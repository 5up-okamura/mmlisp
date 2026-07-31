# Plan: editor input aids (live CodeMirror)

Batches 1 and 2 **landed** 2026-07-31 (`live/index.html`, `live/style.css`,
`docs/guide.md` §24, README). This file now only tracks what is left.

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
retrace stack), and `closeOpenBrackets` on `Mod-Alt-]` plus **Tools ▸ Close
Open Brackets**. Both selection commands return `true` even when there is
nothing to do — falling through to the browser's Alt-Up would move the cursor
and drop the selection. `Mod-Shift-]` was avoided: Chrome reserves it.

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
