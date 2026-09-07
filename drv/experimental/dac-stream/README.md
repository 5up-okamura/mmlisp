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
npm run dac-stream:probe-test  # the instrument's own negatives, incl. on the core

node experimental/dac-stream/machine-probe.mjs --case NAME --seconds N \
  [--strict]          # every case is required, nothing is informational
  [--fault NAME]      # drop-copy | no-commit | early-commit | late-request
  [--marks]           # build the 68000 side with its own timestamp writes
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

## §3.6, priced — and a BUSREQ transfer does not fit

R1 makes this the thing to settle before any more of P2 is written, so the ROM
does a real transfer: request the bus, wait for the grant, copy N bytes into
Z80 RAM, release. Measured on BlastEm, as the time the Z80 is stopped:

| bytes a grab | 1 | 16 | 64 | 256 |
| --- | --- | --- | --- | --- |
| the Z80 stops for (Z80 cycles) | **54.6** | 218.4 | 741.1 | 2,826 |
| rate at 10 kHz, one grab a frame | −0.083% | −0.724% | −2.461% | −8.839% |
| intervals past 1.10T | all the grabs | all | all | all |
| holes past 1.5T (3 s) | 0 | 333 | 327 | 306 |

The fit is **44 + 10.9N Z80 cycles**, and both halves of it matter:

- **The fixed cost alone is 44 cycles**, against §3.6's allowance of 0.10 T =
  **35.8 cycles** inside one output interval at 10 kHz. *No* BUSREQ transfer
  fits, not even a single byte — the smallest possible one already pushes its
  interval to 1.16 T.
- **Splitting a transfer makes it strictly worse.** N one-byte grabs cost 55 N
  where one N-byte grab costs 44 + 10.9 N. §3.6's second option — "短い分割転送"
  — is the wrong direction, and this is the measurement that says so.
- **The per-frame budget binds even harder than the per-interval one.** §3.6
  allows ~60 Z80 cycles a frame; that is 1.5 bytes. The shipped driver moves a
  write list of up to ~190 bytes a frame, which is 2,115 cycles — **35× the
  allowance**.

The allowance scales with the period, so the same experiment at the clock the
driver ships at today:

| 3,329 Hz, allowance 107.5 | 4 bytes | 16 bytes |
| --- | --- | --- |
| the Z80 stops for | 87.7 | 218.4 |
| every interval inside 0.90–1.10 T | **yes** | no |
| mean rate error | −0.138% | −0.366% |

So a four-byte grab at 3.3 kHz is the first thing measured that fits the
*interval* bound — and it still fails the ±0.1% mean, because 91.5 cycles a
frame is over the frame budget. **There is no clock in this family at which a
BUSREQ transfer carries a driver's command traffic inside §6.2.**

What that leaves, with the numbers this prototype can already put on them:

- **The Z80 reads 68k RAM through the window instead.** A window read measures
  3 Z80 cycles and stops nothing at all. The obstacle is that the window is one
  32 KB bank and the samples are in it: a mailbox in 68k work RAM needs the
  bank moved and put back, which is nine serial writes to `$6000` each way,
  ~126–180 cycles a switch from the instruction costs measured here. Once a
  block that is ~250–360 cycles against the 145 the command reservation holds —
  affordable, but it is a re-plan, not a tweak.
- **A cooperative window**: the 68000 grabs at an instant the Z80's schedule
  expects, and that slot's pad is generated short by the stall. It needs the
  68000 to know the Z80's phase to about ±10 cycles, which the published output
  index does not currently give it.
- **Widening the interval bound for one interval a frame**, which is a change
  to §6.2 and therefore the designer's call, not this prototype's.

## R2 — the transfer measured properly, and a cooperative window that holds

R2 (`docs/dac-engine-implementation.md` §11) sent the transfer question back
with three corrections: the 44-cycle "fixed cost" was this ROM's `LEA`s and
loop setup executed *inside* the grab; the log measured request→release, not
the Z80's stop→resume; and "a frame" was a `DBRA` count. All three are fixed.
The instrument now records the Z80-side DAC access (before the YM's 42-master
quantisation), the modelled stop and resume, the notification, every copied
byte with its offset, the commit byte, and the first unrequested BUSACK poll —
and a value mismatch is a fatal error whatever the case's label says
(`probe-analysis.mjs`, pinned by `probe-selftest.mjs` including a CLI negative
that corrupts one sample and expects exit 1).

**The minimal uncompensated transfer**, setup moved before BUSREQ, copy
unrolled, addresses held in registers — measured as the Z80's stop→resume:

| bytes a grab, ~63 grabs/s | 1 | 2 | 4 |
| --- | --- | --- | --- |
| Z80 stopped (Z80 cycles) | 4.3–17.3, p50 7.3 | 10.4–23.4, p50 13.3 | 23.5–35.5, p50 25.5 |
| mean rate | −0.0143% | −0.0251% | −0.0468% |
| §6.2 | **pass** | **pass** | fails the 99.9% band |

So one or two bytes a frame fit uncompensated, and the earlier "no BUSREQ
transfer of any size fits" is withdrawn as a statement about the hardware —
it was a statement about a routine.

**The cooperative window** (`cooperative.mjs`): the Z80 raises a notification
(one write into 68k work RAM through the bank window), keeps a window of
`nop`s, lowers it, then looks at a local commit byte the 68000 wrote last
before releasing. Commit present → that slot's pad is generated
`compensation` cycles short, so the planned stop is repaid where it happened.
Commit absent → the full pad runs; the Z80 never waits for the host. The
68000 polls for the low→high edge with interrupts masked and skips a window
it arrives late for.

| | 4 B, ≤125 grabs/s | 8 B every 5 slots (**16 KB/s**) |
| --- | --- | --- |
| compensation | 41 | 65 |
| host phases walked | 21 (`every` 11,000–13,000) | 31 (`every` 0–600) |
| mean-rate error | −0.0000%…+0.0013% | −0.0004%…+0.0001% |
| worst interval | 1.004 T | 1.008 T |
| Z80 stopped, all phases | 38.3–42.5 | 62.8–68.3 |
| 60 s at the phase that used to fail | — | 597,275 samples, −0.0000%, gaps 0.993–1.004 T |

**What the phase-dependent failure was.** The window was a `djnz` loop.
BUSACK is granted at an M-cycle boundary, so on a 13-cycle `djnz` iteration
the stop begins up to 13 cycles after the request, and *where* depends on the
68000's phase: measured 53–65 cycles, averaging the compensation in seven
phases and missing it by 4.3 in the eighth — the +0.2387% that stopped the
work. A window of `nop`s bounds that to 4 cycles, and the stop is 62.8–68.3 in
every phase. The compensation is then a property of the transfer routine (its
fixed hold plus grant and resume latency), set from the same routine's
measured stop and *proved* across the host's phase, not fitted to a rate.

**The hardware-facing rule this leaves.** In the model the residual averages
to zero because grants land on the emulator's sync points; on silicon the
residual is the M-cycle grant jitter, ≤ 4 cycles on `nop`s, of unknown mean.
At 2,000 grabs/s a mean residual of 1 cycle is 0.056% of the rate, so the
±0.1% budget allows a mean residual of about 1.8 cycles at that density, or
proportionally more at lower density. That is the number a hardware round has
to return.

**What this does not settle.** All of it is the P1 output-only engine with a
340-cycle pad. The 2ch mixer leaves 151 cycles in a plain slot and ~76 in a
reserved one; the window (64) plus the notification traffic (~40) plus the
compensation (41–65) does not fit either without re-planning the reservations
— R2 §11.4 step 4 and §11.5 (ROM bank) are still open, and Z80 reads of 68k
work RAM are withdrawn by R2 as a mechanism. Nothing has run on hardware.

## Can the window enter the 2ch schedule, and can a game's 68000 reach it?

Two questions R2 §11.4 step 4 leaves, with numbers.

> **R3 supersedes the second half of this section.** The computed-timing
> conclusions below — "±5 Z80 cycles", "the Z80 side is unchanged", the reading
> of `djnz` as 13 cycles of blindness, and the I/O-only grant as a rule of the
> core — did not survive review or re-measurement. What replaced them is the
> next section; the budget table here still stands.

**The window budget in a mixer slot.** A plain 2ch slot has 151 cycles of pad
and a reserved one 76–87. The cooperative slot's fixed traffic — notify up
(23), notify down (20), commit check (46) — is 89. What is left for the window
itself, after the compensation:

| bytes a grab | 1 | 2 | 4 | 8 |
| --- | --- | --- | --- | --- |
| compensation | ~10 | ~17 | 41 | 65 |
| window in a plain slot | 52 | 45 | 21 | **−3** |
| window in a reserved slot | none | none | none | none |

…and that is before the bank: the notification is a write into 68k work RAM
through the bank window, the mixer needs the window on the sample ROM, and a
bank switch is nine serial writes (~126 cycles) each way. **The window as
prototyped does not enter the 2ch schedule.** What could is a window with no
steady-state notification — the 68000 computing when the window is — which
also removes the bank conflict, since the one notification it needs is at boot.

**Computed timing, measured.** `rom.mjs` gained a 68000 program that reads the
first window opening once at boot, then keeps `rem` — master clocks from the
current HBlank tick to the next opening — from the VDP's V counter (elapsed
lines, so a tick lost while the handler is busy costs nothing), skips and
counts a window already passed, and when one is due before the next tick
busy-waits the remainder and grabs. No polling, no notification. The
instrument measures where the 68000's *request* lands (that it controls
exactly) apart from where the emulator *grants* it.

- **In steady state it tracks to ±5 Z80 cycles**: 85 consecutive windows a
  frame land within 1,665–1,675 of the opening with `rem` varying 374–3,374
  across them — the busy-wait cancels the tick phase exactly. A 64-cycle
  window holds that.
- **Once a frame, at the vblank crossing, the belief is knocked ~228 cycles
  (one line) and recovers over ~10 windows.** Using the VDP's line counter as
  the time base across the vblank reload is where the emulator and the
  arithmetic disagree; the 38-line hypothesis was tested and falsified. The
  real protocol does not depend on it: R2 §3.7 has the 68000 read the Z80's
  published output index at every transfer, so error never accumulates past
  one window.
- **The landing phase is an attractor, and that is a property of fixed
  compensation.** The boot calibration cannot move the steady-state landing
  (1,331 → 1,676 → 1,670 for three very different offsets) because the Z80's
  clock is pulled by (stall − compensation) at every grab until the grab
  phase settles where the two are equal. On hardware the stall varies ±4
  cycles with the M-cycle the request lands on, so the pull is weak; in the
  model it is strong, because —
- **BlastEm grants a pending BUSREQ at the Z80's next I/O access**, which in
  this engine is the next DAC write: the modelled grant phase inside a slot is
  the emulator's scheduling, not an M-cycle boundary. Requests landed 1,670
  after the opening while grants clustered at 256 + k·358. With four YM
  status reads inside the window (`windowSync`, harmless, emulator-only) the
  grant follows the request (14.2% of grants inside vs 1.0% for identical
  requests).

So: a 68000 can reach a 64-cycle window from HBlank without polling, in the
model, to ±5 cycles; a computed-timing run that *passes §6* has not been
produced, because the attractor sits outside the window and the vblank
crossing needs the §3.7 re-anchor. Those are the next two pieces of 68000
work, and they are 68000 work — the Z80 side is unchanged.

**BlastEm is still a model.** It is the reference implementation we are arguing
with while a hardware round is expensive, and it has already found what the
instruction model could not. Nothing here has run on a Mega Drive.

## R3 — the instrument was scoring the wrong thing

R3 §12.2 named four defects and each one turned out to change a result.

**The foreground load never ran.** The 68000's idle load divided `$12345678`
by 7, whose quotient does not fit in 16 bits: DIVU detects the overflow, leaves
the operands alone and exits early, so every iteration took the short path and
the operands never changed. The `load calibration` case now measures it, with
interrupts masked and the Z80 untouched, against a mark pair whose empty body
gives the mark instruction's own cost:

| | mark | `nop` | `divu` /7 | `divu` /7, overflowing | `divu` /$7FFF |
| --- | --- | --- | --- | --- | --- |
| 68000 cycles | 20.0 | 4.0 | **140.4** | **22.3** | 148.3 |

The load was 22 cycles, not 140. With a dividend that divides, the
interrupt-to-entry delay measured from the VDP's own raise (a new probe event)
to the handler's first bus write is:

| load | entry delay, 68000 cycles | ticks lost |
| --- | --- | --- |
| short (`nop`) | 65..86, p50 70 | 0 of 3,304 |
| `divu` that divides | 65..**215**, p50 136 | 0 of 3,304 |
| level 4 masked ~12 lines | 60..**6,027**, p50 1,582 | **1,218 of 3,304** |

So the earlier "±5 cycles under load" was measured under a load of 22-cycle
instructions. (The masked row's minimum is the instrument's pairing floor, not
a latency the machine reached — a tick raised while the previous handler is
still being entered cannot be attributed.)

**The HBlank cases were never checked as transfers.** `analyzeTransfers()` ran
for the notified cases only, so for every HBlank and computed-timing case the
payload, its order, its byte count and the commit went unexamined; the PCM
matched because the PCM does not depend on them. All modes now run the same
checks, and the four ways to break the protocol are injected deliberately
(`--fault`) against a case that passes without them:

| injected fault | what the gate says | exit |
| --- | --- | --- |
| none | 45/45 stops strictly inside the window, 0 carried | 0 |
| `drop-copy` | transferred byte count | 1 |
| `no-commit` | missing or premature transfer commit | 1 |
| `early-commit` | missing or premature transfer commit (PCM still 9,987.56 Hz) | 1 |
| `late-request` | commit adopted by a window it was not written in, 0/45 inside | 1 |

`early-commit` is the one to read twice: the clock is perfect and every sample
is right, and the protocol is broken. A fault that the emitted path would not
reach is refused at build time rather than passing quietly.

**The window is not the notification's lifetime.** The notification brackets
the window by
`(13 − λ) + bankWait + 64 + 4 + λ`, where λ is where inside `ld (nn),a` the
write is timestamped — so the span is 81 + bankWait whatever λ is. Measured, it
is 84, which yields **bankWait = 3** independently of the earlier
`windowWait` measurement, and leaves λ unknown and bounded by 13 cycles. Every
boundary is therefore a band, and the analyzer reports a stop as strictly
inside (inside for every λ) or only loosely inside. A window with a grab in it
is longer by exactly the stall, which is subtracted before the geometry is
taken — taking the median of all of them would have priced the stall into the
window and put every stop outside its own window.

**With those in place, the notification-free cases fail on protocol, not on
timing.** `computed timing 8B, unloaded 68k` at 2 s: mean rate −0.0010%, and
8 stops strictly inside their window, 72 loosely, **2,881 outside**, with
**2,798 commits adopted by a window they were not written in**. That last
number is the failure a fixed compensation cannot survive: a slot repays a
stall that happened somewhere else. Every HBlank and computed case is now a
fatal failure rather than an informational timing miss — 11 of them.

The cooperative regression is unaffected: `cooperative density 8B/5 slots
delay 300` holds 3,449 of 3,449 stops strictly inside, 0 carried, 15,977 B/s,
−0.0000%.

**And the M-cycle explanation was wrong.** BUSREQ is sampled at the end of the
machine cycle in flight, not at the end of the instruction (Zilog Z80 CPU User
Manual, bus request/acknowledge), and a branch-taken `djnz` is 5/4/4, not 13
cycles of blindness. What a nop run buys is a uniform 4-cycle boundary lattice.
The measurement stands on its own — 53..65 cycles of stop under a `djnz`
window against 62.8..68.3 under nops — and the hardware's stop width and mean
residual remain **unmeasured**. `windowSync` is a different ROM with different
bus activity, and its results are not evidence about the plain one.

## The phase contract, and where the notification-free window fails

R3 §12.2 C asks for this table before any more 68000 code. It is filled in with
what was measured. R4 then corrected two of the claims that were made from it,
and this section is the corrected version.

| the contract asks | what there is |
| --- | --- |
| **identifying the target window** | Nothing identifies it. The Z80 publishes no output-boundary number, and R3 already withdrew the idea that one would resolve sub-slot phase anyway. The 68000 can only count windows forward from a single boot notification. |
| **what the Z80 publishes** | Nothing, in the steady state. The one mechanism that costs no bus grab is a write into 68k work RAM through the bank window: 23 Z80 cycles, and in P2 it needs the bank pointed away from the sample ROM — nine serial writes each way, which have to be split across slots. |
| **what the 68000 observes** | The VDP's HV counter, `$C00008`, is the only clock it can read without taking the Z80 bus. Stamped at handler entry, **the widest observed spread of times within one H value was 69–74 master clocks** — over 3,304 entries whose raw latency spans 1,050 master under a divide load, and over 2,059 entries spanning 43,000 master under a masked load with 210 distinct H values. That is evidence the H value carried line-position information in those conditions. **It is not a decoder's error bound**: no decoder exists, and the figure contains nothing about each group's centre, the read-to-mark delay, unobserved H values, or how a line or frame would be identified. |
| **the phase uncertainty** | 68000 entry, uncorrected: 65..215 cycles (divide load), 60..6,027 (masked). Busy-wait granularity: 70 master an iteration. Request→grant in the model: 3..6 Z80 cycles; on hardware, unmeasured. The Z80's own phase moves by `hold − compensation` at every served transfer — see below for what that was measured to do, and for what it was wrongly claimed to do. |
| **what happens when the deadline cannot be met** | Implemented: the handler counts the window and skips rather than requesting late. |
| **the cost on both CPUs** | Opening notification 23, closing notification 20, commit check 46, window 64, and the planned stop itself — **218 Z80 cycles at compensation 65**, against 151 of pad in a plain 2ch slot, before any bank switch. (The same arithmetic as the `151 − 89 − compensation` table above, which leaves −3 for an 8 B window; an earlier draft of this row said "133", which had dropped the closing notification and the stop.) |

**What the residual actually does.** A served slot runs long by
`r = hold − compensation`. Over 5,449 notified transfers in one 3-second run:

| | |
| --- | --- |
| mean | +0.0002 Z80 cycles |
| sd | 1.137 |
| cumulative excursion | **−3.53 .. +2.80**, ending +1.13 |
| block-sum sd at L = 10 / 100 / 1000 | 0.24 / 0.22 / 0.00 — a random walk would give 3.60 / 11.37 / 35.96 |
| autocorrelation | lag 1 +0.139, lag 2 −0.236, lag 10 **+0.867** |

So in the notified engine the residual is **bounded and periodic, not a random
walk**: the block sums do not grow with the block length at all. An earlier
draft of this section took the standard deviation of 1.136 and computed a
790-grab drift out of a ±32-cycle window; that calculation assumed independence
that the autocorrelation refutes, and it is withdrawn. So is the recurrence
`φ_{n+1} = φ_n − r(φ_n)` with gain 1.044 and a repelling fixed point near 54:
its table was indexed by the STOP position while `φ` was the REQUEST position,
and it did not separate the request-to-grant delay, skips, or a compensation
adopted in a different window. The underlying observation — that `r` fell from
+2.40 to −2.37 across stop offsets 0 to 100 over 874 grabs — is kept as an
observation, with no model on top of it.

**Why the notification-free window is suspended anyway.** The suspension does
not rest on any of that. It rests on what the notification-free cases measure:
in `computed timing 8B, unloaded 68k`, 2,881 of 2,961 stops land outside the
window they were computed for; 2,798 commits are read by a window they were not
written in; and, measured independently from the slot's own length, **2,257
windows shortened their pad without having been stalled at all**. Each of those
is also a DAC interval violation — the minimum interval of 4,395 master is
5,376 less one compensation — so the protocol failure and the §6 failure are
the same event seen twice. The notified engine has none of them: 5,449 of
5,449 stops strictly inside, 0 carried, 0 windows repaid without a stall.

Per R4, the next unit is §3.2's **bounded phase correction** as its own P1
prototype, and its first deliverable is a phase OBSERVER with no correction at
all, judged on what it can see. The first candidate to observe is a real Z80
read of the VDP HV counter — which is not assumed to be free, non-stalling, or
even coherent until it has been read.

## The phase observer, step one: the Z80 can read the VDP

R4 §13.3 orders §3.2's bounded phase correction as its own P1 prototype, and
its first deliverable is an OBSERVER with no correction, judged on what it can
see. `observer.mjs` generates one, as extra work inside `gen-stream.mjs`'s own
slots — so it rides the real mixer, the real CSM traffic and the real pad
arithmetic, and a reading that does not fit is a slot overrun at generation
time rather than a second loop that happens to have room.

**It is affordable.** `ld a,($7F09)` costs 13 cycles plus the 3 this core
charges for reaching the 68k bus — the same penalty the bank window pays. Every
observer case passes §6 at 9,987.57 Hz, −0.0000%, intervals 5,370..5,385
master, with the 68000 idle and with it running the corrected divide load:

| schedule | worst slot without | with H + store (29 cyc) | with V+H + store (45 cyc) |
| --- | --- | --- | --- |
| complete 2ch budget, CSM on | 79.6% | **87.7%** | **92.2%** |

That is the comparison that matters: the notified transfer window needs 218
cycles into 151 of pad and does not fit, and an observer that reads the VDP
does.

**H carries the line position; V identifies the line.** In the 2ch schedule,
which reads sixteen times a loop and so samples many phases, **210 distinct H
values were observed and the widest observed spread of times within one value
was 15 master clocks** — one Z80 cycle. V gave 232 distinct values with a
spread of a whole line, which is what a line number is. Both are observations
about these runs and neither is a decoder's error bound; there is no decoder
yet.

**The read positions are a lattice, not a sample of the line.** Both clocks are
exact rational multiples of the master clock, so a fixed schedule reads HV at a
finite set of phases forever — 57 of them in the 5-slot P1 loop, where the
spread within a value is therefore 0. That is a property of the sampling, not a
resolution. It is also good news for a decoder, which only ever has to decode
the phases its own schedule produces.

**A V+H pair is not a snapshot.** The two reads are two bus accesses exactly 16
Z80 cycles apart. Reading H twice moves it by a median of 15 units, with
extremes of +61 and −242 — the counter's jump inside the line and its wrap at
the end of it.

**What this is not.** In the core in use, each read also charges the 68000 8 of
its own cycles, and that core's comment says the 68000-side delay is an
estimate wanting a fresh logic-analyzer capture. Nothing here has run on
hardware, where Z80 access to the VDP is a documented hazard area rather than a
free clock. The decoder itself — value to time, line and frame identification,
the counter's discontinuities, missing readings, restart — is step 3 and does
not exist.

## The phase decoder: observation alone settles it, to about one Z80 cycle

R4 §13.3 step 3 asks whether the observer can decide the phase from what it can
see, with the states it cannot distinguish reported rather than filled in.
`decoder.mjs` is that decoder and `npm run dac-stream:decoder` is the answer.

**What it is allowed to use.** The byte the Z80 read, the read's index in the
schedule, and state it kept itself. That is all. The instrument's absolute clock
appears in `scoreDecode()` and nowhere else. Three chip constants are
calibrated — the VDP's line origin, H → phase within the line, and V → which
line — and **the calibration runs are not the evaluation runs**: the tables come
from the three disturbed runs, which are the only ones with dense phase
coverage, and every boot phase scored below is data they have never seen. That
separation is not a formality: an earlier pass that let the evaluation runs into
the table turned a 17-master worst error into 257 and invented 764 false alarms.

**H alone, eleven runs, 43,000 readings:**

| | worst error vs the instrument | within tolerance | false alarms | missed shifts |
| --- | --- | --- | --- | --- |
| clean | 17 master (1.1 Z80 cyc) | 100% | 0 | 0 |
| 1 B unrepaid stall | 18 master | 100% | 0 | 0 |
| 16 B | 18 master | 100% | 0 | 0 |
| 64 B | 18 master | 100% | 0 | 0 |
| seven other boot phases | 9–16 master | 100% | 0 | 0 |

So the Z80 can measure a shift in its own schedule to about **one Z80 cycle**,
from one byte read per group, and it never cried wolf in 43,000 reads.

**Where H stops.** H repeats every line, so a shift of more than half a line
(±114 Z80 cycles) is reported the short way round and the difference is not
recoverable from H. Measured: 0% of shifts in the clean and 1 B runs, 0.10% at
16 B, **18.77% at 64 B**, whose stalls reach 405 Z80 cycles.

**V extends the range to a frame, and brings two problems H does not have.**
33 of the 256 V values answer to more than one line of the frame, six lines
apart, and from the reading alone those are undecidable: the decode reports both
candidates and refuses to pick, which is 14.6% of a clean run's reads. And the
pair is not atomic — V is read 16 Z80 cycles before H, and a stall landing
between them was measured pushing them 126 cycles apart, which breaks the rule
that decides whether the line advanced in between. Those show up as the
whole-line residual errors in the disturbed V+H runs.

**So: use H, not V+H.** The shifts this has to measure are the size of a
compensation — 65 Z80 cycles — and a transfer window is 64. Both sit well inside
H's ±114, where H is exact, unambiguous, atomic and costs 16 cycles instead of
32.

**Not done.** The decoder is a JS model of one; the Z80 code for it (a
256-byte table lookup, a subtract and a compare, about 30 cycles) is not
written. Missing readings and a restart are untested, and so is hardware — where
the H → phase table would have to be calibrated again.

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
| `cooperative.mjs` | the P1 notified-window engine, and the window geometry every analysis reads |
| `case-config.mjs` | **one resolved case.** The CLI's overrides are applied once, and the object that is generated, run, analyzed and written to JSON is the same object (§12.3) |
| `rom.mjs` | the 68000 side: bootstrap, the transfer paths, the foreground loads, the instruction-time calibration, and the deliberate protocol faults |
| `machine-probe.mjs` | runs a case on BlastEm and reports it. `--strict` makes every case required; `--fault`, `--marks`, `--compensation`, `--capture-offset` |
| `probe-analysis.mjs` | the probe log: DAC timing, window generations, transfers in every mode, and the 68000's own timeline |
| `probe-selftest.mjs` | proves each of those can fail — including, with `--machine`, that every injected fault leaves the CLI non-zero |

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

- **No notification-free transfer works.** Every HBlank and computed-timing
  case fails, and after R3 they fail on protocol: the request lands outside
  the window it was computed for and the commit is adopted by a window it was
  not written in. The notified P1 window is the only transfer that holds, and
  it does not fit a 2ch slot (the budget table above). The phase contract
  R3 §12.2 C asks for — which window is being aimed at, what the Z80 publishes,
  what the 68000 can observe, the uncertainty, what happens when the deadline
  cannot be met, and the cost on both CPUs — is **not written**, and no further
  68000 work should start before it is.
- **The hardware stop width is unmeasured.** Every stop figure here is
  BlastEm's arbitration model. The nop window narrowed it in that model; what
  silicon does, and what the mean residual is at 2,000 grabs a second, is the
  number a hardware round has to return.
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
