# Song importers — the user's decisions, and what is open

The importers (MIDI, VGM with the YM2612 DAC, DefleMask / Furnace) and VGM
export with PCM are built; the behaviour is `docs/guide.md` §23, the code
`live/src/import-*.js` (`import-song.js` the shared back end). This file
keeps why they are shaped as they are and what is left. Delete it once the
open items are settled or dropped.

## Decisions (user)

- **A dialog, defaults right** (2026-10-05): Enter alone imports; only what
  a user changes per file (destinations, tempo, timing, loop).
- **MIDI lanes** (2026-10-05): cut from the most polyphonic channels first;
  the GM bank's note offsets applied at import (the preset set does not).
- **VGM tempo is estimated** (2026-10-05), not a fixed frame grid; frames
  are the fallback.
- **Trackers: a pattern is a phrase def** (2026-10-05), the tracks naming
  them in order; a phrase restates the state it relies on.
- **VGM export PCM** (2026-10-05): the mixed DAC stream as one data block +
  `0x8n`, not DAC stream control (the engine mixes voices in software).
- **Structure over exactness** (2026-10-07): "the more structured, the
  easier to grasp." Repeats fold into `(x n …)` and `(x n A (break) B)`, a
  run used again elsewhere into a def; exact matches only (no transposed
  repeats yet), velocity compared at MMLisp's 16 steps.
- **Vibrato as a function, wobble rounded** (2026-10-07): a `(macro :pitch
  (sin …))` def beats a faithful per-frame array; depth and period are
  rounded so notes share defs. The same holds for tracker fine tune (E5xx to
  10 cents — DMF conversions tune every note).
- **MIDI modulation (CC1) is a fixed mapping** (2026-10-07), decided by us:
  127 → ±50 cents at 5.5 Hz, from 12 frames into the note (the user found an
  undelayed one wobbling throughout).
- **The envelope presets serve imports** (2026-10-07): level shapes are
  `:vel+` so a note's dynamics survive, pitch shapes are separate (vib,
  vib-delay, slide-up, drop) so they combine; a MIDI part on the PSG takes
  its GM family's shape.
- **The YM2612 DAC: one bank wav** (2026-10-07), as mucom's PCM bank — each
  start offset a `dac-NN` def slicing it; DAC stream control read as well.
- **A song without a loop point loops whole** on request (2026-10-07):
  ticked by default for MIDI, unticked for VGM (a jingle).

## Open

- **DT in the voice importers (found 2026-10-05, not fixed):** Furnace's
  loaders store DT centred on 3 (register = `{7,6,5,0,1,2,3,4}[dt]`) for DMP,
  TFI and FUI (`fileOpsIns.cpp` reads them straight into that field), but
  `import-fm-voices.js` reads them as the register field. DMF/FUR song import
  converts (`import-tracker.js` DT_REG); the single-voice imports do not.
  VGI/OPNI unverified.
- **VGM**: tempo changes within a song (one grid for the whole file); second
  chips; other chips' PCM (SegaPCM, YM2610 ADPCM, OKI…). Dino Land's title
  theme (Genesis) estimates a 64th-note grid for the whole song.
- **Fewer shapes** if the user wants them: VGM envelopes and bends match
  exactly (TwinBee gives ~26 envelopes); rounding near shapes together is
  the lever. A bass of per-note pitch falls (Dungeon fm1) names a bend per
  pitch — the driver steps F-numbers, so the falls differ in cents.
- **Trackers**: sample channels, macros of old (pre-INS2) Furnace
  instruments, subsongs after the first; Furnace's slide/porta compat rules
  are rounded (a slide stops at the next note, 03xx is row-only, a vibrato
  under a slide is dropped).
- **MIDI**: per-note pan/CC changes after the first.
- **Structured vs flat**: a structured import writes a voice's TL at a block
  head, during the rest before the note, where the flat one writes it at the
  note — the same key-ons, a different release tail. Seen in the
  flat-vs-structured register comparison; not judged audible.
