// P1 gate — the isolated test (docs/dac-engine-implementation.md §5/P1, §6).
//
//   node experimental/dac-stream/gate.mjs [--seconds N] [--case NAME] [--json]
//   node experimental/dac-stream/gate.mjs --long        # the 60 s case too
//
// Thresholds are §6.2's, fixed BEFORE the first measurement and not moved
// afterwards. A case that fails prints what failed and by how much; nothing
// here is allowed to pass on an average.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../tools/z80asm.mjs";
import { buildConfig, stampLine } from "./config.mjs";
import { generate, cyclePaths } from "./gen-stream.mjs";
import { Machine, traceMeta } from "./machine.mjs";
import {
  analyzeValue, analyzeTime, analyzeBus, analyzeWrites, analyzeTimerPhase, analyzeDacEnable,
} from "./analyze.mjs";
import { compareClock } from "./spectrum.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const OUT = join(drv, "out", "dac-stream");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 10));
const LONG = argv.includes("--long");
const ONLY = arg("case", null);
const JSON_OUT = argv.includes("--json");

// ── §6.2, fixed in advance ─────────────────────────────────────────────────
const LIMITS = {
  rateErrPct: 0.1,      // mean effective rate, ±0.1%
  within5pct: 99.9,     // share of adjacent intervals inside 0.95T..1.05T
  bandMin: 0.90, bandMax: 1.10,   // and EVERY interval inside 0.90T..1.10T
  holePeriods: 1.5,     // no stretch longer than this, ever
};

// ── §6.3's waveforms ───────────────────────────────────────────────────────
const waves = {
  constant: () => Uint8Array.from({ length: 256 }, () => 0x80),
  // Identifiable: every byte is its own index, so a duplicated or dropped
  // sample is visible in the stream itself and not only in a count.
  ramp: () => Uint8Array.from({ length: 256 }, (_, i) => i),
  sine: () => Uint8Array.from({ length: 256 },
    (_, i) => Math.round(128 + 120 * Math.sin((2 * Math.PI * i) / 256)) & 0xff),
  // Two tones back to back — the §6.3 "異なる2音の連続ループ" in one page.
  twotone: () => Uint8Array.from({ length: 256 }, (_, i) => (i < 128
    ? Math.round(128 + 100 * Math.sin((2 * Math.PI * i) / 32))
    : Math.round(128 + 60 * Math.sin((2 * Math.PI * i) / 64))) & 0xff),
};

const CASES = [
  { name: "constant", wave: "constant", cfg: {} },
  { name: "ramp", wave: "ramp", cfg: {} },
  { name: "sine", wave: "sine", cfg: {} },
  { name: "two tones", wave: "twotone", cfg: {} },
  { name: "no timer observation", wave: "sine", cfg: { observeTimerB: false } },
  { name: "CSM alongside", wave: "sine", cfg: { csm: true } },
  { name: "CSM + dense FM writes", wave: "sine", cfg: { csm: true, fmBurst: 5 } },
  // §6.3 asks for the bus-grab phase sweep. It is NOT part of P1's pass — the
  // isolated column of §6.2 is measured without the 68000 — but the instrument
  // has to be able to see it before P3 asks the question, so it runs and
  // reports, marked.
  { name: "68000 bus grab (informational)", wave: "sine", cfg: { csm: true }, grabPhase: true, informational: true },
  { name: "3.3 kHz, the shipped clock", wave: "sine", cfg: { profile: "p3k3" } },
  { name: "13.3 kHz (informational)", wave: "sine", cfg: { profile: "p13k" }, informational: true },
];

const build = (cfgIn) => {
  const cfg = buildConfig(cfgIn);
  const gen = generate(cfg);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `stream-${cfg.profile.name}-${cfg.stamp}.z80`);
  writeFileSync(path, gen.text);
  return { cfg, gen, built: assemble(path), path };
};

function runCase(c, seconds) {
  const { cfg, gen, built, path } = build(c.cfg);
  const wave = waves[c.wave]();
  const cycles = Math.round(seconds * cfg.z80Hz);
  // The bus-grab sweep walks the grab's start through ONE sample period, so a
  // grab that lands just before a DAC write and one that lands just after are
  // both measured (§6.3).
  const grabs = [];
  if (c.grabPhase) {
    const P = cfg.periodCycles;
    for (let k = 0; k * 20000 < cycles; k++)
      grabs.push({ at: Math.round(k * 20000 + (k % 16) * (P / 16)), cycles: 700 });
  }
  const m = new Machine(cfg, built, { wave, grabs });
  m.trace.meta = traceMeta(cfg, { case: c.name, seconds, source: path });
  m.run(cycles);

  const value = analyzeValue(m.trace, (i) => wave[i % wave.length]);
  const time = analyzeTime(m.trace, cfg);
  const bus = analyzeBus(m.trace, cfg);
  const writes = analyzeWrites(m.trace, cfg);
  const phase = analyzeTimerPhase(m.trace, cfg);
  const dacen = analyzeDacEnable(m.trace, cfg, m.cycles);
  const spec = c.wave === "sine" ? compareClock(m.trace, cfg) : null;

  const fails = [];
  if (value.problems.length) fails.push(...value.problems.map((p) => `VALUE ${p}`));
  if (writes.problems.length) fails.push(...writes.problems.slice(0, 3).map((p) => `WRITE ${p}`));
  if (Math.abs(time.rateErrPct) > LIMITS.rateErrPct)
    fails.push(`TIME mean rate ${time.meanRateHz} Hz is ${time.rateErrPct}% off ${cfg.rateHz.toFixed(2)}`);
  if (time.within5pct < LIMITS.within5pct)
    fails.push(`TIME ${time.within5pct}% of intervals inside 0.95T..1.05T (needs ${LIMITS.within5pct}%)`);
  if (time.gapMin < cfg.periodCycles * LIMITS.bandMin || time.gapMax > cfg.periodCycles * LIMITS.bandMax)
    fails.push(`TIME interval range ${time.gapMin}..${time.gapMax} outside`
      + ` ${(cfg.periodCycles * LIMITS.bandMin).toFixed(1)}..${(cfg.periodCycles * LIMITS.bandMax).toFixed(1)}`);
  if (time.holes.length) fails.push(`TIME ${time.holes.length} hole(s) past ${LIMITS.holePeriods}T`
    + ` — longest ${Math.max(...time.holes.map((h) => h.periods))} periods`);
  if (dacen.length !== 1) fails.push(`the DAC was enabled ${dacen.length} times, expected once`);

  return { c, cfg, gen, value, time, bus, writes, phase, dacen, spec, fails,
    imageBytes: built.bytes.length, codeBytes: built.symbols.get("code_end"),
    ramTop: built.symbols.get("stream") };
}

// ── Report ─────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const results = [];
let failed = 0;
for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const seconds = LONG && c.name === "CSM + dense FM writes" ? 60 : SECONDS;
  const r = runCase(c, seconds);
  results.push(r);
  const bad = r.fails.length > 0;
  if (bad && !c.informational) failed++;
  console.log(`${bad ? (c.informational ? "info" : "FAIL") : "ok  "}  ${pad(c.name, 32)}`
    + ` ${r.time.n} samples · ${r.time.meanRateHz} Hz (${r.time.rateErrPct >= 0 ? "+" : ""}${r.time.rateErrPct}%)`
    + ` · gap ${r.time.gapMin}..${r.time.gapMax} (T = ${r.cfg.periodCycles})`
    + ` · phase max ${r.time.maxAbsPhase} cyc (${r.time.maxAbsPhasePct}%)`
    + ` · drift ${r.time.drift} cyc over ${r.time.seconds}s`);
  if (r.spec) console.log(`      spectrum: tone ${r.spec.toneHz} Hz ·`
    + ` worst non-tone bin ${r.spec.uniformWorstDbc} dBc on the uniform grid,`
    + ` ${r.spec.realWorstDbc} dBc at the real write times`
    + ` (the clock added ${r.spec.clockAddedDb} dB, at ${r.spec.realWorstHz} Hz)`);
  if (r.phase) console.log(`      Timer B: ${r.phase.overflows} overflows,`
    + ` ${r.phase.reads} reads, flag seen ${r.phase.flagSeenPct}%,`
    + ` read delay p50 ${r.phase.delayP50} max ${r.phase.delayMax} cyc`
    + ` (period ${r.phase.periodCycles})`);
  if (r.bus.grabs) console.log(`      bus: ${r.bus.grabs} grabs, ${r.bus.heldCycles} cycles held`
    + ` (${r.bus.heldPeriods} sample periods), longest ${r.bus.longest}`
    + ` — ${r.time.holes.filter((h) => h.inBusGrab).length} of ${r.time.holes.length}`
    + ` holes overlap one`);
  for (const f of r.fails.slice(0, 6)) console.log(`      ! ${f}`);
}

// ── The §4 deliverables, printed with the run that produced them ───────────
const ref = results.find((r) => r.c.name === "CSM + dense FM writes") ?? results[0];
if (ref && !JSON_OUT) {
  console.log(`\n出力配置表 — ${stampLine(ref.cfg)}`);
  console.log(`  ${pad("slot", 5)}${pad("cycles", 8)}${pad("work", 6)}${pad("pad", 6)}${pad("work%", 7)}what`);
  for (const row of ref.gen.placement.rows)
    console.log(`  ${pad(row.slot, 5)}${pad(row.cycles, 8)}${pad(row.work, 6)}${pad(row.pad, 6)}`
      + `${pad(row.workPct, 7)}${row.what.slice(0, 90)}`);
  console.log(`  mean work ${ref.gen.placement.meanWorkPct}% ·`
    + ` worst slot ${ref.gen.placement.worst.slot} at ${ref.gen.placement.worst.workPct}%`
    + ` (§4 design ceiling is 80%)`);

  const paths = cyclePaths(ref.cfg);
  console.log(`\n経路別サイクル表 — costed from the encodings`);
  for (const [name, cyc, note] of paths.rows)
    console.log(`  ${pad(name, 30)}${String(cyc).padStart(6)}  ${note}`);
  for (const [name, note] of paths.pending)
    console.log(`  ${pad(name, 30)}${"—".padStart(6)}  ${note}`);

  console.log(`\nRAMマップ — code ${ref.codeBytes} B (loop entry $${ref.ramTop.toString(16)},`
    + ` ends $${ref.codeBytes.toString(16)}), image ${ref.imageBytes} B with the waveform page`);
  for (const [k, v] of Object.entries(ref.cfg.ram)) {
    if (k === "size") continue;
    console.log(`  ${pad(k, 10)} $${v[0].toString(16).padStart(4, "0")}..$${v[1].toString(16).padStart(4, "0")}`
      + `  ${String(v[1] - v[0]).padStart(5)} B`);
  }

  console.log(`\nレジスター契約`);
  for (const [r, note] of [
    ["a", "the sample in flight; scratch inside a slot's work, dead across the pad"],
    ["hl", "the waveform cursor (H = page, L = index) — LIVE for the whole run"],
    ["de", "$4001, the YM data port — LIVE for the whole run"],
    ["bc", "the pad's own; b is the djnz counter and nothing outlives a slot"],
    ["ix/iy", "unused"],
    ["af'/bc'/de'/hl'", "unused in P1 (P2 takes them for the mixer's plane)"],
    ["sp", "the boot stack only; the loop never pushes"],
    ["i/r", "untouched"],
    ["IFF1/IFF2", "clear from boot to power-off — the loop takes no interrupt"],
  ]) console.log(`  ${pad(r, 18)}${note}`);
}

if (JSON_OUT) {
  const out = join(OUT, "gate.json");
  writeFileSync(out, JSON.stringify(results.map((r) => ({
    case: r.c.name, informational: !!r.c.informational, stamp: r.cfg.stamp,
    rateHz: r.cfg.rateHz, period: r.cfg.periodCycles,
    value: r.value, time: { ...r.time, holes: r.time.holes.slice(0, 20) },
    bus: r.bus, writes: { writes: r.writes.writes, problems: r.writes.problems.slice(0, 10) },
    phase: r.phase, placement: r.gen.placement.rows, fails: r.fails,
  })), null, 2));
  console.log(`\njson → ${out}`);
}

console.log(`\n${failed ? `FAIL: ${failed} of ${results.filter((r) => !r.c.informational).length} cases`
  : `${results.filter((r) => !r.c.informational).length} cases pass`}`
  + ` · ${SECONDS}s each${LONG ? " (one at 60s)" : ""}`);
process.exit(failed ? 1 : 0);
