// A song of written times (a VGM's, an NSF's) read against a beat given by
// hand. Nothing here guesses the pulse: where the beat falls and how fast it
// goes come from the user's taps, which fix what an estimate gets wrong (double
// or half the tempo, which onsets are on the beat); the song's onsets then give
// the taps the accuracy a hand has not got.
//
//   tapBeat(taps)                  → {beat, origin}, in samples
//   fitBeat(channels, {beat, origin}) → the same on the onsets, and how they fit
//   shuffleOf(onsets, timing, first) → a pair's first share, where they swing
//   beatClock(timing, first)       → a time → the score's tick
//   timingLine(timing) / timingOfLine(text): the settings as a score's comment
//
// A timing: {beat: samples, origin: the sample of a beat (of a bar's first, with
// `bar`), grid: the step in ticks, snap: frames an onset may be off the grid and
// still land on it, bar: beats to a bar (0: no bar lines), shuffle: 1–99, a list
// of weights or null, gate: frames each note is cut by (0: none)}.

import { PPQN, RATE, lenToken } from "./import-song.js";

const FRAME = RATE / 60;

/** The onsets, sorted, those within 15 ms one (a chord, however loosely struck). */
export function mergeOnsets(onsets) {
  const merged = [];
  for (const t of [...onsets].sort((a, b) => a - b)) if (!merged.length || t - merged[merged.length - 1] > RATE * 0.015) merged.push(t);
  return merged;
}

/** The beat a run of taps keeps: a missed tap is two beats, not a slower one. */
export function tapBeat(taps) {
  if (taps.length < 2) return null;
  const gaps = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
  let beat = gaps[gaps.length >> 1];
  const place = taps.map((t) => Math.round((t - taps[0]) / beat));
  const n = taps.length;
  const mk = place.reduce((s, k) => s + k, 0) / n, mt = taps.reduce((s, t) => s + t, 0) / n;
  const den = place.reduce((s, k) => s + (k - mk) ** 2, 0);
  if (den > 0) beat = place.reduce((s, k, i) => s + (k - mk) * (taps[i] - mt), 0) / den;
  // The first tap's beat: it says where the song's beats, and its bars, start.
  return { beat, origin: mt - mk * beat };
}

// How strongly the onsets keep a period: at it, its half and its quarter, so
// that neither a song of off-beats nor one of sixteenths reads as none.
function keep(onsets, u) {
  let s = 0;
  for (const h of [1, 2, 4]) {
    let x = 0, y = 0;
    for (const t of onsets) { const a = (2 * Math.PI * h * t) / u; x += Math.cos(a); y += Math.sin(a); }
    s += Math.hypot(x, y) / onsets.length;
  }
  return s / 3;
}
// Each channel on its own, by its onsets: a part a driver delays (Cybernate-Q
// and its like) keeps the period as well as the rest, only elsewhere in it.
function keepAll(channels, u) {
  let s = 0, n = 0;
  for (const c of channels) { s += keep(c, u) * c.length; n += c.length; }
  return n ? s / n : 0;
}

/**
 * The taps' beat, held to the onsets (`channels`: the onsets of each channel):
 * looked for close to what was tapped, over a span doubling out from `mid`,
 * so the taps' reading of the tempo is never swapped for its double or half.
 * Where the song stops keeping that beat (a tempo change) the span stops,
 * `held` saying how many seconds it covers; where no period stands out the
 * taps are left as they are (`kept`). `fit` is the share of the onsets held
 * that are a frame or less off the sixteenth grid.
 */
export function fitBeat(channels, { beat, origin }, { mid = origin } = {}) {
  const song = channels.map(mergeOnsets).filter((c) => c.length > 1);
  const total = song.reduce((s, c) => s + c.length, 0);
  let u = beat, best = 0, held = 0, window = song, kept = true, range = 0.04;
  for (let span = RATE * 8; ; span *= 2) {
    const near = song.map((c) => c.filter((t) => Math.abs(t - mid) <= span)).filter((c) => c.length > 1);
    const count = near.reduce((s, c) => s + c.length, 0);
    if (count >= 8) {
      const scores = [];
      for (let j = -20; j <= 20; j++) { const c = u * (1 + (range * j) / 20); scores.push([keepAll(near, c), c]); }
      const [top, topU] = scores.reduce((p, q) => (q[0] > p[0] ? q : p));
      const typical = scores.map(([f]) => f).sort((a, b) => a - b)[20];
      if (top < best * 0.7 || (kept && top < typical * 1.5)) break;
      best = Math.max(best, top);
      u = topU;
      window = near;
      kept = false;
      range /= 2; // (closer in, once a search has been made)
      held = (Math.max(...near.map((c) => c[c.length - 1])) - Math.min(...near.map((c) => c[0]))) / RATE;
    }
    if (count === total) break;
  }
  if (kept) return { beat, origin, fit: 0, held: 0, kept };
  // The tapped beat on the corrected period, moved to where most onsets sit
  // around it — within half a sixteenth, so a tap keeps the beat it fell on.
  const step = u / 4;
  const off = window.flat().map((t) => { const d = (((t - origin) % step) + step) % step; return d > step / 2 ? d - step : d; });
  const place = (x) => off.filter((d) => { const e = Math.abs(d - x); return Math.min(e, step - e) <= FRAME / 2; }).length;
  let at = 0, most = -1;
  for (let x = -step / 2; x < step / 2; x += FRAME / 4) { const k = place(x); if (k > most) { most = k; at = x; } }
  const on = off.filter((d) => { const e = Math.abs(d - at); return Math.min(e, step - e) <= FRAME; }).length;
  return { beat: u, origin: origin + at, fit: off.length ? on / off.length : 0, held, kept };
}

/**
 * A pair's first share where the onsets swing on the timing's grid: the middle
 * of those between a pair's edges. Null where too few are, they are straight,
 * or the share does not bring more of them onto the grid.
 */
export function shuffleOf(onsets, timing, first = 0) {
  const c = beatClock({ ...timing, shuffle: null, snap: 0 }, first);
  const pair = timing.grid * 2 * c.tickLen;
  const on = mergeOnsets(onsets).map((t) => (((t - c.zero) % pair) + pair) % pair / pair);
  const inner = on.filter((p) => p > 0.25 && p < 0.85).sort((a, b) => a - b);
  if (inner.length < 8 || inner.length < on.length * 0.1) return null;
  const r = Math.round(inner[inner.length >> 1] * 100);
  if (Math.abs(r - 50) < 4) return null;
  // A share is only a swing if it puts more of them on the grid.
  const onGrid = (shuffle) => {
    const k = beatClock({ ...timing, shuffle, snap: 1 }, first);
    return onsets.filter((t) => k.tickOf(t) % timing.grid === 0).length;
  };
  return onGrid(r) > onGrid(null) * 1.05 ? r : null;
}

// `:shuffle`'s warp of the timeline: a step's ticks, straight → as played, and
// back (language.md §5.2). Identity with no shuffle.
export function warpOf(shuffle, base) {
  if (shuffle == null) return { warp: (x) => x, unwarp: (x) => x };
  const w = Array.isArray(shuffle) ? shuffle : [shuffle, 100 - shuffle];
  const n = w.length, sum = w.reduce((s, v) => s + v, 0);
  const share = w.map((v) => (v * n) / sum);
  const at = [0];
  for (const s of share) at.push(at[at.length - 1] + s);
  const cycle = n * base;
  const warp = (x) => {
    const q = Math.floor(x / cycle), r = x - q * cycle;
    const i = Math.min(n - 1, Math.floor(r / base));
    return q * cycle + (at[i] + (r / base - i) * share[i]) * base;
  };
  const unwarp = (x) => {
    const q = Math.floor(x / cycle), r = (x - q * cycle) / base;
    let i = 0;
    while (i < n - 1 && at[i + 1] <= r) i++;
    return q * cycle + (i + (r - at[i]) / share[i]) * base;
  };
  return { warp, unwarp };
}

/**
 * A time in samples → the score's tick. The score starts on the beat (the bar,
 * with bar lines) of the song's first onset `first`, so a silent lead-in is not
 * written and a pickup is the end of its bar. An onset within `snap` frames of
 * the grid lands on it: that much is the driver's frame, not the music. One
 * further off stays where it is, to the tick — a groove is not corrected.
 */
export function beatClock(timing, first = 0) {
  const { beat, origin, grid = PPQN / 4, snap = 1, bar = 0, shuffle = null } = timing;
  // To three places, as the score's :tempo says it.
  const bpm = +((60 * RATE) / beat).toFixed(3);
  const tickLen = (60 * RATE) / (bpm * PPQN);
  const tol = snap * FRAME;
  const span = (bar || 1) * beat;
  const zero = origin + Math.floor((first - origin + tol) / span) * span;
  const { warp, unwarp } = warpOf(shuffle, grid);
  const tickOf = (t) => {
    const x = unwarp((t - zero) / tickLen);
    if (x <= 0) return 0;
    const on = Math.round(x / grid) * grid;
    return Math.abs(zero + warp(on) * tickLen - t) <= tol ? on : Math.round(x);
  };
  return { tickOf, tickLen, bpm, zero, grid, bar };
}

/** A shuffle as text: `none`, a share, or a list of weights. */
export function shuffleText(s) {
  return s == null ? "none" : Array.isArray(s) ? `[${s.join(" ")}]` : String(s);
}
/** The shuffle some text says, or null: none, a straight 50, or nothing a `:shuffle` takes. */
export function shuffleOfText(text) {
  const v = text.trim();
  const list = /^\[([\d\s]+)\]$/.exec(v);
  if (list) { const w = list[1].trim().split(/\s+/).map(Number); return w.length > 1 && w.every((x) => x > 0) ? w : null; }
  const r = Number(v);
  return r >= 1 && r <= 99 && r !== 50 ? Math.round(r) : null;
}

/** The tokens a track of this timing opens with. */
export function shuffleTokens({ shuffle, grid = PPQN / 4 }) {
  return shuffle == null ? [] : [`:shuffle-base ${lenToken(grid)}`, `:shuffle ${shuffleText(shuffle)}`];
}

/** The settings, as the score's comment: all that a later adjustment starts from. */
export function timingLine(t, bpm) {
  return `; Timing: ${bpm} BPM from ${(t.origin / RATE).toFixed(4)} s, grid ${t.grid}t, snap ${t.snap}f, bar ${t.bar}, shuffle ${shuffleText(t.shuffle)}, gate ${t.gate}f`;
}

/** The timing a score's comment says, or null. */
export function timingOfLine(text) {
  const m = /^; Timing: ([\d.]+) BPM from ([\d.-]+) s, grid (\d+)t, snap ([\d.]+)f, bar (\d+), shuffle (none|\d+|\[[\d ]+\]), gate ([\d.]+)f$/m.exec(text);
  if (!m) return null;
  return { beat: (60 * RATE) / Number(m[1]), origin: Number(m[2]) * RATE, grid: Number(m[3]), snap: Number(m[4]), bar: Number(m[5]), shuffle: shuffleOfText(m[6]), gate: Number(m[7]) };
}
