# Post-M3 driver feature roadmap — budget meeting outcome (2026-07)

Status (updated 2026-07-20): **most items LANDED.** CALL/RET (1), SE + restore
(2), PCM per-voice volume (4), and `(trig N)` are done in emulation; the
sample-bank half of the 32K wall (5) landed too. **Remaining: DJ cross-MMB
transitions (3, hardware-gated), WIDE_OFFSETS (5), and the CALL/RET
shared-loop-body extension (1).** Decided with the user 2026-07 in a
budget-driven design review; implemented in separate chats. Per-feature detail
is now in [[z80-driver-status]] (Done list) and [[plan-se]]; this file keeps the
budget frame + the still-open items.

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

### 2. SE + BGM voice restore — DONE (2026-07-20)

VOICE_SET (the FM patch mechanism) landed 2026-07-19; the full SE suspend/restore
followed. **All landed:** `START_SE` (mailbox cmd 7), suspend-not-evict
(`T_STATUS=3`), mid-sustain snapshot/restore for **FM + PSG + PCM**, and SE
**priority** (N=1 slot). The mid-sustain-vs-re-key question resolved to
per-family restore (FM → VOICE_SET 29-B patch; PSG → period+att re-attack; PCM →
17-B `G_PCMV` snapshot resuming at `PV_POS`). Full detail + the remaining SE
polish (N=1→pool, stop_track reclaim, bundler) live in [[plan-se]].

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

### 4. PCM runtime volume — DONE (2026-07-20), per-voice bit-shift

Landed as `:vel`+`:vol`+`:master` composed to a per-voice arithmetic-shift
(`sra`) attenuation with mute (`PV_SHIFT`), matching the FM/PSG loudness ladder.
No new opcode (rides the existing `PARAM_SET VEL`/`VOL`/`MASTER`). Detail +
budget reorg (evicted `start_sweep` to `ovl_sweep`) in [[plan-se]] and
[[z80-driver-status]]. **Stretch goal still open:** a ROM multiply LUT for
smoother/exact (non-pow2) gain — deferred by the user until the bit-shift version
is confirmed. **Cycle** cost (per-sample `sra`, up to 175×3/frame on the heaviest
routine) is trace-correct in emulation, hardware-unvalidated.

### 5. PCM 32K wall — narrower half DONE (sample-bank separation); WIDE_OFFSETS still open

The **narrower option — bank the sample data independently of event/track data
— LANDED 2026-07-19** (PCM blobs moved to a dedicated ROM bank the mixer latches
per frame, `G_SMP_BANK`; see [[plan-se]] Step 1). That lifts the wall for
PCM-heavy songs and is the SE-bundling enabler. **Still open:** full
`WIDE_OFFSETS` (mmb.md §12 / header bit 0 — u32 offsets + mid-stream control-data
banking) for control streams that alone exceed 32KB. ~50-100 B, confidence low,
LAST — after the dedup pass (1) and cross-MMB banking (3), when the need is
measured.

## Music→game triggers — `(trig N)` — DONE (2026-07-18, explicit form)

**Shipped.** `(trig N)` (N = 0..63) emits MARKER 0x42 with an explicit id (IR
`{cmd:MARKER, args:{code}}`; export-mmb emits it verbatim, skips the label
id/offset bookkeeping; exempt from `E_MARKER_DUP`). **0 Z80 bytes** (reuses the
existing `d_marker` → MB_TSTAT path; free stayed 68 B). Errors `E_TRIG_ARITY`,
`E_TRIG_RANGE`. **Auto-numbered `(trig)` deferred** — the useful form is
explicit (the game knows N); auto needs a collision policy not worth designing
until a real use appears.

**The real work was the marker gate** (MARKER has no register effect, so the
trace/ab gates couldn't see it). Added: drv-player tracks per-track `markerId`
and `captureRegisterLog` returns a per-frame `markerLog`; `run-trace.mjs`
snapshots `MB_TSTAT` (MB_BASE+0x22) per frame; `verify.mjs` diffs the id bits
Z80≡drv-player at zero tolerance. Gate `m3-trig` (ids 1/2/63 + 10/20, sticky
last-wins). **Bonus: this gated d_marker for the FIRST time** — every existing
`#label`/`(go)` marker is now verified across the whole corpus (0 mismatches),
which **unblocks the d_marker overlay eviction** (~25 B funding, was blocked on
"no marker gate exists" — see [[z80-driver-status]] budget table).

Original context (still true): the MARKER opcode (0x42) + `MB_TSTAT`
(68k-readable, driver.md §6.1) is the music→game position channel. `#name` emits
MARKER as the JUMP/loop **label** (overloaded); `|` is a compile/editor-only bar
aid (emits nothing).

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

## Related: DAC ownership — SUPERSEDED, folded here (plan-dac-ownership deleted)

fm6 and the DAC are one physical channel (`$2B` bit7 selects); today **PCM wins
unconditionally** (a PCM note-on writes `$2B=$80`, fm6 silent until all voices
end). An earlier "last KEY-ON wins" **runtime**-arbitration plan (18 B) is
**dropped** — its two premises fell: mucom is no longer a driver-policy input
(so no corpus forces the driver's hand), and the byte wall that made it look
costly is gone. **Live direction: a STATIC compile-time rule** — a PCM-using
song cedes fm6, arbitrated in the compiler (most promising shape: `:prio`
treating fm6 + pcm1-3 as parallel layers of the one channel), so the driver
arbitrates **zero bytes** and could reclaim the ~12 B DAC-release path. Measured
facts worth keeping: the MMB format is unaffected (runtime behaviour only), and
`process_pcm` already early-outs (`call pcm_any_active / ret z`) so fm6 taking
the channel *idles* the driver's most expensive routine — the cycle "saving" is
paid in music (the drums stopped), not free. **Open sub-problems for the static
rule:** `:prio`'s monophonic flatten can't yet express "fm6 vs the *group*
{pcm1,pcm2,pcm3}"; and runtime SE (START_SE, not in the compiled score) can't be
flattened at compile time, so SE-over-PCM stays a hardware fact.
