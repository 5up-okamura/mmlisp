// MMB v0.2 shared tables and framing helpers.
//
// Single source of truth for the binary container, imported by BOTH the writer
// (export-mmb.js) and the reference decoder (drv-player.js) so their opcode,
// target, channel and curve ids can never drift apart. Pure data + small pure
// functions — no DOM, no audio, no Node APIs — so it runs in the browser and in
// headless tooling alike.
//
// Frozen spec: docs/mmb.md (container), docs/opcodes.md (opcode/target/curve
// freeze), docs/ir.md (event vocabulary). Ids and layouts here match those
// documents verbatim; the v0.1 ids they inherit came from the old
// tools/scripts/mmb-common.js + ir-player.js MMB maps.

// ── File header (mmb.md §4) ───────────────────────────────────────────────
export const MAGIC = [0x4d, 0x4d, 0x42, 0x30]; // "MMB0"
export const VERSION_MAJOR = 0;
export const VERSION_MINOR = 2;
export const HEADER_SIZE = 12;

// Header flags (mmb.md §4). Both reserved / must be 0 in v0.2 output.
export const HEADER_FLAG = {
  WIDE_OFFSETS: 1 << 0,
  PAL_TIMEBASE: 1 << 1,
};

// ── Section directory (mmb.md §5) ─────────────────────────────────────────
export const SECTION_ID = {
  TRACK_TABLE: 0x0001,
  EVENT_STREAM: 0x0002,
  METADATA: 0x0003,
  SAMPLE_BANK: 0x0004,
  VAL_TABLE: 0x0005,
  VOICE_TABLE: 0x0006,
};
export const SECTION_FLAG = { REQUIRED: 1 << 0 };

// ── Track table (mmb.md §6) ───────────────────────────────────────────────
export const TRACK_FLAG = {
  hasLoop: 1 << 0, // backward JUMP present (loops forever)
  isCsm: 1 << 1, // fm3-csm track, drives Timer A / CSM
  isFm3Op: 1 << 2, // fm3 independent-operator sub-track
};

// Channel id map (mmb.md §6.1), keyed by the canonical hardware channel name.
export const CHANNEL_ID = {
  fm1: 0,
  fm2: 1,
  fm3: 2,
  fm4: 3,
  fm5: 4,
  fm6: 5,
  sqr1: 6,
  sqr2: 7,
  sqr3: 8,
  noise: 9,
  fm3op2: 16,
  fm3op3: 17,
  fm3op4: 18,
  pcm1: 20,
  pcm2: 21,
  pcm3: 22,
};
export const CHANNEL_NAME = Object.fromEntries(
  Object.entries(CHANNEL_ID).map(([name, id]) => [id, name]),
);

// Resolve a compiler `scoreChannel` (e.g. "fm3-1", "fm3-csm", "pcm2") to its MMB
// channel id. FM3 independent-op sub-tracks map op1→fm3 (channel 2) and op2–4→
// 16–18; the CSM variants share the fm3 channel. Everything else is a direct
// name lookup. Returns null for an unknown channel.
export function resolveChannelId(scoreChannel) {
  if (scoreChannel in CHANNEL_ID) return CHANNEL_ID[scoreChannel];
  if (scoreChannel === "fm3-csm" || scoreChannel === "fm3-csm-rate") {
    return CHANNEL_ID.fm3;
  }
  const m = /^fm3-([1-4])$/.exec(scoreChannel);
  if (m) {
    const op = Number(m[1]);
    return op === 1 ? CHANNEL_ID.fm3 : 14 + op; // op1→fm3(2); op2–4→16–18
  }
  return null;
}

// ── Opcodes (opcodes.md §3, §5, §6) ───────────────────────────────────────
export const OPCODE = {
  END_OF_TRACK: 0x00,
  NOTE_ON: 0x10,
  REST: 0x11,
  TIE: 0x12,
  NOTE_ON_EX: 0x13,
  VOICE_SET: 0x14,
  LOOP_BEGIN: 0x40,
  LOOP_END: 0x41,
  MARKER: 0x42,
  JUMP: 0x43,
  CALL: 0x44,
  RET: 0x45,
  LOOP_BREAK: 0x46,
  PARAM_SET: 0x60,
  PARAM_SWEEP: 0x61,
  PARAM_ADD: 0x62,
  PARAM_MUL: 0x63,
  PARAM_FROM_VAL: 0x64,
  PARAM_SWEEP_STOP: 0x65,
  TEMPO_SET: 0x80,
  TEMPO_SWEEP: 0x81,
  CSM_ON: 0xa0,
  CSM_OFF: 0xa1,
  CSM_RATE: 0xa2,
  FM3_MODE: 0xa3,
  FM3_OP_PITCH: 0xa4,
  PCM_NOTE_ON: 0xc0,
  PCM_NOTE_OFF: 0xc1,
  PARAM_ADD_VAL: 0xe1,
  PARAM_MUL_VAL: 0xe2,
};
export const OPCODE_NAME = Object.fromEntries(
  Object.entries(OPCODE).map(([name, id]) => [id, name]),
);

// ── Target ids (opcodes.md §7) ────────────────────────────────────────────
// 0x02 NOTE_VOLUME is retired (id parked, never emitted). Width is 2 (i16) for
// NOTE_PITCH and TEMPO_SCALE, 1 (i8) for everything else.
export const TARGET_ID = {
  NOTE_PITCH: 0x01,
  TEMPO_SCALE: 0x03,
  VOL: 0x04,
  MASTER: 0x05,
  VEL: 0x06,
  NOTE_SEMI: 0x07,
  KEYON: 0x08,
  GATE: 0x09,
  FM_FB: 0x10,
  FM_TL1: 0x11,
  FM_TL2: 0x12,
  FM_TL3: 0x13,
  FM_TL4: 0x14,
  FM_ALG: 0x15,
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
  PAN: 0x40,
  LFO_RATE: 0x41,
  NOISE_MODE: 0x42,
};
export const TARGET_NAME = Object.fromEntries(
  Object.entries(TARGET_ID).map(([name, id]) => [id, name]),
);

// i16 targets (opcodes.md §7.4): only NOTE_PITCH (cents) and the reserved
// TEMPO_SCALE. Every other target is i8.
const WIDE_TARGET_IDS = new Set([TARGET_ID.NOTE_PITCH, TARGET_ID.TEMPO_SCALE]);

// Byte width (1 = i8, 2 = i16) of a target's PARAM value, by target id.
export function targetWidth(id) {
  return WIDE_TARGET_IDS.has(id) ? 2 : 1;
}

// ── Curve ids (opcodes.md §8) ─────────────────────────────────────────────
// The driver carries four easing shapes and four loop waveforms; the exporter
// lowers the language's full easing vocabulary onto them.
export const CURVE_ID = {
  linear: 0,
  "ease-in": 1,
  "ease-out": 2,
  "ease-inout": 3,
  sin: 4,
  triangle: 5,
  square: 6,
  saw: 7,
  // 8–11 reserved (stochastic); how they lower is an M3 decision.
  noise: 8,
  pink: 9,
  perlin: 10,
  brown: 11,
};

// Lower a language curve name to a driver curve id. The easing families collapse
// onto their base quad shape (`ease-in-sine` → ease-in, etc.); `ramp` aliases
// `saw`; `const` is a flat segment (linear). Unknown names fall back to linear.
export function curveId(name) {
  const n = String(name || "");
  if (n === "linear" || n === "const") return CURVE_ID.linear;
  // ease-inout must be tested before ease-in ("ease-inout".startsWith("ease-in")).
  if (n.startsWith("ease-inout")) return CURVE_ID["ease-inout"];
  if (n.startsWith("ease-in")) return CURVE_ID["ease-in"];
  if (n.startsWith("ease-out")) return CURVE_ID["ease-out"];
  if (n === "ramp") return CURVE_ID.saw;
  if (n in CURVE_ID) return CURVE_ID[n];
  return CURVE_ID.linear;
}

// ── Integer curve evaluation (driver.md §8, M2 sweep engine) ──────────────
// The driver evaluates curves integer-only from an 8-bit phase (0..255) to an
// 8-bit unit (0..255). Seven of the eight shapes are computed (a multiply or a
// fold); only `sin` needs a table. Both drv-player.js and the Z80 asm use
// THIS definition — gen-tables.mjs emits SIN_LUT verbatim, and curveUnit8 is
// hand-ported to asm — so JS and asm cannot disagree.

// sin loop waveform: (1 - cos(2π·t/256)) / 2, i.e. the ir-utils `sin` curve
// with default params, quantized to 0..255. Starts at 0, peaks 255 at t=128.
export const SIN_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let t = 0; t < 256; t++) {
    lut[t] = Math.round(((1 - Math.cos((2 * Math.PI * t) / 256)) / 2) * 255);
  }
  return lut;
})();

// curveUnit8(id, t): id = driver curve id (CURVE_ID), t = phase 0..255 → 0..255.
// Loop shapes (4..7) are periodic over t; easing shapes (0..3) are one-shot.
export function curveUnit8(id, t) {
  t &= 0xff;
  switch (id) {
    case 0: // linear
    case 7: // saw (ramp) — identity ramp over the period
      return t;
    case 1: // ease-in (quad): t²
      return (t * t) >> 8;
    case 2: // ease-out (quad): 1 - (1-t)²
      return 255 - (((255 - t) * (255 - t)) >> 8);
    case 3: // ease-inout (quad)
      return t < 128
        ? (2 * t * t) >> 8
        : 255 - ((2 * (255 - t) * (255 - t)) >> 8);
    case 4: // sin loop
      return SIN_LUT[t];
    case 5: // triangle loop: up then down
      return t < 128 ? t << 1 : (255 - t) << 1;
    case 6: // square loop: 50% duty (:duty is authoring-side, opcodes.md §8)
      return t < 128 ? 0 : 255;
    default:
      return t;
  }
}

// sweepValue(from, to, unit8): from + trunc((to-from)·unit8 / 256), truncating
// toward zero (matches the asm magnitude-multiply-then-negate). Result is the
// interpolated target value before per-target clamping at the register write.
export function sweepValue(from, to, unit8) {
  const p = (to - from) * (unit8 & 0xff);
  return from + (p < 0 ? -((-p) >> 8) : p >> 8);
}

// Per-frame phase increment (8.8→16-bit phase) for a sweep of `len` frames.
// Loop: one full period over `len` frames. One-shot: reaches ~full at the last
// frame (endpoint is forced to `to` on completion, so the residue is harmless).
export function sweepStep(len, loop) {
  const n = Math.max(1, len | 0);
  if (loop) return Math.min(0xffff, Math.floor(65536 / n));
  return n <= 1 ? 0 : Math.min(0xffff, Math.floor(65536 / (n - 1)));
}

// ── PCM per-frame rate (driver.md §11, opcodes.md §6) — frame-quantized DAC ─
// The single-channel DAC feed is modelled frame-quantized (option A): each
// 60 Hz frame advances a 16.16 sample-position accumulator by `increment` and
// bursts the covered sample bytes to $2A. This verifies rate/indexing/loop
// deterministically (asm↔reference exact); the real sub-frame feed timing is a
// hardware-bring-up concern (samples burst at frame start here, not spread).
//
// increment (16.16 samples/frame) = base_rate × MULT_FRAME[note-36], where
// MULT_FRAME[n] = round(2^((note-60)/12) × 65536 / 60) for C2..C6 (note 36..84).
export const PCM_MULT_FRAME = (() => {
  const t = new Uint16Array(49);
  for (let n = 36; n <= 84; n++) {
    t[n - 36] = Math.round((Math.pow(2, (n - 60) / 12) * 65536) / 60);
  }
  return t;
})();

// 16.16 per-frame position increment for a sample of `baseRate` Hz at `note`.
export function pcmIncrement(baseRate, note) {
  const n = note < 36 ? 36 : note > 84 ? 84 : note;
  return (baseRate * PCM_MULT_FRAME[n - 36]) >>> 0;
}

// ── Duration operand (mmb.md §7.2) ────────────────────────────────────────
export const DUR_HOLD = 0x00; // indefinite hold (len=0 note)
export const DUR_EXT = 0xff; // extended: u16le follows

// Encode a tick duration to operand bytes. 0 = indefinite hold; 1–254 = one
// byte; 255–65535 = 0xFF followed by u16le. Throws above 65535 (the exporter is
// expected to keep note lengths within one u16, well beyond any musical value).
export function encodeDuration(ticks) {
  const t = Math.round(Number(ticks));
  if (!(t >= 0) || t > 0xffff) {
    throw new RangeError(`duration out of range: ${ticks}`);
  }
  if (t === 0) return [DUR_HOLD];
  if (t <= 0xfe) return [t];
  return [DUR_EXT, t & 0xff, (t >> 8) & 0xff];
}

// Read a duration operand from a byte array (or DataView-like with [] access) at
// `offset`. Returns { ticks, next } where ticks === 0 marks an indefinite hold
// and `next` is the offset just past the operand.
export function readDuration(bytes, offset) {
  const b0 = bytes[offset];
  if (b0 === DUR_HOLD) return { ticks: 0, next: offset + 1 };
  if (b0 === DUR_EXT) {
    const lo = bytes[offset + 1];
    const hi = bytes[offset + 2];
    return { ticks: lo | (hi << 8), next: offset + 3 };
  }
  return { ticks: b0, next: offset + 1 };
}

// ── Tempo (mmb.md §7.5) ───────────────────────────────────────────────────
// Per-frame tick increment in 8.8 fixed point: round(bpm × 96 × 256 / 3600) =
// round(bpm × 512 / 75). e.g. 120 → 819, 150 → 1024 (exact).
export function bpmToTickIncrement(bpm) {
  return Math.round((Number(bpm) * 512) / 75);
}
