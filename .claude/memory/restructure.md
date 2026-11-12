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
2. **Layering** — done; what is left of it goes with phase 3: `nesChips`
   and `decodeOki` leave import-vgm.js with its chip readers and decoders.
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

- Phase 0: done (60580a3a). HEAD's `verify:all` was red on an unused
  `enc_b4` (-Werror); dropped in f9c880a7.
- Phase 1: done — the move script is the commit's own record (see its
  message); CLAUDE.md's map is one row a directory.
- Phase 2: done — ir-utils.js into ir/ (pitch, levels, curves, ranges,
  timing) and machine/chips/opn-regs.js; encodeWav → audio/wav-encode.js;
  mucom-pcm.js → audio/; the RX5 stand-in kit → import/rhythm-kit.js
  (score-port's copy of RHYTHM_KIT gone); PORT_TARGETS → machine/targets.js.
  `check:paths` also holds every named import to an export of its module
  (a page's miss fails only in the browser).
- Next: phase 3. mmlisp2ir.js has three top-level `let`s
  (`compileFrameHz`, `drawStreams`, `freshNameCounter`): their writers stay
  with them, or the state becomes an object.
- The splits were done by a scratch tool (acorn: each top-level declaration
  verbatim with its comments, its file's imports computed, every importer
  rewritten, a line-multiset check that nothing was lost or doubled); it is
  not in the repo — rewrite it from this description if a session needs it.
