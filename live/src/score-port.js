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
import * as pcePsg from "./chips/huc6280.js";
import { compileMMLisp } from "./mmlisp2ir.js";
import { PART_LEVELS } from "./part-levels.js";
import { shapeOf, wave32, envelopeOf, WAVETABLE_SET, fdsAsPce, pceAsFds, pceFmsOf, fdsFreqAsPce, pceFreqAsFds, fdsCounter } from "./wave-port.js";
import { pitchToMidi, expandLoops, VEL_DB_PER_STEP } from "./ir-utils.js";
import { waveformOf, carrierOctave, carrierMultiple, opnAs2op, ROLES, ROM_OF_WAVE } from "./voice-port.js";
import { opllWordsAs4op } from "./chips/ym2413.js";
import { voiceTable, onOpll, romOn4op, romForRole, roleOf, opllDefAs4op, FM_ROLES_SET, OPLL_VIB_FMS, OPLL_AM_AMS, OPLL_LFO_RATE } from "./voice-port.js";

/** The machines a score can be converted between. */
/** The machines a score can be converted between: every one of chips (General MIDI's is its own road). */
export const PORT_TARGETS = Object.keys(TARGETS).filter((t) => TARGETS[t].sound === "chips");

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
const PITCHED_NOISE = { "fc-noise": fcApu, "gb-noise": gbApu, "pce-noise": pcePsg };
const noiseModel = (part) => (PITCHED_NOISE[part?.name] ? "pitch" : part?.modes && Object.keys(part.modes).some((m) => /^white\d$/.test(m)) ? "mode" : "rate");
const NOISE_RATE_START = 9; // the SSG's and the OPM's rate before one is written
const PITCH_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const midiOfNote = (v, oct) => {
  const [, name] = NOTE.exec(v);
  return 12 * (oct + 1) + SEMI[name[0]] + (name[1] === "+" ? 1 : name[1] === "-" ? -1 : 0);
};

// 0-based offsets of each line's start, for the parser's 1-based line / column.
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
// The melodic kinds: a track of one goes onto a channel of any (wave-port.js).
const MELODIC_KINDS = ["fm", "tone", "wave"];
// A machine's kit roles (the ROM rhythms').
const kitRoles = (target) => new Set(target.parts.flatMap((p) => Object.keys(p.kit ?? {})));
// A tone part whose shape is its own, on a wave channel.
const TONE_SHAPE = { "fc-tri": "triangle", "vrc6-saw": "saw" };
// The words a form writes before its first note or rest: [[keyword, value node]].
function leadWords(form) {
  const out = [];
  const items = form.items.slice(form.items[1]?.value === ":prio" ? 3 : 1);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "atom" && (isNote(it.value) || /^_/.test(it.value))) break;
    if (it.kind === "atom" && /^:/.test(it.value) && items[i + 1]) out.push([it.value, items[++i]]);
  }
  return out;
}

const NOTE = /^([a-g][+-]?)((?:\d+(?:\/\d+)?)?(?:t|f|ms)?\.*)$/;
const isNote = (v) => typeof v === "string" && NOTE.test(v);
const restOf = (v) => `_${NOTE.exec(v)[2]}`;
const num = (node) => (node?.kind === "atom" && /^-?\d+(\.\d+)?$/.test(node.value) ? Number(node.value) : null);
const isList = (n, head) => n?.kind === "list" && n.bracket === "()" && (head == null || n.items[0]?.value === head);
// The two FM families: the OPLL's 2 operators (a ROM of voices, `romNames`)
// and the OPN's and OPM's 4. A voice goes as written within one.
const twoOp = (part) => !!part?.romNames;
// A track whose notes are tone and noise by turns — x68k fm8's `:mode noise`,
// an SSG square's `:mode noise` / `both` (a PSG drum) — on a machine whose
// channel cannot: its noise notes are a row of their own, `<head>/noise`,
// onto the noise; its tone notes stay on its row's channel.
const splitKey = (head) => `${head}/noise`;
const isSplit = (k) => /\/noise$/.test(k);
const splitHead = (k) => (isSplit(k) ? k.slice(0, -6) : k);
const NOISY = new Set(["noise", "both"]); // the modes that sound the noise
// The source voice a row is: a split's is its own.
const srcKeyOf = (from, k) => (isSplit(k) ? k : from.voiceKey(k));
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
  const waveNames = new Set([...defNames(roots, "def-wave"), ...defNames(others, "def-wave")]);
  const heads = new Map();
  for (const f of forms) {
    const head = f.items[0].value;
    const h = heads.get(head) ?? { head, part: from.partOf(head), forms: [], notes: 0, noiseNotes: 0, mode: "tone", samples: new Set(), voices: [], voiceNotes: new Map(), voice: null, waves: new Set(), noiseMode: false };
    heads.set(head, h);
    h.forms.push(f);
    walk(f.items.slice(1), (n, prev, times) => {
      if (n.kind !== "atom") return;
      if (isNote(n.value)) {
        h.notes += times;
        if (NOISY.has(h.mode)) h.noiseNotes += times;
        if (h.voice) h.voiceNotes.set(h.voice, (h.voiceNotes.get(h.voice) ?? 0) + times); // the notes each voice plays
      }
      else if (samples.has(n.value) || kit.has(n.value)) h.samples.add(n.value);
      else if (voices.has(n.value)) { h.voices.push(n.value); h.voice = n.value; }
      if (waveNames.has(n.value)) h.waves.add(n.value);
      if (prev?.value === ":mode" && NOISY.has(n.value)) h.noiseMode = true;
      if (prev?.value === ":mode" && n.kind === "atom") h.mode = n.value; // the notes after it: tone or noise
    });
  }
  // An FDS track's modulation (a depth written above 0), which the PC
  // Engine plays as its LFO (wave-port.js).
  let fdsMod = false;
  const findPmd = (n) => {
    if (n?.kind !== "list") return;
    n.items.forEach((m, i) => { if (m.value === ":lfo-pmd" && n.items[i + 1] && n.items[i + 1].value !== "0") fdsMod = true; });
    n.items.forEach(findPmd);
  };
  if (from.name === "fc" && heads.has("fds-wave")) roots.forEach(findPmd);
  // The wavetable's role macros (`wave-piano`: its waves and levels), an
  // import's snippet the conversion cannot rewrite: named, they are read as
  // their role off a wave channel.
  const ownDefs = defNames(roots, "def");
  const waveMacros = new Set([...defNames(others, "def"), ...ROLES.map((r) => `wave-${r}`)].filter((n) => /^wave-/.test(n) && !ownDefs.has(n)));
  return { roots, forms, heads, voices, samples, ownSamples, kit, waves: waveNames, fdsMod, waveMacros };
}

// Every atom of a body, in order, into the lists a body is made of.
// `times`: how often the node plays — a loop's `(x N …)` body N times — so
// a row's notes are counted as it sounds.
function walk(items, fn, times = 1) {
  let prev = null;
  for (const n of items) {
    if (isList(n) && DESCEND.has(n.items[0]?.value)) {
      const k = n.items[0].value === "x" && /^\d+$/.test(n.items[1]?.value ?? "") ? Number(n.items[1].value) : 1;
      walk(n.items.slice(1), fn, times * k);
    } else fn(n, prev, times); // a value list (a curve, a glide) is no body
    prev = n;
  }
}

// A drum row's place among the drums (lower: the beat's — the kick and the
// snare — before the toms, a rim, the cymbals and the hats): by the names
// it plays, or for a name that says nothing (an MDX's `pdx-003`) by its
// sound as heard (`heard`: name → role, import-to-midi.js heardRoles).
// A word of a name (letters on neither side: `909snare` and `tom4` are,
// `bottom`, `chat`, `prime` are not).
const word = (w) => new RegExp(`(?<![a-z])(?:${w})(?![a-z])`, "i");
const DRUM_RANKS = [[word("kick|bd|bass-?drum"), 1], [word("snare|sd|clap"), 2], [word("tom"), 3], [word("rim|cowbell|cow|perc"), 4], [word("crash|ride|cymbal|cym|splash"), 5], [word("hat|hh|hihat|hi-hat"), 6]];
const rankOfName = (n) => DRUM_RANKS.find(([re]) => re.test(n))?.[1];
// A sample's place among the drums where its name or its sound tells it; null
// for one that says nothing (a pad, a voice, a hit not heard).
const knownRank = (n, heard) => rankOfName(n) ?? (heard?.has(n) ? rankOfName(heard.get(n)) : undefined) ?? null;
function drumRank(h, heard = null) {
  const ranks = [...(h?.samples ?? [])].map((n) => knownRank(n, heard) ?? 4);
  return ranks.length ? Math.min(...ranks) : 4;
}

/**
 * A score with the defs nothing names taken out — a macro, a voice, a wave,
 * a sample of a dropped track's, one a rule replaced, one only kept — and
 * then what only they named: { text, gone } (the names, in the score's order).
 */
export function pruneUnnamedDefs(text) {
  const gone = [];
  let out = text;
  for (let pass = 0; pass < 8; pass++) {
    let roots;
    try { roots = parse(out); } catch { break; }
    const named = new Map();
    const count = (n) => {
      if (n?.kind === "atom") for (const v of new Set([n.value, String(n.value).replace(/^[$']/, "")])) named.set(v, (named.get(v) ?? 0) + 1);
      if (n?.kind === "list") n.items.forEach(count);
    };
    roots.forEach(count);
    const inside = (n, name) => { let c = 0; const w = (m) => { if (m?.kind === "atom" && m.value === name) c++; if (m?.kind === "list") m.items.forEach(w); }; w(n); return c; };
    const defs = roots.filter((n) => ["def", "def-fm", "def-wave", "def-pcm"].some((h) => isList(n, h)) && n.items[1]?.kind === "atom"
      && named.get(n.items[1].value) - inside(n, n.items[1].value) === 0);
    if (!defs.length) break;
    const starts = lineStarts(out);
    const names = [];
    for (const n of defs.sort((a, b) => b.line - a.line || b.column - a.column)) {
      const from = starts[n.line - 1] + n.column - 1, to = starts[n.endLine - 1] + n.endColumn - 1;
      // Its line too where it stood alone on it, and a blank line after.
      const lineStart = out.lastIndexOf("\n", from - 1) + 1;
      const alone = /^[ \t]*$/.test(out.slice(lineStart, from)) && out[to] === "\n";
      const end = alone && out[to + 1] === "\n" && (lineStart === 0 || out[lineStart - 2] === "\n") ? to + 2 : alone ? to + 1 : to;
      out = out.slice(0, alone ? lineStart : from) + out.slice(end);
      names.unshift(n.items[1].value);
    }
    gone.push(...names);
  }
  return { text: out, gone };
}

// A sample limited where a machine's samples come up short: driven into a
// limiter by LIMIT_DRIVE_DB, drums come out ~LIMIT_LIFT_DB louder at the
// same peak (measured on an MDX's PDX; more drive gains little).
const LIMIT_DRIVE_DB = 6;
const LIMIT_LIFT_DB = 3;

// A song's bass line: the melodic part sitting this far (semitones) under
// the next lowest, by the median note (import-to-midi.js LOW_APART).
const BASS_APART = 7;
const BASS_TOGETHER = 2; // semitones: parts this near the lowest are one bass line
const BASS_UNDER = 55; // a bass sits under G3 (import-to-midi.js LOW_UNDER)
// A bass or a melody: a part sounding at least this share of the time the
// longest-sounding (of the parts in a tune's lengths, for the melody) does;
// a melody's level read in steps of MELODY_DB (a part 3 dB down is as loud).
const PART_SHARE = 0.25;
const PART_NOTES = 4; // a line has notes to change: one held note is none
const MELODY_DB = 3;
const MELODY_ABOVE = 3; // semitones over the next part as loud

// The drums on a noise channel, where a machine has no sample channel (the
// Game Boy): each a note — its clock, low for the kick, bright for the snare,
// brighter for a rim and the cymbals, brightest for the hats — under a level
// that falls away (a hat in three frames, a cymbal in thirty), its gate as
// long (so a layer under it gives way only while it sounds). A sample whose
// name or sound says no drum plays nothing there.
const NOISE_DRUMS = {
  kick: { oct: 4, note: "a", env: "noise-kick", steps: "[0 -4 -8 -12 -15]", gate: "5f" },
  snare: { oct: 6, note: "d+", env: "noise-snare", steps: "[0 -1 -2 -3 -4 -5 -6 -7 -8 -9 -10 -11 -12 -13 -15]", gate: "15f" },
  tom: { oct: 5, note: "d+", env: "noise-tom", steps: "[0 -2 -3 -5 -6 -8 -9 -11 -13 -15]", gate: "10f" },
  rim: { oct: 6, note: "g", env: "noise-rim", steps: "[0 -7 -15]", gate: "3f" },
  cymbal: { oct: 6, note: "a", env: "noise-cymbal", steps: "[(linear 0..-15 :len 30f)]", gate: "30f" },
  hat: { oct: 6, note: "a+", env: "noise-hat", steps: "[0 -8 -15]", gate: "3f" },
};
const noiseDrumOf = (rank) => [null, "kick", "snare", "tom", "rim", "cymbal", "hat"][rank ?? 0] ?? null;

// The roles heard, as a kit has them: one kick and one snare — of the
// samples heard as kicks, the one the score names most; as snares, too (the
// listening takes a tom or a second snare for a snare); the others toms.
function heardBeat(heard, text) {
  const out = new Map(heard ?? []);
  const uses = (n) => (text.match(new RegExp(`(?<![\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g")) ?? []).length;
  for (const role of ["kick", "snare"]) {
    const these = [...out].filter(([, r]) => r === role).map(([n]) => n).sort((a, b) => uses(b) - uses(a));
    for (const n of these.slice(1)) out.set(n, "tom");
  }
  return out;
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
const kindOf = (from, key) => (isSplit(key) ? "noise" : from.partOf(key)?.kind);

// Whether `head`'s noise notes split off onto `to`'s noise: its own channel
// plays them by its :mode (x68k fm8, an SSG square), and `to`'s own squares
// cannot (the PC-8801's and the MSX's SSG can: there it stays as written).
function splits(from, to, head) {
  if (from.name === "x68k") return head === "fm8" && to.name !== "x68k";
  const p = from.partOf(head);
  if (p?.kind !== "tone" || !Object.hasOwn(p.modes ?? {}, "noise")) return false;
  return !channelsOf(to, "tone", { board: true }).some((h) => Object.hasOwn(to.partOf(h).modes ?? {}, "noise"));
}

// FM3's patch: `(fm3 voice)` or `(fm3-csm voice)` with no notes, beside
// fm3-1…fm3-4, on a machine without them — its voice goes into the operator
// tracks' and the form is taken out.
function patchHeads(s, to) {
  const ops = [...s.heads.keys()].some((h) => /^fm3-\d$/.test(h));
  if (!ops || to.channelNames.includes("fm3-1")) return new Set();
  return new Set(["fm3", "fm3-csm"].filter((h) => s.heads.get(h) && s.heads.get(h).notes === 0));
}

// A role heard (import-to-midi.js sampleRole, heardBeat) as a kit's role.
const KIT_OF_HEARD = { kick: "kick", snare: "snare", tom: "tom4", tom3: "tom4", crash: "ride", hat: "hat", "hat-open": "hat" };

/**
 * The rows of `text` onto `toName`: each channel the score writes, where it
 * goes by default, and where else it could. { from, to, rows: [{ key, head,
 * kind, notes, to, choices }] } or { error }. `to` is a channel or 'drop'.
 */
export function portRows(text, toName, { imports = null, heard = null } = {}) {
  const { s, ...plan } = planFor(text, toName, imports, heard);
  return plan;
}

// The rows, with the survey they were read from (the Porter reads it too).
// `heard`: the score's samples' roles as heard (a Map, name → role), for a
// drum whose name says nothing.
function planFor(text, toName, imports, heard = null) {
  const from = TARGETS[scoreTargetOf(text)];
  const to = TARGETS[toName];
  if (!to || !PORT_TARGETS.includes(toName)) return { error: `no conversion onto ${toName}` };
  if (!PORT_TARGETS.includes(from.name)) return { error: `the ${from.system} is not converted at the words' level` };
  let s;
  try { s = survey(text, from, imports); } catch (e) { return { error: `the score does not parse: ${e.message}` }; }
  s.heard = heardBeat(heard, text);
  // The score compiled, once, when something asks (the rows' loops, the
  // porter's middle notes and waves): on the survey for both.
  s.compiled = () => {
    if (s.ir === undefined) {
      try { s.ir = compileMMLisp(text, "score.mmlisp", { imports: imports ?? new Map() }).ir ?? null; } catch { s.ir = null; }
    }
    return s.ir;
  };
  // Each track's endless loop, as "from-to" ticks (null: none), at the
  // ticks they play, as the compiler's layering reads them (alignLayerLoops:
  // the counted loops written out) — only if rows are to share a channel.
  let loops;
  const loopOf = (head) => {
    if (!loops) {
      loops = new Map();
      for (const t of s.compiled()?.tracks ?? []) {
        const evs = t.events.some((e) => e.cmd === "LOOP_BEGIN") ? expandLoops(t.events) : t.events;
        const jumps = evs.filter((e) => e.cmd === "JUMP");
        const mark = jumps.length === 1 && evs.find((e) => e.cmd === "MARKER" && e.args?.id === jumps[0].args?.to);
        if (mark) loops.set(t.scoreChannel ?? t.channel, `${mark.tick}-${jumps[0].tick}`);
      }
    }
    return loops.get(head) ?? null;
  };
  return { from: from.name, to: to.name, rows: planRows(s, from, to, loopOf), s };
}

function planRows(s, from, to, loopOf = () => null) {
  const patch = patchHeads(s, to);
  const keys = [];
  for (const head of from.channelNames) {
    const h = s.heads.get(head);
    if (!h || patch.has(head)) continue;
    // fm8's :mode noise notes are a row of their own, onto the noise.
    if (h.noiseMode && splits(from, to, head)) keys.push(splitKey(head));
    keys.push(head);
  }
  const roleKit = to.parts.some((p) => p.kit);
  const toKit = kitRoles(to);
  // A machine with no sample channel but a ROM kit (the MSX's FM-PAC):
  // a sample whose name is no role is the kit's role it sounds as (an
  // MDX's pdx-000 heard as the kick), so its row plays on the kit.
  s.byEar = new Map();
  if (roleKit && !channelsOf(to, "sample", { board: true }).length)
    for (const [n, r] of s.heard ?? []) {
      const role = KIT_OF_HEARD[r];
      if (!toKit.has(n) && role && toKit.has(role)) s.byEar.set(n, role);
    }
  const rolesHere = (h) => roleKit && h && h.samples.size > 0 && [...h.samples].every((x) => toKit.has(x) || s.byEar.has(x));
  // A physical voice each channel taken is, and which source voice took it:
  // two of the source's on one of the destination's (md sqr3 and noise onto
  // pc88's sqr3) cannot both go there.
  const takenBy = new Map();
  const taken = new Set();
  const sampleRows = keys.some((k) => kindOf(from, k) === "sample" && s.heads.get(k)?.notes);
  // The Mega Drive's PCM owns fm6 (its DAC).
  if (to.name === "md" && sampleRows) takenBy.set(to.voiceKey("fm6"), "dac");
  const srcKey = (k) => srcKeyOf(from, k);
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
  // A kit that plays on FM channels (the FM-PAC's rhythm, on fm7-9) takes
  // them when a row plays its roles.
  const kitPart = to.parts.find((p) => p.kit && p.takes);
  const kitTakes = kitPart && keys.some((k) => kindOf(from, k) === "sample" && rolesHere(s.heads.get(k)) && s.heads.get(k)?.notes)
    ? to.channelNames.filter((h) => kitPart.takes(to.channels[h])) : [];
  for (const h of kitTakes) takenBy.set(to.voiceKey(h), "kit");
  const dest = {};
  // A split track's halves count their own notes: a part all noise has no
  // tone half to give a channel.
  const notesOf = (k) => {
    const h = s.heads.get(splitHead(k));
    if (!h) return 0;
    if (isSplit(k)) return h.noiseNotes;
    return keys.includes(splitKey(k)) ? h.notes - h.noiseNotes : h.notes;
  };
  for (const k of keys) if (notesOf(k) === 0 && keys.includes(splitKey(k))) dest[k] = "drop";
  // Rows that are one channel on both machines (fm3 and fm3-1…fm3-4, as
  // they are on pc88) need one channel between them.
  const groupOf = (k) => (!isSplit(k) && to.partOf(k)?.kind === kindOf(from, k) && keys.some((o) => o !== k && !isSplit(o) && from.voiceKey(o) === from.voiceKey(k)) ? from.voiceKey(k) : k);
  // A machine short of channels keeps the parts that play the most notes
  // (the user, 2026-11-08): past its melodic channels — FM and squares, less
  // a square its noise is and fm6 under the Mega Drive's PCM — and past its
  // noises, the parts with fewer notes are dropped before anything is placed.
  const melodic = (k) => MELODIC_KINDS.includes(kindOf(from, k)) && k !== "fm3-csm-rate";
  // The score's bass: the melodic part whose notes sit lowest, a fifth or
  // more under the next (import-to-midi.js's reading of a song's bass line),
  // read off the compiled score when the rows are short or the machine has a
  // bass channel. It is kept before the others and, on a machine with a
  // channel for a bass line (a `bass` part: the 2A03's triangle, the Game
  // Boy's wave), plays there.
  s.bass = null;
  // Each melodic row as it plays: its notes, its middle note, its middle
  // length (ticks) and its level (dB: :vel and the track's :vol, 2 dB a
  // step each), off the compiled score.
  let stats;
  const statsOf = () => {
    if (stats) return stats;
    stats = new Map();
    const middle = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // A channel's tracks (its :prio layers) together; a def-se's are the
    // game's effects, not the song.
    const raw = new Map();
    for (const t of s.compiled()?.tracks ?? []) {
      const k = t.scoreChannel ?? t.channel;
      if (t.se || !keys.includes(k) || !melodic(k) || kindOf(from, k) === "noise") continue;
      const r = raw.get(k) ?? raw.set(k, { keys: [], lens: [], levels: [] }).get(k);
      let vol = 31;
      for (const e of t.events) {
        if (e.cmd === "PARAM_SET" && e.args?.target === "VOL") vol = Number(e.args.value) || 0;
        if (e.cmd !== "NOTE_ON") continue;
        r.keys.push(pitchToMidi(e.args.pitch));
        r.lens.push(e.args.length ?? 0);
        r.levels.push(((e.args.vel ?? 15) - 15) * VEL_DB_PER_STEP + (Math.min(31, vol) - 31) * VEL_DB_PER_STEP);
      }
    }
    // `sounds`: the ticks its notes take (as written, a loop's body once) —
    // how much of the song the part is, a held bass and a run of 32nds alike.
    for (const [k, r] of raw)
      if (r.keys.length) stats.set(k, { notes: r.keys.length, mid: middle(r.keys), len: middle(r.lens), level: middle(r.levels), sounds: r.lens.reduce((a, x) => a + x, 0) });
    return stats;
  };
  // The bass: the lowest parts — those within BASS_TOGETHER of the lowest,
  // a bass line doubled (an MSX song's FM bass and its SCC copy) — sitting
  // BASS_APART under every other; of them the loudest, then the busiest.
  s.bassGroup = [];
  const bassRow = () => {
    if (s.bass !== null) return s.bass || null;
    s.bass = false;
    const st = statsOf();
    // A line, not a held note: PART_NOTES notes or more, sounding PART_SHARE
    // of the time the part sounding longest does.
    const most = Math.max(0, ...[...st.values()].map((x) => x.sounds));
    const mids = [...st].filter(([, x]) => x.notes >= PART_NOTES && x.sounds >= most * PART_SHARE).map(([k, x]) => [x.mid, k]).sort((a, b) => a[0] - b[0]);
    if (mids.length < 2) return null;
    const group = mids.filter(([m]) => m - mids[0][0] <= BASS_TOGETHER);
    const next = mids[group.length];
    if (!next || next[0] - mids[0][0] < BASS_APART || mids[0][0] >= BASS_UNDER) return null;
    s.bassGroup = group.map(([, k]) => k);
    s.bass = [...s.bassGroup].sort((a, b) => st.get(b).level - st.get(a).level || st.get(b).notes - st.get(a).notes)[0];
    return s.bass;
  };
  // The song's melody: of the parts that move in a tune's note lengths (a
  // sixth of a beat or longer — a sixteenth with its gate taken off, an MDX's
  // 22 ticks — not an arpeggio's or a trill's run of 32nds)
  // and play a part's worth of notes, the loudest, then the highest — the
  // lead a song puts over the rest. Kept before the others but the bass.
  s.melody = null;
  const melodyRow = () => {
    if (s.melody !== null) return s.melody || null;
    s.melody = false;
    const st = statsOf();
    if (st.size < 2) return null; // one part: nothing to tell apart
    const ppqn = s.compiled()?.ppqn ?? 96;
    bassRow();
    const inTune = [...st].filter(([k, x]) => !s.bassGroup.includes(k) && x.len >= ppqn / 6);
    const most = Math.max(0, ...inTune.map(([, x]) => x.sounds));
    const tunes = inTune.filter(([, x]) => x.notes >= PART_NOTES && x.sounds >= most * PART_SHARE);
    if (!tunes.length) return null;
    if (tunes.length === 1) { s.melody = tunes[0][0]; return s.melody; } // the one part in a tune's lengths
    // It must stand out: the loudest alone, or of the loudest the one
    // sitting MELODY_ABOVE over the next — parts alike (a doubled line, a
    // song of equals) name none.
    const bin = (x) => Math.round(x.level / MELODY_DB);
    tunes.sort(([, a], [, b]) => bin(b) - bin(a) || b.mid - a.mid);
    const [[k, top], [, next]] = tunes;
    if (bin(top) > bin(next) || top.mid - next.mid >= MELODY_ABOVE) s.melody = k;
    return s.melody || null;
  };
  const bassChannel = to.channelNames.find((h) => to.partOf(h)?.bass && !(to.listsExpansions && to.chipOf(h).optional));
  const isKitRow = (k) => kindOf(from, k) === "sample" && rolesHere(s.heads.get(k));
  // The channels the conversion keeps for a machine's own use: the PC
  // Engine's wave2, its LFO, when an FDS track's modulation becomes it.
  const reserved = to.name === "pce" && s.fdsMod ? ["wave2"] : [];
  for (const h of reserved) takenBy.set(to.voiceKey(h), "lfo");
  const melodicRoom = MELODIC_KINDS.reduce((n, kind) => n + channelsOf(to, kind, { board: true }).length, 0);
  // A machine whose kinds share its voices (the PC Engine: wave5, noise5 and
  // pcm5 are channel 5) has one room for them all: its voices.
  const boardKeys = (kinds) => new Set(kinds.flatMap((kind) => channelsOf(to, kind, { board: true })).map((h) => to.voiceKey(h)));
  const shared = boardKeys(["fm", "tone", "wave", "noise", "sample"]).size
    < MELODIC_KINDS.reduce((n, kind) => n + boardKeys([kind]).size, 0) + boardKeys(["noise"]).size + boardKeys(["sample"]).size;
  const pools = [
    [melodic, melodicRoom
      - (keys.some((k) => kindOf(from, k) === "noise") && channelsOf(to, "noise", { board: true }).some((n) => to.channelNames.some((h) => h !== n && to.voiceKey(h) === to.voiceKey(n))) ? 1 : 0)
      - (to.name === "md" && sampleRows ? 1 : 0)
      - kitTakes.filter((h) => channelsOf(to, "fm", { board: true }).includes(h)).length
      - reserved.length],
    [(k) => kindOf(from, k) === "noise", channelsOf(to, "noise", { board: true }).length],
    // A kit's tracks are many to its one voice; the rest are a channel each.
    // A machine whose drivers stream samples on fewer channels than it has
    // (the PC Engine's DDA: one) gives them that many.
    [(k) => kindOf(from, k) === "sample" && !rolesHere(s.heads.get(k)),
      Math.min(channelsOf(to, "sample", { board: true }).length, ...to.parts.filter((p) => p.kind === "sample" && p.streams).map((p) => p.streams))],
  ];
  if (shared) pools.push([(k) => !isKitRow(k) && k !== "fm3-csm-rate", boardKeys(["fm", "tone", "wave", "noise", "sample"]).size - reserved.length]);
  // A sample row's place among the drums (drumRank: the kick and snare
  // first, the hats last), for which keeps a channel of its own.
  const isSampleRow = (k) => kindOf(from, k) === "sample" && !rolesHere(s.heads.get(k));
  const rankOf = (g) => Math.min(...g.map((k) => drumRank(s.heads.get(k), s.heard)));
  // A machine with no sample channel plays its drums on its noise
  // (NOISE_DRUMS): a row of any drum goes there; one that plays none drops.
  const drumNoise = !channelsOf(to, "sample", { board: true }).length && !roleKit && channelsOf(to, "noise", { board: true })[0];
  const noiseDrums = drumNoise ? keys.filter((k) => isSampleRow(k) && notesOf(k) && [...(s.heads.get(k)?.samples ?? [])].some((n) => knownRank(n, s.heard) != null)) : [];
  for (const k of noiseDrums) dest[k] = "noise-drum";
  // The bass and the melody read before the pools' order asks for them.
  bassRow();
  melodyRow();
  for (const [inPool, room] of pools) {
    const groups = new Map();
    for (const k of keys.filter((k) => inPool(k) && !(k in dest && ["drop", "layer", "noise-drum"].includes(dest[k])))) groups.set(groupOf(k), [...(groups.get(groupOf(k)) ?? []), k]);
    if (groups.size <= room) continue;
    const notes = (g) => g.reduce((n, k) => n + notesOf(k), 0);
    // A row of a kind the machine has (FM onto FM) keeps its channel before
    // one that would play a stand-in (the user, 2026-11-08); among those
    // alike, the most notes.
    const own = (g) => g.some((k) => channelsOf(to, kindOf(from, k), { board: true }).length > 0);
    // Samples past the machine's sample channels (or the one its drivers
    // stream on) are not dropped: they are :prio layers on a kept one
    // (placeLayers) — and the drums that keep a channel of their own are the
    // beat's (a snare plays fewer notes than the hats, and matters more).
    const samples = (g) => g.every(isSampleRow);
    // The bass is kept before every other melodic part.
    const isBass = (g) => g.includes(bassRow());
    const isMelody = (g) => g.includes(melodyRow());
    // A copy of the bass line (the group's other parts) goes first: the bass
    // already plays what it plays.
    const isCopy = (g) => g.some((k) => s.bassGroup.includes(k) && k !== bassRow());
    const order = (a, b) => (isCopy(b) - isCopy(a)) || (isBass(a) - isBass(b)) || (isMelody(a) - isMelody(b)) || (own(a) - own(b)) || (samples(a) && samples(b) ? rankOf(b) - rankOf(a) : 0) || (notes(a) - notes(b));
    for (const g of [...groups.values()].sort(order).slice(0, groups.size - Math.max(0, room)))
      for (const k of g) dest[k] = samples(g) && room > 0 ? "layer" : "drop";
  }
  // The layers' channel: the kept sample row least among the drums (the
  // kick and snare keep theirs to themselves), of those looping as the
  // layers do — a channel has one loop (language.md §1), and a mucom88
  // song's parts each loop on their own. With one channel (the PC Engine's
  // one stream) the kept row is the loop's group playing the most notes.
  // A layer looping over other ticks than any kept row goes.
  const hostOf = {};
  if (keys.some((k) => dest[k] === "layer")) {
    const rows = keys.filter((k) => isSampleRow(k) && dest[k] !== "drop");
    let kept = rows.filter((k) => dest[k] !== "layer");
    const loopOfRow = (k) => loopOf(splitHead(k));
    const alike = (a, b) => loopOfRow(a) == null || loopOfRow(b) == null || loopOfRow(a) === loopOfRow(b);
    if (kept.length === 1) {
      // One channel: which loop it plays is the group with the most notes.
      const total = (k) => rows.filter((o) => alike(o, k)).reduce((n, o) => n + notesOf(o), 0);
      const best = [...rows].sort((a, b) => total(b) - total(a) || drumRank(s.heads.get(a), s.heard) - drumRank(s.heads.get(b), s.heard) || notesOf(b) - notesOf(a))[0];
      if (best !== kept[0]) { dest[kept[0]] = "layer"; delete dest[best]; kept = [best]; }
    }
    const byRank = [...kept].sort((a, b) => drumRank(s.heads.get(b), s.heard) - drumRank(s.heads.get(a), s.heard) || notesOf(a) - notesOf(b));
    for (const k of rows) {
      if (dest[k] !== "layer") continue;
      const host = byRank.find((h) => alike(h, k));
      if (host) hostOf[k] = host;
      else dest[k] = "drop";
    }
  }
  // With the FDS's track dropped there is no LFO to keep wave2 for.
  if (reserved.length && dest["fds-wave"] === "drop") { takenBy.delete(to.voiceKey("wave2")); reserved.length = 0; }
  // The FDS's modulating track on wave1, the PC Engine's one swayed channel.
  if (reserved.length && keys.includes("fds-wave") && dest["fds-wave"] !== "drop" && free("fds-wave", "wave1")) dest["fds-wave"] = claim("fds-wave", "wave1");
  // The bass onto the machine's bass channel, where it has one.
  if (bassChannel && bassRow() && !(bassRow() in dest) && free(bassRow(), bassChannel)) dest[bassRow()] = claim(bassRow(), bassChannel);
  // First the channels the destination has as they are: the noise before a
  // square (a drum is a drum), then in the table's order.
  const byNoise = [...keys].sort((a, b) => (kindOf(from, b) === "noise") - (kindOf(from, a) === "noise"));
  for (const k of byNoise) {
    const p = to.partOf(k);
    if (k in dest || !p || p.kind !== kindOf(from, k)) continue;
    if (p.kit && !rolesHere(s.heads.get(k))) continue; // a kit's track plays its roles
    if (p.kind === "sample" && rolesHere(s.heads.get(k))) continue; // its roles go to the ROM rhythm
    if (p.kind === "wave" && p.waveRam && channelsOf(to, "wave").some((o) => o !== k && to.partOf(o).waveRam?.(to.channels[o].voice) === p.waveRam(to.channels[k].voice) && to.channelNames.indexOf(o) < to.channelNames.indexOf(k))) continue;
    if (free(k, k)) dest[k] = claim(k, k);
  }
  // Then the rest, in the table's order (the pools above have dropped what
  // does not fit) — the noise first, so a channel it shares (the PC
  // Engine's 5 and 6) is its: channels past the source's count first
  // (x68k's fm7 and fm8), FM3's own tracks onto fm3 first. A melodic track
  // goes to its own kind first, then FM, the waves, the squares.
  const fmBoard = channelsOf(to, "fm", { board: true });
  const fmBeyond = fmBoard.filter((h) => !from.channelNames.includes(h));
  const fmOrder = [...fmBeyond, ...fmBoard.filter((h) => !fmBeyond.includes(h))];
  const fm3Order = fmOrder.includes("fm3") ? ["fm3", ...fmOrder.filter((h) => h !== "fm3")] : fmOrder;
  const fmFirst = (k) => (/^fm3/.test(k) ? fm3Order : fmOrder);
  const tones = channelsOf(to, "tone", { board: true });
  // A wave channel whose memory an earlier one has (the SCC's wave5, wave4's)
  // plays whichever wave was written last: it is taken last, after FM and
  // the squares.
  const ramOf = (h) => to.partOf(h).waveRam?.(to.channels[h].voice);
  const allWaves = channelsOf(to, "wave", { board: true });
  const sharesRam = (h) => ramOf(h) != null && allWaves.some((o) => o !== h && allWaves.indexOf(o) < allWaves.indexOf(h) && ramOf(o) === ramOf(h));
  const waves = allWaves.filter((h) => !sharesRam(h));
  const lastWaves = allWaves.filter(sharesRam);
  for (const k of byNoise) {
    if (k in dest) continue;
    const kind = kindOf(from, k);
    let cands = [];
    if (k === "fm3-csm-rate") cands = [];
    else if (kind === "fm") cands = [...fmFirst(k), ...waves, ...tones, ...lastWaves];
    else if (kind === "tone") cands = [...tones, ...waves, ...fmFirst(k), ...lastWaves];
    else if (kind === "wave") cands = [...waves, ...fmFirst(k), ...tones, ...lastWaves];
    else if (kind === "noise") cands = channelsOf(to, "noise", { board: true });
    else if (kind === "sample") cands = rolesHere(s.heads.get(k)) ? [...channelsOf(to, "sample", { kit: true }), ...channelsOf(to, "sample", { board: true })] : channelsOf(to, "sample", { board: true });
    const h = cands.find((c) => free(k, c));
    dest[k] = h ? claim(k, h) : "drop";
  }
  // A layered sample row plays on its host's channel.
  for (const k of keys) if (dest[k] === "layer") dest[k] = hostOf[k] && dest[hostOf[k]] && dest[hostOf[k]] !== "drop" ? dest[hostOf[k]] : "drop";
  // The drums on the noise, as :prio layers over its own part (the
  // beat first): they loop as one, so a row looping on other ticks than the
  // drums goes — the noise's own part first, being decoration.
  if (noiseDrums.length) {
    const on = keys.filter((k) => dest[k] === drumNoise || noiseDrums.includes(k));
    const loopOfRow = (k) => loopOf(splitHead(k));
    const top = [...noiseDrums].sort((a, b) => drumRank(s.heads.get(a), s.heard) - drumRank(s.heads.get(b), s.heard) || notesOf(b) - notesOf(a))[0];
    const alike = (k) => loopOfRow(k) == null || loopOfRow(top) == null || loopOfRow(k) === loopOfRow(top);
    for (const k of on) dest[k] = alike(k) ? drumNoise : "drop";
  }
  const choicesOf = (k) => {
    const kind = kindOf(from, k);
    if (to.partOf(k)?.kind === kind && !to.partOf(k).kit && to.channelNames.includes(k) && !channelsOf(to, kind).includes(k)) return [k, "drop"]; // fm3-1 … as they are
    if (k === "fm3-csm-rate") return ["drop"];
    if (["fm", "tone", "wave"].includes(kind)) return [...channelsOf(to, "fm"), ...channelsOf(to, "wave").filter((h) => !reserved.includes(h)), ...channelsOf(to, "tone"), "drop"];
    if (kind === "noise") return [...channelsOf(to, "noise"), "drop"];
    if (drumNoise && kind === "sample") return [...channelsOf(to, "noise"), "drop"];
    return [...channelsOf(to, "sample"), ...(rolesHere(s.heads.get(k)) ? channelsOf(to, "sample", { kit: true }) : []), "drop"];
  };
  return keys.map((k) => ({
    key: k,
    head: splitHead(k),
    kind: kindOf(from, k),
    notes: notesOf(k),
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
export function portScore(text, toName, { rows = {}, imports = null, header = true, names = {}, heard = null, peaks = null } = {}) {
  const plan = planFor(text, toName, imports, heard);
  if (plan.s) plan.s.peaks = peaks ?? new Map();
  if (plan.error) return { error: plan.error };
  const from = TARGETS[plan.from];
  const to = TARGETS[toName];
  if (from === to) return { text, map: {}, said: [] };
  const map = Object.fromEntries(plan.rows.map((r) => [r.key, rows[r.key] ?? r.to]));
  for (const r of plan.rows)
    if (map[r.key] !== "drop" && !r.choices.includes(map[r.key])) return { error: `${r.head} cannot go to ${map[r.key]} on the ${to.system}` };
  // One channel a row, and one physical voice a source voice: fm3 and
  // fm3-1 are one channel on both machines, md's sqr3 and noise are not.
  const seen = new Map();
  const srcKey = (k) => srcKeyOf(from, k);
  for (const [k, h] of Object.entries(map)) {
    if (h === "drop" || to.partOf(h).kit) continue;
    const key = to.voiceKey(h);
    const prev = seen.get(key);
    // Sample rows on one sample channel are its :prio layers (placeLayers).
    // So are drum rows on a noise channel (NOISE_DRUMS), with its own part.
    const layers = prev && prev.h === h && ((to.partOf(h).kind === "sample" && kindOf(from, k) === "sample" && kindOf(from, prev.k) === "sample")
      || (to.partOf(h).kind === "noise" && [k, prev.k].some((x) => kindOf(from, x) === "sample") && [k, prev.k].every((x) => ["sample", "noise"].includes(kindOf(from, x)))));
    if (prev && !layers && (prev.h === h || srcKey(prev.k) !== srcKey(k)))
      return { error: prev.h === h ? `${prev.k} and ${k} both go to ${h}` : `${prev.k} (to ${prev.h}) and ${k} (to ${h}) are one channel of the ${to.system}` };
    seen.set(key, { k, h });
  }
  if (to.name === "md" && Object.values(map).some((h) => /^pcm/.test(h)) && Object.values(map).includes("fm6"))
    return { error: "fm6 is the Mega Drive's DAC while the score plays PCM: send that row to another channel" };
  return new Porter(text, from, to, map, imports, names, plan.s).run(header);
}

class Porter {
  constructor(text, from, to, map, imports, names, s) {
    this.names = names;
    this.text = text;
    this.from = from;
    this.to = to;
    this.map = map;
    this.s = s;
    this.imports = imports;
    this.said = new Set();
    this.starts = lineStarts(text);
    this.patch = patchHeads(this.s, to);
    this.toKit = kitRoles(to);
    this.opVoices = new Map(); // `${voice}-op${n}` → [voice, n]
    this.standIns = new Set();
    this.patchCarry = this.readPatch();
    this.opFormVoice = this.readOpVoices();
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
    this.replacedWaves = new Set(); // def-wave names a conversion leaves unplayed
    this.replacedSnippets = new Set(); // a def a conversion leaves unnamed (an FDS table's)
    this.waveMacroOn = new Set(); // the heads a role's wave macro is running on
    this.octShift = new Map(); // head → the octaves its stand-in is written up, for its voice's carrier
    this.setupLfo();
    this.userVoice = this.pickUserVoice();
    this.layerPrio = this.placeLayers();
    this.mix = this.mixBalance();
    // Drums onto a ROM kit the user brings (the PC-8801's rhythm): without
    // the ROM the score's samples under the roles' names stand in, so a
    // score with none for the roles it plays takes presets/rx5's, as a
    // mucom88 import does — else, ROM-less, they would be silent.
    const romRows = Object.entries(map).filter(([, h]) => h !== "drop" && to.partOf(h)?.kit && to.partOf(h).userRom);
    const roles = new Set(romRows.flatMap(([k]) => [...(this.s.heads.get(splitHead(k))?.samples ?? [])].map((n) => this.s.byEar?.get(n) ?? n)));
    if ([...roles].some((r) => !this.s.samples.has(r))) {
      this.needsKit = true;
      this.say(`the ${to.system}'s ${romRows.length ? to.partOf(romRows[0][1]).label : "rhythm"} plays a ROM you bring (File > Import); without it presets/rx5's samples stand in for the roles the score has none of`);
    }
    if (this.s.melody && this.map[this.s.melody] && this.map[this.s.melody] !== "drop")
      this.say(`${this.nameOf(this.s.melody)} is the melody (the loudest and highest part in a tune's note lengths): kept, on ${this.map[this.s.melody]}`);
    if (this.s.bass && this.map[this.s.bass] && this.map[this.s.bass] !== "drop") {
      const h = this.map[this.s.bass];
      this.say(`${this.nameOf(this.s.bass)} is the bass (its notes sit a fifth or more under the rest): ${this.to.partOf(h)?.bass ? `it plays on ${h}, the ${this.to.system}'s bass channel` : `kept, on ${h}`}`);
    }
    // Two rows on channels of one wave memory (the SCC's wave4 and wave5):
    // the wave written last plays on both — said where their waves differ.
    const byRam = new Map();
    for (const [k, h] of Object.entries(map)) {
      const ram = h !== "drop" && to.partOf(h)?.waveRam?.(to.channels[h].voice);
      if (ram == null || ram === false) continue;
      byRam.set(ram, [...(byRam.get(ram) ?? []), [k, h]]);
    }
    for (const rows of byRam.values()) {
      if (rows.length < 2) continue;
      const sets = rows.map(([k]) => [...(this.s.heads.get(k)?.waves ?? [])].sort().join(" "));
      if (sets.some((x) => x !== sets[0]) || sets.some((x) => !x))
        this.say(`${rows.map(([k, h]) => `${this.nameOf(k)} (${h})`).join(" and ")} share one wave memory on the ${to.system}: the wave written last plays on both`);
    }
    this.envDefs = new Map(); // a voice's envelope macro, onto a wave channel
    this.splits = new Set(Object.keys(map).filter(isSplit).map(splitHead));
  }

  say(line) { this.said.add(line); }
  toHas(w) { return [...this.toParts].some((p) => p.words(w) || p.songWords?.(w)); }
  // A source channel as the log names it: the song's own name for it where
  // the caller has one (an MDX's FM G for fm7), else the channel.
  nameOf(head) { return head == null ? "a def" : isSplit(head) ? this.nameOf(splitHead(head)) : this.names[head] ?? head; }

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
      else if (head === "def-wave") replace(n, this.defWave(n));
      else if (head === "def-pcm") replace(n, this.louder(n, this.defPcm(n)));
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
    if (this.lfoTrack) out = `${out.replace(/\s*$/, "")}\n${this.lfoTrack}\n`;
    out = this.pruneVoices(out);
    out = this.pruneEmptyDefs(out);
    out = this.pruneUnnamed(out);
    out = this.placeLfo(out);
    out = this.addHeader(out, [...added.values()].flat(), header);
    return { text: out, map: this.map, said: [...this.said] };
  }

  // A def the conversion left empty — a section whose channels all went, a
  // snippet of words the machine has not — goes, and every place that names
  // it: it plays nothing there.
  pruneEmptyDefs(out) {
    let roots;
    try { roots = parse(out); } catch { return out; }
    const empty = new Set(roots.filter((n) => isList(n, "def") && n.items.length === 2 && n.items[1]?.kind === "atom").map((n) => n.items[1].value));
    if (!empty.size) return out;
    const starts = lineStarts(out);
    const at = (line, col) => starts[line - 1] + col - 1;
    const cuts = [];
    const visit = (n, top) => {
      if (isList(n, "def") && empty.has(n.items[1]?.value) && n.items.length === 2) {
        const a = at(n.line, n.column), b = at(n.endLine, n.endColumn);
        cuts.push([a, out[b] === "\n" ? b + 1 : b]);
        return;
      }
      if (n?.kind === "atom" && empty.has(n.value)) {
        const a = at(n.line, n.column), b = a + String(n.value).length;
        // The name and a space after it; at a root its line.
        cuts.push(top && out[b] === "\n" ? [a, b + 1] : out[b] === " " ? [a, b + 1] : out[a - 1] === " " ? [a - 1, b] : [a, b]);
        return;
      }
      if (n?.kind === "list") n.items.forEach((m, i) => (i === 0 && n.bracket === "()" ? null : visit(m, false)));
    };
    roots.forEach((n) => visit(n, true));
    for (const name of empty) this.say(`${name}: nothing of it is left on the ${this.to.system}; the def and the places it is named are taken out`);
    for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
    return out;
  }

  // The converted score holds only what it plays (pruneUnnamedDefs).
  pruneUnnamed(out) {
    const { text, gone } = pruneUnnamedDefs(out);
    if (gone.length) this.say(`defs nothing plays on the ${this.to.system} taken out: ${gone.join(" ")}`);
    return text;
  }

  // The song's LFO, on for the OPLL's vibrato and tremolo read as :fms /
  // :ams: written once, after the head of the score's first channel form
  // (a song word goes on any track), unless the score sets one.
  placeLfo(out) {
    const words = [...(this.carried ?? [])];
    if (this.needsLfo && !/:lfo-rate\b/.test(out) && !words.some((w) => w.startsWith(":lfo-rate"))) words.push(`:lfo-rate ${OPLL_LFO_RATE}`);
    if (!words.length) return out;
    let roots;
    try { roots = parse(out); } catch { return out; }
    const isForm = (n) => isList(n) && this.to.channelNames.includes(n.items[0]?.value);
    const form = roots.flatMap((n) => (isList(n, "def") ? n.items.slice(2) : [n])).find(isForm);
    if (!form) {
      this.say(`${words.join(" ")}: no track is left to carry them`);
      return out;
    }
    // A word the track sets itself before its first note is its own.
    const own = new Set(leadWords(form).map(([kw]) => kw));
    const add = words.filter((w) => !own.has(w.split(" ")[0]));
    if (!add.length) return out;
    const head = form.items[form.items[1]?.value === ":prio" ? 2 : 0];
    const at = lineStarts(out)[head.line - 1] + head.column - 1 + String(head.value).length;
    return `${out.slice(0, at)} ${add.join(" ")}${out.slice(at)}`;
  }

  // A dropped track's song words — its tempo, the fader, the LFO — written
  // before its first note are the song's from its start: they go onto the
  // first track kept (placeLfo). One written later is said.
  carrySongWords(n, head) {
    const ctx = this.ctx(null);
    let before = true;
    const walkItems = (items) => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "atom" && (isNote(it.value) || /^_/.test(it.value))) before = false;
        if (isList(it) && DESCEND.has(it.items[0]?.value)) { walkItems(it.items.slice(1)); continue; }
        if (it.kind !== "atom" || !/^:(tempo|master|lfo-)/.test(it.value) || i + 1 >= items.length) continue;
        // An LFO word is the song's on FM (the OPN's, the OPM's); the FDS's is
        // its own modulator's, nothing to another machine's LFO.
        const part = this.from.partOf(splitHead(head));
        if (/^:lfo-/.test(it.value) && !(part?.kind === "fm" && part.songWords?.(canonicalTarget(it.value)))) { i++; continue; }
        const val = items[i + 1];
        i++;
        if (!before) { this.say(`${it.value} on ${this.nameOf(head)}, after its first note: the track is not converted, so the change is not kept`); continue; }
        const r = it.value === ":tempo" || it.value === ":master" ? {} : this.wordRule(it.value, val, ctx);
        if (r.drop) continue;
        (this.carried ??= []).push(r.replace ?? `${it.value} ${this.slice(val)}`);
      }
    };
    walkItems(n.items.slice(n.items[1]?.value === ":prio" ? 3 : 1));
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
    // A 4-op def under a ROM voice's name would hide it: it goes, named or
    // not (its name then plays the ROM's). Every other def a rule left
    // unnamed goes with the rest (pruneUnnamed).
    if (!this.shadowing.size) return out;
    let roots;
    try { roots = parse(out); } catch { return out; }
    const starts = lineStarts(out);
    const gone = roots.filter((n) => isList(n, "def-fm") && this.shadowing.has(n.items[1]?.value)).map((n) => {
      const from = starts[n.line - 1] + n.column - 1, to = starts[n.endLine - 1] + n.endColumn - 1;
      return { from, to: out[to] === "\n" ? to + 1 : to };
    });
    for (const g of gone.sort((a, b) => b.from - a.from)) out = out.slice(0, g.from) + out.slice(g.to);
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
    if (this.needsWaves && !imported(WAVETABLE_SET)) lines.push(`(import "${WAVETABLE_SET}")`);
    lines.push(...this.envDefs.values());
    lines.push(...opDefs);
    // The mix kept (mixBalance): a channel's notes moved by a def-mod.
    for (const [n, hs] of this.mix?.steps ?? []) lines.push(`(def-mod :ch ${hs.length > 1 ? `[${hs.join(" ")}]` : hs[0]} :vel+ ${n}) ; beside the samples, as on the ${this.from.system}`);
    if (this.mix?.gain) lines.push(`(def-mod :voice ${this.mix.samples.length > 1 ? `[${this.mix.samples.join(" ")}]` : this.mix.samples[0]} :vel+ ${-this.mix.gain}) ; the samples beside the melody, as on the ${this.from.system}`);
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

  // A 64-step wave (the FDS's) onto a machine whose waves are 32: written
  // out at the 32 steps the chip plays (every other), as the compiler would
  // read it, said.
  defWave(n) {
    const name = n.items[1]?.value;
    const steps = this.waveSteps(name);
    const holds64 = [...this.toParts].some((p) => p.waveLen === 64);
    if (!steps || steps.length !== 64 || holds64 || ![...this.toParts].some((p) => p.kind === "wave")) return this.slice(n);
    this.say(`wave '${name}': 64 steps (the FDS's) written as the 32 the ${this.to.system} plays, every other one`);
    return `(def-wave ${name} :wave [${wave32(steps).join(" ")}])`;
  }

  // 4-op onto the OPLL, which has one user voice for all its channels: the
  // score's own voice that plays the most notes on an FM row keeps itself,
  // read as two operators; the others play the ROM's (onOpll), so voices
  // sounding at once do not fight over the one register set.
  pickUserVoice() {
    const fm = this.toFm;
    if (!fm || !twoOp(fm) || twoOp(this.fromFm)) return null;
    const own = (v) => {
      const d = this.voices.get(v);
      return d && !d.imported && !roleOf(v) && !fm.romNames.includes(v);
    };
    const notes = new Map();
    for (const [head, h] of this.s.heads) {
      const dest = this.map[head];
      if (!dest || dest === "drop" || this.to.partOf(dest)?.kind !== "fm") continue;
      for (const [v, k] of h.voiceNotes) if (own(v)) notes.set(v, (notes.get(v) ?? 0) + k);
    }
    const [best] = [...notes].sort((a, b) => b[1] - a[1]);
    if (!best) return null;
    if (notes.size > 1) this.say(`the ${fm.label} has one user voice: '${best[0]}' (${best[1]} notes) keeps it, read as two operators; the score's ${notes.size - 1} other voice${notes.size > 2 ? "s" : ""} play the ROM's nearest`);
    else this.say(`the ${fm.label}'s one user voice: '${best[0]}', read as two operators`);
    return best[0];
  }

  // Sample rows sharing one channel (the PC Engine streams one): each a
  // :prio layer (language.md §1), the drums' order — the kick and snare
  // over toms, a rim or clap, cymbals and the hats last — so where two hit
  // at once the beat's sounds win.
  placeLayers() {
    const byDest = new Map();
    for (const [k, h] of Object.entries(this.map)) {
      if (h === "drop" || this.to.partOf(h)?.kit) continue;
      // A sample channel's rows, and a noise channel's where drums play on it.
      const kind = this.to.partOf(h)?.kind;
      if (kind !== "sample" && !(kind === "noise" && Object.entries(this.map).some(([o, d]) => d === h && this.from.partOf(splitHead(o))?.kind === "sample"))) continue;
      byDest.set(h, [...(byDest.get(h) ?? []), k]);
    }
    const out = new Map();
    // The rows that play shots alone (no :mode, no gate of their own).
    this.shotRows = new Set();
    for (const [h, ks] of byDest) {
      if (ks.length < 2) continue;
      // Each its own :prio — forms of an equal one append, not layer — in
      // the drums' order, the busier first among alike; a row's own layers
      // (its forms' :prio) each a number of their own, in their order.
      const order = [...ks].sort((a, b) => drumRank(this.s.heads.get(a), this.s.heard) - drumRank(this.s.heads.get(b), this.s.heard) || (this.s.heads.get(b)?.notes ?? 0) - (this.s.heads.get(a)?.notes ?? 0));
      let next = 1;
      for (const k of order) {
        const own = [...new Set((this.s.heads.get(splitHead(k))?.forms ?? []).map((f) => (f.items[1]?.value === ":prio" ? String(f.items[2]?.value) : "")))];
        own.sort((a, b) => (a === "" ? 8 : Number(a)) - (b === "" ? 8 : Number(b)));
        for (const p of own) out.set(`${k}|${p}`, next++);
      }
      for (const k of ks) {
        const words = this.s.heads.get(k)?.forms.map((f) => this.text.slice(this.starts[f.line - 1] + f.column - 1, this.starts[f.endLine - 1] + f.endColumn - 1)).join(" ") ?? "";
        if (!/:mode|:gate/.test(words) && this.from.partOf(splitHead(k))?.kind === "sample" && this.to.partOf(h)?.kind === "sample") this.shotRows.add(k);
      }
      const streams = this.to.partOf(h).streams;
      this.say(`${ks.map((k) => this.nameOf(k)).join(", ")} share ${h} as :prio layers${streams ? ` (the ${this.to.system}'s drivers stream samples on ${streams === 1 ? "one channel" : `${streams} channels`})` : ""}: where two hit at once, the lower :prio sounds`);
    }
    return out;
  }

  // A sample row left out where the machine streams samples on fewer
  // channels than the score has rows: one channel has one loop, and this
  // row's is not the ones kept (planRows).
  loopWhy(head) {
    if (this.from.partOf(head)?.kind !== "sample") return "";
    const on = Object.entries(this.map).filter(([k, h]) => k !== head && h !== "drop" && this.to.partOf(h)?.kind === "sample" && !this.to.partOf(h).kit && this.from.partOf(k)?.kind === "sample");
    const streams = this.to.parts.find((p) => p.kind === "sample" && p.streams)?.streams;
    if (!on.length || !streams) return "";
    return `: the ${this.to.system} streams samples on ${streams === 1 ? "one channel" : `${streams} channels`}, a channel has one loop, and ${this.nameOf(head)} loops over other ticks than ${on.map(([k]) => this.nameOf(k)).join(", ")} on ${on[0][1]}`;
  }

  defFm(n) {
    const fm = this.toFm;
    const name = n.items[1]?.value;
    if (!fm) return this.slice(n); // played as a wave or a square: the def goes if nothing plays it
    // A 4-op voice onto the OPLL: a role's (or a ROM name's) plays the ROM
    // and its def goes if nothing plays it; any other is read as two operators.
    if (twoOp(fm) && !twoOp(this.fromFm)) {
      const d = this.voices.get(name);
      const onFm = Object.values(this.map).some((h) => this.to.partOf(h)?.kind === "fm");
      if (!d || !onFm || name !== this.userVoice) return this.slice(n);
      const r = opnAs2op(name, d.words);
      if (r.without.length) this.say(`'${name}' as two operators plays without ${r.without.join(", ")}`);
      return r.text;
    }
    if (twoOp(this.fromFm) && twoOp(fm)) return this.slice(n);
    // An OPLL user voice onto 4-op: the same voice, read as 4-op.
    if (twoOp(this.fromFm)) {
      const d = this.voices.get(name);
      if (!d) return this.slice(n);
      const r = opllDefAs4op(name, d.words);
      if (r.without.length) this.say(`'${name}' plays without ${r.without.join(", ")}: a 4-op chip has none`);
      if (r.lfo) {
        this.needsLfo = true;
        this.say(`'${name}': the ${this.fromFm.label}'s vibrato / tremolo read as :fms ${OPLL_VIB_FMS} / :ams ${OPLL_AM_AMS} on the song's LFO (:lfo-rate ${OPLL_LFO_RATE})`);
      }
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

  // The score's samples beside its melody, as near as the machine allows
  // without the song playing quieter than it did: each machine's parts at
  // full level (part-levels.js) differ — the X68000's ADPCM 17 dB over its
  // FM, the Mega Drive's DAC one FM channel's — so where the samples come
  // up short they are limited (louder in loudness at the same peak, ~3 dB
  // on drums: LIMIT_LIFT_DB) and a melodic track comes down — but only as
  // far as the machine plays it louder than the source did, never under
  // the level it had. A track that would have to go up takes the rest down
  // instead, the samples too. Every move is a `def-mod … :vel+ N` line (2
  // dB a step), one a step — the tracks' by :ch, the samples' by :voice —
  // so the score's own notes and defs stay as written. `peaks`: the
  // samples' own headroom, which the normalize lifts them by.
  mixBalance() {
    const L = (t, kind) => PART_LEVELS[t]?.[kind === "noise" ? "tone" : kind];
    const from = this.from.name, to = this.to.name;
    const sampleRows = Object.entries(this.map).filter(([k, h]) => h !== "drop" && this.from.partOf(splitHead(k))?.kind === "sample" && this.to.partOf(h)?.kind === "sample" && !this.to.partOf(h).kit);
    if (!sampleRows.length || L(from, "sample") == null || L(to, "sample") == null) return null;
    const played = [...new Set(sampleRows.flatMap(([k]) => [...(this.s.heads.get(splitHead(k))?.samples ?? [])]))];
    const known = played.map((n) => this.s.peaks?.get(n)).filter((x) => x != null).sort((a, b) => a - b);
    const room = known.length ? Math.min(0, known[Math.floor(known.length / 2)]) : 0;
    // Each melodic track: where it must go to sit over the samples as at
    // the source (+ up, − down), and how much louder the machine plays it.
    const want = new Map(), louder = new Map();
    for (const [k, h] of Object.entries(this.map)) {
      if (h === "drop") continue;
      const sk = isSplit(k) ? "noise" : this.from.partOf(k)?.kind, dk = this.to.partOf(h)?.kind;
      if (!["fm", "tone", "wave", "noise"].includes(sk) || !["fm", "tone", "wave", "noise"].includes(dk)) continue;
      const a = L(from, sk), b = L(to, dk);
      if (a == null || b == null) continue;
      want.set(h, a - L(from, "sample") - room - (b - L(to, "sample")));
      louder.set(h, Math.max(0, b - a));
    }
    if (!want.size) return null;
    // Short: a track that cannot come down far enough for the balance
    // (further than the machine plays it louder): the samples are limited.
    const limit = [...want].some(([h, d]) => d < -louder.get(h));
    const move = new Map([...want].map(([h, d]) => [h, Math.max(d + (limit ? LIMIT_LIFT_DB : 0), -louder.get(h))]));
    const up = Math.max(0, ...move.values());
    const steps = new Map();
    for (const [h, d] of move) {
      const n = Math.round((d - up) / VEL_DB_PER_STEP);
      if (n) steps.set(n, [...(steps.get(n) ?? []), h]);
    }
    // The samples' own move, in :vel steps too (a def-mod on their names).
    const gain = Math.round(up / VEL_DB_PER_STEP);
    const samples = gain ? played : [];
    if (!steps.size && !gain && !limit) return null;
    const left = Math.max(0, ...[...want].map(([h, d]) => -(d + (limit ? LIMIT_LIFT_DB : 0)) - louder.get(h)));
    this.say(`the samples beside the melody as on the ${this.from.system}: the ${this.to.system}'s parts play at other levels (part-levels.js)${limit ? "; the samples limited (louder, the same peak)" : ""}${steps.size ? `; ${[...steps].map(([n, hs]) => `${hs.join(" ")} :vel+ ${n}`).join(", ")} (def-mod, no further than the ${this.to.system} plays them louder)` : ""}${gain ? `; the samples :vel+ ${-gain}` : ""}${left > 1 ? `; still ${Math.round(left)} dB under, the song not made quieter for it` : ""}`);
    return { steps, gain, samples, limit };
  }

  // A sample onto another machine plays at its peak (`:fx` … (normalize)):
  // the machine's sample output is its own — the Mega Drive's DAC one FM
  // channel's level, the PC Engine's DDA 5 bits — and a sample left at the
  // level it had beside the other's chips sinks under them (an MDX's drums
  // on the Mega Drive: the kick alone was heard). One of its own :file only;
  // a variant of it takes its base's.
  louder(n, text) {
    const onSamples = Object.values(this.map).some((h) => h !== "drop" && this.to.partOf(h)?.kind === "sample" && !this.to.partOf(h).kit);
    // A def of its own :file, or a variant with an :fx of its own (which
    // replaces its base's chain, normalize and all); one without takes its
    // base's. Limited only where it is a drum (a name or a sound that says
    // so): a pad driven into a limiter is squashed, and the lift was
    // measured on hits.
    const own = n.items.some((x) => x.value === ":file") || n.items.some((x) => x.value === ":fx");
    if (!onSamples || !own || /\(normalize\b/.test(text)) return text;
    const name = n.items[1]?.value;
    const drum = rankOfName(name) != null || this.s.heard?.has(name);
    const tail = ` (normalize)${this.mix?.limit && drum ? ` (gain ${LIMIT_DRIVE_DB}) (limit)` : ""}`;
    if (!this.saidLouder) { this.saidLouder = true; this.say(`the samples play at their peak on the ${this.to.system} (:fx … (normalize)): its sample output is its own, not the ${this.from.system}'s`); }
    const fx = text.match(/:fx\s*\[/);
    if (fx) {
      // The chain's closing bracket: the first ] past :fx [ at its depth.
      let depth = 0;
      for (let i = fx.index + fx[0].length - 1; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]" && --depth === 0) return `${text.slice(0, i)}${tail}${text.slice(i)}`;
      }
      return text;
    }
    return text.replace(/\)\s*$/, ` :fx [${tail.trim()}])`);
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
      // A section with nothing left goes, with its name where it plays (pruneEmptyDefs).
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
      // A split's noise notes are the source machine's noise.
      srcPart: head ? (isSplit(head) ? this.from.partOf("noise") ?? this.from.partOf(splitHead(head)) : this.from.partOf(head)) : null,
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
    // A drum row on a noise channel: each drum a noise note
    // (NOISE_DRUMS), the rest silent; the role goes on from form to form.
    if (src?.kind === "sample" && dst?.kind === "noise") c.drumNoise = ((this.drumNoiseState ??= new Map()).get(head) ?? this.drumNoiseState.set(head, { role: null }).get(head));
    // A noise between a pitched one and the others is read note by note.
    if (src?.kind === "noise" && dst?.kind === "noise") {
      const from = noiseModel(src), to = noiseModel(dst);
      // Between two pitched noises too: the 2A03's note 48 and the Game
      // Boy's are rates far apart.
      if ((from !== to && (from === "pitch" || to === "pitch")) || (from === "pitch" && to === "pitch" && src.name !== dst.name))
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
    if (this.splits.has(head)) {
      // A channel's forms of one :prio append (language.md §1): the mode
      // goes on from one to the next.
      const layer = `${head}|${n.items[1]?.value === ":prio" ? n.items[2]?.value : ""}`;
      const state = (this.splitState ??= new Map()).get(layer) ?? { mode: "tone" };
      this.splitState.set(layer, state);
      // Each half walks the form from the layer's state; the one walked last
      // leaves it where the form ends.
      const noiseDropped = this.map[splitKey(head)] === "drop";
      const tone = this.map[head] === "drop" ? null : this.oneForm(n, this.ctx(head, { split: "tone", state: noiseDropped ? state : { ...state } }));
      const noise = noiseDropped ? null : this.oneForm(n, this.ctx(splitKey(head), { split: "noise", state }));
      if (tone == null && noise == null) {
        this.carrySongWords(n, head);
        this.say(`${this.nameOf(head)} (${notes(this.s.heads.get(head).notes)}) is not converted`);
        return null;
      }
      return [tone, noise].filter((x) => x != null).join("\n");
    }
    if (this.map[head] === "drop" || this.map[head] == null) {
      this.carrySongWords(n, head);
      const why = head === "fm3-csm-rate" ? `: the ${this.to.system} has no CSM` : this.loopWhy(head);
      this.say(`${this.nameOf(head)} (${notes(this.s.heads.get(head)?.notes ?? 0)}) is not converted${why}`);
      return null;
    }
    return this.oneForm(n, this.ctx(head));
  }

  oneForm(n, ctx) {
    const at = n.items[1]?.value === ":prio" ? 2 : 0; // the head option
    // The noise's state, too, goes on from one form of a layer to the next.
    if (ctx.noise) {
      const layer = `${ctx.head}|${at ? n.items[2]?.value : ""}`;
      const kept = (this.noiseState ??= new Map()).get(layer);
      if (kept) ctx.noise = kept;
      this.noiseState.set(layer, ctx.noise);
      ctx.noise.last = null;
    }
    const { outs, after } = this.body(n.items, at + 1, ctx);
    outs[0] = ctx.dest;
    const layerKey = `${ctx.head}|${at ? String(n.items[2]?.value) : ""}`;
    const prio = this.layerPrio.get(layerKey);
    if (prio != null) {
      // A shot plays to its end whatever its gate: a hit holds the channel a
      // tick, so a lower layer gives way only where both strike at once and
      // past that the latest hit sounds, as one stream plays them. Each layer
      // is a timeline of its own: its first form takes the gate.
      const gate = !(this.gated ??= new Set()).has(layerKey) && this.shotRows.has(ctx.head) ? " :gate 1t" : "";
      this.gated.add(layerKey);
      if (at) outs[2] = `${prio}${gate}`;
      else outs[0] = `${ctx.dest} :prio ${prio}${gate}`;
    }
    const lead = [];
    // The first form of the head carries what the conversion adds: the
    // patch's tempo and voice on an operator track, a stand-in voice.
    const first = !this.started?.has(ctx.head);
    (this.started ??= new Set()).add(ctx.head);
    if (first && ctx.opN && this.patchCarry?.tempo && !this.tempoCarried) { lead.push(`:tempo ${this.patchCarry.tempo}`); this.tempoCarried = true; }
    // An operator track's form starts under the patch's voice: the patch
    // form's (first form), or one another operator track's n-th form sets.
    // On a 4-op channel a one-operator voice of the patch; on the OPLL the
    // patch voice's role or waveform; on a wave its wave; on a square none.
    if (ctx.opN && !ctx.hasVoiceFirst) {
      const j = this.formIndex(n, ctx.head);
      const v = this.opFormVoice?.get(j) ?? (first ? this.patchCarry?.voice : null);
      if (v && ctx.destPart?.kind === "fm") lead.push(twoOp(ctx.destPart) ? this.voiceRule(v, ctx) ?? v : this.opVoice(v, ctx.opN));
      if (v && ctx.destPart?.kind === "wave") lead.push(this.voiceOnWave(v, ctx));
    }
    // An FM track that names no voice plays init-fm, a sine; a wave channel
    // starts on a square.
    if (first && ctx.srcPart.kind === "fm" && ctx.destPart.kind === "wave" && !this.s.heads.get(ctx.head)?.voices.length && !(ctx.opN && this.patchCarry?.voice)) {
      this.needsWaves = true;
      lead.push("sine");
    }
    if (first && ctx.srcPart.kind === "tone" && ctx.destPart.kind === "wave") {
      // The 2A03's triangle and the VRC6's saw keep their shape.
      const shape = TONE_SHAPE[ctx.srcPart.name] ?? "square";
      this.needsWaves = true;
      lead.push(shape);
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} as presets/wavetable's ${shape}`);
    }
    if (first && ctx.srcPart.kind !== "fm" && ctx.srcPart.kind !== "wave" && ctx.destPart.kind === "fm") {
      const v = this.standIn(ctx.destPart);
      lead.push(v);
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} as ${v} (a stand-in for its square)`);
    }
    if (ctx.srcPart.kind === "fm" && ctx.destPart.kind === "tone")
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest}, the ${ctx.destPart.label}, without its voice`);
    if (ctx.split === "noise") {
      const tone = this.map[splitHead(ctx.head)];
      this.say(`${this.nameOf(ctx.head)}'s noise notes (:mode ${this.from.name === "x68k" ? "noise" : "noise / both"}) play on ${ctx.dest}${tone === "drop" ? "; its tone notes are not converted" : `, its tone notes on ${tone}`}`);
    }
    if (ctx.opN && ctx.destPart?.kind === "fm" && !twoOp(ctx.destPart)) this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} under a one-operator voice of the patch (operator ${ctx.opN} the carrier)`);
    if (ctx.head === "fm3-csm" && ctx.dest !== "fm3-csm") this.say(`${this.nameOf("fm3-csm")} plays its notes on ${ctx.dest}: the ${this.to.system} has no CSM`);
    if (first && ctx.flatPitch && this.s.heads.get(ctx.head)?.notes) {
      lead.push(":oct 4");
      this.say(`${this.nameOf(ctx.head)} plays on ${ctx.dest} at c4: the ${ctx.destPart.label} has one pitch a sound`);
    }
    if (first && this.lfoLead && ctx.dest === "fds-wave") lead.push(this.lfoLead);
    if (first && this.leadOn?.[ctx.dest]) lead.push(this.leadOn[ctx.dest]);
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
        if (ctx.noise && !(ctx.split && v === ":mode") && typeof v === "string" && /^:(mode|noise-rate|oct\+?)$/.test(v) && i + 1 < items.length) {
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
          outs[i] = ctx.split && ctx.state.mode !== ctx.split ? restOf(v) : this.noiseNote(v, ctx);
          continue;
        }
        const shift = ctx.head ? this.octShift.get(ctx.head) ?? 0 : 0;
        if (shift && v === ":oct" && num(items[i + 1]) != null) { outs[i + 1] = String(num(items[i + 1]) + shift); i++; continue; }
        if (typeof v === "string" && /^:[a-z]/.test(v) && i + 1 < items.length) {
          const r = this.wordRule(v, items[i + 1], ctx);
          if (r.drop) outs[i] = outs[i + 1] = null;
          else if (r.replace != null) { outs[i] = r.replace; outs[i + 1] = null; }
          i++;
          continue;
        }
        if (ctx.head && ctx.srcPart?.kind === "wave" && ctx.destPart?.kind !== "wave" && this.s.waveMacros.has(v)) {
          const role = v.slice(5);
          if (ROLES.includes(role)) {
            const r = this.waveRule(role, ctx);
            if (r !== undefined) outs[i] = r;
          } else {
            this.say(`${v} on ${this.nameOf(ctx.head)}: presets/wavetable's macro of waves, which ${ctx.dest} has not; taken out`);
            outs[i] = null;
          }
          continue;
        }
        if (ctx.head && ctx.srcPart?.kind === "wave" && this.s.waves.has(v)) {
          const r = this.waveRule(v, ctx);
          if (r !== undefined) outs[i] = r;
          continue;
        }
        if ((ctx.head || ctx.snippet) && this.s.voices.has(v)) {
          if (!sawNote && ctx.opN) ctx.hasVoiceFirst = true;
          const r = this.voiceRule(v, ctx);
          if (r !== undefined) outs[i] = r;
          continue;
        }
        if (ctx.drumNoise) {
          if (this.s.samples.has(v) || this.s.kit?.has?.(v)) {
            const role = noiseDrumOf(knownRank(v, this.s.heard));
            // Within one body the role's words once; a loop's body (another
            // list) writes them again, so every pass starts right.
            const same = role === ctx.drumNoise.role && ctx.drumNoise.lastIn === items;
            ctx.drumNoise.role = role;
            ctx.drumNoise.lastIn = items;
            if (same) { outs[i] = null; continue; }
            if (role) {
              const d = NOISE_DRUMS[role];
              this.envDefs.set(d.env, `(def ${d.env} (macro :vel+ ${d.steps}))`);
              if (!this.saidDrums?.has(role)) { (this.saidDrums ??= new Set()).add(role); this.say(`the ${role} on ${ctx.dest} (the ${this.to.system} has no sample channel): a noise note under ${d.env}`); }
            }
            outs[i] = role ? `${NOISE_DRUMS[role].env} :oct ${NOISE_DRUMS[role].oct} :gate ${NOISE_DRUMS[role].gate}` : null;
            continue;
          }
          if (v === ">" || v === "<" || /^o[+-]\d*$/.test(v)) { outs[i] = null; continue; }
          if (isNote(v)) {
            sawNote = true;
            outs[i] = ctx.drumNoise.role ? `${NOISE_DRUMS[ctx.drumNoise.role].note}${NOTE.exec(v)[2]}` : restOf(v);
            continue;
          }
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
        // A sample on the ROM kit by its sound: its role's name.
        if (ctx.destPart?.kit && this.s.byEar?.has(v)) {
          if (!this.saidByEar?.has(v)) { (this.saidByEar ??= new Set()).add(v); this.say(`'${v}' plays the ${ctx.destPart.label}'s ${this.s.byEar.get(v)} (as it sounds)`); }
          outs[i] = this.s.byEar.get(v);
        }
      } else if (ctx.head && this.octShift.get(ctx.head) && isList(it, "glide") && /^[a-g][+-]?\d+$/.test(String(it.items[1]?.value))) {
        // A glide's start note, written at its octave: raised with the rest.
        const m = /^([a-g][+-]?)(\d+)$/.exec(it.items[1].value);
        const outs2 = [];
        outs2[1] = `${m[1]}${Number(m[2]) + this.octShift.get(ctx.head)}`;
        outs[i] = this.renderList(it, outs2);
      } else if ((ctx.noBend || ctx.flatPitch) && isList(it, "glide")) {
        this.say(`(glide …) on ${this.nameOf(ctx.head)}: ${ctx.dest} plays a sound at its own pitch; taken out`);
        outs[i] = null;
      } else if (isList(it) && DESCEND.has(it.items[0]?.value)) {
        // A loop's next pass starts from where its last ended. A body that
        // ends with the noise's state written as it began needs nothing more;
        // one that does not is read again with its state written at its start.
        const isMacro = it.items[0].value === "macro";
        const oct = ctx.noise?.oct;
        const mode = ctx.state?.mode;
        const saved = ctx.noise && { ...ctx.noise };
        if (ctx.noise) ctx.noise.bodyFirst = undefined; // the state the body's first noise note plays in
        let inner = this.body(it.items, 1, isMacro ? { ...ctx, macro: true } : ctx);
        const bodyFirst = ctx.noise?.bodyFirst;
        if (ctx.noise) ctx.noise.bodyFirst = saved.bodyFirst;
        // A loop (x N …) whose body moves the octave or the split's mode is
        // written out a pass after another, each from where the last ended —
        // unless it holds a label or a (break), which a copy cannot: then its
        // later passes are read as its first, said. (A macro's #sus / #rel
        // are its steps' marks, not labels: a macro or a vector is not looked into.)
        const times = isList(it, "x") ? num(it.items[1]) : null;
        const moves = times > 1 && ((ctx.noise && ctx.noise.oct !== oct) || (ctx.split && ctx.state.mode !== mode));
        const fixed = (n) => (n?.kind === "atom" && /^#./.test(n.value)) || isList(n, "break")
          || (isList(n) && DESCEND.has(n.items[0]?.value) && n.items[0].value !== "macro" && n.items.some(fixed));
        if (moves && !it.items.slice(2).some(fixed)) {
          const bodyText = (r) => {
            const outs2 = [...r.outs];
            outs2[0] = outs2[1] = null;
            return this.renderList(it, outs2, r.after).slice(1, -1).trim();
          };
          const passes = [bodyText(inner)];
          for (let k = 1; k < times; k++) passes.push(bodyText(this.body(it.items, 2, ctx)));
          if (ctx.split !== "noise") this.say(`a loop on ${this.nameOf(ctx.head)} whose passes ${ctx.split ? "change the :mode" : "move the noise's octave"} is written out pass by pass`);
          outs[i] = passes.join(" ");
          continue;
        }
        // Kept a loop: a body that does not end in the state its first noise
        // note plays in is read again, its state written at its start, and
        // written again after it.
        if (ctx.noise && isList(it, "x") && bodyFirst !== undefined && ctx.noise.last !== bodyFirst) {
          const end = { ...ctx.noise };
          Object.assign(ctx.noise, saved, { last: null });
          if (ctx.state) ctx.state.mode = mode;
          inner = this.body(it.items, 1, ctx);
          Object.assign(ctx.noise, { oct: end.oct, hz: end.hz, periodic: end.periodic, last: null });
        }
        if (moves && ctx.noise && ctx.noise.oct !== oct) ctx.noise.oct += (times - 1) * (ctx.noise.oct - oct);
        if (moves && ctx.split !== "noise")
          this.say(`a loop on ${this.nameOf(ctx.head)} ${ctx.split ? "ends in another :mode than it starts" : "moves the noise's octave"} and holds a label or a (break): its later passes are read as its first`);
        // A macro with none of its steps left is no macro.
        if (isMacro && it.items.length > 1 && it.items.slice(1).every((_, j) => inner.outs[j + 1] === null)) outs[i] = null;
        else outs[i] = this.renderList(it, inner.outs, inner.after);
      }
    }
    // A tie into or out of a note the split made a rest ties nothing.
    if (ctx.split) {
      // The nearest item on each side that is still there (a :mode between
      // is taken out).
      const near = (i, d) => { for (let j = i + d; j >= start && j < items.length; j += d) if (outs[j] !== null) return outs[j]; return undefined; };
      for (let i = start; i < items.length; i++)
        if (items[i].value === "~" && [near(i, -1), near(i, 1)].some((o) => typeof o === "string" && o.startsWith("_"))) outs[i] = null;
    }
    return { outs, after };
  }

  // The noise's state as its source writes it: the octave, the rate (Hz),
  // white or periodic.
  noiseWord(kw, val, ctx) {
    const n = ctx.noise;
    const v = val.kind === "atom" ? String(val.value) : null;
    if (kw === ":oct+") { if (num(val) != null) n.oct += num(val); return; }
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
      // The 2A03's and the Game Boy's are white or periodic; the PC Engine's white only.
      const modes = n.dst.modes ?? {};
      const mode = n.periodic && modes.periodic ? ":mode periodic " : modes.white ? ":mode white " : "";
      if (n.periodic && !modes.periodic && !n.saidPeriodic) { n.saidPeriodic = true; this.say(`a periodic noise on ${this.nameOf(ctx.head)}: ${ctx.dest} makes white noise only`); }
      state = `${mode}:oct ${oct}`;
    } else if (n.to === "mode") {
      state = `:mode ${n.periodic ? "periodic" : "white"}${nearestWhite(n.hz)}`;
    } else {
      if (n.periodic && !n.saidPeriodic) { n.saidPeriodic = true; this.say(`a periodic noise on ${this.nameOf(ctx.head)}: ${ctx.dest} makes white noise only`); }
      state = `:noise-rate ${Math.max(1, Math.min(31, Math.round(NOISE_CLOCK / n.hz)))}`;
    }
    if (!n.said) { n.said = true; this.say(`${this.nameOf(ctx.head)} on ${ctx.dest}: the noise's rate read note by note as the nearest ${n.to === "pitch" ? "pitch" : n.to === "mode" ? ":mode whiteN / periodicN" : ":noise-rate"} (Hz)`); }
    if (n.bodyFirst === undefined) n.bodyFirst = state;
    if (state === n.last) return note;
    n.last = state;
    return `${state} ${note}`;
  }

  // An FDS or PC Engine LFO word: onto the other its reading (fdsAsPce /
  // pceAsFds, at the conversion's start: this.lfo); elsewhere dropped, said.
  lfoRule(w, kw, val, ctx) {
    const r = this.lfo?.rule(w, val, ctx);
    if (r) return r;
    if (!this.saidLfo?.has(kw)) {
      (this.saidLfo ??= new Set()).add(kw);
      this.say(`${kw}: the ${this.from.system}'s ${this.from.name === "fc" ? "FDS modulation" : "LFO"} has no reading on the ${this.to.system}; taken out`);
    }
    return { drop: true };
  }

  // ── the wave memories (wave-port.js) ──

  // The score's waves as the chip plays them: name → steps, off its compile.
  // The source score compiled, once: its waves as the chip plays them, its
  // tracks' notes. Null where it does not compile.
  compiled() {
    return this.s.compiled();
  }

  waveSteps(name) {
    if (!this.waveTable) this.waveTable = new Map((this.compiled()?.metadata?.waves ?? []).filter((w) => w.name).map((w) => [w.name, w.data]));
    return this.waveTable.get(name) ?? null;
  }

  // A track's middle note (MIDI), as it plays: 72 where it has none.
  middleNote(head) {
    const keys = (this.compiled()?.tracks ?? []).filter((t) => (t.scoreChannel ?? t.channel) === head)
      .flatMap((t) => t.events.filter((e) => e.cmd === "NOTE_ON").map((e) => pitchToMidi(e.args.pitch))).sort((a, b) => a - b);
    return keys.length ? keys[Math.floor(keys.length / 2)] : 72;
  }

  // The FDS's modulation ↔ the PC Engine's LFO (wave-port.js): read once,
  // from the words the score writes first, then each word by `rule`.
  setupLfo() {
    const words = [];
    const walkAll = (n) => {
      if (n?.kind !== "list") return;
      n.items.forEach((m, i) => { if (m.kind === "atom" && /^:(lfo-|fms$)/.test(m.value) && n.items[i + 1]) words.push([m.value, n.items[i + 1]]); });
      n.items.forEach(walkAll);
    };
    this.s.roots.forEach(walkAll);
    const first = (kw) => words.find(([k, v]) => k === kw && num(v) != null)?.[1];
    // A table, written or a def's.
    const tableOf = (v) => {
      const node = v?.kind === "atom" ? this.s.roots.find((n) => isList(n, "def") && n.items[1]?.value === v.value)?.items[2] : v;
      return node?.kind === "list" && node.bracket === "[]" ? node.items.map((x) => (x.value === "reset" ? "reset" : Number(x.value))) : null;
    };
    if (this.from.name === "fc" && this.to.name === "pce" && this.map["fds-wave"] === "wave1" && this.s.fdsMod) {
      const tableWord = words.find(([k]) => k === ":lfo-wave")?.[1];
      const table = tableOf(tableWord) ?? Array(32).fill(0);
      // The table is wave2's wave now: its def goes, whichever track named it.
      if (tableWord?.kind === "atom") this.replacedSnippets.add(tableWord.value);
      const n = num(first(":lfo-freq")) ?? 0;
      const midi = this.middleNote("fds-wave");
      const peak = Math.max(1, ...fdsCounter(table).map(Math.abs));
      const p = fdsAsPce({ table, n, pmd: num(first(":lfo-pmd")) ?? 0, midi });
      // wave2 holds the LFO's wave, its rate's :lfo-freq with it (the score's
      // own, read below, follow it); wave1 starts at the first depth.
      this.lfoTrack = `(def-wave fds-lfo :wave [${p.wave.join(" ")}])\n(wave2 fds-lfo :lfo-freq ${p.lfoFreq} :vol 0 :oct ${Math.floor(p.note / 12) - 1} ${PITCH_NAMES[p.note % 12]}0) ; the FDS's modulation: wave2 is the LFO wave1 takes`;
      // A depth a track writes before its first note is the song's from its
      // start: wave1 starts at it (one written later is that track's own).
      const opening = this.s.forms.flatMap((f) => leadWords(f).filter(([kw, v]) => kw === ":lfo-pmd" && num(v) != null).map(([, v]) => num(v)));
      if (opening.length && opening[0] > 0) this.leadOn = { wave1: `:fms ${pceFmsOf((opening[0] * peak) / 1024, midi)}` };
      this.say(`the FDS's modulation is the ${this.to.system}'s LFO: wave2 plays its table's sway at ${p.note} (:vol 0, held), wave1 takes it (:fms), :lfo-freq read with wave2's pitch`);
      let saidTable = false;
      this.lfo = { rule: (w, val, ctx) => {
        if (num(val) == null && w !== "LFO_WAVE") { this.say(`${w === "LFO_FREQ" ? ":lfo-freq" : ":lfo-pmd"} (a sweep): the ${this.to.system}'s LFO takes a value; taken out`); return { drop: true }; }
        if (w === "LFO_FREQ") return { replace: `:lfo-freq ${fdsFreqAsPce(num(val), p.note)}` };
        if (w === "LFO_PMD") {
          if (ctx.dest !== "wave1") { this.say(`:lfo-pmd on ${this.nameOf(ctx.head)}: the ${this.to.system}'s depth is wave1's :fms (the first one written is at wave1's start); taken out`); return { drop: true }; }
          return { replace: `:fms ${pceFmsOf((num(val) * peak) / 1024, midi)}` };
        }
        if (w === "LFO_WAVE" && !saidTable) { saidTable = true; if (val.kind === "atom") this.replacedSnippets.add(val.value); return { drop: true }; }
        if (w === "LFO_WAVE") { this.say(":lfo-wave written again: wave2 plays the first table only; taken out"); return { drop: true }; }
        return null;
      } };
    }
    if (this.from.name === "pce" && this.to.name === "fc" && this.map.wave1 === "fds-wave") {
      const wave2 = this.s.heads.get("wave2");
      const name = wave2?.forms.flatMap((f) => f.items).find((x) => x.kind === "atom" && this.s.waves.has(x.value))?.value;
      const steps = (name && this.waveSteps(name)) ?? wave32(Array(64).fill(0).map((_, i) => Math.round(127 * Math.sin((2 * Math.PI * i) / 64))));
      const note = this.middleNote("wave2");
      const lfoFreq = num(first(":lfo-freq")) ?? 0;
      const midi = this.middleNote("wave1");
      const firstFms = num(words.find(([k, v]) => k === ":fms" && num(v) > 0)?.[1]) ?? 1;
      const p = pceAsFds({ wave: wave32(steps), note, lfoFreq, fms: firstFms, midi });
      // The rate in the lead unless wave1 writes one before its first note.
      const ownRate = this.s.heads.get("wave1")?.forms.some((f) => leadWords(f).some(([kw]) => kw === ":lfo-freq"));
      this.lfoLead = `:lfo-wave [${p.table.join(" ")}]${ownRate ? "" : ` :lfo-freq ${p.n}`}`;
      this.say(`the ${this.from.system}'s LFO (wave2 swaying wave1) is the FDS's modulation: its table from wave2's wave '${name ?? "sine"}', its rate from wave2's pitch${this.map.wave2 === "drop" ? "" : "; wave2 still plays as written"}`);
      const pmdOf = (k) => pceAsFds({ wave: wave32(steps), note, lfoFreq, fms: k, midi }).pmd;
      this.lfo = { rule: (w, val, ctx) => {
        if (w === "LFO_FREQ" && num(val) != null) return { replace: `:lfo-freq ${pceFreqAsFds(num(val), note)}` };
        if (w === "FM_FMS" && ctx.head === "wave1" && num(val) != null) return { replace: `:lfo-pmd ${pmdOf(num(val))}` };
        return null;
      } };
    }
  }

  // A wave named on a wave track, on the destination's channel: a wave
  // there; on FM a role's voice, else its shape's; on a square its duty.
  waveRule(v, ctx) {
    const dst = ctx.destPart;
    if (!dst || dst.kind === "wave") return undefined;
    this.replacedWaves.add(v);
    const steps = this.waveSteps(v);
    return this.waveOnto(ROLES.includes(v) ? null : steps ? shapeOf(steps) : "square", `wave '${v}'`, v, ctx);
  }

  // A wave of `shape` (null: the role `role`'s) onto a channel without wave
  // memory: on FM the role's voice or the shape's, on a pulse its width.
  waveOnto(shape, what, role, ctx) {
    const dst = ctx.destPart;
    const v = role;
    if (dst.kind === "fm") {
      let name;
      if (!shape) name = twoOp(dst) ? romForRole(dst, v) : (this.needsRoles = true, v);
      else if (twoOp(dst)) name = ROM_OF_WAVE[`wave-${shape}`] ?? "clarinet"; // a pulse the square's
      else { name = `wave-${["pulse25", "pulse12"].includes(shape) ? "square" : shape}`; this.standIns.add(name); }
      this.say(`${what} on ${this.nameOf(ctx.head)} plays ${shape ? `as a ${shape}` : "its role"}: ${name} on ${ctx.dest}`);
      return name;
    }
    if (dst.kind === "tone" && dst.words("DUTY")) {
      const duty = { pulse25: 4, pulse12: 2 }[shape] ?? 8;
      this.say(`${what} on ${this.nameOf(ctx.head)}: ${ctx.dest}'s ${duty === 8 ? "square" : `pulse (:duty ${duty})`}`);
      return `:duty ${duty}`;
    }
    this.say(`${what} on ${this.nameOf(ctx.head)}: ${ctx.dest} plays its own ${TONE_SHAPE[dst.name] ?? "square"}`);
    return null;
  }

  // A voice's sounding octave (its main carrier's multiple) on a channel
  // that plays the written note: the track moves up that far — `:oct+` at
  // the switch, its `:oct` writes and glides after it raised (body).
  octaveFor(v, ctx) {
    const def = this.voices.get(v);
    const words = twoOp(ctx.srcPart) ? opllWordsAs4op(def?.words ?? new Map()) : def?.words ?? new Map();
    const k = roleOf(v) ? 0 : carrierOctave(words);
    const was = this.octShift.get(ctx.head) ?? 0;
    this.octShift.set(ctx.head, k);
    if (k !== 0 && !this.saidOct?.has(v)) {
      (this.saidOct ??= new Set()).add(v);
      this.say(`'${v}' sounds ${Math.abs(k)} octave${Math.abs(k) === 1 ? "" : "s"} ${k > 0 ? "up" : "down"} on FM (its carrier's :ml ${carrierMultiple(words)}); on ${ctx.dest} its notes are written so`);
    }
    return k === was ? "" : ` :oct+ ${k - was}`;
  }

  // An FM voice onto a wave channel: a role's wave and its macro (the
  // wavetable's `wave-piano`); any other its waveform's wave, under an
  // envelope read off its main carrier.
  voiceOnWave(v, ctx) {
    this.replaced.add(v);
    this.needsWaves = true;
    const role = roleOf(v);
    // A role's macro steps the channel's waves on every note: a voice after
    // it clears them.
    const clear = this.waveMacroOn.has(ctx.head) ? "(macro :wave none) " : "";
    if (role) {
      this.waveMacroOn.add(ctx.head);
      this.say(`'${v}' on ${this.nameOf(ctx.head)} plays presets/wavetable's ${role} (wave-${role}: its wave and level over a note)`);
      return `wave-${role}${this.octaveFor(v, ctx)}`;
    }
    const def = this.voices.get(v);
    const words = twoOp(ctx.srcPart) ? opllWordsAs4op(def?.words ?? new Map()) : def?.words ?? new Map();
    const wave = waveformOf(words).slice(5);
    const env = `${v}-env`;
    // Its rates as the key scaling makes them at the track's middle note.
    if (!this.envDefs.has(env)) this.envDefs.set(env, `(def ${env} (macro :vel+ ${envelopeOf(words, this.middleNote(ctx.head))}))`);
    this.say(`'${v}' on ${this.nameOf(ctx.head)} plays presets/wavetable's ${wave} under ${env}, its carrier's envelope`);
    this.waveMacroOn.delete(ctx.head);
    return `${clear}${wave} ${env}${this.octaveFor(v, ctx)}`;
  }

  voiceRule(v, ctx) {
    if (!ctx.destPart) return undefined;
    if (ctx.destPart.kind === "wave" && ctx.srcPart?.kind === "fm") return this.voiceOnWave(v, ctx);
    if (ctx.destPart.kind !== "fm") {
      this.replaced.add(v);
      const oct = ctx.destPart.kind === "tone" ? this.octaveFor(v, ctx).trim() : "";
      return oct || null;
    }
    if (ctx.opN && !twoOp(ctx.destPart)) return this.opVoice(v, ctx.opN);
    const def = this.voices.get(v);
    // 4-op onto the OPLL: a role's ROM voice, else its waveform's.
    if (ctx.family && !twoOp(ctx.srcPart)) {
      // A role's voice is the ROM's; the one user voice (pickUserVoice)
      // stays itself, read as two operators (defFm); the rest the ROM's.
      if (v === this.userVoice) return undefined;
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
    // The song's words (its tempo, its fader, the LFO) go with a split's tone
    // half, or with its noise half where that is all there is.
    if (ctx.split === "noise" && this.map[splitHead(ctx.head)] !== "drop" && /^:(tempo|master|lfo-)/.test(base)) return DROP;
    if (ctx.split && base === ":mode") {
      if (val.kind === "atom") ctx.state.mode = NOISY.has(val.value) ? "noise" : "tone";
      else if (ctx.split === "tone") this.say(`:mode [${val.items?.map((x) => x.value).join(" ") ?? "…"}] on ${this.nameOf(ctx.head)}: a mode stepped by a macro is not split; taken out`);
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
    if (ctx.drumNoise && [":oct", ":oct+", ":pitch", ":semi", ":mode", ":gate", ":gate-", ":gate*"].includes(base)) return DROP;
    if ((base === ":pitch" || base === ":semi") && (ctx.noBend || ctx.flatPitch)) {
      this.say(`${kw} on ${this.nameOf(ctx.head)}: the ${ctx.destPart.label} cannot bend a sample; taken out`);
      return DROP;
    }
    const w = canonicalTarget(base);
    if (!w) return KEEP;
    if (w === "FM_FMS" && this.lfo && ctx.srcPart?.kind === "wave") {
      const r = this.lfo.rule(w, val, ctx);
      if (r) return r;
    }
    // The PC Engine's :fms is its own LFO's (wave2 swaying wave1), not FM's.
    if ((w === "FM_FMS" || w === "FM_AMS") && ctx.destPart?.kind === "wave" && ctx.srcPart?.kind === "fm") {
      this.say(`${base} on ${this.nameOf(ctx.head)}: FM's LFO sensitivity, not the ${this.to.system}'s LFO; taken out`);
      return { drop: true };
    }
    // A track's `:wave (expr)` off a wave channel: the wave it folds to (the
    // compile names it by its place, `wave1@3:14`), read as a named one is.
    // One that follows a $slot has no steps to read.
    // The waves a :wave off a wave channel names go if nothing else plays them.
    if (w === "WAVE" && ctx.destPart && ctx.destPart.kind !== "wave") {
      const walkNames = (n) => { if (n?.kind === "atom" && this.s.waves.has(n.value)) this.replacedWaves.add(n.value); if (n?.kind === "list") n.items.forEach(walkNames); };
      walkNames(val);
    }
    if (w === "WAVE" && ctx.srcPart?.kind === "wave" && ctx.destPart && ctx.destPart.kind !== "wave" && !ctx.macro) {
      if (val.kind === "atom" && this.s.waves.has(val.value)) {
        const r = this.waveRule(val.value, ctx);
        return r ? { replace: r } : { drop: true };
      }
      const steps = this.waveSteps(`${splitHead(ctx.head)}@${val.line}:${val.column}`);
      if (!steps) {
        this.say(`:wave on ${this.nameOf(ctx.head)}: a wave with no steps to read (it follows a $slot, or does not fold); taken out`);
        return { drop: true };
      }
      const r = this.waveOnto(shapeOf(steps), ":wave (a wave of its own)", null, ctx);
      return r ? { replace: r } : { drop: true };
    }
    // A pulse's width onto a wave channel: the wavetable's pulse of it.
    if (w === "DUTY" && ctx.destPart?.kind === "wave" && num(val) != null && !ctx.macro) {
      this.needsWaves = true;
      const d = Math.min(num(val), 16 - num(val)); // 75 % sounds as 25 %
      return { replace: d <= 3 ? "pulse12" : d <= 6 ? "pulse25" : "square" };
    }
    const owners = partsWithWord(w);
    if (!owners.length) return KEEP; // the language's own (:master, :vol …)
    // The FDS's and the PC Engine's LFO words are their chips' own: onto
    // each other they are read (lfoRule), elsewhere they are not the LFO there.
    if (/^LFO_/.test(w) && ["fc", "pce"].includes(this.from.name)) return this.lfoRule(w, base, val, ctx);
    // Across the FM families a voice's words are the other chip's: its
    // register ranges, its operators. The voice is the role's or the
    // waveform's now; written over, it would not be.
    // The OPLL's vibrato and tremolo written on a track: the 4-op channel's
    // sensitivities to the song's LFO (voice-port.js).
    if (ctx.family && twoOp(ctx.srcPart) && /^FM_(VIB|AMEN)\d$/.test(w)) {
      const vib = w.startsWith("FM_VIB");
      const as = (x) => (Number(x) > 0 ? (vib ? OPLL_VIB_FMS : OPLL_AM_AMS) : 0);
      const kw2 = vib ? ":fms" : ":ams";
      let value = null;
      if (val.kind === "atom" && num(val) != null) value = String(as(val.value));
      else if (val.kind === "list" && val.bracket === "[]" && val.items.every((x) => num(x) != null)) value = `[${val.items.map((x) => as(x.value)).join(" ")}]`;
      if (value != null) {
        this.needsLfo = true;
        this.say(`${base} on ${this.nameOf(ctx.head)}: the ${ctx.srcPart.label}'s ${vib ? "vibrato" : "tremolo"} read as ${kw2} on the song's LFO`);
        // The tremolo needs the operator's AM bit too, which a 4-op voice has.
        return { replace: vib || ctx.macro ? `${kw2} ${value}` : `${kw2} ${value} :am${w.at(-1)} ${val.value}` };
      }
    }
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
    // FM's LFO (the OPN's, the OPM's) onto the PC Engine's or the FDS's,
    // which have words of those names for an LFO of their own: not that LFO.
    if (/^LFO_/.test(w) && ["pce", "fc"].includes(this.to.name)) {
      if (!this.saidLfo?.has(kw)) { (this.saidLfo ??= new Set()).add(kw); this.say(`${kw}: the ${this.from.system}'s FM LFO is not the ${this.to.system}'s; taken out`); }
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
      const what = w === "LFO_WAVE" ? "wave" : w === "LFO_FREQ" ? "rate" : "depth";
      this.say(this.from.name === "x68k" && this.toHas("LFO_RATE")
        ? `${kw}${n == null ? " (a sweep)" : ""}: the OPM's LFO ${what}; the OPN's LFO is a triangle at :lfo-rate's eight rates, its depth each voice's :fms / :ams — taken out`
        : `${kw}: the ${this.to.system} has no LFO; taken out`);
      return DROP;
    }
    if (w === "NOISE_RATE") {
      if (ctx.destPart?.kind === "noise" && noiseModel(ctx.destPart) === "mode" && n != null) {
        const white = nearestWhite(NOISE_CLOCK / n);
        this.say(`:noise-rate ${n} (${Math.round(NOISE_CLOCK / n)} Hz) reads as :mode white${white} (${WHITE_HZ[white]} Hz)`);
        return { replace: `:mode white${white}` };
      }
      const noise = [...this.toParts].find((p) => p.kind === "noise");
      const how = noiseModel(noise) === "pitch" ? "its rate is each noise note's pitch" : noiseModel(noise) === "mode" ? "its rate is the noise track's :mode" : "it has no rate sweep";
      this.say(`:noise-rate ${n ?? "(a sweep)"} on ${ctx.head ? this.nameOf(ctx.head) : "a def"}: the ${this.to.system}'s noise — ${how}; taken out`);
      return DROP;
    }
    this.say(`${kw}: the ${this.to.system} has none; taken out`);
    return DROP;
  }

  modeRule(val, ctx) {
    const KEEP = {};
    const DROP = { drop: true };
    // A snippet's :mode is read where the snippet plays; one no tone or
    // noise part of the machine has (the SSG's mixer on the Mega Drive) goes.
    if (!ctx.head) {
      const syms = val.kind === "atom" ? [val.value] : val.kind === "list" && val.bracket === "[]" ? val.items.map((x) => x.value) : null;
      if (!syms || syms.some((m) => /^(shot|loop|gate)$/.test(m))) return KEEP; // a sample's
      const parts = [...this.toParts].filter((p) => ["tone", "noise"].includes(p.kind));
      const own = [...parts.flatMap((p) => Object.keys(p.modes ?? {})), ...Object.values(this.to.channels).flatMap((c) => Object.keys(c.modes ?? {}))];
      if (syms.every((m) => own.includes(m))) return KEEP;
      this.say(`:mode ${syms.join(" ")} in a def: no channel of the ${this.to.system} has it; taken out`);
      return DROP;
    }
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

  // FM3's operator tracks share one patch: a voice written at the head of
  // one's n-th form (mucom88 writes it on fm3-1 alone) is the patch's from
  // there, so the others' n-th forms start under it too — a machine of
  // channels of their own needs it on each. Form index → voice; a voice
  // written mid-form is that track's alone (said).
  readOpVoices() {
    const ops = [...this.s.heads.keys()].filter((h) => /^fm3-\d$/.test(h) && !this.to.channelNames.includes(h));
    if (!ops.length) return null;
    const byForm = new Map();
    let mid = false;
    for (const h of ops)
      this.s.heads.get(h).forms.forEach((f, j) => {
        let before = true;
        for (const it of f.items.slice(f.items[1]?.value === ":prio" ? 3 : 1)) {
          if (it.kind === "atom" && (isNote(it.value) || /^_/.test(it.value))) before = false;
          if (it.kind !== "atom" || !this.s.voices.has(it.value)) continue;
          if (before) { if (!byForm.has(j)) byForm.set(j, it.value); } else mid = true;
        }
      });
    if (mid) this.say("a voice written mid-form on an FM3 operator track is the shared patch's on fm3; here it plays on that track alone");
    return byForm;
  }

  // The form's index among its head's.
  formIndex(n, head) { return this.s.heads.get(head)?.forms.indexOf(n) ?? -1; }

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
