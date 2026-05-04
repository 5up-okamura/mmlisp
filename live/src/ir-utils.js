/**
 * MMLisp IR player utilities.
 *
 * Shared helpers used by ir-player.js and mmlisp2ir.js:
 *   - Macro target range table + clampForTarget()
 *   - Pitch / MIDI helpers
 *   - YM2612 F-number conversion
 *   - Volume composition (FM TL, PSG att)
 *   - Vol sweep sampling + curve units
 *   - YM2612 channel register state + encoding
 *   - Channel name → index maps
 */

// ---------------------------------------------------------------------------
// Macro target range table
// ---------------------------------------------------------------------------
// Used by the compiler (parseMacroSpec / step-vector parsing) and the player
// (_scheduleMacro write path) to clamp and round macro output values.
//
// integer: true  — Math.round then clamp (used for all hardware registers and
//                  snap-to-integer targets like :pan, :mode)
// integer: false — clamp only, preserve fractional value (e.g. NOTE_PITCH in cents)
//
// Targets with a numeric suffix (FM_TL1–FM_TL4 etc.) fall back to the
// suffix-stripped key via clampForTarget().
export const MACRO_TARGET_RANGE = {
  // KEY-ON scoped
  NOTE_PITCH: { min: -32768, max: 32767, integer: false },
  VEL: { min: 0, max: 15, integer: true },

  // Channel-level
  VOL: { min: 0, max: 31, integer: true },
  MASTER: { min: 0, max: 31, integer: true },

  // LFO
  LFO_RATE: { min: 0, max: 8, integer: true },

  // FM channel params
  FM_ALG: { min: 0, max: 7, integer: true },
  FM_FB: { min: 0, max: 7, integer: true },
  FM_AMS: { min: 0, max: 3, integer: true },
  FM_FMS: { min: 0, max: 7, integer: true },

  // FM operator params — shared by FM_TL1–FM_TL4, FM_AR1–FM_AR4, etc.
  // clampForTarget() strips the trailing digit before lookup.
  FM_TL: { min: 0, max: 127, integer: true },
  FM_AR: { min: 0, max: 31, integer: true },
  FM_DR: { min: 0, max: 31, integer: true },
  FM_SR: { min: 0, max: 31, integer: true },
  FM_RR: { min: 0, max: 15, integer: true },
  FM_SL: { min: 0, max: 15, integer: true },
  FM_ML: { min: 0, max: 15, integer: true },
  FM_DT: { min: 0, max: 7, integer: true },
  FM_KS: { min: 0, max: 3, integer: true },
  FM_AMEN: { min: 0, max: 1, integer: true },
  FM_SSG: { min: 0, max: 15, integer: true },

  // FM panning — bits 7-6 of B4
  PAN: { min: -1, max: 1, integer: true },

  // PSG noise mode (0-7 via `:mode` keyword on noise channel)
  NOISE_MODE: { min: 0, max: 7, integer: true },
};

/**
 * Clamp a macro output value to the hardware range for the given target.
 * For integer targets, rounds before clamping.
 * For targets with a numeric suffix (e.g. "FM_TL1"), strips the suffix and
 * looks up the base key (e.g. "FM_TL").
 * Returns v unchanged if no range entry is found.
 *
 * @param {string} target  - canonical target name (e.g. "FM_TL1", "VEL", "PAN")
 * @param {number} v       - raw value from macro interpolation
 * @returns {number}
 */
export function clampForTarget(target, v) {
  const range =
    MACRO_TARGET_RANGE[target] ??
    MACRO_TARGET_RANGE[target.replace(/\d+$/, "")];
  if (!range) return v;
  const val = range.integer ? Math.round(v) : v;
  return Math.max(range.min, Math.min(range.max, val));
}

// ---------------------------------------------------------------------------
// Pitch → MIDI note
// ---------------------------------------------------------------------------
const NOTE_NAMES = [
  "c",
  "cs",
  "d",
  "ds",
  "e",
  "f",
  "fs",
  "g",
  "gs",
  "a",
  "as",
  "b",
];
// Aliases for accidentals used in MMLisp ("c+", "d-" etc.)
const NOTE_ALIASES = {
  "c+": "cs",
  "d-": "cs",
  "d+": "ds",
  "e-": "ds",
  "f+": "fs",
  "g-": "fs",
  "g+": "gs",
  "a-": "gs",
  "a+": "as",
  "b-": "as",
};

export function pitchToMidi(pitchStr) {
  // Format: "c4", "e4", "f+3", "b-5" etc.
  const m = pitchStr.toLowerCase().match(/^([a-g][+\-]?)(\d)$/);
  if (!m) return 60; // fallback C4

  let name = m[1];
  const octave = parseInt(m[2], 10);

  name = NOTE_ALIASES[name] ?? name;
  const semitone = NOTE_NAMES.indexOf(name);
  if (semitone < 0) return 60;

  // MIDI: C4 = 60, C0 = 12
  return (octave + 1) * 12 + semitone;
}

// ---------------------------------------------------------------------------
// MIDI pitch → YM2612 F-number + block
// Calibrated for NTSC Mega Drive master clock 7670454 Hz.
// ---------------------------------------------------------------------------

// YM2612 frequency formula: fnum = freq * 2^(21-block) / (MASTER_CLOCK/144)
// MASTER_CLOCK/144 ≈ 53267 Hz (7,670,454 Hz / 144)
// Supports fractional midiNote for cent-precision pitch.
const FM_CLOCK_DIV = 53267;

export function midiToFnumBlock(midiNote) {
  const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
  let block = 4;
  let fnum = Math.round((freq * (1 << (21 - block))) / FM_CLOCK_DIV);
  while (fnum > 1023 && block < 7) {
    block++;
    fnum = Math.round((freq * (1 << (21 - block))) / FM_CLOCK_DIV);
  }
  while (fnum < 512 && block > 0) {
    block--;
    fnum = Math.round((freq * (1 << (21 - block))) / FM_CLOCK_DIV);
  }
  return {
    fnum: Math.max(0, Math.min(2047, fnum)),
    block: Math.max(0, Math.min(7, block)),
  };
}

// ---------------------------------------------------------------------------
// Volume composition helpers
// ---------------------------------------------------------------------------
// Compose vel (0-15), vol (0-31), master (0-31) into a linear level 0.0-1.0.
export function composeLevel(vel, vol, master) {
  return (vel / 15) * (vol / 31) * (master / 31);
}

// Convert composed level 0.0-1.0 → YM2612 TL (0=max, 127=silent).
// TL is already in dB domain (~0.375 dB/step), so a linear mapping produces
// a perceptually linear (constant dB/frame) fade. No x² correction needed.
export function levelToFmTl(level) {
  const t = Math.max(0, Math.min(1, level));
  return Math.max(0, Math.min(127, Math.round((1 - t) * 127)));
}

// Convert composed level 0.0-1.0 → SN76489 attenuation (0=max, 15=silent).
// Att is already in dB domain (2 dB/step), so linear mapping is correct.
export function levelToPsgAtt(level) {
  const t = Math.max(0, Math.min(1, level));
  return Math.max(0, Math.min(15, Math.round((1 - t) * 15)));
}

// Convenience: compose vel/vol/master and convert to hardware register in one call.
// Add analogous functions (composePcmVol, composeCsmTl, …) when new synth types land.
export function composeFmTl(vel, vol, master) {
  return levelToFmTl(composeLevel(vel, vol, master));
}
export function composePsgAtt(vel, vol, master) {
  return levelToPsgAtt(composeLevel(vel, vol, master));
}

// ---------------------------------------------------------------------------
// Vol sweep sampling + curve helpers
// ---------------------------------------------------------------------------

// Sample a vol sweep state { from, to, curve, baseFrames, nonLoopOffset, startWhen }
// at the given audio time. Returns a clamped value in the same range as from/to.
// Shared by _fmVolAtTime and _psgVolAtTime.
export function sweepVolAtTime(sweep, when) {
  const frameOffset = Math.max(0, (when - sweep.startWhen) * 60);
  const frame = (sweep.nonLoopOffset ?? 0) + frameOffset;
  const phase =
    sweep.baseFrames <= 1 ? 1 : Math.min(1, frame / (sweep.baseFrames - 1));
  const unit = sampleCurveUnit(sweep.curve, phase);
  return Math.max(0, Math.min(31, sweep.from + (sweep.to - sweep.from) * unit));
}

// Compute sweep phase [0,1] for a given frame index.
// loop=true wraps with loopPhaseOffset; loop=false clamps to 1.
export function sampleSweepPhase(frame, baseFrames, loop, loopPhaseOffset) {
  return loop
    ? ((frame + loopPhaseOffset) % baseFrames) / baseFrames
    : baseFrames <= 1
      ? 1
      : Math.min(1, frame / (baseFrames - 1));
}

export function sampleCurveUnit(curve, phase) {
  const t = Math.max(0, Math.min(1, phase));
  switch (curve) {
    case "linear":
      return t;
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) * (1 - t);
    case "ease-in-out":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "sin":
      return (Math.sin(2 * Math.PI * t - Math.PI / 2) + 1) / 2;
    case "triangle":
      return t < 0.5 ? t * 2 : 2 - t * 2;
    case "square":
      return t < 0.5 ? 0 : 1;
    case "saw":
    case "ramp":
      return t;
    default:
      return t;
  }
}

// ---------------------------------------------------------------------------
// YM2612 channel register state + encoding
// ---------------------------------------------------------------------------
//
// MMLisp param names (from IR) map to hardware registers.
// Channel-level params:
//   FM_FB      → 0xB0 bits 5-3 (feedback, 0-7)
//   FM_ALG     → 0xB0 bits 2-0 (algorithm, 0-7)
//   FM_AMS     → 0xB4 bits 5-4 (AM sensitivity, 0-3)
//   FM_FMS     → 0xB4 bits 2-0 (FM sensitivity, 0-7)
//   LFO_RATE   → 0x22 global (0=off, 1-8=rate index)
// Operator params (op1-op4):
//   FM_TL1..4  → 0x40 per op (total level, 0-127)
//   FM_AR1..4  → 0x50 per op (attack rate, 0-31)
//   FM_DR1..4  → 0x60 per op bits 4-0 (decay rate, 0-31)
//   FM_AMEN1..4 → 0x60 per op bit 7 (AM enable, 0-1)
//   FM_SR1..4  → 0x70 per op (sustain rate, 0-31)
//   FM_RR1..4  → 0x80 per op (release rate bits 3-0)
//   FM_SL1..4  → 0x80 per op (sustain level bits 7-4)
//   FM_ML1..4  → 0x30 per op (multiplier bits 3-0)
//   FM_DT1..4  → 0x30 per op (detune bits 6-4)

export const OP_ADDR_OFFSET = [0, 8, 4, 12]; // op1,op2,op3,op4 in OPN2 register space

export function buildChannelRegState(chIndex) {
  // Returns a mutable object representing all register state for a channel
  return {
    algorithm: 0,
    feedback: 0,
    pan: 0, // -1 (left) / 0 (center) / 1 (right), used for PAN macro
    ams: 0, // LFO AM sensitivity 0-3 (0xB4 bits 5-4)
    fms: 0, // LFO FM sensitivity 0-7 (0xB4 bits 2-0)
    b4: 0xc0, // Cache of YM2612 B4 register (read-only on hardware; we cache to preserve bits)
    ops: [
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
      {
        tl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
      },
    ],
  };
}

// Encode B0 register (algorithm + feedback)
export function encodeB0(regs) {
  return ((regs.feedback & 0x07) << 3) | (regs.algorithm & 0x07);
}

// Encode B4 register (pan + AMS/FMS)
export function encodeB4(regs) {
  // PAN: -1 (left) → 0b10, 0 (center) → 0b11, 1 (right) → 0b01
  const panBits = regs.pan < 0 ? 0b10 : regs.pan > 0 ? 0b01 : 0b11;
  return (panBits << 6) | ((regs.ams & 0x03) << 4) | (regs.fms & 0x07);
}

// Encode 0x60 (AM enable + DR) for an operator
export function encode60(op) {
  return ((op.amen & 0x01) << 7) | (op.dr & 0x1f);
}

// Encode 0x30 (DT1/MUL) for an operator
export function encode30(op) {
  return ((op.dt & 0x07) << 4) | (op.mul & 0x0f);
}

// Encode 0x80 (SL/RR) for an operator
export function encode80(op) {
  return ((op.sl & 0x0f) << 4) | (op.rr & 0x0f);
}

export function fmCarrierOpsForAlg(alg) {
  const CARRIER_OPS = [
    [3], // alg 0: op4
    [3], // alg 1: op4
    [3], // alg 2: op4
    [3], // alg 3: op4
    [1, 3], // alg 4: op2, op4
    [1, 2, 3], // alg 5: op2, op3, op4
    [1, 2, 3], // alg 6: op2, op3, op4
    [0, 1, 2, 3], // alg 7: all
  ];
  return CARRIER_OPS[alg] ?? [3];
}

// ---------------------------------------------------------------------------
// Channel name → index maps
// ---------------------------------------------------------------------------

// YM2612 channel name → 0-based channel index
export const CH_NAME_TO_INDEX = {
  fm1: 0,
  fm2: 1,
  fm3: 2,
  fm4: 3,
  fm5: 4,
  fm6: 5,
};

// SN76489 PSG channel name → 0-based PSG channel index (0-3)
export const PSG_CH_NAME_TO_INDEX = {
  sqr1: 0,
  sqr2: 1,
  sqr3: 2,
  noise: 3,
};

// PSG MASTER_CLOCK (NTSC Mega Drive)
export const PSG_MASTER_CLOCK = 3579545;

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

// Lead time in seconds before gate boundary for FM key-off writes.
// Gives the FM envelope time to start decaying before the note technically ends.
export const KEY_OFF_LEAD_SECS = 0.005;

// Sentinel frame count used for hold notes (gateTicks === 0).
// Macros continue until triggerKeyOff() is called at runtime.
export const HOLD_FRAMES = 0x7fffffff;
