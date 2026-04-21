# MMLisp IR v0.1 Draft

This document defines the intermediate representation (IR) produced by the
MMLisp compiler before binary serialization.

## 1. Goals

1. Deterministic event representation for preview and export
2. Minimal command set aligned with v0.1 language scope
3. Stable bridge between source language and GMB binary

## 2. IR Unit Model

IR is represented as a song object with one or more tracks.

Song fields:

1. version: integer
2. ppqn: integer (fixed at 120 in v0.1)
3. tempo_base: fixed-point increment baseline
4. tracks: array of track objects
5. metadata: key-value map

Track fields:

1. id: integer
2. name: string
3. channel: preferred legacy channel id (for backward compatibility)
4. route_hint: routing hint object
5. events: sorted array of event objects

route_hint fields:

1. allocation_preference: string (v0.1 default: ordered_first_fit)
2. channel_candidates: ordered array of logical channel names
3. role: string enum (bgm | se | modulator | chaos; default: bgm)
4. write_scope: array of strings (notes | fm-params | ctrl | reg | any; default: [any])

Event fields:

1. tick: uint32 (absolute tick)
2. cmd: enum
3. args: tuple/object command payload
4. src: source location {line, column}

## 3. Command Set (v0.1)

1. NOTE_ON
2. REST
3. TIE
4. TEMPO_SET
5. LOOP_BEGIN
6. LOOP_END
7. PARAM_SET
8. PARAM_ADD
9. MARKER
10. JUMP
11. FM3_MODE
12. REG_WRITE

Reserved for v0.2:

1. CSM_ON
2. CSM_OFF
3. CSM_RATE

## 4. Normalization Rules

1. All event ticks in a track are non-decreasing
2. Same-tick events preserve source order
3. Inherited lengths are expanded to explicit runtime length metadata
4. Marker references are resolved to canonical marker ids
5. Tempo values are converted to fixed-point increments in IR

## 5. Runtime Semantics Mapping

base/delta rule mapping:

1. PARAM_SET mutates base value
2. PARAM_ADD mutates delta value when target is runtime-modulatable
3. final value is runtime-derived and not stored as authoritative IR state

Loop behavior:

1. LOOP_BEGIN and LOOP_END define structural loop frames
2. Repeat counts are normalized to explicit integer counters
3. Invalid nesting is rejected at compile stage

## 6. Validation Output Contract

Compiler emits diagnostics as structured records:

1. severity: error or warning
2. code: stable diagnostic code string
3. message: human-readable description
4. line: 1-based
5. column: 1-based
6. hint: optional remediation message

## 7. Determinism Requirements

Given identical source, options, and compiler version:

1. IR output must be byte-identical when serialized to canonical JSON form
2. Event order must be stable
3. Marker id assignment must be stable

## 8. Canonical JSON Snapshot (for tests)

The implementation should provide a canonical JSON snapshot mode for regression
tests.

Required canonicalization:

1. Object keys sorted lexicographically
2. Track list sorted by track id
3. Event list sorted by tick and source order index
