# MMB v0.2 Opcode & Target Tables

Status: **freeze document**. Once reviewed, the assignments here are frozen:
new opcodes/targets may be *added* in later minor versions, but ids, payload
layouts, and semantics defined here do not change. Stream framing (duration
operands, per-track termination) is defined in `docs/mmb.md` §7; event
semantics come from the IR (`docs/ir.md`).

Freeze classes used below:

- **core (M1)** — implemented by the first driver milestone. A v0.2 M1
  decoder must execute these.
- **reserved (M2/M3)** — layout frozen now, implementation deferred. A v0.2
  M1 decoder must be able to **skip** these by their fixed layouts (so M2/M3
  content in a stream degrades gracefully instead of killing the track).
- **undefined** — no layout assigned. A decoder that encounters one must
  fail-safe: stop decoding that track and report an error (mmb.md §13).

## 1. Opcode Space Map

| Range     | Group                                  |
| --------- | -------------------------------------- |
| 0x00      | END_OF_TRACK                           |
| 0x01–0x0F | stream control — reserved, undefined   |
| 0x10–0x3F | timing and note events                 |
| 0x40–0x5F | control flow                           |
| 0x60–0x7F | parameter events                       |
| 0x80–0x9F | tempo and transport                    |
| 0xA0–0xBF | advanced FM (CSM, FM3 special mode)    |
| 0xC0–0xDF | PCM                                    |
| 0xE0–0xEF | macro / dynamic-value block            |
| 0xF0–0xFF | reserved, undefined                    |

## 2. Operand Conventions

- `dur` = the shared duration operand (mmb.md §7.2): `0x01–0xFE` ticks,
  `0xFF` + u16le extended, `0x00` indefinite hold (NOTE_ON/PCM_NOTE_ON only).
- `value` on parameter opcodes is i8 or i16 per the target's width column
  (§7); the width is static per target and known from ROM tables.
- Multi-byte fields are little-endian. All payloads are byte-packed.

## 3. Core Opcodes (frozen, milestone M1)

| Op   | Name         | Payload                  | Bytes (op + payload) |
| ---- | ------------ | ------------------------ | -------------------- |
| 0x00 | END_OF_TRACK | —                        | 1                    |
| 0x10 | NOTE_ON      | note u8, dur             | 3 (5 ext.)           |
| 0x11 | REST         | dur                      | 2 (4 ext.)           |
| 0x12 | TIE          | dur                      | 2 (4 ext.)           |
| 0x40 | LOOP_BEGIN   | count u8                 | 2                    |
| 0x41 | LOOP_END     | —                        | 1                    |
| 0x42 | MARKER       | id u8                    | 2                    |
| 0x43 | JUMP         | dest u16                 | 3                    |
| 0x60 | PARAM_SET    | target u8, value i8/i16  | 3–4                  |
| 0x80 | TEMPO_SET    | increment u16 (8.8)      | 3                    |

### 3.1 Semantics

**0x00 END_OF_TRACK** — terminates a non-looping track: key-off if still
keyed, release the channel, mark the track idle in the mailbox status byte.
On an `isCsm` track this also clears the CSM bit in reg $27 (driver.md §9).
Every track block must end with this opcode (looping tracks never reach it —
their tail is a backward JUMP — but the terminator is still required as the
structural end for validation).

**0x10 NOTE_ON** — key-on `note` (u8 MIDI number → F-number/block or PSG
period via ROM LUTs, mmb.md §7.3) using the track's current **vel** and
**gate** state (see §4). Advance the clock by `dur`. Key-off fires at
`dur × gate / 8` ticks; with gate = 8 it fires at `dur` expiry unless the
next opcode byte is TIE (one-byte peek — a tied note must compile with full
gate; the compiler guarantees this). `dur = 0x00` holds the key until the
host releases it (docs/language.md §17); the track suspends dispatch until then.

**0x11 REST** — key-off if still keyed, advance the clock by `dur`.

**0x12 TIE** — extend the sounding note by `dur` without retrigger; the
gate rule applies to the final segment.

**0x40 LOOP_BEGIN** — `count` = total iterations (2–255; 0 and 1 are
reserved and must not be emitted — infinite repetition is a backward JUMP).
Pushes `{resume_ptr, count − 1}` on the track's control stack (4 entries,
driver.md §5.2).

**0x41 LOOP_END** — if the top counter is nonzero, decrement and jump to
`resume_ptr`; else pop and continue. Note the v0.1 layout change: loop ids
are gone and the count moved from LOOP_END to LOOP_BEGIN (§8).

**0x42 MARKER** — write `id` into the track's mailbox status byte (position
feedback for the 68k) and continue. The driver never searches markers; JUMP
targets are resolved offsets. Zero-cost sync point.

**0x43 JUMP** — unconditional jump to `dest`, a byte offset relative to the
EVENT_STREAM payload start (same base as `event_offset`). Used for infinite
loops (`#loop … (go loop)`). Finite `(go label n)` never reaches MMB — the
compiler already rewrites it to LOOP_BEGIN/LOOP_END.

**0x60 PARAM_SET** — set `target` to `value` (width per §7). Level targets
(VEL/VOL/MASTER/GATE) update driver state; register targets write through
the shadow-register queue (driver.md §4).

**0x80 TEMPO_SET** — replace the per-frame tick increment for **all tracks
of the containing MMB** (tempo is score-global; language.md §5). 8.8 fixed
point, precomputed at compile time (mmb.md §7.5).

## 4. Decided — NOTE_ON velocity/gate carriage

**Resolved: Option B adopted** (2026-07-06). NOTE_ON carries only `{note, dur}`;
vel/gate are sticky driver state set by `PARAM_SET VEL` / `PARAM_SET GATE`, with
NOTE_ON_EX (§5.1) for per-note deviations. Rationale below.

Demo-class songs need per-note velocity and gate in M1. Three candidate
encodings:

| Option | Encoding | Cost |
| ------ | -------- | ---- |
| A. In-stream fields | `NOTE_ON {note, dur, vel u8, gate u8}` | +2 bytes on *every* note; decoder reads them unconditionally |
| B. **Track state (recommended)** | `NOTE_ON {note, dur}`; vel/gate are sticky driver state set by `PARAM_SET VEL` / `PARAM_SET GATE`; per-note deviations use NOTE_ON_EX | Bytes only when values change (matches the sticky `:vel`/`:gate` source model); smallest M1 decoder — NOTE_ON stays a 2-field read |
| C. Compile-time gate lowering | gate disappears: exporter emits `NOTE_ON(gated dur)` + `REST(remainder)` | Zero driver gate logic, but changes `dur` semantics from musical length to key-on length, complicates TIE and the M3 macro gate boundary, and bloats streams with one REST per articulated note |

**Recommendation: B.** It matches how the language already works (`:vel` and
`:gate` are sticky track state in the compiler), keeps the M1 decoder
smallest, and NOTE_ON_EX (§5.1) covers the cases state can't express
(`:gate-` fixed-tick shortening, one-off accents). Option A is rejected as a
per-note tax on the common case; option C is attractive for its zero driver
cost but is a semantic change to `dur` that M3 macros would pay for.

Under B, defaults at track start are vel = 15, gate = 8 (both "no
attenuation / full length"), matching compiler defaults — the exporter emits
initial PARAM_SETs only for non-default values.

## 5. Reserved Opcodes — Control Flow and Notes (layouts frozen)

| Op   | Name       | Payload                        | Stage |
| ---- | ---------- | ------------------------------ | ----- |
| 0x13 | NOTE_ON_EX | flags u8, note u8, dur, fields | M3    |
| 0x14 | VOICE_SET  | voice_id u8                    | M3 — VOICE_TABLE (mmb.md §11), driver.md §10 |
| 0x44 | CALL       | dest u16                       | M3    |
| 0x45 | RET        | —                              | M3    |
| 0x46 | LOOP_BREAK | skip u16                       | M2    |

### 5.1 NOTE_ON_EX (0x13)

`{flags u8, note u8, dur, then one field per set flag bit, in bit order}`:

| Bit | Field     | Size    | Meaning                                        |
| --- | --------- | ------- | ---------------------------------------------- |
| 0   | vel       | u8      | velocity for this note only (state untouched)  |
| 1   | gate      | dur enc | absolute gate in ticks for this note only (covers `:gate-` and irregular gates) |
| 2   | macro_ref | u8      | per-note one-shot: trigger MACRO_TABLE[macro_ref] for this note only, without touching the sticky active set (mmb.md §15, opcodes.md §6) |
| 3   | legato    | —       | slur: write the F-number / recompose levels / re-snapshot macros but **do not re-key** (leave `$28`, the FM EG or PSG tone carries over). No field. `X ~ Y` different-pitch (language.md §3.1). FM/PSG only |
| 4–7 | —         | —       | reserved; **must be 0** — a decoder seeing a set reserved bit must fail-safe (sizes unknown → not skippable) |

Skip rule for an M1 decoder: read flags/note/dur, then skip each present
field by its fixed size (gate uses duration-operand length rules).

### 5.2 CALL / RET / LOOP_BREAK

- **CALL 0x44** `{dest u16}` — jump to `dest` (EVENT_STREAM-relative),
  pushing the return pointer on the track control stack. Shared-subsequence
  reference: the target of the encode-time deduplication pass (M3). Depth:
  CALL and LOOP entries share one 4-entry control stack (driver.md §5.2);
  the encoder enforces combined depth ≤ 4.
- **RET 0x45** — pop return pointer, continue there.
- **LOOP_BREAK 0x46** `{skip u16}` — `:break`: on the **last** iteration of
  the innermost loop, pop its entry and jump forward `skip` bytes (measured
  from the end of this instruction, landing just past the matching
  LOOP_END); on earlier iterations, no-op. Note: the compiler emits
  LOOP_BREAK IR events today; the v0.1 draft had no opcode for it — added
  here as reserved M2.

## 6. Reserved Opcodes — Parameters, Tempo, FM3/CSM, PCM

| Op   | Name             | Payload                                              | Stage |
| ---- | ---------------- | ---------------------------------------------------- | ----- |
| 0x61 | PARAM_SWEEP      | target u8, curve u8, flags u8, from i16, to i16, len u16 | M2 |
| 0x62 | PARAM_ADD        | target u8, delta i8/i16 (target width)               | M2    |
| 0x63 | PARAM_MUL        | target u8, factor u16 (8.8 unsigned)                 | M3    |
| 0x64 | PARAM_FROM_VAL   | target u8, slot u8                                   | M3    |
| 0x65 | PARAM_SWEEP_STOP | target u8                                            | M2    |
| 0x81 | TEMPO_SWEEP      | from u16 (8.8), to u16 (8.8), len u16, curve u8      | M2    |
| 0xA0 | CSM_ON           | —                                                    | M2    |
| 0xA1 | CSM_OFF          | —                                                    | M2    |
| 0xA2 | CSM_RATE         | flags u8, then const or swept form (below)           | M2    |
| 0xA3 | FM3_MODE         | mode u8 (0 normal, 1 special/independent-OP, 2 CSM)  | M3    |
| 0xA4 | FM3_OP_PITCH     | op u8 (1–4), note u8                                 | M3    |
| 0xC0 | PCM_NOTE_ON      | sample u8, note u8, dur                              | M2    |
| 0xC1 | PCM_NOTE_OFF     | —                                                    | M2    |
| 0xE0 | MACRO_SET        | macro_id u8                                          | M3    |
| 0xE1 | PARAM_ADD_VAL    | target u8, slot u8                                   | M3    |
| 0xE2 | PARAM_MUL_VAL    | target u8, slot u8                                   | M3    |
| 0xE3 | MACRO_CLEAR      | target u8                                            | M3    |

Notes:

- **PARAM_SWEEP** is a fixed 9-byte payload (trivially skippable). `len` is
  in 60 Hz frames; for loop-curve ids it is the period. `flags` bit0 = loop
  (run until PARAM_SWEEP_STOP / next note per IR semantics), bits1–7
  reserved 0. From/to are in target units, i16 regardless of target width
  (NOTE_PITCH cents need it; narrow targets just don't use the range).
- **PARAM_MUL** (implemented) factor is unsigned 8.8 (0x0100 = ×1.0).
  Read-modify-write against the current value, clamped at the write. The driver
  multiplies the low byte of the current value (levels are ≤127), so signed/wide
  targets (NOTE_PITCH) via MUL are a later refinement.
- **PARAM_FROM_VAL / PARAM_ADD_VAL / PARAM_MUL_VAL** (implemented) read val slot
  `slot` (mmb.md §8) at dispatch time. FROM_VAL writes the slot; ADD_VAL adds it
  to the current value; MUL_VAL multiplies by it as an 8.8 factor (like
  PARAM_MUL). Slot 0xFF = the built-in `$time` source (elapsed 60 Hz frames,
  low 16 bits); slots 0x00–0x0F are VAL_TABLE slots, seeded at START_TRACK and
  written by the `SET_VAL` mailbox command (driver.md §6).
- **TEMPO_SWEEP** interpolates the tick increment over `len` frames.
  Because the increment is proportional to BPM, linear interpolation in
  increment domain is linear in BPM — no conversion needed on the Z80.
- **CSM_RATE**: `flags` bit0 = 0 → const form: `period u16` (10-bit Timer A
  period, precomputed from Hz at compile time — Hz never reaches the Z80);
  bit0 = 1 → swept form: `from u16, to u16, len u16 (frames), curve u8`.
  Bits1–7 reserved 0.
- **FM3_MODE / FM3_OP_PITCH** (implemented, driver.md §13.4). Each `fm3-1`…
  `fm3-4` note emits `FM3_OP_PITCH {op, note}` — writing that operator's
  F-number registers (OP4 → CH3 base `$A6`/`$A2`; OP1-3 → `$AC+idx`/`$A8+idx`,
  `idx = op mod 3`) — followed by a `NOTE_ON` on channel id 2 (op1) or 16-18
  (op2-4) that keys the operator's `$28` slot bit. `FM3_MODE 1` (from the
  note-less `(fm3 …)` track) sets `$27` bit6 first. (The v0.1 draft reserved
  0xA4 for REG_WRITE; REG_WRITE is dropped — see §8.)
- **PCM_NOTE_ON** plays `sample` (SAMPLE_BANK id) at the rate implied by
  `note` relative to the sample's C4 `base_rate`
  (`rate = base_rate × 2^((note−60)/12)`, precomputed table of 49 u16
  multipliers for C2–C6 in ROM). `dur = 0x00` + a looped sample holds until
  PCM_NOTE_OFF / host release.
- **MACRO_SET / MACRO_CLEAR** drive the macro engine (implemented — mmb.md §15,
  driver.md §13). Macros are sticky track state: `MACRO_SET {macro_id}` binds
  MACRO_TABLE[macro_id] as the active macro for its target (replacing any
  active macro on that target); `MACRO_CLEAR {target}` clears one target
  (`0xFF` = clear all). `NOTE_ON` (0x10) then triggers whatever is active — no
  change to NOTE_ON. `NOTE_ON_EX` `macro_ref` (§5.1) is the per-note one-shot.
  The exporter diffs each note's snapshotted macros into these sticky opcodes.
  Slice 1 lowers the `steps` form onto i8 targets (driver.md §13); the driver
  keeps one active macro per channel for now. The descriptor `flags` byte
  (mmb.md §15) carries bit0 = i16 values and bit1 = additive: an additive
  `:pitch+`/`:semi+` macro composes each sample with the channel's live pitch
  offset instead of overwriting it, so a static `:pitch N` shifts the macro's
  center (driver.md §8).
- **0xE4–0xEF** stay undefined. Undefined ⇒ fail-safe reject, not skip.

## 7. Target ID Table

Ids 0x01–0x41 are carried **verbatim from v0.1**
(`tools/scripts/mmb-common.js` `TARGET_ID`, `live/src/ir-player.js`
`MMB_TARGET_ID_TO_NAME`); 0x05–0x09, 0x40, 0x42 are new in v0.2 (0x05–0x09
and 0x40 were unassigned gaps in the v0.1 table). Width 1 = i8/u8 payload,
2 = i16. Clamp ranges are `MACRO_TARGET_RANGE` in `live/src/ir-utils.js` —
the driver clamps at the register write with the same bounds.

| Id   | IR name     | Width | Clamp range    | Register family                    | Stage |
| ---- | ----------- | ----- | -------------- | ---------------------------------- | ----- |
| 0x01 | NOTE_PITCH  | 2     | −32768..32767 (cents) | YM $A4/$A0 (block/F-num), PSG period | M2 |
| 0x02 | NOTE_VOLUME | —     | —              | **retired** (v0.1 legacy; superseded by VEL/VOL/MASTER — never emitted, id not reused) | — |
| 0x03 | TEMPO_SCALE | 2     | —              | **reserved** (no v0.5 emission path; id kept from v0.1) | — |
| 0x04 | VOL         | 1     | 0..31          | composed → carrier TL / PSG att    | M1    |
| 0x05 | MASTER      | 1     | 0..31          | composed → carrier TL / PSG att    | M1    |
| 0x06 | VEL         | 1     | 0..15          | note-on state → composed level     | M1    |
| 0x07 | NOTE_SEMI   | 1     | −48..48        | key-on pitch offset (macro target) | M3    |
| 0x08 | KEYON       | 1     | 0..1           | gate retrigger (macro target)      | M3    |
| 0x09 | GATE        | 1     | 0..8           | note-off timing state (eighths of dur; §4) | M1 |
| 0x10 | FM_FB       | 1     | 0..7           | YM $B0 bits 5–3                    | M1    |
| 0x11–0x14 | FM_TL1–4 | 1    | 0..127         | YM $40+op                          | M1    |
| 0x15 | FM_ALG      | 1     | 0..7           | YM $B0 bits 2–0                    | M1    |
| 0x16–0x19 | FM_AR1–4 | 1    | 0..31          | YM $50+op bits 4–0                 | M1    |
| 0x1A–0x1D | FM_DR1–4 | 1    | 0..31          | YM $60+op bits 4–0                 | M1    |
| 0x1E–0x21 | FM_SR1–4 | 1    | 0..31          | YM $70+op                          | M1    |
| 0x22–0x25 | FM_RR1–4 | 1    | 0..15          | YM $80+op bits 3–0                 | M1    |
| 0x26–0x29 | FM_SL1–4 | 1    | 0..15          | YM $80+op bits 7–4                 | M1    |
| 0x2A–0x2D | FM_KS1–4 | 1    | 0..3           | YM $50+op bits 7–6                 | M1    |
| 0x2E–0x31 | FM_ML1–4 | 1    | 0..15          | YM $30+op bits 3–0                 | M1    |
| 0x32–0x35 | FM_DT1–4 | 1    | 0..7           | YM $30+op bits 6–4                 | M1    |
| 0x36–0x39 | FM_SSG1–4 | 1   | 0..15          | YM $90+op                          | M1    |
| 0x3A–0x3D | FM_AMEN1–4 | 1  | 0..1           | YM $60+op bit 7                    | M1    |
| 0x3E | FM_AMS      | 1     | 0..3           | YM $B4 bits 5–4                    | M1    |
| 0x3F | FM_FMS      | 1     | 0..7           | YM $B4 bits 2–0                    | M1    |
| 0x40 | PAN         | 1     | −1..1          | YM $B4 bits 7–6 (−1=L, 0=LR, 1=R)  | M1    |
| 0x41 | LFO_RATE    | 1     | 0..8           | YM $22 (0=off, 1–8=rate index)     | M1    |
| 0x42 | NOISE_MODE  | 1     | 0..7           | PSG $E0 noise control (FB bit + NF bits) | M1 |
| 0x43–0xFF | —      | —     | —              | reserved                           | —     |

Per-op ids follow the v0.1 pattern: consecutive ids op1→op4 within each
parameter family (e.g. FM_TL1 = 0x11 … FM_TL4 = 0x14).

## 8. Curve ID Table (PARAM_SWEEP / TEMPO_SWEEP / CSM_RATE)

The Z80 evaluates a small curve set; the exporter lowers the language's full
easing vocabulary onto it (output-side minimalism — the driver carries four
easing shapes, not thirty).

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
| 8–11 | noise, pink, perlin, brown | **reserved** — stochastic curves; whether the driver carries the seeded ROM LUTs or the exporter bakes them into stepped PARAM_SETs is an M3 decision |
| 12–255 | —       | reserved                                                  |

Curve shapes are evaluated from 256-entry u8 unit LUTs in driver ROM,
generated by the JS reference implementation (driver.md §12). Note this is
a fidelity reduction relative to the live player (float easing at 60 Hz);
the acceptance band for A/B diffs covers it (driver.md §12).

## 9. Migration Notes (v0.1 → v0.2)

1. **PARAM_ADD conflict resolved.** The v0.1 draft doc assigned
   PARAM_ADD = 0x61 while the tools (`mmb-common.js`) used 0x61 for
   PARAM_SWEEP. v0.2 rules: **PARAM_SWEEP = 0x61, PARAM_ADD = 0x62.**
2. Record framing: the v0.1 `{tick u32, opcode u8, payload_len u16}` prefix
   is gone; time is delta-encoded via duration operands, payload sizes are
   implied by opcode + target width (mmb.md §7.1).
3. NOTE_ON: v0.1 `{pitch u8, length u16}` → `{note u8, dur}`; velocity and
   gate move to track state / NOTE_ON_EX (§4).
4. TEMPO_SET: v0.1 `{bpm u16}` → precomputed 8.8 tick increment; BPM is
   display metadata only.
5. JUMP: v0.1 `{marker_id u8}` → compile-time-resolved `{dest u16}` offset.
   MARKER remains, repurposed as a zero-cost status/sync point.
6. LOOP_BEGIN/LOOP_END: loop ids dropped; the repeat count moves from
   LOOP_END to LOOP_BEGIN.
7. END_OF_TRACK (0x00) is new; v0.1 relied on byte-length bounds from the
   track table, which no longer carries an `event_length`.
8. REG_WRITE (v0.1 reserved at 0xa4) is dropped — no raw register escape
   hatch in the stream. 0xA4 is reassigned to FM3_OP_PITCH.
9. Target NOTE_VOLUME (0x02) is retired (level model of docs/language.md §6);
   the id is parked, not reused.
