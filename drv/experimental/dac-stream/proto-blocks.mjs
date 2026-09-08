// THE PROTOCOL, AS Z80 CODE (docs/dac-engine-implementation.md R12 §33.2-§33.3).
//
// Four jobs, each constant time, each in its own slot:
//
//   read     the H reading is taken and stashed
//   check    the host's control block is read and, if its commit changed, THIS
//            observation's decode is invalidated before it is finalised
//   decode   the reading is decoded from the stash
//   publish  the nine-byte stage is copied into the face the 68000 is not
//            reading, and the selector is flipped last
//   advance  the 32-bit output index moves on by one lap's worth of samples
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
import { protocolLayout, PROTO_GLOB, STAGE, SNAPSHOT, SNAPSHOT_BYTES,
  SNAPSHOT_STRIDE } from "./protocol.mjs";

const hx = (n) => `$${n.toString(16)}`;

/** Where everything lives, for one configuration. */
export function protoMap(cfg) {
  const L = protocolLayout(cfg.ram.pub[0]);
  const g = cfg.ram.glob[0];
  const stage = Object.fromEntries(Object.entries(STAGE).map(([k, v]) => [k, g + v]));
  return { L, glob: g, stage, stageBase: g + PROTO_GLOB.stage,
    lastPhaseCommit: g + PROTO_GLOB.lastPhaseCommit, queueTail: g + PROTO_GLOB.queueTail,
    decode: g + GLOB.decode, observe: g + GLOB.observe };
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
export function protoCheckOps(m, state) {
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
 * The destination is one self-modified `ld hl,nn` rather than nine self-modified
 * store operands: the two faces are nine bytes apart and both are inside one
 * page, so `xor 9` on the low byte is the whole face swap.
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
 * The output sample index, advanced once a lap by the lap's own sample count.
 *
 * ONE PER OUTPUT is the semantics, not the arithmetic: the counter names DAC
 * writes and it is read at one defined instruction position — the lap's first
 * `$2A` write — so adding the lap's worth once produces exactly the same
 * sequence at that position as adding one eighty times, for a fifth of the
 * cycles. It does not advance while the bus is held, because the Z80 is not
 * running, and it does not move when the phase is corrected, because a
 * correction changes when a sample is written and not how many there were.
 *
 * The carry crosses the four bytes inside ONE block: `ld a,(nn)` and
 * `ld (nn),a` leave the flags alone, so nothing has to be saved between them.
 */
export function protoAdvanceOps(m, samples) {
  const at = m.stage.boundarySampleIndex;
  const ops = [];
  for (let k = 0; k < 4; k++) {
    ops.push(op(`ld   a,(${hx(at + k)})`, 13));
    ops.push(op(k === 0 ? `add  a,${samples}` : "adc  a,0", 7));
    ops.push(op(`ld   (${hx(at + k)}),a`, 13,
      k === 3 ? { what: "the output sample index, one lap on" } : {}));
  }
  return ops;
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
    "ld   b,9",
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
    // The queue is empty and the first face to be written is face 1, so the
    // first publication flips the selector from 0 to 1.
    "xor  a",
    `ld   (${hx(m.queueTail)}),a`,
    `ld   (${hx(m.L.publishSelect.offset)}),a`,
  ];
}

/** What the protocol costs, per lap, so a budget can be read off. */
export function protoCost(m, state, samples) {
  const c = (ops) => ops.reduce((t, o) => t + o.cycles, 0);
  return {
    check: c(protoCheckOps(m, state)),
    publish: c(protoPublishOps(m, "", { useShadow: true })),
    advance: c(protoAdvanceOps(m, samples)),
  };
}
