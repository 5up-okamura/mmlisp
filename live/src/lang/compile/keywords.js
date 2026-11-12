// The words a score writes, as the compiler knows them: which targets a
// macro, a set or an inline sweep takes, a keyword's IR target and back,
// PCM's and the song's own words, a target or a track that lacks one.

import { pushDiag } from "./diag.js";
import { FM_CHANNEL_WORDS, opWords, FM_OP_WORDS } from "../../machine/chips/fm-words.js";
import { NAMED_CC } from "../../machine/chips/midi.js";
import { partsWithWord } from "../../machine/targets.js";

// Macro-legal targets — everything a `(macro :target …)` may drive.
export const SUPPORTED_TARGETS = new Set([
  "NOTE_PITCH",
  "NOTE_SEMI",
  "KEYON",
  "VEL",
  "VOL",
  "MASTER",
  "LFO_RATE",
  "LFO_FREQ",
  "LFO_PMD",
  "LFO_AMD",
  "LFO_WAVE",
  "NOISE_RATE",
  "ENV_RATE",
  "PAN",
  "NOISE_MODE",
  "DUTY",
  // A MIDI channel's (chips/midi.js): its controllers and channel pressure;
  // a controller a word writes is that word's (namedCc).
  ...Array.from({ length: 128 }, (_, n) => `CC${n}`).filter((_, n) => !(n in NAMED_CC)),
  "PRESSURE",
  // The FM family's (chips/fm-words.js), the inline-only ones aside.
  ...FM_CHANNEL_WORDS.map((w) => w.word),
  ...opWords(FM_OP_WORDS.filter((w) => !w.inline)).map((w) => w.word),
]);

// What a (macro …) may step: the supported targets, the SSG's mixer, which
// a `:mode` macro on it becomes (its inline :mode is the part's), and a wave
// channel's wave, stepped through def-wave names (its inline :wave a wave).
export const MACRO_TARGETS = new Set([...SUPPORTED_TARGETS, "SSG_MIX", "WAVE"]);

// Inline-only targets: sticky channel state with no per-note macro form.
// SNAP (`:snap`, language.md §5.3) is a pitch-class mask the channel's every
// pitch write passes through; a mask is set, never swept or stepped.
// SSG_ENV (`:env`, language.md §19) is the SSG channel's envelope shape, or
// none: a channel's setting, no level; ENV_SEMI and ENV_DETUNE (`:env-semi`,
// `:env-detune`) move the period the channel's notes or rates give it.
// PROG, BANK and BEND_RANGE (`:prog`, `:bank`, `:bend-range`) are a
// MIDI channel's settings: an instrument, its bank, its bend's reach.
// LFO_SYNC (`:lfo-sync on|off`) has the channel's key-ons start the song's
// LFO over.
export const INLINE_TARGETS = new Set(["SNAP", "SSG_ENV", "ENV_SEMI", "ENV_DETUNE", "PROG", "BANK", "BEND_RANGE", "LFO_SYNC", ...opWords(FM_OP_WORDS.filter((w) => w.inline)).map((w) => w.word)]);

// An operator's velocity sensitivity, `:vel1`–`:vel4` (language.md §6): a
// ratio 0–1 of the note's velocity offset, carried as sixteenths. A voice
// param written in a def-fm or inline, never swept: the driver composes it at
// each level write, so it has no macro, `+`/`*` or `$` form.
export const VEL_SENS_TARGETS = new Set(opWords(FM_OP_WORDS.filter((w) => w.word === "FM_VEL")).map((w) => w.word));
const VEL_SENS_KEYWORDS = new Set(opWords(FM_OP_WORDS.filter((w) => w.word === "FM_VEL")).map((w) => w.kw));
// The IR's value for "the role's own" (16 on a carrier, 0 on a modulator).
export const VEL_SENS_AUTO = -1;
// A ratio 0–1 → sixteenths, or null when it is not one.
export function velSensSixteenths(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 16) : null;
}

// Does the score write a velocity sensitivity anywhere — in a voice, inline,
// or in a snippet or effect it defines or imports? Then every voice states all
// four (resolveVoices), so a voice change also resets what the voice before it
// set. A score that never writes one emits none and plays exactly as before.
export function writesVelSens(...roots) {
  const seen = new WeakSet();
  const walk = (n) => {
    if (!n || typeof n !== "object" || seen.has(n)) return false;
    seen.add(n);
    if (n.kind === "atom") return VEL_SENS_KEYWORDS.has(n.value);
    if (n instanceof Map) {
      for (const v of n.values()) if (walk(v)) return true;
      return false;
    }
    return (Array.isArray(n) ? n : Object.values(n)).some(walk);
  };
  return roots.some(walk);
}

// A PCM voice has no pitch step. The engine advances its pointer one byte
// a sample and nothing else, so a note picks a BAKED blob and that is the whole
// pitch mechanism. Every runtime pitch move — cents, semitones, glide, a
// (macro :pitch …) vibrato — has no hardware to land on; reject it rather than
// drop it silently (.claude/memory/pcm.md).
export const PCM_PITCH_TARGETS = new Set(["NOTE_PITCH", "NOTE_SEMI", "SNAP"]);

// A PCM note's points (docs/language.md §16): the range it plays,
// :pcm-start / :pcm-end / :pcm-len (RANGE_*), and inside it the loop a held
// loop note repeats, :loop-start / :loop-end / :loop-len (LOOP_*). Their
// values are LENGTH TOKENS, not plain numbers, and they drive the engine's
// block edge rather than a chip register — so they are PARAM-legal (a literal
// or a curve) but not macro-legal. An …_END and an …_LEN both set their span's
// far bound, pinning the end vs the length; the last one written wins.
// The song-wide write targets a macro does not take (a macro is a note's).
export const SONG_TARGETS = new Set(["MASTER", "LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE", "NOISE_RATE", "ENV_RATE"]);
// Song-wide write targets: their sweeps run in slots of their own on the
// driver, not in the writing channel's two (driver.md §4).
export const isSongTarget = (t) => SONG_TARGETS.has(t) || /^VAL\d+$/.test(t ?? "");

export const PCM_POINT_TARGETS = new Set(["RANGE_START", "RANGE_END", "RANGE_LEN",
  "LOOP_START", "LOOP_END", "LOOP_LEN"]);
export const PCM_PITCH_KEYWORD = { NOTE_PITCH: ":pitch", NOTE_SEMI: ":semi" };

// What a (macro …) can drive on a pcm track: a retrigger (`:keyon` plays the
// blob again from its start — a roll) and the voice's level. The rest are
// chip registers a soft-mixed voice does not have.
export const PCM_MACRO_TARGETS = new Set(["KEYON", "VEL", "VOL"]);
export const PCM_MACRO_ARG_KEYS = ["keyon", "velMacro", "vol"];
// A part that pitches its voice (parts.js `pitch`) takes the pitch words
// but :snap, and their macros.
export const PITCHED_PCM_MACRO_ARG_KEYS = [...PCM_MACRO_ARG_KEYS, "pitchMacro", "note_semi"];
export const pcmTakesPitch = (trackState, irTarget) => !!trackState?.part?.pitch && irTarget !== "SNAP";

export function pcmRejectsPitch(trackState, what, diagnostics, src, trackName, irTarget = "NOTE_PITCH") {
  if (!trackState?.isPcmTrack || pcmTakesPitch(trackState, irTarget)) return false;
  pushDiag(
    diagnostics ?? [],
    "error",
    "E_PCM_NO_PITCH",
    `${what} has no effect on a pcm track: a PCM voice plays its baked blob and cannot bend`,
    src ?? { line: 1, column: 1 },
    trackName,
  );
  return true;
}

// PARAM-legal targets — what an inline `:target v` / `(param-set …)` may write.
// A strict subset of the macro-legal set: NOTE_SEMI, KEYON and VEL have no
// meaningful absolute-write semantics (NOTE_SEMI duplicates NOTE_PITCH, KEYON is
// a note event, VEL is key-on-sticky), so they are macro-only. Writing them as a
// PARAM is rejected.
export const PARAM_SET_TARGETS = new Set([
  ...[...SUPPORTED_TARGETS].filter(
    (t) => t !== "NOTE_SEMI" && t !== "KEYON" && t !== "VEL",
  ),
  ...INLINE_TARGETS,
  ...PCM_POINT_TARGETS,
]);

// The language's word for "this target has no such thing": a feature that
// would change what is heard is an error, a setting with no meaning here a
// warning (docs/roadmap.md, the pc88 item).
export function targetDiag(diagnostics, severity, message, src, track) {
  pushDiag(diagnostics, severity, severity === "error" ? "E_TARGET" : "W_TARGET", message, src, track);
}
// A write target this machine's chips do not have: why, or null. A word is
// a part's when one claims it (chips/parts.js); the rest are on every target.
export function targetLacks(irTarget, sym, target) {
  if (target.hasWord(irTarget)) return null;
  const owners = [...new Set(partsWithWord(irTarget).map((p) => p.label))];
  if (!owners.length) return null;
  const hint = target.hints?.[irTarget];
  return `${sym} is the ${owners.join(" / ")}'s; the ${target.system} has none${hint ? ` — ${hint}` : ""}`;
}
// A part's word on a channel of another part (`:tl1` on sqr1): the channel
// has no such thing, on every target. A song-wide word is any track's. The
// owners named are this target's where it has any, else every target's.
export function trackLacks(irTarget, sym, trackState) {
  const { part, head, target } = trackState;
  if (!part || isSongTarget(irTarget) || part.words(irTarget)) return null;
  const all = partsWithWord(irTarget);
  if (!all.length) return null;
  const here = all.filter((p) => target.parts.includes(p));
  const owners = [...new Set((here.length ? here : all).map((p) => p.label))];
  return `${sym} is the ${owners.join(" / ")}'s; ${head} (${part.label}) has no such thing`;
}

// A MIDI controller a word of the language writes (chips/midi.js NAMED_CC):
// `:cc7` is `:vol`'s, said so.
export function namedCc(target) {
  const n = /^CC(\d+)$/.exec(target ?? "")?.[1];
  const word = n != null ? NAMED_CC[n] : null;
  return word ? `:cc${n} is ${word}'s: CC${n} is written by it (language.md §19)` : null;
}

// PAN symbolic values → logical range -1/0/+1 (encodeB4 maps these to L/LR/R bits)
export const PAN_MAP = { left: -1, center: 0, right: 1 };
// A target's own symbols: the pan's places, the OPM LFO's waveforms, the
// SSG's `:env none` (the 4-bit level back), `:env-semi none` and
// `:env-detune none` (no move), and `:env-rate note` (the envelope's period
// on the writing track's notes, language.md §19).
export const TARGET_SYMBOLS = {
  PAN: PAN_MAP,
  LFO_WAVE: { saw: 0, square: 1, triangle: 2, noise: 3 },
  SSG_ENV: { none: -1 },
  LFO_SYNC: { off: 0, on: 1 },
  ENV_RATE: { note: 0 },
  ENV_SEMI: { none: 0 },
  ENV_DETUNE: { none: 0 },
  // The SSG mixer's, as a `:mode` macro steps it (its inline :mode is the part's modes).
  SSG_MIX: { tone: 0, noise: 1, both: 2, env: 3 },
};

// Macro targets that accept the `*` (multiplicative) modifier: each has a
// per-note/channel static base its macro values scale. Offset targets
// (NOTE_PITCH/NOTE_SEMI) and discrete ones (PAN/KEYON/...) have no base, so
// `*` is rejected there.
export const OP_BASE_TARGETS = new Set(["VEL"]);

// Offset targets carry a runtime base (the channel's live pitch offset), so `+`
// composes the macro with it — resolved in the player, not baked here like VEL.
// `*` has no meaningful multiply of a signed offset and stays rejected.
export const OP_ADD_TARGETS = new Set(["NOTE_PITCH", "NOTE_SEMI"]);

// Split a trailing arithmetic operator off a keyword/atom:
// "vel*" -> { stem: "vel", op: "*" }, "oct+" -> {stem:"oct", op:"+"}, "vel" -> {stem, op:null}.
// Only `+` (add to base) and `*` (multiply base) are operators; no `-`/`/`.
export function opSuffix(sym) {
  const last = sym.length > 1 ? sym[sym.length - 1] : "";
  return last === "*" || last === "+"
    ? { stem: sym.slice(0, -1), op: last }
    : { stem: sym, op: null };
}

// Split a macro keyword into its canonical target and the arithmetic operator:
// `:vel*` -> { target: "VEL", op: "*" }, `:vel+` -> op "+", `:vel` -> op null.
export function macroKeyword(sym) {
  const { stem, op } = opSuffix(sym);
  return { target: canonicalTarget(stem), op };
}

// Targets written as a value alone: no curve, no `+` / `*` (the envelope's
// moves are read where its period is written, language.md §19).
export const SET_ONLY_TARGETS = new Set(["ENV_SEMI", "ENV_DETUNE"]);
// Targets whose literal keeps its fraction: a rate in Hz (an SSG
// envelope's period is a step of it at the bass).
// Targets whose value keeps its fraction to the encoder: the envelope's Hz,
// and a pan, which each chip reads at its own resolution (chips/parts.js).
export const FRACTIONAL_TARGETS = new Set(["ENV_RATE", "PAN"]);

// A `:keyword` the language already means something by — a target, a PCM
// point, or one of the body keywords handled by name — or the `$time` source.
const BODY_KEYWORDS = new Set(["oct", "len", "gate", "tempo", "shuffle", "shuffle-base",
  "csm-rate", "mode", "vel", "time", "prio", "pcm-voices", "step"]);
export function isLanguageKeyword(name) {
  const t = canonicalTarget(":" + name);
  return BODY_KEYWORDS.has(name) || SUPPORTED_TARGETS.has(t) || INLINE_TARGETS.has(t) ||
    PCM_POINT_TARGETS.has(t);
}

// Keyword → IR target name (canonicalTarget).
const TARGET_KEYWORDS = new Map(Object.entries({
  // Sequencer / level
  ":vol": "VOL",
  ":master": "MASTER",
  ":pitch": "NOTE_PITCH",
  ":semi": "NOTE_SEMI",
  ":snap": "SNAP",
  ":keyon": "KEYON",
  // LFO
  ":lfo-rate": "LFO_RATE",
  ":lfo-freq": "LFO_FREQ",
  ":lfo-pmd": "LFO_PMD",
  ":lfo-amd": "LFO_AMD",
  ":lfo-wave": "LFO_WAVE",
  ":lfo-sync": "LFO_SYNC",
  ":noise-rate": "NOISE_RATE",
  ":env": "SSG_ENV",
  ":env-rate": "ENV_RATE",
  ":env-semi": "ENV_SEMI",
  ":env-detune": "ENV_DETUNE",
  // PCM points: the range a note plays, and the loop inside it
  ":pcm-start": "RANGE_START",
  ":pcm-end": "RANGE_END",
  ":pcm-len": "RANGE_LEN",
  ":loop-start": "LOOP_START",
  ":loop-end": "LOOP_END",
  ":loop-len": "LOOP_LEN",
  ":pan": "PAN",
  ":duty": "DUTY",
  ":mode": "NOISE_MODE",
  // The FM family's: the channel's, and each operator's (:tl1–:tl4 …) that
  // some part has — the OPLL's own words on its two operators only.
  ...Object.fromEntries([...FM_CHANNEL_WORDS, ...opWords()].filter((w) => partsWithWord(w.word).length).map((w) => [w.kw, w.word])),
}));

// The keyword a canonical target is written as (FM_SSG1 → :ssg1).
const KEYWORD_OF = new Map([...TARGET_KEYWORDS].map(([kw, t]) => [t, kw]));
export function keywordOf(target) {
  return KEYWORD_OF.get(target) ?? `:${target.toLowerCase().replace(/_/g, "-")}`;
}

export function canonicalTarget(symbol) {
  const known = TARGET_KEYWORDS.get(symbol);
  if (known) return known;
  // The spelled-out fallback must not make `:range-start` a key.
  const t = symbol.replace(/^:/, "").toUpperCase().replace(/-/g, "_");
  return PCM_POINT_TARGETS.has(t) ? null : t;
}
