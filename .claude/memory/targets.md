# Targets beyond the Mega Drive — the restructure before SCC and OPLL

The toolchain grew from the Mega Drive; pc88, x68k and msx were added on the
part / chip / target layering (`live/src/chips/parts.js`). Before the
wavetable class (SCC, `wave1`–`wave5`) and 2-op FM (OPLL) land, the layers
below the compiler are being restructured so a part decides how it plays,
shows and takes voices — not only which words it accepts. This file holds the
rulings and the plan's state; delete each item once the repo records it.

## Rulings (2026-10-25)

- **`def-fm` stays the one FM voice form**, OPLL's 2 ops included — no
  `def-fm2`.
- **Play what can be played.** A voice or word a channel's part lacks is left
  out with `W_TARGET`, not refused (as SSG-EG on the OPM already was); a voice
  on a channel with no FM keeps its `:key`.
- **OPLL's words share the `FM_` prefix** (`:ws1`, `:eg1`, `:ksl1`, `:vib1`,
  `:inst`, `:sus` new; AR/DR/SL/RR/KS/TL the same words with narrower
  ranges). What must change instead: a part's `words` become a closed list
  (opn-fm's `/^FM_(?!DT2_)/` claims any future `FM_*` word), and ranges
  become per part (`MACRO_TARGET_RANGE` is per word today).
- In the Live panel, what a machine lacks is hidden; a menu item is disabled.

## Plan, in order (each keeps md/pc88/x68k/msx output: check:snapshot green)

1. Contract written down: per-kind encoder interface; part fields `lanes`,
   `level { scale: db|linear, stepDb, steps }`, `voiceForm`, closed `words`,
   `ranges`. Not started.
2. IR player: one `route` per track (`{kind, part, lane}` + handler by part
   then kind; the Mega Drive DAC an explicit handler, not the default; an
   unknown kind an error), lanes sized from the target (today `FM_CHANNELS =
   8`, 4 PSG lanes, hold ids 8 / 20), one level composition quantized by the
   part's `level` (seven today), FM3/CSM/Timer A moved into the OPN encoder,
   the FM/PSG pitch-sweep copies merged. Not started.
3. Live page: a strip carries its channel entry (`selectedCh` numbers and
   `PSG_UI_BASE` go), kind adapters for preview / mixer / panel, a def-kind
   registry for "the voice under the cursor", Library tags from the part.
   Not started.
4. Exports: a chip-owned VGM emit (SCC's `0xD2 pp aa dd` does not fit
   `ports`), worklet ports assigned by the profile, one data-block hook for
   the DAC / ADPCM-B / OKI special cases. Not started.
5. Then SCC (`kind: wave`, `def-wave`, `metadata.waves[]` + a `WAVE` word —
   the IR form still to confirm with the user), then OPLL.

## Open

- pc88 `pcm1` (ADPCM-B) and the ROM rhythm are silent on the keys while
  stopped: `previewPcmNoteOn` knows the md DAC and PCM8 only. Lands with
  step 3's preview adapters.
