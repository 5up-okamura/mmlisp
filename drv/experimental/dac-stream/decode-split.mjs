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
import { PHASE_TABLE } from "./observer.mjs";

// The split needs one more byte than the single-slot version: the phase itself
// has to live in RAM, because C cannot hold it across the whole sequence.
export const SPLIT_STATE = { known: 0, valid: 1, expect: 2, delta: 3,
  countLo: 4, countHi: 5, phase: 6 };
export const SPLIT_STATE_SIZE = 7;

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
                   op(`ld   (${S("countHi")}),a`, 13)]),
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
