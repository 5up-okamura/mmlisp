# MMLisp Roadmap

What is still ahead, and nothing else. What the language and the driver do now
is `docs/language.md` and `docs/driver.md`; how they got here is git and its
tags. The language baseline is v0.7, and it evolves in place from composition
needs (CLAUDE.md).

## Driver (MMLispDRV)

Its current limits are `driver.md` §11 — keep the two in step.

**Before release:**

- **A hardware run.** Everything — the three engine images at a 100% work
  ceiling, the multi-bank engine, sound effects in the SGDK example — has run
  only in the JS machine and on BlastEm.

**Next:**

1. **Mid-song voice changes** — VOICE_SET bodies in the sample-bank ROM, so a
   voice change is one pair instead of the ~30 register writes a channel costs
   today.
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
- **`if` / `for` / def-functions**, and what eval enables past them:
  algorithmic composition, parametric phrases as real functions, signal
  composition (`(+ (sin) (saw))`, `(* env lfo)`), curves as a standard library.
  The signal-⊕ region model's first relaxation is loop⊕one-shot, which a
  baked `env × lfo` AM needs (runtime AM is the scaled macro today).
- **Quantize snap** — a scale mask applied after the pitch sum.
- **OP mask** — per-channel operator enable/disable.
- **Dynamic performance branches** — `|` alternation, random part switching,
  random label jump.

## Importers

- **mucom88**: the MML is imported whole. What a Mega Drive cannot hold is
  reinterpreted, not carried: part G's rhythm plays the RX5 kit, the ADPCM
  part its decoded `#pcm` bank, and the SSG lands on the PSG's coarser steps.
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

**A patch ecosystem on `import`.** `(import "path")` already merges another
file's defs at compile time (language.md §9.2); the idea keeps that surface
and adds sources — `(import "dx7-brass" :from :patches)`, a community URL —
resolved at compile time, version-pinned for reproducibility. Patches would be
FM voices and function effects (delay, arpeggiator, LFO), each with author,
license, version and lineage (`fork_of`); previews synthesize in the browser,
since the chip emulators are already there.

**MMLisp as the composing tool for a Z80 stream player.** For a game that
cannot spare the 68000: the score exported as a pre-rendered stream (Live's
VGM export → xgmtool → XGM works today, without runtime parameter motion),
played by a small Z80 player with a little added on top — per-channel level
offsets on the carrier TL writes, part swapping between layered variant
streams, and `(trig N)` markers so the game can sync to bars.

**Multi-chip.** The IR is chip-agnostic; only the backend (MMB exporter and
driver) is chip-specific. YM2151 (OPM), YM2413 (OPLL), SID, the NES 2A03 and
the PC Engine's HuC6280 would each need a target profile, a register encoder
and a JS emulator.
