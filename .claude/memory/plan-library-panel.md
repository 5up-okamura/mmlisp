# Library panel (Browse + reference in the side panel) — phase 1 built 2026-10-08

Phase 1 is built (guide §25 has the behaviour; the list is
`live/src/catalog-list.js`). Phases 2 and 3 are not. This file keeps the
user's decisions and the order of work.

## Decisions (2026-10-08)

- **The side panel gets two tabs: Params | Library.** The gear stays the one
  top-bar button (the menu bar never collapses on a phone, so no new buttons
  there). Library is Browse and a new reference in one list, narrowed by a
  source switch (All / Ref / Presets / Snippets / Scores; the last one is
  remembered). The user preferred this to three tabs (Params | Browse | Ref):
  one search finds the keyword, the presets and the snippets for a word.
- **One list component for every source**: collapsible group headers in one
  column (Browse's two-column set → defs layout and its phone back button go),
  a search box (substring on name + description, as the completion does),
  filters (source; kind: FM / PSG / PCM / macro / keyword / form …; "fits the
  track at the cursor"), Group / A–Z order (A–Z while searching), a detail
  area under the list, and Browse's keys (↑↓, Space auditions, Enter acts).
  Each row: name, kind, one-line description, ▶, Insert; a group header can
  carry an action (Import set).
- **The Browse modal is removed**; File > Browse… opens the panel on Library.
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
- **The reference is English only**, written as structured data (e.g.
  `docs/reference.json`), not scraped from language.md, with a check that
  compiles every example (like check:cheatsheet).

## Order of work (agreed)

1. **Built.** Panel tabs; Browse moves into Library with search and filters.
   The shortcut is ⌘K / Ctrl+K (user, 2026-10-08).
2. The reference data, its check, and the Ref source.
3. The same data feeds completion info, a hover tooltip and the MCP server;
   AC_PARAMS / AC_FORMS come from it so the two cannot drift.
