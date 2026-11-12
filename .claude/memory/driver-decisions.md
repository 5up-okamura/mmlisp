# The driver's decision record

Why MMLispDRV is shaped as it is, the figures to reopen a question with, and
the user's rulings. The design is `docs/driver.md` (it wins where both
speak); open work is `docs/roadmap.md` and `driver.md` §11. PCM is [[pcm]].
Superseded engines: tags `archive/all-z80`, `archive/ring-engine`,
`archive/dac-stream-bench`.

## Why the split

- **The sequencer left the Z80 on cycles, not bytes** (2026-08-02): the
  all-Z80 soft-mixer alone was ~193k cycles a frame (3.2× the budget) with
  one voice; rewritten to its floor, two voices took 99.7% of the frame with
  the sequencer idle. XGM mixes at ~25 cycles/sample/channel because it keeps
  state in registers and does not resample.
- Reversed since, so not to be argued again: the Z80 keeping the clock and a
  ring (now the 68000 pumps pairs); a fixed 3 PCM voices (now 1–3 images);
  runtime pitch (now baked per note); a ring depth knob; one 10.5 kHz rate
  (now three generated rates from `npm run light-study`).
- Still in force: SE is the 68k's; change-only suppression is the 68k's;
  writes go in **dispatch order, never coalesced full-frame** (it keeps the
  zero-tolerance gate possible; coalescing saved ~1% of writes).
- **Write census**: key on/off 0.8% of steady-state writes, F-num / PSG
  period 65%, TL 17%, PSG att 12%. Subdividing time multiplies 99% of the
  traffic and gains nothing on notes.
- **The YM2612 wait table is XGM2's measurement** (in `drv/engine/config.mjs`
  `wait:`): no wait within `$21–$2F` except `$28`, so the sample feed needs
  none.
- Other drivers (2026-09-01): neither MDSDRV nor XGM2 resamples; XGM2 keeps
  ≤168 cycles between DAC writes and drops music frames to protect the DAC
  (we protect the frame); MDSDRV accepts ~313 µs holes.

## Z80 traps

- VDP DMA stops the Z80's ROM window: a DAC fed from it plays from Z80 RAM
  deep enough for the longest DMA, and the game flags its DMA.
- Accumulate biased-unsigned (`^ $80`); `exx` is flag-transparent but swaps
  BC; the image boots at level 0 with ROM bank 0 in the window;
  `ld a,(LUT>>8)` is a memory load — write `ld a,LUT>>8`.

## How the gates fail

- Cycle figures before commit `9c7c51f` are uncalibrated (the CPU model
  under-charged `(HL)`).
- **Keep more than one rate in a gate's case list**: a pad filler zeroed
  every other sample at one rate and passed at another.
- Gates compare values, not timing (a 87 kHz burst feed passed every gate).
- **C ≡ JS proves agreement, not correctness**: budget audits of the
  register trace against the spec.
- An encoder-only fix is locked by the ir↔drv A/B baseline, not `verify:all`.
- A silent failure has no traffic to compare: check invariants (`claim-gate`).
- **Never fix a failing gate by breaking the reference the same way.**
- Quick check: run a built `song.mmb` + `song.smp` through the reference
  player and count `$2A` writes.

## The 68000's share

- **Readability over noise-level gains** (the user): any speed-up must show
  in an A/B profile and read plainly. Driver + API is ~16% of the 68000.
- Rejected: pre-rendering macros (XGM by another name); spreading a render
  over the lead; a copy-and-rotate for score B's loop head; a banked_writes
  rewrite (+4 KB RAM, no peak gain); staging early in the host lane.
- Left for when a game drops a frame: asm for the hot paths with the C as
  reference; the sequencer pushing pairs straight into the converter
  (−2% average, −30–40% on a peak, −5 KB RAM).
- Reopen figures (BlastEm, banked): a YM write ~2,000 cycles end to end, so a
  peak render is its write count (116 writes ≈ 2.4 frames).

## Onset under write bursts (rulings)

- The test scores A and B are private mucom imports on the user's machine.
- **The hoist windows stay fixed** (rest 4 frames, cut 2); a voice before a
  rest moves too; the tail cut is built but off (no audible difference).
- **`MMLISP_LEAD` 2 stays** until a render fits a frame (lead 1 still
  slips: key-on lag p95/max 18.3/38.8 ms against 6.7/22.2).
- **No transport increase**; declined: skipping unchanged pitch pairs,
  patches under BUSREQ, a frame mark in the FIFO, the patch after the
  key-on, PCM STAGE, ordinary FM3 in the short-group priority, key-ons last
  × `banked_writes`. Reopen FM3 / key-ons-last only if a wobble is heard.
- **VOICE_SET bodies in ROM** (roadmap): today's performance is enough
  (2026-10-27); only pcm1 has the cycles. Reopen on a full-feature score
  whose lateness survives the hoist.
- The song-start voice burst is the wire (~250 writes at 16 pairs/frame);
  spreading setup at compile time staggers the channels — refused.

## SE and several songs (rulings)

- Triggered by a host call, not a source marker; control data bundled, the
  sample bank shared (over cross-MMB banking).
- **`def-se` is the one way**: one effects file injected into every song,
  several parts per effect, a default priority the host may override.
- The displaced part plays on as a ghost (catching up at SE-end rejected).
  Open: a `:master` written by a ghost's stream.
- **SE-end restores the state, not the sound** (2026-11): no re-key on any
  channel; the part sounds from its next note. Re-attacking (FM's EG, a PSG
  `:vel` envelope, a sample's head) was rejected as an attack the music never
  wrote; SMPS and Echo do the same (state back, no key-on). A `:len 0` hold
  under an effect stays silent — the composer's to arrange (user's choice A).
- **PCM voices are owned channels with ghosts** like FM / PSG (`owned_ch`,
  `ghost_ix`); the PCM-only snapshot (loop restart, saved binds) is gone. The
  DAC's one pan is the exception: a PCM SE's `se_pan` over fm6's L / R.
- No effect on CH3; song-wide state (`:master`, `:lfo-rate`) refused in
  def-se.
- FM effects belong on free channels (priming); LEAD 1, an SE lane two
  frames ahead and a faster light-image wire were not chosen.
- Two scores resident: per-score state off the sequencer; two scores
  wanting different engine images cannot be resident at all.

## Other rulings

- LOOP and CALL/RET stay separate; no count on CALL.
- `(trig N)`'s status byte is readable by a Z80-only driver with no write
  back. `#label` emits nothing.
- Sub-tick timing retired (`SLOT_SUBS = 1`), its machinery left in on
  purpose (LTO folds it).
- The PSG soft-envelope divergence stays: the goal is ir ≡ drv.
- A tick-written macro `:step` runs on the tick clock; a `:keyon` retrigger
  restarts the envelopes, not `:pitch` / `:semi`; velocity in eighths of a
  step (TL resolves 0.75 dB).
- **HBlank is the game's**; the host pumps from VBlank only.
- The gates' slot encoder stays in `mmlispseq.c` (gc-sections drop it).

## How to work here (the user)

- Measure the symptom, don't reason from a bound; one variable per build;
  don't stack unproven work.
- Don't spend the user's build-and-listen rounds on guesses; ask for a
  listening test only when its answer tells hypotheses apart.
- A fix that only makes a symptom smaller is the wrong shape.
- A fitted coefficient is not a hardware measurement; no single number is a
  pass.
- **PAL: supported, not verified, low priority**: a CLI export only; no PAL
  gate, hardware pass or UI — do not propose them.
