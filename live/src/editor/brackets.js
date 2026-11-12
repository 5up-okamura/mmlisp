// The bracket structure under the cursor: the scan, the enclosing form's
// highlight and the unmatched marks, the brackets left open, a cursor added
// above or below.

import { StateField, layer, RectangleMarker, EditorSelection } from "../../vendor/codemirror.js";

// -----------------------------------------------------------------------
// Bracket structure: enclosing-form highlight + unmatched-bracket marks
// -----------------------------------------------------------------------

// One pass over the document, skipping strings and `;` comments, feeding
// both the enclosing-form highlight and the unmatched-bracket marks.
// Returns { pairs, bad }: `pairs` are matched brackets ({from, to} are the
// two bracket offsets), `bad` are offsets of unclosed openers and stray or
// mismatched closers. A mismatched closer does not pop the stack — that
// matches the parser, which reports the still-open bracket as unclosed.
// It runs on every keystroke, over the whole score: char codes, not
// one-character strings.
function scanBrackets(src) {
  const pairs = [];
  const bad = [];
  const stack = [];
  const QUOTE = 34, BACKSLASH = 92, SEMI = 59, NL = 10;
  const OPEN_P = 40, CLOSE_P = 41, OPEN_B = 91, CLOSE_B = 93;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    if (ch === QUOTE) {
      i++;
      while (i < src.length && src.charCodeAt(i) !== QUOTE) { if (src.charCodeAt(i) === BACKSLASH) i++; i++; }
      continue; // the loop's i++ steps past the closing quote
    }
    if (ch === SEMI) {
      while (i < src.length && src.charCodeAt(i) !== NL) i++;
      continue;
    }
    if (ch === OPEN_P || ch === OPEN_B) { stack.push(i); continue; }
    if (ch === CLOSE_P || ch === CLOSE_B) {
      const open = stack.length ? stack[stack.length - 1] : -1;
      if (open >= 0 && src.charCodeAt(open) === (ch === CLOSE_P ? OPEN_P : OPEN_B)) {
        stack.pop();
        pairs.push({ from: open, to: i });
      } else {
        bad.push(i);
      }
    }
  }
  for (const open of stack) bad.push(open);
  bad.sort((a, b) => a - b);
  return { pairs, bad };
}

// The pair to highlight for a cursor at `pos`: a bracket the cursor is
// directly touching from the outside wins (classic match-at-cursor), then
// the innermost pair containing it. Returns a member of `pairs`, so the
// state field can compare by identity.
function enclosingForm(pairs, pos) {
  let afterClose = null, beforeOpen = null, inner = null;
  for (const p of pairs) {
    if (p.to === pos - 1) afterClose = p;
    if (p.from === pos) beforeOpen = p;
    if (p.from < pos && pos <= p.to && (!inner || p.from > inner.from)) inner = p;
  }
  return afterClose || beforeOpen || inner;
}

function computeBrackets(state) {
  const { pairs, bad } = scanBrackets(state.doc.toString());
  return { pairs, bad, form: enclosingForm(pairs, state.selection.main.head) };
}

// Rescans only when the document changes; a bare cursor move re-picks the
// form from the existing pairs. Playback dispatches playhead effects at
// event rate, and those transactions touch neither, so they cost nothing.
export const bracketField = StateField.define({
  create: (state) => computeBrackets(state),
  update(v, tr) {
    if (tr.docChanged) return computeBrackets(tr.state);
    if (!tr.selection) return v;
    const form = enclosingForm(v.pairs, tr.state.selection.main.head);
    return form === v.form ? v : { ...v, form };
  },
});

// Drawn as a layer of rectangles for the same reason as the playhead: mark
// decorations split the text into inline boxes, which under lineWrapping
// can move the soft-wrap point as the highlight comes and goes.
export const bracketLayer = layer({
  above: false, // behind the glyphs — this is a fill, not an outline
  class: 'cm-bracketLayer',
  update: (update) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.startState.field(bracketField) !== update.state.field(bracketField),
  markers: (view) => {
    const state = view.state;
    const doc = state.doc;
    const v = state.field(bracketField);
    const markers = [];
    const add = (from, to, cls) => {
      if (from >= to) return;
      try {
        for (const m of RectangleMarker.forRange(view, cls, EditorSelection.range(from, to))) {
          markers.push(m);
        }
      } catch (_) {}
    };
    if (v.form) {
      const { from, to } = v.form;
      // Fill the span only for a form that lives on one document line —
      // where the pair alone reads poorly because the line may soft-wrap.
      // Filling a whole track or `def` block would dominate the editor, so
      // those get the bracket marks only.
      if (doc.lineAt(from).number === doc.lineAt(to).number) {
        add(from, to + 1, 'cm-bracketForm');
      }
      add(from, from + 1, 'cm-bracketMatch');
      add(to, to + 1, 'cm-bracketMatch');
    }
    for (const pos of v.bad) add(pos, pos + 1, 'cm-bracketBad');
    return markers;
  },
});

// Insert the closers for every form still open at the cursor, innermost
// first. Only brackets the scan reports as unclosed are closed, so this
// never touches a form that is already complete further down the file.
export function closeOpenBrackets(view) {
  const state = view.state;
  const pos = state.selection.main.head;
  const opens = state.field(bracketField).bad
    .filter(p => p < pos && /[([]/.test(state.doc.sliceString(p, p + 1)));
  if (!opens.length) return false;
  const insert = opens.reverse()
    .map(p => state.doc.sliceString(p, p + 1) === '(' ? ')' : ']')
    .join('');
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  return true;
}

// Put a cursor at an arbitrary offset, following CodeMirror's own rule for
// a modifier-click: landing on an existing cursor or selection removes it
// (unless it is the last one), so overshooting is undone by clicking again.
export function addCursorAt(view, pos) {
  const ranges = view.state.selection.ranges;
  const hit = ranges.findIndex(r => r.from <= pos && r.to >= pos);
  if (hit >= 0 && ranges.length === 1) return;
  const next = hit >= 0
    ? EditorSelection.create(ranges.filter((_, i) => i !== hit), 0)
    : EditorSelection.create([...ranges, EditorSelection.cursor(pos)], ranges.length);
  view.dispatch({ selection: next, userEvent: 'select' });
}

// Add a cursor one line above / below the outermost existing one, the way
// VS Code's Cmd/Ctrl+Alt+Arrow does. moveVertically works in visual lines,
// so on this wrapped editor the new cursor lands where ArrowUp/Down would
// put the caret, and its goal column survives a short line in between.
export function addCursorVertically(view, forward) {
  const ranges = view.state.selection.ranges;
  const edge = ranges.reduce((a, b) => ((b.head > a.head) === forward ? b : a));
  const moved = view.moveVertically(edge, forward);
  if (moved.head === edge.head) return true;  // already at the first/last line
  const added = moved.empty ? moved : EditorSelection.cursor(moved.head);
  view.dispatch({
    selection: EditorSelection.create([...ranges, added], ranges.length),
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}
