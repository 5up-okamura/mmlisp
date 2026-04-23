# MMLisp v0.3 Design Notes

Document status: frozen
Started: 2026-04-22
Finalized: 2026-04-22
Frozen: 2026-04-24 (tag: v0.3-freeze at c3bdc72)

This document captures decisions and open questions for v0.3, based on design
discussions following the v0.2 implementation (2026-04-22).

The central theme of v0.3 is **authoring model modernization**: making MMLisp
feel natural to write, not just structurally correct.

---

## 1. Decided

### 1.1 Track as append stream

A `track` with a `:ch`/`:role` pair that has already appeared in the same
`score` appends its content to that track's event stream. The first occurrence
defines the channel and role; subsequent occurrences inherit all attributes.

```lisp
(score :tempo 120

  ; ── Section A ──────────────────────────────────────
  (track :ch fm1 :oct 3 :len 1/8
    (x 2 (seq c e g e)))

  (track :ch fm2 :oct 2 :len 1/8
    (x 2 (seq c c c c)))

  (track :ch fm1 :role modulator
    (param-set :fm-tl4 30)
    (x 8 (param-add :fm-tl4 +1)))

  ; ── Section B ──────────────────────────────────────
  (track :ch fm1                     ; appends to fm1::bgm
    (x 2 (seq f g a g)))

  (track :ch fm2                     ; appends to fm2::bgm
    (x 2 (seq f f f f)))

  (track :ch fm1 :role modulator     ; appends to fm1::modulator
    (param-set :fm-tl4 30)
    (x 8 (param-add :fm-tl4 +1)))

)
```

**Attribute inheritance rules for appended tracks:**

| Attribute | First occurrence | Appended occurrence                        |
| --------- | ---------------- | ------------------------------------------ |
| `:ch`     | Required         | Required; must match first (forms the key) |
| `:role`   | Default `bgm`    | Required if not `bgm`; forms the key       |
| `:oct`    | Default 4        | Inherited; inline `:oct` overrides locally |
| `:len`    | Default `1/8`    | Inherited; inline `:len` overrides locally |
| `:carry`  | Default `false`  | Inherited                                  |

### 1.2 Track body structure

Track bodies contain note/rest/control commands directly. `:len` and `:oct`
are set as track options or changed inline within `seq`.

To persistently update the track defaults mid-body, use `(default ...)`:

```lisp
(track :ch fm1 :oct 4 :len 1/8
  (seq c e g e)               ; oct 4, len 1/8
  (default :oct 3 :len 1/4)  ; overwrite defaults
  (seq c e g e))              ; oct 3, len 1/4
```

Accepted keys: `:oct`, `:len`, `:gate`, `:vol`. Unrecognized keys are ignored.

### 1.3 `seq` — inline note sequence

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
| `:gate val` | Set gate ratio (`0.0`–`1.0`)                                       | Persistent  |
| `@name`     | Switch voice to named `def` voice                                  | Persistent  |
| `_`         | Rest (uses current `:len`)                                         | Single step |
| `~`         | Tie: extend by current `:len`; `~ 1/2` overrides len               | Single step |
| `>`         | Octave up by 1                                                     | Persistent  |
| `<`         | Octave down by 1                                                   | Persistent  |
| `v+` `v+N`  | Volume up by N (default 1); clamp 0–15                             | Persistent  |
| `v-` `v-N`  | Volume down by N (default 1); clamp 0–15                           | Persistent  |
| `(a b c)`   | Subgroup: divide current `:len` equally among elements (Bresenham) | Single slot |

Note names within `seq` are bare symbols; octave is determined by the current
`:oct` state:

```lisp
(seq :oct 3 :len 1/8  c d e f  g a b  > c)  ; > raises octave: last c is octave 4
```

**Subgroup notation for equal-division rhythms:**

A parenthesized list inside `seq` divides the current `:len` equally among its
elements using Bresenham distribution (remainder spread to leading elements):

```lisp
(seq :len 1/4  c  (e g a)  f)          ; triplet: 40+40+40 ticks
(seq :len 1/4  (c d e f g a b))        ; septuplet: 18+17×6 ticks
(seq :len 1/4  c  (_ e)  f)            ; rest in subgroup OK
```

Subgroup elements support bare note names and `_` (rest).
The current `:len` is restored after the subgroup; `:oct` changes within the subgroup persist.

### 1.4 Cascaded default state: track → seq → note

All state values cascade from outer to inner scope, with inner overrides taking
effect until the scope ends:

```
score :tempo
  track :ch :role :oct :len :gate :carry :shuffle
    seq  :oct :len :gate
      note[N[.]]  per-note length (denominator + optional dot; one note only)
      note        (no inline length; uses current :len)
```

Example:

```lisp
(score :tempo 120

  (track :ch fm1 :oct 4 :len 1/8 :gate 0.8
    (seq c e g  :len 1/4 c  :len 1/8 e g))   ; gate 0.8 applies throughout

  (track :ch fm2 :oct 2 :len 1/4
    (seq c _ c _  :oct 3 e g)))               ; oct 2 inherited, overridden to 3
```

### 1.5 `def` — named phrase

A phrase `def` is a named sequence of track-level commands (notes, params,
loops) that can be referenced by name inside a track body. The body is one or
more `seq` forms (or other track-level commands).

```lisp
(def riff (seq :oct 4 :len 1/8  c e g e))

(def riff-variant (seq :oct 4 :len 1/8  f g a g))

(score :tempo 120
  (track :ch fm1  riff  riff  riff-variant)
  (track :ch fm2 :oct 2
    (seq c c c c)
    (seq c c c c)
    (seq f f f f)))
```

A phrase `def` can contain multiple forms:

```lisp
(def fill
  (seq :oct 4 :len 1/8  c e g e)
  (seq :oct 4 :len 1/4  f g))
```

`def` is expanded at compile time. It does not carry `:ch` or `:role` —
those are always on `track`.

The compiler distinguishes voice defs from phrase defs by the first token of
the body: `:fm` or `:psg` → voice; `(seq ...)` or other track commands → phrase.

Parametric phrases use `defn`:

```lisp
(defn arp [root]
  (seq :oct 4  root  > root  < root))

(track :ch fm1  (arp c)  (arp g))
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
(track :ch fm1 :gate 0.8
  (seq :oct 4 :len 1/8  c e g c))

(track :ch fm2 :gate 0.3
  (seq :oct 4 :len 1/8  c c c c))
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
  (track :ch noise
    (seq :oct 4 :len 1/8  c _ c _ c _ c _))

  (track :ch fm1 :shuffle 50            ; override: melody stays straight
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
  (track :ch fm1
    (seq :oct 4 :len 1/8  c e g c)))
```

`:id` is required only when multiple scores appear in the same file (for driver
lookup). When a file contains exactly one score, `:id` defaults to the filename
stem.

### 1.10 `#label` / `goto` — label and jump

A single pair of primitives handles all looping and branching:

```lisp
#top                   ; label declaration — bare atom, no parens
(seq c e g e)
(goto top)             ; infinite loop — reference without #
```

```lisp
#verse
(seq c e g e)
(goto verse 4)         ; finite: repeat 4 times then fall through
```

`#label` is a bare atom; the tokenizer reads it as a single atom with `#`
prefix. The `goto` reference omits the `#`.

**IR mapping:**

- `#top` → `MARKER { id: "top" }`
- `(goto top)` → `JUMP { to: "top" }` (infinite)
- `(goto top 4)` → `LOOP_BEGIN` + body + `LOOP_END` with count 4

### 1.11 `x` — compact loop (sugar over `#`/`goto`)

```lisp
(x 4 (seq c e g e))    ; finite: repeat 4 times
(x (seq c e g e))      ; infinite: no leading integer = infinite loop
```

Count comes **first** (optional integer literal). No count = infinite.
Multiple body forms are allowed:

```lisp
(x 4
  (seq c e g e)
  (seq f g a g))
```

Expands to `MARKER` + body + `JUMP` (infinite) or `LOOP_BEGIN` + body +
`LOOP_END` (finite).

### 1.12 `@voice` — voice switch

Voice switching uses a bare `@name` atom in both track body and `seq` context:

```lisp
(def brass :fm ...)
(def bd    :psg ...)

(track :ch fm1
  @brass                             ; voice switch in track body
  (seq c e g e))

(track :ch psg1 :len 1/8
  (seq @bd c  @hh c  @sd c  @hh c)) ; voice switch inline in seq
```

`@name` is tokenized as a single atom. The compiler detects the `@` prefix to
distinguish from block references and note names.

### 1.13 Per-note length suffix

A note may carry an inline length: a denominator integer optionally followed
by `.` for dotted value. The compiler matches `/^[a-g][+\-]?\d+\.?$/` —
the trailing number is the length denominator, not the octave.

```lisp
(seq c4 e8 g8 c4)        ; quarter eighth eighth quarter
(seq c4. e8 g8 c2)       ; dotted quarter, eighth, eighth, half
(seq :len 1/8  c e4 g e) ; e4 overrides for that note only; c/g/e use :len
```

The per-note length applies to that note only and does **not** update the
persistent `:len` state. Octave is still controlled by `:oct`, `>`, and `<`.

**`:len` dotted shorthand:** the same `N.` syntax is also valid for `:len`
and `(rest N.)` forms:

```lisp
(seq :len 4.  c e g c)    ; all notes dotted quarter
(rest 8.)                 ; dotted eighth rest
```

**IR impact:** none — the per-note length expands to the same tick count as
the equivalent `n/d` fraction before IR emission.

### 1.15 `v+` / `v-` — inline volume shift

Within `seq`, volume can be shifted up or down using bare atoms `v+` and `v-`.
An optional integer suffix specifies the delta (default: 1). Volume is clamped
to 0–15.

```lisp
(seq c e v+ g v+ a)         ; step up by 8 before g and a
(seq c e v+16 g v-8 a f c)  ; explicit delta
(seq v- c d e f)            ; step down before the phrase
```

The initial volume for each `seq` is inherited from the track's `:vol` option
(default 8). Changes persist within the seq but reset at the next seq.

**IR impact:** a `PARAM_SET { target: "VOL", value: N }` event is emitted at
the current tick before the following note.

```json
{ "cmd": "PARAM_SET", "args": { "target": "VOL", "value": 12 } }
```

### 1.14 Naming conventions

User-defined names (`def`, `defn`, labels) use plain identifiers without `:`.

```lisp
(def riff (seq c e g e))
(def bridge (seq :oct 5 :len 1/4  f g a g))

(track :ch fm1  riff  riff)
```

Built-in option keywords (`:oct`, `:len`, `:gate`, `:ch`, `:role`, `:fm`,
`:psg`, etc.) retain their `:` prefix.

---

## 2. Open Questions

### ~~2.1 Drum track — 1-channel multi-timbre~~ → resolved

`@voice` switching (`@bd`, `@sd`, `@hh`, …) handles multi-timbre on a single
channel. Each `@name` atom emits `PSG_VOICE` before the note, switching the
envelope inline. No new mechanism is needed for v0.3.

FM3 independent-operator mode remains out of scope. See §3.

### ~~2.2 `shuffle-base` and polyrhythm~~ → resolved

Each track maintains its own independent `subBeatParity` counter. Tracks with
different `:shuffle-base` values operate on separate tick timelines and require
no cross-track synchronization. Loop boundaries are respected per-track; the
driver plays all tracks in global tick order regardless of shuffle alignment.

---

## 3. Out of Scope for v0.3

- `FM3_MODE` — FM3 independent-operator mode (drum design dependency, §2.2)
- `CSM_ON` / `CSM_OFF` / `CSM_RATE` — YM2612 CSM mode
- Runtime subroutines (`CALL`/`RET` in GMB) — `defn` / `defblock` remain
  compile-time only
- Patch import system (`import` from stdlib/community) — Future Vision
- PCM/WAV sample instruments
