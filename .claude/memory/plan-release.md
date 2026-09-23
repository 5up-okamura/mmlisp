# Release checklist (review of 2026-09-21, re-checked 2026-09-23)

What the whole-repo review found that is still open. Each item names the
file so an implementation chat can take it without re-deriving. Delete an
item when it lands; delete the file when the release is tagged.

State on 2026-09-23: `cd drv && npm run verify:all` is green; SE, PAL, fm3-N
levels/pitch/keyon and `(trig N)` landed on the 68k; the memory directory is
consolidated; the local DAC-engine document is no longer referenced.

## Decisions the user has to make

1. ~~**Deployment layout.**~~ **DONE 2026-09-23.** Kept the published root at
   `live/` and mirrored the shipped data into it the way `examples/` already
   was: added the tracked symlink `live/presets -> ../presets`. The set
   browser's `/presets/...` fetches resolve in production; the local
   `serve ..` flow is unaffected (it reaches `presets/` from the repo root
   directly). The Licenses dialog's three in-repo links pointed at `/LICENSE`
   and `/third_party/*/LICENSE`, which the published root does not hold and
   which would have published the 823 KB die shot and the C sources if
   symlinked; they now point at the public repository
   (`github.com/5up-okamura/mmlisp/blob/main/...`, all 200). Verified
   headlessly: Browse lists the four sets, the dialog's links are all
   external, no console errors.
2. ~~**Nuked-PSG is GPL-2.0.**~~ **DOCUMENTED 2026-09-23.** The app's Licenses
   dialog already declared it correctly (GPL-2.0-or-later + a source link);
   only the repo-level files were silent. `THIRD_PARTY_NOTICES.md` now has a
   Nuked-PSG section and the README's License section names both cores.
   **Still the user's call:** whether shipping a GPL-2.0-or-later core inside
   an otherwise-MIT app is the intended licensing posture for the release, or
   whether the PSG core should be swapped/isolated. The notices describe what
   is true today; they do not settle that.
3. ~~**`$slot` range.**~~ **DONE 2026-09-23 (user's call: the lighter
   option, with a compile-time warning).** The old rule was that
   `ir-player` clamped every slot write to the `def-val` `[min, max]`, which
   `drv-player` and the 68k did not, and which `language.md` §8 justified with
   "this mirrors the bounded integer slots the driver holds" — untrue.

   What settled it: `mmlispseq.c` already clamps at the point of *use*, per
   target (`clampi`: TL 0..127, att 0..15, vel 0..15, vol/master 0..31, note
   0..126, PSG period 1..1023, gate 0..8, rate 0..8, pan -1..1), and
   `ir-player._applyParam`'s `set(apply, min, max)` does the same with the
   same numbers. So the safety the doc claimed was already delivered by a
   mechanism the driver needs anyway. Per-slot bounds in VAL_TABLE would have
   been a second clamp over the first, at 64 bytes and a format change across
   four layers, and would have promoted `:from`/`:to` from a slider affordance
   into a runtime contract.

   Shipped: a slot is an i16 and nothing more. `toSlotValue()` in `ir-utils.js`
   is the one coercion (round, clamp to i16, `null` for non-finite = ignore the
   write), called by both `ir-player.setVal` and `drv-player.setVal`, so the
   two cannot drift. `init` is no longer folded into range at compile time:
   outside the slider's travel is `W_DEFVAL_INIT_RANGE`, outside i16 is
   `E_DEFVAL_INIT`. `language.md` §8 rewritten; `ir.md`'s note that the player
   consumes only `name`/`init`/`unit` is now true.

   Not done, deliberately: `GATE` is still absent from `MACRO_TARGET_RANGE`.
   It is not in `SUPPORTED_TARGETS`, and the only `TARGET_ID.GATE` writes are
   the eighths `export-mmb` derives itself (0..8 by construction), so no slot
   can reach it. A range entry for it would be dead config.

   Verified: 87 scores compile with zero out-of-range inits, six-case
   diagnostic test, `drv npm run verify:all` green, `check:mmlisp-strict` 6/6,
   and the Dynamic Parameters slider renders 0..40 and drives `setVal` with no
   console errors.

4. ~~**`player/`.**~~ **DONE 2026-09-23 (user's call: delete).** The VGM
   player had served its purpose as a problem-checking harness, so
   `player/{index.html,vgm-player.js,package.json,README.md}` are gone. Its
   sibling `player/wasm/` was not part of that harness: it builds both chip
   cores and is the corresponding source the LGPL/GPL notices point at, so it
   moved to top-level `wasm/`. Its two build scripts computed `repo_root` as
   `dirname/../..`, corrected to `dirname/..`. References repointed in
   `THIRD_PARTY_NOTICES.md`, `README.md`, `CLAUDE.md`, `live/sw.js`.
   `tools/scripts/render-acid-fm.mjs` imported the gitignored
   `player/wasm/dist/nuked-opn2.js`; it now imports the shipped
   `live/nuked-opn2.js` and passes.

## What is left

Nothing from the review is outstanding. The four decisions above are settled,
the facts are corrected, the dead code is out and the docs describe only the
present. Two things were learned along the way and are worth keeping:

- **Do not quote a gate's score count in prose.** It was written in five
  places and drifted between 47, 48, 56 and 61 within days. The gates print
  what they ran; the docs say so instead of repeating a number.
- **The engine cfg object's field shape is the image stamp's input**
  (`sha256(JSON.stringify(cfg))`, published in `live/src/engine-images.js` and
  `sgdk/mmlispdrv_bin.h`, byte-compared by `npm run mirrors`). The flags the
  generator no longer varies — `oneVoice`, `csm`, `fmBurst`, `observeTimerB`,
  `correctorBudget`, `command`, `ymWriter`, `csmHost` — are pinned literals
  for that reason, not oversights. Dropping them renames all three images;
  it is safe (the bytes do not move) but needs the mirrors regenerated, and
  nobody has asked for it.

## Open question

The roadmap now frames **v0.5 as the baseline** and says numbered freezes
stopped there, matching CLAUDE.md. Compile-time eval, `import`, score removal
and the value machine all shipped after that line was drawn; if the user wants
them called v0.6, it is the version table's last row and the sentence under it.
