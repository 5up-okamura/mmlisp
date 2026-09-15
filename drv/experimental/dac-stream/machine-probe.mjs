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
import { COOP } from "../../tools/cooperative.mjs";
import { createHash } from "node:crypto";
import { readProbe, analyzeProbe, analyzeTransfers, analyzeHost, windowGenerations,
  analyzeAdoption, analyzeResidual, analyzeZ80Hv, faultMarks,
  summarizeResults, Z80_DIV } from "../../tools/probe-analysis.mjs";
import { resolveCase, buildCase, FAULTS, DBRA_MASTER } from "./case-config.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../tools/z80asm.mjs";
import { stampLine } from "../../engine/config.mjs";
import { buildRom } from "./rom.mjs";
import { mixOne, mixTwo } from "../../engine/lut.mjs";
import { checkWriterTrace, YM_BUSY_MASTER } from "../../engine/ym-writer.mjs";
import { BANK as PCM1_BANK, SAMPLES as PCM1_SAMPLES, endFor as pcm1EndFor, reference as pcm1Reference } from "../../engine/pcm1-ref.mjs";
import { expectedWrites } from "../../engine/pair-host.mjs";
import { PCM1, PCM1_BASE_OFF } from "../../engine/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const OUT = join(drv, "out", "dac-stream");
// MMLISP_BLASTEM points at another built core. It exists so a result can be
// produced from a CLEAN rebuild rather than from the working copy that has
// been patched by hand over several sessions (R9 §26.2).
const BLAST = process.env.MMLISP_BLASTEM || join(drv, "out", "blastem");
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
// What the core WAS BUILT FROM, written by setup.sh. A result that names only
// a hash cannot be traced back to a revision and a patch (R9 §26.2).
let build = null;
try { build = JSON.parse(readFileSync(join(BLAST, "build.json"), "utf8")); } catch { /* older tree */ }

import { CASES, sine } from "./cases.mjs";

const MCLK = 53693175;

function runCase(c0) {
  // ONE resolved configuration, from here to the JSON (§12.3): the overrides
  // are applied once, and the case object that is generated, run, analyzed and
  // recorded is the same object. buildCase() is shared with decoder-eval, so
  // the rom a tool predicts for a case is the rom the runner builds.
  const b = buildCase(c0, { outDir: OUT, compensation: COMP, captureOffset: CAPOFF,
    fault: FAULT, marks: MARKS });
  const log = join(OUT, `probe-${b.cfg.stamp}-${b.caseId}-${b.sha}-${coreHash.slice(0,8)}-${SECONDS}s${argv.includes("--inject-value-error") ? "-mutant" : ""}.log`);
  rmSync(log, { force: true });
  const frames = Math.round(SECONDS * 60);
  execFileSync(host, ["--core", core, "--rom", b.rpath, "--frames", String(frames),
    "--wav", log.replace(/\.log$/, ".wav")],
    { env: { ...process.env, MMLISP_PROBE_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });
  return { cfg: b.cfg, gen: b.gen, sha: b.sha, log, rpath: b.rpath,
    image: b.image, samples: b.samples, resolved: b.resolved };
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
// `--required-only` runs the cases that are meant to pass and nothing else, so
// there is a machine gate that exits 0 (R11 §31.3, §31.4 step 4). It ADDS a
// mode; the full run still reports every case and still exits 1 on the known
// informational failures, which are not to be quietly reclassified.
const REQUIRED_ONLY = argv.includes("--required-only");
// The conflict-position repetitions are the same image from another starting
// phase, and there are twelve of them (R22 §52.4). They are off unless asked
// for, so the routine gate does not pay for them.
const CONFLICT = argv.includes("--conflict");
// …and the listening tour, which is 44 seconds of music and not a gate.
const LISTEN = argv.includes("--listen");
// …and the host-YM P1 experiments, which write the chip from the 68000.
const YM = argv.includes("--ym");
// …and the PSG P1 experiments, which write $C00011 from the 68000.
const PSG = argv.includes("--psg");
// …and the Z80 YM writer P1 images, which replace b11..b14's reserved pad with
// real instructions (R26 §59.3).
const WRITER = argv.includes("--writer");
const selected = CASES.filter((c) => (!ONLY || c.name.includes(ONLY))
  && (CONFLICT || !c.conflictOnly) && (LISTEN || !c.listenOnly) && (YM || !c.ymOnly) && (PSG || !c.psgOnly)
  && (WRITER || !c.writerOnly)
  // The access-width witness runs in the required gate too: its DAC numbers
  // are informational, its verdict is not (R20 §48.3 step 1).
  && (!REQUIRED_ONLY || !c.informational || c.widthWitness)
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
console.log(`machine-probe — BlastEm, ${SECONDS}s a case; timing = Z80 DAC bus writes`
  + (REQUIRED_ONLY ? " · REQUIRED CASES ONLY — the full run reports the informational ones too" : ""));
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
  const L = r.cfg.levels;
  // THE ONE-VOICE REFERENCE (R28 §63.6 step 1): the boot-staged start is one
  // event before time zero, and the block-level state machine of pcm1-ref.mjs
  // predicts every byte from it and the DAC's own timestamps.
  const pcm1Expected = c.pcm1 ? (() => {
    const b = c.pcm1.boot;
    const events = b ? [{ kind: "start", at: -1, seq: 0, src: PCM1_SAMPLES[b.sample].at,
      end: pcm1EndFor(PCM1_SAMPLES[b.sample], b.step), step: b.step }] : [];
    return pcm1Reference(r.cfg, PCM1_BANK, events, log.dac.map((d) => d.time), null);
  })() : null;
  const expected = (i) => {
    if (pcm1Expected) return pcm1Expected(i);
    if (!r.cfg.voices) return c.wave[i % 256];
    if (i < r.cfg.lead) return 128;
    const j = (i - r.cfg.lead) % 256;
    return r.cfg.voices >= 2
      ? mixTwo(r.samples[j], L-1, r.samples[256+j], L-1, L-1, L)
      : mixOne(r.samples[j], L-1, L-1, L);
  };
  // An explicit negative test exercises the CLI exit status, not just a helper.
  if (argv.includes("--inject-value-error") && log.dac.length) log.dac.at(-1).value ^= 1;
  const a = analyzeProbe(log, r.cfg, c.levelsMove ? null : expected);
  // AN EXCEPTION IS A FAILED RUN, whatever the PCM looks like. Every unused
  // vector lands on a routine that stamps this and halts, so a fault cannot
  // hide behind a clean two-second waveform any more.
  const faults = faultMarks(log);
  if (faults.length) a.errors.push("the 68000 took an exception"
    + ` (first at ${(faults[0].time / MCLK).toFixed(3)}s)`);
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
    + ` holes ${a.holes.length} (${a.overlapping.length} overlap BUSREQ);`
    + ` values ${c.levelsMove ? "not fixed — the mailbox moves them, graded by dac-stream:decoder"
      : a.firstBad < 0 ? "all match" : "FAIL"}`);
  // ── THE ACCESS WIDTH, READ BACK (R20 §48.3 step 1) ───────────────────
  // The only proto case whose verdict is not the DAC's. The host compares the
  // three constants behind the observation number against what boot put there
  // and stamps every reading; a word-wide read gives byte 3 the value of byte
  // 2, so `--fault wide-read` must land here with a non-zero bad count.
  if (c.widthWitness) {
    const stamps = (log.marks ?? []).filter((e) => e.value === 0x21 || e.value === 0x22);
    const ok = stamps.filter((e) => e.value === 0x21).length;
    const bad = stamps.length - ok;
    console.log(`  access width: ${ok} snapshots read back byte for byte, ${bad} that came`
      + ` back with a duplicated byte`);
    if (bad) result.errors.push(`${bad} of ${stamps.length} snapshot readings came back with`
      + " a duplicated byte — Z80 RAM was not read one byte at a time");
    if (ok < 100 * SECONDS) result.errors.push(`only ${ok} snapshot readings were checked for`
      + ` access width in ${SECONDS}s — the witness is not running`);
  }
  const steady = log.grabs.filter(([t]) => t >= a.samples[0]?.time && t <= a.samples.at(-1)?.time);
  const beforeOutput = log.grabs.filter(([t]) => t < log.dac[0]?.time).length;
  console.log(`  requests: ${beforeOutput} before first DAC, ${log.grabs.length-beforeOutput-steady.length} outside measurement, ${steady.length} measured`);
  // ── THE Z80 YM WRITER (R26 §59.4, §59.5) ─────────────────────────────
  // Reconstructed from the chip's side: every access the Z80 made, the address
  // latch tracked per part, and each data write attributed to the register that
  // was latched when it arrived. The DAC's own stream and the engine's CSM pair
  // come out of the same walk, so nothing has to be assumed about which write
  // was whose.
  if (c.ymWriter) {
    const from = a.samples[0]?.time ?? 0, to = a.samples.at(-1)?.time ?? Infinity;
    const w = checkWriterTrace(log, { entries: c.ymWriter.entries, from, to });
    const live = c.ymWriter.entries.filter((e) => e.port !== null).length;
    const laps = w.dac / r.cfg.cycleSlots;
    const want = Math.floor(laps * live);
    const secs = (to - from) / MCLK;
    console.log(`  YM writer: ${w.writes} register writes in ${secs.toFixed(2)}s`
      + ` (${(w.writes / secs).toFixed(1)}/s), ${w.matched} in the window's order`
      + ` from entry ${w.phase};`
      + ` DAC ${w.dac}, CSM ${w.csm}`);
    if (w.writes) console.log(`  …busy: ${w.busyBefore} master after the slot's DAC write,`
      + ` ${w.busyAfter} before the next (needs ${YM_BUSY_MASTER} either side);`
      + ` settling and both frequency latches: ${w.settle ? `${w.settle} PROBLEMS` : "clean"}`);
    // A count that is short by more than the lap in flight is a lost write.
    if (live && w.matched !== w.writes)
      result.errors.push(`${w.writes - w.matched} of ${w.writes} register writes did not`
        + " follow the window");
    if (Math.abs(w.writes - want) > live)
      result.errors.push(`the window says ${want} writes in ${laps.toFixed(1)} laps`
        + ` and the chip saw ${w.writes}`);
    for (const p of w.problems) result.errors.push(`YM writer: ${p}`);
    // §59.6: the YM is the Z80's and the PSG is the 68000's, checked by CPU.
    const host = log.ym68k.filter((e) => e.time >= from && e.time <= to).length;
    const z80psg = log.psgZ80.filter((e) => e.time >= from && e.time <= to).length;
    if (host) result.errors.push(`${host} YM accesses came from the 68000 while the engine ran`);
    if (z80psg) result.errors.push(`${z80psg} PSG writes came from the Z80`);
  }
  // ── THE PAIR TRANSPORT (R28 §63.6 step 2) ────────────────────────────
  // Two judgements from the instrument's own records: every FM data write the
  // Z80 made — attributed to the register its part had latched — is the
  // stream's, per port and in order, with the DAC and the CSM pair taken out;
  // and every DAC byte matches the one-voice reference driven by the engine's
  // own writes to its state block (the probe logs them), not by what the host
  // meant to send.
  if (c.pairsGate) {
    const groups = c.grab.pairs.groups;
    const want = expectedWrites(groups);
    const latch = [null, null];
    const seen = [[], []];
    const CSM = new Set([0xac, 0xa8]);
    const dac0 = log.dac[0]?.time ?? 0;
    for (const e of log.ymZ80) {
      if (e.read) continue;
      if (e.kind === "addr") { latch[e.part] = e.byte; continue; }
      const reg = latch[e.part];
      if (e.time < dac0 || reg === null) continue;
      if (e.part === 0 && (reg === 0x2a || CSM.has(reg))) continue;
      seen[e.part].push({ reg, val: e.byte, time: e.time });
    }
    for (const p of [0, 1]) {
      const n = seen[p].length;
      if (n > want[p].length) result.errors.push(`pairs: port ${p} saw ${n} writes, the stream has ${want[p].length}`);
      for (let i = 0; i < Math.min(n, want[p].length); i++) {
        const x = seen[p][i], y = want[p][i];
        if (x.reg !== y.reg || x.val !== y.val) {
          result.errors.push(`pairs: port ${p} write ${i} was $${x.reg.toString(16)}=$${x.val.toString(16)},`
            + ` the stream says $${y.reg.toString(16)}=$${y.val.toString(16)}`);
          break;
        }
      }
    }
    // The engine's state writes, as events for the reference.
    const events = [];
    const st = { src: 0, end: 0, step: 1, sgen: 0, pgen: 0 };
    const levelWrites = [], masterWrites = [];
    for (const w of log.ramWrites) {
      if (w.region !== "glob") continue;
      const off = w.addr - PCM1_BASE_OFF;
      if (off === PCM1.stSrc) st.src = (st.src & 0xff00) | w.value;
      else if (off === PCM1.stSrc + 1) st.src = (st.src & 0xff) | (w.value << 8);
      else if (off === PCM1.stEnd) st.end = (st.end & 0xff00) | w.value;
      else if (off === PCM1.stEnd + 1) st.end = (st.end & 0xff) | (w.value << 8);
      else if (off === PCM1.stStep) st.step = w.value;
      else if (off === PCM1.startGen && w.value !== st.sgen) {
        st.sgen = w.value; events.push({ kind: "start", at: w.time, src: st.src, end: st.end, step: st.step, seq: events.length });
      } else if (off === PCM1.stopGen && w.value !== st.pgen) {
        st.pgen = w.value; events.push({ kind: "stop", at: w.time, seq: events.length });
      } else if (off === PCM1.level) levelWrites.push(w);
      else if (off === PCM1.master) masterWrites.push(w);
    }
    // The level pages at each block edge: the last value written before the
    // edge's own slot (the STORE arm never runs in that slot).
    const B = r.cfg.blockSamples, lead = r.cfg.lead, lutPage = r.cfg.ram.lut[0] >> 8;
    const dacT = log.dac.map((d) => d.time);
    const edges = [];
    let li = 0, mi = 0, lv = lutPage + r.cfg.levels - 1, mv = lutPage + r.cfg.levels - 1;
    for (let K = 2; (B * K - lead - 1) < dacT.length; K++) {
      const t = dacT[B * K - lead - 1];
      while (li < levelWrites.length && levelWrites[li].time < t) lv = levelWrites[li++].value;
      while (mi < masterWrites.length && masterWrites[mi].time < t) mv = masterWrites[mi++].value;
      edges.push({ cycle: t, v0: lv - lutPage, master: mv - lutPage });
    }
    const ref = pcm1Reference(r.cfg, PCM1_BANK, events, dacT, edges);
    let bad = -1;
    for (let i = 0; i < log.dac.length; i++) if (log.dac[i].value !== ref(i)) { bad = i; break; }
    if (bad >= 0) result.errors.push(`pairs: DAC sample ${bad} was ${log.dac[bad].value}, the reference says ${ref(bad)}`);
    // Stops from the first DAC sample on: the boot upload holds the bus for
    // the whole image and is not a runtime grab.
    const stops = log.stops.filter(([x]) => x >= dac0).map(([x, y]) => y - x);
    const over = stops.filter((x) => x > 1500).length;
    console.log(`  pairs: chip saw ${seen[0].length}+${seen[1].length} FM writes of ${want[0].length}+${want[1].length}`
      + ` in the table; ${events.length} PCM events; ${log.grabs.length} grabs,`
      + ` stop ${stops.length ? Math.min(...stops) : 0}..${stops.length ? Math.max(...stops) : 0} master,`
      + ` ${over} over 1,500; DAC ${bad < 0 ? "all match the reference" : "MISMATCH"}`);
    if (over) result.errors.push(`pairs: ${over} bus stops longer than 1,500 master`);
    if (seen[0].length + seen[1].length === 0 && want[0].length + want[1].length > 0)
      result.errors.push("pairs: the chip saw no FM writes at all");
  }
  const times = (pairs) => pairs.filter(([t]) => t >= a.samples[0]?.time && t <= a.samples.at(-1)?.time)
    .map(([x,y]) => (y-x)/Z80_DIV).sort((x,y) => x-y);
  for (const [name, pairs] of [["request→release",log.grabs],["modeled stop→resume",log.stops]]) {
    const lens = times(pairs);
    if (lens.length) console.log(`  ${name}: ${lens[0].toFixed(2)}..${lens.at(-1).toFixed(2)} Z80 cyc, p50 ${q(lens,.5).toFixed(2)}; sum ${lens.reduce((x,y)=>x+y,0).toFixed(1)}`);
  }
  // THE HOST'S OWN TIMELINE. Only present when the ROM was built with marks,
  // and it is a different ROM when it was.
  if (c.grab?.marks || c.calibrate || c.grab?.hv || c.observer?.loadProbe) {
    const host = analyzeHost(log, { marks: !!c.grab?.marks, calibrate: !!c.calibrate });
    if (host.load) console.log(`  foreground load: ${host.load.ticks} ticks,`
      + ` ${host.load.iterationCycles.toFixed(1)} 68000 cycles an iteration`
      + ` (${host.load.min.toFixed(1)}..${host.load.max.toFixed(1)})`);
    // The load's TIME is a criterion, not a printout (R6 §17.2 C). A run that
    // stops stamping, or whose divide has become a short instruction, fails
    // here rather than passing on its PCM.
    // Driven by what the CASE declared, not by the resolved rom: a mutation
    // that switches the stamping off must fail the check, not disable it.
    if (c.observer?.loadProbe) {
      const expect = SECONDS * 7670453 / (256 * 576.4);   // marks a second at the measured cost
      if (!host.load) result.errors.push("the load loop reported no timing marks");
      else {
        if (host.load.ticks < 0.8 * expect)
          result.errors.push(`the load stamped ${host.load.ticks} times, expected about ${expect.toFixed(0)}`);
        if (host.load.iterationCycles < 500 || host.load.iterationCycles > 700)
          result.errors.push(`the load ran ${host.load.iterationCycles.toFixed(1)} cycles an iteration,`
            + ` outside the 500..700 a real divide takes`);
      }
    }
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
      // THE NUMBER THE TRANSFER PERIOD IS BUILT FROM (R20 §48.5). A DBRA
      // iteration is ten 68000 cycles, but what it is WORTH depends on what
      // else is on the bus, so the generator uses this measurement and this
      // check is what stops it drifting.
      if (host.cal.dbraMaster !== null) {
        const got = host.cal.dbraMaster;
        console.log(`  a DBRA iteration: ${got.toFixed(3)} master`
          + ` (${(got / 7).toFixed(2)} 68000 cycles); the period generator uses`
          + ` ${DBRA_MASTER.toFixed(3)}`);
        // Reported, not graded. This is a tight two-word loop with nothing else
        // running; the host's wait loop sits in a longer program and measures
        // 72.667 there, and the number the generator uses comes from THAT
        // environment (case-config's DBRA_MASTER). What grades the period is
        // the interval it actually produced, in dac-stream:decoder.
      }
      // The load has to be a LONG instruction. An overflowing divide is not.
      if (host.cal.divu !== null && host.cal.divu < 100) result.errors.push("divide load is not the long path");
    }
  }
  // THE PHASE OBSERVER: what the Z80 got when it read the VDP, and whether the
  // reading is coherent. Whether it could AFFORD the read is the DAC gate's
  // verdict above, not this one's.
  if (c.observer) {
    const hv = analyzeZ80Hv(log, r.cfg);
    result.z80hv = hv;
    if (!hv) result.errors.push("the Z80 read nothing from the VDP");
    else {
      for (const [p, s] of Object.entries(hv.ports))
        console.log(`  Z80 read $7f${Number(p).toString(16).padStart(2,"0")}:`
          + ` ${s.readings} readings, ${s.distinct} distinct values,`
          + ` widest observed spread of times within one value`
          + ` ${s.widestObservedSpreadMaster ?? "—"} master`);
      if (hv.pair) console.log(`  consecutive readings in a slot: ${hv.pair.n},`
        + ` ${hv.pair.gapMin}..${hv.pair.gapMax} Z80 cyc apart;`
        + ` same-port change ${hv.pair.sameportDeltaMin ?? "—"}..${hv.pair.sameportDeltaMax ?? "—"}`
        + ` (median ${hv.pair.sameportDeltaMedian ?? "—"})`);
    }
  }
  // TRANSFERS: the same payload, order, count, commit and carry-over checks in
  // every mode (§12.2 B). Only the acceptance criterion differs.
  if (c.grab && !c.grab.disabled && !c.grab.pairs) {
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
    ...result, build, case: r.resolved, cli: { compensation: COMP, captureOffset: CAPOFF, fault: FAULT,
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
