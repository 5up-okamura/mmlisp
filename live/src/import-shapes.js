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

// ── A level that moves, as a macro vector ─────────────────────────────────

/**
 * Values a sample apart — a frame, a tick (`unit`), or `stride` of them —
 * as a macro vector's items, straight where they run straight: every
 * importer's one way to write a level that moves. A span of four samples or
 * more through three levels or more, which the line between its ends
 * follows — through each stair, to within half a step (fits) — is one
 * `(linear a..b :len N)` (its samples run from its first value to its last:
 * it reaches its end on its Nth); the rest are values and their holds,
 * `(wait N)`.
 * `round` makes a value the step written, `fmt` writes it. `keepEnd`: the
 * last value's hold is written — the time before what follows (a loop's
 * length) — else the last value just holds.
 */
export function lineItems(values, { unit = "f", stride = 1, round = (x) => x, fmt = String, keepEnd = false } = {}) {
  const out = [];
  const flat = [];
  const holds = (vals, end) => {
    for (let i = 0; i < vals.length;) {
      let j = i + 1;
      while (j < vals.length && vals[j] === vals[i]) j++;
      out.push(fmt(vals[i]));
      if (j - i > 1 && (j < vals.length || end)) out.push(`(wait ${(j - i - 1) * stride}${unit})`);
      i = j;
    }
  };
  // Samples s..e (both played) on the line between values[s] and values[e]:
  // at each, within half a step of the stair it is on — its value, or
  // between it and the level before or after it in the span. A chip plays
  // a level in steps, so a line through a staircase plays it again (each
  // change where the line crosses the stair).
  // (Where each value's stair begins and ends: the levels either side.)
  const L = values.length;
  const before = new Int32Array(L), after = new Int32Array(L);
  for (let k = 0; k < L; k++) before[k] = k > 0 && values[k - 1] === values[k] ? before[k - 1] : k - 1;
  for (let k = L - 1; k >= 0; k--) after[k] = k < L - 1 && values[k + 1] === values[k] ? after[k + 1] : k + 1;
  const fits = (s, e) => {
    for (let k = s + 1; k < e; k++) {
      const at = values[s] + ((values[e] - values[s]) * (k - s)) / (e - s);
      const p = Math.max(s, before[k]), n = Math.min(e, after[k]);
      const lo = Math.min(values[p], values[k], values[n]) - 0.5, hi = Math.max(values[p], values[k], values[n]) + 0.5;
      if (at < lo || at > hi) return false;
    }
    return true;
  };
  const levels = (s, e) => new Set(values.slice(s, e + 1).map(round)).size;
  let i = 0;
  while (i < values.length) {
    let e = i + 1;
    while (e + 1 < values.length && fits(i, e + 1)) e++;
    // (Not into the last value's hold: it reaches the end no later than the
    // values do, and holds there.)
    if (e === values.length - 1) while (e - 1 > i && values[e - 1] === values[e]) e--;
    if (e < values.length && e - i >= 3 && levels(i, e) >= 3 && fits(i, e)) {
      holds(flat.splice(0), true);
      out.push(`(linear ${fmt(values[i])}..${fmt(values[e])} :len ${(e - i + 1) * stride}${unit})`);
      i = e + 1;
    } else flat.push(round(values[i++]));
  }
  holds(flat, keepEnd);
  return out;
}

/**
 * A level's frames as one `(macro …)` on `target` (`:vol`, `:vel+` …):
 * `head` from the key-on — its sustain loop from `loopAt`, or `hold` held
 * while the key is — and `rel` from the key-off. On the coarsest clock
 * every change lands on (`:step Nf`, a step a sample), written as
 * lineItems on it. `flat`: the level, where it is one value and no more.
 */
export function levelMacro(target, { head, loopAt = null, hold = null, rel = null }, { round, fmt } = {}) {
  const runs = (a) => {
    const out = [];
    for (const v of a) {
      if (out.length && out[out.length - 1][0] === v) out[out.length - 1][1]++;
      else out.push([v, 1]);
    }
    return out;
  };
  const pre = loopAt == null ? head : head.slice(0, loopAt), loop = loopAt == null ? [] : head.slice(loopAt);
  // The runs whose lengths are heard: an open end (the head's before the
  // key-off, the release's last) holds however long.
  const heard = [...runs(pre).slice(0, loopAt != null || hold != null ? undefined : -1), ...runs(loop), ...runs(rel ?? []).slice(0, -1)];
  const step = heard.reduce((g, [, k]) => gcd(g, k), 0) || 1;
  const thin = (a) => a.filter((_, i) => i % step === 0);
  const o = { stride: step, round, fmt };
  const body = [...lineItems(thin(pre), { ...o, keepEnd: loopAt != null || hold != null })];
  if (loopAt != null) body.push("#sus", ...lineItems(thin(loop), { ...o, keepEnd: true }));
  else if (hold != null) body.push("#sus", (fmt ?? String)(hold));
  if (rel?.length) body.push("#rel", ...lineItems(thin(rel), o));
  const flat = loopAt == null && hold == null && !rel?.length && new Set(head).size === 1 ? head[0] : null;
  return { flat, text: `(macro${step > 1 ? ` :step ${step}f` : ""} :${target} [${body.join(" ")}])` };
}

// ── Macros written more than once, as defs ────────────────────────────────

// A curve macro's def name, read off its curve: a pitch line a bend (up or
// down to where it goes), any other pitch curve a vibrato, a :vel curve a tremolo
// (to its widest), then its length, its phase where it does not start as the
// shape's vibrato does (a triangle from the middle rising, a saw from its
// middle; a triangle falling is `-down`, as import-song names one) and its wait.
const SHAPE = { triangle: "tri", saw: "saw", square: "sq", sin: "sin" };
const CURVE = /^\(macro :(pitch|vel)\+? \((linear|triangle|saw|square|sin) (-?[\d.]+)\.\.(-?[\d.]+) :len (\S+?)(?: :phase (\d+))?(?: :wait (\S+?))?\)\)$/;
const OWN_PHASE = { pitch: { triangle: 64, saw: 128 } };
function macroName(x) {
  const m = CURVE.exec(x);
  if (!m) return null;
  const [, target, curve, a, b, len, phase = "0", wait] = m;
  const own = OWN_PHASE[target]?.[curve] ?? 0;
  const p = Number(phase) === own ? "" : curve === "triangle" && target === "pitch" && phase === "192" ? "-down" : `-p${phase}`;
  const w = wait ? `-w${wait}` : "";
  const cents = (v) => `${v < 0 ? "down" : "up"}${Math.abs(v)}`;
  if (target === "pitch" && curve === "linear") return `bend-${Number(a) ? `${cents(a)}-` : ""}${cents(b)}-${len}${w}`;
  const amp = Math.max(Math.abs(a), Math.abs(b));
  return `${target === "pitch" ? "vib" : "trem"}-${SHAPE[curve] ?? curve}-${amp}-${len}${p}${w}`;
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
 * `(def env-01 (macro :vel+ [0 (linear -1..-4 :len 4f) #sus -4 #rel -5 -7]))`,
 * as every importer writes a level (levelMacro), on a coarser `:step` when
 * every change is.
 */
function envDef(name, { head, sus, rel }) {
  return `(def ${name} ${levelMacro("vel+", { head, hold: sus, rel }).text})`;
}
