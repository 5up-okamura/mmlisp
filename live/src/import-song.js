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

export const PPQN = 96; // must match mmlisp2ir.js
/** The time base estimateGrid works in: onsets in samples at this rate. */
export const RATE = 44100;
export const WHOLE = PPQN * 4;

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
export function writeBody(notes, opts) {
  const { bars = [], endTick, loopTick = null, marks = [], defLen } = opts;
  const bounds = new Set([...bars, endTick]);
  for (const m of marks) bounds.add(m.tick);
  if (loopTick != null) bounds.add(loopTick);
  const sortedBounds = [...bounds].filter((b) => b > 0 && b <= endTick).sort((a, b) => a - b);
  // A PCM track's notes are shots, which play out whatever their length, so
  // a note there ends at the next bound rather than tie across it.
  if (opts.noTie) {
    notes = notes.map((n) => {
      const b = sortedBounds.find((x) => x > n.tick) ?? endTick;
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
      if (vel !== opts.vel || lastPre.length) line.push(`:vel ${vel}`);
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
        line.push(`:vel ${n.vel}`);
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
export function commonLen(notes, bars, endTick) {
  const count = new Map();
  for (const n of notes) {
    // Count the piece up to the next bar end, as writeBody splits it.
    const b = bars.find((x) => x > n.tick) ?? endTick;
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

/**
 * The whole score.
 *
 * @param song {
 *   header: string[]        top-level lines (comments, title, imports, defs)
 *   bars: number[]          bar end ticks
 *   endTick, loopTick?
 *   tracks: [{channel, head: string[], notes, marks?, vel?}]
 * }
 */
// The compiler's octaves run 0 up: a note below (a slide's tail, a deep
// drum sweep) is folded up an octave at a time — written as it is, every
// relative octave after it would land one too high.
const playable = (m) => (m == null ? m : m < 12 ? playable(m + 12) : m > 127 ? playable(m - 12) : m);
const inRange = (notes) => (notes.every((n) => n.midi == null || (n.midi >= 12 && n.midi <= 127)) ? notes
  : notes.map((n) => ({ ...n, midi: playable(n.midi) })));
const songInRange = (song) => ({ ...song, tracks: song.tracks.map((tr) => ({ ...tr, notes: inRange(tr.notes) })) });

export function emitSong(song) {
  song = songInRange(song);
  const out = [...song.header];
  for (const tr of song.tracks) {
    const notes = tr.notes;
    const first = notes.find((n) => n.midi != null);
    const oct = first ? octOf(first.midi) : 4;
    const defLen = commonLen(notes, song.bars, song.endTick);
    const vel = notes.find((n) => n.vel != null)?.vel ?? 15;
    const body = writeBody(notes, {
      bars: song.bars, endTick: song.endTick, loopTick: song.loopTick ?? null,
      marks: tr.marks ?? [], defLen, oct, vel, pre: tr.head, noTie: tr.channel.startsWith("pcm"),
    });
    const head = [tr.channel, ...tr.head, `:oct ${oct}`, `:len ${lenToken(defLen)}`];
    if (vel !== 15) head.push(`:vel ${vel}`);
    if (song.loopTick != null) body.push("(go top)");
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
        bars: sg.bars, endTick: sg.len, marks: sg.marks ?? [], defLen, oct, vel, pre,
      });
      const head = [...pre, `:oct ${oct}`, `:vel ${vel}`].join(" ");
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
  const unit = best.u;

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

  // Walk: each onset's unit, the unit's length following as it goes. A gap
  // under half a unit (a part played a little late) is the same unit.
  const at = [0];
  const len = [unit];
  let u = unit;
  for (let i = 1; i < merged.length; i++) {
    const d = merged[i] - merged[i - 1];
    const k = Math.round(d / u);
    at.push(at[i - 1] + k);
    // A little of each gap's own unit, never far from the song's.
    if (k > 0) u = Math.min(unit * 1.1, Math.max(unit * 0.9, u + 0.1 * (d / k - u)));
    len.push(u);
  }
  const units = (t) => {
    if (t <= merged[0]) return Math.round((t - merged[0]) / unit);
    let lo = 0, hi = merged.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (merged[mid] <= t) lo = mid; else hi = mid - 1; }
    return at[lo] + Math.round((t - merged[lo]) / len[lo]);
  };

  // Whichever grid keeps the onsets' gaps best, a fixed one on a tie (a
  // timer that drifts loses count on any fixed grid).
  const grids = [fixedGrid(fixedU), fixedGrid(scanU), { u: unit, units }].filter(Boolean);
  const pick = grids.map((gr) => ({ gr, n: misses(gr) })).reduce((a, b) => (b.n < a.n ? b : a)).gr;
  return readingsOf(pick.u, { fit: best.fit, frames: false, units: pick.units });
}

// The unit as a note: whatever puts the beat in 80-160 BPM, a 16th first;
// the other readings (double, half, … the tempo) ride along.
function readingsOf(unit, grid) {
  const asNote = [[4, 24], [2, 48], [8, 12], [3, 32], [6, 16], [1, 96], [16, 6], [12, 8], [32, 3], [24, 4]];
  const options = asNote.map(([perBeat, ticks]) => ({ unitTicks: ticks, bpm: (60 * RATE) / (unit * perBeat) }));
  const pick = options.find((o) => o.bpm >= 80 && o.bpm <= 160) ?? options[0];
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
// A song written with its repeats folded (user, 2026-10-07: "the more
// structured, the easier to grasp"). Each track is cut into units — its bars,
// and the loop point — compared by what they play (notes at MMLisp's 16
// velocity steps, the voice/state in force, the marks). Then:
//   1. runs that repeat back to back become `(x n …)`, and a run that comes
//      back once more cut short becomes `(x n A (break) B)` (A B A B A);
//   2. a run that comes back elsewhere becomes a `(def …)`, named in place.
// A block restates the state it relies on at its head — a loop's second pass
// arrives with its own end state, and a def plays wherever it is named. A
// unit that starts tied (or slurred) on from the one before cannot head one.

const MAX_BLOCK = 16; // units in one repeated block or phrase

// A switch's kind: a keyword by its name, a macro (or an `env-` def, an
// imported envelope) by its target, any other name — the voice or the
// sample — as "name".
const switchKind = (t) => t.startsWith(":") ? t.split(" ")[0]
  : t.startsWith("(macro") ? `macro${t.match(/^\(macro\s+(:[a-z-]+|none)/)?.[1] ?? ""}`
    : /^env-\d/.test(t) ? "macro:vel" : "name";

// The switches a note needs written, given those in force: by kind — a
// keyword (`:pan`, `:mode`) by its name, a macro by its target, a bare name
// (a voice, a sample, an envelope def) by its place — only what changed.
// With nothing known in force (after a loop's break), all of them.
function stateChange(from, to) {
  if (!from.length) return to;
  const kind = (toks) => new Map(toks.map((t) => [switchKind(t), t]));
  const a = kind(from), b = kind(to);
  // A different set of kinds (a macro appears or goes): write them all.
  if (a.size !== b.size || [...b.keys()].some((k) => !a.has(k))) return to;
  return [...b].filter(([k, t]) => a.get(k) !== t).map(([, t]) => t);
}

/** Cut a track into units at the bar ends and the loop point. */
function unitsOf(tr, bars, endTick, loopTick) {
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
      // No ties on PCM (writeBody noTie): a shot's tail over the cut is let go.
      if (n.tick < a && tr.channel.startsWith("pcm")) continue;
      // Carried over the cut: tied on — except into the loop, which starts over.
      const tieIn = n.tick < a ? a !== loopTick : !!n.tieIn && (n.tick > a || a !== loopTick);
      pieces.push({ tick: s - a, len: e - s, midi: n.midi, vel: n.vel, st: n.st, tieIn });
    }
    const marks = (tr.marks ?? []).filter((m) => m.tick >= a && m.tick < b).map((m) => ({ ...m, tick: m.tick - a }));
    const tieHead = pieces.length > 0 && pieces[0].tick === 0 && pieces[0].tieIn;
    const key = JSON.stringify([b - a, pieces.map((p) => [p.tick, p.len, p.midi, p.vel, p.st.join(" "), p.tieIn ? 1 : 0]),
      marks.map((m) => [m.tick, m.tokens.join(" ")])]);
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

/**
 * The whole score, structured. Same input as emitSong; a track's notes may
 * carry `state` (every switch in force) or only `pre` (a voice switch).
 */
// One track's structure on a given set of bars: its units, folded and
// phrased, and the ticks it writes out (a loop body and a def once each).
function planTrack(tr, bars, endTick, loopTick) {
  const units = unitsOf(tr, bars, endTick, loopTick);
  const segs = loopTick > 0 ? [units.filter((u) => u.start < loopTick), units.filter((u) => u.start >= loopTick)] : [units];
  const lists = segs.map((s) => foldRepeats(s));
  const defs = extractDefs(lists, tr.channel);
  const written = (items) => items.reduce((t, it) =>
    t + (it.k === "u" ? it.len : it.k === "x" ? written(it.block) : 0), 0);
  const ticks = lists.reduce((t, l) => t + written(l), 0) + defs.reduce((t, d) => t + written(d.items), 0);
  return { segs, lists, defs, ticks };
}

/**
 * Where the bars go when the file does not say (a VGM, a MIDI file timed by
 * its notes): the bar length and pickup under which the song folds most.
 * `|` is editorial, so this changes only how the score reads.
 */
export function bestBars(song) {
  song = songInRange(song);
  const { endTick, loopTick = null } = song;
  let best = null;
  for (const bar of [384, 768, 192, 576, 288]) {
    for (let pickup = 0; pickup < bar; pickup += 96) {
      const bars = [];
      for (let t = pickup || bar; t < endTick; t += bar) bars.push(t);
      bars.push(endTick);
      let ticks = 0;
      for (const tr of song.tracks) ticks += planTrack(tr, bars, endTick, loopTick).ticks;
      // A 4/4 bar reads best: another length has to fold 8% more to win.
      if (bar !== 384) ticks *= 1.08;
      if (!best || ticks < best.ticks) best = { bars, ticks };
    }
  }
  return best.bars;
}

export function emitStructured(song) {
  song = songInRange(song);
  const out = [...song.header];
  const forms = [];
  const loopTick = song.loopTick ?? null;
  for (const tr of song.tracks) {
    const defLen = commonLen(tr.notes, song.bars, song.endTick);
    const { segs, lists, defs } = planTrack(tr, song.bars, song.endTick, loopTick);
    const byRun = new Map(defs.map((d) => [d.runKey, d]));
    // Switches the compiler binds to the notes as it goes (like the octave),
    // not writes the chip gets: a macro, and a PCM track's sample.
    const pcm = tr.channel.startsWith("pcm");
    const baked = (t) => { const k = switchKind(t); return k.startsWith("macro") || (pcm && k === "name"); };

    // Writing: the state carried from item to item, restated at a head.
    const writeUnit = (u, st) => {
      let running = st.st;
      const notes = u.pieces.map((p) => {
        const pre = stateChange(running, p.st);
        running = p.st;
        return { tick: p.tick, len: p.len, midi: p.midi, vel: p.vel, tieIn: p.tieIn, pre };
      });
      const lines = writeBody(notes, { bars: [u.len], endTick: u.len, marks: u.marks, defLen, oct: st.oct, vel: st.vel, pre: st.st });
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
        return { tokens: [...sw, `:oct ${oct}`, `:vel ${p.vel}`], st: { oct, vel: p.vel, st: p.st } };
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
    forms.push("", `(${[tr.channel, `:len ${lenToken(defLen)}`].join(" ")}`, ...body.map((l) => "  " + l));
    forms[forms.length - 1] += ")";
  }
  return [...out, ...forms].join("\n") + "\n";
}
