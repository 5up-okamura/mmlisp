# GMLisp Command Table v0.1 Draft

This is a logical command table for compiler/runtime alignment.
Numeric opcode assignment is intentionally deferred until after demo-driven pruning.

## Core Commands

1. NOTE_ON
- Args: pitch, length(optional if inherited), flags
- Effect: start note event

2. REST
- Args: length
- Effect: advance time without note

3. TIE
- Args: length
- Effect: extend current note duration

4. TEMPO_SET
- Args: bpm or fixed-step value
- Effect: update tempo accumulator increment

5. LOOP_BEGIN
- Args: optional loop id
- Effect: mark loop start

6. LOOP_END
- Args: repeat count or conditional behavior
- Effect: branch to loop start

7. PARAM_SET
- Args: target, absolute value
- Effect: set base parameter value

8. PARAM_ADD
- Args: target, delta value
- Effect: apply relative parameter change

9. MARKER
- Args: marker id
- Effect: publish timeline marker

10. JUMP
- Args: destination marker/id
- Effect: branch control flow

## Reserved Commands (v0.2 focus)

1. CSM_ON
2. CSM_OFF
3. CSM_RATE
4. FM3_MODE
5. REG_WRITE

## Notes

- Commands should preserve base/delta semantics.
- Real opcode bytes will be assigned only after command usage is validated with demo songs.
- Binary format should keep extension room for reserved commands.
