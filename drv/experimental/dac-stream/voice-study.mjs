// THE VOICE-COUNT STUDY (plan-pcm-spec.md D1 + D4).
//
//   node experimental/dac-stream/voice-study.mjs [--voices 1,2,3] [--from HZ] [--to HZ] [--json]
//
// For one, two and three PCM voices, the highest DAC rate the generator PLACES
// with everything the shipped engine carries — the pair expander, the phase
// decode, the corrector and the runtime protocol — and D4's level model: 6 dB
// rung pages with the master folded in (one table read a voice), the 512 B
// clamp cascaded once per extra voice.
//
// A point passes when generateSplit places it and the image holds the shipped
// engine's two rules: no slot's work over 83.9% of its length, the mean under
// 79.6%, and the code inside its region (the assembler checks it). Rates are
// integer Z80-cycle periods (the group is one slot, so any lap of whole blocks
// closes on it).
//
// THE LAP IS HELD UNDER TODAY'S 430,080 MASTER CLOCKS (8.01 ms): the corrector
// repays at most 1,500 master a lap and the SGDK host's pumps are 131 lines
// (8.34 ms) apart, so a longer lap could hold two grabs. A lower rate therefore
// gets FEWER blocks a lap, and the expander gets the steps a lap that carry
// 1.5x the host's 960 pairs a second.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../engine/config.mjs";
import { nvEdgeCost, expanderCost } from "../../engine/gen-stream.mjs";
import { generateSplit } from "../../engine/decode-split.mjs";
import { assemble } from "../../tools/z80asm.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VOICES = arg("voices", "1,2,3").split(",").map(Number);
const FROM_HZ = Number(arg("from", 12000)), TO_HZ = Number(arg("to", 4500));
const JSON_OUT = argv.includes("--json");
// Variants: how many voices carry the octave step (default all), and the
// expander's capacity as a multiple of the host's 960 pairs a second.
const STEP_VOICES = arg("step-voices", null) === null ? null : Number(arg("step-voices", null));
const WIRE_MARGIN = Number(arg("wire-margin", 1.5));
// --flat-level drops the level model entirely (no rung page, no master): what a
// driver that gives up volume to buy rate would run. It is a COST measurement,
// not a proposal — gate-nv's reference mixes rungs, so it does not check this.
const FLAT_LEVEL = argv.includes("--flat-level");

const MASTER = 53693175, Z80DIV = 15;
// Today's lap. The hard limit is the pumps' spacing, 131 lines = 448,020
// master, less one grab; --lap-max measures what the margin costs.
const LAP_MAX_MASTER = Number(arg("lap-max", 430080));
const WORST = 83.9, MEAN = 79.6;

export function pointConfig(voices, period, { stepVoices = STEP_VOICES, wireMargin = WIRE_MARGIN,
  flatLevel = FLAT_LEVEL } = {}) {
  const sampleMaster = period * Z80DIV;
  const lapBlocks = Math.floor(LAP_MAX_MASTER / (16 * sampleMaster));
  if (lapBlocks < 2) return null;
  const lapS = (lapBlocks * 16 * sampleMaster) / MASTER;
  const xpSteps = Math.max(8, Math.ceil(960 * wireMargin * lapS));
  return { voices, complete: true, pairs: true, signedSource: true, production: true,
    correctorBudget: true, workTarget: WORST / 100, sampleMaster, lapBlocks, xpSteps,
    ...(flatLevel ? { flatLevel } : {}),
    ...(stepVoices === null ? {} : { stepVoices }) };
}

export function tryPoint(voices, period, { bytes = false } = {}) {
  const opts = pointConfig(voices, period);
  if (!opts) return { voices, period, ok: false, why: "lap" };
  let cfg, r;
  try {
    cfg = buildConfig(opts);
    r = generateSplit(cfg, { stackFill: true, correct: true, proto: true });
  } catch (e) {
    return { voices, period, ok: false, why: e.message.split("\n")[0].slice(0, 90) };
  }
  const base = { voices, period, rateHz: +cfg.rateHz.toFixed(1), lap: cfg.cycleSlots,
    lapMs: +((cfg.cycleSlots * cfg.periodCycles) / cfg.z80Hz * 1000).toFixed(2), steps: cfg.xpSteps };
  if (!r.ok) return { ...base, ok: false, why: `${r.stage} ${r.error ?? r.walk?.failed?.name ?? ""}`.trim() };
  const worst = r.gen.placement.worst.workPct, mean = r.gen.placement.meanWorkPct;
  const out = { ...base, worst, mean, ok: worst <= WORST && mean <= MEAN };
  if (!out.ok) out.why = worst > WORST ? `worst ${worst}%` : `mean ${mean}%`;
  if (out.ok && bytes) {
    const dir = mkdtempSync(join(tmpdir(), "voice-study-"));
    try {
      const path = join(dir, "e.z80");
      writeFileSync(path, r.gen.text);
      const built = assemble(path);
      out.code = built.symbols.get("code_end");
      out.region = cfg.ram.code[1];
      out.image = built.bytes.length;
    } catch (e) {
      out.ok = false; out.why = `assembly: ${e.message.split("\n")[0].slice(0, 80)}`;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pLo = Math.ceil(MASTER / Z80DIV / FROM_HZ), pHi = Math.floor(MASTER / Z80DIV / TO_HZ);
  const best = {}, rows = [];
  for (const v of VOICES) {
    // Highest rate first; the first point that passes (and assembles) is the answer.
    for (let p = pLo; p <= pHi; p++) {
      const r = tryPoint(v, p);
      if (!r.ok) continue;
      const b = tryPoint(v, p, { bytes: true });
      if (!b.ok) continue;
      best[v] = b;
      break;
    }
    // …and a few points below it, to show the margin is not a knife edge.
    if (best[v]) for (const k of [1, 2, 4, 8, 16]) rows.push(tryPoint(v, best[v].period + k, { bytes: true }));
  }
  if (JSON_OUT) { console.log(JSON.stringify({ best, rows }, null, 1)); process.exit(0); }
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("voices  rate Hz   period  lap (ms)        steps  worst  mean   code / region");
  for (const v of VOICES) {
    const b = best[v];
    if (!b) { console.log(`${v}       none between ${FROM_HZ} and ${TO_HZ} Hz`); continue; }
    console.log(`${pad(v, 8)}${pad(b.rateHz, 10)}${pad(b.period, 8)}${pad(`${b.lap} (${b.lapMs})`, 16)}`
      + `${pad(b.steps, 7)}${pad(b.worst + "%", 7)}${pad(b.mean + "%", 7)}${b.code} / ${b.region}`);
    const cfg = buildConfig(pointConfig(v, b.period));
    console.log(`        edges ${JSON.stringify(nvEdgeCost(cfg))}`
      + ` · expander A ${expanderCost(cfg).aCycles} B ${expanderCost(cfg).bCycles}`);
  }
  console.log("\nbelow each best point:");
  for (const r of rows)
    console.log(`  ${r.voices}v ${pad(r.rateHz, 9)} ${r.ok ? "ok  " : "FAIL"} ${r.ok ? `${r.worst}% / ${r.mean}%` : r.why}`);
}
