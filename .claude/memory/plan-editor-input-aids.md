# Editor input aids (live CodeMirror) — the decisions behind them

All landed (2026-07-31 brackets/snippets/selection, 2026-09-21 find/replace and
multiple cursors, 2026-10-03 the touch symbol bar). What they do is
`docs/guide.md` §24; the code is `live/index.html` and `live/style.css`. This
file keeps only why they have this shape, and what is not built.

## Why it is shaped this way

- **No `@codemirror/lint`, no `bracketMatching()`.** Bracket marks are drawn in
  a `layer`, like the playhead: a mark decoration around a bracket adds a
  line-break opportunity, which is the wrap instability the playhead layer
  exists to avoid. `bracketMatching()` under `StreamLanguage` falls back to a
  scan that does not skip strings and comments. The one exception to the
  layer-only rule is search matches (CodeMirror's own marks, only while the
  panel is open).
- **The form fill is single-line only** — filling a whole track or `def`
  dominates the editor.
- **Shortcuts Chrome steals:** `Mod-Shift-]` is reserved, hence
  `Mod-Alt-]` for Close Open Brackets. `Alt-ArrowUp/Down` return `true` even
  with nothing to do, or the browser moves the cursor and drops the selection.
- **Alt-click places a cursor although Alt is the value scrub**: an Alt press
  over a value stays undecided until `pointerup`, and no movement means
  add-cursor — so no spot in the document refuses a cursor. Hence no
  `rectangularSelection()` / `crosshairCursor()`: Alt-*drag* is the scrub.
- **`wordChars` carries an atom's punctuation** (`-+*/%^~!?<>=:@#$&|'.`), so
  double-click, `Mod-d` and the match tint take `:vel*`, not `vel`. Accepted
  side effects: `"` typed right before such a character does not auto-close,
  and a double-click in a comment grabs trailing punctuation.
- The search panel docks at the **bottom**: the top-right is the
  unmatched-bracket badge.
- **The Edit menu exists because of undo on touch**, not width (the top bar
  had 55px to spare even at 360px). Edit = what changes the text; Tools = what
  is done with the score.
- **Touch symbol bar**: placed from `visualViewport`, so it shows only while a
  soft keyboard is up (never with a hardware one). Key order is measured
  frequency in the shipped scores, `( ) : @` first. A tap acts on an un-moved
  `touchend`, cancelled so the editor keeps focus — `touchstart` must stay
  passive or the row cannot scroll. iOS Smart Punctuation is undone on input.
  **Not yet tried on a real device.**

## Standing decisions

- **Never auto-repair broken source.** Where a missing bracket belongs is a
  guess, and in a music source a wrong guess silently changes what plays.
  Detection is automatic; insertion is explicit.
- **No full paredit** (slurp/barf/splice/raise) — editing here is step-vector
  churn, not S-expression restructuring.
- **No rainbow parens** — breaks the "accent only on call heads and `:params`"
  rule in `mmlispHighlight`.

## Not built

- Touch has no add-cursor gesture: no modifier exists, and long-press is the
  value popup. A tap-to-add mode was left undesigned.
- Possible, not committed to: a token-level first step for `Alt-ArrowUp`
  (today it starts at the enclosing form's contents), snippets for `:param`
  completions.
