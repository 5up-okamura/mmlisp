// THE FIXED-LENGTH PCM STATE COMMAND, CONSUMED BY THE Z80
// (docs/dac-engine-implementation.md R15 §39.4 steps 3-4).
//
// One record type, one length, one effect: at a named 16-sample boundary, one
// of the mixer's STAGED bytes takes a new value. The block edge picks the
// staged bytes up at b = 15 and self-modifies the mixer with them, so a change
// that lands here is whole-block by construction — §3.4's rule is the schedule's
// shape rather than a check.
//
//   { size:u8 = 8, type:u8, applyAtLow:u16, slot:u8, value:u8, 0, 0 }
//
// EVERYTHING HERE IS CONSTANT TIME. There is no path that is shorter when the
// queue is empty, when the record is in the future, or when its type is one the
// engine does not know. A command either happens or does not; the slot it
// happens in is the same length either way, because the slot boundary is the
// DAC write and a branch here would move it.
//
// The masks are the same technique the acquisition gate, the corrector's expiry
// and the protocol's invalidation use: a compare, `sbc a,a`, and an `and`.
//
//   have   $ff when a WHOLE record is behind the host's cursor
//   due    $ff when its time is at or before this boundary
//   go     have & due — the record is consumed (the tail steps by its length)
//   apply  go & the type is one we know — the staged byte is written
//
// `go` and `apply` are different on purpose (§39.4 step 4): a record the engine
// does not recognise is EXPLICITLY HANDLED — stepped over — rather than left to
// block the queue for ever behind a type nobody will ever consume.
import { op, cost } from "./schedule.mjs";
import { CMD_HEADER } from "./protocol.mjs";

const hx = (n) => `$${n.toString(16)}`;

/** The one type the engine knows. */
export const CMD_PCM_STATE = 1;
/** Every record is this long. The size byte still carries it, and is checked. */
export const CMD_BYTES = 8;
/** Where the fields sit inside a record. */
export const CMD = { size: 0, type: 1, applyLo: 2, applyHi: 3, slot: 4, value: 5 };
if (CMD.slot !== CMD_HEADER) throw new Error("the payload must start after the header");

/**
 * The staged bytes a command may write, in the order the record names them.
 *
 * They are the block edge's own inputs (gen-stream.mjs `blockEdge`), so what a
 * command can change is exactly what a block boundary can carry — and the
 * record's slot number is MASKED to this many, so a wrong or hostile number
 * writes one of these and never anything else.
 */
export const CMD_SLOTS = ["v0page", "v1page", "mpage"];
export const CMD_SLOT_MASK = 3;

/**
 * The reference consumer, in JS: what the Z80 below has to agree with.
 *
 * @param q     {mem, base, size} the queue's page
 * @param st    {tail, staged:{}} the consumer's state, updated in place
 * @param head  the host's cursor
 * @param at    the output index of the boundary being decided (16 bits)
 */
export function refConsume(q, st, head, at) {
  const byte = (k) => q.mem[q.base + ((st.tail + k) % q.size)];
  const avail = (head - st.tail + q.size) % q.size;
  const have = avail >= CMD_BYTES;
  // DUE means "not in the future": exactly on time and late are both consumed
  // here, because the boundary a late command lands on is the first one the
  // engine has not built, and this is it (§33.4 `lateTarget`).
  const applyAt = byte(CMD.applyLo) | (byte(CMD.applyHi) << 8);
  const due = have && ((at - applyAt) & 0xffff) < 0x8000;
  const known = have && byte(CMD.type) === CMD_PCM_STATE;
  const go = have && due;
  const apply = go && known;
  if (apply) st.staged[CMD_SLOTS[byte(CMD.slot) & CMD_SLOT_MASK]] = byte(CMD.value);
  if (go) st.tail = (st.tail + CMD_BYTES) % q.size;
  return { have, due, go, apply };
}

/**
 * The consumer as Z80 pieces, for ONE 16-sample block.
 *
 * A piece is indivisible — it is what fits between two slot boundaries — and
 * nothing crosses one in a register: A and the flags die at every boundary, so
 * every piece re-establishes its pointer and hands its result on in memory. The
 * three cheap-looking alternatives all fail here: HL is the play cursor and has
 * to be pushed and popped, DE is the YM data port, and IX, IY and the shadow
 * set are the mixer's.
 *
 * @param m   the protocol's map (proto-blocks.mjs `protoMap`)
 * @param g   {head} the host's queueHead address
 * @param blockSamples  what one block is worth, for the boundary's own step
 */
export function commandBlocks(m, blockSamples, tag = "") {
  const P = (k) => hx(m.queueTail);            // the record pointer's low byte
  const T = hx(m.queueTail);
  const OUT = m.outputLow;
  const HAVE = hx(m.commandMask);
  const HEAD = hx(m.L.control.queueHead.offset);
  const STAGE = m.stageBytes;                  // the first staged byte's address
  const DEST = hx(m.commandDest);              // …and which of them, once decided
  const b = (name, ops) => ({ name, ops, cycles: cost(ops) });
  const lbl = (n) => `cmd_${n}${tag}`;
  return [
    // ── is there a WHOLE record? ──────────────────────────────────────
    // `head - tail` in the page's own 8-bit arithmetic, so the wrap is free and
    // is never tested. One byte of the page is never used, which is what makes
    // `head === tail` mean empty rather than full (protocol.mjs `queueFree`).
    b("cmd have", [
      op("push hl", 11, { what: "the play cursor, for the length of this piece" }),
      op(`ld   hl,(${T})`, 16, { what: "L = the tail, H = the queue's page" }),
      op(`ld   a,(${HEAD})`, 13, { what: "the host's cursor" }),
      op("sub  l", 4, { what: "how many bytes are behind it" }),
      op(`cp   ${CMD_BYTES}`, 7),
      op("sbc  a,a", 4),
      op("cpl", 4, { what: "$ff exactly when a whole record is there" }),
      op(`ld   (${HAVE}),a`, 13),
      op("pop  hl", 10),
    ]),
    // ── is it DUE at this boundary? ───────────────────────────────────
    // The comparison is against the engine's own logical position, which is the
    // boundary being decided: this piece runs once a block and the position
    // steps by one block at the end of it, so no per-site constant is written
    // down anywhere (R15 §39.3).
    b("cmd due", [
      op("push hl", 11),
      op(`ld   hl,(${T})`, 16),
      op("inc  l", 4),
      op("inc  l", 4, { what: "→ the record's applyAtLow" }),
      op(`ld   a,(${hx(OUT)})`, 13, { what: "this boundary's output index, low" }),
      op("sub  (hl)", 7),
      op("inc  l", 4),
      op(`ld   a,(${hx(OUT + 1)})`, 13, { what: "…and high — `ld` leaves the borrow alone" }),
      op("sbc  a,(hl)", 7),
      op("add  a,a", 4, { what: "the difference's sign into the carry" }),
      op("sbc  a,a", 4, { what: "$ff when the command is still in the FUTURE" }),
      op("cpl", 4, { what: "…so this is $ff when it is due" }),
      op(`ld   hl,${HAVE}`, 10),
      op("and  (hl)", 7, { what: "…and a whole record is there: go" }),
      op("ld   (hl),a", 7),
      op("pop  hl", 10),
    ]),
    // ── is it a type we know, and what does that decide? ──────────────
    // Two masks come out of this, and they are deliberately not the same one.
    b("cmd type", [
      op("push hl", 11),
      op(`ld   hl,(${T})`, 16),
      op("inc  l", 4, { what: "→ the record's type" }),
      op("ld   a,(hl)", 7),
      op(`sub  ${CMD_PCM_STATE}`, 7),
      op("sub  1", 7, { what: "carry set exactly when it was that type" }),
      op("sbc  a,a", 4),
      op(`ld   hl,${HAVE}`, 10),
      op("and  (hl)", 7, { what: "apply = go AND a type we know" }),
      op([`${lbl("go")}:`, `ld   (${lbl("blend")}+1),a`], 13,
        { what: "…written into the blend's own operand" }),
      op("ld   a,(hl)", 7, { what: "go, whatever the type was" }),
      op(`and  ${CMD_BYTES}`, 7),
      op(`ld   (${lbl("step")}+1),a`, 13,
        { what: "the tail's step: the record's length, or nothing" }),
      op("pop  hl", 10),
    ]),
    // ── where the value is going, and what it is ──────────────────────
    // Two bytes out of the record: the value into the blend's own operand, and
    // the slot number — MASKED — into the address the next piece will use. The
    // mask is what makes a wrong or hostile slot number name one of the four
    // staged bytes and never anything else.
    b("cmd fetch", [
      op("push hl", 11),
      op(`ld   hl,(${T})`, 16),
      op("ld   a,l", 4),
      op(`add  a,${CMD.value}`, 7),
      op("ld   l,a", 4, { what: "→ the record's value" }),
      op("ld   a,(hl)", 7),
      op(`ld   (${lbl("blendx")}+1),a`, 13,
        { what: "…into the blend's first operand" }),
      op("dec  l", 4, { what: "→ the record's slot" }),
      op("ld   a,(hl)", 7),
      op(`and  ${CMD_SLOT_MASK}`, 7, { what: "confined to the staged bytes, always" }),
      op(`add  a,${hx(STAGE & 0xff)}`, 7),
      op(`ld   (${DEST}),a`, 13, { what: "→ the staged byte, for the piece that writes it" }),
      op("pop  hl", 10),
    ]),
    // ── stage it, without a branch ────────────────────────────────────
    // `cur ^ ((cur ^ new) & apply)` is the new value when the mask is $ff and
    // the old one when it is $00, so the store happens either way and writes
    // back what was already there when nothing is due.
    b("cmd blend", [
      op("push hl", 11),
      op(`ld   a,(${DEST})`, 13),
      op("ld   l,a", 4),
      op(`ld   h,${hx(STAGE >> 8)}`, 7, { what: "→ the staged byte itself" }),
      op("ld   a,(hl)", 7, { what: "what is staged now" }),
      op([`${lbl("blendx")}:`, "xor  $00"], 7, { what: "^ the new value" }),
      op([`${lbl("blend")}:`, "and  $00"], 7, { what: "…kept only if we are applying" }),
      op("xor  (hl)", 7),
      op("ld   (hl),a", 7, { what: "the staged byte — whole-block by construction" }),
      op("pop  hl", 10),
    ]),
    // ── consume it, and move the boundary on ──────────────────────────
    b("cmd step", [
      op(`ld   a,(${T})`, 13),
      op([`${lbl("step")}:`, "add  a,$00"], 7, { what: "the record's length, or nothing" }),
      op(`ld   (${T}),a`, 13, { what: "the tail: one record, or where it was" }),
      op(`ld   a,(${hx(OUT)})`, 13),
      op(`add  a,${blockSamples}`, 7),
      op(`ld   (${hx(OUT)}),a`, 13),
      op(`ld   a,(${hx(OUT + 1)})`, 13),
      op("adc  a,0", 7),
      op(`ld   (${hx(OUT + 1)}),a`, 13, { what: "the next boundary's output index" }),
    ]),
  ];
}

/** What one block of it costs, so a budget can be read off without generating. */
export const commandCost = (blocks) => blocks.reduce((t, x) => t + x.cycles, 0);
