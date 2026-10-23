# MMLisp Roadmap

What is still ahead, and nothing else. What the language and the driver do now
is `docs/language.md` and `docs/driver.md`; how they got here is git and its
tags. The language baseline is v0.7, and it evolves in place from composition
needs (CLAUDE.md).

## Driver (MMLispDRV)

Its current limits are `driver.md` §11 — keep the two in step.

**Next:**

1. **Mid-song voice changes with no silence before them** — VOICE_SET
   bodies in the sample-bank ROM, so a voice change is one pair instead of
   the ~30 register writes a channel costs today. A change after a rest or a
   cut note is already sent ahead in the silence (`voice-hoist.js`) and is
   not late; what this buys is several channels changing voice legato on one
   beat.
2. **Several scores resident at once** (DJ-style transitions, driver.md §2.3).
   Today one score is resident; a bundle's songs share one sample bank.
3. **Single-bank PAL samples** are baked at the NTSC DAC rate (the multi-bank
   images have PAL rates of their own).
4. **Integration breadth** — more game-scene mappings worth shipping as
   examples beside `drv/sgdk/example`, and a hardware-verified reference
   build.

## Language

- **Slot-fed macro-curve params, live.** A macro curve's `:from`/`:to`/
  `:rate`/`:len`, and a sweep's `:len`, bake to their slot's init on the
  driver; reading them at note-on would make them as live as an inline
  sweep's endpoints.
- **The compile-time shadow fold** (parked) — folding static bases at compile
  time instead of emitting the arithmetic. A folded `:tl1+ 3` would be
  relative to the value the score wrote, missing a host write in between;
  `(+ $tl1 3)` would stay the live reading.
- **Recursive def-functions**, and what eval enables past them: curves as a
  standard library, signal composition (`(+ (sin) (saw))`, `(* env lfo)`).
  All of it compile time — the driver gains no evaluator, so `if` (§7.6)
  cannot test a `$` value. A parametric def already returns a value
  (`(def (oct x) (* 12 x))`); what it cannot do is call itself, because defs
  expand before anything evaluates — recursion needs a call expanded when the
  evaluator reaches it, which waits for a score that needs it. `and` / `or`
  join the comparisons when one does. `for` (§7.5) binds numbers only; a
  `for` over tokens (note names, samples, lengths) is the next step if
  writing chords as MIDI offsets proves awkward, and a value-position `for`
  that builds a step vector after that.
  The signal-⊕ region model's first relaxation is loop⊕one-shot, which a
  baked `env × lfo` AM needs (runtime AM is the scaled macro today).
- **OP mask** — per-channel operator enable/disable.
- **More PCM tracks than voices** (considered, waiting for a score that
  needs it). `:pcm-voices 2` keeps the 10.1 kHz rate; pcm1–pcm3 written
  beside it would flatten by the `:prio` rule the layers already use, so
  where three overlap the lowest drops, and the compiler counts the drops.
  Opt-in by writing more tracks than voices; a merged bake of the overlaps
  was the alternative, rejected for growing the bank unseen.
- **Dynamic performance branches** — `|` alternation, random part switching,
  random label jump.

## Importers

- **The target an import is for.** An import writes the open score's
  `:target` (the machine is the language's to say, not a dialog's): a voice
  or sample import joins that score, and a song import — MIDI, VGM,
  DefleMask / Furnace, mucom — writes a new document for the same target,
  its lanes placed on that target's channel table by kind (FM, tone, noise,
  sample) instead of the Mega Drive's names. What the importer knows is the
  file's chips, not where the music came from or went: the VGM header's
  clocks, the module's system id, a `.muc` is MUCOM88's and so the YM2608's,
  MIDI has none. Where they differ from the target's, the import says what it
  read as what ("a YM2608 song, read for md; for pc88 write
  `(def-score :target pc88)` first"); what the target lacks is dropped and
  said so, as today. The importers take `target` and Live passes the open
  score's; the mucom importer writes md and pc88 (guide.md, "For pc88"),
  the others md, and say so for any other.
- **mucom**: part G's per-sound pan `p$xy` is not read.
- **VGM**: tempo changes within a song (one grid serves the whole file — Dino
  Land's title theme estimates a 64th-note grid for all of it); fewer shapes,
  if wanted — envelopes and bends match exactly (TwinBee gives ~26
  envelopes), and rounding near ones together is the lever;
  second chips, the YM2608's rhythm and ADPCM-B, the remaining PCM chips (OKI
  MSM6295, QSound, K054539, C140, …).
- **DefleMask / Furnace**: sample channels, the macros of pre-INS2 Furnace
  instruments, subsongs after the first.
- **MIDI**: per-note pan (a channel's first pan serves the song), and CC7/CC11
  moving during a note (they are read at each note-on).

## MMLisp Live

- A score's own `def-pcm` is not auditioned from the voice picker: its `:file`
  is relative to the score's folder, which the picker's stand-in score lacks.
- Dragging the piano roll's background to seek (in the mockup, left out; not
  decided).

## Future vision

**MMLisp as the composing tool for a Z80 stream player.** For a game that
cannot spare the 68000: the score exported as a pre-rendered stream (Live's
VGM export → xgmtool → XGM works today, without runtime parameter motion),
played by a small Z80 player with a little added on top — per-channel level
offsets on the carrier TL writes, part swapping between layered variant
streams, and `(trig N)` markers so the game can sync to bars.

**Other machines, as VGM.** The IR is chip-agnostic; only the backend is
chip-specific. The Mega Drive keeps its driver and its integrated environment.
Every other machine gets a *target profile*, a register encoder, a browser
emulator for the preview and a VGM chip block — and no driver of its own: the
score is composed in Live and delivered as a VGM, which existing players run.
Live's preview and the VGM come from the same register log, so they match by
construction, as the driver's A/B gate does today. What this gives up is
hardware playback and game integration, deliberately (VGMPlay-MSX plays the
MSX VGMs on hardware regardless).

A target profile is a first-class part of the language: the channel table,
which parameters exist and their ranges (language.md §7.0's "target's base",
`E_UNSUPPORTED_TARGET`), the pitch table for the chip's clock, the voice
classes it can play, its PCM voices and their constraints, and its kit (below).
A *portable core* — notes, lengths, flow, the vel/pitch/pan curves, 4-op FM
voices on the OPN/OPM family, square + noise — compiles for every target; a
target's own features (FM3 special mode, SSG-EG, duty, waves) are a diagnostic
on any other, and its own settings a warning.

In order:

1. **PC-8801 SB2 (YM2608): the sound.** A `:target pc88` score compiles,
   exports VGM 1.51 — FM, the SSG, the rhythm and the ADPCM-B with its
   RAM image — and plays and renders WAV through ymfm's YM2608, its rhythm
   from the user's own ROM or, without one, the kit's `:file`s in the ROM's
   layout (language.md §19; the
   profile is `live/src/targets/pc88.js`, the chip `live/src/chips/ym2608.js`,
   the synth `live/src/synth-pc88.js`, the scores `tools/tests/pc88/`). What
   is left, in order:
   - **`:keyon` macros on the PCM**: a step re-keying the rhythm sound or
     the ADPCM-B note (a roll, a flam); the levels move, the re-key is not
     played yet.
   - **The check, what is left**: the mucom importer's pc88 scores against
     the real driver's VGM (the A/B the importer was tuned with). FM keys and
     pitch, the rhythm's hits, levels and pan, and the SSG's mixer match,
     and its levels mostly (70–99% exact, 86–100% within a step). Open: a
     `v` move inside a tie (one fader step, where mucom's level × (v+1)
     moves less near the sustain), a `q` note's release start, a hit
     quieter than the IL's 31 steps (RTL stays 63). K's notes, Delta-N,
     level and pan match (14 of 16 songs to within 1 dB); open are its
     volume mode `vm<n>`, its detune `D` (a PCM track takes no `:pitch`),
     and mucom's Delta-N table, which runs a few cents sharp of equal
     temperament above C (`+200` on every note).
   - **The preview's scope**: ymfm gives no per-channel outputs, so the
     oscilloscope stays blank on a `pc88` score.
2. **X68000 (YM2151 + MSM6258).** OPM voices convert from OPN with DT2 = 0
   and SSG-EG dropped; KC/KF pitch and channel 8's noise are the profile's.
   PCM8 is a software mixer, not a chip, so the export does its job: pcm1-3
   are mixed into the one MSM6258 ADPCM stream at the chip's fixed rate, with
   pitch absorbed in that mix (`pcm-model.js`'s lineage).
3. **MSX: PSG, then SCC.** The PSG is the SSG profile again. The SCC brings
   the *wavetable* voice class, which the PC Engine, the FDS and the Game Boy
   share later. The FM-PAC (OPLL: 2-op, fifteen preset voices and one user
   voice) is a different composing surface that none of the 4-op voice assets
   reach, so it waits for a 2-op voice form; MSX-Audio is left out.
4. **Famicom: the 2A03.** New to the language: pulse duty, a triangle
   without a level (the level model needs targets that have none), the
   noise's two modes, and the DPCM as a one-voice kit of user samples at
   sixteen fixed rates. Expansions are decided by voice class, not one by one:
   the 5B is the SSG profile, the VRC7 the OPLL's, the FDS the wavetable
   class. VRC6, N163 and MMC5 have no VGM block, which bounds the set.

Emulators for the preview: ymfm (BSD) covers the YM2608, YM2151, YM2413,
Y8950 and the SSG in one library, built to WASM beside the Nuked cores.
