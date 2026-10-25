# Targets beyond the Mega Drive — the restructure, and the FM-PAC

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
- **OPLL's words share the `FM_` prefix** (built: language.md §19 msx; a
  part's `words` is a closed `fmWords` list, its narrower registers its
  `ranges`). `MACRO_TARGET_RANGE` stays the family's widest: a macro is
  clamped there, the part's range clamps at the write.
- In the Live panel, what a machine lacks is hidden; a menu item is disabled.

## Rulings for what comes next (2026-10-25, not built yet)

- **The editor panel** is built; still open: swap only once the cursor
  rests when it moves by keys (if passing through feels busy), drawing on a
  stage vector, and a 2-op FM editor for the OPLL.
- **Wave expressions** are built (`+ - * /`, a track's `:wave` with
  `$slot`s); still open: generators (`(harmonics 1 0.5 0.33)` …), once the
  expressions are in use.
- **FM-PAC (OPLL).** The one user voice and the 15 ROM voices are built
  (stage 2; language.md §19 msx). The `opll-` prefix was chosen in the
  build, not by the user: confirm or rename. Rhythm mode: channels `rhythm1`-`rhythm5` under the
  kit roles (kick snare tom4 ride hat; rim none), as pc88's. The mode is
  song-wide: a score with a rhythm track has it on, and fm7-fm9 are
  `E_TARGET` there. A hit's pitch tunes its channel (ch7 BD, ch8 SD/HH,
  ch9 TOM/CY): c4 is the datasheet's ($16=$20 $26=$05, $17=$50 $27=$05,
  $18=$C0 $28=$01), other notes move it by semitones; a shared pair takes
  the last hit's pitch, with one `W_TARGET` a score when its two sounds are
  written at different pitches. Pitch macros and glide on a rhythm hit come
  later (a tom's pitch-down), on the FM pitch path. Like the SCC, the
  FM-PAC is a cartridge in `:target msx`: an optional chip (`optional:
  true`), started at its first write, absent from a VGM that has no OPLL
  track.

## FM-PAC: how to build it (findings, 2026-10-25)

- **Stages.** 1 engine and 2 language and player are built; next 3 the
  rhythm mode, then 4 the panel's 2-op FM editor. Commit each.
- **How the encoder works (chips/ym2413.js), and why.** The IR player sends
  a note's key-off as the note starts (a gated note) or as the next one
  does (full gate), ahead of writes inside the note, so the encoder never
  reads its own write order: each channel keeps its latest note's span
  (on, off) from the times the player passes, and a write is inside a note
  when its time is in that span. No dedup against "what the chip holds"
  for the same reason. A voice is settled at key-on (ROM index when the
  registers match the ROM, else the user voice's 8 bytes); a voice write
  inside a note moves it at once; one between notes waits for the key-on,
  so a voice switch's run of PARAM_SETs never leaves the shared user voice
  half-written. The voice hoist is off for the part (`voiceAtKey`): it only
  cut notes 40 ms. Known: a new note's pitch write, sent before a
  full-gate note's deferred key-off, carries the key bit, so the re-key
  edge is at the pitch write in the same instant (harmless in ymfm's
  adapter, which holds a second $2x of a sample for the next).
- **Open from stage 2.** The volume's floor is −45 dB (vol 15): `:vol 0`
  and a mixer mute do not silence a sounding FM-PAC note (the md's TL 127
  does) — key it off, or take the floor as the chip's. The Live key
  preview and a channel hold on the OPLL are untried: `writeBorrowedPatch`
  writes through the song's encoder with no time, and the worklet's
  `_songRegs` is indexed `port & 1` (port 4 → the PSG's), so a hold bus
  needs it per port first. The panel shows the 4-op editor on fm1-fm9.
  Not heard yet: the ROM voices against a recording, MO + RO and
  `OPLL_GAIN` by ear; a dense score clips a few samples as the md's does.
- **ROM voices.** The values are Nuked-OPLL's `patch_ym2413` (read from
  the die), packed into the user voice's layout in chips/ym2413.js; the
  emulator takes the same table (`ol_set_rom`), so a ROM voice and the same
  bytes as the user voice render sample-identical (checked for all 15).

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
3. IR player: FM3 / CSM / Timer A into the OPN encoder (hygiene; gated by
   `csm` today). The OPLL's level through its encoder and per-part ranges
   are built (stage 2).
