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
- A file is named for what it is (renames allowed); the directory
  prefixes stay (`import/import-vgm.js`, not `import/vgm.js`): dropping
  them makes four `midi.js`.
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
- Phase 3: done for the two planned files — mmlisp2ir.js into
  lang/compile/ (13 modules, a DAG: diag → keywords / length → curves →
  macros, params, voices, defs, imports, expand → notes, layers → track;
  two lets got setters), import-vgm.js into vgm-chips.js, nes-chips.js and
  audio/pcm-decode.js. Still large, not planned: ir-player.js (3.6k, the
  mixins — see live-app.md), drv-player.js (3.6k, the C's twin),
  import-mucom.js (3k), score-port.js (2.5k), export-mmb.js (2.1k).
- Phase 5 is put to the user, not done: 76 files in tools/scripts and
  drv/tools build repo paths by climbing from their own place (~340
  lines), generators write to those paths, many are outside every gate;
  a deeper directory would misplace their output for a prefix's worth of
  order.
- The review (2026-11-12) found the layers still looped (six mutual
  pairs); fixed by moving fm-words.js → ir/, sample-bank.js → export/,
  ab-compare.js → player/, export-midi.js → midi/, gm-names.js →
  machine/chips/, pruneUnnamedDefs (+ isList) → editor/edit-tools.js.
  `check:paths` now fails on a loop between live/src's directories.
- Phase 4 step 1 done: the page's editor parts and theme colours out of
  index.html (16.1k → 15.0k lines) into editor/ (mmlisp-mode, brackets,
  value-fields, playhead, completion-sources, fm-def) and
  app/theme-colors.js; CodeMirror's `await import` became a static import
  (nothing ran before it). The smoke now drives the editor (it needs the
  score's top in view: a paste leaves it scrolled to the end).
- After its review: score-port reads edit-tools' lineStarts (one copy);
  `check:editor-parts` holds value-fields / fm-def / brackets in node; both
  it and the smoke's editor step were seen to fail on a broken part.
- Names made true (the user, 2026-11-13: names may change, right beats
  kept): render/ for what spans layers (sample-bank, gm-render,
  ab-compare); midi/midi-plan.js (midiPlan) apart from
  export/export-midi.js (the SMF); lang/score-text.js (lineStarts,
  isList, nodeSpan, channelForms, pruneUnnamedDefs); fm-model.js →
  machine/chips/; rhythm-kit.js dissolved — RHYTHM_SOUNDS / RHYTHM_KIT
  into chips/rhythm-rom.js, ringGate into import-song.js. Left by
  choice: the import- / export- / synth- / ir-player- prefixes inside
  their directories (dropping them makes four midi.js), and
  import-song.js / import-shapes.js's names (a matter of taste, low gain).
- Open: phases 0–3 are pushed (2026-11-12); from ec38f7f6 on is not —
  to be played by the user first (value drag, Logical Editor, themes, the
  FM panel's write-back, completion templates, :target midi's WAV and MIDI
  export). sw.js's cache version was bumped for the moved modules.
- Phase 4, as the review recast it: no addEventListener pass (each module
  can keep `window.X =`; the smoke already catches a handler that does not
  resolve). First the page's pure code out — 290 declarations, ~1,370
  lines that read no top-level `let` (directly or through a callee) and
  touch no document / window / audio (CodeMirror's language support, the
  bracket scan, the def readers). Then stop and decide: 95 of the page's
  235 top-level lets are written from another section, which ES modules
  cannot import-and-assign; moving the bound sections needs them made one
  state object first, and a smoke that drives those sections.
- The splits were done by a scratch tool (acorn: each top-level declaration
  verbatim with its comments, its file's imports computed, every importer
  rewritten, a line-multiset check that nothing was lost or doubled); it is
  not in the repo — rewrite it from this description if a session needs it.
