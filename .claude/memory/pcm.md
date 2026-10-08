# PCM — the user's decisions, the measurements, and what is open

**Read before touching PCM in any layer.** What it IS lives in the docs:
`docs/driver.md` §1/§5/§5.4/§6.3/§6.6/§14 (engines, host, levels, loops),
`docs/language.md` §9/§16 (`pcm-voices`, the four points, `:fx`),
`docs/mmb.md` §10 (the bank), `docs/pcm-multibank.md` (multi-bank). This file
keeps the reasons the docs state as bare facts, and the open list. Merged
2026-10-09 from `plan-pcm-spec` and `plan-pcm-multibank`.

## The user's decisions, with their reasons

- **Light over exact (D10, 2026-09-17).** "Correct and strict" had become a
  shackle. No phase observer, no corrector, bus stops not repaid, VSync-only
  host — licensed by a listening test (`drv/sgdk/README.md` has the figure).
- **No runtime pitch.** Every note is baked at its own pitch; pitch on a PCM
  track is a score error. The octave-by-shift key agreed in D5 was DROPPED
  with D10: the images have no 2^k step.
- **Levels on the 6 dB grid, as TABLES.** The user had decided bit shifts were
  enough (2026-08-12); a 15-page linear LUT then shipped without being
  flagged, and the user objected. Tables of 6 dB rungs, master folded in by
  the host: one read a voice, constant time.
- **The Z80 keeps writing the YM.** The user wants a Z80-only driver some day
  and does not want the Z80's YM machinery thrown away. Cost measured: ~0 at
  1–2 voices, ~10% of rate at 3.
- **Work margin: to the edge.** "To the edge is fine if it plays." The margin
  only guards cost-model error; a mis-costed slot runs slightly flat, never
  crashes.
- **Loops are a performance control.** Listened to 2026-09-18, the user was
  glad they were added — "music the Mega Drive has never played" — and wants
  start and end changeable per note and by curves, "to fit the performance".
  Points are TIMES, never fractions or source frames ("I want to say exactly
  from here to here"), in the same notation on the def and the track. The
  shortest loop, one 16-byte block, was accepted. `:mode` is sticky like every
  parameter — "go back with an explicit `:mode shot`".
- **The four points** (`:pcm-start`, `:loop-start`, `:loop-end`, `:pcm-end`)
  were named by the user — "pcm-start, loop-start, loop-end, pcm-end" — when
  asked where a loop note's head and tail go. The `pcm-` prefix over a new
  word (`:span` was proposed and rejected: "avoid new words"); both `…-len`
  forms kept so the spans read alike. It came up because of a reversed cymbal;
  a baked reverse (a second blob, 13 KB of 32 for a crash) was rejected.
- **"fm6 in the gaps" is gone** — a score with PCM owns fm6 as the DAC all song.
- **The browser sounds like the driver.** "Otherwise this is not a production
  environment for this driver."
- **`:fx` exists because PCM sounds thin and weak next to FM** (2026-09-25).
  Effects chain in order rather than one key each (`crush` replaced
  `:bit-depth`); the user agreed to move the resample to float at the same
  time. **A kit's chain runs before the def's** — the user's call: the kit is
  evened out first, so a per-sound level survives a kit-wide normalize. PCM
  audition is the FM one, no new UI (user).
- **Macros on PCM: `:keyon`, `:vel`, `:vol`** (2026-09-28): "use every feature
  the hardware allows; skip only what is hard" — a drum roll was the case.
- **Capacity first** (2026-10-05): more than 32 KiB of samples a song, and
  voices from different banks at once, over runtime pitch. A per-voice
  read-ahead resampler was studied and not chosen. **The bank switch is what
  costs the rate** — one or two banked voices run at the two-voice light rate.

**The yardstick, for "approach XGM":** XGM2 is 100% Z80, 3 channels of 8-bit
signed PCM at up to 13.3 kHz paced by Timer A through a ring, loops from a
64-byte-aligned point, NO PCM volume. We pay every slot's worst case because
CSM owns Timer A; what we have that it lacks is levels and moving loop points.

## Measurements (multi-bank, BlastEm, the SGDK example app)

- Two-voice stress run, 45 s: FM key-on interval error p95 24.8 ms, max
  36.8 ms; bus loss 0.72%. One voice, 30 s: p95 18.4, max 33.9. A minimal app
  did not improve the maximum.
- After the optimisation pass: three-voice NTSC p95 13.2 ms, max 20.2 ms, bus
  loss 0.45%; PAL p95 14.9, max 31.7. The PAL outlier is not the classifier
  (a build without it measures the same); dense-command jitter is workload-
  and phase-dependent.
- Service rates (NTSC, pairs/s): single-bank 1,027 / 1,011 / 1,109 for one,
  two, three voices; banked 6,952 / 1,896 / 1,663. The host caps copies at 16
  pairs a frame single-bank (959/s) and 80 banked (4,794/s).
- **Why ordinary FM3 is excluded from `banked_writes`**: the converter does
  not know CH3's mode; a probe showed FM3's key-on queued at index 31 behind a
  29-write patch where FM2's sat at index 2.
- Not adopted, with reasons: single-bank images with more expander steps
  (fit, but the 16-pair cap would still bind); a banked three-voice variant
  with the expander's B half inlined (raw throughput does not establish
  better onset latency).

## Open

- **The integrated multi-bank build has had no listening test.** The user
  accepted the precomputed two-voice prototype's timing by ear (a slightly
  slow passage near 7 s) — do not claim that acceptance for the build.
- Nothing has run on real hardware.
- **The banked converter has no byte-for-byte JS twin** in `pairs-gate`:
  covered by `tests/banked-pairs.c`, the BlastEm run and `prioritizeFmNotes`.
  `tests/multibank-3v.mmlisp` carries two known PSG-timing divergences in
  `ab-baseline.json`, unrelated to PCM.
- **Reverse at playback** (2026-10-03): zero bank and per-sample cost, but the
  block-edge pieces assume a forward walk, so a backward voice is a new piece
  mirrored through the generator, `pcm-model.js`, the worklet,
  `drv-player.js`, the C and the gates, plus a language key. Not worth it for
  one cymbal; worth revisiting if a composer wants direction as a
  performance control.
- Not scheduled: compile-time premix of overlapping PCM voices; measuring
  XGM2 / MDSDRV ROMs on BlastEm as a yardstick.
