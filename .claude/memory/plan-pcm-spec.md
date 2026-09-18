# PCM — the decisions behind the shipped design, and what is still open

D10 (the light engine) shipped in six steps, 2026-09-17..18 (commits d95cab1 …
S6). What it is lives in the docs: `docs/driver.md` §1/§5/§6.6/§14 (engine,
host, levels, loops), `docs/language.md` §9/§16 (`pcm-voices`, loop points),
`docs/mmb.md` §10 (bank v0.3). This file keeps the user's decisions the docs
state as facts without their reasons, and the open list. Read before touching
PCM in any layer.

## Decisions, with the user's reasons

- **Light over exact (D10, 2026-09-17).** "Correct and strict" had become a
  shackle. No phase observer, no corrector, bus stops not repaid, VSync-only
  host. The ear accepted every stop up to 200 µs at 60/120 Hz (listening set,
  2026-09-17), which is what licenses not repaying them.
- **No runtime pitch (D5/D10).** Every note is baked at its own pitch; no C2–C6
  clamp (the bank is the only limit); pitch on a PCM track is a score error.
  The octave-by-shift key D5 had agreed was DROPPED with D10: the images have
  no 2^k step.
- **Voice count per score (D8/D10)**: `(def pcm-voices N)`, one engine image
  per count. The user chose the language form after the `(def title …)`
  precedent.
- **Levels on the 6 dB grid, as TABLES (D4).** The user had decided bit shifts
  were enough (2026-08-12); the 15-page linear LUT the one-voice engine shipped
  contradicted that without being flagged, and the user objected. Tables of
  6 dB rungs, master folded in by the host: one read a voice, constant time.
- **The Z80 keeps writing the YM (D10 round 2).** The user wants a Z80-only
  driver some day and does not want the Z80's YM machinery thrown away. Cost
  measured: ~0 at 1–2 voices, ~10% of rate at 3.
- **Work margin: to the edge (D10 (3)).** "To the edge is fine if it plays."
  The margin only guards cost-model error and waits measured on BlastEm; a
  mis-costed slot runs slightly flat, never crashes.
- **Loops (D10 round 2 + S3).** The user's aim: start and end changeable per
  note and by curves, "to fit the performance" — other drivers do not have
  this. Loop points are TIMES (`Nms`, note lengths, frames), never fractions or
  source frames ("I want to say exactly from here to here"), with the same
  notation on the def and the track. `:offset`/`:frames` cut the sample out of
  the bank; `:loop-*` are playback. The shortest loop is one 16-byte block, and
  the user accepted that.
- **fm6 per song (D6).** A score with PCM owns fm6 as the DAC all song; fm6 FM
  and PCM in one score is an error. "fm6 in the gaps" is gone.
- **The browser sounds like the driver (D0).** "Otherwise this is not a
  production environment for this driver."
- **One 32 KB bank a song (2026-09-17).** If ever needed: on `pcm1` only, the
  START piece writes the bank register (~100 cycles, blobs may not cross a
  32 KB boundary; ~14.4 → ~12 kHz). Two or three voices would need a per-block
  copy into RAM.

The yardstick, for "approach XGM": XGM2 is 100% Z80, 3 channels of 8-bit
signed PCM at up to 13.3 kHz paced by Timer A through a ring, loops from a
64-byte-aligned point, NO PCM volume. We pay every slot's worst case because
CSM owns Timer A; what we have that it lacks is levels and moving loop points.

## Open

- **Hardware.** Nothing has run on silicon. The images sit at a 100% work
  ceiling and the one measured wait (a read through the 68k window) is a
  BlastEm number; the host writes with `movep.l`. First hardware run decides
  whether the images keep the edge (`npm run light-study -- --target 0.95`
  prints the ladder with a margin).
- **A listening round on loops** (moving `:loop-start` by a curve, short loops
  where the block rounding detunes).
- **PCM SE** runs only in `drv-player.js`; the C sequencer and the SGDK host
  have no SE yet ([[plan-se]]).
- **D7 sample keys** — `:bit-depth`, `:volume`, `:compress`, `:reverb`: the
  user wants all of them eventually; today they warn
  (`W_SAMPLE_KEY_UNIMPLEMENTED`).
- **The mucom importer's `+3` octave shift on K parts** was justified by the
  C2–C6 clamp, which no longer exists (`live/src/import-mucom.js`
  `MUCOM_PCM_OCT_SHIFT`). Whether to keep it is the user's call.
- **Not scheduled:** compile-time premix of overlapping pcm voices (D1 (C));
  measuring XGM2/MDSDRV ROMs on BlastEm as a yardstick.
