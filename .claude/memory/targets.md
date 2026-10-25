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

Done (2026-10-25): one route per track in the IR player (`_routes`, cores by
kind, SAMPLE_HANDLERS with the DAC explicit, holds keyed `core:lane`); one
level composition (ir-utils `levelSteps` / `levelGain`) quantized on each
part's `level`; the FM family's words in one table (`chips/fm-words.js`)
with closed per-part lists; FM channels sized from the targets; one synth
registry (`src/synths.js`) and a port-collision check per target.

Next:
1. Live page: a strip carries its channel entry (`selectedCh` numbers,
   `PSG_UI_BASE`, `isFmChannel` go), kind adapters for preview / mixer /
   panel, a def-kind registry for "the voice under the cursor", Library
   Fits from the part (not `/^fm/`, `/^pcm/`).
2. VGM: a `sub` byte in `vgm.ports` for the SCC's `0xD2 pp aa dd`; one
   data-block hook for the DAC / ADPCM-B / OKI special cases (optional).
3. IR player, when OPLL lands: the FM level through the encoder (OPLL has
   a channel volume, not carrier TLs), per-part ranges; FM3 / CSM / Timer A
   into the OPN encoder (hygiene; gated by `csm` today).
4. `targets.js` SCOPE_BASE: OPLL's fm7-fm9 would land on the PSG's lanes —
   set `scope` in its channel table or rebase.
5. Then SCC (`kind: wave`, `def-wave`, `metadata.waves[]` + a `WAVE` word —
   the IR form still to confirm with the user), then OPLL.
