// THE BOUNDED CORRECTOR (docs/dac-engine-implementation.md R9 §26.4, R10 §29.4).
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
//        jr   corr_k_e0       <- the DISPLACEMENT byte is self-modified
//   e0:  nop                     displacement 0 runs 8 nops  = +16 cycles
//   e1:  nop
//   ...                          displacement 4 runs 4 nops = the NEUTRAL point
//   e8:  <the rest of the pad>    displacement 8 runs none   = -16 cycles
//
// IT IS `jr`, NOT `jp`, AND THAT IS THE WHOLE POINT. `jp nn` carries a 16-bit
// ADDRESS, so writing the entry number 4 into its second byte sets the target to
// $xx04 — it does not enter the fourth nop, it leaves the loop. The engine ran
// for exactly as long as it took to reach the first ladder. `jr` carries a
// signed DISPLACEMENT measured from the instruction after it, which is `e0`, so
// the byte the corrector writes IS the entry number and nothing has to be
// computed. It costs two cycles more than `jp` and one byte less.
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
//
// THERE IS ONE SHAPE, not two. R9 §28 offered a 16-quantum variant as a
// measurement because it needed eleven fewer pieces; R10 §29.5 answered the
// placement problem by replacing a reservation instead, and the narrow shape
// EXPIRES AT 1,340 MASTER — inside the 1,500-master disturbance contract it
// would have to survive. A shape that cannot hold the contract is not a
// fallback, so it is gone rather than kept behind a flag.
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
 * THE DEBT THE CORRECTOR WILL ACCEPT, in phase-table units, and it is NOT the
 * quantum capability restated (R10 §29.4).
 *
 * §27 and §28 said "±112 units, expiring past 113" and the code did not do
 * that: it narrowed `debt + delta` to a signed byte first and then asked
 * `|q| > 28` afterwards, which accepts +113, +114 and -113, first refuses at
 * +115 and -114, and — because 100 + 75 is -81 in eight bits — accepts a debt
 * of 175 as a valid debt of the opposite sign. The wrap has to be refused
 * BEFORE it happens, so the sum is formed in nine bits and the limit is its
 * own constant.
 *
 * Why 112 rather than the 75 units a single disturbance may present: the
 * quantised difference can sit two units off the true one, and a disturbance at
 * the contract's limit repeated at every observation leaves a 3/4-gain residue
 * that walks the pre-correction debt up toward 100. 112 keeps those alive and
 * still stops well short of the signed byte's own edge, which is where the
 * silent lie used to be.
 */
export const MAX_DEBT_UNITS = 112;

/** The debt limit is four quanta-worth per quantum of capability. */
export const debtLimitFor = (maxQuanta) => 4 * maxQuanta;

/**
 * Ways to break the corrector on purpose (R9 §26.5-5, R10 §29.4). Each one is a
 * plausible implementation, not a scribble: they are the mistakes the
 * arithmetic invites, and the checks have to fail on every one of them or they
 * are not checks.
 */
export const CORR_FAULTS = {
  "corr-sign": "the ladders are driven the wrong way round, so a correction adds to the debt",
  "corr-double": "each quantum is applied twice — the debt is repaid once and the schedule moved twice",
  "corr-no-fold": "the correction is not taken off the phase the next expectation is built from",
  "corr-saturate": "a debt past the capability is clamped and carried instead of expiring",
  "corr-debt-wrap": "the debt is summed in eight bits, so 100 + 75 becomes a valid -81",
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

const EXPIRED = { debt: 0, q: 0, a: 0, b: 0, c: 0, applied: 0, expired: true };

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
 *
 * TWO checks, not one, and the order matters. The debt is checked as a NINE-BIT
 * sum against MAX_DEBT_UNITS; only then is it narrowed and divided; and the
 * capability |q| <= maxQuanta is a separate test that the ladder split enforces
 * by construction. Using one for the other is what put the boundary at +114.
 */
export function refCorrect(prev, delta, { expire = false, maxQuanta = MAX_QUANTA } = {}) {
  if (expire) return { ...EXPIRED };
  const raw = prev.debt + delta;                        // nine bits, never narrowed
  // Beyond the limit the debt is DISCARDED and the acquisition is dropped — not
  // saturated and carried, which would cap the correction quietly and leave the
  // engine claiming a phase it is not holding (R9 §26.4).
  if (Math.abs(raw) > debtLimitFor(maxQuanta)) return { ...EXPIRED };
  const q = (raw + 1) >> 2;
  if (Math.abs(q) > maxQuanta) return { ...EXPIRED };
  const { a, b, c, applied } = splitQuanta(q);
  return { debt: raw - CORR.unitsPerQuantum * applied, q, a, b, c, applied, expired: false };
}

export const INITIAL_CORR = { debt: 0, q: 0, a: 0, b: 0, c: 0, applied: 0, expired: false };

/**
 * The ladder a correction slot carries, as ONE op.
 *
 * Its COST is the neutral path — the `jp` plus the four nops an uncorrected
 * observation runs. R10 §29.5 settles what that means for the ceiling: the
 * `nop`s are TIMING PAD, not work, because they are the clock itself rather
 * than a feature's cost, and only the `jp`'s 10 cycles are charged as fixed
 * work. The neutral length is still what the slot's arithmetic closes on, so it
 * is what this op reports; `gen-stream` charges the 10 and leaves the rest in
 * the pad column.
 */
export const LADDER_WORK = 12;                    // the `jr`; the nops are pad
export const LADDER_NEUTRAL = LADDER_WORK + CORR.neutral * CORR.quantumCycles;
export const LADDER_BYTES = 2 + CORR.ladderNops;

export function ladderOps(tag) {
  // The target is `e0`, which is the byte right after the `jr`, so the assembled
  // displacement is 0 and the entry number is written straight over it.
  const asm = [`corr_${tag}:`, `jr   corr_${tag}_e0`];
  for (let i = 0; i < CORR.ladderNops; i++) asm.push(`corr_${tag}_e${i}:`, "nop");
  asm.push(`corr_${tag}_e${CORR.ladderNops}:`);
  return [op(asm, LADDER_NEUTRAL, { what: `correction ladder ${tag}`, ladder: tag,
    ladderWork: LADDER_WORK })];
}


/**
 * The corrector, as the Z80 runs it: pieces of at most 29 cycles, carrying
 * their intermediates in B and C, with A and the flags dying at every slot
 * boundary — the same discipline as the decode (decode-split.mjs).
 *
 * @param S      (name) => the asm address of that state byte
 * @param tags   the ladder tags, grouped [[4],[2],[1]]
 */
export function correctorBlocks(S, tags, { maxQuanta = MAX_QUANTA, fault = null } = {}) {
  if (fault && !CORR_FAULTS[fault]) throw new Error(`unknown corrector fault ${fault}`);
  if (maxQuanta !== MAX_QUANTA)
    throw new Error("there is one corrector shape; the 16-quantum variant expired inside the contract");
  const blocks = correctorShape(S, tags);
  if (!fault) return blocks;
  // `corr-no-fold` DELETES the phase fold, which is the one R9 §26.4 names: an
  // implementation that forgets it sees its own correction come back as a
  // displacement of the opposite sign at the next observation.
  if (fault === "corr-no-fold")
    return blocks.filter((b) => !b.name.startsWith("corr phase") && !b.name.startsWith("corr fold"));
  return blocks.map((b) => {
    // The ladders driven the wrong way: a correction that adds to the debt.
    if (fault === "corr-sign" && b.name === "corr a bias")
      return patch(b, "add  a,4", ["neg", "add  a,4"]);
    // Twice the schedule movement for the same repayment: one `sra` short, so
    // `a` is q>>1 where the repayment still assumes q>>2.
    if (fault === "corr-double" && b.name === "corr a shift")
      return replace(b, [op("ld   a,b", 4), op("sra  a", 8), op("nop", 8), op("ld   c,a", 4)]);
    // A debt past the limit clamped and carried, instead of expiring: the range
    // mask is forced live, so the ladder clamps absorb it silently.
    if (fault === "corr-saturate" && b.name === "corr range")
      return replace(b, [op("ld   a,b", 4), op("ld   a,255", 7), op("nop", 4), op("ld   b,a", 4)]);
    // The sum taken as eight bits: the overflow mask is never consulted, so
    // 100 + 75 arrives as a perfectly acceptable -81.
    if (fault === "corr-debt-wrap" && b.name === "corr live")
      return replace(b, [op("ld   a,b", 4), op("nop", 4), op("nop", 4), op("ld   c,a", 4)]);
    return b;
  });
}

/** Replace one instruction inside a block, keeping the block's shape honest. */
function patch(b, find, repl) {
  const ops = [];
  for (const o of b.ops) {
    if (o.asm[0].trim().startsWith(find)) {
      for (const r of repl) ops.push(op(r, r.startsWith("neg") ? 8 : o.cycles));
      continue;
    }
    ops.push(o);
  }
  return { ...b, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) };
}

/** Replace a whole block's instructions, for a fault that is not one edit. */
function replace(b, ops) {
  return { ...b, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) };
}

/**
 * THE NINE-BIT DEBT AND ITS RANGE TEST (R10 §29.4).
 *
 * `debt + delta` is -197..197 and an eight-bit add cannot say which side of the
 * limit it landed on: a true 175 arrives as -81, which is a perfectly ordinary
 * debt. The ninth bit is exactly the signed-overflow condition of the add, and
 * the Z80 has it in P/V — but P/V dies at the slot boundary and there is no
 * `sbc a,a` for it, so it is rebuilt from the three signs:
 *
 *   overflow  <->  the sum's sign differs from BOTH operands' signs
 *                  = (sd ^ ss) & (se ^ ss)
 *
 * with each sign taken as a 0/$ff mask by `add a,a` + `sbc a,a`. Then the
 * in-range test is one unsigned comparison on the byte, which is the true sum
 * exactly when there was no overflow:
 *
 *   live = ~overflow & (s + 112 <= 224)
 *
 * and `live` gates q, the debt and KNOWN. Clearing KNOWN is the point: the next
 * reading becomes a base rather than a difference, so the engine is openly at a
 * NEW relative phase instead of pretending to return to the old one.
 */
function debtBlocks(S, b) {
  const max = MAX_DEBT_UNITS;
  return [
    b("corr valid", [op(`ld   a,(${S("valid")})`, 13), op("ld   c,a", 4)]),
    b("corr debt", [op(`ld   a,(${S("debt")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr debt keep", [op("ld   a,b", 4), op(`ld   (${S("hi")}),a`, 13)]),
    b("corr sum", [op(`ld   a,(${S("delta")})`, 13), op("add  a,b", 4), op("ld   b,a", 4)]),
    b("corr sum keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    b("corr ss", [op("ld   a,b", 4), op("add  a,a", 4), op("sbc  a,a", 4),
      op(`ld   (${S("rem")}),a`, 13, { what: "the sum's sign, as a mask" })]),
    b("corr sd", [op(`ld   a,(${S("hi")})`, 13), op("add  a,a", 4), op("sbc  a,a", 4),
      op("ld   c,a", 4)]),
    b("corr ovf d", [op(`ld   a,(${S("rem")})`, 13), op("xor  c", 4), op("ld   c,a", 4)]),
    b("corr se", [op(`ld   a,(${S("delta")})`, 13), op("add  a,a", 4), op("sbc  a,a", 4),
      op("ld   b,a", 4)]),
    b("corr ovf", [op(`ld   a,(${S("rem")})`, 13), op("xor  b", 4), op("and  c", 4),
      op("ld   c,a", 4, { what: "$ff exactly when the nine-bit sum did not fit" })]),
    b("corr bias", [op(`ld   a,(${S("debt")})`, 13), op(`add  a,${max}`, 7), op("ld   b,a", 4)]),
    b("corr range", [op("ld   a,b", 4), op(`cp   ${2 * max + 1}`, 7), op("sbc  a,a", 4),
      op("ld   b,a", 4)]),
    b("corr live", [op("ld   a,c", 4), op("cpl", 4), op("and  b", 4), op("ld   c,a", 4)]),
  ];
}

const DEBT_LIVE = [
  ["c"],        // corr valid       C = the VALID mask
  ["b"],        // corr debt        B = the debt it gates
  ["b"],        // corr debt keep   …and a copy in memory for its sign
  ["b"],        // corr sum         B = the eight-bit sum
  ["b"],        // corr sum keep
  [],           // corr ss          -> memory
  ["c"],        // corr sd
  ["c"],        // corr ovf d       C = sd ^ ss
  ["b", "c"],   // corr se
  ["c"],        // corr ovf         C = the overflow mask
  ["b", "c"],   // corr bias
  ["b", "c"],   // corr range       B = in-range, C = overflow
  ["c"],        // corr live        C = the gate
];

/** What the gate does with itself: q, the debt and KNOWN all pass through it. */
function gateBlocks(S, b) {
  return [
    b("corr gate q", [op("ld   a,b", 4), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr q keep", [op("ld   a,b", 4), op(`ld   (${S("q")}),a`, 13)]),
    b("corr gate debt", [op(`ld   a,(${S("debt")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr gate debt keep", [op("ld   a,b", 4), op(`ld   (${S("debt")}),a`, 13)]),
    b("corr gate known", [op(`ld   a,(${S("kraw")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("corr gate known keep", [op("ld   a,b", 4), op(`ld   (${S("known")}),a`, 13)]),
    b("corr reload q", [op(`ld   a,(${S("q")})`, 13), op("ld   b,a", 4)]),
  ];
}

const GATE_LIVE = [["b", "c"], ["c"], ["b", "c"], ["c"], ["b", "c"], [], ["b"]];

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

const FOLD_LIVE = [["b", "c"], ["b", "c"], ["b"], ["b", "c"], ["b", "c"], []];

function correctorShape(S, tags) {
  const b = (name, ops) => ({ name, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) });
  // max(x, 0) for a signed byte in C, leaving it in `dst`. The sign bit is
  // moved into carry by `add a,a` and `sbc a,a` turns it into a mask — no
  // branch, so the piece has one length.
  const maxZero = (dst) => [op("ld   a,c", 4), op("add  a,a", 4), op("sbc  a,a", 4),
    op("cpl", 4), op("and  c", 4), op(`ld   ${dst},a`, 4)];
  return [
    // The debt is DISCARDED when the difference is not valid: an unknown
    // reading, a re-acquisition or a restart leaves nothing to repay, and the
    // next known value is a new relative basis rather than a return to the old
    // phase (R9 §26.4). The nine-bit sum and its limit are debtBlocks().
    ...debtBlocks(S, b),
    // q = (debt + 1) >> 2, arithmetic. A gain of 3/4 rather than a division by
    // three: it converges in at most five observations and leaves at most two
    // units — 40 master — where dividing costs far more than that is worth.
    b("corr q hi", [op(`ld   a,(${S("debt")})`, 13), op("inc  a", 4), op("sra  a", 8),
      op("ld   b,a", 4)]),
    b("corr q", [op("ld   a,b", 4), op("sra  a", 8), op("ld   b,a", 4)]),
    ...gateBlocks(S, b),
    // a = clamp(q >> 2, -4, 4), carried as the ladder operand a+4 in 0..8. The
    // clamp is the QUANTUM CAPABILITY check and it is not the debt check: the
    // debt limit keeps |q| <= 28 already, and these are what make 28 mean
    // 4a + 2b + c with every |.| <= 4 (R10 §29.4).
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
  if (maxQuanta !== MAX_QUANTA)
    throw new Error("there is one corrector shape; the 16-quantum variant expired inside the contract");
  const L = [];
  const push = (n, v) => { for (let i = 0; i < n; i++) L.push(v); };
  L.push(...DEBT_LIVE);
  L.push(["b", "c"], ["b", "c"]);                     // q hi, q
  L.push(...GATE_LIVE);
  L.push(["b", "c"], ["b", "c"], ["b"], ["b", "c"], ["b", "c"], ["b"]);   // a
  push(tags[0].length, ["b"]);                        // writes a
  L.push(["c"], ["c"], ["c"], []);                    // 4a, r part, r, r keep
  L.push(["c"], ["b"], ["b", "c"], ["b", "c"], ["b"]);// b
  push(tags[1].length, ["b"]);                        // writes b
  L.push(["b"], ["b"], ["b"]);                        // 2b, c part, c
  push(tags[2].length, ["b"]);                        // writes c
  L.push(["c"], ["c"], ["b", "c"], ["c"]);            // 3q lo, 3q, repay, repay keep
  L.push(...FOLD_LIVE);
  return L;
}
