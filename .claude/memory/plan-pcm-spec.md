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
- **Loops (D10 round 2 + S3).** Listened to 2026-09-18, the user: glad it was
  added — "music the Mega Drive has never played". The user's aim: start and end changeable per
  note and by curves, "to fit the performance" — other drivers do not have
  this. Loop points are TIMES (`Nms`, note lengths, frames), never fractions or
  source frames ("I want to say exactly from here to here"), with the same
  notation on the def and the track. `:offset`/`:frames` cut the sample out of
  the bank; `:loop-*` are playback. The shortest loop is one 16-byte block, and
  the user accepted that. DECIDED 2026-09-18 (user, after the listening set):
  the NOTE's `:mode` decides whether it loops (PCM_NOTE_ON note bit 7; a loop
  note on a def with no points loops the whole sample, a shot always plays
  once), and `:mode` is STICKY like every parameter — "go back with an
  explicit `:mode shot`" (user, same day), and a track's loop writes are sticky, laid over the def's at each
  note-on. `npm run pcm-loop` checks it against the score, not the twin.
- **fm6 per song (D6).** A score with PCM owns fm6 as the DAC all song; fm6 FM
  and PCM in one score is an error. "fm6 in the gaps" is gone.
- **The browser sounds like the driver (D0).** "Otherwise this is not a
  production environment for this driver."
- **Sample effects are a def's `:fx [...]` chain (2026-09-25).** The user
  asked for it because PCM sounds thin and weak next to FM, and wanted
  effects chained in order rather than one key each (`crush` replaced
  `:bit-depth`). All compile-time, run by the bank builder on float before
  the per-note resample, with one 8-bit quantize at the end (the user agreed
  to move the resample to float at the same time). First batch: `gain`,
  `normalize`, `comp`, `limit`, `crush`, `fade`; the fade's shape is a §11
  easing name and it cuts the sample, which saves bank bytes.
- **Kits and variants (2026-09-25).** `(import … :fx [...])` processes a
  whole kit; `:extend` on a sample makes a variant. The import's chain runs
  BEFORE the def's — the user's call: the kit is evened out first, and a
  per-sound level survives a kit-wide normalize. PCM audition is the FM one:
  cursor on a sample def, play the keyboard; no panel (user: no new UI).
- **Macros on PCM: `:keyon`, `:vel`, `:vol` (2026-09-28).** The user: "use
  every feature the hardware allows; skip only what is hard" — a drum roll
  was the case. Before this the PCM path silently dropped every macro. PCM
  velocity went to eighths at the same time, like FM and PSG, which removed
  every PCM special case. The other targets stay errors: a soft-mixed voice
  has no register for them.
- **The range a note plays is not a loop thing — `:pcm-start` /
  `:pcm-end` / `:pcm-len` (decided 2026-10-03, landed the same day).** The
  user assumed a shot could already be given a start and an end, since a
  loop can; it could not (the 2026-09-18 ruling had defined loop points for
  loops only). The engine needed nothing. The user chose the `pcm-` prefix
  over a new word (`:span` was proposed for the length, since `:len` is the
  note's): "avoid new words", and it matches `def-pcm` / `pcm1`. `:offset` /
  `:frames` stay what they are — the bytes that go in the bank — against a
  time range the note plays. No old names kept: `:loop-*` is
  `E_UNKNOWN_KEYWORD` on a def and a track. Why it came up: a reversed
  cymbal — a baked reverse costs a second blob (13 KB of 32 for a crash),
  which the user rejected; reverse at playback is under Open.
  Choices made in the implementation, NOT yet confirmed by the user (the
  decision did not say): (a) a loop note's first pass still starts at the
  blob's start (attack, then the range repeats) — only a shot starts at
  `:pcm-start`; (b) a shot's range is WIDENED to blocks (start floor, end
  ceil — `pcmRangePoints`), where a loop rounds to nearest, so a whole-sample
  shot still plays every byte; (c) a released loop note's tail still plays to
  the blob's end, not to `:pcm-end`; (d) the binary/IR target names stay
  `LOOP_START` / `LOOP_END` / `LOOP_LEN` (a `PCM_START` target would collide
  with the slot command); (e) the editor's sample audition still plays a def
  with a range as a loop, a def without as a shot.
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
- **Sample effects, second batch** — `hpf` / `lpf` (a low cut buys level
  headroom), `drive` (tanh saturation). Agreed with the first batch, not yet
  written. `reverb` is in (2026-09-26; `:tail` required, the user's OK on the
  params), not yet listened to by the user. Nothing listened yet:
  the first batch wants a pass by ear in the live app.
- **Reverse at playback** (2026-10-03): per-note direction, zero bank
  cost and zero per-sample cost (`dec de` / `dec hl` cost what `inc` does;
  the step opcode is one self-modifiable byte), but the block-edge pieces
  assume a forward walk (COMPARE is pointer ≥ END, END is last byte + 1 −
  16), so a backward voice is a new piece mirrored through the generator,
  pcm-model.js, the worklet, drv-player.js, the C sequencer and the gates,
  plus a language key and an IR field. Not worth it for one reversed
  cymbal; worth revisiting if a composer wants direction as a performance
  control, like the moving loop points.
- **Not scheduled:** compile-time premix of overlapping pcm voices (D1 (C));
  measuring XGM2/MDSDRV ROMs on BlastEm as a yardstick.
