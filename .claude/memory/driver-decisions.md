# The driver's decision record

What the docs do not carry: why MMLispDRV is shaped the way it is, the
measurements that cost real work, and the user's rulings. **The design itself is
`docs/driver.md`** — if a fact about the present is in both places, that one
wins and this one is wrong.

PCM is [[pcm]]. Open work is `docs/roadmap.md` (Driver) and `docs/driver.md`
§11; what is listed as open here is only the reasoning those omit. The
superseded engines are tags `archive/all-z80`, `archive/ring-engine` and
`archive/dac-stream-bench`.

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
- Another homebrew driver's data point: **8 fixed-pitch PCM voices ⇄ 2
  pitched, switchable**. A voice count says nothing about feed uniformity, and
  that is the part worth learning.

**For any Z80 player** (a stream player included), learned on the all-Z80
build: the game's VDP DMA stops the Z80's access to the ROM window, so a DAC
fed from it must play from a ring in Z80 RAM deep enough for the longest DMA,
and the game must flag its DMA (XGM2's protocol); bank switches (~9 writes)
belong per chunk, not per sample. Accumulate **biased-unsigned** (`sample ^
$80`) so the sum needs no sign extension; two page-aligned planes let one
8-bit index address both (`inc h` / `dec h`); **`exx` is flag-transparent**,
so a frac carry chains into the pointer add — but `exx` swaps BC too, so load
the increment into C *after* it. Two image build traps: **the image boots at
level 0**, and until the bank is set the window shows ROM bank 0; and
`ld a,(LUT>>8)` assembles as a **memory load** — write `ld a,LUT>>8`.

## 5. Three bugs that no gate could see

All outside the code under test, all silent:

1. **`tools/z80asm.mjs`: `$` meant the address of the NEXT instruction**, so
   `djnz $` jumped past itself — a 26-iteration pad loop that ran once, a sample
   clock 4.5× too fast, no error anywhere.
2. **`tools/z80cpu.mjs` charged every `(HL)` operand 3 cycles too few** (7 is
   not 4; `ld (hl),n` is 10, not 7), and the mixer's hot loop was `ld a,(hl)` +
   `add a,(hl)`. **Every cycle budget in the repository was computed against an
   under-charged model.** Fixed with a selftest pinning the documented counts.
   Treat any modelled figure from before commit `9c7c51f` as uncalibrated — and
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

## 9. The 68000's share

The user's direction: keep the split and make the 68000 side cheap, so a game
keeps the CPU for raster effects and 3D. Settled by listening on 2026-10-14
(a banked mucom import, score B of §10, had slipped frames; two frames of lead, the
first optimisation pass and the voice spread of §10 fixed it). Working notes:
git history, `plan-68k-optimization.md` at `afef069`.

| score A whole, `sgdk-profile --pc`, 30 s | before (`ba094a6`) | after (`bf50bdc`) |
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
  **Profiles taken before `b54d937` ran a broken score A** (tracks stopped at
  ~13 s); do not compare against them.
- **Left, for when a game actually drops a frame**: hand-written assembly for
  the hot paths only (the macro step, the tick walk, `mmlp_plan`), the C kept as
  the reference — the gates would need a 68000 emulator or a BlastEm A/B; a
  per-frame-numbered profile output; the sequencer pushing pairs directly
  (~1–2%, a large change).
- **Rejected**: pre-rendering macros (XGM by another name — the user wants a
  synth the game can play); spreading one frame's render over the lead; for
  score B's one remaining heavy frame (five voices at the head of a
  `(go loop3 2)` repeat, 242% of a frame), a copy before the loop plus a
  rotation into the body's tail rest, or a voice-id skip in `apply_patch` —
  the user heard no problem after the fixes; a banked_writes rewrite that
  reads the ring once (byte-identical over 400k fuzzed frames, p50 −36%, but
  no gain on the peak frames and +4 KB RAM); staging early in the host lane
  (at lead 1 the next frame is never queued at the vblank, at lead 2 no
  better).
- **The figures to reopen with** (BlastEm, `sgdk-profile --fn` / `--pc
  --peak`, a banked score): a YM register write costs ~2,000 cycles end to
  end — ~400 in the sequencer (`ym()`, shadow, `q_push`), ~870 in the banked
  converter, ~220 in `mmlp_plan` and the grab — so a peak render is its write
  count (116 writes = 2.4 frames); the converter is 2% of all 68000 time but
  30–45% of a peak render. Steady state: the tick walk ~550 cycles a track a
  frame, a macro slot ~1,000 a frame, `mmlp_plan` + pump ~3%; the driver's
  average ~17% of the 68000. The C-level items left (a tick-walk fast path
  ~1.5%, skipping HOLD macro slots ~0.5–1%) stop at 3–4 points; past them
  the structural change is the sequencer pushing pairs straight into the
  converter's queue (−2% average, −30–40% on a peak, −5 KB RAM).

## 10. Onset jitter under write bursts (2026-10-07)

What the user hears as tempo wobble: a frame whose pairs exceed the Z80's
service slides every key-on behind them. The behaviour that landed — the voice
hoist and key-ons last — is `language.md` §9 and `driver.md` §3.5.

- **The test scores are two private mucom imports that never enter the repo**
  (kept on the user's machine): score A, dense, single-bank pcm1, and score B,
  banked. Score A's wobble near 14 s is
  the 15.02 s downbeat, where fm4/fm5 switch voice (65 writes in one frame).
  BlastEm, 2–30 s:

  | | late p95 | max | 15.02 s beat (fm1/fm5/fm4/fm2) |
  | --- | ---: | ---: | --- |
  | before | 18.0 ms | 91.1 ms | 16 / 50 / 88 / 91 |
  | hoist | 17.1 ms | 31.9 ms | 0 / 12 / 19 / 22 |
  | hoist + tail cut | 17.1 ms | 31.7 ms | 0 / 12 / 19 / 22 |

  Key-ons last on top: chord spread p95 19.5 → 3.0 ms, max 33 → 4; late p95
  17.1 → 16.4. The listening WAVs are on the user's machine.
- **The user's verdicts**: key-ons last adopted after listening. The user
  accepted a changed release tail, and a note ending up to two frames early,
  over tempo wobble — then the tail cut made **no audible difference**
  on score A, so it is built but off by default (fewer writes). Revisit only on
  a score with a long release before a voice change.
- **Declined after measuring**: skipping unchanged pitch pairs (half of
  score A's rewrite the same value, but only 12 fall in heavy frames over 30 s).
- **No transport increase.** More expander steps help `pcm1` only and reopen
  the images' hardware risk. Capacity is closed; the work is fewer pairs ahead
  of a key-on.
- **Rejected**: the 68000 writing patches under BUSREQ (the engine keeps the
  port-0 latch at `$2A`, and the expander's address/data writes are not atomic
  against a bus stop); a frame mark in the FIFO (makes lateness uniform, does
  not create service); writing the new patch right after the key-on (the
  attack is the most audible part of the note).
- **Declined for their cost** (user, 2026-10-13 — the expected gain looked too
  small for the cost; a judgment, not a measurement):
  **PCM STAGE** (the sequencer peeks a track's next PCM note and stages
  SRC/END/WRAP early so its START is one pair — lookahead in the ROM
  sequencer for a few ms, while the PCM lane already jumps the FM backlog on
  both hosts);
  **ordinary FM3 in the short-group priority** (when the `$27` shadow says
  normal mode); **key-ons last × `banked_writes`** (its short-groups-first
  rule would be undone). The wobble the user then heard on a banked score was
  the render slipping a frame, not the order (two frames of lead, below);
  reopen the FM3 or key-ons-last item only if a wobble is heard again.
  `banked:sgdk` measures it.
- **The hoist windows stay fixed** (rest 4 frames, note cut 2; user,
  2026-10-13), no song-level setting: a wider rest window only sends the voice
  earlier, and the note cut is already controlled where it matters — a slur
  keeps the voice in place, a `:gate-` silence is used as it is. Revisit only
  if a score suffers from the cut.
- **Within the window, the lightest frame, and a voice before a rest moves
  too** (user, 2026-10-14): the behaviour is `language.md` §9. Why: on
  score B the two measured slips were not hoisted voices at all — a voice the
  mucom importer wrote before a rest (`stab _2 (x 26 _1 e …)`) landed on
  another channel's beat (fm5's key-on 33 ms late at lead 2), and the head of
  a `(go loop3 2)` repeat puts five voices with their notes in one frame. So a
  voice written before a rest is treated like one in the gap, and every placed
  voice takes the first frame of its window free of voices and FM key-ons.
  The loop head was left as it is — one beat's worth, and a driver change —
  and the listening that followed settled it (§9). Measured: score B FM
  key-on error max 33.3 → 14.0 ms, the voice-change render 153% → 117% of a
  frame; a lone voice lands where it did. Spreading does nothing for the
  single-bank WIRE (the pairs before a key-on are the same however they are
  spread over the window); it is the 68000's render it halves.
- **Two frames of lead, eight pairs ahead** (user, 2026-10-14). The
  frame slip above is the render missing its vblank; `MMLISP_LEAD` 2 gives it
  the whole frame before. The user's worry was SE latency — one frame of
  delay, an effect arriving late, matters a lot to them — so the wire was
  measured first: the
  host placed a grab 32 pairs past the engine's index (48 past a frame-old one
  on the light host), 18.3 ms of dead wire at two banked voices (p50, every
  pair, BlastEm). Read fresh and placed 8 past it: 5.7 ms, every gate green.
  The slips are gone (score B FM key-on lag p90/p95 19.9/23.7 → 5.5/7.7 ms).
  Both hosts, one rule. Re-measured after the 68000 pass (score B 40 s): lead
  1 still slips — key-on lag p95/max 18.3/38.8 ms, interval error p95 17.9 —
  on ordinary 107–126% frames at 8–31 s, not only the 242% loop head; lead 2
  gives 6.7/22.2 and 7.2. So LEAD 2 stays until a render fits a frame.
- **Every start sounds in the frame it is drained in** (user, 2026-10-14):
  the silent armed frame that held a song's, a track's and an
  effect's first note back ~17 ms is gone — one rule, not an SE-only branch,
  since the FIFO wire already keeps a head's writes ahead of its first key-on.
  The head still runs at the head of the track's first frame (`fresh`),
  before that frame's tempo step: run inside the accumulate loop, the first
  tick piles up at the old tempo before a head TEMPO_SET lands, a sub-frame
  phase offset for the whole song (pal-gate caught it on m3-voice and
  m4-voice-hoist). Priming at load reuses the same flag: start, dispatch the
  head, stop. The call → sound figure an effect gets now is `driver.md` §3.4.

## 11. SE, and several songs

**SE** (behaviour: `driver.md` §2.5, §12.2a; `language.md` §9.3):

- **Authored in MMLisp; triggered by a host call, not a source marker** — no
  language, IR or MMB change, and the hard part (suspend/restore) is the same
  either way (user, 2026-07-19).
- **Bundle the control data, share the sample bank** — chosen *explicitly
  over* runtime cross-MMB banking. Worth re-opening if several scores ever
  become resident; not a prerequisite.
- **`def-se`, one way only** (2026-09-28): the user wants a driver a game can
  really use, so this had to be settled, and wants `def-se` to be the single
  way — the older implementation is not needed. What
  forced it: an SE addressed by TRACK ID shifts with each song's track count,
  so a game could not hold a constant; and a song using every channel had no
  spare one to author an SE on. The user ruled: one effects file injected into
  every song; one effect may have several parts; a def-se carries a default
  priority the host may override. **Mine, not ruled on**: an effect is a DEF
  (so `import` carries it and "tracks are songs" stands); a part is on the
  channel it takes; an effect keeps its own tempo.
- **Re-trigger the restored macros, not resume them.**
- **The displaced part plays on, unheard** (2026-10-16). The earlier ruling —
  an in-flight sweep lost, kept out by authoring (a composer was to avoid
  assigning a channel with a long sweep to an effect) — was reversed: a sweep
  that does not come back on a channel an effect took is a bug. Probing it
  found the larger
  fault: a suspended part did not advance, so after an effect it was late by
  the effect's length for the rest of the song, in both players. **Chosen**:
  the part keeps dispatching into a per-channel ghost (`MMLGhost`) with the
  channel's writes dropped; ghost and live state trade places only around
  what the part does to its channel. **Not chosen**: advancing the clock and
  catching up at SE-end — every event of the effect's span lands in one frame
  ($slot reads, trig, loops at the wrong time) and a sweep's value has to be
  computed apart. Measured (m68k-elf-gcc sizes): `MMLSeq` 15,042 → 14,402 B
  (the per-track snapshot went; ten 128 B ghosts came). Left open: a
  `:master` the ghost's own stream
  writes recomposes every channel but the effect's, which is stashed in the
  ghost at that moment (rare: master is song-wide and usually set at the
  head).
- **No effect on CH3** (user, 2026-10-16), reversing "taking all of channel 3
  is fine": a ghost for CH3 would span the shared channel, four operators,
  the chip-wide `$27` and Timer A, and several tracks writing one ghost —
  heavy for the driver — so the compiler refuses a CH3 part (`E_SE_PART`)
  and the driver's CH3 hold (claim, restore, dissolve, `MMLCh3Snap`) went.
- **Restore from the register shadow, not a voice id** — the user's ruling: go
  back from the register copy. Partial `def-fm` voices were not rebuilt
  otherwise.
- **No `:master` / `:lfo-rate` in an effect** — the user's ruling: an effect
  does not use them; the compiler refuses them. The rule for any future
  song-wide state: refuse it in def-se, unless it belongs to a channel the
  effect takes, in which case the channel's ghost carries it.
- **Prime the voices of effects on free channels** (user, 2026-10-15).
  Measured on BlastEm (SGDK example + demo-se,
  2026-10-14): an FM SE that brings its voice onto a song channel sounded
  81 ms after the call = lead 33 + pump to the first pair 8 + wire 40 (its
  ~35 voice/level/pitch writes ahead of the key-on, ~1 pair/ms on the light
  images); PSG/PCM effects, which upload nothing, ~42 ms. The rule (both
  players' prime, `driver.md` §4.1): an effect part is primed when no song
  track anywhere in the table uses its channel and it is the first effect
  part there; the prime clears the setup's sweeps after it. Closed with it:
  an effect's `:tempo` sweep drove the song's clock (now `E_SE_PART`).
  **Not chosen**: LEAD 1 (re-measured after the
  68000 pass, still slips); an SE lane running effect tracks two frames ahead
  of the song (two clocks, ownership/restore edge cases, three players +
  gates, and it does not touch the upload); a faster light-image wire (more
  expander steps + a higher per-frame cap, trades PCM rate/voices). An effect
  on a song channel still pays its upload — the advice is to keep FM effects
  on free channels (`drv/sgdk/README.md`). Measured after it (demo-se with
  bleep/zap moved to fm4/fm5): 46.7 / 46.1 ms, four writes in the frame
  (TL, pitch, key-on), from 72.9 / 70.4 before.

**Several songs** (behaviour: `driver.md` §2.3, `mmb.md` §10.2):

- The shared bank is built (`drv/tools/bundle.mjs`). **A non-PCM song in a
  bundle still boots the bundle's image** — a reboot-free song change is worth
  more than the idle voice.
- **Two scores resident at once** (roadmap Driver 3) is what a cross-file
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

- **VOICE_SET bodies in ROM: what they would buy** (measured 2026-10-27, not
  built; the roadmap item). A ROM-fed YM write in a pad, priced by hand at
  ~134 cycles inline (two window reads at `windowWait` 3, the address/data
  writes, the $2A latch put back, a constant-time end) — `call`ed, ~161, fits
  no slot. Slots with a pad >= 134 (the light images' placement tables):
  pcm1 55 a lap = ~7,060 writes/s (a 30-write body in 4.2 ms); pcm2 5 = ~630/s
  (below the 960/s wire: no gain); pcm3 8 = ~1,110/s (the pads are 137, so
  the estimate has 3 cycles of slack). Upper bound on the corpus
  (onset-timing with every frame's >= 8-write channel body taken off the wire,
  2-20 s, 123 single-bank scores): late key-ons (> 8 ms over usual) 122 -> 93,
  all of it on two synthetic scores (m3-voice-loop 38 -> 9, stress-m1's max
  34.8 -> 27.3). It would also need a fence (a key-on pair must wait for its
  body) and a twin in every layer. The user's ruling (2026-10-27): today's
  performance is enough — the mucom benchmark songs are fine. Reopen only
  when a score written with MMLisp's full feature set shows lateness that
  survives the hoist and key-ons last (re-run this counterfactual on it).

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
- **The gates' slot encoder stays in `mmlispseq.c`** (user, 2026-10-15). It,
  `mml_command` and `mml_start_all` serve only the gates, but SGDK builds with
  `-ffunction-sections` + `--gc-sections` + LTO, and a built ROM's symbols
  hold none of them; the gate-only RAM is six bytes. A separate file would buy
  nothing on the target and cost an internal header for the queue it reads.

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
- **PAL: supported, not verified, low priority** (2026-10-27). PAL is a CLI
  export only (`--pal`; Live stays NTSC), and it needs to be correct by
  construction, not gated or run on hardware: no PAL DAC gate, no PAL
  hardware pass, no PAL UI. Do not propose them.
- **Do not stack unproven work.** While two voices are unsettled, three voices,
  arbitrary pitch and better interpolation are more unknowns on top of an
  unknown.
