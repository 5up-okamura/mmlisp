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

import { parse } from "./mmlisp-parser.js";
import { programOf } from "./gm-names.js";
import { fmInitVoice } from "./chips/fm-words.js";
import { opllRomVoices, opllWordsAs4op, OPLL_ROM_NAMES } from "./chips/ym2413.js";
import { nearestVoiceOfWords } from "./import-fm-voices.js";
import { canonicalTarget } from "./mmlisp2ir.js";

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
const ROM_OF_WAVE = { "wave-square": "clarinet", "wave-saw": "synth", "wave-triangle": "flute", "wave-sine": "flute" };

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
const OPLL_ONLY = { FM_WS: ":ws (the rectified sine)", FM_KSL: ":ksl", FM_VIB: ":vib (the chip's vibrato)" };

/**
 * An OPLL user voice's words as a 4-op def-fm, named `name`: { text, without }
 * — `without` the OPLL's words it set that the 4-op chip has not.
 */
export function opllDefAs4op(name, words) {
  const w = opllWordsAs4op(words);
  const without = Object.entries(OPLL_ONLY).filter(([k]) => [1, 2].some((n) => words.get(`${k}${n}`) > 0)).map(([, v]) => v);
  const opw = (n) => ["ar", "dr", "sr", "rr", "sl", "tl", "ks", "ml", "am"]
    .map((k) => `:${k}${n} ${w.get(`FM_${k === "am" ? "AMEN" : k.toUpperCase()}${n}`) ?? 0}`).join(" ");
  return { text: `(def-fm ${name} :alg ${w.get("FM_ALG")} :fb ${w.get("FM_FB") ?? 0}\n  ${[1, 2, 3, 4].map(opw).join("\n  ")})`, without };
}
