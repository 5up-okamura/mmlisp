// A sweep's curve sampled: its phase over a frame count, the named curve
// shapes, and the seeded stochastic ones (their look-up tables built once).

// ---------------------------------------------------------------------------
// Sweep curve helpers
// ---------------------------------------------------------------------------

// Compute sweep phase [0,1] for a given frame index.
// loop=true wraps with loopPhaseOffset; loop=false clamps to 1.
export function sampleSweepPhase(frame, baseFrames, loop, loopPhaseOffset) {
  return loop
    ? ((frame + loopPhaseOffset) % baseFrames) / baseFrames
    : baseFrames <= 1
      ? 1
      : Math.min(1, frame / (baseFrames - 1));
}

export const STOCHASTIC_LUT_SEED = 0xdead;
const STOCHASTIC_LUT_SIZE = 1024;

export function createSeededRng(seed) {
  // Scramble the seed first (murmur3's finalizer): the LCG maps nearby seeds
  // to nearby states, so seeds 1, 2, 3 would open on the same value.
  let state = seed >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x85ebca6b) >>> 0;
  state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35) >>> 0;
  state = (state ^ (state >>> 16)) >>> 0;
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

  return {
    white,
    noise: normalizeToUnit(white),
    pink: normalizeToUnit(pinkRaw),
    perlin: normalizeToUnit(perlinRaw),
    brown: brownTable(white, BROWN_DEFAULT_LEAK),
  };
}

// Brown noise: a leaky integrator over the seed's white noise, then min-max
// normalized. `leak` is the curve's `:leak` (0 = white, towards 1 = slower
// drift); each (seed, leak) is built once.
const BROWN_DEFAULT_LEAK = 0.99;
function brownTable(white, leak) {
  const raw = [];
  let y = 0;
  for (let i = 0; i < white.length; i++) {
    y = leak * y + (1 - leak) * white[i];
    raw.push(y);
  }
  return normalizeToUnit(raw);
}
function brownLutFor(luts, leak) {
  if (leak === BROWN_DEFAULT_LEAK) return luts.brown;
  const cache = (luts.brownByLeak ??= new Map());
  let lut = cache.get(leak);
  if (!lut) cache.set(leak, (lut = brownTable(luts.white, leak)));
  return lut;
}

const STOCHASTIC_LUTS = buildStochasticLuts(
  STOCHASTIC_LUT_SIZE,
  STOCHASTIC_LUT_SEED,
);

// Per-seed stochastic LUT sets, memoized (`:seed`, language.md §11.1). The
// default seed reuses the module-level tables so seedless sources are
// byte-identical; other seeds regenerate once and cache. Compile-time only —
// the driver replays the sampled values, so the seed costs it nothing.
const stochasticLutCache = new Map();
function getStochasticLuts(seed) {
  if (seed == null || (seed >>> 0) === STOCHASTIC_LUT_SEED) return STOCHASTIC_LUTS;
  const key = seed >>> 0;
  let luts = stochasticLutCache.get(key);
  if (!luts) {
    luts = buildStochasticLuts(STOCHASTIC_LUT_SIZE, key);
    stochasticLutCache.set(key, luts);
  }
  return luts;
}

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

function sampleLut(lut, phase) {
  if (!lut || lut.length === 0) return phase;
  const idx = Math.max(
    0,
    Math.min(lut.length - 1, Math.floor(phase * (lut.length - 1))),
  );
  return lut[idx];
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

const STOCHASTIC_HOLD_CURVES = new Set(["noise", "pink", "perlin", "brown"]);

function sampleStochasticCurve(curve, phase, params) {
  const jitter = clamp01(Number(params?.jitter) || 0);

  const luts = getStochasticLuts(params?.seed);
  const noiseLut = luts.noise;
  const pinkLut = luts.pink;
  const perlinLut = luts.perlin;
  const brownLut = luts.brown;

  let base = phase;
  if (curve === "noise") {
    base = sampleLut(noiseLut, phase);
  } else if (curve === "pink") {
    const beta = Math.max(0.1, Number(params?.beta) || 1.0);
    const pink = sampleLut(pinkLut, phase);
    if (beta === 1) {
      base = pink;
    } else if (beta < 1) {
      const mix = clamp01(1 - beta);
      const noise = sampleLut(noiseLut, phase);
      base = pink * (1 - mix) + noise * mix;
    } else {
      const mix = clamp01(beta - 1);
      const brown = sampleLut(brownLut, phase);
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
      total += amp * sampleLut(perlinLut, fract(phase * freq));
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    base = norm > 0 ? total / norm : sampleLut(perlinLut, phase);
  } else if (curve === "brown") {
    const raw = Number(params?.leak ?? BROWN_DEFAULT_LEAK);
    const leak = Number.isFinite(raw) ? Math.max(0, Math.min(0.9999, raw)) : BROWN_DEFAULT_LEAK;
    base = sampleLut(brownLutFor(luts, leak), phase);
  }

  if (jitter <= 0) return base;
  const n = hashUnit01(phase * 131071.0);
  return base * (1 - jitter) + n * jitter;
}

export function sampleCurveUnit(curve, phase, params = null) {
  // A stochastic curve's `:hold`: its share of :len (the compiler's
  // resolveCurveHold). The time is held on that grid before :rate and :phase,
  // so each value lasts the hold's length whatever the curve's speed.
  const hold = Number(params?.hold);
  if (hold > 0 && STOCHASTIC_HOLD_CURVES.has(curve))
    phase = Math.floor(phase / hold + 1e-9) * hold;
  const phaseOffset = (Number(params?.phase) || 0) / 256;
  const rate = Number(params?.rate);
  // rate is a phase-speed multiplier: rate 0 freezes the curve at its start
  // phase (no time flow), so allow >= 0; only non-finite/negative falls back.
  // It scales the time only — `:phase` is where the curve starts, at any rate.
  const rateMul = Number.isFinite(rate) && rate >= 0 ? rate : 1;
  const phaseScaled = phase * rateMul + phaseOffset;
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
      const bounce = (u, add) => n1 * u * u + add;
      if (t < 1 / d1) return bounce(t, 0);
      if (t < 2 / d1) return bounce(t - 1.5 / d1, 0.75);
      if (t < 2.5 / d1) return bounce(t - 2.25 / d1, 0.9375);
      return bounce(t - 2.625 / d1, 0.984375);
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
    // ── Stochastic (LUT-based at compile time) ────────────────────────────
    case "noise":
    case "pink":
    case "perlin":
    case "brown":
      return sampleStochasticCurve(curve, t, params);
    default:
      return t;
  }
}
