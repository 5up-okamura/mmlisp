// A score's waves on another machine (score-port.js), and its voices on a
// machine of waves: the wave memories — the MSX's SCC, the PC Engine's six,
// the Famicom's FDS and N163, the Game Boy's wave channel — beside FM and
// the squares. The policy is the voices' (voice-port.js, the user's,
// 2026-11-08): a role plays the machine's sound for that role; anything
// else the nearest plain shape.
//   a wave's shape: the nearest of presets/wavetable's six plain ones (sine
//   triangle saw square pulse25 pulse12), by its harmonics' magnitudes — not
//   its level, not its phase (shapeOf)
//   a voice onto a wave channel: a role's wave and its macro
//   (`wave-piano`: the steps of wave and level that make the instrument); any
//   other 4-op voice its waveform's wave, with an envelope macro read off
//   its main carrier's EG (envelopeOf), as presets/envelopes writes one
//   the FDS's modulation ↔ the PC Engine's LFO (channel 2 swaying channel
//   1): the FDS's table summed is the LFO's wave, its rate the wave's pitch
//   and :lfo-freq, its depth the nearest :fms at the track's middle note
//   (fdsAsPce, pceAsFds)
// ---------------------------------------------------------------------------

import { egStep, CARRIERS } from "../import/fm-model.js";
import { midiToFnumBlock } from "../ir/pitch.js";
import { FDS_MOD_STEPS } from "../machine/chips/fds.js";
import { lineItems } from "../import/import-shapes.js";

export const WAVETABLE_SET = "presets/wavetable/set.mmlisp";

// ── A wave's shape ───────────────────────────────────────────────────────

const N = 32;
const cycle = (f) => Array.from({ length: N }, (_, i) => f(i / N));
// The plain shapes, as presets/wavetable writes them (by formula: the
// magnitudes are what is compared, so the set's exact steps need not be).
const SHAPES = {
  sine: cycle((x) => Math.sin(2 * Math.PI * x)),
  triangle: cycle((x) => (x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4)),
  saw: cycle((x) => 2 * x - 1),
  square: cycle((x) => (x < 0.5 ? 1 : -1)),
  pulse25: cycle((x) => (x < 0.25 ? 1 : -1)),
  pulse12: cycle((x) => (x < 0.125 ? 1 : -1)),
};
export const SHAPE_NAMES = Object.keys(SHAPES);

// The magnitudes of harmonics 1-15, the DC out, to unit length: how a wave
// sounds held still, whatever its level and phase.
function spectrum(steps) {
  const xs = steps.length === 64 ? steps.filter((_, i) => i % 2 === 0) : steps; // the FDS's 64, read as 32
  const n = xs.length;
  const mags = [];
  for (let k = 1; k < n / 2; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += xs[i] * Math.cos((2 * Math.PI * k * i) / n); im -= xs[i] * Math.sin((2 * Math.PI * k * i) / n); }
    mags.push(Math.hypot(re, im));
  }
  const len = Math.hypot(...mags) || 1;
  return mags.map((m) => m / len);
}
const SHAPE_SPECTRA = Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, spectrum(v)]));

/** The plain shape (sine, triangle, saw, square, pulse25, pulse12) a wave's steps sound nearest. */
export function shapeOf(steps) {
  // A wave that repeats within its cycle (a square drawn twice: an octave
  // up) is read on one repeat, each step held as the chip would not.
  let xs = wave32(steps);
  const range = Math.max(...xs) - Math.min(...xs);
  if (range === 0) return "sine"; // a silent wave: no shape, and nothing loud for it
  const tol = Math.max(1, range * 0.03); // a repeat to within 3 % of its swing
  while (xs.length >= 8 && xs.slice(0, xs.length / 2).every((x, i) => Math.abs(x - xs[i + xs.length / 2]) <= tol))
    xs = xs.slice(0, xs.length / 2);
  if (xs.length < N) xs = Array.from({ length: N }, (_, i) => xs[Math.floor((i * xs.length) / N)]);
  const s = spectrum(xs);
  let best = "sine", bestD = Infinity;
  for (const [name, ref] of Object.entries(SHAPE_SPECTRA)) {
    const d = s.reduce((a, x, i) => a + (x - ref[i]) ** 2, 0);
    if (d < bestD) { best = name; bestD = d; }
  }
  return best;
}

/** A 64-step wave (the FDS's) as 32, every other step — as a 32-step chip plays it. */
export const wave32 = (steps) => (steps.length === 64 ? steps.filter((_, i) => i % 2 === 0) : steps);

// ── A voice's envelope, as a macro ───────────────────────────────────────

const FRAME_HZ = 60;
const EG_HZ = 7670454 / 144 / 3; // the YM2612's EG ticks a second
const DB_PER_UNIT = 96 / 1024; // the EG's attenuation, 10 bits over 96 dB
const VEL_DB = 2; // a :vel step (language.md §6)
const KEY_FRAMES = 120; // how long a note is followed while held (2 s)
const REL_FRAMES = 60;

// The main carrier's attenuation (EG units) at each frame: held for up to
// KEY_FRAMES, until it settles, then released for up to REL_FRAMES.
function egFrames(op, kc = 0) {
  // The key scaling: KS 3 adds the key code whole, a high note's envelope
  // the faster (as fm-model.js runs it).
  const ksr = kc >> (3 - (op.ks & 3));
  const rate = (r) => (r === 0 ? 0 : Math.min(63, 2 * r + ksr));
  const ar = rate(op.ar), dr = rate(op.dr), sr = rate(op.sr), rr = Math.min(63, 4 * op.rr + 2 + ksr);
  const sl = op.sl === 15 ? 1023 : op.sl << 5;
  let att = ar >= 62 ? 0 : 1023, state = ar >= 62 ? 1 : 0, counter = 0;
  const perFrame = Math.round(EG_HZ / FRAME_HZ);
  const tick = () => {
    counter++;
    if (state === 0) {
      const inc = egStep(ar, counter);
      if (inc) att += ((~att) * inc) >> 4;
      if (att <= 0) { att = 0; state = 1; }
    } else {
      const r = state === 1 ? dr : state === 2 ? sr : rr;
      att = Math.min(1023, att + egStep(r, counter));
      if (state === 1 && att >= sl) state = 2;
    }
  };
  // The first frame is the key-on: what the attack starts from (at AR 31,
  // the level at once).
  const held = [att];
  for (let f = 1; f < KEY_FRAMES; f++) {
    for (let t = 0; t < perFrame; t++) tick();
    held.push(att);
    // Settled: held still (no sustain rate), or gone.
    if (f > 2 && (att >= 1023 || (state === 2 && sr === 0) || (state === 1 && dr === 0))) break;
  }
  state = 3;
  const released = [];
  for (let f = 0; f < REL_FRAMES && att < 1023; f++) {
    for (let t = 0; t < perFrame; t++) tick();
    released.push(att);
  }
  return { held, released };
}

// Frames a frame at a time as a vector's stages, straight where they run
// straight (import-shapes.js lineItems, every importer's way): `level` is
// the EG's level a frame, in steps, unrounded — an FM decay falls by the
// same dB a frame, so most of an envelope is one line, as near the EG as
// its rounded steps were — the rest its rounded values and their holds.
const tenth = (x) => Math.round(x * 10) / 10;
const lineVector = (level) => lineItems(level, { round: (x) => Math.max(-15, -Math.round(-x)), fmt: tenth, keepEnd: true });

/**
 * A 4-op voice's (its words, a Map) level over a note as a `:vel+` macro's
 * vector, presets/envelopes' way: the main carrier's EG a frame at a time,
 * `#sus` where it holds, `#rel` its release; 2 dB a step, −15 the floor.
 * `midi`: the note its key scaling (KS) is read at.
 */
export function envelopeOf(words, midi = 72) {
  const carriers = CARRIERS[words.get("FM_ALG") ?? 7].map((i) => i + 1);
  const main = carriers.sort((a, b) => (words.get(`FM_TL${a}`) ?? 0) - (words.get(`FM_TL${b}`) ?? 0))[0];
  const op = Object.fromEntries(["ar", "dr", "sr", "rr", "sl", "ks"].map((k) => [k, words.get(`FM_${k.toUpperCase()}${main}`) ?? 0]));
  if (op.ar === 0) op.ar = 31; // a voice that never sounds: read as struck
  const level = (att) => Math.max(-15, -(att * DB_PER_UNIT) / VEL_DB);
  const vel = (att) => Math.max(-15, -Math.round((att * DB_PER_UNIT) / VEL_DB));
  const { fnum, block } = midiToFnumBlock(midi);
  const { held, released } = egFrames(op, (block << 2) | ((fnum >> 9) & 3));
  const h = held.map(vel), r = released.map(vel);
  while (h.length > 1 && h.at(-1) === h.at(-2)) h.pop(); // the held level once
  const sus = h.pop();
  const lv = held.slice(0, h.length).map(level);
  // The release from where the note is let go (a curve after #rel with no
  // :from), to silence over the frames the EG takes from the sustain.
  const rel = r.length ? `(linear :to -15 :len ${r.length}f)` : "-15";
  return `[${[...lineVector(lv), "#sus", String(sus), "#rel", rel].join(" ")}]`;
}

// ── The FDS's modulation ↔ the PC Engine's LFO ───────────────────────────

const FDS_CLOCK = 1789773;
const PCE_CLOCK = 3579545;
/** The FDS modulation's passes a second at :lfo-freq n (a pass: its table's 32 entries, each twice). */
export const fdsModHz = (n) => (n * FDS_CLOCK) / (64 * 16 * 4096);
const fdsModFreqOf = (hz) => Math.max(1, Math.min(4095, Math.round((hz * 64 * 16 * 4096) / FDS_CLOCK)));
/** The PC Engine LFO's sways a second: wave2's pitch over (256 − :lfo-freq). */
export const pceLfoHz = (wave2Hz, lfoFreq) => wave2Hz / (256 - lfoFreq);
const hzOfMidi = (m) => 440 * 2 ** ((m - 69) / 12);
const midiOfHz = (hz) => Math.round(69 + 12 * Math.log2(hz / 440));
// The PC Engine's period for a pitch (3.58 MHz / 32 / f), and its :fms's
// sways in period steps (language.md §19 pce).
const pcePeriod = (hz) => PCE_CLOCK / 32 / hz;
const FMS_STEPS = [0, 16, 64, 256];
const STEP_VALUE = Object.fromEntries(Object.entries(FDS_MOD_STEPS).filter(([k]) => k !== "reset").map(([k]) => [k, Number(k)]));

/** The FDS's counter over a pass of `table` (32 entries: 0 ±1 ±2 ±4 reset), each entry twice. */
export function fdsCounter(table) {
  const out = [];
  let c = 0;
  for (const e of table) for (let k = 0; k < 2; k++) {
    c = e === "reset" ? 0 : (((c + Number(e)) & 0x7f) << 25) >> 25;
    out.push(c);
  }
  return out;
}

/**
 * The FDS's modulation as the PC Engine's LFO. `table` (the :lfo-wave), `n`
 * (:lfo-freq), `pmd` (:lfo-pmd), `midi` the modulated track's middle note:
 * { wave: 32 steps for wave2, note (wave2's MIDI note), lfoFreq, fms }.
 */
export function fdsAsPce({ table, n, pmd, midi }) {
  const counter = fdsCounter(table);
  const peak = Math.max(1, ...counter.map(Math.abs));
  const wave = wave32(counter).map((c) => Math.max(-128, Math.min(127, Math.round((c / peak) * 127))));
  const hz = fdsModHz(n);
  // wave2 at the pitch that puts :lfo-freq in the middle of its range, then
  // the :lfo-freq that comes nearest the rate at that note.
  const note = Math.max(24, Math.min(108, midiOfHz(hz * 128)));
  const lfoFreq = Math.max(0, Math.min(255, Math.round(256 - hzOfMidi(note) / hz)));
  return { wave, note, lfoFreq, fms: pceFmsOf((pmd * peak) / 1024, midi) };
}

/** The :fms (0-3) nearest a sway of ± `frac` of the pitch at MIDI note `midi`. */
export function pceFmsOf(frac, midi) {
  if (!(frac > 0)) return 0;
  const steps = frac * pcePeriod(hzOfMidi(midi));
  return 1 + [16, 64, 256].reduce((b, s, i) => (Math.abs(Math.log(s / steps)) < Math.abs(Math.log([16, 64, 256][b] / steps)) ? i : b), 0);
}

/** A PC Engine :lfo-freq read with wave2 at `note`, as the FDS's :lfo-freq. */
export const pceFreqAsFds = (lfoFreq, note) => fdsModFreqOf(pceLfoHz(hzOfMidi(note), lfoFreq));
/** An FDS :lfo-freq read as the PC Engine's, with wave2 at `note`. */
export const fdsFreqAsPce = (n, note) => Math.max(0, Math.min(255, Math.round(256 - hzOfMidi(note) / fdsModHz(n))));

/**
 * The PC Engine's LFO as the FDS's modulation: `wave` (wave2's 32 steps),
 * `note` (wave2's MIDI note), `lfoFreq`, `fms`, `midi` wave1's middle note:
 * { table: 32 entries, n, pmd }. The table is the wave's slope, held to the
 * chip's steps with the error carried on, so its sum is the wave.
 */
export function pceAsFds({ wave, note, lfoFreq, fms, midi }) {
  // The counter to draw, ±32 at its peak (room for the 7-bit counter).
  const top = Math.max(1, ...wave.map(Math.abs));
  // The counter starts at 0: the wave from where it rises through 0.
  const n = wave.length;
  const start = Math.max(0, wave.findIndex((w, i) => w <= 0 && wave[(i + 1) % n] > 0));
  const target = [...wave.slice(start + 1), ...wave.slice(0, start + 1)].map((w) => (w / top) * 32);
  const allowed = Object.values(STEP_VALUE);
  const table = [];
  let c = 0;
  for (let j = 0; j < 32; j++) {
    const want = (target[j] - c) / 2; // each entry is added twice
    const e = allowed.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), 0);
    table.push(e);
    c += 2 * e;
  }
  const peak = Math.max(1, ...fdsCounter(table).map(Math.abs));
  const frac = fms ? FMS_STEPS[fms] / pcePeriod(hzOfMidi(midi)) : 0;
  return { table, n: pceFreqAsFds(lfoFreq, note), pmd: Math.max(0, Math.min(63, Math.round((frac * 1024) / peak))) };
}
