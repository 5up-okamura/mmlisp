# The live app — why it is shaped this way, and what is open

What the editor, the Library panel, the voice picker and the song importers DO
is `docs/guide.md` (§22 completions, §23 importers, §24 editing aids, §25 the
Library). This file keeps only the reasons the guide does not carry, the
user's rulings, measurements, and open items. Merged 2026-10-09 from
`plan-editor-input-aids`, `plan-library-panel`, `plan-voice-picker` and
`plan-importers`.

## Editing aids (`live/index.html`, `live/style.css`)

- **No `@codemirror/lint`, no `bracketMatching()`.** Bracket marks are drawn
  in a `layer`, like the playhead: a mark decoration around a bracket adds a
  line-break opportunity — the wrap instability the playhead layer exists to
  avoid. `bracketMatching()` under `StreamLanguage` falls back to a scan that
  does not skip strings and comments. The one exception to the layer-only
  rule is search matches (CodeMirror's own marks, only while the panel is
  open).
- **Shortcuts Chrome steals:** `Mod-Shift-]` is reserved, hence `Mod-Alt-]`
  for Close Open Brackets. `Alt-ArrowUp/Down` return `true` even with nothing
  to do, or the browser moves the cursor and drops the selection.
- **No `rectangularSelection()` / `crosshairCursor()`**: Alt-*drag* is the
  value scrub. An Alt press over a value stays undecided until `pointerup`,
  and no movement means add-cursor, so no spot refuses a cursor.
- **`wordChars` carries an atom's punctuation** (`-+*/%^~!?<>=:@#$&|'.`), so
  double-click, `Mod-d` and the match tint take `:vel*`, not `vel`. Accepted
  side effects: `"` typed right before such a character does not auto-close,
  and a double-click in a comment grabs trailing punctuation.
- The search panel docks at the bottom because the top-right is the
  unmatched-bracket badge.
- **The Edit menu exists because of undo on touch**, not width (the top bar
  had 55px to spare even at 360px). Edit = what changes the text; Tools =
  what is done with the score.
- **On-screen keyboard** (`watchSoftKeyboard`, `html.soft-kb`), measured on
  the user's iPad (iPadOS 17.6.1, landscape, home-screen app): opening fires a
  `visualViewport` resize; **closing fires nothing**, keeps the editor focused
  and leaves `visualViewport` stale; `innerHeight` dips while the keyboard is
  up by however far iOS scrolled the page (8–168px seen) and returns on close
  — the only close sign, so it is polled while up. iOS can leave `scrollY`
  non-zero after close: drawn in place, hit-tested off-target, so it is reset
  whenever the keyboard is down. The iPhone reports both open and close.
  Piano visibility above the keyboard depends on the right panel's scroll —
  accepted.

## Library panel and voice picker

- **Two tabs, not three**: one search finds the keyword, the presets and the
  snippets for a word; a source switch narrows it. **One list component** for
  every source, so Browse's two-column layout, its phone back button and the
  modal went.
- **Phones keep the full-screen panel** — the play keyboard leaves no room for
  a half-height sheet.
- **The keys never play a macro** (user: not now, not later): they write a
  key-on and run no macro engine; a macro's ▶ (a one-note sqr1 score) is
  enough.
- **An audition owes the score nothing** (user: "it should always sound"):
  it bakes for one voice whatever the score states, and an error elsewhere in
  the score does not stop it.
- ⌘⇧K was dropped (CodeMirror's delete-line, Firefox's web console). Tools >
  Snippets went (user: "the most half-done thing").
- **Nothing is saved across launches** — state that outlived quitting
  confused the user.
- **The reference is hand-written data, not scraped from language.md**, a JS
  module both the page and node import. The completion's word lists are NOT
  generated from it (they hold sub-params no entry is written for);
  `check:reference` fails when the completion offers a word no entry covers.
- **The picker is the completion list, not a modal.** It never takes typing,
  which is what makes the `@` trigger safe next to mucom's `@1` voice names.
- **Every preset set, imported or not** — the user chose this after asking
  about speed: 10 sets / 374 names / ~100 KB; a substring filter over 5,000
  names costs ~0.5 ms a keystroke.
- **Long-press rides `classifyToken`**, so long-press means "edit this" for
  every kind of token.
- **Import is judged by the written `(import …)` lines**, not
  `_importSources`, which is only re-read on Build and so holds the previous
  score's sets.

## Song importers (`live/src/import-*.js`)

- **"The more structured, the easier to grasp"** (user, 2026-10-07):
  repeats fold into `(x …)`, reused runs into defs; exact matches only.
- **Vibrato and fine tune are rounded so notes share defs** — a function beats
  a faithful per-frame array.
- **MIDI CC1 starts 12 frames into the note** because the user found an
  undelayed one wobbling throughout.
- **A dialog whose defaults are right**: Enter alone imports; only what a user
  changes per file is offered.
- **VGM export writes PCM as one data block + `0x8n`**, not DAC stream
  control, because the engine mixes voices in software.

## Lessons

- **Check a commit's Vercel status before asking for a device test**
  (`api.github.com/repos/5up-okamura/mmlisp/commits/<sha>/status`) — a run of
  failed deploys once meant four fixes never reached the device.
- **Suspect the instrument first.** An on-screen probe that rewrote itself
  every 300ms made the iPad lay the app out at portrait size in landscape; it
  was blamed on the offline change and the vendored font first. Prefer a
  probe that writes only on demand.

## Standing decisions — do not re-propose

- **Touch symbol bar**: removed at the user's request (unstable on their
  iPad). Not without a way to test on that device.
- **No full paredit** — editing here is step-vector churn, not S-expression
  restructuring.
- **No rainbow parens** — breaks the "accent only on call heads and
  `:params`" rule in `mmlispHighlight`.

## Open

- **Library ▶ and the completion list's ↑ / ↓ still refuse a sample while the
  song plays** (their preview reloads the PCM bank). The keys play one on the
  side player during playback (`playAuditionBlob`); routing these two through
  it too is open.
- A score's own `def-pcm` is not auditioned from the picker: its `:file` is
  relative to the score's folder, which the stand-in score lacks.
- Touch has no add-cursor gesture (no modifier; long-press is the value
  popup).
- **VGM**: tempo changes within a song (one grid for the whole file); second
  chips; other chips' PCM (SegaPCM, YM2610 ADPCM, OKI). Dino Land's title
  theme estimates a 64th-note grid for the whole song.
- **Fewer shapes**, if wanted: VGM envelopes and bends match exactly (TwinBee
  gives ~26 envelopes); rounding near shapes together is the lever. A bass of
  per-note pitch falls names a bend per pitch.
- **Trackers**: sample channels, macros of pre-INS2 Furnace instruments,
  subsongs after the first; Furnace's slide/porta compat rules are rounded.
- **MIDI**: per-note pan/CC changes after the first.
- **Structured vs flat import**: structured writes a voice's TL at a block
  head, during the rest, where flat writes it at the note — same key-ons, a
  different release tail. Not judged audible.
