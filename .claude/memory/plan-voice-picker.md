# Voice picker in the editor — decided 2026-10-03, not yet implemented

The problem: in the live editor a voice or sample can only be written by
someone who already knows its name. The existing completion
(`mmlispCompletions` / `scoreDefNames` in `live/index.html`) is prefix-only,
lists only the score's defs and already-imported sets, and only opens after
two typed characters — nothing offers a list at an empty spot, and touch has
no Ctrl+Space.

## Decisions

- **Not a modal panel — the existing completion, strengthened.** The list
  drops down under the cursor and never takes typing: characters go into the
  document and narrow the list; Space, `(` and the like close it and are
  typed. Only ↑↓ / Enter / Esc belong to it, as now. This is what makes the
  `@` trigger safe (below).
- **Matching:** substring on the name **and** its description (the comment
  above the def, e.g. "GrandPiano"), so `piano` finds `gm-piano` and `ride`
  finds every kit's ride.
- **Scope: every preset set, imported or not**, plus the score's own defs.
  Picking a name from a set the score does not import adds that set's
  `(import …)` at the top, as Browse's Insert already does. The user chose
  "all sets" after asking about speed: 10 sets / 374 names / ~100 KB today;
  a substring filter over 5,000 names costs ~0.5 ms a keystroke; the list
  renders at most 12 rows. Share Browse's set cache; never pre-load WAVs (a
  sample's audio loads only when it is auditioned). Listing a set does not
  import it, so compile time is untouched.
- **Kind follows the track at the cursor:** inside an `fm…` track only FM
  voices, inside a `pcm…` track only samples.
- **Audition on highlight:** moving the selection with ↑↓ plays the
  highlighted entry after a short debounce (Browse's `previewBrowseDef`). Not
  on Space — Space must stay a typed space.
- **Two new ways to open it:**
  1. **Typing `@`** where no name is being written opens the full list;
     what follows filters it, and Enter replaces the `@` with the name. `@`
     is the importer's voice prefix for mucom scores (`@1`, `@brass` — a bare
     number would read as a length), so those names stay in the list: typing
     `@12 c` by hand narrows to `@12`, and the space closes the list and
     types normally. `@` is an editor trigger only, not language notation.
  2. **Long-pressing a written voice/sample name** opens the same list at
     that name; picking replaces the token. It rides the value popup's shared
     classifier (`classifyToken`, docs/guide.md §22) so long-press means "edit
     this" for every kind of token.

## Open

- **PSG.** PSG has no voice def, but an envelope is a macro def
  (`(def env1 (macro :vel […]))`), which the scan already tags `macro`.
  Offering macro defs on `sqr…` / `noise` tracks — and a preset set of PSG
  envelopes — would make this work for PSG too; but macros are not PSG-only,
  so which ones to show is undecided. Out of scope for the first cut.
