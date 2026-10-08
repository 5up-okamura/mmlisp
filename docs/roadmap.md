# MMLisp Roadmap

What is still ahead, and nothing else. What the language and the driver do now
is `docs/language.md` and `docs/driver.md`; how they got here is git and its
tags. The language baseline is v0.7, and it evolves in place from composition
needs (CLAUDE.md).

Items marked *to discuss* wait for a decision before anyone builds them.

## Driver (MMLispDRV)

Its current limits are `driver.md` §11 — keep the two in step.

1. **A hardware run.** Everything — the three engine images at a 100% work
   ceiling, the multi-bank engine, sound effects in the SGDK example — has run
   only in the JS machine and on BlastEm.
2. **Wire budget** (*to discuss*). 960 pairs a second; the opening setup is
   primed at load, but a mid-song change still has to fit through. Candidates,
   in this order: **PCM STAGE** (the sequencer peeks a track's next PCM note
   and stages its sample, so the note's START is one pair); **ordinary FM3 in
   the short-group priority**; **key-ons last** on the banked converter too.
3. **Voice-hoist windows** (*to discuss*). The windows a voice change may move
   into are fixed (a rest of 4 frames, a note cut of 2); a song-level setting
   to widen them was discussed and is not built.
4. **Mid-song voice changes** — VOICE_SET bodies in the sample-bank ROM, so a
   voice change is one pair instead of the ~30 register writes a channel costs
   today.
5. **Several scores resident at once** (DJ-style transitions, driver.md §2.3).
   Today one score is resident; a bundle's songs share one sample bank.
6. **PAL and SE rough edges.** A single-bank PAL score's samples are baked at
   the NTSC DAC rate (the multi-bank images have PAL rates of their own). A
   PCM effect restarts a looping BGM note from the sample's head rather than
   where it was, and a sweep in flight on a stolen channel is lost rather than
   resumed.
7. **A small Z80-only build** (*to discuss*) — sequencer and engine both on
   the Z80, for a game that cannot spare the 68000. Its PCM rate (a
   Timer-A-paced 10,653 Hz rather than 10,112) is part of that discussion.
8. **Integration breadth** — more game-scene mappings worth shipping as
   examples beside `drv/sgdk/example`, and a hardware-verified reference
   build.

## Language

- **Slot-fed macro-curve params, live.** A macro curve's `:from`/`:to`/
  `:rate`/`:len`, and a sweep's `:len`, bake to their slot's init on the
  driver; reading them at note-on would make them as live as an inline
  sweep's endpoints.
- **The compile-time shadow fold** (parked) — folding static bases at compile
  time instead of emitting the arithmetic.
- **`if` / `for` / def-functions**, and what eval enables past them:
  algorithmic composition, parametric phrases as real functions, signal
  composition (`(+ (sin) (saw))`, `(* env lfo)`), curves as a standard library.
- **Quantize snap** — a scale mask applied after the pitch sum.
- **OP mask** — per-channel operator enable/disable.
- **Dynamic performance branches** — `|` alternation, random part switching,
  random label jump.

## Importers

- **mucom88**: `S` FM3 slot detune (13 reference songs; maps onto
  `fm3-1`–`fm3-4` with a per-operator `:pitch`), `s` key-on revise. Part G is
  the OPNA's rhythm ROM — there is no data to import.
- **VGM**: tempo changes within a song (one grid serves the whole file),
  second chips, other chips' PCM (SegaPCM, YM2610 ADPCM, OKI).
- **DefleMask / Furnace**: sample channels, the macros of pre-INS2 Furnace
  instruments, subsongs after the first.
- **MIDI**: per-note pan and CC changes after the first.

## MMLisp Live

- A score's own `def-pcm` is not auditioned from the voice picker.
- Touch has no add-cursor gesture.

## Future vision

**A patch ecosystem on `import`.** `(import "path")` already merges another
file's defs at compile time (language.md §9.2); the idea keeps that surface
and adds sources — `(import "dx7-brass" :from :patches)`, a community URL —
resolved at compile time, version-pinned for reproducibility. Patches would be
FM voices and function effects (delay, arpeggiator, LFO), each with author,
license, version and lineage (`fork_of`); previews synthesize in the browser,
since the chip emulators are already there.

**Multi-chip.** The IR is chip-agnostic; only the backend (MMB exporter and
driver) is chip-specific. YM2151 (OPM), YM2413 (OPLL), SID, the NES 2A03 and
the PC Engine's HuC6280 would each need a target profile, a register encoder
and a JS emulator.
