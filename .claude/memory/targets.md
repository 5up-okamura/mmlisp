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

- **The PC Engine came first**, the Famicom after it: the PCE fit the parts
  as they were (a wave, a noise sharing its channel); the 2A03 brought new
  words (`:duty`, a triangle with no level, DPCM).
- **pce is built** (language.md §19; chips/huc6280.js, targets/pce.js,
  synth-pce.js). What the docs do not say:
  - The chip is read from MAME's c6280.cpp and Mednafen's pce_psg.cpp
    (they agree); the noise at rate 31 clocks every 32 (Mednafen).
  - A noise note is a rate index, not a Hz: the rates are LFSR clocks (1.8
    kHz up), so a Hz mapping put every note at rate 0.
  - A wave named under a note is written there, as Furnace does (the
    load's channel-off is turned back on in the same writes); it was held
    to the next key-on until Bad Dudes showed instruments stepping waves
    through a note (654×) — the reason `(macro :wave …)` exists. A wave
    step naming the wave already playing writes nothing, as Furnace's
    macro does; inline `:wave` always writes.
  - The LFO's depth is in period steps (±16/64/256), so a deep one wraps
    the 12-bit period (Mednafen's & 0xFFF) — not clamped. Measured: a4 at
    :fms 1 / 2 sways ±20 / ±70 Hz.
  - DDA's bytes go out on the CPU timer (`_writeTimer`, not the frame
    snap), a frame at a time (`_ddaFrame`), so another name's note
    dispatched meanwhile can cut the hit. Live gets a frame's ticks as one
    `stream` message: per-write messages stalled the page ~100 ms; streams
    measured as a wave-only score (p95 ~3 ms).
  - Furnace import fidelity is held to Furnace's own VGM of a song, frame
    by frame (pitch, level, wave up to rotation, noise/wave) — a scratch
    tool, not in the repo; Bad Dudes: channels 1-5 match, 6 differs by its
    duty flicker (roadmap).
- **Open:** Bad Dudes as imported since the `:wave` macro is not yet
  listened to in Live.

## The Famicom (fc) — the design, ruled 2026-10-27; stages 1-3 built

Build it as pce was built (chips/huc6280.js, targets/pce.js, synth-pce.js,
tools/tests/pce are the pattern), in stages: 1. pulses, triangle, noise;
2. DPCM; 3. DefleMask / Furnace NES modules as fc (import-tracker.js
already reads them) and VGM 0xB4. The expansions: their own section
below. Facts are from memory: hold every table to
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
  the :mode macro on the pitched noise lane. Open: no VGM player has
  checked the 0xB4 output.
- **Stage 2 (DPCM) built 2026-10-27** (fcDpcm, `frames: true` as pce's
  DDA; ir-player `_dispatchDpcmEvent`, `_dmcRateOf`). The memory is the
  chip's port 1 (RAM_PORT: an address latch, then bytes), a VGM 0xC2 block
  a run (export-vgm `ramBlock`); Live gets a hit's load as one `stream`
  message. Every hit loads its bytes to $C000 — no cache of what is
  resident: a VGM's loop jumps back with the RAM as the song's end left it,
  so a skip decided on the first pass would play the wrong bytes after it.
  The load goes DMC_LOAD_LEAD_SECS (0.5 ms) ahead of the frame's start
  writes (streams and timed writes are separate queues in the worklet).
  In Live the start goes as a stream too: the worklet writes timed writes
  at its 128-sample block's start but streams at their sample, so a start
  sent timed played the previous hit's bytes for up to a block. A seek
  does not replay the loads (`_ramPorts`). Left as they are (review,
  2026-10-27): a restart under a sounding hit carries up to 16 of its bits
  past $4011 (a DC offset, as on the chip); a `:len 0` hold on pcm1 is not
  released by triggerKeyOff (DDA's the same: sample handlers do not
  register holds). A long song's VGM grows a block a hit.
- **Songs in, ruled 2026-10-27 (the user): VGM first, then Furnace /
  DefleMask NES modules, ppmck's MML only if wanted** (NSF came after the
  expansions, 2026-10-29: its own section below). VGM built
  2026-10-27 (import-vgm.js apuChip): the length and linear counters and
  the envelope run between writes (`advance`), so a note ends where its
  counter ran out and an envelope is a level envelope; the sweep is only
  counted; a DMC hit's sample is the memory as it stood (`bytes` on the
  hit, identity by content) since 0xC2 blocks rewrite it (bank switches);
  `$4011` written on and on is counted as CPU PCM, not imported. A review
  (2026-10-27) fixed: the 5-step frame counter (QUARTER on $4017, the
  average), a joint period + level write read as a strike only where the
  level came up or the pitch jumped ≥ 50 cents (a volume macro under a
  vibrato is one note), an envelope's steps never emitted before the last
  write (event order per key), a looping envelope kept on through its 0,
  the divider read from a $4000 written after $4003, the counters starting
  at 0, the triangle's reload with the flag still set, a duty step within
  4 frames of a note's start folded into it (the attack's macro: the note
  takes the value it settles on), a note quantized onto the one before
  keeping that one's slur, $4011 counted only on a change, a DMC hit
  before any 0xC2 block lost. Approximations kept: a halt cleared under a
  held counter leaves it held; the sweep's mute of a high period (negate
  clear, target > $7FF) is not applied; $4017's immediate clock in 5-step
  mode is not.
- Held to real rips (2026-10-27, the user's vgmrips packs, kept outside
  the repo in their Dropbox: Balloon Fight, SMB3, Kirby, Contra, Super
  Contra, Fantasy Zone): scratchpad abfc.mjs renders the VGM's own writes
  and the import's on FcSynth and compares each channel a frame at a time
  (sounding ±1 frame, the chip's own periods). What it found and fixed:
  most rips never write $4015 (an NSF player sets it) — start enabled;
  a length counter's sub-frame blip was a 1-tick note that keyed off in its
  own frame before it keyed on (the encoder now queues a same-time key-off
  behind its key-on; the import gives a note a frame at least on a
  frame-clocked target); the triangle's reload is taken at the next quarter
  frame from $4008 as it is then (drivers write $400B before $4008); a
  strike is a level up or a pitch jump within a setup burst (2 ms), not at
  the exact same sample; no tuning estimate for the 2A03; the sweep is
  followed on half frames (and its mute); pitchShape keeps a fall that goes
  on into the note's last two frames, and a burst's last pitch only (a
  period written a byte at a time); the triangle's $400B is a new note but
  in a glide (decided once the burst's low byte is in — Gimmick writes
  $400B first); bendSpec's chained lines start a frame in (a curve plays
  both its ends, so each joint held two frames). After those, most tracks
  agree to a few frames (Gimmick 01 TRI pitch 59 → 87 %, Balloon Fight 07
  SQ1 19 → 49 %: the rest is a fast fall a sub-frame off the frame grid).
  A note that stops dead before a rest no longer takes a shared envelope
  with a #rel (`silentAfter` in assignEnvelopes; Kirby 03 SQ1's extra
  frames 222 → 50). Open: those 50 are a staccato note held to the grid's
  unit (2.7 frames sounding as a 32nd's 5 at Kirby's tempo) at its
  sustain level; Kirby's DPCM not A/B'd. (A VGM's 5B and VRC7 land on
  fc's own chips: the expansions' section.)
- DefleMask / Furnace NES modules built 2026-10-27 (import-tracker.js, the
  readers' NES channels `chip: "nes"`), read from Furnace's nes.cpp
  (fetched): the noise's register rate 15 − (note & 15) under
  properNoiseLayout, else its 253-entry noiseTable (DMFs); the duty
  macro's first step the noise's mode (&1, or > 1 → 1); the volume macro
  and column (VOL_SCALE_LINEAR_BROKEN) multiply under newVolumeScaling
  (in dB they add: the column :vel, the macro :vol) and otherwise add their
  4-bit steps (VOL_SCALE_LOG, clamp(v + m − 15)): DMFs and .fur < 99 (the
  flag the compat block's tenth byte, or CFLG's key), a :vol def per
  column; the triangle on while a volume macro is not 0;
  the pulses' duty 0 (12.5 %) until something sets it, and a duty macro's
  last step held after its note. Open: Furnace's 22 NES demos
  (/Applications/Furnace/demos/nes) import and compile clean (2026-10-27),
  none A/B'd against Furnace's own VGM yet; 649 of the 650 real .dmf in
  the user's Dropbox (41 NES, v5.1 on) import and compile (2026-10-28; the
  one left, Darius II "06 War Oh!", is corrupt at instrument 131), none
  heard against DefleMask; a fixed-pitch arpeggio (drums) is a :semi from the
  played note, an env a note (2026-10-28), not heard against Furnace yet;
  module DPCM (.fur SMP2/SMPL 8/16-bit and 1-bit DPCM; DMF samples and the
  legacy sample mode as convertLegacySamples, 2026-10-28; the DAC start
  `dpcmDelta`, a loop's part, a sample instrument's pitch and a DMF's DPCM
  at the sample's rate rather than a DMC rate not cross-checked against
  Furnace by ear); the level under a sounding note (a column without a
  note, 0Axy and its kin) as a level line (2026-10-28: :vol under the
  note's top :vel, :vel on fc / pce), not heard against Furnace — and a
  DMF's additive volume macro on fc stays baked at the note's column while
  the line moves it; the duty's
  12xx on a DMF read as Furnace's (DefleMask's own NES 12xx not
  cross-checked). The curve option `:duty` is 1–255 (128 = 50 %) while the track
  word is in sixteenths, as ruled — two scales under one name; raise it if
  it confuses. The Live page labels lanes 0-3 S1 S2 S3 N1 (tri shows S3).

## The Famicom's expansions (built 2026-10-28/29)

All six are on fc (language.md §19 fc says what the language does): VRC6,
FDS, MMC5, 5B, VRC7, N163 — any number in one score, each an optional chip
started at its first write, named by chip (the user, 2026-10-29).

Where things are (dev-only):
- Ports: 0 APU, 1 DMC RAM, (2 the worklet's PSG flag), 3 VRC6, 4 FDS (VGM
  0xB4's numbering), 5 MMC5, 6 5B, 7 VRC7, 8 N163 (its RAM). Tone lanes:
  VRC6 12-14, MMC5 15-16, 5B 17-20, N163 21-28. Scope: VRC7 0-5, APU 6-10,
  VRC6 11-13, FDS 14, MMC5 15-16, 5B 17-19, N163 20-27.
- chips/queued-tone.js: the VRC6's and the MMC5's encoder. The 5B is
  ssgEncoder on port 6; ir-player `_psg(encode, method, lane)` routes the
  SSG's song words to it (the APU has no noise period / envelope) and
  `_isNoiseLane` makes 5b-noise a noise lane. The VRC7 is opllEncoder({rom,
  channels, port}); a part's `rom` / `romNames` are its built-in voices.
  The N163's layout comes from the score (ir-player `_voicesOf` → the
  encoder; its `start()` replaces the chip's static init).
- mmlisp2ir: a song word only optional chips own, in a score naming none of
  their channels, is E_TARGET (fc's :noise-rate, :lfo-*).

Open:
- None heard in Live but the VRC6 and the FDS's test score (MMC5, 5B,
  VRC7, N163; the N163's 7-8-channel whine).
- Levels against the 2A03 are choices, not measures: each at full = a 2A03
  pulse at full (the 5B "very loud" per nesdev, its amp's nonlinearity not
  modelled; the N163's boards 11-19.5 dB louder). Every chip at once clips.
- The VRC6 mix not held to Mesen's; its saw's step order NSFPlay's.
- The FDS: a real song heard only from VGM (Zelda II's title); a Furnace /
  DefleMask FDS module checked only as one built in node; its hardware
  envelopes only node-checked (no score or import drives them); the mod
  arithmetic nesdev's, not held to NSFPlay / Mesen.
- The VRC7 is ymfm's YM2413 with the VRC7's ROM, not a DS1001 model.
- :lfo-wave starts the FDS's counter over, so the structured writer's
  restatements (all switches rewritten where the set of kinds changes, a
  def's or a loop's head) add resets the game did not make — a free-
  running modulation's phase jumps there. Not decided (2026-10-29).
- Every fc render starts with a click, probably the DMC's $4011 init write
  (seen 2026-10-29, not checked or fixed).

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

## NSF in (built 2026-10-29)

import-nsf.js runs each song on cpu6502.js and feeds import-vgm.js's chip
models (`nesChips`: the VGM ones, plus vrc6Chip, n163Chip and apuChip's
`mmc5` mode, none of which a VGM reaches). Rulings (the user, 2026-10-29):
the VGM dialog and writer reused, a Song field that re-runs; the length is
the state coming round (RAM $0000-$07FF + $6000-$7FFF + the banks — not the
chips' registers, which would put the loop a section late), else the
writes' period (two periods, ≥ 1 s), else MAX_SECONDS 300; the loop point
settled onto the first frame that writes something new; an N163 wave on 32
steps at its own pitch (the language keeps 32 / 16; a wave length in the
language is a separate discussion, not proposed here).

Open:
- Held to synthesized NSFs (tools check:import-nsf), one headless run of
  Live's dialog, and two real NSFs against their VGM rips (the import
  session's review, 2026-10-29): SMB3 song 1 loops at 0 and ends at 14.40 s
  (the rip 14.38), the same strikes; Falsion song 1 (FDS) comes round at
  89.6 s where the rip loops at 44.7 — its driver detunes pulse 2 by one
  period step every other pass ($4006 aa/a9), so two passes are the exact
  loop (kept: not halved to the rip's). Not A/B'd by ear or frame by frame
  (abfc.mjs's comparison is the plan).
- A play call's writes land a few cycles apart, so a strike and its
  retrig in one burst (0.1 ms) count as two notes in the dialog's row
  counts (SMB3's noise 133 against the rip's 85); the score keeps the later
  of two on one tick, so it is unchanged.
- The 6502's cycles are base counts (+ branch and page crossing), not
  bus-exact; $4015 and the FDS's other registers read back 0 — a driver
  waiting on the DMC's or a length counter's status would misread.
- VRC6 / N163 notes are keyed by level (no key bit): a pitch jump at a held
  level is a slur, as the 5B's and the FDS's are from VGM; $9003's
  frequency shift is not followed (its halt is).
- The FDS's state hash leaves out its RAM above $7FFF (a driver keeping
  its state there falls to the writes' period).

