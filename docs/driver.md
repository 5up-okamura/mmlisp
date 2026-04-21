# MMLDRV Decoder Contract v0.1 Draft

This document defines the draft contract expected by a future MMLDRV decoder
for current GMB artifacts produced by mmlisp-tools.

## 1. Input Expectations

1. Magic must be `MMB0`.
2. Version must be `0.1` for current draft artifacts.
3. Section directory must contain at least:
   - TRACK_TABLE (0x0001)
   - EVENT_STREAM (0x0002)
   - METADATA (0x0003)

## 2. Track Table Contract

Track entry fields:

1. track_id: uint16
2. channel_id: uint16 (resolved by compiler allocator for selected target profile)
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
4. payload: fixed binary args

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

Payload contract in current draft:

1. NOTE_ON: pitch:u8, length:u16
2. REST: length:u16
3. TIE: length:u16
4. TEMPO_SET: bpm:u16
5. LOOP_BEGIN: loop_id:u8
6. LOOP_END: loop_id:u8, repeat:u8
7. MARKER: marker_id:u8
8. JUMP: marker_id:u8
9. PARAM_SET: target_id:u8, value:i16
10. PARAM_ADD: target_id:u8, delta:i16

## 4. Error Handling Policy

1. Unknown section id: skip unless marked required by future flags.
2. Unknown opcode: fail-safe stop track decode.
3. Payload length mismatch for opcode: treat as decode error.
4. Invalid loop structure at decode time: stop track and report error.

## 5. Planned Tightening Before Freeze

1. Freeze opcode table and arg packing format.
2. Define strict error codes shared by tools and driver.
3. Add cross-check fixtures for decoder compatibility.
4. Add multi-track and channel mapping fixtures.

Current fixture coverage:

1. Valid demo1 and demo2 binaries
2. Invalid magic header fixture
3. Invalid payload length fixture
4. Invalid track event-range fixture
