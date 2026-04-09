# GMLisp Command Table v0.1 Draft

This is a logical command table for compiler/runtime alignment.
Numeric opcode assignment is intentionally deferred until after demo-driven pruning.

Execution model assumptions:

1. Commands are processed in tick order
2. Channel-local command order is preserved
3. Missing optional length means length inheritance is used

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

- Args: target, absolute value
- Effect: set base parameter value
- Validation: target must be supported in v0.1 profile

8. PARAM_ADD

- Args: target, delta value
- Effect: apply relative parameter change
- Validation: target must be supported in v0.1 profile

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

See also:

1. docs/spec-v0.1-draft.md
2. docs/ir-v0.1-draft.md
3. docs/gmb-format-v0.1-draft.md
