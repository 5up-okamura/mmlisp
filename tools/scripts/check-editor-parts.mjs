#!/usr/bin/env node
// The page's editor parts held in node, as the page uses them: the value a
// drag or long-press edits (its range, its label, what it writes back), the
// panel's write of a def-fm word into the def's text, the brackets left open
// and closed by the editor's shortcut, and the panel's algorithm tables
// against the chip's own carriers.

import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "../../live/vendor/codemirror.js";
import { fieldsForAtom, findAtomAt, fieldAtOffset, clampField, fmtNum } from "../../live/src/editor/value-fields.js";
import { ALG_CARRIERS, ALG_EDGES, ALG_LAYOUT, TWO_OP, fmParamToDefKey, replaceOrInsertDefParam, velSensText, defCloseAt, isFmVoiceDefNode } from "../../live/src/editor/fm-def.js";
import { bracketField, closeOpenBrackets } from "../../live/src/editor/brackets.js";
import { fmCarrierOpsForAlg } from "../../live/src/machine/chips/opn-regs.js";
import { parse } from "../../live/src/lang/mmlisp-parser.js";

let n = 0;
const check = (what, fn) => { fn(); n++; };

// --- the values a drag edits -----------------------------------------------
// [atom, the keyword before it, [kind, label, value, min, max] per field,
//  what each writes back at value + 1]
const FIELDS = [
  ["31", ":ar1", [["number", "ar1", 31, 0, 31]], ["32"]],
  ["127", ":tl1", [["number", "tl1", 127, 0, 127]], ["128"]],
  ["8", null, [["number", "len", 8, 0, undefined]], ["9"]],
  ["4.", null, [["number", "len", 4, 0, undefined]], ["5."]],
  ["24t", null, [["number", "len", 24, 0, undefined]], ["25t"]],
  ["3/16", null, [["number", "len", 3, 0, undefined]], ["4/16"]],
  ["c4", null, [["pitch", "note"], ["number", "len", 4, 0, undefined]], [null, "5"]],
  ["e-8", null, [["pitch", "note"], ["number", "len", 8, 0, undefined]], [null, "9"]],
  ["v+2", null, [["number", "vel±", 2, -15, 15]], ["v+3"]],
  ["o-", null, [["number", "oct±", -1, -9, 9]], ["o+0"]],
  ["0..15", null, [["number", "from", 0, undefined, undefined], ["number", "to", 15, undefined, undefined]], ["1", "16"]],
  ["1.5", ":pitch", [["number", "pitch", 1.5, -32768, 32767]], ["2.5"]],
];
for (const [atom, kw, want, back] of FIELDS) check(`fields of ${atom}`, () => {
  const got = fieldsForAtom(atom, 10, 10 + atom.length, kw);
  assert.equal(got.length, want.length, `${atom}: ${got.length} fields`);
  got.forEach((f, i) => {
    const [kind, label, value, min, max] = want[i];
    assert.equal(f.kind, kind, `${atom} field ${i}: kind`);
    assert.equal(f.label, label, `${atom} field ${i}: label`);
    if (kind !== "number") return;
    assert.equal(f.value, value, `${atom}: value`);
    assert.equal(f.min, min, `${atom}: min`);
    assert.equal(f.max, max, `${atom}: max`);
    assert.equal(f.writeBack(f.value), atom.slice(f.range[0] - 10, f.range[1] - 10).replace(/^o-$/, "o-1"), `${atom}: writes itself back`);
    assert.equal(f.writeBack(f.value + 1), back[i], `${atom}: + 1`);
  });
});
check("a field's clamp and its number", () => {
  assert.equal(clampField({ min: 0, max: 31 }, 40), 31);
  assert.equal(clampField({ min: 0, max: 31 }, -2), 0);
  assert.equal(clampField({}, 1e6), 1e6);
  assert.equal(fmtNum(1.23456, true), "1.235");
  assert.equal(fmtNum(2.6, false), "3");
});
check("the atom at an offset, and its field", () => {
  const doc = EditorState.create({ doc: "(fm1 :ar1 31 c4 e8)" }).doc;
  const roots = parse(doc.toString());
  // As the page's classifyToken builds it: the atom, then its fields.
  const token = (offset) => {
    const hit = findAtomAt(roots, doc, offset, null);
    return hit && { hit, fields: fieldsForAtom(String(hit.node.value), hit.from, hit.to, hit.keyword) };
  };
  const at = token(10);
  assert.equal(at.hit.node.value, "31");
  assert.equal(at.hit.keyword, ":ar1");
  assert.equal(fieldAtOffset(at, 11).label, "ar1");
  const note = token(13);
  assert.equal(note.hit.node.value, "c4");
  assert.equal(fieldAtOffset(note, 13).kind, "pitch");
  assert.equal(fieldAtOffset(note, 15).label, "len");
});

// --- a def-fm word written by the panel ------------------------------------
check("a panel word's key in the def", () => {
  assert.equal(fmParamToDefKey("FM_TL1"), ":tl1");
  assert.equal(fmParamToDefKey("FM_AR3"), ":ar3");
  assert.equal(fmParamToDefKey("FM_DT2_4"), ":dt2-4");
  assert.equal(fmParamToDefKey("FM_AMEN2"), ":am2");
  assert.equal(fmParamToDefKey("FM_VEL1"), ":vel1");
  assert.equal(fmParamToDefKey("FM_ALG"), ":alg");
  assert.equal(fmParamToDefKey("FM_FB"), ":fb");
  assert.equal(fmParamToDefKey("FM_TL5"), null);
  assert.equal(fmParamToDefKey("PSG_VOL"), null);
});
check("the def's text: a word replaced, inserted on its row, or before the )", () => {
  const def = "(def-fm a init-fm :alg 4\n  :ar1 31 :tl1 30\n  :ar2 31)";
  const close = def.length - 1;
  assert.equal(replaceOrInsertDefParam(def, ":tl1", "40", close), "(def-fm a init-fm :alg 4\n  :ar1 31 :tl1 40\n  :ar2 31)");
  assert.equal(replaceOrInsertDefParam(def, ":alg", "7", close), "(def-fm a init-fm :alg 7\n  :ar1 31 :tl1 30\n  :ar2 31)");
  assert.equal(replaceOrInsertDefParam(def, ":rr1", "15", close), "(def-fm a init-fm :alg 4\n  :ar1 31 :tl1 30 :rr1 15\n  :ar2 31)");
  assert.equal(replaceOrInsertDefParam(def, ":tl3", "20", close), "(def-fm a init-fm :alg 4\n  :ar1 31 :tl1 30\n  :ar2 31\n  :tl3 20)");
  assert.equal(replaceOrInsertDefParam(def, ":fb", "5", close), "(def-fm a init-fm :alg 4\n  :ar1 31 :tl1 30\n  :ar2 31\n  :fb 5)");
  assert.equal(replaceOrInsertDefParam(def, ":fb", "5", -1), def, "no ) known: unchanged");
  assert.equal(velSensText(16), "1");
  assert.equal(velSensText(8), "0.5");
  assert.equal(velSensText(0), "0");
});
check("a def-fm found and its ) placed", () => {
  const text = "(def-fm a init-fm :alg 4\n  :tl1 30)\n(fm1 @a c)";
  const doc = EditorState.create({ doc: text }).doc;
  const [def, track] = parse(text);
  assert.ok(isFmVoiceDefNode(def));
  assert.ok(!isFmVoiceDefNode(track));
  assert.equal(text[defCloseAt(doc, def)], ")");
  assert.equal(defCloseAt(doc, def), text.indexOf(")"));
});

// --- the algorithm tables ---------------------------------------------------
check("the panel's carriers are the chip's", () => {
  for (let alg = 0; alg < 8; alg++)
    assert.deepEqual(ALG_CARRIERS[alg], fmCarrierOpsForAlg(alg).map((i) => i + 1), `alg ${alg}`);
  assert.deepEqual(ALG_CARRIERS[TWO_OP], [2]);
  assert.equal(ALG_EDGES.length, ALG_CARRIERS.length);
  assert.equal(ALG_LAYOUT.length, ALG_CARRIERS.length);
  // A carrier is an operator no edge leaves.
  ALG_EDGES.forEach((edges, alg) => {
    const ops = alg === TWO_OP ? [1, 2] : [1, 2, 3, 4];
    const from = new Set(edges.map(([a, b]) => (a === b ? null : a)).filter(Boolean));
    assert.deepEqual(ops.filter((o) => !from.has(o)), ALG_CARRIERS[alg], `alg ${alg}'s edges`);
  });
});

// --- the brackets left open, closed at the cursor ---------------------------
check("the open brackets before the cursor closed, innermost first", () => {
  const close = (text) => {
    let state = EditorState.create({ doc: text, extensions: [bracketField], selection: EditorSelection.cursor(text.length) });
    const view = { get state() { return state; }, dispatch: (spec) => { state = state.update(spec).state; } };
    const did = closeOpenBrackets(view);
    return [did, state.doc.toString()];
  };
  assert.deepEqual(close("(fm1 c d"), [true, "(fm1 c d)"]);
  assert.deepEqual(close("(def-wave w [1 2"), [true, "(def-wave w [1 2])"]);
  assert.deepEqual(close('(fm1 "(" c'), [true, '(fm1 "(" c)'], "a string's ( is text");
  assert.deepEqual(close("(fm1 ; (\n c"), [true, "(fm1 ; (\n c)"], "a comment's ( is text");
  assert.deepEqual(close("(fm1 c)"), [false, "(fm1 c)"]);
});

console.log(`check:editor-parts ok — ${n} checks`);
