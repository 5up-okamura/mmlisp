// THE 68k/Z80 RUNTIME PROTOCOL (docs/dac-engine-implementation.md R12 §33.2-§33.4).
//
// One layout, in one place. The addresses below are the ONLY definition: the
// Z80 source takes its equates from `protocolAsm()`, the 68000 takes its offsets
// from `protocolHeader()`, and the JS reference reads the same object. A second
// hand-kept copy of an offset is exactly the failure §33.2 forbids.
//
// ── the three quantities, kept apart (§33.2) ──────────────────────────────
//
//   bootGeneration      u16, the 68000's.  Which RUN this is. Changes when the
//                       Z80 is started or reloaded; everything published or
//                       queued by an older run is thrown away.
//   outputSampleIndex   u32, the Z80's.    Which SAMPLE this is — the logical
//                       time a command is scheduled against. One per DAC write,
//                       never skipped, never rewound, and NOT a wall clock: it
//                       does not advance while the bus is held and it does not
//                       jump when the phase is corrected.
//   phaseGeneration     u8,  the 68000's.  Which stretch of CONTINUOUS PHASE
//                       this is. Bumped whenever a stop happened that H cannot
//                       be trusted across, which is what makes the Z80 drop its
//                       difference rather than accept an aliased one.
//
// Mixing any two of them is the mistake the whole structure exists to prevent:
// a phase invalidation must not disturb the logical time of commands already
// queued, and a boot must invalidate both.
import { GLOB } from "./config.mjs";

/** One published snapshot: what the Z80 tells the 68000 about where it is. */
// THE OBSERVATION NUMBER COMES FIRST, and that is a placement decision rather
// than a taste: the stage the Z80 publishes from is laid over the decoder's own
// state so that these two bytes ARE the decoder's 16-bit counter. Copying them
// into the stage cost 52 cycles a lap and overran the decode's slot by seven.
export const SNAPSHOT = [
  ["observationNumber", 2, "the H observation count — the decoder's own counter, not a copy"],
  ["bootGeneration", 2, "the run this snapshot belongs to — the 68000's number, echoed"],
  ["phaseGeneration", 1, "the phase stretch it belongs to"],
  ["boundarySampleIndex", 4, "the output index AT the defined boundary DAC write"],
];

/** The 68000's control block, which the Z80 reads and never writes. */
export const CONTROL = [
  ["bootGeneration", 2, "the run the host believes is running"],
  ["phaseGeneration", 1, "bumped for every stop H cannot be trusted across"],
  ["queueHead", 1, "the producer's cursor; written LAST, after the payload"],
  ["phaseCommit", 1, "commits phaseGeneration only; queueHead is the queue's separate commit"],
];

const sizeOf = (fields) => fields.reduce((t, [, n]) => t + n, 0);
export const SNAPSHOT_BYTES = sizeOf(SNAPSHOT);      // 9
export const CONTROL_BYTES = sizeOf(CONTROL);        // 5
export const FACES = 2;

/**
 * THE STRIDE IS TEN, NOT NINE, and the extra byte is not padding for its own
 * sake (R12 §33.4). The 68000 reads a face with the bus held, and every byte it
 * reads is Z80 time it is holding: nine `move.b (a0)+,(a1)+` measured
 * 105..123 Z80 cycles of STOP -> RESUME, which is 1,583..1,851 master and OVER
 * the 1,500 the live-transfer contract allows. With both faces on an even
 * boundary the same nine bytes are two `move.l` and one `move.w`, and the
 * selector's own toggle stays one `xor`.
 */
export const SNAPSHOT_STRIDE = 10;

/**
 * The layout, built once from the field lists.
 *
 * Offsets are RELATIVE to the publication region's base, so the same object
 * describes the JS model, the Z80's absolute equates and the 68000's header.
 */
export function protocolLayout(base = 0) {
  const at = (fields, from) => {
    const out = {}; let o = from;
    for (const [name, n] of fields) { out[name] = { offset: base + o, bytes: n }; o += n; }
    return { fields: out, end: o };
  };
  // THE SELECTOR COMES FIRST and the faces follow it, so that the selector and
  // both faces are ONE contiguous run the 68000 can take in a straight line of
  // long moves — no read of the selector, no branch on it, no second `lea`.
  // Choosing the face is done afterwards, in the host's own RAM, with the bus
  // already released. That is what brought the live read's STOP -> RESUME from
  // 1,851 master to inside the 1,500 the contract allows (R12 §33.4).
  const publishSelect = { offset: base, bytes: 1 };
  let o = 2;                                   // …one byte behind it, for alignment
  const faces = [];
  for (let f = 0; f < FACES; f++) { faces.push(at(SNAPSHOT, o).fields); o += SNAPSHOT_STRIDE; }
  const host = at(CONTROL, o); o = host.end;
  return { base, faces, publishSelect, control: host.fields, size: o,
    // What the host reads in one go: the selector, its pad, and both faces.
    readRun: { offset: base, bytes: 2 + FACES * SNAPSHOT_STRIDE } };
}

export const PUB_REGION_BYTES = 32;
export const PROTOCOL_BYTES = FACES * SNAPSHOT_STRIDE + 2 + CONTROL_BYTES;  // 27
export const PROTOCOL_SPARE = PUB_REGION_BYTES - PROTOCOL_BYTES;            // 5

// ── reading and writing, as ordered byte operations ───────────────────────
// The ORDER is the protocol. Both sides publish a block by writing every byte
// of it and then, strictly last, one byte that says it is there.

const putLE = (out, { offset, bytes }, v) => {
  for (let i = 0; i < bytes; i++) out.push([offset + i, (v / 2 ** (8 * i)) & 0xff]);
};
const getLE = (mem, { offset, bytes }) => {
  let v = 0;
  for (let i = 0; i < bytes; i++) v += mem[offset + i] * 2 ** (8 * i);
  return v;
};

/**
 * The writes the Z80 makes to publish one snapshot, IN ORDER.
 *
 * It writes the face the 68000 is NOT reading, then flips the selector. A
 * reader that takes the selector first therefore sees either the whole previous
 * snapshot or the whole new one, at every interleaving — which is the property
 * `tornSnapshotPossible()` below checks by walking every prefix rather than by
 * being argued for here.
 */
export function publishSteps(layout, select, snap) {
  const face = layout.faces[select ^ 1];
  const out = [];
  putLE(out, face.bootGeneration, snap.bootGeneration);
  putLE(out, face.phaseGeneration, snap.phaseGeneration);
  putLE(out, face.boundarySampleIndex, snap.boundarySampleIndex);
  putLE(out, face.observationNumber, snap.observationNumber);
  out.push([layout.publishSelect.offset, select ^ 1]);        // LAST
  return out;
}

/** What a reader gets: the selector first, then the face it names. */
export function readSnapshot(mem, layout) {
  const select = mem[layout.publishSelect.offset] & 1;
  const f = layout.faces[select];
  return { select,
    bootGeneration: getLE(mem, f.bootGeneration),
    phaseGeneration: getLE(mem, f.phaseGeneration),
    boundarySampleIndex: getLE(mem, f.boundarySampleIndex),
    observationNumber: getLE(mem, f.observationNumber) };
}

/**
 * A full control initialisation. Runtime queue publication does NOT use this
 * commit: `queueHead` commits queue bytes, while `phaseCommit` commits only a
 * new phase generation. Keeping those domains separate prevents an ordinary
 * live command from invalidating the H corrector.
 */
export function controlSteps(layout, ctl) {
  const c = layout.control, out = [];
  putLE(out, c.bootGeneration, ctl.bootGeneration);
  putLE(out, c.phaseGeneration, ctl.phaseGeneration);
  putLE(out, c.queueHead, ctl.queueHead);
  putLE(out, c.phaseCommit, ctl.phaseCommit);                 // LAST for phase control
  return out;
}

export function readControl(mem, layout) {
  const c = layout.control;
  return { bootGeneration: getLE(mem, c.bootGeneration),
    phaseGeneration: getLE(mem, c.phaseGeneration),
    queueHead: getLE(mem, c.queueHead),
    phaseCommit: getLE(mem, c.phaseCommit) };
}

// ── the wrap rules, written once ──────────────────────────────────────────
// Every counter here wraps, and each one wraps into a different question.

/** u8 forward distance. `$ff -> $00` is ONE step, not a restart (§33.3). */
export const genAdvance = (prev, now) => (now - prev) & 0xff;

/**
 * Did the phase generation change? A stop the host could not bound bumps it by
 * one; 256 bumps between two H observations is NOT allowed to look like none,
 * so a caller that can count them checks the count as well as the equality.
 */
export const phaseInvalidated = (prev, now) => genAdvance(prev, now) !== 0;

/** u32 forward distance, for the output index. It must never go backwards. */
export const outputAdvance = (prev, now) => (now - prev) >>> 0;

/**
 * A command's 16-bit time, extended against the Z80's own 32-bit output index
 * (§33.4). 1..32767 samples ahead is a future time; 0 or anything that reads as
 * the past is LATE.
 */
export function extendTime(applyAtLow, outputIndex) {
  const delta = (applyAtLow - outputIndex) & 0xffff;
  if (delta === 0 || delta > 32767)
    return { late: true, at: null, behind: delta === 0 ? 0 : delta - 65536 };
  return { late: false, at: (outputIndex + delta) >>> 0, behind: 0 };
}

/**
 * Where a late command actually lands: the first block boundary the engine has
 * NOT built yet. The build cursor runs `lead` samples ahead of the play cursor,
 * so anything at or before it is already finished and must not be rewritten.
 */
export function lateTarget(outputIndex, lead, block) {
  const cursor = (outputIndex + lead) >>> 0;
  return (cursor + ((block - (cursor % block)) % block)) >>> 0;
}

// ── the negative cases, as code rather than as prose ──────────────────────
/**
 * Ways to get the protocol wrong. Each is a plausible implementation, and the
 * checks have to fail on every one (§33.6 step 1).
 */
export const PROTOCOL_FAULTS = {
  "select-first": "the selector is flipped before the face behind it is written",
  "half-face": "the publisher writes the face the reader is looking at",
  "head-first": "queueHead is advanced before the payload it points past",
  "commit-first": "phaseCommit is written before phaseGeneration",
};

/** The same publication, done wrong on purpose. */
export function faultySteps(layout, select, snap, fault) {
  const good = publishSteps(layout, select, snap);
  if (fault === "select-first") return [good.at(-1), ...good.slice(0, -1)];
  if (fault === "half-face") {
    // Writes into the face the reader is CURRENTLY on, so every partial state
    // is visible; there is no flip at the end to save it.
    const face = layout.faces[select];
    const out = [];
    putLE(out, face.bootGeneration, snap.bootGeneration);
    putLE(out, face.phaseGeneration, snap.phaseGeneration);
    putLE(out, face.boundarySampleIndex, snap.boundarySampleIndex);
    putLE(out, face.observationNumber, snap.observationNumber);
    return out;
  }
  return good;
}

export function faultyControlSteps(layout, ctl, fault) {
  const good = controlSteps(layout, ctl);
  if (fault === "commit-first") return [good.at(-1), ...good.slice(0, -1)];
  return good;
}

/**
 * WALK EVERY INTERLEAVING. A reader may run between any two of the publisher's
 * byte writes, so the question "can a torn snapshot be observed" is answered by
 * trying all of them rather than by reasoning about the order.
 *
 * @returns the first torn reading, or null
 */
const WHOLE = ["bootGeneration", "phaseGeneration", "boundarySampleIndex", "observationNumber"];
export function tornSnapshotPossible(layout, mem0, snap, steps) {
  const key = (s) => WHOLE.map((k) => s[k]).join(",");
  const before = readSnapshot(new Uint8Array(mem0), layout);
  const ok = new Set([key(before), key(snap)]);
  const mem = new Uint8Array(mem0);
  for (let k = 0; k <= steps.length; k++) {
    const got = readSnapshot(mem, layout);
    if (!ok.has(key(got))) return { after: k, got, before, snap };
    if (k < steps.length) mem[steps[k][0]] = steps[k][1];
  }
  return null;
}

/** The same walk for the phase-control block, gated on its own commit byte. */
export function tornControlPossible(layout, mem0, ctl, steps) {
  // queueHead is deliberately absent: it commits queue bytes independently
  // and must be allowed to move without changing the phase generation.
  const key = (c) => [c.bootGeneration, c.phaseGeneration].join(",");
  const mem = new Uint8Array(mem0);
  const before = readControl(mem, layout);
  const wanted = key(ctl);
  let seenCommit = null;
  for (let k = 0; k <= steps.length; k++) {
    const got = readControl(mem, layout);
    // A reader ACTS only when the commit byte changes. Once it has, everything
    // the commit stands for must already be there.
    if (got.phaseCommit !== before.phaseCommit) {
      seenCommit ??= k;
      if (key(got) !== wanted) return { after: k, got, before, ctl };
    }
    if (k < steps.length) mem[steps[k][0]] = steps[k][1];
  }
  return null;
}

// ── the emitters ──────────────────────────────────────────────────────────
// Same layout, three languages, and none of them holds a second copy.

const upper = (s) => s.replace(/([A-Z])/g, "_$1").toUpperCase();

export function protocolAsm(base) {
  const L = protocolLayout(base);
  const eq = (n, v) => `${n.padEnd(26)} equ $${v.toString(16)}`;
  const out = ["; GENERATED from experimental/dac-stream/protocol.mjs — do not edit.",
    eq("PROTO_BASE", base)];
  L.faces.forEach((f, i) => {
    for (const [name] of SNAPSHOT) out.push(eq(`PROTO_F${i}${upper(name)}`.replace(/(\d)([A-Z])/, "$1_$2"), f[name].offset));
  });
  out.push(eq("PROTO_SELECT", L.publishSelect.offset));
  for (const [name] of CONTROL) out.push(eq(`PROTO_H_${upper(name)}`, L.control[name].offset));
  return out.join("\n") + "\n";
}

export function protocolHeader(base) {
  const L = protocolLayout(base);
  const hex = (v) => `0x${v.toString(16).toUpperCase()}`;
  const lines = ["/* GENERATED from drv/experimental/dac-stream/protocol.mjs — do not edit. */",
    "#ifndef MML_PROTO_H", "#define MML_PROTO_H", "",
    `#define MML_PROTO_BASE ${hex(base)}`,
    `#define MML_PROTO_BYTES ${PROTOCOL_BYTES}`,
    `#define MML_PROTO_SPARE ${PROTOCOL_SPARE}`, ""];
  L.faces.forEach((f, i) => {
    for (const [name, , why] of SNAPSHOT)
      lines.push(`#define MML_PROTO_F${i}_${upper(name)} ${hex(f[name].offset)}  /* ${why} */`);
  });
  lines.push(`#define MML_PROTO_SELECT ${hex(L.publishSelect.offset)}`);
  for (const [name, , why] of CONTROL)
    lines.push(`#define MML_PROTO_H_${upper(name)} ${hex(L.control[name].offset)}  /* ${why} */`);
  lines.push("", "#endif", "");
  return lines.join("\n");
}

/**
 * The globals the Z80 keeps for the protocol, alongside the decoder's state.
 *
 * THE STAGE IS THE SNAPSHOT, byte for byte and in the same order. Publishing is
 * then a nine-byte copy through one pointer rather than nine self-modified
 * store operands, and the field order exists once — in SNAPSHOT — instead of
 * twice.
 */
export const PROTO_GLOB = {
  // $14 is GLOB.decode + 4, which is the decoder's countLo. The stage starts
  // THERE so that its first two bytes are the observation counter itself; the
  // rest follows in SNAPSHOT order. `protoMap()` checks the coincidence rather
  // than trusting this comment.
  stage: 0x14,         // 9 B, laid out as SNAPSHOT
  lastPhaseCommit: 0x1d, // u8  the phase commit the Z80 has already acted on
  queueTail: 0x1e,     // u8  the consumer's cursor — the Z80 owns it
};
export const PROTO_GLOB_END = 0x1f;

/** Where each snapshot field sits inside the stage. */
export const STAGE = (() => {
  const out = {}; let o = PROTO_GLOB.stage;
  for (const [name, n] of SNAPSHOT) { out[name] = o; o += n; }
  if (o !== PROTO_GLOB.lastPhaseCommit) throw new Error("the stage is not the snapshot");
  return out;
})();

// It DOES overlap the decoder's state, deliberately and by exactly two bytes.
if (PROTO_GLOB.stage !== GLOB.decode + 4)
  throw new Error("the stage must start on the decoder's countLo");

// ── the command queue (§33.4) ─────────────────────────────────────────────
// Single producer, single consumer. The 68000 owns `queueHead` and the payload;
// the Z80 owns `queueTail` and never reads past the head. The wire record is
// `{size:u8, type:u8, applyAtLow:u16, payload...}` and `size` counts the whole
// record, so a consumer can step past a type it does not know.

export const CMD_HEADER = 4;

/**
 * The writes that append one record, IN ORDER: the payload first and the head
 * strictly last, which is what makes a consumer that stops anywhere see either
 * no record or a whole one.
 */
export function enqueueSteps(layout, qbase, qsize, head, rec, fault = null) {
  const bytes = [rec.size, rec.type, rec.applyAtLow & 0xff, (rec.applyAtLow >> 8) & 0xff,
    ...rec.payload];
  if (bytes.length !== rec.size) throw new Error(`record says ${rec.size} bytes and carries ${bytes.length}`);
  const body = bytes.map((b, i) => [qbase + ((head + i) % qsize), b]);
  const advance = [[layout.control.queueHead.offset, (head + rec.size) % qsize]];
  // `head-first` is the fault: the cursor says the record is there before it is.
  return fault === "head-first" ? [...advance, ...body] : [...body, ...advance];
}

/** What the consumer may read: only the bytes strictly behind the head. */
export function dequeue(mem, layout, qbase, qsize, tail) {
  const head = mem[layout.control.queueHead.offset];
  const avail = (head - tail + qsize) % qsize;
  if (avail === 0) return null;
  const size = mem[qbase + (tail % qsize)];
  // A record is not readable until ALL of it is behind the head. Without this
  // the consumer reads the producer's next bytes as this record's payload.
  if (size < CMD_HEADER || size > avail) return { incomplete: true, avail, size };
  const at = (i) => mem[qbase + ((tail + i) % qsize)];
  return { incomplete: false, size, type: at(1), applyAtLow: at(2) | (at(3) << 8),
    payload: Array.from({ length: size - CMD_HEADER }, (_, i) => at(CMD_HEADER + i)),
    tail: (tail + size) % qsize };
}

/**
 * When a command takes effect, and what a late one does (§33.4). A late command
 * is NOT dropped and NOT applied to something already built: it goes to the
 * first block boundary the build cursor has not reached.
 */
export function scheduleCommand(applyAtLow, outputIndex, lead, block) {
  const t = extendTime(applyAtLow, outputIndex);
  if (!t.late) return { at: t.at, late: false, behind: 0 };
  return { at: lateTarget(outputIndex, lead, block), late: true, behind: t.behind };
}
