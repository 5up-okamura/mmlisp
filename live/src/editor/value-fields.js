// Every adjustable value written in the source: the atoms a drag, a
// long-press or the scrub edits (a number, a length, a shift, a pitch) and
// their ranges, found by offset; the hover, Logical Editor and bar marks.

import { MACRO_TARGET_RANGE } from "../ir/ranges.js";
import { canonicalTarget } from "../lang/compile/keywords.js";
import { StateEffect, Decoration, StateField, EditorView } from "../../vendor/codemirror.js";

// ===================================================================
// Interactive value editing
// -------------------------------------------------------------------
// Every adjustable value written in the source — keyword numbers
// (:vel 12, :tl1 45, :pitch -40), any note-length form (8, 8., 16t,
// 16f, 3/4), note names (c, c+, c2, c4.), and v±/o± shifts — can be
// nudged in place. Three surfaces share ONE classifier: long-press
// popup (desktop + touch), Alt+drag scrub (desktop), and the
// Mod-Shift-. / Mod-Shift-, keyboard shortcuts. classifyToken() maps a
// document offset to the editable field(s) at that token; each Field
// owns its replace range and a writeBack() that regenerates the token
// text (preserving suffix / sign / fraction). The token is the unit of
// hover + popup; only Alt+drag resolves to a sub-field by pointer x.
// ===================================================================

// Length-token forms accepted by parseLengthToken (mmlisp2ir.js).
const LEN_TICK = /^(\d+)t$/, LEN_FRAME = /^(\d+)f$/, LEN_FRAC = /^(\d+)\/(\d+)$/,
      LEN_DOT = /^(\d+)\.$/, LEN_PLAIN = /^\d+$/;
const NUM_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;
// Curve range sugar `A..B` (parseRangeToken in mmlisp2ir.js) — one atom
// holding two editable endpoints.
const RANGE_TOKEN = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
const NOTE_BARE = /^[a-g][+-]?$/;
const NOTE_LEN = /^([a-g][+-]?)(.+)$/;
const VEL_SHIFT = /^v([+-])(\d*)$/, OCT_SHIFT = /^o([+-])(\d*)$/;
// Chromatic spelling used when the piano / semitone-nudge rewrites a note.
export const CHROMA = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
export const NOTE_TO_IDX = {
  c: 0, 'c+': 1, 'd-': 1, d: 2, 'd+': 3, 'e-': 3, e: 4, f: 5, 'f+': 6,
  'g-': 6, g: 7, 'g+': 8, 'a-': 8, a: 9, 'a+': 10, 'b-': 10, b: 11,
};

function isLengthForm(v) {
  return LEN_PLAIN.test(v) || LEN_DOT.test(v) || LEN_TICK.test(v) ||
         LEN_FRAME.test(v) || LEN_FRAC.test(v);
}
function rangeForTarget(target) {
  if (!target) return null;
  return MACRO_TARGET_RANGE[target] || MACRO_TARGET_RANGE[target.replace(/\d+$/, '')] || null;
}
export function fmtNum(x, isFloat) {
  return isFloat ? String(Math.round(x * 1000) / 1000) : String(Math.round(x));
}
export function clampField(field, v) {
  const lo = field.min ?? -Infinity, hi = field.max ?? Infinity;
  return Math.max(lo, Math.min(hi, v));
}

// --- Field factories (each returns a Field descriptor) ---
function numberField(from, to, valueStr, keyword) {
  const target = keyword ? canonicalTarget(keyword) : null;
  const range = rangeForTarget(target);
  const isFloat = valueStr.includes('.');
  return {
    kind: 'number', range: [from, to], value: Number(valueStr),
    min: range?.min, max: range?.max, step: 1, isFloat, target,
    label: keyword ? keyword.replace(/^:/, '') : 'value',
    writeBack: (v) => fmtNum(v, isFloat),
  };
}
function lengthField(from, to, valueStr) {
  let m, suffix = '', frac = null, numStr = valueStr;
  if ((m = LEN_TICK.exec(valueStr))) { numStr = m[1]; suffix = 't'; }
  else if ((m = LEN_FRAME.exec(valueStr))) { numStr = m[1]; suffix = 'f'; }
  else if ((m = LEN_DOT.exec(valueStr))) { numStr = m[1]; suffix = '.'; }
  else if ((m = LEN_FRAC.exec(valueStr))) { numStr = m[1]; frac = m[2]; }
  return {
    kind: 'number', range: [from, to], value: parseInt(numStr, 10),
    min: 0, max: undefined, step: 1, isFloat: false, label: 'len',
    writeBack: (v) => {
      const n = Math.max(0, Math.round(v));
      if (frac != null) return `${n}/${frac}`;
      return `${n}${suffix}`;
    },
  };
}
function shiftField(from, to, m, kind) {
  const sign = m[1] === '-' ? -1 : 1;
  const digits = m[2] === '' ? 1 : parseInt(m[2], 10);
  return {
    kind: 'number', range: [from, to], value: sign * digits,
    min: kind === 'v' ? -15 : -9, max: kind === 'v' ? 15 : 9, step: 1,
    isFloat: false, label: kind === 'v' ? 'vel±' : 'oct±',
    writeBack: (v) => { const iv = Math.round(v); return `${kind}${iv < 0 ? '-' : '+'}${Math.abs(iv)}`; },
  };
}
function pitchField(from, to, noteStr) {
  return {
    kind: 'pitch', range: [from, to], value: { note: noteStr.toLowerCase() },
    label: 'note', writeBack: (name) => name,
  };
}

export function fieldsForAtom(v, from, to, keyword) {
  let m;
  if (NOTE_BARE.test(v)) return [pitchField(from, to, v)];
  if ((m = NOTE_LEN.exec(v)) && isLengthForm(m[2])) {
    const mid = from + m[1].length;
    return [pitchField(from, mid, m[1]), lengthField(mid, to, m[2])];
  }
  if ((m = RANGE_TOKEN.exec(v))) {
    // Two endpoints in one atom: `-40..40` → from-field | `..` | to-field.
    const midFrom = from + m[1].length, midTo = to - m[2].length;
    const a = numberField(from, midFrom, m[1], keyword);
    const b = numberField(midTo, to, m[2], keyword);
    a.label = 'from'; b.label = 'to';
    return [a, b];
  }
  if ((m = VEL_SHIFT.exec(v))) return [shiftField(from, to, m, 'v')];
  if ((m = OCT_SHIFT.exec(v))) return [shiftField(from, to, m, 'o')];
  if (keyword && NUM_LITERAL.test(v)) return [numberField(from, to, v, keyword)];
  if (isLengthForm(v)) return [lengthField(from, to, v)];
  if (NUM_LITERAL.test(v)) return [numberField(from, to, v, null)];
  return null;
}

function atomOffsets(doc, node) {
  const lineObj = doc.line(node.line);
  const from = lineObj.from + (node.column - 1);
  return [from, from + String(node.value).length];
}
// Walk the AST for the atom whose span contains `offset`, tracking the
// preceding sibling as keyword context (:vel 12 → keyword ":vel"). Numbers
// inside a `[…]` step array inherit the keyword that precedes the array, so
// `(macro :vel [15 14 …])` classifies each entry as a VEL value, not a len.
export function findAtomAt(items, doc, offset, inheritedKw) {
  for (let i = 0; i < items.length; i++) {
    const n = items[i];
    if (n.kind === 'atom') {
      const [f, t] = atomOffsets(doc, n);
      if (offset >= f && offset <= t) {
        const prev = items[i - 1];
        const kw = prev && prev.kind === 'atom' && prev.value.startsWith(':') ? prev.value : inheritedKw;
        return { node: n, from: f, to: t, keyword: kw, prev: prev?.kind === 'atom' ? String(prev.value) : null };
      }
    } else if (n.kind === 'list') {
      const lf = doc.line(n.line).from + (n.column - 1);
      const lt = doc.line(n.endLine).from + (n.endColumn - 1);
      if (offset >= lf && offset <= lt) {
        // `[…]` = step array: entries inherit the array's keyword.
        // `(…)` = a sub-form (curve/call): its args carry their own keywords.
        let childKw = null;
        if (n.bracket === '[]') {
          const prev = items[i - 1];
          childKw = prev && prev.kind === 'atom' && prev.value.startsWith(':') ? prev.value : inheritedKw;
        }
        const r = findAtomAt(n.items, doc, offset, childKw);
        if (r) return r;
      }
    }
  }
  return null;
}

// A written voice or sample name is a token too: its long-press opens the
// completion list on it (openNamePicker), so the pick replaces it. Not the
// name a def is defining.
export const NAME_DEF_HEADS = new Set(['def', 'def-fm', 'def-pcm', 'def-wave', 'def-val']);

export function fieldAtOffset(info, offset) {
  return info.fields.find((f) => offset >= f.range[0] && offset <= f.range[1]) || info.fields[0];
}

// --- Hover affordance (whole-token underline; DOM hint + cursor) ---
// Modifier-key interactions are invisible, so hovering an adjustable value
// marks the WHOLE token (c2 / c4. / v+2 are never split) and shows a hint.
export const setHover = StateEffect.define();
const hoverMark = Decoration.mark({ class: 'cm-valHover' });
export const hoverField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHover)) deco = e.value ? Decoration.set([hoverMark.range(e.value[0], e.value[1])]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Logical Editor matches: marked while its panel is open. ---
export const setLogicalMarks = StateEffect.define();
export const logicalMark = Decoration.mark({ class: 'cm-logical-match' });
export const logicalSharedMark = Decoration.mark({ class: 'cm-logical-match cm-logical-shared' });
export const logicalField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = tr.docChanged ? Decoration.none : deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLogicalMarks)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Bar markers ( | ): follow edits like the playhead; info on tap. ---
// Positions are re-anchored on build and mapped through later edits; the
// tick count / ordinal are build-time values (marked stale after an edit).
export const setBars = StateEffect.define();
export const barField = StateField.define({
  create: () => ({ list: [], stale: false }),
  update(v, tr) {
    let { list, stale } = v;
    if (tr.docChanged && list.length) {
      list = list
        .map((b) => ({ ...b, from: tr.changes.mapPos(b.from, -1), to: tr.changes.mapPos(b.to, 1) }))
        .filter((b) => b.to > b.from);
      stale = true;
    }
    for (const e of tr.effects) if (e.is(setBars)) { list = e.value; stale = false; }
    return list === v.list && stale === v.stale ? v : { list, stale };
  },
});
// A bar `|` is a single character, so allow a small slop (its own width
// plus a char of surrounding whitespace) to make the marker easy to hit.
const BAR_HIT_SLOP = 1;
export function barAtOffset(state, offset) {
  const { list, stale } = state.field(barField, false) ?? { list: [], stale: false };
  const b = list.find((x) => offset >= x.from - BAR_HIT_SLOP && offset <= x.to + BAR_HIT_SLOP);
  return b ? { ...b, stale } : null;
}
