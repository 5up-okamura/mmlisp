# Plan: editor input aids (live CodeMirror)

Batches 1 and 2 **landed** 2026-07-31, batch 3 (find/replace + multiple
cursors) 2026-09-21 — all in `live/index.html`, `live/style.css`,
`docs/guide.md` §24, README. This file now only tracks what is left.

## Landed

- `closeBrackets()` + `closeBracketsKeymap`, with `languageData.closeBrackets
  = { brackets: ['(', '[', '"'] }` on `mmlispMode` so the defaults `{` and `'`
  (an ordinary atom char here) are not auto-closed.
- `scanBrackets` / `enclosingForm` / `bracketField` / `bracketLayer` — one
  string+comment-skipping pass feeds the enclosing-form highlight, the
  unmatched-bracket underlines and the badge. Rescans only on doc change; a
  bare cursor move re-picks the form from the cached pairs, so playback's
  event-rate playhead transactions cost nothing.
- `#bracketStatus` badge (top-right of the editor, click = jump to the first
  unmatched bracket).

Deviations from the original plan worth remembering:

- **No `@codemirror/lint`.** The marks are drawn in the same `layer` as the
  rest, which avoids a new CDN module *and* mark decorations — a span around a
  bracket creates a new line-break opportunity, which is exactly the wrap
  instability the playhead layer exists to avoid.
- **The form fill is single-line only.** Filling a whole track or `def` block
  dominates the editor, so a multi-line form shows only its two brackets.
- `bracketMatching()` was not used at all (under `StreamLanguage` it falls
  back to a plain scan that does not skip strings/comments).

Verified headlessly (playwright-core + installed Chrome, `/live/`): auto-close,
type-over, empty-pair backspace, wrap-selection, no `'` auto-close, form
highlight single vs multi-line, unclosed opener + stray/mismatched closer,
badge text and jump, and coexistence with the playhead layer during playback.
Build, format and completion unaffected; no console errors.

Batch 2 (same day): `AC_SNIPPETS` template completions (`snippetCompletion`,
body-only templates since the parens already exist; curve heads generated from
one `A..B :len L` shape), `expandSelection` / `shrinkSelection` on
`Alt-ArrowUp` / `Alt-ArrowDown` (contents → form → next level out, with a
retrace stack), and `closeOpenBrackets` on `Mod-Alt-]` plus the menu item (now **Edit ▸ Close
Open Brackets**). Both selection commands return `true` even when there is
nothing to do — falling through to the browser's Alt-Up would move the cursor
and drop the selection. `Mod-Shift-]` was avoided: Chrome reserves it.

Batch 3 (2026-09-21): find / replace and multiple cursors — `@codemirror/search`
(`search({ literal: true })`, `searchKeymap`, `highlightSelectionMatches`),
`EditorState.allowMultipleSelections` + `drawSelection()`, an
`addCursorVertically` command on `Mod-Alt-Arrow`, `simplifySelection` on
`Escape` (after the panel's own Escape), and a new **Edit** menu. Decisions worth keeping:

- **Alt-click places a cursor even though Alt is the value scrub.** The
  `pointerdown` handler claims the Alt press over a value token but stays
  undecided: `pointerup` with no movement past `MOVE_CANCEL` calls
  `addCursorAt` instead of leaving a no-op scrub, so there is no spot in the
  document where a cursor cannot be placed. `clickAddsSelectionRange` is given
  `altKey || metaKey/ctrlKey` (both gestures), and `addCursorAt` copies
  CodeMirror's own rule — a click on an existing range removes it unless it is
  the last one. Still no `rectangularSelection()` / `crosshairCursor()`:
  Alt-*drag* over a value is the scrub.
- **Touch has no add-cursor gesture yet.** No modifier exists there, and
  long-press is already the value popup; a tap-to-add mode was left undesigned.
- **`languageData.wordChars`** now carries the punctuation an MMLisp atom can
  hold (`-+*/%^~!?<>=:@#$&|'.`), so a "word" is the whole token: double-click,
  `Mod-d` and the selection-match tint all take `:vel*`, not `vel`. Side effect
  accepted: `"` typed directly before such a character no longer auto-closes
  (closeBrackets skips quote-closing before a word char), and in a `;` comment
  a double-click grabs trailing punctuation.
- **Search matches are mark decorations** (CodeMirror's own), the one exception
  to the layer-only rule above — they exist only while the panel is open.
- The panel docks at the **bottom**: the top-right corner is the
  unmatched-bracket badge.
- **The Edit menu exists because of undo on touch.** The top bar measured
  217px of 390 before it, so a fourth menu was never a width problem (55px of
  slack even at 360px); what was missing was any UI at all for undo/redo
  without a keyboard. Edit = what changes the text (undo/redo, find/replace,
  the occurrence commands, toggle comment, close brackets, format); Tools =
  what is done with the score (build, snippets).

## Still open

- **Symbol bar for touch** — `(` `[` `:` are the painful keys on iPad, and the
  value-editing UI is already tap-first. The only batch-1/2 item not done.
- Possible follow-ups, not committed to: a token-level first step for
  `Alt-ArrowUp` (currently the first step is the enclosing form's contents),
  and snippets for `:param` completions.

## Standing decisions

- **Never auto-repair broken source.** Where a missing bracket belongs is a
  guess and in a music source a wrong guess silently changes what plays.
  Detection is automatic; insertion must be explicit.
- **No full paredit** (slurp/barf/splice/raise) — editing here is step-vector
  churn, not S-expression restructuring.
- **No rainbow parens** — breaks the "accent only on call heads and `:params`"
  rule in `mmlispHighlight`.
