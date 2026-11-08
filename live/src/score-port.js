// A score of one 4-operator FM machine on another — md, pc88, x68k — at the
// words' level: what the composer wrote (the voices, `:gate`, a glide, a
// `:pitch+` curve, the loop, the formatting and the comments) is kept, and
// only what the other machine has not is read in its words or taken out.
// The VGM road rebuilds a song from its registers; this one moves the text.
//
// Two faces use it: an MDX's Target (the import writes x68k, then this moves
// it) and Edit > Convert to Machine… (the open score). Both show the rows —
// each written channel and where it goes, or drop — and say what was dropped
// or approximated (`said`).
//
// What moves where (the rows' defaults, portRows):
//   a channel the other machine has, of the same kind, stays: fm1 is fm1
//   FM past the other's count (x68k fm7, fm8), FM3's operator tracks onto
//   x68k (each a free FM channel under a one-operator voice made from the
//   patch's), CSM onto x68k (fm3's plain notes) — a free FM channel, else a
//   square as a stand-in; nothing drops while a channel is free
//   a square — a free square, else a free FM channel under presets/waveforms'
//   square
//   the noise — the noise: x68k fm8's `:mode noise` notes too (the track is
//   split: its tone notes stay on the FM row's channel)
//   a sample track — a free sample channel; one that plays only kit roles
//   (kick, snare …) goes to the PC-8801's ROM rhythm, and the ROM rhythm to
//   sample channels playing presets/rx5's kit under the same names
//
// The words (wordRule): a word the destination's part has stays; the OPM's
// `:lfo-freq` is the OPN's nearest `:lfo-rate` (Hz), its depths and wave are
// dropped (the OPN's depth is each voice's :fms / :ams); a noise rate is the
// Mega Drive's nearest white noise and back; the SSG's mixer and envelope,
// DT2, SSG-EG, a sample's pan where the voice has none are dropped and said.
// ---------------------------------------------------------------------------

import { parse } from "./mmlisp-parser.js";
import { TARGETS, partsWithWord } from "./targets.js";
import { canonicalTarget } from "./mmlisp2ir.js";
import { loudDefs } from "./import-song.js";
import { OPN_LFO_HZ, lfoHz } from "./chips/ym2151.js";
import { opllRomVoices } from "./chips/ym2413.js";
import * as fcApu from "./chips/rp2a03.js";
import * as gbApu from "./chips/lr35902.js";
import { voiceTable, onOpll, romOn4op, romForRole, roleOf, opllDefAs4op, FM_ROLES_SET } from "./voice-port.js";

/** The machines a score can be converted between. */
export const PORT_TARGETS = ["md", "pc88", "x68k", "msx", "fc", "gb"];

const WAVEFORMS = "presets/waveforms/set.mmlisp";
const RHYTHM_KIT = "presets/rx5/set.mmlisp"; // the ROM rhythm's roles, as the mucom88 import plays them
const SONG_WORDS = new Set(["LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE", "NOISE_RATE", "ENV_RATE"]);
// Lists whose items are a body's: walked for words, voices and notes. Any
// other list (a curve, an expression, a glide) is a value and kept whole.
const DESCEND = new Set(["x", "t", "macro", "let", "if", "for", "echo", "delay"]);
// The SN76489's white noises (Hz) and the rates (125 kHz / n, the OPM's and
// the SSG's alike) that come nearest them, as the VGM import reads them.
const WHITE_HZ = [13983, 6991, 3496];
const RATE_OF_WHITE = { white0: 9, white1: 18, white2: 31 };
const NOISE_CLOCK = 125000;
const nearestWhite = (hz) => WHITE_HZ.reduce((b, w, i) => (Math.abs(Math.log(w / hz)) < Math.abs(Math.log(WHITE_HZ[b] / hz)) ? i : b), 0);
const nearestLfoRate = (hz) => 1 + OPN_LFO_HZ.reduce((b, w, i) => (Math.abs(Math.log(w / hz)) < Math.abs(Math.log(OPN_LFO_HZ[b] / hz)) ? i : b), 0);

// How a noise's rate is written: the SN76489's `:mode whiteN` / `periodicN`,
// a song-wide `:noise-rate n` (the SSG's, the OPM's, the 5B's: 125 kHz / n),
// or each note's pitch (the 2A03's and the Game Boy's: c2 the slowest).
const PITCHED_NOISE = { "fc-noise": fcApu, "gb-noise": gbApu };
const noiseModel = (part) => (PITCHED_NOISE[part?.name] ? "pitch" : part?.modes && Object.keys(part.modes).some((m) => /^white\d$/.test(m)) ? "mode" : "rate");
const NOISE_RATE_START = 9; // the SSG's and the OPM's rate before one is written
const PITCH_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const midiOfNote = (v, oct) => {
  const [, name] = NOTE.exec(v);
  return 12 * (oct + 1) + SEMI[name[0]] + (name[1] === "+" ? 1 : name[1] === "-" ? -1 : 0);
};

const NOTE = /^([a-g][+-]?)((?:\d+(?:\/\d+)?)?(?:t|f|ms)?\.*)$/;
const isNote = (v) => typeof v === "string" && NOTE.test(v);
const restOf = (v) => `_${NOTE.exec(v)[2]}`;
const num = (node) => (node?.kind === "atom" && /^-?\d+(\.\d+)?$/.test(node.value) ? Number(node.value) : null);
const isList = (n, head) => n?.kind === "list" && n.bracket === "()" && (head == null || n.items[0]?.value === head);
// The two FM families: the OPLL's 2 operators (a ROM of voices, `romNames`)
// and the OPN's and OPM's 4. A voice goes as written within one.
const twoOp = (part) => !!part?.romNames;
const NOISE_SPLIT = "fm8/noise"; // the row of x68k fm8's :mode noise notes
const notes = (n) => `${n} note${n === 1 ? "" : "s"}`;

/** The `:target` a score names, or md. */
export function scoreTargetOf(text) {
  let roots;
  try { roots = parse(text); } catch { return "md"; }
  const score = roots.find((n) => isList(n, "def-score"));
  const at = score?.items.findIndex((n) => n.value === ":target") ?? -1;
  return at >= 0 ? String(score.items[at + 1]?.value ?? "md") : "md";
}

// ── What the score holds ─────────────────────────────────────────────────

// The score's channel forms (top-level, and a section's), its voices and
// samples, and each head's notes — what the rows are read from.
function survey(text, from, imports) {
  const roots = parse(text);
  const others = [...(imports?.values() ?? [])].flatMap((t) => { try { return parse(t); } catch { return []; } });
  const defNames = (nodes, head) => new Set(nodes.filter((n) => isList(n, head) && n.items[1]?.kind === "atom").map((n) => n.items[1].value));
  // The built-in ones too: the OPLL's ROM names, which every FM part has (a
  // 4-op reading where there is no ROM), and a part's own (the VRC7's).
  const romNames = from.parts.filter((p) => p.kind === "fm").flatMap((p) => [...opllRomVoices(p).keys()]);
  const voices = new Set(["init-fm", ...romNames, ...defNames(roots, "def-fm"), ...defNames(others, "def-fm")]);
  const ownSamples = defNames(roots, "def-pcm");
  const samples = new Set([...ownSamples, ...defNames(others, "def-pcm")]);
  // A kit's roles, whichever machine's: a sample track playing them is a
  // kit's track wherever its samples come from.
  const kit = new Set(Object.values(TARGETS).flatMap((t) => t.parts.flatMap((p) => Object.keys(p.kit ?? {}))));
  const isHead = (n) => isList(n) && n.items[0]?.kind === "atom" && from.channelNames.includes(n.items[0].value);
  const forms = [];
  for (const n of roots) {
    if (isHead(n)) forms.push(n);
    else if (isList(n, "def") && n.items[1]?.kind === "atom") forms.push(...n.items.slice(2).filter(isHead));
  }
  const heads = new Map();
  for (const f of forms) {
    const head = f.items[0].value;
    const h = heads.get(head) ?? { head, part: from.partOf(head), forms: [], notes: 0, samples: new Set(), voices: [], noiseMode: false };
    heads.set(head, h);
    h.forms.push(f);
    walk(f.items.slice(1), (n, prev) => {
      if (n.kind !== "atom") return;
      if (isNote(n.value)) h.notes++;
      else if (samples.has(n.value) || kit.has(n.value)) h.samples.add(n.value);
      else if (voices.has(n.value)) h.voices.push(n.value);
      if (prev?.value === ":mode" && n.value === "noise") h.noiseMode = true;
    });
  }
  return { roots, forms, heads, voices, samples, ownSamples, kit };
}

// Every atom of a body, in order, into the lists a body is made of.
function walk(items, fn) {
  let prev = null;
  for (const n of items) {
    if (isList(n) && DESCEND.has(n.items[0]?.value)) walk(n.items.slice(1), fn);
    else fn(n, prev); // a value list (a curve, a glide) is no body
    prev = n;
  }
}

// ── The rows ─────────────────────────────────────────────────────────────

// A machine's channels of one kind a track can be written on: not another
// way of playing one (fm3-1 …), and a kit's only where asked. `board`: only
// the machine's own, not a cartridge's it lists (fc's expansions: the rows
// offer them, the defaults do not, as a song import's).
function channelsOf(target, kind, { kit = false, board = false } = {}) {
  return target.channelNames.filter((h, i) => {
    const p = target.partOf(h);
    if (p.kind !== kind || !!p.kit !== kit) return false;
    if (board && target.listsExpansions && target.chipOf(h).optional) return false;
    return p.kit || !target.channelNames.slice(0, i).some((o) => target.voiceKey(o) === target.voiceKey(h) && target.partOf(o) === p);
  });
}

// The kind of sound a row is.
const kindOf = (from, key) => (key === NOISE_SPLIT ? "noise" : from.partOf(key)?.kind);

// FM3's patch: `(fm3 voice)` or `(fm3-csm voice)` with no notes, beside
// fm3-1…fm3-4, on a machine without them — its voice goes into the operator
// tracks' and the form is taken out.
function patchHeads(s, to) {
  const ops = [...s.heads.keys()].some((h) => /^fm3-\d$/.test(h));
  if (!ops || to.channelNames.includes("fm3-1")) return new Set();
  return new Set(["fm3", "fm3-csm"].filter((h) => s.heads.get(h) && s.heads.get(h).notes === 0));
}

const allRoles = (h, kit) => h.samples.size > 0 && [...h.samples].every((x) => kit.has(x));

/**
 * The rows of `text` onto `toName`: each channel the score writes, where it
 * goes by default, and where else it could. { from, to, rows: [{ key, head,
 * kind, notes, to, choices }] } or { error }. `to` is a channel or 'drop'.
 */
export function portRows(text, toName, { imports = null } = {}) {
  const from = TARGETS[scoreTargetOf(text)];
  const to = TARGETS[toName];
  if (!to || !PORT_TARGETS.includes(toName)) return { error: `no conversion onto ${toName}` };
  if (!PORT_TARGETS.includes(from.name)) return { error: `the ${from.system} is not converted at the words' level` };
  let s;
  try { s = survey(text, from, imports); } catch (e) { return { error: `the score does not parse: ${e.message}` }; }
  return { from: from.name, to: to.name, rows: planRows(s, from, to) };
}

function planRows(s, from, to) {
  const patch = patchHeads(s, to);
  const keys = [];
  for (const head of from.channelNames) {
    const h = s.heads.get(head);
    if (!h || patch.has(head)) continue;
    // fm8's :mode noise notes are a row of their own, onto the noise.
    if (from.name === "x68k" && head === "fm8" && h.noiseMode && to.name !== "x68k") keys.push(NOISE_SPLIT);
    keys.push(head);
  }
  const roleKit = to.parts.some((p) => p.kit);
  const toKit = new Set(to.parts.flatMap((p) => Object.keys(p.kit ?? {})));
  const rolesHere = (h) => roleKit && h && allRoles(h, toKit);
  // A physical voice each channel taken is, and which source voice took it:
  // two of the source's on one of the destination's (md sqr3 and noise onto
  // pc88's sqr3) cannot both go there.
  const takenBy = new Map();
  const taken = new Set();
  const sampleRows = keys.some((k) => kindOf(from, k) === "sample" && s.heads.get(k)?.notes);
  // The Mega Drive's PCM owns fm6 (its DAC).
  if (to.name === "md" && sampleRows) takenBy.set(to.voiceKey("fm6"), "dac");
  const srcKey = (k) => (k === NOISE_SPLIT ? "noise-split" : from.voiceKey(k));
  const free = (k, h) => {
    if (taken.has(h)) return false;
    if (to.partOf(h).kit) return true;
    const owner = takenBy.get(to.voiceKey(h));
    return owner == null || owner === srcKey(k);
  };
  const claim = (k, h) => {
    taken.add(h);
    if (!to.partOf(h).kit) takenBy.set(to.voiceKey(h), srcKey(k));
    return h;
  };
  const dest = {};
  const notesOf = (k) => s.heads.get(k === NOISE_SPLIT ? "fm8" : k)?.notes ?? 0;
  // A machine short of channels keeps the parts that play the most notes
  // (the user, 2026-11-08): past its melodic channels — FM and squares, less
  // a square its noise is and fm6 under the Mega Drive's PCM — and past its
  // noises, the parts with fewer notes are dropped before anything is placed.
  const melodic = (k) => ["fm", "tone"].includes(kindOf(from, k)) && k !== "fm3-csm-rate";
  const pools = [
    [melodic, channelsOf(to, "fm", { board: true }).length + channelsOf(to, "tone", { board: true }).length
      - (keys.some((k) => kindOf(from, k) === "noise") && channelsOf(to, "noise", { board: true }).some((n) => to.channelNames.some((h) => h !== n && to.voiceKey(h) === to.voiceKey(n))) ? 1 : 0)
      - (to.name === "md" && sampleRows ? 1 : 0)],
    [(k) => kindOf(from, k) === "noise", channelsOf(to, "noise", { board: true }).length],
    // A kit's tracks are many to its one voice; the rest are a channel each.
    [(k) => kindOf(from, k) === "sample" && !rolesHere(s.heads.get(k)), channelsOf(to, "sample", { board: true }).length],
  ];
  for (const [inPool, room] of pools) {
    const rows = keys.filter(inPool);
    if (rows.length <= room) continue;
    for (const k of [...rows].sort((a, b) => notesOf(a) - notesOf(b)).slice(0, rows.length - Math.max(0, room))) dest[k] = "drop";
  }
  // First the channels the destination has as they are: the noise before a
  // square (a drum is a drum), then in the table's order.
  const byNoise = [...keys].sort((a, b) => (kindOf(from, b) === "noise") - (kindOf(from, a) === "noise"));
  for (const k of byNoise) {
    const p = to.partOf(k);
    if (k in dest || !p || p.kind !== kindOf(from, k) || p.kind === "wave") continue;
    if (p.kit && !rolesHere(s.heads.get(k))) continue; // a kit's track plays its roles
    if (p.kind === "sample" && rolesHere(s.heads.get(k))) continue; // its roles go to the ROM rhythm
    if (free(k, k)) dest[k] = claim(k, k);
  }
  // Then the rest, in the table's order (the pools above have dropped what
  // does not fit): channels past the source's count first (x68k's fm7 and
  // fm8), FM3's own tracks onto fm3 first. A wave memory's channel is a
  // later stage's: dropped.
  const fmFirst = (k) => {
    const fm = channelsOf(to, "fm", { board: true });
    const beyond = fm.filter((h) => !from.channelNames.includes(h));
    const order = [...beyond, ...fm.filter((h) => !beyond.includes(h))];
    return /^fm3/.test(k) && order.includes("fm3") ? ["fm3", ...order.filter((h) => h !== "fm3")] : order;
  };
  const tones = channelsOf(to, "tone", { board: true });
  for (const k of keys) {
    if (k in dest) continue;
    const kind = kindOf(from, k);
    let cands = [];
    if (k === "fm3-csm-rate" || kind === "wave") cands = [];
    else if (kind === "fm") cands = [...fmFirst(k), ...tones];
    else if (kind === "tone") cands = [...tones, ...fmFirst(k)];
    else if (kind === "noise") cands = channelsOf(to, "noise", { board: true });
    else if (kind === "sample") cands = rolesHere(s.heads.get(k)) ? [...channelsOf(to, "sample", { kit: true }), ...channelsOf(to, "sample", { board: true })] : channelsOf(to, "sample", { board: true });
    const h = cands.find((c) => free(k, c));
    dest[k] = h ? claim(k, h) : "drop";
  }
  const choicesOf = (k) => {
    const kind = kindOf(from, k);
    if (to.partOf(k)?.kind === kind && !to.partOf(k).kit && to.channelNames.includes(k) && !channelsOf(to, kind).includes(k)) return [k, "drop"]; // fm3-1 … as they are
    if (k === "fm3-csm-rate" || kind === "wave") return ["drop"];
    if (kind === "fm" || kind === "tone") return [...channelsOf(to, "fm"), ...channelsOf(to, "tone"), "drop"];
    if (kind === "noise") return [...channelsOf(to, "noise"), "drop"];
    return [...channelsOf(to, "sample"), ...channelsOf(to, "sample", { kit: true }), "drop"];
  };
  return keys.map((k) => ({
    key: k,
    head: k === NOISE_SPLIT ? "fm8" : k,
    kind: kindOf(from, k),
    notes: s.heads.get(k === NOISE_SPLIT ? "fm8" : k)?.notes ?? 0,
    to: dest[k],
    choices: choicesOf(k),
  }));
}

// ── The conversion ───────────────────────────────────────────────────────

/**
 * `text` (a score on md, pc88 or x68k) on `toName`.
 * @param {string} text
 * @param {string} toName
 * @param {{rows?: Record<string,string>, imports?: Map<string,string>, header?: boolean}} [opts]
 *   rows: a row's key → its channel or 'drop', over the defaults (portRows);
 *   imports: the score's imports' texts, path → text (its voices and samples);
 *   header: the `; Converted from` line at the top (default true);
 *   names: a channel → the name the log calls it by (an MDX's parts)
 * @returns {{text: string, map: Record<string,string>, said: string[]} | {error: string}}
 */
export function portScore(text, toName, { rows = {}, imports = null, header = true, names = {} } = {}) {
  const plan = portRows(text, toName, { imports });
  if (plan.error) return plan;
  const from = TARGETS[plan.from];
  const to = TARGETS[toName];
  if (from === to) return { text, map: {}, said: [] };
  const map = Object.fromEntries(plan.rows.map((r) => [r.key, rows[r.key] ?? r.to]));
  for (const r of plan.rows)
    if (map[r.key] !== "drop" && !r.choices.includes(map[r.key])) return { error: `${r.head} cannot go to ${map[r.key]} on the ${to.system}` };
  // One channel a row, and one physical voice a source voice: fm3 and
  // fm3-1 are one channel on both machines, md's sqr3 and noise are not.
  const seen = new Map();
  const srcKey = (k) => (k === NOISE_SPLIT ? k : from.voiceKey(k));
  for (const [k, h] of Object.entries(map)) {
    if (h === "drop" || to.partOf(h).kit) continue;
    const key = to.voiceKey(h);
    const prev = seen.get(key);
    if (prev && (prev.h === h || srcKey(prev.k) !== srcKey(k))) return { error: `${prev.k} and ${k} both go to ${h}` };
    seen.set(key, { k, h });
  }
  if (to.name === "md" && Object.values(map).some((h) => /^pcm/.test(h)) && Object.values(map).includes("fm6"))
    return { error: "fm6 is the Mega Drive's DAC while the score plays PCM: send that row to another channel" };
  return new Porter(text, from, to, map, imports, names).run(header);
}

class Porter {
  constructor(text, from, to, map, imports, names) {
    this.names = names;
    this.text = text;
    this.from = from;
    this.to = to;
    this.map = map;
    this.s = survey(text, from, imports);
    this.said = new Set();
    this.starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.starts.push(i + 1);
    this.patch = patchHeads(this.s, to);
    this.toKit = new Set(to.parts.flatMap((p) => Object.keys(p.kit ?? {})));
    this.opVoices = new Map(); // `${voice}-op${n}` → [voice, n]
    this.standIns = new Set();
    this.patchCarry = this.readPatch();
    // The FM parts each side writes its voices for, and the voices resolved.
    this.fromFm = from.parts.find((p) => p.kind === "fm" && !p.optional) ?? from.parts.find((p) => p.kind === "fm");
    this.toFm = to.parts.find((p) => p.kind === "fm");
    this.voices = voiceTable(text, imports, this.fromFm);
    // The parts the converted score has: the machine's own, and a cartridge's
    // a row goes to (fc's 5B has a noise rate, its 2A03 none).
    const used = new Set(Object.values(map));
    this.toParts = new Set(to.channelNames.filter((h) => !(to.listsExpansions && to.chipOf(h).optional) || used.has(h)).map((h) => to.partOf(h)));
    this.replaced = new Set(); // def-fm names a conversion leaves unplayed
    this.shadowing = new Set(); // def-fm names that would hide the OPLL's ROM voice of that name
    this.fm8Split = from.name === "x68k" && !!this.s.heads.get("fm8")?.noiseMode;
  }

  say(line) { this.said.add(line); }
  toHas(w) { return [...this.toParts].some((p) => p.words(w) || p.songWords?.(w)); }
  // A source channel as the log names it: the song's own name for it where
  // the caller has one (an MDX's FM G for fm7), else the channel.
  nameOf(head) { return head == null ? "a def" : head === NOISE_SPLIT ? this.nameOf("fm8") : this.names[head] ?? head; }

  span(node) {
    const from = this.starts[node.line - 1] + node.column - 1;
    if (node.endLine != null) return { from, to: this.starts[node.endLine - 1] + node.endColumn - 1 };
    const len = node.kind === "string" ? String(node.value).length + 2 : String(node.value).length;
    return { from, to: from + len };
  }
  slice(node) {
    const { from, to } = this.span(node);
    return this.text.slice(from, to);
  }

  // A list's text with its items replaced (`outs[i]`: a string, null to take
  // it out, undefined as written) and text added after an item (`after`).
  // A taken-out item takes the spaces after it, so the line's indentation
  // and comments stay.
  renderList(node, outs, after = new Map()) {
    const { from, to } = this.span(node);
    const its = node.items;
    if (!its.length) return this.text.slice(from, to);
    let s = this.text.slice(from, this.span(its[0]).from);
    let dropNext = false;
    for (let i = 0; i < its.length; i++) {
      const sp = this.span(its[i]);
      if (i > 0) {
        const gap = this.text.slice(this.span(its[i - 1]).to, sp.from);
        if (dropNext) {
          const rest = gap.replace(/^[ \t]+/, "");
          if (rest.startsWith("\n")) s = s.replace(/[ \t]+$/, "");
          // A line the taken-out words leave empty goes with them.
          s += rest.startsWith("\n") && s.endsWith("\n") ? rest.slice(1) : rest;
        } else s += gap;
      }
      if (outs[i] !== null) s += outs[i] ?? this.text.slice(sp.from, sp.to);
      dropNext = outs[i] === null;
      for (const a of after.get(i) ?? []) s = `${s.replace(/[ \t]+$/, "")} ${a}`;
    }
    const tail = this.text.slice(this.span(its.at(-1)).to, to);
    return s.replace(/[ \t]+$/, "") + (dropNext ? tail.replace(/^[ \t]+/, "") : tail);
  }

  run(header) {
    const { roots } = this.s;
    const changes = [];
    const replace = (node, insert) => {
      const sp = this.span(node);
      if (insert !== null) return changes.push({ ...sp, insert });
      // A form taken out takes its line when nothing else is on it.
      let a = sp.from, b = sp.to;
      while (a > 0 && /[ \t]/.test(this.text[a - 1])) a--;
      while (b < this.text.length && /[ \t]/.test(this.text[b])) b++;
      if ((a === 0 || this.text[a - 1] === "\n") && (this.text[b] === "\n" || b === this.text.length)) changes.push({ from: a, to: Math.min(this.text.length, b + 1), insert: "" });
      else changes.push({ ...sp, insert: "" });
    };
    for (const n of roots) {
      if (!isList(n)) continue;
      const head = n.items[0]?.value;
      if (this.from.channelNames.includes(head)) replace(n, this.form(n));
      else if (head === "def-score") replace(n, this.defScore(n));
      else if (head === "def-fm") replace(n, this.defFm(n));
      else if (head === "def-pcm") replace(n, this.defPcm(n));
      else if (head === "def-mod") replace(n, this.defMod(n));
      else if (head === "def-se") {
        this.say(`def-se ${n.items[1]?.value ?? ""}: a sound effect is the Mega Drive driver's; taken out`);
        replace(n, null);
      } else if (head === "def") replace(n, this.def(n));
    }
    // The defs the conversion adds: each one-operator voice after its base.
    const added = this.opVoiceDefs();
    for (const [base, defs] of added) {
      const node = roots.find((n) => isList(n, "def-fm") && n.items[1]?.value === base);
      if (!node) continue;
      const c = changes.find((ch) => ch.from === this.span(node).from);
      c.insert += `\n${defs.join("\n")}`;
      added.delete(base);
    }
    changes.sort((a, b) => a.from - b.from);
    let out = "";
    let at = 0;
    for (const c of changes) {
      out += this.text.slice(at, c.from) + c.insert;
      at = c.to;
    }
    out += this.text.slice(at);
    out = this.pruneVoices(out);
    out = this.addHeader(out, [...added.values()].flat(), header);
    return { text: out, map: this.map, said: [...this.said] };
  }

  // A def-fm the conversion leaves unplayed (its tracks play a role's or a
  // waveform's voice now, or a square) goes, and its line: one nothing else
  // names, a voice extending it included.
  pruneVoices(out) {
    // presets/fm-roles holds the roles' 4-op voices under the OPLL's ROM
    // names: on the OPLL the ROM's own are the roles.
    if (twoOp(this.toFm) && !twoOp(this.fromFm)) {
      const before = out;
      out = out.replace(new RegExp(`^[ \\t]*\\(import\\s+"${FM_ROLES_SET.replace(/[./]/g, "\\$&")}"\\)[^\\n]*\\n?`, "m"), "");
      if (out !== before) this.say(`presets/fm-roles: the ${this.toFm.label}'s ROM voices are the roles; its import is taken out`);
    }
    for (let pass = 0; pass < 4 && (this.replaced.size || this.shadowing.size); pass++) {
      let roots;
      try { roots = parse(out); } catch { return out; }
      const named = new Map();
      const count = (n, skip) => {
        if (n === skip) return;
        if (n?.kind === "atom") named.set(n.value, (named.get(n.value) ?? 0) + 1);
        if (n?.kind === "list") n.items.forEach((m) => count(m, skip));
      };
      const defs = roots.filter((n) => isList(n, "def-fm") && (this.replaced.has(n.items[1]?.value) || this.shadowing.has(n.items[1]?.value)));
      roots.forEach((n) => count(n));
      const starts = [0];
      for (let i = 0; i < out.length; i++) if (out[i] === "\n") starts.push(i + 1);
      const gone = defs.filter((n) => named.get(n.items[1].value) === 1 || this.shadowing.has(n.items[1].value)).map((n) => {
        const from = starts[n.line - 1] + n.column - 1, to = starts[n.endLine - 1] + n.endColumn - 1;
        return { from, to: out[to] === "\n" ? to + 1 : to };
      });
      if (!gone.length) break;
      for (const g of gone.sort((a, b) => b.from - a.from)) out = out.slice(0, g.from) + out.slice(g.to);
    }
    return out;
  }

  // The lines that go after def-score: the imports the stand-ins and the
  // rhythm's roles need, the loud stand-ins' defs, the one-operator voices of
  // an imported base — and the score's def-score when it had none.
  addHeader(out, opDefs, header) {
    const lines = [];
    const imported = (path) => new RegExp(`\\(import\\s+"${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`).test(out);
    if (this.standIns.size && !imported(WAVEFORMS)) lines.push(`(import "${WAVEFORMS}")`);
    lines.push(...loudDefs(this.standIns));
    if (this.needsKit && !imported(RHYTHM_KIT)) lines.push(`(import "${RHYTHM_KIT}")`);
    if (this.needsRoles && !imported(FM_ROLES_SET)) lines.push(`(import "${FM_ROLES_SET}")`);
    lines.push(...opDefs);
    if (!this.s.roots.some((n) => isList(n, "def-score"))) lines.unshift(`(def-score :target ${this.to.name}${this.pcmVoices() ? ` :pcm-voices ${this.pcmVoices()}` : ""})`);
    let head = "";
    let body = out;
    // After the score's leading comments and its def-score.
    const score = /^(?:[ \t]*;[^\n]*\n|[ \t]*\n)*/.exec(body)[0];
    head = score;
    body = body.slice(score.length);
    const ds = /^\(def-score\b[^\n]*\n?/.exec(body);
    if (ds && this.balanced(ds[0])) {
      head += ds[0].endsWith("\n") ? ds[0] : `${ds[0]}\n`;
      body = body.slice(ds[0].length);
    }
    const top = header ? `; Converted from :target ${this.from.name}\n` : "";
    if (header) head = head.replace(/^; Converted from :target \w+[^\n]*\n/m, ""); // an earlier conversion's
    return top + head + (lines.length ? `${lines.join("\n")}\n` : "") + body;
  }
  balanced(line) {
    let d = 0;
    for (const ch of line.replace(/"[^"]*"/g, "").replace(/;.*$/, "")) d += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    return d === 0;
  }

  pcmVoices() {
    if (this.to.name !== "md") return 0;
    const used = Object.values(this.map).map((h) => /^pcm(\d)$/.exec(h)?.[1]).filter(Boolean).map(Number);
    return used.length ? Math.max(...used) : 0;
  }

  // ── def forms ──

  defScore(n) {
    const outs = [];
    const after = new Map();
    let hasTarget = false;
    let hasVoices = false;
    for (let i = 1; i < n.items.length; i++) {
      const kw = n.items[i].value;
      if (kw === ":target") { outs[i + 1] = this.to.name; hasTarget = true; i++; continue; }
      if (kw === ":pcm-voices" && this.to.name === "md") { hasVoices = true; if (this.pcmVoices()) outs[i + 1] = String(Math.max(this.pcmVoices(), num(n.items[i + 1]) ?? 0)); i++; continue; }
      const setting = typeof kw === "string" && kw.startsWith(":") && this.from.parts.find((p) => p.settings?.includes(kw));
      if (setting && !this.to.parts.some((p) => p.settings?.includes(kw))) {
        this.say(`${kw} is the ${setting.label}'s setting; the ${this.to.system} has none`);
        outs[i] = outs[i + 1] = null;
        i++;
      }
    }
    const add = [];
    if (!hasTarget) add.push(`:target ${this.to.name}`);
    if (!hasVoices && this.pcmVoices()) add.push(`:pcm-voices ${this.pcmVoices()}`);
    if (add.length) after.set(n.items.length - 1, add);
    return this.renderList(n, outs, after);
  }

  defFm(n) {
    const fm = this.toFm;
    const name = n.items[1]?.value;
    // A 4-op voice onto a machine of the OPLL (or none) is played as its
    // role or waveform there: the def stays, and goes if nothing plays it.
    if (!fm || (twoOp(fm) && !twoOp(this.fromFm))) return this.slice(n);
    if (twoOp(this.fromFm) && twoOp(fm)) return this.slice(n);
    // An OPLL user voice onto 4-op: the same voice, read as 4-op.
    if (twoOp(this.fromFm)) {
      const d = this.voices.get(name);
      if (!d) return this.slice(n);
      const r = opllDefAs4op(name, d.words);
      if (r.without.length) this.say(`'${name}' plays without ${r.without.join(", ")}: a 4-op chip has none`);
      return r.text;
    }
    const outs = [];
    const gone = [];
    for (let i = 2; i < n.items.length; i++) {
      const kw = n.items[i].value;
      if (!(typeof kw === "string" && kw.startsWith(":"))) continue;
      const w = canonicalTarget(kw);
      if (w && partsWithWord(w).length && !fm.words(w)) {
        gone.push(kw);
        outs[i] = outs[i + 1] = null;
      }
      i++;
    }
    if (gone.length) this.say(`'${name}' plays without ${gone.join(" ")}: the ${this.to.system}'s FM has none`);
    return this.renderList(n, outs);
  }

  // The ADPCM-B repeats a sample's whole range: a loop that starts after the
  // range does is made the range (the head before it is cut).
  defPcm(n) {
    if (!this.to.parts.some((p) => p.rangeLoops)) return this.slice(n);
    const at = (kw) => n.items.findIndex((x) => x.value === kw);
    if (at(":loop-start") < 0) return this.slice(n);
    const outs = [];
    for (const [loop, range] of [[":loop-start", ":pcm-start"], [":loop-end", ":pcm-end"], [":loop-len", ":pcm-len"]]) {
      const r = at(range);
      if (r >= 0 && at(loop) >= 0) outs[r] = outs[r + 1] = null;
      if (at(loop) >= 0) outs[at(loop)] = range;
    }
    this.say(`'${n.items[1]?.value}': the ADPCM-B loops a sample's whole range, so its range is its loop (the head before the loop is cut)`);
    return this.renderList(n, outs);
  }

  // `:ch` names channels: the ones the rows moved, the dropped ones out.
  defMod(n) {
    const outs = [];
    const at = n.items.findIndex((x) => x.value === ":ch");
    const v = n.items[at + 1];
    if (at < 0 || !v) return this.slice(n);
    const rename = (h) => (h in this.map ? this.map[h] : h);
    if (v.kind === "atom") outs[at + 1] = rename(v.value) === "drop" ? null : rename(v.value);
    else if (v.kind === "list") {
      const inner = v.items.map((x) => (x.kind === "atom" ? (rename(x.value) === "drop" ? null : rename(x.value)) : undefined));
      outs[at + 1] = this.renderList(v, inner);
    }
    if (outs[at + 1] === null) outs[at] = null;
    return this.renderList(n, outs);
  }

  // A def: a section's channel forms each converted, a snippet's words read
  // as no channel's (only what the machine has none of goes).
  def(n) {
    const outs = [];
    const isForm = (x) => isList(x) && this.from.channelNames.includes(x.items[0]?.value);
    if (n.items.slice(2).some(isForm)) {
      for (let i = 2; i < n.items.length; i++) if (isForm(n.items[i])) outs[i] = this.form(n.items[i]);
      return this.renderList(n, outs);
    }
    // A snippet's voices are read as the FM's: across the FM families each
    // is its role's or its waveform's, wherever the snippet is played.
    // With no row on an FM channel they go.
    const ctx = this.ctx(null);
    const onFm = Object.values(this.map).some((h) => this.to.partOf(h)?.kind === "fm");
    if (this.fromFm && !onFm) Object.assign(ctx, { srcPart: this.fromFm, destPart: { kind: "none", label: "", words: () => false }, snippet: true });
    else if (this.fromFm && this.toFm && twoOp(this.fromFm) !== twoOp(this.toFm))
      Object.assign(ctx, { srcPart: this.fromFm, destPart: this.toFm, family: true, snippet: true });
    const { outs: body } = this.body(n.items, 2, ctx);
    return this.renderList(n, body);
  }

  // ── channel forms ──

  ctx(head, extra = {}) {
    const dest = head ? this.map[head] : null;
    const c = {
      head,
      dest,
      srcPart: head ? this.from.partOf(head === NOISE_SPLIT ? "noise" : head) : null, // fm8's noise notes are the OPM's noise
      destPart: dest && dest !== "drop" ? this.to.partOf(dest) : null,
      destChannel: dest && dest !== "drop" ? this.to.channels[dest] : null,
      opN: head && /^fm3-\d$/.test(head) && !this.to.channelNames.includes(head) ? Number(head.slice(4)) : null,
      ...extra,
    };
    const src = c.srcPart, dst = c.destPart;
    // A sample channel that cannot bend (the Mega Drive's DAC), and a kit
    // that plays each sound at one pitch (the PC-8801's ROM rhythm).
    c.noBend = dst?.kind === "sample" && !dst.pitch && !!src?.pitch;
    c.flatPitch = !!dst?.kit && !dst.pitch && !(src?.kit && !src.pitch);
    // A noise between a pitched one and the others is read note by note.
    if (src?.kind === "noise" && dst?.kind === "noise") {
      const from = noiseModel(src), to = noiseModel(dst);
      if (from !== to && (from === "pitch" || to === "pitch"))
        c.noise = { from, to, src, dst, oct: 4, hz: from === "mode" ? WHITE_HZ[0] : NOISE_CLOCK / NOISE_RATE_START, periodic: false, last: null };
    }
    // A voice crossing between the FM families, or between two ROMs.
    c.family = src?.kind === "fm" && dst?.kind === "fm" && twoOp(src) !== twoOp(dst);
    c.romSwap = twoOp(src) && twoOp(dst) && src.rom !== dst.rom;
    return c;
  }

  form(n) {
    const head = n.items[0].value;
    if (this.patch.has(head)) return null;
    if (head === "fm8" && this.fm8Split) {
      const state = { mode: "tone" };
      const fm = this.map.fm8 === "drop" ? null : this.oneForm(n, this.ctx("fm8", { split: "tone", state: { ...state } }));
      const noise = this.map[NOISE_SPLIT] === "drop" ? null : this.oneForm(n, this.ctx(NOISE_SPLIT, { split: "noise", state: { ...state } }));
      if (fm == null && noise == null) {
        this.say(`${this.nameOf("fm8")} (${notes(this.s.heads.get("fm8").notes)}) is not converted`);
        return null;
      }
      return [fm, noise].filter((x) => x != null).join("\n");
    }
    if (this.map[head] === "drop" || this.map[head] == null) {
      const why = head === "fm3-csm-rate" ? `: the ${this.to.system} has no CSM` : "";
      this.say(`${this.nameOf(head)} (${notes(this.s.heads.get(head)?.notes ?? 0)}) is not converted${why}`);
      return null;
    }
    return this.oneForm(n, this.ctx(head));
  }

  oneForm(n, ctx) {
    const at = n.items[1]?.value === ":prio" ? 2 : 0; // the head option
    const { outs, after } = this.body(n.items, at + 1, ctx);
    outs[0] = ctx.dest;
    const lead = [];
    // The first form of the head carries what the conversion adds: the
    // patch's tempo and voice on an operator track, a stand-in voice.
    const first = !this.started?.has(ctx.head);
    (this.started ??= new Set()).add(ctx.head);
    if (first && ctx.opN && this.patchCarry) {
      if (this.patchCarry.tempo && !this.tempoCarried) { lead.push(`:tempo ${this.patchCarry.tempo}`); this.tempoCarried = true; }
      // On a 4-op channel a one-operator voice of the patch; on the OPLL the
      // patch voice's role or waveform; on a square none.
      const v = this.patchCarry.voice;
      if (v && !ctx.hasVoiceFirst && ctx.destPart?.kind === "fm")
        lead.push(twoOp(ctx.destPart) ? this.voiceRule(v, ctx) ?? v : this.opVoice(v, ctx.opN));
    }
    if (first && ctx.srcPart.kind !== "fm" && ctx.destPart.kind === "fm") {
      const v = this.standIn(ctx.destPart);
      lead.push(v);
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} as ${v} (a stand-in for its square)`);
    }
    if (ctx.srcPart.kind === "fm" && ctx.destPart.kind !== "fm" && ctx.destPart.kind !== "noise")
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest}, a square, without its voice`);
    if (ctx.split === "noise") this.say(`${this.nameOf("fm8")}'s :mode noise notes play on ${ctx.dest}, its tone notes on ${this.map.fm8}`);
    if (ctx.opN && ctx.destPart?.kind === "fm" && !twoOp(ctx.destPart)) this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} under a one-operator voice of the patch (operator ${ctx.opN} the carrier)`);
    if (ctx.head === "fm3-csm" && ctx.dest !== "fm3-csm") this.say(`${this.nameOf("fm3-csm")} plays its notes on ${ctx.dest}: the ${this.to.system} has no CSM`);
    if (first && ctx.flatPitch && this.s.heads.get(ctx.head)?.notes) {
      lead.push(":oct 4");
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} at c4: the ${ctx.destPart.label} has one pitch a sound`);
    }
    if (lead.length) after.set(at, [...lead, ...(after.get(at) ?? [])]);
    return this.renderList(n, outs, after);
  }

  // A body's items from `start`: each keyword's word read for the
  // destination, the voices, the notes of a split track.
  body(items, start, ctx) {
    const outs = [];
    const after = new Map();
    let sawNote = false;
    for (let i = start; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "atom") {
        const v = it.value;
        if (ctx.noise && !(ctx.split && v === ":mode") && typeof v === "string" && /^:(mode|noise-rate|oct)$/.test(v) && i + 1 < items.length) {
          this.noiseWord(v, items[i + 1], ctx);
          outs[i] = outs[i + 1] = null;
          i++;
          continue;
        }
        if (ctx.noise && (v === ">" || v === "<" || /^o[+-]\d*$/.test(v))) {
          const n = ctx.noise;
          n.oct += v === ">" ? 1 : v === "<" ? -1 : (v[1] === "+" ? 1 : -1) * Number(v.slice(2) || 1);
          if (n.to === "pitch") outs[i] = null; // the notes are written at their octave
          continue;
        }
        if (ctx.noise && isNote(v)) {
          sawNote = true;
          outs[i] = this.noiseNote(v, ctx);
          continue;
        }
        if (typeof v === "string" && /^:[a-z]/.test(v) && i + 1 < items.length) {
          const r = this.wordRule(v, items[i + 1], ctx);
          if (r.drop) outs[i] = outs[i + 1] = null;
          else if (r.replace != null) { outs[i] = r.replace; outs[i + 1] = null; }
          i++;
          continue;
        }
        if ((ctx.head || ctx.snippet) && this.s.voices.has(v)) {
          if (!sawNote && ctx.opN) ctx.hasVoiceFirst = true;
          const r = this.voiceRule(v, ctx);
          if (r !== undefined) outs[i] = r;
          continue;
        }
        if (ctx.flatPitch && (v === ">" || v === "<" || /^o[+-]\d*$/.test(v))) { outs[i] = null; continue; }
        if (ctx.flatPitch && isNote(v)) {
          sawNote = true;
          outs[i] = `c${NOTE.exec(v)[2]}`;
          continue;
        }
        if (isNote(v)) {
          sawNote = true;
          if (ctx.split && ctx.state.mode !== ctx.split) outs[i] = restOf(v);
          continue;
        }
        if (ctx.destPart?.kind === "sample" && !this.toKit.size && this.from.parts.some((p) => p.kit?.[v]) && !this.s.samples.has(v)) this.needsKit = true;
      } else if ((ctx.noBend || ctx.flatPitch) && isList(it, "glide")) {
        this.say(`(glide …) on ${this.nameOf(ctx.head)}: ${ctx.dest} plays a sound at its own pitch; taken out`);
        outs[i] = null;
      } else if (isList(it) && DESCEND.has(it.items[0]?.value)) {
        // A loop's next pass starts from where its last ended: the noise's
        // state is written again inside it and after it.
        if (ctx.noise) ctx.noise.last = null;
        const inner = this.body(it.items, 1, it.items[0].value === "macro" ? { ...ctx, macro: true } : ctx);
        if (ctx.noise) ctx.noise.last = null;
        outs[i] = this.renderList(it, inner.outs, inner.after);
      }
    }
    // A tie into or out of a note the split made a rest ties nothing.
    if (ctx.split)
      for (let i = start; i < items.length; i++)
        if (items[i].value === "~" && [outs[i - 1], outs[i + 1]].some((o) => typeof o === "string" && o.startsWith("_"))) outs[i] = null;
    return { outs, after };
  }

  // The noise's state as its source writes it: the octave, the rate (Hz),
  // white or periodic.
  noiseWord(kw, val, ctx) {
    const n = ctx.noise;
    const v = val.kind === "atom" ? String(val.value) : null;
    if (kw === ":oct") { if (num(val) != null) n.oct = num(val); else this.say(`:oct on ${this.nameOf(ctx.head)}: not a number; the noise's octave is read as ${n.oct}`); return; }
    if (kw === ":noise-rate") {
      if (num(val) != null) n.hz = NOISE_CLOCK / Math.max(1, num(val));
      else this.say(`:noise-rate (a sweep) on ${this.nameOf(ctx.head)}: the ${ctx.destPart.label} has no rate sweep; taken out`);
      return;
    }
    // :mode
    const m = /^(white|periodic)(\d)?$/.exec(v ?? "");
    if (!m) { this.say(`:mode on ${this.nameOf(ctx.head)}: not one noise; taken out`); return; }
    n.periodic = m[1] === "periodic";
    if (m[2] != null) {
      if (m[2] === "3") this.say(`:mode ${v} on ${this.nameOf(ctx.head)} follows sqr3's pitch, which ${ctx.dest} has not: read as ${m[1]}2`);
      n.hz = WHITE_HZ[Math.min(2, Number(m[2]))];
    }
  }

  // A noise note on the destination: its pitch the rate's where the rate is
  // a pitch, else the note as written after the mode or rate it plays at.
  noiseNote(v, ctx) {
    const n = ctx.noise;
    const suffix = NOTE.exec(v)[2];
    if (n.from === "pitch") n.hz = PITCHED_NOISE[n.src.name].noiseHzOfNote(midiOfNote(v, n.oct));
    let state, note = v;
    if (n.to === "pitch") {
      const midi = PITCHED_NOISE[n.dst.name].noiseNoteOfHz(n.hz);
      const oct = Math.floor(midi / 12) - 1;
      note = `${PITCH_NAMES[midi % 12]}${suffix}`;
      state = `${n.periodic ? ":mode periodic" : ":mode white"} :oct ${oct}`;
    } else if (n.to === "mode") {
      state = `:mode ${n.periodic ? "periodic" : "white"}${nearestWhite(n.hz)}`;
    } else {
      if (n.periodic && !n.saidPeriodic) { n.saidPeriodic = true; this.say(`a periodic noise on ${this.nameOf(ctx.head)}: ${ctx.dest} makes white noise only`); }
      state = `:noise-rate ${Math.max(1, Math.min(31, Math.round(NOISE_CLOCK / n.hz)))}`;
    }
    if (!n.said) { n.said = true; this.say(`${this.nameOf(ctx.head)}'s noise on ${ctx.dest}: each note's rate read as the nearest ${n.to === "pitch" ? "pitch" : n.to === "mode" ? "white / periodic mode" : ":noise-rate"} (Hz)`); }
    if (state === n.last) return note;
    n.last = state;
    return `${state} ${note}`;
  }

  voiceRule(v, ctx) {
    if (!ctx.destPart) return undefined;
    if (ctx.destPart.kind !== "fm") { this.replaced.add(v); return null; }
    if (ctx.opN && !twoOp(ctx.destPart)) return this.opVoice(v, ctx.opN);
    const def = this.voices.get(v);
    // 4-op onto the OPLL: a role's ROM voice, else its waveform's.
    if (ctx.family && !twoOp(ctx.srcPart)) {
      const r = onOpll(v, def?.words ?? new Map(), ctx.destPart);
      if (r.why) this.say(r.why);
      if (r.name !== v) this.replaced.add(v);
      // A 4-op def named as the ROM's voice would hide it: the def goes.
      else if (def && !def.imported) { this.shadowing.add(v); this.say(`'${v}' plays the ${ctx.destPart.label}'s ${v} (its role); its 4-op def is taken out`); }
      return r.name === v ? undefined : r.name;
    }
    // The OPLL onto 4-op: a ROM voice its role's, presets/fm-roles'; a user
    // voice goes as itself, its def read as 4-op (defFm).
    if (ctx.family && !def) {
      const role = romOn4op(v);
      this.needsRoles = true;
      if (role !== v) this.say(`'${v}' (the ${ctx.srcPart.label}'s ROM) plays presets/fm-roles' ${role}`);
      return role === v ? undefined : role;
    }
    // One ROM onto another: the voice of its role.
    if (ctx.romSwap && !def && !ctx.destPart.romNames.includes(v)) {
      const rom = romForRole(ctx.destPart, roleOf(v) ?? "synth");
      this.say(`'${v}' plays the ${ctx.destPart.label}'s ${rom} (its role)`);
      return rom;
    }
    return undefined;
  }

  // What a `:keyword value` pair is on the destination: { keep } | { drop }
  // | { replace }, said where it is not as written.
  wordRule(kw, val, ctx) {
    const KEEP = {};
    const DROP = { drop: true };
    const where = ctx.dest ? `${ctx.dest}` : `the ${this.to.system}`;
    const base = kw.replace(/[+*]$/, "");
    if (ctx.split && base === ":mode") {
      if (val.kind === "atom") ctx.state.mode = val.value === "noise" ? "noise" : "tone";
      return DROP;
    }
    if (base === ":mode") return this.modeRule(val, ctx);
    // A channel of one level (the 2A03's triangle) sounds or is halted: a
    // level written there is not heard, except 0.
    if ((base === ":vel" || base === ":vol") && ctx.destPart?.noLevel && !ctx.srcPart?.noLevel && val.value !== "0") {
      this.say(`${base} on ${this.nameOf(ctx.head)}: ${ctx.dest} (the ${ctx.destPart.label}) has one level; taken out`);
      return DROP;
    }
    if (base === ":csm-rate") {
      if (ctx.dest === "fm3-csm" || !ctx.head) return KEEP;
      this.say(`:csm-rate on ${this.nameOf(ctx.head)}: the ${this.to.system} has no CSM; taken out`);
      return DROP;
    }
    if (ctx.flatPitch && base === ":oct") return DROP;
    if ((base === ":pitch" || base === ":semi") && (ctx.noBend || ctx.flatPitch)) {
      this.say(`${kw} on ${this.nameOf(ctx.head)}: the ${ctx.destPart.label} cannot bend a sample; taken out`);
      return DROP;
    }
    const w = canonicalTarget(base);
    if (!w) return KEEP;
    const owners = partsWithWord(w);
    if (!owners.length) return KEEP; // the language's own (:master, :vol …)
    // Across the FM families a voice's words are the other chip's: its
    // register ranges, its operators. The voice is the role's or the
    // waveform's now; written over, it would not be.
    if (ctx.family && /^FM_/.test(w)) {
      this.say(`the voice's words written on ${this.nameOf(ctx.head)} (${base} …): the ${ctx.destPart.label} plays its own voice; taken out`);
      return DROP;
    }
    if (SONG_WORDS.has(w)) return this.songRule(w, kw, val, ctx);
    // An FM3 operator track on a channel of its own: another operator's word
    // was the shared patch's, which this channel does not play.
    const op = /\d$/.test(w) && /^FM_/.test(w) ? Number(w.at(-1)) : null;
    if (ctx.opN && op && op !== ctx.opN && ctx.destPart?.kind === "fm" && !twoOp(ctx.destPart)) {
      this.say(`${kw} on ${this.nameOf(ctx.head)} was the FM3 patch's operator ${op}; taken out`);
      return DROP;
    }
    if (ctx.destPart ? ctx.destPart.words(w) : this.toHas(w)) return KEEP;
    if (w === "PAN" && (val.value === "center" || val.value === "0")) return DROP; // as a channel with none plays
    const label = ctx.srcPart?.words(w) ? ctx.srcPart.label : owners.find((p) => this.from.parts.includes(p))?.label ?? owners[0].label;
    this.say(`${base} (the ${label}'s)${ctx.head ? ` on ${this.nameOf(ctx.head)}` : ""}: ${where} has none; taken out`);
    return DROP;
  }

  songRule(w, kw, val, ctx) {
    const KEEP = {};
    const DROP = { drop: true };
    // A song's word steps in a note's macro only on a part that says so
    // (the SSG's noise rate).
    if (ctx.macro && this.toHas(w) && !ctx.destPart?.songMacros?.(w)) {
      this.say(`${kw} in a macro on ${this.nameOf(ctx.head)}: on the ${this.to.system} it is the song's, not a note's; taken out`);
      return DROP;
    }
    if (this.toHas(w)) return KEEP;
    if (w === "NOISE_RATE" && ctx.split === "tone") return DROP; // the noise half reads it
    const n = num(val);
    if (w === "LFO_FREQ" && this.toHas("LFO_RATE") && n != null) {
      const rate = nearestLfoRate(lfoHz(n));
      this.say(`:lfo-freq ${n} (${lfoHz(n).toFixed(2)} Hz) reads as :lfo-rate ${rate} (${OPN_LFO_HZ[rate - 1]} Hz)`);
      return { replace: `:lfo-rate ${rate}` };
    }
    if (/^LFO_/.test(w)) {
      this.say(`${kw}: the OPM's LFO ${w === "LFO_WAVE" ? "wave" : "depth"}; the OPN's LFO is a triangle whose depth is each voice's :fms / :ams — taken out`);
      return DROP;
    }
    if (w === "NOISE_RATE") {
      if (ctx.destPart?.kind === "noise" && noiseModel(ctx.destPart) === "mode" && n != null) {
        const white = nearestWhite(NOISE_CLOCK / n);
        this.say(`:noise-rate ${n} (${Math.round(NOISE_CLOCK / n)} Hz) reads as :mode white${white} (${WHITE_HZ[white]} Hz)`);
        return { replace: `:mode white${white}` };
      }
      this.say(`:noise-rate ${n ?? "(a sweep)"} on ${ctx.head ? this.nameOf(ctx.head) : "a def"}: the ${this.to.system}'s noise has no rate${ctx.destPart?.kind === "noise" ? " sweep" : " but its track's :mode"}; taken out`);
      return DROP;
    }
    this.say(`${kw}: the ${this.to.system} has none; taken out`);
    return DROP;
  }

  modeRule(val, ctx) {
    const KEEP = {};
    const DROP = { drop: true };
    if (!ctx.head) return KEEP;
    if (ctx.srcPart?.kind === "sample" && ctx.destPart?.kind === "sample") return KEEP;
    const syms = val.kind === "atom" ? [val.value] : val.kind === "list" && val.bracket === "[]" ? val.items.map((x) => x.value) : null;
    if (!syms) return KEEP;
    const modes = { ...(ctx.destPart?.modes ?? {}), ...(ctx.destChannel?.modes ?? {}) };
    if (syms.every((m) => Object.hasOwn(modes, m))) return KEEP;
    const reading = this.to.readsAs?.modes?.[ctx.destPart?.name] ?? {};
    if (val.kind === "atom") {
      const r = reading[val.value];
      if (r?.write) return { replace: r.as };
      if (ctx.destPart?.kind === "noise" && this.toHas("NOISE_RATE") && RATE_OF_WHITE[val.value])
        return { replace: `:noise-rate ${RATE_OF_WHITE[val.value]}` };
      if (r?.none) { this.say(`:mode ${val.value} on ${this.nameOf(ctx.head)}: ${r.none}; taken out`); return DROP; }
    }
    const what = ctx.srcPart?.kind === "tone" ? " (the SSG's mixer: its notes play as tone)" : ctx.srcPart?.kind === "noise" ? " (it plays the noise the machine has)" : "";
    this.say(`:mode ${val.kind === "atom" ? val.value : `[${syms.join(" ")}]`} on ${this.nameOf(ctx.head)}: ${ctx.dest} has no such mode${what}; taken out`);
    return DROP;
  }

  // ── what the conversion adds ──

  standIn(part) {
    if (twoOp(part)) return "clarinet"; // the OPLL's square-shaped ROM voice
    const loud = !this.to.parts.some((p) => p.kind === "tone")
      && !Object.entries(this.map).some(([k, h]) => h !== "drop" && kindOf(this.from, k) === "fm" && this.to.partOf(h).kind === "fm");
    const name = loud ? "loud-square" : "wave-square";
    this.standIns.add(name);
    return name;
  }

  // FM3's patch: its first voice (the operator tracks start under it) and a
  // tempo written there (the song's, which must not go with the form).
  readPatch() {
    if (!this.patch.size) return null;
    let voice = null;
    let tempo = null;
    const later = [];
    for (const head of this.patch)
      for (const f of this.s.heads.get(head).forms) {
        const items = f.items;
        for (let i = 1; i < items.length; i++) {
          const v = items[i].value;
          if (v === ":tempo") { tempo ??= this.slice(items[i + 1]); i++; continue; }
          if (this.s.voices.has(v)) { if (!voice) voice = v; else if (v !== voice) later.push(v); continue; }
          if (typeof v === "string" && /^:/.test(v) && !/^:(len|oct|gate)$/.test(v)) { this.say(`${v} on ${this.nameOf(head)} (the FM3 patch): taken out with the patch`); i++; continue; }
        }
      }
    if (later.length) this.say(`the FM3 patch's later voices (${[...new Set(later)].join(" ")}) are not followed: the operator tracks keep ${voice}'s`);
    return { voice, tempo };
  }

  opVoice(v, n) {
    const name = `${v}-op${n}`;
    this.opVoices.set(name, [v, n]);
    return name;
  }

  opVoiceDefs() {
    const byBase = new Map();
    for (const [name, [v, n]] of this.opVoices) {
      const others = [1, 2, 3, 4].filter((m) => m !== n).map((m) => `:tl${m} 127`).join(" ");
      const def = `(def-fm ${name} ${v} :alg 7 ${others})`;
      byBase.set(v, [...(byBase.get(v) ?? []), def]);
    }
    return byBase;
  }
}
