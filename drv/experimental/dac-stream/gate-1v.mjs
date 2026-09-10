// THE ONE-VOICE PROFILE'S GATE, in the JS instruction model (R28 §63.6 step 1).
//
//   node experimental/dac-stream/gate-1v.mjs [--seconds N] [--case NAME] [--split]
//
// The two-voice gate's reference is a fixed 256-byte page read for ever; this
// profile plays SAMPLES — a 16-bit pointer through the window, a 2^k step, an
// end it parks at, starts and stops the host stages between blocks — so the
// reference is a block-level state machine written from §63.3 D2 and nothing
// else. It does not read the engine's state; it reads the host's pokes and the
// DAC's own timestamps, and predicts every byte.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../tools/z80asm.mjs";
import { buildConfig, stampLine, PCM1, pcm1Base } from "./config.mjs";
import { generate, codeLedger, pcmEdgeCost } from "./gen-stream.mjs";
import { generateSplit } from "./decode-split.mjs";
import { Machine, traceMeta } from "./machine.mjs";
import { analyzeValue, analyzeTime, analyzeWrites, analyzeLead, analyzeDacEnable } from "./analyze.mjs";
import { tablesAgree } from "./lut.mjs";
import { BANK, hostScript, reference, syntheticH } from "./pcm1-ref.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "out", "dac-stream");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 4));
const ONLY = arg("case", null);
const SPLIT = argv.includes("--split");

const LIMITS = { rateErrPct: 0.1, within5pct: 99.9, bandMin: 0.90, bandMax: 1.10, holePeriods: 1.5 };

const CASES = [
  { name: "1v idle — parked from boot", host: "idle" },
  { name: "1v one shot, step 1", host: "shot" },
  { name: "1v steps 1, 2, 4, 8", host: "steps" },
  { name: "1v stop mid-sample, restart", host: "stop" },
  { name: "1v restart over a running voice", host: "restart" },
  { name: "1v forty-byte samples", host: "short" },
  { name: "1v a drum roll, every third block", host: "roll" },
  { name: "1v levels and master, opposed, over a sample", host: "levels" },
  { name: "1v shot + CSM", host: "shot", cfg: { csm: true } },
  { name: "1v roll + CSM", host: "roll", cfg: { csm: true } },
];

const base = { voices: 1, complete: true, levels: 15, workTarget: 0.839, correctorBudget: true };

function build(c) {
  const cfg = buildConfig({ ...base, ...(c.cfg ?? {}) });
  let gen;
  if (SPLIT) {
    const r = generateSplit(cfg, { stackFill: true, correct: true, proto: true });
    if (!r.ok) throw new Error(`split did not place: ${r.stage} ${r.error ?? r.walk?.failed?.name ?? ""}`);
    gen = r.gen;
  } else gen = generate(cfg);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `stream1v-${cfg.stamp}${SPLIT ? "-split" : ""}.z80`);
  writeFileSync(path, gen.text);
  return { cfg, gen, built: assemble(path), path };
}

function runCase(c, seconds) {
  const { cfg, gen, built, path } = build(c);
  const cycles = Math.round(seconds * cfg.z80Hz);
  const script = hostScript(c.host, cfg, cycles);
  const watch = [pcm1Base(cfg) + PCM1.level, pcm1Base(cfg) + PCM1.master];
  // The split image reads the VDP's H counter: the machine answers with a
  // synthetic one that follows the line clock, so the corrector stays quiet.
  const m = new Machine(cfg, built, { rom: BANK, pokes: [], watch, vdp: SPLIT ? syntheticH() : null });
  m.trace.meta = traceMeta(cfg, { case: c.name, seconds, source: path });
  // The host script is written in slots from the FIRST DAC write, not from
  // reset: the two images boot for different lengths, and a poke placed from
  // cycle 0 lands in a different block position in each.
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  const pokes = script.pokes.map((p) => ({ ...p, at: p.at + dac0 }));
  const events = script.events.map((e) => ({ ...e, at: e.at + dac0 }));
  m.pokes = [...pokes].sort((a, b) => a.at - b.at);
  m.run(cycles);
  const lutPage = cfg.ram.lut[0] >> 8;
  const edges = [];
  for (let i = 0; i + 1 < m.trace.globRead.length; i += 2) {
    const r = m.trace.globRead.slice(i, i + 2).map((x) => x[2] - lutPage);
    edges.push({ cycle: m.trace.globRead[i][0], v0: r[0], master: r[1] });
  }
  // No poke may land in an edge slot — the runner's own promise, checked.
  const dac = m.trace.dacCycle;
  const B = cfg.blockSamples;
  for (const p of pokes) {
    let s = 0; while (s + 1 < dac.length && dac[s + 1] <= p.at) s++;
    const b = (s + cfg.lead) % B;
    if (b >= B - 3 || b === 0) throw new Error(`a poke at ${p.at} landed in edge slot b${b}`);
  }
  const ref = reference(cfg, BANK, events, dac, edges);
  const value = analyzeValue(m.trace, ref);
  const time = analyzeTime(m.trace, cfg);
  const writes = analyzeWrites(m.trace, cfg);
  const lead = analyzeLead(m.trace, cfg, [built.symbols.get("mix_one"), built.symbols.get("code_end")]);
  const dacen = analyzeDacEnable(m.trace, cfg, m.cycles);
  const fails = [];
  if (value.problems.length) fails.push(...value.problems.map((p) => `VALUE ${p}`));
  if (lead?.problems.length) fails.push(...lead.problems.slice(0, 3).map((p) => `LEAD ${p}`));
  for (const p of tablesAgree(cfg.levels).slice(0, 2)) fails.push(`TABLE ${p}`);
  if (m.trace.stray.length) fails.push(`STRAY ${m.trace.stray.length} writes outside every device (first ${JSON.stringify(m.trace.stray[0])})`);
  // The level edges must land in the slot that builds a block's last sample.
  {
    const first = (B - 1 - cfg.lead % B + B) % B;
    let misplaced = 0;
    for (let k = 0; k < edges.length; k++) {
      const slot = first + k * B, lo = dac[slot], hi = dac[slot + 1];
      if (lo === undefined || hi === undefined) break;
      if (!(edges[k].cycle > lo && edges[k].cycle < hi)) misplaced++;
    }
    if (misplaced) fails.push(`VALUE ${misplaced} of ${edges.length} block edges did not land in the last slot of their block`);
  }
  if (writes.problems.length) fails.push(...writes.problems.slice(0, 3).map((p) => `WRITE ${p}`));
  if (Math.abs(time.rateErrPct) > LIMITS.rateErrPct) fails.push(`TIME mean rate ${time.meanRateHz} Hz is ${time.rateErrPct}% off`);
  if (time.within5pct < LIMITS.within5pct) fails.push(`TIME ${time.within5pct}% inside 0.95T..1.05T`);
  if (time.gapMin < cfg.periodCycles * LIMITS.bandMin || time.gapMax > cfg.periodCycles * LIMITS.bandMax)
    fails.push(`TIME interval range ${time.gapMin}..${time.gapMax}`);
  if (time.holes.length) fails.push(`TIME ${time.holes.length} hole(s)`);
  if (dacen.length !== 1) fails.push(`the DAC was enabled ${dacen.length} times`);
  return { c, cfg, gen, value, time, fails, events, codeBytes: built.symbols.get("code_end"), lead };
}

const pad = (s, n) => String(s).padEnd(n);
let failed = 0, ran = 0;
for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const r = runCase(c, SECONDS);
  ran++;
  if (r.fails.length) failed++;
  console.log(`${r.fails.length ? "FAIL" : "ok  "}  ${pad(c.name, 46)} ${r.time.n} samples · ${r.time.meanRateHz} Hz`
    + ` (${r.time.rateErrPct >= 0 ? "+" : ""}${r.time.rateErrPct}%) · gap ${r.time.gapMin}..${r.time.gapMax}`
    + ` · ${r.events.length} host events · ${r.value.compared ?? ""}`);
  for (const f of r.fails.slice(0, 6)) console.log(`      ! ${f}`);
}
{
  const cfg = buildConfig({ ...base, csm: true });
  const gen = generate(cfg);
  const led = codeLedger(cfg, gen, gen.slots ? 0 : 0);
  console.log(`\nedge pieces: ${JSON.stringify(pcmEdgeCost(cfg))} cycles;`
    + ` worst slot ${gen.placement.worst.slot} at ${gen.placement.worst.workPct}%, mean ${gen.placement.meanWorkPct}%`
    + ` — ${stampLine(cfg)}`);
  void led;
}
console.log(`\n${failed ? `FAIL: ${failed} of ${ran} cases` : `${ran} cases pass`} · ${SECONDS}s each${SPLIT ? " (split image)" : ""}`);
process.exit(failed ? 1 : 0);
