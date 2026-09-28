# A Z80-only MMLisp build — feasibility (started 2026-09-28)

`roadmap.md` Phase 3 open #6. Nothing is built; this file holds the user's
decisions so far and the measurements taken for them.

## Why (the user, 2026-09-28)

The game side wants the whole 68000: heavy raster effects, 3D and coordinate
math. The shipped split costs the 68000 **~28% of every frame on average and
~116% in the worst render** on a six-channel song (`drv/sgdk/README.md`,
`sgdk:profile`). That is the number that makes the question real. It has not
been re-measured on the user's heavier scores (needs SGDK + probe BlastEm,
not available in the cloud container).

## Decided

- **A profile, not a fork.** Language, IR and MMB stay one. The Z80 build is a
  compile-time profile (`export-mmb --target z80` or similar): opcodes outside
  it are a compile error, and the driver's existing "undefined ⇒ fail-safe
  reject" covers the rest. Keeps the third implementation (JS ≡ C ≡ Z80) to a
  frozen subset.
- **PCM is the crux, and is decided first** — before a PCM-less build is
  written, because the PCM scheme dictates how the sequencer itself must be
  written (poll points or bounded chunks). Bolting PCM onto a freely written
  sequencer is what `archive/all-z80` did, and it never played well.

## Measurement: the archived Z80 sequencer, PCM off (2026-09-28)

`archive/all-z80` (resident 6,017 B + 2,309 B of overlays; its CPU model
already carries the `(HL)` fix, so these figures are calibrated). Method:
`run-trace.mjs` patched to log the cycles from the vblank interrupt to the
driver's `halt`, `sampleBank: null`, 1,200 frames, every archive test score
whose sidecar is a plain command list (>7 tracks started over frames 0–1).
Share of a 59,659-cycle frame:

| score | mean | p50 | p99 | frames ≥100% | backlog at 50% capacity |
| --- | --- | --- | --- | --- | --- |
| demo1 | 37.3 | 37.6 | 76.3 | 1 | 0.50 frame |
| stress-9ch | 29.3 | 22.5 | 91.3 | 8 | 1.73 |
| m3-voice-loop | 14.4 | 12.0 | 87.1 | 9 | 0.69 |
| m2-motion | 13.1 | 6.7 | 50.8 | 1 | 1.06 |
| ab-core | 9.1 | 6.7 | 31.2 | 1 | 0.60 |
| the other 43 | ≤19 | ≤17 | ≤44 | ≤1 | ≤0.55 |

- The floor is **6.7%** (~4,000 cycles) with nothing to do.
- The single ≥100% frame in most scores is the start frame; the 8–9 in
  stress-9ch / m3-voice-loop are voice changes (overlay loads + ~30 writes a
  channel). 100% is a clip: those frames never reached `halt`.
- "Backlog" = the worst queue if the sequencer gets a fixed share of each frame
  and renders ahead (the 68k build's render lead). **At a 50% share, every
  score stays under two frames of lead.**
- It is a floor on three counts: the emulator charges no bank-window wait,
  the sequencer predates everything added after the 2026-08-02 pivot (tick-clock
  macros, eighth-step velocity, value-machine extensions, PCM loops, CH3
  claim), and the corpus is the gate corpus, not the user's heaviest score.

Reading: **cycles are no longer the blocker.** Half the Z80 runs the sequencer;
the other half is ~29,800 cycles a frame, and a fixed-pitch voice read through
a level table costs tens of cycles a sample, not the 983 of the resampling
mixer that killed the archive build. The blocker is structural: with no timer
interrupt on the Z80, the DAC must be fed from inside the sequencer's own
instruction stream at an even pace.

## Open: the PCM scheme

Three candidates, not yet chosen:

1. **Constant-time lap (the shipped engine's shape).** Zero jitter; the
   sequencer is rewritten as bounded micro-steps run in each slot's slack. The
   largest rewrite.
2. **Poll points (XGM2's shape).** The sequencer carries a DAC/poll point at
   most every N cycles on every path — checkable by the generator's analyzer.
   Samples come from a RAM ring filled in bulk. Pacing by polling a YM timer
   flag gives an exact mean rate and jitter bounded by N; without it, jitter
   and rate both follow the code.
3. **Holes (MDSDRV's shape).** Rejected in practice by the archive build's
   bring-up (a burst then 6 ms of one value: "never once good").

Constraints any scheme must meet:

- **The game's VDP DMA blocks the Z80's ROM window.** A 68k-heavy game DMAs a
  lot; the DAC must be fed from Z80 RAM (a ring ahead of it), and the ring's
  depth is the longest DMA it has to ride out. SGDK's joypad halts remain.
- **One window for MMB, samples and overlays.** Bank switches (~9 writes)
  must happen per chunk, not per sample.
- **8 KB RAM.** The archive build had ~20 B free; a ring, the PCM code and a
  render-ahead write list must be paid for with the cut list.

Next measurements, in order:

1. **Is bounded jitter audible?** Rendered 2026-09-28 by
   `drv/tools/jitter-listen.mjs` (→ `drv/out/jitter/`, not checked in; the
   header states the model). 14,375.68 Hz, 8-bit, each write late by U(0, N)
   Z80 cycles, either always (`rand`) or only in the first 35% of each frame
   (`frame`); the chip reads the DAC on its 53,267 Hz grid (67.2 cycles).
   Jitter error, dB below signal: N=30 30.8, N=100 25.6, N=300 20.3 (8,638
   samples overwritten unheard), N=600 17.6. **The chip's own grid against an
   ideal hold is already 31.9 dB** — N≈30 is the level every driver on the
   hardware lives with, though the grid's error is a fixed pattern and the
   jitter's is noise. **Waiting on the user's listening verdict**; it chooses
   between 1 and 2.
2. **Poll-point overhead**: the longest poll-free path in the archived
   sequencer and the cycles polls add at the chosen N.
3. Then the cut list in bytes (`npm run size` on the archive) against the
   RAM the chosen scheme needs.
