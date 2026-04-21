# MMLisp Command Table v0.1 Draft

This is a logical command table for compiler/runtime alignment.
Numeric opcode assignment is intentionally deferred until after demo-driven pruning.

Execution model assumptions:

1. Commands are processed in tick order
2. Channel-local command order is preserved
3. Missing optional length means length inheritance is used

Default values:

1. phrase `:len` — `1/8` (60 ticks at PPQN=120) when not specified
2. `note` / `rest` / `tie` length — inherits phrase `:len` when omitted
3. track `:ch` — auto-increment by track index (track 0 → fm1, track 1 → fm2, …) when not specified
4. track `:role` — `bgm` when not specified
5. track `:write` — `[:any]` when not specified

## Core Commands

1. NOTE_ON

- Args: pitch, length(optional), flags(optional)
- Effect: start note event on current channel
- Validation: pitch range and effective length must be legal

2. REST

- Args: length
- Effect: advance time without note
- Validation: length must be greater than zero

3. TIE

- Args: length
- Effect: extend current note duration
- Validation: requires an active or immediately preceding note context

4. TEMPO_SET

- Args: bpm or fixed-step value
- Effect: update tempo accumulator increment
- Validation: value must map to valid accumulator increment

5. LOOP_BEGIN

- Args: optional loop id
- Effect: mark loop start
- Validation: nesting depth must stay within implementation limit

6. LOOP_END

- Args: repeat count or conditional behavior
- Effect: branch to loop start
- Validation: must match a valid loop begin

7. PARAM_SET

- Args: target, absolute value (repeatable as KV pairs)
- Effect: set base parameter value; multiple targets per source call supported
- Validation: each target must be supported in v0.1 profile

8. PARAM_ADD

- Args: target, delta value (repeatable as KV pairs)
- Effect: apply relative parameter change; multiple targets per source call supported
- Validation: each target must be supported in v0.1 profile

9. MARKER

- Args: marker id
- Effect: publish timeline marker
- Validation: marker id must be unique in marker namespace policy

10. JUMP

- Args: destination marker/id
- Effect: branch control flow
- Validation: destination must resolve during compile

## Canonical Target Set (v0.1)

1. NOTE_PITCH
2. NOTE_VOLUME
3. TEMPO_SCALE
4. FM_FB
5. FM_TL1
6. FM_TL2
7. FM_TL3
8. FM_TL4

Additional targets are allowed only through profile extension and must not be
assumed by default.

## Source Sugar Forms

These forms are compiled away before IR emission. No opcode is assigned.

1. `notes` — batch note/rest sequence using phrase default length per element
2. `tuplet` — equal-division sequence into a fixed total duration (remainder to last element)

## Reserved Commands (v0.2 focus)

1. CSM_ON
2. CSM_OFF
3. CSM_RATE
4. FM3_MODE
5. REG_WRITE

Reserved command policy:

1. Parser may accept behind feature flag
2. Compiler must reject in strict v0.1 export mode
3. Binary opcode space must retain room for these commands

## Notes

- Commands should preserve base/delta semantics.
- Real opcode bytes will be assigned only after command usage is validated with demo songs.
- Binary format should keep extension room for reserved commands.

## Draft Opcode Table (Current Implementation)

This table reflects current writer/validator behavior and is a freeze candidate
for v0.1.

1. `0x10` NOTE_ON (payload 3 bytes: pitch:u8, length:u16)
2. `0x11` REST (payload 2 bytes: length:u16)
3. `0x12` TIE (payload 2 bytes: length:u16)
4. `0x40` LOOP_BEGIN (payload 1 byte: loop_id:u8)
5. `0x41` LOOP_END (payload 2 bytes: loop_id:u8, repeat:u8)
6. `0x42` MARKER (payload 1 byte: marker_id:u8)
7. `0x43` JUMP (payload 1 byte: marker_id:u8)
8. `0x60` PARAM_SET (payload 3 bytes: target_id:u8, value:i16)
9. `0x61` PARAM_ADD (payload 3 bytes: target_id:u8, delta:i16)
10. `0x80` TEMPO_SET (payload 2 bytes: bpm:u16)

## Target ID Table (Current Implementation)

1. `0x01` NOTE_PITCH
2. `0x02` NOTE_VOLUME
3. `0x03` TEMPO_SCALE
4. `0x10` FM_FB
5. `0x11` FM_TL1
6. `0x12` FM_TL2
7. `0x13` FM_TL3
8. `0x14` FM_TL4

See also:

1. docs/spec-v0.1.md
2. docs/ir.md
3. docs/gmb.md
