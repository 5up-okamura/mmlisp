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

## Round 2 — structure and expression (user, 2026-10-07)

Order: (1) structure MIDI/VGM, (2) envelopes (VGM PSG, FM carrier TL),
(3) pitch: trackers → VGM → MIDI. Decisions:

- **Structure over exactness.** "The more structured, the easier to grasp."
  Repeats become `(x n …)`, including the `(x n A (break) B)` form (A B A B
  A); a run used again elsewhere becomes a `(def …)`. Exact matches only (no
  transposed repeats yet). Compare velocity at MMLisp's 16 steps — finer
  differences mean nothing.
- **Vibrato as a function, wobble rounded:** a `(macro :pitch (sin …))` in a
  `(def …)` beats a faithful per-frame array; round depth/rate so notes
  share defs.
- **MIDI modulation (CC1): fixed mapping** (depth/rate decided by us).

Done: (1) structure (3775f6d, 55ae5dd); (2) VGM envelopes — PSG level and FM
carrier TL during a note → `:vel+` defs with `#sus`/`#rel`, the PSG note
keyed off where its release starts. Shapes are matched exactly (a cut-short
note names the one it starts); TwinBee still gives ~26 — rounding near
shapes together is the next lever if the user wants fewer. (3) pitch:
trackers done (04/01/02/03/E1/E2/E5 → :pitch macros; Furnace's rules
rounded: a slide stops at the next note, 03 is row-only, a vibrato under a
slide is dropped; E5 to 10 cents); VGM done (jump that stays 4 frames =
slur, else vib-/bend- defs; per-part tuning back to A440); MIDI done (bend
through RPN 0 → the same shapes; CC1 → vib, 127 = ±50 cents, 11 frames).
Round 2 is complete. A bass of per-note pitch falls (Dungeon fm1) still names a bend per
pitch — the falls differ in cents; sharing them would need fnum-relative
shapes.

## Open

- **DT in the voice importers (found 2026-10-05, not fixed):** Furnace's
  loaders store DT centred on 3 (register = `{7,6,5,0,1,2,3,4}[dt]`) for DMP,
  TFI and FUI (`fileOpsIns.cpp` reads them straight into that field), but
  `import-fm-voices.js` reads them as the register field. DMF/FUR song import
  converts (`import-tracker.js` DT_REG); the single-voice imports do not.
  VGI/OPNI unverified.
- VGM: tempo changes within a song (one grid for the whole file), DAC sample
  import, second chips.
- Trackers: sample channels,
  macros of old (pre-INS2) Furnace instruments, subsongs after the first.
- MIDI: per-note pan/CC changes after the first.
