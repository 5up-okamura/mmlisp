// What the completion offers beyond the word list: the forms' templates,
// the defs a score and its imports name, a track's kind, the reference
// entry at the cursor.

import { AC_TRACKS, AC_FORMS, AC_PARAMS } from "./completion-names.js";
import { isReservedHead } from "../lang/mmlisp-eval.js";
import { pickedCompletion, EditorView, hasHoverTooltips, closeHoverTooltips } from "../../vendor/codemirror.js";

// -----------------------------------------------------------------------
// Autocomplete
// -----------------------------------------------------------------------
// Templates for the forms whose argument shape is fixed enough that filling
// it in beats typing it. Body only — the parens are already in the document
// (typing '(' auto-closes). `${n:text}` are tab stops whose placeholder is
// a usable default, so leaving the snippet early (Esc) still leaves valid
// source. Forms whose shape genuinely varies keep the plain name.
export const AC_SNIPPETS = {
  'def': 'def ${1:name} ${2}',
  'def-val': 'def-val ${1:name} ${2:0} ${3:0..127}',
  'def-se': 'def-se ${1:name} :prio ${2:5} (${3:fm1} ${4})',
  'def-score': 'def-score :title "${1}"',
  'def-mod': 'def-mod :ch ${1:fm1} :keyon off',
  'import': 'import "${1:voices.mmlisp}"',
  'x': 'x ${1:4} ${2}',
  'go': 'go ${1:head}',
  'macro': 'macro :${1:vel} ${2}',
  'echo': 'echo ${1:3} :${2:vel+} ${3:-1}',
  'delay': 'delay ${1:3} :${2:vel+} ${3:-4} :time ${4:1/8}',
  'glide': 'glide ${1:1/8}',
};

// An :fx writes out EVERY parameter, each a tab stop holding its
// default, so the list need not be remembered — generated from the table
// the compiler checks against, so a new param shows up here by itself. A
// required param has no default; it gets a usable example. A param whose
// default is not writable (fade :at, "`:len` before the end") is left out
// and named in the completion's detail instead.
export const AC_FX_EXAMPLE = { 'gain.db': '6', 'crush.bits': '4', 'fade.len': '100ms', 'reverb.tail': '250ms' };
export const AC_DETAIL = {};

// The names a score can use: its own defs and everything its imports
// bring in. A scan, not a parse — it runs on keystrokes — reading each
// top-level (def …) head for the name and what kind of thing it is, and
// the comment line just above it for the description (a preset set says
// what each voice is there: "GM 1 / MIDI 0: * GrandPiano"). Given
// `imports`, the same pass collects the (import "…") paths written — so
// an edit in progress (unbalanced parens) does not hide them.
const AC_DEF_RE = /^[ \t]*\((def-val|def-fm|def-pcm|def-wave|def)[ \t]+(\()?([^\s()]+)[ \t]*([^\s()]*)(\()?/;
export function scanDefNames(text, from, imports = null) {
  const out = [];
  let comment = '';
  for (const line of text.split('\n')) {
    const m = AC_DEF_RE.exec(line);
    if (m) {
      const [, head, fnParen, name, next, listAfter] = m;
      let kind;
      if (head === 'def-val') kind = 'val';
      else if (head === 'def-fm') kind = 'voice';
      else if (head === 'def-pcm') kind = 'sample';
      else if (head === 'def-wave') kind = 'wave';
      else if (fnParen) kind = 'fn';
      else if (next === '' && listAfter) kind = /^\s*\(def[ \t]+\S+[ \t]+\(macro\b/.test(line) ? 'macro' : 'def';
      else kind = 'def';
      // A kit names its samples after roles; the file says which sound.
      const file = kind === 'sample' && /:file\s+"(?:[^"]*\/)?([^"/]+?)(?:\.\w+)?"/.exec(line);
      const about = comment || (file ? file[1] : '');
      out.push({ name, kind, about, from });
      comment = '';
      continue;
    }
    const imp = imports && /^\s*\(import\s+"([^"]+)"/.exec(line);
    if (imp) imports.add(imp[1]);
    const c = /^\s*;+\s?(.*)$/.exec(line);
    comment = c ? c[1].replace(/\*\s*/, '') : '';
  }
  return out;
}

const AC_DEF_TYPE = { voice: 'type', sample: 'constant', macro: 'function', fn: 'function', val: 'variable', def: 'variable' };
export function defCompletion(d, label = d.name) {
  const detail = d.kind + (d.from ? ` \u00b7 ${d.from}` : '');
  return { label, type: AC_DEF_TYPE[d.kind], detail, info: d.about || undefined, boost: d.from && !d.builtin ? 0 : 1 };
}

// What kind of name the track at `pos` takes, by its channel's part
// (targets/: the score's machine's, else the first that has the name): an
// FM channel plays voices, a sample channel samples, a PSG channel
// macros — an envelope is the voice it does not have. Outside a track — a
// def, the top level — everything.
export const AC_TRACK_SET = new Set(AC_TRACKS);
export const TRACK_KIND_OF_PART = { fm: 'voice', sample: 'sample', tone: 'psg', noise: 'psg', wave: 'wave', midi: 'midi' };

// Substring on the name and on its description, so `piano` finds gm-piano
// and `ride` every kit's ride. Prefix matches first, then the rest of the
// names, then descriptions; within each, the order above. A mucom score's
// `@12` is found by `@12` as typed (`@` is also the trigger) and by `12`.
export function matchNames(names, typed) {
  const q = typed.toLowerCase();
  const ranked = [];
  for (const d of names) {
    const name = d.name.toLowerCase();
    let rank;
    if (name.startsWith(q) || name.startsWith('@' + q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (d.about.toLowerCase().includes(q)) rank = 2;
    else continue;
    ranked.push([rank, d]);
  }
  return ranked.sort((a, b) => a[0] - b[0]).map(([, d]) => d);
}

export function nameCompletion(d) {
  const c = defCompletion(d);
  c.pick = d; // what ↑ / ↓ auditions
  if (d.importSet) {
    c.detail += ' \u00b7 + import';
    c.apply = (view, completion, from, to) => applyWithImport(view, completion, from, to, d.importSet);
  }
  return c;
}

// A name from a set the score does not import yet brings the set's
// (import …) to the top with it, in one transaction — one undo takes both.
function applyWithImport(view, completion, from, to, path) {
  const line = `(import "${path}")`;
  const add = view.state.doc.toString().includes(line) ? '' : line + '\n';
  view.dispatch({
    changes: [...(add ? [{ from: 0, insert: add }] : []), { from, to, insert: completion.label }],
    selection: { anchor: from + add.length + completion.label.length },
    annotations: pickedCompletion.of(completion),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
}

// A word that reads as a note, a rest or a v± / o± shift never opens the
// list on its own: `a-`, `e8.`, `v-2` are music, not a name being typed.
export const AC_MUSIC_WORD = /^([a-gr][+-]?[\d.]*|[vo][+-]\d*)$/;

// `noise` is two words of the language: the PSG channel at the head of a
// track, and a random curve where a value goes. reference.js keeps an
// entry for each and picks by `ctx`, so the hover and the completion say
// which one the text has at hand. A curve is the value of a keyword
// (`:pitch (noise …)`), or an operand of an eval head (`(+ root (noise
// …))`, `(macro …)`), or names its own ends — which a track form never
// does, so that is what tells the two apart under a `def`, which holds
// either. A form head anywhere else is the channel.
//
// The ends must be the form's OWN: a track's inline sweep puts a range in
// a nested form (`(noise :vol (linear 15..0 :len 8) c)`), so only the
// direct children count, and they are read across lines.
function curveNamesItsEnds(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; continue; }
    if (ch === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { if (--depth === 0) return false; continue; }
    if (depth !== 1 || /\s/.test(ch)) continue;
    const token = /^[^\s()[\]";]*/.exec(text.slice(i))[0];
    i += token.length - 1;
    if (token === ':from' || token === ':to' || /^-?[\d.]+\.\.-?[\d.]+$/.test(token)) return true;
  }
  return false;
}
export function referenceCtxAt(state, wordFrom) {
  let before = state.sliceDoc(0, wordFrom);
  if (before.endsWith('(')) before = before.slice(0, -1); // the word's own '(' encloses nothing
  const open = [];
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === '"') { for (i++; i < before.length && before[i] !== '"'; i++) if (before[i] === '\\') i++; }
    else if (ch === ';') { while (i < before.length && before[i] !== '\n') i++; }
    else if (ch === '(' || ch === '[') open.push(i);
    else if (ch === ')' || ch === ']') open.pop();
  }
  if (open.length === 0) return 'track';                      // the top level: a track form
  if (/:[a-zA-Z0-9#_-]+\s*$/.test(before)) return 'value';    // right after a keyword
  const at = open[open.length - 1];
  if (before[at] === '[') return 'value';                     // inside a step vector
  const head = /^[^\s()[\]";]*/.exec(before.slice(at + 1, at + 32))[0];
  if (isReservedHead(head) || head === 'macro' || head === 'wait') return 'value';
  // Under a `def`, which holds a track form or a curve: its own ends say.
  return curveNamesItsEnds(state.sliceDoc(0, state.doc.length), wordFrom - 1) ? 'value' : 'track';
}

// Hover: a keyword (`:vel`, `:tl1+`) anywhere, a form head or a channel
// name right after `(`. Only the words the completion offers — a def's
// own name, a note or a number is not the reference's to explain.
// On a touch screen a tap is the hover and nothing ever leaves it, so the
// card also goes on a tap on it, on typing, and when the cursor moves.
export const AC_WORDS = new Set([...AC_FORMS, ...AC_TRACKS, ...AC_PARAMS]);

export const closeReferenceOnMove = EditorView.updateListener.of((u) => {
  if (!u.selectionSet || u.docChanged || !hasHoverTooltips(u.state)) return;
  queueMicrotask(() => u.view.dispatch({ effects: closeHoverTooltips })); // not inside this update
});
