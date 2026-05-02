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
  TEMPO_SET: 0x80,
};

const TARGET_ID = {
  NOTE_PITCH: 0x01,
  NOTE_VOLUME: 0x02,
  TEMPO_SCALE: 0x03,
  VOL: 0x04,
  FM_FB: 0x10,
  FM_ALG: 0x15,
  FM_TL1: 0x11,
  FM_TL2: 0x12,
  FM_TL3: 0x13,
  FM_TL4: 0x14,
  FM_AR1: 0x16,
  FM_AR2: 0x17,
  FM_AR3: 0x18,
  FM_AR4: 0x19,
  FM_DR1: 0x1a,
  FM_DR2: 0x1b,
  FM_DR3: 0x1c,
  FM_DR4: 0x1d,
  FM_SR1: 0x1e,
  FM_SR2: 0x1f,
  FM_SR3: 0x20,
  FM_SR4: 0x21,
  FM_RR1: 0x22,
  FM_RR2: 0x23,
  FM_RR3: 0x24,
  FM_RR4: 0x25,
  FM_SL1: 0x26,
  FM_SL2: 0x27,
  FM_SL3: 0x28,
  FM_SL4: 0x29,
  FM_KS1: 0x2a,
  FM_KS2: 0x2b,
  FM_KS3: 0x2c,
  FM_KS4: 0x2d,
  FM_ML1: 0x2e,
  FM_ML2: 0x2f,
  FM_ML3: 0x30,
  FM_ML4: 0x31,
  FM_DT1: 0x32,
  FM_DT2: 0x33,
  FM_DT3: 0x34,
  FM_DT4: 0x35,
  FM_SSG1: 0x36,
  FM_SSG2: 0x37,
  FM_SSG3: 0x38,
  FM_SSG4: 0x39,
  FM_AMEN1: 0x3a,
  FM_AMEN2: 0x3b,
  FM_AMEN3: 0x3c,
  FM_AMEN4: 0x3d,
  FM_AMS: 0x3e,
  FM_FMS: 0x3f,
  LFO_RATE: 0x41,
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
