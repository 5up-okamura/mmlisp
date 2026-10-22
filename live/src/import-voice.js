/**
 * A WAV as a voice: formant tracks for FM3 (language.md §15).
 *
 * The recording is read as speech: every 60 Hz frame gets a loudness (its
 * RMS), a voicing (autocorrelation), a pitch and an LPC envelope, and the
 * envelope's peaks are followed through the frames as four formants. Each
 * formant becomes one `fm3-N` track — a note per phrase under a def holding
 * its `:pitch` table (cents, one a frame) and its `:vol` table; under CSM the
 * tables hold the vowel (`#sus`) and carry the tail (`#rel`) and the note is
 * gated at the vowel — and the frames that hiss rather than buzz become
 * bursts on the `noise` track. Two syntheses share that analysis:
 *
 * - `csm`: CSM with formant tracks — a note-less `(fm3-csm voice)`, the four
 *   operators as formants, and an `fm3-csm-rate` track that is the voice: its
 *   rate the recording's pitch per phrase (or one given), its rest the breath.
 *   The buzz through the formants is a vocoder's voice.
 * - `sine`: the four operators as sine waves on the formant tracks (alg 7,
 *   independent-operator mode) — sine-wave speech, a whistled voice with no
 *   pitch of its own.
 *
 * At 150 BPM one frame is four ticks, so every table lands on the frame it
 * was measured in and the tracks come out the same length.
 */

const FPS = 60;
export const VOICE_RATE = 8000; // formants live below 4 kHz; the analysis runs here
const BPM = 150; // one 60 Hz frame = 4 ticks
const NOMINAL = [550, 1500, 2500, 3400]; // where the four formants start out
const F_LOW = 150, F_HIGH = 3900; // the band a formant may sit in
const LPC_ORDER = 12;

// ── Analysis ───────────────────────────────────────────────────────────────

/**
 * @param {Float32Array} data mono samples
 * @param {number} sampleRate their rate
 * @returns {{ rate, duration, frames, tracks, segments, unvoiced, active, rmsDb, peakRms, pitchHz }}
 */
export function analyzeVoice(data, sampleRate) {
  const x = highPass(resample(data, sampleRate, VOICE_RATE), VOICE_RATE, 100);
  const rate = VOICE_RATE;
  const frames = analyzeFrames(x, rate);
  const n = frames.length;
  const dB = (v) => 20 * Math.log10(v + 1e-12);
  const rmsDb = frames.map((q) => dB(q.rms));
  const peakRms = n ? Math.max(...rmsDb) : -120;
  const active = rmsDb.map((d) => d > peakRms - 32);
  const unvoiced = frames.map((q, i) => active[i] && q.zcr > 0.22 && q.voicing < 0.6);
  const tracks = trackFormants(frames, rate);
  // phrases: runs of active frames, gaps shorter than three frames bridged
  const segments = [];
  for (let i = 0; i < n; ) {
    if (!active[i]) { i++; continue; }
    let j = i;
    while (j < n && (active[j] || (j + 3 < n && active.slice(j, j + 3).some(Boolean)))) j++;
    if (j - i >= 3) segments.push([i, j]);
    i = j;
  }
  const f0s = frames.filter((q, i) => active[i] && !unvoiced[i] && q.f0 >= 60 && q.f0 <= 400).map((q) => q.f0);
  return {
    rate, duration: data.length / sampleRate, frames, tracks, segments, unvoiced, active, rmsDb, peakRms,
    pitchHz: f0s.length ? median(f0s) : 0,
  };
}

function median(a) {
  const s = Array.from(a).sort((p, q) => p - q);
  return s[s.length >> 1];
}

// Linear resampling behind a box low-pass wide enough for the step down —
// enough for an envelope analysis (not for a sample bank: export-mmb's is).
function resample(data, from, to) {
  if (from === to) return Float32Array.from(data);
  const ratio = from / to;
  let src = data;
  if (ratio > 1) {
    const w = Math.max(1, Math.round(ratio));
    const acc = new Float64Array(data.length + 1);
    for (let i = 0; i < data.length; i++) acc[i + 1] = acc[i] + data[i];
    src = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const a = Math.max(0, i - (w >> 1)), b = Math.min(data.length, a + w);
      src[i] = (acc[b] - acc[a]) / (b - a);
    }
  }
  const n = Math.floor(data.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, k = Math.floor(p), t = p - k;
    out[i] = src[k] * (1 - t) + (src[Math.min(k + 1, src.length - 1)] ?? 0) * t;
  }
  return out;
}

// Two-pole Butterworth high-pass: a recording's hum or DC would be read as a
// formant.
function highPass(x, rate, fc) {
  const w0 = (2 * Math.PI * fc) / rate, al = Math.sin(w0) / (2 * Math.SQRT1_2), cs = Math.cos(w0);
  const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = b0, a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i], y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0; y[i] = y0;
  }
  return y;
}

// Levinson-Durbin: the all-pole model of one windowed, pre-emphasised frame.
function lpc(seg, order) {
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) { let s = 0; for (let i = k; i < seg.length; i++) s += seg[i] * seg[i - k]; r[k] = s; }
  r[0] *= 1 + 1e-9;
  if (r[0] <= 0) return null;
  let a = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e, na = a.slice();
    for (let j = 1; j < i; j++) na[j] = a[j] + k * a[i - j];
    na[i] = k;
    a = na;
    e *= 1 - k * k;
  }
  return { a, e };
}

// |H(f)| of the LPC model, pre-emphasis undone.
function lpcEnvelope(a, gain, rate) {
  return (f) => {
    const w = (2 * Math.PI * f) / rate;
    let pr = 0, pi = 0;
    for (let k = 0; k < a.length; k++) { pr += a[k] * Math.cos(w * k); pi -= a[k] * Math.sin(w * k); }
    const pre = Math.hypot(1 - 0.97 * Math.cos(w), 0.97 * Math.sin(w));
    return Math.sqrt(gain) / Math.hypot(pr, pi) / pre;
  };
}

function analyzeFrames(x, rate) {
  const hop = rate / FPS, N = Math.round(0.032 * rate), L = Math.round(0.05 * rate);
  const ham = Float64Array.from({ length: N }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const at = (j) => (j >= 0 && j < x.length ? x[j] : 0);
  const frames = [];
  for (let f = 0; ; f++) {
    const c = Math.round(f * hop);
    if (c >= x.length) break;
    const s0 = c - (N >> 1);
    let rms = 0, zc = 0, prev = 0;
    const seg = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const v = at(s0 + i);
      rms += v * v;
      if (i && v >= 0 !== prev >= 0) zc++;
      seg[i] = (v - 0.97 * prev) * ham[i];
      prev = v;
    }
    rms = Math.sqrt(rms / N);
    // pitch and voicing: the normalised autocorrelation over 60–500 Hz. Its
    // peaks are read between the samples (a parabola through each), and the
    // shortest one within a hair of the best is the period: a period's
    // multiples score as high as the period itself (the octave error).
    let best = 0, period = 0;
    const p0 = c - (L >> 1), T0 = Math.floor(rate / 500), T1 = Math.ceil(rate / 60);
    const score = new Float64Array(T1 + 2);
    for (let T = T0; T <= T1 + 1; T++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + T < L; i++) { const u = at(p0 + i), v = at(p0 + i + T); s += u * v; e1 += u * u; e2 += v * v; }
      score[T] = s / Math.sqrt(e1 * e2 + 1e-12);
    }
    const peaks = [];
    for (let T = T0 + 1; T <= T1; T++) {
      const y0 = score[T - 1], y1 = score[T], y2 = score[T + 1];
      if (y1 < y0 || y1 < y2) continue;
      const d = y0 - 2 * y1 + y2, off = d < 0 ? (0.5 * (y0 - y2)) / d : 0;
      peaks.push([T + off, y1 - 0.25 * (y0 - y2) * off]);
      if (peaks[peaks.length - 1][1] > best) best = peaks[peaks.length - 1][1];
    }
    for (const [T, v] of peaks) if (v >= best * 0.93) { period = T; break; }
    const fr = { rms, zcr: zc / N, voicing: best, f0: period ? rate / period : 0, env: null };
    const m = rms > 1e-4 ? lpc(seg, LPC_ORDER) : null;
    if (m) fr.env = lpcEnvelope(m.a, m.e / N, rate);
    frames.push(fr);
  }
  return frames;
}

// The LPC envelope's peaks, assigned to four slots frame by frame — the
// ordered assignment that moves each slot least from where it was (a peak
// or a slot may be skipped at a cost) — then median-smoothed.
function trackFormants(frames, rate) {
  const grid = [];
  for (let f = F_LOW; f <= F_HIGH; f += 10) grid.push(f);
  const prev = NOMINAL.slice();
  const tracks = [[], [], [], []];
  const dB = (v) => 20 * Math.log10(v + 1e-12);
  for (const q of frames) {
    const E = (f) => (q.env ? q.env(f) : 0);
    const ev = grid.map(E), cands = [];
    for (let k = 1; k < grid.length - 1; k++) if (ev[k] > ev[k - 1] && ev[k] >= ev[k + 1]) cands.push(grid[k]);
    const C = cands.length, SKIP_C = 0.5, SKIP_S = 0.6;
    const cost = (i, s) => Math.abs(Math.log2(cands[i] / prev[s]));
    const best = Array.from({ length: C + 1 }, () => new Array(5).fill(Infinity));
    const how = Array.from({ length: C + 1 }, () => new Array(5));
    best[0][0] = 0;
    for (let i = 0; i <= C; i++) for (let s = 0; s <= 4; s++) {
      const v = best[i][s];
      if (v === Infinity) continue;
      if (i < C && v + SKIP_C < best[i + 1][s]) { best[i + 1][s] = v + SKIP_C; how[i + 1][s] = "c"; }
      if (s < 4 && v + SKIP_S < best[i][s + 1]) { best[i][s + 1] = v + SKIP_S; how[i][s + 1] = "s"; }
      if (i < C && s < 4 && v + cost(i, s) < best[i + 1][s + 1]) { best[i + 1][s + 1] = v + cost(i, s); how[i + 1][s + 1] = "m"; }
    }
    const slot = [null, null, null, null];
    for (let i = C, s = 4; i > 0 || s > 0; ) {
      const h = how[i][s];
      if (h === "m") { slot[s - 1] = cands[i - 1]; i--; s--; } else if (h === "c") i--; else s--;
    }
    for (let s = 0; s < 4; s++) {
      const f = slot[s] ?? prev[s];
      tracks[s].push({ f, db: dB(E(f)) });
      prev[s] = f;
    }
  }
  for (const t of tracks) {
    const f = t.map((p) => p.f);
    for (let i = 1; i < t.length - 1; i++) t[i].f = [f[i - 1], f[i], f[i + 1]].sort((a, b) => a - b)[1];
  }
  return tracks;
}

// ── Options and the score ──────────────────────────────────────────────────

export const VOICE_MODES = [["csm", "CSM — the buzz through the formants (a vocoder's voice)"], ["sine", "sine waves on the formants (sine-wave speech)"]];
// Each ring's decay: how a formant is heard. Held, the operator is a sine
// wave whose phase Timer A resets every period — the loudest, a synthesizer's
// voice; a decay makes the ring shorter and the formant wider, towards speech.
export const VOICE_WIDTHS = [
  ["held", "held (RR 0) — the loudest; a synthesizer's voice"],
  ["ringing", "ringing (RR 12, KS 1) — fuller, the high formants stay"],
  ["wide", "wide (RR 15, KS 3) — a short ring, closer to speech"],
];
const WIDTH_ENV = { held: [0, 0], ringing: [12, 1], wide: [15, 3] };
// The noise track against the formants at each width (the voice's own level
// falls as the rings shorten): what keeps a recording's hiss-to-voice balance.
const WIDTH_NOISE_DB = { held: 0, ringing: -8, wide: -10 };

export function defaultVoiceOptions(a, width = "held") {
  return { mode: "csm", pitchHz: 0, width, noiseDb: WIDTH_NOISE_DB[width] ?? 0, comp: 0.6, start: 0, end: +a.duration.toFixed(2), tempo: true };
}

/**
 * @param {ReturnType<typeof analyzeVoice>} a
 * @param {{ mode, pitchHz, width, noiseDb, comp, start, end, tempo }} opts  tempo: write
 *        `:tempo 150`, where a frame is four ticks (false when the voice joins a
 *        score that has its own tempo: the frames then round to its ticks, the
 *        same way on every track)
 * @returns {{ source: string, warnings: string[] }}
 */
export function voiceToMmlisp(a, opts, fileName = "voice.wav") {
  const o = { ...defaultVoiceOptions(a), ...opts };
  const warnings = [];
  const csm = o.mode === "csm";
  const f0 = Math.floor(Math.max(0, o.start) * FPS);
  const f1 = Math.min(a.frames.length, Math.ceil(Math.max(o.start, o.end) * FPS));
  const n = f1 - f0;
  const segs = a.segments.map(([s, e]) => [Math.max(s, f0) - f0, Math.min(e, f1) - f0]).filter(([s, e]) => e - s >= 3);
  if (!segs.length) warnings.push("nothing loud enough to be a voice in the range chosen");
  const idx = (i) => f0 + i; // a frame index of the range → the analysis's
  const FLOOR_DB = -24;
  const loud = (i) => o.comp * (a.rmsDb[idx(i)] - a.peakRms);
  const toVol = (d) => Math.max(0, Math.min(31, Math.round(31 + d / 2)));
  const opDb = (s, i) => {
    const top = Math.max(...a.tracks.map((t) => t[idx(i)].db));
    return loud(i) + Math.max(FLOOR_DB, a.tracks[s][idx(i)].db - top);
  };
  const sounding = (i) => a.active[idx(i)] && !a.unvoiced[idx(i)];
  const NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
  const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
  const wrap = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += 24) out.push(arr.slice(i, i + 24).join(" "));
    return out.join("\n      ");
  };
  const rest = (k) => `_${k}f`;

  // Each phrase's tables are defs — `pK-fN` a formant's, `pK-n` the noise's —
  // so a track reads as rhythm (`p1-f1 :gate 29f c+29f _19f p2-f1 …`), a
  // phrase can be played again, and the note's length is free: the gate is
  // the phrase's own length, so a longer note sounds the same and a shorter
  // one cuts it.
  const defs = [];
  // The phrase's vowel: its loudest voiced frame.
  const vowelFrame = (p, q) => {
    let best = p, db = -Infinity;
    for (let i = p; i < q; i++) if (sounding(i) && a.rmsDb[idx(i)] > db) { db = a.rmsDb[idx(i)]; best = i; }
    return best;
  };
  const formantLine = (s) => {
    const t = a.tracks[s], parts = [];
    let at = 0;
    segs.forEach(([p, q], k) => {
      if (p > at) parts.push(rest(p - at));
      const fs = []; for (let i = p; i < q; i++) fs.push(t[idx(i)].f);
      const m = Math.round(midiOf(median(fs)));
      const base = 440 * 2 ** ((m - 69) / 12);
      const cents = fs.map((f) => Math.round(1200 * Math.log2(f / base)));
      const vols = []; for (let i = p; i < q; i++) vols.push(sounding(i) ? toVol(opDb(s, i)) : 0);
      // Under CSM the phrase holds its vowel: the loudest frame is the sustain
      // (`#sus`), what follows the release (`#rel`), and the note is gated
      // there — a longer note and gate hold the vowel, the tail follows.
      const c = csm ? vowelFrame(p, q) - p : -1;
      const mark = (arr) => (c < 0 ? arr : [...arr.slice(0, c), "#sus", arr[c], ...(c + 1 < arr.length ? ["#rel", ...arr.slice(c + 1)] : [])]);
      defs.push({ k, name: `p${k + 1}-f${s + 1}`, body: `(macro :pitch [${wrap(mark(cents))}]\n    :vol [${wrap(mark(vols))}])` });
      parts.push(`p${k + 1}-f${s + 1} :gate ${c < 0 ? q - p : c + 1}f :oct ${Math.floor(m / 12) - 1} ${NAMES[m % 12]}${q - p}f`);
      at = q;
    });
    if (n > at) parts.push(rest(n - at));
    return `(fm3-${s + 1}\n    ${parts.join("\n    ")})`;
  };
  const noiseLine = () => {
    const parts = [];
    let at = 0;
    segs.forEach(([p, q], k) => {
      if (p > at) parts.push(rest(p - at));
      const vols = []; for (let i = p; i < q; i++) vols.push(a.unvoiced[idx(i)] ? toVol(loud(i) + o.noiseDb) : 0);
      if (vols.some((v) => v > 0)) {
        defs.push({ k, name: `p${k + 1}-n`, body: `(macro :vol [${wrap(vols)}])` });
        parts.push(`p${k + 1}-n :gate ${q - p}f c${q - p}f`);
      } else parts.push(rest(q - p));
      at = q;
    });
    if (n > at) parts.push(rest(n - at));
    return `(noise\n    ${parts.join("\n    ")})`;
  };
  // the voice: one rate per voiced run (its median pitch, or the one given),
  // a rest per unvoiced run — the buzz rests there and the noise speaks
  const rateLine = () => {
    const parts = [];
    let at = 0;
    for (const [p, q] of segs) {
      if (p > at) parts.push(rest(p - at));
      for (let i = p; i < q; ) {
        const voiced = !a.unvoiced[idx(i)];
        let j = i;
        while (j < q && !a.unvoiced[idx(j)] === voiced) j++;
        if (!voiced) parts.push(rest(j - i));
        else {
          const f0s = [];
          for (let k = i; k < j; k++) { const f = a.frames[idx(k)].f0; if (f >= 60 && f <= 400) f0s.push(f); }
          const hz = o.pitchHz > 0 ? o.pitchHz : f0s.length ? median(f0s) : a.pitchHz || 110;
          parts.push(`:len ${j - i}f ${Math.round(hz)}`);
        }
        i = j;
      }
      at = q;
    }
    if (n > at) parts.push(rest(n - at));
    return `(fm3-csm-rate${o.tempo ? ` :tempo ${BPM}` : ""}\n    ${parts.join("\n    ")})`;
  };

  const [rr, ks] = WIDTH_ENV[o.width] ?? WIDTH_ENV.held;
  const ops = [1, 2, 3, 4]
    .map((k) => `:ar${k} 31 :dr${k} 0 :sr${k} 0 :rr${k} ${csm ? rr : 15} :sl${k} 0 :tl${k} 0 :ks${k} ${csm ? ks : 0} :ml${k} 1 :dt${k} 0`)
    .join("\n  ");
  const name = fileName.replace(/\.[^.]*$/, "");
  const head = csm
    ? `; ${name}: CSM with formant tracks (language.md §15). Each fm3-N follows one\n; formant of the recording — its frequency as a :pitch table, its level as a\n; :vol table, one value a frame — the fm3-csm-rate track is the voice (its\n; rates the pitch, its rests the breaths), and the noise track the consonants.`
    : `; ${name}: sine-wave speech. Each fm3-N is a sine wave on one formant of the\n; recording — its frequency as a :pitch table, its level as a :vol table, one\n; value a frame — and the noise track the consonants.`;
  const tracks = [0, 1, 2, 3].map(formantLine).join("\n") + "\n" + (csm ? rateLine() + "\n" : "") + noiseLine() + "\n";
  const defBlock = segs.map(([p, q], k) =>
    `; phrase ${k + 1}: ${((p + f0) / FPS).toFixed(2)}–${((q + f0) / FPS).toFixed(2)} s\n` +
    defs.filter((d) => d.k === k).map((d) => `(def ${d.name} ${d.body})`).join("\n")).join("\n\n");
  const source =
    `${head}\n` +
    `(def-fm formant :alg 7 :fb 0 :ams 0 :fms 0\n  ${ops})\n\n` +
    (defBlock ? defBlock + "\n\n" : "") +
    (csm ? `(fm3-csm formant)\n` : `(fm3${o.tempo ? ` :tempo ${BPM}` : ""} formant)\n`) +
    tracks;
  return { source, warnings };
}
