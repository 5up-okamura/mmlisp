// What the song importers share between reading a file and writing the
// score (import-song.js): the defs a score names, keyed by what they hold,
// and the small notations every importer writes the same way.

import { gcd } from "./import-song.js";

/**
 * A score's defs, in the order they are first named. `of(key, make)` gives
 * the def `key` stands for, made on its first use: `make()` returns what the
 * caller keeps for it — `{ name, text }` puts `text` in the score, anything
 * else (a ROM voice's name, a level, null for a missing one) is kept only.
 * `uniq(base)` a name no def has taken; `taken` the names the score has
 * already (a preset's).
 */
export function defTable(taken = []) {
  const used = new Set(taken);
  const byKey = new Map();
  const texts = [];
  return {
    uniq(base) {
      let n = base;
      for (let k = 2; used.has(n); k++) n = `${base}-${k}`;
      used.add(n);
      return n;
    },
    of(key, make) {
      if (!byKey.has(key)) {
        const d = make();
        byKey.set(key, d);
        if (d?.text) texts.push(d.text);
      }
      return byKey.get(key);
    },
    /** A def no key names: written once, where it is added. */
    add(text) { texts.push(text); },
    texts,
  };
}

/** Text in Shift-JIS, as an X68000's or an MSX's file holds it. */
export const sjis = (u8) => { try { return new TextDecoder("shift-jis").decode(u8); } catch { return String.fromCharCode(...u8); } };

/**
 * Frame values as a macro vector: a run of one value is the value and a
 * wait; `sus` the frame `#sus` goes before.
 */
export function frameVector(values, sus) {
  const items = [];
  for (let k = 0; k < values.length; ) {
    if (k === sus) items.push("#sus");
    let n = 1;
    while (k + n < values.length && values[k + n] === values[k] && k + n !== sus) n++;
    items.push(String(values[k]));
    // The last value holds: a wait at the end only keeps a loop's length.
    if (n > 1 && (k + n < values.length || sus != null)) items.push(`(wait ${n - 1}f)`);
    k += n;
  }
  return `[${items.join(" ")}]`;
}

// ── Macros written more than once, as defs ────────────────────────────────

// A curve macro's def name, read off its curve: a pitch line a bend (up or
// down to where it goes), any other pitch curve a vibrato, a :vel curve a tremolo
// (to its widest), then its length and wait.
const SHAPE = { triangle: "tri", saw: "saw", square: "sq", sin: "sin" };
const CURVE = /^\(macro :(pitch|vel)\+? \((linear|triangle|saw|square|sin) (-?[\d.]+)\.\.(-?[\d.]+) :len (\S+?)(?: :phase \d+)?(?: :wait (\S+?))?\)\)$/;
function macroName(x) {
  const m = CURVE.exec(x);
  if (!m) return null;
  const [, target, curve, a, b, len, wait] = m;
  const w = wait ? `-w${wait}` : "";
  const cents = (v) => `${v < 0 ? "down" : "up"}${Math.abs(v)}`;
  if (target === "pitch" && curve === "linear") return `bend-${Number(a) ? `${cents(a)}-` : ""}${cents(b)}-${len}${w}`;
  const amp = Math.max(Math.abs(a), Math.abs(b));
  return `${target === "pitch" ? "vib" : "trem"}-${SHAPE[curve] ?? curve}-${amp}-${len}${w}`;
}

/**
 * A curve macro the score writes twice or more becomes a def, named by its
 * curve (macroName), and the notes name it. A write is where a note's macro
 * is not the one before it on its track. `tracks`: `{ notes: [{ state }] }`.
 */
export function hoistMacros(tracks, defs) {
  const writes = new Map();
  for (const t of tracks) {
    let before = new Set();
    for (const n of t.notes) {
      const now = new Set(n.state.filter((x) => CURVE.test(x)));
      for (const x of now) if (!before.has(x)) writes.set(x, (writes.get(x) ?? 0) + 1);
      before = now;
    }
  }
  const names = new Map();
  for (const [x, k] of writes)
    if (k >= 2) names.set(x, defs.of(`macro:${x}`, () => { const name = defs.uniq(macroName(x)); return { name, text: `(def ${name} ${x})` }; }).name);
  if (!names.size) return;
  for (const t of tracks) for (const n of t.notes) n.state = n.state.map((x) => names.get(x) ?? x);
}

// ── Level shapes ─────────────────────────────────────────────────────────

const ENV_KEY = 4; // frames assignEnvelopes indexes its shapes by

/**
 * The notes' envelopes (`env`: :vel+ offsets a frame) → shared defs. A
 * driver's envelope is a way in, a level it holds, and a way out once the
 * note is let go: a run held four frames or more is that level (`#sus`),
 * and on the PSG what comes after it is the release (`#rel`) — the note is
 * keyed off where it starts, so notes of any length share the shape. A note
 * cut short plays the start of a longer one's, so it names that: the most
 * used shape it is the start of. Sets `envName` (and `relFrame`, where the
 * note is let go) on the notes that move; returns the defs.
 */
export function assignEnvelopes(notes) {
  const moving = notes.filter((n) => n.env?.some((v) => v !== 0));
  for (const n of moving) n.shape = shapeOf(n.env, n.canRelease);
  const fits = (n, c) => {
    if (n.shape.rel) return !!c.rel && same(n.shape.head, c.head) && n.shape.sus === c.sus && same(n.shape.rel, c.rel);
    // A note that stops dead (its level to 0, then a rest) takes no shape
    // with a release: that would sound on after it.
    if (c.rel && n.silentAfter) return false;
    return n.env.every((v, f) => v === (f < c.head.length ? c.head[f] : c.sus));
  };
  // A fit plays the shape's first ENV_KEY frames exactly, so a note that
  // long is tried only on the shapes that start so; a shorter one, on all.
  const keyOf = (env) => env.join(",");
  const startOf = (c) => {
    const a = [];
    for (let f = 0; f < ENV_KEY; f++) a.push(f < c.head.length ? c.head[f] : c.sus);
    return keyOf(a);
  };
  const noteKey = (n) => (n.shape.rel ? startOf(n.shape) : n.env.length >= ENV_KEY ? keyOf(n.env.slice(0, ENV_KEY)) : null);
  const indexed = (list) => {
    const by = new Map();
    for (const c of list) {
      const k = startOf(c);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(c);
    }
    return (n) => { const k = noteKey(n); return k == null ? list : by.get(k) ?? []; };
  };
  const shapes = [];
  const by = new Map();
  // Whole shapes first, longest first: a shorter note may be the start of one.
  const order = [...moving].sort((x, y) => (y.shape.rel ? 1 : 0) - (x.shape.rel ? 1 : 0) || y.env.length - x.env.length);
  for (const n of order) {
    const k = noteKey(n);
    let c = (k == null ? shapes : by.get(k) ?? []).find((sh) => fits(n, sh));
    if (!c) {
      shapes.push((c = { ...n.shape, uses: 0 }));
      const sk = startOf(c);
      if (!by.has(sk)) by.set(sk, []);
      by.get(sk).push(c);
    }
    c.uses++;
  }
  shapes.sort((x, y) => y.uses - x.uses || x.head.length - y.head.length);
  const near = indexed(shapes);
  const named = new Map();
  for (const n of moving) {
    const c = near(n).find((sh) => fits(n, sh));
    if (!named.has(c)) named.set(c, `env-${String(named.size + 1).padStart(2, "0")}`);
    n.envName = named.get(c);
    if (n.shape.rel) n.relFrame = n.shape.relAt;
  }
  return [...named].map(([c, name]) => envDef(name, c));
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** An envelope's way in, the level it holds, and (`release`) its way out. */
export function shapeOf(env, release) {
  let best = null;
  for (let i = 0; i < env.length; ) {
    let j = i + 1;
    while (j < env.length && env[j] === env[i]) j++;
    if (j - i >= 4 && (!best || j - i > best.e - best.s)) best = { s: i, e: j };
    i = j;
  }
  if (best && release && best.e < env.length)
    return { head: env.slice(0, best.s), sus: env[best.s], rel: env.slice(best.e), relAt: best.e };
  // Held to the end: the run it ends on is the level.
  let L = env.length;
  while (L > 1 && env[L - 2] === env[L - 1]) L--;
  return { head: env.slice(0, L - 1), sus: env[L - 1], rel: null };
}

/**
 * `(def env-01 (macro :vel+ [0 -1 -2 #sus -3 #rel -5 -7]))`, on a coarser
 * `:step` when every change is.
 */
function envDef(name, { head, sus, rel }) {
  const runs = (a) => {
    const out = [];
    for (const v of a) {
      if (out.length && out[out.length - 1][0] === v) out[out.length - 1][1]++;
      else out.push([v, 1]);
    }
    return out;
  };
  const parts = [runs(head), runs(rel ?? [])];
  const step = parts.flat().reduce((g, [, k]) => gcd(g, k), 0) || 1;
  const vals = (r) => r.flatMap(([v, k]) => new Array(k / step).fill(v));
  const body = [...vals(parts[0]), "#sus", sus, ...(rel ? ["#rel", ...vals(parts[1])] : [])];
  return `(def ${name} (macro${step > 1 ? ` :step ${step}f` : ""} :vel+ [${body.join(" ")}]))`;
}
