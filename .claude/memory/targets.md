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
  (stage 2; language.md §19 msx), named with no prefix (the user's
  ruling, 2026-10-25: `piano`, not `opll-piano`). The rhythm mode is
  built (stage 3; language.md §19 msx). Pitch macros and glide on a rhythm
  hit come later (a tom's pitch-down), on the FM pitch path.

## FM-PAC: how to build it (findings, 2026-10-25)

- **Stages.** All four are built (1 engine, 2 language and player, 3 the
  rhythm mode, 4 the panel: a target with FM and no `:alg` shows two
  operator columns, op1 into op2, its rows by `data-needs`, its sliders on
  the part's `ranges`; a def extending a ROM voice or init-fm shows the
  base's values).
- **The rhythm's encoder.** $0E's keys and the $36-$38 volume bytes hold
  several sounds, and hits from different tracks reach the encoder out of
  time order (each track is dispatched to the horizon in turn), so a write
  built from "the current state" would key another sound off. The OPLL's
  rhythm ops are queued with their times and written by `flush(horizon)`,
  which the player calls in `_scheduleStep` once every track is dispatched
  to the horizon (as `_chipPcmFrames`). A dump with no time (a stop) drops
  the queue. The player's rhythm path is the kit part's (`_rhythmEncOf`),
  not the YM2608's by name; the level is the part's ladder (il = top - att).
  Open: a dense score with the rhythm clips (ymfm doubles the rhythm
  output; the test score clips 87 samples) — the levels wait for a
  listening pass; the scope shows SD with HH and TOM with TOP, one lane per
  channel.
- **How the encoder works (chips/ym2413.js), and why.** The IR player does
  not send a channel's writes in time order: a note's pitch, level and op
  macros go out before its key-on, its key-off as it starts (gated) or with
  the next note (full gate). A first build read state from the order and
  lost every macro on the FM-PAC (a vibrato wrote nothing; the review
  caught it). So all of a channel's state is timelines (voice bytes, volume,
  pitch, sustain) and note spans; the player sends `noteOn(ch, when)` before
  a keyed note's macros, and each write reads the state at its own time. A
  run of voice writes at one time is held to the channel's next call and
  written then, stamped with its own time (a write's fourth element,
  `_fmWrites`), so a voice switch never leaves the shared user voice
  half-written. Known: a pitch step inside a `:keyon` macro's off-step is
  written keyed (the retrigger's key-offs go out after the pitch steps).
- **Open.** The levels wait for the user's listening pass (2026-10-25:
  "decide after hearing"): `OPLL_GAIN`, MO + RO, the rhythm against the
  melody — a score with the rhythm clips. The volume's floor is −45 dB
  (vol 15): `:vol 0` and a mixer mute do not silence a sounding FM-PAC note
  (the md's TL 127 does). A call with no time (a live edit, a key preview)
  is the encoder's latest time, and `IRPlayer.setParam` writes the edit at
  once (`live`); checked in node, not by ear. The worklet has no hold bus
  for the OPLL (the msx synth's `bus` is null; `_songRegs` is indexed
  `port & 1`), so a key preview over a song channel is not held. A cursor
  on a ROM voice's name (`piano`) shows nothing in the panel, as on init-fm.
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

## Song importers for msx / x68k (MGS, MDX; 2026-10-25)

- `import-mgs.js` reads MGSDRV's semantics from the format (digital-sound-
  antiques/mgsc mgs-format.md, mgsrc-js) and the msxplay-js demo songs —
  **not held to the driver**: no MGSDRV run was compared (libkss can render
  MGS through the real driver, and kss2vgm would give the A/B the mucom
  importer had). Not to be re-read from a secondary source: an
  AI answer's `/` `\` `_` as envelope volume moves or a loop, and a rhythm
  hit's digits as its level, contradict the format and the demos (MGSC
  writes `/n` as the mixer mode $An, `\n` as a signed detune $12, loops as
  `[ ]`; grider.mml has `h4h4h8` with `vh12`, and $20-$3F carry a length).
  Guesses to check against the driver or MGSC111.TXT: an @e's levels add to
  v (15 is v; taken from that same answer, unconfirmed), `k` keys off k
  frames early (likewise), @r scales v (v × level / 255), `n:c` slides,
  an @e's `\` steps are + up (the reverse of the track's `\`, which MGSC
  stores as a period offset — chosen because the other reading sends
  `@e22`-style toms up 60 semitones), `h` is delay, quarter-cycle frames,
  mode, depth in periods, `q` is eighths, an
  envelope mode 0 keeps the track's mixer.
- MGS's FM tracks play on fm1-fm9 (@v → def-fm mgs-vNN, else ROM voice n,
  so/sf → :sus, v as :vol on the 3 dB ladder); the rhythm track (15 in
  #opll_mode 1) is rhythm1-rhythm5, b s m c h as kick snare tom4 ride hat,
  each hit ringing to its sound's next — how MGSDRV keys a sound off (and
  what ko / kf do) is not known.
- `import-mdx.js` follows MXDRV itself (portable_mdx's port of its 68000
  code), not mdxmini, which is wrong on volume, gates after a tie, `k`, the
  LFO shapes and MA. Not modelled: the LFOs' free run without MD (the import
  restarts them each note), the random shape, sync.
