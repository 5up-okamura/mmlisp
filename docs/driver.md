# MMLispDRV Architecture — 68k sequencer + Z80 DAC/write engine

MMLispDRV plays MMB v0.3 (`docs/mmb.md`, `docs/opcodes.md`) on a Mega Drive. The
68000 runs the sequencer; the Z80 keeps the DAC clock and puts the sequencer's
chip writes on the YM2612. This document defines both halves, the interface
between them (§6), and the interactive-playback model the language is built
around (§2).

## 1. Role and Constraints

Two processors:

- **68000 — the sequencer and the host.** Walks the MMB, runs the tick
  accumulators, dispatch, sweeps and macros, composes levels and pitch, and
  renders each frame into a list of register writes and PCM commands (§4). The
  host glue turns that frame into `{op, val}` pairs, writes them into Z80 RAM
  in one bus grab a frame from the vertical interrupt (§6.6), and writes the
  PSG itself. The MMB lives in 68k ROM and is read as a plain byte array.
- **Z80 — the engine.** Plays one to three PCM voices through the fm6 DAC on a
  fixed clock taken from its own instruction stream, and consumes the pairs:
  YM2612 register writes and the PCM voices' state (§5). There is one engine
  image per PCM voice count, each at its own rate; the score names the one it
  plays on. It evaluates nothing: every value arrives register-ready.

**Who keeps which clock.** The DAC's sample clock is the Z80's instruction
stream — no interrupt and no timer. The music's frame clock is the 68000's
video clock (SGDK's `vtimer`): the sequencer renders ahead and the pumps
release each frame when its time has come (§3.1), so a late main loop delays
nothing that was ready.

Design principles (working agreements applied to the driver):

- **Pointer walking only.** The MMB is decoded in place; no parsing pass, no
  unpacking, no allocation.
- **The engine stays dumb.** All computation that can happen at compile time
  does: BPM → tick increments, note names → MIDI numbers, Hz → Timer A
  periods, easing vocabulary → integer curves, PCM pitch → per-note baked
  samples. Everything else happens on the 68000, including all runtime
  computation the score needs (health → volume, speed → pitch, §6.5).
- **Determinism.** Frame-by-frame register output is a pure function of
  (MMB bytes, host command history). The JS reference and the 68k C produce
  identical write logs, and the engine reproduces the writes it is handed and
  the DAC stream its state implies (§12).

### 1.1 Why the work is split this way

The sequencer and a PCM mixer do not fit one Z80: a sounding PCM voice costs a
large, fixed share of every sample period, and the sequencer's worst frames
need most of a frame on their own. The 68000 has the cycles, a hardware
multiplier and direct ROM access, so it takes every decision; the Z80 keeps
only the work that must be exactly periodic — the DAC — and the chip writes
that must not disturb it.

The YM2612 writes go through the Z80 rather than straight from the 68000
because the 68000 would have to hold the Z80's bus for every write and its
BUSY wait, which stops the DAC. Pairs are copied in short grabs; a grab is a
bus stop, and no stop is repaid (§5.1). The PSG is on the VDP's bus, so the
68000 writes it directly and stops nothing.

### 1.2 Fixed limits

**8-bit DAC output** (YM2612), **one to three PCM voices** (one engine image
per count, §5), **no runtime pitch** (PCM is baked per note at the image's
rate by the exporter, §14.2), **one 32 KB sample bank a song** (§5.4), and
**bus stops**: the 68000's grabs and SGDK's own halts around joypad reads and
VBlank DMA stop the Z80, and the DAC runs slow by the time the bus was held
(`drv/sgdk/README.md`, "Bus stops that are not the driver's").

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
runs out), otherwise immediately. The channel state records the owning
track id (§4.3) to arbitrate this.

**Exception — the FM3 shared channel.** Channel 2 is exempt from eviction:
in FM3 independent-OP mode the note-less `(fm3 …)` voice track and the
`fm3-1` operator track legitimately coexist on it (§13.4), so a second
track claiming channel 2 keeps both rather than releasing the first. The
first claimant owns the shared level state; later ones only key their
operator. (`fm3-2`–`fm3-4` live on ids 16-18, which carry no channel block
and never arbitrate.)

### 2.3 Layering and scene transitions

A track control block carries the pointer to its own score, so the sequencer's
model allows tracks of several MMBs to run at once. The SGDK host loads **one
score at a time** (`MMLisp_loadScore` resets the sequencer); cross-score
transitions are not available yet (§11). Within a score, a transition is
started and faded per track:

```c
MMLisp_startTrack(TRACK_B1);
MMLisp_startTrack(TRACK_B2);
MMLisp_fadeTrack(TRACK_A1, 60);   /* 60 frames ≈ 1 s */
MMLisp_fadeTrack(TRACK_A2, 60);
```

### 2.4 `len=0` — indefinite hold

A NOTE_ON with duration byte 0x00 keys on and **suspends the track's
dispatcher** until the host calls `MMLisp_keyOff` (on the channel) or
`MMLisp_stopTrack`. Use cases: state-length sound effects (engine rumble,
charge-up), pad chords under a scene, PCM loops held open. Sweeps/macros
already running on the channel keep running while held.

### 2.5 Sound effects

SE is sequencer work — priority arbitration, suspend/restore of the displaced
BGM channel, snapshot of mid-sustain state — so it belongs on the 68000. The
reference player (`drv-player.js`) implements it; the C sequencer does not yet,
and the SGDK host has no SE call (§11).

## 3. Timing

### 3.1 Clocks and accumulators

**The frame clock is the 68000's.** `MMLisp_frame()`, called once per frame
from the game's main loop, renders each frame `MMLISP_LEAD` (default 1) frames
before its time into the pair queue. The pumps (§6.6) send only the frames
whose time has come, counted from SGDK's `vtimer`. A main loop that runs late
renders the missed frames on its next call; one that falls more than three
frames behind is taken as a stop (a load, a pause screen) and moves the time
base, so the music pauses rather than bursting through the missed frames.

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

**The DAC clock is the Z80's** (§5.1) and does not depend on the 68000 at all.

### 3.2 Why 8.8, and the error budget

PPQN 96 at 60 fps gives fractional ticks per frame for almost every tempo
(120 BPM → 3.2 ticks/frame). With an 8.8 accumulator:

- **Accumulation is exact.** Integer adds only — the fractional part is
  never discarded, so over any loop of N frames the track advances exactly
  `N × increment / 256` ticks. Every loop pass reproduces the identical
  tick-to-frame pattern: **zero drift over loops**, and two tracks at the
  same increment can never diverge.
- **The only error is the one-time rounding of the increment**, bounded by
  0.5/256 tick per frame. This is a constant tempo offset, not accumulating
  jitter: relative tempo error ≤ 0.5 / increment.
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

Not supported. The tempo increments assume 60 Hz (the correction would be a
6/5 scale applied at TEMPO_SET), and the sample bank is baked for the NTSC DAC
rates (§14.2).

### 3.4 Latency of host calls

Every control call (§6.5) takes effect on the next frame `MMLisp_frame()`
renders. That frame is released `MMLISP_LEAD` frames later, and its writes
reach the chip within about half a frame of their time (the grab period plus
the pair page). Each frame of lead is a frame of latency on every host → music
operation; the lead is what absorbs a heavy frame of the game or of the music
(a voice change on several channels can take more than a frame to render).

### 3.5 Note onsets

Note onsets fall on the 60 Hz frame. The slot format keeps a sub-tick count,
`SLOT_SUBS`, as a format parameter fixed at 1 (§6.2).

## 4. The 68k Frame — rendering one frame

Frame order is **fixed and normative** — `drv-player.js` implements exactly
this order and the 68k C reproduces it (§12):

1. **Drain the host command queue:** consume all commands posted since the last
   render, in order. Start/stop/key-off effects apply before any dispatch this
   frame.
2. **Dispatch, per track, ascending track index:** run the §3.1 accumulator
   loop; each consumed tick counts down `wait_ticks` and, at zero, executes
   stream events (immediate events run back-to-back; the next timed event
   reloads `wait_ticks`). Key-offs scheduled by the gate rule fire on their
   tick inside this loop.
3. **Engines, ascending channel index:** sweep interpolators, then macro
   steppers (§13.3).
4. **Close the frame** (§6.2): its register writes and PCM commands.

Register writes are **appended to the frame as they are generated**, in
dispatch order, change-only against the 68k's shadow — so the frame's per-port
write sequence is byte-identical to the sequence `drv-player.js` emits. Full-
frame coalescing (emitting each register once, at its final value) would save
~1% of writes and cost the zero-tolerance raw-equality gate, which is this
project's strongest verification asset.

The frame buckets writes into three runs (PSG, YM port 0, YM port 1), so
cross-bucket ordering within a frame is not preserved. This is safe by
construction: the two YM ports address disjoint channels, the PSG is a different
chip, and everything whose ordering carries meaning is port-local — `$28` key
edges, the `$22`/`$27`/`$2A`/`$2B` globals, and the `$A4`→`$A0` F-number pair
whose shared latch §8 describes.

**The write cap and spill.** A frame carries at most `SLOT_MAX_WRITES` = 95
register writes (PSG + both YM ports). When a frame generates more, the excess
stays **in order** in the sequencer's write queue and leads the next frame.
Writes are never dropped and never reordered, so the chip state converges; a
key-on in a write-dense frame can land a frame late. The reference implements
the same cap and spill (`slot-builder.js`) so the §12 gate stays at zero
tolerance.

**The 68000 never writes the YM2612.** Its writes reach the chip as pairs the
engine executes (§5.1, §6.1); PSG bytes are written by the host directly
(§6.6).

### 4.1 Priming at load

`MMLisp_loadScore` primes the score (`mml_prime_tracks`, host command `0x08`):
each idle track is started, its leading setup runs as the armed frame would
run it (§4.2), and the track is stopped before it sounds. The chip's neutral
patch and every track's voices and levels are queued at once and leave over
the next frames; the real start later is an ordinary start whose change-only
writes find the registers already set, so the first notes do not wait behind a
few hundred setup writes. Skipped: channels a running track owns, FM3-op, PCM
and CSM tracks. `MMLisp_isSettled()` reports when the load has gone out.

### 4.2 The armed frame (starting a track does not sound in its own frame)

A track's clock starts on the frame it was set up in, so a host that staggers
`MMLisp_startTrack` across frames leaves its tracks **permanently out of phase**
by that many frames.

So track status carries **armed**: the state a track is in for the frame its
start was drained in. Armed tracks do not accumulate; they are promoted at the
top of the next frame and all begin dispatching together. Frame-exact and
tempo-independent.

**The armed frame also runs the score's head.** Dispatch returns early while
the track is armed, at the first opcode that sounds or consumes time
(`$10..$13`, and `PCM_NOTE_ON`): the leading VOICE_SET / PARAM_SET / macro binds run in the armed
frame, the notes wait for the next one. The head of a score generates far more
writes than the per-frame cap (§4), so it spills across several frames either
way; arming keeps the voice applies ahead of the notes, so no note sounds under
a half-applied patch.

PCM tracks are armed like every other track, and the converter sends a frame's
PCM commands ahead of its register writes (§6.6), so a PCM hit and an FM hit
written on the same beat sound together (within ~1.5 ms in the score gate,
`tests/m3-pcm-sync.mmlisp`).

`drv-player.js` implements this (`armed`), and `ir-player.captureRegisterLog`
mirrors it (`_drvSetupShift`) so the A/B gate compares like with like: the
timeline starts a frame late and each track's leading events are pulled back
onto the preamble frame — a quarter-frame in, so they land after
`_initDefaultVoices` rather than being overwritten by the neutral patch. Capture
only; live playback has no setup frame to hide. What that cannot reproduce is
*when the level model recomposes*: the sequencer composes carrier TL once, in
the armed frame, with the vel the head set, while ir-player writes the voiced TL
and recomposes at the note. Six A/B scores carry 4–12 mismatches of that shape
(all TL, all at the track's first frame), frozen in the baseline.

### 4.3 Sequencer state (68000)

Ordinary C structs; what follows is the model, not a memory map. Constant
tables (F-number, PSG period, level ladders, carrier masks, operator offsets,
the sin curve unit — §7, §8) are ROM data: `tools/gen-c-tables.mjs` generates
`drv/68k/tables.c` from the same `live/src/ir-utils.js` functions
`drv-player.js` builds its tables from, so the two cannot disagree (§12.6).

**Channel state**, one per channel 0–9 (fm1–fm6, sqr1–sqr3, noise; mmb.md §6.1).
fm3 operator sub-tracks (ids 16–18) keep their per-op pitch inside fm3's block;
PCM voices have their own state (§14).

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

**Track control block**, one per active track; `MML_MAX_TRACKS` = 16.

| Field | Notes |
| ----- | ----- |
| status | idle / playing / armed / held / fading / suspended |
| track id, channel id | |
| flags | hasLoop / isCsm / isFm3Op |
| stream pointer, stream base | 68k ROM pointers. JUMP/CALL destinations are relative to the base |
| score pointer | the MMB this track belongs to (§2.3) |
| tick accumulator, tempo increment | 8.8 (§3.1) |
| wait_ticks | until the next timed dispatch |
| control stack | 4 × {ptr, count}; LOOP entries carry the remaining count, CALL entries are tagged |
| fade counter | |
| last MARKER id | for `(trig N)` sync; not yet surfaced to the host (§11) |

## 5. The Z80 Engine

The engine is generated, not hand-written: `drv/engine/gen-stream.mjs`
generates it and `drv/tools/build-engine.mjs` assembles one image per PCM voice
count. `drv/sgdk/mmlispdrv_bin.h` carries the three images and every address
below as an ABI constant; `live/src/engine-images.js` carries the same
descriptors for the exporter and the browser. The images share the RAM map, the
state block and the op layout; they differ only in voice count, rate, lap and
expander steps.

| image | PCM voices | DAC period (Z80 cycles) | rate | lap (samples) | expander steps a lap | IDLE pairs after a generation |
| --- | --- | --- | --- | --- | --- | --- |
| `pcm1` | 1 | 249 | 14,375.68 Hz | 112 | 8 | 1 |
| `pcm2` | 2 | 354 | 10,111.71 Hz | 80 | 8 | 1 |
| `pcm3` | 3 | 538 | 6,653.43 Hz | 48 | 8 | 5 |

A score without PCM plays on `pcm1`, which is also its FM/PSG writer.

### 5.1 The clock — an unrolled lap of constant-time slots

- **No interrupt, no timer.** Interrupts are disabled from boot. The engine is
  an unrolled lap of slots; each slot is exactly the DAC period and writes one
  DAC byte.
- **The slot boundary is the `$2A` write.** Every slot starts with its DAC
  write, so an interval equals the slot length by construction; everything
  else a slot does — the mix, the voices' block edges, the pair expander — is
  placed inside the slot by the generator and padded to a constant length on
  every path (branches with arms of equal length, not masks). The slot that
  binds each image's rate is filled to 100% of its length.
- **Bus stops are not repaid.** While the 68000 holds the bus the Z80 executes
  nothing and the DAC holds its byte; the lap then carries on at its own rate.
  The DAC runs slow by the time the bus was held.
- **YM writes.** The pair expander (§6.1) runs at fixed slots of the lap. The
  generator's analyzer checks the whole schedule against the YM2612's
  per-register settling times — including the BUSY each slot's own DAC write
  raises — so the engine polls nothing.

### 5.2 RAM map

The same for the three images.

| Region | Address | Contents |
| ------ | ------- | -------- |
| code | `$0000–$10FF` | boot, the lap, the mix, the expander |
| clamp | `$1100–$12FF` | the saturating add of two voices' terms, 512 B |
| rung pages | `$1300–$1AFF` | 8 pages: page 0 silence, page 7 − r the rung `s >> r` (§5.3) |
| — | `$1B00–$1BFF` | unused |
| sample ring | `$1C00–$1CFF` | finished samples, 18 ahead of the DAC |
| pair page | `$1D00–$1DFF` | 128 `{op, val}` pairs (`MMLISPDRV_FIFO`, §6.1) |
| — | `$1E00–$1EFF` | unused |
| globals | `$1F00–$1F7F` | the PCM state block at `$1F30` (`MMLISPDRV_STATE`, §6.1), the pair index at `$1F6D` (`FIFO_LO`), the ready mark at `$1F6E` (`0xD2`) |
| stack | `$1F80–$1FFF` | |

An image is 6,912 bytes uploaded at `$0000`: the code, the clamp and the rung
pages. `MMLISPDRV_PROTO_VER` (12) names the layout.

### 5.3 The PCM voices

- **A voice is a pointer, an END and a WRAP.** The pointer walks the sample
  bank's window one byte a sample. At every block edge, if the pointer has
  reached END it goes to WRAP. A shot's WRAP is the silence page (`$FF00`), so
  it parks and stays parked; a loop's END is its loop end and its WRAP its loop
  start; a release moves END to the sample's end and WRAP to silence, so the
  tail plays out and parks. A loop point moved during a note is the same move.
- **Levels are table reads.** A voice's byte goes through its rung page — the
  master is already folded in by the host — and comes out biased; a second and
  a third voice are summed through the clamp table, saturating in voice order.
  Every path is constant time.
- **16-sample blocks.** Each voice's block starts at its own phase (0; 0 and 8;
  0, 5 and 11) and carries six constant-time pieces: two generation checks
  (branch-free: a moved START generation marks a start, a moved RETARGET
  generation marks a retarget), APPLY (END and WRAP := the staged ones), COMPARE
  (pointer ≥ END), WRAP (the rung page for the next block; the pointer to WRAP
  if COMPARE said so) and, before the block's first mix, START (the pointer :=
  the staged source). Generations rather than flags, so no pair can land
  between a set and a clear.
- **The END contract.** COMPARE sees the pointer after the block's fifteenth
  mix, so END is the last byte to play, plus one, less 16: the voice wraps at
  the last edge before it would read past. Blobs are whole blocks (§14.2), so a
  shot plays every byte and a loop's rounding (§14) is exact.
- **The image boots with every voice parked at rung 0**, silent until the host
  starts one.

### 5.4 Sample banking

Samples live in one 32 KB ROM bank, read through the Z80's `$8000–$FFFF`
window: `song.smp`, 32 KB aligned, which the exporter writes next to the MMB
(mmb.md §10). `MMLisp_setSampleBank` sets the bank register (nine writes in one
grab) and hands the directory to the sequencer. The top page (`$7F00–$7FFF` of
the bank) is the silence a parked voice reads; the exporter refuses a bank
whose samples reach it. MMB data never goes through the window — the 68000
reads it directly.

## 6. The Interface (68000 → Z80)

The sequencer renders frames (§4); the host converts each frame into pairs and
PSG bytes (§6.6); the engine executes the pairs (§6.1).

### 6.1 Pairs

A 128-pair page at `$1D00`. The engine reads one pair at each of its expander
slots, writes IDLE over each pair it consumed, and publishes its next position
(`FIFO_LO`, a byte offset into the page).

| op | effect |
| --- | --- |
| `$00`..`$1F` | STORE: `(PCM_STATE + op) := val` — `$00` is a bucket (IDLE) |
| `$20` | PORT: the YM port the RAW pairs after it go to |
| `$22`..`$B6` | RAW: a YM register write on the current port |

The state block, nine ops a voice (v = 0..2):

| op | name | meaning |
| --- | --- | --- |
| `$01 + 9v` | LEVEL | the voice's rung page (`LUT_PAGE` + 0 silence .. + 7 unity), the master folded in |
| `$02/$03 + 9v` | SRC | staged start: the blob's window address |
| `$04/$05 + 9v` | END | staged END (§5.3) |
| `$06/$07 + 9v` | WRAP | staged WRAP |
| `$08 + 9v` | START | a new value: source, END and WRAP := the staged ones at the voice's next edges |
| `$09 + 9v` | RETARGET | a new value: END and WRAP := the staged ones; the pointer keeps playing |

A generation is detected a few expander steps before its staged bytes are
read, so a staged store for the same voice consumed in between would be
applied by the wrong generation. The host therefore follows a START or
RETARGET pair with the image's `idleAfterGen` IDLE pairs (§5) before any
staged store for that voice; the count is computed from the image's own slots.

**The frequency latch is chip-wide.** The YM2612 holds one `$A4`-group and one
`$AC`-group upper-byte latch for both ports, so a port-1 upper can clobber a
port-0 upper. The producer therefore writes a pitch pair (`$A4..$A6` then
`$A0..$A2`, or the `$AC`/`$A8` pair) whole within one grab.

### 6.2 The frame format (the sequencer's output)

The sequencer closes each frame as a **slot**: its register writes and its PCM
commands. The SGDK host reads the frame in place (`mml_render_frame_view`,
`MMLFrameView`); the byte encoding below is what the C and the JS reference
produce for the host gate (`c-gate`, §12.2), and what `mmlpairs.c`'s JS twin
consumes.

```
[u8 n_writes]                         ; frame total
[u8 n_pcm] [pcm command × n_pcm]      ; §6.3, variable length
{ [u8 n_psg] [val × n_psg]            ; SN76489
  [u8 n_fm0] [{reg,val} × n_fm0]      ; YM2612 port 0
  [u8 n_fm1] [{reg,val} × n_fm1] }    ; YM2612 port 1
  × SLOT_SUBS                         ; = 1
```

Length-prefixed runs keep the consumer free of per-write dispatch. Per port,
the frame's writes are in generation order (§4).

### 6.3 PCM commands

Opcode-first, every address resolved by the sequencer (§14).

| Op | Name | Payload |
| -- | ---- | ------- |
| 0x01 | `PCM_START` | voice u8, shift u8, src u16, end u16, wrap u16 — 8 B |
| 0x03 | `PCM_VOL` | voice u8, shift u8 |
| 0x04 | `PCM_RETARGET` | voice u8, end u16, wrap u16 — a release, or a loop point moved |
| 0x05 | `PCM_MASTER` | shift u8 — sent when the master's shift moves, not when `master` does |

`shift` is the voice's attenuation 0–4 on the 6 dB grid; **8 means mute**.
`src`, `end` and `wrap` are window addresses (§5.3).

### 6.4 Val slots

16 × i16 in 68k RAM, initialized from the score's VAL_TABLE at track start and
thereafter host-written (`MMLisp_setVal`, read back with `MMLisp_getVal`). Slot
index = VAL_TABLE index; slot 0xFF in stream operands is the built-in `$time`
source (elapsed 60 Hz frames, low 16 bits), never stored in the array. The host
does all arithmetic; the sequencer only stores and applies (docs/language.md
§8).

### 6.5 Host API and live control

`drv/sgdk/mmlispdrv.h`. Track and channel ids are the MMB's.

| Call | Semantics |
| ---- | --------- |
| `MMLisp_init()` | upload the engine image, boot it, wait up to ~1 s for its ready mark; `MMLisp_isReady()` says whether it came up |
| `MMLisp_setSampleBank(smp)` | publish the 32 KB sample bank (§5.4); PCM scores only |
| `MMLisp_loadScore(mmb)` | load a score (resets the sequencer; one score at a time) and prime it (§4.1); `MMLisp_isSettled()` says when the load has gone out |
| `MMLisp_attachInterrupts()` | install the pump (§6.6) as the VBlank callback; a game with its own calls `MMLisp_pump()` once a frame instead. The horizontal interrupt is not touched |
| `MMLisp_frame()` | once per frame in the main loop, after the control calls: render ahead (§3.1); takes no bus |
| `MMLisp_startTrack(track)` | initialize the track (stream pointer, accumulator 0, the stream's first TEMPO_SET), apply the channel-ownership rule (§2.2), reset the channel's level state (vel 15, vol 31, master 31, gate 8), and initialize declared val slots not yet host-written (mmb.md §8). Restarting an active track restarts it from the top. The track enters **armed** (§4.2) |
| `MMLisp_stopTrack(track)` | key-off (the release tail runs out naturally), free the channel, idle the track. On an `fm3-csm` track this clears the CSM bit in `$27` (§9) |
| `MMLisp_trackCount()` / `MMLisp_trackId(i)` | enumerate the loaded score's tracks — start them all by this list, not by a count of your own |
| `MMLisp_keyOff(channel)` | key-off one channel without stopping its track: releases a `len=0` hold (the dispatcher resumes) or truncates a sounding note |
| `MMLisp_setParam(channel, target, value)` | one-shot absolute write of `target` (opcodes.md §7), as if a PARAM_SET arrived in the stream |
| `MMLisp_fadeTrack(track, frames)` | step `master` down to 0 over `frames`, then stop |
| `MMLisp_setVal(slot, value)` / `MMLisp_getVal(slot)` | val slots (§6.4) |
| `MMLisp_needsSampleBank()` / `MMLisp_trackActive(track)` / `MMLisp_renderedFrames()` / `MMLisp_readStats(&stats)` | status; `MMLispStats` is the host's own counters and takes no bus grab (`drv/sgdk/README.md`) |

Every control call takes effect on the next frame rendered (§3.4).

### 6.6 The host: converter, pumps and timing

- **The converter** (`drv/68k/mmlpairs.c`) turns a frame into pairs: the PCM
  commands first, as state stores — the voice's LEVEL page with the master
  folded in, only the staged bytes that changed (a repeated hit is one pair),
  then the generation, and `idleAfterGen` IDLE pairs before the next staged
  store for that voice (§6.1) — then the FM writes, with a PORT pair where the
  port changes and each pitch pair kept whole. PSG bytes go to a queue the
  pumps write to `$C00011` one grab period late, so they land with the FM they
  were cued with. A command for a voice the booted image does not have is a
  fault (`MMLispStats.faults`).
- **The image** is booted by `MMLisp_loadScore` from the MMB header's PCM voice
  count (`MMLisp_init` boots `pcm1`); booting another resets the Z80 and
  rewrites the bank register.
- **One grab a frame, from the vertical interrupt.** The horizontal interrupt
  is never touched — it stays the game's. A grab reads the engine's index, then
  writes **sixteen pairs** (IDLE-padded) at `H = index read last grab +
  MMLP_AHEAD_ONE` (48) with two `movem.l` and eight `movep.l` — about 2,400
  master clocks (~45 µs) of bus stop, measured on BlastEm. It never writes
  behind pairs not yet read and never across the page end. If the fresh index
  shows the engine already at or past `H`, the grab writes nothing and the
  pairs go back to the queue (a late grab; `MMLispStats.late`). 960 pairs a
  second — the same wire two grabs of eight carried, in half the stops.
- **Release on time.** The converter remembers where each queued frame ends; a
  grab sends only frames whose time has come, so the tempo follows the video
  clock rather than the main loop.
- **The stop is not repaid.** The DAC runs slow by the time the bus was held.
  On the gate's scores that is 0.15–0.27% of the rate — 2.4 to 4.7 cents flat,
  the driver's own grab plus SGDK's DMA-flush halt.

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

`vel` above is really **two** per-channel bytes, on FM, PSG and PCM alike:

- **`vel_base`** — the score's sticky velocity. Written *only* by a
  `PARAM_SET VEL` out of the event stream.
- **`vel`** — the live one that composes into TL / att / PCM shift. A `:vel`
  macro writes this every frame; it is the channel's envelope authority while
  it runs (§13.3).

**Every note-on copies base → live** before composing the note's level. The
MMB carries velocity as change-only sticky track state (`export-mmb.js` emits
`PARAM_SET VEL` only when the score's velocity *changes*), so nothing in the
stream re-asserts it after a macro has overwritten the live value; without the
copy, a macro's last sample would stay the channel's velocity.

- A channel that currently has a **VEL macro bound is skipped**: the note-on
  retrigger re-instantiates the bind and its attack sample lands in the same
  frame (§4 step 3), so copying the base would only emit a register write that
  is overwritten before it can be heard.
- `NOTE_ON_EX` bit0 carries a per-note velocity. It replaces the live value for
  that note **without** becoming the base, so it neither survives the note nor
  is lost to the copy.

Gate: `m3-macro-vel-clear` (FM + PSG accent-then-clear at a loop head, plus a
never-cleared macro that must not gain a write). `m3-macro-vel` pins the
macro-owns-the-envelope side.

## 8. Pitch Tables

Both tables are generated **from the same code as `ir-utils.js`**
(`midiToFnumBlock`, `PSG_MASTER_CLOCK`) and emitted as C arrays the 68k links
(§12.6). NTSC clocks: YM 7,670,454 Hz, PSG 3,579,545 Hz.

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
- Fractional pitch (cents — glide, vibrato, NOTE_PITCH sweeps) is applied as a
  linear interpolation between adjacent LUT entries (F-number is near-linear
  over one semitone; error < 1 cent).
- **The F-number write is unconditional, not change-only.** The high byte
  (`$A4`–`$A6`) latches into a register the YM2612 shares across channels (and
  across ports, §6.1); the low-byte write (`$A0`–`$A2`) commits `{latch, low}`
  to *its* channel. If the high byte were suppressed because this channel's
  block was unchanged, another channel's intervening high-byte write would have
  clobbered the shared latch, and the low-byte commit would pick up the wrong
  octave. So the pitch writers (`drv-player` `_writeFmPitch` /
  `_writeFm3OpPitch` and their C counterparts) emit the `$A4`/`$A0` pair every
  note through the always-write path, keeping the shadow current but never
  suppressing. This is the one place the sequencer deliberately bypasses
  change-only suppression besides the `$28` key edge.

## 9. CSM Rule

- The compiler emits `CSM_ON` once at the start and `CSM_OFF` only at
  **end-of-stream** of an fm3-csm track; mid-track rests do **not** toggle
  the CSM bit (Timer A just keeps retriggering a released envelope).
- The sequencer's invariant: `MMLisp_stopTrack` (and END_OF_TRACK, and the stop
  side of `MMLisp_fadeTrack`) on the track flagged `isCsm` clears the CSM bits
  in reg `$27` — the flag exists in the track table precisely so stopping never
  leaves the chip in CSM mode.

## 10. Voice Representation

A full FM voice is a **VOICE_TABLE entry + `VOICE_SET` (0x14)**; the 29-byte
entry layout is in mmb.md §11 (`$30,$40,$50,$60,$70,$80,$90` × 4 ops + `$B0`).
The IR keeps per-parameter PARAM_SETs; the exporter's coalescing pass
(`live/src/mmb-voices.js`) folds a same-tick group covering the full voice
parameter set (28 operator params + ALG/FB) into a deduplicated VOICE_TABLE
entry + `VOICE_SET`; partial groups stay PARAM_SETs. A voice change is 2 stream
bytes instead of ~90.

The `VOICE_SET` handler block-copies the entry in drv-player's exact write
order (op outer, register inner, then `$B0`), change-only against the shadow
(an unwritten register reads as 0, so an SSG-omitting voice never writes `$90`),
seeds the four voiced-TL bytes, and updates the channel's algorithm so the
vel/vol carrier-TL recompose picks the right carrier mask. The comparison is
against the **structured** shadow, because a PARAM_SET burst only wrote the
registers it touched (§12.2). Gate: `m3-voice` (both ports, mid-song switch).
The ab-compare gate's `normalize` collapses same-frame YM writes to the
per-frame final value, which makes the A/B baseline coalescing-invariant.

### 10.1 Loop-invariant VOICE_SET (encode-time hoist)

`planVoiceHoists` (`live/src/export-mmb.js`) emits a loop head's VOICE_SET
**before** the loop marker, so pass 1 applies it and the backward JUMP lands
past it. Moving it across a MARKER cannot reorder any chip write (MARKER writes
no register), so the register trace is unchanged — asserted by the gate, and by
an A/B of the same song encoded with `opts.voiceHoist` on and off.

The hoist is skipped when the loop body can leave the voiced registers different
from what that VOICE_SET set: another voice change, a PARAM_SET/ADD/MUL/SWEEP on
an op param / ALG / FB, or a macro on one of those (where it stops is not a
compile-time fact). Those songs keep the head VOICE_SET inside the loop, which
restores the voice each iteration. `drv/tests/m3-voice-loop.mmlisp` pins all
three outcomes.

## 11. Current Limits

- **PCM:** one to three voices, one engine image per count; one 32 KB sample
  bank a song; no runtime pitch. A loop point lands on the engine's 16-byte
  block, so the shortest loop is one block (1.1 ms at `pcm1`, 2.4 ms at
  `pcm3`).
- **Wire:** 960 pairs a second. The song's opening
  setup is primed at load (§4.1), but a mid-song voice change on several
  channels (~30 writes each) takes a few frames to reach the chip.
- **One score loaded at a time** (§2.3).
- **SE** runs in the reference player only; not in the C sequencer or the SGDK
  host (§2.5).
- **`(trig N)` markers** are tracked by the sequencer but not surfaced to the
  host.
- **PAL** is not supported (§3.3).
- **Not yet run on hardware.** The images are graded in the JS machine
  (§12.4) and on BlastEm (§12.7); the slot that binds each rate has no margin,
  and the one wait the model charges from measurement — a read through the 68k
  window — was measured on BlastEm. The host writes Z80 RAM with `movep.l`
  (byte cycles as the 68000 defines them; correct in BlastEm).
- **Bus stops** — the pumps' and SGDK's own (joypad reads, VBlank DMA) — are
  not repaid (§1.2).

## 12. Verification Strategy

There is no automated test suite for audio; verification is comparative, and
every gate runs on the host. `cd drv && npm run verify:all` runs §12.2–§12.5.

### 12.1 `drv-player.js` — the executable spec

Executes MMB v0.3 with the §4 loop order and **integer-only math** (8.8
accumulators, the §7/§8 integer tables — no floats), in the live environment as
an alternate backend, and emits real frames through the real cap/spill queue
(§4) so it specifies the interface too, not just the music.

### 12.2 68k C ≡ `drv-player.js` — the hard gate

The C sequencer compiles for the host as well as for m68k (its core is plain C
with no SGDK dependency), so the gate is: run both over the same MMB, dump the
per-frame slot stream, diff at **zero tolerance** — same writes, same values,
same ports, same frames, same order. `npm run c-gate` (46 scores; every score
without a host schedule runs a second time primed, §4.1).

Two things the C needs that the reference gets for free:

- **A shadow-validity plane.** `drv-player` keys its shadow with a Map, so an
  unwritten register never compares equal to anything; a zero-initialised C
  array would suppress the neutral patch's many writes of 0.
- **The drain must not render.** Once the song is over the harness closes slots
  until the spill queue is empty; those slots are *encoded only*. Running
  another frame there would invent traffic the reference never produces.

A PCM score's sample bank is a separate ROM bank rather than an MMB section, so
the gate hands it to the C as a separate file (`--samples`).

### 12.3 The converter — `mmlpairs.c` ≡ its JS twin

`npm run pairs-gate`: the C converter and `tools/pairs-model.mjs` turn the
same slot streams into pairs and PSG bytes, byte for byte, on 46 scores — each
with its own image's configuration — with late grabs injected, with render
leads 0, 1 and 2 (which must give the same wire), with one and two grabs a
frame, and through the frame-view path the SGDK host uses.

### 12.4 The engine

The images run in `tools/machine.mjs` — a Z80 emulator plus the Mega Drive
slice it talks to: the YM2612's ports with a timer model written from the chip,
the bank register, the PSG port, and the 68000's bus grab as injected stopped
time. The reference for every DAC byte is `live/src/pcm-model.js`, the engine
as a state machine, driven by the pairs the expander actually consumed.

- `npm run engine:gate` — each image with a host writing pairs once a frame:
  every interval, every DAC byte, what each START and RETARGET applied against
  what the host meant, the settling table, and every pair consumed once, in
  order, at the image's own slots. Cases: shots, loops and releases,
  retargets, level walks, clipping, a roll, a start and a retarget as close as
  the IDLE window allows. `npm run engine:gate:negatives` requires an uncosted
  instruction, a wrapping add and a missing IDLE window to fail it.
- `npm run engine:score` — real scores through the image each names, driven by
  the host model: every FM write per port in order, every PSG byte, every DAC
  byte, the clock, and PCM-vs-FM sync.

### 12.5 `ir-player` A/B — characterization

**Register-write log A/B** (`ab-compare.js`; `window.__abCompare()` in
the live app). The reference driver's frame-stamped register log is
diffed against `ir-player.js` output as per-register *state runs* (raw
write streams are incomparable: the IR player runs a continuous clock
and repeats values; the sequencer is change-only and frame-quantized).
Acceptance bands:

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

`examples/source/ab-core.mmlisp` (exactly the M1 opcode set) diffs clean.
Songs using M2/M3 features (macros, sweeps, PCM, CSM) diverge by construction —
the exporter pre-samples curves that `ir-player` evaluates in continuous time —
so `npm run verify:ab` (`drv/tools/ab-gate.mjs`) is a *characterization* gate:
each corpus score's mismatch signature (count + digest) is frozen in
`drv/tests/ab-baseline.json`, and the gate fails when a signature **changes**.
After an intended change, review the printed mismatches and re-freeze with
`node tools/ab-gate.mjs --update`.

**Known open divergence.** A PSG soft-envelope on a gate-cut note
(`:gate-`/`:gate*`) diverges at the note boundary: the IR player emits a
1-frame hard key-off (att 15) between notes, so they separate; the driver lets
the macro release value hold, so they connect. The gate key-off also lands on a
slightly different frame in each. Frozen in the A/B baseline, so it is watched.

**PCM is not in that gate — it has its own, and it is exact.** The browser's
IR preview does not approximate the driver's PCM: the worklet runs the
sequencer's voice model (`live/src/pcm-voices.js`, the same class
`drv-player.js` uses) and the engine model (`live/src/pcm-model.js`
`PcmLiveEngine`) on the bank an export ships, stepped at the image's rate —
8-bit, with the driver's 6 dB rungs, its 16-byte loop rounding and its loop-point
moves. `ir-player.js` only forwards the score's PCM events (note, release,
level, master, loop point; a loop-point sweep stepped with the driver's own
integer arithmetic, after the frame's events as the driver's step 3 does).
`npm run pcm-ab` (`drv/tools/pcm-ab-gate.mjs`, in `verify:all`) runs those
events through `PcmIrVoices` — the class the worklet runs — and requires the
**same PCM command bytes, in the same order, each within a frame** of
`drv-player`'s own slot stream: 12 scores, all identical. The editor's
per-track PCM faders are a UI gain on a voice's samples before its rung, which
the driver does not have.

**`npm run level-diff <song.mmlisp>`** (`drv/tools/level-diff.mjs`) answers the
question the gate cannot: *where is the driver louder than the reference, and
by how much*. It replays both logs into a register file, samples the level
state per frame (carrier TL under the algorithm in force, PSG attenuation),
and prints only the spans where the **driver is the louder of the two**, in dB.
It tiles ir-player's loop (the capture is one pass; the driver loops) and
ignores spans shorter than `--hold` (default 3 frames), so the ±1 frame
note-timing skew does not read as a level difference.

### 12.6 Tables

The reference computes every constant table (F-number, PSG period, level
offsets, curve units) from `live/src/ir-utils.js`, and
`tools/gen-c-tables.mjs` emits the same tables as C for the 68k
(`drv/68k/tables.c`, and the images' rate stamps in `drv/68k/mml_rate.h`).
Neither side re-derives a table. `npm run mirrors` checks that `mml_rate.h`, the
engine header and `live/src/engine-images.js` describe the same images, and that
the two generated files are what the images build to now.

### 12.7 On the machine

`npm run sgdk:gate -- <score>` builds a scratch SGDK project with
`install-sgdk`, runs it in a patched headless BlastEm (`drv/blastem/`) that logs
every DAC byte, every YM/PSG access by CPU and every bus grab, and grades the
log: every FM write per port and every PSG byte in the score's order, **every
DAC byte against `live/src/pcm-model.js` driven by the engine's own state-block
writes**, the bus stops, PCM-vs-FM sync, and whether the FM's lag behind the
reference's frames climbs (a lost frame). Grading starts at the LAST ready mark
— `MMLisp_init` boots `pcm1` and `MMLisp_loadScore` boots the score's image
over it, so an earlier engine's samples are not this one's. Measured, six
scores across the three images:

| | `m2-pcm` | `m4-pcm-2v-master` | `m4-pcm-3v` | `m4-pcm-loop-curve` | `sin008` | `demo1` |
| --- | --- | --- | --- | --- | --- | --- |
| image | pcm1 | pcm2 | pcm3 | pcm1 | pcm1 | pcm1 |
| rate between stops | 14375.68 | 10111.71 | 6653.43 | 14375.68 | 14375.68 | 14375.68 |
| lost to bus stops | −2.4 ¢ | −2.7 ¢ | −2.7 ¢ | −3.6 ¢ | −3.1 ¢ | −4.7 ¢ |
| longest runtime stop | 2,402 | 2,378 | 2,390 | 2,402 | 2,449 | 2,453 |
| DAC vs the model | all match | all match | all match | all match | all match | all match |

The lag floor moved 0.0–0.1 ms over an 8-second run: no frame is lost at one
grab a frame. `npm run sgdk:profile` times the driver's functions in the same
build. Needs SGDK, the m68k toolchain and the probe BlastEm
(`drv/blastem/setup.sh`).

`npm run light-study` places the generator at each voice count and prints the
highest rate a slot's work ceiling allows (`--target 0.95` for a margin) —
where the images' periods come from.

## 13. Macro Engine

Macros (docs/language.md §10) are per-target parameter automation attached to
notes. The rich authoring vocabulary — step vectors, curves, multi-stage,
`:hold` sustain loops, `:off` release, `_` holds, the `:step` clock, symbolic
coercion — is **lowered at compile time** to one uniform runtime shape (mmb.md
§15): a per-`:step` value array in three regions (attack / sustain-loop /
release). Curves and stages are pre-sampled; the driver never evaluates a curve
or easing at macro time. This keeps the engine small and reproduces `ir-player`
`_scheduleMacro` exactly, so the JS reference and the C share it under the §12
gate.

**Coverage.** Implemented in `drv-player.js` and the C sequencer: the `steps`,
`curve`, and `stages` macro forms on i8 targets that ride the PARAM_SET apply
path — the common envelope/LFO case (VOL/VEL/FM_TL/…). Curve and stage macros
are pre-sampled at the `:step` clock in the exporter (a one-shot curve fills the
attack region and holds its last value; a looping curve/stage fills the sustain
region; `(wait key-off)` marks the release boundary).

- **NOTE_SEMI** (macro-only target): a semitone offset written to the pitch
  register at note+semi each `:step` (no retrigger, no change to the sticky
  `:pitch` state) — the classic chiptune arpeggio, on FM and PSG.
- **NOTE_PITCH** (i16, pitch envelopes / vibrato shapes): the descriptor carries
  flags bit0 (i16), the value blob is 2 bytes per `:step` (cents, hold sentinel
  `0x8000`), and the stepper reads it wide and rides the PARAM_SET apply path.
  Gated by `m3-macro-pitch` on FM and PSG.
- **Multiple macros per channel** run together (up to 3, keyed by target —
  e.g. a VOL envelope + a NOTE_PITCH vibrato + a NOTE_SEMI arpeggio): the active
  ids stay compact and insertion-ordered (matching drv-player's Map),
  `MACRO_SET` replaces same-target in place and appends a new target,
  `MACRO_CLEAR` removes one target (or all on `0xFF`), NOTE_ON instantiates
  every active into its running slot, and the stepper steps all three. Gated by
  `m3-macro-multi`.
- **KEYON** (macro-only target, retrigger; gated by `m3-macro-keyon`): a nonzero
  step re-attacks the note — it restarts the channel's non-keyon macro slots to
  their attack (so soft-envelope `:vol`/`:pitch` macros replay) and, on FM,
  re-keys the hardware EG (`$28` off→on; FM3-op op via its mask). PSG has no
  hardware EG, so the soft-envelope restart is the whole effect. The macro
  engine runs on channels 0–9, so PCM and FM3-op op2–4 have no `:keyon` (the
  exporter drops it there).
- Tick-unit `:step`/`:len` are resolved to a 60 Hz frame count at the note's
  tempo when the macro is snapshotted (compiler side, like the `Nf` glide/delay
  resolution), so both frame (`Nf`) and note-length macro clocks work.
- Dynamic (val-slot) `:from`/`:to`/`:rate`/`:len` are dropped with a warning.

The hard gate is C ≡ `drv-player` at zero tolerance; the `ir-player` A/B is
informational for macros.

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

In the frame loop (§4 step 3, after the sweep engines), each running macro:

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
vibrato/tremolo depth follows in real time, at the host-call latency (§3.4).

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
the level back up. So the engine keys off status bit0 (keyed), set at NOTE_ON
and cleared at channel-off — not bit1 (PSG audible). A level macro re-applies to
the output (FM carrier TL / PSG att) each step, sharing the PARAM_SET path, so
it updates the sticky `:vel`/`:vol`; a following note re-establishes its own
level on its NOTE_ON (or its own macro's first step), and the change-only shadow
absorbs the transient.

### 13.4 FM3 independent-OP mode

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

Keying is a shared 4-bit mask: each operator's key sets/clears its bit
(OP1 = `$10` … OP4 = `$80`) and re-emits `$28 = mask | 0x02`. A full gate is
used (the operator keys off at the next rest / end-of-track). The driver derives
the operator from the channel id (2→1, 16-18→2-4); F-numbers go through the
change-only shadow, key edges bypass it.

## 14. PCM

`pcm1`–`pcm3` are the language's PCM voices, played through the fm6 DAC.
Samples are declared with `def :sample` and exported as a sample bank beside
the MMB (mmb.md §10). A score's PCM voice count is the highest `pcmN` it uses;
it is written in the MMB header and picks the engine image (§5).

A `PCM_NOTE_ON` becomes a `PCM_START` in the frame (§6.3): the note's own
blob, END and WRAP. Whether it loops is the NOTE's (`:mode loop`, bit 7 of
the opcode's note byte), not the sample's: a shot plays to its end even on a
sample whose def loops. A looping note loops; its `PCM_NOTE_OFF` becomes a
`PCM_RETARGET` to the sample's end with WRAP at silence, so the tail plays
out.

**fm6.** A score's first PCM note sends `$2B = $80`, and nothing turns the DAC
off again: a score that plays PCM owns fm6 as the DAC from then on. A score
without PCM never writes it, and fm6 is FM.

**Loop points** start as the sample's `:loop-start` / `:loop-end` /
`:loop-len` (the whole sample when the def sets none), mapped to baked bytes by
the exporter, with the track's own loop writes laid over them, and rounded to
whole blocks by the sequencer (`pcm_loop_points`, twin of `live/src/pcm-model.js`
`pcmLoopPoints`):

```
le' = 16·round(le/16), within 16..len
ls' = le' − 16·max(1, round((le − ls)/16)), at least 0
END = src + le' − 16,  WRAP = src + ls'
```

so the first pass plays `[0, le')` and every later pass `[ls', le')`. On a
one-cycle loop the rounding is a detune.

**A loop point may be MOVED while the note sounds** — this is what the block
edge's RETARGET exists for beyond the release. `PARAM_SET` / `PARAM_SWEEP` on
`LOOP_START` (0x43), `LOOP_END` (0x44) or `LOOP_LEN` (0x45) carries a byte
offset into the playing blob (opcodes.md §7); the voice keeps its live `ls` /
`le` / `llen`, and a write recomputes END and WRAP through the same
`pcm_loop_points` and sends one `PCM_RETARGET`. `LOOP_LEN` holds the length
when `LOOP_START` moves; `LOOP_END` pins the end.

A write is also KEPT, like any track parameter: the voice remembers the last
start and the last bound (`o_ls`, `o_bound` and which of END/LEN it was), and
each loop note starts from the def's loop with them laid over it in the same
terms. So `:loop-start 100ms :loop-len 16 c` loops the note it precedes, and
the notes after it.

Two things this needs, both of which the sequencer does:

- **The sweep engine reaches the PCM voices.** Its banks are the ten M1
  channels plus the three voices (`sweep_bank`, `MML_SWEEP_BANKS` = 13, twin
  `_sweepBank`); before this a sweep on a `pcmN` channel was dropped.
- **A RETARGET goes out only when the rounded block moves.** A sweep is
  recomputed every frame and mostly lands inside the same 16 bytes; sending it
  regardless would spend six bytes of every slot on it, sixty times a second.
  The voice remembers the last END/WRAP it sent (`sent_end`/`sent_wrap`).

A released voice is a shot, so loop writes after a note-off do not move its
sound — they are kept for the next loop note.

**Per-channel volume (`:vel` + `:vol`).** `:vel` and `:vol` on a `pcmN` channel
ride the FM/PSG velocity/fader ladder (2 dB/step). The sequencer composes them
into one per-voice attenuation on the 6 dB grid:

```
n = (15 − vel) + (31 − vol)
shift = min(PCM_MAX_SHIFT, round(n / 3))    # PCM_MAX_SHIFT = 4
mute  = (vol == 0) || (master == 0)
        || (shift + master_shift >= PCM_TOTAL_MAX_SHIFT)    # = 7
```

so the same `:vel`/`:vol` mean the same loudness on a PCM voice as on FM/PSG.
`vel` never mutes — `vol 0` is a hard mute, and so are the two master
conditions (§14.1). The compose runs on the 68k once per `PARAM_SET VEL`/`VOL`
(and for every voice on a `MASTER` change, because master decides the mute) and
reaches the frame as `PCM_VOL`; `vel`/`vol` persist per voice.

### 14.1 `:master` is folded into each voice

`:master` is common to every voice, so it is not in the per-voice shift. It
reaches the frame as the voiceless `PCM_MASTER`:

```
master_shift = min(PCM_MASTER_MAX_SHIFT, round((31 − master) / 3))    # = 6
```

and the host folds it into each voice's rung page:
`page = LUT_PAGE + (mute ? 0 : 7 − (shift + master_shift))`, silence past −36 dB.
A master change re-sends the LEVEL of every voice whose page moves.

**A stepped DAC level is by design.** 6 dB rungs are the model; what the level
has to do is move when the fader moves and reach silence at `master 0`, not
subdivide finely on the way.

### 14.2 Pitch-baked samples

The engine does not resample and has no octave step. The exporter resamples
each sample at build time, once for every note it is played at, to the rate at
which that note advances one byte a sample at the image's DAC rate, and pads
the blob with silence to whole 16-byte blocks (mmb.md §10.1). The bank carries
the image's rate as its stamp, and a loader refuses a bank baked for another
image.

### 14.3 Where the layers disagree

- **The browser.** The live player's IR preview plays PCM through the driver's
  own voice model and engine (`live/src/pcm-voices.js`, `pcm-model.js`) on the
  bank an export ships, so rate, 8-bit output, levels and loop rounding match;
  `npm run pcm-ab` checks it sends the driver's commands. What differs is the
  timing: its events land on the audio clock, not on 60 Hz frames.
- **Unimplemented sample keys.** `:bit-depth`, `:volume`, `:compress` and
  `:reverb` are accepted with a warning (`W_SAMPLE_KEY_UNIMPLEMENTED`).
