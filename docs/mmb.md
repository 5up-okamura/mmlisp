# MMB v0.3 Container Format

This document, with `docs/opcodes.md` (opcodes and targets) and
`docs/driver.md` (the driver), defines what the exporter writes and the
driver reads. Event and target vocabulary comes from `docs/ir.md`; MMB is the
binary lowering of that IR.

MMB v0.3 replaces every earlier draft entirely. There is no compatibility path
(no legacy support): a loader accepts its own version and nothing else.

## 1. Goals

1. **Decodable in place.** The sequencer (68000) reads the file directly from
   ROM. Locating any structure is pointer walking only — fixed-size headers
   and offset fields, no parsing, no allocation, no relocation.
2. **Compact.** Events are byte-packed with no per-event tick or length
   prefixes (§7).
3. **Deterministic.** Identical IR input produces byte-identical MMB output.
4. Clear version negotiation and fail-safe handling of unknown content.

## 2. Conventions

1. Endianness: **little-endian** for all multi-byte fields.
2. Section starts are 2-byte aligned (zero padding between sections).
   Structures *inside* a section are byte-packed; readers access multi-byte
   fields a byte at a time.
3. "Reserved" fields must be written as zero and ignored on read.
4. Offsets are relative to the structure named in the field description,
   never absolute file positions, so the file works at any address.

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
| 0x05   | 1    | version_minor | 3                                    |
| 0x06   | 2    | flags         | u16, see below                       |
| 0x08   | 2    | section_count | u16                                  |
| 0x0A   | 2    | header_size   | u16, = 12                              |

There is no checksum field. Integrity checking is a 68k-side loader concern (checksum the ROM region however the game likes); the
driver never verifies checksums.

Header flags:

| Bit  | Name         | Meaning                                              |
| ---- | ------------ | ---------------------------------------------------- |
| 0    | WIDE_OFFSETS | **Reserved.** When set, track-table `event_offset` widens to u32 and the file may exceed 32 KB. Must be 0; loaders reject it (see §12). |
| 1    | PAL_TIMEBASE | The score's frame-counted numbers — the tempo increment and every macro, sweep and delay length — were baked for a **50 Hz** frame clock (driver.md §3.3). The driver reads no frame rate, so this is what tells a host which machine the score belongs on. |
| 2–3  | PCM_VOICES   | The score's PCM voice count, 0–3: which engine image plays it (driver.md §5) and so the rate its sample bank is baked at (§10). |
| 4 | MULTIBANK_PCM | Selects multi-bank PCM for up to three voices on NTSC or PAL; PAL_TIMEBASE selects the region-specific engine (§10.3). |
| 5–15 | — | Reserved, must be 0. |

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
| 0x0004 | —           | unused (the sample bank is its own ROM bank, §10) |
| 0x0005 | VAL_TABLE   | optional (§8)                       |
| 0x0006 | VOICE_TABLE | optional (§11)                      |
| 0x0007 | MACRO_TABLE | optional (§15)                      |
| 0x0008 | SE_TABLE    | optional (§16); the score's sound effects (def-se) |

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
| 2   | isFm3Op | fm3 independent-operator sub-track (channel 16–19) |
| 3   | isSe    | a sound effect's part (def-se, §16): started by the host by the effect's number, never with the song; its TEMPO_SET sets its own clock (driver.md §2.5) |
| 4–7 | —       | Reserved, must be 0                                |

`event_offset` is u16, and the encoder limits the whole MMB to 32 KB (§12).
Larger songs are deferred behind the reserved WIDE_OFFSETS header flag (§4);
the encoder rejects output that would overflow u16 offsets.

### 6.1 Channel id map

`live/src/mmb.js` `CHANNEL_ID` / `resolveChannelId`. Ids are frozen:

| Id    | Channel        | Hardware                              |
| ----- | -------------- | ------------------------------------- |
| 0–5   | fm1–fm6        | YM2612 FM channels 1–6                |
| 6–8   | sqr1–sqr3      | SN76489 square 1–3                    |
| 9     | noise          | SN76489 noise                         |
| 10–15 | —              | reserved                              |
| 16–19 | fm3 op1–op4    | YM2612 ch3 special mode, one id per operator (driver.md §13.4) |
| 20–22 | pcm1–pcm3      | PCM voices on the fm6 DAC (driver.md §14) |
| 23–255| —              | reserved                              |

## 7. EVENT_STREAM Section (0x0002)

Per-track event blocks are contiguous, byte-packed, in track-table order.
Each block starts at its `event_offset` and ends at its `END_OF_TRACK`
opcode (0x00); the track entry carries no length.

### 7.1 Delta/duration encoding

Events carry **no time and no length prefix**:

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
`PSG_MASTER_CLOCK`). The JS reference builds both tables from that same code,
and `drv/tools/gen-c-tables.mjs` emits them as C for the 68k sequencer
(driver.md §8, §12.6). Fractional/cent pitch never appears in the
stream; pitch bends are `PARAM_SWEEP NOTE_PITCH` events executed by the
driver's sweep engine (M2).

### 7.4 Parameter values

Targets are u8 ids (opcodes.md §7). A parameter value is **i8 when the
target's clamp range fits in i8, i16 otherwise**; the width is a fixed
per-target property listed in the target table, known to both encoder and
decoder (the driver holds a width bitmap in ROM). In practice every target
except `NOTE_PITCH` (cents, ±32767) is i8.

### 7.5 TEMPO_SET payload

BPM never reaches the driver. `TEMPO_SET` carries the precomputed per-frame
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

## 9. METADATA Section (0x0003)

Key-value entries, repeated:

```
key_len   : u8
key       : key_len bytes, UTF-8
value_len : u16
value     : value_len bytes, UTF-8
```

Required keys: `title`, `composer`, `author`, `compiler_version`. Optional keys include
`bpm` (display-only, see §7.5) and val-slot names. **The driver ignores this
section entirely**; it exists for hosts and tools.

## 10. SAMPLE_BANK (separate ROM bank)

PCM data for `def-pcm` defs (docs/language.md §9, §16). **This is not an MMB
section — it is a separate ROM resource**, so PCM blobs never crowd the MMB.
The default format occupies one 32 KB bank; the multi-bank format is described
in §10.3. The
exporter (`encodeMmb`) returns it separately (`{ bytes, sampleBank }`); the host
points the Z80's window at it (SGDK: `MMLisp_setSampleBank(song_smp)` after
`MMLisp_init`, which also hands the sequencer the directory); the engine then
reads sample bytes through the window (driver.md §5.4). Section id 0x0004 is
unused. Both exporters write the bank as a `.smp` sidecar next to the `.mmb`
(`drv/tools/mmb-build.mjs` by name, the live app's File > Export > MMB… by a
second save dialog opened in the `.mmb`'s folder) — a PCM song is the pair.
Default single-bank structure:

```
entry_count : u16
bake_stamp  : u16   the DAC rate, rounded, of the engine image the blobs are baked for
entries     : entry_count × 24 bytes
blobs       : raw sample data (8-bit signed PCM), byte-packed
padding     : zeros to 0x8000 — the file is always exactly 32 KB
```

**The file is a whole 32 KB and its top page is silence.** A parked PCM voice
(driver.md §5.3) reads window `$FF00` — bank offset `$7F00..$7FFF` — so that
page must be zero (signed silence) and must be the bank's own, not whatever
rescomp places after a shorter blob. The exporter therefore refuses a payload
that reaches `$7F00` and pads the file to `$8000`; the BIN resource is
`BIN song_smp "song.smp" 32768` (aligned, uncompressed).

`bake_stamp` is the rounded DAC rate of the image named by the header's
PCM_VOICES (§4; `pcm1` for a score without PCM), and a loader **refuses a bank
whose stamp is not its image's** (`mml_load_samples` returns -3). Baked data is
bound to the rate it was baked for; played under another the pitch is quietly
wrong, which is the least debuggable failure there is.

Sample entry (24 bytes):

| Offset | Size | Field      | Notes                                        |
| ------ | ---- | ---------- | -------------------------------------------- |
| 0x00   | 1    | sample_id  | u8, referenced by PCM_NOTE_ON                |
| 0x01   | 1    | flags      | bit0 = the def set a range; bit1 = it set a loop start; bit2 = a loop end; bits3–7 reserved |
| 0x02   | 2    | —          | reserved, 0                                  |
| 0x04   | 4    | offset     | u32, blob start relative to the blob region (past the entry table) |
| 0x08   | 4    | length     | u32, bytes — a whole number of 16-byte blocks |
| 0x0C   | 4    | src_frames | u32, the source slice's frame count, after its `:fx` chain |
| 0x10   | 2    | range_start | u16, the range's start: baked byte offset into the blob, unrounded |
| 0x12   | 2    | range_end   | u16, the range's end |
| 0x14   | 2    | loop_start  | u16, the loop's start, inside the range |
| 0x16   | 2    | loop_end    | u16, the loop's end, inside the range |

### 10.1 Pitch baking

Every entry is baked for one note: the source slice, run through the def's
`:fx` chain (language.md §16) in float, resampled (linear) to the rate at
which that note advances *exactly one byte a DAC sample* at the image's rate —
`rate / 2^((note − 60) / 12)` — quantized to signed 8-bit once, and padded with
silence to whole 16-byte blocks. The engine does not resample and has no octave step (driver.md §14.2),
so a sample played at several notes occupies several ids, deduplicated by
content hash.

Every entry carries four points: the range a shot plays once, and the loop
inside it a held loop note repeats — the NOTE decides which it is (opcodes.md
§6, PCM_NOTE_ON). They are the def's `:pcm-*` and `:loop-*` — times in the
sample's own recording — turned into byte offsets by the note's own bake rate,
and stored unrounded; the sequencer rounds them to whole blocks when it sends
them (driver.md §14). A def with no range, or a range that maps to nothing
(`W_MMB_BAKE_RANGE_EMPTY`), stores the whole sample: `range_start` 0,
`range_end` its baked length. A loop point the def did not set stores the
range's (its flag clear, so a track's range write moves it too); a loop that
maps to nothing (`W_MMB_BAKE_LOOP_EMPTY`) stores the whole range. Every point
fits u16: a blob lies inside the 32 KB window. `src_frames` is the source
slice's length after its effects (a fade shortens it), carried for tooling; nothing in the driver reads it.

Samples are mono 8-bit signed PCM (stereo is downmixed at compile time).
In the default format, the **bank image (entry table + blobs) must fit one 32 KB window, below its
silent top page**: the engine addresses a sample by its 16-bit window address.
`encodeMmb` automatically selects §10.3 for a larger eligible bank (up to three voices on NTSC or PAL), unless multi-bank output is explicitly disabled. Other profiles
retain the single-bank limit.

### 10.2 One bank for several scores

A bank is not tied to the MMB that was built with it: the MMB carries only
entry ids, and the host re-publishes whatever bank it holds on every load
(driver.md §2.3). `drv/tools/bundle.mjs` builds N scores against ONE bank —
`createSampleBankBuilder` in `export-mmb.js` plans every score's `(sample,
note)` pairs into the same entry table, deduplicated by content (bytes, flags,
range), and hands each score the ids it ends up with. Two conditions,
both enforced by the bundle: every score uses the **same PCM voice count
and engine profile**, and the combined library fits that profile's capacity.
Single-bank bundles must fit one window; eligible bundles can expand to
§10.3. Standalone single-bank exports that fit remain byte-identical.

### 10.3 Multi-bank sample resources

Header flags bit 4 (`MULTIBANK_PCM`) selects the block-rendering engine for NTSC and PAL scores with up to three PCM voices. Bit 15 of the SMP rate stamp identifies the multi-bank format; the lower 15 bits contain the selected engine's rounded rate: 10112 (NTSC, one/two voices), 10019 (PAL, one/two voices), 6653 (NTSC, three voices), or 6593 (PAL, three voices). The directory occupies the first 32 KiB, and offsets in its 24-byte entries are relative to the following 32 KiB boundary. Files contain whole 32 KiB banks, each with a final 256-byte silence page. Blobs are aligned to 16 bytes and cannot cross banks. The loader rejects mismatched score/sample formats and rates. The first two voices stage bank words at STORE ops `0x1c/0x1d` and `0x1e/0x1f`; the third stages its bank byte at `0x21`. The third bank has no high byte because the supported 4 MiB aperture needs only seven bank bits. Protocol version 14 includes this assignment. See [Multi-bank PCM](pcm-multibank.md) for details.

## 11. VOICE_TABLE Section (0x0006)

Deduplicated FM voices, referenced by `VOICE_SET` (opcodes.md §5). The
export-time coalescing pass (driver.md §10) folds a same-tick group of
PARAM_SETs covering a full voice into one entry here + a `VOICE_SET`; the IR is
unchanged. Structure:

```
entry_count : u16
entries     : entry_count × 29 bytes
```

Voice entry (29 bytes), laid out in register-write order so the driver copies
a block into the operator shadow and queues the writes with no per-field logic:

| Offset | Size | Registers | Contents                                          |
| ------ | ---- | --------- | ------------------------------------------------- |
| 0x00   | 4    | $30+op    | DT/MUL, op1–op4                                    |
| 0x04   | 4    | $40+op    | TL, op1–op4 (voiced base; the level model recomposes carrier TL from vel/vol/master, driver.md §7) |
| 0x08   | 4    | $50+op    | KS/AR, op1–op4                                     |
| 0x0C   | 4    | $60+op    | AM enable / DR, op1–op4                            |
| 0x10   | 4    | $70+op    | SR (D2R), op1–op4                                  |
| 0x14   | 4    | $80+op    | SL/RR, op1–op4                                     |
| 0x18   | 4    | $90+op    | SSG-EG, op1–op4                                    |
| 0x1C   | 1    | $B0       | FB/ALG                                            |

`$B4` (pan / AMS / FMS) is **not** part of a voice — it is performance state
set separately. Voice ids are assigned in the coalescing pass's discovery
order; identical voices dedup to one entry.

Detection rule (exporter): a same-tick PARAM_SET group covering the full voice
parameter set (28 operator params + ALG/FB) becomes a `VOICE_SET`; partial
groups stay as PARAM_SETs (driver.md §10).

A `VOICE_SET` that sits immediately after a backward-JUMP target is emitted
**before** it when the loop body cannot disturb the voiced registers, so looping
does not re-apply it every iteration (driver.md §10.1). The JUMP target is the
offset the label resolved to — labels emit no bytes of their own (opcodes.md
§0x42) — so the hoist simply moves the `VOICE_SET` ahead of that offset.

## 12. Size Budget and Banking

The sequencer reads the MMB as a plain 68k ROM pointer, so these are encoder
limits, not hardware ones; relaxing them needs no driver change beyond
`WIDE_OFFSETS`.

- **One MMB file ≤ 32 KB**, enforced by the encoder.
- The u16 `event_offset` in the track table encodes this limit structurally.
- Escape hatch (reserved, not implemented): header flag
  WIDE_OFFSETS widens `event_offset` to u32 and permits a larger file. Any loader seeing this flag set must reject the file until a
  future version defines the mechanism.

## 13. Compatibility Policy

1. Loader must reject a file whose `version_major` is newer than it knows.
2. Loader may accept newer `version_minor` if no unknown header flags are
   set and no unknown REQUIRED sections are present.
3. Unknown section id: skip, unless its REQUIRED flag is set → reject.
4. Unknown header flag set → reject.
5. Unknown opcode inside a track stream → fail-safe: stop decoding that
   track, report error.

## 14. Validation Rules

Asserted by the JS reference driver on load (`live/src/drv-player.js`), and
by the C sequencer's loader where it can:

1. Magic, version, `header_size` = 12, directory in ascending id order.
2. All section offsets/sizes in bounds; sections non-overlapping;
   `section_count` matches the directory.
3. TRACK_TABLE, EVENT_STREAM, METADATA present.
4. Every `event_offset` in bounds; every track block reaches an
   `END_OF_TRACK` opcode without running off the section end.
5. Every `channel_id` is defined in §6.1; `isCsm`/`isFm3Op` flags
   consistent with channel ids. (Several tracks may share a channel: a song
   part and the effects' parts on it, or CH3's tracks.)
6. Metadata entries valid UTF-8; required keys present.
7. VAL_TABLE `count` ≤ 16; every val-slot reference in the stream < count.
8. Every `sample_id` referenced by a PCM_NOTE_ON exists in SAMPLE_BANK;
   blob ranges in bounds; `loop_end` ≤ length.
9. Duration byte 0x00 only on NOTE_ON / PCM_NOTE_ON.
10. Deterministic output: recompiling the same IR yields identical bytes.
11. Every `voice_id` (VOICE_SET) < VOICE_TABLE `entry_count`; every `macro_id`
    (MACRO_SET / NOTE_ON_EX macro_ref) < MACRO_TABLE `entry_count`; every macro
    descriptor's `blob_offset + count × width` is in bounds and
    `loop_start`/`release` are `0xFF` or ≤ `count`.

## 15. MACRO_TABLE Section (0x0007)

Deduplicated macro definitions (docs/language.md §10), referenced by index from
`MACRO_SET` / `NOTE_ON_EX` `macro_ref` (opcodes.md §5, §6). The exporter lowers
**every** macro form — step vector, curve, multi-stage — to one uniform shape
at compile time (driver.md §13): a per-`:step` value array in three regions
(attack / sustain-loop / release). The driver never evaluates a curve or easing
at macro time; it steps a cursor through the values. Structure mirrors
SAMPLE_BANK (fixed descriptors + a variable blob):

```
entry_count : u16
descriptors : entry_count × 8 bytes
blobs       : value arrays, byte-packed
```

Macro descriptor (8 bytes):

| Offset | Size | Field       | Notes                                            |
| ------ | ---- | ----------- | ------------------------------------------------ |
| 0x00   | 1    | target      | target id (opcodes.md §7); also fixes value width |
| 0x01   | 1    | flags       | bit0 = i16 values (only NOTE_PITCH); bit1 = additive (`:pitch+`/`:semi+` — driver composes each sample with the channel's live pitch offset instead of overwriting it); bit2 = scaled (`(* <LFO> $slot)` — driver multiplies each sample by a value slot read live per frame, §4.4; see the appended slot byte below); bit3 = tick clock (`step` counts the note's track ticks, driver.md §13.2); bits4–7 reserved 0 |
| 0x02   | 1    | step        | `:step` clock, 1–255: frames of the score's clock (§4: 60 or 50 Hz), or ticks when `flags` bit3 |
| 0x03   | 1    | loop_start  | step index the sustain loop begins; `0xFF` = one-shot (hold the last attack value) |
| 0x04   | 1    | release     | step index the release begins; `0xFF` = no release |
| 0x05   | 1    | count       | number of steps, 1–255                           |
| 0x06   | 2    | blob_offset | u16, into the blob region (relative to its start) |

The value blob is `count` values, i8 (or i16 if `flags` bit0), little-endian.
A `VEL` macro's values are **eighths of a step** (0…120; the exporter writes
`round(v × 8)`), the unit the driver holds a live velocity in (driver.md §7.1);
every other target's values are its own integers.
A **scaled** macro (`flags` bit2) appends one `scale_slot` byte immediately
after its `count` values (found at `blob_offset + count × width`); the
descriptor stays 8 bytes. Each frame the driver reads that value slot and writes
`(sample × (slot & 0xFF)) >> 8` — the low byte is a 0..255 depth (255 ≈ full,
256 ≈ ×1 is not representable), the multiply runs on the magnitude then
re-signs toward zero (§4.4). `scale_slot` = 0xFF is the `$time` frame counter,
0x00–0x0F a value slot. The **hold sentinel** `0x80` (i8) / `0x8000` (i16)
means "advance one step, write nothing" (the `_` token). The sentinel is NOT a
free value: NOTE_PITCH's range bottoms out at exactly −32768, so **the exporter
moves a real −32768 to −32767** (and −128 to −127) rather than let a macro
driven to its floor silently stop writing. One step of the target's own
resolution is inaudible; a dropped write is not. Gate: `m4-macro-floor`.
Regions inside the array:

```
[0 .. loop_start)        attack  — played once
[loop_start .. release)  sustain — cycled until key-off (empty if equal)
[release .. count)       release — played once after key-off
```

A macro holds at most 255 steps. The exporter samples a curve at the `:step`
clock; one that needs more is cut to 255 (`W_MMB_MACRO_TRUNCATED`), and a
step vector or a multi-stage macro past 255 is dropped
(`W_MMB_MACRO_SKIPPED`) — raise `:step` to fit. A multi-stage macro lowers as
the editor plays it: a looping stage is the sustain, and the stage after it is
the release even without a `(wait key-off)`.

## 16. SE_TABLE Section (0x0008)

The score's sound effects (`def-se`, language.md §9.3), by number — the
number the host plays one by (`MMLisp_playSe`, driver.md §2.5):

```
se_count : u8
entries  : se_count × 3 bytes — {prio u8, first_track u8, part_count u8}
```

An effect's parts are `part_count` consecutive tracks from `first_track`, each
flagged `isSe` (§6) and on the channel it takes from the song. The compiler
lays them out after the song's tracks, in def-se order (imports first), so a
bundle whose songs carry the same effects file numbers them alike. `prio` is
the def-se's `:prio`, the default the host may override.
