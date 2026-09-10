// THE PAIR TRANSPORT'S GATE, in the JS instruction model (R28 §63.6 step 2).
//
//   node experimental/dac-stream/gate-fifo.mjs [--seconds N] [--case NAME] [--split]
//
// A host that runs the producer algorithm of pair-host.mjs twice a frame, an
// engine that consumes sixteen pairs a lap through the expander, and three
// judgements: every FM register write the chip saw is the stream's, per port and
// in order, with nothing else; every DAC byte matches the one-voice reference
// driven by the starts, stops and levels the ENGINE stored (its own writes to
// the state block, not the host's intentions); and the clock did not move.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../tools/z80asm.mjs";
import { buildConfig, stampLine, PCM1, PCM1_OPS, pcm1Base } from "./config.mjs";
import { generate } from "./gen-stream.mjs";
import { generateSplit } from "./decode-split.mjs";
import { Machine, traceMeta } from "./machine.mjs";
import { analyzeValue, analyzeTime, analyzeWrites, analyzeLead, analyzeDacEnable } from "./analyze.mjs";
import { BANK, SAMPLES, reference, syntheticH } from "./pcm1-ref.mjs";
import { makeProducer, pairStream } from "./pair-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "out", "dac-stream");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 3));
const ONLY = arg("case", null);
const SPLIT = argv.includes("--split");
const LIMITS = { rateErrPct: 0.1, within5pct: 99.9, bandMin: 0.90, bandMax: 1.10 };

const CASES = [
  { name: "fifo idle — nothing sent", kind: "idle" },
  { name: "fifo raw writes, both ports", kind: "raw" },
  { name: "fifo pitch pairs + key, both ports", kind: "pitch" },
  { name: "fifo dense — every grab full", kind: "dense" },
  { name: "fifo PCM: start, level, master, stop, restart, steps", kind: "pcm" },
  { name: "fifo drum roll + pitch + key", kind: "roll" },
  { name: "fifo pitch pairs + CSM", kind: "pitch", cfg: { csm: true } },
  { name: "fifo PCM + CSM", kind: "pcm", cfg: { csm: true } },
];

const base = { voices: 1, complete: true, levels: 15, workTarget: 0.839, correctorBudget: true };

function build(c) {
  const cfg = buildConfig({ ...base, ...(c.cfg ?? {}) });
  let gen;
  if (SPLIT) {
    const r = generateSplit(cfg, { stackFill: true, correct: true, proto: true });
    if (!r.ok) throw new Error(`split did not place: ${r.stage}`);
    gen = r.gen;
  } else gen = generate(cfg);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `fifo-${cfg.stamp}${SPLIT ? "-split" : ""}.z80`);
  writeFileSync(path, gen.text);
  return { cfg, gen, built: assemble(path), path };
}

function runCase(c, seconds) {
  const { cfg, gen, built, path } = build(c);
  const cycles = Math.round(seconds * cfg.z80Hz);
  const S = (k) => pcm1Base(cfg) + PCM1[k];
  const watch = ["level", "master", "stSrc", "stEnd", "stStep", "startGen", "stopGen"]
    .flatMap((k) => (k === "stSrc" || k === "stEnd" ? [S(k), S(k) + 1] : [S(k)]));
  const producer = makeProducer(cfg);
  const m = new Machine(cfg, built, { rom: BANK, watch, vdp: SPLIT ? syntheticH() : null });
  m.trace.meta = traceMeta(cfg, { case: c.name, seconds, source: path });
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  for (const item of pairStream(c.kind, cfg, cycles)) producer.push({ ...item, at: item.at + dac0 });
  // Two grabs a frame (§63.3 D6): the host reads the index and writes ahead.
  m.host = { every: Math.round(cfg.frameCycles / 2), fn: (ram, cycle) => producer.grab(cycle, ram[S("fifoLo")]) };
  m.hostNext = dac0 + Math.round(cfg.frameCycles / 4);
  m.run(cycles);

  // ── the FM writes the chip saw, per port, against the stream ─────────
  const CSM = new Set([0xac, 0xa8]);
  const seen = [[], []];
  for (const [cycle, port, reg, val] of m.trace.ym)
    if (cycle >= dac0 && !(port === 0 && CSM.has(reg))) seen[port].push({ reg, val, cycle });
  const want = [[], []];
  let port = 0;
  for (const w of producer.log) {
    if (w.op === PCM1_OPS.PORT) { port = w.val; continue; }
    if (w.op >= 0x22) want[port].push({ reg: w.op, val: w.val, cycle: w.cycle });
  }
  const fails = [];
  for (const p of [0, 1]) {
    // What was written after the last grab may still be in the queue; compare
    // the prefix the run had time to consume, and require it to be nearly all.
    const n = seen[p].length;
    if (n > want[p].length) fails.push(`WRITES port ${p}: the chip saw ${n} writes, the stream had ${want[p].length}`);
    for (let i = 0; i < Math.min(n, want[p].length); i++) {
      const a = seen[p][i], b = want[p][i];
      if (a.reg !== b.reg || a.val !== b.val) {
        fails.push(`WRITES port ${p}, write ${i}: chip saw $${a.reg.toString(16)}=$${a.val.toString(16)},`
          + ` the stream says $${b.reg.toString(16)}=$${b.val.toString(16)}`);
        break;
      }
      if (a.cycle < b.cycle) { fails.push(`WRITES port ${p}, write ${i}: executed before it was written`); break; }
    }
    if (want[p].length - n > 16 * 3 && c.kind !== "dense")
      fails.push(`WRITES port ${p}: ${want[p].length - n} of the stream's writes never reached the chip`);
  }
  // ── the DAC, against the reference driven by what the engine STORED ───
  const events = [];
  const st = { src: 0, end: 0, step: 1, sgen: 0, pgen: 0 };
  for (const [cycle, addr, val] of m.trace.globWrite) {
    const off = addr - pcm1Base(cfg);
    if (off === PCM1.stSrc) st.src = (st.src & 0xff00) | val;
    else if (off === PCM1.stSrc + 1) st.src = (st.src & 0xff) | (val << 8);
    else if (off === PCM1.stEnd) st.end = (st.end & 0xff00) | val;
    else if (off === PCM1.stEnd + 1) st.end = (st.end & 0xff) | (val << 8);
    else if (off === PCM1.stStep) st.step = val;
    else if (off === PCM1.startGen && val !== st.sgen) {
      st.sgen = val; events.push({ kind: "start", at: cycle, src: st.src, end: st.end, step: st.step, seq: events.length });
    } else if (off === PCM1.stopGen && val !== st.pgen) {
      st.pgen = val; events.push({ kind: "stop", at: cycle, seq: events.length });
    }
  }
  const lutPage = cfg.ram.lut[0] >> 8;
  const edges = [];
  const reads = m.trace.globRead.filter(([, a]) => a === S("level") || a === S("master"));
  for (let i = 0; i + 1 < reads.length; i += 2)
    edges.push({ cycle: reads[i][0], v0: reads[i][2] - lutPage, master: reads[i + 1][2] - lutPage });
  const ref = reference(cfg, BANK, events, m.trace.dacCycle, edges);
  const value = analyzeValue(m.trace, ref);
  const time = analyzeTime(m.trace, cfg);
  const writes = analyzeWrites(m.trace, cfg);
  const lead = analyzeLead(m.trace, cfg, [built.symbols.get("mix_one"), built.symbols.get("xp_a")]);
  const dacen = analyzeDacEnable(m.trace, cfg, m.cycles);
  if (value.problems.length) fails.push(...value.problems.map((p) => `VALUE ${p}`));
  if (lead?.problems.length) fails.push(...lead.problems.slice(0, 3).map((p) => `LEAD ${p}`));
  if (writes.problems.length) fails.push(...writes.problems.slice(0, 3).map((p) => `SETTLE ${p}`));
  if (Math.abs(time.rateErrPct) > LIMITS.rateErrPct) fails.push(`TIME mean rate ${time.meanRateHz} Hz is ${time.rateErrPct}% off`);
  if (time.within5pct < LIMITS.within5pct) fails.push(`TIME ${time.within5pct}% inside 0.95T..1.05T`);
  if (time.gapMin < cfg.periodCycles * LIMITS.bandMin || time.gapMax > cfg.periodCycles * LIMITS.bandMax)
    fails.push(`TIME interval range ${time.gapMin}..${time.gapMax}`);
  if (time.holes.length) fails.push(`TIME ${time.holes.length} hole(s)`);
  if (dacen.length !== 1) fails.push(`the DAC was enabled ${dacen.length} times`);
  if (m.trace.stray.length) fails.push(`STRAY ${m.trace.stray.length} writes outside every device`);
  return { c, cfg, gen, time, fails, seen, want, events, producer, value };
}

const pad = (s, n) => String(s).padEnd(n);
let failed = 0, ran = 0;
for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const r = runCase(c, SECONDS);
  ran++;
  if (r.fails.length) failed++;
  const s = r.producer.stats;
  console.log(`${r.fails.length ? "FAIL" : "ok  "}  ${pad(c.name, 50)} ${r.time.n} smp · ${r.time.meanRateHz} Hz`
    + ` (${r.time.rateErrPct >= 0 ? "+" : ""}${r.time.rateErrPct}%) · gap ${r.time.gapMin}..${r.time.gapMax}`
    + ` · chip ${r.seen[0].length}+${r.seen[1].length} of ${r.want[0].length}+${r.want[1].length}`
    + ` · ${s.grabs} grabs, ${s.written} pairs, ${s.resets} resets · ${r.events.length} PCM events`);
  for (const f of r.fails.slice(0, 6)) console.log(`      ! ${f}`);
}
{
  const cfg = buildConfig({ ...base, csm: true });
  const gen = generate(cfg);
  console.log(`\nexpander: A ${gen.expander.aCycles} cyc, B ${gen.expander.bCycles} cyc, arms ${JSON.stringify(gen.expander.arms)};`
    + ` worst slot ${gen.placement.worst.slot} at ${gen.placement.worst.workPct}%, mean ${gen.placement.meanWorkPct}% — ${stampLine(cfg)}`);
}
console.log(`\n${failed ? `FAIL: ${failed} of ${ran} cases` : `${ran} cases pass`} · ${SECONDS}s each${SPLIT ? " (split image)" : ""}`);
process.exit(failed ? 1 : 0);
