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
export const WHOLE = PPQN * 4;

const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

/** A MIDI note's octave in MMLisp terms (`:oct 4` holds MIDI 60). */
export const octOf = (midi) => Math.floor(midi / 12) - 1;
export const noteName = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12];

/** A length in ticks as written after a note: `4`, `8.`, `3/2`, or `Nt`. */
export function lenToken(d) {
  if (d <= 0) return "0";
  if (WHOLE % d === 0) return String(WHOLE / d);
  if ((d * 2) % 3 === 0 && WHOLE % ((d * 2) / 3) === 0) return `${WHOLE / ((d * 2) / 3)}.`;
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
 * @param notes  [{tick, len, midi, vel?, pre?: string[]}], sorted, no overlap
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
    } else if (i < notes.length && notes[i].tick <= t) {
      const n = notes[i++];
      held = n;
      const start = t; // a note quantized onto an earlier one starts here
      if (n.pre?.length) {
        line.push(...n.pre);
        lastPre = n.pre;
      }
      if (n.vel != null && n.vel !== vel) {
        line.push(`:vel ${n.vel}`);
        vel = n.vel;
      }
      const end = Math.min(n.tick + n.len, b);
      if (end <= start) continue;
      line.push(pitch(n.midi) + len(end - start));
      t = end;
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
export function emitSong(song) {
  const out = [...song.header];
  for (const tr of song.tracks) {
    const notes = tr.notes;
    const first = notes.find((n) => n.midi != null);
    const oct = first ? octOf(first.midi) : 4;
    const defLen = commonLen(notes, song.bars, song.endTick);
    const vel = notes.find((n) => n.vel != null)?.vel ?? 15;
    const body = writeBody(notes, {
      bars: song.bars, endTick: song.endTick, loopTick: song.loopTick ?? null,
      marks: tr.marks ?? [], defLen, oct, vel, pre: tr.head,
    });
    const head = [tr.channel, ...tr.head, `:oct ${oct}`, `:len ${lenToken(defLen)}`];
    if (vel !== 15) head.push(`:vel ${vel}`);
    if (song.loopTick != null) body.push("(go top)");
    out.push("", `(${head.join(" ")}`, ...body.map((l) => "  " + l));
    out[out.length - 1] += ")";
  }
  return out.join("\n") + "\n";
}
