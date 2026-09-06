# dac-stream — the output-centred DAC engine, P0 and P1

A prototype, not the driver. `docs/dac-engine-implementation.md` is the
instruction it implements; this file is what was built, what was measured, and
what is not true yet.

```
cd drv
npm run baseline            # P0 — freeze the comparison baseline
npm run dac-stream          # P1 — the isolated gate, 10 s a case
npm run dac-stream:long     # …and 60 s on the representative case, + JSON
```

Nothing here is linked by, included in, or reachable from the shipped driver.
`drv/src/engine.z80` is untouched.

## What P1 achieves

At **9,987.57 Hz**, in the JS instruction model, over 10 s a case:

| | |
| --- | --- |
| mean effective rate | 9,987.570 Hz — **+0.0000%** of nominal |
| adjacent intervals | 358 or 359 cycles; **100%** inside 0.95T–1.05T |
| worst phase error | **0.8 cycles = 0.22%** of one period |
| drift over 10 s | **−0.6 cycles** (one group's Bresenham residue, and it never grows) |
| holes past 1.5T | **0** |
| what the clock adds to a 39 Hz tone | **−0.1 dB** at the worst non-tone bin, i.e. nothing above the measurement floor |
| code | **567 B** |

…and it holds with Timer B observed and its flag reset every group, with CSM
programmed and issuing two register writes a group, and with five FM register
writes crowded into one slot (69.1% of that interval spent, against the §4
ceiling of 80%). The 3,329 Hz and 13,317 Hz profiles come out at +0.0000% from
the same generator with no constant changed.

**This is an emulator result and the emulator is a model.** It charges
documented Z80 cycles with no bus arbitration, no YM /WAIT and no DRAM refresh
contention. Nothing here has run on a Mega Drive, or even on BlastEm — the
toolchain for either was not available in this environment (`m68k-linux-gnu-gcc`
is absent and `drv/blastem/setup.sh` has not been run). Read every number above
as "the placement arithmetic is right", not "the hardware does this".

## The three structural decisions

**1. The slot boundary IS the DAC write.** Each output interval begins with
`ld (de),a`, so the interval between two writes is the slot's length by
construction. Work placed after it delays only the pad, never the next sample.
That is what makes "does CSM change the PCM period?" answerable by reading the
generated code rather than by measuring and hoping.

**2. There is no interrupt.** The Z80 runs with interrupts disabled from boot
and never takes a vblank (§3.1 permits this and asks for the time-sync
mechanism to be named). The DAC's clock is the instruction stream: five slots
are 1,792 cycles *exactly*, so the average carries no error to accumulate.
Timer B is the phase reference — read once per group, its flag reset through
the `$27` shadow, with the harness recording the cycle of every read.

The alternative was measured on paper and rejected: a vblank ISR is ~90 cycles
landing anywhere inside a 358-cycle slot, a quarter of the period against a 5%
tolerance. Reserving room for it in *every* slot costs 25% of the budget for an
event that happens once per 167 samples.

**3. The pad is arithmetic, not a coefficient.** `schedule.mjs` solves for an
instruction sequence costing *exactly* the cycles the slot has left — a `djnz`
loop for the bulk and a short exact tail — and throws if it cannot. There is no
`PAD_FRACTION` and no per-song tuning. A slot that overruns is an error at
generation time.

## The files

| file | what it is |
| --- | --- |
| `config.mjs` | **the one configuration object.** Clocks, profile, RAM map, YM registers, the settling table. Nothing reads an environment variable; a config is passed in, hashed, and its stamp goes into every artifact it produced. |
| `schedule.mjs` | the placement engine: exact-cost ops, the pad solver, the placement table |
| `gen-stream.mjs` | generates the Z80 source and the per-path cycle table |
| `machine.mjs` | the emulated machine and the instrument: RAM, the YM's four ports with a real timer model, the 68000's bus grab as injectable stopped time, and a 64-bit-safe trace |
| `analyze.mjs` | VALUE, TIME and BUS, kept apart; plus the chip's settling table, checked |
| `spectrum.mjs` | the §6.3 comparison: the same bytes on a uniform grid vs at their real write times |
| `gate.mjs` | the §6 acceptance thresholds, fixed before the first measurement |

Generated sources and the JSON report land in `drv/out/dac-stream/`.

## Three bugs this found, all outside the prototype

They are listed because each was invisible to every gate in the repository, and
two of them change numbers that other work rests on.

**1. `$` meant the address of the NEXT instruction** (`tools/z80asm.mjs`). So
`djnz $` assembled as a jump *past* itself: a 26-iteration pad loop that ran
once, a sample clock 4.5× too fast, and no error anywhere. The header of that
file promises sjasmplus syntax, where `$` is the current instruction's address.
Fixed, with `db`/`dw` keeping the older item-by-item meaning that `selftest`
pins, and a new selftest case for the three forms a pad uses.

**2. Every `(HL)` operand was charged 3 cycles too few** (`tools/z80cpu.mjs`).
`ld r,(hl)`, `ld (hl),r` and `alu a,(hl)` are 7 T-states, not 4; `ld (hl),n` is
10, not 7. The emulator returned the register-to-register figures. **The PCM
mixer's hot loop is `ld a,(hl)` and `add a,(hl)`**, so every cycle budget in
this repository — `mixer-bench`, `frame-budget`, `PAD_TARGET`, `EMIT_CYCLES`,
and the measurements quoted in `.claude/memory/plan-68k-split.md` — was computed
against an under-charged model. Fixed, with a selftest that pins the documented
counts. Re-running the P0 baseline across the fix moves the modelled DAC
delivery on `m3-pcm-softmix` from 98.3% to 99.1% and on `m2-pcm` from 63.2% to
75.9%: the engine's own numbers move, which is the point.

**3. A pad filler destroyed the sample in flight.** `ld a,0` is the pad
solver's only odd-cost filler, and the sample fetch used to sit *before* the
pad. At 9,987.6 Hz the pads happened to be a bare `djnz` and nothing showed; at
3,329 Hz the tail took an `ld a,0` and every other sample went out as zero. The
fetch now runs after the pad, which is also what makes an odd residual paddable
at all. It is in this list because the gate caught it only because a *second*
profile was in the case list — one clock would have passed.

## What is NOT done

- **P2 has not started.** No mixer, no voices, no volume, no finished-PCM
  blocks, no loops, no ROM banks. `config.mjs` carries `blockSamples`, `blocks`
  and `voices` and `cycleSlots` already closes the 5-slot group against a
  16-sample block at 80 slots, but no code uses them.
- **No command protocol, no host transfer** (P3). The bus-grab case exists to
  prove the instrument can see a grab, not to claim anything about §3.6. It is
  reported as informational and is excluded from the pass: a 700-cycle grab
  makes a hole of up to 2.95 sample periods, which is exactly the problem §3.6
  says to measure rather than assume away.
- **Nothing has run on BlastEm or on hardware.** §6.4's second column is empty.
- The 60-second representative case runs; the 10-minute one in §6.2 does not
  (the trace is held in memory, and that is the thing to change first if it is
  wanted — the cycle stamps themselves are already 64-bit-safe doubles).
