# Targets beyond the Mega Drive — the restructure before OPLL

The toolchain grew from the Mega Drive; pc88, x68k and msx were added on the
part / chip / target layering (`live/src/chips/parts.js`). Before 2-op FM
(OPLL) lands, the layers below the compiler are being restructured so a
part decides how it plays, shows and takes voices — not only which words
it accepts. This file holds the rulings and the plan's state; delete each item once the repo records it.

## Rulings (2026-10-25)

- **`def-fm` stays the one FM voice form**, OPLL's 2 ops included — no
  `def-fm2`.
- **Play what can be played.** A voice or word a channel's part lacks is left
  out with `W_TARGET`, not refused (as SSG-EG on the OPM already was); a voice
  on a channel with no FM keeps its `:key`.
- **OPLL's words share the `FM_` prefix** (`:ws1`, `:eg1`, `:ksl1`, `:vib1`,
  `:sus` new; AR/DR/SL/RR/KS/TL the same words with narrower
  ranges). What must change instead: a part's `words` become a closed list
  (opn-fm's `/^FM_(?!DT2_)/` claims any future `FM_*` word), and ranges
  become per part (`MACRO_TARGET_RANGE` is per word today).
- In the Live panel, what a machine lacks is hidden; a menu item is disabled.

## Rulings for what comes next (2026-10-25, not built yet)

- **Live editor panel: one editor, for the subject.** The subject is what
  was touched last — a strip, or the def / vector the cursor went into. The
  panel shows that kind's editor (FM 4-op, FM 2-op, wave, vector); the
  cursor leaving it dims it (never hides); a subject of another kind swaps
  the editor in. No pin. Keep the panel's order (Global, Channels, editor,
  Dynamic Parameters, Sound Effects: by priority); its heading becomes the
  subject's kind (`FM` / `Wave` / `Macro :vel`) with the subject on the
  right, where `fmParamStatus` is. Open: swap on a click at once, but only
  once the cursor rests when it moves by keys.
- **One vector editor** (Max/pd arrays) for every vector: def-wave, macro
  step vectors (`#sus` / `#rel` as markers), later chips' waves. The subject
  gives the length and the range (the part's / MACRO_TARGET_RANGE); a
  relative target (`:pitch`, `:semi`) has a view range the user sets.
  Clamping: the editor cannot draw out of range; a literal out of range is
  the compiler's error; a computed value is clamped at the register write.
- **Waves are expressions**, as values are (§7.1.2): without a `$slot` folded
  at compile time (mixes, generators such as harmonics), with one
  re-evaluated by the player when the slot moves and written whole (≤ once a
  frame). One evaluator shared by compiler and player; the XY pad, sliders,
  MIDI CC and def-val sweeps all drive it through slots; the editor drawing
  live writes the data. Goal: draw / morph a held note's wave in real time
  (Koshiro's mucom VSTi).
- **FM-PAC (OPLL).** The one user voice: the last written wins, with
  `W_TARGET`. The 15 ROM voices are built-in voice names (as init-fm, the
  ROM rhythm roles), their dumped parameters letting a def-fm extend one and
  other targets play an approximation; the name prefix is open (`opll-`?),
  and no `:inst` number. Rhythm mode: channels `rhythm1`-`rhythm5` under the
  kit roles (kick snare tom4 ride hat; rim none), as pc88's. Still to
  discuss: the mode song-wide (fm7-9 then `E_TARGET`?), and pitch (ch7-9's
  F-number tunes the drums, SD/HH and TOM/CY pairs shared — later wins?).

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
   Fits from the part (not `/^fm/`, `/^pcm/`). The wave editor would sit on
   that.
2. VGM: one data-block hook for the DAC / ADPCM-B / OKI special cases
   (optional).
3. IR player, when OPLL lands: the FM level through the encoder (OPLL has
   a channel volume, not carrier TLs), per-part ranges; FM3 / CSM / Timer A
   into the OPN encoder (hygiene; gated by `csm` today).
4. `targets.js` SCOPE_BASE: OPLL's fm7-fm9 would land on the PSG's lanes —
   set `scope` in its channel table or rebase.
5. OPLL (FM-PAC) needs design talks first: one user voice shared by every
   channel, the 15 ROM voices (`:inst`), rhythm mode vs the `rhythm-*`
   strips.
