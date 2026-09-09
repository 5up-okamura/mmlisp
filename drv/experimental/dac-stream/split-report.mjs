// WHAT THE DISTRIBUTED IMAGE COSTS, printed from the image itself.
//
// R10 §29.7 step 5 asks for the worst slot, the mean, the neutral path, the
// shortened path's remaining pad, every DAC interval, the code and the RAM,
// recomputed for the corrected image. Those numbers were coming out of
// throwaway scripts, which is how §28 came to report a placement that had
// folded onto three laps: a number nobody can re-run is a number nobody can
// check. This is the tool that produces them.
//
//   node experimental/dac-stream/split-report.mjs [--plain] [--slots]
import { buildConfig, stampLine, cmdDisplacedCycles, CMD_SLOTS_USED,
  CMD_REPLACED } from "./config.mjs";
import { generateSplit, SPLIT_STATE_SIZE, SPLIT_STATE_SIZE_CORR } from "./decode-split.mjs";
import { codeLedger } from "./gen-stream.mjs";
import { CORR, CORR_SLOTS, LADDER_NEUTRAL, LADDER_WORK, LADDER_BYTES, MAX_QUANTA,
  MAX_DEBT_UNITS } from "./corrector.mjs";
import { assemble } from "../../tools/z80asm.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const SLOTS = argv.includes("--slots");
const pad = (s, n) => String(s).padEnd(n);

const PROFILES = [
  { tag: "decode only", cfg: { correctorBudget: false }, opt: {} },
  { tag: "decode + corrector, as-is", cfg: { correctorBudget: false }, opt: { correct: true } },
  { tag: "decode + corrector, time-pub replaced", cfg: { correctorBudget: true }, opt: { correct: true } },
  { tag: "…and the runtime protocol in the chain", cfg: { correctorBudget: true },
    opt: { correct: true, proto: true } },
  // The reserved command pad replaced by the code that actually does the job
  // (R15 §39.4 step 3). It needs more block positions than were reserved for
  // it, so the displaced reservation is reported and added back below.
  { tag: "…and the real PCM state consumer",
    cfg: { correctorBudget: true, command: true },
    opt: { correct: true, proto: true, command: true } },
];

// THE FOUR LIMITS, judged INDEPENDENTLY (R14 §37.4 step 4). One number over is a
// failure of that number, not an average of the four, and none of them is
// adjusted to make an image pass.
const verdict = (cfg, r, led) => {
  const rows = [
    ["worst slot", r.gen.placement.worst.workPct, cfg.workTarget * 100, "%"],
    ["mean", r.gen.placement.meanWorkPct, cfg.meanTarget * 100, "%"],
    ["code (finished estimate)", led.finished, led.region, " B"],
    ["RAM", cfg.ram.size, 0x2000, " B"],
  ];
  return rows.map(([what, got, limit, unit]) =>
    ({ what, got, limit, unit, ok: got <= limit + 1e-9 }));
};

for (const p of PROFILES) {
  const cfg = buildConfig({ voices: 2, complete: true, csm: true, levels: 15,
    workTarget: 0.839, ...p.cfg });
  const r = generateSplit(cfg, { stackFill: true, ...p.opt });
  console.log(`\n── ${p.tag} ──`);
  console.log(`   ${stampLine(cfg)}`);
  if (!r.ok) {
    // A refusal says WHERE, not just that. The stage names are the contract:
    // `place` ran out of slots before the next read, `laps` folded, `order`
    // came out in the wrong sequence, `ladders` had nowhere causal to go.
    console.log(`   NOT PLACED — stage "${r.stage}"`);
    if (r.stage === "place")
      console.log(`   ${r.walk.placed.length} of ${r.blocks.length} pieces placed;`
        + ` "${r.walk.failed.name}" (${r.walk.failed.cycles} cyc) had no slot before the next read`
        + ` (deadline ${r.walk.deadline})`);
    if (r.stage === "ladders")
      console.log(`   ${r.found} of ${r.want} ladder slots with ${r.need} cycles free in [${r.lo}, ${r.hi})`);
    if (r.stage === "ladder pad") console.log(`   slot ${r.slot} leaves ${r.rest} cycles of pad, ${r.want} needed`);
    if (r.stage === "pad") console.log(`   ${r.error}`);
    if (r.stage === "order") console.log(`   the emitted order is not the chain's order`);
    continue;
  }
  // AN IMAGE THAT OVERRUNS ITS REGION IS A MEASUREMENT, not a crash. The
  // generated source asserts `code_end <= $a00` and the assembler refuses it,
  // which is right — but the failure table has to say by HOW MUCH, so the size
  // is taken from a copy with that one assertion removed and the refusal is
  // reported as itself (R14 §37.4 step 5).
  const sizeOf = (text) => {
    const d = mkdtempSync(join(tmpdir(), "dac-split-"));
    try {
      const f = join(d, "e.z80"); writeFileSync(f, text);
      try { return { end: assemble(f).symbols.get("code_end"), refused: false }; }
      catch (e) {
        const f2 = join(d, "m.z80");
        writeFileSync(f2, text.replace(/^\s*assert\s+code_end.*$/m, ""));
        return { end: assemble(f2).symbols.get("code_end"), refused: true, why: e.message };
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  };
  const measured = sizeOf(r.gen.text);
  const bytes = measured.end;
  if (measured.refused)
    console.log(`   REFUSED     the assembler would not emit this image: it is`
      + ` ${bytes - cfg.ram.code[1]} B past the ${cfg.ram.code[1] - cfg.ram.code[0]} B region`);
  const region = cfg.ram.code[1] - cfg.ram.code[0];
  const owed = cfg.codeEstimate.reduce((t, [, b]) => t + b, 0);
  const rows = r.gen.placement.rows;
  const last = Math.max(...r.walk.placed.map((x) => x.absolute));

  console.log(`   pieces      ${r.blocks.length} in ${r.walk.laps} lap,`
    + ` last at slot ${last} of ${cfg.cycleSlots}, ${r.blocks.reduce((t, b) => t + b.cycles, 0)} cycles`);
  console.log(`   fixed work  worst ${r.gen.placement.worst.workPct}% (slot ${r.gen.placement.worst.slot}),`
    + ` mean ${r.gen.placement.meanWorkPct}%`
    + `  — ceiling ${(cfg.workTarget * 100).toFixed(1)}% / mean ${(cfg.meanTarget * 100).toFixed(1)}%`);
  console.log(`   BC carried  ${r.slotsPreserving} slots`);
  if (r.command?.length) {
    // WHAT THE CONSUMER REALLY COST, piece by piece, and what had to move out
    // of its way. The reservation it replaces is two block positions; the code
    // that does the job needs six, and the four extra ones were the YM/PSG
    // slot writer's. Those cycles are NOT forgiven — they are added back into
    // the verdict below, because an image that drops a reservation to make room
    // and then reports the result as a pass has measured the wrong engine.
    const perBlock = r.command.reduce((t, x) => t + x.cycles, 0);
    const blocks = cfg.cycleSlots / cfg.blockSamples;
    console.log(`   consumer    ${r.command.length} pieces at block positions`
      + ` ${CMD_SLOTS_USED.join(", ")}, ${perBlock} cyc a block = ${perBlock * blocks} a lap`);
    for (const x of r.command)
      console.log(`     ${pad(x.name, 22)}${String(x.cycles).padStart(5)} cyc`);
    console.log(`     ${pad("reserved for it", 22)}${String(145).padStart(5)} cyc a block`
      + ` (positions ${CMD_REPLACED.join(", ")})`);
    console.log(`     ${pad("displaced", 22)}${String(cmdDisplacedCycles()).padStart(5)} cyc a block`
      + ` = ${cmdDisplacedCycles() * blocks} a lap of the YM/PSG slot writer — STILL OWED`);
  }
  if (r.correct) {
    // The ladder is the only variable-length thing in the loop, so its three
    // numbers ARE the schedule's variability: what the neutral path costs, what
    // the slot has left when the ladder is at its shortest, and the interval.
    const worstRest = Math.min(...r.ladders.map((l) => l.restPad));
    const lo = Math.min(...r.ladders.map((l) => l.interval[0]));
    const hi = Math.max(...r.ladders.map((l) => l.interval[1]));
    console.log(`   ladders     ${CORR_SLOTS} at slots ${r.ladders.map((l) => l.absolute).join(", ")}`);
    console.log(`   neutral     ${LADDER_NEUTRAL} cyc each (${LADDER_WORK} charged as work,`
      + ` ${LADDER_NEUTRAL - LADDER_WORK} as pad), worst slot ${Math.max(...r.ladders.map((l) => l.strictPct))}%`
      + ` with the whole neutral run counted as work`);
    console.log(`   short path  ${worstRest} cyc of pad left at the tightest ladder slot (16 required)`);
    console.log(`   DAC interval ${lo}..${hi} cyc (nominal ${cfg.periodCycles}) — 342..375 is the limit`);
    console.log(`   capability  ${MAX_QUANTA} quanta = ${MAX_QUANTA * CORR.quantumCycles} cyc`
      + ` = ${MAX_QUANTA * CORR.quantumCycles * cfg.machine.z80Div} master an observation;`
      + ` debt limit ${MAX_DEBT_UNITS} units`);
  }
  console.log(`   settle      read → complete record ${r.gen.observer.settleMaster} master`
    + ` (${(r.gen.observer.settleMaster / cfg.machine.masterHz * 1000).toFixed(3)} ms)`);
  // The CSM test voice is scaffolding — a real engine receives a patch as
  // commands, not as boot code — so it is measured and separated rather than
  // quietly inflating the budget, exactly as the gate does it.
  // …and the ledger is taken from THAT image, not from this one. A CSM write
  // draws on its block's reservation, so the two images do not carry the same
  // amount of reserved padding: mixing `code_end` from one with the padding
  // from the other reports 357 B where the image has 437.
  const bare = (() => {
    const c2 = buildConfig({ voices: 2, complete: true, csm: false, levels: 15,
      workTarget: 0.839, ...p.cfg });
    const r2 = generateSplit(c2, { stackFill: true, ...p.opt });
    if (!r2.ok) return null;
    return { end: sizeOf(r2.gen.text).end, cfg: c2, gen: r2.gen };
  })();
  // THE FOUR TERMS, PRINTED SEPARATELY (R11 §31.1). The estimate is not added
  // to the image: the image already EXECUTES the unwritten features' cycles as
  // tagged padding, and the real feature replaces those bytes rather than
  // arriving on top of them.
  const led = bare ? codeLedger(bare.cfg, bare.gen, bare.end) : codeLedger(cfg, r.gen, bytes);
  console.log(`   code        ${led.engine} B engine of ${led.region} B`
    + (bare === null ? "" : ` (${bytes} B with the ${bytes - bare.end} B CSM test patch)`));
  console.log(`     ${pad("- reserved padding", 22)}${String(led.reserved).padStart(5)} B`
    + `  provisional: the real feature REPLACES these bytes`);
  console.log(`     ${pad("+ still owed", 22)}${String(led.owed).padStart(5)} B`);
  for (const [what, b] of cfg.codeEstimate)
    console.log(`     ${pad(`    ${what}`, 22)}${String(b).padStart(5)} B`);
  console.log(`     ${pad("= finished estimate", 22)}${String(led.finished).padStart(5)} B`
    + `  (${led.spare >= 0 ? `${led.spare} B spare` : `${-led.spare} B OVER`})`);
  const state = r.correct ? SPLIT_STATE_SIZE_CORR : SPLIT_STATE_SIZE;
  const V = verdict(cfg, r, led);
  // The displaced reservation, put back where the verdict can see it: the mean
  // the finished engine would run at is this image's plus the cycles that were
  // moved out of the way to make it emittable.
  if (r.command?.length) {
    const blocks = cfg.cycleSlots / cfg.blockSamples;
    const lapCycles = cfg.slotCycles.reduce((t, c) => t + c, 0) * (cfg.cycleSlots / cfg.groupSlots);
    const back = +(100 * cmdDisplacedCycles() * blocks / lapCycles).toFixed(1);
    V.splice(2, 0, { what: "mean + displaced reserve", got: +(V[1].got + back).toFixed(1),
      limit: cfg.meanTarget * 100, unit: "%",
      ok: V[1].got + back <= cfg.meanTarget * 100 + 1e-9 });
  }
  console.log(`   VERDICT     ${V.every((v) => v.ok) ? "inside every limit" : "OVER"}`);
  for (const v of V)
    console.log(`     ${pad(v.what, 26)}${String(v.got).padStart(7)}${v.unit}`
      + ` against ${v.limit}${v.unit}   ${v.ok ? "ok" : "OVER"}`);
  console.log(`   RAM         ${state} B of state in the ${cfg.ram.glob[1] - cfg.ram.glob[0]} B globals,`
    + ` phase table $${cfg.ram.phase[0].toString(16)}`
    + (r.correct ? `, ${CORR_SLOTS * LADDER_BYTES} B of ladder inside the code` : ""));
  if (SLOTS) {
    console.log(`   ${pad("slot", 5)}${pad("cyc", 5)}${pad("work", 6)}${pad("pad", 5)}${pad("%", 7)}what`);
    for (const row of rows)
      console.log(`   ${pad(row.slot, 5)}${pad(row.cycles, 5)}${pad(row.work, 6)}${pad(row.pad, 5)}`
        + `${pad(row.workPct, 7)}${row.what.slice(0, 100)}`);
  }
}
