# MMLisp v0.3 Design Notes

Document status: design-complete
Started: 2026-04-22
Finalized: 2026-04-22

This document captures decisions and open questions for v0.3, based on design
discussions following the v0.2 implementation (2026-04-22).

The central theme of v0.3 is **authoring model modernization**: making MMLisp
feel natural to write, not just structurally correct.

---

## Background: v0.2 status

v0.2 is implementation-complete. The following features are confirmed working:

- `Cmd+Enter` play/pause toggle, `Cmd+.` full stop (§spec-v0.2 §1.1)
- Cursor-line seek via source map (§spec-v0.2 §1.11)
- `def :fm` / `def :psg` named voice data (§spec-v0.2 §1.2, §1.7)
- `ins` command for voice loading
- `modulator` track role and `:carry` (§spec-v0.2 §1.3, §1.4, §1.9)
- PSG envelope sub-types: bare / `:seq` / `:adsr` (§spec-v0.2 §1.7)
- Score-level `:tempo` / `:lfo-rate` initial values (§spec-v0.2 §1.8)

Remaining v0.2 backlog (implementation, not spec):

- PWA top bar UI layout (§spec-v0.2 §2.7)
- GMB opcode table freeze and driver implementation (Phase 3)

---

## 1. Decided

### 1.1 Track as append stream (PMD-style authoring model)

**Motivation:** In v0.1/v0.2, `track` is a single container. Writing music
section-by-section requires either long monolithic tracks or complex `def`
aliasing. PMD-style notation (e.g. `A o3l8[cege]2`) allows the same track to
be written in time-ordered segments, making section structure visible in source.

**Decision:** A `track` form with a name that has already appeared earlier in
the same `score` appends its content to that track's event stream. The first
occurrence defines the track's channel and role; subsequent occurrences inherit
all attributes.

```lisp
(score :tempo 120

  ; ── Section A ──────────────────────────────────────
  (track :A :ch fm1 :oct 3 :len 1/8
    (x2 c e g e))

  (track :B :ch fm2 :oct 2 :len 1/8
    (x2 c c c c))

  (track :M :ch fm1 :role modulator
    (param-set :fm-tl4 30)
    (x8 (param-add :fm-tl4 +1)))

  ; ── Section B ──────────────────────────────────────
  (track :A                          ; inherits :ch fm1 :oct 3 :len 1/8
    (x2 f g a g))

  (track :B                          ; inherits :ch fm2 :oct 2 :len 1/8
    (x2 f f f f))

  (track :M                          ; inherits :ch fm1 :role modulator
    (param-set :fm-tl4 30)
    (x8 (param-add :fm-tl4 +1)))

)
```

**Compiled result:** identical event stream to writing each track as a single
block. The append model is purely an authoring-time convenience; IR output is
unchanged.

**Attribute inheritance rules for appended tracks:**

| Attribute | First occurrence | Appended occurrence                                       |
| --------- | ---------------- | --------------------------------------------------------- |
| `:ch`     | Required         | Inherited; re-specifying is an error (`E_TRACK_CH_REDEF`) |
| `:role`   | Default `:bgm`   | Inherited                                                 |
| `:oct`    | Default 4        | Inherited; inline `:oct` overrides locally                |
| `:len`    | Default `1/8`    | Inherited; inline `:len` overrides locally                |
| `:carry`  | Default `false`  | Inherited                                                 |

### 1.2 `phrase` abolished

`phrase` is removed as a required structural element. Track bodies contain
note/rest/control commands directly.

**v0.2 `phrase` responsibilities and their v0.3 replacements:**

| v0.2 phrase responsibility        | v0.3 replacement                                             |
| --------------------------------- | ------------------------------------------------------------ |
| `:len` default length scope       | `:len` on `track`; inline `:len` to change                   |
| `:tempo` setting                  | `(tempo N)` command inline in track body                     |
| `:carry` flag                     | `:carry` on `track`                                          |
| Reuse via `def riff (phrase ...)` | `defn` generating track content, or named `block` (see §1.5) |
| `marker` / `jump` for loops       | `marker` and `jump` at track level directly                  |

`phrase` is removed. The parser rejects it with `E_PHRASE_REMOVED`.

### 1.3 `note` and `notes` unified into `seq`

`note` (single note with optional explicit length) and `notes` (batch with
shared length) are replaced by a single `seq` form that maintains inline state.

```lisp
(seq :oct 4 :len 1/8  c e g c
     :len 1/4          e
     :oct 5 :len 1/8   c e g)
```

Inline state modifiers within `seq`:

| Modifier    | Meaning                                                            | Scope       |
| ----------- | ------------------------------------------------------------------ | ----------- |
| `:oct N`    | Set current octave (0–8)                                           | Persistent  |
| `:len val`  | Set current length (fraction `1/4`, denominator `4`)               | Persistent  |
| `:gate val` | Set gate ratio (`0.0`–`1.0`) or percent (`80%`)                    | Persistent  |
| `_`         | Rest (uses current `:len`)                                         | Single step |
| `~`         | Tie: extend by current `:len`; `~ 1/2` overrides len               | Single step |
| `>`         | Octave up by 1                                                     | Persistent  |
| `<`         | Octave down by 1                                                   | Persistent  |
| `(a b c)`   | Subgroup: divide current `:len` equally among elements (Bresenham) | Single slot |

Note names within `seq` are bare symbols without the `:` keyword prefix and
without an octave suffix — octave is determined by the current `:oct` state:

```lisp
(seq :oct 3 :len 1/8  c d e f  g a b  > c)  ; > raises octave: last c is octave 4
```

`note` and `notes` are removed. The parser rejects them with `E_NOTE_REMOVED`.

**Coexistence with absolute pitch notation:**

Absolute pitch (`:c4`, `:e3`) remains supported inside `seq` as an explicit
override, resetting the current octave state:

```lisp
(seq :oct 3 :len 1/8  c e g  :e5 g)  ; :e5 sets oct=5; g plays at oct 5
```

**Subgroup notation for equal-division rhythms:**

A parenthesized list inside `seq` divides the current `:len` equally among its
elements using Bresenham distribution (remainder spread to leading elements):

```lisp
(seq :len 1/4  c  (e g a)  f)          ; triplet: 40+40+40 ticks
(seq :len 1/4  (c d e f g a b))        ; septuplet: 18+17×6 ticks
(seq :len 1/4  c  (_ e)  f)            ; rest in subgroup OK
```

Subgroup elements support bare note names, absolute pitches (`:c4`), and `_` (rest).
The current `:len` is restored after the subgroup; `:oct` changes within the subgroup persist.

### 1.4 Cascaded default state: track → seq → note

All state values cascade from outer to inner scope, with inner overrides taking
effect until the scope ends:

```
score :tempo
  track :ch :role :oct :len :gate :carry :shuffle
    seq  :oct :len :gate
      note (no inline length; uses current :len)
```

Example:

```lisp
(score :tempo 120

  (track :melody :ch fm1 :oct 4 :len 1/8 :gate 0.8
    (seq c e g  :len 1/4 c  :len 1/8 e g))   ; gate 0.8 applies throughout

  (track :bass :ch fm2 :oct 2 :len 1/4
    (seq c _ c _  :oct 3 e g)))               ; oct 2 inherited, overridden to 3
```

### 1.5 `block` — named reusable content (replaces `def (phrase ...)`)

A `block` is a named sequence of track-level commands (notes, params, loops)
that can be referenced by name inside a track body. It replaces the v0.2
pattern of `def name (phrase ...)`.

```lisp
(block :riff :oct 4 :len 1/8
  (seq c e g e))

(block :riff-variant :oct 4 :len 1/8
  (seq f g a g))

(score :tempo 120
  (track :A :ch fm1  :riff :riff :riff-variant)
  (track :B :ch fm2 :oct 2
    (seq c c c c)
    (seq c c c c)
    (seq f f f f)))
```

`block` is expanded at compile time (same as v0.2 `def` with phrase). A
`block` does not carry `:ch` or `:role` — those are always on `track`.

`block` may receive parameters via `defn`-style syntax:

```lisp
(defblock :arp [root]
  (seq :oct 4  root  :o+ root  :o- root))

(track :A :ch fm1  (:arp c)  (:arp g))
```

### 1.6 Gate time

Gate time controls how long a note is voiced (KEY-ON duration) independently
from step length (the time to the next note).

**Specification:**

- `:gate` accepts a ratio `0.0–1.0` (fraction of step length) or an integer
  (absolute ticks).
- Default: `1.0` (full gate = legato; KEY-OFF only on next NOTE_ON).
- Gate < 1.0 inserts a `NOTE_OFF` event at `tick + round(length × gate)`.

```lisp
(track :melody :ch fm1 :gate 0.8    ; 80% gate on all notes
  (seq :o 4 :l 1/8  c e g c))

(track :staccato :ch fm2 :gate 0.3  ; very short
  (seq :o 4 :l 1/8  c c c c))
```

Inline gate override within `seq`:

```lisp
(seq :oct 4 :len 1/8 :gate 0.9  c e  :gate 0.3  g c)
```

**IR impact:** `NOTE_ON` gains an optional `gate` field (ticks, integer).
When `gate == length`, the field is omitted (backward compatible).

```json
{ "cmd": "NOTE_ON", "args": { "pitch": "c4", "length": 60, "gate": 48 } }
```

**Driver impact:** The driver must schedule `NOTE_OFF` (KEY-OFF write) at
`event_time + gate_ticks`. This requires a pending-event queue in the driver.
Design of this queue is part of the Phase 3 driver specification.

**PSG note:** For PSG voices with a `:release` envelope phase, `NOTE_OFF` at
gate time triggers the release phase. This is consistent with v0.2 `:release`
semantics.

### 1.7 Shuffle / swing quantization

Shuffle applies a time-stretching transformation to even/odd subdivisions of
a beat at compile time. The IR receives the already-adjusted tick values; the
driver and GMB format are unaffected.

**Specification:**

- `:shuffle N` where N is an integer 50–90 (percent of one sub-beat pair
  allocated to the first subdivision).
- `50` = straight (no shuffle). `67` = standard triplet swing. `75` = heavy.
- Applies to the smallest subdivision in use (default: 8th notes at `len=1/8`).
- `:shuffle-base` specifies which note value to swing (default: `1/8`).

```lisp
(score :tempo 120 :shuffle 67           ; score-wide swing
  (track :drums :ch noise
    (seq :oct 4 :len 1/8  c _ c _ c _ c _))

  (track :melody :ch fm1 :shuffle 50   ; override: melody stays straight
    (seq :oct 4 :len 1/8  c e g c)))
```

**Implementation:** `parseLengthToken` is extended to accept a shuffle context.
When shuffle is active, tick values for alternating sub-beats are scaled:

```
pair_ticks = 2 × base_ticks
beat1_ticks = round(pair_ticks × shuffle / 100)
beat2_ticks = pair_ticks - beat1_ticks
```

Sub-beat parity is tracked per-track. Shuffle state resets at each `marker`.

### 1.8 `:ch` simplified — single channel only

The v0.2 multi-candidate `:ch` array syntax (e.g. `[:fm1 :fm2 :fm3]`) is
removed. `:ch` accepts a single channel name only.

Multi-track channel allocation (voice stealing) remains out of scope. If
needed in future it will be a separate mechanism, not overloaded on `:ch`.

Valid channel names:

| Name          | Hardware              |
| ------------- | --------------------- |
| `fm1`–`fm6`   | YM2612 FM channels    |
| `psg1`–`psg3` | SN76489 tone channels |
| `noise`       | SN76489 noise channel |

### 1.9 `score` metadata — all optional

All metadata fields on `score` are optional. A minimal score compiles without
`:id`, `:title`, or `:author`.

```lisp
; Minimal valid score
(score :tempo 120
  (track :A :ch fm1
    (seq :oct 4 :len 1/8  c e g c)))
```

`:id` is required only when multiple scores appear in the same file (for driver
lookup). When a file contains exactly one score, `:id` defaults to the filename
stem.

### 1.10 `x` — compact loop

`loop-begin` / `loop-end` are retained for multi-phrase loops but `x` is added
as a compact inline repeat:

```lisp
(x 2  c e g e)          ; repeat "c e g e" twice (seq context)
(x 4  (seq :o 4 c e g e))  ; repeat a seq block 4 times
```

`x` is syntactic sugar; the compiler expands it to `LOOP_BEGIN` / `LOOP_END`
in the IR. Loop ID is auto-assigned.

---

## 2. Open Questions

### ~~2.1~~ `>` / `<` — **DECIDED: persistent** (2026-04-22)

`>` and `<` are persistent state changes, consistent with the cascade model
(§1.4). They behave like `:o` but as increment/decrement.

```lisp
(seq :oct 3 :len 1/8  c e g  >  c e g)  ; > sets oct=4; c e g = c4 e4 g4
```

State resets only when `:o N` is explicitly set or a new `seq`/`track` scope
begins with its own `:o` declaration.

### 2.2 Drum track — 1-channel multi-timbre

PSG noise and FM3 independent-operator mode both allow multiple timbres on
one channel. Design for authoring multi-timbre drum tracks on a single channel:

**PSG noise approach:**
`:noise-mode` parameter target (new) to switch between periodic/white noise
and clock rates between hits. Combined with `ins` for envelope switching.

**FM3 independent-operator mode:**
`FM3_MODE` (reserved in v0.1/v0.2, out of scope). If unlocked in v0.3, BD/SD/
HH can share fm3 with independent TL/envelope per operator.

No decision yet. Requires driver design input before spec can be written.

### ~~2.3~~ `gate` default — **DECIDED: `gate=1.0` universal** (2026-04-22)

Default is `gate=1.0` (legato) for all channel types. NOTE_OFF is emitted only
when the author explicitly sets gate < 1.0. This keeps the spec simple and
puts intentional articulation in the author's hands.

### ~~2.4~~ `block` with track-local context — **DECIDED: hybrid** (2026-04-22)

Declared attributes on `block` override track state; undeclared attributes
inherit from the calling track. This gives both portability (fixed blocks) and
flexibility (parameterless blocks that adapt to context).

```lisp
(block :riff  c e g e)                     ; no defaults → inherits caller's :oct, :len
(block :riff-fixed :oct 4 :len 1/8  c e g e)  ; declares :oct and :len → always fixed

(track :A :ch fm1 :oct 4 :len 1/8  :riff)  ; riff plays at oct 4, len 1/8 (inherited)
(track :B :ch fm2 :oct 3 :len 1/4  :riff)  ; riff plays at oct 3, len 1/4 (inherited)
(track :C :ch fm1 :oct 2 :len 1/4  :riff-fixed)  ; always oct 4, len 1/8 (declared)
```

### 2.5 `shuffle-base` and polyrhythm

When `:shuffle-base` differs between tracks (e.g. melody swings 8ths, drums
swing 16ths), tick values diverge from straight alignment. Behavior at loop
boundaries and marker positions needs specification.

### 2.6 `se` top-level form

A lightweight `se` top-level form for authoring sound effects without the full
`score` boilerplate (discussed in design session 2026-04-22):

```lisp
(se :jump :ch fm6 :role se
  (ins brass) (note :c5 1/16) (note :g5 1/8))
```

Compiles to a single-track score with `:role se` implicit. Relationship to
`score` `:id` namespace TBD.

---

## 3. Out of Scope for v0.3

- `FM3_MODE` — FM3 independent-operator mode (drum design dependency, §2.2)
- `CSM_ON` / `CSM_OFF` / `CSM_RATE` — YM2612 CSM mode
- Runtime subroutines (`CALL`/`RET` in GMB) — `defn` / `defblock` remain
  compile-time only
- Patch import system (`import` from stdlib/community) — Future Vision
- PCM/WAV sample instruments
