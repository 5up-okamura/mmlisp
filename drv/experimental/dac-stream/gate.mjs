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
import { generate, cyclePaths, codeLedger } from "./gen-stream.mjs";
import { Machine, traceMeta } from "./machine.mjs";
import {
  analyzeValue, analyzeTime, analyzeBus, analyzeWrites, analyzeTimerTraffic, analyzeDacEnable,
  analyzeLead,
} from "./analyze.mjs";
import { compareClock } from "./spectrum.mjs";
import { mixOne, mixTwo, SILENCE, tablesAgree, lutPages, pageIsALevel } from "./lut.mjs";

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

// A 256-byte source page in the 68k window, in the shape §6.3 asks for: a
// constant, a ramp, a tone. Fixed pitch, one byte a sample (§3.4).
// Page 0 is voice 0's source and page 1 is voice 1's, so a two-voice run mixes
// two DIFFERENT things and a swapped pointer cannot pass.
const sources = {
  romsine: () => Uint8Array.from({ length: 512 }, (_, i) => (i < 256
    ? Math.round(128 + 120 * Math.sin((2 * Math.PI * i) / 256))
    : Math.round(128 + 90 * Math.sin((2 * Math.PI * (i - 256) * 3) / 256))) & 0xff),
  romramp: () => Uint8Array.from({ length: 512 }, (_, i) => (i < 256 ? i : 255 - (i - 256))),
  // Both voices at full scale in the same direction — the only input that can
  // reach the clamp at all, and therefore the only one that tests it.
  romfull: () => Uint8Array.from({ length: 512 }, (_, i) => ((i % 256) < 128 ? 0xff : 0x00)),
};

/**
 * The §6.1 reference for a mixed run: an INDEPENDENT statement of what the
 * bytes should be, not a transcription of the assembly. The engine's structure
 * enters it in exactly two places, and both are properties being asserted:
 * the build cursor runs `lead` samples ahead of the play cursor, and a level
 * change takes effect at a block edge and applies to the whole block.
 *
 * The level sequence comes from the block edges the machine was OBSERVED to
 * read, which is why the caller also checks that each of those reads landed in
 * the last slot of its block — otherwise a reference built from them would
 * follow the engine wherever it went.
 */
function referenceMix(cfg, src, edges) {
  const B = cfg.blockSamples;
  const L = cfg.levels;
  const boot = { v0: L - 1, v1: L - 1, master: L - 1 };
  return (i) => {
    if (i < cfg.lead) return SILENCE;   // the declared start-up silence
    const j = i - cfg.lead;             // the slot that built it
    // A block edge runs in the slot that builds the LAST sample of a block, so
    // the levels it reads are the ones block b+2 is built at. Two, not one,
    // because the lead is 17: the edge is one slot before the slot boundary
    // the built block starts on.
    const b = Math.floor(i / B);
    const e = b < 2 ? boot : edges[b - 2] ?? edges[edges.length - 1] ?? boot;
    return cfg.voices >= 2
      ? mixTwo(src[j % 256], e.v0, src[256 + (j % 256)], e.v1, e.master, L)
      : mixOne(src[j % 256], e.v0, e.master, L);
  };
}

const CASES = [
  { name: "constant", wave: "constant", cfg: {} },
  { name: "ramp", wave: "ramp", cfg: {} },
  { name: "sine", wave: "sine", cfg: {} },
  { name: "two tones", wave: "twotone", cfg: {} },
  // Timer B's traffic, on purpose: a status read and a $27 write in the
  // schedule with the $2A re-latch behind them. It is a YM LOAD case; §3.2
  // (R1) withdraws its use as a phase reference, and the gate prints the
  // measured reason — the reset -> read window is longer than the period.
  { name: "Timer B traffic (load case)", wave: "sine", cfg: { observeTimerB: true } },
  { name: "CSM alongside", wave: "sine", cfg: { csm: true } },
  { name: "CSM + dense FM writes", wave: "sine", cfg: { csm: true, fmBurst: 5, observeTimerB: true } },
  // §6.3 asks for the bus-grab phase sweep. It is NOT part of P1's pass — the
  // isolated column of §6.2 is measured without the 68000 — but the instrument
  // has to be able to see it before P3 asks the question, so it runs and
  // reports, marked.
  { name: "68000 bus grab (informational)", wave: "sine", cfg: { csm: true }, grabPhase: true, informational: true },
  { name: "3.3 kHz, the shipped clock", wave: "sine", cfg: { profile: "p3k3" } },
  { name: "13.3 kHz (informational)", wave: "sine", cfg: { profile: "p13k" }, informational: true },

  // ── P2: one voice through the block mixer ────────────────────────────────
  { name: "P2 one voice, unity", src: "romsine", cfg: { voices: 1 } },
  { name: "P2 one voice, full scale", src: "romfull", cfg: { voices: 1 } },
  { name: "P2 one voice + CSM", src: "romsine", cfg: { voices: 1, csm: true } },
  // Every level, walked one block at a time — §6.3's "全音量段階".
  { name: "P2 all 16 levels", src: "romramp", cfg: { voices: 1 }, levels: "walk" },
  // Full scale to silence and back, on the master alone (§6.3's fade).
  { name: "P2 master fade to silence", src: "romsine", cfg: { voices: 1 }, levels: "fade" },
  // The two composed, in opposite directions, which is the case that catches a
  // build that folded them into one lookup: the rounding differs.
  { name: "P2 vel and master, opposed", src: "romsine", cfg: { voices: 1 }, levels: "opposed" },

  // ── P2: two voices ───────────────────────────────────────────────────────
  { name: "P2 two voices, unity", src: "romsine", cfg: { voices: 2 } },
  // Both at full scale and in phase: the sum leaves the range on most samples,
  // so this is what exercises the clamp table.
  { name: "P2 two voices, clipping", src: "romfull", cfg: { voices: 2 } },
  { name: "P2 two voices + CSM", src: "romsine", cfg: { voices: 2, csm: true } },
  // The same, with Timer B's traffic added on top — the heaviest YM load the
  // prototype can produce.
  { name: "P2 two voices + CSM + Timer B", src: "romsine", cfg: { voices: 2, csm: true, observeTimerB: true } },
  { name: "P2 two voices, all levels", src: "romramp", cfg: { voices: 2 }, levels: "walk" },
  { name: "P2 two voices, master fade", src: "romsine", cfg: { voices: 2 }, levels: "fade" },
  // The §6.3 "声部別の逆向きフェード": voice 0 up while voice 1 goes down.
  { name: "P2 two voices, opposed fades", src: "romsine", cfg: { voices: 2 }, levels: "opposed" },

  // ── The COMPLETE 2ch engine's BUDGET (§10.3 step 2, R1) ──────────────────
  // Every feature that is not written yet has its cycles EXECUTED as padding
  // and its RAM reserved. What passes here is not the finished engine — it is
  // the finished engine's schedule, measured rather than tabulated.
  { name: "2ch complete budget", src: "romsine", cfg: { voices: 2, complete: true } },
  { name: "2ch complete budget + CSM", src: "romsine", cfg: { voices: 2, complete: true, csm: true } },
  { name: "2ch complete budget, fades", src: "romsine", cfg: { voices: 2, complete: true }, levels: "opposed" },

  // ── The 15-LEVEL PROFILE (R8 §23.2) ──────────────────────────────────────
  // A different build, not a different default: 15 levels of k/14 in 3,840 B,
  // the page that comes free reserved for the phase table, ring and everything
  // after it unmoved. The reference computes from the arithmetic and never
  // reads the generated family, so a wrong table fails here rather than
  // agreeing with itself. Silence, unity, every level, and the two roundings
  // moving in opposite directions are all covered.
  { name: "2ch 15 levels", src: "romsine",
    cfg: { voices: 2, complete: true, levels: 15, workTarget: 0.839 } },
  { name: "2ch 15 levels + CSM", src: "romsine",
    cfg: { voices: 2, complete: true, csm: true, levels: 15, workTarget: 0.839 } },
  { name: "2ch 15 levels, all levels", src: "romramp",
    cfg: { voices: 2, complete: true, levels: 15, workTarget: 0.839 }, levels: "walk" },
  { name: "2ch 15 levels, opposed fades", src: "romsine",
    cfg: { voices: 2, complete: true, levels: 15, workTarget: 0.839 }, levels: "opposed" },
  { name: "2ch 15 levels, clipping", src: "romfull",
    cfg: { voices: 2, complete: true, levels: 15, workTarget: 0.839 } },
];

const build = (cfgIn) => {
  const cfg = buildConfig(cfgIn);
  const gen = generate(cfg);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `stream-${cfg.profile.name}-${cfg.stamp}.z80`);
  writeFileSync(path, gen.text);
  return { cfg, gen, built: assemble(path), path };
};

// The host's level changes, as cycles at which the 68000 pokes Z80 RAM. The
// exact cycle does not have to be exact: the reference follows the block edges
// the machine was observed to take, and a separate check says those edges were
// where they belong. What the schedule must do is land the pokes INSIDE blocks,
// which "the middle of one, roughly" does at any plausible boot cost.
function levelPokes(cfg, kind, cycles, sym) {
  if (!kind) return [];
  const lutPage = cfg.ram.lut[0] >> 8;
  const L = cfg.levels;
  const blockCy = cfg.blockSamples * cfg.periodCycles;
  const out = [];
  const every = 24;                        // blocks between changes
  // EVERY level, including 0 and L-1 — silence and unity are the two a score
  // relies on being exact — and `opposed` moves the voice and the master in
  // opposite directions, which is the case that would catch the two roundings
  // being folded into one (R8 §23.2).
  for (let b = 2, n = 0; b * blockCy < cycles; b += every, n++) {
    const at = Math.round((b + 0.5) * blockCy) + 8000;
    let vel = L - 1, master = L - 1;
    if (kind === "walk") vel = n % L;
    if (kind === "fade") master = L - 1 - (n % (L * 2) > L - 1
      ? L * 2 - 1 - (n % (L * 2)) : n % (L * 2));
    if (kind === "opposed") { vel = n % L; master = L - 1 - (n % L); }
    out.push({ at, addr: sym.get("G_V0PAGE"), value: lutPage + vel });
    if (sym.has("G_V1PAGE"))
      out.push({ at, addr: sym.get("G_V1PAGE"), value: lutPage + (kind === "opposed" ? L - 1 - vel : vel) });
    out.push({ at, addr: sym.get("G_MPAGE"), value: lutPage + master });
  }
  // NO PAGE THIS GATE WRITES MAY LEAVE THE FAMILY. The mixer's page is a
  // self-modified operand, so a page one past the end is not an error, it is
  // the phase table read as a volume table (R8 §23.2).
  const stray = out.filter((w) => !pageIsALevel(cfg, w.value));
  if (stray.length)
    throw new Error(`level page $${stray[0].value.toString(16)} is outside the family`
      + ` $${lutPages(cfg).first.toString(16)}..$${lutPages(cfg).last.toString(16)}`);
  return out;
}

function runCase(c, seconds) {
  const { cfg, gen, built, path } = build(c.cfg);
  const wave = c.wave ? waves[c.wave]() : null;
  const src = c.src ? sources[c.src]() : null;
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
  const watch = cfg.voices
    ? [built.symbols.get("G_V0PAGE"), built.symbols.get("G_MPAGE"),
       ...(cfg.voices >= 2 ? [built.symbols.get("G_V1PAGE")] : [])]
    : [];
  const pokes = cfg.voices ? levelPokes(cfg, c.levels, cycles, built.symbols) : [];
  const m = new Machine(cfg, built, { wave, grabs, rom: src, pokes, watch });
  m.trace.meta = traceMeta(cfg, { case: c.name, seconds, source: path });
  m.run(cycles);

  // The block edges, as the machine was seen to take them: one (G_VPAGE,
  // G_MPAGE) pair per block, in order.
  const lutPage = cfg.voices ? cfg.ram.lut[0] >> 8 : 0;
  const per = cfg.voices >= 2 ? 3 : 2;      // reads per edge: v0 [, v1], master
  const edges = [];
  for (let i = 0; i + per - 1 < m.trace.globRead.length; i += per) {
    const r = m.trace.globRead.slice(i, i + per).map((x) => x[2] - lutPage);
    edges.push(cfg.voices >= 2
      ? { cycle: m.trace.globRead[i][0], v0: r[0], v1: r[1], master: r[2] }
      : { cycle: m.trace.globRead[i][0], v0: r[0], master: r[1] });
  }

  const value = cfg.voices
    ? analyzeValue(m.trace, referenceMix(cfg, src, edges))
    : analyzeValue(m.trace, (i) => wave[i % wave.length]);
  const time = analyzeTime(m.trace, cfg);
  const bus = analyzeBus(m.trace, cfg);
  const writes = analyzeWrites(m.trace, cfg);
  const timerB = analyzeTimerTraffic(m.trace, cfg);
  const lead = cfg.voices
    ? analyzeLead(m.trace, cfg, [built.symbols.get("mix_one"), built.symbols.get("code_end")])
    : null;
  const dacen = analyzeDacEnable(m.trace, cfg, m.cycles);
  // The clock/value comparison wants ONE tone in the signal; a two-voice mix
  // has two by construction and the "worst non-tone bin" is then the other
  // voice, which says nothing about either.
  const spec = (c.wave === "sine" || c.src === "romsine") && cfg.voices < 2
    ? compareClock(m.trace, cfg) : null;

  const fails = [];
  if (value.problems.length) fails.push(...value.problems.map((p) => `VALUE ${p}`));
  // §3.3 (R1): the fixed lead is an invariant, so it is checked, not assumed.
  if (lead?.problems.length) fails.push(...lead.problems.slice(0, 3).map((p) => `LEAD ${p}`));
  // …and the generated tables against the same arithmetic the reference uses,
  // reported separately from the value comparison (§3.4 R1).
  if (cfg.voices) for (const p of tablesAgree(cfg.levels).slice(0, 2)) fails.push(`TABLE ${p}`);
  // A LEVEL CHANGE IS WHOLE-BLOCK OR IT IS NOTHING (§3.4). The k-th edge must
  // fall inside the last slot of block k — after that slot's own sample went
  // out, and before the next one's. Without this the reference above would
  // simply follow the engine wherever it decided to latch.
  if (cfg.voices) {
    // A LEVEL CHANGE IS WHOLE-BLOCK OR IT IS NOTHING (§3.4). The k-th edge runs
    // in the slot that builds the last sample of a block — slot 14 + 16k with
    // a lead of 17 — so its cycle must sit between that slot's DAC write and
    // the next one's. Without this the reference above would simply follow the
    // engine wherever it decided to latch.
    const B = cfg.blockSamples;
    const first = (cfg.blockSamples - 1 - cfg.lead % B + B) % B;
    let misplaced = 0;
    for (let k = 0; k < edges.length; k++) {
      const slot = first + k * B;
      const lo = m.trace.dacCycle[slot];
      const hi = m.trace.dacCycle[slot + 1];
      if (lo === undefined || hi === undefined) break;
      if (!(edges[k].cycle > lo && edges[k].cycle < hi)) misplaced++;
    }
    if (misplaced) fails.push(`VALUE ${misplaced} of ${edges.length} block edges`
      + ` did not land in the slot that builds their block's last sample`);
    const wantEdges = Math.floor((m.trace.dacCycle.length - first) / B);
    if (Math.abs(edges.length - wantEdges) > 1)
      fails.push(`VALUE ${edges.length} block edges for ${m.trace.dacCycle.length} samples,`
        + ` expected about ${wantEdges}`);
  }
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

  return { c, cfg, gen, value, time, bus, writes, timerB, dacen, spec, fails, edges, lead,
    imageBytes: built.bytes.length, codeBytes: built.symbols.get("code_end"),
    ramTop: built.symbols.get("stream") };
}

// ── Report ─────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const results = [];
let failed = 0;
for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  // The representative case §6.2 wants a minute of is the heaviest one that is
  // meant to pass: two voices, a master, and CSM writing alongside.
  const seconds = LONG && c.name === "2ch complete budget + CSM" ? 60 : SECONDS;
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
  if (r.lead) console.log(`      fixed lead: ${r.lead.slots} slots, ${r.lead.wraps} page wraps,`
    + ` build-to-play distance ${r.lead.distance} (expected ${r.lead.expected}),`
    + ` one output and one finished store in every slot`);
  if (r.timerB) console.log(`      Timer B traffic (NOT a phase reference, §3.2 R1):`
    + ` ${r.timerB.reads} reads, flag seen ${r.timerB.flagSeenPct}%`
    + ` · reset→read window ${r.timerB.resetToReadMax} cyc vs a ${r.timerB.periodCycles} cyc period`
    + ` — ${r.timerB.informative ? "could carry information" : "CANNOT carry information"}`);
  if (r.bus.grabs) console.log(`      bus: ${r.bus.grabs} grabs, ${r.bus.heldCycles} cycles held`
    + ` (${r.bus.heldPeriods} sample periods), longest ${r.bus.longest}`
    + ` — ${r.time.holes.filter((h) => h.inBusGrab).length} of ${r.time.holes.length}`
    + ` holes overlap one`);
  for (const f of r.fails.slice(0, 6)) console.log(`      ! ${f}`);
}

// ── The §4 deliverables, printed with the run that produced them ───────────
// The tables are printed for the HEAVIEST configuration that ran, because the
// question they answer is where the room is.
const ref = results.find((r) => r.c.name === "2ch complete budget + CSM")
  ?? results.find((r) => r.c.name === "P2 two voices + CSM")
  ?? results.find((r) => r.c.name === "CSM + dense FM writes") ?? results[0];
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

  console.log(`\nRAMマップ — code ${ref.codeBytes} B built (loop entry $${ref.ramTop.toString(16)},`
    + ` ends $${ref.codeBytes.toString(16)})`);
  let claimed = 0;
  for (const [k, v] of Object.entries(ref.cfg.ram)) {
    if (k === "size") continue;
    claimed += v[1] - v[0];
    const note = k === "code"
      ? `${ref.codeBytes} B built, ${v[1] - v[0] - ref.codeBytes} B left for the rest`
      : "";
    console.log(`  ${pad(k, 10)} $${v[0].toString(16).padStart(4, "0")}..$${v[1].toString(16).padStart(4, "0")}`
      + `  ${String(v[1] - v[0]).padStart(5)} B  ${note}`);
  }
  console.log(`  ${pad("", 10)} ${pad("", 13)}  ${String(0x2000 - claimed).padStart(5)} B  UNCLAIMED`
    + (0x2000 - claimed < 256 ? "  ← this is not a margin" : ""));

  if (ref.cfg.reserve) {
    // The code region is the half of the budget the cycle reservations cannot
    // express, and it is the binding one.
    //
    // THE ESTIMATE IS NOT ADDED TO THE IMAGE (R11 §31.1, and R8 §24.3 before
    // it). A `complete` build EXECUTES every unwritten feature's cycles as
    // tagged padding, and those bytes are in `code_end` already — the real
    // feature REPLACES them. Adding the estimate on top counts them twice,
    // which is how a 2,392 B image was reported as 269 B over 2,560.
    const region = ref.cfg.ram.code[1] - ref.cfg.ram.code[0];
    // The test image bakes a CH3 patch into boot so CSM has something to key.
    // That is scaffolding — a real engine receives a patch as commands — so it
    // is measured and separated rather than quietly inflating the budget. The
    // ledger is taken from THAT image, because a CSM write draws on its block's
    // reservation and the two images do not carry the same reserved padding.
    const plain = build({ ...ref.c.cfg, csm: false });
    const bare = plain.built.symbols.get("code_end");
    const scaffold = ref.codeBytes - bare;
    const led = codeLedger(plain.cfg, plain.gen, bare);
    console.log(`\nコード予算 — region ${region} B`);
    console.log(`  ${pad("built (engine)", 26)}${String(led.engine).padStart(5)} B`);
    if (scaffold > 0)
      console.log(`  ${pad("(test CSM patch dump)", 26)}${String(scaffold).padStart(5)} B`
        + `  scaffolding — a real engine gets a patch as commands, not as boot code`);
    console.log(`  ${pad("- reserved padding", 26)}${String(led.reserved).padStart(5)} B`
      + `  provisional: the real feature replaces these bytes, it does not add to them`);
    for (const [what, bytes, why] of ref.cfg.codeEstimate)
      console.log(`  ${pad(`+ ${what}`, 26)}${String(bytes).padStart(5)} B  ${why}`);
    console.log(`  ${pad("= finished estimate", 26)}${String(led.finished).padStart(5)} B`
      + `  ${led.spare >= 0 ? `${led.spare} B spare` : `${-led.spare} B OVER — the region does not hold it`}`);
  }

  if (ref.cfg.reserve) {
    console.log(`\n予約表 — the complete 2ch engine, per 16-sample block.`
      + ` These cycles EXECUTE in this build.`);
    let total = 0;
    for (const [b, cyc, why] of ref.cfg.reserve) {
      total += cyc;
      console.log(`  b${pad(b, 4)}${String(cyc).padStart(4)}  ${why.slice(0, 86)}`);
    }
    console.log(`  ${pad("", 4)} ${String(total).padStart(4)}  = ${(total / 16).toFixed(1)} cycles a slot`
      + ` on top of the ${ref.gen.placement.rows[1].work - (ref.cfg.reserve[2][1])} the mixer already costs`);
  }

  const v = ref.cfg.voices;
  console.log(`\nレジスター契約 — ${v ? `${v} voice${v > 1 ? "s" : ""}` : "output only"}`);
  for (const [r, note] of [
    ["a", "the sample in flight; scratch inside a slot's work, dead across the pad"],
    ["hl", v ? "the PLAY cursor into the ring (H = page, L = index) — LIVE for the whole run"
      : "the waveform cursor (H = page, L = index) — LIVE for the whole run"],
    ["de", "$4001, the YM data port — LIVE for the whole run"],
    ["bc", "the pad's own; b is the djnz counter and nothing outlives a slot"],
    ["hl'", v ? "the mixer's table scratch — H = a level page, L = the index" : "unused"],
    ["de'", v ? "voice 0's source pointer in the 68k window; E advances, D never does" : "unused"],
    ["bc'", v ? "the BUILD cursor, LEAD ahead of the play cursor (B = ring page)" : "unused"],
    ["ix", v >= 2 ? "voice 1's source pointer — IXL advances" : "unused"],
    ["iy", v >= 2 ? "IYL holds voice 0's contribution between the two lookups" : "unused"],
    ["af'", "unused — `ex af,af'` never runs, so an interrupt could not use it either"],
    ["sp", "the boot stack and the mix routine's return address; nothing else pushes"],
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
    timerB: r.timerB, lead: r.lead, placement: r.gen.placement.rows, fails: r.fails,
  })), null, 2));
  console.log(`\njson → ${out}`);
}

console.log(`\n${failed ? `FAIL: ${failed} of ${results.filter((r) => !r.c.informational).length} cases`
  : `${results.filter((r) => !r.c.informational).length} cases pass`}`
  + ` · ${SECONDS}s each${LONG ? " (one at 60s)" : ""}`);
process.exit(failed ? 1 : 0);
