# MMLisp v0.1 Draft Specification

Document status: draft
Target freeze: v0.1

## 1. Purpose

MMLisp targets interactive game music where composition, sound effects, and game state can dynamically influence each other.

v0.1 prioritizes:

- Authoring workflow and expressive control
- Stable intermediate representation (IR)
- Practical constraints awareness before hardware driver implementation

v0.1 does not aim to be feature-complete for YM2612 edge cases. The goal is
to lock a minimal, proven authoring-to-binary contract.

## 2. Product Components

- MMLisp Live: web authoring environment
- MMLisp compiler: source to IR/binary conversion
- MMLispDRV: playback driver for SGDK/Mega Drive (post-freeze implementation)

Primary development order for v0.1:

1. MMLisp Live authoring and playback validation
2. Compiler IR and GMB output stabilization
3. Driver-oriented compatibility checks
4. MMLispDRV implementation after freeze

## 3. Timebase

- Internal resolution: 120 ticks per beat
- Tempo stepping: fixed-point accumulator
- Tuplet support target: 2..8 divisions without frame-locking artifacts

Timing requirements:

1. Tick progression must remain deterministic for identical input and seed
2. Tempo multiplier changes must apply at explicit command boundaries
3. Offline export and live preview must produce equivalent event timing

## 4. Control Model

All runtime-modulatable values use a split model:

- base: score-defined value
- delta: runtime/game-driven offset
- final = base + delta

Recovery behavior:

- With intervention: target follows game value
- Without intervention: target returns to base
- Smoothing: first-order low-pass style update

Control requirements:

1. base is always score-owned state
2. delta is always runtime-owned state
3. final is derived state and must not be directly serialized as authority
4. smoothing speed must be explicitly represented in data where used

## 5. v0.1 Language Scope (minimum)

- def / defn (compile-time constants and template macros)
  - see subsection below
- score / track / phrase blocks
- note / rest / tie
- notes (sugar: batch note/rest sequence)
- tuplet (sugar: equal-division note/rest sequence into a fixed total duration)
- tempo set and multiplier
- loop begin/end
- parameter set/add (multiple KV pairs per call supported)
- marker and jump
- track-level channel hints (`:ch`)
- track role and write-scope declaration (`:role`, `:write`)
- direct register write via REG_WRITE IR op
- FM3 independent-operator mode via FM3_MODE IR op

Track role model:

1. `:bgm` — default; owns note-on/off; long-term channel tenant
2. `:se` — can evict `:bgm` tracks from channels; traditional sound-effect behavior
3. `:modulator` — overlays FM parameters on current channel occupant without eviction; multiple modulators may stack on one channel
4. `:chaos` — no ownership claims; writes freely to any reachable channel; intentional undefined behavior is permitted

Write scope (`:write`) declares which register classes a track may touch:

1. `:notes` — key-on/off and frequency (F-number)
2. `:fm-params` — operator parameters (TL, op-ratio, AR, DR, RR, SL)
3. `:ctrl` — control parameters (tempo-scale, volume)
4. `:reg` — raw YM2612 register writes
5. `:any` — all of the above (default)

Operator pitch abstraction (`:op-ratio`):

ML and DT are unified as a single fixed-point decimal.
0.5 = ×0.5 (ML=0), 1.0 = unison (ML=1), 2.0 = octave (ML=2), etc.
Fractional part encodes DT direction and magnitude.
The compiler quantizes to the nearest valid (ML, DT) pair per frame.
Pitch envelopes are authored as PARAM_ADD sequences targeting `:op1-ratio` through `:op4-ratio`.
MMLisp macros such as `pitch-glide` can generate these sequences at authoring time.

`notes` sugar syntax:

`(notes :c4 :e4 _ :g4)` expands to individual `(note ...)` and `(rest ...)` calls
using the enclosing phrase `:len` as default length. `_` denotes a rest.
An optional `:len` keyword overrides the default length locally:
`(notes :len 1/16 :c4 :e4 _ :g4)`.
This is a source-level sugar; the compiler expands it to NOTE_ON and REST IR
events before output. `note` remains the canonical form for single notes,
notes with individual lengths, or notes interleaved with non-note commands.

`tuplet` sugar syntax:

`(tuplet <total-len> :c4 :e4 :g4)` divides `total-len` equally among all
elements and emits a NOTE*ON or REST per element. `*` denotes a rest.

Rules:

1. The first argument is a length value (e.g. `1/4`, `1/8`). If omitted the
   phrase default length is used as the total duration.
2. Each element receives `floor(total / n)` ticks; any remainder ticks are
   added to the final element.
3. `_` expands to REST; a note keyword (`:c4`) expands to NOTE_ON.
4. Expansion happens before IR emission; no dedicated IR command exists.

Example — quarter-note triplet: `(tuplet 1/4 :c4 :e4 :g4)`
→ three NOTE_ON events each 40 ticks (120 ticks total).

`param-set` / `param-add` multiple KV syntax:

A single call can set or add multiple targets at once:
`(param-set :fm-fb 2 :fm-tl1 40 :fm-tl2 19)`.
Each keyword-value pair emits a separate PARAM_SET (or PARAM_ADD) IR event
at the same tick. The single-pair form remains valid.

`def` / `defn` compile-time expansion:

`(def name value)` binds a compile-time constant. All occurrences of `name` in
subsequent forms are replaced with `value` before compilation.

`(defn name [params] body...)` defines a template macro. A call `(name arg1 arg2)`
is expanded by substituting params in the body. Rules:

1. `def` and `defn` must appear at top level, before `(score ...)`
2. `defn` may call other `defn` (chain expansion is supported)
3. Recursive expansion is rejected; depth limit is 16
4. Expansion is purely compile-time; no IR commands are emitted for `def`/`defn`
5. `def` values must be literals (numbers or keywords); `defn` bodies are arbitrary forms

Example:

```
(def main-tempo 120)
(defn trill [a b len]
  (note a len) (note b len))

(score ...
  (phrase :riff :tempo main-tempo
    (trill :c4 :e4 1/16)))
```

Non-goals for v0.1 language:

1. Full macro language parity with historical MML ecosystems
2. Full CSM authoring syntax

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
- FM3_MODE
- REG_WRITE

Reserved for v0.2:

- CSM_ON / CSM_OFF / CSM_RATE

See: docs/ir.md

## 7. Binary Format (GMB) Draft

- Header with version
- Feature flags bitfield
- Track table
- Event stream section
- Metadata section
- Reserved bytes for forward compatibility

See: docs/gmb.md

## 8. Validation Rules

- Compile fails on unsupported commands
- No silent downgrade behavior
- Diagnostics include line and column

Validation classes:

1. Parse errors: invalid syntax and malformed literals
2. Semantic errors: unknown marker, invalid loop target, illegal parameter target
3. Capability errors: command requires feature not enabled in target profile

## 9. Freeze Gate for v0.1

All conditions should pass:

1. At least two demo songs completed in MMLisp Live
2. Loop and marker behavior stable under repeated playback
3. base/delta recovery behavior audibly consistent
4. IR command set proven minimal and sufficient
5. GMB layout validated against future driver needs

Freeze artifacts required in repository:

1. At least two demo source files
2. Their exported IR snapshots
3. Their exported GMB files
4. A freeze review note summarizing accepted exclusions

## 10. SGDK/MMLispDRV Timing

Driver implementation starts after v0.1 freeze, but format decisions must remain driver-oriented from day one.

Driver readiness criteria before implementation starts:

1. IR command set is stable for one review cycle
2. GMB section layout has no unresolved blocking items
3. Required runtime state for base/delta playback is represented in data

## 11. v0.1 Deliverables

1. Language subset spec (this document)
2. Command table draft
3. IR format draft
4. GMB binary draft
5. Freeze checklist
6. Demo-driven validation notes

## 12. Change Policy

1. Draft documents can change freely until freeze candidate is announced
2. Once freeze candidate is announced, all breaking changes require rationale
3. After freeze, incompatible changes must target v0.2
