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

- **The editor panel** is built; still open: swap only once the cursor
  rests when it moves by keys (if passing through feels busy), drawing on a
  stage vector, and a 2-op FM editor for the OPLL.
- **Wave expressions** are built (`+ - * /`, a track's `:wave` with
  `$slot`s); still open: generators (`(harmonics 1 0.5 0.33)` …), once the
  expressions are in use.
- **FM-PAC (OPLL).** The one user voice: the last written wins, with
  `W_TARGET`. The 15 ROM voices are built-in voice names (as init-fm, the
  ROM rhythm roles), their dumped parameters letting a def-fm extend one and
  other targets play an approximation; the name prefix is open (`opll-`?),
  and no `:inst` number. Rhythm mode: channels `rhythm1`-`rhythm5` under the
  kit roles (kick snare tom4 ride hat; rim none), as pc88's. The mode is
  song-wide: a score with a rhythm track has it on, and fm7-fm9 are
  `E_TARGET` there. A hit's pitch tunes its channel (ch7 BD, ch8 SD/HH,
  ch9 TOM/CY): c4 is the datasheet's ($16=$20 $26=$05, $17=$50 $27=$05,
  $18=$C0 $28=$01), other notes move it by semitones; a shared pair takes
  the last hit's pitch, with one `W_TARGET` a score when its two sounds are
  written at different pitches. Pitch macros and glide on a rhythm hit come
  later (a tom's pitch-down), on the FM pitch path.

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
