# GMLDRV Decoder Contract v0.1 Draft

This document defines the draft contract expected by a future GMLDRV decoder
for current GMB artifacts produced by gmlisp-tools.

## 1. Input Expectations

1. Magic must be `GMB0`.
2. Version must be `0.1` for current draft artifacts.
3. Section directory must contain at least:
   - TRACK_TABLE (0x0001)
   - EVENT_STREAM (0x0002)
   - METADATA (0x0003)

## 2. Track Table Contract

Track entry fields:

1. track_id: uint16
2. channel_id: uint16
3. event_offset: uint32
4. event_length: uint32

Decoder requirements:

1. Reject out-of-range event offsets.
2. Treat unknown channel ids as unsupported track mapping.
3. Do not read beyond `event_length`.

## 3. Event Stream Contract (Current Draft)

Each event record is encoded as:

1. tick: uint32 little-endian
2. opcode: uint8
3. payload_len: uint16 little-endian
4. payload: UTF-8 JSON bytes for args

Known opcodes in draft writer:

1. 0x10 NOTE_ON
2. 0x11 REST
3. 0x12 TIE
4. 0x40 LOOP_BEGIN
5. 0x41 LOOP_END
6. 0x42 MARKER
7. 0x43 JUMP
8. 0x60 PARAM_SET
9. 0x61 PARAM_ADD
10. 0x80 TEMPO_SET

## 4. Error Handling Policy

1. Unknown section id: skip unless marked required by future flags.
2. Unknown opcode: fail-safe stop track decode.
3. Malformed payload JSON: treat as decode error.
4. Invalid loop structure at decode time: stop track and report error.

## 5. Planned Tightening Before Freeze

1. Replace JSON payload with packed binary args.
2. Freeze opcode table and arg packing format.
3. Define strict error codes shared by tools and driver.
4. Add cross-check fixtures for decoder compatibility.
