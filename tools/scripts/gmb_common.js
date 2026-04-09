"use strict";

function u16le(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32le(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function i16le(value) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(value | 0, 0);
  return b;
}

function alignBuffer(buf, alignment) {
  if (alignment <= 1) {
    return buf;
  }
  const rem = buf.length % alignment;
  if (rem === 0) {
    return buf;
  }
  return Buffer.concat([buf, Buffer.alloc(alignment - rem)]);
}

const SECTION = {
  TRACK_TABLE: 0x0001,
  EVENT_STREAM: 0x0002,
  METADATA: 0x0003,
};

const OPCODE = {
  NOTE_ON: 0x10,
  REST: 0x11,
  TIE: 0x12,
  LOOP_BEGIN: 0x40,
  LOOP_END: 0x41,
  MARKER: 0x42,
  JUMP: 0x43,
  PARAM_SET: 0x60,
  PARAM_ADD: 0x61,
  TEMPO_SET: 0x80,
};

const TARGET_ID = {
  NOTE_PITCH: 0x01,
  NOTE_VOLUME: 0x02,
  TEMPO_SCALE: 0x03,
  FM_FB: 0x10,
  FM_TL1: 0x11,
  FM_TL2: 0x12,
  FM_TL3: 0x13,
  FM_TL4: 0x14,
};

function parsePitchToByte(raw) {
  const s = String(raw || "c4").trim();
  const m = s.match(/^([a-gA-GhH])([#\+\-b]?)(-?\d+)$/);
  if (!m) {
    throw new Error(`Invalid pitch format: ${s}`);
  }

  const note = m[1].toLowerCase();
  const accidental = m[2];
  const octave = Number.parseInt(m[3], 10);

  const baseMap = {
    c: 0,
    d: 2,
    e: 4,
    f: 5,
    g: 7,
    a: 9,
    b: 11,
    h: 11,
  };

  let semi = baseMap[note] ?? 0;
  if (accidental === "#" || accidental === "+") {
    semi += 1;
  } else if (accidental === "b" || accidental === "-") {
    semi -= 1;
  }

  let midi = (octave + 1) * 12 + semi;
  if (midi < 0) {
    midi = 0;
  }
  if (midi > 127) {
    midi = 127;
  }
  return midi;
}

module.exports = {
  SECTION,
  OPCODE,
  TARGET_ID,
  u16le,
  u32le,
  i16le,
  alignBuffer,
  parsePitchToByte,
};
