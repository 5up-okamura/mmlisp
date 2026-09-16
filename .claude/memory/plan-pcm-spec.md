# PCM/DAC language spec — settling it against the shipped engine (2026-09-14)

The four PCM paths disagree: the browser (ir-player + live/worklet.js, closest
to the docs), the JS reference driver + C sequencer (2 voices, loops keyed on
the sample, 6 dB shift model), the shipped pair-transport engine (1 voice, no
loops, 15 linear levels) and the docs (3 soft-mixed voices, the ring engine's
model). The user wants ONE spec before SE. Audit done 2026-09-14 (file:line
evidence was in that session; re-derive from the code, it is quick).

## Bugs found, independent of the spec (not fixed yet)

1. fm6 FM is silent on hardware in EVERY song: the engine boots with
   `$2B=$80` (gen-stream.mjs boot) and `q_push` drops every `$2A/$2B`
   (mmlispseq.c). Docs promise fm6 in the gaps.
2. C out-of-bounds: `PARAM_SET VEL/VOL` on pcm3 writes `s->pcm[2]` with
   `MML_PCM_VOICES 2` (mmlispseq.c param path; the JS has a guard). The
   exporter emits a VEL at every loop head, so any looping pcm3 track hits it.
3. The bank is baked for 60 × 166.674 = 10,000.45 Hz (`PCM_BAKE_RATE_REF`,
   mmb.js) but the engine plays 9,987.57 Hz: PCM ~2.2 cents flat vs FM.

## Decisions (user, 2026-09-14)

* D2 rate: ONE fixed rate, stated in the spec, and the bank is baked for the
  engine's true rate (fixes bug 3). 9,987.57 Hz today; D1's two-voice study
  may lower it — the spec number waits for that verdict.
* D3 loops: shot-only for now (plays to its end or is cut by the next note on
  the voice; `:mode loop` / loop points become errors). The user WANTS loops
  back once there is a way — engine loop wrap is boundary work, design later.
* D4 levels — REVISED by the user (2026-09-14, second answer): back to the
  6 dB shift model (driver.md §14/§14.1, decided 2026-08-12: stepped by
  design, finer resolution out of scope). The shipped 15 linear LUT pages
  (3,840 B, nearly half the Z80's 8 KB) came from the designer log's own
  requirement (dac-engine-implementation.md line ~110 "at least 16 levels, do
  not narrow the fade to a bit shift", §24 the 15-level profile) and the
  implementer carried it into R28 WITHOUT flagging that it contradicted the
  user's decision — the user: "more memory than expected, I said bit shifts
  were enough; this is not what I intended". Implementation is free to pick
  the cheapest constant-time form (a few shift pages keep today's cycles at
  ~1/3 the RAM; composing master into each voice's shift on the 68k removes
  the master stage), chosen together with D1 because RAM and cycles trade.
  The freed RAM goes to the second voice.
  DIRECTION AGREED (2026-09-14): keep TABLES, not runtime shifts — a table
  read is ~11 cyc whatever the level (`ld l,a / ld a,(hl)`) and also carries
  the biased-unsigned conversion; a constant-time `sra a` chain pays its
  maximum every sample (8 cyc a step: 32/voice to −24 dB, +48 for master to
  −36 dB) out of a 358-cycle slot, and cycles are what limit the voice count.
  Few pages: 6 dB rungs to −36 dB + silence = 7 pages (1,792 B) with master
  FOLDED into each voice's rung on the 68k (total rung past the limit = mute,
  driver.md §14 rule) — one table read per voice, the post-mix master stage
  removed, ~2 KB freed for the 2nd/3rd voice's clamp. Final form confirmed
  by the cycle measurements in the D1 study.
* D5 pitch: per-note bake is the spec; no C2–C6 clamp (the bank is the only
  limit); glide/vibrato/`:pitch`/macros on PCM → errors instead of silence.
  User asked about octave-by-shift: the engine ALREADY has a 2^k step
  (self-modified add, host rounds to 1/2/4/8, MMB flags bits4-7 exist); only
  the exporter always bakes k=0. Costs no Z80 cycles; saves bank ROM; costs
  aliasing (decimation, no low-pass) and ≤16·step samples of tail. Up only.
  DECIDED: exposed as an explicit per-sample key (name TBD), never automatic.
* D6 fm6/DAC: per song — a score with PCM owns fm6 as the DAC all song (fm6
  FM + pcm in one score = error); a score without PCM gets fm6 as FM. The
  "fm6 in the gaps" behaviour is dropped. Fixes bug 1.
* D7 `:bit-depth` `:volume` `:compress` `:reverb`: never implemented anywhere;
  the user wants ALL of them later (small per-sample adjustments). Until then:
  warn "not implemented" instead of silently ignoring (proposed).

## Decided in the second round (2026-09-14)

* D0 DECIDED: the browser must sound like the driver ("otherwise this is not
  a production environment for this driver") — the worklet emulates the
  engine's rate, 8-bit output, voice count and level model.
* D1 DECIDED direction: multiple voices are wanted. First study (A) TWO
  voices at a LOWER rate — find the highest rate the generator places with 2
  voices + transport + corrector (estimate ~8 kHz: +70 cyc/slot on a slot at
  worst 83.8%), with D4's shift levels; then (C) compile-time premix of
  pcm1..3 overlaps on top, for more expression. The user wants the FINAL
  VERDICT reported (rate, voices, levels, RAM, cost) before the spec is
  implemented. Why 1 today (R28 §63.2): 2-voice mixer 207 cyc/slot vs ~135,
  512 B clamp table, IX/IY/AF'/HL' now used by the expander.
  KEEP THREE VOICES POSSIBLE (user, 2026-09-14): the study also measures a
  3-voice point (rough guess ~6.5-7 kHz at ~+70 cyc a voice; a 3-voice sum
  needs a wider clamp than the 512 B table; the generator has never tried a
  third voice), and nothing chosen for 2 voices may close the door on 3 —
  register allocation, RAM map, level scheme, the host's voice handling, and
  `pcm1`–`pcm3` stay in the language. The verdict reports 1/2/3 voices side
  by side (rate, cycles, RAM).

Order: (1) cleanup, no behaviour change; (2) D1+D4 study → verdict to the
user; (3) implement the spec in every layer + bugs 1-3 (bug 3's bake rate
waits for D1's rate); (4) premix; loops (D3) and D7 keys later.

## D1 + D4 study — DONE 2026-09-15 (89631ad), VERDICT AWAITING THE USER

Method: the real generator (new N-voice pair profile, shipped image untouched)
placed with the decode, corrector and protocol; rules = worst slot <= 83.9%,
mean <= 79.6% (the designer's 20% margin, not relaxed), code inside its
region; lap held <= 430,080 master (one grab a lap), expander steps for 1.5x
the 960 pairs/s wire; each best point then RUN in the JS machine (gate-nv:
every interval = slot length, every DAC byte = an independent reference;
negatives mis-cost / wrap fail as they must).

D4 as built: 8 rung pages (silence + shift 0..6 = to -36 dB; the note above
said 7 pages — 7 rungs need an 8th page for silence), signed in / biased out,
master folded into the rung by the host, one table read a voice. 1v mix 104
cyc/sample vs shipped 129; levels 2,048 B vs 3,840 B.

WHAT EACH PIECE OF EXPRESSION COSTS (2026-09-16, the same method; every cell
placed and assembled, and the rung/step points also RUN in gate-nv):

    max rate (Hz)        per-voice level        no level at all
    1 voice  no step        12,052                 12,969
    1 voice  step           10,782                 11,547
    2 voices no step         8,482                  9,420
    2 voices step on v0      7,765                  8,646
    2 voices step on both    7,131                  7,799
    3 voices no step         5,524                  6,438
    3 voices step on v0      5,264                  5,926
    3 voices step on all     4,716                  5,295

Per voice per sample: the rung read (= the level, and the signed->biased
conversion with it) is 18 cyc; the 2^k octave step is 26 (24 on voice 0, whose
step-free advance is `inc de`); the saturating add + clamp of each EXTRA voice
is 37. Mix totals: 1v 104/78, 2v 235/209/183, 3v 366/314/288 (step on all/v0/
none). CHANGING a level is nearly free — it is a self-modified page at the
voice's block edge, 26 cyc per 16 samples.

Two things the matrix settles. (a) The engine image is ONE build, so the step's
26 cycles are paid by every song whether or not any sample uses D5's octave
key; dropping the key outright buys +717 Hz at 2 voices, and a baked octave-up
copy costs only +50% of that sample's ROM (it is half the length) — ROM for
cycles, which is the trade this driver should always take. (b) Dropping the
level model buys +881 Hz at 2 voices (11%) and costs all PCM dynamics; it is
the smallest of the three costs and the one worth keeping. Give up BOTH and 2
voices reach 9,420 Hz — i.e. the shipped one-voice rate, which is exactly the
shape of the drivers that carry two fixed-volume, fixed-pitch voices.
Past that point the binding rule is no longer the mean (74.6%) but the worst
slot, and the worst slot is a voice's START edge — the note machinery, not the
mixing. Further rate would have to come out of start/stop/park/compare
(~53 cyc/sample at 2 voices), not out of expression.

The level-free column is a placement + TIME result only: gate-nv's reference
mixes rungs, so it does not check a level-free image's VALUES.

| voices | octave step | max rate | mix cyc | code/region | limit |
| 1 | - | 10,782 Hz | 104 | 2,474/4,864 | worst slot (START) |
| 2 | both | 7,131 Hz | 235 | 2,373/4,352 | mean |
| 2 | v0 only | 7,765 Hz | 209 | 2,328/4,352 | mean + xp A beside the mix |
| 2 | none | 8,482 Hz | 183 | 2,763/4,352 | worst slot (START) |
| 3 | all | 4,716 Hz | 366 | 2,226/4,352 | mean |
| 3 | v0 only | 5,264 Hz | 314 | 2,156/4,352 | mean |
| 3 | none | 5,524 Hz | 288 | 2,124/4,352 | mean |

8 kHz with 2 voices misses by ~2 cycles a slot IF the octave step is kept
(xp A 151 + mix 209 + 18 vs 375.9); without the step it is clear.
Caveats: loops (D3) would add ~150 cyc/voice/block of edge work — ~4% mean at
2v; 2v/3v need the host's lap constants (32/48/64-slot laps, 9-11 steps)
redone.
RECOMMENDATION (revised 2026-09-16): 2 voices at 8,482 Hz, the level model
KEPT, D5's octave key DROPPED (every note baked at its own pitch, octaves too)
— the step is the expensive knob and the only one whose cost can be paid in
ROM instead. Premix (C) for a third layer; 3v at 5.3-6.4 kHz is too dull
(Nyquist < 3.2 kHz).

## Where the slot actually goes, and what the margin costs (2026-09-16)

At the 2-voice / 8,482 Hz point, per sample (422 Z80 cycles): mix 185, the four
note edges 51, the pair expander 40, the DAC write + fetch 18, CSM/YM/corrector
32 — and 96 cycles (23%) of deliberate margin. Only 44% of the slot is mixing;
about 17% is the Z80 being the whole song's output stage (the expander and the
YM traffic), which a driver whose 68000 writes the YM itself does not pay.

Priced with --worst/--mean (they exist to price the margin, not to spend it):
2 voices go 8,482 -> 9,085 Hz at 90/86 and 9,597 Hz at 95/92. The expander's
wire margin is NOT a lever (1.5x -> 1.0x changes no rate; it is not binding).

THE ONE-VOICE CEILING IS ONE LUMPY SLOT, not the total work: at 12,052 Hz the
mean is 58.2% and the wall is the slot that must hold the mix AND the 130-cycle
START edge. Relaxing only the worst-slot rule: 12,648 Hz at 88%, 13,715 at 96%,
with the mean still ~65%. So splitting START across two slots (the edge is
already four pieces; this would make it five) is worth up to ~16.5 kHz at one
voice, where the mean rule would finally bind. UNBUILT, arithmetic only. At 2
voices the same split buys 8,482 -> 8,731 Hz and at 3 voices nothing: there the
total work is the wall.

## D8 — the voice count as the COMPOSER's choice (asked 2026-09-16, open)

One image cannot change its voice count at run time (the slots are unrolled and
constant-time), so the choice is per song at compile time: SEPARATE ENGINE
IMAGES, one named by the score. Levels kept, no octave step: 1 voice 12,052 Hz,
2 voices 8,482 Hz, 3 voices 5,524 Hz. ~7 KB of ROM an image. Feasible if the
RAM map, the op codes and the protocol are IDENTICAL across images — the C
host's addresses are #defines and one of them is baked into inline asm
(mmlispdrv.c:253) — leaving only rate, lap slots, samples a lap, expander
steps, ring lead and voice count as a small per-image descriptor. The exporter
bakes the bank at that image's rate (it is already per-rate), the MMB header
names the image, the browser emulates that rate and voice count (D0), and
declaring 2 voices makes pcm3 a score error. THE COST IS VERIFICATION, not ROM:
every gate (engine:1v/fifo/score, sgdk:gate, gate-nv, ab) runs once an image.

## D9 — the TARGET, restated by the user (2026-09-17)

Levels in 6 dB steps; pitch baked; LOOPS; THREE voices (two at the very
least); catch up with MDSDRV and XGM on rate; and decide it TOGETHER with the
FM/PSG path (the pair wire, the 68k's per-frame cost), not DAC-first.
Arithmetic that frames it: XGM's 14 kHz and XGM2's 13.3 kHz are Timer A
divisions (144 master a tick: 372,869 / 26 = 14,341, / 28 = 13,317 Hz), i.e.
timer-paced variable work with jitter bounded by the chunk length — the
opposite of our cycle-counted zero-jitter slots, where every branch is paid at
its worst case. A bare 3-voice 6 dB mixer with pointers in registers is
~250-280 cyc/sample = the whole Z80 at 13.3 kHz: at that point the Z80 carries
nothing else and no margin. Open (asked of the user): is BOUNDED jitter
acceptable, and is the Z80 to stay the song's output stage? Proposed before any
spec: probe XGM2/MDSDRV ROMs on the BlastEm machine (real rate, interval
histogram, behaviour during YM writes, 68k load), price a timer-paced variant
of our engine in the JS machine, measure our own 68k cost a frame.

## Cleanup — DONE 2026-09-15 (step 1 of the order above)

Health found before it: verify:all green; the dac-stream research bench green
(machine-probe 38/38, decoder-eval); ring engine red (engine 8/12,
dac-model); all-Z80 build red (every score one frame off since prime-at-load);
the verify-rom jig broken. Every step kept verify:all green and the image
byte-identical (d1048f17dd92); sgdk:gate green on m3-pcm-sync.

* Tags (local until pushed): `archive/ring-engine` = de839b2 (pre-cleanup),
  `archive/all-z80` = 90b810e.
* Removed: orphans, the verify-rom jig, the ring engine and its 16 tools, the
  all-Z80 build (drv/src/ entirely) and its 9 tools. rate-mirrors checks only
  68k/mml_rate.h vs sgdk/mmlispdrv_bin.h (bare gen-c-tables / emit-bin
  reproduce both).
* Generator → `drv/engine/`; gates → `tools/engine-{1v,fifo,score}-gate.mjs`,
  `tools/{machine,probe-analysis,cooperative}.mjs` (npm `engine:*`). The
  research bench stays in experimental/dac-stream/ for the D1 study.
* drv/out emptied except the BlastEm build (which was deleted by mistake and
  rebuilt from setup.sh: same revision and patch hash; the core binary hash
  differs — not bit-reproducible — and machine-probe, decoder-eval and
  sgdk:gate give the same results).
* Docs rewritten to the present only (user: "driver.mdに過去の履歴は必要ない、
  常に今だけ"): driver.md 2,550 → ~1,020 lines, top-level numbering kept so
  code references stay valid (§15 folded into §5/§6, §11 = current limits,
  §14.3 = where the PCM layers disagree); drv/README.md, sgdk/README.md,
  roadmap Phase 3, root README, mmb.md (LUT_TABLE has no reader; the exporter
  still emits it), opcodes/language mailbox and MB_TSTAT wording.

Step-3 carry-overs (they touch shipped or installed sources, so NOT done here):
the C/JS ring model — mml_pump + gate_main --pump (no gate runs it),
mml_pcm_ring_fill, the sample ring in drv-player.js, the PCM_RING_* constants
and the PCM_SPG / PCM_FM env knobs in mmb.js; dropping LUT_TABLE from the
exporter (a format change); stale driver.md section numbers in C comments
(mmlispseq.c, mmlpairs.c, mmlispdrv.c/h cite ring-era §5.1.x / §6.x) and
mmlpairs.c:150 "gate-score" (now engine-score-gate) — fix when those files are
next touched, with the SGDK copy list.
