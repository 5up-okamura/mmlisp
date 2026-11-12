// A def-fm as the panel edits it: the algorithms' carriers, edges and
// layout, the operator words, a voice's default registers, a word's key in
// the def and the text that writes or replaces it.

import { fmOpWord } from "../ir/fm-words.js";

// -----------------------------------------------------------------------
// Parameter UI
// -----------------------------------------------------------------------

// Algorithm descriptions (what's a carrier, what's a modulator)
// Carrier operators (1-indexed) per algorithm
export const ALG_CARRIERS = [
  [4],             // ALG 0: 1→2→3→4
  [4],             // ALG 1: (1+2)→3→4
  [4],             // ALG 2: (1+(2→3))→4
  [4],             // ALG 3: ((1→2)+3)→4
  [2, 4],          // ALG 4: (1→2)+(3→4)
  [2, 3, 4],       // ALG 5: 1→(2+3+4)
  [2, 3, 4],       // ALG 6: (1→2)+3+4
  [1, 2, 3, 4],    // ALG 7: 1+2+3+4
  [2],             // the OPLL's two operators: 1→2 (TWO_OP)
];
// The diagram's and the roles' algorithm on a 2-op FM (the OPLL's), which
// has none of its own: op1 into op2. Set from the score's target
// (applyTargetUi): a target with FM and no :alg.
export const TWO_OP = 8;

// Operator modulation edges [from→to] and grid positions [col,row] per algorithm.
export const ALG_EDGES = [
  [[1,2],[2,3],[3,4]],   // 0
  [[1,3],[2,3],[3,4]],   // 1
  [[2,3],[3,4],[1,4]],   // 2
  [[1,2],[2,4],[3,4]],   // 3
  [[1,2],[3,4]],         // 4
  [[1,2],[1,3],[1,4]],   // 5
  [[1,2]],               // 6
  [],                    // 7
  [[1,2]],               // TWO_OP
];
// Operator grid positions [col,row]: modulators left → carriers right (carriers
// sit in the rightmost column so they collect into the output bus on the right).
export const ALG_LAYOUT = [
  { 1:[0,0], 2:[1,0], 3:[2,0], 4:[3,0] },  // 0: 1→2→3→4
  { 1:[0,0], 2:[0,1], 3:[1,0], 4:[2,0] },  // 1: (1+2)→3→4
  { 2:[0,0], 3:[1,0], 1:[1,1], 4:[2,0] },  // 2: (1+(2→3))→4
  { 1:[0,0], 2:[1,0], 3:[1,1], 4:[2,0] },  // 3: ((1→2)+3)→4
  { 1:[0,0], 2:[1,0], 3:[0,1], 4:[1,1] },  // 4: (1→2)+(3→4)
  { 1:[0,1], 2:[1,0], 3:[1,1], 4:[1,2] },  // 5: 1→(2+3+4)
  { 1:[0,0], 2:[1,0], 3:[1,1], 4:[1,2] },  // 6: (1→2)+3+4
  { 1:[0,0], 2:[1,1], 3:[2,2], 4:[3,3] },  // 7: 1+2+3+4 (staggered so it isn't cramped)
  { 1:[0,0], 2:[1,0] },                     // TWO_OP: 1→2
];

// The operator rows, one per IR word: the panel's sliders, a def-fm's
// keys (fmParamToDefKey) and the regs field (`key`) each one reads. A row
// shows when the score's target has its word (applyTargetUi): SSG-EG is
// the OPN's, DT2 the OPM's, WS / EG / KSL / VIB the OPLL's, and the OPLL
// has two operators, op1's TL alone.
// In the panel's order (the envelope's first), each row the FM family's
// word (src/ir/fm-words.js): its range, label and regs field. VEL's
// slider runs 0–1 in sixteenths (language.md §6), not its -1 "the role's own".
export const OP_PARAMS = ['FM_TL', 'FM_AR', 'FM_DR', 'FM_SL', 'FM_SR', 'FM_RR', 'FM_ML', 'FM_DT', 'FM_DT2_', 'FM_KS', 'FM_SSG',
  'FM_WS', 'FM_EG', 'FM_KSL', 'FM_VIB', 'FM_VEL']
  .map((word) => fmOpWord(word))
  .map((w) => {
    const vel = w.word === 'FM_VEL';
    return { key: vel ? 'vel' : w.field, label: w.label, min: vel ? 0 : w.min, max: w.max, param: (op) => `${w.word}${op}` };
  });
// The rows that are a register value, read and written alike (VEL is a
// sensitivity, kept as velK with its role's default).
export const OP_REG_PARAMS = OP_PARAMS.filter((pp) => pp.key !== 'vel');

export function defaultFmRegs() {
  return {
    algorithm: 0,
    feedback: 0,
    lfoRate: 0,
    ams: 0,
    fms: 0,
    ops: Array.from({ length: 4 }, () => ({
      ...Object.fromEntries(OP_REG_PARAMS.map((pp) => [pp.key, 0])),
      amen: 0,
    })),
  };
}


export function isFmVoiceDefNode(node) {
  return node?.kind === 'list' && node.items?.[0]?.value === 'def-fm';
}

// Where a new `:key value` goes in a def: just inside its `)` (endColumn is
// one past it, 1-based).
export function defCloseAt(doc, node) {
  return doc.line(node.endLine).from + node.endColumn - 2;
}

export function fmParamToDefKey(paramName) {
  if (paramName === 'FM_ALG') return ':alg';
  if (paramName === 'FM_FB') return ':fb';
  if (paramName === 'FM_AMS') return ':ams';
  if (paramName === 'FM_FMS') return ':fms';
  const m = paramName.match(/^FM_(TL|AR|DR|SL|SR|RR|ML|DT2_|DT|KSL|KS|SSG|AMEN|VEL|WS|EG|VIB)([1-4])$/);
  if (!m) return null;
  if (m[1] === 'AMEN') return `:am${m[2]}`;
  if (m[1] === 'DT2_') return `:dt2-${m[2]}`;
  return `:${m[1].toLowerCase()}${m[2]}`;
}

// `closePos`: the def-fm's `)` within defText — a key the voice does not
// write yet goes after the last pair of its operator (`:vel3` after op3's
// `:dt3 0`, so the row stays one row and the formatter aligns it), else
// just inside the `)`.
export function replaceOrInsertDefParam(defText, defKey, valueText, closePos) {
  const esc = defKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${esc}\\s+)([^\\s\\)\\]]+)`);
  if (re.test(defText)) {
    return defText.replace(re, `$1${valueText}`);
  }
  const op = /^:[a-z]+([1-4])$/.exec(defKey)?.[1];
  if (op) {
    const rowRe = new RegExp(`:[a-z]+${op}\\s+[^\\s\\)\\]]+`, 'g');
    let last = null;
    for (const m of defText.matchAll(rowRe)) last = m;
    if (last) {
      const at = last.index + last[0].length;
      return `${defText.slice(0, at)} ${defKey} ${valueText}${defText.slice(at)}`;
    }
  }
  if (!(closePos >= 0)) return defText;
  return `${defText.slice(0, closePos)}\n  ${defKey} ${valueText}${defText.slice(closePos)}`;
}

// A velocity sensitivity's sixteenths as the ratio the score writes
// (`:vel1 0.5`); every sixteenth is an exact short decimal.
export function velSensText(k16) {
  return String(k16 / 16);
}
