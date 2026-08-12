# MMLispDRV v0.3 Architecture — 68k sequencer + Z80 PCM/write engine

Status: **architecture pivot, 2026-08-02.** MMLispDRV was an all-Z80 driver
through v0.2 (M1–M3, gate-verified in emulation). Cycle measurement on real
scores showed that the sequencer and a multi-voice PCM soft-mix cannot share
one Z80 — see §1.1. The sequencer therefore moves to the 68000 and the Z80
becomes a dedicated PCM mixer and chip-write engine.

This document defines both halves and the interface between them (§6). It
consumes MMB v0.2 unchanged (`docs/mmb.md`, `docs/opcodes.md`) and absorbs the
interactive-playback design vision that previously lived in `docs/spec-v0.5.md`
§4; **this is its canonical home** (§2).

## 1. Role and Constraints

Two processors, one clock:

- **68000 — the sequencer.** Walks the MMB, runs the tick accumulators,
  dispatch, sweeps and macros, composes levels and pitch, and **pre-renders
  each frame into a register-write list** which it deposits in a ring in Z80
  RAM (§6). The MMB lives in 68k ROM and is read as a plain byte array — no
  bank window, no 32 KB wall.
- **Z80 — the engine.** Consumes one ring slot per vblank, paces the writes
  to the YM2612 (0x4000–0x4003) and SN76489 (0x7F11) itself, and spends the
  rest of its frame on the PCM soft-mix feeding the fm6 DAC (§5.3). It
  evaluates nothing: every value it writes arrives register-ready.

**The Z80 keeps the clock.** It consumes exactly one slot per vblank at its own
interrupt, so tempo stays 60 Hz-exact and a heavy game frame is absorbed by the
ring rather than stuttering the music. That autonomy is what motivated the
all-Z80 design in the first place, and it is the one property the split had to
preserve.

Design principles (working agreements applied to the driver):

- **Pointer walking only.** The MMB is decoded in place; no parsing pass,
  no unpacking, no allocation.
- **The engine stays dumb.** All computation that can happen at compile time
  does: BPM → tick increments, note names → MIDI numbers, Hz → Timer A
  periods, easing vocabulary → a 4-shape curve set. Everything else happens on
  the 68000 — including all *runtime* computation the score needs (health →
  volume, speed → pitch, §6.5). The Z80 owns exactly one piece of live state:
  PCM sample position.
- **Determinism.** Frame-by-frame register output is a pure function of
  (MMB bytes, host command history). The JS reference and the 68k C must
  produce matching write logs; the Z80 must reproduce the slot's writes and
  the mixer's DAC stream exactly (§12).

### 1.1 Why the split — the measurement that forced it

A 60 Hz Z80 frame is **59,659 cycles** (3.579545 MHz ÷ 60), and overrun is not
graceful: the vblank `/INT` is asserted for about one scanline, so a long frame
misses the next interrupt outright and the score loses a whole frame.

The all-Z80 PCM soft-mix measured **~240 cycles per voice per mix tick plus
~260 fixed per tick** after the optimisation pass — 3 voices at `PCM_MIX_R`
= 175 ticks/frame is 972/tick = 170k/frame = **285% of the budget**. Rewritten
to the theoretical floor for the same semantics (16.16 resampling, per-voice
volume, i16 sum), ~110/voice + ~120 fixed gives:

> 2 voices × 175 ticks = **59,500 cycles = 99.7% of the frame, with the
> sequencer executing zero instructions.**

So the ceiling is not the sequencer's fault — its median frame is only 19.7k
(33%). The two workloads simply do not fit in one Z80, and no Z80-side
technique moves the gap by the required factor. The earlier position that "68k
offload is the architectural last resort" was argued on **bytes**, and the code
overlay pass solved the byte problem; the binding constraint is now **cycles**.

### 1.2 What the split buys beyond voice count

The sequencer leaving frees **~7 KB of Z80 RAM** (5.6 KB of code plus TCB 512 B,
channel state 640 B, shadow 304 B, macro/sweep state). That is what makes the
real mixer fix possible — a **voice-outer pass over a full-frame mix buffer**
(§5.3), which had nowhere to live before. Consequences:

- **Dynamic loop points become free.** A voice-outer pass loads loop
  start/end into registers once per frame, so changing them costs nothing per
  tick and takes effect the next frame. Ping-pong loops and macro-modulated
  loop length become cheap the same way.
- **The 32 KB sample-bank wall dies.** A voice reads a contiguous run of ~175
  samples per frame, so each voice pass latches its own ROM bank and handles at
  most one boundary crossing per frame. Sample memory becomes ROM-sized.
- **The 8 KB Z80 ceiling stops governing the design.** Overlays, the
  byte-funding menu, `DATA_BASE` bumps, `WIDE_OFFSETS`, cross-MMB and PAL
  deferrals all go away — the first three because the Z80 image is small again,
  the last three because the 68k reads ROM directly.

### 1.3 Fixed limits (expectation-setting)

Unchanged by the split, and not worth re-litigating: **8-bit DAC output**
(YM2612), **nearest-neighbour resampling only** (interpolation needs a multiply
per sample — impossible at any usable rate), and **DAC jitter from the 68k's
per-frame bus grab** (~tens of µs, ~0.2%; measure on hardware).

## 2. Interactive Playback Model

### 2.1 Goal

MMLisp is not a fixed-BGM driver. The target is a **DJ-style continuous
audio environment**: scene transitions flow without silence gaps — a title
sting's release tail decays under the incoming stage music; boss → clear →
next-stage transitions crossfade rather than cut. Tempo does **not** need
to match between scenes: tracks from different scores run at their own BPM
independently (hence per-track tick accumulators, §3).

### 2.2 Track lifetime — channel ownership

The unit of runtime control is the **track**, not the score. A score is a
named collection of tracks; the game starts and stops tracks individually
(`MMLisp_startTrack` / `stopTrack` / `fadeTrack`, §6.5).

**Channel ownership rule:** when a newly started track claims a channel
already owned by a running track, the running track is released on that
channel — with its release tail if the voice defines one (key-off, envelope
runs out), otherwise immediately. The channel-state block records the
owning track id (§4.3) to arbitrate this.

**Exception — the FM3 shared channel.** Channel 2 is exempt from eviction:
in FM3 independent-OP mode the note-less `(fm3 …)` voice track and the
`fm3-1` operator track legitimately coexist on it (§13.4), so a second
track claiming channel 2 keeps both rather than releasing the first. The
first claimant owns the shared level state; later ones only key their
operator. (`fm3-2`–`fm3-4` live on ids 16-18, which carry no channel block
and never arbitrate.)

### 2.3 Layering and scene transitions

Tracks from **any number of MMBs** may be active at once. The pre-split
"one MMB per bank window" restriction is gone: the sequencer runs on the 68000,
where every MMB is a directly addressable ROM pointer, so a track control block
simply carries the pointer to its own score. The canonical transition:

```c
MMLisp_startTrack(&sceneB, FM2);
MMLisp_startTrack(&sceneB, SQR2);
MMLisp_fadeTrack(&sceneA, FM1, 60);   /* 60 frames ≈ 1 s */
MMLisp_fadeTrack(&sceneA, SQR1, 60);
```

### 2.4 `len=0` — indefinite hold

A NOTE_ON with duration byte 0x00 keys on and **suspends the track's
dispatcher** until the host calls `MMLisp_keyOff` (on the channel) or
`MMLisp_stopTrack`. Use cases: state-length sound effects (engine rumble,
charge-up), pad chords under a scene, PCM loops held open. Sweeps/macros
already running on the channel keep running while held.

### 2.5 Sound effects run on the 68000

SE is sequencer work — priority arbitration, suspend/restore of the displaced
BGM channel, snapshot of mid-sustain state — so it moves to the 68000 with the
rest of it, and the Z80 stays a pure engine. The cost is that an SE start
inherits the ring's lookahead latency (§3.4): **1–2 frames**, accepted.

## 3. Timing

### 3.1 Clock source and accumulators

The **Z80** runs from the 60 Hz vblank interrupt (Z80 INT, driven by the VDP)
and consumes exactly one ring slot per interrupt — that is the audible clock.
The **68000** renders slots from its own vblank handler, running ahead of the
Z80 by the ring depth (§3.4). A 68k frame that overruns does not retime the
music; it only eats into the lookahead.

Each rendered frame, every active track advances by its tempo increment in an
**8.8 fixed-point tick accumulator**:

```
acc += increment            ; u16 + u16, 8.8
while (acc >= 0x100):       ; integer part ≥ 1
    acc -= 0x100
    advance_one_tick(track) ; count down wait; dispatch events at 0
```

`increment = round(bpm × 96 × 256 / 3600) = round(bpm × 512 / 75)`
(precomputed at compile time; mmb.md §7.5).

### 3.2 Why 8.8, and the error budget

PPQN 96 at 60 fps gives fractional ticks per frame for almost every tempo
(120 BPM → 3.2 ticks/frame). With an 8.8 accumulator:

- **Accumulation is exact.** Integer adds only — the fractional part is
  never discarded, so over any loop of N frames the track advances exactly
  `N × increment / 256` ticks. Every loop pass reproduces the identical
  tick-to-frame pattern: **zero drift over loops**, and two tracks at the
  same increment can never diverge.
- **The only error is the one-time rounding of the increment**, bounded by
  0.5/256 tick per frame ≈ **0.195 hundredths of a tick per frame**. This
  is a constant tempo offset, not accumulating jitter:
  relative tempo error ≤ 0.5 / increment.
  - 120 BPM: increment 819.2 → 819, error 0.024% ≈ **14.6 ms per minute**.
  - Worst case at ≥ 60 BPM (increment ≥ 410): ≤ 0.122% ≈ **73 ms/min**.
  - Exact (zero error) whenever BPM is a multiple of 75 (increment
    = bpm × 512/75; e.g. 75 → 512, 150 → 1024, 225 → 1536).
- **Accumulators are per-track; the increment is per-song.** Tempo is
  score-global in the language (a mid-track `:tempo` retimes every track of
  the score — language.md §5), so a TEMPO_SET/TEMPO_SWEEP decoded on any
  track replaces the increment for **all tracks of its MMB**. Per-track
  accumulators keep only the fractional phase. Independent BPM exists
  *between* songs: tracks of different MMBs each follow their own song
  increment (§2.1).

### 3.3 PAL

On PAL (50 Hz vblank) the same increments play 60/50 = 1.2× slower. The
correction is a 6/5 scale of the increment, and post-split it is **a single 68k
multiply at TEMPO_SET** rather than something the Z80 has to be talked out of —
the PAL_TIMEBASE header flag (mmb.md §4) and the PAL-precomputed-file idea are
both unnecessary. Still unimplemented, no longer deferred for cost reasons.

Note the PCM mixer is unaffected in *pitch* (its increment is per mix tick) but
gains 20% more cycles per frame on PAL, so `PCM_MIX_R` could rise there. Left
NTSC-fixed until there is a PAL target to measure.

### 3.4 Ring depth — lookahead vs live control

**Default depth 3, and it is a per-game tuning knob, not a design constant.**

Depth is lookahead, not decimation: the Z80 still consumes one slot per vblank,
so the music keeps its resolution at any depth — 60 Hz for the engines, and
`SLOT_SUBS` × that for note onsets (§3.5). What depth buys is tolerance.

**One slot is always in use.** Since §3.5 the engine reads sub-slots at 1/3 and
2/3 of the frame, so the slot being consumed stays the Z80's for the whole frame
and the tail is released at its end. The 68000 renders from a loop that woke on
the *same* vblank, so its render lands **inside** that frame — it sees the ring
still holding the slot. Pending lookahead is therefore `depth − 2`, and at depth
2 that is **zero**: the host finds the ring full every frame, renders nothing,
and the next vblank starves. Measured at 50% of frames, on hardware and in the
gate, heard as half-speed music. Depth 3 restores the one slot of lookahead the
pre-sub-tick engine had at depth 2.

So at depth N the game may overrun N−2 frames without the music stuttering. What
it costs is latency on **every host→music operation**: `MMLisp_startSe` is only the
most obvious one; `setVal` (`$slot` live control), `setParam`, `fadeTrack` and
`stopTrack` all inherit it.

Re-rendering the ring on invalidation rescues a one-shot (an SE start, a fade)
at a cost of depth × the per-frame sequencer work — ~24k 68k cycles at depth 4,
19% of a frame. It does **not** rescue continuous control: a game driving
`setVal` every frame would re-render every frame, throwing the lookahead away
*and* paying depth-times the cost, which is the worst case of both. So **deep
lookahead and continuous live control are mutually exclusive**, and since
interactive music is a stated goal of the language (§2), the shallow default is
the honest one.

If depth 2 later proves too shallow for a real game, the escape is **indirect
write-list entries** ("write register X from val slot S"), resolved by the Z80
at consume time, which keeps live control at one frame while the music stays
pre-rendered. Deliberately deferred: it puts resolution logic back on the Z80
and blurs the pure-engine line, so it should be paid for by a measured need.

Independent of depth: the 68k may render N slots in one burst every N frames
rather than one per frame, moving its sequencer work to 60/N Hz. That trades a
steady ~5% load for an N× taller spike at 1/N the rate — better or worse
depending on the game's own frame-budget shape, so it is a per-game choice too,
not part of the interface.

### 3.5 Sub-ticks — note onsets below the frame

`SLOT_SUBS = 3`, a build constant, and it must equal the mixer's `PACE_PASSES`.

A frame is divided into **K = `SLOT_SUBS` sub-ticks**. Note dispatch runs on
every one of them; the engines still run once a frame. That asymmetry is the
whole design, and it comes from a measurement (`m3-macro-multi`, steady state,
97 frames, 641 writes): key on/off is **0.8%** of write traffic, while F-num,
TL and PSG attenuation — sweep and macro stepping — are the other 99%. So
subdividing dispatch costs **zero extra chip writes**, and subdividing the
engines would multiply the frame's traffic by K, blow `SLOT_MAX_WRITES` every
frame, and put the writes back a frame late — reintroducing exactly the error
this removes.

What it buys: onset error goes from 16.7 ms to 5.56 ms ± the DAC feed's ~3.4 ms
wander (§5.1). At 128 BPM a 1/8 triplet is 9.373 frames, so every onset was up
to half a frame out; now it is up to a sixth.

**The accumulator.** Each frame's tempo increment is distributed over the K
sub-ticks by Bresenham:

```
step_j = ((j+1) × increment) / K − (j × increment) / K
```

The K steps sum to exactly `increment`, so §3.2's zero-drift-over-loops property
is untouched and **every dispatch still happens in the frame it always did** —
only its position inside that frame moves.

**Per sub-tick:** the accumulator drain and event dispatch, every opcode.
**Per frame, at sub-tick 0:** sweep stepping, macro stepping, `FADE_TRACK`'s
ramp. **After the last sub-tick:** PCM position bookkeeping, because the engine
applies a frame's whole PCM command list at the frame head and then mixes — a
`PCM_VOL` a late sub-tick generated has to be in force for this frame's samples
on both sides, or the two mixers diverge.

**Macro phase.** A note-on at sub-tick j > 0 runs *that channel's* macro first
step immediately, right after the trigger — §13.1 requires the first step in the
same frame and after the note-on, and the step pass has already run. A channel
that stepped at sub-tick 0 and then takes a note-on steps twice in the frame:
correct, because the note-on re-instantiated the macros, so those are two
different instances.

**Not subdivided: PCM onsets.** A soft-mix voice's pass covers the whole frame
(§5.3), so starting one mid-frame needs a leading IDLE segment — ~2,400 cycles
per note-on. PCM tracks therefore take their whole increment at sub-tick 0 and
keep exactly the frame-grid timing they had. The part that matters most for
drums is waiting on the mixer's per-segment cost coming down.

**What it costs the Z80: nothing structural.** The mixer already runs exactly
three voice passes a frame, silent voices included, and the pacing pad holds
every tick body to the same period — so the two pass boundaries already sit at
1/3 and 2/3 of the frame, and the sub-slots ride boundaries that were there
anyway (§5.1, §6.2). The subdivision points are a by-product of the DAC pacing
fix.

## 4. The 68k Frame — rendering one slot

Frame order is **fixed and normative** — `drv-player.js` implements exactly
this order and the 68k C must reproduce it (§12):

1. **Drain the host command queue:** consume all commands posted since the last
   render, in order. Start/stop/key-off effects apply before any dispatch this
   frame.
2. **For each of the K sub-ticks (§3.5), per track, ascending track index:** run
   the §3.1 accumulator loop over that sub-tick's share of the increment; each
   consumed tick counts down `wait_ticks` and, at zero, executes stream events
   (immediate events run back-to-back; the next timed event reloads
   `wait_ticks`). Key-offs scheduled by the gate rule fire on their tick inside
   this loop.
3. **Engines, ascending channel index — at sub-tick 0 only:** sweep
   interpolators, then macro steppers (§13.3). Dispatch at sub-ticks 1 and 2
   therefore follows the frame's engine writes rather than preceding them.
4. **Publish the slot** (§6.2), its writes bucketed by the sub-tick that
   generated them.

Register writes are **appended to the slot as they are generated**, in dispatch
order, change-only against the 68k's shadow — so the slot's per-port write
sequence is byte-identical to the sequence `drv-player.js` emits. That is a
deliberate choice: full-frame coalescing (emitting each register once, at its
final value) would save ~1% of writes and cost the zero-tolerance raw-equality
gate, which is this project's strongest verification asset. If a future write-cap
squeeze makes coalescing worth it, the gate rebases on per-frame register
*state* — but not before.

The slot buckets writes into three runs (PSG, YM port 0, YM port 1), so
cross-bucket ordering within a frame is not preserved. This is safe by
construction: the two YM ports address disjoint channels, the PSG is a different
chip, and everything whose ordering carries meaning is port-0-local — `$28` key
edges, the `$22`/`$27`/`$2A`/`$2B` globals, and the `$A4`→`$A0` F-number pair
whose shared latch §8 describes.

**YM BUSY policy:** the Z80's consume loop is the only thing that touches the
chip, and it paces itself — see §5.1. The 68000 never writes a sound chip.

### 4.1 Where the cycles went, and where they go now

The all-Z80 sequencer was optimised hard before the split, and the numbers are
kept here because they are the evidence for §1.1 — not as a live budget. Measured
on a 7-track mucom import (gh002, `tools/run-trace.mjs` cycle counts):

| | before the optimisation pass | after |
| --- | --- | --- |
| median frame | 28,132 (47%) | **18,866 (32%)** |
| p99 | 68,458 (115%) | **58,574 (98%)** |
| frames over budget | 3.8% | **0.77%** |
| loop frame | 263,000 (4.4×) | **79,000 (1.3×)** |

A well-tuned Z80 sequencer therefore sits at a third of the frame with a tail
reaching the ceiling — fine on its own, and hopeless with a 40–53k PCM mixer
beside it. The tail is also **flat**: a profile split at 40k found the heavy
frames spread across 40+ routines with the largest at 6.6%, so there was no
hotspot left to remove.

**On the 68000 this workload is not a budget item.** The 68k runs at 7.67 MHz
with 16/32-bit registers and a hardware multiplier, against a Z80 doing 16-bit
arithmetic in 8-bit pieces; the sequencer is expected to land near ~5% of a
68k frame. The number to *measure* on the 68k is not the median but the
re-render burst (§3.4) and the start frame.

Two structural lessons from the Z80 profiling survive the port and are worth
applying to the C:

- **Do not recompute per-channel pointers inside the ascending loops.** Walking
  an induction pointer instead cost 19% of *every* Z80 frame to discover.
- **Test emptiness before the call, not inside it.** The sweep-slot scan spent
  ~180 cycles of prologue before it could report an empty slot, 20× a frame.

### 4.2 The armed frame (starting a track does not sound in its own frame)

A track's clock starts on the frame it was set up in, so a host that staggers
`MMLisp_startTrack` across frames leaves its tracks **permanently out of phase**
by that many frames — 100 ms of flam for a 7-track score, on every chord, for
the whole song.

So track status carries **armed**: the state a track is in for the frame its
start was drained in. Armed tracks do not accumulate; they are promoted at the
top of the next frame and all begin dispatching together. Frame-exact and
tempo-independent — a tick-based delay would have varied with the increment.

**The armed frame also runs the score's head.** A mucom-style score puts its
`VOICE_SET`s at tick 0, so without this the first dispatching frame carries
seven voice applies *plus* the first notes. Dispatch therefore returns early
while the track is armed, at the first opcode that sounds or consumes time
(`$10..$13`): the leading VOICE_SET / PARAM_SET / macro binds run in the armed
frame, the notes wait for the next one.

**PCM tracks are the exception, and they lead by one frame (2026-08-03).** The
mixer feeds the DAC from a plane the previous frame finished (§5.1), so a PCM
command issued in frame N is first *heard* in frame N+1. That delay is exactly
one frame and never varies, so the sequencer cancels it: a PCM track is promoted
in its own armed frame instead of the next one, and from then on runs one frame
ahead of every other track — permanently, since all tracks advance by the same
increment. A PCM hit and an FM hit written on the same beat therefore sound
together. (Its first note already fell in the armed frame, because the early
return above stops at `$10..$13` and `PCM_NOTE_ON` is not one of them, so that
note needed no correction and now gets none.) Without this the PCM part of a
score drags 16.7 ms behind the rest — small on paper, audible on anything the
drums carry.

**Why this survives the split even though the 68k setup cost vanished.** The
original rationale was Z80 cycles — 7 tracks of MMB walk, TCB fill and overlay
loads measured 204k, over three frame-times. That cost is gone. What is *not*
gone is that the head still generates **262 register writes**, against a
per-slot write cap (§6.2) measuring in the tens. So the head spills across
several slots either way;
arming keeps the voice applies ahead of the notes, so no note ever sounds under
a half-applied patch. The armed frame is now a **write-budget** device, not a
CPU-time one.

`drv-player.js` implements this (`armed`), and `ir-player.captureRegisterLog`
mirrors it (`_drvSetupShift`) so the A/B gate compares like with like: the
timeline starts a frame late and each track's leading events are pulled back
onto the preamble frame — a quarter-frame in, so they land after
`_initDefaultVoices` rather than being overwritten by the neutral patch. Capture
only; live playback has no setup frame to hide. What that cannot reproduce is
*when the level model recomposes*: the sequencer composes carrier TL once, in
the armed frame, with the vel the head set, while ir-player writes the voiced TL
and recomposes at the note. Six A/B scores carry 4–12 mismatches of that shape
(all TL, all at the track's first frame) — frozen in the baseline.

### 4.3 Sequencer state (68000)

The pre-split layouts were byte-packed to fit 8 KB of Z80 RAM. On the 68000 they
are ordinary structs and the offsets stop mattering; what follows is the model,
not a memory map. Constant tables (F-number, PSG period, level ladders, carrier
masks, operator offsets, the sin curve unit — §7, §8) are ROM data the C links
directly; both `drv-player.js` (`buildLuts`) and the C take them from
`live/src/lut-blob.js`, so §12 divergence stays structurally impossible.

**Channel state**, one per channel 0–9 (fm1–fm6, sqr1–sqr3, noise; mmb.md §6.1).
fm3 operator sub-tracks (ids 16–18) keep their per-op pitch inside fm3's block;
PCM voices (20–22) have their own state (§5.4).

| Field | Notes |
| ----- | ----- |
| status | bit0 keyed (note active), bit1 PSG audible (att < 15) |
| note | MIDI |
| fnum / PSG period | current, including bend |
| block | FM |
| vel (0–15), vol (0–31), master (0–31) | level model, §7 |
| gate (0–8) | |
| pan (i8 −1/0/1) | |
| key-off countdown | ticks; sentinel = none/held |
| pitch offset | cents, i16 |
| owner track id | channel-ownership arbitration, §2.2 |
| algorithm | selects the carrier mask |
| voiced TL × 4 ops | level-composition base |
| fade counters | Bresenham N/V/err/cur + frames-left |
| sweep engine | 2 slots × {target, curve, flags, phase, from, to, len, step} |
| macro engine | 3 active-macro ids + 3 running slots × {descriptor idx, step clock, cursor, state} (§13) |

**Track control block**, one per active track. Track capacity was 16 on the Z80
because 16 × 32 B was what the RAM allowed; on the 68k it is a build constant
with no such pressure.

| Field | Notes |
| ----- | ----- |
| status | idle / playing / armed / held / fading / suspended |
| track id, channel id | |
| flags | hasLoop / isCsm / isFm3Op |
| stream pointer, stream base | **68k ROM pointers.** JUMP/CALL destinations are relative to the base |
| score pointer | the MMB this track belongs to — this is what makes cross-MMB layering free (§2.3) |
| tick accumulator, tempo increment | 8.8 (§3.1) |
| wait_ticks | until the next timed dispatch |
| control stack | 4 × {ptr, count}; LOOP entries carry the remaining count, CALL entries are tagged |
| fade counter | |
| last MARKER id | published to the host for `(trig N)` sync (§6.5) |

## 5. The Z80 Engine

The Z80 no longer sequences. Its whole job is: take one slot per vblank, put
its bytes on the chips, and spend the rest of the frame mixing PCM.

### 5.1 Frame loop

1. **Claim a slot.** If the ring is empty, skip step 2 — the 68k did not keep
   up. The mixer still runs (PCM must not gap), so the music holds rather than
   glitches.
2. **Read the frame-level head** (§6.2) — the write count, which both sizes the
   pacing debt and decides whether the write pump runs (§5.1.1), and the PCM
   commands the mixer needs — then **consume sub-slot 0**: three length-prefixed
   runs, PSG bytes, YM port 0 `{reg,val}` pairs, YM port 1 pairs. Runs are
   length-prefixed precisely so the loop needs no per-write dispatch. The PSG
   bytes go out here; the YM runs are normally **queued for the write pump**.
3. **Mix PCM** (§5.3) while feeding the DAC — the same loop does both, and it
   also drains the queued chip writes, one per iteration (§5.1.1) — and put
   **sub-slots 1 and 2** out at the voice-pass boundaries (§3.5). Every YM write
   re-latches `$2A` afterwards, because the feed writes it blind. When nothing
   is sounding the mixer is not entered at all, so that path runs a **paced idle
   loop** instead, giving the same two boundaries; without it a score with no
   PCM in it would silently lose its sub-ticks (and with no iterations to drain
   it, such a frame writes its YM runs directly).
4. **Release the slot** — the tail only advances at the end of the frame, once
   the last sub-slot has been read *and* the pump has finished reading the runs
   in place, so the 68k cannot refill a slot the frame is still consuming — and
   **publish** the consumed-frame counter (§6.4).

**DAC PACING (2026-08-03).** The feed is *inside* the mix loops, one `$2A` write
every three ticks, and not a pass of its own. A separate output pass is what the
engine did until this date, and it put a frame's 175 samples out in **12% of the
frame** — right values, ~8x too fast, then a 14 ms hold. Byte-identical to the
reference and unlistenable; it cost three hardware bring-up rounds because every
gate in the repo compared sample *values* and none could see *when* one was
written. `drv/tools/dac-gate.mjs` (`npm run dac`) is the gate that can.

Three things follow from pacing, and they shape the engine:

- **The buffer is read a frame behind what the mixer is writing, so PCM lags by
  one frame.** A sample is final only once the last voice has added to it, so a
  feed that occupies the whole frame can only be feeding what the *previous*
  frame finished. A burst opens with a frame of silence and closes with the
  frames the tail needs; the DAC is released after that tail, not before it.
  `drv-player.js` models the same delay, or the gates would stop meaning
  anything. **The sequencer cancels it** by running PCM tracks one frame ahead
  of the rest (§4.2), so the delay costs latency against the host's input, never
  alignment against the music. (The buffer was two frame-long planes swapped at
  the frame boundary; §5.1.2 replaces them with a ring, and the lag survives the
  change unaltered.)
- **Every frame runs exactly three voice passes**, silently (through `G_IDLEV`)
  where there is no voice — otherwise the cadence would depend on how many
  voices sound, and the samples would bunch into whatever the mix took.
- **Each iteration is padded to the frame's tick period**, `frame / R`. The pad
  is a baked constant per (role, shift) — the generator knows each loop copy's
  cycle cost — minus a runtime **debt**: what the frame spends *outside* the
  loops, which is ~10k cycles of mixer segment set-up plus the slot's own
  writes. Without that subtraction a frame ends ~20% late, which is a slow tempo
  and eventually a dropped frame.

  **The debt is a measurement, not an estimate.** The pads that carry any
  authority are all in the *silent* passes — measured, a sounding pass's pad is
  0–5 units against a silent one's 14–16, and the debt clamps the former to its
  floor anyway — and the silent passes run **last**. By the time the first one
  chooses its pad, every sounding segment has been counted and each remaining
  silent pass is worth exactly one more, so the frame's total is exact. It used
  to be carried over from the *previous* frame and revised only upward within
  this one; one segment of error is ~4% of a frame, at frame rate, which is what
  the DAC wander was. Nothing crosses a frame boundary now.

  **The debt also charges what only hardware pays: the ROM-window fetch stall**
  (`PACE_WINDOW`, gen-mixer.mjs; `pace_win_tab`, added per *sounding* pass —
  MUTE and IDLE fetch nothing). A sample fetch is not a Z80 memory read: the
  `$8000` window goes out over the 68000's bus, and each read waits
  ~`PACE_WINDOW` cycles on its arbiter — ~2,450 cycles a frame per sounding
  voice that no emulator-priced pad knew about, which on hardware was a steady
  2–3 lost frames every second on a *one-voice* song. The charge cannot land on
  the sounding pass itself (its pad is clamped to the floor), so the silent
  passes pay it and the feed's error swings by ~0.05 of a frame — priced into
  the dac-gate bar, and the gates model the same stall per window read
  (`dac-gate`, `seg-bench --stall-read`), so the charge and the cost are
  verified against each other in emulation. `PACE_WINDOW` is the one constant
  to tune on hardware: raise it while `lost/s` in the example's readout is
  non-zero on a one-voice score, lower it if `npm run dac` loses its span.

  **And it is what caps PCM at two voices.** Measured across four scores with
  `npm run budget:frame` / `seg-bench --stall-read`: a frame with one voice
  sounding always fits, a frame with **two never does** (42/42, 6/6, 4/4 over
  budget), by 1–8%. Sweeping the charge on the same frames — 2/42 over at 0
  cycles, 22/42 at 4, 37/42 at 7, 42/42 at 14 — puts the whole overrun on the
  stall and nothing else: each sounding pass makes R = 175 window reads, so a
  second voice costs ~2,450 cycles of pure bus arbitration and the frame does
  not have them.

  Note what this does *not* argue for. The "1 variable + 2 fixed voices" plan
  addresses mix cycles, and mix cycles are not the binding constraint — a
  fixed-pitch voice reads one sample byte per tick like any other and pays the
  same stall. What would cut reads is a loop variant for `incI == 0` (below the
  sample's own rate the same byte serves several ticks, and register C is free
  in that variant to cache it) or a lower `PCM_MIX_R`. Neither is costed, and
  `PACE_WINDOW` was back-fitted from one song's loss rate rather than measured.

  **And it explains nothing about a ONE-voice song**, which is the case that is
  actually still reported as wobbling. Attribute those frames on the song
  itself — `seg-bench <song>.mmb --stall-read 14` reads an SGDK project's `res/`
  directly — rather than on a synthetic score.

What it does not fix: those cycles are real and are not spent feeding, so
between segments the feed still pauses and in between it runs ~20% fast to make
up for it. Measured wander is ~2.5 ms against the burst's 14.7 ms. **Cutting the
per-segment cost is what tightens it further** — see §5.3.

**Unspent pad is not slack; it is silence.** A frame that finishes its R samples
early does not stop making sound — it holds the DAC at its last value until the
next vblank. On a one-voice song running at 90% of budget that was 23 sample
periods (2.2 ms) of frozen DAC at the end of *every* frame, at 60 Hz, which is a
periodic discontinuity, and the samples that did play came out ~10% fast across
the rest. So `PACE_RESERVE` is not free to be generous with: it was re-derived
from 7200 to **5600**, the last step that takes sample periods off every score's
boundary hold while moving no score's over-budget count. `PACE_SEG` stays at
2400 despite measuring ~1,000, because the over-charge is what keeps a
segment-heavy frame inside its budget (cutting it takes m3-pcm-softmix from 12
over-budget frames to 179).

What blocks the rest is **quantisation**: the debt is whole 16-cycle pad units
and one unit is 16 × R = 2,800 cycles, so the tuning cliff is one unit wide.
Keeping the remainder and handing an extra unit to some of the three passes
(per *pass*, not per sample — the hot loop must not grow a branch) would take
the granularity to ~1 ms and let the margin come down the rest of the way.

**The register file is live for the whole pass** (the "(b)" rewrite): a
sounding pass loads DE = ptr, C = incInt, HL' = frac, DE' = incFrac once
(`ms_pload`), every segment runs through `mix_seg_live` without touching the
voice struct, and the position is stored back once at pass end (`ms_pstore`).
The boundary math between segments — window-top bank step, loop wrap, the
exact-tail walk — operates on the live registers, so `ms_load`/`ms_done`
survive only on the idle path. Measured: ~1.4–1.8k cycles a frame returned to
the pad, and one fewer over-budget frame class on segment-heavy scores.

**YM BUSY policy.** Every latched YM register write polls the status byte
(0x4000 bit 7) before the address and before the data byte. The **DAC data
register `$2A` is exempt** and is fed blind: the busy flag guards the chip's
internal write cycle for latched registers, `$2A` is not one, and every Mega
Drive PCM driver feeds it blind. Polling it cost 115 cycles per mix tick — 20k a
frame, a third of the whole budget — waiting for something that is never set at
a 10.5 kHz feed rate. PSG writes need no wait.

### 5.1.1 The write pump — chip writes ride the mix loop (2026-08-06)

A slot's YM writes used to go out in a **burst** at their sub-tick instant, and
for as long as that burst ran the DAC held its last sample. On a score with real
chip traffic the worst in-frame hold measured **17.5 sample periods**, and the
gap it opens is the one thing the pacing pad cannot absorb: the pad is spread
thinly over the whole frame and the burst is not.

So the writes are not fed into the consume; **the consume is fed into the feed**.
Every unrolled mix iteration already holds itself to the frame's tick period
(§5.1), and a YM register write costs about half of one — so the pump gives one
queued write to each iteration. The writes land at the instants the pad
occupied, and on a write-heavy frame the writes *are* the pad.

- **Queued, not copied.** `cs_runs` records where the sub-slot's two YM runs
  start and how many pairs each holds; the pump walks them **in place**. The
  cursor lives in the pump's own self-modified `ld bc,nn`, and the target port is
  baked into its two `ld (nn),a` operands, so the per-write path carries no
  dispatch. That the queue *is* the slot is why the ring tail is now released at
  the **end of the frame** rather than when the last sub-slot is read
  (`slot_release`) — otherwise the 68k could refill a slot the pump is reading.
- **It costs a loop with nothing to pump nothing at all.** There is no test in
  the hot path: while writes are queued, the bound copy's own first instruction
  — `ld a,(iy+0)`, three bytes, exactly the size of a `jp` — is overwritten with
  a jump to the pump, and put back when the queue empties. `ms_bind` binds one
  unrolled copy per pass, so exactly one site is ever patched. (That is also why
  a second *generated* set of pumping loop copies was not the answer: a queue
  empties mid-pass, and a bound copy cannot be swapped without leaving the loop.)
- **Order and port are preserved exactly**, which is the transport's whole
  contract (§12.3): port 0's pairs drain before port 1's, and a write may not
  cross its own sub-tick boundary — whatever the pump still holds at a pass
  boundary goes out before the next sub-slot is queued.
- **PSG bytes are not pumped.** A PSG write is 13 cycles and holds nothing; a
  whole run is under one sample period.
- **A write-dense frame does not use the pump at all** (`PCM_DRAIN` = 56, tested
  against the slot's leading write count, §6.2). A pass has 58 unrolled
  iterations, so past that the queue cannot drain anyway — and such a frame (a
  score head's patch dump, a dense voice change) is over its cycle budget
  whichever way the writes go out. Threading them through the mix then buys
  nothing while making the feed's own rate visibly uneven, whereas a burst
  landing *before* the frame's first sample is a constant offset and inaudible.
- **The pad pays for it.** A pumped iteration costs ~236 cycles more than a
  plain one (`PUMP_CYCLES` in gen-mixer.mjs), so while armed the pad it holds to
  is the plain figure less `PCM_PUMP_U` units — floored at 1, like every other
  pad. The `$2A` latch has to be restored after every pumped write, since the
  feed writes it blind; that re-latch is the pump's one irreducible overhead.

**It ships OFF (`PUMP_ON = 0`), because the frame cannot afford it.** On a score
carrying both FM/PSG traffic and three PCM voices it does what it was built to
do — worst in-frame hold **16.1 → 14.3** periods, frame-boundary hold **21.7 →
19.9**, span 88% → 89%. It also takes **17.9% → 24.6% of frames over their
59,659-cycle budget**. A pumped write costs ~236 cycles against a bursted one's
~113: an extra BUSY poll, the `$2A` re-latch, and the queue's bookkeeping, none
of which the burst pays. At 40 writes a frame that is ~5% of the whole budget,
on a driver that already measures 98–102%.

Every over-budget frame loses its vblank outright, is consumed late by the
catch-up (§6.7), and hiccups the DAC once on the way through. Seven more points
of that is ~4 extra hiccups a second — reported from hardware as clicking with
the tempo wobbling behind it, which is how the switch came to exist. Two sample
periods of hold do not buy four hiccups a second.

The gates cannot see either side of that trade: an emulated frame never runs out
of cycles and its YM is never BUSY. So both builds are gated (`npm run engine`
assembles the engine twice) and the choice is made on the machine.

**What it does not fix, and this is the correction it forced:** the median
in-frame hold was never the writes. Profiled, it is the **voice-pass transition**
— `ms_load`, `pcm_debt`, the voice-pointer arithmetic, `ms_bind`, `mvf_idle` —
~3.2k cycles with no sample fed, at every pass boundary. That is the (1)+(2)
per-segment cost §5.3 already points at, it is the frame's real overhead, and it
is what has to be cut before the pump becomes affordable. Both problems have the
same answer, which is why the pump waits rather than being reworked.

**One piece of it landed anyway and is on in every build:** the burst path's
BUSY polls are now *inline* rather than `call ym_busy0`. A call/ret is 27 cycles
on each of two polls a write — ~2.2k on a 40-write frame, spent while the DAC is
holding. It takes a 95-write frame from 69.4k cycles to 64.3k.

### 5.1.2 The sample clock and the ring — Timer B paces the DAC (2026-08-07)

Everything above paces the feed from the *frame*: a fixed `R` samples spread
over ~59,659 cycles by a baked pad. Measured (`npm run dac:clock`), that clock
is not one — the median interval came out 29% short of nominal, 68% of samples
arrived early, and a steady 1 kHz tone came back with frame-rate sidebands
**louder than the tone**. No constant fixes it: a pad moves the frame's average
and the ear hears the intervals. The pacing has to come from a clock, and the
YM2612 has one.

**The clock.** `Timer B` overflows every 16 x (256 - TB) FM samples; the
engine polls the overflow flag (status bit 1 at `$4000`, cleared through `$27`)
and emits `PCM_GROUP` samples per gate, the first at the gate and the rest
cycle-paced behind it. **TB and `PCM_GROUP` move together** — the generator
derives both from one knob (`TIMER_B_K` in gen-mixer.mjs, k = 256 - TB, and
`PCM_GROUP` = 3k) — so the RATE is 16/3 FM samples a DAC sample whatever k is.
k is the window the engine may average its out-of-loop work over, and it is 16:
TB = 240, `PCM_GROUP` = 48. At k = 1 the song ran at 74% of speed. Timer A is not available — CSM owns it (§9).

**`$27` must carry `$0A`, not `$02` — Load B *and* Enable B.** Load B (bit 1)
runs the counter; **Enable B (bit 3) is what publishes its overflow to the
status byte**. Nuked-OPN2 states it in one line (`ym3438.c`, `OPN2_DoTimerB`):

```c
timer_b_overflow_flag |= timer_b_overflow & timer_b_enable;
```

With bit 3 clear the counter runs and the flag never appears, so `gate_wait` is
an infinite loop: the first frame's chip writes reach the chips — **one note** —
and the driver never returns. Enable B also gates the YM2612's `/IRQ` pin, which
is not connected on the Mega Drive (the Z80's `/INT` is the VDP's vblank), so
setting it costs nothing; it is the ordinary idiom for a driver that polls. Both
bits have to stay set forever, which is why `cs_r27` ORs `$0A` into every `$27`
the sequencer sends.

> **This shipped, and every gate in the repo passed it.** `engine-gate`,
> `slot-gate`, `dac-gate`, `frame-budget` and `seg-bench` each modelled Timer B
> as "the flag rises `GATE_CY` cycles after the last reset" — written from the
> intent, never from the chip — so all five raised the flag whether or not the
> engine had enabled the timer. The lesson generalises past this bug: **a
> harness that models a peripheral from the design document cannot fail on a
> register the design document forgot.** All five now read bit 3, and
> `engine-gate` reports a poll with it clear as a named error rather than as a
> spin, because a spin only ever shows up as "no frames ran".

**BUSY is modelled too, for the same reason.** Every harness returned status bit
7 clear ("an emulated write completes instantly"), so the consume loop's
`cr_p0d` / `cr_p1d` / `cs_r27d` polls never spun and a frame's chip writes were
free. Nuked-OPN2 holds BUSY for 32 internal cycles after a **data** write
(`write_busy_cnt >> 5`); an internal cycle is 6 YM clocks and a YM clock is 7/15
of a Z80 one, so **BUSY is 90 Z80 cycles**. `budget:frame` and `seg-bench` now
charge it. Measured, it is worth ~1k cycles a frame and changes no verdict — the
feed's `call feed_one` every fourth write already spaces the data writes further
apart than 90 cycles. It is charged anyway, because "we checked and it is small"
is a different statement from "we never looked".

**And `budget:frame` was measuring the wrong quantity entirely.** It modelled
the gate as satisfied-on-demand, so waiting cost nothing and it reported the
frame's WORK. A frame is not its work. The engine emits `chunk` samples on Timer
B's clock and **167 x 358.4 = 59,853 cycles is 100.3% of a vblank by itself**;
every cycle of work that does not fall inside a gate wait is added on top of
that, not hidden inside it. Measured on one real song:

| | reported |
| --- | --- |
| `budget:frame`, gate satisfied on demand | 88%, 0.2% of frames over |
| `dac-gate` (which always modelled the timer) | span **110%** |
| a real Mega Drive (`music x256 = 0x0BF`) | **134%** |
| `budget:frame`, timer free-running | **116%, 83.7% over** |

The tool now free-runs the timer and the engine really waits for it. Two gates
disagreeing by 22 points is a thing to chase, not to average: `dac-gate` was
right for months and nobody reconciled it with the tool named "does the frame
fit".

> Judge BUSY on a **monotonic** cycle counter. Judging it on the per-frame one
> makes the chip read BUSY at every frame boundary and the poll loops spin until
> the frame catches up — 13k cycles a call, which reads exactly like a real
> hardware cost and is not one.

```
YM clock = master/7,  FM sample = /144 = 53267 Hz
Timer B step = 16k FM samples (k = 256 - TB) → gate 3329.2/k Hz
x 3k samples a gate                           → 9987.6 Hz = master/5376
   k cancels — the rate is 16/3 FM samples a DAC sample for every k.
   k = 16 today (TB = 240, GROUP = 48); it is the averaging window,
   not the rate. See §5.1.2.
358.4 Z80 cycles a sample (5% MORE room than R = 175's 341)
frame = master/896040                         → 166.674 samples a frame
```

Because the timer pulls the phase back every three samples, pad error cannot
accumulate: the **hole bound is one gate — 3 sample periods**, against the 14–20
measured under frame pacing. Larger groups reach 10.5 kHz again (`GROUP` 19,
`k` 6 = 10542 Hz) at the cost of re-admitting drift inside the group; 3/9988 is
Timer B's best point and the rate is the price of the clock.

**Why that forces a ring.** 166.674 is not an integer and nothing about `GROUP`
or `TB` makes it one — the frame rate and the FM sample rate are not
commensurate. A frame owes the DAC **166 or 167 samples depending on where the
timer's phase falls**, so a frame-long buffer cannot be the unit of production.
The two 175-byte planes become one ring, `PCM_RING_TARGET` = **256 finished
samples** carried ahead of the feed, in a **512-byte buffer**:

- the feed drains it on the sample clock, `pcmFrameSamples(frame)` a frame,
  derived from a running remainder so producer and feed cannot disagree;
- a burst's **prime frame** — any frame that starts with an empty ring — builds
  the whole 256-sample lead and feeds nothing, parking the DAC at silence with a
  single `$2A` byte so claiming fm6 cannot step it to whatever the last burst
  left latched;
- **every frame after it mixes exactly what the feed took.** That is not a
  tuning choice: the engine emits one sample per three mix ticks, so "ticks
  mixed" and "samples fed" are the same number by construction, and a frame that
  mixed more than it fed would have to wait out the extra gates and lose its
  vblank. It also means there is no per-frame catch-up rule to get wrong;
- the fill therefore sits at 256 after every mix and **89 after every feed**.
  That 89-sample floor (8.9 ms) is the jitter margin, and it is what the
  frame-boundary hold used to eat (23 sample periods, p50, at 60 Hz).

**Why 512 bytes for a 256-sample lead.** The mixer is voice-outer: a sample is
final only once the *last* voice pass has added to it, so while a chunk is being
built none of it is playable and the finished samples must still be there to
play. Both are live at once — 256 finished plus a chunk of up to 256 under
construction — and 256 B could hold one or the other, never both. (The buffer is
still exactly the two planes' footprint, so this costs no RAM against the design
it replaces; the earlier "net −256 B" figure was taken before the two-region
requirement was worked out.) A 256-byte ring is only possible with **block-wise**
mixing — all three voices over a block of ≤128 samples, then the next — which
triples the voice-pass transitions (~3.2 k cycles each, measured) to save RAM the
engine has spare. Rejected on that trade.

**The chunk length is the sequencer's, not the engine's.** The segment plan
(§6.3.1) is a list of tick distances computed from the voice positions the 68k
models, so the engine has to mix exactly as many samples as the 68k planned for
or the two desync. The slot carries it. The ring's fill absorbs the difference
between the modelled schedule and the timer's real phase — both come off the
same crystal, so the error is bounded by the vblank/timer phase, well inside the
margin. An overrun that does exhaust the margin drops samples rather than
shortening the chunk; dropping a sample is one 100 µs event, shortening a chunk
desyncs the plan.

The segment plan otherwise gets *easier*: a segment no longer has to align with
a frame's tick count, so the last run of a still-sounding voice is the chunk
length rather than `R`.

**What this deletes when the engine follows:** `PACE_SEG`, `PACE_RESERVE`,
`pcm_debt`, `debt_tab`, `pad_first_tab`/`pad_add_tab`, `G_DEBT`/`G_NSEG*`/
`G_PAD`, `pace_win_tab`, the whole per-frame overhead estimator, and the plane
swap. The ROM-window stall stops being something a pad has to predict — it just
consumes part of a sample's 358 cycles.

**The gate is `npm run dac:model`** (`drv/tools/dac-model.mjs`). It drives the
reference and asks the three things a value comparison cannot: that every
feeding frame takes exactly `pcmFrameSamples(frame)` — the sequencer and the
feed derive that count independently and have to agree forever — that the ring
never runs dry under a running mixer, and how much **slack** it is holding.
Measured over the PCM gate scores and a 66-second song (592k samples):

| | |
| --- | --- |
| off-schedule frames / underruns | **0 / 0**, every score |
| slack | **89 samples = 8.9 ms**, constant from the first fed frame |
| ring fill peak | 256/256 |
| prime frames | 1 per burst (210 over the song's 4000 frames) |

There is no ramp: the prime frame builds the lead in one go, so the slack is at
its full value from the first fed frame onwards. What that costs is the prime
frame itself — 256 ticks of mixing against a steady frame's 167, in a frame that
feeds nothing — which is affordable at one or two voices and is the one frame a
three-voice burst can overrun.

**One consequence worth stating: 89 samples does not cover a lost frame** (167).
A ring that could would need ~512 B, since the fill has to peak a whole chunk
above the floor. So the priority rule both reference drivers chose is not
optional here — **a frame that cannot do both drops the music frame, not the
mix** (§6.7's catch-up already consumes the owed slot late). Note this makes the
"drop below ~150" threshold copied from XGM2 meaningless at this geometry: the
fill sits at ~89 every frame by design, so the test would fire always. The rule
is simply that PCM mixing outranks the slot.

**State.** `live/src/mmb.js`, `drv-player.js` (the port spec), the 68k C
sequencer and the **Z80 engine** all hold the ring and the sample clock as of
2026-08-07. `npm run verify:all` is green: engine 12/12, `npm run slots`
byte-exact and sample-for-sample on every PCM score, `c-gate` 41/41, ring,
`sgdk:lint`, `ab-gate`, and `dac` 100% paced.

### 5.1.3 What an emit costs — and why the phase lives in A' (2026-08-07)

Under Timer B the frame's arithmetic is one line: the frame feeds `chunk`
samples and the timer spaces them, so it **cannot end before `chunk × 358`
cycles** — 59,174 for a typical 165.3, or 99.2% of a vblank. Whatever the code
costs *above* that floor is a lost vblank, every frame. There is no slack to
spend: the clock already owns the frame.

That makes the per-emit cost the number that decides whether the driver runs at
all, and it was wrong twice over.

**1. The pacing model did not know about its own gate.** `EMIT_CYCLES` in
`gen-mixer.mjs` was **49** — the four instructions that read the ring, bias the
byte, write `$2A` and step `IY`. Timer B then put `call gate_step` in front of
that block and the constant never moved. The 69-cycle gap is charged ~165 times
a frame, and it propagates into both places the generator prices:

- the **baked pads** (`padFor`), so every sounding iteration over-ran a sample
  period by 69 cycles;
- **`pass_cost_tab`**, which under-reported a pass by ~4,000 cycles — so
  `pcm_pad` computed `PCM_BUDGET − (three passes)` against a sum ~12,000 too
  small and handed the idle passes ~13,000 cycles of pad the frame did not have.

A model that under-prices the work pads *harder*, which is the wrong direction
in exactly the case that cannot afford it. Alone this was 123% → 110% of a
frame.

**2. The phase counter cost more than the emit.** `gate_step` maintained a
1..`GROUP` countdown in a RAM byte:

```
call gate_step   17 + ld a,(G_PHASE) 13 + dec a 4 + jr nz 12
                    + ld (G_PHASE),a 13 + ret 10   = 69 cycles
```

69 of a sample's 358, to maintain a counter that never exceeds 3. **The phase is
now A', the shadow accumulator**, and the whole step is inline in 8 bytes:

```
ex af,af'  4  ·  dec a  4  ·  jr nz,gt  12  ·  [call gate_wait]  ·  ex af,af'  4
```

24 cycles on the two non-gating emits of every group, and `gate_wait` returns
`A = PCM_GROUP` so the gating one reloads the phase for free. `EMIT_CYCLES` is
**73** and `GATE_CYCLES` (**141**, what the gating emit adds once per group) is
priced separately, because the pad has no interest in an interval the timer sets.

> **AF' belongs to the pacing and nothing else in the engine may use it.** The
> ISR's `push af`/`pop af` does not touch it, which is what lets the phase stay
> continuous across the frame boundary — and it must, because 166 and 167 both
> fail to divide `GROUP`, so a phase that restarted per frame would put a wait at
> every frame boundary. `exx` is unaffected; the mixer's use of it is fine. A
> second user of AF' would not fail a gate, it would drift the DAC's phase and
> read as jitter, so it is called out here, at `gate_wait`, and at
> `gen-mixer.mjs`'s `gatePrologue`.

A third fix came out of the profile that followed. **`feed_wrap` compared a
16-bit cursor to find a wrap that fires once per 512 samples**: `push de` /
`push iy` / `pop hl` / `sbc hl,de` / `pop de`, 86 cycles, ~17 times a frame. The
ring is 512-aligned and the cursor can only be `RING_BUF..RING_TOP`, so **the
high byte alone answers it** — 47 cycles, and 5 bytes smaller. Worth only ~740
cycles a frame, and it moved the over-budget share from 24% to 4.6%, because
that is what "the clock leaves no slack" means in practice: the 1-voice frame
was sitting a hair over the line and almost all of it crossed back at once.

Measured, `npm run budget:frame` and `npm run dac`:

| | before | after |
| --- | --- | --- |
| frame cost, p50 | 123% / 127% | **97% / 96%** |
| frames over budget | 100% / 99.6% | **4.6% / 0.4%** |
| `dac` span of a frame | 121–124% | **111–112%** |
| `dac` wander | 3.74–4.26 ms | **2.11–2.48 ms** |
| `dac` paced | 96–100% | **100%** |

**What is left is polyphony, and it is a rate decision, not an optimisation.**
`npm run seg-bench` prints the frame's mean cost by how many PCM voices are
sounding, which is the number that sets expectations:

| voices sounding | mean frame | over budget |
| --- | --- | --- |
| 0 | 72% | 0/98 |
| 1 | **95–97%** | **0/189** |
| 2 | 120–136% | 5/5 |
| 3 | 150% | 6/6 |

**A sounding voice costs ~25–30% of a frame** — 167 ticks × (78 cycles of
mixing + the 14-cycle ROM-window stall) ≈ 15.4k — and that is the mixer at the
floor §5.3.1 already computed for these semantics, not slack. So **the engine
fits one PCM voice at 9987.6 Hz.** §1.1 predicted exactly this before the split
("2 voices × 175 ticks = 99.7% of the frame with the sequencer executing zero
instructions"); the split bought the sequencer's 19.7k, which is one voice.

The only lever with the required size is the **sample rate**, because ticks
scale with it one-for-one: `GROUP = 2` is 6658.4 Hz and ~111 ticks a pass, which
buys back ~1/3 of both the mix and the emits. That trades bandwidth for
polyphony and touches `mmb.js`, `drv-player.js` and the C sequencer together, so
it is a decision and not a patch. Trimming the remaining out-of-loop work cannot
substitute: it is ~16.7k a frame in total, spread flat over ~40 labels
(`ms_load`, `mvf_*`, `pcm_pad`'s `pp_*`), and a second voice needs 15.4k.

**`npm run seg-bench` is the tool that answers "where".** It buckets every
executed cycle by the engine's own labels, models Timer B the way
`frame-budget.mjs` does (the gate is satisfied on demand, so the profile shows
work and not spin), charges `PACE_WINDOW` per ROM-window read, and prints the
floor/work/over-the-vblank arithmetic above. `npm run budget:frame` is the gate
that says *whether*; this one says *which label*.

### 5.2 RAM map

The engine is small enough that the 8 KB stops being a design input. Sizes, not
addresses — the build assigns the addresses and publishes the two the host needs
(§6.4).

As built (`drv/src/engine.z80` + the generated mixer):

| Region | Address | Size | Contents |
| ------ | ------- | ---- | -------- |
| code | `$0000` | 4756 B | boot, ISR, consume loop, PCM commands, write pump, mixer |
| published header | `$1300` | 64 B | ring control, status, consumed-frame counter (§6.4) |
| slot ring | `$1400` | depth × 256 B | 768 B at the default depth 3 (§3.4) |
| mix buffer | `$1700` | 2 × 256 B | two planes: one being mixed, one being fed (§5.1) |
| PCM voice state | `$1900` | 3 × 32 B | 32 is a power-of-two stride, so indexing is shifts |
| engine scratch | `$1960` | 160 B | the always-silent voice struct at `$1980`, the frame's segment plan at `$19A0`, the write pump's queue state at `$19B0` |
| stack | `$1F00` | 256 B | |
| | | **~5.8 KB** | leaving ~1.2 KB unallocated |

The mixer is most of the code: shift specialisation means ten copies of each
loop (§5.3.1) — eight shifts, mute, and idle — and pacing unrolls each of them
by three (§5.1). That is 3.4 KB of the image.

**The planes moved above the ring when the sub-slot consume loop (§3.5) pushed
the image past 4 KB.** They used to sit at `$1000`, directly above the code,
with 114 B of headroom — the doc said then that the next thing to grow would
have to move the map rather than squeeze in, and this was it. Growing *upward*
into the free space is the move that does not make the host's build stale: the
header's address is the one Z80 constant the 68k compiles in (§6.4), so it
stayed at `$1300` and no protocol version had to change. Code now has the whole
span below the header — 1132 B of headroom — and everything above the ring is
the engine's own working memory. The boot clear covers that region only, which
means the published header survives it.

Everything the old design fought for is gone with the sequencer: no code
overlays, no overlay ROM blob, no `DATA_BASE`, no shadow file (change-only now
happens on the 68k, §4), no LUTs, no TCB, no channel state. The ~6 KB left over
is the budget any future engine-side idea gets to spend, and the mix buffer is
the first thing that spends it.

### 5.3 The mixer — voice-outer over a full-frame buffer

This is the change the split exists to enable. The old mixer was **tick-outer**:
for each of R ticks, visit each voice. That re-reads every voice's position,
increment, loop bounds and volume from RAM on every tick — 14 indexed accesses
per voice per tick, and it measured 240 cycles/voice/tick.

The new mixer is **voice-outer**: each voice owns the register file for its
entire R-tick pass, writing into a frame-long mix buffer.

```
if nothing sounding and nothing owed: release the DAC (change-only), return
latch $2A once; point the feed cursor at the plane the LAST frame finished
for each voice v — sounding ones first, silent passes after them:
    latch v's sample ROM bank            # once per frame, not per tick
    load pos/inc/loop bounds/shift into registers
    for t in 0..R-1:
        every third tick:                # §5.1: the feed IS the mix loop
            write plane_fed[i++] ^ 0x80 to $2A
            pad to the frame's tick period
        s = sample[pos >> 16] >> shift   # nearest neighbour, sra = sign-preserving
        mixbuf[t] = s                    # the first pass stores...
        mixbuf[t] += s                   # ...the rest accumulate
        pos += inc
        wrap the loop region, or run the rest of the pass silent
    write pos back
flush any sample the interleave could not reach; swap the planes
```

**The specialised copy is bound once per PASS, not per segment.** Which of the
ten loops runs is decided by (role, shift), and both are constant for a whole
voice pass — a pass is one voice, and `PV_SHIFT` only moves when a `PCM_VOL`
arrives, which happens between passes. Resolving it per segment, along with a
pad that had not changed either, cost **~1,700 cycles a frame** re-deriving
known values; `ms_bind` now does it at pass entry, and again if a pass falls
through to the silent loop (which is the one thing that changes the shift under
a running pass). The per-segment path is a single self-modified `jp`.

Three details that matter:

- **The first pass stores instead of accumulating**, which removes the
  frame-long buffer clear entirely. Since a silent pass stores the plane's zero,
  it also subsumes the old early-end silence fill.
- **A pass always runs its full R ticks**, silently once its voice ends, because
  the feed's cadence rests on the tick count and not on what is sounding (§5.1).
- **Buffer width is the live decision** (§5.3.1). Three candidates, all measured:
  **i16 sum-then-saturate** (the v0.2 semantics — widest dynamic range, most
  expensive); **i8 saturating-add** (one plane, clamp at every add — clips
  earlier and is order-dependent, but never attenuates); and **i8 headroom**
  (pre-attenuate each voice by `ceil(log2 N)` so the sum cannot overflow —
  measured slower *and* worse than saturating-add, so it is out).

### 5.3.1 Measured cost (P0, 2026-08-02)

`drv/tools/gen-mixer.mjs` generates the mixer (→ `drv/src/mixer.z80`) and
`drv/tools/mixer-bench.mjs` (`npm run mixer`) runs one frame per configuration
in the emulator with the cycle counter on, checking **every DAC byte against a
JS model of the same mix** — cost and correctness in one gate, so a
fast-but-wrong loop cannot pass. Every figure below verifies against the model.

**The estimate was ~50% optimistic.** It predicted 301 cyc/tick at 3 voices with
the i16 buffer; the first honest implementation measured **449**. Three
optimizations then took it to **384**:

- **Shift specialisation.** A single loop must dispatch into the `sra` chain
  every tick (a `jr`, 12 cycles). Eight copies of the loop, one per shift, bake
  the chain in and cost exactly 8·shift with no dispatch — the caller picks the
  copy once per voice per frame from an 8-entry table.
- **Increment in a register.** Register C is free for the whole pass (the loop
  uses only A, DE, HL, B), so `adc a,c` (4) replaces a self-modified
  `adc a,n` (7) and the self-modification disappears with it.
- **Unroll.** `dec b`/`jp nz` amortised over U ticks. U = 2 is the size/speed
  knee: it takes 402 → 384 cyc/tick for 1.5 KB of code, where U = 4 buys 10 more
  for 3.2 KB. (`djnz` is a ±128 relative branch and an unrolled body outruns it.)

At **3 voices** (the binding case), measured at unroll 2. "max rate" is the
highest `PCM_MIX_R` the configuration sustains once a typical frame's ~60 chip
writes and the consume loop are reserved; "vs i16" is how far the output lands
from sum-then-saturate on the same voices:

| buffer | cyc/tick | at R = 175 | **max rate** | vs i16 |
| --- | --- | --- | --- | --- |
| i16 sum-then-saturate | 384 | **113%** — does not fit | **8.6 kHz** | — |
| **i8 saturating-add** | **305** | 89%, 95 writes left | **10.9 kHz** | 5.1% of samples, ≤ 31/255 |
| i8 headroom | 326 | 96%, 34 writes | 10.2 kHz | *(attenuates instead)* |
| i16, pre-resampled | 273 | 80%, 186 writes | 12.2 kHz | — |
| i8 saturating-add, pre-resampled | 193 | 57%, 416 writes | **17.2 kHz** | 6.3%, ≤ 18/255 |

At **1 and 2 voices** every variant fits at 10.5 kHz (i16: 47% and 79%), and
**i8 saturating-add is bit-identical to i16 there** — with a single add there is
only one saturation point either way, so the divergence measures 0.0%. The 8-bit
buffer's cost exists *only* at three simultaneous voices.

Unroll 4 buys ~11 cyc/tick more (i8sat 305 → 294, max rate 10.9 → 11.3 kHz) for
double the code; unroll 2 is the default.

**i8 headroom is out.** It is both slower than saturating-add (the per-voice
`ceil(log2 N)` attenuation is extra `sra` instructions in the hot loop) and
worse: the headroom tracks the *active voice count*, so a sustained voice jumps
12 dB when another starts — audible pumping. Making it static instead costs a
fixed 12 dB of an already 8-bit DAC. The row stays only so the comparison is on
the record.

**What i8 saturating-add actually costs.** It clamps at every add rather than
summing wide and clamping once, so the result depends on voice order (+100,
+100, −100 gives 100 wide, but 127 then 27 saturating). The Z80 has no
saturating add, but `add a,(hl)` sets P/V on signed overflow, so the common path
is one not-taken `jp pe` — 10 cycles against the ~26 the i16 high plane costs.
The 5.1% divergence figure is a **worst case**: the bench mixes full-scale
uniform noise at shifts 0/1/2, which overflows far more often than real material,
and any per-voice `:vol` below unity removes the overflow entirely. In other
words the cost is "leave a little headroom in a 3-voice mix", which is ordinary
practice — whereas the mix rate is paid on every sample of every score.

Where the cycles go (3 voices, R = 175, i16): accumulating voices 214/tick, the
first voice 87, the output pass 74, per-frame setup 10.

Two caveats, in opposite directions:

- **These are a floor.** The emulator charges documented Z80 cycles with no
  bank-window wait states, and every tick reads its sample from 68k ROM through
  that window. Silicon adds bus arbitration to the instruction the loop executes
  most.
- **The segment split and the per-voice bank latch are not modelled.** Both are
  per-frame, not per-tick: the latch is ~117 cycles per voice.

**And the second caveat turned out to be the binding one.** Measured on whole
frames of real scores (2026-08-03), the segment split costs **~2.4k cycles per
segment and 5–10 segments a frame — 13k to 18k, a fifth of the frame** — against
which the bench's per-tick figures are a rounding error. Half of it was the
conservative `avail >> KSH` bound *halving* toward a region's end (21 ticks, 10,
5, 2, 1 — a segment each); `mvf_exact` now counts the tail exactly once the
bound collapses, at 75 cycles a tick, which took a typical frame from 8 segments
to 5. What remains is `mix_seg`'s register file in and out plus the caller's
boundary arithmetic, and it is now **the** number to beat: it is why the paced
feed (§5.1) still runs 20% fast between segments, and cutting it is the only
thing that tightens that.

`PCM_MIX_R` is the engine's build constant for how many samples a frame carries;
changing it changes the output, so the gate baselines must be re-frozen with it.
It used to be shared with `live/src/mmb.js`, which since 2026-08-07 runs the
Timer-B sample clock instead (§5.1.2) and has no such constant — the engine has
still to follow, and that re-freeze is what closes it.

#### Settled (2026-08-02)

**8-bit saturating-add, 3 voices, `PCM_MIX_R` = 175 (10.5 kHz), unroll 2.**
89% of the frame, 95 chip writes left, and bit-identical to sum-then-saturate
whenever fewer than three voices sound.

**The mix rate stays a knob to raise, not a frozen constant.** The measured
ceiling for this configuration is 10.9 kHz at unroll 2 and 11.3 kHz at unroll 4,
so there is 4–8% in hand; take it only if a real score's write budget and
hardware measurement leave room, since raising R changes the output and re-freezes
every gate baseline. The far larger step — 17.2 kHz — needs pre-resampling and is
not on the table (§14).

#### What the measurement says about the two reopened decisions

- **Pre-resampling** was rejected in the pivot on an estimate of ~25
  cyc/voice/tick, "11% of the PCM budget". Measured, the runtime resampler costs
  **~37 cyc/voice/tick — 29% of the mixer**, and it remains the largest single
  lever. But it is no longer *needed*: with the optimizations above, 3 voices fit
  at 10.5 kHz with the i8 saturating-add buffer and at 8.6 kHz with i16. So the
  question is only whether more headroom is worth losing per-note PCM pitch and
  dynamic loop points.
- **Buffer width** is a straight choice between two working configurations rather
  than a question of what fits: **i8 saturating-add at 10.5 kHz** or **i16
  sum-then-saturate at 8.6 kHz**. The measurement argues for the former, and the
  reason is that the two costs are not paid at the same rate:
  - The wide buffer's benefit appears **only at three simultaneous voices**, on
    5.1% of samples in the worst case, and vanishes entirely if any voice sits
    below unity `:vol`. At one and two voices the two are bit-identical.
  - The mix rate is paid **on every sample of every score**. 8.6 kHz is a 4.3 kHz
    Nyquist against 10.5 kHz's 5.25 kHz — 22% less bandwidth, plainly audible on
    hats and snares, and with nearest-neighbour resampling (no anti-aliasing
    filter, §1.3) a lower rate also aliases more.

  The counter-case is a score whose PCM is tonal rather than percussive, where
  clipping intermodulation is less masked; there the composer can back off `:vol`
  and get i16's behaviour anyway. The headroom variant decision 7 weighed against
  is dominated by saturating-add on both axes and is not a candidate.

### 5.4 PCM voices and sample banking

A voice's state is `{active/loop/releasing flags, bank, cur, end, loop_start,
loop_end, pos (16.16), inc (16.16), shift}`. Everything in it arrives from the
68k register-ready (§6.3): the sequencer resolves the sample entry, computes the
per-tick increment `floor(inc_frame / R)` and composes the volume shift, so the
Z80 does no per-note arithmetic at all. The old `ovl_pcm` overlay and its
32-bit ÷ 175 are gone.

Samples live in their own ROM banks, read through the 0x8000–0xFFFF window.
Because a voice-outer pass reads a **contiguous run of ~R samples per frame**, it
latches its bank once and can cross at most one 32 KB boundary per frame — so the
old 32 KB sample-bank wall (and the `WIDE_OFFSETS` countermeasure it needed) is
gone. The window is now used for nothing else: MMB data is read by the 68k
directly from ROM.

**Per-voice volume** composes `:vel` + `:vol` + `:master` on the 68k into one
attenuation the mixer applies as an arithmetic right shift per sample, so volume
stays off the critical path (§14).

## 6. The Interface (68000 → Z80)

The 68000 deposits pre-rendered frames into a ring in Z80 RAM; the Z80 consumes
one per vblank. This replaces the v0.2 command mailbox entirely — the host no
longer sends the driver commands, because the host *is* the driver. What crosses
the bus is finished work.

**Why the chip writes go through the Z80 at all.** The 68k could write the YM
directly, but it would have to hold the Z80 bus for every write plus its BUSY
waits — 100+ µs, an audible DAC gap. Dumping ~150–250 bytes into Z80 RAM is one
short grab, and the Z80 paces the writes itself.

### 6.1 The ring

`RING_DEPTH` slots of `SLOT_SIZE` = 256 B each, plus a head/tail pair in the
published header (§6.4). Depth defaults to **2** and is a per-game knob — see
§3.4 for what depth costs and buys.

Discipline mirrors the old mailbox: the 68k fills the slot at `head` and
increments it last; the Z80 consumes while `tail != head`. **The tail is not
advanced until the frame's last sub-slot has been read** (§3.5), so the slot
under the Z80 is never one the 68k may write — which is why depth carries one
more slot than the lookahead it provides (§3.4). **Ring-empty is not
an error** — it means the game overran, and the Z80 simply holds the chips where
they are and keeps mixing. Ring-full means the 68k has run as far ahead as the
depth allows and skips rendering that frame.

### 6.2 Slot format

One slot is one frame, holding both that frame's chip writes and its PCM voice
commands — so a PCM note-on lands in the same frame as the music that cues it.
The chip writes are divided into `SLOT_SUBS` **sub-slots**, one per sub-tick
(§3.5); the PCM commands are frame-level.

```
[u8 n_writes]                         ; frame total: the pacing debt, and §5.1.1
[u8 chunk]                            ; samples to mix (§5.1.2); 0 = a prime frame
[u8 n_pcm] [pcm command × n_pcm]      ; §6.3, variable length
{ [u8 n_psg] [val × n_psg]            ; SN76489, port 0x7F11
  [u8 n_fm0] [{reg,val} × n_fm0]      ; YM2612 port 0 (0x4000/0x4001)
  [u8 n_fm1] [{reg,val} × n_fm1] }    ; YM2612 port 1 (0x4002/0x4003)
  × SLOT_SUBS
```

`chunk` is what the engine mixes this frame, and it is a field rather than
something the engine works out because the segment plan's tick distances are
measured against it (§5.1.2): a starved frame that guessed would desync the two.
0 means a PRIME frame — mix `PCM_RING_TARGET`, feed nothing — which is also why
the field fits in a byte when the lead does not.

**The frame-level fields lead, and that ordering is load-bearing.** They are
wanted at the frame head — the PCM commands before the mixer runs, `n_writes`
before the pacing debt sizes the frame's pad (§5.1) *and* before the engine
decides whether this frame's writes ride the write pump or burst (§5.1.1) —
while sub-slots 1..K-1 are not consumed until a third and two thirds of the way
in. With them trailing, the
engine had to walk past every sub-slot to reach them and tally every run on the
way, which measured **~1,400 cycles a frame**: 2.3% of the Z80's budget spent
re-deriving a number the 68000 already had.

Length-prefixed runs mean the consume loop needs no per-write dispatch: three
tight loops, each with its port address fixed. **That property is exactly why
the frame is divided into blocks rather than given per-write timestamps** — a
timestamp would put a comparison in the inner loop and cost more than the timing
it bought. `SLOT_SUBS` is a build constant, so the count is not on the wire; the
cost is 6 B a slot at K = 3, and `SLOT_SUBS = 1` collapses the format back to
the single-block one, byte for byte.

**Which sub-slot a write lands in** is simply the sub-tick that generated it.
One ordered queue feeds all of them, as before, and the 68k records the queue
depth at each sub-tick boundary; those depths are the bucket ends. Order,
change-only and the shadow are all unchanged, and per port the whole frame's
sequence is the buckets concatenated — so the transport still only ever *delays*
a write.

**The write cap and spill.** `SLOT_MAX_WRITES` bounds
`n_psg + n_fm0 + n_fm1` **summed over the whole slot**: it exists for the Z80's
cycles per frame, not per sub-slot. The queue is walked once and the buckets
fill in order, so overflow out of one bucket lands in the next bucket of the
*same* frame; only what does not fit at all waits, and it leads the next frame's
sub-slot 0 exactly as it always did.

The bound is **cycles, not bytes** — the Z80 frame is shared with the
mixer, and what is left after the mixer is the whole budget:

```
SLOT_MAX_WRITES = (59,659 − mixer − ~500 interrupt/consume overhead) / ~61
```

The mixer term is the dominant one and it is a configuration choice, so the cap
is not a fixed number until §5.3.1's configuration is settled. From the measured
table there: 23 writes at (i16, runtime resampling, R = 128), 106 at (i16,
pre-resampled, R = 160), 142 at (i8, R = 128), 270 at (i16, pre-resampled,
R = 128).

A typical frame emits ~60 writes, so anything above ~64 binds only on voice
changes and score heads — but the tightest configurations sit *below* that, which
is a real argument in the §5.3.1 decision and not just a tuning detail.

When a frame generates more, the 68k keeps the excess **in order** and prepends
it to the next slot. Writes are never dropped and never reordered, so the chip
state converges; the cost is that a key-on in a write-dense frame can land one
frame late. This is the runtime analogue of the armed frame (§4.2), and the two
together are why a 262-write score head is a non-event.

The reference implements the same cap and spill (`drv-player.js`, `slotWriteCap`)
so the §12 gate stays at zero tolerance — the interface is part of the spec, not
an implementation detail of the C.

### 6.3 PCM commands

Variable-length, opcode-first. Every field arrives register-ready; the Z80
computes nothing (§5.4).

| Op | Name | Payload |
| -- | ---- | ------- |
| 0x01 | `PCM_START` | voice u8, flags u8, shift u8, ksh u8, bank u16, ptr u16, left u16, loop_len u16, tail u16, inc_frac u16, inc_int u8 — 17 B |
| | | `shift` 0–7 is the attenuation; **8 means mute** — a real entry in the mixer's specialised-loop table, because `:vol 0` has to keep the voice advancing silently (§14) |
| 0x02 | `PCM_STOP` | voice u8 — a looped voice starts its release tail; a shot is unaffected (it plays to its end) |
| 0x03 | `PCM_VOL` | voice u8, shift u8 |
| 0x04 | `PCM_LOOP` | voice u8, loop_len u16, left u16 — retarget a running voice's loop region |
| 0x05 | `PCM_MASTER` | shift u8 — the attenuation the emit applies to the finished SUM, once per DAC sample (§14.1) |
| | | The only VOICELESS command, and it does not go in a voice struct: the engine PATCHES it into every emit's chain. Sent when the shift moves, not when `master` does |

Two of `PCM_START`'s fields are worth explaining, because both exist to keep
arithmetic off the Z80:

- **Distances, not end addresses.** `left` is the byte countdown to the current
  boundary (loop end, or sample end for a shot) and `tail` is the extra distance
  from the loop end to the sample end, which `PCM_STOP` adds to `left` when the
  release begins. Countdowns rather than absolute addresses are what let a
  sample span ROM banks without anything to rebase: the pointer wraps at the
  window top, the bank steps, and the countdown is unaffected (§5.4).
- **`ksh` is the segment bound.** The engine splits each voice's frame at loop
  and sample boundaries and needs to know how many ticks fit before the next
  one. Rather than divide, it uses `avail >> ksh` where `2^ksh ≥ inc_int + 1`
  — conservative, so it never overruns, and one shift instead of a division.
  The 68k computes `ksh = ceil(log2(inc_int + 1))` once at note-on.

`PCM_LOOP` is new and costs the mixer nothing: a voice-outer pass loads the loop
bounds once per segment, never per tick (§1.2). It is what makes ping-pong and
macro-modulated loop length affordable.

`PCM_MASTER` is the one command whose handler writes CODE rather than state, and
it is the reason `:master` can take PCM below −24 dB at all — §14.1 has the
mechanism, the fade it fixes, and what it costs.

### 6.4 Published Z80 addresses

The engine publishes a 64-byte header at a fixed address — the only Z80
addresses the 68k needs to know, and the only ones that must stay stable across
builds. `drv/sgdk/mmlispdrv.c` carries the current values.

| Field | Owner | Notes |
| ----- | ----- | ----- |
| `head` | 68k | next slot to fill |
| `tail` | Z80 | next slot to consume |
| `frames_consumed` u16 | Z80 | **the audible clock.** The 68k runs ahead by the ring depth, so `(trig N)` must fire when the frame is *heard*, not when it was rendered — the host compares this counter against the frame it stamped the marker on (§6.5) |
| `engine_ready` u8 | Z80 | 0x00 while booting |
| `protocol_version` u8 | Z80 | = 7. The host refuses to run on a mismatch — it means this header's layout moved under it |
| `smp_bank` u16 | 68k | PCM sample ROM bank; 0 = none. Must be published *after* the image upload, which clears Z80 RAM |
| `ring_depth` u8 | Z80 | slots in the ring |
| `slot_shift` u8 | Z80 | log2 of the slot stride — a slot index is a shift |
| `ring_base` u16 | Z80 | where the ring starts in Z80 RAM |
| `starved_frames` u16 | Z80 | frames the engine held the chips because the ring was empty (§6.1) |
| `vblank_stamp` u8 | 68k | the 68k's own vblank count, low byte — what missed-vblank catch-up compares against (§6.7) |

`frames_consumed` counts **slots actually consumed**, not interrupts taken: a
starved frame plays nothing, so it must not advance the audible clock. Getting
that wrong once made a host-side speed readout show correct tempo while the ring
was starving half the time — the metric was blind to the only failure it existed
to catch.

`starved_frames` exists because ring-empty is the one failure with **no
signature**: the music keeps playing, just not evenly, and nothing in the trace
says why. It is what "the tempo wobbles" looks like from the inside. It should
stay at 0; if it climbs, the 68k missed 60 Hz, and the answer is either less
work per frame or a deeper ring (§3.4).

Together with a real-time frame count on the host, those two name the culprit:

```
frames_consumed / REAL elapsed frames    the music's real speed
  ~1.0, starved_frames flat              the driver is keeping up
  < 1 and starved_frames climbing        the ring ran dry — the 68k is late
  < 1 and starved_frames flat            the Z80 is not taking every interrupt,
                                         i.e. its frame is over budget (§5.3.1)
```

**Three traps, all of which produced a wrong reading the first time this was
used on hardware.**

*The reference clock must be real frames, not the host's loop count.* A main
loop that misses a frame waits for the next vblank, so counting its own
iterations under-counts elapsed time and the ratio comes out **above** 1 — a
slow 68k reads as fast music, which is the opposite of the truth. Use a counter
driven by the vertical interrupt (SGDK's `vtimer`).

*Reading the counters costs the thing being measured.* The 68000 must hold the
Z80 bus to touch Z80 RAM, and the Z80 does not run while it is held — a grab
that spans a vblank costs the engine that frame exactly as an over-long mix
would. Take every counter in **one** grab (`MMLisp_readStats`) and sample every
~32 frames.

*There is no Z80-side overrun counter, and one cannot be built this way.* The
obvious design — run the frame with interrupts enabled so the successor's vblank
re-enters and tallies itself — does not work: the VDP holds Z80 `/INT` for about
a scanline, so the **same** vblank re-triggers the moment `ei` executes and
every frame counts one. Measured on hardware as 1602 "overruns" in 1603 frames.
The ratio above answers the same question without touching the engine.

The last three exist so the header's **address** is the only Z80 constant the
68k compiles in. Both sides have to agree on the ring's geometry and a mismatch
fails *silently* — the 68k either stalls believing the ring is full or writes a
slot that does not exist — so exactly one side owns those numbers, and it is the
side they are built into. The host reads them once, at the moment
`engine_ready` appears.

### 6.5 Host API and live control

The v0.2 command set survives as C entry points rather than mailbox commands,
with the same semantics; what changes is that they now execute *in* the
sequencer rather than being posted to it.

| Call | Semantics |
| ---- | --------- |
| `MMLisp_startTrack(score, track)` | look up the track, initialize its TCB (stream ptr = base + event_offset, accumulator 0, increment from the stream's first TEMPO_SET — the compiler guarantees one before the first timed event), apply the channel-ownership rule (§2.2), reset channel level state to defaults (vel 15, vol 31, master 31, gate 8), and initialize declared val slots not yet host-written (mmb.md §8). Restarting an active track restarts it from the top. The track enters **armed** (§4.2) |
| `MMLisp_stopTrack(score, track)` | key-off (the release tail runs out naturally), free the channel, mark the TCB idle. On an `fm3-csm` track this clears the CSM bit in `$27` (§9) |
| `MMLisp_keyOff(channel)` | key-off one channel without stopping its track: releases a `len=0` hold (the dispatcher resumes) or truncates a sounding note |
| `MMLisp_setParam(channel, target, value)` | one-shot absolute write of `target` (opcodes.md §7), as if a PARAM_SET arrived in the stream |
| `MMLisp_fadeTrack(score, track, frames)` | step `master` down to 0 over `frames`, then stop |
| `MMLisp_setVal(slot, value)` | write i16 into a val slot |
| `MMLisp_getVal(slot)` | plain read — the slots are 68k memory now |
| `MMLisp_startSe(...)` | §2.5 |

**Val slots.** 16 × i16 in 68k RAM, initialized from the score's VAL_TABLE at
track start and thereafter host-written. Slot index = VAL_TABLE index; slot 0xFF
in stream operands is the built-in `$time` source (elapsed 60 Hz frames, low 16
bits), never stored in the array. The host does all arithmetic; the sequencer
only stores and applies (docs/language.md §8). They no longer cross the bus —
`GET_VAL`, which the v0.2 protocol reserved a command for and then realized as a
direct Z80-RAM read, is now an ordinary variable access.

**Latency.** Every call in this table takes effect on the next frame the 68k
renders, so it is heard `RING_DEPTH` frames later — see §3.4, which is the
reason the default depth is shallow.

### 6.6 The per-frame hook — decided 2026-08-03

**The host calls `MMLisp_frame()` once per vblank. The driver does not register
itself with SGDK's vblank callback.**

`MMLisp_frame()` **tops up the ring** rather than rendering exactly one slot, so
the lookahead is an invariant the call maintains and not something the game has
to manage: an empty ring at startup renders `RING_DEPTH` slots, steady state
renders one, and a frame the game overran renders two and the lookahead refills
itself. The contract on the host is exactly "call me once per frame" — the same
contract a vblank registration would impose, only visible.

It is also **self-limiting**: called twice in a frame, the second call finds no
space and does nothing, so a host that calls it from both its vblank handler and
its game loop is not broken by that.

Why explicit, beyond the project's directness rule:

- **The host chooses where in the frame the bus grab lands.** Writing a slot
  takes the Z80 bus, which halts the mixer (§1.3's jitter). If SGDK's callback
  owned the call, SGDK would choose that moment.
- **SGDK's vblank callback is effectively a single slot.** A driver that claims
  it forces the host to chain, and a broken chain is a classic "my callback
  stopped firing" bug. Taking a resource the host may need is the kind of
  implicit magic the working agreements exist to avoid.
- **It is the same path the host gate already exercises** (`mml_render_frame` in
  a loop), so no code path exists only on target.
- **§3.4's "render N slots every N frames" comes free** — that is just calling
  it every N frames, rather than a configuration knob.

The usual argument for auto-registration — that it guarantees a regular
interval — **does not apply here, and that is structural rather than lucky**:
the Z80 owns the clock, so jitter in *when* the 68k renders shows up in the
ring's fill level and never in the tempo. That is what §1 is built on.

Two consequences that follow from the choice:

- **The bus is grabbed per slot COPY, and never across the render.** The
  original form of this rule — one grab per call — is wrong in the direction
  that matters, and the P3 implementation corrected it: a grab halts the Z80,
  and the work between two slot copies is the sequencer's entire frame. Holding
  the bus across it would stall the mixer for **milliseconds**, an audible
  dropout rather than the tens of microseconds §1.3 budgets. What the rule is
  actually for is ruling out a grab per *write* — the same argument §6 makes for
  not letting the 68k drive the YM directly. In the default depth-2
  configuration a steady-state frame is three short grabs: read `tail`, copy one
  256-byte slot, publish `head`.
- **Control calls precede the render call within a frame.** §6.5's calls take
  effect on the next frame rendered, so putting `MMLisp_frame()` last in the
  host's frame means a track started this frame is rendered this frame.
  Reversing the order costs an extra frame of latency — a placement rule that
  only exists *because* the call is explicit.

The honest cost: recovering lookahead after the game overran means one call
writes two slots, so the bus grab — and the mixer stall — doubles exactly when
things are already bad. It is bounded by the ring depth, which is one more
reason to keep the default shallow. **No `MMLisp_autoVBlank()` convenience is
shipped**: it would be a second path that the host gate cannot reach, and a host
that wants it can write the one line itself.

### 6.7 Missed-vblank catch-up

A Z80 frame that runs past its budget loses the next vblank **outright**: the
VDP holds Z80 `/INT` for about a scanline, so an interrupt that is not taken
while the frame is still working simply never happens. Before this section the
consequence was a lost frame of *music* — the tempo slipped and nothing
anywhere said why. The Z80 cannot detect it alone; an earlier attempt (an
interrupts-enabled handler counting re-entries) failed because the same pulse
re-triggers the moment `ei` executes.

The 68000 can see what the Z80 cannot: its own vertical interrupt is not
missable the same way. So `MMLisp_frame` stamps the low byte of SGDK's
`vtimer` into `vblank_stamp` inside the bus grab it already takes, and the
engine compares that against the vblanks it has **answered** (its own counter,
incremented once per interrupt and once per catch-up). If the stamp is ahead,
the difference is missed frames, and the handler consumes them *immediately*,
before returning — the frame is late, the DAC hiccups once, and the music
does not lose a frame.

Why the test cannot fire spuriously: a stamp can never arrive *earlier* than
its own vblank, while the Z80's frame starts *at* the vblank — so the stamp
running ahead of the answered count always means a real miss. A host that
stamps late only delays detection. Anything outside a small window (boot, a
host restart) resyncs silently and catches up nothing; the loop is capped at
two frames per interrupt, so a wild stamp cannot stall the engine and a real
backlog heals one frame per interrupt.

**What catch-up does NOT license: chronic overrun.** A steady frame that
exceeds its budget every time is caught up every time, but the ring then
throttles the 68k and the music runs slow by exactly the overrun — smoothly,
with no counter climbing. The pacing constants must still land the *typical*
frame under budget; catch-up converts the **transient** spikes (a note-on
burst, a patch dump, a segment storm) from tempo slips into one-off
hiccups. That is also what let `PACE_RESERVE` drop 7200 → 4800: one debt
quantum less insurance, ~8 sample periods shaved off the every-frame feed
hold at the frame boundary, paid for by spikes that now self-heal.

## 7. Level Composition

Implements the level model of docs/language.md §6 — signed dB offsets composed by
addition, quantization once at the write:

```
FM  (per carrier op of the current ALG):
    TL  = clamp(0, 127, voicedTL[op] + vel_tl[vel] + vol_tl[vol] + vol_tl[master])
PSG:
    att = clamp(0, 15,  vel_psg[vel] + vol_psg[vol] + vol_psg[master])
```

Offset tables in 68k ROM, **generated from the `ir-utils.js` constants**
(`TL_DB_PER_STEP` 0.75, `PSG_DB_PER_STEP` 2, `VEL_DB_PER_STEP` 2,
`VOL_STEP_DB` 2, `VOL_UNITY` 31):

- `vel_tl[16]` = round((15 − v) × 2 / 0.75) =
  `[40,37,35,32,29,27,24,21,19,16,13,11,8,5,3,0]` (v = 0…15)
- `vol_tl[32]` = round((31 − v) × 2 / 0.75) — v = 31 → 0 … v = 1 → 80;
  **shared by vol and master** (their offsets add)
- `vel_psg[16]` = 15 − v; `vol_psg[32]` = 31 − v

Rules:

- **vol = 0 or master = 0 is a hard mute:** FM skips key-on (and forces
  carrier TL 127 if already sounding); PSG writes max attenuation 15. The
  v = 0 table entries are never used.
- Velocity never mutes (vel 0 = −30 dB floor); silence is a rest.
- Carrier ops per algorithm come from the `fmCarrierOpsForAlg` table
  (alg 0–3 → op4; 4 → op2,4; 5–6 → op2,3,4; 7 → all).
- **Same-table requirement:** the JS reference and the 68k C use these
  byte-identical integer tables. The tables round per term, whereas
  `ir-player.js` sums floats and quantizes once — a known divergence of at
  most ±2 TL steps (±1.5 dB) / ±1 PSG step, inside the §12 acceptance band.

### 7.1 Velocity is two values: a base and a live one

**Landed 2026-08-04**, after a level macro was found to leave every following
note at the macro's level.

`vel` above is really **two** per-channel bytes, on FM, PSG and PCM alike:

- **`vel_base`** — the score's sticky velocity. Written *only* by a
  `PARAM_SET VEL` out of the event stream.
- **`vel`** — the live one that composes into TL / att / PCM shift. A `:vel`
  macro writes this every frame; it is the channel's envelope authority while
  it runs (§13.3).

**Every note-on copies base → live** before composing the note's level. This is
not bookkeeping — it is what makes a note's own velocity land at all. The two
formats carry velocity differently: the **IR** puts `vel` on every `NOTE_ON`
and `ir-player` applies it there, while the **MMB** carries it as change-only
sticky track state (`export-mmb.js` emits `PARAM_SET VEL` only when the score's
velocity *changes*). So in the stream there is nothing that re-asserts the
velocity after a macro has overwritten the live value — without the copy, a
macro's **last sample stayed the channel's velocity for the rest of the song**.
A single accent macro anywhere in a loop was enough to bring the whole loop
body back at the macro's level, at full volume when the macro ended high. It
was audible in live's MMLDrv and on hardware, and absent in ir-player, which is
the signature of exactly this asymmetry.

Two details matter for the write count:

- A channel that currently has a **VEL macro bound is skipped**: the note-on
  retrigger re-instantiates the bind and its attack sample lands in the same
  frame (§4 step 3), so copying the base would only emit a register write that
  is overwritten before it can be heard. The copy is what happens once the
  bind is *cleared* — that is the case that was broken.
- `NOTE_ON_EX` bit0 carries a per-note velocity. It replaces the live value for
  that note **without** becoming the base, so it neither survives the note nor
  is lost to the copy.

Gate: `m3-macro-vel-clear` (FM + PSG accent-then-clear at a loop head, plus a
never-cleared macro that must not gain a write). `m3-macro-vel` pins the
macro-owns-the-envelope side.

## 8. Pitch Tables

Both tables are generated by the JS reference **from the same code as
`ir-utils.js`** (`midiToFnumBlock`, `PSG_MASTER_CLOCK`) and emitted as C arrays
the 68k links (§12). NTSC clocks: YM 7,670,454 Hz, PSG 3,579,545 Hz.

- **FM:** `FNUM_LUT[12]` u16, A-rooted so every entry falls in the 512–1023
  window `midiToFnumBlock` normalizes to:
  `[541,574,608,644,682,723,766,811,859,910,965,1022]` (A, A#, …, G#).
  For MIDI note n: `index = (n + 3) mod 12`, `block = (n + 3)/12 − 1`.
  Because the ideal F-number is exactly ×2 per octave, one rounded table +
  block reproduces `midiToFnumBlock` output bit-exactly for all notes with
  block 0–7 (MIDI 9–116); outside, block clamps and the F-number shifts
  (sub/ultra-sonic; ±1 LSB tolerance there).
- **PSG:** `PSG_PERIOD_LUT[72]` u16 for MIDI 45–116
  (`period = round(3579545 / (32 × freq))`; MIDI 45/A2 → 1017). Notes below
  45 clamp to period 1023, above 116 to the top entry.
- Fractional pitch (cents — glide, vibrato, NOTE_PITCH sweeps) is an M2
  sweep-engine concern: cents offsets are applied as a linear interpolation
  between adjacent LUT entries (F-number is near-linear over one semitone;
  error < 1 cent). Never in the M1 note path.
- **The F-number write is unconditional, not change-only.** The high byte
  (`$A4`–`$A6`) latches into a register the YM2612 shares across the three
  channels of a port; the low-byte write (`$A0`–`$A2`) commits `{latch, low}`
  to *its* channel. If the high byte were suppressed because this channel's
  block was unchanged, another channel's intervening high-byte write would have
  clobbered the shared latch, and the low-byte commit would pick up the wrong
  octave — audible pitch corruption that worsens with more active FM channels.
  So the pitch writers (`drv-player` `_writeFmPitch` / `_writeFm3OpPitch` and
  their C counterparts) emit the `$A4`/`$A0` pair every note through the
  always-write path, keeping the shadow current but never suppressing. This is
  the one place the sequencer deliberately bypasses change-only suppression
  besides the `$28` key edge. Both writes land in the same port run of the same
  slot (§4), so the pair stays adjacent on the way to the chip.

## 9. CSM Rule

- The compiler emits `CSM_ON` once at the start and `CSM_OFF` only at
  **end-of-stream** of an fm3-csm track; mid-track rests do **not** toggle
  the CSM bit (Timer A just keeps retriggering a released envelope).
- The sequencer's invariant: `MMLisp_stopTrack` (and END_OF_TRACK, and the stop
  side of `MMLisp_fadeTrack`) on the track flagged `isCsm` clears the CSM bits
  in reg `$27` — the flag exists in the track table precisely so stopping never
  leaves the chip in CSM mode.

## 10. Decided — Voice Representation

**Resolved: Option B adopted** (2026-07-06); the 29-byte voice entry layout is
**frozen in mmb.md §11** (2026-07-07). The export-time coalescing pass folds
full-voice PARAM_SET bursts into VOICE_TABLE entries + `VOICE_SET` (0x14); the
IR is unchanged. Rationale below.

**Landed 2026-07-19 (coalescing ON by default).** The exporter pass
(`live/src/mmb-voices.js`) and both players carry it. The `VOICE_SET` handler
block-copies the 29-byte entry in drv-player's exact write order (op outer,
register inner, then `$B0`), change-only vs the shadow (an unwritten register
reads as 0, so an SSG-omitting voice never writes `$90`), seeds the four
voiced-TL bytes, and updates the channel's algorithm so the vel/vol carrier-TL
recompose picks the right carrier mask. The ab-compare gate's `normalize`
collapses same-frame YM writes to the per-frame final value (drv-player's clock
is frame-quantized), which makes the ab baseline coalescing-invariant (§12).
Gate: `m3-voice` (both ports, mid-song switch).

Post-split the *stream* saving in the table below still stands, but the "driver
cost" column no longer decides anything: 29 shadow compares are nothing on a
68000, and a VOICE_SET whose registers already match emits no slot writes at
all. Voice coalescing is now purely a ROM-size optimization.

Today a full FM voice change compiles to ~30 same-tick PARAM_SET events:
~90 stream bytes and 30 dispatch iterations per change, repeated for every
voice switch in the song.

| Option | Stream cost / change | Driver cost | Toolchain cost |
| ------ | -------------------- | ----------- | -------------- |
| A. Leave as-is (PARAM_SET burst) | ~90 B | 30 dispatches + 30 queued writes | none |
| B. **VOICE_TABLE + VOICE_SET (recommended)** | 2 B (+29 B per *unique* voice, once, in VOICE_TABLE) | one dispatch → 29-byte table copy into shadow + writes | export-time coalescing pass in `mmlisp2mmb`; **IR unchanged** |
| C. New IR voice event | 2 B | same as B | IR schema change; player, live tooling, and spec all touched |

**Recommendation: B.** The win is large for any real song (voices are
reused constantly), the driver side is a straight register-block copy, and
it stays an *encoding* optimization — the IR keeps its honest per-parameter
semantics and the live player is untouched. Detection rule: a same-tick
group of PARAM_SETs covering the full voice parameter set (28 operator
params + ALG/FB) coalesces into a deduplicated VOICE_TABLE entry (mmb.md
§11) + `VOICE_SET` (opcode 0x14); partial groups stay as PARAM_SETs. The
29-byte register-order entry ($30,$40,$50,$60,$70,$80,$90 × 4 ops + $B0) is
specified in mmb.md §11.

### 10.1 Loop-invariant VOICE_SET (encode-time hoist)

**Retained but no longer load-bearing.** The pass was built because a
`VOICE_SET` cost the *Z80* 29 registers of shadow bookkeeping even when the chip
saw nothing — ~30k cycles per track, and a 7-track import measured **263k cycles
at the loop frame, 4.4× the budget**: four dropped frames, clearly audible as
the loop stumbling. On the 68000 that cost is negligible and the pass is kept
only because it is free and trace-neutral. The description below is the record
of why it exists.

`planVoiceHoists` (`live/src/export-mmb.js`) emits that VOICE_SET **before** the
marker instead, so pass 1 applies it and the backward JUMP lands past it. Moving
it across a MARKER cannot reorder any chip write (MARKER writes no register), so
the register trace is unchanged — asserted by the gate, and by an A/B of the same
song encoded with `opts.voiceHoist` on and off.

The hoist is skipped when the loop body can leave the voiced registers different
from what that VOICE_SET set: another voice change, a PARAM_SET/ADD/MUL/SWEEP on
an op param / ALG / FB, or a macro on one of those (where it stops is not a
compile-time fact). Those songs keep today's behaviour — the head VOICE_SET stays
inside the loop and restores the voice each iteration. `drv/tests/m3-voice-loop.mmlisp`
pins all three outcomes.

## 11. Milestones

**M1–M3 are feature-complete and gate-verified** in the all-Z80 build (core
playback; motion — sweeps, PARAM_ADD, TEMPO_SWEEP, cent pitch, CSM; expression —
FM3 independent-OP, the macro engine, dynamic value slots, PCM soft-mix,
CALL/RET, VOICE_SET, slur, SE). That work is not lost: **`drv-player.js` carries
every one of those features** and is the port spec (§12). What the split
re-plans is *where* the code runs, not *what it does*.

The port milestones:

- **P0 — mixer prototype. DONE 2026-08-02, and it paid for itself.**
  `drv/tools/gen-mixer.mjs` + `npm run mixer` (§5.3.1). Going first was the right
  call: the estimate was 50% optimistic, and even after the optimizations it
  found, **3 voices at 10.5 kHz does not fit with sum-then-saturate** — the knee
  for those semantics is ~8.6 kHz. Mix rate, buffer width and the pre-resampling
  decision are all back on the table, before anything was built on top of them.
  Settling §5.3.1's configuration is the gate on P1, because `SLOT_MAX_WRITES`
  falls out of whatever the mixer leaves (§6.2).
- **P1 — the interface. DONE for FM/PSG, 2026-08-02.** `drv/src/engine.z80`
  (2560 B: boot, vblank ISR, ring consume, PCM commands, published header, the
  segment-split voice driver), `live/src/slot-builder.js` (the wire format and
  the cap/spill queue — deliberately its own module, since the interface is
  part of the spec rather than either player's business), and
  `DrvPlayer.captureSlotLog`. Two gates: `npm run engine` (seven scenarios
  including loop wrap, mid-frame voice end, ROM bank crossing, ring starvation)
  and `npm run slots` (a real score end to end — §12.3).

  **PCM landed too, 2026-08-02.** `drv-player.js`'s mixer was re-based onto the
  settled semantics — voice-outer over a frame-long plane, 8-bit
  saturating-add, and the engine's countdown boundary rather than an
  `idx >= len` test — so the two now share a structure instead of merely
  agreeing on results. `npm run slots` checks the DAC stream sample for sample
  across the PCM corpus: 52,685 writes on `m3-pcm-softmix`, all matching.
- **P2 — the sequencer. M1 + M2 + M3 landed 2026-08-03.** `drv/68k/mmlispseq.c` —
  plain C99, no SGDK, so it compiles for the host as well as for m68k.
  - **M1:** the core opcode set, FM + PSG note paths, the level model, pitch,
    loops/CALL/RET, tempo, VOICE_SET, the armed frame, and slot emission
    through the real cap/spill queue.
  - **M2:** the sweep engine (`PARAM_SWEEP`/`_STOP`, two slots per channel,
    the eight integer curves), `PARAM_ADD` with its read-modify-write reads,
    `TEMPO_SWEEP`, cent-interpolated `NOTE_PITCH`, CSM (`CSM_ON`/`OFF`/`RATE`,
    constant and swept), and the host control API of §6.5 — `mml_key_off`,
    `mml_set_param`, `mml_fade_track` (the Bresenham vol ramp), `mml_set_val`.
  - **M3:** the macro engine of §13 (sticky binds, note-on re-instantiation,
    the attack/sustain/release regions, `NOTE_SEMI`, `NOTE_PITCH` override and
    additive, scaled macros, the `KEYON` retrigger), the value machine's stream
    ops (`PARAM_MUL` / `_FROM_VAL` / `_ADD_VAL` / `_MUL_VAL`), FM3
    independent-OP mode (`FM3_MODE`, `FM3_OP_PITCH`, and the per-operator key
    path §13.4 describes), and PCM — `PCM_NOTE_ON` / `_NOTE_OFF`, the level
    composition of §14, and the §6.3 command emission with every field resolved
    on this side.

  `npm run c-gate` diffs the slot stream against `drv-player.js` byte for byte:
  **38 corpus scores byte-identical** — `ab-core`, `demo1`, both stress scores,
  the whole M2 set (including `m2-mailbox` with its host-command schedule) and
  the whole M3 set (macros, dynamic values, FM3-op, and the six PCM scores).

  Opcodes not yet ported stop their track fail-safe (mmb.md §13) rather than
  mis-decoding a length, and the gate reports those scores as **PEND** with the
  opcode and how many leading frames were identical — so the port's remaining
  surface reads straight off the gate output, and a regression upstream of the
  stop still shows as that number falling. Nothing in the corpus is PEND today;
  what remains unported is **SE** (plan-se.md) — track lifecycle, START_SE,
  suspend/restore and priority — whose gate scores carry a richer sidecar
  (autoStart off + a channel remap) and are reported SKIP until it lands.

  One thing the 68k has to carry that is not obvious from the opcode list: it
  **shadows each PCM voice's position**. It never reads a sample byte — the
  mixer is entirely the Z80's — but two of its own decisions depend on when a
  voice retires (a `PCM_VOL` for a dead voice is not worth the slot bytes, and
  `PCM_NOTE_OFF` on a finished shot must emit nothing), so it runs the same
  16.16 countdown over the same mix grid. The cost is 3 × `PCM_MIX_RATE`
  add-and-compare per frame; a closed form exists for the non-looping case if a
  cycle count ever asks for it.
- **P3 — integration and bring-up. The glue landed 2026-08-03; hardware has
  not.** `drv/sgdk/{mmlispdrv.c,mmlispdrv.h}` was rewritten for the split: the
  mailbox is gone, so track control is ordinary calls into `mmlispseq.c` (which
  the game now compiles in, alongside its generated tables), and the only thing
  crossing the bus per frame is the slot. `MMLisp_frame()` is §6.6's hook;
  `mml_pump` is the policy half of it, kept in the sequencer so the host gate can
  reach it. `MMLisp_init` takes no overlay argument, `MMLisp_loadScore` is new,
  and the score no longer needs 32 KB alignment — only the sample bank still
  goes through the Z80's window.

  The build path changed with it: `tools/build-engine.mjs` assembles
  `src/engine.z80` with the generated mixer and `tools/emit-bin.mjs` emits the
  one resident image (2,668 B) plus its header constants. The overlay blob and
  its C array are deleted. `build-driver.mjs` still builds the superseded
  all-Z80 driver — nothing ships from it.

  Two new gates, both host-side: `npm run ring` (§12.7) and `npm run sgdk:lint`,
  which compiles the glue and the example against a hand-written shim of the
  dozen SGDK symbols they use, with the real `mmlispseq.h` in the include path.
  That catches the likeliest failure — the glue drifting out of step with the
  sequencer API, which changes far more often than SGDK does — and it catches
  nothing else, which is the honest claim to make for it.

  **Still open, in the order P3 needs them:** per-score `(trig N)` delivery
  (markers are rendered ahead by the ring depth, so they have to be released
  against `frames_consumed` — §6.4 says what to compare, but there is no API
  yet), more than one score loaded at once (§2.3's DJ transitions), the SE port
  (plan-se.md), PAL (§3.3), and raising the mix rate (§5.3.1). The open hardware
  questions are unchanged: YM BUSY behaviour on silicon, and the DAC jitter the
  68k's per-frame bus grab introduces (§1.3).

What the split unlocks, deliberately **not** scheduled until P3 lands: dynamic
and ping-pong loop points (§6.3), cross-MMB DJ transitions (§2.3), PAL (§3.3),
and revisiting the 3-voice PCM limit. All of them are cheap now; none of them
is a reason to delay the port.

## 12. Verification Strategy

There is no automated test suite for audio; verification is comparative. The
split changes which pairs get compared, not the method — and it makes the
central gate **cheaper**, because both sides of it now run on the host.

### 12.1 `drv-player.js` — the executable spec

Executes MMB v0.2 with the §4 loop order and **integer-only math** (8.8
accumulators, the §7/§8 integer tables — no floats), in the live environment as
an alternate backend. It is the executable form of this document, and P1 extends
it to emit real slots through the real cap/spill queue (§6.2) so it specifies the
interface too, not just the music.

### 12.2 68k C ≡ `drv-player.js` — the hard gate

The C sequencer compiles for the host as well as for m68k (its core is plain C
with no SGDK dependency), so the gate is: run both over the same MMB, dump the
per-frame slot stream, diff at **zero tolerance** — same writes, same values,
same ports, same frames, same order. `npm run c-gate`.

Two things the port needs that the reference gets for free, both discovered by
this gate:

- **A shadow-validity plane.** `drv-player` keys its shadow with a Map, so an
  unwritten register never compares equal to anything; a zero-initialised C
  array would suppress the neutral patch's many writes of 0. (The Z80 solved
  the same problem by writing every covered register at boot, which is what let
  it drop its own plane — driver.md §5.)
- **`VOICE_SET` compares against the STRUCTURED shadow**, not the register
  shadow, because the burst it replaced only wrote registers some PARAM_SET
  touched (§10).
- **The drain must not render.** Once the song is over the harness closes slots
  until the spill queue is empty; those slots have to be *encoded only*. Running
  another frame there invents traffic (a sweep step, a retiring PCM voice) that
  the reference, which only calls `endFrame`, never produces.

A PCM score's sample bank is a separate ROM bank rather than an MMB section, so
the gate hands it to the C as a separate file (`--samples`) — the same shape the
68k will see through its bank window.

This is a straight replacement for the old asm↔reference trace gate and it is
strictly easier: no emulator in the loop, no assembler, and a debugger on both
sides. It is also why the port is far less risky than the original Z80 one —
that one had a prose spec, this one has a validated implementation in a portable
language.

### 12.3 Z80 engine ≡ the slot stream

The engine's contract is narrow enough to gate directly, and it is gated two
ways. The existing first-party assembler/emulator/trace toolchain (`drv/tools/`)
carries over unchanged.

**`npm run engine`** feeds hand-written slot streams and asserts that (a) the
chip writes are exactly the slot's bytes, in order, on the right ports, and
(b) the `$2A` DAC stream matches a JS model of §5.3 sample for sample. The
scenarios exist to pin the segment arithmetic: a loop wrapping several times
per frame, a shot ending mid-frame, a sample crossing a ROM bank boundary, a
mid-flight `PCM_LOOP`, and a starved ring. One more pins the sub-slots (§3.5):
writes placed in *every* sub-slot, once with PCM sounding and once without, so
both delivery paths — the mixer's voice-pass boundaries and the paced idle loop
— have to produce the frame's whole write sequence in order. A PCM-less score
silently losing its sub-ticks is otherwise an invisible failure.

**`npm run slots`** runs a real score the whole way — `.mmlisp` → MMB →
`drv-player.js` → slot stream through the real cap/spill queue → the engine —
and asserts the chip writes *are* the sequencer's register writes: same values,
same ports, same order, nothing added or dropped. It also asserts the transport
only ever **delays**: a write may arrive in its own frame or a later one, never
earlier — **and that the engine never starves**. The host model renders from
*inside* the engine's frame, ~20% in, because that is where a 68000 woken by the
same vblank actually gets its turn; rendering before the interrupt (which this
gate did until 2026-08-06) hides a ring-geometry fault completely, and one
reached hardware as half-speed music. On the corpus the cap binds only at a score's head (the burst §4.2
describes) and never in steady state — 2 frames held back, at most 2 frames
late, on scores from 395 to 1801 writes.

### 12.4 The mixer cycle gate

**New kind of gate, and a hard one.** §5.3's cost is load-bearing for the entire
architecture, so it gets asserted rather than assumed. `drv/tools/mixer-bench.mjs`
(`npm run mixer`) runs one frame per configuration in the emulator with the cycle
counter on, attributes cycles per routine, and diffs every DAC byte against a JS
model of the mix — correctness and cost in one gate, so a fast-but-wrong loop
cannot pass. Results: §5.3.1.

Cycles are a *specified* property of this driver now, not something discovered on
hardware. That is the lesson of §1.1 — an unmeasured estimate survived three
milestones and then forced an architecture pivot — and the P0 run earned it
again immediately: the replacement estimate was itself 50% optimistic, and found
that out in an afternoon instead of on silicon.

### 12.5 `ir-player` A/B — characterization

**Register-write log A/B** (`ab-compare.js`; `window.__abCompare()` in
the live app). The reference driver's frame-stamped register log is
diffed against `ir-player.js` output as per-register *state runs* (raw
write streams are incomparable: the IR player runs a continuous clock
and repeats values; the sequencer is change-only, and quantized to the
frame for its engines and to the sub-tick for note onsets, §3.5).
Unchanged by the split. Acceptance bands:
   - **±1 frame** timing skew on every state change and key edge.
   - **TL data ±2 steps** (integer offset tables vs float-sum-then-round);
     **F-number low byte ±1** (LUT cent interpolation vs float pow).
   - **$28 key edges compare per channel** — cross-channel write order
     within one frame is player-specific and carries no meaning.
   - **Waiver — notes sounding across a TEMPO_SET**: the IR player
     schedules a note's key-off at onset-tempo (queued writes cannot be
     retimed); the driver counts gate ticks under the live tempo map and
     is the tick-exact one. Scores for exact A/B (ab-core) put tempo
     changes on all-track note boundaries.
   Gate: `examples/source/ab-core.mmlisp` (exactly the M1 opcode set) must
   diff clean — currently **0 mismatches**. Songs using M2/M3 features
   (macros, sweeps, PCM, CSM) report skipped-event diagnostics and A-side
   surplus writes; expected, logged, not a failure.

   **Known open divergence (bug, not a band).** A PSG soft-envelope on a
   gate-cut note (`:gate-`/`:gate*`) diverges at the note boundary: the IR
   player emits a 1-frame hard key-off (att 15) between notes, so they
   separate; the driver lets the macro release value hold, so they connect.
   The gate key-off also lands on a slightly different frame in each. Not yet
   reconciled — see `.claude/memory/z80-driver-status.md` for the full arc.
   This divergence is now frozen in the A/B baseline (below), so it is watched
   rather than silent.

   **Automated A/B gate** (`drv/tools/ab-gate.mjs`, `npm run verify:ab`, folded
   into `verify:all`). Because M2/M3 scores diverge by construction (the
   exporter pre-samples curves that `ir-player` evaluates in continuous time),
   this is a *characterization* gate, not a 0-diff one: each corpus score's
   mismatch signature (count + digest) is frozen in `drv/tests/ab-baseline.json`
   and the gate fails when a signature **changes**. Pure-M1 scores (ab-core)
   baseline to zero. This closes the blind spot that let the PSG release bug
   hide — any new drv↔ir divergence (or the disappearance of a known one) now
   fails the gate. After an intended change, review the printed mismatches and
   re-freeze with `node tools/ab-gate.mjs --update`.

   **`npm run level-diff <song.mmlisp>`** (`drv/tools/level-diff.mjs`) is the
   companion for the question the gate cannot answer: *where is the driver
   louder than the reference, and by how much*. The gate reports whether the
   divergence set moved; this replays both logs into a register file, samples
   the level state per frame (carrier TL under the algorithm in force, PSG
   attenuation), and prints only the spans where the **driver is the louder of
   the two**, in dB, with the loop frames alongside. It exists because a level
   bug reads as an unremarkable `missing-in-b` line in a gate summary — that is
   how the §7.1 velocity bug hid for a release. Two things it must do to be
   trustworthy, both learned by getting them wrong first:

   - **Tile ir's loop.** `ir-player.captureRegisterLog` captures one pass and
     reports `loopStartSec`/`endSec`; the driver actually loops. Without
     re-emitting the body at +P (as `export-wav.js` does) every iteration after
     the first reads as "the driver is louder" — and the loop point, which is
     where these bugs live, falls outside the comparison entirely.
   - **Ignore spans shorter than `--hold` (default 3 frames).** The ±1 frame
     note-timing skew of §12.5 shows up as a level difference whenever one
     player has keyed off and the other has not. A blast is a level that is
     wrong for a whole note, not for a frame.

### 12.6 LUT export

The reference prints every constant table (F-number, PSG period, level offsets,
PCM rate multipliers, curve units) for verbatim inclusion — as C arrays for the
68k, as `db`/`dw` blocks for whatever the Z80 still needs. Neither side ever
re-derives a table, so table divergence stays structurally impossible.

### 12.7 The ring transport — a pipeline, not a filter

`mml_pump` (§6.6) is eight lines of modular arithmetic that fail *silently* when
they are wrong: a stalled ring reads as "the music stopped", a wrapped index as
"the music got strange". So it gets its own gate rather than riding on the slot
comparison.

`npm run ring` runs a score through the harness twice — once calling
`mml_render_frame` directly, once through the real ring with a model of the Z80
consuming one slot per its own vblank — and requires the two byte streams to be
**identical**. Every seventh host frame skips the call entirely, standing in for
a game frame that overran; at depth N the ring absorbs N−1 of those (§3.4), so
the stream has to survive that too. Depths 2, 3, 4 and 8 all run, which is what
exercises the wrap. Inside the loop the harness also asserts §6.6's self-limiting
property directly: the call tops the ring up, so a second call in the same frame
must render nothing.

What this deliberately does *not* cover is the bus grab and the byte copy —
those live in the SGDK layer, which no gate here can reach. Keeping the split
exactly there (policy in the sequencer, mechanism in the glue) is what makes the
untestable part small enough to read.

## 13. Macro Engine (M3)

Macros (docs/language.md §10) are per-target parameter automation attached to
notes. The rich authoring vocabulary — step vectors, curves, multi-stage,
`:hold` sustain loops, `:off` release, `_` holds, the `:step` clock, symbolic
coercion — is **lowered at compile time** to one uniform runtime shape (mmb.md
§15): a per-`:step` value array in three regions (attack / sustain-loop /
release). Curves and stages are pre-sampled; the driver never evaluates a curve
or easing at macro time. This keeps the engine tiny and reproduces `ir-player`
`_scheduleMacro` exactly, so the JS reference and the port share it under the
§12 gate.

**Implementation status.** Everything below is implemented and gate-verified in
`drv-player.js` and in the all-Z80 build; the split re-targets it to the 68k C
(P2, §11) with no semantic change. Coverage is the `steps`, `curve`, and
`stages` macro forms on i8 targets that ride the
PARAM_SET apply path — the common envelope/LFO case (VOL/VEL/FM_TL/…). Curve
and stage macros are pre-sampled at the `:step` clock in the exporter (a
one-shot curve fills the attack region and holds its last value; a looping
curve/stage fills the sustain region; `(wait key-off)` marks the release
boundary) — no engine change, the same value array is stepped. The macro-only target **NOTE_SEMI** is implemented (§13.2): its value is a
semitone offset written to the pitch register at note+semi each `:step` (no
retrigger, no change to the sticky `:pitch` state) — the classic chiptune
arpeggio, on FM and PSG. The i16 target **NOTE_PITCH** is implemented (pitch
envelopes / vibrato shapes): its descriptor carries flags bit0 (i16), the value
blob is 2 bytes per `:step` (cents, hold sentinel `0x8000`), and the stepper
reads it wide and rides the PARAM_SET apply path (`NOTE_PITCH` cents offset) —
gated by `m3-macro-pitch` on FM and PSG. **Multiple macros per channel** run
together (up to 3, keyed by target — e.g. a VOL envelope + a NOTE_PITCH vibrato
+ a NOTE_SEMI arpeggio): the active ids stay compact and insertion-ordered
(matching drv-player's Map), `MACRO_SET` replaces same-target in place and
appends a new target, `MACRO_CLEAR` removes one target (or all on `0xFF`),
NOTE_ON instantiates every active into its running slot, and `process_macros`
steps all three — gated by `m3-macro-multi`. The macro-only target **KEYON**
(retrigger) is implemented (`apply_keyon`, gated by `m3-macro-keyon`): a nonzero
step re-attacks the note — it restarts the channel's non-keyon macro slots to
their attack (so soft-envelope `:vol`/`:pitch` macros replay) and, on FM, re-keys
the hardware EG (`$28` off→on; FM3-op op via its mask). PSG has no hardware EG,
so the soft-envelope restart is the whole effect; the macro engine runs on
channels 0–9, so PCM and FM3-op op2–4 are deferred (exporter drops `:keyon`
there). Tick-unit `:step`/`:len` are resolved to a 60 Hz frame count at the
note's tempo when the macro is snapshotted (compiler side, like the `Nf`
glide/delay resolution), so both frame (`Nf`) and note-length macro clocks work.
Interim limit: dynamic (val-slot) `:from`/`:to`/`:rate`/`:len` are dropped with a
warning. The hard gate is asm↔`drv-player` at zero tolerance; the `ir-player` A/B is informational for
macros (the exporter pre-samples what `ir-player` evaluates in continuous time).

### 13.1 Sticky active set + trigger

`MACRO_SET {macro_id}` binds MACRO_TABLE[macro_id] as the **active macro for
its target** on the track (sticky, replacing any active macro on that target);
`MACRO_CLEAR {target}` clears one (`0xFF` = all). The channel holds up to **3**
active-macro ids (§4.3). On **any** `NOTE_ON` the sequencer instantiates each
active macro into a **running slot** (3 slots × {descriptor index, step clock,
cursor, flags}); `NOTE_ON_EX` `macro_ref` adds a per-note one-shot. When a
channel's active set would exceed 3, the *exporter* drops the extras with a
`W_MMB_MACRO_SLOTS` warning (deterministic) — the driver never overflows.

### 13.2 Per-frame stepping

In the frame loop (§4 step 3, after the sweep engines, before the write flush),
each running macro:

1. advances its step clock; on a `:step` boundary it writes `values[cursor]`
   to the target through the **same** per-target apply path `PARAM_SET` uses
   (level composition, cent pitch, pan snap, …), skipping the hold sentinel;
2. advances `cursor` with the region rules — attack once, then the sustain
   region cycled while the note is keyed, jumping to the release region at
   key-off, then playing release once and ending.

An **override** pitch macro (`:pitch`/`:semi`, no `+`) writes the note pitch from
the sample alone each frame and does **not** persist to the channel's sticky
`:pitch` base — so once the macro ends or is cleared (`(macro :pitch none)`) the
following notes play at their true pitch, with no residual detune.

Two macro flags (MACRO_TABLE descriptor, mmb.md §15) modify the sample before
it is applied. **Additive** (bit1, `:pitch+`/`:semi+`): the sample composes with
the channel's live `:pitch` offset instead of replacing it. **Scaled** (bit2,
`(* <LFO> $slot)`): the sample is multiplied by a value slot read **live each
frame** — `(sample × (slot & 0xFF)) >> 8`, magnitude multiply re-signed toward
zero. The slot id rides one byte appended after the value blob. This is the
frame-tier interactive knob — the game writes a slot (`MMLisp_setVal`) and a
vibrato/tremolo depth follows in real time, at the ring's latency (§3.4).

`NOTE_SEMI`/`KEYON` (macro-only targets, opcodes.md §7) resolve here: `NOTE_SEMI`
adds `value × 100` cents to the note pitch (no retrigger, chiptune arpeggio),
`KEYON` retriggers key-on when the value crosses ≥ 0.5.

### 13.3 Ordering

Running slots step in a fixed order (active-set index, ascending channel) so
the register trace is deterministic — the same requirement as the sweep engine
(§4). Macro writes and sweep writes on the same target in the same frame follow
their engine order (sweeps first, then macros), matching the reference.

A macro steps while its channel is **keyed** (note active), which is distinct
from **audible**: a `:vel`/`:vol` macro can drive the level to silence (PSG
att 15) mid-note without ending the note, and must keep stepping so it can bring
the level back up. So the engine keys off `CHS_STATUS` bit0 (keyed), set at
NOTE_ON and cleared at channel-off — not bit1 (PSG audible). A level macro
re-applies to the output (FM carrier TL / PSG att) each step, sharing the
PARAM_SET path, so it updates the sticky `:vel`/`:vol`; a following note
re-establishes its own level on its NOTE_ON (or its own macro's first step), and
the change-only shadow absorbs the transient.

### 13.4 FM3 independent-OP mode (implemented)

`FM3_MODE {mode}` (0xA3) sets CH3's mode register `$27`: mode 1 sets bit6
(special / independent-OP), mode 2 sets bit7 (CSM), mode 0 clears both. In
special mode CH3's four operators run at independent F-numbers with their own
key bits.

The score splits this across coexisting tracks: a note-less `(fm3 voice)`
track carries the shared patch and channel level state, and `fm3-1`–`fm3-4`
each drive one operator. `fm3-1` rides channel 2 (with the voice, §2.2);
`fm3-2`–`fm3-4` ride channel ids 16-18. Each operator note emits
`FM3_OP_PITCH {op, note}` (0xA4) — writing that operator's F-number registers
(OP4 → the CH3 base `$A6`/`$A2`; OP1-3 → `$AC+idx`/`$A8+idx` with
`idx = op mod 3`) — followed by a `NOTE_ON` that keys the operator.

Keying is a shared 4-bit mask (`G_FM3MASK`): each operator's key sets/clears
its bit (OP1 = `$10` … OP4 = `$80`) and re-emits `$28 = mask | 0x02`. A full
gate is used (the operator keys off at the next rest / end-of-track). The
driver derives the operator from the channel id (2→1, 16-18→2-4); F-numbers
go through the change-only shadow, key edges bypass it.

## 14. PCM Soft-Mix — musical model

The mixer's mechanism and cost live in §5.3; this section is the model the
language and the sequencer commit to.

`pcm1`–`pcm3` are three PCM voice slots summed in software to the single fm6
DAC. (`fm6` itself is FM-only; it is no longer a PCM channel.) **Three is a
fixed count, decided 2026-08-02**, so the mixer can be fully specialised — three
passes, no voice-count loop. A `PCM_NOTE_ON` in the stream becomes a `PCM_START`
command in the frame's slot (§6.3); `PCM_NOTE_OFF` becomes `PCM_STOP`, which
starts a looped voice's release tail — a `shot` plays to its end regardless.

**Per-note pitch vs pre-resampling — reopened by measurement (§5.3.1).** The
pivot rejected compiling samples to a fixed playback rate ("option B") on the
grounds that the runtime resampler costs ~25 cyc/voice/tick, 11% of the PCM
budget. Measured, it costs **~40 cyc/voice/tick, 27% of the mixer**, and
removing it is the single largest lever on the frame budget: it takes 3 voices
at R = 175 from 132% to 96%. The trade is unchanged in kind — pre-resampling
costs per-note PCM pitch, dynamic loop freedom and ROM — but its price is now
known rather than assumed. Undecided; §5.3.1 lists the configurations.

While runtime resampling stands, `inc` is `floor(inc_frame / R)` computed on the
68k at full precision (a table pre-divided by `R` would round too coarsely).

**The DAC is claimed, not owned.** The first active voice enables it (`$2B`
bit 7) and the mixer releases it once every voice is done, so a score may use
`fm6` and `pcmN` together: the chip mutes fm6 for exactly as long as the DAC is
on, and fm6 sounds as FM in the gaps between PCM voices. The `m3-fm6-pcm` gate
locks those enable/release edges around an fm6 key-on.

**Post-split, `$2A` and `$2B` are the engine's and never cross the bus.** The
sequencer could compute when a shot ends and send the `$2B` edges itself, but
that would make both sides responsible for agreeing on the exact frame — a
coupling worth not having, when voice activity is the one piece of state the
Z80 already owns. So the slot never carries them, and the gate compares the
engine's DAC traffic against the reference *mixer's*, separately from the
power-on patch (which still writes both, for parity with `ir-player`).

**Per-channel volume (`:vel` + `:vol`).** `:vel` and `:vol` on a `pcmN` channel
ride the FM/PSG velocity/fader ladder (2 dB/step). The sequencer composes them
into one per-voice attenuation the mixer applies as an arithmetic right shift on
each sample before summing — one `sra` per sample, so volume stays off the
critical path. Summing each control's steps-below-unity gives the attenuation,
quantized to the 6 dB shift grid:

```
n = (15 − vel) + (31 − vol)
shift = min(PCM_MAX_SHIFT, round(n / 3))    # the voice's shift, bits0-2
mute  = (vol == 0) || (master == 0)
        || (shift + master_shift >= PCM_TOTAL_MAX_SHIFT)    # bit7 — true silence
```

so the same `:vel`/`:vol` mean the same loudness on a PCM voice as on FM/PSG.
`vel` never mutes — `vol 0` is a hard mute, and so are the two master conditions
in §14.1 (a muted voice still advances, matching FM where a note continues
silently under a 0 fader). The compose runs on the 68k, once per `PARAM_SET
VEL`/`VOL` (and for every voice on a `MASTER` change, because master decides the
mute), never per sample, and reaches the Z80 as a `PCM_VOL` command; `vel`/`vol`
persist per voice and ride the SE snapshot.

A single voice takes the same path — there is no separate fast path.

### 14.1 `:master` rides the sum, not the voices

**`:master` is not in the per-voice shift.** It is common to every voice by
definition, so the mixer applies it ONCE PER DAC SAMPLE, in the emit, to the
finished and already-saturated sum:

```
master_shift = min(PCM_MASTER_MAX_SHIFT, round((31 − master) / 3))
```

and it reaches the Z80 as `PCM_MASTER` (§6.3) — the one voiceless PCM command.

**Why it moved is the ceiling, not the cycles.** Folded in, master shared
`PCM_MAX_SHIFT` with `vel`/`vol`, and that ceiling exists for a per-tick cost
master does not have. The result was a PCM voice that would not fade: measured
on the DAC stream, peak per step, one voice at unity `vel`/`vol` —

```
master   31    28    25    22    19    16    13    10     7     4     1     0
before  -3.1  -9.1 -14.9 -20.6 -26.6 -26.6 -26.6 -26.6 -26.6 -26.6 -26.6  -inf
after   -3.1  -9.1 -14.9 -20.6 -26.6 -32.6 -36.1 -36.1 -36.1 -36.1 -36.1  -inf
```

FM went on down the TL ladder and PSG down its 4-bit one while PCM held at
−26.6 dB and then fell off a cliff. The defect was that PCM did not follow the
fader at all past a point, not that it followed it coarsely: it now reaches two
rungs further and lands on silence from −36 dB. `master 12..1` still share the
bottom rung, and the drop from there to silence is still a step.

**A stepped DAC level is by design, not a shortfall (decided 2026-08-12).**
Smoothness is not a requirement for PCM — 6 dB rungs are the model, the same
way `PCM_MAX_SHIFT` clamps `vel`/`vol` at four of them. What the level has to do
is MOVE when the fader moves and reach silence at `master 0`; how finely it
subdivides on the way is not something this mix is asked to deliver. Anything
that would buy resolution here (below) is therefore out of scope, not deferred.

**Saturation order changed, deliberately.** Each voice used to be attenuated
before the saturating add; the sum now saturates at full scale and is attenuated
after. A fade-out therefore holds whatever the mix clipped and takes THAT down,
rather than un-clipping as it goes. That is what a master fader does, and it is
a real audio change: gate scores that move master move with it.

**Deep is muted, not mixed.** `shift + master_shift >= PCM_TOTAL_MAX_SHIFT` (7)
silences the voice — the same "inaudible, so do not sound it" rule
`PCM_MAX_SHIFT` states, applied to the total. 7 leaves one bit of an 8-bit
sample, and muting also hands the frame the voice's whole per-tick cost back,
which is what keeps the new deep rungs affordable.

**How the Z80 holds it (§5.3).** The emit is inlined into all twenty loop copies
and has no free register to read a shift from and no cycles to fetch one with —
`A` is the sample, `A'` the gate phase, `HL`/`DE`/`BC` the mixer's register file,
`IY` the ring cursor. So the shift is PATCHED INTO THE CODE. Every emit carries
two copies:

- the **plain** one, byte-for-byte what the engine ran before this change, and
  the fall-through;
- the **attenuated** one, carrying `PCM_MASTER_MAX_SHIFT` two-byte chain slots
  that `pc_master` fills with `sra a` plus a jump over the rest.

The gate's own `jr nz` chooses between them, with its displacement patched — the
branch was already there, so unity pays nothing for the choice. `mst_tab` /
`mst_tab1` in the generated mixer list every site; `gen-mixer.mjs` emits the
displacements as label arithmetic so a re-layout cannot silently rot them.

This is affordable only because the shift moves on the 6 dB grid: three `master`
steps to a rung, so a full fade rewrites the sites about seven times rather than
once a frame. The 68k emits `PCM_MASTER` on the SHIFT, never on `master` itself.

**What it costs**, measured with `budget:frame`, two voices looping at unity
`vel`/`vol`, cycles per frame against a 59,736 budget:

```
master   31      28      25      22      19      16      13
before   59,132  59,439  62,440  64,894  67,416  67,416  67,416
after    59,199  62,760  63,956  65,178  66,415  67,670  68,975
```

Unity is free (+67, 0.1%: the gate's own sample and `feed_one` always take the
general form). Past that the attenuated path costs a flat 12 cycles a sample —
one branch, structural, because the plain copy's prologue sits between the chain
and the shared tail — plus 8 a step. So a shallow master costs ~3,300 cycles
where the fold cost ~300, and a deep one is a wash. **This change does not buy
frame budget. It buys the fade.**

The alternative that keeps coming up is a 256-entry lookup table, flat in cost
and smooth at 256 levels instead of 6 dB steps. **It is closed by the decision
above** — it buys resolution nobody asked for. Its mechanics are recorded only
so the question does not get reopened as if it were cheap: the table needs a
register pair pointing at it at emit time, and the only way to load one there is
`ld ixl,a`, which is undocumented and absent from this repo's assembler and
emulator. So it would cost a resolution requirement AND two new tools.

**Sub-frame feed timing** was the open item here, and it was real: the engine put
each frame's samples out in 12% of the frame until 2026-08-03. §5.1 is the fix
and `npm run dac` is the gate. What is left for silicon is the 68k's per-frame
bus grab, ~0.2% jitter on top (§1.3), and whether the residual pacing wander
(~3.4 ms, §5.1) is audible under real material.
