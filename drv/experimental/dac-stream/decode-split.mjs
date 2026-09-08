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
import { CORR, CORR_SLOTS, LADDER_NEUTRAL, LADDER_WORK, correctorBlocks, correctorLive,
  ladderOps } from "./corrector.mjs";

// The split needs one more byte than the single-slot version: the phase itself
// has to live in RAM, because C cannot hold it across the whole sequence.
export const SPLIT_STATE = { known: 0, valid: 1, expect: 2, delta: 3,
  countLo: 4, countHi: 5, phase: 6,
  // …and the corrector's own, when there is one (corrector.mjs). `hi` holds the
  // gated debt while its sign is taken, which is what the nine-bit sum needs
  // and the eight-bit one did not (R10 §29.4).
  debt: 7, q: 8, rem: 9, hi: 10, kraw: 11 };
export const SPLIT_STATE_SIZE = 7;
export const SPLIT_STATE_SIZE_CORR = 12;

/**
 * The record, IN THE ORDER THE PIECES WRITE IT. Nothing is published over the
 * bus here — the instrument watches the Z80's writes to the globals page — so
 * this order is not a choice, it is what the placement produces: `valid` is
 * stored before `keep known`, and the two internal bytes (`phase`, `expect`)
 * are not part of a record at all.
 */
export const RECORD_FIELDS = ["known", "valid", "delta", "countLo", "countHi"];

/**
 * The record, IN THE ORDER THE PIECES WRITE IT — read out of the chain, not
 * declared next to it.
 *
 * Nothing is published over the bus: the instrument watches the Z80's writes to
 * the globals page, so the order is whatever the placement produces and the
 * completeness check compares against it. It used to be a constant, and the
 * corrector moved KNOWN: the raw mask now goes to a scratch byte and the
 * corrector's gate makes the single write, which is late in the chain rather
 * than sixth. A constant said the record was out of order 247 times out of 247
 * while the engine was correct (R10 §29.3).
 */
export function recordOrder(blocks, state) {
  const at = new Map(RECORD_FIELDS.map((n) => [`$${(state + SPLIT_STATE[n]).toString(16)}`, n]));
  const seen = [];
  for (const b of blocks)
    for (const o of b.ops) {
      const m = /^ld\s+\((\$[0-9a-f]+)\),a$/.exec(o.asm[0].trim());
      if (!m || !at.has(m[1])) continue;
      const name = at.get(m[1]);
      if (seen.includes(name))
        throw new Error(`the record's ${name} is written twice — the instrument sees a field too many`);
      seen.push(name);
    }
  if (seen.length !== RECORD_FIELDS.length)
    throw new Error(`the chain writes ${seen.length} of the record's ${RECORD_FIELDS.length} fields`);
  return seen;
}

/**
 * @param table  page-aligned phase table
 * @param state  base of the 7-byte state
 * @param step   this schedule's quantised advance
 */
export function splitBlocks({ table, state, step, hv = 0x7f09,
  units = PHASE_TABLE.quantised.units, unknown = PHASE_TABLE.quantised.unknown,
  // WHERE THIS OBSERVATION'S KNOWN IS PARKED. Without a corrector it goes
  // straight into the record's own byte. With one it does not: the corrector
  // may still clear KNOWN when the debt expires, and if the decode had already
  // written the record byte the instrument would see the field TWICE for one
  // observation — a record with a field too many, which is exactly what the
  // completeness check is there to refuse. So the raw mask goes to a scratch
  // byte and the corrector's gate makes the single write (R10 §29.3).
  knownTo = "known" }) {
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
                op("and  b", 4), op("ld   c,a", 4)]),
    b("valid store", [op("ld   a,c", 4), op(`ld   (${S("valid")}),a`, 13)]),
    b("keep known", [op("ld   a,b", 4), op(`ld   (${S(knownTo)}),a`, 13)]),
    b("expect", [op(`ld   a,(${S("expect")})`, 13), op("ld   b,a", 4)]),
    b("difference", [op(`ld   a,(${S("phase")})`, 13), op("sub  b", 4),
                     op("ld   b,a", 4, { what: "B = the raw difference" }),
                     op("sbc  a,a", 4, { what: "…and C its borrow, as a mask" }), op("ld   c,a", 4)]),
    b("reduce", [op("ld   a,c", 4), op(`and  ${units}`, 7), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("sign mask", [op("ld   a,b", 4), op(`add  a,${256 - half}`, 7), op("sbc  a,a", 4),
                    op(`and  ${units}`, 7), op("ld   c,a", 4)]),
    b("sign", [op("ld   a,b", 4), op("sub  c", 4), op("ld   b,a", 4)]),
    b("publish delta", [op(`ld   a,(${S("valid")})`, 13), op("and  b", 4), op("ld   c,a", 4)]),
    b("publish delta store", [op("ld   a,c", 4), op(`ld   (${S("delta")}),a`, 13)]),
    b("count lo", [op(`ld   a,(${S("countLo")})`, 13), op("add  a,1", 7), op("ld   b,a", 4)]),
    b("count store", [op("ld   a,b", 4), op(`ld   (${S("countLo")}),a`, 13)]),
    b("count wrap", [op(`ld   a,(${S("countLo")})`, 13), op("sub  1", 7),
                     op("sbc  a,a", 4, { what: "$ff exactly when the low byte wrapped" }), op("ld   b,a", 4)]),
    b("count hi", [op(`ld   a,(${S("countHi")})`, 13), op("sub  b", 4), op("ld   c,a", 4)]),
    b("count hi store", [op("ld   a,c", 4),
                         op(`ld   (${S("countHi")}),a`, 13, { what: "COUNT" })]),
    b("advance carry", [op(`ld   a,(${S("phase")})`, 13), op(`add  a,${step}`, 7),
                        op("sbc  a,a", 4), op("ld   c,a", 4)]),
    b("advance sum", [op(`ld   a,(${S("phase")})`, 13), op(`add  a,${step}`, 7), op("ld   b,a", 4)]),
    b("advance fold", [op("ld   a,c", 4), op(`and  ${256 % units}`, 7), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("advance mask", [op("ld   a,b", 4), op(`add  a,${256 - units}`, 7), op("sbc  a,a", 4),
                       op(`and  ${units}`, 7), op("ld   c,a", 4)]),
    b("advance", [op("ld   a,b", 4), op("sub  c", 4), op("ld   b,a", 4)]),
    b("publish expect", [op(`ld   a,(${S("known")})`, 13), op("and  b", 4), op("ld   c,a", 4)]),
    b("publish expect store", [op("ld   a,c", 4), op(`ld   (${S("expect")}),a`, 13)]),
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
  ["b", "c"],   // valid          B still holds it, C the value to store
  ["b"],        // valid store
  [],           // keep known
  ["b"],        // expect         B = the expected phase
  ["b", "c"],   // difference     B = raw difference, C = its borrow mask
  ["b"],        // reduce         B = reduced into 0..170
  ["b", "c"],   // sign mask      C = the correction
  ["b"],        // sign           B = the signed displacement
  ["c"],        // publish delta
  [],           // publish delta store
  ["b"],        // count lo
  [],           // count store
  ["b"],        // count wrap
  ["c"],        // count hi
  [],           // count hi store
  ["c"],        // advance carry  C = the carry mask
  ["b", "c"],   // advance sum    B = the sum, C still the carry mask
  ["b"],        // advance fold
  ["b", "c"],   // advance mask
  ["b"],        // advance
  ["c"],        // publish expect
  [],           // publish expect store
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
 * Walk the loop's slots from the read and place the chain, ONE OBSERVATION DEEP
 * (R10 §29.2).
 *
 * The version this replaces did two things it was never entitled to do. It
 * advanced past a slot after every piece, so two pieces could never share one
 * even when both fitted; and when it ran out of slots it kept walking `at % 80`
 * into a second and third lap, folding those pieces back onto the same physical
 * slots. A piece placed on lap 2 and slot 26 is emitted BEFORE the lap-1 piece
 * in slot 27 — the chain runs out of order and the report says 64 of 75 placed.
 *
 * So the deadline is explicit and absolute: the chain has from this read to the
 * next one, `from` to `from + cycleSlots`, and reaching it is a failure rather
 * than a wrap. Success means `laps === 1`, checked rather than assumed.
 *
 * Two pieces in one slot are fine and needed: there is no pad between them, so
 * A, the flags and BC all survive from one to the next, and the only cost is
 * the slot's own headroom.
 */
export function placeSplit(blocks, slots, { target = 0.796, from = 0,
  cycleSlots = slots.length } = {}) {
  const n = slots.length;
  const head = slots.map((s) => target * s.cycles - s.row.work);
  const limit = from + cycleSlots;                  // the next read, exclusive
  const placed = [];
  let at = from;
  for (const blk of blocks) {
    while (at < limit && head[at % n] < blk.cycles) at++;
    if (at >= limit)
      return { placed, failed: blk, laps: Infinity, deadline: limit, at, head };
    placed.push({ block: blk, slot: at % n, lap: Math.floor((at - from) / n), absolute: at,
      headroom: head[at % n] });
    head[at % n] -= blk.cycles;
    // …and NOT `at++`: the next piece gets the same slot if it still fits.
  }
  const laps = placed.length ? placed.at(-1).lap + 1 : 1;
  return { placed, failed: null, laps, deadline: limit, at, head };
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
  stackFill = false, correct = false, maxQuanta = null, ladderLate = false,
  // WHERE THE OBSERVATION COUNTER STARTS. Zero everywhere except in the test
  // that has to see it wrap: 65,536 observations is 8.7 minutes of run time and
  // R11 §31.2 asks for the wrap to be REACHED, not waited for. It is a boot
  // constant, so the image is the image under test with one immediate changed.
  countFrom = 0 } = {}) {
  const map = decodeMap(cfg);
  const state = map.state;
  const stateSize = correct ? SPLIT_STATE_SIZE_CORR : SPLIT_STATE_SIZE;
  if (state + stateSize > cfg.ram.glob[1])
    throw new Error("the split decoder's state does not fit in the globals");
  const advance = step ?? quantStepOf(cfg);
  const decode = splitBlocks({ table: map.table, state, step: advance,
    knownTo: correct ? "kraw" : "known" });
  // THE CORRECTOR GOES IN THE CHAIN, after DELTA and VALID have settled and
  // before the phase the next expectation is built from is read (R9 §26.4).
  // AFTER the counter, not straight after the displacement: both positions
  // satisfy "DELTA and VALID have settled, the next EXPECT's basis has not",
  // and the earlier one puts 42 pieces in front of the counter's 28-cycle ones,
  // which then have no slot left to go in.
  const AFTER = decode.findIndex((b) => b.name === "count hi store") + 1;
  const S = (n) => `$${(state + SPLIT_STATE[n]).toString(16)}`;
  const tags = correct
    ? [["a0", "a1", "a2", "a3"], ["b0", "b1"], ["c0"]] : null;
  const qopt = maxQuanta === null ? {} : { maxQuanta };
  const corr = correct ? correctorBlocks(S, tags, qopt) : [];
  const blocks = correct
    ? [...decode.slice(0, AFTER), ...corr, ...decode.slice(AFTER)] : decode;
  const live = correct
    ? [...SPLIT_LIVE.slice(0, AFTER), ...correctorLive(tags, qopt), ...SPLIT_LIVE.slice(AFTER)]
    : SPLIT_LIVE;
  const RECORD = recordOrder(blocks, state);
  const base = generate(cfg);
  const walk = placeSplit(blocks, base.slots, { target, from, cycleSlots: cfg.cycleSlots });
  if (walk.failed) return { ok: false, stage: "place", blocks, walk, map, correct };
  if (walk.laps !== 1)
    return { ok: false, stage: "laps", blocks, walk, map, correct, laps: walk.laps };
  const preserve = preserveBC(walk.placed, live);
  const bySlot = new Map();
  for (const p of walk.placed) {
    if (!bySlot.has(p.slot)) bySlot.set(p.slot, []);
    bySlot.get(p.slot).push(p.block);
  }
  // THE ORDER THE CODE WILL RUN IN, read back out of the placement rather than
  // trusted. Pieces are emitted slot by slot, in the order they were placed
  // inside each one, so this has to come back as the input chain — and when the
  // walk was folding onto a second lap it did not.
  const emitted = [...bySlot.keys()].sort((a, b) => a - b)
    .flatMap((i) => bySlot.get(i).map((b) => b.name));
  if (emitted.join("|") !== blocks.map((b) => b.name).join("|"))
    return { ok: false, stage: "order", blocks, walk, map, correct, emitted };
  // THE LADDERS. They are the only thing that is not part of the chain: each is
  // a `jp` (work) into a run of nops (pad), and one loop's seven all carry the
  // SAME observation's decision.
  //
  // R10 §29.3: they used to be placed before the first ladder write, which ran
  // the value the previous observation had decided while EXPECT was updated
  // with this one's — the correction and the expectation it is supposed to
  // cancel were one observation apart, and the piece-level test could not see
  // it because it does not include the ladders or the next read. The window is
  // now AFTER the last write and BEFORE the next read, so the decision, the
  // writes, the executions and EXPECT all close inside one observation.
  let ladders = [];
  if (correct) {
    const writes = walk.placed.filter((p) => p.block.name.startsWith("corr write"));
    const lastWrite = Math.max(...writes.map((p) => p.absolute));
    const firstWrite = Math.min(...writes.map((p) => p.absolute));
    // `corr-one-late` is the fault this window exists to refuse: the old
    // placement, kept only so the integration test can fail on it.
    const lo = ladderLate ? from : lastWrite, hi = ladderLate ? firstWrite : walk.deadline;
    const head = base.slots.map((s, i) => ({ i, head: target * s.cycles - s.row.work }));
    for (const p of walk.placed) head[p.slot].head -= p.block.cycles;
    // THE LADDER'S NOPS ARE PAD, and its `jp` is the only work it adds (R10
    // §29.5): the nops are the clock itself, not a feature's cost, and the
    // slot's length on the neutral path is unchanged because the ladder
    // replaces pad that was already there. So what the ceiling has to hold is
    // the `jp`, and the shortened path is checked separately below.
    const window = [];
    for (let a = lo; a < hi; a++) {
      const h = head[a % base.slots.length];
      if (h.head >= LADDER_WORK) window.push({ ...h, absolute: a });
    }
    const room = window.sort((x, y) => y.head - x.head).slice(0, CORR_SLOTS);
    if (room.length < CORR_SLOTS)
      return { ok: false, stage: "ladders", blocks, walk, map, correct,
        need: LADDER_WORK, found: room.length, want: CORR_SLOTS, lo, hi,
        headroom: head.map((h) => +h.head.toFixed(1)) };
    ladders = tags.flat().map((tag, k) => ({ tag, slot: room[k].i, absolute: room[k].absolute }));
    ladders.sort((x, y) => x.absolute - y.absolute);
    // …and the pad each one leaves behind, on the shortened path.
    for (const l of ladders) {
      const slot = base.slots[l.slot];
      const used = slot.row.work + (bySlot.get(l.slot) ?? []).reduce((t, b) => t + b.cycles, 0);
      const rest = slot.cycles - used - LADDER_NEUTRAL;
      l.restPad = rest;
      l.strictPct = +(100 * (used + LADDER_NEUTRAL) / slot.cycles).toFixed(1);
      // The DAC interval this slot can produce, end to end: the ladder is the
      // only thing in the loop whose length is not fixed, so these two numbers
      // are the whole of the schedule's variability.
      l.interval = [slot.cycles - CORR.neutral * CORR.quantumCycles,
        slot.cycles + (CORR.ladderNops - CORR.neutral) * CORR.quantumCycles];
      if (rest < 16)
        return { ok: false, stage: "ladder pad", blocks, walk, map, correct, ladders,
          slot: l.slot, rest, want: 16 };
    }
    // The ladder has to be after every write and before the next read, which is
    // the causal order R10 §29.3 fixes. Checked here rather than argued from
    // the window, because the window is the thing that could be wrong.
    const expect = walk.placed.find((p) => p.block.name === "publish expect store");
    for (const l of ladders) {
      if (!ladderLate && (l.absolute < lastWrite || l.absolute >= walk.deadline))
        return { ok: false, stage: "ladder order", blocks, walk, map, correct, ladders,
          tag: l.tag, at: l.absolute, lastWrite, deadline: walk.deadline };
    }
    if (expect && expect.absolute < lastWrite)
      return { ok: false, stage: "expect order", blocks, walk, map, correct,
        expect: expect.absolute, lastWrite };
  }
  const ladderAt = new Map(ladders.map((l) => [l.slot, l.tag]));
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
    `ld   b,${stateSize}`,
    "splitinit:",
    "ld   (hl),0",
    "inc  l",
    "djnz splitinit",
    // The ladders start NEUTRAL, so the first loop — before any observation has
    // been made — corrects nothing.
    ...(correct ? [`ld   a,${CORR.neutral}`,
      ...tags.flat().map((t) => `ld   (corr_${t}+1),a`)] : []),
    ...(countFrom ? [
      `ld   a,${countFrom & 0xff}`,
      `ld   ($${(state + SPLIT_STATE.countLo).toString(16)}),a`,
      `ld   a,${(countFrom >> 8) & 0xff}`,
      `ld   ($${(state + SPLIT_STATE.countHi).toString(16)}),a`,
    ] : []),
  ];
  let gen;
  try {
    gen = generate(cfg, (i) => [
      ...(bySlot.get(i) ?? []).flatMap((b) => b.ops),
      ...(ladderAt.has(i) ? ladderOps(ladderAt.get(i)) : []),
    ], boot, slotDead);
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
  const lastAddr = `ld   ($${(state + SPLIT_STATE[RECORD.at(-1)]).toString(16)}),a`;
  for (const slot of gen.slots) {
    let inSlot = 0;
    for (const o of slot.ops) {
      inSlot += o.cycles;
      if (o.asm[0].trim() === lastAddr.trim()) settle = seen + inSlot;
    }
    seen += slot.cycles;
  }
  if (settle === null) throw new Error("the record's last field is not written in the loop");
  gen.observer = {
    decode: true, reads: ["h"], every: 1, at: null, split: true,
    readOffsetCycles: [at], loopCycles,
    spacingCycles: [loopCycles],
    spacingMaster: [loopCycles * cfg.machine.z80Div],
    record: RECORD.map((n) => ({ name: n, offset: SPLIT_STATE[n] })),
    countFrom,
    settleCycles: settle === null ? null : settle - at,
    settleMaster: settle === null ? null : (settle - at) * cfg.machine.z80Div,
    decodeCycles: blocks.reduce((t, b) => t + b.cycles, 0),
  };
  if (gen.observer.spacingMaster[0] !== loopMaster(cfg))
    throw new Error("the laid-out loop and the configured one disagree");
  return { ok: true, gen, blocks, walk, preserve, map, base, correct, ladders,
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
