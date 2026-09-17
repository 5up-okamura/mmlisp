// THE LIGHT ENGINE STUDY (plan-pcm-spec.md D10, design session 2026-09-17).
//
//   node experimental/dac-stream/light-study.mjs [--voices 1,2,3] [--target 1.0]
//        [--wire 960] [--no-loops] [--lap-max 430080]
//
// The highest DAC rate the generator PLACES for one, two and three voices with
// NOTHING but the engine: no phase decode, no corrector, no runtime protocol
// (`generate()` alone, never `generateSplit()`), D4's rung levels, no octave
// step, and — unless --no-loops — the loop-capable six-piece edge
// (gen-stream.mjs, `loops: true`). `--target` is the work ceiling a slot may be
// filled to; 1.0 is the edge (a slot with no pad at all). `--wire` is the
// pairs a second the expander is sized for (steps a lap = ceil(wire × lap)).
// A point is placed AND assembled; it is not run — gate-nv is where the pieces'
// costs are proved, once it knows the loop edge.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../engine/config.mjs";
import { generate, nvEdgeCost, expanderCost } from "../../engine/gen-stream.mjs";
import { assemble } from "../../tools/z80asm.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VOICES = arg("voices", "1,2,3").split(",").map(Number);
const TARGET = Number(arg("target", 1.0));
const WIRE = Number(arg("wire", 960));
const LOOPS = !argv.includes("--no-loops");
const LAP_MAX_MASTER = Number(arg("lap-max", 430080));
const MASTER = 53693175, Z80DIV = 15;

export function lightConfig(voices, period, { target = TARGET, wire = WIRE, loops = LOOPS, lapMax = LAP_MAX_MASTER } = {}) {
  const sampleMaster = period * Z80DIV;
  const lapBlocks = Math.floor(lapMax / (16 * sampleMaster));
  if (lapBlocks < 2) return null;
  const lapS = (lapBlocks * 16 * sampleMaster) / MASTER;
  const xpSteps = Math.max(8, Math.ceil(wire * lapS));
  return { voices, complete: true, pairs: true, signedSource: true, production: true,
    workTarget: target, meanTarget: target, sampleMaster, lapBlocks, xpSteps, stepVoices: 0, loops };
}

export function tryPoint(voices, period, opts = {}) {
  const o = lightConfig(voices, period, opts);
  if (!o) return { ok: false, why: "lap" };
  let cfg, g;
  try { cfg = buildConfig(o); g = generate(cfg); }
  catch (e) { return { ok: false, why: e.message.split("\n")[0].slice(0, 100) }; }
  const worst = g.placement.worst.workPct, mean = g.placement.meanWorkPct;
  const out = { voices, period, rateHz: +cfg.rateHz.toFixed(1), lap: cfg.cycleSlots, steps: cfg.xpSteps,
    worst, mean, worstWhat: g.placement.worst.what.slice(0, 70), cfg };
  if (g.slots.some((s) => s.row.pad < 0) || worst > 100 * (opts.target ?? TARGET) + 1e-9)
    return { ...out, ok: false, why: `worst ${worst}%` };
  const dir = mkdtempSync(join(tmpdir(), "light-study-"));
  try {
    const p = join(dir, "e.z80");
    writeFileSync(p, g.text);
    const b = assemble(p);
    out.code = b.symbols.get("code_end"); out.region = cfg.ram.code[1]; out.ok = true;
  } catch (e) { out.ok = false; out.why = "asm " + e.message.split("\n")[0].slice(0, 80); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`light engine · loops ${LOOPS ? "on" : "off"} · target ${(TARGET * 100).toFixed(0)}% · wire ${WIRE} pairs/s`);
  console.log("voices  rate Hz   period  lap   steps  worst   mean    code/region  binding slot");
  for (const v of VOICES) {
    let best = null;
    for (let p = 150; p <= 900 && !best; p++) { const r = tryPoint(v, p); if (r.ok) best = r; }
    if (!best) { console.log(`${v}       none`); continue; }
    console.log(`${String(v).padEnd(8)}${String(best.rateHz).padEnd(10)}${String(best.period).padEnd(8)}${String(best.lap).padEnd(6)}`
      + `${String(best.steps).padEnd(7)}${(best.worst + "%").padEnd(8)}${(best.mean + "%").padEnd(8)}${best.code}/${best.region}  ${best.worstWhat}`);
    const e = nvEdgeCost(best.cfg)[0], x = expanderCost(best.cfg);
    console.log(`        edge pieces (voice 0) ${JSON.stringify(e)} · expander A ${x.aCycles} B ${x.bCycles}`);
  }
}
