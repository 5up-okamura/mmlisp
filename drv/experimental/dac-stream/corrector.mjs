// THE BOUNDED CORRECTOR (docs/dac-engine-implementation.md R9 §26.4).
//
// What it is for, stated narrowly: to return to WHATEVER relative phase the
// engine happened to start at, smoothly, after a short stop. It is not a shared
// clock with the 68000, it publishes no transfer window, and passing here does
// not mean the host knows when it may take the bus.
//
// ── how a slot is made shorter or longer ──────────────────────────────────
// A slot's length is exact by construction, so a correction cannot be a
// subtraction — it has to be an instruction sequence whose length varies by a
// known amount. That is a LADDER: a run of `nop`s entered at a computed point.
//
//        jp   corr_k          <- the operand byte is self-modified
//   e0:  nop                     entering here runs 8 nops  = +16 cycles
//   e1:  nop
//   ...                          entering at e4 runs 4 nops = the NEUTRAL point
//   e8:  <the rest of the pad>    entering here runs none    = -16 cycles
//
// So one byte, written once per observation, moves that slot's DAC interval by
// -16..+16 cycles in steps of 4. Four cycles is the quantum because it is 60
// master and the phase table's unit is 20: a quantum is exactly three units,
// and no rounding enters the loop through the correction itself.
//
// SEVEN slots carry a ladder, which is where the 112-cycle-per-observation
// capability comes from. They do not all get the same value: with one shared
// value the total is a multiple of seven quanta, the steady-state residual is
// 21 units = 420 master, and R9 §26.5 asks for under 60. So they are grouped
// 4 + 2 + 1 and driven by three values a, b, c with |.| <= 4:
//
//        applied = 4a + 2b + c,  every integer in -28..28 reachable
//
// which is one quantum of resolution — 60 master — with three bytes to write.
import { op } from "./schedule.mjs";

export const CORR = {
  quantumCycles: 4,        // = 60 master = 3 phase-table units
  unitsPerQuantum: 3,
  maxQuantaPerSlot: 4,     // |16| cycles in one DAC interval
  groups: [4, 2, 1],       // how many slots share each of the three values
  ladderNops: 8,           // -4..+4 quanta
  neutral: 4,              // the entry that costs nothing
};
export const CORR_SLOTS = CORR.groups.reduce((a, b) => a + b, 0);
export const MAX_QUANTA = CORR.groups.reduce((t, g) => t + g * CORR.maxQuantaPerSlot, 0);

/**
 * Ways to break the corrector on purpose (R9 §26.5-5). Each one is a plausible
 * implementation, not a scribble: they are the mistakes the arithmetic invites,
 * and the checks have to fail on every one of them or they are not checks.
 */
export const CORR_FAULTS = {
  "corr-sign": "the ladders are driven the wrong way round, so a correction adds to the debt",
  "corr-double": "each quantum is applied twice — the debt is repaid once and the schedule moved twice",
  "corr-no-fold": "the correction is not taken off the phase the next expectation is built from",
  "corr-saturate": "a debt past the capability is clamped and carried instead of expiring",
};

/** The reference: what the corrector decides, in JavaScript. */
export const splitQuanta = (q) => {
  const clamp = (x) => Math.max(-CORR.maxQuantaPerSlot, Math.min(CORR.maxQuantaPerSlot, x));
  const shr = (x, n) => Math.floor(x / (1 << n));      // arithmetic, toward -inf
  const a = clamp(shr(q, 2));
  const r = q - 4 * a;
  const b = clamp(shr(r, 1));
  const c = r - 2 * b;
  return { a, b, c, applied: 4 * a + 2 * b + c };
};

/**
 * One observation of the corrector.
 *
 * `debt` is signed and in phase units: how far the engine has drifted from the
 * phase it is trying to hold. A VALID displacement is added to it; an invalid
 * one is zero, so an unknown reading contributes nothing rather than being
 * special-cased here.
 *
 * The quanta to apply are (debt+1) >> 2, not debt/3. Dividing by three costs
 * more than the loop gain is worth: a gain of 3/4 converges in a few
 * observations and, because of the +1, leaves a residual of at most 2 units =
 * 40 master, under the 60 master R9 §26.5 asks for. Each applied quantum takes
 * three units off the debt, so the 1-2 unit remainder is KEPT rather than
 * rounded into a correction pulse every time.
 */
export function refCorrect(prev, delta, { expire = false, maxQuanta = MAX_QUANTA } = {}) {
  if (expire) return { debt: 0, q: 0, a: 0, b: 0, c: 0, applied: 0, expired: true };
  const raw = (prev.debt + delta) << 24 >> 24;          // signed byte
  const q = (raw + 1) >> 2;
  // Beyond the capability the debt is DISCARDED and the acquisition is dropped
  // — not saturated and carried, which would cap the correction quietly and
  // leave the engine claiming a phase it is not holding (R9 §26.4).
  if (Math.abs(q) > maxQuanta)
    return { debt: 0, q: 0, a: 0, b: 0, c: 0, applied: 0, expired: true };
  const { a, b, c, applied } = splitQuanta(q);
  return { debt: (raw - CORR.unitsPerQuantum * applied) << 24 >> 24,
    q, a, b, c, applied, expired: false };
}

export const INITIAL_CORR = { debt: 0, q: 0, a: 0, b: 0, c: 0, applied: 0, expired: false };

/**
 * The ladder a correction slot carries, as ONE op.
 *
 * Its COST is the neutral path — the `jp` plus the four nops an uncorrected
 * observation runs — because that is what the slot's arithmetic has to close
 * on. The other four nops are emitted but not executed on that path, so
 * counting the whole emitted run would make the slot's length wrong by 16
 * cycles. R9 §26.4 asks for the normal path to be inside the ceiling, and this
 * is what puts it there to be judged.
 */
export const LADDER_NEUTRAL = 10 + CORR.neutral * CORR.quantumCycles;
export const LADDER_BYTES = 3 + CORR.ladderNops;

export function ladderOps(tag) {
  const asm = [`corr_${tag}:`, `jp   corr_${tag}_e${CORR.neutral}`];
  for (let i = 0; i < CORR.ladderNops; i++) asm.push(`corr_${tag}_e${i}:`, "nop");
  asm.push(`corr_${tag}_e${CORR.ladderNops}:`);
  return [op(asm, LADDER_NEUTRAL, { what: `correction ladder ${tag}`, ladder: tag })];
}


/**
 * The corrector, as the Z80 runs it: pieces of at most 24 cycles, carrying
 * their intermediates in B and C, with A and the flags dying at every slot
 * boundary — the same discipline as the decode (decode-split.mjs).
 *
 * @param S      (name) => the asm address of that state byte
 * @param tags   the ladder tags, grouped [[4],[2],[1]]
 */
export function correctorBlocks(S, tags, { maxQuanta = MAX_QUANTA, fault = null } = {}) {
  if (fault && !CORR_FAULTS[fault]) throw new Error(`unknown corrector fault ${fault}`);
  const blocks = correctorShape(S, tags, maxQuanta);
  if (!fault) return blocks;
  // `corr-no-fold` DELETES the phase fold, which is the one R9 §26.4 names: an
  // implementation that forgets it sees its own correction come back as a
  // displacement of the opposite sign at the next observation.
  if (fault === "corr-no-fold")
    return blocks.filter((b) => !b.name.startsWith("corr phase"));
  return blocks.map((b) => {
    if (fault === "corr-sign" && b.name === "corr a bias")
      return patch(b, "add  a,4", ["neg", "add  a,4"], 4);
    if (fault === "corr-double" && b.name === "corr 3q")
      return patch(b, "add  a,c", ["add  a,c"], 0, true);
    if (fault === "corr-saturate" && b.name === "corr live mask")
      return patch(b, "sbc  a,a", ["ld   a,255"], 3);
    return b;
  });
}

/** Replace one instruction inside a block, keeping the block's shape honest. */
function patch(b, find, repl, extra, append = false) {
  const ops = [];
  for (const o of b.ops) {
    if (o.asm[0].trim().startsWith(find)) {
      if (append) { ops.push(o); ops.push(op(repl[0], 4)); continue; }
      for (const r of repl) ops.push(op(r, r.startsWith("neg") ? 8 : o.cycles));
      continue;
    }
    ops.push(o);
  }
  return { ...b, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) };
}

function correctorShape(S, tags, maxQuanta) {
  // WHY THERE ARE TWO SHAPES. With |q| <= 16 the split needs no clamp at all:
  // q >> 2 is already inside -4..4, and the remainder q & 3 is 0..3, so b and c
  // fall out of two masks. Above that, a and b both have to be saturated, which
  // is eleven more pieces and about 170 more cycles — and the pieces are what
  // there is no room for. The spec's 28 quanta is the default; the 16-quantum
  // shape is offered as a measurement, not chosen here.
  if (maxQuanta <= 16) return correctorBlocksNarrow(S, tags);
  return correctorBlocksWide(S, tags);
}

/**
 * The expiry, which is NOT a saturation (R9 §26.4: "補正能力を超えた債務は飽和して
 * 継続せず失効にする").
 *
 * Clamping the split would quietly cap the correction and carry the rest of the
 * debt forward for ever, which is a slow silent lie about the phase. Instead a
 * debt the corrector cannot repay throws the debt away, leaves the ladders
 * neutral, and clears KNOWN — so the next reading is a base, not a difference,
 * and the engine is openly at a NEW relative phase rather than pretending to
 * return to the old one.
 *
 * The test is one unsigned range check: q + max is 0..2max exactly when q is
 * -max..max.
 */
function expiryBlocks(S, b, max) {
  return [
    b("corr live", [op("ld   a,b", 4), op(`add  a,${max}`, 7), op("ld   c,a", 4)]),
    b("corr live mask", [op("ld   a,c", 4), op(`cp   ${2 * max + 1}`, 7),
      op("sbc  a,a", 4), op("ld   c,a", 4)]),
    b("corr gate q", [op("ld   a,b", 4), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr q keep", [op("ld   a,b", 4), op(`ld   (${S("q")}),a`, 13)]),
    b("corr gate debt", [op(`ld   a,(${S("debt")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr gate debt keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    b("corr gate known", [op(`ld   a,(${S("known")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr gate known keep", [op("ld   a,b", 4), op(`ld   (${S("known")}),a`, 13)]),
    b("corr reload q", [op(`ld   a,(${S("q")})`, 13), op("ld   b,a", 4)]),
  ];
}

const EXPIRY_LIVE = [["b", "c"], ["b", "c"], ["b", "c"], ["c"], ["b", "c"], ["c"],
  ["b", "c"], [], ["b"]];

function correctorBlocksNarrow(S, tags) {
  const b = (name, ops) => ({ name, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) });
  return [
    b("corr valid", [op(`ld   a,(${S("valid")})`, 13), op("ld   c,a", 4)]),
    b("corr debt", [op(`ld   a,(${S("debt")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr add", [op(`ld   a,(${S("delta")})`, 13), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("corr keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    b("corr q hi", [op("ld   a,b", 4), op("inc  a", 4), op("sra  a", 8), op("ld   b,a", 4)]),
    b("corr q", [op("ld   a,b", 4), op("sra  a", 8), op("ld   b,a", 4)]),
    ...expiryBlocks(S, b, 16),
    b("corr a shift", [op("ld   a,b", 4), op("sra  a", 8), op("sra  a", 8), op("ld   c,a", 4)]),
    b("corr a bias", [op("ld   a,c", 4), op("add  a,4", 7), op("ld   b,a", 4)]),
    ...tags[0].map((t, i) => b(`corr write a${i}`,
      [op("ld   a,b", 4), op(`ld   (corr_${t}+1),a`, 13, { what: `set ladder ${t}` })])),
    b("corr rem", [op(`ld   a,(${S("q")})`, 13), op("and  3", 7), op("ld   c,a", 4)]),
    b("corr b bit", [op("ld   a,c", 4), op("rrca", 4), op("and  1", 7), op("ld   b,a", 4)]),
    b("corr b bias", [op("ld   a,b", 4), op("add  a,4", 7), op("ld   b,a", 4)]),
    ...tags[1].map((t, i) => b(`corr write b${i}`,
      [op("ld   a,b", 4), op(`ld   (corr_${t}+1),a`, 13, { what: `set ladder ${t}` })])),
    b("corr c bias", [op("ld   a,c", 4), op("and  1", 7), op("add  a,4", 7), op("ld   b,a", 4)]),
    ...tags[2].map((t, i) => b(`corr write c${i}`,
      [op("ld   a,b", 4), op(`ld   (corr_${t}+1),a`, 13, { what: `set ladder ${t}` })])),
    b("corr 3q lo", [op(`ld   a,(${S("q")})`, 13), op("ld   c,a", 4)]),
    b("corr 3q", [op("ld   a,c", 4), op("add  a,c", 4), op("add  a,c", 4), op("ld   c,a", 4)]),
    b("corr repay", [op(`ld   a,(${S("debt")})`, 13), op("sub  c", 4), op("ld   b,a", 4)]),
    b("corr repay keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    ...phaseFold(S, b),
  ];
}

/**
 * Take the correction off the phase the next expectation is built from.
 *
 * The subtlety, which cost a round: `phase - 3q` is -84..254 and a BYTE cannot
 * tell those apart. 130 is a perfectly good positive phase and also has bit 7
 * set, so testing the sign bit reduced it as if it were negative and turned it
 * into 45. What disambiguates it is the sign of 3q, which is unambiguous
 * because |3q| <= 84:
 *
 *   3q >= 0  ->  the result is -84..170, so a byte above 170 is negative: +171
 *   3q <  0  ->  the result is 0..254,  so a byte above 170 is over the line: -171
 *
 * Both cases are "byte > 170"; only the direction differs, and -171 is +85 in
 * eight bits. So the correction is a mask AND a selector, and no branch.
 */
function phaseFold(S, b) {
  return [
    b("corr phase", [op(`ld   a,(${S("phase")})`, 13), op("sub  c", 4), op("ld   b,a", 4)]),
    b("corr fold sign", [op("ld   a,c", 4), op("add  a,a", 4), op("sbc  a,a", 4),
      op("and  254", 7), op("ld   c,a", 4)]),
    b("corr fold pick", [op("ld   a,c", 4), op("xor  171", 7), op(`ld   (${S("rem")}),a`, 13)]),
    b("corr fold need", [op("ld   a,b", 4), op("sub  171", 7), op("sbc  a,a", 4),
      op("cpl", 4), op("ld   c,a", 4)]),
    b("corr fold mask", [op(`ld   a,(${S("rem")})`, 13), op("and  c", 4), op("ld   c,a", 4)]),
    b("corr phase keep", [op("ld   a,b", 4), op("add  a,c", 4), op(`ld   (${S("phase")}),a`, 13)]),
  ];
}

function correctorBlocksWide(S, tags) {
  const b = (name, ops) => ({ name, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) });
  // max(x, 0) for a signed byte in C, leaving it in `dst`. The sign bit is
  // moved into carry by `add a,a` and `sbc a,a` turns it into a mask — no
  // branch, so the piece has one length.
  const maxZero = (dst) => [op("ld   a,c", 4), op("add  a,a", 4), op("sbc  a,a", 4),
    op("cpl", 4), op("and  c", 4), op(`ld   ${dst},a`, 4)];
  const flat = tags.flat();
  return [
    // The debt is DISCARDED when the difference is not valid: an unknown
    // reading, a re-acquisition or a restart leaves nothing to repay, and the
    // next known value is a new relative basis rather than a return to the old
    // phase (R9 §26.4).
    b("corr valid", [op(`ld   a,(${S("valid")})`, 13), op("ld   c,a", 4)]),
    b("corr debt", [op(`ld   a,(${S("debt")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr add", [op(`ld   a,(${S("delta")})`, 13), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("corr keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    // q = (debt + 1) >> 2, arithmetic. A gain of 3/4 rather than a division by
    // three: it converges in at most five observations and leaves at most two
    // units — 40 master — where dividing costs far more than that is worth.
    b("corr q hi", [op("ld   a,b", 4), op("inc  a", 4), op("sra  a", 8), op("ld   b,a", 4)]),
    b("corr q", [op("ld   a,b", 4), op("sra  a", 8), op("ld   b,a", 4)]),
    ...expiryBlocks(S, b, MAX_QUANTA),
    // a = clamp(q >> 2, -4, 4), carried as the ladder operand a+4 in 0..8.
    b("corr a shift", [op("ld   a,b", 4), op("sra  a", 8), op("sra  a", 8), op("ld   c,a", 4)]),
    b("corr a bias", [op("ld   a,c", 4), op("add  a,4", 7), op("ld   c,a", 4)]),
    b("corr a floor", maxZero("b")),
    b("corr a over", [op("ld   a,b", 4), op("sub  8", 7), op("ld   c,a", 4)]),
    b("corr a excess", maxZero("c")),
    b("corr a ceil", [op("ld   a,b", 4), op("sub  c", 4), op("ld   b,a", 4)]),
    ...tags[0].map((t, i) => b(`corr write a${i}`,
      [op("ld   a,b", 4), op(`ld   (corr_${t}+1),a`, 13, { what: `set ladder ${t}` })])),
    // r = q - 4a, carried biased by 16 so it stays a plain byte.
    b("corr 4a", [op("ld   a,b", 4), op("add  a,a", 4), op("add  a,a", 4), op("ld   c,a", 4)]),
    b("corr r part", [op(`ld   a,(${S("q")})`, 13), op("sub  c", 4), op("ld   c,a", 4)]),
    b("corr r", [op("ld   a,c", 4), op("add  a,16", 7), op("ld   c,a", 4)]),
    b("corr r keep", [op("ld   a,c", 4), op(`ld   (${S("rem")}),a`, 13)]),
    // b = clamp(r >> 1, -4, 4), again as the operand b+4.
    b("corr b shift", [op("ld   a,c", 4), op("sra  a", 8), op("add  a,4", 7), op("ld   c,a", 4)]),
    b("corr b floor", maxZero("b")),
    b("corr b over", [op("ld   a,b", 4), op("sub  8", 7), op("ld   c,a", 4)]),
    b("corr b excess", maxZero("c")),
    b("corr b ceil", [op("ld   a,b", 4), op("sub  c", 4), op("ld   b,a", 4)]),
    ...tags[1].map((t, i) => b(`corr write b${i}`,
      [op("ld   a,b", 4), op(`ld   (corr_${t}+1),a`, 13, { what: `set ladder ${t}` })])),
    // c = r - 2b, which is already inside -4..4 and needs no clamp.
    b("corr 2b", [op("ld   a,b", 4), op("add  a,a", 4), op("ld   b,a", 4)]),
    b("corr c part", [op(`ld   a,(${S("rem")})`, 13), op("sub  b", 4), op("ld   b,a", 4)]),
    b("corr c", [op("ld   a,b", 4), op("add  a,12", 7), op("ld   b,a", 4)]),
    ...tags[2].map((t, i) => b(`corr write c${i}`,
      [op("ld   a,b", 4), op(`ld   (corr_${t}+1),a`, 13, { what: `set ladder ${t}` })])),
    // Three units come off the debt for every quantum actually applied, so the
    // 1-2 unit remainder is kept instead of being rounded into a pulse.
    b("corr 3q lo", [op(`ld   a,(${S("q")})`, 13), op("ld   c,a", 4)]),
    b("corr 3q", [op("ld   a,c", 4), op("add  a,c", 4), op("add  a,c", 4), op("ld   c,a", 4)]),
    b("corr repay", [op(`ld   a,(${S("debt")})`, 13), op("sub  c", 4), op("ld   b,a", 4)]),
    b("corr repay keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    // AND THE SAME AMOUNT COMES OFF THE PHASE the next expectation is built
    // from. Without this the correction the engine itself applied comes back as
    // a displacement of the opposite sign at the next observation and the loop
    // chases its own tail (R9 §26.4).
    ...phaseFold(S, b),
  ];
}

/** What each corrector piece leaves in B and C, for the liveness pass. */
export function correctorLive(tags, { maxQuanta = MAX_QUANTA } = {}) {
  if (maxQuanta <= 16) {
    const L = [["c"], ["b", "c"], ["b"], []];                    // valid..keep
    L.push(["b"], ["b"]);                                         // q hi, q
    L.push(...EXPIRY_LIVE);
    L.push(["b", "c"], ["b"]);                                    // a shift, a bias
    for (const _ of tags[0]) L.push(["b"]);
    L.push(["c"], ["b", "c"], ["b", "c"]);                        // rem, b bit, b bias
    for (const _ of tags[1]) L.push(["b", "c"]);
    L.push(["b"]);                                                // c bias (c is dead now)
    for (const _ of tags[2]) L.push([]);
    L.push(["c"], ["c"], ["b", "c"], ["c"]);                      // 3q lo..repay keep
    L.push(["b", "c"], ["b", "c"], ["b"], ["b", "c"], ["b", "c"], []);   // the phase fold
    return L;
  }
  return correctorLiveWide(tags);
}

function correctorLiveWide(tags) {
  const L = [];
  const push = (n, v) => { for (let i = 0; i < n; i++) L.push(v); };
  L.push(["c"], ["b", "c"], ["b"], []);              // valid, debt, add, keep
  L.push(["b"], ["b"]);                               // q hi, q
  L.push(...EXPIRY_LIVE);
  L.push(["b", "c"], ["b", "c"], ["b"], ["b", "c"], ["b", "c"], ["b"]);   // a
  push(tags[0].length, ["b"]);                        // writes a
  L.push(["c"], ["c"], ["c"], []);                    // 4a, r part, r, r keep
  L.push(["c"], ["b"], ["b", "c"], ["b", "c"], ["b"]);// b
  push(tags[1].length, ["b"]);                        // writes b
  L.push(["b"], ["b"], ["b"]);                        // 2b, c part, c
  push(tags[2].length, ["b"]);                        // writes c
  L.push(["c"], ["c"], ["b", "c"], ["c"]);            // 3q lo, 3q, repay, repay keep
  L.push(["b", "c"], ["b", "c"], ["b"], ["b", "c"], ["b", "c"], []);      // the phase fold
  return L;
}
