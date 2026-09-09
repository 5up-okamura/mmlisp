// THE PROTOCOL, AS Z80 CODE (docs/dac-engine-implementation.md R12 §33.2-§33.3).
//
// Four jobs, each constant time, each in its own slot:
//
//   read     the H reading is taken and stashed
//   check    the host's control block is read and, if its commit changed, THIS
//            observation's decode is invalidated before it is finalised
//   decode   the reading is decoded from the stash
//   publish  the five-byte stage is copied into the face the 68000 is not
//            reading, and the selector is flipped last
//
// THE ORDER IS THE POINT (§33.3). The check runs AFTER the reading is taken and
// BEFORE the decode is finalised, so a stop that happened before the read is
// seen by the very next check, and one that happens after the check is seen by
// the next difference and the next check. Neither can slip through between them.
//
// Everything here is branch-free. The invalidation is an AND with a mask that is
// $FF when the commit is unchanged and $00 when it is not — the same technique
// the acquisition gate and the corrector's expiry use — so the slot has one
// length whatever the host did.
import { op } from "./schedule.mjs";
import { GLOB } from "./config.mjs";
import { protocolLayout, protoGlobals, mailboxLayout, SNAPSHOT, SNAPSHOT_BYTES,
  SNAPSHOT_STRIDE } from "./protocol.mjs";

const hx = (n) => `$${n.toString(16)}`;

/**
 * Where everything lives, for one configuration.
 *
 * @param state  the decoder's field offsets — STATE for P1, SPLIT_STATE for 2ch
 */
export function protoMap(cfg, state) {
  const L = protocolLayout(cfg.ram.pub[0]);
  const g = cfg.ram.glob[0];
  const decode = g + GLOB.decode;
  const G = protoGlobals(decode, state.countLo);
  if (G.end > cfg.ram.glob[1])
    throw new Error("the protocol's globals do not fit the globals region");
  // The mailbox's payload sits at the head of the region the old queue had. The
  // rest of that page is NOT released (R17 §43.1) — it stays reserved for the
  // voice state a later profile will need, and the ledger keeps it.
  const mailbox = mailboxLayout(cfg.ram.queue ? cfg.ram.queue[0] : 0x1d00);
  return { L, glob: g, stage: G.fields, stageBase: G.stage, mailbox,
    lastPhaseCommit: G.lastPhaseCommit, commandAck: G.commandAck,
    lateCount: G.lateCount, cmd: G.cmd, globEnd: G.end,
    // The staged bytes a command writes: the block edge's own inputs, and the
    // bit bucket a suppressed command is written into instead.
    stageBytes: g + GLOB.v0page, dumpBytes: g + GLOB.cmdDump,
    stagePad: g + GLOB.stagePad, decode, observe: g + GLOB.observe, state };
}

/**
 * The host's control block, checked and acted on (§33.3).
 *
 * `phaseCommit` is the only byte read for the decision: the 68000 writes it
 * after phaseGeneration. `queueHead` is a separate commit domain and changing
 * it for an ordinary command must not invalidate phase. When phaseCommit changes,
 * KNOWN, VALID, DELTA and EXPECT are all cleared — the next reading becomes a
 * BASE rather than a difference, which is the whole point of the invalidation:
 * a displacement H cannot be trusted across must not be accepted as a small
 * ordinary one.
 *
 * `phaseGeneration` is copied into the stage unconditionally, so the snapshot
 * says which stretch the observation belongs to whether or not it changed.
 * `bootGeneration` is NOT copied here — the Z80 latches it once at boot, so a
 * host that bumps it without resetting the Z80 sees its own number missing from
 * the snapshots instead of being echoed back at it.
 *
 * @param decodeState  base of the decoder's 6-byte state, and its field offsets
 */
export function protoCheckOps(m, state = m.state) {
  const S = (k) => hx(m.decode + state[k]);
  return [
    // THE PHASE GENERATION IS READ FIRST, and that order is the whole
    // correctness of this piece. A grab is atomic from the Z80's side — it is
    // stopped for the whole of it — so a grab landing between these two reads
    // gives the Z80 the OLD value of whichever it read first. Reading the commit
    // first therefore produces "old commit, new phase": the engine publishes a
    // new phase stretch WITHOUT having invalidated anything, which is precisely
    // the lie the generation exists to prevent, and it happened on 48 of 493
    // invalidations before this order was fixed. Reading the phase first gives
    // "old phase, new commit" instead: the engine invalidates and publishes the
    // stale phase for one more lap, which is late but never wrong.
    op(`ld   a,(${hx(m.L.control.phaseGeneration.offset)})`, 13),
    op(`ld   (${hx(m.stage.phaseGeneration)}),a`, 13, { what: "the phase stretch this observation is in" }),
    op(`ld   a,(${hx(m.L.control.phaseCommit.offset)})`, 13, { what: "the host's phase commit byte" }),
    op("ld   b,a", 4),
    op(`ld   a,(${hx(m.lastPhaseCommit)})`, 13),
    op("sub  b", 4, { what: "0 exactly when nothing was committed since" }),
    op("cp   1", 7),
    op("sbc  a,a", 4, { what: "$ff = unchanged, $00 = invalidate" }),
    op("ld   c,a", 4),
    op("ld   a,b", 4),
    op(`ld   (${hx(m.lastPhaseCommit)}),a`, 13, { what: "latch the phase commit, changed or not" }),
    ...["known", "valid", "delta", "expect"].flatMap((k) => [
      op(`ld   a,(${S(k)})`, 13),
      op("and  c", 4),
      op(`ld   (${S(k)}),a`, 13, { what: `invalidate ${k}` }),
    ]),
  ];
}

/**
 * Publish the stage into the face the 68000 is NOT reading, then flip the
 * selector — strictly last, which is what makes a reader see either the whole
 * previous snapshot or the whole new one (protocol.mjs `tornSnapshotPossible`).
 *
 * The destination is one self-modified `ld hl,nn` rather than one self-modified
 * store operand per byte: both faces are inside one page, so a single `xor` on
 * the low byte is the whole face swap.
 */
export function protoPublishOps(m, tag = "", { useShadow = false } = {}) {
  const first = SNAPSHOT[0][0];
  const f0 = m.L.faces[0][first].offset, f1 = m.L.faces[1][first].offset;
  // The swap is one `xor` on the low byte whatever the stride works out to, as
  // long as both faces live in the same page.
  const swap = f0 ^ f1;
  if ((f0 >> 8) !== (f1 >> 8) || swap > 0xff)
    throw new Error("the two faces are not one xor apart inside one page");
  const lbl = `proto_dst${tag}`;
  // P1 KEEPS ITS WAVEFORM CURSOR IN HL for the whole run, so the copy borrows
  // the shadow set the way the decode does. In a build where HL is free the two
  // `exx` are not emitted rather than being paid for out of habit.
  const ops = [];
  if (useShadow) ops.push(op("exx", 4, { what: "borrow the shadow set for the copy" }));
  ops.push(op([`${lbl}:`, `ld   hl,${hx(f1)}`], 10, { what: "the face the 68000 is not reading" }));
  for (let k = 0; k < SNAPSHOT_BYTES; k++) {
    ops.push(op(`ld   a,(${hx(m.stageBase + k)})`, 13));
    ops.push(op("ld   (hl),a", 7));
    ops.push(op("inc  l", 4));
  }
  ops.push(op(`ld   a,(${lbl}+1)`, 13));
  ops.push(op(`xor  ${swap}`, 7, { what: "the other face, next time" }));
  ops.push(op(`ld   (${lbl}+1),a`, 13));
  ops.push(op(`ld   a,(${hx(m.L.publishSelect.offset)})`, 13));
  ops.push(op("xor  1", 7));
  ops.push(op(`ld   (${hx(m.L.publishSelect.offset)}),a`, 13,
    { what: "the selector, LAST — this is what publishes it" }));
  if (useShadow) ops.push(op("exx", 4));
  return ops;
}

/**
 * The 16-sample block boundaries inside one lap, as offsets from the lap's own
 * first output (R15 §39.3).
 *
 * GENERATED, not written down. A command applies at a block boundary, so the
 * consumer compares its extended time against the lap's low value plus one of
 * these — and 0/16/32/48/64 written out by hand is five places for the number
 * to be wrong the day the lap or the block changes size.
 */
export function outputBlockOffsets(cfg) {
  const n = cfg.cycleSlots / cfg.blockSamples;
  if (!Number.isInteger(n))
    throw new Error(`a lap of ${cfg.cycleSlots} outputs is not a whole number`
      + ` of ${cfg.blockSamples}-sample blocks`);
  return Array.from({ length: n }, (_, i) => i * cfg.blockSamples);
}

/**
 * Boot (§33.2). The 68000 has already written the control block while holding
 * the bus, so the Z80's first act is to take its identity FROM it: the run it
 * belongs to, the phase stretch it starts in, and the commit it has already
 * seen. The output index starts at zero and the first lap's first DAC write is
 * sample zero.
 *
 * The 68000 sends no timed command until it reads back a snapshot carrying its
 * own boot generation, which is what makes this handshake and not a guess.
 */
export function protoBootLines(m) {
  const c = m.L.control;
  return [
    // The two bytes the decoder owns are NOT zeroed here — its own init does
    // that — so the stage is cleared from the third byte on.
    `ld   hl,${hx(m.stageBase + 2)}`,
    `ld   b,${SNAPSHOT_BYTES - 2 + 3}`,
    "protoinit:",
    "ld   (hl),0",
    "inc  l",
    "djnz protoinit",
    // The run this is, echoed from the host and never recomputed.
    `ld   a,(${hx(c.bootGeneration.offset)})`,
    `ld   (${hx(m.stage.bootGeneration)}),a`,
    `ld   a,(${hx(c.bootGeneration.offset + 1)})`,
    `ld   (${hx(m.stage.bootGeneration + 1)}),a`,
    `ld   a,(${hx(c.phaseGeneration.offset)})`,
    `ld   (${hx(m.stage.phaseGeneration)}),a`,
    // The commit already in place is not an invalidation: it is where we start.
    `ld   a,(${hx(c.phaseCommit.offset)})`,
    `ld   (${hx(m.lastPhaseCommit)}),a`,
    // The mailbox is empty — the loop above cleared the ack and the late count —
    // and the first face to be written is face 1, so the first publication
    // flips the selector from 0 to 1.
    "xor  a",
    `ld   (${hx(m.L.publishSelect.offset)}),a`,
  ];
}

/** What the protocol costs, per lap, so a budget can be read off. */
export function protoCost(m, state = m.state) {
  const c = (ops) => ops.reduce((t, o) => t + o.cycles, 0);
  return {
    check: c(protoCheckOps(m, state)),
    publish: c(protoPublishOps(m, "", { useShadow: true })),
  };
}

// ── THE PROTOCOL AS CHAIN PIECES, for the 2ch schedule (R14 §37.2, §37.3) ──
//
// The 2ch engine's registers are all spoken for — HL is the play cursor, DE the
// YM data port, IX and the shadow set the mixer's — with ONE exception that
// changes the shape of this entirely: `mix_one` works inside `exx`, so MAIN BC
// is free, and `preserveBC()` already knows how to keep it alive across the
// slots between two pieces. So the publication is a pointer walk in BC with a
// single self-modified operand, not one absolute store per byte each with its
// own.
//
// Every piece here is constant time. There is no path that is shorter when a
// carry is zero, and none that is shorter when nothing was invalidated.

const b = (name, ops) => ({ name, ops, cycles: ops.reduce((t, o) => t + o.cycles, 0) });

/**
 * The five-byte snapshot, into the face the 68000 is not reading, then the
 * selector — strictly last.
 *
 * BC is live from the `ld bc,FACE*` to the last `ld (bc),a`: `ld a,(nn)` and
 * `ld (bc),a` leave it alone and `inc c` is what walks it. The two faces are in
 * one page, so the pointer's own swap is one `xor` on the low byte and the
 * high byte never moves — which is why `inc c` is enough and `inc bc` is not
 * needed.
 */
export function protoPublishSplit(m, tag = "") {
  const first = SNAPSHOT[0][0];
  const f0 = m.L.faces[0][first].offset, f1 = m.L.faces[1][first].offset;
  const swap = f0 ^ f1;
  if ((f0 >> 8) !== (f1 >> 8) || swap > 0xff)
    throw new Error("the two faces are not one xor apart inside one page");
  if (((f1 & 0xff) + SNAPSHOT_BYTES - 1) > 0xff)
    throw new Error("a face straddles a page: `inc c` would not walk it");
  const lbl = `proto_dst${tag}`;
  const out = [b("pub ptr",
    [op([`${lbl}:`, `ld   bc,${hx(f1)}`], 10, { what: "the face the 68000 is not reading" })])];
  for (let k = 0; k < SNAPSHOT_BYTES; k++) {
    const last = k === SNAPSHOT_BYTES - 1;
    out.push(b(`pub ${k}`, [op(`ld   a,(${hx(m.stageBase + k)})`, 13), op("ld   (bc),a", 7),
      ...(last ? [] : [op("inc  c", 4)])]));
  }
  out.push(b("pub flip ptr", [op(`ld   a,(${lbl}+1)`, 13), op(`xor  ${swap}`, 7),
    op(`ld   (${lbl}+1),a`, 13, { what: "the other face, next time" })]));
  out.push(b("pub flip sel", [op(`ld   a,(${hx(m.L.publishSelect.offset)})`, 13),
    op("xor  1", 7),
    op(`ld   (${hx(m.L.publishSelect.offset)}),a`, 13,
      { what: "the selector, LAST — this is what publishes it" })]));
  return out;
}

/** What each publication piece leaves in BC. */
export function protoPublishLive() {
  const L = [["b", "c"]];                       // the pointer
  for (let k = 0; k < SNAPSHOT_BYTES; k++) L.push(k === SNAPSHOT_BYTES - 1 ? [] : ["b", "c"]);
  L.push([], []);                               // the two flips carry nothing
  return L;
}

/**
 * The host's phase control, checked after the reading is taken and before the
 * decode is finalised (R12 §33.3).
 *
 * ONLY KNOWN IS CLEARED, and that is not a shortcut. The check runs before the
 * decode's own pieces, and the decode then writes VALID from `known & (known)`,
 * DELTA gated by VALID and EXPECT gated by KNOWN — all three in this same
 * observation. Clearing them here as well would be eight more pieces writing
 * values that are overwritten a few slots later. What the causal chain has to
 * show is the consequence, and the gate follows it all the way through: a
 * changed `phaseCommit` clears KNOWN, the decode publishes VALID = 0, the
 * corrector drops the debt and every ladder operand goes neutral.
 */
export function protoCheckSplit(m, state = m.state) {
  const S = (k) => hx(m.decode + state[k]);
  const C = m.L.control;
  return [
    // The generation is read BEFORE the commit: a grab is atomic from the Z80's
    // side, so whichever is read first is the one that comes back stale, and
    // "old commit, new generation" would publish a new phase stretch without
    // invalidating anything (R12 §34.4).
    b("ctl gen", [op(`ld   a,(${hx(C.phaseGeneration.offset)})`, 13), op("ld   b,a", 4)]),
    b("ctl gen keep", [op("ld   a,b", 4),
      op(`ld   (${hx(m.stage.phaseGeneration)}),a`, 13, { what: "the phase stretch this observation is in" })]),
    b("ctl commit", [op(`ld   a,(${hx(C.phaseCommit.offset)})`, 13), op("ld   b,a", 4)]),
    b("ctl diff", [op(`ld   a,(${hx(m.lastPhaseCommit)})`, 13), op("sub  b", 4), op("ld   c,a", 4)]),
    b("ctl latch", [op("ld   a,b", 4), op(`ld   (${hx(m.lastPhaseCommit)}),a`, 13)]),
    b("ctl mask", [op("ld   a,c", 4), op("cp   1", 7), op("sbc  a,a", 4),
      op("ld   c,a", 4, { what: "$ff = unchanged, $00 = invalidate" })]),
    b("ctl known", [op(`ld   a,(${S("pknown")})`, 13), op("and  c", 4), op("ld   b,a", 4)]),
    b("ctl known keep", [op("ld   a,b", 4),
      op(`ld   (${S("pknown")}),a`, 13, { what: "invalidate the acquisition" })]),
  ];
}

export const PROTO_CHECK_LIVE = [["b"], [], ["b"], ["b", "c"], ["c"], ["c"],
  ["b", "c"], []];
