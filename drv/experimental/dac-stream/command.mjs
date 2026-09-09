// THE PCM STATE MAILBOX (docs/dac-engine-implementation.md R17 §43.2-§43.4).
//
// ── what changed, and why ────────────────────────────────────────────────
//
// R16 made a command a BUNDLE — the complete desired state of all three levels
// at one lap boundary, so two voices and a master moving together are one
// record — and that was right, but the consumer still ran a general FIFO to get
// at it: head against tail, a size byte, a type byte, a record pointer rebuilt
// every lap. 867 cycles against 725 reserved, and the arithmetic was not where
// they went. A waiting list belongs to the CPU that can afford one (R17 §43.1).
//
// So there is no queue on this side at all. ONE outstanding desired state, at a
// FIXED address, with a two-byte handshake:
//
//   the 68000 writes a payload only while `commit == ack`, then bumps commit
//   the Z80 acts only while `commit != ack`, and sets `ack = commit` when it has
//
// Nothing is dereferenced, so main BC is not used ANYWHERE in this chain — it
// is not even saved and restored — and the decode's, the corrector's and the
// protocol's BC live ranges stop being this file's problem.
//
// ── time is counted in observations, not samples (R17 §43.2) ─────────────
//
// A bundle can only land on a lap boundary, so the low sixteen bits of a sample
// number were carrying a multiple of eighty and using a fifth of their range.
// The engine already holds the same clock as the decoder's `observationNumber`,
// so that is what the wire names:
//
//   snapshot observation n names the lap starting at (n - 1) * outputsPerObservation
//   decisionObservation n applies at the boundary   n * outputsPerObservation
//
// Same sixteen bits, same wrap rule, same 1..32767 look-ahead — measured in
// observations now, which is 32,767 laps instead of 32,767 samples. The Z80's
// `outputSampleLow` is gone with the arithmetic that needed it; the host still
// derives its u32 sample number from the compact snapshot.
import { op, cost } from "./schedule.mjs";

const hx = (n) => `$${n.toString(16)}`;

/** The three staged bytes a bundle carries, in the order it carries them. */
export const CMD_VALUES = ["v0page", "v1page", "mpage"];

/** One bundle, as the host means it. */
export const cmdBundle = ({ at, v0page, v1page, mpage }) =>
  ({ decisionObservation: at & 0xffff, v0page, v1page, mpage });

/**
 * THE HOST SIDE (R17 §43.3, §43.5).
 *
 * The waiting list lives here. Changes are held against EXTENDED observation
 * numbers — a u32 that never wraps — and are narrowed to sixteen bits only when
 * a bundle is encoded, which is what makes `$ffff -> $0000` an ordinary step
 * forward instead of a comparison nobody can get right (§43.5).
 *
 * Several future boundaries may be waiting at once. Changes for the same
 * boundary merge into one desired state; a change for a boundary that has
 * already been published does not rewrite it — it goes to the next boundary,
 * which in observation units is simply +1 and is therefore always a boundary
 * the schedule really has (R15's sample-number form sent it to output 161,
 * which is not one).
 */
export function makeEncoder({ v0page = 0, v1page = 0, mpage = 0 } = {}) {
  // THE WAITING LIST HOLDS DIFFERENCES, NOT STATES (R19 §46.2). It used to hold
  // a whole state per boundary, seeded from "the latest state anyone has asked
  // for" — and that is wrong the moment `want()` is called out of time order:
  // a boundary created after a LATER one already exists was born carrying that
  // later one's values, so a change meant for observation 20 came out at 15.
  // What each entry owns is only the fields that boundary was actually told
  // about; the whole state is built at emit time, in time order, from the last
  // one that really went out.
  const waiting = new Map();          // extended observation -> the fields it sets
  const live = { v0page, v1page, mpage };   // the last state actually published
  const desired = { v0page, v1page, mpage };  // …and what everything asked for
  // The HIGH-WATER MARK, not what is in the box: once a boundary has been
  // published the Z80 may already have applied it, so a change for it can never
  // be folded in afterwards however the handshake then goes.
  let published = null;
  let inBox = false;
  let commit = 0, ack = 0;
  let changes = 0, records = 0;
  const soonest = () => (waiting.size ? Math.min(...waiting.keys()) : null);
  return {
    /** What the host means the levels to end up as, once everything is out. */
    get desired() { return { ...desired }; },
    /** What the engine has actually been told, as of the last bundle sent. */
    get live() { return { ...live }; },
    get coalesced() { return { changes, records, waiting: waiting.size }; },
    get commit() { return commit; },
    /** The Z80 has taken the bundle that was in the box. */
    acknowledge(a) { ack = a & 0xff; if (ack === (commit & 0xff)) inBox = false; },
    get free() { return !inBox; },
    /**
     * Ask for `set` (any subset of the three) to hold from observation `at`.
     * @returns the extended observation it was actually scheduled for
     */
    want(at, set) {
      changes += Object.keys(set).length;
      // A boundary already published is closed. The comparison is on extended
      // numbers, so it is a comparison and not a guess about which side of a
      // wrap something is on.
      let target = at;
      if (published !== null && target <= published) target = published + 1;
      if (!waiting.has(target)) waiting.set(target, {});
      // ONLY THIS BOUNDARY. A later boundary that does not mention the field
      // inherits it at emit time, from whatever was live by then — which is the
      // same answer, arrived at in time order instead of in call order.
      Object.assign(waiting.get(target), set);
      Object.assign(desired, set);
      return target;
    },
    /** Put the soonest waiting bundle in the box, if the box is free. */
    emit() {
      if (!this.free) return null;
      const at = soonest();
      if (at === null) return null;
      Object.assign(live, waiting.get(at));
      waiting.delete(at);
      published = at;
      inBox = true;
      commit = (commit + 1) & 0xff;
      records++;
      return { bundle: cmdBundle({ at, ...live }), commit, at };
    },
  };
}

/**
 * THE Z80 SIDE, as a reference: one decision a lap, on this lap's observation.
 *
 * @param box  what the mailbox holds — `readMailbox()`
 * @param st   {ack, staged:{}, late} updated in place
 * @param n    THIS observation's number, after the decoder has finalised it
 */
/**
 * THE BOUNDARY A PUBLISH ATTEMPT NAMES (R21 §50.2).
 *
 * The host knows `rExt`, the extended observation number the snapshot read gave
 * it, and reads the decoder's own live counter — one byte — inside the same
 * stopped Z80 as the ack. The engine publishes its snapshot 62.8% of the way
 * through a lap, so the snapshot the host holds is either the lap now running
 * or the one before it, and the host cannot tell which from the number alone.
 * The live counter settles it:
 *
 *   live == (rExt + 1) & $ff   the snapshot was the newer face   -> rExt + 2
 *   live == (rExt + 2) & $ff   it was the older one              -> rExt + 3
 *
 * Both name the boundary AFTER the counter that is running as the bytes are
 * written, which is the earliest one a bundle can still be applied at without
 * being late. Anything else means the observation series is outside the range
 * the read predicted: publish nothing, count it, let the bus go.
 *
 * The comparison is a byte and the answer is a u16 built from `rExt`, so the
 * two wraps are independent: $ff -> $00 in the comparison, $ffff -> $0000 in
 * the target. The two candidate bytes are consecutive and therefore always
 * different, so a live counter can never match both.
 */
export function adaptiveTarget(rExt, liveLo) {
  const near = (rExt + 1) & 0xff, far = (rExt + 2) & 0xff;
  const live = liveLo & 0xff;
  if (live === near) return (rExt + 2) & 0xffff;
  if (live === far) return (rExt + 3) & 0xffff;
  return null;
}

export function refConsume(box, st, n) {
  const pending = box.commit !== st.ack;
  const d = (n - box.decisionObservation) & 0xffff;
  const due = pending && d < 0x8000;
  const late = due && d !== 0;
  if (due) {
    CMD_VALUES.forEach((k) => { st.staged[k] = box[k]; });
    st.ack = box.commit;
    if (late) st.late = ((st.late ?? 0) + 1) & 0xff;
  }
  return { pending, due, late, d };
}

// ── THE CONSUMER AS Z80 PIECES ───────────────────────────────────────────
//
// Ten positions, b9 and b10 of every block, one copy of the chain a lap. Every
// operand is a FIXED address or a self-modified immediate, so there is no
// pointer to build and no register to borrow: `A` and the flags are the only
// live things, `AF'` carries the one value that has to cross a slot boundary
// with its flags (the borrow out of the low half of the comparison), and BC is
// never touched — which the test asserts by disassembling the emitted bytes.

const b = (name, ops, extra = {}) => ({ name, ops, cycles: cost(ops), ...extra });

/**
 * Ways to get the consumer's ORDER wrong (R17 §43.6 step 3).
 *
 * `ack-early` is the one the mailbox's whole shape depends on: the ack is what
 * lets the 68000 write the next payload, so giving it before the three values
 * have been stored hands the box back while this lap is still reading it.
 */
export const COMMAND_FAULTS = {
  "ack-early": "the ack is given before the three values have been stored",
};

export function commandBlocks(m, cfg, tag = "", { fault = null } = {}) {
  if (fault && !COMMAND_FAULTS[fault]) throw new Error(`unknown command fault ${fault}`);
  const lbl = (n) => `mb_${n}${tag}`;
  const OBS = m.mailbox.fields.decisionObservation.offset;
  const VAL = m.mailbox.fields.v0page.offset;
  const COMMIT = m.L.control.commandCommit.offset;
  const ACK = m.commandAck, LATE = m.lateCount;
  const CNT = m.stageBase;                       // the decoder's own counter
  const V0 = m.stageBytes, DUMP = m.dumpBytes;
  const SUPPRESS = (V0 ^ DUMP) & 0xff;
  if ((V0 & 0xff00) !== (DUMP & 0xff00))
    throw new Error("the staged bytes and the bit bucket must share a page");
  for (let k = 1; k < CMD_VALUES.length; k++)
    if ((((V0 + k) ^ (DUMP + k)) & 0xff) !== SUPPRESS)
      throw new Error("the suppression xor does not survive the walk along the values");
  // The sites the chain writes into itself. `ack` lives in three of them and in
  // the globals byte the host reads; the rest are one-lap masks.
  const S = Object.fromEntries(["k1", "k2", "k3", "pend", "go1", "go2", "go3",
    "late", "olo", "slo", "shi"].map((n) => [n, lbl(n)]));
  const P = CMD_VALUES.map((_, i) => lbl(`st${i}`));
  const order = (list) => {
    if (fault !== "ack-early") return list;
    // …moved in front of the stores, and no longer held behind the edge.
    const ack = list.find((x) => x.name === "mb ack");
    const rest = list.filter((x) => x !== ack);
    const at = rest.findIndex((x) => x.edge);
    return [...rest.slice(0, at), { ...ack, afterEdge: false }, ...rest.slice(at)];
  };
  return order([
    // ── is there anything in the box? ─────────────────────────────────
    // `commit - ack`, with the engine's own ack held in the instruction that
    // uses it. Nothing is dereferenced and nothing is saved.
    b("mb pending", [
      op(`ld   a,(${hx(COMMIT)})`, 13, { what: "the 68000's commit byte" }),
      op([`${S.k1}:`, "sub  $00"], 7, { what: "…less the ack this engine last gave" }),
      op("sub  1", 7),
      op("sbc  a,a", 4),
      op("cpl", 4, { what: "$ff exactly when a bundle is waiting" }),
      op(`ld   (${S.pend}+1),a`, 13),
    ]),
    // ── the time, low half ────────────────────────────────────────────
    // AFTER the decoder has finalised this observation's number: the comparison
    // is against `count`, and using it before `count hi store` would be
    // comparing against last lap's (R17 §43.2). The placer checks the order.
    b("mb diff lo", [
      op(`ld   a,(${hx(OBS)})`, 13, { what: "the observation the bundle names" }),
      op(`ld   (${S.slo}+1),a`, 13),
      op(`ld   a,(${hx(CNT)})`, 13, { what: "…and the one this lap is" }),
      op([`${S.slo}:`, "sub  $00"], 7, { what: "the difference's low byte, and the borrow" }),
      op(`ld   (${S.olo}+1),a`, 13, { what: "kept for the exactly-on-time test" }),
      op("ex   af,af'", 4, { what: "the borrow, to the piece that needs it" }),
    ], { needsCount: true }),
    // ── the time, high half, and whether it is zero ───────────────────
    // ONE subtraction, shared: the sign of the high byte decides due, and the
    // OR of the two halves decides exact-or-late. Neither is recomputed.
    b("mb diff hi", [
      op("ex   af,af'", 4, { what: "the borrow, back" }),
      op(`ld   a,(${hx(OBS + 1)})`, 13),
      op(`ld   (${S.shi}+1),a`, 13, { what: "…`ld` leaves the borrow alone" }),
      op(`ld   a,(${hx(CNT + 1)})`, 13),
      op([`${S.shi}:`, "sbc  a,$00"], 7, { what: "the difference, with the borrow" }),
      op(`ld   (${hx(m.cmd.dhi)}),a`, 13),
      op([`${S.olo}:`, "or   $00"], 7, { what: "…or its low half: zero only if exact" }),
      op(`ld   (${hx(m.cmd.nx)}),a`, 13),
    ], { needsCount: true }),
    // ── due, and therefore going to happen ────────────────────────────
    b("mb go", [
      op(`ld   a,(${hx(m.cmd.dhi)})`, 13),
      op("add  a,a", 4, { what: "the sign into the carry" }),
      op("sbc  a,a", 4, { what: "$ff when the bundle is still in the FUTURE" }),
      op("cpl", 4, { what: "…so this is $ff when its boundary has come" }),
      op([`${S.pend}:`, "and  $00"], 7, { what: "…and there is a bundle in the box" }),
      op(`ld   (${S.go1}+1),a`, 13, { what: "into the destination blend" }),
      op(`ld   (${S.go2}+1),a`, 13, { what: "…the late test" }),
      op(`ld   (${S.go3}+1),a`, 13, { what: "…and the ack" }),
    ]),
    // ── where the three values are going ──────────────────────────────
    // The staged bytes and the bit bucket differ by one bit of their low byte,
    // and by the same bit all the way along the three, so the whole suppression
    // is `and` / `xor` on one address.
    b("mb dest", [
      op([`${S.go1}:`, "ld   a,$00"], 7),
      op(`and  ${SUPPRESS}`, 7),
      op(`xor  ${hx(DUMP & 0xff)}`, 7, { what: "the staged bytes, or the bit bucket" }),
      op(`ld   (${P[0]}+1),a`, 13),
      op("inc  a", 4),
      op(`ld   (${P[1]}+1),a`, 13),
      op("inc  a", 4),
      op(`ld   (${P[2]}+1),a`, 13),
    ]),
    // ── the three values, stored ──────────────────────────────────────
    // BOTH OF THESE MUST SIT BETWEEN THE SAME TWO BLOCK EDGES (R17 §43.4): the
    // edge picks the three staged bytes up together, so an edge landing between
    // two of these stores would run a block on half of one bundle and half of
    // the last one.
    b("mb store 01", [
      op(`ld   a,(${hx(VAL)})`, 13),
      op([`${P[0]}:`, `ld   (${hx(DUMP)}),a`], 13,
        { what: "voice 0's level page — the operand starts on the bit bucket" }),
      op(`ld   a,(${hx(VAL + 1)})`, 13),
      op([`${P[1]}:`, `ld   (${hx(DUMP + 1)}),a`], 13, { what: "voice 1's" }),
    ], { edge: true }),
    b("mb store 2", [
      op(`ld   a,(${hx(VAL + 2)})`, 13),
      op([`${P[2]}:`, `ld   (${hx(DUMP + 2)}),a`], 13, { what: "…and the master's" }),
    ], { edge: true }),
    // ── and only then, the acknowledgement ────────────────────────────
    // AFTER the three stores, never before: the ack is what lets the 68000
    // write the next payload, and it must not do that over a bundle this lap
    // has read but not yet applied.
    b("mb ack", [
      op(`ld   a,(${hx(COMMIT)})`, 13),
      op([`${S.k2}:`, "xor  $00"], 7),
      op([`${S.go3}:`, "and  $00"], 7, { what: "…only if the bundle was taken" }),
      op([`${S.k3}:`, "xor  $00"], 7),
      op(`ld   (${hx(ACK)}),a`, 13, { what: "the byte the 68000 reads" }),
      op(`ld   (${S.k1}+1),a`, 13, { what: "…and the three the engine uses" }),
      op(`ld   (${S.k2}+1),a`, 13),
      op(`ld   (${S.k3}+1),a`, 13),
    ], { afterEdge: true }),
    // ── exactly on time, or late? ─────────────────────────────────────
    // §33.4 asked for this count. A bundle applied at a boundary later than the
    // one it named is late; a phase correction or a bus grab is not, because
    // neither moves the observation number.
    b("mb late", [
      op(`ld   a,(${hx(m.cmd.nx)})`, 13),
      op("sub  1", 7),
      op("sbc  a,a", 4),
      op("inc  a", 4, { what: "1 when the boundary had already gone, 0 when it is this one" }),
      op([`${S.go2}:`, "and  $00"], 7, { what: "…and only when it was actually staged" }),
      op(`ld   (${S.late}+1),a`, 13),
    ], { afterEdge: true }),
    b("mb count", [
      op(`ld   a,(${hx(LATE)})`, 13),
      op([`${S.late}:`, "add  a,$00"], 7),
      op(`ld   (${hx(LATE)}),a`, 13, { what: "lateCommandCount" }),
    ], { afterEdge: true }),
  ]);
}

/** What one lap of it costs. */
export const commandCost = (blocks) => blocks.reduce((t, x) => t + x.cycles, 0);

/**
 * Boot. The ack and the count start at zero, nothing is pending, and the three
 * destinations point at the BIT BUCKET — so the first lap, before anything has
 * been decided, stages nothing rather than whatever the operands held.
 */
export function commandBootLines(m, tag = "") {
  const lbl = (n) => `mb_${n}${tag}`;
  // ONLY WHAT THE FIRST LAP WOULD READ BEFORE WRITING. The three store
  // operands are emitted pointing at the BIT BUCKET, so even the assembled
  // image before anything has run stages nothing.
  //
  // ONLY WHAT THE FIRST LAP WOULD READ BEFORE WRITING. Every other operand and
  // work byte in this chain is written by an earlier piece of the SAME lap
  // before any later piece looks at it — the placement proves the order — so
  // zeroing them at boot is dead code, and dead code in this image costs bytes
  // the region does not have. What is left is the ack, in the three
  // instructions that hold it and in the byte the 68000 reads, and the late
  // count, which accumulates into itself.
  return ["xor  a",
    `ld   (${hx(m.commandAck)}),a`,
    `ld   (${hx(m.lateCount)}),a`,
    `ld   (${lbl("k1")}+1),a`,
    `ld   (${lbl("k2")}+1),a`,
    `ld   (${lbl("k3")}+1),a`];
}

/**
 * WHERE THE CHAIN GOES (R17 §43.4).
 *
 * b9 and b10 of every block — ten positions, `(73 + 72) * 5` cycles — and three
 * ordering constraints that come from the schedule rather than from taste:
 *
 *   needsCount   the comparison reads the decoder's counter, so it must be
 *                placed after the slot the decode's `count hi store` landed in
 *   edge         the three stores go in the block whose edge is the last one
 *                before the lap boundary, so the change lands exactly there
 *   afterEdge    the ack and the late count follow the stores
 */
export function packCommand(blocks, cfg, { rooms, ceilings, budget, countAt = -1 }) {
  const bs = cfg.blockSamples, lead = cfg.lead, n = cfg.cycleSlots;
  const positions = [];
  for (let i = 0; i < n; i++) {
    const p = (i + lead) % bs;
    if (p === 9 || p === 10) positions.push(i);
  }
  // The edge that activates state for the lap's first output is the slot that
  // builds the sample before it. Derived from the schedule, not written down.
  const edgeSlot = (n - lead - 1 + n) % n;
  if ((edgeSlot + lead) % bs !== bs - 1)
    throw new Error("the lap boundary's block edge is not a block edge");
  const edgeBlock = Math.floor((edgeSlot + lead) / bs);
  const pinned = positions.filter((i) => Math.floor((i + lead) / bs) === edgeBlock);
  if (pinned.length !== 2) throw new Error("the edge block does not hold both consumer positions");
  // WHICH RESIDUALS A PAD CAN ACTUALLY HIT. `padTo` builds from {4, 6, 7, 10,
  // 12} plus `ld b,k`/`djnz`, but a slot that has to carry a value in BC gets
  // neither `inc bc` nor the djnz form (schedule.mjs), and whether a given slot
  // is one of those depends on a placement that has not happened yet. So the
  // test is the CONSERVATIVE set — what {4, 7, 10, 12, 21} can reach — and
  // 1, 2, 3, 5, 6, 9 and 13 are refused wherever they fall.
  const UNREACHABLE = new Set([1, 2, 3, 5, 6, 9, 13]);
  const paddable = (r) => r >= 0 && !UNREACHABLE.has(r);
  const first = blocks.findIndex((x) => x.edge);
  const last = blocks.length - 1 - [...blocks].reverse().findIndex((x) => x.edge);

  const attempt = (room) => {
    const at = new Map(positions.map((i) => [i, []]));
    const load = new Map(positions.map((i) => [i, 0]));
    const edges = blocks.filter((x) => x.edge);
    let k = 0, failed = null;
    for (let idx = 0; idx < blocks.length; idx++) {
      const piece = blocks[idx];
      let placed = null;
      if (piece.edge) {
        placed = pinned[edges.indexOf(piece)];
        if (positions.indexOf(placed) < k) { failed = piece; break; }
      } else {
        const lo = piece.afterEdge || idx > last
          ? positions.indexOf(pinned[1]) + 1 : k;
        const hi = idx < first ? positions.indexOf(pinned[0]) : positions.length;
        for (let j = Math.max(k, lo); j < hi; j++) {
          const i = positions[j];
          if (pinned.includes(i)) continue;
          if (piece.needsCount && i <= countAt) continue;
          // Fits inside whatever budget this pass is using, AND leaves a
          // residual the pad solver can actually hit — which is a property of
          // the SLOT, not of the budget, so it is always checked against the
          // physical room (schedule.mjs `padTo`).
          if (room(i) - load.get(i) - piece.cycles < 0) continue;
          if (!paddable(rooms.get(i) - load.get(i) - piece.cycles)) continue;
          placed = i; break;
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
  // holds. A consumer that needs the second pass has not fitted, and the report
  // says which positions it pushed past 83.9% and by how much.
  let r = attempt((i) => ceilings.get(i)), spilled = false;
  if (r.failed) { r = attempt((i) => rooms.get(i)); spilled = true; }
  const plan = new Map();
  for (const [i, ps] of r.at) if (ps.length) plan.set(i, ps.flatMap((p) => p.ops));
  const over = [...r.load].filter(([i, c]) => c > ceilings.get(i))
    .map(([i, c]) => ({ slot: i, cycles: c, ceiling: ceilings.get(i) }));
  const slotOf = (name) => [...r.at].find(([, ps]) => ps.some((p) => p.name === name))?.[0];
  return { plan, positions, pinned, edgeSlot, load: r.load, at: r.at,
    failed: r.failed, spilled, over, total: commandCost(blocks), budget, countAt,
    firstCount: Math.min(...blocks.filter((x) => x.needsCount)
      .map((x) => slotOf(x.name) ?? Infinity)) };
}
