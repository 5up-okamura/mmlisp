# GMLisp v0.1 Draft Specification

## 1. Purpose

GMLisp targets interactive game music where composition, sound effects, and game state can dynamically influence each other.

v0.1 prioritizes:

- Authoring workflow and expressive control
- Stable intermediate representation (IR)
- Practical constraints awareness before hardware driver implementation

## 2. Product Components

- GMLisp Live: web authoring environment
- GML compiler: source to IR/binary conversion
- GMLDRV: playback driver for SGDK/Mega Drive (post-freeze implementation)

## 3. Timebase

- Internal resolution: 120 ticks per beat
- Tempo stepping: fixed-point accumulator
- Tuplet support target: 2..8 divisions without frame-locking artifacts

## 4. Control Model

All runtime-modulatable values use a split model:

- base: score-defined value
- delta: runtime/game-driven offset
- final = base + delta

Recovery behavior:

- With intervention: target follows game value
- Without intervention: target returns to base
- Smoothing: first-order low-pass style update

## 5. v0.1 Language Scope (minimum)

- score / part / phrase blocks
- note / rest / tie
- tempo set and multiplier
- loop begin/end
- parameter set/add
- marker and jump

## 6. Intermediate Representation (IR)

Required op families in v0.1:

- NOTE_ON
- REST
- TIE
- TEMPO_SET
- LOOP_BEGIN
- LOOP_END
- PARAM_SET
- PARAM_ADD
- MARKER
- JUMP

Reserved for v0.2:

- CSM_ON / CSM_OFF / CSM_RATE
- FM3_MODE
- REG_WRITE

## 7. Binary Format (GMB) Draft

- Header with version
- Feature flags bitfield
- Track table
- Event stream section
- Metadata section
- Reserved bytes for forward compatibility

## 8. Validation Rules

- Compile fails on unsupported commands
- No silent downgrade behavior
- Diagnostics include line and column

## 9. Freeze Gate for v0.1

All conditions should pass:

1. At least two demo songs completed in GMLisp Live
2. Loop and marker behavior stable under repeated playback
3. base/delta recovery behavior audibly consistent
4. IR command set proven minimal and sufficient
5. GMB layout validated against future driver needs

## 10. SGDK/GMLDRV Timing

Driver implementation starts after v0.1 freeze, but format decisions must remain driver-oriented from day one.
