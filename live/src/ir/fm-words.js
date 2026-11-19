// ---------------------------------------------------------------------------
// The FM family's words (language.md §9, def-fm): one table, which the
// compiler's keywords, macro targets and voice keys, the IR's ranges
// (ir/ranges.js MACRO_TARGET_RANGE), the editor's completion and each FM
// part's word list (chips/parts.js `words`) are all read from. A word is the
// family's; a part names which of them its chip has, and how many operators,
// so a word one chip lacks (SSG-EG on the OPM, DT2 on the OPN) is that
// chip's diagnostic and no other's.
//
//   kw     the keyword (an operator's takes its number: `:tl1`)
//   word   the IR target (an operator's takes its number: FM_TL1)
//   field  the word's field in a register shadow (machine/chips/opn-regs.js
//          buildChannelRegState, the Live panel's regs)
//   reg    the register the field is written through: an operator word's
//          the encoders' op(ch, op, reg, o) group, a channel word's the
//          encoder's alg / pan / sus
//   label  the Live panel's
//   min, max  the value's range, clamped at the register write
//   init   the value `init-fm`, the empty voice, holds; absent: not set
//   inline an operator word written inline or in a def-fm only, never a
//          macro's (the velocity sensitivity)
//   track  a channel word that is the track's, not the voice's: no def-fm
//          key (the OPLL's sustain, a bit of its key register)
// The order is the order a voice's writes go into the IR.
// ---------------------------------------------------------------------------

export const FM_CHANNEL_WORDS = [
  { kw: ":alg", word: "FM_ALG", field: "algorithm", reg: "alg", min: 0, max: 7, init: 7 },
  { kw: ":fb", word: "FM_FB", field: "feedback", reg: "alg", min: 0, max: 7, init: 0 },
  { kw: ":ams", word: "FM_AMS", field: "ams", reg: "pan", min: 0, max: 3, init: 0 },
  { kw: ":fms", word: "FM_FMS", field: "fms", reg: "pan", min: 0, max: 7, init: 0 },
  { kw: ":sus", word: "FM_SUS", field: "sus", reg: "sus", min: 0, max: 1, track: true }, // the OPLL's: a keyed-off note releases at RR 5
];

export const FM_OP_WORDS = [
  { kw: ":ar", word: "FM_AR", field: "ar", reg: "ks-ar", label: "AR", min: 0, max: 31, init: 31 },
  { kw: ":dr", word: "FM_DR", field: "dr", reg: "am-dr", label: "DR", min: 0, max: 31, init: 0 },
  { kw: ":sr", word: "FM_SR", field: "d2r", reg: "sr", label: "SR", min: 0, max: 31, init: 0 },
  { kw: ":rr", word: "FM_RR", field: "rr", reg: "sl-rr", label: "RR", min: 0, max: 15, init: 15 },
  { kw: ":sl", word: "FM_SL", field: "sl", reg: "sl-rr", label: "SL", min: 0, max: 15, init: 0 },
  { kw: ":tl", word: "FM_TL", field: "tl", reg: "tl", label: "TL", min: 0, max: 127, init: 0 },
  { kw: ":ks", word: "FM_KS", field: "rs", reg: "ks-ar", label: "KS", min: 0, max: 3, init: 0 },
  { kw: ":ml", word: "FM_ML", field: "mul", reg: "dt-ml", label: "MUL", min: 0, max: 15, init: 1 },
  { kw: ":dt", word: "FM_DT", field: "dt", reg: "dt-ml", label: "DT", min: -3, max: 3, init: 0 }, // signed; encode30 maps it to the register
  { kw: ":ssg", word: "FM_SSG", field: "ssg", reg: "ssg-eg", label: "SSG", min: 0, max: 15, init: 0 }, // the OPN's SSG-EG
  { kw: ":am", word: "FM_AMEN", field: "amen", reg: "am-dr", label: "AM", min: 0, max: 1, init: 0 },
  { kw: ":dt2-", word: "FM_DT2_", field: "dt2", reg: "sr", label: "DT2", min: 0, max: 3, init: 0 }, // the OPM's DT2 (op N's DT1 is :dtN)
  // The OPLL's: the waveform (1 the half-wave rectified sine), the envelope
  // type (1 sustained, 0 percussive), the level's key scale, the vibrato.
  { kw: ":ws", word: "FM_WS", field: "ws", reg: "voice", label: "WS", min: 0, max: 1 },
  { kw: ":eg", word: "FM_EG", field: "eg", reg: "voice", label: "EG", min: 0, max: 1 },
  { kw: ":ksl", word: "FM_KSL", field: "ksl", reg: "voice", label: "KSL", min: 0, max: 3 },
  { kw: ":vib", word: "FM_VIB", field: "vib", reg: "voice", label: "VIB", min: 0, max: 1 },
  // Velocity sensitivity in sixteenths (language.md §6); -1 is the role's own.
  { kw: ":vel", word: "FM_VEL", field: "velK", reg: "tl", label: "VEL", min: -1, max: 16, inline: true },
];

// An operator's register groups (the words' `reg`), in the order a voice's
// are written; `voice` is the OPLL's, whose operator words are bits of one
// voice. An encoder answers a group its chip lacks with no write.
export const FM_OP_REGS = ["dt-ml", "tl", "ks-ar", "am-dr", "sr", "sl-rr", "ssg-eg", "voice"];

// The most operators an FM part has: the four of the OPN and the OPM.
export const FM_OPS = 4;
export const OPS = Array.from({ length: FM_OPS }, (_, i) => i + 1);

/** Every operator's instance of the words `ws`, operator by operator: [{…w, op, kw, word}]. */
export function opWords(ws = FM_OP_WORDS, ops = FM_OPS) {
  const out = [];
  for (let op = 1; op <= ops; op++)
    for (const w of ws) out.push({ ...w, op, kw: `${w.kw}${op}`, word: `${w.word}${op}` });
  return out;
}

/**
 * An FM part's `words` (chips/parts.js): the channel words `channel`, the
 * operator words `op` (base words, FM_TL …) for operators 1..`ops` — or
 * `op(n)`, operator n's — and `more` (PAN). A closed list: a word added to
 * the family is no part's until a part names it.
 */
export function fmWords({ channel, op, ops = FM_OPS, more = [] }) {
  const opsOf = typeof op === "function" ? op : () => op;
  const has = new Set([...channel, ...more]);
  for (let n = 1; n <= ops; n++) for (const w of opsOf(n)) has.add(`${w}${n}`);
  return (word) => has.has(word);
}

/**
 * `init-fm`, the empty voice, on `part` (an FM part, or null): the part's
 * own (`initVoice`), else the family's init values of the words the part
 * has — the OPN's sine with its SSG-EG off, the OPM's with its DT2 at 0,
 * every operator a carrier at TL 0. A Map word → value.
 */
export function fmInitVoice(part) {
  if (part?.initVoice) return new Map(part.initVoice);
  return new Map([...FM_CHANNEL_WORDS, ...opWords()]
    .filter((w) => w.init !== undefined && (!part || part.words(w.word)))
    .map((w) => [w.word, w.init]));
}

/** The operator word `word` (FM_TL, no number) in the table. */
const OP_WORD_OF = new Map(FM_OP_WORDS.map((w) => [w.word, w]));
const CHANNEL_WORD_OF = new Map(FM_CHANNEL_WORDS.map((w) => [w.word, w]));
/** An operator word's entry by its IR target without the operator (FM_TL). */
export const fmOpWord = (word) => OP_WORD_OF.get(word);
/** A channel word's entry by its IR target (FM_ALG). */
export const fmChannelWord = (word) => CHANNEL_WORD_OF.get(word);
