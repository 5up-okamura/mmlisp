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
  // Discrete semitone offset sequence (×100 cents at playback). Counterpart to
  // NOTE_PITCH (continuous, cents).
  NOTE_SEMI: { min: -48, max: 48, integer: true },
  // Retrigger gate: sampled per :step, fires key-on at >= 0.5. Step lists use
  // 0/1; curves/stochastic signals pass through and are thresholded.
  KEYON: { min: 0, max: 1, integer: false },
  // Level controls clamp only (no rounding): values stay float through the
  // pipeline and are quantized once at the hardware-register write.
  VEL: { min: 0, max: 15, integer: false },

  // Channel-level
  VOL: { min: 0, max: 31, integer: false },
  MASTER: { min: 0, max: 31, integer: false },

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
  // Format: "c4", "e4", "f+3", "b-5", "c10" etc.
  const m = pitchStr.toLowerCase().match(/^([a-g][+\-]?)(\d+)$/);
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

// ---------------------------------------------------------------------------
// Unified level model — additive dB offsets
// ---------------------------------------------------------------------------
// vel / vol / master each map to a signed dB offset; the offsets are summed (in
// float) on top of an operator's voiced TL, and quantized once at the register
// write. This is the PMD/MDSDRV table style and maps directly onto a Z80 driver
// (add small per-control offset tables). The helpers below return register-step
// offsets (FM: dB ÷ 0.75; PSG: dB ÷ 2), as floats.
//
// Hardware step sizes, in dB:
export const TL_DB_PER_STEP = 0.75; // YM2612 TL — 128 steps over ~95 dB
export const PSG_DB_PER_STEP = 2; // SN76489 attenuator — 16 steps
// Velocity ladder (PMD / MDSDRV coarse-volume convention):
export const VEL_DB_PER_STEP = 2;
// vol/master mixer-fader (tunable): VOL_UNITY = 0 dB reference on the 0–31
// scale; values above boost, below cut. Unity sits below the top so there is
// boost headroom, like a real fader.
export const VOL_STEP_DB = 2;
export const VOL_UNITY = 24;

// Velocity (0-15) → TL attenuation (float, register steps). 2 dB/step ladder:
// vel 15 = 0 (patch level), vel 0 ≈ -30 dB floor. Attenuation only — never
// mutes (silence is a rest, or vol/master 0). Caller rounds once.
export function velToTlAtten(vel) {
  const v = Math.max(0, Math.min(15, vel));
  return ((15 - v) * VEL_DB_PER_STEP) / TL_DB_PER_STEP;
}

// vol or master (0-31) → signed TL offset (float). Bipolar mixer-fader around
// VOL_UNITY (0 dB): v > unity boosts (negative offset, louder), v < unity cuts.
// 0 is a hard mute handled by the caller (this curve does not reach silence).
export function volToTlOffset(v) {
  const x = Math.max(0, Math.min(31, v));
  return ((VOL_UNITY - x) * VOL_STEP_DB) / TL_DB_PER_STEP;
}

// PSG attenuator-domain counterparts (register steps = dB ÷ 2).
export function velToPsgAtten(vel) {
  const v = Math.max(0, Math.min(15, vel));
  return ((15 - v) * VEL_DB_PER_STEP) / PSG_DB_PER_STEP;
}
export function volToPsgOffset(v) {
  const x = Math.max(0, Math.min(31, v));
  return ((VOL_UNITY - x) * VOL_STEP_DB) / PSG_DB_PER_STEP;
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
  const unit = sampleCurveUnit(sweep.curve, phase, sweep.params);
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

const STOCHASTIC_LUT_SEED = 0xdead;
const STOCHASTIC_LUT_SIZE = 1024;

function createSeededRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function normalizeToUnit(values) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return values.map(() => 0.5);
  }
  const scale = 1 / (max - min);
  return values.map((v) => (v - min) * scale);
}

function buildStochasticLuts(size, seed) {
  const rng = createSeededRng(seed);

  const white = Array.from({ length: size }, () => rng() * 2 - 1);

  // Paul Kellet-style IIR approximation for pink noise.
  const pinkRaw = [];
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < size; i++) {
    const x = white[i];
    b0 = 0.99886 * b0 + 0.0555179 * x;
    b1 = 0.99332 * b1 + 0.0750759 * x;
    b2 = 0.969 * b2 + 0.153852 * x;
    b3 = 0.8665 * b3 + 0.3104856 * x;
    b4 = 0.55 * b4 + 0.5329522 * x;
    b5 = -0.7616 * b5 - 0.016898 * x;
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + 0.5362 * x;
    b6 = 0.115926 * x;
    pinkRaw.push(y);
  }

  // 1D value noise (Perlin-like smooth random curve).
  const latticeCount = 257;
  const lattice = Array.from({ length: latticeCount }, () => rng() * 2 - 1);
  const perlinRaw = [];
  const repeat = 8;
  for (let i = 0; i < size; i++) {
    const x = (i / size) * repeat;
    const x0 = Math.floor(x);
    const x1 = x0 + 1;
    const f = x - x0;
    const u = f * f * (3 - 2 * f);
    const a = lattice[x0 % lattice.length];
    const b = lattice[x1 % lattice.length];
    perlinRaw.push(a + (b - a) * u);
  }

  // Brown noise: leaky integrator, then min-max normalize.
  const brownRaw = [];
  let y = 0;
  for (let i = 0; i < size; i++) {
    y = 0.99 * y + 0.01 * white[i];
    brownRaw.push(y);
  }

  return {
    noise: normalizeToUnit(white),
    pink: normalizeToUnit(pinkRaw),
    perlin: normalizeToUnit(perlinRaw),
    brown: normalizeToUnit(brownRaw),
  };
}

const STOCHASTIC_LUTS = buildStochasticLuts(
  STOCHASTIC_LUT_SIZE,
  STOCHASTIC_LUT_SEED,
);

const LOOP_CURVE_NAMES = new Set([
  "sin",
  "triangle",
  "square",
  "saw",
  "ramp",
  "noise",
  "pink",
  "perlin",
  "brown",
]);

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function fract(v) {
  return v - Math.floor(v);
}

function sampleLut(lut, phase, hold = 1) {
  if (!lut || lut.length === 0) return phase;
  const idxRaw = Math.max(
    0,
    Math.min(lut.length - 1, Math.floor(phase * (lut.length - 1))),
  );
  const holdFrames = Math.max(1, Math.floor(Number(hold) || 1));
  const idx = Math.floor(idxRaw / holdFrames) * holdFrames;
  return lut[Math.min(lut.length - 1, idx)];
}

function hashUnit01(x) {
  const n = Math.sin((x + 1.23456789) * 12.9898) * 43758.5453123;
  return fract(n);
}

function applySkew(phase, skewRaw) {
  const skew = Math.max(-127, Math.min(127, Number(skewRaw) || 0));
  if (skew === 0) return phase;
  const pivot = 0.5 + (skew / 127) * 0.45;
  const p = Math.max(0.05, Math.min(0.95, pivot));
  if (phase <= p) return 0.5 * (phase / p);
  return 0.5 + 0.5 * ((phase - p) / (1 - p));
}

function sampleStochasticCurve(curve, phase, params) {
  const hold = Math.max(1, Math.floor(Number(params?.hold) || 1));
  const jitter = clamp01(Number(params?.jitter) || 0);

  const noiseLut = STOCHASTIC_LUTS.noise;
  const pinkLut = STOCHASTIC_LUTS.pink;
  const perlinLut = STOCHASTIC_LUTS.perlin;
  const brownLut = STOCHASTIC_LUTS.brown;

  let base = phase;
  if (curve === "noise") {
    base = sampleLut(noiseLut, phase, hold);
  } else if (curve === "pink") {
    const beta = Math.max(0.1, Number(params?.beta) || 1.0);
    const pink = sampleLut(pinkLut, phase, hold);
    if (beta === 1) {
      base = pink;
    } else if (beta < 1) {
      const mix = clamp01(1 - beta);
      const noise = sampleLut(noiseLut, phase, hold);
      base = pink * (1 - mix) + noise * mix;
    } else {
      const mix = clamp01(beta - 1);
      const brown = sampleLut(brownLut, phase, hold);
      base = pink * (1 - mix) + brown * mix;
    }
  } else if (curve === "perlin") {
    const octaves = Math.max(
      1,
      Math.min(8, Math.round(Number(params?.octaves) || 3)),
    );
    const lacunarity = Math.max(0.01, Number(params?.lacunarity) || 2.0);
    const persistence = Math.max(0.01, Number(params?.persistence) || 0.5);
    let total = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      total += amp * sampleLut(perlinLut, fract(phase * freq), hold);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    base = norm > 0 ? total / norm : sampleLut(perlinLut, phase, hold);
  } else if (curve === "brown") {
    const leak = Math.max(0, Math.min(0.9999, Number(params?.leak) || 0.99));
    const brown = sampleLut(brownLut, phase, hold);
    const noise = sampleLut(noiseLut, phase, hold);
    const whiten = clamp01((0.99 - leak) / 0.99);
    base = brown * (1 - whiten) + noise * whiten;
  }

  if (jitter <= 0) return base;
  const n = hashUnit01(phase * 131071.0);
  return base * (1 - jitter) + n * jitter;
}

export function sampleCurveUnit(curve, phase, params = null) {
  const phaseOffset = (Number(params?.phase) || 0) / 256;
  const rate = Number(params?.rate);
  const rateMul = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const phaseScaled = (phase + phaseOffset) * rateMul;
  const t = LOOP_CURVE_NAMES.has(curve)
    ? fract(phaseScaled)
    : clamp01(phaseScaled);
  switch (curve) {
    case "linear":
      return t;
    // ── Sine ──────────────────────────────────────────────────────────────
    case "ease-in-sine":
      return 1 - Math.cos((t * Math.PI) / 2);
    case "ease-out-sine":
      return Math.sin((t * Math.PI) / 2);
    case "ease-inout-sine":
      return -(Math.cos(Math.PI * t) - 1) / 2;
    // ── Quad ──────────────────────────────────────────────────────────────
    case "ease-in":
    case "ease-in-quad":
      return t * t;
    case "ease-out":
    case "ease-out-quad":
      return 1 - (1 - t) * (1 - t);
    case "ease-inout":
    case "ease-inout-quad":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // ── Cubic ─────────────────────────────────────────────────────────────
    case "ease-in-cubic":
      return t * t * t;
    case "ease-out-cubic":
      return 1 - Math.pow(1 - t, 3);
    case "ease-inout-cubic":
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    // ── Quart ─────────────────────────────────────────────────────────────
    case "ease-in-quart":
      return t * t * t * t;
    case "ease-out-quart":
      return 1 - Math.pow(1 - t, 4);
    case "ease-inout-quart":
      return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
    // ── Quint ─────────────────────────────────────────────────────────────
    case "ease-in-quint":
      return Math.pow(t, 5);
    case "ease-out-quint":
      return 1 - Math.pow(1 - t, 5);
    case "ease-inout-quint":
      return t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2;
    // ── Expo ──────────────────────────────────────────────────────────────
    case "ease-in-expo":
      return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
    case "ease-out-expo":
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    case "ease-inout-expo":
      return t === 0
        ? 0
        : t === 1
          ? 1
          : t < 0.5
            ? Math.pow(2, 20 * t - 10) / 2
            : (2 - Math.pow(2, -20 * t + 10)) / 2;
    // ── Circ ──────────────────────────────────────────────────────────────
    case "ease-in-circ":
      return 1 - Math.sqrt(1 - t * t);
    case "ease-out-circ":
      return Math.sqrt(1 - Math.pow(t - 1, 2));
    case "ease-inout-circ":
      return t < 0.5
        ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
        : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2;
    // ── Back ──────────────────────────────────────────────────────────────
    case "ease-in-back": {
      const c1 = 1.70158,
        c3 = c1 + 1;
      return c3 * t * t * t - c1 * t * t;
    }
    case "ease-out-back": {
      const c1 = 1.70158,
        c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    case "ease-inout-back": {
      const c1 = 1.70158,
        c2 = c1 * 1.525;
      return t < 0.5
        ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
        : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (2 * t - 2) + c2) + 2) / 2;
    }
    // ── Elastic ───────────────────────────────────────────────────────────
    case "ease-in-elastic": {
      const c4 = (2 * Math.PI) / 3;
      return t === 0
        ? 0
        : t === 1
          ? 1
          : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
    }
    case "ease-out-elastic": {
      const c4 = (2 * Math.PI) / 3;
      return t === 0
        ? 0
        : t === 1
          ? 1
          : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
    case "ease-inout-elastic": {
      const c5 = (2 * Math.PI) / 4.5;
      return t === 0
        ? 0
        : t === 1
          ? 1
          : t < 0.5
            ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
            : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) /
                2 +
              1;
    }
    // ── Bounce ────────────────────────────────────────────────────────────
    case "ease-out-bounce": {
      const n1 = 7.5625,
        d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
    case "ease-in-bounce":
      return 1 - sampleCurveUnit("ease-out-bounce", 1 - t);
    case "ease-inout-bounce":
      return t < 0.5
        ? (1 - sampleCurveUnit("ease-out-bounce", 1 - 2 * t)) / 2
        : (1 + sampleCurveUnit("ease-out-bounce", 2 * t - 1)) / 2;
    // ── Loop waveforms ────────────────────────────────────────────────────
    case "sin":
      return (
        (Math.sin(2 * Math.PI * applySkew(t, params?.skew) - Math.PI / 2) + 1) /
        2
      );
    case "triangle": {
      const tt = applySkew(t, params?.skew);
      return tt < 0.5 ? tt * 2 : 2 - tt * 2;
    }
    case "square": {
      const duty = Math.max(
        1,
        Math.min(255, Math.round(Number(params?.duty) || 128)),
      );
      const threshold = duty / 256;
      return t < threshold ? 0 : 1;
    }
    case "saw":
    case "ramp":
      return applySkew(t, params?.skew);
    // ── Stochastic (v0.5; LUT-based at compile time) ──────────────────────
    case "noise":
    case "pink":
    case "perlin":
    case "brown":
      return sampleStochasticCurve(curve, t, params);
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
        voicedTl: 0,
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
        voicedTl: 0,
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
        voicedTl: 0,
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
        voicedTl: 0,
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
