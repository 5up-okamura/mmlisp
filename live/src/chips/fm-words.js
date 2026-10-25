// ---------------------------------------------------------------------------
// The FM family's words (language.md §9, def-fm): one table, which the
// compiler's keywords, macro targets and voice keys, the IR's ranges
// (ir-utils.js MACRO_TARGET_RANGE), the editor's completion and each FM
// part's word list (chips/parts.js `words`) are all read from. A word is the
// family's; a part names which of them its chip has, and how many operators,
// so a word one chip lacks (SSG-EG on the OPM, DT2 on the OPN) is that
// chip's diagnostic and no other's.
//
//   kw     the keyword (an operator's takes its number: `:tl1`)
//   word   the IR target (an operator's takes its number: FM_TL1)
//   field  an operator's field in a register shadow (ir-utils.js
//          buildChannelRegState, the Live panel's regs)
//   label  the Live panel's
//   min, max  the value's range, clamped at the register write
//   init   the value `init-fm`, the empty voice, holds; absent: not set
//   inline an operator word written inline or in a def-fm only, never a
//          macro's (the velocity sensitivity)
// The order is the order a voice's writes go into the IR.
// ---------------------------------------------------------------------------

export const FM_CHANNEL_WORDS = [
  { kw: ":alg", word: "FM_ALG", min: 0, max: 7, init: 7 },
  { kw: ":fb", word: "FM_FB", min: 0, max: 7, init: 0 },
  { kw: ":ams", word: "FM_AMS", min: 0, max: 3, init: 0 },
  { kw: ":fms", word: "FM_FMS", min: 0, max: 7, init: 0 },
];

export const FM_OP_WORDS = [
  { kw: ":ar", word: "FM_AR", field: "ar", label: "AR", min: 0, max: 31, init: 31 },
  { kw: ":dr", word: "FM_DR", field: "dr", label: "DR", min: 0, max: 31, init: 0 },
  { kw: ":sr", word: "FM_SR", field: "d2r", label: "SR", min: 0, max: 31, init: 0 },
  { kw: ":rr", word: "FM_RR", field: "rr", label: "RR", min: 0, max: 15, init: 15 },
  { kw: ":sl", word: "FM_SL", field: "sl", label: "SL", min: 0, max: 15, init: 0 },
  { kw: ":tl", word: "FM_TL", field: "tl", label: "TL", min: 0, max: 127, init: 0 },
  { kw: ":ks", word: "FM_KS", field: "rs", label: "KS", min: 0, max: 3, init: 0 },
  { kw: ":ml", word: "FM_ML", field: "mul", label: "MUL", min: 0, max: 15, init: 1 },
  { kw: ":dt", word: "FM_DT", field: "dt", label: "DT", min: -3, max: 3, init: 0 }, // signed; encode30 maps it to the register
  { kw: ":ssg", word: "FM_SSG", field: "ssg", label: "SSG", min: 0, max: 15, init: 0 }, // the OPN's SSG-EG
  { kw: ":am", word: "FM_AMEN", field: "amen", label: "AM", min: 0, max: 1, init: 0 },
  { kw: ":dt2-", word: "FM_DT2_", field: "dt2", label: "DT2", min: 0, max: 3 }, // the OPM's DT2 (op N's DT1 is :dtN)
  // Velocity sensitivity in sixteenths (language.md §6); -1 is the role's own.
  { kw: ":vel", word: "FM_VEL", field: "velK", label: "VEL", min: -1, max: 16, inline: true },
];

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
 * An FM part's `words` (chips/parts.js): the channel words, the operator
 * words for operators 1..`ops` (`except` those the chip lacks, by base word),
 * and `more` (PAN). A closed list: a word added to the family is no part's
 * until a part names it.
 */
export function fmWords({ ops = FM_OPS, except = [], more = [] } = {}) {
  const has = new Set([
    ...FM_CHANNEL_WORDS.map((w) => w.word),
    ...opWords(FM_OP_WORDS.filter((w) => !except.includes(w.word)), ops).map((w) => w.word),
    ...more,
  ]);
  return (word) => has.has(word);
}

/** The operator word `word` (FM_TL, no number) in the table. */
export const fmOpWord = (word) => FM_OP_WORDS.find((w) => w.word === word);
