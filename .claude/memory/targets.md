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
- **The OPLL's one user voice is one at a time, not one a score** (the
  user's reading of MGS songs, 2026-10-26): a key-on writes the user voice,
  so a channel switches freely; `W_TARGET` only where notes on different
  channels sound together on different user voices (`checkTracks`, on the
  tracks' loops written out, init-fm counting as one).
- **The voice hoist is the driver's alone** (`target.driver`; 2026-10-25,
  the user's reading): on a VGM target it only cut notes 40 ms and moved
  voices off their beat. No `voiceAtKey` per part.
- **`init-fm` is the FM part's** (`initVoice`, else the family's init
  values of the words the part has — the OPM's with DT2 0 and no SSG-EG,
  the OPN's the reverse; the user's ruling, 2026-10-26): a sine on each chip. The player's boot patch is the same map,
  so a track with no voice plays init-fm on every target.

## Rulings for what comes next (2026-10-25, not built yet)

- **The editor panel** is built, the OPLL's 2-op operators too; still
  open: drawing on a stage vector. (Ruled 2026-10-26: no wait for the
  cursor to rest before the panel swaps.)
- **Wave expressions** are built (`+ - * /`, a track's `:wave` with
  `$slot`s); still open: generators (`(harmonics 1 0.5 0.33)` …), once the
  expressions are in use.
- **FM-PAC (OPLL).** The one user voice and the 15 ROM voices are built
  (stage 2; language.md §19 msx), named with no prefix (the user's
  ruling, 2026-10-25: `piano`, not `opll-piano`). The rhythm mode is
  built (stage 3; language.md §19 msx), its hits' pitch moves too.

## PC Engine, then the Famicom (rulings, 2026-10-27)

- **The PC Engine (HuC6280) comes first**, the Famicom (2A03) after it: the
  PCE fits the parts as they are (wave, a noise sharing its channel) and
  tests the "resolution is the encoder's" ruling; the 2A03 brings new words
  (`:duty`, a triangle with no level, DPCM).
- **Target names `pce` and `fc`.** Channel names reuse the existing ones:
  pce `wave1`-`wave6`, the noise its channels 5 and 6 switch to as
  `noise5` / `noise6`; fc `sqr1`-`sqr2`, `tri`, `noise`, `pcm1` (DPCM).
- **pce's first build is the wave channels and the noise only** — DDA (the
  5-bit direct PCM) and the ch2 → ch1 LFO wait, as the SCC came in stages.
  Built 2026-10-27 (chips/huc6280.js, targets/pce.js, synth-pce.js): the
  chip's reading is MAME's c6280.cpp and Mednafen's pce_psg.cpp (fetched,
  they agree): tone = clock / 32 / f, the LFSR clocked every (31 − n) × 64,
  the volume 1.5 dB a step capped at the table's 48 dB with the L/R and
  main levels added, a wave loaded with the channel off from a DDA 1 → 0
  edge. Rulings built in: a noise note is a rate index (c2 slowest … g4),
  not a Hz — the rates are LFSR clocks (1.8 kHz up), so a Hz mapping
  would have put every note at rate 0; a `:wave` under a note is held to
  the next key-on (ir-player `_writeLaneWave`, part `waveAtKeyOn`); a
  score has wave5 or noise5 (the SSG's one-or-the-other rule). The PSG
  core's off level is the lane's ladder's last step (`_psgOff`), no longer
  15. `:pan` is built (a value, a
  sweep, a note's macro onto $05, the IR keeping its fraction:
  FRACTIONAL_TARGETS). DefleMask / Furnace PCE modules import as pce
  (import-tracker.js; Furnace's rules read from its pce.cpp: noise rate =
  note & 31 under properNoiseLayout, else a 12-entry table; 08xy the $05
  nibbles; the WAVE block and pointer type 5 from papers/format.md). Open:
  the Furnace side has run on no real .fur (check:import-tracker builds a
  DMF only); an old (<240) .fur's properNoiseLayout is not read (default
  true). VGMs import too (import-vgm.js pceChip / sccChip: a note carries
  its wave, each distinct one a def-wave; the HuC6280's noise a row of its
  own; round-tripped in check:import-vgm).
- **pce's LFO and DDA, ruled 2026-10-27 (the user):**
  - LFO, used as the FM LFO is: the song's `:lfo-freq` 0–255, larger is
    faster ($08 = 256 − v); wave1 takes it with `:fms 0–3` (0 off, 1–3
    $09's modes); its shape is wave2's def-wave, its speed wave2's pitch
    / (256 − v). Rule A: while wave1's :fms is not 0, ch2 stays on and is
    the LFO — wave2's rests and :vol 0 only silence it (volume 0 with the
    on bit kept), the LFO runs at its last pitch; wave1's :fms 0 stops it.
    A wave2 key-on resets the LFO's phase ($09 bit 7 pulsed). The depth is
    in period steps (±16/64/256), so a higher note sways more and a deep
    one wraps the 12-bit period (Mednafen's & 0xFFF) — not clamped.
  - DDA: `pcm1`–`pcm6`, channel N in DDA mode; samples baked per note at
    6.99 kHz (7.16 MHz / 1024), no pitch move while sounding; level and pan
    as a wave channel's (the same volume table on the chip).
  - One channel, several kinds (wave5 / noise5 / pcm5): all may be
    written; where they overlap, :prio decides across the names, and at an
    equal :prio (the default 8) pcm > noise > wave — the higher's note
    drops a lower one starting under it and cuts one sounding. Loops must
    agree, as same-name layers' do. Order of work: LFO → DDA → this pass.
  - LFO built 2026-10-27 (pceWaveLfo on ch1 takes FM_FMS; the encoder's
    lfo / lfoFreq / keyOn — keyOn a player hook at a PSG lane's NOTE_ON;
    synth-pce.js steps ch2 at freq × divider and moves ch1's period).
    Measured: a4 at :fms 1 / 2 sways ±20 / ±70 Hz.
  - DDA built 2026-10-27 (pceDda, frames: true — bakePcm8's frames, the
    player's setFrameBank, renamed from setPcm8Bank). A note's bytes are
    written on the CPU timer (ir-player `_writeTimer`, not the frameClock
    snap), a frame at a time from _chipPcmFrames (`_ddaFrame`), so a note
    of another of the channel's names dispatched meanwhile ends the hit (its
    off a key-order lead before that key-on; the off waits for its frame
    and the horizon, or a note starting at the sample's very end came after
    it). Live gets each frame's ticks as one `stream` message
    (writeToWorklet.stream → worklet `_runStreams`, a tick at its sample) —
    per-write messages stalled the page ~100 ms and an O(n²) queue in the
    worklet; per-frame streams measured the same as a wave-only score (p95
    ~3 ms, the page's own 30-50 ms long tasks). The export / capture path
    writes them one by one, so the register log, VGM and WAV are the same
    writes.
  - The cross-name layering built 2026-10-27 (mmlisp2ir shareChannelLayers,
    parts' `sharePrio`; the :prio pass split into alignLayerLoops /
    resolveLayerNotes, same-name output unchanged). Like the same-name
    :prio pass, it does not count the notes it drops.

## The Famicom (fc) — the design, ruled 2026-10-27; stage 1 built

Build it as pce was built (chips/huc6280.js, targets/pce.js, synth-pce.js,
tools/tests/pce are the pattern), in stages: 1. pulses, triangle, noise;
2. DPCM; 3. DefleMask / Furnace NES modules as fc (import-tracker.js
already reads them) and VGM 0xB4. Expansions after, by voice class (FDS
the only one with a VGM slot: APU clock bit 31; VRC7 as a YM2413 needs its
own ROM voices, decide then). Facts are from memory: hold every table to
nesdev and Mesen / MAME (fetch them) before writing the emulator.

- Channels `sqr1` `sqr2` `tri` `noise` `pcm1`; VGM: NES APU clock at $84,
  command 0xB4, DPCM data in block 0xC2 (writable mid-song, so no 16 KB
  total limit); frameClock true (60 Hz vblank drivers).
- **`:duty` in sixteenths** (a new word, macros allowed): the encoder takes
  the nearest of the chip's steps — 2A03 2/4/8/12 (12.5/25/50/75 %; 75
  sounds as 25), later VRC6 1–8, MMC5 as 2A03. The "a part's resolution
  is its encoder's" ruling.
- **Pulse / noise level** 4-bit linear (`{ scale: "linear", steps: 16 }`),
  constant-volume mode, volume 0 the key-off. No hardware envelope, no
  sweep in the language. The encoder writes $4001 = $08 (sweep off, negate
  set — else notes below ~A2 are muted by the sweep's overflow check),
  stops at a period under 8, and rewrites $4003 / $4007 only when the high
  bits change (a write resets the phase: a click).
- **Triangle** has no level: `:vel` / `:vol` are W_TARGET (the "play what
  can be played" ruling). A rest halts it with the linear counter (it holds
  its output: no click; takes effect at the next frame-sequencer tick).
- **Noise**: the note picks one of the 16 period-table rates (from c2, as
  pce's noise), `:mode white | periodic` (periodic = the 93-step short
  mode); md's white0–periodic3 are E_TARGET with a hint.
- **DPCM (pcm1, one voice)**: one rate per def-pcm — the highest of the 16
  at which every note of it fits 4081 bytes; each note resampled to its
  pitch at that rate. Level baked into the amplitude (`:vel`, `:vol`; no
  change while it sounds). Loops are the whole sample only ($4012/$4013):
  :pcm-start / :pcm-end are the sample, a different :loop-* is W_TARGET;
  `:mode loop` works. Each hit writes $4011 to the bake's start level (64)
  and restarts via $4015. The 1-bit delta (±2 a sample) dulls fast loud
  attacks — say so in the reference. The nonlinear mixer (the DAC level
  lowering tri / noise) is the emulator's, the language says nothing.
- **Stage 1 built 2026-10-27** (chips/rp2a03.js, targets/fc.js,
  synth-fc.js, tools/tests/fc). Tables from nesdev's APU pages (fetched):
  duty sequences, noise periods (NTSC, CPU clocks), triangle, the mixer
  formulas. The encoder queues its timed writes and `flush(horizon)`s them
  in time order (as the SSG's): a pulse's $4000 holds volume and duty, which
  the player sends out of order; a silence is written at once (level 0 is
  silent at any duty) with its state queued. The noise sits on the PSG's
  noise lane 3, pitched (part `rateNote`); the PSG encoder hands a view a
  lane (`lanes`) since each channel's period differs. The triangle's
  `:vel` / `:vol` warn through warnEnvLevel (part `noLevel`). The synth runs
  the envelope, sweep, length and frame counter too (for the VGM import to
  come); `MASTER_OUTPUT_GAIN` 1.6 puts one pulse's RMS at one pce channel's.
  A review (2026-10-27) caught and fixed: the noise's length counter never
  loaded (init writes $400F once); a stop's untimed silence deduped away
  against the horizon's state (an untimed write bypasses `last`); nothing
  flushed the queue while stopped (`_psgWrites` flushes when not playing);
  the :mode macro on the pitched noise lane. Open: not listened to by the
  user (the level beside other targets, the noise rates, the triangle's
  halt); no VGM player has checked the 0xB4 output. The curve option `:duty` is 1–255 (128 = 50 %) while the track
  word is in sixteenths, as ruled — two scales under one name; raise it if
  it confuses. The Live page labels lanes 0-3 S1 S2 S3 N1 (tri shows S3);
  Import > Audio as Formants on an fc score writes fm3 tracks (pce is
  excluded in index.html; fc is not yet).

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
- **Levels.** `OPLL_GAIN` is set against the PSG and SCC as libkss
  (MSXplay) mixes them, measured on an MGS song (G2_00.MGS) chip by chip;
  confirmed by ear 2026-10-26.
- **Open.** The levels passed the user's listening (2026-10-26: the
  rhythm against the melody, the clipping and the level beside the other
  targets are fine as they are). The volume's floor is −45 dB
  (vol 15): `:vol 0` and a mixer mute do not silence a sounding FM-PAC note
  (the md's TL 127 does) — ruled 2026-10-26 to stay: the chip cannot, and
  MGSDRV's v0 is the same; a mute keys off as on md. A call with no time (a live edit, a key preview)
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

Ruled for the 2A03 / HuC6280 (2026-10-26, the user): a part's resolution
is its encoder's, written at the write (parts.js header) — so `def-wave`
stays 32 steps of −128..127 (the HuC6280's 5 bits are its encoder's
shift), and `:pan` reaches the encoder unsnapped (`panSide` for the
left/right-bit chips; the HuC6280's 4-bit L/R reads it whole). A step count
other than 32 waits for the FDS (64): a wave repeated a whole number of
times only, never interpolated; 64 → 32 a `W_TARGET`. A part with no level
(the 2A03's triangle) is "play what can be played": `:vel` / `:vol` a
`W_TARGET`, built with the 2A03. Order: the part model before the Live
strip (node-checkable first; the strip's entry carries the part).

Done (2026-10-27): the Live page's channels are slots (`FM_SLOTS`,
`TONE_SLOTS`, `PCM_SLOT`; a strip carries `slot`), nothing reads a kind off
a number; ruled with it: no kind-adapter registry (14 `kind` switches are
enough), the Library's Fits and the def under the cursor already come from
the parts.

Done (2026-10-27): CH3's $27, Timer A, its operators' TL and F-numbers are
the OPN encoder's (`mode`, `timerA`/`timerAOf`, `ch3Tl`, `ch3OpPitch`); the
IR player keeps only their state.

Next (optional): VGM — one data-block hook for the DAC / ADPCM-B / OKI
special cases.

## Song importers for msx / x68k (MGS, MDX; 2026-10-25)

- `import-mgs.js` follows MGSC 1.11's MML reference (MGSC111.TXT, from the
  user: gigamix.jp is out of this environment's reach) and is held to the
  real MGSDRV: `tools/scripts/ab-mgsdrv.mjs` (libkss-js, installed with
  `npm i --no-save libkss-js`, runs the driver and writes VGM) compares an
  import frame by frame. On the five msxplay-js demos (copyrighted, kept
  out of the repo) sounding agrees 86-100% a channel, pitch within 50 cents
  92-100% (a PSG drum part 51%: tones near the period's floor, where our
  exact pitch and the driver's integer period part), levels within a step.
  What is left is a frame of phase on short notes. The rhythm is held to
  $0E's key bits (ko / kf, the end's all-off; Grider and Contrail agree
  99.8-100% a frame), $36-$38's levels and $16-$28's tunings, and y to the
  driver's register writes (a user voice's $00-$07, the PSG's $06/$07).
- MGSDRV's frame, as measured on libkss (2026-10-26, crafted MGS files,
  scratch `g2/mgsq.mjs`, `g2/mgstempo.mjs`): count c starts on frame
  round(c · W / 192), W = floor(14400 / t), a half up; a gate keys off
  floor(note frames · q / 8) frames in, one at least — the msx target
  plays so (`frameClock`, built). Left: a q8 note before a rest keys off
  one or two frames late in MGSDRV. libkss runs the MSX at 59.92 Hz:
  ab-mgsdrv reads it on that frame, mid-frame. A `y14`'s held keys (HH,
  CYM) ring once at the `y` at levels the file does not give (MGSDRV
  writes HH 3 with no `@`), so they are left out; only a song's first
  `y14` is read.
- A secondary source (an AI answer) had `/` `\` `_` in an envelope as volume
  moves or a loop and a rhythm hit's digits as its level: the reference
  says otherwise — not to be re-read from such a source.
- The msxplay-js demo Contrail (PSG + SCC + FM + rhythm, its rhythm at v15)
  clips the msx synth's mix by ~30k samples where it barely clips without
  the rhythm: the OPLL rhythm's level beside the other chips is untested.
- `import-mdx.js` follows MXDRV itself (portable_mdx's port of its 68000
  code), not mdxmini, which is wrong on volume, gates after a tie, `k`, the
  LFO shapes and MA. Not modelled: the LFOs' free run without MD (the import
  restarts them each note), the random shape, sync.
- How an MDX import is held to MXDRV (2026-10-26, on the user's Assault
  set): clone portable_mdx, add to `Opm::OpmPoke` an `fprintf(stderr, "W
  %ld %02x %02x", tick, reg, data)` with `tick` counted up in the Timer B
  interrupt (`OpmIntProc` call), build `examples/simple_mdx2wav`, run it on
  the MDX + PDX; turn the ticks to seconds from the `$12` writes (a clock
  is 1024·(256−TB)/4 MHz); compare against `IRPlayer.captureRegisterLog`
  of the import: key-ons ($08) per channel within 5 ms, KC/KF at each
  key-on, and the pitch held between. What still differs: the software
  LFOs' phase and depth within a note (MXDRV steps them a clock, ~10 ms;
  the import at 60 Hz), `v` rounded to :vel's 2 dB (≤ 1 dB), a looping
  tempo-only track averaged (≤ 1 % over its loop). The x68k synth's
  FM : PCM8 balance was measured on the same build (X68Sound: a TL 0
  carrier 3660/32768, PCM8 volume 8 at full scale 26886/32768). The
  quarter read off the notes (quarterOf) was checked on the Sho set
  (g_shomdx2: 176-clock bars, 44 a quarter; two tracks carry 7-9-clock
  runs, hence the nine-in-ten rule).
- Ruled (2026-10-26): the OPM's voiced noise is fm8's `:mode noise`, not a
  `def-fm` on the `noise` channel — a voice there is fm8 under another name
  (its pitch, :tl, :alg), two ways to write one thing. `noise` stays the
  operator alone, for scores moved from the PSG targets.
- Ruled (2026-10-26, the user): the IR player's `drvBpm` rounding on the
  driver-less targets (0.02-0.04 % off the BPM, ~50 ms over a 2.5-minute
  MDX against MXDRV) stays — not to be "fixed". An import compared against
  its driver drifts that much; compare note lengths (on → off), not
  absolute times, past the first minute.
