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

## Decided: poll points (2026-09-28, the user's listening verdict)

Listening set: `drv/tools/jitter-listen.mjs` (→ `drv/out/jitter/`, not checked
in; its header states the model — 14,375.68 Hz, 8-bit, each write late by
U(0, N) Z80 cycles, the chip reading the DAC on its 53,267 Hz / 67.2-cycle
grid). Jitter error in dB below signal: N=30 30.8, 100 25.6, 300 20.3 (samples
overwritten unheard), 600 17.6; the chip's own grid against an ideal hold is
already 31.9. The user:

- **N=100 is audible and acceptable.** So the scheme is **poll points**
  (XGM2's shape), not the constant-time lap: the sequencer carries a poll at
  most every ~100 cycles on every path.
- **Drums are fine at every N, up to 600.** A drum-only score could run with
  far sparser polls.
- **`rand` (always jittered) sounds more natural than `frame` (jittered only
  while the sequencer runs).** The 60 Hz on/off is what bothers the ear, not
  the jitter. So **the idle loop must poll at the sequencer's spacing** and not
  on a tight loop, keeping the jitter's statistics the same across the frame.
  It costs nothing.

Rejected: the constant-time lap (the largest rewrite, for a jitter the user
accepts) and holes (the archive build's bring-up: "never once good").

## Measurement: poll overhead on the archived sequencer (2026-09-28)

Same method as above, with each executed instruction fed to a greedy
placement: a poll goes at an instruction boundary whenever the next
instruction would take the gap past P. It is a **lower bound** — a poll in
real code sits at a fixed place and runs on every pass, so static placement
will cost more (not yet measured; the engine generator's analyzer is the tool
that would check it). Assumed costs, not measured: a poll that finds nothing
due 24 cycles (`ld a,($4000)`, `rrca`, `jr c`), an output 60 (ring pop, `$2A`,
timer re-arm through `$27`), a one-voice mix into the ring 30 a sample.

| score | busy mean / p99 | polls a frame at P=100 mean / p99 | busy + polls mean / p99 |
| --- | --- | --- | --- |
| demo1 | 37.4 / 76.3 | 236 / 482 | 46.9 / 95.8 |
| stress-9ch | 29.6 / 100 | 182 / 564 | 37.0 / 120.6 |
| m3-voice-loop | 14.9 / 100 | 91 / 513 | 18.5 / 120.7 |
| ab-core | 9.2 / 35.6 | 57 / 225 | 11.5 / 44.7 |

P=150 cuts demo1's polls to 154 and P=249 to 91: polls are ~10% of a frame at
P=100 — not where the cost is. **The PCM output itself is: 240 samples × 90 =
36.1% of a frame at 14,375.68 Hz, 169 × 90 = 25.4% at 10,111.71 Hz.** demo1
then totals ~72% mean at 10.1 kHz, ~83% at 14.4 kHz.

- **A frame over 100% no longer breaks the audio** in this scheme — the polls
  keep the DAC fed through it; only that frame's register writes land late,
  and the driver catches up on the next vblank. XGM2 degrades the same way.
- **The one obstacle: overlay loads.** `load_overlay` is a single `ldir` of
  up to 5,749 cycles — the only uninterruptible stretch over 100 in the
  corpus, 607 of them across it. Overlays must go (fit in RAM through the cut
  list) or be copied in polled chunks.
- **The CPU model charged a whole `ldir` 16 cycles** until this session
  (fixed in `drv/tools/z80cpu.mjs`, pinned by the selftest). The shipped engine
  uses no `ldir`, so nothing shipped moved; the archive's busy figures above
  moved by ≤0.5 point on the means, and its overlay-load frames now clip.

## Open

Constraints the poll-point build must meet:

- **The game's VDP DMA blocks the Z80's ROM window.** A 68k-heavy game DMAs a
  lot; the DAC must be fed from Z80 RAM (a ring ahead of it), and the ring's
  depth is the longest DMA it has to ride out. SGDK's joypad halts remain.
- **One window for MMB, samples and overlays.** Bank switches (~9 writes)
  must happen per chunk, not per sample.
- **8 KB RAM.** The archive build had ~20 B free; a ring, the PCM code and a
  render-ahead write list must be paid for with the cut list.

Next, in order:

1. **The rate** — 10,111.71 Hz leaves ~28% of a frame for the sequencer's
   growth since the pivot, 14,375.68 Hz ~17% (demo1). The user's call.
2. **The cut list in bytes** (`npm run size` on the archive) against what the
   build needs added: the ring, the poll/output code, no overlays or polled
   overlay copies.
3. **Static poll placement**: the real overhead, checked by an analyzer over
   the sequencer's control-flow graph, not the greedy lower bound.
