// A score's FM voice on another family of FM (score-port.js): the 4-operator
// OPN / OPM and the 2-operator OPLL (the MSX's FM-PAC, the Famicom's VRC7).
// Within one family a voice goes as written. Across them (the user's policy,
// 2026-11-08):
//   a role — a voice named for an instrument (the fifteen of presets/fm-roles,
//   which are the OPLL's ROM names; a gm-* voice; the VRC7's ROM names) —
//   plays the machine's voice for that role: the ROM voice on the OPLL and
//   the VRC7, presets/fm-roles' on a 4-op chip;
//   any other voice plays the nearest of presets/waveforms' four (sine,
//   triangle, saw, square), weighed by how it sounds (import-fm-voices.js
//   nearestVoiceOfWords) — on the OPLL as the ROM voice of that shape, so a
//   conversion never writes the chip's one user voice;
//   an OPLL user voice onto a 4-op chip goes as it is, read as 4-op
//   (chips/ym2413.js opllWordsAs4op).
// ---------------------------------------------------------------------------

import { parse } from "../lang/mmlisp-parser.js";
import { programOf } from "../midi/gm-names.js";
import { fmInitVoice } from "../machine/chips/fm-words.js";
import { opllRomVoices, opllWordsAs4op, OPLL_ROM_NAMES } from "../machine/chips/ym2413.js";
import { nearestVoiceOfWords } from "../import/import-fm-voices.js";
import { canonicalTarget } from "../lang/mmlisp2ir.js";

export const FM_ROLES_SET = "presets/fm-roles/set.mmlisp";
export const WAVEFORMS_SET = "presets/waveforms/set.mmlisp";

/** The fifteen melodic roles: presets/fm-roles' voices, the OPLL's ROM names. */
export const ROLES = OPLL_ROM_NAMES;

// presets/waveforms' four as their words (tools check:score-port holds them
// to the set): every operator AR 31, RR 15, held, no detune.
const op = (tl, ml = 1) => ({ tl, ml });
const WAVEFORMS = {
  "wave-sine": { alg: 7, fb: 0, ops: [op(127), op(127), op(127), op(16)] },
  "wave-triangle": { alg: 7, fb: 0, ops: [op(16), op(41, 3), op(53, 5), op(61, 7)] },
  "wave-saw": { alg: 0, fb: 7, ops: [op(28), op(32), op(40), op(16)] },
  "wave-square": { alg: 0, fb: 7, ops: [op(28, 2), op(32, 2), op(36, 2), op(16)] },
};
const waveWords = ({ alg, fb, ops }) => new Map([
  ["FM_ALG", alg], ["FM_FB", fb],
  ...ops.flatMap((o, i) => Object.entries({ AR: 31, DR: 0, SR: 0, RR: 15, SL: 0, TL: o.tl, ML: o.ml }).map(([k, v]) => [`FM_${k}${i + 1}`, v])),
]);
export const WAVEFORM_WORDS = new Map(Object.entries(WAVEFORMS).map(([name, v]) => [name, waveWords(v)]));
// The ROM voice of each waveform's shape (import-song.js ROM_STAND_IN).
export const ROM_OF_WAVE = { "wave-square": "clarinet", "wave-saw": "synth", "wave-triangle": "flute", "wave-sine": "flute" };

// A GM program's role, by its family (gm-names.js): the instruments the
// fifteen stand for. Pads, effects, the ethnic and the percussive have none.
function roleOfProgram(p) {
  if (p == null) return null;
  if (p < 8) return p === 6 ? "harpsichord" : "piano";
  if (p < 16) return "vibraphone";
  if (p < 24) return "organ";
  if (p < 32) return p < 26 ? "guitar" : "electric-guitar";
  if (p < 40) return p < 36 ? "acoustic-bass" : "synth-bass";
  if (p < 56) return p === 47 ? null : "violin"; // the strings, the ensembles; not the timpani
  if (p < 64) return [57, 58, 60].includes(p) ? "horn" : "trumpet";
  if (p < 72) return p === 68 || p === 69 ? "oboe" : "clarinet"; // the saxes as the clarinet
  if (p < 80) return "flute";
  if (p < 88) return "synth";
  return null;
}

/** The role a voice named `name` stands for, or null: a role as it is, a gm-* or a VRC7 ROM name by its program. */
export function roleOf(name) {
  if (ROLES.includes(name)) return name;
  return roleOfProgram(programOf(name));
}

// The VRC7's ROM voice for a role it has no voice of that name for.
const VRC7_FOR_ROLE = {
  piano: "wurly", harpsichord: "buzzy-bell", "electric-guitar": "guitar", "acoustic-bass": "fretless",
  violin: "tutti", horn: "trumpet", oboe: "clarinet",
};

/** The ROM voice of `part` (an OPLL part: rom names) that plays `role`. */
export function romForRole(part, role) {
  if (part.romNames.includes(role)) return role;
  return VRC7_FOR_ROLE[role] ?? "synth";
}

// ── A score's voices ─────────────────────────────────────────────────────

/**
 * Every def-fm `texts` define, resolved: name → { words: Map, base, own: Map,
 * node, imported }. A base the defs do not hold is `init-fm` (the part's) or
 * one of `part`'s ROM voices; a value that is not a number is left out.
 */
export function voiceTable(text, imports, part) {
  const defs = new Map();
  const read = (src, imported) => {
    let roots;
    try { roots = parse(src); } catch { return; }
    for (const n of roots) {
      if (n?.kind !== "list" || n.items[0]?.value !== "def-fm" || n.items[1]?.kind !== "atom") continue;
      const items = n.items.slice(2);
      const base = items[0]?.kind === "atom" && !String(items[0].value).startsWith(":") ? items.shift().value : null;
      const own = new Map();
      for (let i = 0; i + 1 < items.length; i += 2) {
        const w = canonicalTarget(String(items[i].value));
        const v = Number(items[i + 1]?.value);
        if (w && Number.isFinite(v)) own.set(w, v);
      }
      defs.set(n.items[1].value, { base, own, node: n, imported });
    }
  };
  for (const t of imports?.values() ?? []) read(t, true);
  read(text, false);
  const rom = part ? opllRomVoices(part) : new Map();
  const resolved = new Map();
  const resolve = (name, seen = new Set()) => {
    if (resolved.has(name)) return resolved.get(name).words;
    const d = defs.get(name);
    if (!d || seen.has(name)) return name === "init-fm" || !rom.has(name) ? fmInitVoice(part) : new Map(rom.get(name));
    seen.add(name);
    const words = new Map([...(d.base ? resolve(d.base, seen) : fmInitVoice(part)), ...d.own]);
    resolved.set(name, { ...d, words });
    return words;
  };
  for (const name of defs.keys()) resolve(name);
  return resolved;
}

/** A voice's words over the 4-op init voice's: every word the weighing reads is there. */
const full4op = (words) => new Map([...fmInitVoice(null), ...words]);

/**
 * The octaves a 4-op voice sounds above its written note: its main carrier's
 * multiple, where that is a power of two (ML 2 one up, 4 two, 0 — a half —
 * one down); any other multiple (3, 5 …) is a partial, 0. A wave or a
 * square plays the written note: it is written that many octaves up.
 */
export function carrierOctave(words) {
  return mlOctave(carrierMultiple(words));
}
const mlOctave = (ml) => (ml === 0 ? -1 : Number.isInteger(Math.log2(ml)) ? Math.log2(ml) : 0);
/**
 * How a 4-op voice sounds against its written note: `pitch`, the semitones
 * above it — its main carrier's octave (operator `op`'s, for a track that
 * plays one operator) and its `:key` − 60 — and `key`, the `:key` that
 * moves the written note (60: none). A stand-in that plays the written note
 * (a wave, a square) is { 0, 60 }; a role's voice of presets/fm-roles,
 * FM_ROLE_SOUND's.
 */
export function soundOf(words, op = null) {
  const key = words.get("KEY") ?? 60;
  const ml = op ? full4op(words).get(`FM_ML${op}`) ?? 1 : carrierMultiple(words);
  return { pitch: 12 * mlOctave(ml) + key - 60, key, ml };
}
/**
 * presets/fm-roles' voices that sound off their written note or move it
 * (soundOf), the rest { 0, 60 } — the conversion's stand-ins for the OPLL's
 * ROM voices on 4-op, whose texts it does not hold (gen-fm-roles.mjs
 * --check holds it to the set).
 */
export const FM_ROLE_SOUND = {
  harpsichord: { pitch: 0, key: 72 }, guitar: { pitch: 0, key: 72 }, "acoustic-bass": { pitch: 12, key: 72 },
  "synth-bass": { pitch: 12, key: 48 }, violin: { pitch: 12, key: 60 }, trumpet: { pitch: 0, key: 48 },
  oboe: { pitch: 24, key: 60 }, synth: { pitch: 12, key: 60 },
};
/** A voice's `:key` as written in a def it is rewritten to. */
const keyOf = (words) => (words.has("KEY") ? ` :key ${words.get("KEY")}` : "");

/** A 4-op voice's main carrier's multiple (:ml, the loudest carrier's). */
export function carrierMultiple(words) {
  const w = full4op(words);
  const carriers = CARRIERS_OF[w.get("FM_ALG") ?? 7];
  const main = [...carriers].sort((a, b) => (w.get(`FM_TL${a}`) ?? 0) - (w.get(`FM_TL${b}`) ?? 0))[0];
  return w.get(`FM_ML${main}`) ?? 1;
}
// Each algorithm's carriers, op 1-4 (fm-model.js CARRIERS, 1-based).
const CARRIERS_OF = [[4], [4], [4], [4], [2, 4], [2, 3, 4], [2, 3, 4], [1, 2, 3, 4]];

// ── A 4-op voice as the OPLL's two operators ────────────────────────────
// Each algorithm's operators that modulate each carrier (op 1-4): the OPN's
// eight (chips/opn-fm.js). The chosen pair is the main carrier and the
// loudest of its modulators.
const MODULATORS_OF = [
  { 4: [3] }, { 4: [3] }, { 4: [1, 3] }, { 4: [2, 3] },
  { 2: [1], 4: [3] }, { 2: [1], 3: [1], 4: [1] }, { 2: [1], 3: [], 4: [] }, { 1: [], 2: [], 3: [], 4: [] },
];
// The OPLL's multiples (its ML code's), and the code nearest an OPN multiple.
const OPLL_MULTIPLES = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const opllMl = (ml) => OPLL_MULTIPLES.indexOf(OPLL_MULTIPLES.reduce((b, m) => (Math.abs(m - (ml || 0.5)) < Math.abs(b - (ml || 0.5)) ? m : b), 1));

/**
 * A 4-op voice's words as a 2-op def-fm for the OPLL (the FM-PAC, the
 * VRC7), named `name`: its main carrier under the loudest of the carrier's
 * modulators — the rates halved to the chip's 0-15, the modulator's level to
 * 0-63, the feedback where op1 is the modulator, a sustain rate as the
 * percussive envelope (EG 0), the detune and the other two operators gone.
 * { text, without: what it plays without }.
 */
export function opnAs2op(name, words) {
  const w = full4op(words);
  const alg = w.get("FM_ALG") ?? 7;
  const car = carrierMainOf(w);
  const mods = MODULATORS_OF[alg][car] ?? [];
  const mod = [...mods].sort((a, b) => (w.get(`FM_TL${a}`) ?? 0) - (w.get(`FM_TL${b}`) ?? 0))[0] ?? null;
  const g = (k, n) => w.get(`FM_${k}${n}`) ?? 0;
  const op = (n, isMod) => {
    const eg = g("SR", n) > 0 ? 0 : 1; // a level that falls while held: percussive
    return [`:ar${isMod ? 1 : 2} ${g("AR", n) >> 1}`, `:dr${isMod ? 1 : 2} ${g("DR", n) >> 1}`, `:sl${isMod ? 1 : 2} ${g("SL", n)}`,
      // (percussive: RR is the fall while held; the key-off's is the chip's)
      `:rr${isMod ? 1 : 2} ${eg ? g("RR", n) : g("SR", n) >> 1}`, `:ks${isMod ? 1 : 2} ${g("KS", n) >> 1}`,
      `:ml${isMod ? 1 : 2} ${opllMl(g("ML", n))}`, `:am${isMod ? 1 : 2} ${g("AMEN", n)}`, `:eg${isMod ? 1 : 2} ${eg}`].join(" ");
  };
  const modLine = mod != null ? `:tl1 ${Math.min(63, g("TL", mod) >> 1)} ${op(mod, true)}` : ":tl1 63 :ar1 15 :dr1 0 :sl1 0 :rr1 15 :ks1 0 :ml1 1 :am1 0 :eg1 1";
  const fb = mod === 1 ? w.get("FM_FB") ?? 0 : 0;
  const without = [];
  const others = [1, 2, 3, 4].filter((n) => n !== car && n !== mod && (w.get(`FM_TL${n}`) ?? 127) < 100);
  if (others.length) without.push(`operator${others.length > 1 ? "s" : ""} ${others.join(", ")}`);
  if ([1, 2, 3, 4].some((n) => (w.get(`FM_DT${n}`) ?? 0) !== 0)) without.push("the detune");
  if (mods.length > 1) without.push(`modulator${mods.length - 1 > 1 ? "s" : ""} ${mods.filter((n) => n !== mod).join(", ")}`);
  // On init-fm: the words the 4-op voice has no say in (:ws, :ksl, :vib) set
  // too, so a channel coming from a ROM voice keeps none of its registers —
  // the one user voice is then the same on every channel (W_TARGET).
  return { text: `(def-fm ${name} init-fm${keyOf(words)} :fb ${fb} ${modLine}\n  ${op(car, false)})`, without };
}
function carrierMainOf(w) {
  const carriers = CARRIERS_OF[w.get("FM_ALG") ?? 7];
  return [...carriers].sort((a, b) => (w.get(`FM_TL${a}`) ?? 0) - (w.get(`FM_TL${b}`) ?? 0))[0];
}

/** The waveform of presets/waveforms nearest a 4-op voice's words. */
export function waveformOf(words) {
  const w = full4op(words);
  const wave = nearestVoiceOfWords(w, WAVEFORM_WORDS);
  // The weighing reads the modulators; a sine and a triangle have none, and
  // a triangle is carriers of odd harmonics — its overtones are carriers
  // above the first harmonic, heard (TL under 60).
  if (wave !== "wave-sine") return wave;
  const carriers = { 4: [2, 4], 5: [2, 3, 4], 6: [2, 3, 4], 7: [1, 2, 3, 4] }[w.get("FM_ALG")] ?? [4];
  return carriers.some((n) => w.get(`FM_ML${n}`) > 1 && w.get(`FM_TL${n}`) < 60) ? "wave-triangle" : wave;
}

/**
 * What a voice `name` (its 4-op `words`) plays as on an OPLL `part`:
 * { name, why } — its role's ROM voice, or the ROM voice of its waveform.
 */
export function onOpll(name, words, part) {
  const role = roleOf(name);
  if (role) {
    const rom = romForRole(part, role);
    return { name: rom, why: rom === name ? null : `'${name}' plays the ${part.label}'s ${rom} (its role, ${role})` };
  }
  const wave = waveformOf(words);
  const rom = ROM_OF_WAVE[wave];
  return { name: rom, why: `'${name}' plays the ${part.label}'s ${rom} (nearest presets/waveforms' ${wave.slice(5)})` };
}

/**
 * What an OPLL ROM voice `name` plays as on a 4-op chip: its role, which
 * presets/fm-roles holds under that name (the VRC7's wurly is the piano).
 */
export function romOn4op(name) {
  return roleOf(name) ?? "synth";
}

// The OPLL's words with no 4-op register: said when a voice goes without them.
const OPLL_ONLY = { FM_WS: ":ws (the rectified sine)", FM_KSL: ":ksl" };

// The OPLL's LFOs are fixed (ymfm's ymfm_opl.cpp): the vibrato about ±12
// cents at 6.1 Hz, the tremolo 4.8 dB, each an operator's on or off. On a
// 4-op chip they are the channel's sensitivities to the one LFO: :fms 4
// (±14 cents) and :ams 2 (5.9 dB), the LFO at :lfo-rate 4 (6.37 Hz on the
// OPN; the OPM reads the rate as its nearest).
export const OPLL_VIB_FMS = 4;
export const OPLL_AM_AMS = 2;
export const OPLL_LFO_RATE = 4;

/**
 * An OPLL user voice's words as a 4-op def-fm, named `name`: { text, without,
 * lfo } — `without` the OPLL's words it set that the 4-op chip has not, `lfo`
 * whether it needs the song's LFO (its vibrato or tremolo).
 */
export function opllDefAs4op(name, words) {
  const w = opllWordsAs4op(words);
  const on = (k) => [1, 2].some((n) => words.get(`${k}${n}`) > 0);
  const without = Object.entries(OPLL_ONLY).filter(([k]) => on(k)).map(([, v]) => v);
  const fms = on("FM_VIB") ? OPLL_VIB_FMS : 0;
  const ams = on("FM_AMEN") ? OPLL_AM_AMS : 0;
  const opw = (n) => ["ar", "dr", "sr", "rr", "sl", "tl", "ks", "ml", "am"]
    .map((k) => `:${k}${n} ${w.get(`FM_${k === "am" ? "AMEN" : k.toUpperCase()}${n}`) ?? 0}`).join(" ");
  const lfo = fms || ams ? ` :ams ${ams} :fms ${fms}` : "";
  return { text: `(def-fm ${name}${keyOf(words)} :alg ${w.get("FM_ALG")} :fb ${w.get("FM_FB") ?? 0}${lfo}\n  ${[1, 2, 3, 4].map(opw).join("\n  ")})`, without, lfo: !!(fms || ams) };
}
