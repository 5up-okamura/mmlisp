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

## Facts to correct (no decision needed)

- `README.md:29` "the hardware driver plays one voice today" contradicts
  README lines 109–111 and `engine-images.js` (three images).
- Score counts are quoted in five places (`README.md`, `drv/README.md`,
  `drv/sgdk/README.md`, `docs/driver.md` ×2) and drift within a day: the docs
  say 56, `c-gate` runs 61 (63 including sidecars) on 2026-09-23. Stop
  quoting the number, or let one gate print it and cite that.
- `CLAUDE.md:64` "There is **no automated test suite**" — false for `drv/`
  (verify:all) and `tools/`; say the live app has none. The live/src table
  omits 12 of 23 modules (engine-images, export-vgm/wav, import-fm-voices,
  import-mucom, mmb-dedup, mmb-voices, mmlisp-eval, mucom-pcm, scope-trigger,
  slot-builder, synth-md).
- `live/index.html` says "MMB v0.2" three times (backend toggle title,
  the backend log line, the drv backend comment); the format is v0.3.
- `drv/sgdk/README.md` verification box: "ran … on the one-voice engine that
  preceded the three images; that gate is being moved" — `sgdk-gate.mjs`
  boots the score's own image and driver.md §12.7 reports all three.
- `third_party/Nuked-OPN2/ym3438.svg` (823 KB die shot) is unused.
- `cd tools && npm run check:format:mmlisp` is red (examples + presets), and
  the glob does not cover `presets/`; `.vscode/tasks.json` runs it.
- `tools/scripts/render-acid-fm.mjs` and `check-scope-trigger.mjs` are in no
  package script and no README.

## Dead code

- `drv/68k/gate_main.c` `--pump` / `mml_pump` / `MMLSlotSink`
  (`mmlispseq.c`, `.h`): the ring-transport model; its own comment says no
  gate runs it since `archive/ring-engine`.
- `drv/engine/config.mjs` + `gen-stream.mjs`: the one-voice and bench
  profiles (`p10k/p3k3/p13k`, `RAM_P1/P2*`, `RAM_1V`, `CODE_ESTIMATE_2CH*`,
  the "ONE-VOICE MIX" / "ONE-VOICE PCM EDGE" sections, `cfg.oneVoice`
  dispatch, the `.asm` header "output-only DAC stream prototype (P1)").
  `build-engine.mjs` only ever builds the multi profile. Prove with the
  `mirrors` gate: images byte-identical after the cut.
- Orphan fixtures reached by no script: `drv/tests/budget-2v*.mmlisp` (3),
  `stress-9ch.mmlisp`, `m3-pcm-baked.mmlisp` — promote into c-gate or delete.
- `live/src/drv-player.js`: `unsupported: t.channelId >= 23` and the
  `W_DRV_CHANNEL_UNSUPPORTED` ("is M2/M3") path; channel ids end at pcm3 = 22.
- `live/src/ir-utils.js`: `composeLevel`, `levelToFmTl`, `levelToPsgAtt`,
  `composeFmTl`, `composePsgAtt` (the pre-additive-dB model; zero callers).
- `live/src/mmlisp2ir.js`: `isAtom`, `parseSingleChannel`, `parseTrackHead`
  (never called); `":tempo-scale"` mapping + its i16 special cases while
  `SUPPORTED_TARGETS` rejects it and no player handles it (keep the id
  reserved in mmb.js/opcodes.md only).
- Duplicates to fold into `ir-utils.js` / `pcm-model.js`: MIDI→Hz (4 copies),
  PSG period (ir-player, drv-player), sample-bank parse in drv-player vs
  `parsePcmBank`, the 7670454 / 3579545 clock constants (4 files each),
  `PCM_BLOCK` / sample-entry size / voice count defined twice.
- Comments describing v0.3/v0.4 deltas ("was 0-15", …) in `mmlisp2ir.js`
  around lines 2, 900, 936, 2836, 3003, 5004, 5166, 5240.
- `MMLISPDRV_PROTO_VER` is emitted in `mmlispdrv_bin.h` and read nowhere.

## Docs: history to cut, per CLAUDE.md "docs describe only the present"

- `docs/opcodes.md`: §9 "Migration Notes (v0.1 → v0.2)", the Stage column
  and "reserved / layout frozen / M3 decision" wording (everything in the
  tables is implemented), the dated decision record in §4, the claim that
  curves come from "256-entry u8 unit LUTs" (only `sin` is a LUT; the rest
  are computed in `mmb.js` and `mmlispseq.c`), curve ids 8–11 described as
  reserved while they are emitted, FM_DT "0..7" vs language.md's signed
  −3..+3, and references to `tools/scripts/mmb-common.js`,
  `MMB_TARGET_ID_TO_NAME`, `tools/scripts/verify-mmb.js` (none exist; cite
  `live/src/mmb.js`).
- `docs/mmb.md`: "v0.2 tooling must…", v0.1/v0.2 comparison sentences,
  "design frozen for review".
- `docs/roadmap.md` (797 lines): Phases 0–2 and the v0.4/v0.5 checklists are
  all done; "CALL/RET + hardware bring-up remain", "Furnace/DefleMask import"
  and "parametric definitions removed" are stale. Keep Phase 3 open items +
  a refreshed backlog; one line per finished phase.
- Duplicated driver facts (rates, "byte-for-byte", hardware status, SE
  status) live in README, drv/README, sgdk/README, driver.md §11, roadmap.
  Give each fact one owner: README one paragraph + links; drv/README
  build/verify; sgdk/README integration; driver.md §11 limits.
- History phrasing left in code comments: `drv/sgdk/mmlispdrv.c` ("the
  two-grab host it replaces", "the ring … cleared"), `drv/68k/mmlpairs.c`
  header (HInt grab), `tools/README.md` ("v0.1 MMB scripts were removed"),

- `mmlisp-syntax/package.json` lacks publisher/license/repository; the
  package.json versions (0.1.0 / 0.1.1) do not match the v0.5 baseline.
