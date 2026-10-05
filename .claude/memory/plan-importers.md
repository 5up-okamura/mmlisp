# Song importers and VGM export with PCM — what is left

Built 2026-10-05 (commits b949f94 … 13aff2b): VGM/WAV export carry PCM (the
mixed DAC stream), and MIDI, DMF, VGM and FUR import through one dialog. The
behaviour is in `docs/guide.md` §23; the code is `live/src/import-*.js`
(`import-song.js` is the shared back end, `import-tracker.js` the DMF/FUR
converter). Delete this file once the open items below are settled.

## Decisions behind it (user, 2026-10-05)

- A conversion dialog, defaults right so Enter alone imports; only what a
  user changes per file (destinations, tempo, timing).
- MIDI: cut lanes from the most polyphonic channels first; apply the GM
  bank's note offsets at import (the preset set does not).
- VGM: estimate the tempo (not a fixed frame grid); frames are the fallback.
- Trackers: each pattern a `(def …)` phrase, the tracks naming them in order;
  a phrase restates the state it relies on.
- VGM export PCM: the mixed DAC stream as one data block + `0x8n`, not DAC
  stream control (the engine mixes voices in software).

## Open

- **DT in the voice importers (found 2026-10-05, not fixed):** Furnace's
  loaders store DT centred on 3 (register = `{7,6,5,0,1,2,3,4}[dt]`) for DMP,
  TFI and FUI (`fileOpsIns.cpp` reads them straight into that field), but
  `import-fm-voices.js` reads them as the register field. DMF/FUR song import
  converts (`import-tracker.js` DT_REG); the single-voice imports do not.
  VGI/OPNI unverified.
- VGM: tempo changes within a song (one grid for the whole file), DAC sample
  import, second chips.
- Trackers: pitch effects (01-04 slides/vibrato, E1/E2), sample channels,
  macros of old (pre-INS2) Furnace instruments, subsongs after the first.
- MIDI: pitch bend, per-note pan/CC changes after the first.
