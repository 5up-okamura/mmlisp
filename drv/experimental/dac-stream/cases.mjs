// The case table, in its own module so that a tool other than the runner can
// resolve a case to the exact rom it produces (R5 §15.2 C). Importing
// machine-probe.mjs would run the whole suite; importing this runs nothing.
// Isolated regressions, measured transfer candidates, and known failing loads.
export const sine = (n, amp, cycles) => Uint8Array.from({ length: n },
  (_, i) => Math.round(128 + amp * Math.sin((2 * Math.PI * i * cycles) / n)) & 0xff);
export const CASES = [
  // THE COMPENSATION IS THE PLANNED STOP, and the planned stop is a property
  // of the transfer routine — the 68000's fixed hold plus the grant and resume
  // latencies. It is set from the measured stop→resume of the SAME routine
  // under a nop-only window (2026-09-06, BlastEm): 8 B 62.8..68.3, p50 ~65;
  // 4 B 38.3..42.5, p50 ~41. Then it is PROVED, not assumed, by walking the
  // host's phase (--every-sweep): the mean-rate error stays inside
  // -0.0004%..+0.0001% over 31 phases at 8 B, where the earlier `djnz` window
  // put one phase at +0.2387%. On hardware the residual is the M-cycle grant
  // jitter, which this model only approximates — see the README.
  ...[0,1,5,50,100,200,300,1000].map((every) => ({
    name: `cooperative density 8B/5 slots delay ${every}`, cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { every, bytes: 8, optimized: true, cooperative: true }, informational: true,
  })),
  ...[0, 1, 12000, 30000].map((every) => ({
    name: `cooperative 4B host delay ${every}`, cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 80, compensation: 41 },
    grab: { every, bytes: 4, optimized: true, cooperative: true },
  })),
  // COMPUTED TIMING: the 68000 grabs from the HBlank interrupt every `line`
  // lines, with no notification and no polling — the only shape a game's
  // 68000 could use. The Z80 side is the cooperative engine unchanged, so the
  // instrument still sees every window; what is measured is where the grabs
  // LAND relative to the windows, under a 68000 running `divu` in its loop.
  // Informational: a grab outside a window is repaid by a slot that was not
  // stalled, and the DAC gate says what that costs.
  ...[8, 26, 105].map((line) => ({
    name: `hblank grab 8B every ${line} lines`, cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, line, bytes: 8 }, informational: true,
  })),
  { name: "hblank grab 8B every 8 lines, unloaded 68k", cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, line: 8, bytes: 8, load: "none" }, informational: true },
  // The load, separated (§12.2 A): a short instruction, a divide that really
  // divides, and a stretch with level 4 masked so the tick is LOST. The first
  // version of this ran an overflowing divide, which took the early exit and
  // measured nothing at all.
  ...["short", "divu", "masked"].map((load) => ({
    name: `hblank grab 8B every 8 lines, ${load} load`, cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, line: 8, bytes: 8, load }, informational: true })),
  // Can the 68000 see its own phase? The handler stamps the VDP's HV counter
  // at entry, which is the only clock it can read without taking the Z80 bus.
  ...["divu", "masked"].map((load) => ({
    name: `hblank HV at entry, ${load} load`, cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, line: 8, bytes: 8, load, hv: true, marks: true }, informational: true })),
  // What the load actually costs, measured with interrupts masked and the Z80
  // untouched — so the DAC gate runs unchanged beside it and this case is
  // REQUIRED, not exploratory.
  { name: "load calibration", cfg: {}, wave: sine(256,120,1), calibrate: true },
  // THE SAME CALIBRATION WITH THE DISPLAY ON (R20 §48.5). The transfer period
  // is a DBRA count and the generator has to know what one is worth. With the
  // VDP drawing it is not the seventy master its ten cycles would be, and the
  // difference over a lap of waiting is 16,500 master — the whole reason the
  // first generated period overshot. This case measures it and fails if it has
  // moved away from the number the generator uses.
  { name: "load calibration, display on", cfg: {}, wave: sine(256,120,1),
    calibrate: true, vdp: true, calibrationOf: "display" },
  // ── the phase observer, step one (R4 §13.3.2) ───────────────────────────
  // The load, timed inside the observer's OWN rom (R5 §15.2 A): the
  // calibration rom's instruction times do not show what this one ran.
  { name: "hv observer, load timed in place", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "divu", loadProbe: true } },
  // Output only, no correction, no transfer: can the Z80 read the VDP's HV
  // counter at all, what does it get, and does the schedule survive it?
  // Required, not exploratory — the whole point is that the DAC must not move.
  ...[["h"], ["v", "h"], ["h", "h"], ["h", "v"]].map((reads) => ({
    name: `hv observer, Z80 reads ${reads.join("+")}`, cfg: {}, wave: sine(256,120,1),
    observer: { reads, store: true, load: "divu" } })),
  { name: "hv observer, idle 68k", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "none" } },
  // …and the same read inside the schedule it would have to live in: the
  // complete 2ch budget with the reservations executed, and with CSM.
  { name: "hv observer in the 2ch budget", cfg: { voices: 2, complete: true },
    observer: { reads: ["v", "h"], store: true, load: "divu" } },
  { name: "hv observer in the 2ch budget + CSM", cfg: { voices: 2, complete: true, csm: true },
    observer: { reads: ["v", "h"], store: true, load: "divu" } },
  // …and with the disturbance the observer exists to notice: a plain,
  // UNREPAID bus grab. The DAC gate fails by construction here — that is the
  // injected fault — so these are exploratory; what is being judged is whether
  // the readings show it.
  ...[1, 16, 64].map((bytes) => ({
    name: `hv observer, unrepaid ${bytes}B stall`, cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "divu",
      stall: { every: 2000, bytes } }, informational: true })),
  // The same question from a different starting phase. Nops before the bus is
  // released move the Z80's whole schedule against the VDP's counters; 40 of
  // them is 280 master, and eight steps walk most of a line.
  ...[1, 2, 3, 4, 5, 6, 7].map((k) => ({
    name: `hv observer, boot phase ${k}`, cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "divu", bootNops: 40 * k } })),
  // ── the decoder, running on the Z80 (R6 §17.4 step 2) ───────────────────
  // No correction: it reads, decodes, and publishes what it decided so the
  // instrument can compare it with the reference. Required — the DAC must not
  // move while it does that.
  { name: "z80 decoder, quiet", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, publish: true, load: "divu" } },
  { name: "z80 decoder, 4B stall", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, publish: true, load: "divu",
      bootNops: 260, stall: { every: 3000, bytes: 4 } }, informational: true },
  // ── THE RUNTIME PROTOCOL, as real code on both CPUs (R12 §33.6 step 2) ──
  // P1, five slots a lap and one job to a slot: read, check the host's control
  // block, decode, publish the snapshot, advance the output index. The 68000
  // takes the bus for real — eight LIVE reads of the published snapshot, which
  // change nothing, then one BULK invalidation that bumps the phase generation
  // and commits it. The engine has to drop its difference on the invalidation
  // and re-acquire from the next known reading, and nothing else.
  // Three runs, because the two pieces cost different amounts and a run that
  // does both reports one range covering the pair (§33.4).
  { name: "proto P1, live reads only", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, load: "divu",
      proto: { every: 3000, skipBulk: true } }, informational: true },
  { name: "proto P1, invalidations only", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, load: "divu",
      proto: { every: 3000, between: 0, skipLive: true } }, informational: true },
  // A REAL COMMAND, and nothing else (R13 §35.3 step 1). The host writes the
  // payload and then `commandCommit`, touching neither the phase generation nor its
  // commit — so the engine's H synchronisation has to survive every one of
  // them, unbroken, which is what this case exists to show from the outside.
  { name: "proto P1, mailbox only", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, load: "divu",
      proto: { every: 3000, skipLive: true, skipBulk: true, queue: true } },
    // Informational to machine-probe for the same reason as the others: a run
    // that takes the bus on purpose does not hold a fixed DAC interval, and
    // what grades it is `dac-stream:decoder`.
    informational: true },
  // THE FIVE PIECES, ONE PER RUN (R13 §35.3 step 3, R17 §43.6 step 6). Each is
  // what the 68000 actually executes for that job, measured as STOP -> RESUME
  // with the bus really held — not a byte count and not a model.
  ...[["payload", "the bundle's five bytes, with the commit left alone"],
      ["commit", "the piece that ends it: the commit byte alone"],
      ["ack", "the answer alone: one byte the Z80 owns and the host only reads"],
      ["mailbox", "the whole handshake in one grab: read the ack, publish if free"],
      ["snapshot", "the time update: the selector and both faces"],
      ["invalidate", "the phase declared over: generation then its commit"]]
    .map(([piece]) => ({
      name: `proto P1, piece ${piece}`, cfg: {}, wave: sine(256,120,1),
      observer: { reads: ["h"], decode: true, load: "divu",
        proto: { every: 3000, piece } },
      informational: true })),

  // THE ACCESS WIDTH, ON THE MACHINE (R20 §48.3 step 1). The one proto case
  // whose verdict does not depend on the DAC: the bus really is taken, so the
  // mean rate and the interval band are informational the way they are for
  // every other transfer case — but a duplicated byte is NOT a timing error,
  // so it is fatal, and `--required-only` runs this case for that reason.
  // It is the standing answer to "the transfer was timed and never read back".
  // The engine publishes a face whose three bytes behind the observation
  // number are $A5, $3C and $5A: three DIFFERENT values, in three neighbouring
  // bytes, so a read that duplicates the even byte comes back visibly wrong.
  // `--fault wide-read` is the same case with the withdrawn word-move read,
  // and it has to fail.
  { name: "proto P1, snapshot byte width", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, load: "divu",
      proto: { every: 3000, width: true, bootGeneration: 0x3ca5,
        phaseGeneration: 0x5a } },
    widthWitness: true, informational: true },

  { name: "proto P1, live and bulk", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], decode: true, load: "divu",
      proto: { every: 3000, between: 8 } }, informational: true },

  // ── the decoder INSIDE the complete 2ch engine (R8 §23.5 step 3) ────────
  // The 15-level profile, the mixer, every reserved feature's cycles, CSM's
  // register traffic, and the phase decode cut into 21 pieces placed among
  // them. Nothing is published over the bus: the instrument watches the Z80's
  // own writes to the globals page, so the image measured is the image under
  // test rather than a heavier twin (R7 §20.2 B).
  { name: "2ch 15-level decoder, quiet", cfg: { voices: 2, complete: true, csm: true,
      levels: 15, workTarget: 0.839 },
    split: { load: "divu" } },
  { name: "2ch 15-level decoder, 4B stall", cfg: { voices: 2, complete: true, csm: true,
      levels: 15, workTarget: 0.839 },
    split: { load: "divu", bootNops: 260, stall: { every: 3000, bytes: 4 } },
    informational: true },

  // ── the same engine WITH the bounded corrector (R10 §29.5, §29.7) ───────
  // The "time-publication-replaced" budget image: b1..b4's 75 cycles a block
  // are spent on the corrector instead of on the output-index publication, and
  // the 70 B that publication owed leave the code estimate with them. The
  // ladders are the only thing in the loop whose length is not fixed, so the
  // DAC interval is no longer one number — 342..375 cycles — and that is the
  // point of the image rather than a defect in it.
  { name: "2ch corrector, quiet", cfg: { voices: 2, complete: true, csm: true,
      levels: 15, workTarget: 0.839, correctorBudget: true },
    split: { load: "divu", place: { correct: true } } },
  { name: "2ch corrector, 4B stall", cfg: { voices: 2, complete: true, csm: true,
      levels: 15, workTarget: 0.839, correctorBudget: true },
    split: { load: "divu", bootNops: 260, stall: { every: 3000, bytes: 4 },
      place: { correct: true } },
    informational: true },
  // A disturbance that STOPS, which is the case the corrector exists for. The
  // 4 B stall above repeats every 3,000 DBRA iterations — roughly every read —
  // so the debt never gets a quiet observation to walk back in, and a quiet run
  // never moves it at all. Neither can show a RETURN. 41,000 iterations is one
  // displacement about every seven observations, with the same 4 B stall that
  // measures 452..1,295 master — inside the 1,500 master contract.
  { name: "2ch corrector, occasional 4B stall", cfg: { voices: 2, complete: true, csm: true,
      levels: 15, workTarget: 0.839, correctorBudget: true },
    split: { load: "divu", bootNops: 260, stall: { every: 41000, bytes: 4 },
      place: { correct: true } },
    // INFORMATIONAL to machine-probe, which grades a fixed interval: a working
    // corrector moves the DAC by design, so the interval band is not the test
    // for this image. What grades it is `dac-stream:decoder`, where the movement
    // is compared with the correction that was decided.
    informational: true },
  // ONE SIZE OF DISTURBANCE IS NOT A SWEEP (R11 §31.2). 1, 2, 4 and 8 bytes,
  // each isolated (about seven observations apart, so the debt has quiet
  // observations to walk back in) and each at a different boot phase, so the
  // stop does not always land in the same part of the loop. The landing slot is
  // reported: 41,000 iterations is not commensurate with the 430,080-master
  // loop, so the stop walks across all 80 slots by itself.
  // THE OBSERVATION NUMBER CARRYING PAST $FFFF, reached rather than waited for
  // (R11 §31.2): 65,536 observations is 8.7 minutes of run time, and the counter
  // is a boot constant, so the image under test is the image with one immediate
  // changed. Four observations in, the low byte wraps and the high byte has to
  // follow — through the corrector's gating of KNOWN, which is the part that had
  // never seen it.
  { name: "2ch corrector, counter wrap", cfg: { voices: 2, complete: true, csm: true,
      levels: 15, workTarget: 0.839, correctorBudget: true },
    split: { load: "divu", place: { correct: true, countFrom: 0xfffc } } },
  // ── THE WHOLE THING AT ONCE (R19 §46.3) ─────────────────────────────────
  // Until now the complete 2ch engine was verified in JS slots and the 68000's
  // mailbox transfer on a P1 output image, and nothing ran both. This is the
  // finished shape: two voices, fifteen levels, CSM, the corrector, the compact
  // snapshot, the one-slot mailbox — and a REAL 68000 host driving it, reading
  // the published snapshot, aiming a bundle `lead` observations ahead, then
  // reading the ack and publishing if the box is free.
  //
  // `csmHost` is what makes it assemble: the CSM test voice is harness, and the
  // 68000 writes it while it still holds the bus, so the engine's code region
  // does not carry 162 bytes of scaffolding (R19 §46.3).
  // THE PERIOD IS GENERATED, NOT WRITTEN DOWN (R20 §48.5). The old fixed
  // `every: 6144` was one lap of DBRA and nothing else, so the 68000's own
  // execution time landed on top of it and the interval was always longer than
  // the lap it was named after. `transferPeriod` takes the two bounds — at
  // least one observation interval, at most masterHz/120 so that two transfers
  // still make 60 updates a second — and the emitter prices its own
  // instructions and solves for the two DBRA counts. `density: 2` halves the
  // spacing on purpose, so a second grab lands in the same interval and the SUM
  // is what has to be read.
  //
  // INFORMATIONAL to machine-probe, for the same reason every other case that
  // takes the bus on purpose is: the DAC interval is not fixed while the 68000
  // holds the bus, and the level pages really do change, so the fixed-waveform
  // value model does not apply. What grades these is `dac-stream:decoder`.
  // THE LEAD IS CHOSEN BY THE SWEEP, NOT BY HAND (R20 §48.5 step 4). A bundle
  // names the observation it is to take effect at, and the mailbox holds it
  // until that observation arrives — so too small a lead is applied late and
  // too large a one keeps the box occupied and costs updates. 1, 2 and 3 are
  // run and the smallest with no late bundle outside startup is the one the
  // rate condition is graded on. `a lap late` names a boundary that has already
  // gone by, and has to be late every time: the negative that proves the count
  // is a count.
  ...[["lead 1", 1, 1, false], ["lead 2", 2, 1, false], ["lead 3", 3, 1, false],
    ["a lap late", 0, 1, false], ["at double density", 2, 2, true]]
    .map(([what, lead, density, dense]) => ({
      name: `2ch mailbox, ${what}`,
      cfg: { voices: 2, complete: true, csm: true, csmHost: true, levels: 15,
        workTarget: 0.839, correctorBudget: true, command: true },
      split: { load: "divu", proto: { live: true, lead, density },
        place: { correct: true, proto: true, command: true } },
      dense, informational: true,
      // The mixer's level pages really change here — that is the whole point —
      // so the fixed-level reference does not apply and the DAC is graded on
      // what the staged pages did, by `dac-stream:decoder`.
      levelsMove: true,
    })),

  // EITHER SIDE OF WHAT H CAN SEE (R11 §31.2). 12 B lands about at the 1,500
  // master contract, 16 B past it but inside half a line, 24 B past half a line
  // and 64 B past a whole one. INFORMATIONAL, and deliberately so: past half a
  // line H reports the short way round, so the record's difference is a small
  // ordinary number and the corrector acts on it. The debt limit cannot refuse
  // that — only an external invalidation from the 68000 could, and there is no
  // input path for one yet. These runs exist to MEASURE the boundary, not to
  // claim it is defended.
  ...[[12, 20], [16, 60], [24, 100], [64, 140]].map(([bytes, bootNops]) => ({
    name: `2ch corrector, beyond ${bytes}B stall, phase ${bootNops}`,
    cfg: { voices: 2, complete: true, csm: true, levels: 15, workTarget: 0.839,
      correctorBudget: true },
    split: { load: "divu", bootNops, stall: { every: 41000, bytes },
      place: { correct: true } },
    informational: true })),
  ...[[1, 20], [2, 60], [8, 140]].map(([bytes, bootNops]) => ({
    name: `2ch corrector, single ${bytes}B stall, phase ${bootNops}`,
    cfg: { voices: 2, complete: true, csm: true, levels: 15, workTarget: 0.839,
      correctorBudget: true },
    split: { load: "divu", bootNops, stall: { every: 41000, bytes },
      place: { correct: true } },
    informational: true })),

  // IN-CONTRACT DISTURBANCES (R6 §17.2 B). The verification runs had no
  // unplanned displacement at all, so nothing showed that a small stall is
  // measured correctly — only that a quiet run stays quiet. These inject
  // displacements that stay inside half a line, at boot phases and transfer
  // intervals the calibration never saw.
  ...[[1, 1500, 20], [2, 900, 60], [4, 3000, 100], [8, 1200, 140]].map(([bytes, every, bootNops]) => ({
    name: `hv observer, in-contract ${bytes}B stall every ${every}`, cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "divu", bootNops,
      stall: { every, bytes } }, informational: true })),
  // Consecutive stalls: the host takes the bus again before the next read.
  // Consecutive read intervals each carrying a stall — one grab per interval,
  // not the hundreds that `every: 0` produced, which put the run far outside
  // the contract it was meant to exercise.
  { name: "hv observer, back-to-back 2B stalls", cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "divu", bootNops: 180,
      stall: { every: 600, bytes: 2 } }, informational: true },
  // Either side of the half-line boundary, which is where H stops being able
  // to say which way the schedule moved.
  ...[16, 24].map((bytes) => ({
    name: `hv observer, boundary ${bytes}B stall`, cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["h"], store: true, load: "divu", bootNops: 220,
      stall: { every: 700, bytes } }, informational: true })),
  // The non-uniform spacing pattern, end to end, with a small stall in it.
  { name: "hv observer, 2ch pattern with a 4B stall", cfg: { voices: 2, complete: true, csm: true },
    observer: { reads: ["h"], store: true, load: "divu",
      stall: { every: 2500, bytes: 4 } }, informational: true },
  // H alone repeats every line, so a shift of more than half a line is
  // reported the short way round. These read V as well, which is what a
  // decoder needs to tell one line from another.
  ...[16, 64, 256].map((bytes) => ({
    name: `hv observer, V+H, unrepaid ${bytes}B stall`, cfg: {}, wave: sine(256,120,1),
    observer: { reads: ["v", "h"], store: true, load: "divu",
      stall: { every: 2000, bytes } }, informational: true })),
  // Computed timing: every line ticks; the handler waits out the remainder to
  // the next window and grabs there. `path` is the handler's fixed cost in
  // master clocks from tick to request, set from where the grabs land.
  { name: "computed timing 8B, path 0", cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, computed: true, line: 1, bytes: 8, path: 0, captureOffset: -2130 }, informational: true },
  // The 68000's interrupt latency is the one thing `rem` cannot know: the
  // handler measures from the tick, not from when it actually started. An
  // idle loop of one `bra` bounds that at 10 cycles; four `divu`s are ~570.
  { name: "computed timing 8B, unloaded 68k", cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, computed: true, line: 1, bytes: 8, path: 0, load: false, captureOffset: -2130 }, informational: true },
  { name: "computed timing 8B, unloaded, window sync", cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65, windowSync: true },
    grab: { hint: true, computed: true, line: 1, bytes: 8, path: 0, load: false, captureOffset: -2130 }, informational: true },
  { name: "computed timing 8B, debug payload", cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 5, compensation: 65 },
    grab: { hint: true, computed: true, line: 1, bytes: 8, path: 0, debugPayload: true }, informational: true },
  { name: "cooperative absent host", cfg: {}, wave: sine(256,120,1),
    cooperative: { slots: 80, compensation: 41 }, bankOnly: true },
  ...[1, 2, 4].flatMap((bytes) => [
    { name: `uncompensated legacy ${bytes}B`, cfg: {}, wave: sine(256,120,1),
      grab: { every: 12000, bytes }, informational: true },
    { name: `uncompensated optimized ${bytes}B`, cfg: {}, wave: sine(256,120,1),
      grab: { every: 12000, bytes, optimized: true }, informational: true },
  ]),
  { name: "output only", cfg: {}, wave: sine(256, 120, 1) },
  { name: "output only + CSM", cfg: { csm: true }, wave: sine(256, 120, 1) },
  { name: "one voice", cfg: { voices: 1 } },
  { name: "two voices", cfg: { voices: 2 } },
  { name: "two voices + CSM", cfg: { voices: 2, csm: true } },
  { name: "2ch complete budget", cfg: { voices: 2, complete: true } },
  { name: "2ch complete budget + CSM", cfg: { voices: 2, complete: true, csm: true } },
  // Historical transfers use a DBRA delay, not VBlank synchronization.
  // Their timing failures remain informational; data/probe failures are fatal.
  { name: "68k transfer, 1 byte DBRA12000", cfg: { voices: 2, complete: true },
    grab: { every: 12000, bytes: 1 }, informational: true },
  { name: "68k transfer, 1 byte DBRA6000", cfg: { voices: 2, complete: true },
    grab: { every: 6000, bytes: 1 }, informational: true },
  { name: "68k transfer, 16 bytes DBRA6000", cfg: { voices: 2, complete: true },
    grab: { every: 6000, bytes: 16 }, informational: true },
  { name: "68k transfer, 64 bytes DBRA6000", cfg: { voices: 2, complete: true },
    grab: { every: 6000, bytes: 64 }, informational: true },
  { name: "68k transfer, 256 bytes DBRA6000", cfg: { voices: 2, complete: true },
    grab: { every: 6000, bytes: 256 }, informational: true },
  // The allowance scales with the period, so the same transfer is a different
  // proposition at the clock the driver ships at today.
  { name: "3.3 kHz, 4 bytes DBRA12000", cfg: { voices: 2, profile: "p3k3" },
    grab: { every: 12000, bytes: 4 }, informational: true },
  { name: "3.3 kHz, 16 bytes DBRA12000", cfg: { voices: 2, profile: "p3k3" },
    grab: { every: 12000, bytes: 16 }, informational: true },
];
