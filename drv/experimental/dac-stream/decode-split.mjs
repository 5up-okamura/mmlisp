// THE DECODE, CUT INTO PIECES THAT A COMPLETE 2ch SLOT CAN ACTUALLY HOLD
// (docs/dac-engine-implementation.md R7 §20.3, §20.4 step 3).
//
// §19 answered the placement question with a table of equal-length pieces
// measured against the minimum pad. R7 rejected that: the pieces have to be
// real instruction groups, assigned to concrete slots, carrying their
// intermediate state and their flag lifetimes with them, and each slot judged
// against the 79.6% target separately from the total. This is that version.
//
// WHAT SURVIVES A SLOT BOUNDARY in the complete 2ch engine, from the register
// contract the gate prints:
//
//   memory                  always
//   main BC                 only if the slot's pad is generated nops-only —
//                           the pad's own filler uses `inc bc` and `ld b,n`
//   the stack               `call mix_one` is balanced, so a pushed byte
//                           survives (unused here: 21 cycles a seam)
//   A and the flags         NEVER. mix_one runs in every slot and it is the
//                           sample path: `add`, `adc`, and A is the sample.
//
// So HL is not available (the play cursor), DE is not (the YM data port),
// IX/IY and the whole shadow set belong to the mixer. The table lookup is a
// self-modified absolute operand, every state byte is an absolute load or
// store, and every piece begins by getting a value into A and ends by putting
// it somewhere that survives. That is the inflation: 283 cycles in one P1 slot
// becomes 501 in pieces.
import { op } from "./schedule.mjs";
import { generate, DEAD_DEFAULT } from "./gen-stream.mjs";
import { PHASE_TABLE, decodeMap } from "./observer.mjs";

// The split needs one more byte than the single-slot version: the phase itself
// has to live in RAM, because C cannot hold it across the whole sequence.
export const SPLIT_STATE = { known: 0, valid: 1, expect: 2, delta: 3,
  countLo: 4, countHi: 5, phase: 6 };
export const SPLIT_STATE_SIZE = 7;

/**
 * The record, IN THE ORDER THE PIECES WRITE IT. Nothing is published over the
 * bus here — the instrument watches the Z80's writes to the globals page — so
 * this order is not a choice, it is what the placement produces: `valid` is
 * stored before `keep known`, and the two internal bytes (`phase`, `expect`)
 * are not part of a record at all.
 */
export const RECORD = ["valid", "known", "delta", "countLo", "countHi"];

/**
 * @param table  page-aligned phase table
 * @param state  base of the 7-byte state
 * @param step   this schedule's quantised advance
 */
export function splitBlocks({ table, state, step, hv = 0x7f09,
  units = PHASE_TABLE.quantised.units, unknown = PHASE_TABLE.quantised.unknown }) {
  const half = (units + 1) >> 1;
  const S = (k) => `$${(state + SPLIT_STATE[k]).toString(16)}`;
  const b = (name, ops) => ({ name, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) });
  // Both reductions and the carry fold are written as `add` + `sbc a,a`, never
  // as a branch: a balanced `jr` pair costs 19 or 26 in one piece, and no slot
  // has that much. `add a,256-n` sets carry exactly where `cp n` clears it,
  // which is the polarity a mask needs.
  return [
    b("read", [op(`ld   a,($${hv.toString(16)})`, 16, { what: "the observation instant" }),
               op("ld   (dec_lk+1),a", 13, { what: "index the table by modifying the operand" })]),
    b("lookup", [op(["dec_lk:", `ld   a,($${table.toString(16)})`], 13, { what: "the quantised phase" }),
                 op(`ld   (${S("phase")}),a`, 13)]),
    b("known", [op(`ld   a,(${S("phase")})`, 13), op(`cp   ${unknown}`, 7),
                op("sbc  a,a", 4), op("ld   b,a", 4, { what: "B = known" })]),
    b("valid", [op(`ld   a,(${S("known")})`, 13, { what: "…and the last reading" }),
                op("and  b", 4), op(`ld   (${S("valid")}),a`, 13)]),
    b("keep known", [op("ld   a,b", 4), op(`ld   (${S("known")}),a`, 13)]),
    b("expect", [op(`ld   a,(${S("expect")})`, 13), op("ld   b,a", 4)]),
    b("difference", [op(`ld   a,(${S("phase")})`, 13), op("sub  b", 4),
                     op("ld   b,a", 4, { what: "B = the raw difference" }),
                     op("sbc  a,a", 4, { what: "…and C its borrow, as a mask" }), op("ld   c,a", 4)]),
    b("reduce", [op("ld   a,c", 4), op(`and  ${units}`, 7), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("sign mask", [op("ld   a,b", 4), op(`add  a,${256 - half}`, 7), op("sbc  a,a", 4),
                    op(`and  ${units}`, 7), op("ld   c,a", 4)]),
    b("sign", [op("ld   a,b", 4), op("sub  c", 4), op("ld   b,a", 4)]),
    b("publish delta", [op(`ld   a,(${S("valid")})`, 13), op("and  b", 4),
                        op(`ld   (${S("delta")}),a`, 13)]),
    b("count lo", [op(`ld   a,(${S("countLo")})`, 13), op("add  a,1", 7), op("ld   b,a", 4)]),
    b("count store", [op("ld   a,b", 4), op(`ld   (${S("countLo")}),a`, 13)]),
    b("count wrap", [op(`ld   a,(${S("countLo")})`, 13), op("sub  1", 7),
                     op("sbc  a,a", 4, { what: "$ff exactly when the low byte wrapped" }), op("ld   b,a", 4)]),
    b("count hi", [op(`ld   a,(${S("countHi")})`, 13), op("sub  b", 4),
                   op(`ld   (${S("countHi")}),a`, 13, { what: "COUNT" })]),
    b("advance carry", [op(`ld   a,(${S("phase")})`, 13), op(`add  a,${step}`, 7),
                        op("sbc  a,a", 4), op("ld   c,a", 4)]),
    b("advance sum", [op(`ld   a,(${S("phase")})`, 13), op(`add  a,${step}`, 7), op("ld   b,a", 4)]),
    b("advance fold", [op("ld   a,c", 4), op(`and  ${256 % units}`, 7), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("advance mask", [op("ld   a,b", 4), op(`add  a,${256 - units}`, 7), op("sbc  a,a", 4),
                       op(`and  ${units}`, 7), op("ld   c,a", 4)]),
    b("advance", [op("ld   a,b", 4), op("sub  c", 4), op("ld   b,a", 4)]),
    b("publish expect", [op(`ld   a,(${S("known")})`, 13), op("and  b", 4),
                         op(`ld   (${S("expect")}),a`, 13)]),
  ];
}

/**
 * WHAT EACH PIECE LEAVES BEHIND, and therefore what the slots after it may not
 * destroy (R8 §23.3).
 *
 * `placeSplit()` used to subtract cycles and stop there, and the split selftest
 * clobbered only A and the flags. Both were wrong in the same way: BC crosses a
 * slot boundary only if nothing in between writes it, and the pad solver's
 * cheapest filler is `ld b,k` / `djnz $` — four bytes for any length — while
 * the RESERVED padding standing in for the unwritten 2ch features uses the
 * same. `known` in slot 6 and `valid` in slot 15 is nine slots of `ld b,n`
 * between a value being made in B and being read.
 *
 * The set is per piece and is the LIVE-OUT: what has to still be there when the
 * next piece runs. It is checked, not declared and trusted — the selftest
 * clobbers every register NOT named here between each pair.
 */
export const SPLIT_LIVE = [
  [],           // read           -> memory
  [],           // lookup         -> memory
  ["b"],        // known          B = the known mask
  ["b"],        // valid          B still holds it
  [],           // keep known
  ["b"],        // expect         B = the expected phase
  ["b", "c"],   // difference     B = raw difference, C = its borrow mask
  ["b"],        // reduce         B = reduced into 0..170
  ["b", "c"],   // sign mask      C = the correction
  ["b"],        // sign           B = the signed displacement
  [],           // publish delta
  ["b"],        // count lo
  [],           // count store
  ["b"],        // count wrap
  [],           // count hi
  ["c"],        // advance carry  C = the carry mask
  ["b", "c"],   // advance sum    B = the sum, C still the carry mask
  ["b"],        // advance fold
  ["b", "c"],   // advance mask
  ["b"],        // advance
  [],           // publish expect
];

/**
 * Which slots may not destroy BC, from a placement.
 *
 * A value made by the piece in slot p and read by the piece in slot q has to
 * survive the pad of every slot from p to q-1. Two pieces in the SAME slot have
 * no pad between them, so they constrain nothing.
 */
export function preserveBC(placed, live = SPLIT_LIVE) {
  // TWO answers a slot, not one. A slot's RESERVED padding — the cycles the
  // unwritten 2ch features are holding — runs BEFORE whatever piece the slot
  // carries, and the slot's own pad runs after it. So the question "may this
  // slot destroy BC" splits in half:
  //
  //   in   a value produced earlier is read HERE or later: the reserve may not
  //   out  a value produced here or earlier is read LATER: the pad may not
  //
  // Getting this wrong is not subtle and it is not loud either. `keep known`
  // landed in slot 16 behind `ld b,5 / djnz $`, so it stored a B that the
  // reserve had already zeroed, and every published record came out as the
  // boot state — with the DAC still perfect and every slot still inside its
  // budget.
  const liveIn = new Set(), liveOut = new Set();
  for (let k = 0; k + 1 < placed.length; k++) {
    if (!live[k]?.length) continue;
    const p = placed[k].slot, q = placed[k + 1].slot;
    for (let s = p; s < q; s++) liveOut.add(s);
    for (let s = p + 1; s <= q; s++) liveIn.add(s);
  }
  return { liveIn, liveOut, size: new Set([...liveIn, ...liveOut]).size };
}

/**
 * Walk the loop's slots from the read and put each piece in the next slot that
 * has room for it, at the target. Order is not negotiable — the pieces are one
 * dependent chain — so this is a walk, not a bin-pack.
 */
export function placeSplit(blocks, slots, { target = 0.796, from = 0 } = {}) {
  const head = slots.map((s) => target * s.cycles - s.row.work);
  const placed = [];
  let at = from, laps = 0;
  for (const blk of blocks) {
    let steps = 0;
    while (head[at % slots.length] < blk.cycles) {
      at++; steps++;
      if (steps > slots.length * 64) return { placed, failed: blk, laps: Infinity };
    }
    placed.push({ block: blk, slot: at % slots.length, lap: Math.floor(at / slots.length),
      headroom: head[at % slots.length] });
    head[at % slots.length] -= blk.cycles;      // a slot may hold more than one
    at++;
  }
  laps = placed.length ? placed.at(-1).lap + 1 : 0;
  return { placed, failed: null, laps };
}


/**
 * The whole thing as one image: the complete 2ch engine with the phase decode
 * distributed into its slots, the pads regenerated where BC has to survive, and
 * the calibrated table in the RAM the profile reserves for it.
 *
 * This is what R8 §23.3 asks for instead of an insertion arithmetic: the pads
 * are GENERATED, so a residual the solver cannot reach without `ld b,k` is a
 * failure here rather than a footnote, and the bytes are measured rather than
 * estimated.
 */
export function generateSplit(cfg, { target = cfg.workTarget, from = 0, step = null,
  stackFill = false } = {}) {
  const map = decodeMap(cfg);
  const state = map.state;
  if (state + SPLIT_STATE_SIZE > cfg.ram.glob[1])
    throw new Error("the split decoder's state does not fit in the globals");
  const advance = step ?? quantStepOf(cfg);
  const blocks = splitBlocks({ table: map.table, state, step: advance });
  const base = generate(cfg);
  const walk = placeSplit(blocks, base.slots, { target, from });
  if (walk.failed) return { ok: false, stage: "place", blocks, walk, map };
  const preserve = preserveBC(walk.placed);
  const bySlot = new Map();
  for (const p of walk.placed) {
    if (!bySlot.has(p.slot)) bySlot.set(p.slot, []);
    bySlot.get(p.slot).push(p.block);
  }
  // A slot carrying a value in BC loses `ld b,k`/`djnz $`, which is four bytes
  // for any wait. `stackFill` gives it `push af`/`pop af` instead — 21 cycles
  // in two bytes, balanced, touching only A, F and two bytes of stack.
  const keep = { dead: ["a"], stack: stackFill }, free = { dead: DEAD_DEFAULT };
  const slotDead = (i) => ({
    work: preserve.liveIn.has(i) ? keep : free,
    pad: preserve.liveOut.has(i) ? keep : free,
  });
  const boot = [
    `ld   hl,$${state.toString(16)}`,
    `ld   b,${SPLIT_STATE_SIZE}`,
    "splitinit:",
    "ld   (hl),0",
    "inc  l",
    "djnz splitinit",
  ];
  let gen;
  try {
    gen = generate(cfg, (i) => (bySlot.get(i) ?? []).flatMap((b) => b.ops), boot, slotDead);
  } catch (e) {
    // A slot whose residual is 1, 2, 3, 5, 6, 9 or 13 cycles has no exact fill
    // without `ld b,k`, and that is a real refusal, not a rounding.
    return { ok: false, stage: "pad", error: e.message, blocks, walk, preserve, map };
  }
  // The calibrated table travels in the image, in the page the profile reserved
  // — which in the 15-level map is the one the sixteenth level used to hold, so
  // it goes in BEFORE the fill up to the ring rather than after the image ends.
  const b = PHASE_TABLE.quantised.bytes;
  const table = [`        ds   $${map.table.toString(16)}-$, 0     ; the calibrated phase table`];
  for (let i = 0; i < 256; i += 16) table.push(`        db   ${b.slice(i, i + 16).join(",")}`);
  const ringFill = new RegExp(`^\\s*ds\\s+\\$${cfg.ram.ring[0].toString(16)}-\\$.*$`, "m");
  if (!ringFill.test(gen.text))
    throw new Error("the generated image has no fill up to the ring to put the table before");
  gen.text = gen.text.replace(ringFill, (m) => `${table.join("\n")}\n${m}`);
  // WHERE THE READ ACTUALLY FALLS, from the laid-out slots — the same rule the
  // single-slot observer follows. One read a loop, so the spacing is one
  // number, but it is taken from the schedule rather than named.
  // AT THE END OF THE READ, not at its start: the reading exists once the
  // instruction has completed, and that is also where the instrument stamps it.
  // Measuring the settle from the start instead put the prediction 16 cycles —
  // one VDP read — past what the machine reports, on every record.
  let at = null, elapsed = 0;
  for (const slot of gen.slots) {
    let inSlot = 0;
    for (const o of slot.ops) {
      inSlot += o.cycles;
      if (o.what === "the observation instant") { at = elapsed + inSlot; break; }
    }
    if (at !== null) break;
    elapsed += slot.cycles;
  }
  const loopCycles = gen.slots.reduce((t, s) => t + s.cycles, 0);
  // WHEN THE RECORD IS FINISHED, from the layout: the read, then the last
  // field's store. Predicted here so the machine can be asked to agree with it
  // rather than to define it.
  let settle = null, seen = 0;
  const lastField = RECORD.at(-1);
  for (const slot of gen.slots) {
    let inSlot = 0;
    for (const o of slot.ops) {
      inSlot += o.cycles;
      if (o.what === "COUNT") settle = seen + inSlot;
    }
    seen += slot.cycles;
  }
  gen.observer = {
    decode: true, reads: ["h"], every: 1, at: null, split: true,
    readOffsetCycles: [at], loopCycles,
    spacingCycles: [loopCycles],
    spacingMaster: [loopCycles * cfg.machine.z80Div],
    record: RECORD.map((n) => ({ name: n, offset: SPLIT_STATE[n] })),
    settleCycles: settle === null ? null : settle - at,
    settleMaster: settle === null ? null : (settle - at) * cfg.machine.z80Div,
    decodeCycles: blocks.reduce((t, b) => t + b.cycles, 0),
  };
  if (gen.observer.spacingMaster[0] !== loopMaster(cfg))
    throw new Error("the laid-out loop and the configured one disagree");
  return { ok: true, gen, blocks, walk, preserve, map, base,
    slotsPreserving: preserve.size, advance };
}

/**
 * This schedule's quantised advance for one read a LOOP.
 *
 * `cfg.slotCycles` is one GROUP — five slots, 1,792 cycles — and the unrolled
 * loop is `cycleSlots` of them. Taking the group for the loop put 147 units
 * here where the 80-slot loop advances 129, and because the reference walk used
 * the same constant the two agreed with each other while both disagreed with
 * the machine. The read interval has to come from the schedule that produces
 * it, which is the rule this file exists under.
 */
export function quantStepOf(cfg) {
  const unit = PHASE_TABLE.quantised.unit, units = PHASE_TABLE.quantised.units;
  const st = (loopMaster(cfg) % PHASE_TABLE.mode.lineMaster) / unit;
  if (!Number.isInteger(st))
    throw new Error(`this schedule's read advance is ${st} units — it needs the distributed steps`);
  return st % units;
}

/** The unrolled loop, in master clocks: every slot, not one group of them. */
export function loopMaster(cfg) {
  let total = 0;
  for (let i = 0; i < cfg.cycleSlots; i++) total += cfg.slotCycles[i % cfg.groupSlots];
  return total * cfg.machine.z80Div;
}
