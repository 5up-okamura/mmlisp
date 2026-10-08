# Library panel (Browse + reference in the side panel) — built 2026-10-08

All three phases are built (guide §25 and §24 have the behaviour; the list is
`live/src/catalog-list.js`, the reference `live/src/reference.js`, the
completion's words `live/src/completion-names.js`). This file keeps the
user's decisions and their reasons; nothing is open.

## Decisions (2026-10-08)

- **The side panel gets two tabs: Params | Library.** The gear stays the one
  top-bar button (the menu bar never collapses on a phone, so no new buttons
  there). Library is Browse and a new reference in one list, narrowed by a
  source switch (All / Ref / Presets / Snippets / Scores). The user preferred this to three tabs (Params | Browse | Ref):
  one search finds the keyword, the presets and the snippets for a word.
- **One list component for every source**: collapsible group headers in one
  column (Browse's two-column set → defs layout and its phone back button go),
  a search box (substring on name + description, as the completion does),
  filters (source; kind: FM / PSG / PCM / macro / keyword / form …; "fits the
  track at the cursor"), Group / A–Z order (A–Z while searching), a detail
  area under the list, and Browse's keys (↑↓, Space auditions, Enter acts).
  Each row: name, kind, one-line description, ▶, Insert; a group header can
  carry an action (Import set).
- **The Browse modal is removed**. The panel's tabs are menu entries side by
  side: Tools > Params (⌘J — toggles: closes the panel when Params shows) and
  Tools > Library (⌘K). ⌘⇧K was the user's first idea and was dropped: it is
  CodeMirror's delete-line and Firefox's web console.
  Tools > Snippets went too (2026-10-08, the user: "the most half-done
  thing"): Library's Snippets source replaces Browse Snippets…, and the FM
  voice template is the snippet `voices/fm-voice-template`.
- **The tab and Library's filters are not saved across launches** (user,
  2026-10-08): the gear reopens the panel as it was left, but a state that
  outlives quitting the app is confusing — a launch starts on Params, All.
- **Phones keep the full-screen panel** — the play keyboard leaves no room for
  a half-height sheet. Insert on a phone closes the panel and shows the
  inserted text selected; on a desktop the panel stays open.
- **Insert moves the focus to the editor**, with the inserted text selected,
  on a desktop as on a phone — search, Enter, keep writing. A shortcut from
  the editor to Library's search box is to be picked with the implementation
  (avoiding the keys Chrome takes).
- **The play keyboard plays the highlighted preset** while Library is open:
  shown for an FM voice or a PCM sample, hidden for anything else. It does not
  play a macro, and never will (user, 2026-10-08): the keys write a key-on
  straight to the chip and run no macro engine, and a macro's ▶ audition
  (a one-note sqr1 score) is enough.
- **The reference is English only**, written as structured data, not scraped
  from language.md, with a check that compiles every example
  (`check:reference`). It is a JS module, `live/src/reference.js`, rather than
  a JSON under docs/: the page imports it (so the offline cache finds it by
  following imports), and node — the check, the MCP server — imports the same
  file.

## Order of work (agreed)

1. **Built.** Panel tabs; Browse moves into Library with search and filters.
   The shortcut is ⌘K / Ctrl+K (user, 2026-10-08).
2. **Built.** The reference data (72 entries, 13 categories), its check, and
   the Ref source.
3. **Built.** The same data feeds the completion's info, a hover card and the
   MCP server (`mmlisp_docs` doc `reference`). Changed from the plan with the
   user's OK: the completion's word lists are NOT generated from the
   reference — they hold sub-params (`:threshold`) no entry is written for —
   but moved to `completion-names.js` and held to it by `check:reference`
   (every word they offer must have an entry by name, alias or prefix).

## Open

- **A sample does not sound while the song plays** (keys or ▶): an audition
  loads its own bank into the worklet's one PCM engine, which would break the
  song's PCM, so it refuses ("Stop playback first"). The fix discussed is a
  small audition-only sample player in the worklet, apart from the engine
  (not the driver's sound, but enough to try a sample). Deferred by the user,
  2026-10-08 — the keys otherwise always sound now (one voice, score errors
  ignored).
