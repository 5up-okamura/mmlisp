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
  MACRO_TABLE: 0x0007,
  LUT_TABLE: 0x0008,
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
  MACRO_SET: 0xe0,
  PARAM_ADD_VAL: 0xe1,
  PARAM_MUL_VAL: 0xe2,
  MACRO_CLEAR: 0xe3,
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

// ── PCM per-frame rate (driver.md §11, opcodes.md §6) ──────────────────────
// Each frame advances a 16.16 sample-position accumulator by `increment` and
// covers the frame's share of the sample clock (pcmFrameSamples below — 166 or
// 167, never a constant). That fixes WHICH samples a frame carries; WHEN each
// one reaches $2A is the engine's own business (driver.md §5.1 — the feed is
// paced by Timer B and drains a ring the mixer fills a frame ahead of it, which
// `drv-player.js` models).
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

// ── The sample clock — YM Timer B (driver.md §5.1) ─────────────────────────
// PCM soft-mix (driver.md §14): pcm1–pcm3 are summed in software to the single
// fm6 DAC. Every active voice is resampled (nearest-neighbour) to the sample
// clock's grid and the ≤3 signed samples are summed then hard-saturated to int8.
//
// The grid is not the frame. The DAC is paced by YM Timer B, so the rate is
// fixed by the YM's own clock and has nothing to do with 60 Hz:
//
//   master 53693175 Hz / 7 = YM clock, / 144 = FM sample rate (53267 Hz)
//   Timer B overflows every 16 × (256 − TB) FM samples, and the engine emits
//   PCM_GROUP samples per overflow
//   → 16 × (256 − TB) / PCM_GROUP FM samples per DAC sample
//
// **That ratio is the rate, and it is 16/3 whatever k = 256 − TB is**, because
// the engine's generator derives PCM_GROUP = 3k from the same k (gen-mixer.mjs,
// TIMER_B_K). The window k is a scheduling choice — how many samples the engine
// may average its out-of-loop work over — and it has moved from 1 to 16 without
// the rate moving at all. Do not re-derive this from a particular TB.
//
//   16/3 FM samples a DAC sample = master / 5376 = 9987.6 Hz
//   a frame is 262 lines × 3420 master cycles = master / 896040 (59.92 Hz)
//   → 896040 / 5376 = 166.674 samples a frame, which is NOT an integer
//
// That non-integer is the whole reason the engine holds a sample RING rather
// than a frame-long buffer, and why every "R samples a frame" constant is gone.
export const PCM_SAMPLES_NUM = 37335; // samples per PCM_SAMPLES_DEN frames…
export const PCM_SAMPLES_DEN = 224; // …i.e. 896040/5376 in lowest terms
export const PCM_SAMPLES_PER_FRAME = PCM_SAMPLES_NUM / PCM_SAMPLES_DEN; // 166.67

// Index of the first sample of `frame`, counting from the driver's frame 0.
// Both producer and feed derive their counts from this, so the two cannot
// disagree about how many samples a frame owes. (The 68k/Z80 mirrors keep a
// running remainder instead — the product overflows 32 bits after ~32 minutes.)
export function pcmSampleIndex(frame) {
  return Math.floor((frame * PCM_SAMPLES_NUM) / PCM_SAMPLES_DEN);
}

/** Samples the DAC takes during `frame` — 166 or 167, never constant. */
export function pcmFrameSamples(frame) {
  return pcmSampleIndex(frame + 1) - pcmSampleIndex(frame);
}

// The ring the mixer produces into and the feed drains (driver.md §5.1.2).
//
// TARGET is how many FINISHED samples the ring carries ahead of the feed. A
// burst's first frame builds all of them and feeds nothing (the DAC is parked
// at silence for that one frame); every frame after it mixes exactly what the
// feed just took. That is what keeps the engine's two counts equal — it emits
// one sample per three mix ticks, so "mixed this frame" and "fed this frame"
// are the same number — and it is why there is no per-frame catch-up rule.
//
// BYTES is twice TARGET because the mixer is voice-outer: while a frame's chunk
// is being built, none of it is playable until the last voice pass has added to
// it, so the finished samples and the ones under construction are live at the
// same time. 256 B could hold one or the other, never both.
// 255, not 256: a voice pass's tick count is a single byte in the engine
// (G_TICKS), and the prime frame mixes exactly TARGET of them. The slack it
// leaves the feed is 255 - 167 = 88 samples either way.
export const PCM_RING_TARGET = 255;
export const PCM_RING_BYTES = 512;

// How far a PCM voice may be attenuated, in 6 dB shift steps. It is a BUDGET
// constant, and the range it removes was never audible anyway.
//
// The mixer attenuates with a chain of `sra a`, 8 Z80 cycles a step, on every
// tick of every sounding voice — 1,460 cycles a frame per step per voice
// (measured). A frame has ~2,400 cycles spare with one voice sounding and ~700
// with two, so the deep end of this range is not affordable: two voices at
// -12 dB measured 109% of a vblank and lost frames.
//
// And it buys nothing. The samples are 8-bit signed, so a shift of 5 leaves 3
// bits, 6 leaves 2 and 7 leaves 1 — those levels are quantisation noise, not a
// quiet sample. 4 leaves 4 bits, which is the last one that still carries the
// waveform.
//
// Above this the level CLAMPS rather than mutes, so the documented "vel alone
// never silences a voice" still holds: `vol 0` and `master 0` are the hard
// mutes, and PCM_TOTAL_MAX_SHIFT below is the only other way a voice goes
// silent — and that one needs master's help to reach.
// Mirrored by MML_PCM_MAX_SHIFT in drv/68k/mmlispseq.h; the c-gate
// diffs the two slot streams, so they cannot drift apart silently.
export const PCM_MAX_SHIFT = 4;

// ── Master (driver.md §14.1) ──────────────────────────────────────────────
// Master is NOT part of the per-voice shift above. It is common to every voice
// by definition, so the mixer applies it ONCE per DAC sample — to the finished,
// already-saturated sum, in the emit — instead of once per tick per voice.
//
// The reason is the ceiling, not the cycles. Folded in, master shared
// PCM_MAX_SHIFT with vel/vol: a master fade stopped attenuating PCM at -24 dB,
// held there for `master 12..1`, and then fell off a cliff to silence at 0 —
// while FM went on down the TL ladder and PSG down its 4-bit one. PCM was the
// one voice in the mix that would not fade.
//
// Riding the sum instead lifts it off that ceiling. Its own is deeper because
// its cost no longer multiplies by the voice count, but it is still a 6 dB
// ladder: 6 steps is -36 dB, and `master 12..1` still share the bottom rung.
// The cliff is not gone, it is two rungs further down.
export const PCM_MASTER_MAX_SHIFT = 6;

// Voice shift + master shift at which the voice is MUTED rather than mixed —
// the same "inaudible, so do not sound it" rule PCM_MAX_SHIFT states, applied
// to the total. 7 leaves a single bit of an 8-bit sample, and muting also
// returns the voice's whole per-tick cost to the frame, which is what keeps a
// deep fade affordable now that master can reach past the old ceiling.
export const PCM_TOTAL_MAX_SHIFT = 7;

// 16.16 per-sample position increment: the per-frame increment divided across
// the frame's samples. Computed at full 16.16 precision then floored so pitch
// stays accurate (a table pre-divided by the rate would round too coarsely).
// The divisor is the AVERAGE samples per frame, not a given frame's 166/167:
// the rate the ear hears is the sample clock's, and the ring is what absorbs
// the difference. (Mirrors need 64 bits for the product — 68k pcm_tick_increment.)
export function pcmTickIncrement(baseRate, note) {
  return Math.floor((pcmIncrement(baseRate, note) * PCM_SAMPLES_DEN) / PCM_SAMPLES_NUM) >>> 0;
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
