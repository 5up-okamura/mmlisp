// Sample effects — the def's `:effect [...]` chain (docs/language.md §16).
//
// ALL COMPILE-TIME. The chain runs once per sample when the bank is baked
// (export-mmb.js), on float data at the sample's own rate, before the per-note
// resample and the single 8-bit quantize. The driver, the MMB format and the
// IR's event stream never see an effect: what they play is the processed
// bytes. That is the whole cost model — an effect costs bank bytes (a fade
// SAVES them), never Z80 time.
//
// One table, two readers: the compiler validates `:effect` against
// SAMPLE_EFFECTS and hands the IR a resolved list (times in seconds, levels in
// dB), and applySampleEffects runs that list. Inside the chain nothing clips;
// the quantize at the end is the one hard clip, so a `gain` that overshoots is
// caught by a later `limit` / `normalize` or clips there.

import { sampleCurveUnit } from "./ir-utils.js";

// Param kinds: "db" (a number, dB), "num" (a plain number), "int",
// "time" (a length token → seconds; `positive` when 0 is not a span),
// "curve" (a one-shot curve name). `pos` names the param a bare positional
// value fills: `(gain 6)`.
export const SAMPLE_EFFECTS = {
  gain: { pos: "db", params: { db: { kind: "db", required: true } } },
  normalize: { params: { peak: { kind: "db", def: 0, max: 0 } } },
  comp: {
    params: {
      threshold: { kind: "db", def: -18, max: 0 },
      ratio: { kind: "num", def: 4, min: 1 },
      attack: { kind: "time", def: 0.005 },
      release: { kind: "time", def: 0.08 },
      knee: { kind: "db", def: 6, min: 0 },
      makeup: { kind: "db", def: 0 },
    },
  },
  limit: {
    params: {
      ceiling: { kind: "db", def: 0, max: 0 },
      release: { kind: "time", def: 0.05 },
    },
  },
  crush: { pos: "bits", params: { bits: { kind: "int", required: true, min: 1, max: 8 } } },
  fade: {
    params: {
      at: { kind: "time", def: null },
      len: { kind: "time", required: true, positive: true },
      curve: { kind: "curve", def: "linear" },
    },
  },
  reverb: {
    params: {
      size: { kind: "num", def: 0.5, min: 0, max: 1 },
      damp: { kind: "num", def: 0.5, min: 0, max: 1 },
      mix: { kind: "num", def: 0.3, min: 0, max: 1 },
      predelay: { kind: "time", def: 0 },
      tail: { kind: "time", required: true, positive: true },
    },
  },
};

const dbToGain = (db) => Math.pow(10, db / 20);
// One-pole smoothing coefficient for a time constant, in samples.
const coef = (sec, rate) => (sec > 0 ? Math.exp(-1 / (sec * rate)) : 0);
// The limiter's lookahead: long enough that the gain ramps down instead of
// stepping (a step is a click), short enough to sound like nothing.
const LIMIT_LOOKAHEAD_SEC = 0.002;

function gain(x, { db }) {
  const g = dbToGain(db);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function normalize(x, { peak }) {
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]));
  if (max === 0) return x; // silence stays silence
  const g = dbToGain(peak) / max;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

// Feed-forward compressor: a soft-knee gain computer in dB, its gain
// reduction smoothed by attack (reduction growing) and release (shrinking).
function comp(x, { threshold: T, ratio: R, attack, release, knee: W, makeup }, rate) {
  const aA = coef(attack, rate);
  const aR = coef(release, rate);
  let g = 0; // current gain reduction, dB (<= 0)
  for (let i = 0; i < x.length; i++) {
    const lvl = 20 * Math.log10(Math.abs(x[i]) + 1e-9);
    const over = lvl - T;
    let y = lvl;
    if (2 * over >= W) y = T + over / R;
    else if (W > 0 && 2 * over > -W) y = lvl + ((1 / R - 1) * (over + W / 2) ** 2) / (2 * W);
    const target = y - lvl;
    const a = target < g ? aA : aR;
    g = a * g + (1 - a) * target;
    x[i] *= dbToGain(g + makeup);
  }
  return x;
}

// Brickwall limiter. Offline, so the lookahead costs no latency: the gain each
// sample needs is taken as a running minimum over the lookahead window, then
// box-filtered over the same window — a ramp that is at or below the needed
// gain at every peak — then released upward by a one-pole. The result never
// exceeds the ceiling; the final clamp only guards float rounding.
function limit(x, { ceiling, release }, rate) {
  const c = dbToGain(ceiling);
  const n = x.length;
  const L = Math.max(1, Math.round(LIMIT_LOOKAHEAD_SEC * rate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    need[i] = a > c ? c / a : 1;
  }
  const lo = new Float32Array(n); // min(need[i .. i+L-1])
  for (let i = 0; i < n; i++) {
    let m = 1;
    for (let j = i; j < Math.min(n, i + L); j++) if (need[j] < m) m = need[j];
    lo[i] = m;
  }
  const aR = coef(release, rate);
  let sum = 0;
  let r = 1;
  for (let i = 0; i < n; i++) {
    sum += lo[i];
    if (i >= L) sum -= lo[i - L];
    const s = sum / Math.min(L, i + 1); // mean(lo[i-L+1 .. i])
    r = s < r ? s : r + (s - r) * (1 - aR);
    const v = x[i] * r;
    x[i] = v > c ? c : v < -c ? -c : v;
  }
  return x;
}

// Quantize to N bits on the float scale; the 8-bit quantize at the end then
// holds those N-bit steps.
function crush(x, { bits }) {
  const q = Math.pow(2, bits - 1) - 1 || 1;
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * q) / q;
    x[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return x;
}

// Fade to silence from `at` over `len`, shaped by a one-shot curve (the gain
// is 1 − curve, so `ease-out-expo` drops fast then tails, like a natural
// decay), and cut the sample where the fade ends.
function fade(x, { at, len, curve }, rate, warn) {
  const n = x.length;
  const dur = n / rate;
  const start = at ?? Math.max(0, dur - len);
  if (start >= dur) {
    warn("W_SAMPLE_FX_FADE_PAST_END",
      `fade starts at ${ms(start)} but the sample is ${ms(dur)} long; no fade`);
    return x;
  }
  if (start + len > dur + 1 / rate) {
    warn("W_SAMPLE_FX_FADE_PAST_END",
      `fade ${ms(start)}+${ms(len)} runs past the sample's end (${ms(dur)}); it is cut before it reaches silence`);
  }
  const i0 = Math.round(start * rate);
  const i1 = Math.min(n, Math.round((start + len) * rate));
  const span = Math.max(1, Math.round(len * rate));
  for (let i = i0; i < i1; i++) x[i] *= 1 - sampleCurveUnit(curve, (i - i0) / span);
  return i1 < n ? x.slice(0, i1) : x;
}

const ms = (sec) => `${Math.round(sec * 1000)}ms`;

// Freeverb (Jezar's tunings, mono): eight lowpass-feedback combs in parallel,
// four allpasses in series, the delays scaled from 44.1 kHz to the sample's
// rate. The sample grows by `tail`, and the tail fades out over that span
// ((1 − u)²), so what the bank pays for is exactly what was asked. Baked per
// def, it is not a shared bus: the next note on the voice cuts the tail.
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
function reverb(x, { size, damp, mix, predelay, tail }, rate) {
  const scale = rate / 44100;
  const n = x.length;
  const pre = Math.round(predelay * rate);
  const total = n + Math.round(tail * rate);
  const feedback = 0.7 + 0.28 * size;
  const d = 0.4 * damp;
  const combs = COMB_TUNING.map((t) => ({ buf: new Float32Array(Math.max(1, Math.round(t * scale))), i: 0, lp: 0 }));
  const aps = ALLPASS_TUNING.map((t) => ({ buf: new Float32Array(Math.max(1, Math.round(t * scale))), i: 0 }));
  const out = new Float32Array(total);
  for (let k = 0; k < total; k++) {
    const dry = k < n ? x[k] : 0;
    const inp = (k - pre >= 0 && k - pre < n ? x[k - pre] : 0) * 0.015;
    let wet = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * (1 - d) + c.lp * d;
      c.buf[c.i] = inp + c.lp * feedback;
      c.i = (c.i + 1) % c.buf.length;
      wet += y;
    }
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = wet + b * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      wet = b - wet;
    }
    let v = dry * (1 - mix) + wet * 3 * mix;
    if (k >= n) v *= (1 - (k - n) / (total - n)) ** 2;
    out[k] = v;
  }
  return out;
}

const APPLY = { gain, normalize, comp, limit, crush, fade, reverb };

/**
 * Run a resolved `:effect` chain over one sample.
 * @param {Float32Array} data  mono, -1..1, at `rate` Hz (the sample's own rate)
 * @param {number} rate
 * @param {Array<{type: string}>} effects  metadata.samples[].effect (docs/ir.md §2.2)
 * @param {(code: string, message: string) => void} [warn]
 * @returns {Float32Array} a new array (the input is not touched)
 */
export function applySampleEffects(data, rate, effects, warn = () => {}) {
  let x = Float32Array.from(data);
  for (const fx of effects ?? []) {
    const run = APPLY[fx.type];
    if (!run) {
      warn("W_SAMPLE_FX_UNKNOWN", `unknown effect "${fx.type}" skipped`);
      continue;
    }
    x = run(x, fx, rate, warn);
  }
  return x;
}

/** The one float → signed 8-bit step every bank byte goes through. */
export function quantizeS8(v) {
  const q = Math.round(v * 127);
  return q > 127 ? 127 : q < -128 ? -128 : q;
}
