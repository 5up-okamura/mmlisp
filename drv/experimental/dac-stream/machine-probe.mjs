// Run the dac-stream prototype on BlastEm, and read what the DAC really did
// (docs/dac-engine-implementation.md §10.3 step 3, R1).
//
//   sh drv/blastem/setup.sh                                   # once
//   node drv/experimental/dac-stream/machine-probe.mjs [--case NAME] [--seconds N]
//
// The JS instruction model says the placement arithmetic is right. It cannot
// say anything about bus arbitration, the ROM window, the YM's own timing, or
// what a 68000 taking the bus costs — and §6.4 has been an empty column since
// the prototype started. This fills the emulator half of it.
//
// It is still a model. A green run here is a reason to spend a hardware round,
// not a substitute for one.
import { COOP } from "./cooperative.mjs";
import { createHash } from "node:crypto";
import { readProbe, analyzeProbe, analyzeTransfers, analyzeHost, windowGenerations,
  analyzeAdoption, analyzeResidual, summarizeResults, Z80_DIV } from "./probe-analysis.mjs";
import { resolveCase, FAULTS } from "./case-config.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../tools/z80asm.mjs";
import { stampLine } from "./config.mjs";
import { buildRom } from "./rom.mjs";
import { mixOne, mixTwo, LEVELS } from "./lut.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const OUT = join(drv, "out", "dac-stream");
const BLAST = join(drv, "out", "blastem");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 5));
const ONLY = arg("case", null);
// --compensation N: the planned-stop repayment the cooperative slot subtracts
// from its pad, overriding the case's own. It is the 68000 routine's fixed
// hold plus the grant and resume latencies, so it is a property of the
// transfer code — set it from the measured stop→resume of the SAME routine,
// then prove across host phases that the residual is bounded.
const COMP = arg("compensation", null) === null ? null : Number(arg("compensation"));
// --capture-offset N: computed timing's boot calibration, in master clocks
// (positive = grab earlier), overriding the case's own.
const CAPOFF = arg("capture-offset", null) === null ? null : Number(arg("capture-offset"));
// --fault NAME: break the transfer protocol on purpose. A gate that cannot be
// made to fail is not a gate, and until R3 the HBlank cases were scored on
// their PCM alone — which the payload cannot reach.
const FAULT = arg("fault", null);
if (FAULT && !FAULTS[FAULT]) { console.error(`machine-probe: unknown --fault ${FAULT}; one of ${Object.keys(FAULTS).join(", ")}`); process.exit(2); }
// --marks: build the ROM with the 68000-side timestamp writes. A DIFFERENT
// ROM from the one under test, and reported as one.
const MARKS = argv.includes("--marks");
const STRICT = argv.includes("--strict");
if (!Number.isFinite(SECONDS) || SECONDS < 0.5 || SECONDS >= 70)
  throw new Error("--seconds must be >= 0.5 and < 70 (32-bit instrument clocks)");

const core = ["blastem_libretro.dylib", "blastem_libretro.so"]
  .map((f) => join(BLAST, f)).find(existsSync);
const host = join(BLAST, "host");
if (!core || !existsSync(host)) {
  console.error("machine-probe: BlastEm is not built here — run `sh drv/blastem/setup.sh` first");
  process.exit(2);
}

const coreHash = createHash("sha256").update(readFileSync(core)).digest("hex");

// Isolated regressions, measured transfer candidates, and known failing loads.
const sine = (n, amp, cycles) => Uint8Array.from({ length: n },
  (_, i) => Math.round(128 + amp * Math.sin((2 * Math.PI * i * cycles) / n)) & 0xff);
const CASES = [
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

const MCLK = 53693175;

function runCase(c0) {
  // ONE resolved configuration, from here to the JSON (§12.3): the overrides
  // are applied once, and the case object that is generated, run, analyzed and
  // recorded is the same object.
  const resolved = resolveCase(c0, { compensation: COMP, captureOffset: CAPOFF, fault: FAULT });
  const cfg = resolved.cfg;
  let c = resolved.case;
  if (MARKS && c.grab) c = { ...c, grab: { ...c.grab, marks: true } };
  const gen = resolved.gen;
  const caseId = createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0,12);
  mkdirSync(OUT, { recursive: true });
  const zpath = join(OUT, `probe-${cfg.stamp}-${caseId}.z80`);
  writeFileSync(zpath, gen.text);
  const built = assemble(zpath);

  // P1 plays a waveform out of Z80 RAM, so it travels inside the image; P2
  // reads its voices through the 68k window, so they travel in the cartridge.
  let samples = null;
  let image = Uint8Array.from(built.bytes);
  if (cfg.voices) {
    samples = new Uint8Array(512);
    samples.set(sine(256, 120, 1), 0);
    samples.set(sine(256, 90, 3), 256);
  } else {
    // P1's waveform lives in Z80 RAM past the end of the assembled image, so
    // the upload has to carry it.
    const end = cfg.ram.wave[1];
    const grown = new Uint8Array(end);
    grown.set(image, 0);
    grown.set(c.wave, cfg.ram.wave[0]);
    image = grown;
  }

  if (!samples && c.grab) samples = Uint8Array.from({length:512}, (_,i)=>(i*73+19)&255);
  const { rom, sha } = buildRom(image, samples, c.grab ?? null);
  const rpath = join(OUT, `probe-${cfg.stamp}-${caseId}-${sha}.bin`);
  writeFileSync(rpath, rom);

  const log = join(OUT, `probe-${cfg.stamp}-${caseId}-${sha}-${coreHash.slice(0,8)}-${SECONDS}s${argv.includes("--inject-value-error") ? "-mutant" : ""}.log`);
  rmSync(log, { force: true });
  const frames = Math.round(SECONDS * 60);
  execFileSync(host, ["--core", core, "--rom", rpath, "--frames", String(frames),
    "--wav", log.replace(/\.log$/, ".wav")],
    { env: { ...process.env, MMLISP_PROBE_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });

  return { cfg, gen, sha, log, rpath, image, samples, resolved: c };
}

const q = (s, p) => s[Math.floor((s.length - 1)*p)];
const results = [];
// --every-sweep lo,hi,step: re-run each selected transfer case with the host's
// DBRA delay walked across a range. `every` sets where in the Z80's group the
// 68000 enters its polling section, and R2 §11.4 asks for the transfer to be
// measured across the host's phase — the eight hand-picked delays found one
// failing phase; a walk finds the bias envelope.
const EVERY = (() => { const v = arg("every-sweep", null); if (!v) return null;
  const [lo, hi, step] = v.split(",").map(Number);
  if (![lo, hi, step].every(Number.isInteger) || step < 1 || hi < lo) throw new Error("--every-sweep lo,hi,step");
  return Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step); })();
const selected = CASES.filter((c) => (!ONLY || c.name.includes(ONLY))
  && (!argv.includes("--phase-sweep") || c.name.startsWith("uncompensated"))
  && (!EVERY || c.grab))
  .flatMap((c) => argv.includes("--phase-sweep") ? Array.from({length:32}, (_,phase)=>({
    ...c, name: `${c.name} phase ${phase}`, phaseFamily: c.name,
    // Six NOPs = 168 master clocks; 32 entry offsets span one 5376-master period.
    grab: {...c.grab,startNops:6*phase},
  })) : EVERY ? EVERY.map((every) => ({
    ...c, name: `${c.name.replace(/ delay \d+$/, "")} every ${every}`,
    everyFamily: c.name.replace(/ delay \d+$/, ""), grab: { ...c.grab, every },
  })) : [c]);
// One line per family under --every-sweep, so the envelope is one number.
const everyRows = [];
console.log(`machine-probe — BlastEm, ${SECONDS}s a case; timing = Z80 DAC bus writes`);
for (const c0 of selected) {
  let r;
  try { r = runCase(c0); }
  catch (e) {
    // A configuration that cannot be built is a failure of the run, not a
    // stack trace: say which case and why, and keep the exit status.
    globalThis.console.log(`FAIL ${c0.name}: ${e.message}`);
    results.push({ name: c0.name, errors: [e.message] });
    continue;
  }
  // Everything below reads the RESOLVED case, which is what was built and run.
  const c = r.resolved;
  const log = readProbe(readFileSync(r.log));
  const expected = (i) => {
    if (!r.cfg.voices) return c.wave[i % 256];
    if (i < r.cfg.lead) return 128;
    const j = (i - r.cfg.lead) % 256;
    return r.cfg.voices >= 2
      ? mixTwo(r.samples[j], LEVELS-1, r.samples[256+j], LEVELS-1, LEVELS-1)
      : mixOne(r.samples[j], LEVELS-1, LEVELS-1);
  };
  // An explicit negative test exercises the CLI exit status, not just a helper.
  if (argv.includes("--inject-value-error") && log.dac.length) log.dac.at(-1).value ^= 1;
  const a = analyzeProbe(log, r.cfg, expected);
  const result = { name: c.name, informational: !!c.informational && !STRICT, errors: a.errors };
  results.push(result);
  const measuredSeconds = a.span / MCLK;
  let landing = null;
  // The verdict is printed once EVERY check has run. It used to be printed
  // from the DAC analysis alone, so a case with a broken payload and a clean
  // clock announced itself as "ok" and only the summary disagreed.
  const out = [];
  // Every console.log BELOW this line is buffered and flushed at the end of the
  // case, so that the verdict can be printed first. Anything above it — the
  // build-failure path — has to say `globalThis.console`.
  const console = { log: (...s) => out.push(s.join("")) };
  console.log(`  inside ±5% ${(100*a.inside5).toFixed(4)}%, ±10% ${(100*a.inside10).toFixed(4)}%;`
    + ` holes ${a.holes.length} (${a.overlapping.length} overlap BUSREQ); values ${a.firstBad < 0 ? "all match" : "FAIL"}`);
  const steady = log.grabs.filter(([t]) => t >= a.samples[0]?.time && t <= a.samples.at(-1)?.time);
  const beforeOutput = log.grabs.filter(([t]) => t < log.dac[0]?.time).length;
  console.log(`  requests: ${beforeOutput} before first DAC, ${log.grabs.length-beforeOutput-steady.length} outside measurement, ${steady.length} measured`);
  const times = (pairs) => pairs.filter(([t]) => t >= a.samples[0]?.time && t <= a.samples.at(-1)?.time)
    .map(([x,y]) => (y-x)/Z80_DIV).sort((x,y) => x-y);
  for (const [name, pairs] of [["request→release",log.grabs],["modeled stop→resume",log.stops]]) {
    const lens = times(pairs);
    if (lens.length) console.log(`  ${name}: ${lens[0].toFixed(2)}..${lens.at(-1).toFixed(2)} Z80 cyc, p50 ${q(lens,.5).toFixed(2)}; sum ${lens.reduce((x,y)=>x+y,0).toFixed(1)}`);
  }
  // THE HOST'S OWN TIMELINE. Only present when the ROM was built with marks,
  // and it is a different ROM when it was.
  if (c.grab?.marks || c.calibrate || c.grab?.hv) {
    const host = analyzeHost(log, { marks: !!c.grab?.marks, calibrate: !!c.calibrate });
    result.host = host;
    if (host.entryDelay) console.log(`  hint→handler entry: ${host.entryDelay.min.toFixed(0)}`
      + `..${host.entryDelay.max.toFixed(0)} 68000 cyc, p50 ${host.entryDelay.p50.toFixed(0)};`
      + ` ${host.hints} raised, ${host.serviced} timed, ${host.missedHints} lost,`
      + ` ${host.ambiguousEntries} ambiguous`);
    if (host.hv) console.log(`  HV at entry: ${host.hv.readings} readings, ${host.hv.distinctH}`
      + ` distinct H; widest observed spread of times within one H value`
      + ` ${host.hv.widestObservedSpreadMaster} master — an observation about these`
      + ` conditions, not a decoder's error bound`);
    if (host.cal) {
      const f = (v) => v === null ? "?" : v.toFixed(1);
      console.log(`  instruction time (68000 cycles): mark ${f(host.cal.markCycles)},`
        + ` nop ${f(host.cal.nop)}, divu/7 ${f(host.cal.divu)},`
        + ` divu overflow ${f(host.cal.divuOverflow)}, divu/$7FFF ${f(host.cal.divuBig)}`);
      // The load has to be a LONG instruction. An overflowing divide is not.
      if (host.cal.divu !== null && host.cal.divu < 100) result.errors.push("divide load is not the long path");
    }
  }
  // TRANSFERS: the same payload, order, count, commit and carry-over checks in
  // every mode (§12.2 B). Only the acceptance criterion differs.
  if (c.grab && !c.grab.disabled) {
    const windows = (c.grab.cooperative || c.grab.hint) ? windowGenerations(log) : null;
    // The diagnostic payload is the handler's own state: order and count are
    // still predictable, the content is not.
    const source = c.grab.debugPayload ? null : r.samples;
    const transfer = analyzeTransfers(log, steady, c.grab, source, { windows });
    result.errors.push(...transfer.errors);
    landing = transfer.landing;
    // What the Z80 DID, from the slot's own length — the estimate above is
    // checked against it rather than believed.
    const adopted = windows?.band && c.cooperative
      ? analyzeAdoption(log, windows, r.cfg, c.cooperative.compensation) : null;
    if (adopted) {
      console.log(`  adoption, measured from the window slot's length:`
        + ` ${adopted.served} served, ${adopted.absent} absent, ${adopted.unclear} neither;`
        + ` repaid without a stall ${adopted.repaidUnstalled},`
        + ` stalled without repayment ${adopted.stalledUnrepaid}`);
      // Both halves of the same contract, and both are OBSERVED: a slot that
      // repaid a stall it did not have ran short by the compensation, and a
      // slot that was stalled without repaying ran long by the hold. Each is a
      // DAC interval violation as well, which is where they show up in §6.
      if (adopted.repaidUnstalled) result.errors.push("a window repaid a stall it did not have");
      if (adopted.stalledUnrepaid) result.errors.push("a window was stalled without repaying it");
      if (adopted.unclear) result.errors.push("window slot length matches neither branch");
    }
    // Does the residual accumulate? Reported as a series, not as a model.
    const resid = c.cooperative && transfer.landing.length > 1
      ? analyzeResidual(transfer.landing, c.cooperative.compensation) : null;
    if (resid) {
      console.log(`  residual hold-compensation over ${resid.n}: mean ${resid.mean.toFixed(4)},`
        + ` sd ${resid.sd.toFixed(3)}; cumulative ${resid.cumulative.min.toFixed(2)}`
        + `..${resid.cumulative.max.toFixed(2)}, ending ${resid.cumulative.final.toFixed(2)} Z80 cyc`);
      console.log(`  autocorrelation ${resid.auto.map((a)=>`lag${a.lag} ${a.rho.toFixed(3)}`).join(", ")}`
        + (resid.blocks.length ? `; block sum sd ${resid.blocks.map((b)=>
          `L=${b.length} ${b.sd.toFixed(2)} (walk would be ${b.randomWalkSd.toFixed(2)})`).join(", ")}` : ""));
    }
    result.residual = resid;
    result.transfer = { requests: steady.length, inside: transfer.inside,
      insideLoose: transfer.insideLoose, outside: transfer.outside,
      carried: transfer.carried, own: transfer.own, undecided: transfer.undecided,
      unread: transfer.unread, adoption: adopted && { served: adopted.served,
        absent: adopted.absent, unclear: adopted.unclear,
        repaidUnstalled: adopted.repaidUnstalled, stalledUnrepaid: adopted.stalledUnrepaid } };
    if (windows && !windows.band) {
      console.log(`  windows: ${windows.quiet} unstalled of ${log.notifications.length/2 | 0};`
        + ` no usable geometry${windows.impossible ? " (span does not match the emitted code)"
          : windows.disagree ? " (stall-corrected and unstalled spans disagree)" : ""}`);
      result.errors.push("window geometry");
    }
    if (windows?.band) {
      console.log(`  windows: ${windows.gens.length} generations, notify span ${windows.span} Z80 cyc`
        + ` (${windows.quiet} needed no stall correction) → bank write ${windows.band.bankWait},`
        + ` open +${windows.band.openMin}..+${windows.band.openMax},`
        + ` grant window ${windows.band.windowCycles} cyc, quiet-span spread ${windows.spanSpread}`);
      const total = transfer.inside + transfer.insideLoose + transfer.outside;
      console.log(`  landing: ${transfer.inside} stops strictly inside, ${transfer.insideLoose} within the`
        + ` unknown-offset band, ${transfer.outside} outside`
        + ` (${(100*(transfer.inside+transfer.insideLoose)/Math.max(1,total)).toFixed(1)}% of ${total});`
        + ` commits: ${transfer.own} read by their own window, ${transfer.carried} carried over,`
        + ` ${transfer.undecided} undecidable from the timestamps, ${transfer.unread} unread`);
      if (transfer.landing.length) {
        const req = transfer.landing.map((l) => l.request).sort((a,b)=>a-b);
        console.log(`  request offset from the earliest opening: p10 ${q(req,.1)?.toFixed(0)}`
          + ` p50 ${q(req,.5)?.toFixed(0)} p90 ${q(req,.9)?.toFixed(0)} Z80 cyc`);
      }
      // A candidate transfer has to land in the window it aimed at. This is a
      // TIMING verdict, so an exploratory case reports it and a --strict run
      // fails on it; a payload or commit fault is fatal either way.
      if (total && transfer.outside) result.errors.push("window landing");
    }
    if (!c.grab.hint) {
      const bins = new Set();
      let j=0;
      for (const [at] of steady) {
        while (j+1 < log.dac.length && log.dac[j+1].time <= at) j++;
        bins.add(Math.min(31,Math.floor(32*(at-log.dac[j].time)/r.cfg.periodNum)));
      }
      result.phaseBins = [...bins].sort((a,b)=>a-b);
      console.log(`  ${(steady.length/measuredSeconds).toFixed(2)} requests/s,`
        + ` ${(steady.length*c.grab.bytes/measuredSeconds).toFixed(2)} B/s; request phase ${bins.size}/32 bins`);
    } else {
      console.log(`  ${(steady.length/measuredSeconds).toFixed(2)} requests/s,`
        + ` ${(steady.length*c.grab.bytes/measuredSeconds).toFixed(2)} B/s`);
    }
    if (c.grab.cooperative && transfer.delays.length) {
      const ds = transfer.delays;
      console.log(`  notification→request ${Math.min(...ds).toFixed(2)}..${Math.max(...ds).toFixed(2)} Z80 cyc;`
        + ` masked polling ${(100*transfer.polling.reduce((a,b)=>a+b,0)/a.span).toFixed(2)}% of wall time`);
      Object.assign(result.transfer, { delayMin: Math.min(...ds), delayMax: Math.max(...ds),
        maskedPollingPct: 100*transfer.polling.reduce((a,b)=>a+b,0)/a.span });
    }
  }
  console.log(`  ${result.errors.length ? result.errors.join("; ") : "criteria pass"}`);
  globalThis.console.log(`${result.errors.length ? (c.informational ? "info FAIL" : "FAIL") : "ok"} ${c.name}`
    + `: ${a.samples.length} samples, ${a.rate.toFixed(2)} Hz (${a.errorPct.toFixed(4)}%),`
    + ` gap ${a.sorted[0]}..${a.sorted.at(-1)} master`);
  if (c.everyFamily) {
    const st = times(log.stops);
    everyRows.push({ family: c.everyFamily, every: c.grab.every, errorPct: a.errorPct,
      stopP50: st.length ? q(st, .5) : NaN, stopMin: st[0], stopMax: st.at(-1),
      max: a.sorted.at(-1), pass: !result.errors.length });
  }
  console.log(`  rom ${r.sha} · ${stampLine(r.cfg)} `);
  for (const line of out) globalThis.console.log(line);
  writeFileSync(r.log.replace(/\.log$/, ".json"), JSON.stringify({
    ...result, case: r.resolved, cli: { compensation: COMP, captureOffset: CAPOFF, fault: FAULT,
      marks: MARKS, strict: STRICT }, cfg: r.cfg, rom: r.sha, coreHash, seconds: SECONDS,
    rate: a.rate, errorPct: a.errorPct, intervalMin: a.sorted[0], intervalMax: a.sorted.at(-1),
    inside5: a.inside5, inside10: a.inside10, holes: a.holes.length,
    requests: steady.length, requestsPerSecond: steady.length/measuredSeconds,
    requestCycles: times(log.grabs), stopCycles: times(log.stops), landing,
  }, null, 2));
}
if (argv.includes("--phase-sweep")) {
  for (const family of new Set(selected.map(c=>c.phaseFamily))) {
    const bins=new Set(results.filter(r=>r.name.startsWith(family+" phase ")).flatMap(r=>r.phaseBins));
    console.log(`${family}: aggregate request phase ${bins.size}/32 bins`);
    if (bins.size !== 32) results.push({name:family,errors:["incomplete request phase sweep"]});
  }
}
if (everyRows.length) {
  for (const family of new Set(everyRows.map((r) => r.family))) {
    const rows = everyRows.filter((r) => r.family === family);
    const errs = rows.map((r) => r.errorPct);
    console.log(`\n${family}: ${rows.length} host phases, mean-rate error`
      + ` ${Math.min(...errs).toFixed(4)}%..${Math.max(...errs).toFixed(4)}%,`
      + ` ${rows.filter((r) => !r.pass).length} fail criteria`);
    for (const r of rows) console.log(`  every ${String(r.every).padStart(5)}  ${r.errorPct.toFixed(4).padStart(8)}%`
      + `  stop ${r.stopMin?.toFixed(1)}..${r.stopMax?.toFixed(1)} p50 ${r.stopP50?.toFixed(1)}  max gap ${r.max}  ${r.pass ? "ok" : "FAIL"}`);
  }
}
const summary = summarizeResults(results);
console.log(`\n${summary.text}`);
process.exit(summary.exitCode);
