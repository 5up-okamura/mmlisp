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
