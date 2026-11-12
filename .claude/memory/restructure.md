# The 2026-11 restructuring — plan and where it stands

In flight; delete this file when the last phase lands. The user's call
(2026-11-12): do all of it, behaviour unchanged — language, IR, driver and
the UI's look are out of scope.

Rules for every phase:

- A move and a split are separate commits. A move is `git mv` plus path
  rewrites only, proven by `check:snapshot` staying identical.
- Before each commit: `cd tools && npm run check:all` (every `check:*` and
  drv `verify:all`) and `cd live && npm run smoke` (the page boots, every
  inline handler resolves on `window`, one score per machine builds and
  plays). `check:paths` holds every literal path to a file.
- Basenames stay (`import/import-vgm.js`, not `import/vgm.js`): the docs,
  the memory and the commit history name files by them, and `midi.js`
  would be three files.
- `live/src` stays the toolchain's home: the deploy serves `live/`, and
  moving the library out of it would need the server to serve the repo.

## Phases

0. **Safety net** — `check:all`, `check:paths`, `live npm run smoke`.
1. **live/src into directories by layer** — lang, machine (targets.js,
   targets/, chips/), synth, player, driver, audio, import, export, port,
   midi, editor, app. By a script: specifiers inside live/src resolved
   against the old layout, `src/<old>` spelled anywhere else rewritten.
   By hand: tools/mcp's `load("x.js")`, check-mmlisp-strict's and
   emit-images' `path.join`, check-font-sizes' scan (top level only — it
   would check nothing). CLAUDE.md's table becomes one row a directory.
2. **Layering** — `encodeWav` out of export-wav.js (five importers take it)
   beside wav-decode; `RHYTHM_KIT` / `RHYTHM_SOUNDS` / `ringGate` out of
   import-mucom.js, `PORT_TARGETS` out of score-port.js, `nesChips` /
   `decodeOki` out of import-vgm.js, the GB `Apu` import-vgm takes from
   synth-gb.js; ir-utils.js (58 exports, 36 importers) by subject.
3. **Big files at their seams** — mmlisp2ir.js (7.5k lines, 174
   functions, no section banners) into `lang/compile/`; import-vgm.js by
   chip reader. drv-player.js only toward the shape of drv/68k (it is the
   C sequencer's twin).
4. **index.html** (16k lines, one module script of ~15k, 466 top-level
   declarations, 127 inline handlers + run-time-written ones — see the
   auto-memory note on the page's structure for the six run-time onclicks)
   — first every handler to `addEventListener`, no `window.X`; then the
   loosely bound sections out (CodeMirror language support, theme,
   visualizers, Library, Guide, Share, AI bridge, Video, MIDI input); the
   bound core (Parameter UI, Audio, compile/file) last, its cut decided
   on what is left. Shared hubs (`player`, `editorView`, `log`) in one
   module; no event bus. The user checks each section in the app.
5. **tools/scripts and drv/tools into subdirectories** (check / gen / ab;
   gates / models / build); npm script names stay.

## Where it stands

- Phase 0: done (uncommitted at the time of writing).
