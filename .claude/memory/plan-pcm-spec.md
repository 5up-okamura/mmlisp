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
The timers, correctly (an FM sample is 144 YM clocks = 1,008 master; the
earlier note here used 144 master and was wrong): Timer A ticks once a sample,
53,267 Hz / n — 13,317 (n=4), 10,653, 8,878, 7,610 Hz...; XGM2's 13.3 kHz is
n=4, XGM v1's 14 kHz is more likely 256 Z80 cycles a sample (13,982 Hz).
Timer B ticks every 16 samples, 3,329 Hz / m — it CANNOT pace samples (the
old engine's 3.33 kHz ceiling, dac-engine-implementation.md §2), only be
observed for phase. CSM owns Timer A whenever it is on. So a timer-PACED
engine (the XGM way) is incompatible with CSM, and MMLisp keeps CSM: the DAC
must stay cycle-counted, which is why every branch is paid at its worst case.
The user's "either timer" is satisfied by cycle-counted pacing + a timer
OBSERVED once a lap for phase, and the timer that is always free is B.

THE USER'S STANDING DOUBT (2026-09-17): the phase reference is the VDP H
counter and the pumps hang off VBlank/HInt — "we said going back to VSync
would be a regression, yet here we are". What is true: the sample clock is
the Z80's cycle count, not the frame (the rejected design was mixing a frame
inside a VBlank ISR); what the doubt is right about: the reference ties the
engine to video timing (PAL unsupported, §11), the Z80's VDP read path is
unverified on hardware (§13.3 said so), and the log's second candidate —
Timer B short-window observation — was never tried. Re-opening it is
legitimate, and Timer B works with CSM on or off.

Jitter: the user will decide by EAR, not by number. With cycle-counted pacing
jitter enters only through bus stops (today one 28 µs grab a lap); the lever
worth hearing is the 68k writing the YM directly (drops the expander + YM
traffic, 72 cyc/sample ≈ +25% rate) at the price of longer stops. Proposed
study round before any spec: (1) render the same score through the JS
machine with stops of 28/60/100/200 µs at 60-125 Hz and listen; (2) build
Timer B observation as the phase reference and measure its resolution against
the corrector's need; (3) probe XGM2/MDSDRV ROMs on BlastEm (real rate,
interval histogram, stop behaviour, 68k load); (4) measure our 68k cost a
frame.

## D10 — THE BIG GOAL, chosen by the user (2026-09-17)

The user: implementing "correctly and strictly" had become a shackle; the
balance between the big goal and the small ones was off. Go for the big goal:

* NO PITCH: no octave step (D5's key dropped; every note baked at its pitch).
* VOICE COUNT CHOSEN PER SCORE, 1–3 (D8: one engine image per count).
* LEVELS in 6 dB steps (D4's rung pages, master folded in).
* AS HIGH A RATE AS POSSIBLE — approach XGM / MDSDRV.
* LIGHT over exact (D9 direction): no phase observer, no corrector, stops not
  repaid; VSync-only host.

Open when asked "anything else before we go?" (2026-09-17), put to the user:
(1) who writes the YM — keep the Z80 pair expander, or the 68k writes FM/PSG
directly (the biggest rate lever; the ear accepted 200 µs stops); (2) loops
(D3; D9 listed them) this round or later; (3) the 20% work margin — keep, or
shrink (2v priced: 8,482 -> 9,085 Hz at 90/86%, 9,597 at 95/92%); (4) how a
score names its voice count (a language form — needs the user's design).
ANSWERS (user, 2026-09-17):
(1) YM writes stay on the Z80 — the user wants a Z80-ONLY driver in the
future, so the Z80's YM machinery should not be thrown away. Asked for more
discussion. Measured for it (voice-study, levels, no step): the expander's
capacity is NOT what limits 1–2 voices — wire margin 1.5x / 0.75x / minimum
8 steps all give 1v 11,972 Hz and 2v 8,482 Hz; the wall is one slot holding
the mix + the START edge (130–142 cyc). At 3 voices (mean-bound) the minimum
expander lifts 5,524 -> 6,088 Hz (+10%). Lifting the 8 ms lap to a frame
buys nothing (2v worse, 7,665). So keeping the YM on the Z80 costs ~0 at
1–2v and ~10%+ at 3v; splitting START over two slots is the 1–2v lever.
Z80-only caveat on record (plan-68k-split "Why"): the sequencer's median is
19.7k cyc/frame = 33% of the Z80 — that, not the YM, is what a Z80-only
driver pays out of the PCM.
(2) LOOPS: IN this round (the user: other drivers do not have them). Open
design point for later: the wrap lands on a 16-sample block edge, so the
loop body length vs the block (exporter pads/resamples the body to a
multiple of 16?) — to be proposed.
(3) MARGIN: not fixed at 80%; "to the edge is fine if it plays". The margin
only guards cost-model error (a mis-costed slot runs long -> slightly flat,
not a crash) and real-hardware waits measured only on BlastEm.
(4) a language setting for the voice count is fine; the form is still to be
proposed (precedent: `(def title "Song")` metadata defs).
ROUND 2 (user, 2026-09-17):
(1) DECIDED: the Z80 keeps writing the YM ("let's try hard on the Z80"). The
future Z80-only driver is designed once the whole picture is visible, not now.
(2) LOOPS, the user's aim: loop START and END (not "a length" — corrected by
the user) changeable per note ("to fit the performance") and DYNAMICALLY
through curve functions; rounding to block-friendly numbers is fine. The
language already has `:loop-start` / `:loop-end` (sample frames, relative to
the slice) on `def :sample`, and `:mode loop` per note. So start/end are
runtime PCM state the 68k sends (like a level), taking effect at a block
edge, curves evaluated on the 68k. The wrap happens at the first block edge
at/after END, so what gets rounded is END to START + a multiple of 16 (after
the per-note bake). DECIDED, no further language design (user): on a track
they are written like any other parameter — `:loop-start N` directly, or a
curve (e.g. `(sin …)`, and `(macro :loop-start …)` as other params do).
Watch: on a short single-cycle loop the rounding is a detune.
(3) OK. The YM wait table (engine/config.mjs `wait`) already IS XGM2's
measured one (SGDK src/snd/xgm2/drv_xgm2.s80 header: addr->data 6, $28 53,
$30-$9E 39, $A0-$B6 22, $21-$2F 0) — the user said no need to re-check.
(4) DECIDED: `(def pcm-voices N)`, like `(def title …)`; absent = the highest
pcmN the score uses; a pcmN above N is a score error.
XGM2 FACTS read from its source (2026-09-17), for the "approach XGM" target:
100% Z80 (parses the stream and writes FM/PSG itself), 3 PCM channels 8-bit
signed at up to 13.3 kHz (Timer A = 4 FM samples; ~269 cyc a sample), PCM
paced by Timer A with a write/read ring buffer, loops from a 64-byte-aligned
loop point (on/off per play), half-speed playback, NO PCM volume (volume
commands are FM/PSG only). So its rate comes from average-cost work (timer +
ring) and no PCM levels; ours pays the worst case every slot because CSM
owns Timer A. Our dynamic loop length and PCM levels are what it lacks.
Defaults stated, not asked: the Timer B study (item 2) dropped; one image per
count, bank baked at that image's rate; browser emulates the image (D0);
bugs 1–3 fixed on the way; verification cut to value + time per image;
XGM2/MDSDRV measured (item 3) as the yardstick, not as a gate.

## NEXT — the design is WRITTEN: plan-pcm-d10-design.md (2026-09-17)

The design session ran the same day; its output is
[plan-pcm-d10-design.md](plan-pcm-d10-design.md) — read THAT to implement.
The generator prototype it measured is in the tree (`loops: true` profile,
`npm run dac-stream:light`); the shipped image is untouched, verify:all green.

## (superseded) the brief the design session was given

The spec is decided (D10 + both answer rounds above). Proposed split: a design
session (Fable) turns it into a concrete design, then implementation sessions
(Opus) build it layer by layer. The design must pin down, with the generator
RUN (the rates are measurements, not estimates):
* the engine per voice count 1/2/3: no observer/corrector/ladders/phase page,
  loops at the block edge, START split over two slots, levels as rung pages,
  no octave step, work margin to the edge — placed, with the resulting rate
  of each image;
* what stays IDENTICAL across the three images: RAM map, op codes, protocol,
  and the small per-image descriptor (rate, lap, steps, voices);
* the wire: state stores for voices 1–2, loop start/end, and the host
  converter (mmlpairs.c + its JS twin) for pcm2/pcm3, loops and curves;
* the sequencer/reference (C + drv-player.js) and the exporter: bake at the
  image's rate (bug 3), loop END rounded to START + 16k after the bake, the
  MMB header naming the image, `(def pcm-voices N)`, errors for
  pitch/glide/vibrato on PCM (D5), fm6 per song (D6, bug 1), pcm3 OOB (bug 2);
* the browser worklet emulating the image (D0);
* gates proportionate to the light direction (value + time per image) and the
  order of work, each step leaving verify:all green.
Guard for the implementers: the user's decisions override any older designer
document (the 15-level LUT precedent in D4) — flag a contradiction, never
carry it silently.

## D9 study item 1 — the stop-length listening set, DONE 2026-09-17, VERDICT: ALL ACCEPTABLE

`npm run dac-stream:stops` (experimental/dac-stream/stop-listen.mjs; README
section "The stop-length listening set"). sin008 through the shipped image in
the JS machine with a bus stop of 28/60/100/200 µs at the VBlank pump (60 Hz)
or both pumps (120 Hz); per variant a full FM+PSG+DAC mix through the
browser's nuked cores and a DAC-only track, in drv/out/dac-stream/stop-listen/
(gitignored — rebuild, ~45 s). `shipped` = the machine's own timing; `repaid`
= an ideal repaying engine: plays the stop0 bytes (its sample index stays on
the wall clock), each stop delays the next slots until a ladder sized to the
stop (1.25 × L × stops a lap) pays it back.

    stop            shipped pitch 60/120 Hz  shipped onsets >5 ms  repaid ladder/slot  repaid onsets
    28 µs (100 cy)  0 / 0 ct                 none                  0.8 / 1.5 cyc       ≤0.1 ms
    60 µs (215)     −6.6 / −13.3 ct          2 / 1 of 46, ~15 ms   1.6 / 3.2           ≤0.1 ms
    100 µs (358)    −13.3 / −26.6 ct         1 / 1, ~15 ms         2.7 / 5.4           ≤0.2 ms
    200 µs (716)    −19.9 / −40.1 ct         1 / 2, 12–16 ms       5.4 / 10.8          ≤0.3 ms

THE USER'S EAR, round 1 (2026-09-17): shipped 100/200 µs at 60 and 120 Hz —
"timing not off"; the first `carried` twin — "off". That twin was MY MODEL
BUG: it re-timed the shipped run's bytes (onsets already at wall-clock places)
onto a repaying clock, moving every later onset EARLY (−47 ms by the end at
200 µs). Replaced by `repaid` above; onsets are now measured in the manifest.
The user asked whether the set is about how much onset offset is tolerable:
it is not mainly — shipped keeps onsets because the host's pairs place them on
the 68k clock; what a stop costs the shipped image is PITCH (PCM flat, by an
amount that moves with the stop length), which sin008's all-drum PCM cannot
reveal. VERDICT, round 2 (user, 2026-09-17, after the `repaid` rebuild): "with the
current output, none of them is a problem" — every variant, shipped and
repaid, 28–200 µs, 60 and 120 Hz. So by ear on sin008 a bus stop of up to
200 µs twice a frame is acceptable: the holes are inaudible, and shipped's
unrepaid stops (−20/−40 ct) do not show on drum PCM. What the verdict does
NOT cover: pitch on a sustained pitched PCM note against FM — the set has
none (the test samples are 30–46 ms). If that ever matters, it is the one
listening case left; the user did not ask for it.
Implication for items 2–4: a 68k that writes the YM itself (longer stops) is
not ruled out by the ear. The Timer B study (item 2) is now about PITCH and
the VSync doubt, not about audible jitter: whether stops of this length need
repaying at all depends on pitched PCM, and repaying them needs a reference
that does not wrap inside the stop plus ~5–11 cyc/slot of ladder.

DIRECTION (user, 2026-09-17, after the verdict): "pitch is hard to judge on
drums, but for now I want LIGHT processing that buys features, not strict,
exact, heavy processing" and "it would be good if VSync alone does it". Read
as: no phase observer, no corrector — stops are simply not repaid (PCM runs
flat by stop time / frame time, e.g. 200 µs a frame = 1.2% = −20 ct, the
sin008 file the user accepted) — and the host pumps once a frame at VBlank
only. The Z80's sample clock stays cycle-counted (that part is not the
rejected mix-in-a-VBlank-ISR design). A direction, not yet a spec.
What it frees, counted from the generator's chain (2026-09-17, levels kept,
no octave step; per-lap cycles spread over the lap's slots):
    decode 603 + protocol 268 (ctl/pub) + corrector 1,109 + 7 ladder jr 84
    ≈ 2,060 cyc a lap  ->  1v 21 cyc/slot of 297 (7%), 2v 32 of 422 (8%),
    3v 64 of 648 (10%)
plus the 256 B phase page, the VDP read (unverified on hardware, §13.3) and
its NTSC calibration, and the "lap <= 8.01 ms" rule (it exists for the
corrector's one-grab-a-lap budget). ARITHMETIC ONLY, NOT PLACED: at 3 voices
(mean-bound) −64 cyc/slot suggests ~6,200–6,300 Hz vs 5,524; at 1–2 voices the
worst slot (a START edge) binds, so the gain is smaller. The protocol's boot/
commit generations are judged through the corrector today ("build both"), so
how much of the 268 really goes needs the generator. VSync-only also halves
the wire (480 pairs/s, MMLP_AHEAD_ONE 48) — fewer expander steps, a longer
grab; whether 480 pairs/s carries dense scores (`late` count) is unmeasured.
Consequence for the study round: item 2 (Timer B as phase reference) loses its
purpose under this direction; items 3 (what XGM2/MDSDRV do — do they repay at
all?) and 4 (our 68k cost a frame) still inform it.

FINDING (measured, then predicted exactly from one number): THE H-COUNTER
REFERENCE WRAPS EVERY SCANLINE (3,420 master = 228 Z80 cycles), so the
corrector reads a stop MODULO a line, folded into ±114 cycles — 215 reads as
−13 (the engine is slowed 13 MORE), 358 as −98, 716 as +32; the 1,500-master
contract IS half a line. Past it the shipped corrector repays the wrong
number, not nothing. Consequences for the 68k-direct-write question: (a) any
stop over ~32 µs needs a reference with a longer wrap — Timer B's period is
16 FM samples × m = 16,128·m master = 1,075·m Z80 cycles (300 µs at m=1),
which is the direct link to study item 2; (b) the ladder must carry L·f of
every second (200 µs × 120 Hz ≈ 9–11 cyc/slot vs today's 1.4); today's
ladder carrying the debt would end sin008 50–305 ms behind.

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
