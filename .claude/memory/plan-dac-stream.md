# DAC engine redesign — P0, P1, most of P2, and R1's three steps (2026-09-06)

**Current review (2026-09-07): resume from instruction §12, R3.** The polling
NOP window is the accepted P1 regression. Computed timing has not passed; fix
the overflowing DIVU load and the HBlank transfer-gate bypass, then specify
observable phase/expiry/recovery before further implementation. A published
sample index alone does not resolve sub-sample phase. Historical claims below
about DJNZ/BUSACK and an I/O-only emulator grant are superseded by §12.2 E.

The instruction is `docs/dac-engine-implementation.md`. The prototype is
`drv/experimental/dac-stream/` and its README carries the numbers. This file is
the decision record and the running state.

**Read this before continuing: P2 has not started, and three bugs found on the
way through change numbers that older notes in [[plan-68k-split]] quote.**

## P0 — the baseline, and what it says

`cd drv && npm run baseline` (`tools/baseline.mjs`) writes
`drv/out/baseline/<commit>.{json,md}`: identity, the configuration actually in
effect, five mirror stamps, artifact hashes, every gate run INDEPENDENTLY, and
the existing DAC instruments on four fixed cases with VALUE / TIME / BUS kept
apart. A failing gate is re-run once and both verdicts recorded, so a flake is
distinguishable from a failure.

What it found at `b702ca7`, and none of it was written down anywhere:

* **`npm run engine` fails 8 of 12 scenarios and has since `a48bacc`** — the
  "probe: carry an emit reserve across the ISR edges (gates not yet …)" commit,
  ~40 commits back. Bisected. Every PCM scenario reports 3-4 DAC writes where
  it wants 64. `verify:all` chains with `&&` and stops there, so `dac`, `ring`,
  `c-gate`, `sgdk:lint` and `ab` had not been run in that window at all.
* **`npm run mixer` crashes** — `undefined symbol "feed_one"`; the bench image
  references a routine that now lives in `engine.z80`.
* **`npm run sgdk:lint` fails** to compile the host files (this machine).
* `slot-gate` on `m3-pcm-softmix` fails 3 problems; `dac`, `ring`, `ab`,
  `slots:ab-core`, `selftest`, `mirrors` and `c-gate` (41/41) pass.
* The tools default to `TIMER_B_K=16` while the committed mirrors are at 1, so
  a bare `node tools/<x>.mjs` builds a different engine than the tree ships.
  Always `PCM_SPG=1 TIMER_B_K=1`.

## P1 — the isolated output engine PASSES, in the JS model

`npm run dac-stream`. At **9,987.57 Hz**, 10 s a case (60 s on the
representative one): mean rate **+0.0000%**, every interval 358 or 359 cycles,
worst phase error **0.8 cycles (0.22% of T)**, drift **−0.6 cycles over 60 s**,
**zero** holes, and the clock adds **−0.1 dB** to a 39 Hz tone's worst non-tone
bin — i.e. nothing above the measurement floor. 567 B of code. It holds with
Timer B observed and reset every group, with CSM programmed and writing, and
with five FM writes crowded into one slot (69.1% of that interval, ceiling 80%).
3,329 Hz and 13,317 Hz come out at +0.0000% from the same generator.

**Emulator only.** No BlastEm (`setup.sh` not run here) and no hardware; this
environment has no m68k toolchain. §6.4's second column is empty.

Three decisions worth not re-litigating:

1. **The slot boundary IS the `$2A` write.** Every interval starts with
   `ld (de),a`, so the interval equals the slot length by construction and work
   can only eat the pad. "Does CSM change the PCM period" becomes a property of
   the generated code rather than a measurement to hope about.
2. **No interrupt at all.** `di` from boot, the vblank is never taken. The
   clock is the instruction stream — 5 slots = 1,792 cycles EXACTLY at
   9,987.6 Hz, so nothing accumulates — and Timer B is the phase reference,
   read once a group with the harness recording every read's cycle. An ISR is
   ~90 cycles landing anywhere in a 358-cycle slot: a quarter of the period
   against a 5% tolerance, and reserving room for it in every slot is 25% of
   the budget for an event that happens once per 167 samples.
3. **The pad is solved, not tuned.** `schedule.mjs` finds an instruction
   sequence costing exactly what the slot has left and throws if it cannot.
   No `PAD_FRACTION`. 1, 2, 3, 5 and 9 cycles are the only unreachable
   residuals (no 5- or 9-cycle instruction destroys nothing) — a slot landing
   on one has to move an op, never round.

## P2 — TWO VOICES, INDEPENDENT LEVELS AND A MASTER PASS. Loops do not exist yet

`npm run dac-stream`, 20 cases. Two voices each with a 16-step level, composed
with a master, mixed into 16-sample blocks that a page-sized ring holds:

* **the clock does not move.** +0.0000%, intervals 358 or 359, phase 0.8
  cycles, zero holes — at one voice, at two, with CSM, and over 60 s
  (599,230 samples, drift −0.6 cycles).
* **every sample matches an independent JS reference** (`lut.mjs`): all 16
  levels walked, a master fade to silence and back, vel-against-master and
  voice-against-voice opposed fades, and both voices at full scale into the
  clamp.
* normal slot **57.8%** of its interval at two voices, worst slot 79.6% (the
  block edge), against §4's 80%. 1,784 B of code + 4 KB of level tables +
  512 B of clamp table.

Four things worth not re-deriving:

1. **Production is locked to consumption.** Slot i plays sample i and builds
   sample i+17, one of each, for ever. The ring cannot drain or overrun, so
   there is no fill counter, no low-water mark and NO REGULATOR — the property
   [[plan-68k-split]] spent four measurement rounds chasing is here a
   consequence of the schedule. The 17-sample lead is what buys the block, and
   a block is what makes a level change whole (§3.4).
2. **Every slot's work must be constant time.** There is no clock to wait on:
   work that finishes early moves the next DAC write. So no data-dependent
   branch may enter the mixer. The saturating add is where that bites, and the
   answer is a **512-byte table indexed by the carry out of `add a,(hl)`** —
   five instructions, no jump. Branch-and-fix is 10 cycles common / 35 rare,
   and the difference has to be padded away on every sample anyway.
3. **Biased-unsigned end to end**, conversions baked into the tables. 21 cycles
   a sample against the same code with `xor $80` where it would otherwise be
   needed — 6% of the period.
4. **The lead is 17, not 16, on purpose.** 16 aligns a built block with a slot
   block, which lands the block edge on the last slot of the 80-slot schedule
   — the one that also pays the loop-back — and takes that interval from 79.6%
   to 82.2%. One sample of latency buys it back.

**The generator refuses to emit a slot that overruns, and it caught a real
one**: two voices + CSM's two frequency writes in one slot + the Timer B reset
is 396 cycles of a 358-cycle interval. The fix is §3.5's — split the FM
transaction across two slots, each re-latching `$2A` — not a smaller estimate.
The error names the slot and everything in it.

**WHAT P2 STILL OWES.** §5's order is 1ch → 2ch → independent volume → master
→ loop → ROM bank, and it stops after the master. No loop, no ROM bank
crossing, no note start/stop: each voice's source is one 256-byte page and
`inc e` / `inc ixl` wraps it, so nothing needs a `left` counter or a bank
register yet. Those three are boundary work and each has to be split into
constant-time pieces before it can go in a slot. A third voice has not been
tried (+~90 cycles = 25 more points on a normal slot at 57.8%).

## R1 (design revision) — steps 1-3 DONE. STEP 3 SAYS STOP AND GO BACK

The designer's R1 revision accepted the eight reported findings and set an
order: correct the record, produce the complete 2ch allocation, check it on the
machine, and only then finish P2. Steps 1-3 are done and **step 3's answer is
that the transfer design has to change before P2 continues** — which is what
R1 itself says to do in that case.

**Step 1 — corrections.** Timer B is off in the normal profile and is no
longer called a phase reference: the gate now MEASURES the reset→read window
(1,739 cycles against a 1,075.2 cycle period) and prints "CANNOT carry
information", which is why the flag always read 1. The JS reference no longer
indexes the generated tables (it computes from the arithmetic; `tablesAgree()`
checks the tables separately). §3.3's fixed lead is checked per slot rather
than asserted — one fetch, one finished store, a distance that never moves,
over 194 page wraps; NOP out one `call mix_one` and it fails. The YM frequency
latch is checked apart from the `$2A` address latch.

**Step 2 — the complete 2ch allocation, EXECUTED.** 1,033 reserved cycles a
block run as padding in a `complete` build and the §6 gate runs against it:
worst slot 79.6%, mean 77.2%. RAM 8,096 B of 8,192 (96 B unclaimed, which is
not a margin). Code 2,384 B of a 2,560 B region (1,776 built + 608 estimated).
The block edge MUST split across two slots — all five activations have to land
between one block's last mix and the next block's first, and that window spans
two slots; one slot is 93% of an interval.

**Step 3 — IT RUNS ON BLASTEM, and the machine corrected the model.** There is
no m68k toolchain here, so `rom.mjs` emits the 68000 bootstrap directly (twenty
instructions: hold the Z80, copy, set the bank, let go). All seven schedules
pass at 9,987.57 Hz, −0.0000%, zero holes, every sample matching the reference.

* **A read through the $8000 window costs 3 Z80 cycles** (45 master), measured
  by sweeping 0/1/2 window reads a sample: 9,987.57 / 9,904.66 / 9,823.12 Hz,
  perfectly linear. Two voices first came back **1.65% slow** with every sample
  still correct. This REPLACES A GUESS — `PACE_WINDOW` is 14 in the shipped
  engine and gen-mixer.mjs admits it was never measured. It is a floor: the
  68000 was in a two-instruction loop.
* It is now charged in the config, the generator and the JS machine, and the
  rate is back to −0.0000% on the emulator at every voice count.
* Paying it cost 6 cycles a sample, and they came back by parking voice 0's
  contribution in **IYL** instead of the ring slot (`ld iyl,a` / `add a,iyl`,
  16 cycles against the 22 of park-and-reread). Side effect: a partial sum
  never enters the ring, so the ownership check has nothing left to catch.

**AND THE ONE THAT STOPS P2.** A real BUSREQ transfer — request, grant, copy,
release — stops the Z80 for **44 + 10.9N Z80 cycles** for N bytes (measured at
N = 1, 16, 64, 256; 54.6 / 218.4 / 741.1 / 2,826).

* §3.6's allowance is 0.10 T = **35.8 cycles** in one interval at 10 kHz. The
  FIXED COST ALONE is 44. **No BUSREQ transfer of any size fits**; one byte
  puts its interval at 1.16 T.
* **Splitting makes it worse**, because the fixed cost dominates: N one-byte
  grabs are 55N against one grab's 44 + 10.9N. §3.6's option 2 ("短い分割転送")
  is the wrong direction and this is the measurement that says so.
* The per-frame budget (~60 cycles) binds harder still: that is 1.5 bytes. The
  shipped driver moves up to ~190 bytes a frame = 2,115 cycles = **35x**.
* At 3,329 Hz the allowance is 107.5 and a FOUR-byte grab is the first thing
  measured that keeps every interval inside 0.90-1.10 T — and it still misses
  the ±0.1% mean, because 91.5 cycles a frame is over the frame budget.

So there is no clock in this family at which a BUSREQ transfer carries a
driver's command traffic inside §6.2. The alternatives, with the numbers this
prototype can already attach: the Z80 reading 68k RAM through the window costs
3 cycles and stops nothing, but the window is one 32 KB bank and the samples
are in it, so a mailbox needs the bank moved and restored — nine serial writes
each way, ~126-180 cycles a switch, ~250-360 a block against the 145 reserved;
or a cooperative grab at an instant the schedule expects, which needs the 68000
to know the Z80's phase to ~±10 cycles; or §6.2's interval bound relaxes for
one interval a frame, which is the designer's call.

## R2 — THE TRANSFER, MEASURED RIGHT, AND A COOPERATIVE WINDOW THAT HOLDS

The designer's R2 (`docs/dac-engine-implementation.md` §11) corrected the
transfer measurement: the 44-cycle "fixed cost" was this ROM's `LEA`s inside
the grab, the log measured request→release not stop→resume, and "a frame" was
a `DBRA` count. The designer's own session (Codex) rebuilt the instrument and
the transfer routine and prototyped the cooperative window; it ran out mid-way
with one phase failing (+0.2387%). Finished here.

* **Instrument** (`probe-analysis.mjs`, `probe-selftest.mjs`, probe.patch):
  Z80-side DAC access, modelled stop/resume, notification, per-byte copies,
  commit, first BUSACK poll. A value mismatch is fatal in every case; a CLI
  negative corrupts a sample and expects exit 1. `--every-sweep lo,hi,step`
  walks the host's phase; `--compensation N` overrides a case.
* **Minimal uncompensated transfer** (setup before BUSREQ, unrolled copy):
  stop→resume 1 B p50 7.3, 2 B 13.3, 4 B 25.5 cycles. **1 B and 2 B a frame
  pass §6.2 uncompensated.** "No BUSREQ transfer fits" is withdrawn as a
  hardware claim — it was a routine.
* **Cooperative window** (`cooperative.mjs`): Z80 notifies (write to 68k work
  RAM via the bank window), holds a window, lowers it, checks a local commit
  byte the 68000 wrote last; commit → pad short by `compensation`. **THE
  WINDOW MUST BE NOPS**, as a measurement: on a `djnz` window the stop began
  0..13 cycles after the request depending on the host's phase (53..65
  measured) — right on average in seven phases, off by 4.3 in the eighth; on
  nops it is 62.8..68.3 in every phase and one compensation holds. The
  EXPLANATION that went with it was wrong and R3 §12.2 E corrects it: BUSREQ is
  sampled at the end of the machine cycle in flight, not the instruction, and a
  taken `djnz` is 5/4/4 — what nops buy is a uniform 4-cycle boundary lattice,
  not the removal of 13 cycles of blindness. Hardware stop width: unmeasured.
* **Results with the nop window**: 8 B every 5 slots = 16 KB/s, compensation
  65: 31 host phases, −0.0004%..+0.0001%, worst gap 1.008 T; 60 s at the
  phase that used to fail: 597,275 samples, −0.0000%. 4 B, compensation 41:
  21 phases, ≤ +0.0013%. Absent host passes. Suite: required 12/12.
* **Hardware-facing rule**: in the model the residual averages to zero; on
  silicon it is M-cycle grant jitter (≤4 on nops) of unknown mean. At 2,000
  grabs/s, ±0.1% allows a MEAN residual of ~1.8 cycles. A hardware round has
  to return that number.
* **Still open**: this is the P1 output-only engine (340-cycle pad). A 2ch
  mixer slot has 151 (plain) / ~76 (reserved) — window 64 + notify ~40 +
  compensation 41..65 does not fit without re-planning the reservations (R2
  §11.4 step 4). ROM bank (§11.5) untouched. Z80 reads of 68k work RAM are
  withdrawn by R2 as a mechanism.
* `mml_rate.h` drifted once more during that session (a tool without
  `PCM_SPG=1 TIMER_B_K=1`); reverted. **It is `npm run baseline` that does it**
  — the `c-gate` it runs calls `gen-c-tables.mjs`, which rewrites the header at
  whatever clock the environment implies (10,000 Hz instead of the shipped
  3,333). Check `git status` after every baseline run and revert; the real fix
  is to make that generator write somewhere other than the source tree, and it
  belongs to whoever owns the 68k build, not to this prototype.

## R2 §11.4 STEP 4 — THE WINDOW CANNOT ENTER THE 2ch SCHEDULE AS IS; COMPUTED TIMING TRACKS TO ±5

* **Budget**: a plain 2ch slot has 151 pad; the cooperative slot's fixed
  traffic is 89 (notify 23+20, commit check 46). Window left: 52/45/21/−3 for
  1/2/4/8 B; reserved slots none. And the notify write needs the bank at
  $FF0000 while the mixer needs it on the samples (126 cycles a switch). So
  the prototyped window does not enter the 2ch schedule; only a window with
  NO steady-state notification can — the 68000 computing when it is.
* **Computed timing** (`rom.mjs`, `grab.computed`): boot capture of the first
  opening, `rem` kept from the VDP V counter (elapsed lines, immune to lost
  ticks), skip-and-count a passed window, busy-wait the sub-line remainder,
  grab. Measured by the 68000's REQUEST (not the emulator's grant): steady
  state ±5 Z80 cycles over 85 consecutive windows a frame, `rem` 374..3374
  cancelled exactly. Once a frame at vblank the belief is knocked ~228 (one
  line) and recovers over ~10 windows — the V-counter time base across the
  reload; the 38-line hypothesis was tested and falsified. §3.7's per-transfer
  re-anchor from the published output index makes this moot in the real
  protocol.
* **The landing is an attractor.** The boot offset cannot move the steady-state
  landing: the Z80's clock is pulled by (stall − compensation) per grab until
  the phase settles where they are equal. Real for any fixed compensation;
  weak on hardware (±4), strong in the model because —
* **BlastEm grants a pending BUSREQ at the Z80's next I/O** (the next DAC write
  here), so the modelled grant phase inside a slot is scheduling, not an
  M-cycle. `windowSync` (four YM status reads in the window) makes the grant
  follow the request in the emulator only.
* **Not produced**: a computed-timing run passing §6. Next 68000 work: anchor
  the window right after a Z80 I/O access (so hardware and model agree on the
  grant), re-anchor `rem` per transfer from the published index, and decide
  the compensation's phase dependence. Z80 side unchanged.
* Bugs I made and fixed on the way, for the record: a 3.3x unit error in the
  busy-wait (68000 cycles are master/7, Z80's are /15), the post-grab `rem`
  reloaded from the pre-tick store, a diagnostic payload buffer overlapping
  the previous-V store (which forced the vblank branch every tick), and the
  68000 halting on its first VInt because reg 1 enabled it and its vector is
  the halt trap.

## THREE BUGS, ALL OUTSIDE THE PROTOTYPE, ALL INVISIBLE TO EVERY GATE

**1. `tools/z80asm.mjs`: `$` was the address of the NEXT instruction.** So
`djnz $` assembled as a jump past itself — a 26-iteration pad loop that ran
once, a sample clock 4.5x too fast, no error anywhere. Fixed to the instruction
start (sjasmplus, which that file's header promises); `db`/`dw` keep the
item-by-item meaning `selftest` pins. New selftest case.

**2. `tools/z80cpu.mjs`: every `(HL)` operand was charged 3 cycles too few.**
`ld r,(hl)`, `ld (hl),r`, `alu a,(hl)` are 7 T-states, not 4; `ld (hl),n` is
10, not 7. **The PCM mixer's hot loop is `ld a,(hl)` and `add a,(hl)`.** So
every cycle budget in this repository was computed against an under-charged
model: `mixer-bench`, `frame-budget`, `PAD_TARGET`, `EMIT_CYCLES`, and the
per-voice/per-tick figures quoted throughout [[plan-68k-split]] (240, 449, 384,
305, 110 cyc…). Fixed, with a selftest pinning the documented counts. Across
the fix, modelled DAC delivery moves on `m3-pcm-softmix` 98.3% → 99.1% and on
`m2-pcm` 63.2% → 75.9%, and the `$2A` interval p50 moves 1062 → 1068. No gate
changed verdict (c-gate stayed 41/41).

**3. A pad filler destroyed the sample in flight.** `ld a,0` is the solver's
only odd-cost filler and the sample fetch sat before the pad. At 9,987.6 Hz the
pads happened to be a bare `djnz` and nothing showed; at 3,329 Hz the tail took
an `ld a,0` and every other sample went out as zero. The fetch now runs after
the pad. **It was caught only because a second profile was in the case list** —
one clock would have passed clean.

## R3 step 1, done (2026-09-07)

`docs/dac-engine-implementation.md` §12.4 step 1 — the checks and the
explanations — is complete. What it changed:

* **The foreground load never ran.** `$12345678 / 7` overflows a 16-bit
  quotient, so DIVU took its early exit every time. Measured with a new
  `load calibration` case (marks with interrupts masked, Z80 untouched, so the
  DAC gate runs beside it): mark 20.0, `nop` 4.0, **`divu` 140.4, the
  overflowing `divu` 22.3**, `divu` by $7FFF 148.3 68000 cycles. Interrupt
  raise → handler entry, from a new probe event at the VDP's own raise: short
  load 65..86 (p50 70), real `divu` 65..**215** (p50 136), level 4 masked ~12
  lines 60..**6,027** (p50 1,582) with **1,218 of 3,304 ticks lost**. The old
  "±5 under load" was measured under 22-cycle instructions.
* **The HBlank cases were never checked as transfers.** All modes now run the
  same payload / order / count / commit checks. Four faults are injectable
  (`--fault drop-copy | no-commit | early-commit | late-request`) and each is
  proven fatal against a case that passes without it. `early-commit` keeps the
  clock at 9,987.56 Hz and every sample right — which is why PCM correctness
  was never evidence about the protocol.
* **Window geometry is derived, not assumed.** The notification span is
  81 + bankWait whatever the timestamp offset λ inside `ld (nn),a` is;
  measured 84 → **bankWait = 3**, independently confirming `windowWait`. λ
  stays unknown and bounded by 13, so boundaries are bands and a stop is
  reported strictly or only loosely inside. The stall inside a served window is
  subtracted before the geometry is taken.
* **Result: the notification-free cases fail on protocol.** `computed timing
  8B, unloaded 68k`: mean rate −0.0010%, 8 stops strictly inside, 2,881
  outside, **2,798 commits adopted by a window they were not written in**. All
  11 HBlank/computed cases are fatal now. The notified regression is
  unaffected: 3,449/3,449 inside, 0 carried, 15,977 B/s, −0.0000%.
* **One resolved configuration** (`case-config.mjs`): CLI overrides are applied
  once and the JSON records the case that ran; the window period comes from the
  Z80 schedule for both CPUs; a regression test ties a compensation change to
  the emitted pad. A fault the emitted path cannot reach is refused at build
  time.
* Verified: required 13/13 on the machine, JS gate 24/24, `probe-selftest
  --machine` green, `tools/selftest` green, baseline 7/11 (the same four
  pre-existing reds).

## R3 step 2 / R4 — the phase contract, corrected (2026-09-08)

The table §12.2 C asks for is in the prototype README. **R4 sent two of the
claims made from it back, and both were wrong.**

* **WITHDRAWN: "sd 1.136 → out of the window in 790 grabs".** That needs the
  residuals to be independent and they are not. Measured over 5,449 notified
  transfers: mean +0.0002, sd 1.137, **cumulative excursion only −3.53..+2.80,
  ending +1.13**, block-sum sd 0.24 / 0.22 / 0.00 at L = 10 / 100 / 1000 where
  a random walk predicts 3.60 / 11.37 / 35.96, autocorrelation lag 10 **+0.867**.
  The residual is bounded and periodic. `analyzeResidual()` reports all of it.
* **WITHDRAWN: the recurrence with gain 1.044 and a repelling fixed point at
  54.** Its table was indexed by the STOP position while φ was the REQUEST
  position, and it did not separate the request-to-grant delay, skips, or a
  compensation adopted in another window. The raw observation (r falls +2.40
  → −2.37 across stop offsets 0..100, 874 grabs) is kept without a model.
* **KEPT, and it is what the suspension rests on**: the notification-free cases
  fail on measurement, not theory. `computed timing 8B, unloaded`: 2,881 of
  2,961 stops outside their window, 2,798 commits read by a window they were
  not written in, and — measured independently from the slot's own length —
  **2,257 windows shortened their pad without having been stalled**. The
  minimum DAC interval, 4,395 master, is 5,376 less one compensation: the
  protocol failure and the §6 failure are the same event.
* **HV wording corrected.** 69–74 master is "the widest observed spread of
  times within one H value", evidence that H carried line-position information
  in those conditions. It is NOT a decoder error bound and must not be quoted
  as "±69" or carried over to a Z80 read.
* **Commit attribution is now an interval judgment** (§13.2.1). The old code
  picked the first window with `readLo > t` and then tested `t >= readLo`,
  which can never be true, so every undecidable commit was called a carry-over.
  Verdicts are own / carried / undecided / unread, boundaries inclusive, one
  linear pass. R4's counterexample (bands [110,136] and [1110,1136], commit at
  120) is pinned as undecided.
* **Adoption is now OBSERVED, not inferred**: `analyzeAdoption()` reads which
  branch the Z80 took from the window slot's own length (served → shorter by
  exactly the compensation). It agrees with the commit estimate on every case
  and turns "a window repaid a stall it did not have" into a direct
  measurement. Clean case: 5,948 served, 0 repaid-unstalled.
* **Cost row corrected**: the transfer window costs 23 + 20 + 46 + 64 +
  compensation = **218** Z80 cycles at compensation 65, against 151 of plain
  2ch pad — consistent with the older `151 − 89 − compensation` table. The
  "133" in the first draft had dropped the closing notification and the stop.

## What R4 orders next (§13.3)

Independent P1 prototype of §3.2's bounded phase correction, **observer first,
no correction**. First candidate: a REAL Z80 read of the VDP HV counter — not
assumed free, non-stalling or coherent. Then judge on observation alone, then
add bounded correction, then a shared time origin, then P1 transfer, then 2ch.
Second candidate if HV fails: Timer-B short-window observation. Timer-A stays
with CSM. Starting this range needs no further confirmation from the designer.

## What is next, in order — R3 supersedes the earlier sequence

1. ~~Correct the checks and the explanations~~ — done, above.
2. ~~Specify the runtime phase contract~~ — submitted; R4 accepted the
   suspension and corrected two claims made from it (above). The branch is
   decided: §3.2's bounded phase correction, observer first.
3. Prove the contract on P1, including real time publication and its transfer
   cost, correct long-instruction load, IRQ masking, frame crossing and recovery.
   Gate actual target-window error and every DAC interval with `--strict`.
4. Only after that: generate a complete 2ch placement with the accepted transfer,
   publication, actual mixer and the reserved work. Resolve the ROM bank conflict
   as a fit condition; do not add note/loop behavior before this passes.

R3 review reproduced the repaired 8 B / 5 slots delay-300 case for 10 seconds
(9,987.57 Hz, 5,351..5,397 master, payload/PCM match) and the computed unloaded
case for 3 seconds (exit 1, 4,395..6,476 master, only 73.9882% inside ±5%).
The probe selftest passes but does not yet inject faults through the HBlank
branch. No new hardware validation or full-suite run is claimed by this review.
