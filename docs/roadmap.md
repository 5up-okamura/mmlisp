# MMLisp Roadmap

What is still ahead, and nothing else. What the language and the driver do now
is `docs/language.md` and `docs/driver.md`; how they got here is git and its
tags. The language baseline is v0.7, and it evolves in place from composition
needs (CLAUDE.md).

## Driver (MMLispDRV)

Its current limits are `driver.md` §11 — keep the two in step.

**Next:**

1. **Integration breadth** — more game-scene mappings worth shipping as
   examples beside `drv/sgdk/example`, and a hardware-verified reference
   build — heavy DMA workloads on hardware first (driver.md §11).
2. **Mid-song voice changes with no silence before them** — VOICE_SET
   bodies in the sample-bank ROM, so a voice change is one pair instead of
   the ~30 register writes a channel costs today. A change after a rest or a
   cut note is already sent ahead in the silence (`voice-hoist.js`) and is
   not late; what this buys is several channels changing voice legato on one
   beat. Measured, not built: only `pcm1` (and a score without PCM) has the
   spare cycles to write a body from ROM faster than the wire; waits for a
   score whose key-ons are still late after the hoist.
3. **Several scores resident at once** (DJ-style transitions, driver.md §2.3).
   Today one score is resident; a bundle's songs share one sample bank.

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

- **The target an import is for.** A voice or sample import joins the open
  score, whatever its `:target`. A song import is a conversion, written as a
  new document for a machine its importer knows — not for every target: an
  importer writes only what it is built to write, and offers only that. The
  mucom importer writes pc88 (the song's own chip, the default) or md, chosen
  in its import dialog; VGM writes md or the machine of its chip — x68k for
  a YM2151's, pc88 for a YM2608's or YM2203's, msx for an AY-3-8910's —
  chosen in its dialog; MIDI and DefleMask / Furnace write md and show no
  choice; MDX writes x68k and MGS msx, their songs' own machines. A target is added to an importer when a song needs it, not to fill
  the matrix.
- **mucom**: part G's per-sound pan `p$xy` is not read.
- **MGS**: an envelope's wave changes as it runs (a note keeps the first),
  `#psg_tune` / `#opll_tune`, `@\` on FM.
- **MDX**: the OPM LFO's sync, MP / MA's random shape, and their phase: MXDRV restarts
  them at a note only under an MD, where the import restarts them always.
- **VGM**: tempo changes within a song (one grid serves the whole file — Dino
  Land's title theme estimates a 64th-note grid for all of it); fewer shapes,
  if wanted — envelopes and bends match exactly (TwinBee gives ~26
  envelopes), and rounding near ones together is the lever;
  second chips, the YM2608's rhythm and ADPCM-B (onto pc88's rhythm and
  pcm1), the MSX's FM-PAC and SCC (onto msx's fm and wave channels), the
  remaining PCM chips (OKI MSM6295, QSound, K054539, C140, …).
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

Built: the PC-8801 (`pc88`), the X68000 (`x68k`) and the MSX with the SCC
and the FM-PAC (`msx`) — language.md §19. Next:

1. **Famicom: the 2A03.** New to the language: pulse duty, a triangle
   without a level (the level model needs targets that have none), the
   noise's two modes, and the DPCM as a one-voice kit of user samples at
   sixteen fixed rates. Expansions are decided by voice class, not one by one:
   the 5B is the SSG profile, the VRC7 the OPLL's, the FDS the wavetable
   class. VRC6, N163 and MMC5 have no VGM block, which bounds the set.

Emulators for the preview: ymfm (BSD) covers the YM2608, YM2151, YM2413,
Y8950 and the SSG in one library, built to WASM beside the Nuked cores.
