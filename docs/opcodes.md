# MMB v0.3 Opcode & Target Tables

The opcode, target and curve vocabulary of MMB v0.3 (`live/src/mmb.js`,
`VERSION_MINOR = 3`). Ids, payload layouts and semantics defined here are
stable: a later minor version may *add* opcodes and targets, it does not change
these. Stream framing (duration operands, per-track termination) is defined in
`docs/mmb.md` §7; event semantics come from the IR (`docs/ir.md`).

`live/src/mmb.js` holds the tables themselves — `OPCODE`, `TARGET_ID`,
`CURVE_ID`, the duration helpers and the curve evaluator. Both the writer
(`live/src/export-mmb.js`) and the reference decoder (`live/src/drv-player.js`)
import them, so the two cannot drift; the 68000 sequencer
(`drv/68k/mmlispseq.c`) carries the same ids as C enums and is byte-diffed
against the reference on every gate score (`cd drv && npm run c-gate`).

An id this document leaves **undefined** has no layout, so a decoder cannot skip
it. On meeting one it stops decoding that track and reports an error
(mmb.md §13).

## 1. Opcode Space Map

| Range     | Group                                  |
| --------- | -------------------------------------- |
| 0x00      | END_OF_TRACK                           |
| 0x01–0x0F | stream control — undefined             |
| 0x10–0x3F | timing and note events                 |
| 0x40–0x5F | control flow                           |
| 0x60–0x7F | parameter events                       |
| 0x80–0x9F | tempo and transport                    |
| 0xA0–0xBF | advanced FM (CSM, FM3 special mode)    |
| 0xC0–0xDF | PCM                                    |
| 0xE0–0xEF | macro / dynamic-value block            |
| 0xF0–0xFF | undefined                              |

## 2. Operand Conventions

- `dur` = the shared duration operand (mmb.md §7.2): `0x01–0xFE` ticks,
  `0xFF` + u16le extended, `0x00` indefinite hold (NOTE_ON/PCM_NOTE_ON only).
- `value` on parameter opcodes is i8 or i16 per the target's width column
  (§7). The width is static per target, so a decoder knows a payload's size
  from the opcode and the target byte alone.
- Multi-byte fields are little-endian. All payloads are byte-packed.

## 3. Core Opcodes

| Op   | Name         | Payload                  | Bytes (op + payload) |
| ---- | ------------ | ------------------------ | -------------------- |
| 0x00 | END_OF_TRACK | —                        | 1                    |
| 0x10 | NOTE_ON      | note u8, dur             | 3 (5 ext.)           |
| 0x11 | REST         | dur                      | 2 (4 ext.)           |
| 0x12 | TIE          | dur                      | 2 (4 ext.)           |
| 0x40 | LOOP_BEGIN   | count u8                 | 2                    |
| 0x41 | LOOP_END     | —                        | 1                    |
| 0x42 | TRIG         | id u8                    | 2                    |
| 0x43 | JUMP         | dest u16                 | 3                    |
| 0x60 | PARAM_SET    | target u8, value i8/i16  | 3–4                  |
| 0x80 | TEMPO_SET    | increment u16 (8.8)      | 3                    |

### 3.1 Semantics

**0x00 END_OF_TRACK** — terminates a non-looping track: key-off if still
keyed, release the channel, mark the track idle.
On an `isCsm` track this also clears the CSM bit in reg $27 (driver.md §9).
Every track block must end with this opcode (looping tracks never reach it —
their tail is a backward JUMP — but the terminator is still required as the
structural end for validation).

**0x10 NOTE_ON** — key-on `note` (u8 MIDI number → F-number/block or PSG
period via ROM LUTs, mmb.md §7.3) using the track's current **vel** and
**gate** state (see §4). Advance the clock by `dur`. Key-off fires at
`dur × gate / 8` ticks; with gate = 8 the key-off at `dur` expiry is held for
the next opcode to resolve: TIE extends the note and keeps it pending, a
**legato** NOTE_ON_EX (bit3, §5.1) cancels it, and everything else — a plain
NOTE_ON, REST, END_OF_TRACK — fires it. Before a NOTE_ON it is written ahead of
that note's own writes: on FM the key transition *is* the attack, and the two
`$28` writes land one expander slot apart (≥139 µs, driver.md §6.1), far past
the 18.77 µs round in which the chip latches key state. On PSG and PCM the
pending key-off is dropped instead — the note-on re-asserts attenuation or
restarts the sample, so nothing is lost. `dur = 0x00` holds the key until the
host releases it (docs/language.md §17); the track suspends dispatch until then.

**0x11 REST** — key-off if still keyed, advance the clock by `dur`.

**0x12 TIE** — extend the sounding note by `dur` without retrigger. A sticky
eighth-gate (NOTE_ON) applies per final segment; an absolute NOTE_ON_EX gate is
counted from the original note-on and spans the tie (§5.1).

**0x40 LOOP_BEGIN** — `count` = total iterations (2–255; 0 and 1 are
reserved and must not be emitted — infinite repetition is a backward JUMP).
Pushes `{resume_ptr, count − 1}` on the track's control stack (4 entries,
driver.md §4.3).

**0x41 LOOP_END** — if the top counter is nonzero, decrement and jump to
`resume_ptr`; else pop and continue. The repeat count lives on LOOP_BEGIN, so
LOOP_END carries no operand and loops are not identified by an id.

**0x42 TRIG** — `(trig N)`, the music→game sync point. Write the track's
**status byte** and continue; no register effect.

```
bits 5-0   id, 0..63 — the operand
bits 7-6   firing counter: 1, 2, 3, 1, … starting from 0
```

The counter is what makes a repeat visible. An id alone cannot distinguish "the
same cue fired again" from "nothing happened", and a cue inside a loop fires the
same id every pass — so the game polls the byte and compares it with the one it
last saw: **any difference is a trigger**. Starting the counter at 0 also keeps
`0x00` meaning "this track has never passed a trigger", which `(trig 0)` (=
`0x40`) does not collide with. Within one frame the last trigger wins; reading
does not clear it. The host reads it with `MMLisp_trig(track_id)`.

**Labels emit nothing.** `#label` is a compile-time name for a JUMP target, and
JUMP carries a resolved offset — the driver never searches for a marker — so a
label costs no stream bytes and cannot touch this byte.

**0x43 JUMP** — unconditional jump to `dest`, a byte offset relative to the
EVENT_STREAM payload start (same base as `event_offset`). Used for infinite
loops (`#loop … (go loop)`). Finite `(go label n)` never reaches MMB — the
compiler already rewrites it to LOOP_BEGIN/LOOP_END. The driver keeps its sticky
state (VEL/GATE eighths, active macros) across the jump — the **encoder** is
responsible for re-establishing, just before a backward JUMP, whatever sticky
state the loop body assumes at its target label, since the loop tail may leave a
different state than the linear stream had at the label (export-mmb.js). Without
that, e.g. a full-gate `#loop` head note plays short on iterations 2+.

**0x60 PARAM_SET** — set `target` to `value` (width per §7). Level targets
(VEL/VOL/MASTER/GATE) update driver state; register targets write through
the shadow-register queue (driver.md §4).

**0x80 TEMPO_SET** — replace the per-frame tick increment for **all tracks
of the containing MMB** (tempo is score-global; language.md §5). 8.8 fixed
point, precomputed at compile time (mmb.md §7.5).

## 4. NOTE_ON velocity and gate

NOTE_ON carries `{note, dur}` and nothing else. Velocity and gate are sticky
driver state, set by `PARAM_SET VEL` and `PARAM_SET GATE`; NOTE_ON_EX (§5.1)
carries per-note deviations — a one-off accent, a `:gate-` fixed-tick
shortening, an irregular gate. Bytes are spent only where a value changes,
which is how the language already works (`:vel` and `:gate` are sticky track
state in the compiler) and keeps NOTE_ON a two-field read in the decoder.

Defaults at track start are vel = 15 and gate = 8 — no attenuation, full length
— matching the compiler's defaults, so the exporter emits an initial PARAM_SET
only for a non-default value.

### 4.1 Sticky state across a backward JUMP

The encoder emits sticky params (VEL, GATE, macro binds) change-only against a
**linear** walk of the track, but a backward JUMP re-enters the body with the
state the *tail* left. Something has to reconcile the two, and which mechanism
is used is not a free choice:

- **GATE and macro binds are restored at the JUMP**, from a snapshot taken at
  the target label's offset. They are silent state — nothing reaches a
  register until the next note — so re-establishing them at the loop boundary
  cannot disturb anything.
- **VEL is not.** The driver acts on `PARAM_SET VEL` immediately: it recomposes
  every carrier's TL (driver.md §7.1), so a VEL written at the JUMP would land
  a level on whatever is still sounding across the loop point — up to +21.8 dB
  on a sustained chord, until the body reaches its next note. Instead, a label
  that is a backward-JUMP target **invalidates the encoder's VEL tracking**, so
  the body re-asserts its own velocity at the note that needs it and depends on
  nothing established before the label.

Gate: `m3-loop-vel-hold` (label at the top, quiet `:vel`, rests at the loop head
so a wrong level would last — all three are needed to catch it). `ir-player`
carries vel on every NOTE_ON and cannot show the difference, so the gate is the
only thing that watches this rule.

## 5. Control Flow and Note Opcodes

| Op   | Name       | Payload                        | Notes                                    |
| ---- | ---------- | ------------------------------ | ---------------------------------------- |
| 0x13 | NOTE_ON_EX | flags u8, note u8, dur, fields | per-note vel/gate/macro/legato (§5.1)    |
| 0x14 | VOICE_SET  | voice_id u8                    | VOICE_TABLE (mmb.md §11), driver.md §10  |
| 0x44 | CALL       | dest u16                       | §5.2                                     |
| 0x45 | RET        | —                              | §5.2                                     |
| 0x46 | LOOP_BREAK | skip u16                       | §5.2                                     |

### 5.1 NOTE_ON_EX (0x13)

`{flags u8, note u8, dur, then one field per set flag bit, in bit order}`:

| Bit | Field     | Size    | Meaning                                        |
| --- | --------- | ------- | ---------------------------------------------- |
| 0   | vel       | u8      | velocity for this note only (state untouched)  |
| 1   | gate      | dur enc | absolute gate in ticks **from note-on** for this note only (covers `:gate-` and irregular gates). Counted down across TIE segments — a gate resolved over a tied whole may exceed this NOTE_ON_EX's own `dur`, keying off mid-tie; it is **not** clamped to the first segment. A following REST cancels a still-counting gate |
| 2   | macro_ref | u8      | per-note one-shot: trigger MACRO_TABLE[macro_ref] for this note only, without touching the sticky active set (mmb.md §15, opcodes.md §6) |
| 3   | legato    | —       | slur: write the F-number / recompose levels / re-snapshot macros but **do not re-key** (leave `$28`, the FM EG or PSG tone carries over). No field. `X ~ Y` different-pitch (language.md §3.1). FM/PSG only |
| 4–7 | —         | —       | reserved; **must be 0** — a decoder seeing a set reserved bit must fail-safe (sizes unknown → not skippable) |

Every field has a fixed size, so the instruction is walkable without
interpreting it: read flags/note/dur, then step over each present field by its
size (gate uses the duration-operand length rules).

### 5.2 CALL / RET / LOOP_BREAK

- **CALL 0x44** `{dest u16}` — jump to `dest` (EVENT_STREAM-relative),
  pushing the return pointer on the track control stack. Shared-subsequence
  reference: emitted by the encode-time deduplication pass (`mmb-dedup.js`).
  Depth: CALL and LOOP entries share one 4-entry control stack (driver.md
  §5.2, CALL entries tagged remaining = 0xFF); the encoder factors only
  control-flow-free runs, and a fragment never CALLs, so a CALL adds exactly
  one entry — it factors inside a loop only where `loop depth + 1 ≤ 4`. A
  phrase shared inside loops is factored too, and a LOOP_BREAK whose loop
  body shrinks has its `skip` relinked. Gate: `m3-callret`.
- **RET 0x45** — pop the top (call-tagged) entry and continue at its return
  pointer.

The **dedup pass** is a pure encode transform: repeated
event runs are stored once (fragment + RET) and each occurrence becomes a
3-byte CALL. It changes MMB bytes, never the register trace — verified by the
ab-compare gate (`drv/tools/ab-gate.mjs`), which replays the original IR and
the deduped MMB and requires an unchanged mismatch baseline.
- **LOOP_BREAK 0x46** `{skip u16}` — `(break)`: on the **last** iteration of
  the innermost loop, pop its entry and jump forward `skip` bytes (measured
  from the end of this instruction, landing just past the matching
  LOOP_END); on earlier iterations, no-op.

## 6. Parameter, Tempo, FM3/CSM, PCM and Macro Opcodes

| Op   | Name             | Payload                                              |
| ---- | ---------------- | ---------------------------------------------------- |
| 0x61 | PARAM_SWEEP      | target u8, curve u8, flags u8, from i16, to i16, len u16 |
| 0x62 | PARAM_ADD        | target u8, delta i8/i16 (target width)               |
| 0x63 | PARAM_MUL        | target u8, factor u16 (8.8 unsigned)                 |
| 0x64 | PARAM_FROM_VAL   | target u8, slot u8                                   |
| 0x65 | PARAM_SWEEP_STOP | target u8                                            |
| 0x81 | TEMPO_SWEEP      | from u16 (8.8), to u16 (8.8), len u16, curve u8      |
| 0xA0 | CSM_ON           | —                                                    |
| 0xA1 | CSM_OFF          | —                                                    |
| 0xA2 | CSM_RATE         | flags u8, then const or swept form (below)           |
| 0xA3 | FM3_MODE         | mode u8 (0 normal, 1 special/independent-OP, 2 CSM)  |
| 0xA4 | FM3_OP_PITCH     | op u8 (1–4), note u8                                 |
| 0xC0 | PCM_NOTE_ON      | sample u8, note u8 (bit7 = loop), dur                |
| 0xC1 | PCM_NOTE_OFF     | —                                                    |
| 0xE0 | MACRO_SET        | macro_id u8                                          |
| 0xE1 | PARAM_ADD_VAL    | target u8, slot u8                                   |
| 0xE2 | PARAM_MUL_VAL    | target u8, slot u8                                   |
| 0xE3 | MACRO_CLEAR      | target u8                                            |

Notes:

- **PARAM_SWEEP** is a fixed 9-byte payload. `len` is
  in 60 Hz frames; for loop-curve ids it is the period. `flags` bit0 = loop
  (run until PARAM_SWEEP_STOP / next note per IR semantics), **bit1 = `from`
  is a value-slot id** (in the field's low byte), **bit2 = `to` is a slot id**
  — the driver reads the slot live at dispatch, replacing the field — bits3–7
  reserved 0. From/to are in target units, i16 regardless
  of target width (NOTE_PITCH cents need it; narrow targets just don't use the
  range). `:rate`/`:len` slots are not slot-fed; they bake to the init values.
- **PARAM_MUL** factor is unsigned 8.8 (0x0100 = ×1.0).
  Read-modify-write against the current value, clamped at the write. The driver
  multiplies the low byte of the current value (levels are ≤127), so signed/wide
  targets (NOTE_PITCH) via MUL are a later refinement.
- **PARAM_FROM_VAL / PARAM_ADD_VAL / PARAM_MUL_VAL** read val slot
  `slot` (mmb.md §8) at dispatch time. FROM_VAL writes the slot; ADD_VAL adds it
  to the current value; MUL_VAL multiplies by it as an 8.8 factor (like
  PARAM_MUL). Slot 0xFF = the built-in `$time` source (elapsed 60 Hz frames,
  low 16 bits); slots 0x00–0x0F are VAL_TABLE slots, seeded at START_TRACK and
  written by the host (`MMLisp_setVal`, driver.md §6.4).
- **TEMPO_SWEEP** interpolates the tick increment over `len` frames.
  Because the increment is proportional to BPM, linear interpolation in
  increment domain is linear in BPM — no conversion needed in the driver.
- **CSM_RATE**: `flags` bit0 = 0 → const form: `period u16` (10-bit Timer A
  period, precomputed from Hz at compile time — Hz never reaches the driver);
  bit0 = 1 → swept form: `from u16, to u16, len u16 (frames), curve u8`.
  Bits1–7 reserved 0.
- **FM3_MODE / FM3_OP_PITCH** (driver.md §13.4). Each `fm3-1`…
  `fm3-4` note emits `FM3_OP_PITCH {op, note}` — recording the operator's note
  and writing its F-number registers (OP4 → CH3 base `$A6`/`$A2`; OP1-3 →
  `$AC+idx`/`$A8+idx`, `idx = op mod 3`) with the operator's own sticky
  `NOTE_PITCH` offset applied — followed by a `NOTE_ON` on channel id 2 (op1)
  or 16-19 (op1-4) that keys the operator's `$28` slot bit. NOTE_PITCH sets,
  sweeps and macros on an operator track move that operator alone.
  `FM3_MODE 1` (from the note-less `(fm3 …)` track) sets `$27` bit6 first.
  There is no raw register-write opcode: the stream has no escape hatch to the
  chip.
- **PCM_NOTE_ON** plays `sample` (SAMPLE_BANK id). The exporter bakes one
  entry per (sample, note), so the id already carries the pitch and `note`'s
  low seven bits only name it (mmb.md §10.1). **Bit 7 of `note` says the note
  loops** (`:mode loop`): it loops on the entry's loop, with the track's
  LOOP_* writes laid over it, until PCM_NOTE_OFF, which plays its tail out.
  Clear, the note is a shot and plays once, whatever the entry's loop.
  `dur = 0x00` holds until the host releases it. A loop note whose gate is
  shorter than its length ends `dur` at the gate, where its PCM_NOTE_OFF
  stands, and the rest of the length is a REST.
- **MACRO_SET / MACRO_CLEAR** drive the macro engine (mmb.md §15,
  driver.md §13). Macros are sticky track state: `MACRO_SET {macro_id}` binds
  MACRO_TABLE[macro_id] as the active macro for its target (replacing any
  active macro on that target); `MACRO_CLEAR {target}` clears one target
  (`0xFF` = clear all). `NOTE_ON` (0x10) then triggers whatever is active — no
  change to NOTE_ON. `NOTE_ON_EX` `macro_ref` (§5.1) is the per-note one-shot.
  The exporter diffs each note's snapshotted macros into these sticky opcodes.
  The `steps` form lowers onto i8 targets (driver.md §13); the driver
  keeps one active macro per channel. The descriptor `flags` byte
  (mmb.md §15) carries bit0 = i16 values and bit1 = additive: an additive
  `:pitch+`/`:semi+` macro composes each sample with the channel's live pitch
  offset instead of overwriting it, so a static `:pitch N` shifts the macro's
  center (driver.md §8).
- **0xE4–0xEF** are undefined. Undefined ⇒ fail-safe reject, not skip.

## 7. Target ID Table

Ids are `TARGET_ID` in `live/src/mmb.js` (and `TARGET_NAME`, its inverse); the
68000 sequencer mirrors them as the `T_*` enum in `drv/68k/mmlispseq.c`. Width
1 = i8/u8 payload, 2 = i16; the wide set is `WIDE_TARGET_IDS` in `mmb.js`,
mirrored by `target_wide()` in the C. Clamp ranges are `MACRO_TARGET_RANGE` in
`live/src/ir-utils.js`, and the driver clamps at the register write with the
same bounds.

| Id   | IR name     | Width | Clamp range    | Register family                    |
| ---- | ----------- | ----- | -------------- | ---------------------------------- |
| 0x01 | NOTE_PITCH  | 2     | −32768..32767 (cents) | YM $A4/$A0 (block/F-num), PSG period |
| 0x02 | —           | —     | —              | unassigned: no target uses this id (§7.1) |
| 0x03 | TEMPO_SCALE | 2     | —              | assigned in both tables, emitted by nothing (§7.1) |
| 0x04 | VOL         | 1     | 0..31          | composed → carrier TL / PSG att    |
| 0x05 | MASTER      | 1     | 0..31          | composed → carrier TL / PSG att    |
| 0x06 | VEL         | 1     | 0..15          | note-on state → composed level     |
| 0x07 | NOTE_SEMI   | 1     | −48..48        | key-on pitch offset (macro target) |
| 0x08 | KEYON       | 1     | 0..1           | gate retrigger (macro target)      |
| 0x09 | GATE        | 1     | 0..8           | note-off timing state (eighths of dur; §4) |
| 0x10 | FM_FB       | 1     | 0..7           | YM $B0 bits 5–3                    |
| 0x11–0x14 | FM_TL1–4 | 1    | 0..127         | YM $40+op                          |
| 0x15 | FM_ALG      | 1     | 0..7           | YM $B0 bits 2–0                    |
| 0x16–0x19 | FM_AR1–4 | 1    | 0..31          | YM $50+op bits 4–0                 |
| 0x1A–0x1D | FM_DR1–4 | 1    | 0..31          | YM $60+op bits 4–0                 |
| 0x1E–0x21 | FM_SR1–4 | 1    | 0..31          | YM $70+op                          |
| 0x22–0x25 | FM_RR1–4 | 1    | 0..15          | YM $80+op bits 3–0                 |
| 0x26–0x29 | FM_SL1–4 | 1    | 0..15          | YM $80+op bits 7–4                 |
| 0x2A–0x2D | FM_KS1–4 | 1    | 0..3           | YM $50+op bits 7–6                 |
| 0x2E–0x31 | FM_ML1–4 | 1    | 0..15          | YM $30+op bits 3–0                 |
| 0x32–0x35 | FM_DT1–4 | 1    | −3..3          | YM $30+op bits 6–4 (sign-magnitude; §7.2) |
| 0x36–0x39 | FM_SSG1–4 | 1   | 0..15          | YM $90+op                          |
| 0x3A–0x3D | FM_AMEN1–4 | 1  | 0..1           | YM $60+op bit 7                    |
| 0x3E | FM_AMS      | 1     | 0..3           | YM $B4 bits 5–4                    |
| 0x3F | FM_FMS      | 1     | 0..7           | YM $B4 bits 2–0                    |
| 0x40 | PAN         | 1     | −1..1          | YM $B4 bits 7–6 (−1=L, 0=LR, 1=R)  |
| 0x41 | LFO_RATE    | 1     | 0..8           | YM $22 (0=off, 1–8=rate index)     |
| 0x42 | NOISE_MODE  | 1     | 0..7           | PSG $E0 noise control (FB bit + NF bits) |
| 0x43 | LOOP_START  | 2     | 0..0x7F00      | PCM loop head → `PCM_RETARGET` WRAP |
| 0x44 | LOOP_END    | 2     | 0..0x7F00      | PCM loop end → `PCM_RETARGET` END   |
| 0x45 | LOOP_LEN    | 2     | 0..0x7F00      | PCM loop length; END = head + this  |
| 0x46–0xFF | —      | —     | —              | reserved                           |

Per-op ids are consecutive op1→op4 within each parameter family (FM_TL1 = 0x11
… FM_TL4 = 0x14).

The three loop targets are **byte offsets into the playing blob**, not register
values: the driver recomputes the voice's END/WRAP through the same rounding
every note-on uses and sends one `PCM_RETARGET` — and only when the rounded
16-byte block actually moves, so a swept loop point does not spend six bytes of
every slot. They are valid on `pcm1`–`pcm3` only. `LOOP_LEN` keeps its length
when `LOOP_START` moves; `LOOP_END` pins the end instead. A released voice
ignores them — it is a shot from then on.

### 7.1 Ids with no emission path

- **0x02** is not assigned at all: `TARGET_ID` in `mmb.js` skips it and the
  C enum has no entry for it. Level is VEL/VOL/MASTER (language.md §6). The id
  stays parked rather than being reused.
- **0x03 TEMPO_SCALE** is assigned in both tables and counted as an i16
  target, but nothing emits it: the compiler knows the name `:tempo-scale`
  while `SUPPORTED_TARGETS` rejects it, so no PARAM opcode ever carries it, and
  neither player has a handler for it.

### 7.2 FM_DT carries a signed value

`:dt` in a score is signed, −3..+3 (language.md), and that is what the stream
carries: an i8 in target units like every other operator param, clamped to
`MACRO_TARGET_RANGE.FM_DT`. The chip's 3-bit field is sign-magnitude, and the
conversion happens at the register write, not in the encoder —
`detuneToReg()` in `live/src/ir-utils.js` and `dt_to_reg()` in
`drv/68k/mmlispseq.c` both map `d < 0 ? 4 | (−d & 3) : d & 3` into bits 6–4 of
`$30+op`. So the byte on the wire is a signed detune, and only the register
byte holds 0..7.

## 8. Curve ID Table (PARAM_SWEEP / TEMPO_SWEEP / CSM_RATE)

The driver evaluates a small curve set; the exporter lowers the language's full
easing vocabulary onto it (output-side minimalism — the driver carries four
easing shapes, not thirty). The mapping is `curveId()` in `live/src/mmb.js`:
each `ease-in-*` / `ease-out-*` / `ease-inout-*` family name collapses onto its
base quad shape, `ramp` aliases `saw`, `const` lowers to linear, and an unknown
name falls back to linear.

| Id  | Curve      | Notes                                                     |
| --- | ---------- | --------------------------------------------------------- |
| 0   | linear     |                                                           |
| 1   | ease-in    | quad; all `ease-in-*` family names lower to this          |
| 2   | ease-out   | quad; all `ease-out-*` family names lower to this         |
| 3   | ease-inout | quad; all `ease-inout-*` family names lower to this       |
| 4   | sin        | loop waveform                                             |
| 5   | triangle   | loop waveform                                             |
| 6   | square     | loop waveform (fixed 50% duty; `:duty` is authoring-side) |
| 7   | saw        | loop waveform (`ramp` is an alias)                        |
| 8–11 | noise, pink, perlin, brown | stochastic; emitted as the id, evaluated as linear (§8.1) |
| 12–255 | —       | reserved                                                  |

Curve shapes are **computed**, not tabulated. `curveUnit8(id, t)` in
`live/src/mmb.js` maps an 8-bit phase to an 8-bit unit with a multiply or a
fold; `sin` is the one shape that needs a table (`SIN_LUT`, 256 u8 entries,
emitted to C as `MML_SIN_LUT` by `drv/tools/gen-c-tables.mjs`). The reference
driver imports `curveUnit8` directly, and `curve_unit8()` in
`drv/68k/mmlispseq.c` is a hand-port of it, so the two agree by construction
and the `c-gate` diff keeps them that way.

Interpolation is `sweepValue(from, to, unit)` = `from + trunc((to − from) ×
unit / 256)`, truncating toward zero. This is a fidelity reduction relative to
the live player, which eases in floating point at 60 Hz; the A/B acceptance
band covers it (driver.md §12.5).

### 8.1 Stochastic curve ids on a sweep

`curveId()` returns 8–11 for `noise` / `pink` / `perlin` / `brown` and the
exporter writes them into PARAM_SWEEP / TEMPO_SWEEP / CSM_RATE unchanged. Both
curve evaluators end in `default: return t`, so on the driver a sweep with one
of these ids runs as a **linear ramp** over its length (and, as a loop curve,
as a saw over its period) rather than as noise. The driver carries no random
source.

In a **macro** the same curve names are exact: the exporter samples them
through `sampleCurveUnit()` (`live/src/ir-utils.js`, seeded LUTs) and MACRO_TABLE
stores the sampled values, so what the driver steps is the shape itself, not an
id it has to evaluate.
