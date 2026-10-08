# The driver's decision record

What the docs do not carry: why MMLispDRV is shaped the way it is, the
measurements that cost real work, and the user's rulings. **The design itself is
`docs/driver.md`** — if a fact about the present is in both places, that one
wins and this one is wrong.

**A byte budget, overlay table, `npm run size` / `budget` / `mixer` / `ring`
figure or `.z80` line reference from before 2026-09 describes the all-Z80
build** (tag `archive/all-z80`; the ring engine is `archive/ring-engine`, the
DAC bench `archive/dac-stream-bench`), not the shipped driver.

Merged here on 2026-10-09: `plan-68k-optimization`, `plan-onset-jitter`,
`plan-se` and `plan-multi-score` (§9–§11). PCM is [[pcm]]; the set-aside
Z80-only build is [[z80-only]]. Open work is `docs/roadmap.md` Phase 3 and
`docs/driver.md` §11; what is listed as open here is only what those omit.

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
| 4 | PCM voice count fixed at 3 | **reversed** — one image per count 1–3, `(def-score :pcm-voices N)` |
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
  needs no wait**. The numbers live in the `wait:` object of
  `drv/engine/config.mjs`, which the analyzer *checks* schedules against.

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
   The same model charged a **whole `ldir` 16 cycles** until 2026-09-28 (now
   21 a repeating byte, 16 the last, pinned by the selftest). Nothing shipped
   uses `ldir`; the all-Z80 build's overlay loads did, and were free in every
   profile taken of it.
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
- **C ≡ JS proves agreement, not correctness.** When both players are wrong the
  same way the gate agrees and passes. A mid-song `:tl` wrote `$40` raw in all
  three players for months; the SE modulator leak and the 68000 pass's
  port-order and stale-`(break)` bugs were the same shape. Ears, BlastEm and
  reading the register trace against the *spec* found them. Budget an audit of
  that kind; no gate substitutes.
- **An encoder-only fix is not locked by `verify:all`.** c-gate cannot see an
  encoder regression at all — both players read the same stream. The lock is the
  ir↔drv A/B baseline (the 2026-07 loop sticky-state bleed, the 2026-09 macro
  hold sentinel).
- **A silent failure has no traffic to compare.** An SE that stranded the part
  it suspended left that part SILENT, so no twin diff could see it; `claim-gate`
  checks the invariant itself every frame. Likewise the host's KEY_OFF never
  let a `:len 0` PCM loop go — a bug no gate saw, because no gate sent KEY_OFF
  to a PCM channel (fixed by making a PCM key-off one path, `channel_off`).
- **Never fix a failing gate by breaking the reference the same way.** Moving
  the reference to match a regression destroys the property and leaves the gate
  green.
- A trick that pays: run a built `res/song.mmb` + `res/song.smp` straight
  through the reference player and count `$2A` writes. One write per 600 frames
  against 94,851 settles "is PCM even running" in seconds, without an emulator.

## 7. Porting lessons that still describe `mmlispseq.c`

M2 and M3 went into the C **with zero gate failures on the first run** —
porting from a *validated implementation* rather than from prose is what makes
it cheap (the C-only needs it found are `driver.md` §12.2). Also: macro binds
are an **ordered** map and that order is the step order; a slot's **byte**
budget can bind before its write cap once PCM commands are in play; and
**every PCM handler must return HL untouched** — a `left += tail` in HL (the
command cursor) corrupted everything after a STOP, and four gate scenarios
missed it because only a real score issues STOP+START in one slot.

## 8. The bus grab

- **Plan outside the grab.** Parsing the table with BUSREQ held cost 5,800
  master a grab; only the index read and a straight `move.b (a0)+,(a1)+`
  belong inside.
- **Wait before the first grab** — the Z80's boot clears the pair page, so a
  grab at release time is erased.
- **The grab is asm** because C over `Z80_getAndRequestBus` was 2,835 master;
  eight pairs as four `movep.l` is 1,100–1,320.

## 9. The 68000's share — closed 2026-10-02

The user's direction after setting the Z80-only build aside ([[z80-only]]):
keep the split and make the 68000 side cheap, so a game keeps the CPU for
raster effects and 3D. **Closed by the user**: what is left is the price of
moving parameters every frame, which is what this driver is for. Working notes:
git history, `plan-68k-optimization.md` at `afef069`.

| sin008 whole, `sgdk-profile --pc`, 30 s | before (`ba094a6`) | after (`bf50bdc`) |
| --- | --- | --- |
| driver + API | **24.5%** | **16.3%** |
| idle (the game's) | 72.8% | 80.6% |
| run_frame (tick walk) | 6.8% | 3.7% |
| macro engine | 7.0% | 4.8% |
| API polls | 3.0% | 1.3% |
| pump | 3.6% | 3.2% |
| worst 3 renders (`--peak 3`) | 98.8% | 94.0% |

- **The user's rule: readability over noise-level gains.** Undone for it: the
  walking bit in `process_macros`, the three-way `carrier_tl` split, the
  byte-offset track table (~0.24%, accepted). Any future speed-up must show in
  an A/B profile and read plainly.
- **Measuring**: line attribution is ±1 instruction (a long instruction's time
  lands on the next line); per-function totals hold. A/B with
  `git checkout <rev> -- drv/68k drv/sgdk`, profile, `git checkout HEAD -- …`.
  **Profiles taken before `b54d937` ran a broken sin008** (tracks stopped at
  ~13 s); do not compare against them.
- **Left, for when a game actually drops a frame**: hand-written assembly for
  the hot paths only (the macro step, the tick walk, `mmlp_plan`), the C kept as
  the reference — the gates would need a 68000 emulator or a BlastEm A/B; a
  per-frame-numbered profile output; the sequencer pushing pairs directly
  (~1–2%, a large change).
- **Rejected**: pre-rendering macros (XGM by another name — the user wants a
  synth the game can play); spreading one frame's render over the lead.

## 10. Onset jitter under write bursts (2026-10-07)

What the user hears as tempo wobble: a frame whose pairs exceed the Z80's
service slides every key-on behind them. The behaviour that landed — the voice
hoist and key-ons last — is `language.md` §9 and `driver.md` §3.5.

- **The test score is sin008**, a mucom import that must never enter the repo
  (`~/Desktop/mucom/sin008.mmlisp`), single-bank pcm1. The wobble near 14 s is
  the 15.02 s downbeat, where fm4/fm5 switch voice (65 writes in one frame).
  BlastEm, 2–30 s:

  | | late p95 | max | 15.02 s beat (fm1/fm5/fm4/fm2) |
  | --- | ---: | ---: | --- |
  | before | 18.0 ms | 91.1 ms | 16 / 50 / 88 / 91 |
  | hoist | 17.1 ms | 31.9 ms | 0 / 12 / 19 / 22 |
  | hoist + tail cut | 17.1 ms | 31.7 ms | 0 / 12 / 19 / 22 |

  Key-ons last on top: chord spread p95 19.5 → 3.0 ms, max 33 → 4; late p95
  17.1 → 16.4. WAVs in `~/Desktop/mucom/onset-listen/`.
- **The user's verdicts**: key-ons last adopted after listening. The user
  accepted a changed release tail, and a note ending up to two frames early,
  over tempo wobble — then the tail cut made **no audible difference**
  on sin008, so it is built but off by default (fewer writes). Revisit only on
  a score with a long release before a voice change.
- **Declined after measuring**: skipping unchanged pitch pairs (half of
  sin008's rewrite the same value, but only 12 fall in heavy frames over 30 s).
- **No transport increase.** More expander steps help `pcm1` only and reopen
  the images' hardware risk. Capacity is closed; the work is fewer pairs ahead
  of a key-on.
- **Rejected**: the 68000 writing patches under BUSREQ (the engine keeps the
  port-0 latch at `$2A`, and the expander's address/data writes are not atomic
  against a bus stop); a frame mark in the FIFO (makes lateness uniform, does
  not create service); writing the new patch right after the key-on (the
  attack is the most audible part of the note).
- **Open, in this order**: **PCM STAGE** — without an MMB change, the sequencer
  peeks the track's next PCM note and sends a STAGE command (SRC/END/WRAP/bank,
  no generation) once the previous START is applied, so the note's START diffs
  to one pair; a prepayment never required for correctness. **Ordinary FM3 in
  the short-group priority** when the converter's `$27` shadow says normal mode
  and the frame has no `$27` write. **Key-ons last × `banked_writes`** — not
  applied there (its short-groups-first rule would be undone), no listening
  yet. The hoist windows are fixed options (rest 4 frames, note cut 2); a
  song-level setting to widen them was discussed and is not built.

## 11. SE, and several songs

**SE** (behaviour: `driver.md` §2.5, §12.2a; `language.md` §9.3):

- **Authored in MMLisp; triggered by a host call, not a source marker** — no
  language, IR or MMB change, and the hard part (suspend/restore) is the same
  either way (user, 2026-07-19).
- **Bundle the control data, share the sample bank** — chosen *explicitly
  over* runtime cross-MMB banking. Worth re-opening if several scores ever
  become resident; not a prerequisite.
- **`def-se`, one way only** (2026-09-28): "実際にゲームに使えるドライバーに
  したいので解決は必要", "def-seに一本化したい / 古い実装は必要ない". What
  forced it: an SE addressed by TRACK ID shifts with each song's track count,
  so a game could not hold a constant; and a song using every channel had no
  spare one to author an SE on. The user ruled: one effects file injected into
  every song; one effect may have several parts; a def-se carries a default
  priority the host may override. **Mine, not ruled on**: an effect is a DEF
  (so `import` carries it and "tracks are songs" stands); a part is on the
  channel it takes; an effect keeps its own tempo.
- **Re-trigger the restored macros, not resume them**, and losing an in-flight
  sweep is accepted as an authoring rule: "作曲者が長いスイープのチャンネルを
  SEに割り当てないようにすること".
- **CH3 is taken whole** — "3ch丸ごとで良いです".
- **Restore from the register shadow, not a voice id** — "レジスタの控えから
  戻す方法にしてください". Partial `def-fm` voices were not rebuilt otherwise.
- **No `:master` / `:lfo-rate` in an effect** — "SEでは:master,
  :lfo-rateは使わない"; the compiler refuses them. The rule for any future
  song-wide state: refuse it in def-se, unless it belongs to a channel the
  effect takes, in which case the snapshot carries it.
- **Open: the SGDK example's SE (`example/main.c`) has not run on hardware.**

**Several songs** (behaviour: `driver.md` §2.3, `mmb.md` §10.2):

- The shared bank is built (`drv/tools/bundle.mjs`). **A non-PCM song in a
  bundle still boots the bundle's image** — a reboot-free song change is worth
  more than the idle voice.
- **Two scores resident at once is not built**, and is what a cross-file
  transition would need. The cost: the per-score state (`MMLSeq`'s stream,
  `voices`, `macro_table`, `sample_entries`, `sample_blob_base`, `increment`,
  `frame_hz`, `pcm_voices`; `drv-player.js` likewise) moves off the sequencer —
  better into a score struct the track points at. The ones with teeth: the
  tempo increment is per score, so a TEMPO_SET must reach only its own tracks;
  two scores baked for different standards must be refused at load; **two
  scores wanting different engine images cannot be resident at all** (the image
  is the Z80's program); and no harness gates two MMBs (`buildMmb` returns one
  blob).

## 12. Decisions that answer a question someone will ask again

- **Keep LOOP and CALL/RET separate — do NOT add a count to CALL.** A
  single-use `(x N …)` is L+3 bytes as a LOOP but L+5 as a counted CALL (the
  body forced out of line, plus a RET and a dest pointer). Counted-CALL wins
  only ~4 bytes on the rarer *shared* looped phrase (33 vs 37) while taxing
  every ordinary loop 2 bytes. The synergy is composition, not merger.
- **Dedup inside loops** (2026-09-26, rule in `opcodes.md` §5.2), measured:
  demo-acid 1012 → 646 B, the corpus 35.6 → 35.2 KB, every re-encoded score's
  register trace identical to the depth-0 encoding.
- **`(trig N)`'s status byte was shaped against a "a Z80-only driver exists some
  day" lens** (user, 2026-09-21). That ruled out a 68k-struct sentinel and a
  read-clears call: in a Z80-only build the game reads one byte through the
  window and must not have to write back.
- **`#label` used to emit the trig opcode with its own sequence number**, so
  every looping track wrote a phantom trigger at its loop head — invisible to
  every gate because nothing read the byte. The user chose **labels emit
  nothing**, over a separate opcode.
- **DAC ownership is a static compile-time rule, not runtime arbitration.** The
  "last KEY-ON wins" plan (18 B) was dropped when both its premises fell; the
  direction is `:prio` treating fm6 and pcm1–3 as parallel layers of one
  channel, so the driver arbitrates zero bytes. Open: `:prio`'s monophonic
  flatten cannot yet express "fm6 vs the *group* {pcm1,pcm2,pcm3}", and runtime
  SE cannot be flattened at compile time. Note fm6 taking the channel idles the
  driver's most expensive routine — **the cycle saving is paid in music (the
  drums stopped), not free.**
- **The `$2A`/`$2B` ownership split.** The sequencer *could* predict the `$2B`
  edges, but then both sides would have to agree on the exact frame — a coupling
  worth avoiding when voice activity is the one piece of state the Z80 owns.
- **Sub-tick note timing is retired** (`SLOT_SUBS = 1`, user's call: "most game
  drivers are 1/60"). Idle went 71.9% → 78.6%. **The machinery is left in the
  sources on purpose**: at SUBS=1 LTO folds it away and the SGDK host never
  encodes slots, so deleting it buys nothing measurable and would touch the C,
  the JS reference, the slot format and the gates. Two shapes exist for its
  sake and are still right: PCM tracks are **not** subdivided (that would move
  PCM notes earlier than their frame), and `pcm_frame` runs after the **last**
  sub-tick. A channel that steps at sub-tick 0 and then takes a note-on steps
  **twice** — correct, because the note-on re-instantiates the macros.
- **The PSG soft-envelope divergence is left as-is** (user): the source is a
  finished mucom song, so neither player is authoritatively right; **the goal is
  simply ir ≡ drv.** Keep both fixes; do not revert.
- **The song-start voice burst cannot be fixed by spreading setup at compile
  time** (the user's idea, measured and refused). What delays the first notes is
  the **wire** — ~250 writes at 16 pairs/frame ≈ 16 frames. Spreading setup
  staggers the channels unless every note start is delayed by the same amount.
  Priming at load addresses it (shipped); VSET bodies in ROM would (open).
- **A tick-written macro `:step` runs on the track's tick clock** (user,
  2026-09-27), over an 8.8 fractional frame step: the frame rounding it replaced
  drifted a keyon roll off the beat (a 16th at 118 BPM is 7.63 frames → 8); the
  8.8 step would have averaged right but jittered a frame per hit and ignored
  tempo changes.
- **A `:keyon` retrigger restarts the envelopes, not `:pitch`/`:semi`** (user,
  2026-09-27, option "a" of three): restarting every macro broke the
  retriggered arp; restarting none left a per-hit level envelope unplayed.
- **Velocity in eighths of a step** (user, 2026-09-27): the intent was "compute
  fine, quantize once at the output". The user asked whether this is over-spec
  for the Mega Drive: no — the chip's TL resolves 0.75 dB, and a fade stepping
  2 dB is audible zipper noise. Cost ~420 bytes of ROM tables.
- **The horizontal interrupt is the game's.** The user wanted HBlank left free
  for games that need it (racing, raster 3D); the host pumps from VBlank only
  (`driver.md` §6.6). The user's order: **correct playback first, then
  optimization**, and eventually trading some quality for balance.

## 13. How to work here (the user's rulings)

- **Measure the symptom, don't reason from a bound.** "I argued that any lost
  sample is permanent drift and therefore 99.1% must still drift. **It does
  not.** Do not use '98–99% is not good enough' as a rule."
- **One variable per build.** Stacked changes made a regression unattributable.
- **Do not spend the user's build-and-listen rounds on guesses.** Until the
  model predicts the machine, every engine change is a guess. Fix the model, or
  measure the machine.
- **Only ask for a listening test when the answer discriminates between
  hypotheses** — not when it is your experiment.
- Re-measure rather than guessing: every guess in the 2026-08 bring-up was
  wrong, and the profile was right each time.
- An intermediate fix that only makes a symptom *smaller* is the wrong **shape**
  of fix; the user is right to reject it.
- **A coefficient fitted to make the model match an observation is not a
  hardware measurement.**
- **No single number is a pass.** Not the nominal rate, not the frame-processing
  rate, not "the DAC bytes are identical", not how it sounds.
- **Do not stack unproven work.** While two voices are unsettled, three voices,
  arbitrary pitch and better interpolation are more unknowns on top of an
  unknown.
