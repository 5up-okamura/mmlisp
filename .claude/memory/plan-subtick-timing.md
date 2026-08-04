# Sub-frame note timing (K sub-ticks per frame) — design settled 2026-08-05

Reported symptom: note onsets are quantised to the 60 Hz frame, which is
audible in fast passages and much worse on triplets (128 BPM, PPQN 96: a 1/8
triplet is 9.373 frames, so every onset is up to half a frame out). See
[[plan-68k-split]] "Per-note timing: what 60 Hz costs" for the tempo table.

**Status: STEP 1 LANDED 2026-08-05.** `SLOT_SUBS = 3` in all three ports
(`live/src/slot-builder.js`, `drv/68k/mmlispseq.h`, `drv/src/engine.z80`), the
gate suite is green, and the design now lives in `docs/driver.md` §3.5 / §5.1 /
§5.2 / §6.2 — read there first, not here. What is left in this file is the
measurement that justified the split, the step-1 deviations worth keeping, and
steps 2-3, which are not built.

## The finding that makes step 1 cheap

The mixer already runs **exactly three voice passes every frame**
(`PACE_PASSES = 3`, silent voices included, `engine.z80` `pp_feed`), and the
pacing pad holds *every* tick body to the same period `frame / R` regardless of
role. So the two pass boundaries sit at **1/3 and 2/3 of the frame in paced
time, and they already exist** — consuming part of the slot there needs no
interleaving into the mix loop, and no registers, because the mixer's register
file is not live between passes.

That is the whole answer to "can this ride on the PCM processing?": the
subdivision points are a by-product of the DAC pacing fix.

Caveat: the ~13k cycles/frame of segment set-up are NOT paced, so the boundary's
real position wanders by the same ~3.4 ms as the DAC feed. Onset error therefore
goes 16.7 ms → 5.56 ms ± 3.4 ms now, → 5.56 ms ± ~1 ms once the segment work in
[[plan-68k-split]] lands. Net win either way.

## Why only note dispatch subdivides (measured 2026-08-05)

`dump-trace.mjs` on `m3-macro-multi`, steady state (init burst excluded, 97
frames, 641 writes):

| class | writes | share |
| --- | --- | --- |
| key on/off | 5 | **0.8%** |
| F-num / PSG period | 414 | 65% |
| TL | 112 | 17% |
| PSG att | 76 | 12% |

**Note dispatch is under 1% of steady-state write traffic; macro/sweep stepping
is essentially all of it.** So putting note-ons on sub-ticks costs *zero* extra
writes, and putting macros/sweeps on sub-ticks multiplies 99% of the traffic by
K. Change-only does not rescue it — F-num.lo already changes 124 times in 97
frames, i.e. every frame.

Against `SLOT_MAX_WRITES = 95` and a typical ~60-write frame, K=3 macros would
be 180 writes/frame → permanent spill → writes land a frame late → the timing
error the whole exercise removes comes back. Self-defeating, so **not now**.

The semantics are NOT the blocker, and this is worth not re-deriving: curve
sampling is already compile-time (`ir-utils.js`), so the compiler can sample at
K× resolution and existing scores keep their modulation *rate* unchanged. Only
cycles block it.

## Ordering — and why it is the same work as the PCM fix

1. **Note dispatch → sub-ticks.** +0% write traffic. Ready to build.
2. **Cut the mixer's per-segment cost** ([[plan-68k-split]], the (1)+(2) item).
   This is the PCM audio fix AND the funding for step 3: the cap is
   `(59,659 − mixer − 500) / 61`, so halving the ~13k of segment overhead buys
   ~107 writes and takes the cap from 95 to about 200 — which is what K=3
   macro/sweep stepping needs.
3. **Macro/sweep → sub-ticks**, K applied uniformly to every target (no
   per-target selection), paid for by step 2.

## Step 1 — what shipped, and where it deviates from the spec below

Built as specified, with four things the spec did not anticipate:

- **PCM tracks are NOT subdivided.** They take the whole increment at sub-tick 0
  and keep exactly the frame-grid timing they had. The spec left this implicit
  by putting PCM onsets out of scope; making it explicit matters because
  subdividing them would have moved PCM notes *earlier* than the frame that
  owns them — the engine applies a frame's whole PCM command list at the frame
  head, before it mixes.
- **`pcm_frame` runs after the LAST sub-tick, not at sub-tick 0.** Same reason
  from the other side: a `PCM_VOL` a late sub-tick generated (a MASTER move)
  must be in force for this frame's samples, or the reference mixer and the
  engine's diverge. At K = 1 this is the same place it always was.
- **The engine re-latches `$2A` after every sub-slot run.** The feed writes the
  DAC blind (§5.1) — a sub-slot carrying any YM port-0 write moves the latch,
  and the rest of the frame's samples land in whatever register the slot touched
  last. This was the one real bug in bring-up and it is invisible to every gate
  that compares sample values.
- **The RAM map moved.** The consume loop pushed the image past 4 KB, so the mix
  planes and voice state went from `$1000`/`$1200` up to `$1600`/`$1800`, above
  the ring. The published header stayed at `$1300`, so no protocol bump and no
  host source change — but `drv/sgdk/mmlispdrv.bin` had to be re-emitted.

Cost: engine image 3982 → 4134 B, slot +6 B/frame, zero extra chip writes. The
ab-gate baseline moved on 8 of 43 scores and three of them got *closer* to
ir-player, because the engines now run in the sub-tick-0 slice and late dispatch
follows them.

## Step 1 spec (as designed — kept for the reasoning)

- **`SLOT_SUBS` = K, a build constant, = `PACE_PASSES` = 3.** `K = 1` must be
  byte-identical to today so the current gate baselines stay valid.
- **Accumulator.** Per track, per frame, distribute the tempo increment over the
  K sub-ticks by Bresenham: `step_j = ((j+1)·inc)/K − (j·inc)/K`. The sum is
  exactly `inc`, so §3.2's zero-drift-over-loops property is untouched.
- **Per sub-tick:** the tick-accumulator drain and event dispatch (every opcode
  on the track's stream). **Per frame, at sub-tick 0:** sweep stepping, macro
  stepping, `fade_track`'s ramp, PCM position bookkeeping, `pcm_frame`.
- **Macro phase — DECIDED (option 1).** A note-on at sub-tick j>0 runs *that
  channel's* macro first step at j, immediately after `macro_trigger`, not at
  the next frame's sub-tick 0. driver.md §13.1 requires the first step to fire
  in the same frame and override the note-on's base level; leaving the step pass
  at sub-tick 0 would invert that order within the frame. A channel that already
  stepped at sub-tick 0 and then gets a note-on at j steps twice in the frame —
  correct, because note-on re-instantiates the macro, so those are two different
  instances.
- **Slot format** (driver.md §6.2): K repetitions of the three length-prefixed
  runs, then the frame-level PCM command list.
  `{ [n_psg][psg…] [n_fm0][{r,v}…] [n_fm1][{r,v}…] } × K  [n_pcm][cmds…]`
  K is a build constant, so no count byte. +6 B/slot at K=3. The consume loop
  keeps its "no per-write dispatch" property — that is why sub-slot *blocks*
  beat per-write timestamps.
- **Queue → buckets.** One ordered queue as today; record `q_head` after each
  sub-tick's render and those are the bucket boundaries. Order, change-only and
  the shadow are all unchanged.
- **Cap and spill.** The cap stays a **frame total** (it bounds Z80 cycles per
  frame, not per sub-slot). `encode_slot` walks the queue once, filling buckets
  in order, stopping at the frame cap or the 256-byte budget; the remainder
  spills to the next frame's sub-slot 0 as today. Strictly finer than now:
  overflow from bucket 0 lands in bucket 1 of the *same* frame.
- **Z80 consume.** Sub-slot 0 at frame head as today; sub-slots 1 and 2 between
  the `mix_voice_frame` calls in the pass loop. **When no PCM is sounding the
  mixer is not entered at all** (`pp_run` returns early), so that path needs a
  paced idle loop providing the same two boundaries — otherwise a PCM-less score
  silently gets no subdivision. Two small code paths; the cursor and sub-slot
  index live in engine scratch.
- **`pcm_debt` needs no change.** It wants the frame's total write count, still
  known at frame head from the K bucket lengths. Spreading the writes across the
  passes actually fits the debt's uniform-spreading model better than today's
  frame-head lump.
- **Gates.** `slot-gate`, `c-gate` (39 scores), `ring-gate`, `engine-gate`,
  `dac-gate` all see the slot format. `drv-player.js` is the executable spec and
  models sub-ticks first. Run `SLOT_SUBS=1` against the existing baselines to
  prove the refactor is inert, then freeze `SLOT_SUBS=3`.

## Out of scope for step 1

- **PCM onset sub-ticks.** Voice-outer means a voice's pass covers the whole
  frame; starting mid-frame needs a leading IDLE segment = ~2,400 cycles per
  note-on. So the part that matters most for drums is gated on step 2 — state
  this plainly rather than implying PCM gets finer timing in step 1.
- **`(trig N)` markers.** Still undesigned ([[plan-68k-split]] open item 4);
  whoever designs the marker queue should know sub-ticks exist, since a marker
  will want its sub-tick as well as its frame.
