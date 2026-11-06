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
  sweep's endpoints. Wanted; held on its implementation's cost against what
  it buys (`.claude/memory/language-open.md`).
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
- **More PCM tracks than voices** (considered, waiting for a score that
  needs it). `:pcm-voices 2` keeps the 10.1 kHz rate; pcm1–pcm3 written
  beside it would flatten by the `:prio` rule the layers already use, so
  where three overlap the lowest drops, and the compiler counts the drops.
  Opt-in by writing more tracks than voices; a merged bake of the overlaps
  was the alternative, rejected for growing the bank unseen.
- **Dynamic performance branches** — `|` alternation, random part switching,
  random label jump.
- **Wave generators** — a wave written as its harmonics (`(harmonics 1 0.5
  0.33)` …), once the wave expressions are in use.

## Importers

- **The target an import is for.** A voice or sample import joins the open
  score, whatever its `:target`. A song import is a conversion, written as a
  new document for the machine chosen in its dialog: MIDI for any target;
  VGM, NSF and DefleMask / Furnace for their chips' own machine (the
  default) or any machine whose defaults keep half the notes
  (`import-song.js` holdsSong); mucom for pc88 (the default) or md; MDX for
  x68k and MGS for msx, their songs' own machines.
- **mucom**: part G's per-sound pan `p$xy` is not read.
- **MGS**: an envelope's wave changes as it runs (a note keeps the first),
  `#psg_tune` / `#opll_tune`, `@\` on FM.
- **MDX**: the OPM LFO's sync, MP / MA's random shape, and their phase: MXDRV restarts
  them at a note only under an MD, where the import restarts them always.
- **MIDI timed by its notes**: a pickup in a song with no GM kick and
  snare, and a change of meter or tempo within a song (bestBars and one
  estimated grid serve the whole file).
- **VGM** (timed as written, not as beats): fewer shapes,
  if wanted — envelopes and bends match exactly (TwinBee gives ~26
  envelopes), and rounding near ones together is the lever;
  second chips (a YM2203's aside: they are counted, not read), a wave rewritten
  under a sounding note (the HuC6280's; the SCC's is a `:wave` macro), the
  HuC6280's DDA and LFO, the
  remaining PCM chips (QSound, K054539, uPD7759, C219, …).
- **DefleMask / Furnace**: sample channels (SegaPCM, ADPCM-A/B, the
  MSM6258 — x68k's pcm1–pcm8 could take them), subsongs after the first, a
  module chip's own clock (the SSG's envelope rate is read on the
  target's), the AY envelope's shape moving in its macro (the first step
  serves), a YM2413 drum note's pitch (each hit at c4). On
  the PC Engine: the LFO and DDA effects, a duty macro switching noise and
  wave under a note (its first step serves), and the phase a wave loads at
  (Furnace's anti-click carries the running phase over; a load here starts
  the wave from its first step).
- **MIDI**: per-note pan (a channel's first pan serves the song), and CC7/CC11
  moving during a note (they are read at each note-on).
- **Game Boy**: a `.gbs` import (an LR35902 run, as NSF's 6502); a tracker's
  13xy / 14xx sweep (left out); a wave rewritten under a note, a VGM's CPU
  PCM through the wave memory, and NR50 (not followed).

## MMLisp Live

- A score's own `def-pcm` is not auditioned from the voice picker: its `:file`
  is relative to the score's folder, which the picker's stand-in score lacks.
- **Drawing on a stage vector** in the panel's vector editor: a macro's
  stages are shown, not drawn (edit-tools.js `vectorAt`).
- **The panel's editors follow playback.** What is heard and what is shown
  agree: the vector editor marks the step a playing macro is at, the sample
  editor the position in the wave a playing sample is at — as the source's
  playhead already follows the note. The player reports a position per frame
  (channel, macro or sample, step or frame), as the PC Engine's DDA already
  streams a frame's writes; the panel draws a mark over the subject it
  shows. Where one def plays on several tracks, the newest note's position
  is shown.

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
classes it can play, its PCM voices and their constraints, and its kit.
A *portable core* — notes, lengths, flow, the vel/pitch/pan curves, 4-op FM
voices on the OPN/OPM family, square + noise — compiles for every target; a
target's own features (FM3 special mode, SSG-EG, duty, waves) are a diagnostic
on any other, and its own settings a warning.

Built: the PC-8801 (`pc88`), the X68000 (`x68k`), the MSX with the SCC
and the FM-PAC (`msx`), the PC Engine (`pce`: its waves, noise, `:pan`,
LFO and DDA, DefleMask / Furnace PCE modules and HuC6280 VGMs as `pce`
scores), the Famicom (`fc`: the 2A03's pulses with `:duty`, the
triangle with no level, the noise's rates and two modes, the DMC's
samples, and the six expansion chips — VRC6, FDS, MMC5, 5B, VRC7, N163;
VGMs, NSFs and DefleMask / Furnace NES modules as `fc` scores) and the
Game Boy (`gb`: its pulses, wave and noise, a level free under a note, VGMs
and DefleMask / Furnace modules as `gb` scores) — language.md §19. Next:

1. **Famicom: ppmck's MML** in, if a composer's files call for it.

Emulators for the preview: ymfm (BSD) covers the YM2608, YM2151, YM2413,
Y8950 and the SSG in one library, built to WASM beside the Nuked cores.
