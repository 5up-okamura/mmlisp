# The driver's decision record

What the docs do not carry: why MMLispDRV is shaped the way it is, the
measurements that cost real work, and the user's rulings. **The design itself is
`docs/driver.md`** — if a fact about the present is in both places, that one
wins and this one is wrong.

Merged 2026-09-22 from five files that had drifted (`z80-driver-status`,
`plan-68k-split`, `plan-dac-stream`, `plan-subtick-timing`,
`plan-driver-features`), each of which carried a "LANDED"/"SHIPPED" banner for a
build that no longer exists. **Every byte budget, overlay table, `npm run size` /
`budget` / `mixer` / `ring` / `baseline` figure and every `.z80` line reference
in them described the all-Z80 build and is gone.** That build is tag
`archive/all-z80`, the ring engine `archive/ring-engine`, the DAC research bench
`archive/dac-stream-bench`.

Open work is `docs/roadmap.md` Phase 3 and `docs/driver.md` §11 — not here.

---

## 1. Why the sequencer left the Z80 (2026-08-02)

The all-Z80 PCM soft-mixer, measured on the user's 9-track song over 900 frames
(`runTrace` cycle profiler), against a 59,659-cycle Z80 frame:

| | PCM on | same song, sample bank off |
| --- | --- | --- |
| median | **211,784 (355%)** | 18,937 (32%) |
| p99 | 257,023 (431%) | 57,966 (97%) |
| over budget | **90.9%** | 0.9% |

The FM/PSG engine was fine; **the soft-mixer alone was ~193k cycles a frame —
3.2× the whole budget with ONE voice active.** Per mix tick (~983 cycles):
`pva_add` 292 (a 32-bit phase update, ~14 IX-indexed accesses at 19–20 each),
`pcm_voice_acc` entry ×3 149, `pp_tick` 156, the DAC write **115 (two BUSY
polls)**, `pva_fetch` 94.

**Reference point: XGM mixes 4 channels at 14 kHz in ~25 cycles/sample/channel**
— it keeps state in registers and does not resample. The 12× gap was
architectural, not a Z80 limit. The emulator omits bank-window ROM wait states,
so that figure is a **floor**.

Rewritten to the theoretical floor for the same semantics, two voices came to
**99.7% of the frame with the sequencer executing zero instructions**. The
sequencer was never the problem (median 33%); the two workloads do not fit in
one Z80.

> The old "keep everything on the Z80" position was argued on **bytes**, and the
> overlay pass had solved bytes. The binding constraint was **cycles**.

## 2. Which of the 2026-08-02 decisions survived

Eleven decisions were taken the day of the pivot. Five were later **reversed** by
measurement — recorded because the arguments for them will be made again:

| # | decided | what happened |
| --- | --- | --- |
| 2 | the Z80 keeps the clock; the 68k fills a ring it consumes per vblank | **reversed** — no interrupt, no timer; the 68000 pumps pairs and writes PSG itself (`driver.md` §5.1, §6.6) |
| 4 | PCM voice count fixed at 3 | **reversed** — one image per count 1–3, `(def pcm-voices N)` |
| 5 | no compile-time pre-resampling; per-note pitch is worth the cycles | **reversed** — every sample is baked per note at build time, no runtime pitch (`driver.md` §14.2) |
| 6 | ring depth 2, a per-game knob | **reversed** — there is no ring |
| 7 | 8-bit saturating mix, 3 voices, 10.5 kHz, "the rate stays a knob" | **reversed** — three generated images at 14,375.68 / 10,111.71 / 6,653.43 Hz, derived by `npm run light-study` from a slot work ceiling |

Still in force: the split itself; SE belongs to the 68k; change-only suppression
is the 68k's; writes are appended in **dispatch order, never coalesced
full-frame** (that is what keeps the zero-tolerance gate possible, and full-frame
coalescing was measured at ~1% of writes — built, then reverted at ~90 B for
that 1%).

## 3. Measurements that cost real work

- **Two loud PCM voices do not fit — not three** (2026-08-06, on the ring
  engine): 1 voice 0 of 228 frames over budget; 2 voices **6 of 6**. Overlapping
  drum hits are exactly how a score gets two voices at once, and that is what a
  periodic tempo wobble on hardware sounds like.
- **The steady-state write census** (`m3-macro-multi`, 97 frames, 641 writes) —
  the only measurement of this repo's wire load, and it generalises well past
  the question it was taken for:

  | class | share |
  | --- | --- |
  | key on/off | **0.8%** |
  | F-num / PSG period | 65% |
  | TL | 17% |
  | PSG att | 12% |

  **Note dispatch is under 1% of steady-state traffic; macro and sweep stepping
  is essentially all of it.** Change-only does not rescue it — F-num.lo already
  changes every frame. Any proposal to subdivide time therefore costs nothing on
  notes and multiplies 99% of the traffic. Curve sampling is already
  compile-time (`ir-utils.js`), so the *semantics* were never the blocker; only
  cycles were.
- **The YM2612 write-timing table is XGM2's hardware measurement**, read from
  its source, not folklore: address write needs 6 Z80 cycles before its data; no
  wait at all between writes to `$21–$2F` **except `$28`**; `$28` 53; `$30–$9E`
  39; `$A0–$B6` 22. `$27` and `$2A` are both in `$21–$2F`, so **the sample feed
  needs no wait**. Now in `driver.md` §5.1 and as the `wait:` object in
  `drv/engine/config.mjs` that the analyzer *checks* schedules against.
- **The frequency latch is TWO chip-wide registers** (Nuked `reg_a4`/`reg_ac`),
  not one per port — a port-1 upper can clobber a port-0 upper. A pitch pair
  must be written whole in one grab.

## 4. What the other drivers do

Read from source (`SGDK/src/snd/xgm2/*`, MDSDRV's `mdssub.z80`), 2026-09-01:

- **Neither MDSDRV nor XGM2 has a resampler.** Fixed-vs-pitched is *the* lever.
- XGM2's design rule is **≤168 cycles between `sampleOutput` everywhere**,
  reached by placing DAC writes *inside* `FM_loadInst` (16 of them), the V-int
  handler (8) and the DMA polling loop. Its `sampleOutput` is ~80 cycles: the YM
  ports live permanently in `HL'`/`DE'`, `$27` is resident in `IXL`, and address
  and data writes sit back to back. **XGM2 polls nothing**; XGM1 polls BUSY but
  with the port address in HL (22 cycles, not 24).
- **XGM2 degrades in the opposite direction from this project**: it protects the
  DAC and drops music frames (`MISSED_FRAME++`). This project protected the
  frame and holed the DAC.
- MDSDRV accepts a ~313 µs hole for a key-on plus patch transfer — **holes are
  an accepted concept**, and ours were ~3× too big.
- Third-party data point (吉村ことり's driver): **8 fixed-pitch PCM voices ⇄ 2
  pitched, switchable**. A voice count says nothing about feed uniformity, and
  that is the part worth learning.

## 5. Three bugs that no gate could see

All outside the code under test, all silent:

1. **`tools/z80asm.mjs`: `$` meant the address of the NEXT instruction**, so
   `djnz $` jumped past itself — a 26-iteration pad loop that ran once, a sample
   clock 4.5× too fast, no error anywhere.
2. **`tools/z80cpu.mjs` charged every `(HL)` operand 3 cycles too few** (7 is
   not 4; `ld (hl),n` is 10, not 7), and the mixer's hot loop was `ld a,(hl)` +
   `add a,(hl)`. **Every cycle budget in the repository was computed against an
   under-charged model.** Fixed with a selftest pinning the documented counts.
   Treat any modelled figure from before commit `fcc8457` as uncalibrated — and
   do NOT assume BlastEm values or hand calculations share the error.
3. **A pad filler destroyed the sample in flight.** At 9,987.6 Hz the pads
   happened to be a bare `djnz` and nothing showed; at 3,329 Hz the tail took an
   `ld a,0` and **every other sample went out as zero**. It was caught only
   because a second profile was in the case list — **one clock would have passed
   clean.** Keep more than one rate in any gate's case list.

## 6. How this repo's gates fail

- **They compare sample VALUES, never their timing.** The DAC feed was a burst,
  not a paced stream: 175 writes in 12–13% of the frame — an effective **87 kHz
  against an intended 10.5**, then 6 ms holding one value — confirmed three ways
  including a BlastEm VGM log of the user's own ROM. It survived every
  zero-tolerance gate and cost three bring-up rounds.
- **An encoder-only fix is not locked by `verify:all`.** The 2026-07 loop
  sticky-state bleed was fixed in the exporter, so the regression lock is the
  ir↔drv A/B baseline, not the C gate.
- A trick that pays: run a built `res/song.mmb` + `res/song.smp` straight
  through the reference player and count `$2A` writes. One write per 600 frames
  against 94,851 settles a "is PCM even running" question in seconds, without an
  emulator.

## 7. Porting lessons that still describe `mmlispseq.c`

Both M2 and M3 went into the C **with zero gate failures on the first run** —
porting from a *validated implementation* rather than from prose is what makes
it cheap. Three things the C needs that the JS gets free, all found by the gate:

- **A shadow-validity plane.** `drv-player` keys its shadow with a Map, so an
  unwritten register never compares equal; a zero-initialised C array would
  suppress the neutral patch's many writes of 0.
- **VOICE_SET compares against the STRUCTURED shadow**, not the register shadow
  — the burst only wrote the registers a PARAM_SET touched.
- **The drain must not render**; running a frame there invents traffic the
  reference never produces.

Also: macro binds are an **ordered** map and that order is the step order; a
slot's **byte** budget can bind before its write cap once PCM commands are in
play; and **every PCM handler must return HL untouched** — a `left += tail` in
HL (the command cursor) corrupted everything after a STOP, and four gate
scenarios missed it because only a real score issues STOP+START in one slot.

Z80 techniques worth not rediscovering, now absent from the tree but still true
of any future Z80-only build: accumulate **biased-unsigned** (`sample ^ $80`) so
the sum needs no sign extension anywhere; two page-aligned planes let one 8-bit
index address both (`inc h`/`dec h`); **`exx` is flag-transparent**, so a frac
carry chains into the pointer add — but `exx` swaps BC too, so load the
increment into C *after* it. Two engine build traps: **the image boots at level
0**, and until the bank is set the window shows ROM bank 0; and
`ld a,(LUT>>8)` assembles as a **memory load** — write `ld a,LUT>>8`.

## 8. The bus grab

- **Plan outside the grab.** Parsing the table with BUSREQ held cost 5,800
  master a grab; only the index read and a straight `move.b (a0)+,(a1)+`
  belong inside.
- **Wait before the first grab** — the Z80's boot clears the pair page, so a
  grab at release time is erased.
- **The grab must be asm.** C over `Z80_getAndRequestBus` was 2,835 master;
  eight pairs as four `movep.l` is 1,100–1,320.
- SGDK halts the Z80 on its own: `JOY_update` (~2,490 master per 6-button port)
  and a DMA auto-flush **every VBlank even when empty** (~600).

## 9. Decisions that answer a question someone will ask again

- **`:tl` etc. are baked, the driver has no evaluator.** Compile-time eval
  gains the driver "no evaluator, only readers and flags".
- **Keep LOOP and CALL/RET separate — do NOT add a count to CALL.** A
  single-use `(x N …)` is L+3 bytes as a LOOP but L+5 as a counted CALL (the
  body is forced out of line, plus a RET and a dest pointer). Counted-CALL wins
  only ~4 bytes on the rarer *shared* looped phrase (33 vs 37) while taxing
  every ordinary loop 2 bytes. The count belongs to LOOP; CALL/RET stays
  count-less. The synergy is composition, not merger.
- **The dedup pass factors only control-flow-free runs at loop depth 0.**
  Lifting that so a *shared* looped phrase factors is measured and safe with one
  addition — the encoder must track the real control-stack depth (LOOP and CALL
  share the 4-entry stack) and factor inside a loop only when
  `loop_depth + 1 ≤ 4` — and must be gated on occurrence count ≥ 2, because
  wrapping a phrase used once would *add* bytes. Measured: two tracks each
  `(x 8 phrase)` = 940 B and dedup saves 0; two sites with a 24-byte body go
  54 → ~37.
- **`(trig N)`'s status byte was shaped against a "a Z80-only driver exists some
  day" lens** (user, 2026-09-21). That ruled out a 68k-struct sentinel and a
  read-clears call: in a Z80-only build the game reads one byte through the
  window and must not have to write back. The constraint is still live
  (`roadmap.md` Phase 3 open #6). `opcodes.md` 0x42 has the format and the
  repeat argument but not the two rejected designs.
- **`#label` used to emit the trig opcode with its own sequence number**, so
  every looping track wrote a phantom trigger at its loop head with an id that
  collided with real trig ids — invisible to every gate because nothing read the
  byte and the opcode writes no register. The user chose to fix it by **making
  labels emit nothing at all**, over adding a separate opcode.
- **DAC ownership is a static compile-time rule, not runtime arbitration.** The
  "last KEY-ON wins" plan (18 B) was dropped when both its premises fell; the
  direction is `:prio` treating fm6 and pcm1–3 as parallel layers of one
  channel, so the driver arbitrates zero bytes. Two sub-problems are open:
  `:prio`'s monophonic flatten cannot yet express "fm6 vs the *group*
  {pcm1,pcm2,pcm3}", and runtime SE cannot be flattened at compile time, so
  SE-over-PCM stays a hardware fact. Note `process_pcm` early-outs, so fm6
  taking the channel idles the driver's most expensive routine — **the cycle
  saving is paid in music (the drums stopped), not free.**
- **The `$2A`/`$2B` ownership split.** The sequencer *could* predict the `$2B`
  edges, but then both sides would have to agree on the exact frame — a coupling
  worth avoiding when voice activity is the one piece of state the Z80 owns.
- **Sub-tick note timing is retired** (`SLOT_SUBS = 1`, user's call: "most game
  drivers are 1/60"; an option would complicate the sources). Idle went 71.9% →
  78.6%. **The machinery is left in the sources on purpose**: at SUBS=1 LTO
  folds the one-iteration loops and the dead branches, and the SGDK host never
  encodes slots (it uses the view path), so deleting it buys nothing measurable
  and would touch the C, the JS reference, the slot format and the gates.
  Checked in the built ROM. Two shapes in `mmlispseq.c` exist for its sake and
  are still right: PCM tracks are **not** subdivided (subdividing would move PCM
  notes earlier than the frame that owns them), and `pcm_frame` runs after the
  **last** sub-tick so a late `PCM_VOL` is in force for this frame's samples.
  A channel that steps at sub-tick 0 and then takes a note-on steps **twice** in
  the frame — correct, because the note-on re-instantiates the macros.
- **The PSG soft-envelope Layer-2 divergence is left as-is** (user). The source
  is a finished mucom song, so neither player is authoritatively right; **the
  goal is simply ir ≡ drv.** Keep both fixes; do not revert. Related standing
  rule: a macro *is* the PSG envelope including the release, which runs entirely
  while keyed off, so macro writes land after key-off while non-macro writes
  keep the keyed guard (the `force` flag in `_paramSet`).
- **The song-start voice burst cannot be fixed by spreading setup at compile
  time** (the user's idea, measured and refused). What delays the first notes is
  the **wire** — ~250 register writes at 16 pairs/frame ≈ 16 frames (~260 ms).
  Spreading setup per channel staggers the channels unless every note start is
  delayed by the same amount, which gives the same total delay. Two fixes do
  address it: priming at load (shipped, `fb4fd78`) and VSET bodies in the
  sample-bank ROM (open, `roadmap.md` #3).
- **A VBlank-only pump mode is wanted as an option**, because a game (racing,
  raster 3D) may need HBlank for itself. Shipped as
  `MMLisp_attachVBlankOnly`. The user's stated order is **correct playback
  first, then optimization**, and eventually trading some quality for balance.

## 10. How to work here (the user's rulings)

- **Measure the symptom, don't reason from a bound.** "I argued that any lost
  sample is permanent drift and therefore 99.1% must still drift. **It does
  not.** Do not use '98–99% is not good enough' as a rule."
- **One variable per build.** Stacked changes made a regression unattributable.
- **Do not spend the user's build-and-listen rounds on guesses.** Until the
  model predicts the machine, every engine change is a guess. Fix the model, or
  measure the machine.
- **Only ask for a listening test when the answer discriminates between
  hypotheses** — not when it is your experiment.
- Re-measure rather than guessing: every guess in the 2026-08 bring-up (DMA
  collisions, change-only never repairing a diverged chip, overlay thrash at the
  loop) was wrong, and the profile was right each time.
- An intermediate fix that only makes a symptom *smaller* is the wrong **shape**
  of fix; the user is right to reject it.
