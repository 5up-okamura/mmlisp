// THE PCM STATE BUNDLE, CONSUMED BY THE Z80
// (docs/dac-engine-implementation.md R16 §41.2-§41.4).
//
// ── what a command IS, and what changed ──────────────────────────────────
//
// R15's record named ONE staged byte and set it. Three simultaneous changes —
// two voices and the master — were three records at three block boundaries, and
// the consumer that had to keep up with that cost 619 cycles a block where 145
// were reserved. This record is not an event. It is the COMPLETE desired state
// of all three levels at one lap boundary:
//
//   { size:u8 = 8, type:u8 = PCM_LEVEL_STATE, applyAtLow:u16,
//     v0page:u8, v1page:u8, mpage:u8, reserved:u8 = 0 }
//
// The host fills the values it is not changing from its own shadow, so two
// voices and a master moving together are ONE record. That is what makes one
// decision a lap enough: a lap is 80 outputs, 8.01 ms, 124.84 Hz, finer than
// the 1/60 the design started from — and 124.84 bundles a second is NOT the
// same number as 600 scalar commands a second, so the report says how many
// changes each bundle carried rather than quoting the rate as if it were.
//
// ── the cell, and why `size` is read ─────────────────────────────────────
//
// The queue is a page of FIXED 8-byte cells. `size` is not a variable stride
// here — it is the cell's own check value, and R15's consumer said it checked
// it and never read byte 0 at all (R16 §41.4-2). A cell that is due is stepped
// over whatever it says; it is APPLIED only if it is a type we know AND says 8.
//
// ── everything is constant time ──────────────────────────────────────────
//
// There is no path that is shorter when the queue is empty, when the cell is in
// the future, or when its type is one the engine does not know. The suppression
// is one `xor` on a destination's low operand: a command that must not apply is
// STORED ANYWAY, into a bit bucket next door. The slot boundary is the DAC
// write, so a branch here would move it.
import { op, cost } from "./schedule.mjs";

const hx = (n) => `$${n.toString(16)}`;

/** The one type the engine knows, and the one length every cell has. */
export const CMD_PCM_LEVEL_STATE = 1;
export const CMD_BYTES = 8;
/** Where the fields sit inside a cell. */
export const CMD = { size: 0, type: 1, applyLo: 2, applyHi: 3,
  v0page: 4, v1page: 5, mpage: 6, reserved: 7 };
/** The three staged bytes a bundle carries, in the order it carries them. */
export const CMD_VALUES = ["v0page", "v1page", "mpage"];

/** One well-formed bundle, as wire bytes. */
export const cmdRecord = ({ at, v0page, v1page, mpage,
  type = CMD_PCM_LEVEL_STATE, size = CMD_BYTES }) =>
  [size, type, at & 0xff, (at >> 8) & 0xff, v0page, v1page, mpage, 0];

/**
 * THE HOST SIDE: one desired state, coalesced (R16 §41.2).
 *
 * The 68000 keeps a shadow of what the three levels are supposed to be. A
 * change names a boundary and one or more of them; changes for the SAME
 * boundary are merged into the shadow and leave as one record. A change that
 * arrives for a boundary whose record is already published is not rewritten —
 * it goes to the next boundary that has not been committed yet, which is the
 * rule that keeps a published cell immutable.
 */
export function makeEncoder({ v0page = 0, v1page = 0, mpage = 0 } = {}) {
  const shadow = { v0page, v1page, mpage };
  let pending = null;              // {at, state} not yet published
  let published = null;            // the last boundary handed to the queue
  let changes = 0, records = 0;
  return {
    get shadow() { return { ...shadow }; },
    get coalesced() { return { changes, records }; },
    /** Ask for `set` (any subset of the three) to hold from boundary `at`. */
    want(at, set) {
      changes += Object.keys(set).length;
      // A boundary already published is closed: the next one takes it.
      const target = published !== null && at <= published ? published + 1 : at;
      if (!pending || pending.at !== target)
        pending = { at: target, state: { ...shadow } };
      Object.assign(pending.state, set);
      Object.assign(shadow, set);
      return target;
    },
    /** Hand the pending bundle to the queue, if there is one. */
    emit() {
      if (!pending) return null;
      const r = cmdRecord({ at: pending.at, ...pending.state });
      published = pending.at; pending = null; records++;
      return r;
    },
  };
}

/**
 * THE Z80 SIDE, as a reference: ONE decision a lap.
 *
 * @param q     {mem, base, size} the queue's page
 * @param st    {tail, staged:{}, late} updated in place
 * @param head  the host's cursor
 * @param at    the output index of the LAP BOUNDARY this lap decides for
 */
export function refConsume(q, st, head, at) {
  const byte = (k) => q.mem[q.base + ((st.tail + k) % q.size)];
  const have = ((head - st.tail + q.size) % q.size) >= CMD_BYTES;
  const applyAt = byte(CMD.applyLo) | (byte(CMD.applyHi) << 8);
  // DUE means "not in the future". Exactly on time and late are both consumed
  // here: the boundary a late command lands on is the first one the engine has
  // not built, and this is it.
  const d = (at - applyAt) & 0xffff;
  const due = have && d < 0x8000;
  const known = have && byte(CMD.type) === CMD_PCM_LEVEL_STATE
    && byte(CMD.size) === CMD_BYTES;
  const go = have && due;                 // the cell is consumed
  const apply = go && known;              // …and its values are staged
  const late = apply && d !== 0;
  if (apply) CMD_VALUES.forEach((k, i) => { st.staged[k] = byte(CMD.v0page + i); });
  if (late) st.late = ((st.late ?? 0) + 1) & 0xff;
  if (go) st.tail = (st.tail + CMD_BYTES) % q.size;
  return { have, due, known, go, apply, late, d };
}

// ── THE CONSUMER AS Z80 PIECES ───────────────────────────────────────────
//
// Ten positions, b9 and b10 of every block, and one copy of the chain a lap —
// not five copies of one block's worth. So there is ONE set of self-modified
// operands, and a piece hands its result to the next through memory or, where
// the flags have to survive with it, through `AF'`.
//
// `AF'` IS FREE AND IT IS NOW USED. `ex af,af'` never runs anywhere else in the
// image and there are no interrupts, so the shadow accumulator is a register
// the consumer owns. It carries the borrow out of the low half of the time
// comparison, which nothing else can hold across a slot boundary: the pad may
// clobber the flags and the slot's tail reloads main A with the next sample.
// The chain always SAVES into it before it reads it, so the uninitialised
// shadow is never the value anything depends on.
//
// Main BC is used INSIDE a piece and never across one. `ld bc,(queueTail)` is
// the whole record pointer in 20 cycles where `push hl`/`ld hl,(nn)`/`pop hl`
// is 37, and the placer is told which slots the consumer clobbers BC in so it
// cannot also be carrying the decode's or the protocol's value through them.

const b = (name, ops, extra = {}) => ({ name, ops, cycles: cost(ops), ...extra });

/**
 * BC IS DECLARED, AND THEN PAID FOR (R16 §41.3).
 *
 * A consumer piece may use main BC inside itself, but the decode's and the
 * protocol's own pieces carry BC BETWEEN slots, and the placer showed those
 * live ranges covering every one of the consumer's early positions. So a piece
 * that clobbers BC saves and restores it — 21 cycles, two bytes of stack, the
 * same pair the pad already uses — rather than the placer being asked to keep
 * the two apart, which it cannot do while the chain's deadline is one
 * observation. What this buys is that the clobber is declared and neutralised;
 * what it costs is printed on its own line.
 */
const keepBC = (piece) => (piece.bc
  ? { ...piece, ops: [op("push bc", 11), ...piece.ops, op("pop  bc", 10)],
    cycles: piece.cycles + 21 }
  : piece);

/**
 * The chain, in order.
 *
 * @param m     the protocol's map (proto-blocks.mjs `protoMap`)
 * @param cfg   for the lap's own output count and the queue's page
 */
export function commandBlocks(m, cfg, tag = "", { preserveBC = true } = {}) {
  const C = m.cmd;
  const T = hx(m.queueTail);                        // …and the page byte behind it
  const OUT = m.outputLow;
  const HEAD = hx(m.L.control.queueHead.offset);
  const LAP = cfg.cycleSlots;
  const V0 = m.stageBytes, DUMP = m.dumpBytes;
  const SUPPRESS = (V0 ^ DUMP) & 0xff;              // one xor is the whole of it
  if ((V0 & 0xff00) !== (DUMP & 0xff00))
    throw new Error("the staged bytes and the bit bucket must share a page");
  for (let k = 1; k < CMD_VALUES.length; k++)
    if ((((V0 + k) ^ (DUMP + k)) & 0xff) !== SUPPRESS)
      throw new Error("the suppression xor does not survive the walk along the values");
  const lbl = (n) => `cmd_${n}${tag}`;
  const P = CMD_VALUES.map((_, i) => lbl(`st${i}`));
  const done = (list) => (preserveBC ? list.map(keepBC) : list);
  return done([
    // ── the boundary this lap decides for ─────────────────────────────
    // The logical position steps ONCE a lap, by the lap's own generated output
    // count, at the head of the chain. So from here to the same point next lap
    // it names the boundary the decision applies at AND the next lap's first
    // output — one number, no per-site constant anywhere (R16 §41.2).
    b("cmd tick", [
      op(`ld   a,(${hx(OUT)})`, 13),
      op(`add  a,${LAP}`, 7, { what: "one lap of outputs, from the schedule" }),
      op(`ld   (${hx(OUT)}),a`, 13),
      op(`ld   a,(${hx(OUT + 1)})`, 13),
      op("adc  a,0", 7),
      op(`ld   (${hx(OUT + 1)}),a`, 13, { what: "the boundary this lap decides for" }),
    ]),
    // ── is there a whole cell behind the host's cursor? ────────────────
    b("cmd have", [
      op(`ld   a,(${T})`, 13),
      op("ld   c,a", 4),
      op(`ld   a,(${HEAD})`, 13, { what: "the host's cursor" }),
      op("sub  c", 4),
      op(`cp   ${CMD_BYTES}`, 7),
      op("ccf", 4),
      op("sbc  a,a", 4, { what: "$ff exactly when a whole cell is there" }),
      op(`ld   (${hx(C.mask)}),a`, 13),
    ], { bc: true }),
    // ── the time, low half ────────────────────────────────────────────
    b("cmd due lo", [
      op(`ld   bc,(${T})`, 20, { what: "C = the tail, B = the queue's page" }),
      op("inc  c", 4),
      op("inc  c", 4, { what: "→ the cell's applyAtLow" }),
      op("ld   a,(bc)", 7),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(OUT)})`, 13),
      op("sub  c", 4, { what: "the difference's low byte, and the borrow" }),
      op(`ld   (${hx(C.dlo)}),a`, 13),
      op("ex   af,af'", 4, { what: "the borrow, to the piece that needs it" }),
    ], { bc: true, afOut: true }),
    // ── the time, high half ───────────────────────────────────────────
    // `ld`, `push`/`pop` and `inc c` all leave the carry alone, which is what
    // lets the borrow cross a slot boundary in the shadow flags at all.
    b("cmd due hi", [
      op("ex   af,af'", 4, { what: "the borrow, back" }),
      op(`ld   bc,(${T})`, 20),
      op("inc  c", 4),
      op("inc  c", 4),
      op("inc  c", 4, { what: "→ its high byte" }),
      op("ld   a,(bc)", 7),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(OUT + 1)})`, 13),
      op("sbc  a,c", 4, { what: "the difference, with the borrow" }),
      op(`ld   (${hx(C.dhi)}),a`, 13),
    ], { bc: true, afIn: true }),
    // ── due, and therefore consumed ───────────────────────────────────
    b("cmd go", [
      op(`ld   a,(${hx(C.dhi)})`, 13),
      op("add  a,a", 4, { what: "the sign into the carry" }),
      op("sbc  a,a", 4, { what: "$ff when the cell is still in the FUTURE" }),
      op("cpl", 4, { what: "…so this is $ff when it is due" }),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(C.mask)})`, 13),
      op("and  c", 4, { what: "go = a whole cell AND due" }),
      op(`ld   (${hx(C.mask)}),a`, 13),
      op(`and  ${CMD_BYTES}`, 7, { what: "the cell's length, or nothing" }),
      op([`${lbl("step")}:`, `ld   (${lbl("adv")}+1),a`], 13,
        { what: "…into the tail's own step" }),
    ], { bc: true }),
    // ── is it a cell we know how to apply? ────────────────────────────
    // The size byte IS read (R16 §41.4-2). A cell that says anything but 8 is
    // stepped over and stages nothing, which is the fixed-cell rule.
    b("cmd cell", [
      op(`ld   bc,(${T})`, 20),
      op("ld   a,(bc)", 7, { what: "the cell's size" }),
      op(`sub  ${CMD_BYTES}`, 7),
      op("ex   af,af'", 4, { what: "park it — C still points at the cell" }),
      op("inc  c", 4),
      op("ld   a,(bc)", 7, { what: "…and its type" }),
      op(`sub  ${CMD_PCM_LEVEL_STATE}`, 7),
      op("ld   c,a", 4),
      op("ex   af,af'", 4),
      op("or   c", 4, { what: "zero only if both are what we know" }),
      op("sub  1", 7),
      op("sbc  a,a", 4, { what: "$ff iff a cell we know how to apply" }),
      op(`ld   (${hx(C.known)}),a`, 13),
    ], { bc: true }),
    // ── apply = consumed AND known ────────────────────────────────────
    b("cmd apply", [
      op(`ld   a,(${hx(C.known)})`, 13),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(C.mask)})`, 13),
      op("and  c", 4, { what: "apply" }),
      op(`ld   (${hx(C.known)}),a`, 13, { what: "…kept for the late count" }),
    ], { bc: true }),
    // ── where the three values are going ──────────────────────────────
    // The staged bytes and the bit bucket differ by ONE bit of their low byte,
    // and they differ by the same bit all the way along the three, so the whole
    // suppression is `and mask` / `xor bucket` on one address.
    b("cmd dest", [
      op(`ld   a,(${hx(C.known)})`, 13),
      op(`and  ${SUPPRESS}`, 7),
      op(`xor  ${hx(DUMP & 0xff)}`, 7, { what: "the staged bytes, or the bit bucket" }),
      op(`ld   (${P[0]}+1),a`, 13),
      op("inc  a", 4),
      op(`ld   (${P[1]}+1),a`, 13),
      op("inc  a", 4),
      op(`ld   (${P[2]}+1),a`, 13),
    ]),
    // ── the three values, stored ──────────────────────────────────────
    // BOTH OF THESE MUST SIT BETWEEN THE SAME TWO BLOCK EDGES (R16 §41.3): the
    // edge picks the three staged bytes up together, so an edge landing between
    // two of these stores would run a block on half of one bundle and half of
    // the previous one.
    b("cmd store 01", [
      op(`ld   bc,(${T})`, 20),
      op("ld   a,c", 4),
      op(`add  a,${CMD.v0page}`, 7),
      op("ld   c,a", 4, { what: "→ the bundle's values" }),
      op("ld   a,(bc)", 7),
      op([`${P[0]}:`, `ld   (${hx(V0)}),a`], 13, { what: "voice 0's level page" }),
      op("inc  c", 4),
      op("ld   a,(bc)", 7),
      op([`${P[1]}:`, `ld   (${hx(V0 + 1)}),a`], 13, { what: "voice 1's" }),
    ], { bc: true, edge: true }),
    b("cmd store 2", [
      op(`ld   bc,(${T})`, 20),
      op("ld   a,c", 4),
      op(`add  a,${CMD.mpage}`, 7),
      op("ld   c,a", 4),
      op("ld   a,(bc)", 7),
      op([`${P[2]}:`, `ld   (${hx(V0 + 2)}),a`], 13, { what: "…and the master's" }),
    ], { bc: true, edge: true }),
    // ── consume it ────────────────────────────────────────────────────
    b("cmd adv", [
      op(`ld   a,(${T})`, 13),
      op([`${lbl("adv")}:`, "add  a,$00"], 7, { what: "one cell, or nothing" }),
      op(`ld   (${T}),a`, 13, { what: "the tail: a whole cell, or where it was" }),
    ]),
    // ── exactly on time, or late? ─────────────────────────────────────
    // §33.4 asked for this count and R15 did not have it. A command applied at
    // a boundary later than the one it named is late; a phase correction or a
    // BUSREQ stop is not, because neither changes the output index at all.
    b("cmd late test", [
      op(`ld   a,(${hx(C.dhi)})`, 13),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(C.dlo)})`, 13),
      op("or   c", 4, { what: "zero only if this is the boundary it named" }),
      op("sub  1", 7),
      op("sbc  a,a", 4),
      op("inc  a", 4, { what: "1 when it is late, 0 when it is exact" }),
      op(`ld   (${hx(C.notExact)}),a`, 13),
    ], { bc: true }),
    b("cmd late count", [
      op(`ld   a,(${hx(C.notExact)})`, 13),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(C.known)})`, 13, { what: "apply" }),
      op("and  c", 4),
      op("ld   c,a", 4),
      op(`ld   a,(${hx(C.late)})`, 13),
      op("add  a,c", 4),
      op(`ld   (${hx(C.late)}),a`, 13, { what: "lateCommandCount" }),
    ], { bc: true }),
  ]);
}

/**
 * Boot. The counters start at zero, the tail steps by nothing until a decision
 * says otherwise, and the three destinations point at the BIT BUCKET — so the
 * very first lap, before anything has been decided, stages nothing rather than
 * whatever the operands happened to contain.
 */
export function commandBootLines(m, tag = "") {
  const C = m.cmd, lbl = (n) => `cmd_${n}${tag}`;
  const P = CMD_VALUES.map((_, i) => lbl(`st${i}`));
  const out = ["xor  a"];
  for (const k of ["mask", "dlo", "dhi", "known", "notExact", "late"])
    out.push(`ld   (${hx(C[k])}),a`);
  out.push(`ld   (${lbl("adv")}+1),a`);
  out.push(`ld   a,${hx(m.dumpBytes & 0xff)}`);
  P.forEach((p, i) => {
    if (i) out.push("inc  a");
    out.push(`ld   (${p}+1),a`);
  });
  return out;
}

/** What one lap of it costs. */
export const commandCost = (blocks) => blocks.reduce((t, x) => t + x.cycles, 0);

/**
 * WHERE THE CHAIN GOES (R16 §41.3).
 *
 * The consumer gets b9 and b10 of every block and nothing else — ten positions,
 * `(73 + 72) * 5` cycles. Pieces are laid into them in chain order; the two
 * marked `edge` are PINNED to the pair of positions inside the block whose
 * edge is the last one before the lap boundary, because that edge is what makes
 * the three values take effect exactly at the boundary the bundle named.
 *
 * @returns {plan, positions, over} — the plan maps a slot index to its ops, and
 *          `over` names every position that ended up past the ceiling.
 */
export function packCommand(blocks, cfg, { rooms, ceilings, budget }) {
  const bs = cfg.blockSamples, lead = cfg.lead, n = cfg.cycleSlots;
  const positions = [];
  for (let i = 0; i < n; i++) {
    const p = (i + lead) % bs;
    if (p === 9 || p === 10) positions.push(i);
  }
  // The edge that activates state for the lap's first output: the slot that
  // builds the sample before it. Derived, not written down.
  const edgeSlot = (n - lead - 1 + n) % n;
  if ((edgeSlot + lead) % bs !== bs - 1)
    throw new Error("the lap boundary's block edge is not a block edge");
  const edgeBlock = Math.floor((edgeSlot + lead) / bs);
  const pinned = positions.filter((i) => Math.floor((i + lead) / bs) === edgeBlock);
  if (pinned.length !== 2) throw new Error("the edge block does not hold both consumer positions");

  // 1, 2, 3, 5 and 9 are the residuals a straight-line pad cannot hit, so a
  // piece that would leave one has not fitted — it has jammed the slot. This is
  // the same rule `padTo` enforces, applied before the fact instead of as an
  // assembly-time refusal (schedule.mjs).
  const paddable = (r) => r === 0 || r === 4 || r === 6 || r === 7 || r === 8 || r >= 10;

  // The chain is ordered, so a piece may only go at or after the position the
  // previous one took — and the two pinned pieces split the run in three: what
  // must have happened before the values are stored, the stores themselves, and
  // what may happen after.
  const first = blocks.findIndex((x) => x.edge);
  const last = blocks.length - 1 - [...blocks].reverse().findIndex((x) => x.edge);
  const attempt = (room) => {
    const at = new Map(positions.map((i) => [i, []]));
    const load = new Map(positions.map((i) => [i, 0]));
    const edges = blocks.filter((x) => x.edge);
    let k = 0, failed = null;
    for (let n = 0; n < blocks.length; n++) {
      const piece = blocks[n];
      let placed = null;
      if (piece.edge) {
        placed = pinned[edges.indexOf(piece)];
        if (positions.indexOf(placed) < k) { failed = piece; break; }
      } else {
        // Before the stores: only the positions in front of them. After: only
        // the ones behind. The pinned pair itself is the stores' and nothing
        // else may take its room.
        const lo = n > last ? positions.indexOf(pinned[1]) + 1 : k;
        const hi = n < first ? positions.indexOf(pinned[0]) : positions.length;
        for (let j = Math.max(k, lo); j < hi; j++) {
          const i = positions[j];
          if (pinned.includes(i)) continue;
          const rest = room(i) - load.get(i) - piece.cycles;
          if (rest >= 0 && paddable(rest)) { placed = i; break; }
        }
      }
      if (placed === null) { failed = piece; break; }
      at.get(placed).push(piece);
      load.set(placed, load.get(placed) + piece.cycles);
      k = positions.indexOf(placed);
    }
    return { at, load, failed };
  };

  // FIRST INSIDE THE CEILING, and only then inside what the slot physically
  // holds. A consumer that needs the second pass has not fitted — the report
  // says which positions it pushed past 83.9% and by how much, which is the
  // failure table R16 §41.5 step 5 asks for rather than a refusal with no
  // numbers behind it.
  let r = attempt((i) => ceilings.get(i)), spilled = false;
  if (r.failed) { r = attempt((i) => rooms.get(i)); spilled = true; }
  const plan = new Map();
  for (const [i, ps] of r.at) if (ps.length) plan.set(i, ps.flatMap((p) => p.ops));
  const over = [...r.load].filter(([i, c]) => c > ceilings.get(i))
    .map(([i, c]) => ({ slot: i, cycles: c, ceiling: ceilings.get(i) }));
  return { plan, positions, pinned, edgeSlot, load: r.load, at: r.at,
    failed: r.failed, spilled, over, total: commandCost(blocks), budget,
    bcSlots: [...r.at].filter(([, ps]) => ps.some((p) => p.bc)).map(([i]) => i) };
}
