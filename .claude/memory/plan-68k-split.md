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
- **P2 sequencer** — `drv-player.js` → portable C, host-gated against it.
- **P3 integration** — SGDK glue, hardware bring-up.

## Fixed limits (expectation-setting, unchanged by the split)

8-bit DAC, nearest-neighbour only (interpolation needs a multiply per sample),
DAC jitter from the 68k's per-frame bus grab (~tens of µs, ~0.2%; **measure on
hardware**).
