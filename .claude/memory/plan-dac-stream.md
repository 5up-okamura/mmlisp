# DAC engine redesign — R28: SHIPPED — the pair-transport engine plays a mucom song in an SGDK build on BlastEm (2026-09-11)

**Current (2026-09-11): R28 steps 1, 2, 4 and 5 are DONE; step 3 (VSET/ROM
bodies) is deferred.** The shipped Z80 engine is now the one-voice
pair-transport image (`tools/build-engine.mjs`, contract in `docs/driver.md`
§15, report in `docs/dac-engine-implementation.md` §64). `sin008.muc` ("CHINA
TOWN", FM5 + DAC1 + PSG3) → `import-mucom` → `tests/sin008.mmlisp` →
install-sgdk → SGDK 2.x build → headless BlastEm 20 s: every FM/PSG write in
order, every DAC byte = reference, stops ≤ 1,320 master, 9,981 Hz.
`npm run verify:all` is the new-engine suite (green); the ring engine's gates
are `legacy:ring-engine` (its `engine` gate has been red since a48bacc).
Read "Step 4/5" at the bottom before changing the host or the transport.

**Current review (2026-09-08): R9 §26.2/§26.3 DONE; §26.6 step 3 answered and
NEGATIVE. The corrector's arithmetic is verified against the reference and its
four faults refused; only the PLACEMENT fails, and closing it needs the per-slot
ceiling, the mean ceiling AND the code region all moved. Waiting on the
designer (§27.3, §28.3, §28.5).** The polling
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
  `PCM_SPG=1 TIMER_B_K=1`); reverted. **It was `npm run baseline` that did it**
  — the `c-gate` it runs called `gen-c-tables.mjs`, which rewrites the header at
  whatever clock the environment implies (10,000 Hz instead of the shipped
  3,333). **FIXED 2026-09-08** (R5 §15.2, instruction §22): `tools/c-tables.mjs`
  generates the pair into a temp directory for every verification tool and
  refuses a clock that differs from the one the run is measuring; the
  generator's default output is still `drv/68k` for the product path. Nothing
  to check in `git status` afterwards, and nothing to revert.

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

## R4 §13.3 step 3 — observation alone settles the phase (2026-09-08)

`decoder.mjs` + `npm run dac-stream:decoder`. Runtime inputs: the byte read, the
read's index, own state. The instrument's clock is used ONLY in `scoreDecode()`
and to calibrate three chip constants (line origin 2,700 master; H → phase, 210
of 256 values, widest group span 19 master; V → line, 33 of 256 answering to
more than one line).

* **Calibration data is kept out of the evaluation data.** Tables come from the
  three disturbed runs; the seven boot phases scored are unseen by them. This
  matters: an earlier pass that merged them turned a 17-master worst error into
  257 and produced 764 false alarms.
* **H alone: 11 runs, ~43,000 readings, worst error 9–18 master (0.6–1.2 Z80
  cycles), 100% within tolerance, 0 false positives, 0 false negatives** —
  including three unrepaid-stall runs and seven boot phases.
* **H's limit is half a line (±114 Z80 cycles).** Shifts beyond it are reported
  the short way round: 0% / 0% / 0.10% / 18.77% of shifts in the clean / 1 B /
  16 B / 64 B runs.
* **V extends the range but is worse in two ways**: 33 V values answer to two
  lines six apart (14.6% of a clean run's reads are undecidable and are reported
  as candidates, never guessed), and the V+H pair is not atomic — 16 cycles
  apart nominally, measured 126 apart when a stall lands between them.
* **Decision: use H, not V+H.** A compensation is 65 cycles and a window 64;
  both are well inside ±114, where H is exact, unambiguous, atomic and half the
  cost.
* Not done: the Z80 code for the decoder (a 256-byte lookup, a subtract, a
  compare — about 30 cycles), missing readings, restart, hardware.

Required machine cases now 27/27.

## What R4 orders next (§13.3)

Independent P1 prototype of §3.2's bounded phase correction, **observer first,
no correction**. Step 2 (can the Z80 read HV) is DONE — see above. Next is
step 3: judge on observation alone, with a decoder the engine actually runs,
across the whole initial phase range, short stalls, losses of a line and of a
frame, counter wrap and restart. Then bounded correction, a shared time
origin, P1 transfer, and only then 2ch.
Second candidate if HV fails: Timer-B short-window observation. Timer-A stays
with CSM. Starting this range needs no further confirmation from the designer.

## R4 §13.3 step 2 — the Z80 CAN read the VDP (2026-09-08)

`observer.mjs` places the read as extra work inside `gen-stream.mjs`'s own
slots (new optional `extraWork` argument; default output byte-identical), so it
rides the real mixer, CSM and pad arithmetic.

* **Affordable.** `ld a,($7F09)` = 13 + 3 cycles (the bank-window penalty).
  Complete 2ch + CSM worst slot: 79.6% → **87.7%** with H+store (29 cyc) →
  **92.2%** with V+H+store (45 cyc), and every observer case passes §6 at
  9,987.57 Hz, −0.0000%, 5,370..5,385 master, 68k idle or loaded. Contrast the
  notified transfer window: 218 cycles into 151 of pad.
* **H carries line position, V the line.** 2ch schedule: 210 distinct H values,
  **widest observed spread of times within one value 15 master (1 Z80 cycle)**.
  V: 232 values, spread ≈ one line. Neither is a decoder error bound.
* **The read positions are a LATTICE.** Both clocks are exact rational
  multiples of master, so a fixed schedule samples a finite phase set forever —
  57 phases in the 5-slot P1 loop, hence spread 0 there. Property of the
  sampling, not a resolution. Good for a decoder: it only decodes its own
  schedule's phases.
* **V+H is not a snapshot**: two bus reads exactly 16 Z80 cycles apart; H moves
  a median of 15 units between them, extremes +61 / −242 = the counter's jump
  and its wrap.
* **Caveats to carry.** The core charges the 68000 8 cycles per read and its own
  comment calls the 68000-side delay an estimate needing a fresh capture.
  Hardware unverified; Z80→VDP access is a documented hazard area. No decoder
  exists — that is step 3.

Required machine cases now 20/20.

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

## R7 §20.2 A/B and §20.4 step 3 — the decoder holds, the placement does not

Done and committed. Reported to the designer as instruction §21.

**The acquisition contract (A).** The Z80 decode had no notion of whether the
last reading was usable: it published a difference from the very first reading
and ran an unknown reading through the same arithmetic, so the next good reading
differed from a number made out of `$ff`. Now `KNOWN`/`VALID` are two published
masks and `VALID = KNOWN(now) AND KNOWN(before)` — one AND, no branch. `DELTA`
is masked by `VALID`, `EXPECT` by `KNOWN`. **283 cycles, 69 B** (was 249/62);
P1's read slot is **88.5%**, not 79.1%. All three reductions became branch-free
masks, which is also what makes them divisible.

**RAM ownership (A).** `DECODE.state` was `$1F00` = `G_STATUS`/`G_CSMHI`/
`G_CSMLO`: with CSM on, the decoder wrote on the frequency bytes the loop
reloads every group. The phase table's `$1E00` was not a region at all. Fixed by
declaring `phase:` in `RAM_P1`, moving every global's offset into one `GLOB`
table in `config.mjs`, and making `decodeMap(cfg)` check alignment, size, page
straddling and overlap with whichever globals that build actually keeps. State
init moved into boot through a new `bootExtra` hook — it was relying on the
core's zeroed RAM. **Recalibration was forced by the stamp change and produced a
byte-identical table**; only `calibratedFrom` moved.

**The record (B).** Five fields to five separate window addresses, spread over
the group's later slots so the record closes before the next read; the probe's
NOTIFY now carries the offset (`$FF0000..7`). The check names each breakage
(short / extra / out of order / before its own read) and allows exactly one
unfinished record at the end of a run. 3,947 + 3,937 records compared field by
field on BlastEm, 0 disagreed. Three generated faults and six synthetic ones
show it refusing.

**The placement (step 3) — this is the finding.** In the complete 2ch engine a
slot boundary destroys `A` and the flags (`mix_one` runs in every slot and is
the sample path), so the split decode keeps everything in memory and `BC` and
costs **501 cycles in 21 pieces**, verified by running each piece separately
with `A` and the flags clobbered between them. The loop has 687.9 cycles of
headroom to 79.6% — more than 501 — but **19 of the 21 pieces need a slot with
≥17 cycles free and only 5 slots have that**; the walk fails at the fourth
piece. Granularity, not total. Thinning the observation rate changes nothing:
the loop is statically unrolled, so a piece runs every lap whatever uses it, and
doubling the unrolled loop needs 1,617 B against 176 B free. The sequence first
places at a **83.9%** per-slot ceiling, one lap, 7.51 ms reading→record.

**And the table still has no home.** Free space in the complete map: 176 B
inside the code reservation, 96 B unreserved, 122 B inside the globals. No
page-aligned 256 B block; largest contiguous run obtainable 217 B. The 210 B
compacted table (the 46 uncovered H values are exactly two contiguous runs) does
fit that, but loses page alignment, so the index needs a 16-bit self-modified
operand and grows from 2 pieces to ~6 — and pieces are the scarce resource.
Replacing the table with arithmetic fails on precision: the best straight line
through the compacted index is 60 master off, against the table's own 40.

**Waiting on the designer**: whether to change the 79.6% ceiling (the submission
for that is §21.6), and whether to free a page from the 4 KB LUT (15 levels
instead of 16 costs one volume step and zero cycles — the index page is a
self-modified operand either way). R7 §20.3 declined both this round.

## R8 §23.4 and §23.5 steps 1-2 — the profile exists and the placement runs

Done and committed (`1cd30df`, `a79f5e5`). Reported as instruction §24.

**The tail rule (§23.4).** recordsBetweenReads() excused the last row whenever
it was null, by `problems.short--`, so a final record that arrived complete but
out of order came back short = -1 / outOfOrder = 1 and a caller summing the
counts saw zero. It also demanded a publication AFTER the last read before it
would excuse anything, which made the normal shape of a cut measurement — a
last read with nothing published yet — count as short; that was the 60 s run's
`short = 1`. Now: cut first, judge after; the only allowance is the last read's
fields arriving as a correct PREFIX (0 fields included), never counted then
subtracted; `broken`/`kinds` reported by name.

**The 15-level profile (§23.2).** A different build, not a changed default.
`RAM_P2_FULL_15`: lut $0C00..$1B00 (3,840 B), phase $1B00..$1C00, ring and
everything after it unmoved. Level k scales by k/14 — NOT the 16-level table
with a page pulled — and `levelFromCommand` is written down: monotone, silence
and unity exact, **not injective (commands 7 and 8 share level 7)**. `levels`,
`workTarget` and `meanTarget` are in the stamp. `pageIsALevel()` exists because
the mixer's page is a self-modified operand and the page one past the family is
the phase table.

**BC liveness (§23.3) — this is the one worth remembering.** The first
generated version had every published record stuck at the boot state while the
DAC was perfect and every slot was inside its budget. `keep known` was placed in
slot 16 behind that slot's RESERVED padding (`ld b,5 / djnz $`, which leaves B
at zero), so it stored a B the reserve had already destroyed. **A slot needs two
answers, not one**: its reserved padding runs BEFORE its piece (liveIn) and its
own pad AFTER (liveOut). 61 slots each way.

`push af`/`pop af` was added as an opt-in pad filler: 21 cycles in two bytes and
it destroys nothing (pop restores A and F), which is what a BC-carrying slot
needs once `ld b,k`/`djnz $` is gone. With it the complete 15-level engine plus
the distributed decode assembles at **2,221 B of 2,560**; without it, 2,772 —
over by 212. Finished estimate (reserve padding replaced by the 608 B, not
double-counted): 2,207 B. **§21.4's ledger was wrong**: it double-counted the
reserve padding, so the plain build's free code space is 666 B, not 176.

Ran for real in the JS machine: 69 observations through the real mixer, reserve
and pads, 0 disagreed; DAC 358..359 only (which needed the model to charge the
VDP read the same window wait the schedule does); worst slot 83.8%, mean 78.9%;
7.509 ms reading -> record.

**Not done**: BlastEm cases for the 15-level 2ch, the 10 s / 60 s 2ch
comparison (§23.5 step 3), corrector, transfer, hardware.

## R8 §23.5 step 3 — the observer holds inside the complete 2ch engine

Done and committed (`0b683e0`, `49ac3f6`). Reported as instruction §25.

**The diagnostic does not exist any more.** Publishing the record over the bus
costs 16 cycles a field even in its cheapest form, which grows five pieces to
46/33/46/33/46 and fails to place at 83.9% (it closes only at 85.0%) — and it
would mean measuring an image heavier than the one under test. Instead
`probe.patch` carves the globals page `$1F00..$1F7F` out of the Z80 RAM chunk
into read/write functions and LOGS THE WRITES (`MML_PROBE_Z80RAM`). It declares
no read_cycles/write_cycles, so nothing about the emulated timing changes —
verified by reproducing a case byte-for-byte across the rebuild. The engine
spends nothing and is told nothing.

**A real error this caught.** The split decode's advance came from
`cfg.slotCycles`, which is ONE GROUP (26,880 master, 147 units); the unrolled
2ch loop is 80 slots (430,080 master, 129 units). §24's "69 observations, 0
disagreed" used that constant on BOTH sides, so the reference and the
implementation agreed with each other while both disagreed with the schedule.
The read interval now comes from the laid-out loop. (Same shape of error, one
level down: the settle prediction was measured from the START of the read
instruction, 16 cycles before where the instrument stamps it.)

**Results, complete 2ch+CSM, 15 levels, the decode distributed into it:**
10 s required case passes (`values all match`, gap 5,370..5,385). Over 60 s:
7,497 readings, 7,497 complete records, **0 disagreed** on observation number,
KNOWN, VALID and DELTA. Read spacing agrees with the generated 430,080 master
to **0** on all 7,496 undisturbed intervals. The record settles **317,145
master (5.907 ms)** after the reading on every one — exactly what the layout
predicts. Worst slot 83.8%, mean 79.0%, 66 slots carry BC. machine-probe 30/30.

**The residual, which is step 4's input**: quiet, 0..0 master really happened
and the record's own error is ≤ **20 master (1.3 Z80 cycles)** over 7,496 valid
differences; under 4B stalls, **364..1,328 master** really happened and the
error is ≤ **33 master (2.2 Z80 cycles)** over 7,478.

Also: the CSM test voice's boot init was 438 B of unrolled register writes;
table-driven it is 185 B, which is what let the split+CSM image fit at 2,390 of
2,560.

**Waiting on the designer**: step 4 — max correction rate, origin/generation,
the stop bound. Nothing about the 83.9% headroom that is left (~1,420 cycles a
loop, largest single slot 28.4) is claimed to absorb an unmeasured external
wait.

## R9 — the patch was not the patch, and the corrector does not fit

Committed as `961d528` and `9252267`; reported as instruction §27.

**The RAM watch existed only in an untracked working copy.** `probe.patch`
carried the `MML_PROBE_Z80RAM` constant and nothing else — the handlers, the
`$1F00..$1F7F` memmap chunk, the buffer index and the chunk count 5→6 were in
`drv/out/blastem/src` only. Step 3 passed because it ran against that local
core. `setup.sh` could not have caught it: it folded every `git apply --check`
failure into "already applied (or does not apply) — continuing", which is
exactly the branch a tree with an OLDER patch falls into. Now it distinguishes
three answers and FAILS on the third, verifies the patch fully reverses after
applying, takes `BLASTEM_OUT`, clones the branch then checks out `BLASTEM_REV`
(a commit is not a branch — `--branch <sha>` never worked), pins `b4d7524` by
default, and writes `build.json` with the revision, patch hash and core hash.
Rebuilt from a clean clone into an empty directory: everything reproduces.

**Stops are now subtracted per interval** (`stoppedWithin`, boundaries defined
as [start,end) against [a,b)). The 4B stall case went from "not checked at all"
— every interval contained a stop, so every interval was skipped — to 245/245
intervals matching the generated 430,080 master with residual 0, and every
record settling at exactly 317,145 master once its own stop is taken off.

**The corrector: reference good, placement negative.** The mechanism is a
self-modified `jp` into eight nops, neutral at the fourth: one byte moves a
slot's DAC interval ±16 cycles in steps of 4 (= 60 master = exactly 3 phase
units). Seven slots grouped 4+2+1 driven by three values, because a single
shared value makes the total a multiple of 7 quanta and leaves 420 master of
residual where the acceptance test wants under 60. The reference converges from
±112 units to ≤2 units (40 master) in ≤5 observations.

It does not place. At the specified 112 cycles an observation: 60 of 67 pieces
down, then no slot with 28 free cycles for `advance carry`. A halved 64-cycle
variant places but is over everything — 7 slots above 83.9% (worst 85.5%), mean
81.5% vs 79.6%, 2,578 code bytes vs 2,560. **RAM is not the constraint**: 10 B
of state in the globals, the table in its own page. Nothing was relaxed.

One accounting question is left for the designer: the numbers above count the
ladder's NEUTRAL PATH (jp + 4 nops = 26) as work, per §26.4's wording. Counting
only the `jp` and calling the nops pad puts those seven slots back inside 83.9%
with 52-56 cycles of pad left over.

### The corrector PLACES and passes on BlastEm (R10 §29, §30)

R10 found three defects and building the integration test it asked for found
two more. All five are fixed and the corrected image now runs.

**The placer folded three laps into eighty slots.** `placeSplit` advanced after
every piece and then kept walking `at % 80`, so "64 of 75 placed" was three laps
whose pieces got emitted out of chain order by `bySlot`. §28's 84.5% / 86.6% /
2,680 B are withdrawn. It now has an absolute one-observation deadline, lets
dependent pieces share a slot, checks `laps === 1`, and reads the emitted order
back out of the placement to compare with the chain.

**The ladders ran one observation late** — they were placed before the first
write, so an observation executed the previous decision while EXPECT carried
this one's. The window is now after the last write and before the next read.

**`jp nn` CARRIES AN ADDRESS, NOT AN INDEX.** Writing entry 4 into its second
byte made the target $xx04 and the engine left its loop at the first ladder. The
piece-level test only ever looked at the byte. It is `jr corr_x_e0` now: the
displacement byte IS the entry number, 12 cycles, one byte less.

**The debt is a nine-bit sum.** `(raw+1)>>2` then `|q|>28` accepted +113, +114
and -113, and 100+75 arrived as a valid -81. P/V dies at a slot boundary and has
no `sbc a,a`, so the overflow is rebuilt from three sign masks:
`(sd^ss) & (se^ss)`, and `live = ~overflow & (s+112 <= 224)` gates q, the debt
and KNOWN together. `MAX_DEBT_UNITS = 112` is its own constant.

**KNOWN was written twice** once the corrector gated it, which reads as "a field
too many" from outside. The raw mask goes to a scratch byte; the gate is the
only writer; and RECORD's ORDER is now read out of the placement rather than
declared (KNOWN moved from sixth to last).

**The 16-quantum shape is deleted**, not kept behind a flag: it expires at 1,340
master, inside the 1,500-master contract.

**The image** (`correctorBudget`, R10 §29.5 spends the time publication on the
corrector — b1..b4's 75 cycles and 70 B): 82 pieces in ONE lap ending at slot
49, ladders at 49-51 and 64-67, worst 83.8%, mean 77.9%, DAC interval 342..375,
86 cycles of pad left on the shortened path, settle 103,035 master. RAM is fine
(12 B). **Code is not**: 2,291 + 538 owed = 2,829 of 2,560, 269 B over — and
137 B over even without the corrector. Nothing was silently adjusted; it is
§30.6's first question for the designer.

**BlastEm, 60 s, three cases** (quiet / 4 B stall every 3,000 / every 41,000):
7,497 of 7,497 records, 0 disagreements, 0 broken; the correction rebuilt from
the SEVEN LADDER SLOTS' OWN DAC INTERVALS (never from the engine's q) agreed on
all 7,496 observations of every case; 0 expiries. The occasional stall returns
to under 40 master in **2 observations = 16.02 ms**. `dac-stream:split` prints
the numbers from the image, so no figure here comes from a throwaway script.

Also: `setup.sh` resolves the wanted revision against the remote and refuses a
reused tree whose HEAD is not it; `*.patch` is exempted from git's whitespace
check, because a unified diff's context lines are supposed to start with a space.

### The code ledger, and what R11 settled (§31)

**The 269 B overrun was the ledger, not the image.** `code_end + estimate`
double-counts: a `complete` build EXECUTES the unwritten features' cycles as
tagged padding, so those bytes are in the image already and the real feature
REPLACES them. R8 §24.3 fixed this once and both reports had drifted back to the
plain sum. `finished = code_end(no scaffold) - reservedPadBytes + estimate`, with
the padding measured from the same generated object (ops tagged `reserved`
only — a slot's own pad and a ladder's nops stay in) and the ledger taken from
the SAME image as code_end, since a CSM write draws on its block's reservation.

  decode only    2089 - 570 + 608 = 2127   (433 B spare)
  with corrector 2291 - 437 + 538 = 2392   (168 B spare)

**The code region stays 2,560 B**, and so do the LUT, the quanta, the correction
limit and the level count. 168 B is not a proof — replacing a reservation with
real code changes instruction density, the pad encoding and BC liveness — so the
estimate line for a feature is dropped only when that feature is written.

**What the corrector is accepted for**: a 4 B disturbance inside the 1,500-master
contract. What the sweep then measured, all on BlastEm with every DAC interval
of every observation scored against the layout (99,680 an observation-run, 0
wrong in every case):

  1 B  0..407 master   5 quanta   2 obs to return
  2 B  0..498          6          2
  4 B  0..680          9          2
  8 B  0..1035        13          2
 12 B  0..1399        18          2   <- the contract's edge, still all correct
 16 B  0..1778        22              148 past the contract, 22 past half a line
 24 B  0..2528        16              179 past half a line, all 179 wrong
 64 B  0..6182        13              179 past a whole line, all wrong

**NOT ONE case expired**, and that is the finding rather than a pass: past half a
line H reports the short way round, so a physically large disturbance arrives as
a small ordinary DELTA and the corrector acts on it. The debt limit cannot refuse
that — only an external invalidation from the 68000 could, and there is no input
path for one yet. It is designed with the shared origin, not before.

Also covered through the corrected image: unknown readings (singles and a run of
three), re-acquisition, the debt dropped rather than carried across a break, and
the 16-bit observation number carrying past $FFFF — reached with a `countFrom`
boot constant, not waited for. `dac-stream:machine:required` runs the required
cases and exits 0; the full run still reports every case and still exits 1 on the
13 known informational failures.

## R12–R15 — the runtime protocol, then the wall the consumer hits (2026-09-09)

**The three quantities are separate and so are the three commit domains.**
`bootGeneration` (u16, the 68k's), the output sample index (the Z80's),
`phaseGeneration` (u8, the 68k's); committed by `queueHead` (queue bytes),
`phaseCommit` (phase only) and `publishSelect` (the snapshot). Merging any two
was the R13 §35.1 bug: an ordinary command invalidated the H corrector.

**The snapshot is 5 B, and the output index is DERIVED (R15 §39.2).**
`{observationNumber:u16, bootGeneration:u16, phaseGeneration:u8}`, stride 6,
19 B of the 32 B region, and the host reads selector + pad + both faces as one
14-byte run — three `move.l` and one `move.w`. The u32 time is
`(extend16(obs) - 1) * outputsPerObservation`, with the multiplier generated
(80 for the 2ch lap, 5 for P1) and never hand-written. A u16 step of 1..32767
is forward, 0 is a re-read, 32768+ is unextendable and stops timed commands.
The Z80 keeps only `outputSampleLow:u16`, privately, to extend `applyAtLow`.

Measured on BlastEm, both CPUs, after the change: ~3,940 snapshots a 2-second
case with 0 written with other than 5 bytes behind the selector, 0 derived
indexes misplaced against the instrument's own DAC-write count, and the
observation number used raw as a sample number places 1 of 3,940 — so the check
distinguishes the derivation from that mistake. The live snapshot read fell from
1,184..1,452 to **891..1,144 master** (356 of the 1,500 budget left).

Transfer pieces, measured: head 341..577, credit 429..668, invalidate 576..815,
payload 947..1,200, snapshot 891..1,144. The SUM between two H observations is
the rule; head+credit, head+invalidate and credit+invalidate are the only pairs
under 1,500 and stay candidates until a real two-piece-per-interval run.

**Two things that were structurally wrong and are fixed:** KNOWN was doing two
jobs (the record's field and the carry) — `pknown` is separate now; and
`SPLIT_LIVE` was POSITIONAL, so adding one piece shifted every later entry and
fed two thirds of the corrector chain the wrong liveness. Liveness is keyed by
name and an undeclared piece is refused.

### The command path, three shapes, and the one that fits (R15, R16, R17)

The reservation for commands is **145 cycles a block = 725 a lap**, at b9 and b10
of every block — ten positions. Three consumers have been written against it:

| | shape | cycles/lap | positions |
| --- | --- | ---: | ---: |
| R15 | one SCALAR record a block, `{slot, value}` | 3,095 | 30 |
| R16 | one desired-state BUNDLE a lap, over a FIFO | 867 | 10 (BC clashed) |
| **R17** | **the same bundle, through a one-slot MAILBOX** | **578** | **10** |
| reserved | | 725 | 10 |

**R17 §43.1 found the real cost centre**: R16's consumer still ran a general
FIFO — head against tail, a size byte, a type byte, a record pointer rebuilt
every lap — and that machinery, not the arithmetic, was the 867. A waiting list
belongs to the CPU that can afford one. So the Z80 side is now ONE outstanding
desired state at a fixed address with a two-byte handshake: the 68000 writes a
payload only while `commit == ack` and bumps `commit` last; the Z80 acts only
while `commit != ack` and sets `ack = commit` after it has stored the three
values. Nothing is dereferenced, so **main BC is not used anywhere in the chain**
— checked by decoding the emitted bytes against a fourteen-opcode whitelist.

**Time is counted in observations, not samples (§43.2).** A bundle can only land
on a lap boundary, so the low sixteen bits of a sample number carried a multiple
of eighty and used a fifth of their range. The wire field is
`decisionObservation:u16` against the decoder's own `observationNumber`; same
width, same wrap, same 1..32767 look-ahead — 32,767 laps instead of samples.
`outputSampleLow` and its advance are gone from the engine entirely.

  snapshot observation n names the lap starting at (n-1) * outputsPerObservation
  decisionObservation n applies at the boundary   n * outputsPerObservation

**ALL FOUR LIMITS PASS**, for the first time since the corrector went in:

  worst slot 83.8% of 83.9% · mean 78.7% of 79.6%
  consumer 578 of 725 cycles a lap · code 2,511 B of 2,560 · RAM ok
  YM/PSG's b11..b14 reservation untouched, as §43.1 requires

The chain is ten pieces in the ten positions, with three ordering constraints
that come from the schedule and are checked from the placement: the comparison
after the decode's `count hi store` (it landed at slot 9, the compare at 24);
the three stores inside the block whose edge (slot 62) is the last before the
lap boundary, so the change lands exactly there; the ack strictly after them.
`AF'` carries the one thing memory cannot — the borrow out of the low half of
the comparison — and turning one `ex af,af'` into a `nop` is a refused fault.

**Transfer, measured on BlastEm** (68000 really holding the bus): the whole
handshake in ONE grab — read the ack, publish if free — is 373..1,354 master,
inside the 1,500 contract with 146 to spare. One transfer an observation and one
observation a lap gives **124.8 desired-state updates a second**, against the 60
§43.6 step 6 asks for. Split strategies give 62.4 and 41.6.

Fixed on the way, each reproduced as a failing negative first: R16's encoder sent
a change for a published boundary to output 161 (not on the 80-output grid);
counted "5 changes → 2 records" with one change still unemitted; compared
`at <= published` in u16 across the wrap; and R15's record could name a fourth
staged byte the reference could not name at all while claiming to check a `size`
byte it never read. The host's timeline is extended u32 now and narrows to
sixteen bits only at encode.

### R19 §46 — the integration test found two things nothing else could

Running the complete 2ch image and a REAL 68000 mailbox host together, for the
first time, broke two accepted results:

**1. The 68000 cannot read Z80 RAM with word or long moves.** The Z80 bus is 8
bits: a word/long access to $A00000..$A0FFFF returns the byte at the EVEN
address duplicated into both halves. R12 §33.4 replaced nine `move.b` (1,583..
1,851 master, over the contract) with long moves over a 14-byte run and R15
§39.2 kept it — and the host's copy had only ever been TIMED, never read back.
The first test that read it saw observation `$0202` where the counter said 2,
which is exactly [b0, b0, b2, b2]. The read is now the selector plus the one
face it names, byte by byte, in one grab: **1,038..1,375 master** on the P1 rig.

**2. The transfer costs are bigger inside the complete engine than on the P1
rig.** P1's instructions are short; the 2ch mixer's `ld a,(ix+0)` and its
`call`/`ret` make the bus grant land later. The whole handshake in one grab
measured 1,354 master on P1 and **1,541 inside the 2ch engine** — past the
1,500 the live contract allows. Every piece measurement taken on P1 is a lower
bound for the finished engine, not a value for it.

So the host splits the handshake: a READ lap (selector, observation number, ack
— four byte reads) and a PUBLISH lap (five payload bytes, then the commit), one
grab an observation interval each. Worst total between two H observations
**1,325 master, 0 over 1,500** ✓.

**The rate condition fails.** Publish → the engine sees the commit at the next
lap's first consumer position → applies and acks at slot 72 → the host reads the
ack → publishes. That round trip is 2.7 laps on average, so a safe host sustains
**43.5 desired-state updates a second** against the 60 §43.6 step 6 requires.
124.8/s needs the single-grab handshake, which does not fit the contract inside
the complete engine. Per §46.3 the listening ROM and host-YM both wait.

Everything else in the combined case holds: 128 bundles committed and 128
acknowledged with 0 partial payloads, 0 writes to the phase control block, 15
distinct level pages staged, 0 staged bytes written without the other two, DAC
intervals 342..359 Z80 cycles with the bus holds removed, and the CSM+consumer
image assembling at exactly 2,560 B once the 162 B CSM test voice is written by
the 68000 at boot instead of by the Z80 (§46.3's own remedy).

Also this round: the host's waiting list holds DIFFERENCES per boundary and
assembles the whole state at emit time, so a boundary asked for after a later
one no longer inherits that later one's values (§46.2); and `padTo` gained a
third counter — `ld iyl,k`/`dec iyl`/`jr nz`, five bytes for any wait — for the
slots that carry a value in BC and had no `djnz`, chosen only where it is
shorter. Finished estimate 2,466 B of 2,560 (94 B spare).

**Still open**: the 60 updates/s condition, then §33.6 step 5's host-YM safe
window — the only thing that can release b11..b14. And the mailbox represents
voice state as three level pages only; voice start/stop, cursor, loop and bank
are not in it.

## R20 §48 (2026-09-09) — the width rule, the trimmed publish, the generated period

Commit `36276b5`. Steps 1–3 pass; **Checkpoint A is still not reached** and no
listening ROM was built (§48.6's failure clause).

**The 8-bit Z80 bus is now a rule in three places, not a fixed bug.** The 68000
emitter refuses to encode an absolute access to `$A00000..$A0FFFF` wider than a
byte; a `z80Xfer` scope refuses one through an address register; and every
access the emitter encodes goes into a ledger that probe-selftest checks over
all 106 case ROMs (1,344 byte accesses to Z80 RAM, 0 wide register accesses).
`$A11100` is a separate `busreqW` instruction — named as a port, not RAM, so it
is not an exception hiding in the rule. Required machine case `proto P1,
snapshot byte width` publishes `$A5, $3C, $5A` behind the observation number and
stamps every reading: 489 good / 0 bad; `--fault wide-read` gives 0 / 490 and is
fatal. README withdraws the old 890..1,144 master figure.

**The atomic publish attempt fits the contract.** Everything that can happen
before the bus is taken does: five fixed addresses `lea`'d once outside the loop,
the payload built in 68k RAM, the next commit value in d5 (taken into d4 only on
the free path, so a busy attempt cannot desynchronise). Free path 1,085..1,225
master (was 1,541 for the one-grab handshake), busy 553..679, snapshot read
819..987, worst total between two H observations 1,160 with none over 1,500.

**The transfer period is generated, not written down.** Bounds: at least one
observation interval (430,080), at most masterHz/120 (447,443); target the
midpoint 438,762. The emitter prices its own instructions and solves for two
DBRA counts, carrying the rounding residue between them. `DBRA_MASTER = 72.653`
is measured by differencing the normal and dense builds — the tight calibration
loop reads 71.128, which is NOT what the host loop costs. Achieved
438,543..438,935, mean 438,739, 0 of 241 intervals outside the window.

**Why the rate still fails, measured.** The engine publishes its snapshot
**62.8% into the lap** — it is the last link of H read → decode → corrector →
publish and cannot move earlier. So a host reading before that point gets the
PREVIOUS lap's number, and it cannot know which side it is on; its period is a
little longer than a lap, so one run walks every phase (bootNops 0/60/140/220 are
identical). Lead 1: late 121/121, 61.2/s. Lead 2: late 68, 61.2/s — and the
late/not-late boundary in the by-phase table is exactly 0.628, with 36/36 clean
in the 0.7..1.0 band. Lead 3: late 1 (startup), but the bundle occupies the one
slot until its named observation and the ack lands at slot 72 of the applying
lap, so 14 of 121 attempts find the box busy → **54.2 acknowledged updates a
second**. Lead and rate are coupled through the single slot and the ack being
given at APPLY time.

Three ways out, all designer's calls, none taken: (1) lock the host's phase — it
can detect the crossing for free, because the observation number it already reads
repeats or skips there, and the 0.7..1.0 band gives lead 2 at 62.4/s, but open
loop the phase walks 0.57 lap a minute; (2) read one observation byte inside the
publish attempt and pick between two pre-built targets — 189 master, so about
1,414 of 1,500, but it changes what §48.2 defines that operation to be; (3)
acknowledge at take time rather than apply time — needs a second Z80 buffer,
which R20 excludes.

Gates: dac-stream 29/29, probe-test green, machine:required 33/33 exit 0, split
inside every limit (83.8% / 78.7% / 2,466 B / 8,192 B), c-gate 41/41,
decoder 1 problem (the 54.2/s).

## R21 §50 (2026-09-10) — the boundary chosen inside the grab

Commit `878a7a3`. The fixed lead is gone. The host builds BOTH candidate
payloads (`R+2` and `R+3`) and both comparison bytes before taking the bus, then
inside one grab reads the ack and — only if the box is free — the decoder's own
live counter, publishing the payload whose boundary is that counter's next one:
`live == (R+1)&$ff -> R+2`, `live == (R+2)&$ff -> R+3`, anything else publishes
nothing and is counted. `adaptiveTarget` in command.mjs is the rule on its own.

Room for the two comparisons came from putting `$A11100` in an address
register: `move.w #$0100,(a5)` and `move.w (a5),d0` are 12 and 8 cycles where
the absolute forms are 20 and 16, which took 24 cycles (174 master) out of the
critical section. The port is recorded in the access ledger with a `port` flag,
so it is not an exception hiding inside the byte-width rule.

**60 seconds, complete 2ch+CSM**: 3,675 bundles committed and acknowledged,
**61.2 updates/s**; every one of 3,675 targets was the live counter's next
boundary, checked from the log against the engine's own counter writes; publish
stop 801..1,418 master, read 450..925, worst per-observation total 1,418 with
none over 1,500; interval 438,389..439,271 with 0 of 7,348 outside the window;
0 busy, 0 mismatch; both counter wraps crossed with publications either side.

**The one thing left**: 44 of 3,675 (1.2%) applied one observation late, all
published between slot 8.2 and 9.1 of 80. Measured cause — `mb pending` reads
the commit at **slot 8** and the decode stores the counter's LOW byte at **slot
8.99..9.24**. A commit landing in that ~0.8-slot gap has already missed that
lap's pending check while the counter the host reads is still the previous lap's,
so `live + 1` is one short. The host cannot see the window: the counter reads
the same on both sides of `mb pending`, and its period sweeps every phase by
design. The R18 §48.2 remedy was MEASURED and does not fit — marking `mb
pending` as counter-dependent lands it on `mb diff lo` at slot 24, 101 B past
2,560 with a worst slot of 96.6%.

Negatives that must fail, all confirmed: `pick-near` (always R+2) 330 wrong
targets and 339 late; `pick-far` (always R+3) 205 wrong, 73 busy, 53.8/s — R20's
lead 3 reproduced; `count-astray` 612 refusals, 0 publications, 0 level pages.

`dac-stream:decoder` now runs the mailbox family with a **10-second floor**: the
late window is under one slot in eighty, so a 2-second run makes about one and
cannot tell it from the single late write the engine makes while acquiring —
which is why R20's 2-second run looked clean.

The two counter-wrap cases (`$00fc`, `$fffc`) are the only ones without the CSM
test tone: the ceiling image assembles at exactly $A00 with zero spare and the
counter start costs six bytes.

**Open, and it is a design call**: allow ~1.0% of bundles to apply 8.01 ms late
and go to the listening ROM as it stands, or authorise swapping the order of
`mb pending` and the counter's low-byte store (which touches the consumer's or
the decode's placement, both excluded by R21).

## R22 §52 (2026-09-10) — CHECKPOINT A, audible

Commit `a643f4c`. The 8.01 ms phase-dependent delay is gone and the two
diagnostic listening ROMs exist.

**The fix was an ORDER of two instructions.** R21's late bundles came from
`mb pending` reading the commit at slot 8 while the decode stored the counter's
low byte at slot 8.99. Moving `mb pending` after the counter does not fit (101 B
over, 96.6% worst slot); moving the COUNTER before it does. Its five pieces now
run immediately after the H read — they advance once per read and take nothing
from the phase decode — so `count hi store` is at slot 1 against `mb pending` at
slot 8. The corrector's anchor went back to `publish delta store`, which was
always the real condition; it was tied to `count hi store` only because the
counter's small pieces had no slot left behind forty-two others.

`generateSplit` now REFUSES an image whose counter is not complete before the
box is read, checked in CYCLES from the finished image (every piece's first and
last instruction carries its name), and refuses a shared slot too, because a
slot emits its command plan before its decode piece. `--fault counter-late`
rebuilds R21's arrangement and must fail.

**A fourth pad counter paid for it.** The re-placement put nine more slots on
the BC-carrying path, where only the 7-byte IYL wait fits — 13 B over 2,560.
`ld a,k`/`dec a`/`jr nz` is FIVE bytes for any wait (`dec a` is one byte,
`dec iyl` is two with its IY prefix). Engine 2,495 → **2,384 B**, finished
estimate 2,466 → **2,382 B (178 B spare)**, not one cycle moved.

**60 s, complete 2ch+CSM**: 3,675 bundles, all naming the live counter's next
boundary; **61.2 acked updates/s**; 1 late (the acquisition), 0 busy, 0 refused;
publish stop 829..1,456 master, read 455..914, worst per-observation 1,456 with
none over 1,500; interval 438,403..439,215, 0 of 7,349 outside; four limits
83.8% / 78.7% / 2,382 B / 8,192 B. Conflict positions over sixteen 60 s images:
163 / 5,978 / 56,806 publications, **0 late in each**.

**Two things worth not re-learning:**

1. *The phase sweep is a comb, not a sweep.* The transfer period is a whole
   number of DBRA iterations, so the publish phase lands on ~25 teeth that creep
   ~27 master a publication; closing the gaps takes ~640 publications ≈ 10 s. A
   10-second run reached every TENTH of the lap and still returned "0 late" from
   the deliberately broken `counter-late` image. Bins are now one per SLOT (80),
   an empty bin means the run may not be graded, and the mailbox floor is 30 s.
2. *The staged byte is a PAGE, not a level.* The level family is $0C00..$1B00,
   so page 12 is silence and page 26 is unity. Both hosts had been staging
   0..14 — the code region read as a volume table, exactly `pageIsALevel`'s
   accident. The gates never look at the payload's value, so nothing failed; it
   showed up as a −4,000 DC offset in the reference WAV.

**The listening tour**: `node drv/experimental/dac-stream/listen.mjs` builds two
ROMs (with and without the CSM test tone) playing a fixed 44 s timeline —
each voice alone, an ordinary sum, the clamp, the fifteen levels up and down,
the same fade on the master, a new state every publication, then one piece of
material three times over with no transfer / representative density / double
density. It writes a DAC-only reference WAV from the instrument's record of
every $2A write, plus a manifest with each section's start second, intent,
expected levels, what was staged, and the reference's RMS there. Output is under
`drv/out/dac-stream/listen/` (gitignored).

**Next, and NOT started**: §33.6 step 5's host-YM safe window — still the only
thing that can release b11..b14's 280 cycles/block and 120 B. The mailbox
carries three level pages and nothing else: voice start/stop, cursor, loop and
bank are not in it.

## R24 §55 (2026-09-10) — host-YM P1 steps 1 and 2, and the premise they corrected

Commit `fd95e68`. Baseline frozen and byte-identical (rom `be1675e77edddbb3`).
**P1 is NOT established** — steps 3, 4 and 5 are not done — but it is not
refuted either.

**The premise was wrong, and this is the thing not to re-derive.** The YM2612 is
on the Z80's bus. A 68000 access to `$A04000..$A04003` is answered with OPEN BUS
unless the 68000 holds the bus — BlastEm gates it on `z80_get_busack`, and the
`host-YM P1, no bus` build lands **0 of 28** attempts. So there is no window
between the Z80's YM accesses to aim at: with the bus held the transaction is
atomic by construction and the interleave the search was for cannot happen.

**The probe now sees every YM access from either CPU** (`MML_PROBE_YMZ80`,
`MML_PROBE_YM68K`: port, read/write, byte). Before R24 it saw only the `$2A`
data write — not the address port, not the CSM pair, not the re-latch, and not
which side wrote. `ym-window.mjs` derives the picture from the placement and
from the machine and refuses to answer if they disagree.

Per lap: **110 accesses** — 80 DAC samples, 10 CSM selects, 10 CSM values, 10
`$2A` re-latches; 496 of 496 laps carried exactly 110. Each site's position
spreads 1,401..2,481 master. BUSY is `32 × 42 + 42 = 1,386` master and only a
DATA write raises it.

**`$2A` must be restored inside the same grab.** The 68000's address write
steals the DAC latch; leaving it to the engine's own CSM re-latch costs a
**75,270 master hole — fourteen samples**. Restoring it makes the DAC interval
5,130..5,385, identical to no transaction at all.

**Ride the snapshot READ's grab, not a grab of its own.** A stand-alone
transaction is 263..1,417 master and pushes an observation interval to 1,589
(four over 1,500 in 30 s). Inside the read's grab: worst 1,430, **none over**,
**51.3 transactions/s**, mailbox untouched at 61.2 updates/s. BUSY is read ONCE,
never polled — 83.9% executed, 16.1% deferred, 0 of 4,620 writes made while
busy, worst request-to-execute latency one loop = 16.02 ms.

**The one open hazard**: a grant landing between a Z80 CSM select and its value
(~300 master) means the 68000's `$2A` restore sends that CSM value to the DAC.
Measured 0 in 30 s, and not by luck — the CSM pair closes 690..1,939 master
after the DAC write before it, and **37,416 of 37,468 (99.86%) close inside that
write's 1,386 master BUSY**, where the 68000 refuses to write. The other 52
(0.14%) are delayed by stops or the corrector and expose up to 553 master:
about **one collision per 35 minutes** at 51.3/s. The 68000 cannot detect the
state — HV cannot locate a slot (the Z80's data writes are uniform across the
3,420 master line) and BUSY cannot be sampled without taking the bus, which
freezes it. Closing it needs one flag byte the CSM write sets and clears: two
stores per CSM write, ~260 cycles a lap, and R24 froze the engine.

**Not done**: step 3 (window position, VBlank/IRQ, corrector extremes, mailbox
density), step 4 (more than one transaction a window; PSG on its own row),
step 5 (phase bins at 30 s, the 60 s combined run). Step 4's question has changed
shape: with one transaction the read grab is at 1,430 of 1,500, so **one per grab
is the ceiling at the current placement**.

## R25 §57 (2026-09-10) — CHECKPOINT B, awaiting decision

Commit `e3fa98a`. Baseline still frozen and byte-identical (`be1675e77edddbb3`).

**Roles settled for the decision point**: 68000 = sequencer + PSG, Z80 = DAC +
CSM + normal YM. The host-YM safe-window premise is WITHDRAWN (R25 §57.1) — the
YM2612 is on the Z80's bus and 68000 access needs BUSREQ — and 68000-direct YM
is not adopted: it sustains 51.3 writes/s against a representative score's 337,
a 6.7× shortfall. The CSM guard was NOT built: it would close the rare
address/data race but adds not one write a second. `ym-window.mjs` is kept as
the measurement of the Z80's OWN YM traffic, with all "window for the 68000"
language removed.

**PSG direct is free and it works.** The SN76489 is in the VDP's address space,
so `$C00011` needs no BUSREQ: over 30 s the 68000 delivered **5,232 of 5,232
bytes in the reference driver's own order** at 174.3/s, with bus stops 3,674
against the no-PSG baseline's 3,673, worst per-observation hold 1,429 against
1,418, and the DAC interval identical at 5,130..5,385 master. 60-second combined
run green: 3,676 bundles, 61.2 updates/s, late/busy/mismatch 0/0/0, 80 of 80
slots swept, four limits unchanged.

**The two-byte tone period is NOT atomic** — the chip applies the low four bits
on the first byte and the high six on the second (BlastEm `psg.c`). Written back
to back they are 294..364 master apart (~5.5 µs, about one cycle of the highest
tone), which is harmless; `PSG P1, split pairs` stretches them to ~15,000 and is
refused twice over (the gap, and 63 observation intervals past 1,500). These
images take no interrupt so the longest IRQ mask is 0; a driver with a VBlank
handler must mask across the pair — 24 cycles, 168 master.

**A trap worth remembering**: the PSG replay's work is data-dependent (0..6
bytes a frame) and the transfer period is generated from what the host loop
costs. Unpriced, it made the interval 668 master long and the phase sweep
reached only 63 of 80 slots — R22's slot-coverage rule caught it. Price
data-dependent host work at its AVERAGE.

**`corpus.mjs` reads the real traffic off the reference driver** (`DrvPlayer` +
`SlotBuilder`, the same pair the c-gate compares the C port against). Over 41
scores: 14,627 FM writes — 7,095 voice patch, 3,019 TL, 1,904 pitch-low and
1,904 pitch-high (always paired), 542 key. `m3-macro-multi` is 337 FM/s with
patches and 226 steady; a patch frame carries up to 194 writes alone. PSG peaks
at 169/s. `psg-corpus.json` is TRACKED — the P1 rom is built from it, and a
build input in a gitignored directory is a rom nobody can reproduce.

**Not started**: the YM transport (raw register stream vs compact desired state
vs resident voice table — to be chosen by comparing the volume above against the
1,500 master contract in one table), the Z80 YM writer, integration with the
existing driver, and any hardware run. b11..b14's reservation stays with the Z80
YM writer even though the PSG moved to the 68000.

## R26 §59 (2026-09-10) — the Z80 YM writer, and the reservation it does not fit

**Checkpoint B was accepted.** The chip owners are fixed: 68k = sequencer,
desired state and PSG; Z80 = DAC, CSM and normal FM. The 68000 does not touch
the YM2612 in normal operation. §59 asked for b11..b14's reserved pad — 280
cycles a block and 120 bytes — to become real instructions, for four FM writes a
block (2,496.9/s).

**It does not reach four a block, and the binding constraint is BYTES.** The
loop is eighty slots of straight-line code, so an opportunity that carries code
carries it twenty times a lap, and the writer cannot be shared:

* `call`/`ret` is 27 cycles and `rst`/`ret` 21, against a 70-cycle position that
  also has to fetch an entry and make three chip writes;
* the queue cursor has nowhere to live but **SP** — BC carries a decode value
  across 47 of the 80 slots, HL is the ring's play cursor, DE is the DAC's data
  port, IX is voice 1's source and IYL is the mixer's parking slot;
* SP and a call frame are mutually exclusive: `rst` pushes at SP-2, so the first
  `pop` inside a routine reads the return address instead of the queue.

So the site is inline at **11 bytes and 89 cycles**. Twenty of them are 223 B
against 120 and 356 cycles a block against 280 — over BOTH. `ym-writer.mjs`
prices five candidates (assembled for bytes, summed from documented cycles) and
none of them fits four a block; the only row whose CYCLES fit is port-1-only,
which cannot reach `$28`, `$22`, `$27`, `$2A` or channels 1-3 at all.

**What §59.3's first candidate got wrong.** The port-RUN format is the WORST of
the five here: with twenty independent inline sites "the current port" has no
register to live in, so every site re-reads it from RAM (4 B, 17 cycles) —
before any run-length countdown. The single stream carries the port in each
entry and gets run switching for free. That is what was built.

**Built and measured**: 10 sites of the 20 opportunities, **116 B** of the 120
reserved (10x11 + 3 cursor reload + 3 boot set-up), 188 cycles of the 280 a
block, **1,248.4 writes/s**. Four limits: worst slot 83.8%, mean 76.9%, finished
estimate **2,366 B** of 2,560 (194 B spare), RAM 8,192. (R26 §60 reported 113 B
and 2,363 B: the boot cursor line was added after that split run and was not in
the writer's ledger. R27 §61.3 step 4.) 30 s at max density: 37,156 register writes, 37,156 in the window's
order, settling and both frequency latches clean, 0 YM accesses from the 68000
and 0 PSG writes from the Z80. The mailbox in the same image: 61.2 updates/s,
worst stop 1,432 master, 80 of 80 slots.

**Two traps, both found by running it and both worth remembering.**

1. **The stack and the queue are the same page.** `call mix_one` runs in every
   slot and pushes at SP-2 — the last word the writer popped. For a queue
   consumed once that is free space; a STATIC window re-read every lap had its
   entry rewritten, and the second lap re-latched `$02` instead of `$2a`, so
   every DAC sample after it went into an FM register (3,373 Hz, 1,076 holes).
   The entry is six words and the site pops six, using five.
2. **A port-0 frequency pair may not straddle a block.** The engine's own CSM
   traffic writes `$AC` at b6 and commits it at b8, and the chip has ONE holding
   register per part. A pair split across two blocks loses its upper half to
   CSM. `pairsWithinBlocks()` refuses a window that does it; it is a constraint
   on the PRODUCER, not on the writer.

Also: the cursor reload (`ld sp,base`) must NOT sit in front of the first site —
that slot is already the fullest and ten more cycles took it to 85.5%, past the
83.9% ceiling. It goes in an opportunity the sites left empty, after the lap's
last pop; and boot must set SP too, or the first lap pops from the $2000 RAM
mirror and writes through the bank window.

**The input contract, stated as failures.** The target pointer makes an entry
live or idle — an entry pointing at the two-byte bucket in the chip region makes
no FM write at all, so "the queue is empty" is the same instructions, not a
branch. It is NOT a commit (R27 §61.2): a 16-bit pointer's halves never change
together on an 8-bit bus, so a real transport publishes by bus release or by a
separate one-byte generation written last. `--fault port-first` shows only that
a live entry read before its payload is wrong. The other four negatives are
`no-relatch`, `slow-empty` (the idle path one byte the same and three cycles
short), `port-bit` and `pitch-split`.

**Numbers a transport design has to start from**: 1,248.4 writes/s; 12 queue
bytes an entry of which a producer writes **four** (the target pointer is
SIXTEEN bits and the 68000 reaches Z80 RAM one byte at a time — R26 §60.8's
"three" counted fields, and R27 §61.2 withdraws it); a 194-write patch frame drains
in 19.4 laps (~155 ms) against the corpus's 246 steady writes a second and 337
with patches. The window is a FIXTURE — one lap's entries laid down by the 68000
before the Z80 starts, never refilled.

**Not started**: the 68k producer, the YM transport format (raw register stream
vs compact desired state vs resident voice table), integration with the existing
driver, and any hardware run. Stop is "Z80 YM writer P1 complete — awaiting the
transport decision".

## R27 §61 (2026-09-10) — transport P0: the wire is not what is short

**The 10-site writer was ADOPTED** as the normal-YM execution path (1,248.4
writes/s). Four writes a block is off the required list. Corrections made first
(§61.3): the writer's code is **116 B** of the 120 reserved (the boot cursor
line is the writer's too) and the finished estimate **2,366 B**; a producer
writes **4 bytes** a write, not three — the target pointer is 16 bits and the
68000 reaches Z80 RAM one byte at a time; and "the port word is the commit" is
withdrawn — a 16-bit pointer's halves never change together, so a real transport
publishes by bus release or by a separate one-byte generation written last.

**`semantic.mjs`** reads the 41 scores out of `c-gate`'s own argument list in
package.json (one place, so the two cannot drift) and folds the raw stream into
VOICE_SET / PITCH / TL / KEY / RAW_GLOBAL. `classify()` and `expand()` are two
functions, neither calling the other: **14,627 raw writes fold to 4,450 commands
and expand back byte for byte on every score**. 32 voice identities, 291 loads,
at most 4 live at once, 201 never keyed, 20 written onto a sounding channel,
lead median 1 frame and **12 of 90 key-ons have no lead at all**.

**`transport.mjs`** prices the bus: one byte into Z80 RAM is 87.2 master
(`move.b (a0)+,(a1)+`, 12 cycles at the measured 7.265 master a cycle) and a
grab of its own costs 403 master before any of them. The mailbox already takes
one grab a lap, so the leftovers are **375 B/s worst-case**. MERGING the
mailbox's read and publication into one grab an observation — R25 already
measured that shape at 373..1,354 master and it still makes 124.8 updates/s —
frees the alternate lap and gives **811 B/s**, 2.2x more, for nothing.

| candidate | steady wire | steady lat p95 | worst key-on | expander |
| --- | ---: | ---: | ---: | ---: |
| raw, as-is | 976 B/s | 8,447 ms | 8,571 ms | 0 |
| raw, merged | 976 B/s | 1,776 ms | 1,795 ms | 0 |
| hybrid | 976 B/s | 930 ms | 955 ms | 54 cyc/lap |
| semantic, merged | **369 B/s** | 239 ms | 106 ms | 242 cyc/lap |

**THE WIRE IS NOT WHAT IS SHORT.** Raising it to 256 bytes a lap — forty times
what exists — still leaves commands late. The searched answer is the other
pipeline: **the writer needs 22 sites a lap for every key-on on time and 24 for
every command, against the 10 it has** (270 B of code against 120 B reserved,
2,136 cycles a lap against 1,400). Four writes a block, which R26 could not
afford either, would still be short of 22. The same eleven-bytes-a-site wall
from the other side.

**What the Z80 owes for a semantic wire**: every producer-owned byte the 68000
does not write, the Z80 must — a fetch and a store, 26 cycles, because no
register file has anything spare. 242 cycles a lap over the corpus, which fits
in the ten b11..b14 opportunities the writer left empty (930 at the ceiling) and
SPENDS them, so those can never also become write sites. Reserved and executed
as padding the four limits hold: 83.8% / 78% / 2,507 B of 2,560 (with the
expander's 150 B) / 8,192 B. The CSM-harness image is 45 B past the region.

**Prefetch changed nothing in this corpus** — every patch is either in the cold
start, where there is nothing to move it past, or one of the 20 on a sounding
channel, where §61.4 forbids moving it. And the cold start is a floor: six
voices is 180 chip writes = 18 laps = **144 ms** whatever the transport does.

**Stopped at "transport P0 · candidate selection" with NO candidate adopted.**
Not started: the Z80 consumer, the 68k producer, integration, hardware.

## R28 §63 (2026-09-11) — the plan revised, and the one-voice image (step 1)

The user's instruction: execute the plan and revise it where hardware or
software limits block it, then get a mucom song (FM5, DAC1, PSG3) through
install-sgdk → SGDK → BlastEm. §62 had no candidate. §63 (written by the
implementer in the designer's seat) keeps every §1–§4 principle and changes two
things: the profile's voice count and the transport's shape.

**Why one voice unblocks it.** Voice 2 costs ~70 cycles a slot (5,600 a lap),
the 512 B clamp table, and IX/IY/AF'/HL'. Without it a plain slot is 39% and the
code region grows to 3,072 B. The whole chain (decode + corrector + protocol)
places with worst 83.8% / mean 72.1% and 353 B spare with the expander's 260 B
already owed.

**The transport (D3–D6, not yet built):** `{op,val}` pairs — `$22..$B6` RAW to
the current port, `$01` PORT, `$02` PCM_LEVEL, `$03` PCM_MASTER, `$04`
PCM_START(id) via a Z80 directory in the bank, `$05` PCM_STOP, `$10..$15`
VSET(ch, id) expanded from a ROM body, `$06` RET, `$00` IDLE. The Z80 self-idles
consumed pairs and publishes its FIFO position; the 68000 writes ahead of it,
two grabs a frame (VInt + mid-frame), each ≤ 1,500 master (k ≤ 5 pairs). PSG
stays on the 68000, delayed one frame to match. `mmlispseq.c`/`drv-player.js`
unchanged — the HOST translates the slot stream (D7).

**Step 1, built and measured** (`gen-stream.mjs` oneVoice, `config.mjs`
RAM_1V/PCM1/RESERVE_1V, `pcm1-ref.mjs`, `gate-1v.mjs`, five machine cases):

* mixer 122 cyc (16-bit `DE'` + self-modified 2^k `add`); edge = STOP b13 /
  COMPARE b14 / PARK b15 / START b0 at 104/65/61/156 cycles.
* **Balanced-arm branches, not masks**: `jr cc` + arm + `jr` over a pad of
  exactly arm+7. Masks cost 92/129/170/179 and blew three slots.
* **Generations, not flags** for start/stop: a set-and-clear flag has a
  read→clear window a BUSREQ can land in; the Z80 latches the value it read.
* END sent = `sampleEnd − 16·step` → zero overrun, ≤16 samples of tail lost, no
  blob padding. Silence page `$FF00` (a page, because the parked step is kept).
* Lead 18 (17 put START on the loop-back slot: 85.2%).
* Four bugs found on the way: stop latched after `ld hl,0` took L; the
  reference's `>` on a wrapping byte; a constant fake H made the corrector
  chase a phantom (now `syntheticH`); boot zeroed the 68000-staged start.

**Next**: §63.6 step 2 — the FIFO ring page, the expander routine (jump table,
padded handlers, self-idle, published index), a 68000 host in rom.mjs streaming
a recorded score's pairs at two grabs a frame; gate = chip write order per port
+ DAC vs reference + 1,500 master. Then step 3 (VSET/ROM bodies, exporter
directory), step 4 (P4 integration), step 5 (the mucom song).

### Step 2 (2026-09-11) — the pair transport on BlastEm

Built: `expanderSites`/`RESERVE_1V` (config), `xp_a`/`xp_b` + `balanceArms`
(gen-stream), `pair-host.mjs` (producer algorithm, streams, ROM table encoder),
`gate-fifo.mjs`, the `pairs` host in rom.mjs, six `pairs, *` machine cases with
`pairsGate` checks in machine-probe. Numbers: A 151 / B 82 cycles, 16 steps a
lap; image 2,880 B (275 of it the CSM test patch); worst 83.8% / mean 69.2%;
BlastEm 9,987.55..62 Hz, FM order exact on both ports, DAC exact, stops
280..1,500 master, p50 request→release 42..92 Z80 cycles.

Three things not to re-learn:
* **Plan outside the grab.** Parsing the table with BUSREQ held cost 5,800
  master a grab; only the index read and a straight `move.b (a0)+,(a1)+` run
  belong inside. Head = last grab's index + 24 (the consumer takes ≤ ~20 between
  grabs), so no in-grab arithmetic and no wrap: the planner stops at the page end.
* **Wait before the first grab.** The Z80's boot clears the pair page; a grab
  at release time is erased.
* **The frequency latch is TWO chip-wide registers (Nuked reg_a4 / reg_ac)**,
  not one per port: CSM's $AC/$A8 never touches a $A4/$A0 pair, but a port-1
  upper CAN clobber a port-0 upper. analyze.mjs models this now; §60.7's
  "unsafe" conclusion was the old model's artefact. Producer rule: a pitch pair
  is written whole in one grab.

VSET (step 3) deferred: a patch is 30 raw pairs = 6 grabs ≈ 50 ms; measure on
the real song before paying for ROM bodies. Next: step 4, the production
integration (build-engine → the generated image; mmlispdrv.c → the pair host,
two grabs a frame, PSG direct; slot stream → pairs in the host).

### Step 4/5 (2026-09-11) — the SGDK host, and what the real build taught

Built: `tools/build-engine.mjs` (production image, proto 11; old builder is
`build-engine-ring.mjs`), `68k/mmlpairs.{c,h}` + JS twin `tools/pairs-model.mjs`
+ `pairs-gate`, `sgdk/mmlispdrv.c` rewritten, `experimental/dac-stream/gate-score.mjs`
(shipped image + host model on real scores), `tools/sgdk-gate.mjs` (scratch
SGDK project → make → probe BlastEm → grade). Not to re-learn:

* **SGDK's HInt vector JUMPS to the callback** — it must be
  `HINTERRUPT_CALLBACK` (`MMLisp_hint`); a plain function crashed on `rts`.
* **The grab is asm**: C over `Z80_getAndRequestBus` was 2,835 master. Eight
  pairs as four `movep.l` (ops even, vals odd = the page layout), always 8
  (IDLE-padded), head sent to 0 if 8 do not fit before the page end.
  1,100–1,320 master. 960 pairs/s.
* **Both pumps from interrupts** (VBlank + HBlank line 93, armed once a frame);
  main-loop `MMLisp_frame()` only renders. A skipped pump made two grabs 19 ms
  apart, `H = Cprev + AHEAD` landed behind the index, and later pairs overtook
  a START's staged bytes. Now the grab reads the index and writes only if
  `(lo − loPrev) mod 256 < dist` (`mmlp_in_time`), else `mmlp_abort()`;
  AHEAD 32; `mmlp_slot` publishes a whole slot with one store. Line 112 put the
  two pumps in one 80-sample window (7.1 ms) — 93 gives 131 lines both ways.
* **PCM one slot late.** The sequencer starts PCM tracks a frame early for the
  ring mixer; with pairs that put drums 12–15 ms AHEAD of FM and no gate saw it.
  `mmlpairs.c` holds a slot's PCM commands for one slot, sends only changed
  staged bytes (a repeat hit = 1 pair), and keeps 3 pairs between a START and
  the next staged store. `tests/m3-pcm-sync.mmlisp` + SYNC rows: +0.6..+1.4 ms.
* **The image boots at level 0** — until the bank is set the window shows ROM
  bank 0 and the parked voice played it. `ld a,(LUT>>8)` assembles as a MEMORY
  load (put the level page at $80, inside the window: wrong byte AND a slow
  clock) — write `ld a,LUT>>8`.
* **SGDK halts the Z80 itself**: JOY_update (HALT_Z80_ON_IO, ~2,490 master per
  6-button port) and the DMA auto-flush EVERY VBlank even when empty (~600).
  With pads read the window exceeds the corrector; the autoplay build turns
  pads off. Documented in sgdk/README.md "Bus stops that are not the driver's".
  Idea not built: V-counter resync so the pitch does not depend on game load.

Open: step 3 (song-start voice burst takes several frames of the 16-pair wire —
first notes late), 2 voices / loops, hardware check of `movep` to Z80 RAM, the
user's own `main.c` still uses the ring API (`st.audible`/`st.starved`) —
they update it themselves.


### 68000 render cost and the tempo (2026-09-11/12) — DONE

User report after listening: tempo drags now and then, notes bunch, first
seconds silent (NOT reproduced headless — sound from 0.5 s; asked which ROM).
Cause: the sequencer overran frames and each overrun lost a frame for good.
Fixed in three commits, all output byte-identical where the sequencer is
concerned (c-gate 41/41):
* cca4383 pcm_frame closed form (27% of a frame -> 1%).
* bc5b8ef tools/sgdk-profile.mjs (marks, or --pc PC sampling via the probe's
  MMLISP_PROBE_PC hook + addr2line -i, --peak N for the worst renders) and the
  68000 fixes: `ch % 3` table (int % is __modsi3), 16-bit muls/divs in the
  pitch math (mml_divs is inline asm divs.w — only BlastEm verifies it),
  encode_slot writing runs in place, planner filling the grab block in place.
  Worst render 146% -> 116%. LTO had already inlined ym()/q_push: forcing
  inline changed nothing — measure before assuming call overhead.
* 8d871e6 render ahead (MMLISP_LEAD 1) + release by vtimer (mmlp_plan /
  mmlp_psg_take take a `release` frame count; pairs-gate checks lead 0/1/2 give
  the same wire). The HBlank pump releases the due frames, the VBlank pump one
  fewer: a full grab next to SGDK's DMA-flush halt overran the corrector window
  (295 windows / 20 s, DAC -0.08%); now 41, -0.015%. sgdk-gate grades the FM
  lag floor (drift) and has --burn. Drift 2.6 ms / 20 s; 10.8 ms with the main
  loop overrunning. Render-in-VBlank was rejected: SGDK DMA runs in main right
  after VInt.

Average cost on sin008: driver ~28% of the 68000 (render ~18%, pumps ~6%).
Remaining peaks: voice_set ~76k master per call, the slot round trip
(encode_slot + mmlp_slot per write). Idea not built: feed pairs from the
sequencer's queue directly (skip slot bytes) with a view-based gate.

User direction (2026-09-12): games (racing, raster 3D) may need HBlank for
themselves — a VBlank-only pump mode (480 pairs/s) is wanted as an option;
eventually trade some quality for balance. After DAC playback settles, the user
wants a TINY Z80-only version too (sequencer back on the Z80, this engine's
instruction-clock DAC reused).

### The song-start voice burst — user's idea and the numbers (2026-09-14)

User (after listening: quality OK, the silence was their player's spec):
spread the voice setup at COMPILE time so it does not land in one frame.
Measured facts to weigh it against: the 68000 side of the burst (frame 0 at
~93% of a frame) is already absorbed by the render lead; what delays the first
notes is the WIRE — ~250 register writes at 16 pairs/frame ≈ 16 frames
(~260 ms), and a mid-song voice change on several channels (frame 901 of
sin008: 67 writes) costs ~4 frames the same way. Spreading setup per channel
staggers the channels unless every note start is delayed by the same amount,
which gives the same total delay. Two fixes that do address the wire:
(a) PRIME AT LOAD — the tracks' leading setup rendered at MMLisp_loadScore and
sent over the idle frames before startTrack (sequencer API + JS reference
mirror, c-gate); (b) R28 step 3, VSET bodies in the sample-bank ROM (one pair
per voice; also fixes mid-song changes; engine + exporter). Not decided yet.
User's stated order: correct playback first, then optimization; the realistic
spec is now visible (FM6 + PSG3 + 1 PCM voice at 9,987 Hz, 960 writes/s,
driver ~28% of the 68000 on sin008 — candidates to cut: SLOT_SUBS 2→1, the
slot encode/decode round trip, a VBlank-only pump mode).

### 2026-09-14 — prime, view path, VBlank-only (all DONE) and the SUBS question

* fb4fd78 PRIME at load (mml_prime_tracks, host cmd 0x08, C + drv-player.js):
  first key-ons on sin008 252 ms late -> on time. Chip state identical after
  the start by change-only. c-gate runs every schedule-free score primed too.
* 2a96db6 MMLFrameView + mmlp_render: the SGDK host no longer packs/parses
  slots (view_main runs both paths side by side, state for state). Idle
  71.9% -> 74.0%.
* e47a976 MMLisp_attachVBlankOnly / MMLisp_setPumpsPerFrame; cfg.ahead 48 for
  one grab a frame. Costs: 480 writes/s, DAC -0.10% (grab + SGDK DMA flush in
  one corrector window).
* 1ea5ccd SLOT_SUBS = 1, no build option — the user's call ("most game
  drivers are 1/60"; an option would complicate the sources). Idle 71.9% ->
  78.6% (render p50 17.7% -> 11.5%), c-gate/pairs-gate green, ab-baseline
  re-frozen. The sub-tick machinery is LEFT in the sources on purpose: at
  SUBS=1 LTO folds the one-iteration loops and dead `sub != 0` branches, the
  SGDK host never encodes slots (view path), so deleting it buys nothing
  measurable (checked in the built ROM: all of it inlined into main, ~3 B RAM
  left) and would touch C, JS reference, slot format and the legacy gates.

Still open (none requested yet): R28 step 3 (VSET ROM bodies — mid-song voice
changes, e.g. sin008 frame 901, 67 writes ~ 4 frames), 2 voices / sample loops,
SE on the 68k sequencer (not ported), `(trig N)` to the host, a hardware run
(`movep.l` to Z80 RAM), the tiny Z80-only build.
