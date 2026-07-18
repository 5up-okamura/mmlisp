# Post-M3 driver feature roadmap — budget meeting outcome (2026-07)

Status: **ordered and costed, not started** (except the overlay split, which
landed as the enabler). Decided with the user 2026-07 in a budget-driven design
review. Implement in the order below, in separate implementation chats. Each
item is independently valuable — stop anywhere.

## The reframe: two budgets, not one

Every feature is weighed against **two** separate resources. Mixing them misjudges
cost:

- **Resident bytes** — Z80 code space under the `G_PCMV` ceiling. `npm run size`
  reports it. Widened by the overlay split (below).
- **Per-frame cycles** — the 60 Hz vblank budget. `npm run budget` +
  `drv/tools/budget.mjs`. The overlay split does **nothing** for this.

A feature is "cold" (runs on START_TRACK / note-on / rare events → cheap cycles,
byte cost only) or "hot" (runs inside the per-frame track loop or the PCM mixer →
costs cycles every frame). The hot ones are the real frontier, and none of the
cycle estimates below are validated on real Z80 yet — only 0-diff in emulation.

## The enabler (DONE): overlay split — commit b069ef8

The overlay slot is sized by its **largest** overlay, and every slot byte costs a
resident byte. `ovl_setup` was 445 B and alone set the 451 B slot, leaving **13 B**
of resident headroom — the wall that made every feature below look unaffordable.

Split at its one internal seam: the MMB directory walk (`mmb_locate`, 222 B) →
new `ovl_mmb`; the TCB fill (`start_track`, 220 B) stays in `ovl_setup`. They
cross only through globals, so nothing in the slot is live across the swap.
START_TRACK loads/runs `ovl_mmb` then `ovl_setup`. Slot 451→274 B; ceiling
`G_PCMV` $16FA→$17AB; **free 13→178 B**. verify:all 29/29 0-diff.

This lever is now **spent**: the six overlays are 220–268 B, so further splits
yield only ~13 B each. The next byte comes from the held-back DATA_BASE bump
(~20-26 B, hardware-gated) or psf commonization (~15-20 B), or from evicting more
cold code to overlays.

## Budget verdict

Byte estimates sum to ~195–330 B against ~220 B of reachable funding (178 free +
the two held-back levers). **Not all six fit at once.** ~4 land inside 178 B;
the 32K wall + VOICE_SET need another lever. So: cheapest-first, dependency-first,
and let hardware bring-up gate the hot/cycle items.

## Ordered plan

### 1. CALL/RET — DONE (2026-07-18), ~101 B resident (not 45-60)

Event-stream subroutines sharing the 4-entry loop-control stack
(`T_LOOPS`/`T_DEPTH`, opcodes.md §5.2, 0x44/0x45; CALL tagged remaining=0xFF).
`d_call`/`d_ret` + 2 dispatch entries measured **~101 B** — heavier than the
45-60 estimate; free 169→68 B. Later trim: a shared `ctrl_entry` helper across
d_loop_*/d_call/d_ret. The **exporter dedup pass** (`live/src/mmb-dedup.js`,
compile-side, 0 Z80 B) rides with it — factors control-flow-free depth-0 runs,
~4-8% stream shrink (eases the 32K wall). Verified by trace gate (Z80 CALL/RET
on factored scores) + ab-gate (dedup trace-neutral). See [[z80-driver-status]].

**Extension candidate (2026-07-18, not started): factor shared loop bodies —
lift the depth-0 restriction.** Today the dedup MVP only factors runs at loop
depth 0, so a phrase *inside* an `(x N …)` loop is never shared. When the SAME
looped phrase appears in ≥2 places (two tracks, or two loops), its body is
stored once per site. Measured: two tracks each `(x 8 phrase)` = 940 B, dedup
saves 0. Lifting the limit lets a loop body become `LOOP_BEGIN CALL LOOP_END` +
one shared fragment (two sites, L=24 B body: 54→~37 B). Safe with one addition:
the encoder must track the *real* control-stack depth (LOOP + CALL share the
4-entry stack) and factor inside a loop only when `loop_depth + 1 ≤ 4`. Only
pays off when the phrase is shared — a phrase in a single loop is already stored
once, so wrapping it in CALL/RET would *add* bytes; gate the factoring on
occurrence count ≥ 2.

**Decision — keep LOOP and CALL/RET SEPARATE; do NOT add a count to CALL.** The
tempting unification (a counted `CALL {dest,count}` that both repeats and
shares) loses on the common case: a single-use `(x N phrase)` is L+3 B as a
LOOP (body stays inline, count in LOOP_BEGIN) but L+5 B as a counted-CALL (body
forced out-of-line + a RET + a dest pointer). Counted-CALL only wins ~4 B over
`LOOP_BEGIN CALL LOOP_END` on the rarer *shared* looped phrase (33 vs 37), while
taxing every ordinary loop 2 B and complicating the runtime (per-iteration
re-entry re-invents LOOP_END's decrement). The count belongs to LOOP (in-place
repeat); CALL/RET stays count-less (pure share). The synergy is **composition**
(CALL nested in LOOP), not merger — no new opcode, both primitives stay small
and direct.

### 2. SE + BGM voice restore — bundle with VOICE_SET, ~30-50 B, cold

**Do not count SE-restore and VOICE_SET separately — they are one feature.** SE
steals an FM channel (channel-ownership eviction already exists, driver.md §2.2);
when it ends, the displaced BGM voice (its FM patch) must be re-established. That
re-establishment **is** VOICE_SET (the remaining-M3 runtime patch opcode +
export-time VOICE_TABLE coalescing). Open design question: does a BGM re-key
restore the patch "for free," or must a note **held** under the SE be restored
mid-sustain (the hard case)?

### 3. DJ-style transitions — same-MMB first (0 B), cross-MMB deferred

Same-MMB transitions (one score, two sections; crossfade, release-tail decay
under the incoming) **already work today** (driver.md §2.3) — confirm and document,
no code. The "1 phrase retained → next song same tempo → fade in" case is this,
as long as both live in one MMB.

Cross-MMB (two separate scores) is the **hot** part: a per-track bank re-latch in
the dispatch loop (`latch_bank`, 9-bit shift × active tracks × frame). ~15-30 B
resident **plus** per-frame cycles. The mailbox already carries per-command bank,
so no protocol change (driver.md §5.3). **Defer the cross-MMB cycle cost to
hardware bring-up** — measure with budget.mjs before committing. This is also
what BGM-MMB + SE-MMB (separate files) needs; same mechanism.

### 4. PCM runtime volume — per-voice, bit-shift, ~25-40 B + hot cycles

PCM has **no** level path today (mmlispdrv.z80: "fm3-op/pcm: no level path"; the
mixer adds raw signed samples). Samples stream from ROM live (pva_fetch every
tick), so volume is **unavoidably per-sample** — there is no bake-and-forget like
FM's TL. (My earlier "note-on scale avoids per-sample" was FM thinking, wrong for
PCM.)

Decided:
- **Per-voice**, not master. A `PV_VOL` field per voice; the mixer applies it to
  each fetched sample.
- **Bit-shift** apply (user: "shift is enough"). Small shift count → a few
  instructions per sample per voice.
- **note-on latches `PV_VOL` from vel, and a macro can rewrite `PV_VOL` per
  frame** — same field, no conflict. The per-sample apply just reads the current
  value; the macro path (macro engine reaching `G_PCMV`) is the added byte cost
  and buys the expressiveness.
- **Multiply LUT = stretch goal.** A 256-B scaled table per level gives
  constant-time arbitrary (non-pow2) gain — more expressive, adopt only if bytes
  allow.

Watch the **cycle** cost: per-voice-per-sample shift is up to 175×3 sites/frame
in the already-heaviest routine. Validate on hardware.

### 5. PCM 32K wall — WIDE_OFFSETS, ~50-100 B, confidence low, LAST

MMB ≤ one 32KB bank window today; PCM-heavy songs push past it. The
`WIDE_OFFSETS` flag is **reserved** (mmb.md §12 / header bit 0): u32 offsets +
mid-stream banking. Format + driver change, biggest unknown. Do last — after the
dedup pass (1) and cross-MMB banking (3) exist and the need is measured. A
narrower option: bank the SAMPLE_BANK section independently of event/track data.

## Music→game triggers — `(trig N)` (accepted: minimal-first)

The MARKER opcode (0x42) + `MB_TSTAT` (68k-readable, driver.md §6.1) is already a
music→game position channel. `#name` emits MARKER but is the JUMP/loop **label**
(overloaded); `|` is a compile/editor-only bar aid (emits nothing). So there is
**no dedicated game-trigger verb** — but the plumbing exists.

Plan (accepted recommendation): **`(trig N)` / `(trig)` as a new surface that
emits the existing 0x42** → new opcode 0 B, driver 0 B (d_marker exists), just
compiler surface + an id ≤ 63 check (MB_TSTAT is 6 bits). `(trig)` auto-numbers;
`(trig 4)` is explicit.

**Start minimal (last-wins byte); ring-ify only if dense triggers demand it.**

Drop cases (precise): `MB_TSTAT` is one byte/track, last-wins. A trigger is lost
only when, on the **same track**, ≥2 triggers fire between two consecutive 68k
polls (≈ one frame — and a fast tempo dispatches several ticks/frame, so
consecutive-tick triggers collide in one frame). **Cross-track never drops.**
Sparse triggers (≥1 frame apart) + per-frame polling = zero loss.

Ticks delivery — two options that **converge**:
- *Query anytime*: publish `G_FRAME` (2 B/frame) to the mailbox reserved region
  (0x34-0x3F). Near-free. Global time; game correlates triggers itself.
- *Delivered with the trigger*: upgrade last-wins to a **Z80→68k event ring**,
  each entry `{track, trig_id, frame_lo, frame_hi}`. This **is** the
  guaranteed-delivery fix — so "no drops" and "ticks-on-trigger" are **one ring**,
  ~20-40 B cold + a few mailbox bytes.

All trigger work is cold — it never threatens the 178 B, and slots anywhere in
the order above.

**Still open:** (a) sparse (last-wins, ship first) vs dense (ring) — decide when a
real dense use-case appears; (b) ticks query vs delivered — if (a) goes dense, the
ring answers both.

## Related: DAC ownership is now a separate, de-risked decision

The 18 B "last KEY-ON wins" policy in [[plan-dac-ownership]] was blocked by the
13 B wall and justified by mucom. With mucom dropped as a driver-policy input and
the wall gone (178 B free), DAC ownership is **no longer a budget problem** — it's
a pure design choice. The live direction is a **static** rule (PCM-using songs
cede fm6, arbitrated at compile time, possibly via `:prio` treating fm6+pcm1-3 as
layers of the one physical channel), not runtime arbitration. See that file.
