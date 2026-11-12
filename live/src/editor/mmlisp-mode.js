// MMLisp in CodeMirror: its stream mode and highlight, indentation, the
// paren fold and its summary, the formatter's whitespace-only changes, the
// editor's theme.

import { StreamLanguage, HighlightStyle, tags, indentService, foldService, EditorView } from "../../vendor/codemirror.js";

// MMLisp StreamLanguage for syntax highlighting.
// Only two things get accent: the call name (first symbol after `(`) and
// `:params`. Everything else (notes, numbers, macro names, brackets,
// operators) stays the default foreground; comments are dimmed.
export const mmlispMode = StreamLanguage.define({
  // Auto-close only the brackets MMLisp actually has. The defaults would
  // also close `{` (unused) and `'` (an ordinary atom character here).
  // A "word" here is a whole MMLisp atom: the parser ends one only at
  // whitespace, a bracket, `;` or `"`, so the punctuation an atom can carry
  // (`:vel*`, `def-val`, `1/4`, `c4~`, `$slot`) counts as word characters.
  // Double-click, Cmd/Ctrl+D and the selection-match highlight then all take
  // the token you see rather than a fragment of it.
  languageData: {
    closeBrackets: { brackets: ['(', '[', '"'] },
    wordChars: "-+*/%^~!?<>=:@#$&|'.",
  },
  startState: () => ({ head: false }), // head: next identifier is in call position
  token(stream, state) {
    if (stream.eatSpace()) return null; // keep `head` across whitespace
    if (stream.peek() === ';') { stream.skipToEnd(); return 'comment'; }
    if (stream.peek() === '"') {
      stream.next();
      while (!stream.eol()) { if (stream.next() === '"') break; }
      state.head = false;
      return null;
    }
    if (stream.eat('(')) { state.head = true; return null; }
    if (stream.eat(')') || stream.eat('[') || stream.eat(']')) { state.head = false; return null; }
    // Arithmetic and comparison eval heads (+ - * / = < > <= >=) in call
    // position get the call accent, like an identifier head. Guarded by
    // `head` and a delimiter lookahead so an operand `+`/`-` (or a signed
    // number) and an octave `<`/`>` in the note stream are untouched.
    if (state.head && stream.match(/^(?:[+\-*/=]|[<>]=?)(?=[\s()]|$)/)) { state.head = false; return 'keyword'; }
    if (stream.eat(':')) {
      stream.match(/^[a-zA-Z][a-zA-Z0-9#_-]*/);
      state.head = false;
      return 'atom'; // :param → accent
    }
    if (stream.match(/^[+-]?\d+(?:\/\d+)?/)) { state.head = false; return null; }
    if (stream.match(/^[a-zA-Z][a-zA-Z0-9-]*/)) {
      const op = state.head;
      state.head = false;
      return op ? 'keyword' : null; // call name → accent ; operand → foreground
    }
    stream.next();
    state.head = false;
    return null;
  },
});

// Custom highlight: accent for call names / :params, sub for comments.
// Everything else falls through to the editor's default foreground.
export const mmlispHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--sub)' },
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: tags.atom, color: 'var(--accent)' },
]);

// MMLisp auto-indent service (Lisp-style: align to char after opening paren,
// or indent +2 if nothing follows the paren on that line)
export const mmlispIndent = indentService.of((context, pos) => {
  const doc = context.state.doc;
  const src = doc.sliceString(0, pos);

  // Scan src tracking unmatched opening parens, skipping strings/comments.
  const openStack = [];
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; } // escape
      else if (ch === '"') { inStr = false; }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === ';') {
      // skip to end of line
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '(') {
      openStack.push(i);
    } else if (ch === ')') {
      if (openStack.length > 0) openStack.pop();
    }
  }

  if (openStack.length === 0) return 0;
  const lastOpenPos = openStack[openStack.length - 1];

  const openLine = doc.lineAt(lastOpenPos);
  const openCol = lastOpenPos - openLine.from;

  // Always indent +2 from ( — matches the formatter's childIndent rule
  return openCol + 2;
});

export const mmlispParenFold = foldService.of((state, lineStart) => {
  const doc = state.doc;
  const line = doc.lineAt(lineStart);
  const text = line.text;
  const firstNonSpace = text.search(/\S/);
  if (firstNonSpace < 0) return null;

  const openPos = line.from + firstNonSpace;
  if (doc.sliceString(openPos, openPos + 1) !== '(') return null;

  let depth = 1;
  let inString = false;
  for (let pos = openPos + 1; pos < doc.length; pos++) {
    const ch = doc.sliceString(pos, pos + 1);

    if (inString) {
      if (ch === '\\') {
        pos++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === ';') {
      const commentLine = doc.lineAt(pos);
      pos = commentLine.to;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }

    if (ch === ')') {
      depth--;
      if (depth === 0) {
        const closeLine = doc.lineAt(pos);
        if (closeLine.number === line.number) return null;
        return { from: openPos + 1, to: pos };
      }
    }
  }

  return null;
});

export function summarizeFoldHead(state, range) {
  const openPos = Math.max(0, range.from - 1);
  const line = state.doc.lineAt(openPos);
  const raw = state.doc.sliceString(openPos, line.to);
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact.startsWith('(')) return '...';

  const headText = compact.slice(1).trimStart();
  if (!headText) return '...';

  // Keep folded labels short so they don't dominate the editor line.
  const maxLen = 36;
  const head = headText.length > maxLen ? headText.slice(0, maxLen - 1) + '…' : headText;
  return `${head} ...`;
}

// Split a string into tokens and the whitespace gaps around them, where each
// bracket char is its own token and other tokens are maximal non-whitespace,
// non-bracket runs: s === gaps[0] + words[0] + ... + words[n-1] + gaps[n].
// Treating brackets separately makes paren attach/detach (e.g. `] )` → `])`)
// a pure gap change rather than a token change.
function splitWordsAndGaps(s) {
  const words = [], gaps = [];
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  const isBracket = (c) => c === '(' || c === ')' || c === '[' || c === ']';
  let i = 0, gapStart = 0;
  while (i < s.length) {
    if (isWs(s[i])) { i++; continue; }
    gaps.push(s.slice(gapStart, i));
    if (isBracket(s[i])) { words.push(s[i]); i++; }
    else { let j = i; while (j < s.length && !isWs(s[j]) && !isBracket(s[j])) j++; words.push(s.slice(i, j)); i = j; }
    gapStart = i;
  }
  gaps.push(s.slice(gapStart));
  return { words, gaps };
}

// Formatting only rewrites whitespace (indentation, spacing, line breaks),
// leaving the non-whitespace tokens unchanged and in order. When that holds,
// produce minimal changes that touch only the differing gaps, so every token
// keeps its identity — playhead highlights and the cursor map through the
// format without a rebuild. Returns null if tokens changed (caller replaces
// the whole document instead).
export function whitespaceFormatChanges(oldStr, newStr) {
  const a = splitWordsAndGaps(oldStr), b = splitWordsAndGaps(newStr);
  if (a.words.length !== b.words.length) return null;
  for (let i = 0; i < a.words.length; i++) if (a.words[i] !== b.words[i]) return null;
  const changes = [];
  let pos = 0;
  for (let i = 0; i <= a.words.length; i++) {
    const oldGap = a.gaps[i], to = pos + oldGap.length;
    if (oldGap !== b.gaps[i]) changes.push({ from: pos, to, insert: b.gaps[i] });
    pos = to + (i < a.words.length ? a.words[i].length : 0);
  }
  return changes;
}

export const editorTheme = EditorView.theme({
  '&': { color: 'var(--foreground)', backgroundColor: 'var(--background)' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--foreground) var(--sel), var(--background))' },
  '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--sub)', border: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', color: 'var(--sub)', border: 'none' },
  // The hover card and the completion list, drawn as the panels are.
  '.cm-tooltip': { backgroundColor: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--mid)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]':
    { backgroundColor: 'color-mix(in srgb, var(--foreground) var(--sel), var(--background))', color: 'var(--foreground)' },
}, { dark: true });
