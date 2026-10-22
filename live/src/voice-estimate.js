/**
 * WAV → FM voice: a YM2612 patch estimated for one note (File > Import >
 * Resynthesis > WAV as FM Voice…).
 *
 * FM has no inverse — a patch's sound is easy to compute, the patch of a
 * sound is not — so this searches: candidate patches are rendered on the fast
 * model (fm-model.js), compared with the recording, and moved towards it.
 * What can be read directly narrows the search first: the pitch (the note
 * the patch plays) and the loudness contour (the carriers' AR, DR, SL, SR,
 * fitted on one sine). Then, per algorithm, a genetic search over FB and each
 * operator's ML, TL, AR, DR, SR, SL and KS; the best algorithms go on with a
 * longer search, a one-field-at-a-time polish and an iterated local search
 * (a small kick, a polish, kept when it is better).
 *
 * The comparison is a log-band spectrogram (48 bands, 60 Hz – 12 kHz, frames
 * of 19 ms) after matching the overall level; each band's error is floored at
 * the frame's peak − 50 dB, so what cannot be heard under the rest does not
 * pull, and the attack's first frames weigh triple.
 *
 * The stages are separate functions that take and return plain data, so the
 * page can run the algorithms in parallel workers (voice-estimate-worker.js).
 */
import { renderModel, RATE, CARRIERS } from "./fm-model.js";

export { RATE };
// computed on the signal decimated by 2 (≈26.6 kHz): FFT 1024, hop 512 ≈ 19 ms
const N = 1024, HOP = 512, BANDS = 48, F_LO = 60, F_HI = 12000, SR = RATE / 2;
const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const edges = Array.from({ length: BANDS + 1 }, (_, b) => F_LO * Math.pow(F_HI / F_LO, b / BANDS));
const binOf = (f) => Math.round((f * N) / SR);
const lo = edges.slice(0, BANDS).map((f) => Math.max(1, binOf(f)));
const hi = edges.slice(1).map((f, b) => Math.max(lo[b], binOf(f) - 1));
// radix-2 FFT on re/im in place
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
export function features(full) {
  const x = new Float32Array(full.length >> 1);
  for (let i = 0; i < x.length; i++) x[i] = (full[2 * i] + full[2 * i + 1]) * 0.5;
  const frames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const spec = new Float64Array(frames * BANDS), loud = new Float64Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = (x[f * HOP + i] ?? 0) * win[i];
    fft(re, im);
    let tot = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = lo[b]; k <= hi[b]; k++) e += re[k] * re[k] + im[k] * im[k];
      spec[f * BANDS + b] = e; tot += e;
    }
    loud[f] = tot;
  }
  return { frames, spec, loud };
}
// distance: log-spectral difference (dB) after matching the overall level,
// weighted by the target's loudness so silence does not dominate
export function distance(A, B) {
  const F = Math.min(A.frames, B.frames);
  let sa = 0, sb = 0;
  for (let f = 0; f < F; f++) { sa += A.loud[f]; sb += B.loud[f]; }
  const g = sb > 0 ? sa / sb : 1; // B scaled to A's energy
  const peak = Math.max(...A.loud.slice(0, F)) || 1;
  let d = 0, wsum = 0;
  for (let f = 0; f < F; f++) {
    const w = Math.max(1e-3, Math.sqrt(A.loud[f] / peak));
    const floor = peak * 1e-7;
    for (let b = 0; b < BANDS; b++) {
      const a = 10 * Math.log10(A.spec[f * BANDS + b] + floor), c = 10 * Math.log10(B.spec[f * BANDS + b] * g + floor);
      d += w * Math.abs(a - c);
    }
    // the loudness contour too, in dB
    d += w * BANDS * 0.5 * Math.abs(10 * Math.log10((A.loud[f] + floor) / (B.loud[f] * g + floor)));
    wsum += w * BANDS;
  }
  return d / wsum; // mean dB error
}

// The search's distance: the same log-band error, but each band's error is
// floored at the frame's own peak − 50 dB (what cannot be heard under the
// rest does not pull), and the first frames — the attack — weigh triple.
// A noise's spectrum compared as its colour, not its lines: each band's energy
// averaged with its three neighbours either side.
export function smoothBands(A, half = 3) {
  const spec = new Float64Array(A.spec.length);
  for (let f = 0; f < A.frames; f++)
    for (let b = 0; b < BANDS; b++) {
      let e = 0, n = 0;
      for (let k = Math.max(0, b - half); k <= Math.min(BANDS - 1, b + half); k++) { e += A.spec[f * BANDS + k]; n++; }
      spec[f * BANDS + b] = e / n;
    }
  return { frames: A.frames, spec, loud: A.loud };
}

export function searchDistance(A, B) {
  const F = Math.min(A.frames, B.frames);
  let sa = 0, sb = 0;
  for (let f = 0; f < F; f++) { sa += A.loud[f]; sb += B.loud[f]; }
  const g = sb > 0 ? sa / sb : 1;
  let peak = 0; for (let f = 0; f < F; f++) peak = Math.max(peak, A.loud[f]);
  peak = peak || 1;
  let d = 0, wsum = 0;
  for (let f = 0; f < F; f++) {
    const w = Math.max(1e-3, Math.sqrt(A.loud[f] / peak)) * (f < 4 ? 3 : 1);
    let fpk = 0; for (let b = 0; b < BANDS; b++) fpk = Math.max(fpk, A.spec[f * BANDS + b]);
    const floor = Math.max(fpk * 1e-5, peak * 1e-7);
    for (let b = 0; b < BANDS; b++) {
      const a = 10 * Math.log10(A.spec[f * BANDS + b] + floor), c = 10 * Math.log10(B.spec[f * BANDS + b] * g + floor);
      d += w * Math.abs(a - c);
    }
    d += w * BANDS * 0.5 * Math.abs(10 * Math.log10((A.loud[f] + peak * 1e-7) / (B.loud[f] * g + peak * 1e-7)));
    wsum += w * BANDS;
  }
  return d / wsum;
}
// a seeded RNG so a run is repeatable
export function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export function resampleTo(x, from, to = RATE) {
  const n = Math.floor((x.length * to) / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), t = p - k; out[i] = (x[k] ?? 0) * (1 - t) + (x[k + 1] ?? 0) * t; }
  return out;
}
// trim to the onset, at most maxSec long
export function trimNote(x, maxSec = 1.0) {
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  let s = 0; while (s < x.length && Math.abs(x[s]) < peak * 0.02) s++;
  s = Math.max(0, s - 32);
  return x.subarray(s, Math.min(x.length, s + Math.round(maxSec * RATE)));
}
// f0 by normalized autocorrelation on a window past the attack; the shortest
// lag near the best (a period's multiples score as high)
export function estimatePitch(x) {
  const start = Math.min(x.length - 4096, Math.round(0.08 * RATE)), L = 4096;
  if (start < 0) return null;
  const T0 = Math.floor(RATE / 2000), T1 = Math.ceil(RATE / 30);
  const sc = new Float64Array(T1 + 2);
  let best = 0;
  for (let T = T0; T <= T1 + 1; T++) {
    let s = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < L - T; i++) { const u = x[start + i], v = x[start + i + T]; s += u * v; e1 += u * u; e2 += v * v; }
    sc[T] = s / Math.sqrt(e1 * e2 + 1e-12); if (sc[T] > best) best = sc[T];
  }
  for (let T = T0 + 1; T <= T1; T++) {
    if (sc[T] < sc[T - 1] || sc[T] < sc[T + 1] || sc[T] < best * 0.9) continue;
    const d = sc[T - 1] - 2 * sc[T] + sc[T + 1], off = d < 0 ? (0.5 * (sc[T - 1] - sc[T + 1])) / d : 0;
    const hz = RATE / (T + off), m = 69 + 12 * Math.log2(hz / 440), midi = Math.round(m);
    return { hz, midi, cents: Math.round((m - midi) * 100), clarity: best };
  }
  return null;
}

const NOTE_RANGE = [24, 108]; // where a noise's note may go
const FIELDS = { ml: [0, 15], tl: [0, 127], ar: [0, 31], dr: [0, 31], sr: [0, 31], sl: [0, 15], ks: [0, 3] };
const clamp = (v, [a, b]) => Math.max(a, Math.min(b, Math.round(v)));
const clone = (g) => ({ alg: g.alg, fb: g.fb, note: g.note, ops: g.ops.map((o) => ({ ...o })) });
const full = (g) => ({ alg: g.alg, fb: g.fb, ops: g.ops.map((o) => ({ ...o, rr: o.rr ?? 7, dt: 0 })) });

// `noisy`: a sound with no pitch (a hat, a snare). The note the patch plays
// is then searched too (the genome's `note`, starting at `midi`), and the
// spectra are compared by their colour (smoothBands).
export function makeEvaluator(target, midi, cents, noisy = false, notes = [midi]) {
  const dur = target.length / RATE;
  const tf = features(target);
  const ref = noisy ? smoothBands(tf) : tf;
  let evals = 0;
  const evaluate = (g) => {
    evals++;
    const f = features(renderModel(full(g), g.note ?? midi, g.note != null ? 0 : cents, dur, dur));
    return searchDistance(ref, noisy ? smoothBands(f) : f);
  };
  return { evaluate, tf, dur, noisy, notes, count: () => evals };
}

// the loudness contour alone, on one sine carrier: AR, DR, SL, SR by coordinate descent
export function fitEnvelope(ev, midi, cents) {
  const sine = (e) => ({ alg: 7, fb: 0, ops: [0, 1, 2].map(() => ({ ml: 1, tl: 127, ar: 31, dr: 0, sr: 0, sl: 0, ks: 0 })).concat([{ ml: 1, tl: 0, ks: 0, ...e }]) });
  const loudDist = (e) => {
    const f = features(renderModel(full(sine(e)), midi, cents, ev.dur, ev.dur));
    const A = ev.tf, F = Math.min(A.frames, f.frames);
    let sa = 0, sb = 0; for (let i = 0; i < F; i++) { sa += A.loud[i]; sb += f.loud[i]; }
    const g = sb > 0 ? sa / sb : 1, peak = Math.max(...A.loud), floor = peak * 1e-6;
    let d = 0; for (let i = 0; i < F; i++) d += Math.abs(10 * Math.log10((A.loud[i] + floor) / (f.loud[i] * g + floor)));
    return d / F;
  };
  // DR and SL only act together (SL 0 ends the decay at once, DR 0 never
  // reaches SL): a grid over the pair, then AR and SR, then a pass of each
  let e = { ar: 31, dr: 0, sr: 0, sl: 0 }, best = loudDist(e);
  const RATES = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 31], SLS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
  const tryE = (t) => { const d = loudDist(t); if (d < best) { best = d; e = t; } };
  for (const ar of [31, 28, 24, 20, 16, 12]) tryE({ ...e, ar });
  for (const dr of RATES) for (const sl of SLS) tryE({ ...e, dr, sl });
  for (const sr of RATES) tryE({ ...e, sr });
  for (const ar of RATES) tryE({ ...e, ar });
  for (let pass = 0; pass < 2; pass++) for (const k of ["dr", "sl", "sr", "ar"])
    for (const dv of [-2, -1, 1, 2]) tryE({ ...e, [k]: clamp(e[k] + dv, FIELDS[k]) });
  return e;
}

function randomGenome(alg, env, R, ev = {}) {
  const car = CARRIERS[alg];
  const pick = (a) => a[Math.floor(R() * a.length)];
  return {
    alg,
    // a noise needs an operator in chaos: feedback near the top, mostly
    fb: ev.noisy && R() < 0.7 ? 5 + Math.floor(R() * 3) : Math.floor(R() * 8),
    // from one of the starting notes (the spectral centroid's, the one the
    // autocorrelation picked), within an octave either side
    note: ev.noisy ? clamp(ev.notes[Math.floor(R() * ev.notes.length)] + (R() - 0.5) * 24, NOTE_RANGE) : undefined,
    ops: [0, 1, 2, 3].map((k) => {
      const isC = car.includes(k);
      const jit = (v, s, r) => clamp(v + (R() - 0.5) * 2 * s, r);
      return {
        ml: pick([1, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15]),
        tl: isC ? clamp(R() * 12, FIELDS.tl) : clamp(15 + R() * 50, FIELDS.tl),
        ar: isC ? env.ar : jit(env.ar, 6, FIELDS.ar),
        dr: isC ? env.dr : jit(env.dr, 6, FIELDS.dr),
        sr: isC ? env.sr : jit(env.sr, 4, FIELDS.sr),
        sl: isC ? env.sl : jit(env.sl, 3, FIELDS.sl),
        ks: 0,
      };
    }),
  };
}
function mutate(g, R) {
  const c = clone(g);
  const sd = { ml: 1.5, tl: 8, ar: 4, dr: 4, sr: 3, sl: 2, ks: 1 };
  const keys = Object.keys(FIELDS);
  // one field, then each further one with even odds: mostly small moves
  do {
    if (R() < 0.06) { c.fb = clamp(c.fb + (R() < 0.5 ? -1 : 1), [0, 7]); continue; }
    if (c.note != null && R() < 0.08) { c.note = clamp(c.note + (R() < 0.3 ? (R() < 0.5 ? -12 : 12) : Math.round((R() - 0.5) * 8) || 1), NOTE_RANGE); continue; }
    const o = c.ops[Math.floor(R() * 4)], k = keys[Math.floor(R() * keys.length)];
    const step = Math.round((R() - 0.5) * 2 * sd[k]) || (R() < 0.5 ? -1 : 1);
    o[k] = k === "ml" && R() < 0.3 ? Math.floor(R() * 16) : clamp(o[k] + step, FIELDS[k]);
  } while (R() < 0.5);
  return c;
}
function cross(a, b, R) {
  const c = clone(a);
  if (R() < 0.5) c.fb = b.fb;
  if (c.note != null && R() < 0.5) c.note = b.note;
  for (let k = 0; k < 4; k++) if (R() < 0.5) c.ops[k] = { ...b.ops[k] };
  return c;
}
export function evolve(ev, alg, env, budget, R, seedPop = []) {
  const P = 24;
  let pop = seedPop.slice(0, P).map((g) => ({ g, d: g.d ?? ev.evaluate(g) }));
  while (pop.length < P) { const g = randomGenome(alg, env, R, ev); pop.push({ g, d: ev.evaluate(g) }); }
  let spent = P;
  while (spent < budget) {
    pop.sort((x, y) => x.d - y.d);
    const next = pop.slice(0, 3);
    while (next.length < P) {
      const t = () => { let b = pop[Math.floor(R() * P)]; for (let i = 0; i < 2; i++) { const c = pop[Math.floor(R() * P)]; if (c.d < b.d) b = c; } return b.g; };
      const g = mutate(R() < 0.6 ? cross(t(), t(), R) : t(), R);
      next.push({ g, d: ev.evaluate(g) }); spent++;
    }
    pop = next;
  }
  pop.sort((x, y) => x.d - y.d);
  return pop;
}
// local polish: one field at a time, a step either way
export function polish(ev, g, d, passes = 6) {
  const steps = { ml: [1], tl: [4, 1], ar: [2, 1], dr: [2, 1], sr: [2, 1], sl: [1], ks: [1] };
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (const delta of [-1, 1]) {
      const t = clone(g); t.fb = clamp(t.fb + delta, [0, 7]);
      const dt = ev.evaluate(t); if (dt < d) { g = t; d = dt; moved = true; }
    }
    if (g.note != null) for (const delta of [-12, -2, -1, 1, 2, 12]) {
      const t = clone(g); t.note = clamp(t.note + delta, NOTE_RANGE);
      if (t.note === g.note) continue;
      const dt = ev.evaluate(t); if (dt < d) { g = t; d = dt; moved = true; }
    }
    for (let k = 0; k < 4; k++) for (const f of Object.keys(FIELDS)) for (const s of steps[f]) for (const delta of [-s, s]) {
      const t = clone(g); t.ops[k][f] = clamp(t.ops[k][f] + delta, FIELDS[f]);
      if (t.ops[k][f] === g.ops[k][f]) continue;
      const dt = ev.evaluate(t); if (dt < d) { g = t; d = dt; moved = true; }
    }
    if (!moved) break;
  }
  return { g, d };
}

// iterated local search: kick the best a little (two or three fields), polish
// it, keep it when it is better — the way out of a polished local optimum
export function iterate(ev, g, d, budget, R) {
  const stop = ev.count() + budget;
  while (ev.count() < stop) {
    let k = mutate(g, R); k = mutate(k, R);
    const p = polish(ev, k, ev.evaluate(k), 2);
    if (p.d < d) { g = p.g; d = p.d; }
  }
  return { g, d };
}


// ── The stages, on plain data (the page runs them in workers) ──────────────

/** The recording as the search reads it: at the chip's rate, from its onset,
 *  at most maxSec long; its pitch and its loudness contour as an envelope. */
// Below this the sound has no pitch to read: the TR-808's hats, snares, clap
// and cymbals measure 0.13–0.61 (its side stick 0.72), its kick, toms,
// cowbell and claves 0.99–1.0, and plucked and bowed notes 0.9–1.0.
export const NOISY_CLARITY = 0.8;

/** The recording as the search reads it: at the chip's rate, from its onset,
 *  at most maxSec long; its pitch — or, with none (noisy), a note from its
 *  spectral centroid for the search to start from — and its loudness
 *  contour as an envelope. */
export function prepareVoiceTarget(data, sampleRate, maxSec = 0.8) {
  const target = trimNote(resampleTo(data, sampleRate), maxSec);
  if (target.length < RATE * 0.05) throw new Error("the sound is shorter than 50 ms");
  const read = estimatePitch(target);
  const noisy = !read || read.clarity < NOISY_CLARITY;
  let pitch = read;
  if (noisy) {
    const f = features(target);
    let e = 0, c = 0;
    for (let b = 0; b < BANDS; b++) {
      let be = 0; for (let k = 0; k < f.frames; k++) be += f.spec[k * BANDS + b];
      const fc = Math.sqrt(edges[b] * edges[b + 1]); e += be; c += be * Math.log2(fc);
    }
    const hz = 2 ** (c / (e || 1));
    // a noisy operator's energy centres some two octaves above its note
    const centre = Math.max(NOTE_RANGE[0], Math.min(NOTE_RANGE[1], Math.round(69 + 12 * Math.log2(hz / 440)) - 24));
    pitch = { midi: centre, cents: 0, hz, clarity: read?.clarity ?? 0, starts: read ? [centre, read.midi] : [centre] };
  }
  const ev = makeEvaluator(target, pitch.midi, pitch.cents);
  const env = fitEnvelope(ev, pitch.midi, pitch.cents);
  return { target, pitch, env, noisy, read };
}

/** Stage 1: a short genetic search on one algorithm; the population back. */
export function searchAlgorithm({ target, pitch, env, noisy = false, alg, budget = 300, seed = 1 }) {
  const ev = makeEvaluator(target, pitch.midi, pitch.cents, noisy, pitch.starts);
  const pop = evolve(ev, alg, env, budget, rng(seed * 97 + alg));
  return { alg, noisy, pitch, pop, evals: ev.count() };
}

// ── The plan: which searches run, which go on, how they rank ───────────────
// A pitched sound runs the eight algorithms once. A noise runs them twice:
// the noise search (its note searched, its colour compared) and the plain one
// at the note the autocorrelation picked — each wins on some sounds (a snare
// and a clap the first, a closed hat and a crash, often, the second), so both
// go in and their bests are ranked by colour.

/** Stage 1's tasks for a prepared target: the args each searchAlgorithm takes. */
export function searchTasks(prep, opts = {}) {
  const tasks = [0, 1, 2, 3, 4, 5, 6, 7].map((alg) => ({ ...prep, alg, ...opts }));
  if (prep.noisy && prep.read)
    for (let alg = 0; alg < 8; alg++) tasks.push({ ...prep, alg, noisy: false, pitch: prep.read, ...opts });
  return tasks;
}

// How far a result lies from the target, on one scale for all of a run's
// results: a pitched sound's own distance; a noise's colour distance, whichever
// search it came from.
function rankDistance(prep, patch, note, d) {
  if (!prep.noisy) return d;
  const dur = prep.target.length / RATE;
  return searchDistance(smoothBands(features(prep.target)), smoothBands(features(renderModel(full(patch), note.midi, note.cents, dur, dur))));
}

/** Stage 1's results → the `keep` to refine (each a refineAlgorithm's args
 *  less its seed): the nearest on the run's scale, one per algorithm and search. */
export function refineTasks(prep, results, keep = 3, opts = {}) {
  const scored = results.map((r) => {
    const g = r.pop[0].g;
    const note = g.note != null ? { midi: g.note, cents: 0 } : { midi: r.pitch.midi, cents: r.pitch.cents };
    return { r, score: rankDistance(prep, g, note, r.pop[0].d) };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, keep).map(({ r }) => ({ ...prep, alg: r.alg, noisy: r.noisy, pitch: r.pitch, pop: r.pop, ...opts }));
}

/** Stage 2's results, nearest first on the run's scale (`d` becomes that). */
export function rankCandidates(prep, results) {
  return results.map((c) => ({ ...c, d: rankDistance(prep, c.patch, c.note, c.d) })).sort((a, b) => a.d - b.d);
}

/** Stage 2: the longer search from stage 1's population, the polish and the
 *  iterated local search; one patch back. */
export function refineAlgorithm({ target, pitch, env, noisy = false, alg, pop, budget = 1200, ils = 1500, seed = 1 }) {
  const ev = makeEvaluator(target, pitch.midi, pitch.cents, noisy, pitch.starts);
  const R = rng(seed * 131 + alg);
  const next = evolve(ev, alg, env, budget, R, pop.map((x) => Object.assign(clone(x.g), { d: x.d })));
  const p = polish(ev, next[0].g, next[0].d);
  const best = iterate(ev, p.g, p.d, ils, R);
  // the note it plays: the recording's pitch, or (noisy) the one the search found
  const note = best.g.note != null ? { midi: best.g.note, cents: 0 } : { midi: pitch.midi, cents: pitch.cents };
  return { alg, patch: normalizePatch(full(best.g)), d: best.d, note, noisy, evals: ev.count() };
}

/** The loudest carrier at TL 0, the others kept relative to it: the search
 *  matches level, so its TLs only mean anything against each other. */
export function normalizePatch(patch) {
  const car = CARRIERS[patch.alg];
  const top = Math.min(...car.map((k) => patch.ops[k].tl));
  return { ...patch, ops: patch.ops.map((o, k) => (car.includes(k) ? { ...o, tl: o.tl - top } : o)) };
}

/** The register form the page's preview channel takes (applyFmRegsToChannel). */
export function patchToRegs(patch, key = undefined) {
  return {
    algorithm: patch.alg, feedback: patch.fb, ams: 0, fms: 0, key,
    ops: patch.ops.map((o) => ({
      tl: o.tl, voicedTl: o.tl, ar: o.ar, dr: o.dr, sl: o.sl, d2r: o.sr, rr: o.rr ?? 7,
      mul: o.ml, dt: 0, rs: o.ks, ssg: 0, amen: 0, velK: -1,
    })),
  };
}

/** A def-fm for the patch, named after the file; a comment says what it was
 *  read from. `key`: the note goes into the voice as `:key` (a noise, as
 *  presets/fm-drums do), so c4 plays it as found. */
export function patchToDef(patch, name, pitch, fileName, key = false) {
  let id = String(name).toLowerCase().replace(/\.[^.]*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "voice";
  // a name the score would read as a note or a length (`a`, `c4`, `8`) gets a prefix
  if (/^\d/.test(id) || /^[a-g][+-]?\d*$/.test(id) || /^[ov][+-]?\d*$/.test(id)) id = `fm-${id}`;
  const NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
  const note = `${NAMES[((pitch.midi % 12) + 12) % 12]}${Math.floor(pitch.midi / 12) - 1}`;
  const op = (o, k) => `  :ar${k} ${o.ar} :dr${k} ${o.dr} :sr${k} ${o.sr} :rr${k} ${o.rr ?? 7} :sl${k} ${o.sl} :tl${k} ${o.tl} :ks${k} ${o.ks} :ml${k} ${o.ml} :dt${k} 0`;
  const head = key
    ? `; ${fileName}: an FM voice estimated from the recording — no pitch, a noise; it sounds as found at ${note} (:key), so c4 plays it\n`
    : `; ${fileName}: an FM voice estimated from the recording, read at ${note}${pitch.cents ? ` ${pitch.cents > 0 ? "+" : ""}${pitch.cents}¢` : ""}\n`;
  return head + `(def-fm ${id} :alg ${patch.alg} :fb ${patch.fb} :ams 0 :fms 0${key ? ` :key ${pitch.midi}` : ""}\n${patch.ops.map((o, i) => op(o, i + 1)).join("\n")})`;
}

/** The whole search in one thread (node, tests): stage 1 on every algorithm,
 *  stage 2 on the best `keep`. */
export function estimateVoice(data, sampleRate, { keep = 3, seed = 1, stage1 = 300, stage2 = 1200, ils = 1500 } = {}) {
  const prep = prepareVoiceTarget(data, sampleRate);
  const s1 = searchTasks(prep, { seed, budget: stage1 }).map(searchAlgorithm);
  const s2 = refineTasks(prep, s1, keep, { seed, budget: stage2, ils }).map(refineAlgorithm);
  return { ...prep, candidates: rankCandidates(prep, s2) };
}
