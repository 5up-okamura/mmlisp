# dac-stream — the output-centred DAC engine, P0 / P1 / P2

A prototype, not the driver. `docs/dac-engine-implementation.md` is the
instruction it implements; this file is what was built, what was measured, and
what is not true yet.

```
cd drv
npm run baseline            # P0 — freeze the comparison baseline
npm run dac-stream          # the isolated gate in the JS model, 10 s a case
npm run dac-stream:long     # …and 60 s on the representative case, + JSON

sh blastem/setup.sh         # once — builds the emulator, ~2 min
npm run dac-stream:machine  # the same schedules on BlastEm
```

Nothing here is linked by, included in, or reachable from the shipped driver.
`drv/src/engine.z80` is untouched.

## What it achieves

P1 (output only) and P2 up to **two voices with independent levels, a master,
and CSM alongside** pass the §6 gate. What is NOT built is at the bottom of
this file, and it is a real list: no loops, no ROM bank crossing, no note
starts and stops, no command protocol, no host transfer, and nothing has run
anywhere but the JS instruction model.

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

## What P2 achieves

Two voices, each with its own 16-step level, composed with a master, mixed into
16-sample blocks a page-sized ring holds, at the same clock:

| | |
| --- | --- |
| the clock | **unchanged**: +0.0000%, intervals 358 or 359, phase 0.8 cycles, zero holes, at one voice and at two, with and without CSM |
| every sample | matches an **independent** JS reference (`lut.mjs`) — all 16 levels walked, a master fade to silence and back, voice-against-master and voice-against-voice opposed fades, and both voices at full scale into the clamp |
| the normal slot | **57.8%** of its interval at two voices; worst slot 79.6% (the block edge), against §4's 80% |
| code | **1,784 B**, plus a 4 KB level family and a 512 B clamp table |

Three things carry it:

**Production is locked to consumption, and the gate checks it rather than
asserting it.** Slot *i* plays sample *i* and builds sample *i + 17*, one of
each, for ever — verified per slot over the whole run: exactly one play fetch
and exactly one finished store, a build-to-play distance that never moves
(16 = the 17-sample lead less the one-sample fetch-ahead, which is where the
measurement points are), across 77 page wraps, with nothing reading a sample
still under construction. Removing one `call mix_one` from the image makes it
fail, which is how the check is known to bite. The ring cannot drain and cannot
overrun; there is no fill counter, no low-water mark and no regulator. The
property the shipped engine spent four measurement rounds trying to obtain is
here a consequence of the schedule, and the 17-sample lead is what buys the
block — a level change lands on a block edge and is whole (§3.4).

**Every slot's work is constant time, and that is a hard constraint.** A
cycle-placed schedule has no clock to wait on: work that can finish early
*does*, and then the next DAC write moves. So the mixer carries no
data-dependent branch. The saturating add of two voices is where that bites,
and the answer is a 512-byte table indexed by the carry out of `add a,(hl)` —
five instructions, no jump. The branch-and-fix form is 10 cycles on the common
path and 35 on the rare one, and in this structure the difference has to be
padded away on *every* sample anyway, so the branch buys nothing.

**Everything is biased-unsigned, end to end**, with the conversions baked into
the tables — source byte, both level lookups, the clamp, the ring, the DAC.
That is 21 cycles a sample against the same code with `xor $80` where it would
otherwise be needed, which is 6% of the period.

The generator **refuses to emit a slot that overruns**, and it named a real
one: two voices, plus CSM's two frequency writes in a single slot, plus the
Timer B reset is 396 cycles of a 358-cycle interval. The fix is the one §3.5
asks for — the FM transaction is split across two slots, each re-latching
`$2A` behind it — not a smaller estimate.

## What the COMPLETE 2ch engine's budget looks like

§10.3 step 2 (R1) asks for the finished 2ch version's whole placement before
any more of it is written, with nothing left at zero because it does not exist
yet. So the reservations are **executed**: a `complete` build runs every
unwritten feature's cycles as padding and claims its RAM, and the same §6 gate
runs against it. A table of intentions cannot fail; this can.

| | |
| --- | --- |
| cycles | **1,033 reserved per 16-sample block** (64.6 a slot) on top of the mixer's 207. Worst slot **79.6%**, mean 77.2% — the worst slot is unchanged from the prototype, which is what R1 asks for |
| RAM | **8,096 B of 8,192 claimed, 96 B unclaimed** — and 96 B is not a margin |
| code | **2,384 B of the 2,560 B region**: 1,776 built plus 608 estimated from instruction sketches. 176 B spare |

What the reservations buy, and the rate each one is sized for:

| per block | cycles | what it buys |
| --- | --- | --- |
| output index + snapshot | 300 | the §3.7 publication: a 32-bit add, the four index bytes into the inactive bank, a generation, and the 1-byte publish bank written last |
| voice run state | 260 | two voices' blocks-left countdown and loop-or-advance, selected branch-free and **staged**, not applied |
| command dispatch | 145 | one command a block = **624 commands/s**, against roughly 10 PCM events a frame |
| YM / PSG writes | 280 | four a block = **2,497 writes/s = 41.6 a frame**, which is the shipped driver's typical |
| block edge B | 48 | the two staged source pointers into `DE'`/`IX` |

Two things this settles, and one it does not:

**The block edge splits into two slots, and it has to.** All five activations —
three level pages and two source pointers — must land between the last mix of
one block and the first mix of the next. That window is not one slot: it spans
the tail of the slot that builds a block's last sample and the head of the next
one, because each slot's mix sits in the middle of it. Part A (the levels) is
implemented at the tail; part B (the pointers) is reserved at the head. Putting
all of it in one slot is 333 cycles = 93% of the interval, which passes the
deadline and blows the design margin.

**The 4 KB level family is what makes the schedule affordable, not what
threatens it.** §3.4 asks for a second candidate only if the integrated
reservation does not hold — it holds, with 96 B. And the obvious alternative
is worse where it matters: halving the tables by symmetry (16 levels × 128
entries) saves 2,048 B and costs sign handling on all three lookups, ~+45
cycles a sample. That takes the mixer to 252 and leaves 555 cycles a block
under the 80% line against the 1,033 reserved — it fits the 100% *deadline* and
not the design margin. The trade is bytes for exactly the headroom the
remaining work needs.

**It does not settle the ROM window.** The mixer reads both voices every
sample, so both sources must be inside the same 32 KB bank at once — the Z80's
bank register is nine serial writes to `$6000`, ~120 cycles, which cannot
happen twice a sample. Either all PCM in play lives in one bank (cost 0, and
the exporter's problem), or the mixer goes voice-outer over half a block and
switches twice a block (~240 cycles, and the fixed-lead invariant changes
shape). This is a design decision, not an implementation detail, and it is
listed with the other open items below.

## It runs on BlastEm, and the machine corrected the model

`npm run dac-stream:machine` builds a minimal cartridge — vectors, a header, a
twenty-instruction 68000 bootstrap that holds the Z80, copies the image, sets
the bank register and lets go — and runs it on BlastEm as a libretro core with
the probe patch's `$2A` log. There is no m68k toolchain here, so the bootstrap
is emitted directly by `rom.mjs`; that is the whole 68000 side of this test.

Every schedule the JS model passes also passes there:

| case | rate | intervals (master) | holes past 1.5T |
| --- | --- | --- | --- |
| output only | 9,987.57 Hz, **−0.0000%** | 5,334–5,418 (T = 5,376) | 0 |
| one voice | 9,987.57 Hz, **−0.0000%** | 5,376–5,376 | 0 |
| two voices (+ CSM) | 9,987.57 Hz, **−0.0000%** | 5,376–5,376 | 0 |
| 2ch complete budget (+ CSM) | 9,987.57 Hz, **−0.0000%** | 5,376–5,376 | 0 |

…and every sample matches the same reference the JS gate uses. The interval
spread in the first row is the **probe's own resolution**, not jitter: BlastEm
stamps a `$2A` write with the YM's cycle counter, which advances in 42-master
steps, so a 358-cycle slot (5,370 master) reads as 5,334 or 5,376. The five
values sum to 26,880 = exactly five nominal periods, which is the group closing
on itself.

**What the machine found that the model could not.** The first two-voice run
came back at 9,823.12 Hz — **−1.65%** — with every sample still correct. The
cause is the 68k bank window: a Z80 read at `$8000+` is not a RAM read.
Measured by running the same schedule with zero, one and two window reads a
sample:

| window reads a sample | 0 | 1 | 2 |
| --- | --- | --- | --- |
| measured rate | 9,987.57 | 9,904.66 | 9,823.12 Hz |
| error | −0.0000% | −0.8301% | −1.6465% |

Perfectly linear: **45 master clocks = 3 Z80 cycles per window read**, constant
to within the probe's resolution. That number replaces a guess — the shipped
engine's `PACE_WINDOW` is 14 and `gen-mixer.mjs` says in its own comment that
it has never been measured. It is a *floor*: the 68000 was spinning in a
two-instruction ROM loop while this was taken, and a 68000 doing VDP DMA
contends harder (R1 step 3 stage 4).

A constant, predictable wait is not the unpredictable external stall §3.1 says
padding cannot absorb — it is charged like any other cycle. So `config.mjs`
carries it, the generator bills it, the JS machine models it, and the rate came
back to −0.0000% on BlastEm at every voice count.

**Paying it cost six cycles a sample, and the machine's own measurement said
where to find them.** Voice 0's contribution used to be parked in the ring slot
and read back with `ld h,b`/`ld l,c`/`add a,(hl)` — 15 cycles. It now waits in
`IYL` (`ld iyl,a`, `add a,iyl`, 16 total against 22), which is exactly the six
back, and it makes the ownership argument trivial as a side effect: a partial
sum never enters the ring at all, so the "nothing reads a sample under
construction" check has nothing left to catch.

**BlastEm is still a model.** It is the reference implementation we are arguing
with while a hardware round is expensive, and it has already found what the
instruction model could not. Nothing here has run on a Mega Drive.

## The three structural decisions

**1. The slot boundary IS the DAC write.** Each output interval begins with
`ld (de),a`, so the interval between two writes is the slot's length by
construction. Work placed after it delays only the pad, never the next sample.
That is what makes "does CSM change the PCM period?" answerable by reading the
generated code rather than by measuring and hoping.

**2. There is no interrupt, and there is no phase reference either.** The Z80
runs with interrupts disabled from boot and never takes a vblank (§3.1 adopts
this in R1). The DAC's clock is the instruction stream: five slots are 1,792
cycles *exactly*, so the average carries no error to accumulate.

An earlier version of this file called Timer B the phase reference. **That is
withdrawn** (§3.2, R1). Reading the overflow flag answers "did *any* overflow
happen since the reset", so the reset→read window has to be shorter than one
timer period for the answer to constrain anything — and it never was, at any
cadence tried. The gate now measures the window and says so:

    Timer B traffic (NOT a phase reference, §3.2 R1): 9988 reads, flag seen 100%
      · reset→read window 1739 cyc vs a 1075.2 cyc period — CANNOT carry information

Timer B's traffic remains available as a **YM load case** and is off in the
normal profile. The engine has no wall-clock phase information at all; only the
instrument does, and the numbers it reports (time from a real overflow to the
engine's read) are not the DAC's phase error and not any estimator's error.
The 68000 gets the time from the published output index instead (§3.7).

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
| `lut.mjs` | the level family, the clamp table, and the arithmetic that DEFINES both. The gate's reference computes from that arithmetic and **never indexes the generated tables** (§3.4, R1) — a reference that read them could not fail on a table that is wrong. `tablesAgree()` checks the tables against the same arithmetic as a separate assertion |
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

- **P2 is not finished.** §5's order is 1ch → 2ch → independent volume →
  master → loop → ROM bank boundary, and it stops after the master. There is
  **no loop, no ROM bank crossing, and no note start or stop**: the source is
  one 256-byte page per voice and `inc e` / `inc ixl` wraps it, which is why
  nothing here needs a `left` counter or a bank register yet. Those are the
  next three cases, and each of them is boundary work that has to be split
  into constant-time pieces before it can go in a slot.
- **The ROM bank question above is unanswered**, and it decides whether the
  interleaved per-sample mixer survives contact with real sample data.
- **A third voice has not been tried.** §5/P5 says one dimension at a time,
  and the two-voice normal slot is at 57.8% — a third adds ~90 cycles, which
  is 25 more points, and the block edge slot is already at 79.6%.
- **No command protocol, no host transfer** (P3). Level changes arrive as the
  harness poking Z80 RAM at a chosen cycle, which is the 68000's write
  *without* the bus grab it would really cost. The bus-grab case exists to
  prove the instrument can see a grab, not to claim anything about §3.6. It is
  reported as informational and is excluded from the pass: a 700-cycle grab
  makes a hole of up to 2.95 sample periods, which is exactly the problem §3.6
  says to measure rather than assume away.
- **Nothing has run on hardware.** §6.4's third column is empty; the BlastEm
  column is now filled for the schedules above, at a light 68000 load only.
- **The 68000's bus grab is measured but not solved.** The informational case
  takes the bus on a schedule and the DAC loses 2.06% of its rate with holes to
  1.61T. That is §3.6's question and it has not been answered.
- The 60-second representative case runs; the 10-minute one in §6.2 does not
  (the trace is held in memory, and that is the thing to change first if it is
  wanted — the cycle stamps themselves are already 64-bit-safe doubles).
