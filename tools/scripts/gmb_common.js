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

module.exports = {
  SECTION,
  OPCODE,
  u16le,
  u32le,
  alignBuffer,
};
