# Architecture pivot: 68k sequencer + Z80 PCM engine (decided 2026-08-02)

**The design now lives in `docs/driver.md`** (rewritten 2026-08-02: §1.1 the
measurement, §4 the 68k frame, §5 the Z80 engine, §6 the ring/slot interface,
§11 the port milestones, §12 the gates). `drv/README.md` carries a banner
superseding its "68k offload is the last resort" position.

This file keeps only what the docs do not: the decision record, and the port's
running state.

## Why (the measurement that settled it)

Z80 frame = 59,659 cycles. The all-Z80 PCM soft-mix measured **~240 cyc per
voice per mix tick + ~260 fixed per tick**; 3 voices × 175 ticks = 170k = 285%
of budget. Rewritten to the theoretical floor for the same semantics (16.16
resampling + per-voice volume + i16 sum), ~110/voice + ~120 fixed →

- 2 voices × 175 ticks = **59,500 = 99.7% of the frame, sequencer executing
  zero instructions**.

The sequencer is not the reason — its median is 19.7k (33%). The two workloads
do not fit in one Z80. The old position was argued on *bytes* and the overlay
pass solved that; the binding constraint is *cycles*.

## Decisions (all 2026-08-02)

1. **Split (option C).** 68k sequences; Z80 = PCM mixer + chip-write engine.
2. **The Z80 keeps the clock.** 68k pre-renders per-frame write lists into a
   ring in Z80 RAM; the Z80 consumes one per its own vblank. Tempo stays
   60 Hz-exact and a heavy game frame is absorbed by the ring — the property
   that motivated the all-Z80 design, preserved.
3. **SE moves to the 68k.** Keeps the Z80 a pure engine; costs SE 1–2 frames.
4. **PCM voice count fixed at 3.** Lets the mixer be fully specialised.
5. **No compile-time pre-resampling** ("option B" dropped) — per-note PCM pitch
   and dynamic loop points are worth more than the cycles. **Re-examined after
   P0 and upheld**: the resampler measured ~37 cyc/voice/tick (29% of the mixer,
   not the 11% assumed) and removing it would lift the 3-voice ceiling from
   10.9 kHz to 17.2 — but the chosen configuration fits without it.
6. **Ring depth default 2, a per-game knob.** Deep lookahead and continuous
   live control are mutually exclusive (driver.md §3.4). Escape hatch if 2
   proves too shallow: indirect write-list entries ("write reg X from slot S"),
   deliberately deferred — it puts resolution logic back on the Z80.
7. ~~16-bit mix buffer~~ → **SUPERSEDED by P0 measurement. 8-bit
   saturating-add, 3 voices, `PCM_MIX_R` = 175 (10.5 kHz), unroll 2**
   (2026-08-02). 89% of the frame, 95 chip writes left. i16 sum-then-saturate
   could not hold 10.5 kHz at 3 voices (113%) and its knee was 8.6 kHz. The
   deciding argument was asymmetry of cost: i8sat is **bit-identical to i16
   below 3 simultaneous voices** and its divergence above that is avoidable by
   backing off `:vol`, whereas the mix rate is paid on every sample of every
   score. **The rate stays a knob to raise** (ceiling 10.9 kHz at unroll 2,
   11.3 at unroll 4) if a real score and hardware leave room — raising it
   re-freezes every gate baseline, so it needs a measured reason.
8. **Change-only suppression moves to the 68k.** It holds the shadow and emits
   only changed registers, so the Z80's shadow file, valid plane and the ~550
   cyc/write of bookkeeping all disappear.
9. **Writes are appended in dispatch order, not coalesced full-frame.** Keeps
   the slot's per-port write sequence byte-identical to `drv-player.js`, so the
   zero-tolerance gate survives. Full-frame coalescing saves ~1% of writes and
   costs that gate — not worth it unless a write-cap squeeze forces it.
10. **Per-slot write cap with 68k-side spill** (default 64 writes). Bound is
    *cycles*, not bytes: the Z80 frame is shared with the mixer. Excess writes
    keep their order and prepend to the next slot — never dropped, never
    reordered. `drv-player.js` models the same cap/spill so the gate stays at
    zero tolerance.
11. **Implementation order: Z80 mixer first** (chosen 2026-08-02). The §5.3
    cost estimate is load-bearing for the whole architecture, and the prototype
    that tests it is small — so it goes before anything is built on top of it.

## Port state

- **Docs rewritten — DONE 2026-08-02** (`docs/driver.md`, `drv/README.md`,
  roadmap, README, CLAUDE.md, mmb.md §12, sgdk/README).
- **P0 mixer prototype — DONE 2026-08-02.** `drv/tools/gen-mixer.mjs`
  (generates `src/mixer.z80`) + `drv/tools/mixer-bench.mjs` (`npm run mixer`);
  every configuration verified against a JS model of the mix, so cost and
  correctness gate together. Full table in driver.md §5.3.1.
  **The estimate was ~50% optimistic** — 301 predicted vs **449** measured at
  3 voices, i16, R = 175; optimization took it to **384**, still 113%.
  - **3 voices at 10.5 kHz does not fit with sum-then-saturate.** The knee for
    those semantics is ~8.6 kHz (R = 144, 91%, 83 FM writes).
  - **It DOES fit with an 8-bit saturating-add buffer** — 305 cyc/tick, 89%,
    95 writes at R = 175, ceiling **10.9 kHz**. `add a,(hl)` sets P/V on signed
    overflow, so the common path is one not-taken `jp pe` (10) against the i16
    high plane's ~26. Costs: clips earlier and is order-dependent — but it is
    **bit-identical to i16 at 1 and 2 voices** (one add = one saturation point
    either way), so the cost exists only at 3 simultaneous voices, measures 5.1%
    of samples on worst-case full-scale noise, and disappears under any `:vol`
    below unity.
  - Mix-rate ceilings at 3 voices (60 writes/frame reserved): i16 **8.6 kHz**,
    i8sat **10.9**, i16 pre-resampled **12.2**, i8sat pre-resampled **17.2**.
  - **i8 headroom is dominated and is out** — slower than saturating-add (the
    per-voice `ceil(log2 N)` attenuation is extra `sra`s in the hot loop) *and*
    worse (the headroom tracks the active voice count, so a sustained voice
    jumps 12 dB when another starts — pumping).
  - **2 voices fit at 10.5 kHz in every variant** (79%, 197 writes).
  - Z80 techniques worth not rediscovering: accumulate **biased-unsigned**
    (`sample ^ $80`) — then the i16 sum needs no sign extension anywhere, the
    high plane only ever takes a carry, and the output pass subtracts 128*(N−1).
    Two page-aligned planes let one 8-bit index address both (`inc h`/`dec h`).
    The 16.16 advance is one 32-bit add split across the register sets, because
    **`exx` is flag-transparent** so the frac carry chains into the pointer add
    — but `exx` swaps BC too, so load the increment into C *after* it. Shift
    specialisation (8 loop copies) removes a 12-cycle per-tick dispatch `jr`;
    unroll 2 is the size/speed knee (`djnz` can't reach across an unrolled body).
  - Numbers are a **floor** — no bank-window wait states in the emulator, and
    the sample fetch is the most exposed instruction.
- **Configuration SETTLED 2026-08-02** — see decision 7. `SLOT_MAX_WRITES`
  therefore starts at **95** (what the mixer leaves at R = 175).
- **P1 interface — Z80 HALF DONE 2026-08-02.** `drv/src/engine.z80` (2560 B,
  ends $9FB, under MIXLO $1000): boot, vblank ISR, ring consume (PSG/FM0/FM1
  length-prefixed runs), PCM commands, published header at $1300, and the
  segment-split per-voice driver. `npm run engine` gates it — 7 scenarios, chip
  writes byte-exact vs the slot AND the DAC stream vs a JS model.
  Gotchas worth not rediscovering:
  - `ld (nn),bc` stores C first, so reading back a tick count stored that way
    gets the wrong register.
  - The gate harness must run the CPU to its idle `halt` *before* the first
    interrupt, or every frame's slot is serviced one frame late.
  - The forced one-tick segment (when `avail >> ksh` rounds to 0) can consume
    more than `LEFT`, so the countdown needs a clamp at 0 — otherwise it wraps
    and the voice runs off the end of the sample.
  - Distances (countdowns), not absolute end addresses, are what make ROM bank
    crossing free: the pointer wraps at the window top, the bank steps, the
    countdown is untouched.
  **Slot builder DONE too** — `live/src/slot-builder.js` (its own module: the
  wire format and cap/spill are spec, not either player's business) plus
  `DrvPlayer.captureSlotLog`. `npm run slots` runs a real score end to end and
  asserts the chips receive exactly the sequencer's writes, in order, and that
  the transport only ever DELAYS one. Corpus behaviour: the 95-write cap binds
  only at a score's head (2 frames held back, ≤2 frames late) and never in
  steady state, on scores from 395 to 1801 writes — i.e. the armed-frame burst
  driver.md §4.2 predicted, and nothing else.

  **PCM DONE too (2026-08-02).** `drv-player._pcmFrame` re-based onto the
  engine's structure (voice-outer plane, 8-bit saturating-add, `LEFT` countdown
  checked after the advance); `MUTE_SHIFT = 8` added to the generated mixer for
  `:vol 0`; PCM_START/STOP/VOL emitted from the sequencer side with every field
  resolved there. `npm run slots` compares the DAC stream sample for sample
  across the PCM corpus (52,685 writes on m3-pcm-softmix, all matching).

  **The bug worth remembering:** `pc_stop` computed `left += tail` in HL — which
  is the *command cursor*. A STOP alone was fine, so four gate scenarios missed
  it; a real score retriggers a looped note with STOP+START in ONE slot, and
  everything after the STOP was then read from garbage. Rule: **every PCM
  handler must return HL untouched.** Gate scenario "STOP and START in the same
  slot" now covers it.

  **$2A/$2B ownership.** Both are the engine's and never enter a slot. The
  sequencer *could* predict the `$2B` edges (it knows when a shot ends) but then
  both sides would have to agree on the exact frame — a coupling worth avoiding
  when voice activity is the one piece of state the Z80 already owns. The
  neutral patch still writes them for ir-player parity (removing them cost
  ab-core its 0-diff property, which is worth more), and `DrvPlayer._pcmLog`
  records mixer-produced DAC traffic separately so the gate compares like with
  like.

  **The all-Z80 trace gate is retired** (`legacy:verify*`, no longer passing):
  drv-player now specifies the post-split architecture and the old driver
  implements neither its PCM semantics nor its DAC ownership. `verify:all` is
  now selftest + the P0/P1 gates + the ir↔drv A/B. ab-baseline re-frozen: still
  **18 clean of 40**, with the PCM scores' signatures changed by design.
- **P2 sequencer — M1 + M2 + M3 DONE 2026-08-03.** `drv/68k/{mmlispseq.h,
  mmlispseq.c, gate_main.c}` + generated `tables.c`; gate `npm run c-gate`
  (tools/c-gate.mjs). **38 scores byte-identical, 0 PEND** (was 12 at M2).
  - M2 covers the sweep engine (PARAM_SWEEP/_STOP, 2 slots/channel, the 8
    integer curves), PARAM_ADD + read_param, TEMPO_SWEEP, cent pitch, CSM
    (ON/OFF/RATE const+swept), and the §6.5 host API (key_off / set_param /
    fade_track's Bresenham ramp / set_val), the last gated with a real
    host-command schedule (`m2-mailbox`) — c-gate grew sidecar `.cmds.json`
    support for that.
  - M3 covers the macro engine (sticky binds, note-on re-instantiation,
    attack/sustain/release, NOTE_SEMI, NOTE_PITCH override+additive, scaled
    macros, KEYON retrigger), the value machine's stream ops (PARAM_MUL /
    _FROM_VAL / _ADD_VAL / _MUL_VAL), FM3_MODE + FM3_OP_PITCH with the
    per-operator key path, and PCM_NOTE_ON/_OFF + §6.3 command emission.
  - **Both M2 and M3 went in with zero gate failures on the first run**, which
    says the M1 groundwork (shadow validity, write paths, frame order) really
    was the hard part — and that porting from a *validated implementation*
    rather than prose is what makes this cheap.
  Things the C needs that the JS gets for free, all found BY the gate:
  - **a shadow-validity plane** — drv-player keys its shadow with a Map so an
    unwritten register never compares equal; a zero-initialised C array
    suppresses the neutral patch's many writes of 0. (The Z80 dodged this by
    writing every covered register at boot, which is why it could drop its own
    plane.)
  - **VOICE_SET compares against the STRUCTURED shadow**, not the register
    shadow: the burst it replaced only wrote registers a PARAM_SET touched, so
    e.g. $90/SSG must stay unwritten when the voice omits it.
  - **the drain must not render.** `gate_main` closes slots until the spill
    queue empties; those must be *encode-only* (`mml_drain_frame`). Running a
    frame there invents traffic (a sweep step, a retiring PCM voice) the
    reference — which only calls `endFrame` — never produces.
  M3 design notes worth not rediscovering:
  - **The 68k shadows each PCM voice's POSITION** (3 × 175 add/compare per
    frame), never a sample byte. Not for the audio — for its own decisions: a
    PCM_VOL for a dead voice is wasted slot bytes, and PCM_NOTE_OFF on a
    finished shot must emit nothing. A closed form exists for the non-looping
    case if a cycle count ever asks.
  - **The slot's byte budget can bind before its write cap** once PCM commands
    are in play (3 PCM_STARTs = 54 B), and PSG writes cost 1 byte while FM cost
    2 — so the "longest prefix that fits" test has to count real costs, not
    `take * 2`.
  - The sample bank is a **separate ROM bank, not an MMB section**, so
    `mml_load_samples` is a separate call and c-gate passes it as `--samples`.
    Only the 20-byte entry table is the sequencer's business.
  - Macro binds are an **ordered** map: replacing a target's macro keeps its
    original position (JS Map semantics), and that order is the step order.
  **Remaining for P2: SE** (plan-se.md) — track lifecycle / START_SE /
  suspend-restore / priority. Its gate scores (`m3-se`, `m3-se-prio`) carry a
  richer sidecar (`autoStart: false` + `remapChannels`) and c-gate reports them
  SKIP rather than crashing.
- **P3 integration** — SGDK glue, hardware bring-up.

## P3 entry — what is decided, and what has to be decided first

**Decided 2026-08-03: the per-frame hook.** `MMLisp_frame()`, called once per
vblank by the host; the driver does NOT register with SGDK's vblank callback.
The call **tops up the ring** rather than rendering one slot, so lookahead is an
invariant it maintains, not the host's job — and it is self-limiting, so being
called twice in a frame is harmless. Bus grabbed once per call, not per slot.
Control calls go BEFORE the render call in the host's frame. No
`MMLisp_autoVBlank()` convenience — it would be a second path the host gate
cannot reach. Full rationale in driver.md §6.6; the load-bearing part is that
explicit calling is safe *because the Z80 owns the clock*, so render jitter
lands in the ring's fill level and never in the tempo.

**Still to decide, roughly in the order P3 needs them:**

1. **How the ring depth is shared.** Both the Z80 image (`RING_DEPTH equ 2`) and
   the 68k must agree, and a mismatch fails silently (the 68k thinks the ring is
   full and stops rendering, or writes a slot that does not exist). Suggestion:
   the Z80 publishes depth and slot size in the header next to
   `protocol_version`, and the 68k reads them — one side owns the truth.
2. **Who owns the transport.** `mml_render_frame()` today just returns slot
   bytes; nothing owns head/tail or the bus grab. Keeping the core PURE and
   putting the ring in the SGDK layer preserves the host gate, which depends on
   exactly that purity.
3. **Per-track start/stop.** Only `mml_start_all()` exists (a gate-harness
   convenience). §2.2 channel ownership and §2.3 scene transitions are
   `mml_start_track` / `mml_stop_track` shaped, so the interactive model is not
   actually implemented yet.
4. **`(trig N)` delivery — the biggest undesigned piece.** Markers are rendered
   AHEAD by the ring depth, so handing them straight to game code would fire
   them early. §6.4 says compare against the Z80's consumed-frame counter, but
   there is no API: the natural shape is a small queue of (marker, rendered
   frame) that `MMLisp_frame()` releases as the counter catches up. The C keeps
   `marker_id` per track today and never surfaces it.
5. **Multiple scores loaded at once.** §2.3's DJ transitions became free with the
   split, but `mml_load` fills one `MMLSeq`. Two sequencers would duplicate the
   shadow and the slot queue; one sequencer with a per-track score pointer is
   what §4.3 already describes.
6. **SE port** ([[plan-se]]). The model (priority, suspend/restore, snapshots)
   should carry over unchanged — SE moved to the 68k in decision 3, so the
   ring-latency cost is already accepted. `m3-se` / `m3-se-prio` are SKIP in
   c-gate today.
7. **PAL** (§3.3) — the correction is now one multiply; undecided whether it
   scales at load or at each TEMPO_SET. Needs a PAL target to settle.
8. **Raising the mix rate** (10.5 → up to 10.9/11.3 kHz, §5.3.1) — deliberately
   parked until hardware measurement gives a reason.

## Fixed limits (expectation-setting, unchanged by the split)

8-bit DAC, nearest-neighbour only (interpolation needs a multiply per sample),
DAC jitter from the 68k's per-frame bus grab (~tens of µs, ~0.2%; **measure on
hardware**).
