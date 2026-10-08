# Library panel — built 2026-10-08

The side panel's Params | Library tabs, the language reference (Ref) and its
uses are built; guide §24–§25 have the behaviour, `live/src/catalog-list.js`
the list, `live/src/reference.js` the entries, `live/src/completion-names.js`
the completion's words. This file keeps only the user's decisions with their
reasons, and what is open.

## Decisions and why

- **Two tabs, Params | Library — not three (Params | Browse | Ref).** One
  search finds the keyword, the presets and the snippets for a word; a source
  switch narrows it. The gear stays the one top-bar button, because the menu
  bar never collapses on a phone.
- **One list component for every source**, grouped and folded, so Browse's
  two-column layout and its phone back button went; the modal went with it.
- **Phones keep the full-screen panel**: the play keyboard leaves no room for
  a half-height sheet. Insert hands the focus to the editor (the flow is
  search → Enter → keep writing); a phone also closes the panel.
- **The keys play Library's highlighted voice or sample, never a macro**
  (user: not now, not later): the keys write a key-on and run no macro engine,
  and a macro's ▶ (a one-note sqr1 score) is enough.
- **An audition owes the score nothing** (user: "it should always sound"): it
  bakes for one voice whatever the score states, and an error elsewhere in
  the score does not stop it.
- **Menus**: Tools > Params (⌘J, toggles) beside Tools > Library (⌘K).
  ⌘⇧K was dropped — CodeMirror's delete-line and Firefox's web console.
  Tools > Snippets went (user: "the most half-done thing"); the FM voice
  template is the snippet `voices/fm-voice-template`.
- **Nothing is saved across launches** — the tab, the source, the filters —
  because state that outlives quitting the app confused the user; while it
  runs, the gear reopens the panel as it was left.
- **The reference is English, hand-written data, not scraped from
  language.md**, a JS module (the page imports it, so the offline cache finds
  it; node — the check, the MCP server — imports the same file). The
  completion's word lists are NOT generated from it (they hold sub-params like
  `:threshold` no entry is written for); `check:reference` instead fails when
  the completion offers a word no entry covers.

## Open

- **A sample does not sound while the song plays** (keys or ▶): an audition
  loads its own bank into the worklet's one PCM engine, which would break the
  song's PCM, so it refuses ("Stop playback first"). The fix discussed is a
  small audition-only sample player in the worklet, apart from the engine
  (not the driver's sound, but enough to try a sample). Deferred by the user,
  2026-10-08.
