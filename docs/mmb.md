# MMB v0.2 Container Format

Status: **design frozen for review** — this document, together with
`docs/opcodes.md` (opcode/target freeze) and `docs/driver.md` (driver
architecture), gates the Phase 3 driver implementation. Event and target
vocabulary comes from `docs/ir.md`; MMB is the binary lowering of that IR.

MMB v0.2 replaces the v0.1 draft format entirely. There is no v0.1
compatibility path (no legacy support); `tools/scripts/mmlisp2mmb.js` and all
fixtures move to v0.2 in one step.

## 1. Goals

1. **Z80-decodable in place.** The driver reads the file directly from a
   banked 68k-ROM window (0x8000–0xFFFF). Locating any structure is pointer
   walking only — fixed-size headers and offset fields, no parsing, no
   allocation, no relocation.
2. **Compact.** Events are byte-packed with no per-event tick or length
   prefixes (the headline change from v0.1; see §7).
3. **Deterministic.** Identical IR input produces byte-identical MMB output.
4. Clear version negotiation and fail-safe handling of unknown content.

## 2. Conventions

1. Endianness: **little-endian** for all multi-byte fields.
2. Section starts are 2-byte aligned (zero padding between sections).
   Structures *inside* a section are byte-packed — the Z80 has no alignment
   constraints.
3. "Reserved" fields must be written as zero and ignored on read.
4. Offsets are relative to the structure named in the field description,
   never absolute file positions, so the file works at any window address.

## 3. High-Level Layout

```
+--------------------+  0x0000
| File header        |  12 bytes
+--------------------+  0x000C
| Section directory  |  section_count × 12 bytes
+--------------------+
| Sections ...       |  in directory order
+--------------------+
```

## 4. File Header (12 bytes)

| Offset | Size | Field         | Value / notes                        |
| ------ | ---- | ------------- | ------------------------------------ |
| 0x00   | 4    | magic         | `"MMB0"` (0x4D 0x4D 0x42 0x30)       |
| 0x04   | 1    | version_major | 0                                    |
| 0x05   | 1    | version_minor | 2                                    |
| 0x06   | 2    | flags         | u16, see below                       |
| 0x08   | 2    | section_count | u16                                  |
| 0x0A   | 2    | header_size   | u16, = 12 for v0.2                   |

The v0.1 `crc32` field is **dropped**. Integrity checking is a 68k-side
loader concern (checksum the ROM region however the game likes); the Z80
driver never verifies checksums.

Header flags:

| Bit  | Name         | Meaning                                              |
| ---- | ------------ | ---------------------------------------------------- |
| 0    | WIDE_OFFSETS | **Reserved.** When set, track-table `event_offset` widens to u32 and the file may exceed one 32KB bank window. Must be 0 in v0.2 output; loaders reject it (see §12). |
| 1    | PAL_TIMEBASE | **Reserved.** Tempo increments precomputed for 50 Hz (see driver.md §3). Must be 0 in v0.2. |
| 2–15 | —            | Reserved, must be 0.                                 |

## 5. Section Directory

`section_count` entries, each 12 bytes, immediately after the header:

| Offset | Size | Field  | Notes                                    |
| ------ | ---- | ------ | ---------------------------------------- |
| 0x00   | 2    | id     | u16, section id                          |
| 0x02   | 2    | flags  | u16; bit0 = REQUIRED, bits1–15 reserved  |
| 0x04   | 4    | offset | u32, from start of file                  |
| 0x08   | 4    | size   | u32, payload bytes (excl. alignment pad) |

Section ids:

| Id     | Name        | Status                              |
| ------ | ----------- | ----------------------------------- |
| 0x0001 | TRACK_TABLE | required (§6)                       |
| 0x0002 | EVENT_STREAM| required (§7)                       |
| 0x0003 | METADATA    | required (§9); driver ignores it    |
| 0x0004 | SAMPLE_BANK | optional (§10); M2 content, layout frozen now |
| 0x0005 | VAL_TABLE   | optional (§8); M3 content, layout frozen now |
| 0x0006 | VOICE_TABLE | **reserved** (§11, open decision)   |

Directory order is fixed: ascending id. A loader skips unknown section ids
unless the entry's REQUIRED flag is set, in which case the load fails (§13).

## 6. TRACK_TABLE Section (0x0001)

```
track_count : u16
entries     : track_count × 5 bytes
```

Track entry (5 bytes):

| Offset | Size | Field        | Notes                                        |
| ------ | ---- | ------------ | -------------------------------------------- |
| 0x00   | 1    | track_id     | u8, stable id referenced by START_TRACK etc. |
| 0x01   | 1    | channel_id   | u8, see channel map below                    |
| 0x02   | 1    | flags        | u8, see below                                |
| 0x03   | 2    | event_offset | u16, relative to EVENT_STREAM payload start  |

Track flags:

| Bit | Name    | Meaning                                            |
| --- | ------- | -------------------------------------------------- |
| 0   | hasLoop | Track contains a backward JUMP (loops forever)     |
| 1   | isCsm   | fm3-csm track; drives Timer A / CSM (driver.md §9) |
| 2   | isFm3Op | fm3 independent-operator sub-track (channel 16–18) |
| 3–7 | —       | Reserved, must be 0                                |

`event_offset` is u16, which bounds the whole event stream — and in practice
the whole MMB — to **one 32KB bank window** in M1. Larger songs are deferred
behind the reserved WIDE_OFFSETS header flag (§4); v0.2 tooling must reject
output that would overflow u16 offsets.

### 6.1 Channel id map

Carried verbatim from the live player (`live/src/ir-player.js`,
`MMB_CHANNEL_ID_TO_NAME`). Ids are frozen:

| Id    | Channel        | Hardware                              |
| ----- | -------------- | ------------------------------------- |
| 0–5   | fm1–fm6        | YM2612 FM channels 1–6                |
| 6–8   | sqr1–sqr3      | SN76489 square 1–3                    |
| 9     | noise          | SN76489 noise                         |
| 10–15 | —              | reserved                              |
| 16–18 | fm3 op2–op4    | YM2612 ch3 special mode, operators 2–4 (op1 is channel 2 = fm3) |
| 19    | —              | reserved                              |
| 20–22 | pcm1–pcm3      | software-mixed DAC voices (fm6 DAC)   |
| 23–255| —              | reserved                              |

## 7. EVENT_STREAM Section (0x0002)

Per-track event blocks are contiguous, byte-packed, in track-table order.
Each block starts at its `event_offset` and ends at its `END_OF_TRACK`
opcode (0x00) — v0.2 has an explicit terminator; v0.1's reliance on
byte-length bounds is gone (the track entry no longer carries a length).

### 7.1 Delta/duration encoding

This is the headline change from v0.1. The v0.1 draft prefixed every record
with `{tick u32, opcode u8, payload_len u16}` — 7 bytes of overhead per
event. v0.2 events carry **no time and no length prefix**:

1. Events in a block are sequential. Each track has a clock (in ticks,
   PPQN 96 — see docs/language.md §4).
2. **Timed events** — `NOTE_ON`, `REST`, `TIE`, `PCM_NOTE_ON` — carry a
   *duration* operand and advance the track clock by that many ticks after
   executing.
3. **All other events** execute at the current clock position and carry no
   time bytes. A run of parameter events between two notes occupies zero
   musical time, exactly like same-tick IR events.
4. Payload sizes are implied by the opcode (and, for parameter opcodes, by
   the target's width — see opcodes.md §7). There is no `payload_len`.

### 7.2 Duration operand encoding

| First byte | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| 0x01–0xFE  | duration in ticks (1–254)                                  |
| 0xFF       | extended: u16le follows, duration = 255–65535 ticks        |
| 0x00       | **indefinite hold** (`len=0` note): key stays on until the host sends `KEY_OFF` / `STOP_TRACK` (docs/language.md §17); the track clock does not advance and the driver stops dispatching this track until released |

At PPQN 96 a quarter note is 96 ticks (1 byte); a whole note is 384 ticks
(3 bytes, extended form). `REST`/`TIE` use the same encoding; `0x00` is only
valid on `NOTE_ON` / `PCM_NOTE_ON`.

### 7.3 Pitch representation

Pitch is a **u8 MIDI note number**, resolved at compile time (note names,
`:oct`, transpose all folded by the compiler). The driver converts note →
registers with ROM tables:

- FM: a 12-entry u16 F-number LUT plus `block` derived from the note
  (`block = (note + 3) / 12 − 1`, LUT indexed by `(note + 3) mod 12` — the
  table is A-rooted so that every F-number lands in the 512–1023 window
  that `midiToFnumBlock` in `live/src/ir-utils.js` normalizes to).
- PSG: a u16 period LUT over the playable note range.

Both tables **must match the `ir-utils.js` math** (`midiToFnumBlock`,
`PSG_MASTER_CLOCK`). The JS reference implementation generates both tables
from that same code and prints them for verbatim inclusion in the Z80
source (driver.md §8, §12). Fractional/cent pitch never appears in the
stream; pitch bends are `PARAM_SWEEP NOTE_PITCH` events executed by the
driver's sweep engine (M2).

### 7.4 Parameter values

Targets are u8 ids (opcodes.md §7). A parameter value is **i8 when the
target's clamp range fits in i8, i16 otherwise**; the width is a fixed
per-target property listed in the target table, known to both encoder and
decoder (the driver holds a width bitmap in ROM). In practice every target
except `NOTE_PITCH` (cents, ±32767) is i8.

### 7.5 TEMPO_SET payload

BPM never reaches the Z80. `TEMPO_SET` carries the precomputed per-frame
tick increment in **8.8 fixed point**:

```
increment = round(bpm × 96 × 256 / 3600) = round(bpm × 512 / 75)
```

e.g. 120 BPM → 819 (0x0333), 150 BPM → 1024 (0x0400, exact). Display-only
BPM lives in METADATA. Error analysis is in driver.md §3.

### 7.6 Opcode set

The full opcode table, payload layouts, and freeze status live in
`docs/opcodes.md`. This section only defines the stream *framing* (delta
model, duration operands, terminator).

## 8. VAL_TABLE Section (0x0005)

Dynamic value slots (`def-val`, docs/language.md §8). Layout:

```
count : u16          (0–16; driver RAM reserves 16 slots)
inits : count × i16  (initial slot values, slot = array index)
```

Slot names stay in IR/metadata only; the binary uses indices. At
START_TRACK time the driver initializes each declared slot to its init
value unless the host has already written it this session (driver.md §6).
M3 content; the layout is frozen now so M1 files may already carry it
(M1 drivers skip the section).

## 9. METADATA Section (0x0003)

The v0.1 key-value format is kept unchanged. Repeated entries:

```
key_len   : u8
key       : key_len bytes, UTF-8
value_len : u16
value     : value_len bytes, UTF-8
```

Required keys: `title`, `author`, `compiler_version`. Optional keys include
`bpm` (display-only, see §7.5) and val-slot names. **The driver ignores this
section entirely**; it exists for hosts and tools.

## 10. SAMPLE_BANK Section (0x0004)

PCM data for `def :sample` (docs/language.md §9, §16). M2 content; the layout is
frozen now. Structure:

```
entry_count : u16
entries     : entry_count × 20 bytes
blobs       : raw sample data (8-bit signed PCM), byte-packed
```

Sample entry (20 bytes):

| Offset | Size | Field      | Notes                                        |
| ------ | ---- | ---------- | -------------------------------------------- |
| 0x00   | 1    | sample_id  | u8, referenced by PCM_NOTE_ON                |
| 0x01   | 1    | flags      | bit0 = has_loop; bits1–7 reserved            |
| 0x02   | 4    | offset     | u32, blob start relative to SAMPLE_BANK payload |
| 0x06   | 4    | length     | u32, bytes                                   |
| 0x0A   | 2    | base_rate  | u16, playback rate in Hz at C4               |
| 0x0C   | 4    | loop_start | u32, byte offset into the sample             |
| 0x10   | 4    | loop_end   | u32, byte offset into the sample             |

Samples are mono 8-bit signed PCM (stereo is downmixed at compile time).
Sample ids are assigned in IR declaration order. Note that a SAMPLE_BANK can
push a file past the 32KB window; PCM-heavy songs are an M2 concern and may
require the WIDE_OFFSETS escape or bank-splitting — decided in M2, not here.

## 11. VOICE_TABLE Section (0x0006) — reserved

> **Open decision — voice representation.** Today a full FM voice change
> compiles to ~30 same-tick `PARAM_SET` events (~90 stream bytes, 30
> dispatches). The recommended plan is: `mmlisp2mmb` coalesces full-voice
> bursts into VOICE_TABLE entries plus a `VOICE_SET` opcode, leaving the IR
> unchanged. The trade-off table and recommendation live in driver.md §10;
> the section id and the 0x14 `VOICE_SET` opcode slot (opcodes.md §5) are
> reserved either way so no renumbering is needed once decided.

## 12. Size Budget and Banking

- M1 constraint: **one MMB file ≤ one 32KB bank window** (0x8000–0xFFFF).
  The bank is latched at START_TRACK; all tracks of a playing MMB live in
  the same window (driver.md §5).
- The u16 `event_offset` in the track table encodes this limit structurally.
- Escape hatch (reserved, not implemented in v0.2): header flag
  WIDE_OFFSETS widens `event_offset` to u32 and permits multi-bank
  streaming. Any loader seeing this flag set must reject the file until a
  future version defines the mechanism.

## 13. Compatibility Policy

1. Loader must reject a file whose `version_major` is newer than it knows.
2. Loader may accept newer `version_minor` if no unknown header flags are
   set and no unknown REQUIRED sections are present.
3. Unknown section id: skip, unless its REQUIRED flag is set → reject.
4. Unknown header flag set → reject.
5. Unknown opcode inside a track stream → fail-safe: stop decoding that
   track, report error (opcodes.md §1 defines which opcodes a v0.2 M1
   decoder must be able to *skip* vs treat as unknown).

## 14. Validation Rules

Checked by `tools/scripts/verify-mmb.js` (and asserted by the JS reference
driver on load):

1. Magic, version, `header_size` = 12, directory in ascending id order.
2. All section offsets/sizes in bounds; sections non-overlapping;
   `section_count` matches the directory.
3. TRACK_TABLE, EVENT_STREAM, METADATA present.
4. Every `event_offset` in bounds; every track block reaches an
   `END_OF_TRACK` opcode without running off the section end.
5. Every `channel_id` is defined in §6.1; at most one track per channel per
   file; `isCsm`/`isFm3Op` flags consistent with channel ids.
6. Metadata entries valid UTF-8; required keys present.
7. VAL_TABLE `count` ≤ 16; every val-slot reference in the stream < count.
8. Every `sample_id` referenced by a PCM_NOTE_ON exists in SAMPLE_BANK;
   blob ranges in bounds; `loop_end` ≤ length.
9. Duration byte 0x00 only on NOTE_ON / PCM_NOTE_ON.
10. Deterministic output: recompiling the same IR yields identical bytes.
