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
import { buildConfig, stampLine, cmdBudgetCycles, CMD_SLOTS_USED,
  ymBudgetCycles, YM_CODE_BUDGET } from "./config.mjs";
import { ENTRY_BYTES, FORMS, asmBytes, YM_POSITIONS } from "./ym-writer.mjs";

// How many of the twenty opportunities the 120-byte reservation buys.
const YM_SITES = 10;
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
  // (R17 §43.3): the one-slot MAILBOX, one decision a lap, in the ten b9/b10
  // positions the reservation owns and nowhere else. No queue, no cursor, no
  // record pointer — and therefore no main BC anywhere in the chain.
  { tag: "…and the PCM state mailbox consumer",
    cfg: { correctorBudget: true, command: true },
    opt: { correct: true, proto: true, command: true } },
  // …and b11..b14's reserved pad replaced by the Z80 YM writer's own
  // instructions (R26 §59.3). Ten sites of eleven bytes and a cursor reload:
  // 113 of the 120 bytes the reservation owns, and 247 of the 280 cycles a
  // block. What it does NOT reach is four writes a block — see ym-writer.mjs.
  { tag: "…and the Z80 YM writer",
    cfg: { correctorBudget: true, command: true, ymWriter: true },
    opt: { correct: true, proto: true, command: true,
      ym: { sites: YM_SITES, base: 0x1e00 - YM_SITES * ENTRY_BYTES } } },
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
    // The consumer's own two refusals: no position left for a piece, or a BC
    // live range it would have destroyed (R16 §41.3).
    if (r.stage === "command") {
      console.log(`   the consumer needs ${r.pack.total} cycles a lap against the`
        + ` ${r.pack.budget} its ten b9/b10 positions reserve;`
        + ` "${r.pack.failed.name}" (${r.pack.failed.cycles} cyc) had no position left`);
      for (const [i, ps] of r.pack.at)
        if (ps.length) console.log(`     slot ${String(i).padStart(2)}`
          + `  ${String(r.pack.load.get(i)).padStart(3)} cyc   ${ps.map((x) => x.name).join(" + ")}`);
      for (const x of r.blocks)
        console.log(`     ${pad(x.name, 22)}${String(x.cycles).padStart(5)} cyc`
          + (x.edge ? "   pinned to the edge block" : ""));
    }
    if (r.stage === "command order")
      console.log(`   the comparison landed at slot ${r.firstCount} and the decode's`
        + ` \`count hi store\` at ${r.countAt}: the consumer would be comparing against`
        + ` last lap's observation number`);
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
    // WHAT THE CONSUMER REALLY COST, piece by piece, against the reservation it
    // is allowed to spend — b9 and b10 of every block and nothing else. R16
    // §41.1 holds b11..b14's YM/PSG cycles until the host-YM safe window of
    // §33.6 step 5 answers, so a shortfall here is a shortfall, not a loan.
    console.log(`   consumer    ${r.command.length} pieces at block positions`
      + ` ${CMD_SLOTS_USED.join(", ")} — ten positions a lap,`
      + ` ${r.pack.total} cyc against the ${r.pack.budget} reserved`
      + ` (${r.pack.total <= r.pack.budget ? `${r.pack.budget - r.pack.total} spare`
        : `${r.pack.total - r.pack.budget} OVER`})`);
    for (const [i, ps] of r.pack.at) {
      if (!ps.length) continue;
      console.log(`     slot ${String(i).padStart(2)}  ${String(r.pack.load.get(i)).padStart(3)} cyc`
        + `   ${ps.map((x) => `${x.name} (${x.cycles})`).join(" + ")}`);
    }
    if (r.pack.over.length)
      console.log(`     ${pad("past the ceiling", 22)}${r.pack.over.length} positions:`
        + ` ${r.pack.over.map((o) => `slot ${o.slot} ${o.cycles} of ${o.ceiling}`).join(", ")}`);
    console.log(`     ${pad("main BC", 22)}not used by any piece — nothing is dereferenced,`
      + ` so the decode's and the protocol's live ranges are untouched`);
    console.log(`     ${pad("compare after", 22)}slot ${r.walk.placed
      .find((x) => x.block.name === "count hi store").absolute} (\`count hi store\`),`
      + ` first at slot ${r.pack.firstCount}`);
    console.log(`     ${pad("stores pinned to", 22)}slots ${r.pack.pinned.join(", ")},`
      + ` inside the block whose edge (slot ${r.pack.edgeSlot}) is the last before the lap boundary`);
  }
  if (r.ym) {
    // WHAT THE WRITER REALLY COST, against the two numbers §59.6 grades it by.
    // The site is inline because it has to be, and its bytes are what decides
    // how many of the twenty opportunities the reservation can carry — the
    // shortfall is stated here rather than in prose.
    const all = YM_POSITIONS.length * (cfg.cycleSlots / cfg.blockSamples);
    console.log(`   YM writer   ${r.ym.sites} sites of ${all} opportunities,`
      + ` ${r.ym.siteBytes} B each + ${r.ym.resetBytes} B of cursor reload`
      + ` + ${r.ym.bootBytes} B of boot set-up`
      + ` = ${r.ym.bytes} B of the ${YM_CODE_BUDGET} reserved`
      + ` (${YM_CODE_BUDGET - r.ym.bytes} spare)`);
    console.log(`     ${pad("worst block", 22)}${r.ym.worstBlock} cyc of the`
      + ` ${ymBudgetCycles()} b11..b14 reserve`);
    console.log(`     ${pad("rate", 22)}${r.ym.writesPerLap} writes a lap`
      + ` = ${r.ym.writesPerSecond.toFixed(1)}/s`
      + ` — four a block would be ${(all * cfg.rateHz / cfg.cycleSlots).toFixed(1)}/s`);
    console.log(`     ${pad("four a block needs", 22)}${all * r.ym.siteBytes
      + r.ym.resetBytes + r.ym.bootBytes} B`
      + ` and ${YM_POSITIONS.length * FORMS[0].cycles} cyc a block — over BOTH reservations`);
    console.log(`     ${pad("sites at", 22)}${r.ym.at.join(", ")}`);
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
  // The consumer's own overspend, where the verdict can see it: the cycles it
  // takes beyond its reservation are cycles the lap did not have.
  if (r.command?.length && r.pack.total > r.pack.budget) {
    const lapCycles = cfg.slotCycles.reduce((t, c) => t + c, 0) * (cfg.cycleSlots / cfg.groupSlots);
    V.splice(2, 0, { what: "consumer against its reservation", got: r.pack.total,
      limit: r.pack.budget, unit: " cyc/lap", ok: false });
    void lapCycles;
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
