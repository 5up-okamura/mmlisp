# MMLispDRV v0.2 Architecture

Status: **design frozen for review**. This document defines the Z80 sound
driver that consumes MMB v0.2 (`docs/mmb.md`, `docs/opcodes.md`). It gates
implementation: first a JS reference implementation (`drv-player.js`), then
the Z80 assembly — both against this spec (§12).

This document also absorbs the interactive-playback design vision that
previously lived in `docs/spec-v0.5.md` §4; **this is now its canonical
home** (§2).

## 1. Role and Constraints

MMLispDRV runs entirely on the Mega Drive Z80 (8KB RAM at 0x0000–0x1FFF),
reading song data in place from the banked 68k-ROM window (0x8000–0xFFFF)
and writing the YM2612 (0x4000–0x4003) and SN76489 (0x7F11) directly. The
68000 never touches the sound chips; it talks to the driver through a
mailbox in Z80 RAM (§6).

Design principles (working agreements applied to the driver):

- **Pointer walking only.** The MMB is decoded in place; no parsing pass,
  no unpacking, no allocation.
- **The driver stays dumb.** All computation that can happen at compile
  time does: BPM → tick increments, note names → MIDI numbers, Hz → Timer A
  periods, easing vocabulary → a 4-shape curve set. All *runtime*
  computation the score needs (health → volume, speed → pitch) happens on
  the 68000, which feeds results into value slots (§6.4).
- **Determinism.** Frame-by-frame register output is a pure function of
  (MMB bytes, mailbox command history). The JS reference and the asm must
  produce matching write logs (§12).

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
(`START_TRACK` / `STOP_TRACK` / `FADE_TRACK`, §6.3).

**Channel ownership rule:** when a newly started track claims a channel
already owned by a running track, the running track is released on that
channel — with its release tail if the voice defines one (key-off, envelope
runs out), otherwise immediately. The channel-state block records the
owning track id (§5.1) to arbitrate this.

**Exception — the FM3 shared channel.** Channel 2 is exempt from eviction:
in FM3 independent-OP mode the note-less `(fm3 …)` voice track and the
`fm3-1` operator track legitimately coexist on it (§13.4), so a second
track claiming channel 2 keeps both rather than releasing the first. The
first claimant owns the shared level state; later ones only key their
operator. (`fm3-2`–`fm3-4` live on ids 16-18, which carry no channel block
and never arbitrate.)

### 2.3 Layering and scene transitions

Multiple MMBs' tracks may be active at once (M1 limits this to tracks of
one MMB per bank window; see §5.3). The canonical transition:

```
68000:
  START_TRACK(sceneB.fm2)
  START_TRACK(sceneB.sqr2)
  FADE_TRACK(sceneA.fm1, 60)   ; 60 frames ≈ 1 s
  FADE_TRACK(sceneA.sqr1, 60)
```

### 2.4 `len=0` — indefinite hold

A NOTE_ON with duration byte 0x00 keys on and **suspends the track's
dispatcher** until the host sends `KEY_OFF` (on the channel) or
`STOP_TRACK`. Use cases: state-length sound effects (engine rumble,
charge-up), pad chords under a scene, PCM loops held open. Sweeps/macros
already running on the channel keep running while held.

## 3. Timing

### 3.1 Clock source and accumulators

The driver runs from the **60 Hz vblank interrupt** (Z80 INT, driven by the
VDP). Each frame, every active track advances by its tempo increment in an
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

On PAL (50 Hz vblank) the same increments play 60/50 = 1.2× slower.
Correction (scaling increments by 6/5 at load, or PAL-precomputed files via
the reserved PAL_TIMEBASE header flag, mmb.md §4) is **deferred**; M1 is
NTSC-timed.

## 4. Main Loop

Frame order is **fixed and normative** — the JS reference implements
exactly this order, and A/B verification (§12) depends on it:

1. **Drain mailbox** (§6.2): consume all pending commands (≤ 8), in ring
   order. START/STOP/KEY_OFF effects apply before any dispatch this frame.
2. **Per track, ascending track index:** run the §3.1 accumulator loop;
   each consumed tick counts down `wait_ticks` and, at zero, executes
   stream events (immediate events run back-to-back; the next timed event
   reloads `wait_ticks`). Key-offs scheduled by the gate rule fire on their
   tick inside this loop.
3. **(M2+) Engines, ascending channel index:** sweep interpolators, then
   (M3) macro steppers — each computes new values into the shadow state.
4. **Flush the write queue:** all register writes generated this frame go
   out now, in fixed order — YM channels fm1→fm6 (per channel: operator
   params, then channel params, then F-num/block, then key-on/off via $28),
   then globals ($22/$27), then PSG sqr1→sqr3→noise. Writes are
   change-only: a value equal to the shadow register is skipped (§5.4).

**YM BUSY policy:** every YM2612 access goes through one write routine that
polls the status byte (0x4000 bit 7, BUSY) until clear before writing the
address and again before the data byte. Batching all writes into step 4
bounds the per-frame chip-access time and keeps the write order
deterministic. PSG writes need no wait.

## 5. Z80 RAM Map (8KB, 0x0000–0x1FFF)

| Range           | Size   | Contents                                        |
| --------------- | ------ | ----------------------------------------------- |
| 0x0000–0x11FF   | 4608 B | driver code + constant tables (budget ≤ 4.5KB)  |
| 0x1200–0x147F   | 640 B  | channel state: 10 × 64 B (§5.1)                 |
| 0x1480–0x167F   | 512 B  | track control blocks: 16 × 32 B (§5.2)          |
| 0x1680–0x16BF   | 64 B   | mailbox — 68k-visible (§6.1)                    |
| 0x16C0–0x16DF   | 32 B   | val slots: 16 × i16 — 68k-readable (§6.4)       |
| 0x16E0–0x179F   | 192 B  | YM + PSG shadow registers (§5.4)                |
| 0x17A0–0x1DFF   | 1632 B | **reserved:** M2 PCM ring buffers               |
| 0x1E00–0x1F7F   | 384 B  | reserved headroom                               |
| 0x1F80–0x1FFF   | 128 B  | stack                                           |

> **Implementation note (M2/M3 build).** The image grew through the milestones,
> so the reference/asm build places **all** RAM data above the code at
> `DATA_BASE` (currently 0x18F0; code owns 0x0000–0x18EF, ~6.4 KB image, full
> 16-track capacity, ~14 B headroom). From there: mailbox 0x18F0, val slots
> 0x1930, driver globals 0x1950, channel state 0x19D8, TCB 0x1C58 (16 blocks),
> shadow 0x1E58, valid bitmap 0x1F88, stack top 0x2000. Space reworks got it
> under 8 KB: the shadow's valid plane is a **bit**-per-register bitmap (2×19 B,
> not 2×152 B); the **constant LUTs moved out of Z80 RAM into ROM** (a LUT_TABLE
> MMB section, mmb.md §16, ~726 B freed); and a **table-drive refactor** collapsed
> the ten near-identical FM op-param handlers into one descriptor table + routine
> (~169 B), which paid back the interim TCB trims and restored full 16-track
> capacity. The monolith is now full; the remaining M3 moves to a 68k-offload
> split (engines on the main 68000, the Z80 a thin register + PCM executor). The
> mailbox and val slots are the only 68k-published addresses; they move with
> `DATA_BASE`, so `drv/sgdk/mmlispdrv.c` uses the current values. See
> `drv/README.md`.
>
> **Code overlays.** Cold code (rarely invoked, not the per-frame loop) lives in
> a 32 KB-aligned **overlay ROM blob** (`mmlispdrv_ovl.bin`), not Z80 RAM. The
> resident loader (`load_overlay`) banks the window to the overlay ROM, `LDIR`s
> the requested overlay into a shared RAM buffer at `OVERLAY_SLOT`, banks back to
> the MMB, and calls it. `start_track` + MMB parsing (`ovl_setup`) and the
> mailbox command handlers (`ovl_cmd`) are the first two overlays; the resident
> holds only the hot dispatch/note/sweep/macro/PCM path. This keeps the 68k free
> (the Z80 stays autonomous) while freeing RAM. `MMLisp_init` publishes the
> overlay bank at `G_OVL_BANK` (mailbox +0x34) after the reset.

The constant tables (F-number, PSG period, level ladders, carrier masks,
operator offsets, the sin curve unit, PCM rate multipliers — §7, §8) are
**read-only and identical for every song**, so they live in ROM (the LUT_TABLE
section, mmb.md §16), read through the bank window. The driver derives a window
pointer per table at START_TRACK; they no longer consume Z80 work RAM. Both
the JS reference (`buildLuts`) and the asm use the same bytes (via
`live/src/lut-blob.js`), so §12 divergence stays structurally impossible.

### 5.1 Channel state block (64 B × 10 channels)

Channels 0–9 (fm1–fm6, sqr1–sqr3, noise; mmb.md §6.1). fm3 operator
sub-tracks (ids 16–18) store their per-op pitch inside fm3's block; PCM
voices (20–22) live in the M2 ring-buffer area. The 64-byte layout is
**reserved in full now** so M2/M3 never reshuffle:

| Offset    | Size | Field           | Stage |
| --------- | ---- | --------------- | ----- |
| 0x00      | 1    | status (bit0 keyed = note active; bit1 = PSG audible, att < 15; bits2–7 reserved) | M1 |
| 0x01      | 1    | note (MIDI)     | M1    |
| 0x02      | 2    | fnum / PSG period (current, incl. bend) | M1 |
| 0x04      | 1    | block           | M1    |
| 0x05      | 1    | vel state (0–15) | M1   |
| 0x06      | 1    | vol (0–31)      | M1    |
| 0x07      | 1    | master (0–31)   | M1    |
| 0x08      | 1    | gate state (0–8) | M1   |
| 0x09      | 1    | pan (i8 −1/0/1) | M1    |
| 0x0A      | 2    | key-off countdown (ticks; 0xFFFF = none/held) | M1 |
| 0x0C      | 2    | pitch offset (cents, i16) | M2 |
| 0x0E      | 1    | owner track id (0xFF = free) | M1 |
| 0x0F      | 1    | algorithm (carrier mask lookup) | M1 |
| 0x10–0x13 | 4    | voiced TL, op1–op4 (level-composition base) | M1 |
| 0x14–0x17 | 4    | FADE_TRACK Bresenham counters (N, V, err, cur; M2 mailbox) | M2 |
| 0x18–0x2F | 24   | sweep engine: 2 slots × 12 B (target, curve, flags, phase u16, from i16, to i16, len u16, step u16) | M2 |
| 0x30–0x3E | 15   | macro engine (§13): 3 active-macro ids (0x30–0x32) + 3 running slots × {descriptor idx, step clock, cursor, state} = 4 B (0x33–0x3E) | M3 |
| 0x3F      | 1    | FADE frames-left | M2 |

M1 uses offsets 0x00–0x13 (~24 B of the 64). (The implementation moved a few
M2 fields — FADE counters into 0x14–0x17/0x3E, the M2 shadow to a bitmap valid
plane — see `drv/README.md`; the 64-byte block is unchanged.)

### 5.2 Track control block (32 B × 16 tracks)

| Offset    | Size | Field                                            |
| --------- | ---- | ------------------------------------------------ |
| 0x00      | 1    | status (0 idle, 1 playing, 2 held, 3 fading)     |
| 0x01      | 1    | track_id (from MMB track table)                  |
| 0x02      | 1    | channel_id                                       |
| 0x03      | 1    | track flags (hasLoop/isCsm/isFm3Op)              |
| 0x04      | 2    | stream pointer (Z80 address in window)           |
| 0x06      | 2    | stream base (window address of EVENT_STREAM payload; JUMP/CALL dests are relative to this) |
| 0x08      | 2    | bank (9-bit index of the 32KB window)            |
| 0x0A      | 2    | tick accumulator (8.8)                           |
| 0x0C      | 2    | tempo increment (8.8)                            |
| 0x0E      | 2    | wait_ticks (until next timed dispatch)           |
| 0x10–0x1B | 12   | control stack: 4 × {ptr u16, count u8} — LOOP entries carry the remaining count; CALL entries are tagged count = 0xFF (M3) |
| 0x1C      | 1    | control stack depth                              |
| 0x1D      | 1    | fade counter (M2)                                |
| 0x1E      | 1    | last MARKER id (mirrored to mailbox status)      |
| 0x1F      | 1    | reserved                                         |

### 5.3 Banking

Song data is read through the 0x8000–0xFFFF banked window; the bank is
**latched at START_TRACK** (§6.3). M1 restriction: **one MMB per window** —
all simultaneously playing tracks must come from the same MMB/bank, because
the Z80 has one window. (Cross-MMB layering — the §2.3 vision across two
scores — requires bank switching between track dispatches; deferred, the
mailbox protocol already carries the per-command bank so no protocol change
will be needed.)

**Code overlays.** Cold code lives in a 32 KB-aligned overlay ROM blob at
`G_OVL_BANK`; `load_overlay` banks the window to it, `LDIR`s the overlay into
the shared `OVERLAY_SLOT` RAM buffer, banks back, and the caller runs it there
(§11 lists the overlays). A `G_CUR_OVL` guard skips the copy when the wanted
overlay is already in the slot. The host publishes `G_OVL_BANK` at init. **The
boot code is itself an overlay** (`ovl_boot`): the resident reset stub loads it
using `G_OVL_BANK`, so the host must write `G_OVL_BANK` into Z80 RAM **before
releasing the Z80 from reset**, and `ovl_boot`'s RAM clear preserves the
overlay-bank globals (`G_OVL_BANK` / `G_MMB_BANK` / `G_CUR_OVL`). The idle loop
stays resident (a later overlay load overwrites the slot).

## 6. Mailbox Protocol (68000 → Z80)

Realizes the §2 control interface (formerly spec-v0.5 §4.3). The 68000 writes commands
into a ring in Z80 RAM (taking the Z80 bus briefly); the Z80 drains the
ring at the top of every frame (§4 step 1) and clears consumed cells.

### 6.1 Layout (64 B at 0x1680)

| Offset    | Size | Field                                            |
| --------- | ---- | ------------------------------------------------ |
| 0x00–0x1F | 32   | command ring: 8 cells × 4 B {cmd u8, a0 u8, a1 u8, a2 u8} |
| 0x20      | 1    | head (68k-owned: next cell to write)             |
| 0x21      | 1    | tail (Z80-owned: next cell to read)              |
| 0x22–0x31 | 16   | per-track status bytes (Z80-owned, 68k-readable): bit7 active, bit6 fading, bits5–0 last MARKER id (markers used for host sync must be ≤ 63) |
| 0x32      | 1    | driver_ready (0x00 while booting, 0xD2 when the main loop is up) |
| 0x33      | 1    | protocol_version (= 2)                           |
| 0x34–0x3F | 12   | reserved                                         |

Ring discipline: the 68k writes the cell at `head` (cmd byte last), then
increments `head` mod 8. The Z80 consumes while `tail != head`: execute,
zero the cmd byte, increment `tail` mod 8. The ring is full when
`(head + 1) mod 8 == tail`; the 68k must not overwrite — with per-frame
draining, 8 commands/frame is the burst budget.

### 6.2 Command set

| Cmd  | Name        | a0        | a1        | a2       | Stage |
| ---- | ----------- | --------- | --------- | -------- | ----- |
| 0x00 | (empty)     | —         | —         | —        | —     |
| 0x01 | START_TRACK | track_id  | bank low  | bank high| M1    |
| 0x02 | STOP_TRACK  | track_id  | —         | —        | M1    |
| 0x03 | KEY_OFF     | channel_id| —         | —        | M2    |
| 0x04 | SET_PARAM   | channel_id| target_id | value i8 | M2    |
| 0x05 | FADE_TRACK  | track_id  | frames    | —        | M2    |
| 0x06 | SET_VAL     | slot      | value low | value high | M3  |
| 0x07 | GET_VAL     | —         | —         | —        | reserved — realized as a direct 68k read of the val-slot array (§6.4), no command round-trip |

### 6.3 Command semantics

- **START_TRACK** — latch the bank, look up `track_id` in the MMB track
  table, initialize the TCB (stream ptr = base + event_offset, accumulator
  0, increment from the stream's first TEMPO_SET — the compiler guarantees
  one before the first timed event), apply the channel ownership rule
  (§2.2), reset channel level state to defaults (vel 15, vol 31, master 31,
  gate 8), and initialize declared val slots not yet host-written (mmb.md
  §8). Restarting an active track restarts it from the top.
- **STOP_TRACK** — key-off (release tail runs out naturally), free the
  channel, mark the TCB idle. On the fm3-csm track this **clears the CSM
  bit in reg $27** (§9).
- **KEY_OFF** — key-off one channel without stopping its track: releases a
  `len=0` hold (the track's dispatcher resumes) or truncates a sounding
  note (its release envelope fires).
- **SET_PARAM** — one-shot absolute write of `target_id` (opcodes.md §7) on
  a channel, as if a PARAM_SET arrived in the stream. Value is i8; the two
  i16 targets (NOTE_PITCH cents) are host-drivable via val slots +
  `PARAM_FROM_VAL` instead.
- **FADE_TRACK** — attenuate the track's channel by stepping `master` down
  to 0 over `frames` frames, then behave as STOP_TRACK.
- **SET_VAL** — write i16 into a val slot; takes effect at the next
  dispatch that reads the slot (`PARAM_FROM_VAL`/`_ADD_VAL`/`_MUL_VAL`,
  dynamic curve params). The host does all arithmetic; the driver only
  stores and applies (docs/language.md §8).

### 6.4 Val slots

16 × i16 at the published `VAL_SLOTS` address (mailbox floor + 0x40; see the
§5 note for the current value). Written by the Z80 (init from VAL_TABLE at
START_TRACK, then `SET_VAL` commands); read directly by the 68k for GET_VAL.
Slot index = VAL_TABLE index; slot 0xFF in stream operands is the built-in
`$time` source (elapsed 60 Hz frames, low 16 bits), never stored in this array.
(The reference/asm implement `$time` as frames since boot; for the M1
single-MMB model, tracks start together so this equals frames since track
start.)

## 7. Level Composition

Implements the level model of docs/language.md §6 — signed dB offsets composed by
addition, quantization once at the write:

```
FM  (per carrier op of the current ALG):
    TL  = clamp(0, 127, voicedTL[op] + vel_tl[vel] + vol_tl[vol] + vol_tl[master])
PSG:
    att = clamp(0, 15,  vel_psg[vel] + vol_psg[vol] + vol_psg[master])
```

Offset tables in the driver image, **generated from the `ir-utils.js`
constants** (`TL_DB_PER_STEP` 0.75, `PSG_DB_PER_STEP` 2, `VEL_DB_PER_STEP`
2, `VOL_STEP_DB` 2, `VOL_UNITY` 31):

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
- **Same-table requirement:** the JS reference and the asm use these
  byte-identical integer tables. The tables round per term, whereas
  `ir-player.js` sums floats and quantizes once — a known divergence of at
  most ±2 TL steps (±1.5 dB) / ±1 PSG step, inside the §12 acceptance band.

## 8. Pitch Tables

Both tables are generated by the JS reference **from the same code as
`ir-utils.js`** (`midiToFnumBlock`, `PSG_MASTER_CLOCK`) and pasted verbatim
into the asm (§12). NTSC clocks: YM 7,670,454 Hz, PSG 3,579,545 Hz.

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
  So `write_fm_pitch` / `write_fm3_op_pitch` (and drv-player `_writeFmPitch` /
  `_writeFm3OpPitch`) write the `$A4`/`$A0` pair every note via
  `ym_write_always` / `_ymAlways`, keeping the shadow current but always
  emitting. This is the one place M1 deliberately bypasses change-only
  suppression besides the `$28` key edge.

## 9. CSM Rule

- The compiler emits `CSM_ON` once at the start and `CSM_OFF` only at
  **end-of-stream** of an fm3-csm track; mid-track rests do **not** toggle
  the CSM bit (Timer A just keeps retriggering a released envelope).
- The driver's invariant: `STOP_TRACK` (and END_OF_TRACK, and the stop side
  of FADE_TRACK) on the track flagged `isCsm` clears the CSM bits in reg
  $27 — the flag exists in the track table precisely so stopping never
  leaves the chip in CSM mode.

## 10. Decided — Voice Representation

**Resolved: Option B adopted** (2026-07-06); the 29-byte voice entry layout is
**frozen in mmb.md §11** (2026-07-07). The export-time coalescing pass folds
full-voice PARAM_SET bursts into VOICE_TABLE entries + `VOICE_SET` (0x14); the
IR is unchanged. Rationale below.

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

## 11. Milestones

- **M1 — core playback.** Core opcodes (opcodes.md §3), FM + PSG note
  paths, level tables (§7), pitch LUTs (§8), mailbox with
  START_TRACK/STOP_TRACK, channel ownership, `len=0` holds, MARKER status
  feedback. Skip-decode of all reserved opcodes.
- **M2 — motion.** PARAM_SWEEP / PARAM_SWEEP_STOP (glide, vibrato via loop
  curves), PARAM_ADD, TEMPO_SWEEP, LOOP_BREAK, CSM (ON/OFF/RATE const +
  swept), single-channel PCM through the DAC (ring buffer in the reserved
  area), KEY_OFF / SET_PARAM / FADE_TRACK commands. Note: a `shot` sample
  plays to its end — a note's `length`/`gate` do not truncate it (only `loop`
  mode honors KEY-OFF). Gated / length-limited one-shots are a later milestone.
- **M3 — expression.** FM3 independent-OP (FM3_MODE/FM3_OP_PITCH, §13.4), the
  macro engine (`:step` clocks; VOL/VEL/FM/i16-NOTE_PITCH/NOTE_SEMI/KEYON macros;
  up to 3 concurrent per channel), dynamic value slots (SET_VAL,
  PARAM_FROM_VAL/_ADD_VAL/_MUL_VAL, PARAM_MUL), and **multi-channel PCM soft
  mix** (§14) **are implemented and gated**. Remaining: NOTE_ON_EX macro_ref,
  VOICE_SET, CALL/RET + the encode-time dedup pass.

## 12. Verification Strategy

There is no automated test suite for audio; verification is comparative:

1. **JS reference implementation** (`drv-player.js`): executes MMB v0.2
   with the §4 loop order and **integer-only math** (8.8 accumulators, the
   §7/§8 integer tables — no floats), in the live environment as an
   alternate backend. It is the executable form of this spec.
2. **Register-write log A/B** (`ab-compare.js`; `window.__abCompare()` in
   the live app). The reference driver's frame-stamped register log is
   diffed against `ir-player.js` output as per-register *state runs* (raw
   write streams are incomparable: the IR player runs a continuous clock
   and repeats values; the driver is frame-quantized and change-only).
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
   Gate: `examples/source/ab-core.mmlisp` (exactly the M1 opcode set) must
   diff clean — currently **0 mismatches**. Songs using M2/M3 features
   (macros, sweeps, PCM, CSM) report skipped-event diagnostics and A-side
   surplus writes; expected, logged, not a failure.
3. **LUT export.** The reference prints every constant table (F-number,
   PSG period, level offsets, PCM rate multipliers, curve units) as asm
   `db`/`dw` blocks for verbatim inclusion — the asm never re-derives a
   table, so JS/asm table divergence is structurally impossible.
4. **Asm bring-up (per milestone).** The Z80 build replays the same MMBs in
   an emulator with a register-write trace; the trace must match the JS
   reference log exactly (same math, same tables, same order — zero
   tolerance at this stage, the ±1-frame band applies only to the
   ir-player comparison).

## 13. Macro Engine (M3)

Macros (docs/language.md §10) are per-target parameter automation attached to
notes. The rich authoring vocabulary — step vectors, curves, multi-stage,
`:hold` sustain loops, `:off` release, `_` holds, the `:step` clock, symbolic
coercion — is **lowered at compile time** to one uniform runtime shape (mmb.md
§15): a per-`:step` value array in three regions (attack / sustain-loop /
release). Curves and stages are pre-sampled; the driver never evaluates a curve
or easing at macro time. This keeps the engine tiny and reproduces `ir-player`
`_scheduleMacro` exactly, so the JS reference and asm share it under the §12
trace gate.

**Implementation status.** The engine is implemented and gated (`verify:m3`)
for the `steps`, `curve`, and `stages` macro forms on i8 targets that ride the
PARAM_SET apply path — the common envelope/LFO case (VOL/VEL/FM_TL/…). Curve
and stage macros are pre-sampled at the `:step` clock in the exporter (a
one-shot curve fills the attack region and holds its last value; a looping
curve/stage fills the sustain region; `(wait key-off)` marks the release
boundary) — no engine change, the same value array is stepped. The macro-only target **NOTE_SEMI** is implemented (§13.2): its value is a
semitone offset written to the pitch register at note+semi each `:step` (no
retrigger, no change to the sticky `:pitch` state) — the classic chiptune
arpeggio, on FM and PSG. The i16 target **NOTE_PITCH** is implemented (pitch
envelopes / vibrato shapes): its descriptor carries flags bit0 (i16), the value
blob is 2 bytes per `:step` (cents, hold sentinel `0x8000`), and `sm_fire`
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
active-macro ids (§5.1). On **any** `NOTE_ON` the driver instantiates each
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
zero (the resident `mul16x8_sh8`). The slot id rides one byte appended after the
value blob. This is the frame-tier interactive knob — the game writes a slot
(SET_VAL) and a vibrato/tremolo depth follows in real time.

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

## 14. PCM Soft-Mix (M3)

`pcm1`–`pcm3` are three PCM voice slots summed in software to the single fm6
DAC. (`fm6` itself is FM-only; it is no longer a PCM channel.) Each `PCM_NOTE_ON`
sets up its channel's voice (sample base/length/loop + a per-mix-tick increment);
`PCM_NOTE_OFF` starts a looped voice's release tail (a `shot` plays to its end
regardless). The heavy per-note setup is cold — it lives in the `ovl_pcm`
overlay (§5.3), loaded on demand — so only the hot mixer stays resident.

**The mix (frame-quantized, matches the M2 burst-DAC deviation).** Each frame
emits a fixed `R` DAC writes (the *mix rate*, `PCM_MIX_R = 175` ≈ 10.5 kHz). Per
tick, every active voice is resampled to that grid by **nearest-neighbour**
(sample at `pos >> 16`, then `pos += inc`), the ≤3 signed samples are **summed
and hard-saturated to int8**, and the result is written to `$2A`. `inc` is the
16.16 per-tick increment `= floor(inc_frame / R)` (full-precision divide so pitch
stays accurate; a table pre-divided by `R` would round too coarsely). A voice
deactivates when a shot/tail passes the sample end; a non-releasing loop wraps by
`loopLen` each tick. The DAC is enabled (`$2B`) on the first active voice and
released when the last voice ends, both through the change-only shadow.

A single voice takes the same path (one active slot) — there is no separate
fast path. The voice structs (17 B × 3) live in the RAM gap just below
`OVERLAY_SLOT`. As with the rest of the driver the hard gate is asm↔`drv-player`
at zero tolerance; the sub-frame feed *timing* (bytes burst at frame start, not
spread) remains a hardware-bring-up concern.
