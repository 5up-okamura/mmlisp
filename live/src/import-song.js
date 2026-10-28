// ---------------------------------------------------------------------------
// Song importers' shared back end: a timed note list → MMLisp source text
//
// MIDI, VGM and the trackers (DMF, FUR) each read their file into the same
// small model — per track, notes at MMLisp ticks (quarter = 96), already
// monophonic — and this writes it out the one way: one form per channel,
// one bar a line, `|` at each bar's end, a note crossing a bar split with a
// tie, `:oct` / `>` `<` for the octave, the track's most common length as
// its `:len`, and the song loop as `#top … (go top)`.
//
// A tracker's patterns can come in as phrases: `track.phrases` is a list of
// {name, notes, len} laid out in order, each written once as a `(def …)` and
// then named in the track (see emitPhrased).
// ---------------------------------------------------------------------------

import { targetProfile } from "./targets.js";

export const PPQN = 96; // must match mmlisp2ir.js
/** The time base estimateGrid works in: onsets in samples at this rate. */
export const RATE = 44100;
const WHOLE = PPQN * 4;

const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

/** A MIDI note's octave in MMLisp terms (`:oct 4` holds MIDI 60). */
export const octOf = (midi) => Math.floor(midi / 12) - 1;
export const noteName = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12];

/** A length in ticks as written after a note: `4`, `8.`, `3/2`, or `Nt`. */
export function lenToken(d) {
  if (d <= 0) return "0";
  // Denominators up to a 64th read as notes; finer is clearer in ticks.
  if (WHOLE % d === 0 && WHOLE / d <= 64) return String(WHOLE / d);
  if ((d * 2) % 3 === 0 && WHOLE % ((d * 2) / 3) === 0 && WHOLE / ((d * 2) / 3) <= 64) return `${WHOLE / ((d * 2) / 3)}.`;
  const g = gcd(d, WHOLE);
  if (WHOLE / g <= 64 && d / g <= 16) return `${d / g}/${WHOLE / g}`;
  return `${d}t`;
}

export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

// The destinations an import's dialog offers, in channel order.
// The channels a target offers an import's lanes, by kind (targets/): its FM
// channels (one name per voice — fm3's operator and CSM tracks are views of
// fm3), its tones, its noise and its sample voices.
export function destsFor(target) {
  const seen = new Set();
  const plain = (h) => { const k = target.voiceKey(h); if (seen.has(k)) return false; seen.add(k); return true; };
  return {
    fm: target.channelNames.filter((h) => target.partOf(h).kind === "fm" && plain(h)),
    psg: target.channelNames.filter((h) => target.partOf(h).kind === "tone"),
    noise: target.channelNames.find((h) => target.partOf(h).kind === "noise") ?? null,
    pcm: target.channelNames.filter((h) => target.partOf(h).kind === "sample"),
    wave: target.channelNames.filter((h) => target.partOf(h).kind === "wave"),
    // Every noise channel: the PC Engine's two (noise5, noise6).
    noises: target.channelNames.filter((h) => target.partOf(h).kind === "noise"),
  };
}
const MD = destsFor(targetProfile("md"));
export const FM_DESTS = MD.fm;
export const PSG_DESTS = MD.psg;
export const PCM_DESTS = MD.pcm;

/** A track of shots — PCM, the ROM rhythm — whose hits play out whatever their length. */
const shots = (channel) => /^(pcm|rhythm)/.test(channel);

/** The first of the sorted `list` above `x` (`list.find((v) => v > x)`). */
function firstAbove(list, x) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] > x) hi = mid; else lo = mid + 1; }
  return list[lo];
}

/** A string as an MMLisp string literal. */
export const qstr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Bar end ticks up to `endTick` from time-signature changes [{tick, num, den}]. */
export function barEnds(timeSigs, endTick) {
  const sigs = (timeSigs?.length ? timeSigs : [{ tick: 0, num: 4, den: 4 }])
    .slice().sort((a, b) => a.tick - b.tick);
  const out = [];
  let t = 0;
  let k = 0;
  while (t < endTick) {
    while (k + 1 < sigs.length && sigs[k + 1].tick <= t) k++;
    const bar = Math.max(1, Math.round((WHOLE * sigs[k].num) / sigs[k].den));
    // A signature change lands mid-bar: the bar ends there.
    const nextSig = k + 1 < sigs.length ? sigs[k + 1].tick : Infinity;
    t = Math.min(t + bar, nextSig);
    out.push(t);
  }
  return out;
}

/**
 * Write a track's body: the notes from 0 to `endTick`, with rests between,
 * split at every boundary (bar ends, marks, the loop point).
 *
 * @param notes  [{tick, len, midi, vel?, pre?: string[], state?: string[],
 *                tieIn?}], sorted, no overlap. `pre` is written before the
 *                note (a voice switch); `state` is every such switch in
 *                force at it, restated at the loop point; `tieIn` ties the
 *                note on from whatever the previous phrase left sounding.
 * @param opts   {bars: number[], endTick, loopTick, marks: [{tick, tokens}],
 *                defLen, oct, vel}
 * @returns {string[]} lines, one per bar
 */
function writeBody(notes, opts) {
  const { bars = [], endTick, loopTick = null, marks = [], defLen } = opts;
  const bounds = new Set([...bars, endTick]);
  for (const m of marks) bounds.add(m.tick);
  if (loopTick != null) bounds.add(loopTick);
  const sortedBounds = [...bounds].filter((b) => b > 0 && b <= endTick).sort((a, b) => a - b);
  // A PCM or ROM rhythm track's notes are shots, which play out whatever
  // their length, so a note there ends at the next bound rather than tie
  // across it.
  if (opts.noTie) {
    notes = notes.map((n) => {
      const b = firstAbove(sortedBounds, n.tick) ?? endTick;
      return n.tick + n.len > b ? { ...n, len: b - n.tick } : n;
    });
  }
  const barSet = new Set(bars);
  const marksAt = new Map();
  for (const m of marks) marksAt.set(m.tick, [...(marksAt.get(m.tick) ?? []), ...m.tokens]);

  const lines = [];
  let line = [];
  let oct = opts.oct;
  let vel = opts.vel;
  let t = 0;
  let i = 0;
  let bi = 0;
  let held = null; // the note still sounding at t, continued with a tie
  let lastPre = opts.pre ?? []; // the voice/sample switch in force
  let lastEnd = null; // where the last note written ends

  const pitch = (midi) => {
    const o = octOf(midi);
    const d = o - oct;
    oct = o;
    const name = noteName(midi);
    if (d === 0) return name;
    if (d === 1) return `> ${name}`;
    if (d === -1) return `< ${name}`;
    return `o${d > 0 ? "+" : ""}${d} ${name}`;
  };
  const len = (d) => (d === defLen ? "" : lenToken(d));

  while (t < endTick) {
    while (bi < sortedBounds.length && sortedBounds[bi] <= t) bi++;
    const b = bi < sortedBounds.length ? sortedBounds[bi] : endTick;
    const cont = held && held.tick + held.len > t;
    const tie = cont && loopTick !== t;
    if (tie) line.push("~");
    if (loopTick === t) {
      // `(go top)` arrives with the end's state: restate what the loop's
      // first pass has here.
      line.push("#top", ...lastPre, `:oct ${oct}`);
      if (!opts.noVel && (vel !== opts.vel || lastPre.length)) line.push(`:vel ${vel}`);
    }
    if (marksAt.has(t)) line.push(...marksAt.get(t));
    if (tie || (cont && loopTick === t)) {
      // Tied on, or re-attacked at the loop point.
      const end = Math.min(held.tick + held.len, b);
      line.push(pitch(held.midi) + len(end - t));
      t = end;
      lastEnd = end;
    } else if (i < notes.length && notes[i].tick <= t) {
      const n = notes[i++];
      held = n;
      const start = t; // a note quantized onto an earlier one starts here
      if (n.pre?.length) line.push(...n.pre);
      lastPre = n.state ?? n.pre ?? lastPre;
      if (n.vel != null && n.vel !== vel) {
        if (!opts.noVel) line.push(`:vel ${n.vel}`);
        vel = n.vel;
      }
      const end = Math.min(n.tick + n.len, b);
      if (end <= start) continue;
      // Tied (or slurred) on from the note before, or from the phrase before.
      if (n.tieIn && (start === 0 || lastEnd === start)) line.push("~");
      line.push(pitch(n.midi) + len(end - start));
      t = end;
      lastEnd = end;
    } else {
      held = null;
      const end = Math.min(i < notes.length ? notes[i].tick : endTick, b);
      line.push("_" + len(end - t));
      t = end;
    }
    if (t === b && barSet.has(b)) {
      line.push("|");
      lines.push(line.join(" "));
      line = [];
    }
  }
  if (line.length) lines.push(line.join(" "));
  return lines;
}

/** The most common piece length a body will write (the `:len` to set). */
function commonLen(notes, bars, endTick) {
  const count = new Map();
  for (const n of notes) {
    // Count the piece up to the next bar end, as writeBody splits it.
    const b = firstAbove(bars, n.tick) ?? endTick;
    const d = Math.min(n.len, b - n.tick);
    if (d > 0) count.set(d, (count.get(d) ?? 0) + 1);
  }
  let best = PPQN / 2;
  let bestN = 0;
  for (const [d, k] of count) {
    // Prefer a plain denominator for `:len`.
    const w = k * (WHOLE % d === 0 ? 2 : 1);
    if (w > bestN) { best = d; bestN = w; }
  }
  return best;
}

// The compiler's octaves run 0 up: a note below (a slide's tail, a deep
// drum sweep) is folded up an octave at a time — written as it is, every
// relative octave after it would land one too high.
const playable = (m) => (m == null ? m : m < 12 ? playable(m + 12) : m > 127 ? playable(m - 12) : m);
const inRange = (notes) => (notes.every((n) => n.midi == null || (n.midi >= 12 && n.midi <= 127)) ? notes
  : notes.map((n) => ({ ...n, midi: playable(n.midi) })));
const songInRange = (song) => ({ ...song, tracks: song.tracks.map((tr) => ({ ...tr, notes: inRange(tr.notes) })) });
// A track's end and loop point: its own, else the song's. A loop with nothing
// in it (the track ends where it loops) is no loop.
function trackSpan(song, tr) {
  const endTick = tr.endTick ?? song.endTick;
  const loopTick = tr.loopTick !== undefined ? tr.loopTick : song.loopTick ?? null;
  return { endTick, loopTick: loopTick != null && loopTick < endTick ? loopTick : null };
}

/**
 * The whole score.
 *
 * @param song {
 *   header: string[]        top-level lines (comments, title, imports, defs)
 *   bars: number[]          bar end ticks
 *   endTick, loopTick?
 *   tracks: [{channel, head: string[], notes, marks?, vel?,
 *             endTick?, loopTick?}]  a track's own end and loop, where its
 *                           driver loops each track on its own (MDX, MGS);
 *                           `open`: tokens its form opens with (`:prio n`)
 * }
 */
export function emitSong(song) {
  song = songInRange(song);
  const out = [...song.header];
  for (const tr of song.tracks) {
    const { endTick, loopTick } = trackSpan(song, tr);
    const bars = song.bars.filter((b) => b < endTick).concat(endTick);
    const notes = tr.notes;
    const first = notes.find((n) => n.midi != null);
    const oct = first ? octOf(first.midi) : 4;
    const defLen = commonLen(notes, bars, endTick);
    const vel = notes.find((n) => n.vel != null)?.vel ?? 15;
    const body = writeBody(notes, {
      bars, endTick, loopTick,
      marks: tr.marks ?? [], defLen, oct, vel, pre: tr.head, noTie: shots(tr.channel), noVel: tr.noVel,
    });
    const head = [tr.channel, ...(tr.open ?? []), ...tr.head, `:oct ${oct}`, `:len ${lenToken(defLen)}`];
    if (vel !== 15 && !tr.noVel) head.push(`:vel ${vel}`);
    if (loopTick != null) body.push("(go top)");
    out.push("", `(${head.join(" ")}`, ...body.map((l) => "  " + l));
    out[out.length - 1] += ")";
  }
  return out.join("\n") + "\n";
}

/**
 * A tracker song, its patterns kept as phrases: each segment (one pattern
 * of one channel, as the order list plays it) is written once as a
 * `(def …)` that restates the state it relies on — voice, octave, velocity
 * — and each track names its segments in order, a run of one as `(x n …)`.
 * Segments that come out as the same text share one def.
 *
 * @param song {
 *   header: string[]
 *   tracks: [{channel, head: string[], loopIndex: number|null,
 *             loopTokens?: string[]  written after #top (the tempo)
 *             segments: [{label, len, bars, notes, marks?,
 *                         state: {pre: string[], vel, oct}}]}]
 * }
 */
export function emitPhrased(song) {
  song = { ...song, tracks: song.tracks.map((tr) => ({ ...tr, segments: tr.segments.map((sg) => ({ ...sg, notes: inRange(sg.notes) })) })) };
  const out = [...song.header];
  const forms = [];
  for (const tr of song.tracks) {
    const all = tr.segments.flatMap((sg) => sg.notes);
    const defLen = commonLen(all, [], Infinity);
    const byText = new Map();
    const names = new Set();
    const defs = [];
    const order = [];
    for (const sg of tr.segments) {
      const { pre, vel, oct } = sg.state;
      const body = writeBody(sg.notes, {
        bars: sg.bars, endTick: sg.len, marks: sg.marks ?? [], defLen, oct, vel, pre, noVel: tr.noVel,
      });
      const head = [...pre, `:oct ${oct}`, ...(tr.noVel ? [] : [`:vel ${vel}`])].join(" ");
      const text = [head, ...body].join("\n  ");
      let name = byText.get(text);
      if (!name) {
        const base = `${tr.channel}-${sg.label}`;
        name = base;
        for (let k = 2; names.has(name); k++) name = `${base}-${k}`;
        names.add(name);
        byText.set(text, name);
        defs.push(`(def ${name}\n  ${text})`);
      }
      order.push(name);
    }
    if (!defs.length) continue;
    out.push("", `; ${tr.channel}`, ...defs);
    // The track: the phrases in order, repeats folded, the loop marked.
    const items = [];
    for (let i = 0; i < order.length; i++) {
      if (i === tr.loopIndex) items.push(["#top", ...(tr.loopTokens ?? [])].join(" "));
      let n = 1;
      while (i + n < order.length && order[i + n] === order[i] && i + n !== tr.loopIndex) n++;
      items.push(n > 1 ? `(x ${n} ${order[i]})` : order[i]);
      i += n - 1;
    }
    if (tr.loopIndex != null) items.push("(go top)");
    const lines = [];
    let line = [];
    for (const it of items) {
      if (it.startsWith("#top") && line.length) { lines.push(line.join(" ")); line = []; }
      line.push(it);
      if (line.length >= 6) { lines.push(line.join(" ")); line = []; }
    }
    if (line.length) lines.push(line.join(" "));
    forms.push("", `(${[tr.channel, ...tr.head, `:len ${lenToken(defLen)}`].join(" ")}`,
      ...lines.map((l) => "  " + l));
    forms[forms.length - 1] += ")";
  }
  return [...out, ...forms].join("\n") + "\n";
}

// ── Tempo ────────────────────────────────────────────────────────────────

/**
 * The beat the onsets keep, followed through the song. The basic unit is the
 * coarsest one the gaps between onsets are whole multiples of — gaps, not
 * absolute times, so a driver whose timer drifts or jitters (an arcade one
 * at its own rate) still shows its beat. Then the onsets are walked in
 * order: each gap is rounded to whole units, and the unit's length follows
 * the music a little at each step, so drift never piles up into a wrong bar.
 * Onsets within 15 ms are one (a chord, however loosely played).
 *
 * Returns { unitTicks (what a unit is in the score: 24 = a 16th), bpm, fit,
 * frames, readings, units(t) → the unit a time (in samples) falls on }.
 * Falls back to the frame grid when no unit fits.
 */
export function estimateGrid(onsetsIn, { frameRate = 60 } = {}) {
  const frameUnit = RATE / frameRate;
  const frame = {
    unitTicks: 4, fit: 1, frames: true, readings: [], bpm: (60 * RATE) / (frameUnit * 24),
    units: (t) => Math.round(t / frameUnit),
  };
  const onsets = [...new Set(onsetsIn.map((t) => Math.round(t)))].sort((a, b) => a - b);
  const merged = [];
  for (const t of onsets) if (!merged.length || t - merged[merged.length - 1] > RATE * 0.015) merged.push(t);
  if (merged.length < 8) return frame;
  const gaps = [];
  for (let i = 1; i < merged.length; i++) gaps.push(merged[i] - merged[i - 1]);

  // How well the gaps are whole multiples of `u` (a gap under half a unit
  // is a miss: the unit is too coarse for it).
  const fitOf = (u) => {
    let s = 0;
    for (const d of gaps) {
      const x = d / u;
      s += x < 0.5 ? 0 : 1 - 2 * Math.abs(x - Math.round(x));
    }
    return s / gaps.length;
  };
  // The unit a gap set implies: least squares over the gaps' multiples.
  const refine = (u0) => {
    let u = u0;
    for (let pass = 0; pass < 3; pass++) {
      let num = 0, den = 0;
      for (const d of gaps) {
        const k = Math.round(d / u);
        if (k >= 1 && k <= 32 && Math.abs(d / u - k) < 0.25) { num += d * k; den += k * k; }
      }
      if (den) u = num / den;
    }
    return u;
  };
  // Candidates: the common gaps and their halves, thirds, quarters …
  const hist = new Map();
  for (const d of gaps) {
    const k = Math.round(d / 64) * 64;
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const common = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const cands = [];
  for (const k of common) for (const div of [1, 2, 3, 4, 6, 8]) {
    const u = refine(k / div);
    if (u >= RATE * 0.015 && u <= RATE * 0.75 && !cands.some((c) => Math.abs(c - u) / u < 0.02)) cands.push(u);
  }
  const scored = cands.map((u) => ({ u, fit: fitOf(u) })).sort((a, b) => b.u - a.u);
  const top = Math.max(...scored.map((x) => x.fit));
  const best = scored.find((x) => x.fit >= Math.max(0.75, 0.9 * top));
  if (!best) return frame;
  const unit = best.u, fit = best.fit;

  // A song on one steady clock (exact MIDI, most game drivers) keeps one
  // grid end to end: the unit refined against every onset's absolute time,
  // phase and all. Only when no single grid holds them (a drifting timer)
  // is the beat followed onset by onset.
  const phaseFit = (u, n = merged.length) => {
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * (merged[i] - merged[0])) / u; x += Math.cos(a); y += Math.sin(a); }
    return Math.hypot(x, y) / n;
  };
  let fixedU = unit;
  for (let span = RATE * 4, range = 0.01; ; span *= 2, range /= 4) {
    const upTo = merged.findIndex((t) => t - merged[0] > span);
    const n = upTo < 0 ? merged.length : Math.max(8, upTo);
    let bestU = fixedU, bestF = -1;
    for (let j = -20; j <= 20; j++) {
      const c = fixedU * (1 + (range * j) / 20);
      const f = phaseFit(c, n);
      if (f > bestF) { bestF = f; bestU = c; }
    }
    fixedU = bestU;
    if (upTo < 0) break;
  }
  // The doubling can settle on a near grid when some onsets sit off it (a
  // part played a little late): a fine look over the whole song as well.
  let scanU = fixedU;
  for (let j = -200, f0 = phaseFit(fixedU); j <= 200; j++) {
    const c = fixedU * (1 + (0.02 * j) / 200);
    const f = phaseFit(c);
    if (f > f0) { f0 = f; scanU = c; }
  }
  // Count of the gaps a grid gives half a unit more or less than they last.
  const misses = ({ u, units: f }) => {
    let n = 0;
    for (let i = 1; i < merged.length; i++)
      if (Math.abs(f(merged[i]) - f(merged[i - 1]) - (merged[i] - merged[i - 1]) / u) > 0.5) n++;
    return n;
  };
  // A fixed grid. Its phase: the first onset's (which may be late), the
  // onsets' mean (which a shuffle splits) or where most of them sit — the
  // one that keeps the gaps best.
  const fixedGrid = (u) => {
    if (phaseFit(u) < 0.7) return null;
    const phases = merged.map((t) => (((t - merged[0]) / u) % 1 + 1) % 1);
    let x = 0, y = 0;
    for (const ph of phases) { x += Math.cos(2 * Math.PI * ph); y += Math.sin(2 * Math.PI * ph); }
    const BINS = 20;
    const count = new Array(BINS).fill(0);
    for (const ph of phases) count[Math.floor(ph * BINS) % BINS]++;
    const top = count.indexOf(Math.max(...count));
    const at = (ph) => { const o = merged[0] + (ph - Math.round(ph)) * u; return { u, units: (t) => Math.round((t - o) / u) }; };
    return [at(0), at(Math.atan2(y, x) / (2 * Math.PI)), at((top + 0.5) / BINS)]
      .map((gr) => ({ gr, n: misses(gr) })).reduce((p, q) => (q.n < p.n ? q : p)).gr;
  };

  // Walk: each onset's place in units, the unit's length following as it
  // goes. The place adds up unrounded and is rounded where it is read: a
  // gap under half a unit (a part played a little late) is the same unit,
  // and two half-unit gaps (a 32nd on a 16th grid) are one unit, not two.
  const at = [0];
  const len = [unit];
  let u = unit;
  for (let i = 1; i < merged.length; i++) {
    const d = merged[i] - merged[i - 1];
    const k = Math.round(d / u);
    at.push(at[i - 1] + d / u);
    // A little of each gap's own unit, never far from the song's.
    if (k > 0) u = Math.min(unit * 1.1, Math.max(unit * 0.9, u + 0.1 * (d / k - u)));
    len.push(u);
  }
  const units = (t) => {
    if (t <= merged[0]) return Math.round((t - merged[0]) / unit);
    let lo = 0, hi = merged.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (merged[mid] <= t) lo = mid; else hi = mid - 1; }
    return Math.round(at[lo] + (t - merged[lo]) / len[lo]);
  };

  // Whichever grid keeps the onsets' gaps best, a fixed one on a tie (a
  // timer that drifts loses count on any fixed grid).
  // (The walk's unit, for the tempo, is the one it averages over the song.)
  const span = at[at.length - 1] - at[0];
  const walked = span > 0 ? (merged[merged.length - 1] - merged[0]) / span : unit;
  const grids = [fixedGrid(fixedU), fixedGrid(scanU), { u: walked, units }].filter(Boolean);
  const pick = grids.map((gr) => ({ gr, n: misses(gr) })).reduce((a, b) => (b.n < a.n ? b : a)).gr;
  return readingsOf(pick.u, { fit, frames: false, units: pick.units });
}

// The unit as a note: whatever puts the beat in 80-200 BPM, a 16th first
// (a run's 32nd grid at 178 is 16ths at 178, not 32nds at 89); the other
// readings (double, half, … the tempo) ride along.
function readingsOf(unit, grid) {
  const asNote = [[4, 24], [2, 48], [8, 12], [3, 32], [6, 16], [1, 96], [16, 6], [12, 8], [32, 3], [24, 4]];
  const options = asNote.map(([perBeat, ticks]) => ({ unitTicks: ticks, bpm: (60 * RATE) / (unit * perBeat) }));
  const pick = options.find((o) => o.bpm >= 80 && o.bpm <= 200) ?? options[0];
  return { ...grid, unitTicks: pick.unitTicks, bpm: pick.bpm, readings: options.filter((o) => o.bpm >= 40 && o.bpm <= 320) };
}

/**
 * A grid at a tempo set by hand. A tempo that is another reading of the
 * estimated unit (double, half, …) reads it so; any other tempo only sets
 * the tempo the score is written at — where the notes fall is the grid's.
 */
export function regrid(g, bpm) {
  const r = (g.readings ?? []).find((o) => Math.abs(o.bpm - bpm) / bpm < 0.005);
  return r ? { ...g, unitTicks: r.unitTicks, bpm } : { ...g, bpm };
}

// ── Structure: repeats and phrases ─────────────────────────────────────────
// A song written with its repeats folded: the more structured, the easier to
// grasp. Each track is cut into units — its bars, and the loop point —
// compared by what they play (notes at MMLisp's 16 velocity steps, the
// voice/state in force, the marks). Then:
//   1. runs that repeat back to back become `(x n …)`, and a run that comes
//      back once more cut short becomes `(x n A (break) B)` (A B A B A);
//   2. a run that comes back elsewhere becomes a `(def …)`, named in place.
// A block restates the state it relies on at its head — a loop's second pass
// arrives with its own end state, and a def plays wherever it is named. A
// unit that starts tied (or slurred) on from the one before cannot head one.

const MAX_BLOCK = 16; // units in one repeated block or phrase

// A switch's kind: a keyword by its name, a macro (or an `env-`, `vol-`,
// `vib-` or `bend-` def, an imported envelope or bend) by its target, a
// glide, any other name — the voice or the sample — as "name".
// :gate, :gate* and :gate- set the one gate: one kind.
const switchKind = (t) => t.startsWith(":") ? t.split(" ")[0].replace(/^:gate[*-]$/, ":gate")
  : t.startsWith("(glide") ? "glide"
  : t.startsWith("(macro") ? `macro${t.match(/^\(macro\s+(:[a-z-]+|none)/)?.[1] ?? ""}`
    : /^env-/.test(t) ? "macro:vel" : /^vol-/.test(t) ? "macro:vol"
      : /^(vib|bend)-/.test(t) ? "macro:pitch" : "name";

// The switches a note needs written, given those in force: by kind — a
// keyword (`:pan`, `:mode`) by its name, a macro by its target, a bare name
// (a voice, a sample, an envelope def) by its place — only what changed.
// With nothing known in force (after a loop's break), all of them. A glide
// is a note's own, not a switch: a note that glides carries it, and the one
// after it `(glide none)` — both written wherever they are.
export function stateChange(from, to) {
  if (!from.length) return to;
  const kind = (toks) => new Map(toks.filter((t) => !isGlide(t)).map((t) => [switchKind(t), t]));
  const a = kind(from), b = kind(to);
  // A different set of kinds (a macro appears or goes): write them all.
  if (a.size !== b.size || [...b.keys()].some((k) => !a.has(k))) return to;
  // Each kind where it first comes, its last word; a glide where it is.
  const out = [], seen = new Set();
  for (const t of to) {
    if (isGlide(t)) { out.push(t); continue; }
    const k = switchKind(t);
    if (seen.has(k)) continue;
    seen.add(k);
    if (a.get(k) !== b.get(k)) out.push(b.get(k));
  }
  return out;
}
export const GLIDE_NONE = "(glide none)";
const isGlide = (t) => t.startsWith("(glide");

/** Cut a track into units at the bar ends and the loop point. */
function unitsOf(tr, bars, endTick, loopTick, intern = new Map()) {
  let running = tr.head ?? [];
  const notes = tr.notes.map((n) => {
    if (n.state) running = n.state;
    else if (n.pre?.length) running = n.pre;
    return { ...n, st: running };
  });
  const cuts = [...new Set([...bars, endTick, ...(loopTick > 0 ? [loopTick] : [])])]
    .filter((c) => c > 0 && c <= endTick).sort((a, b) => a - b);
  const units = [];
  let a = 0;
  let k = 0;
  for (const b of cuts) {
    while (k < notes.length && notes[k].tick + notes[k].len <= a) k++;
    const pieces = [];
    for (let j = k; j < notes.length && notes[j].tick < b; j++) {
      const n = notes[j];
      const s = Math.max(n.tick, a);
      const e = Math.min(n.tick + n.len, b);
      if (e <= s) continue;
      // No ties on shots (writeBody noTie): a tail over the cut is let go —
      // into the loop it would strike again.
      if (n.tick < a && shots(tr.channel)) continue;
      // Carried over the cut: tied on — except into the loop, which starts over.
      const tieIn = n.tick < a ? a !== loopTick : !!n.tieIn && (n.tick > a || a !== loopTick);
      pieces.push({ tick: s - a, len: e - s, midi: n.midi, vel: n.vel, st: n.st, tieIn });
    }
    const marks = (tr.marks ?? []).filter((m) => m.tick >= a && m.tick < b).map((m) => ({ ...m, tick: m.tick - a }));
    const tieHead = pieces.length > 0 && pieces[0].tick === 0 && pieces[0].tieIn;
    // What it plays, as a short id (runs of them are compared and joined).
    const full = JSON.stringify([b - a, pieces.map((p) => [p.tick, p.len, p.midi, p.vel, p.st.join(" "), p.tieIn ? 1 : 0]),
      marks.map((m) => [m.tick, m.tokens.join(" ")])]);
    if (!intern.has(full)) intern.set(full, `u${intern.size}`);
    const key = intern.get(full);
    units.push({ k: "u", start: a, len: b - a, pieces, marks, key, size: 1, tieHead });
    a = b;
  }
  return units;
}

const headOk = (it) => (it.k === "u" ? !it.tieHead : headOk(it.first));
const sizeOf = (items, i, n) => { let s = 0; for (let t = 0; t < n; t++) s += items[i + t].size; return s; };
const sameRun = (items, i, j, n) => { for (let t = 0; t < n; t++) if (items[i + t].key !== items[j + t].key) return false; return true; };

/** Fold back-to-back repeats into `(x n …)` groups, until nothing folds. */
function foldRepeats(items) {
  for (let changed = true; changed; ) {
    changed = false;
    const out = [];
    for (let i = 0; i < items.length; ) {
      let best = null;
      // A run that starts tied on (a part played behind the beat) folds as
      // `~ (x n … ~)`: the `~` before it ties the first pass on, the one
      // ending it each pass into the next — and the last into the bar after
      // the loop, so that one must start tied on as well.
      const tieLed = items[i].k === "u" && items[i].tieHead;
      if (headOk(items[i]) || tieLed) {
        for (let L = 1; L <= MAX_BLOCK && i + L <= items.length; L++) {
          if (items[i + L - 1].tieLoop) continue; // it must stay before the bar it ties into
          let n = 1;
          while (i + (n + 1) * L <= items.length && sameRun(items, i, i + n * L, L)) n++;
          let k = 0;
          while (!tieLed && k < L - 1 && i + n * L + k < items.length && items[i + n * L + k].key === items[i + k].key) k++;
          if (k && items[i + k - 1].tieLoop) k = 0;
          if (n < 2 && k === 0) continue;
          if (tieLed && !(items[i + n * L]?.k === "u" && items[i + n * L].tieHead)) continue;
          // Tie or slur is settled once, from the text: coming back round
          // from the body's end must be the same kind as coming in.
          if (tieLed) {
            const h = items[i].pieces[0].midi;
            const before = i > 0 ? lastPiece(items.slice(0, i)) : null;
            const end = lastPiece(items.slice(i, i + L));
            if (!before || !end || (before.midi === h) !== (end.midi === h)) continue;
          }
          // What the fold saves: the passes not written out.
          const saved = (n - 1) * sizeOf(items, i, L) + sizeOf(items, i, k);
          if (saved >= 1 && (!best || saved > best.saved)) best = { L, n, k, saved };
        }
      }
      if (!best) { out.push(items[i++]); continue; }
      const block = items.slice(i, i + best.L);
      const count = best.n + (best.k ? 1 : 0);
      const brk = best.k || null;
      out.push({ k: "x", count, brk, block, first: block[0], size: sizeOf(items, i, best.L), tieLoop: tieLed,
        key: `x${count}/${brk}${tieLed ? "~" : ""}[${block.map((b) => b.key).join(",")}]` });
      i += best.n * best.L + best.k;
      changed = true;
    }
    items = out;
  }
  return items;
}

/** Runs that come back elsewhere → defs, best saving first. */
function extractDefs(lists, prefix) {
  const defs = [];
  for (;;) {
    const occ = new Map(); // run key → [{li, p, m}]
    lists.forEach((items, li) => {
      for (let p = 0; p < items.length; p++) {
        if (!headOk(items[p])) continue;
        let key = "";
        for (let m = 1; m <= MAX_BLOCK && p + m <= items.length; m++) {
          key += (m > 1 ? "," : "") + items[p + m - 1].key;
          if (m === 1 && items[p].k === "d") continue; // a def of one def is no phrase
          if (items[p + m - 1].tieLoop) continue; // it must stay before the bar it ties into
          if (!occ.has(key)) occ.set(key, []);
          occ.get(key).push({ li, p, m });
        }
      }
    });
    let best = null;
    for (const [key, list] of occ) {
      if (list.length < 2) continue;
      // Non-overlapping, left to right in each list.
      const used = [];
      const last = new Map();
      for (const o of list) {
        if ((last.get(o.li) ?? -1) > o.p) continue;
        used.push(o);
        last.set(o.li, o.p + o.m);
      }
      if (used.length < 2) continue;
      const size = sizeOf(lists[used[0].li], used[0].p, used[0].m);
      if (size < 2 && used.length < 3) continue; // a one-bar phrase earns a def from three uses
      const score = size * (used.length - 1);
      if (!best || score > best.score || (score === best.score && used[0].m > best.used[0].m)) best = { key, used, size, score };
    }
    if (!best) break;
    const { used } = best;
    const items = lists[used[0].li].slice(used[0].p, used[0].p + used[0].m);
    const name = `${prefix}-${defName(defs.length)}`;
    const def = { name, items, runKey: best.key };
    defs.push(def);
    const ref = { k: "d", def, first: items[0], size: best.size, key: `d:${name}` };
    // Replace right to left so the earlier indices hold.
    for (const o of [...used].sort((x, y) => y.li - x.li || y.p - x.p)) lists[o.li].splice(o.p, o.m, ref);
  }
  return defs;
}

const defName = (i) => (i < 26 ? String.fromCharCode(97 + i) : defName(Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26)));

/** The first note an item plays, for its head's restatement. */
function firstPiece(it) {
  if (it.k === "u") return it.pieces[0] ?? null;
  for (const c of it.k === "x" ? it.block : it.def.items) {
    const p = firstPiece(c);
    if (p) return p;
  }
  return null;
}

/**
 * The last note a run of items plays: what a loop goes back round with. A
 * loop with a (break) is left from the break, so its last note is the
 * front's (or, the front all rests, the tail's from the pass before).
 */
function lastPiece(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const p = it.k === "u" ? it.pieces[it.pieces.length - 1]
      : it.k === "d" ? lastPiece(it.def.items)
        : (it.brk && lastPiece(it.block.slice(0, it.brk))) || lastPiece(it.block);
    if (p) return p;
  }
  return null;
}

// One track's structure on a given set of bars: its units, folded and
// phrased.
function planTrack(tr, bars, endTick, loopTick) {
  const units = unitsOf(tr, bars, endTick, loopTick);
  const segs = loopTick > 0 ? [units.filter((u) => u.start < loopTick), units.filter((u) => u.start >= loopTick)] : [units];
  const lists = segs.map((s) => foldRepeats(s));
  const defs = extractDefs(lists, tr.channel);
  return { segs, lists, defs };
}

/**
 * Where the bars go when the file does not say (a VGM, a MIDI file timed by
 * its notes). The meter comes from how the song repeats: the share of its
 * onsets (a track's pitch at a 16th) that come back one, two and four bars
 * later, for a 4/4 bar against a 3/4 one. Three is taken only when it
 * clearly wins, in a song longer than eight 4/4 bars (a song that barely
 * repeats reads either way, and 4/4 is the commoner).
 *
 * The downbeat comes from the drums (a note's `drum`: {id, bright}), in
 * 4/4: the backbeat is one drum on two 8ths half a bar apart and another
 * on the two a beat on from them. Of the two the duller (`bright`, a
 * kick) is on 1 and 3, the other (a snare) on 2 and 4. That puts 1 on
 * one of two 8ths; it moves off the start only where clearly more long
 * notes start on it (a chord changes on 1; a track marked `drums` is not
 * counted) — the drums alone mistake a low snare or offbeat hats for the
 * pair, and the kick plays 1 and 3 alike. That 8th starts a bar, one
 * before it a pickup. With no such pair (no drums,
 * a 3/4 song, a beat with no backbeat) the first bar starts at the first
 * note.
 * `|` is editorial, but the structure cuts the score there.
 */
export function bestBars(song) {
  const { endTick } = song;
  const S = PPQN / 4;
  const n = Math.ceil(endTick / S) + 1;
  const at = Array.from({ length: n }, () => []);
  song.tracks.forEach((tr, ti) => {
    for (const x of tr.notes) {
      const i = x.tick / S;
      if (x.midi == null || x.tieIn || !Number.isInteger(i) || i >= n) continue;
      at[i].push(ti * 128 + x.midi);
    }
  });
  const sim = (lag) => {
    const k = lag / S;
    let same = 0, all = 0;
    for (let i = 0; i + k < n; i++) {
      if (!at[i].length) continue;
      all += at[i].length;
      const later = new Set(at[i + k]);
      for (const x of at[i]) if (later.has(x)) same++;
    }
    return all ? same / all : 0;
  };
  const per = (bar) => (sim(bar) + sim(2 * bar) + sim(4 * bar)) / 3;
  const four = per(WHOLE), three = per((WHOLE * 3) / 4);
  const bar = 8 * WHOLE < endTick && three > 0 && three >= four * 1.25 ? (WHOLE * 3) / 4 : WHOLE;

  // Each drum's hits on each 8th of the bar, counted from the song's start.
  const E = PPQN / 2, steps = bar / E, half = steps / 2;
  const drums = new Map();
  for (const tr of song.tracks) {
    for (const x of tr.notes) {
      if (!x.drum || x.tieIn || x.tick % E) continue;
      if (!drums.has(x.drum.id)) drums.set(x.drum.id, { bright: x.drum.bright, at: new Array(steps).fill(0), hits: 0 });
      const d = drums.get(x.drum.id);
      d.at[(x.tick % bar) / E]++;
      d.hits++;
    }
  }
  // A drum's hits on 8th p and p + half a bar, as a share of all of them.
  const pair = (d, p) => (d.at[p % steps] + d.at[(p + half) % steps]) / d.hits;
  let s = 0;
  if (bar === WHOLE) {
    let best = null;
    for (const a of drums.values()) {
      if (a.hits < 16) continue;
      for (let p = 0; p < half; p++) {
        if (pair(a, p) < 0.75) continue;
        for (const b of drums.values()) {
          if (b === a || b.hits < 16 || pair(b, p + 2) < 0.5) continue;
          const score = pair(a, p) * a.hits + pair(b, p + 2) * b.hits;
          if (!best || score > best.score) best = { score, kick: a.bright <= b.bright ? [a, p] : [b, p + 2] };
        }
      }
    }
    if (best) {
      // The kick's two are 1 and 3, but which is which — and whether the
      // pair is a kick and snare at all (a low snare, a hat and a clap on
      // the offbeats) — the long notes tell (half a bar or more, not a
      // drum's: chords change on 1). The start holds unless clearly more
      // start on one of the two: twice as many, and four more.
      const x = best.kick[1] % half;
      const long = (j) => {
        let c = 0;
        for (const tr of song.tracks) {
          if (tr.drums) continue;
          for (const y of tr.notes) if (!y.drum && !y.tieIn && y.midi != null && y.len >= bar / 2 && y.tick % bar === j * E) c++;
        }
        return c;
      };
      const at0 = long(0);
      const c = long(x) >= long(x + half) ? x : x + half;
      if (c && long(c) >= 2 * at0 && long(c) - at0 >= 4) s = c;
    }
  }
  const bars = [];
  for (let t = s ? s * E : bar; t < endTick; t += bar) bars.push(t);
  bars.push(endTick);
  return bars;
}

/**
 * The whole score, structured. Same input as emitSong; a track's notes may
 * carry `state` (every switch in force) or only `pre` (a voice switch).
 */
export function emitStructured(song) {
  song = songInRange(song);
  const out = [...song.header];
  const forms = [];
  for (const tr of song.tracks) {
    const { endTick, loopTick } = trackSpan(song, tr);
    const bars = song.bars.filter((b) => b < endTick).concat(endTick);
    const defLen = commonLen(tr.notes, bars, endTick);
    const { segs, lists, defs } = planTrack(tr, bars, endTick, loopTick);
    const byRun = new Map(defs.map((d) => [d.runKey, d]));
    // Switches the compiler binds to the notes as it goes (like the octave),
    // not writes the chip gets: a macro, the gate, and a PCM track's sample.
    const pcm = tr.channel.startsWith("pcm");
    const baked = (t) => { const k = switchKind(t); return k.startsWith("macro") || k === "glide" || k === ":gate" || (pcm && k === "name"); };

    // Writing: the state carried from item to item, restated at a head.
    const writeUnit = (u, st) => {
      let running = st.st;
      const notes = u.pieces.map((p) => {
        const pre = stateChange(running, p.st);
        running = p.st;
        return { tick: p.tick, len: p.len, midi: p.midi, vel: p.vel, tieIn: p.tieIn, pre };
      });
      const lines = writeBody(notes, { bars: [u.len], endTick: u.len, marks: u.marks, defLen, oct: st.oct, vel: st.vel, pre: st.st, noVel: tr.noVel });
      const lastP = u.pieces[u.pieces.length - 1];
      const next = lastP ? { oct: octOf(lastP.midi), vel: lastP.vel, st: lastP.st } : st;
      return { lines, st: next };
    };
    // The first note anywhere in a run (a block may open on a rest bar).
    // A def plays wherever it is named, so its head states everything. A
    // loop's body is compiled once — the octave and velocity it was entered
    // with hold on every pass — but a switch (a voice, a pan) is a write the
    // chip gets when played: the head writes those the first note needs on
    // the way in or coming back round from `around`, the body's last note.
    const head = (items, st, around, whole, start) => {
      let p = null;
      for (const it of items) if ((p = firstPiece(it))) break;
      if (!p) return { tokens: [], st };
      const oct = octOf(p.midi);
      if (whole) {
        // At the track's start there is no macro to clear.
        const sw = start ? p.st.filter((t) => !/^\(macro :[a-z+*-]+ none\)$/.test(t)) : p.st;
        return { tokens: [...sw, `:oct ${oct}`, ...(tr.noVel ? [] : [`:vel ${p.vel}`])], st: { oct, vel: p.vel, st: p.st } };
      }
      const sw = st.st.length ? stateChange(st.st, p.st) : p.st;
      const back = around ? stateChange(around.st, p.st).filter((t) => !baked(t)) : [];
      const tokens = p.st.filter((t) => sw.includes(t) || back.includes(t));
      if (oct !== st.oct) tokens.push(`:oct ${oct}`);
      return { tokens, st: { ...st, oct, st: p.st } };
    };
    const defEnd = new Map();
    // `whole`: the run the head restates for — a loop's whole block, though
    // only the part before its (break) is written here. `full`: state it all.
    const writeItems = (items, st, atHead, whole = items, around = null, full = false, start = false) => {
      const lines = [];
      // A unit after a `~ (x … ~)` is tied on by the loop's last `~`.
      const untie = (u) => ({ ...u, pieces: u.pieces.map((p, i) => (i === 0 ? { ...p, tieIn: false } : p)) });
      items.forEach((it, idx) => {
        if (idx > 0 && items[idx - 1].tieLoop && it.k === "u") it = untie(it);
        let prefix = [];
        // A block's head restates the first note it plays, whatever comes
        // first — a rest-only loop or a def tells the next note nothing.
        if (atHead && idx === 0) ({ tokens: prefix, st } = head(whole, st, around, full, start));
        let got;
        if (it.k === "u") got = writeUnit(it, st);
        else if (it.k === "d") got = { lines: [it.def.name], st: defEnd.get(it.def.name) ?? st };
        else {
          const blockKey = it.block.map((b) => b.key).join(",");
          const asDef = byRun.get(blockKey);
          const inner = [];
          let after;
          if (asDef) {
            inner.push(asDef.name);
            after = defEnd.get(asDef.name) ?? st;
            if (it.brk) throw new Error("internal: a break inside a def block");
          } else if (it.tieLoop) {
            const block = [untie(it.block[0]), ...it.block.slice(1)];
            const a = writeItems(block, st, true, block, lastPiece(block));
            inner.push(...a.lines);
            inner[inner.length - 1] += " ~";
            after = a.st;
          } else {
            const front = it.block.slice(0, it.brk ?? it.block.length);
            const a = writeItems(front, st, true, it.block, lastPiece(it.block));
            inner.push(...a.lines);
            after = a.st;
            if (it.brk) {
              inner.push("(break)");
              const b = writeItems(it.block.slice(it.brk), a.st, false);
              inner.push(...b.lines);
              // The body is compiled once: after the loop the octave and
              // velocity are where its end leaves them, though the last pass
              // stops at the break. The switches written to the chip are the
              // ones the last pass played — the front's last note's (unknown
              // when the front is all rests: then the next note states them).
              const rt = lastPiece(front)?.st;
              after = rt ? { ...b.st, st: [...b.st.st.filter(baked), ...rt.filter((t) => !baked(t))] }
                : b.st.st.every(baked) ? b.st : { ...b.st, st: [] };
            }
          }
          // Tied on by its own `~` — or by the loop before's last one.
          const tieOn = it.tieLoop && !(idx > 0 && items[idx - 1].tieLoop);
          got = { lines: [`${tieOn ? "~ " : ""}(x ${it.count}`, ...inner.map((l) => "  " + l)], st: after };
          got.lines[got.lines.length - 1] += ")";
        }
        if (prefix.length) got.lines[0] = `${prefix.join(" ")} ${got.lines[0]}`;
        lines.push(...got.lines);
        st = got.st;
      });
      return { lines, st };
    };

    // Defs first (each written from its own head), in order of creation —
    // a later def may name an earlier one.
    const zero = { oct: 4, vel: 15, st: [] };
    const defTexts = [];
    for (const d of defs) {
      // A block that is exactly this def's run is written as the def; the
      // def's own items must not name it.
      byRun.delete(d.runKey);
      const w = writeItems(d.items, zero, true, d.items, null, true);
      byRun.set(d.runKey, d);
      // A def of rests leaves the state as it found it (it is played in place).
      if (lastPiece(d.items)) defEnd.set(d.name, w.st);
      defTexts.push(`(def ${d.name}\n${w.lines.map((l) => "  " + l).join("\n")})`);
    }
    if (defTexts.length) out.push("", `; ${tr.channel}`, ...defTexts);

    const body = [];
    let st = zero;
    // The track opens stating everything; the loop point (`#top`) is come
    // back to from the end.
    const end = lastPiece(lists.flat());
    segs.forEach((_, si) => {
      const top = segs.length > 1 ? si === 1 : loopTick === 0;
      const w = writeItems(lists[si], st, true, lists[si], top ? end : null, si === 0, si === 0);
      if (top) w.lines[0] = `#top ${w.lines[0]}`;
      body.push(...w.lines);
      st = w.st;
    });
    if (loopTick != null) body.push("(go top)");
    forms.push("", `(${[tr.channel, ...(tr.open ?? []), `:len ${lenToken(defLen)}`].join(" ")}`, ...body.map((l) => "  " + l));
    forms[forms.length - 1] += ")";
  }
  return [...out, ...forms].join("\n") + "\n";
}

// ── Pitch shapes: vibrato and bends ───────────────────────────────────────
// A note's pitch as cents from its own, a frame (1/60 s) each — what a VGM
// driver or a MIDI file's pitch bend did to it — drawn as a `:pitch` macro.
// Structure over exactness: a wobble is a vibrato, a sine whose depth (20
// cents) and period (the frame pair) are rounded so notes share one def; any
// other move is a few straight lines.

// A wobble: swings around a centre, at least three (a cycle and a half),
// each a like length — after a wait that may hold the note still first.
function vibratoOf(c) {
  const sorted = [...c].sort((a, b) => a - b);
  const centre = sorted[sorted.length >> 1];
  const d = c.map((v) => v - centre);
  const swings = []; // [frame, sign]
  let sign = 0;
  for (let f = 0; f < d.length; f++) {
    if (Math.abs(d[f]) < 6) continue;
    const sg = Math.sign(d[f]);
    if (sg !== sign) { swings.push(f); sign = sg; }
  }
  if (swings.length < 3) return null;
  const halves = [];
  for (let i = 1; i < swings.length; i++) halves.push(swings[i] - swings[i - 1]);
  const hs = [...halves].sort((a, b) => a - b);
  const half = hs[hs.length >> 1];
  if (half < 1 || halves.some((h) => h > half * 1.6 + 1 || h < half * 0.5 - 1)) return null;
  // Depth: the swings' peaks.
  const peaks = [];
  for (let i = 0; i < swings.length; i++) {
    const a = swings[i], b = swings[i + 1] ?? d.length;
    let m = 0;
    for (let f = a; f < b; f++) m = Math.max(m, Math.abs(d[f]));
    peaks.push(m);
  }
  const ps = [...peaks].sort((a, b) => a - b);
  const depth = Math.max(20, Math.round(ps[ps.length >> 1] / 20) * 20);
  // Before the wobble: held where the note starts.
  const wait = Math.max(0, swings[0] - Math.round(half / 2));
  if (c.slice(0, wait).some((v) => Math.abs(v - c[0]) > 15)) return null;
  const mid = Math.round(centre / 10) * 10;
  return { kind: "vib", centre: Math.abs(mid) <= 20 ? 0 : mid, depth, period: Math.max(2, 2 * half),
    wait: Math.round(wait / 2) * 2 };
}

// A few straight lines through the pitch: the fewest (up to six) within
// 15 cents of it, else within more.
function linesOf(c) {
  for (const tol of [15, 25, 40, 60, 100]) {
    const pts = simplify(c, tol);
    if (pts.length <= 7) return { kind: "lines", pts: pts.map((f) => [f, Math.round(c[f] / 5) * 5]) };
  }
  // Too busy to draw in lines: step it, a frame a value.
  return { kind: "steps", values: c.map((v) => Math.round(v / 5) * 5) };
}

/** Douglas–Peucker over frames: the frames a polyline keeps. */
function simplify(c, tol) {
  const keep = new Set([0, c.length - 1]);
  const rec = (a, b) => {
    let worst = -1, at = -1;
    for (let f = a + 1; f < b; f++) {
      const line = c[a] + ((c[b] - c[a]) * (f - a)) / (b - a);
      const e = Math.abs(c[f] - line);
      if (e > worst) { worst = e; at = f; }
    }
    if (worst > tol) { keep.add(at); rec(a, at); rec(at, b); }
  };
  rec(0, c.length - 1);
  return [...keep].sort((a, b) => a - b);
}

export const PITCH_NONE = "(macro :pitch none)";

/**
 * The notes' bends (`bend`: cents a frame, or `vib`: a vibrato given) →
 * `:pitch` macros. A vibrato is
 * a def by its depth and period (`vib-…`), so notes share it. Any other
 * shape is drawn in lines; a note cut short plays the start of a longer
 * one's (within 10 cents a frame), so it names that; a shape two notes play
 * is a def (`bend-NN`), one only one plays is written on the note. Sets
 * `bendName`; returns the defs.
 */
export function assignBends(notes) {
  const defs = [];
  const vibs = new Map();
  const shapes = [];
  const fits = (a, c) => a.every((v, f) => Math.abs(v - c[Math.min(f, c.length - 1)]) <= 10);
  const others = [];
  for (const n of notes) {
    if (!n.bend && !n.vib) continue;
    // A vibrato given (a MIDI modulation), else one read from the bend.
    const v = n.bend ? vibratoOf(n.bend) : n.vib;
    if (v) {
      const spec = bendSpec(v);
      if (!vibs.has(spec)) {
        const name = `vib-${v.depth}-${v.period}${v.wait ? `-w${v.wait}` : ""}${v.centre ? `${v.centre > 0 ? "+" : ""}${v.centre}` : ""}`;
        vibs.set(spec, name);
        defs.push(`(def ${name} (macro :pitch ${spec}))`);
      }
      n.bendName = vibs.get(spec);
    } else others.push(n);
  }
  // Longest first, so every shape is at least as long as the note tried on
  // it. A fit is within 10 cents a frame, so only the shapes whose first
  // frame (and, for a note longer than 8 frames, ninth) lies in the 10-cent
  // bucket of the note's or one either side can fit: those are tried, in
  // the order the shapes were made.
  const bucket = (v) => Math.floor(v / 10);
  const by0 = new Map(), by08 = new Map();
  const index = (m, k, c) => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
  const near = (a) => {
    if (!a.length) return shapes;
    const b0 = bucket(a[0]), b8 = a.length > 8 ? bucket(a[8]) : null;
    const out = [];
    for (let i = -1; i <= 1; i++) {
      if (b8 == null) out.push(...(by0.get(b0 + i) ?? []));
      else for (let j = -1; j <= 1; j++) out.push(...(by08.get(`${b0 + i},${b8 + j}`) ?? []));
    }
    return out.sort((x, y) => x.i - y.i);
  };
  for (const n of [...others].sort((x, y) => y.bend.length - x.bend.length)) {
    let c = near(n.bend).find((sh) => fits(n.bend, sh.frames));
    if (!c) {
      shapes.push((c = { frames: n.bend, notes: [], i: shapes.length }));
      if (n.bend.length) {
        index(by0, bucket(n.bend[0]), c);
        if (n.bend.length > 8) index(by08, `${bucket(n.bend[0])},${bucket(n.bend[8])}`, c);
      }
    }
    c.notes.push(n);
  }
  let k = 0;
  for (const c of shapes) {
    const lines = linesOf(c.frames);
    // Drawn, it moves 30 cents or less: none.
    const vals = lines.kind === "lines" ? lines.pts.map(([, v]) => v) : lines.values;
    if (Math.max(...vals) - Math.min(...vals) <= 30) continue;
    const spec = bendSpec(lines);
    if (!spec) continue;
    let tok = `(macro :pitch ${spec})`;
    if (c.notes.length >= 2) {
      const name = `bend-${String(++k).padStart(2, "0")}`;
      defs.push(`(def ${name} ${tok})`);
      tok = name;
    }
    for (const n of c.notes) n.bendName = tok;
  }
  return defs;
}

/** A bend as a `:pitch` macro spec (what follows `(macro :pitch `). */
function bendSpec(b) {
  if (b.kind === "vib")
    return `(sin ${b.centre - b.depth}..${b.centre + b.depth} :len ${b.period}f${b.wait ? ` :wait ${b.wait}f` : ""})`;
  if (b.kind === "steps") return `[${b.values.join(" ")}]`;
  // Lines: a stage each; a level held is a wait. A curve plays both its
  // ends, so a line on from the one before starts a frame in (`at`: the
  // frame the next stage's first value lands on).
  const st = [];
  const { pts } = b;
  let at = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [f0, v0] = pts[i], [f1, v1] = pts[i + 1];
    const len = f1 - f0;
    if (v0 === v1 && (i > 0 || v0 === 0)) { st.push(`(wait ${len}f)`); at = at > f0 ? f1 + 1 : f1; }
    else if (at > f0) { st.push(`(linear ${Math.round(v0 + (v1 - v0) / len)}..${v1} :len ${len}f)`); at = f1 + 1; }
    else { st.push(`(linear ${v0}..${v1} :len ${len + 1}f)`); at = f1 + 1; }
  }
  while (st.length && st[st.length - 1].startsWith("(wait")) st.pop(); // the last value holds
  if (!st.length) return null;
  // One line after a wait reads best as the line with its own `:wait`.
  if (st.length === 2 && st[0].startsWith("(wait") && st[1].startsWith("(linear"))
    return st[1].replace(/\)$/, ` :wait ${st[0].match(/\d+/)[0]}f)`);
  return st.length === 1 ? st[0] : `[${st.join(" ")}]`;
}

// For the plain writer: each note's switches that changed, as `pre`.
export function withPre(song) {
  return {
    ...song,
    tracks: song.tracks.map((tr) => {
      let cur = tr.notes[0]?.state ?? [];
      const notes = tr.notes.map((n, i) => {
        const pre = i ? stateChange(cur, n.state) : undefined;
        cur = n.state;
        return { ...n, pre };
      });
      return { ...tr, head: tr.notes[0]?.state ?? [], notes };
    }),
  };
}

// A macro target no note of the track sets needs no `none` either. A def
// names its target by its prefix (switchKind).
const DEF_TARGET = { vol: "vol", env: "vel", bend: "pitch", vib: "pitch" };
const macroTarget = (x) => (x.startsWith("(macro :") ? (x.endsWith(" none)") ? null : /^\(macro :([a-z]+)/.exec(x)[1])
  : DEF_TARGET[/^([a-z]+)-/.exec(x)?.[1]] ?? null);
export function dropIdleNones(notes) {
  const idle = ["pitch", "vel", "vol"].filter((t) => !notes.some((n) => n.state.some((x) => macroTarget(x) === t)));
  if (!idle.length) return notes;
  const nones = new Set(idle.map((t) => `(macro :${t} none)`));
  return notes.map((n) => ({ ...n, state: n.state.filter((x) => !nones.has(x)) }));
}
