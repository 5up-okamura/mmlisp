# MMLisp Composer's Guide

A reference for everything you need to write music in MMLisp.

---

## 1. Minimal Score

```lisp
(score (track :ch fm1 (seq c e g c)))
```

- `score` — root form wrapping the entire piece
- `track` — event stream for one channel; `:ch` is required
- `seq` — inline sequence of notes and rests

`:oct` defaults to `4`, `:len` to `1/8`. `:tempo` is optional.

---

## 2. Channel Reference

| Name          | Hardware                           |
| ------------- | ---------------------------------- |
| `fm1`–`fm6`   | YM2612 FM synthesizer (6 channels) |
| `psg1`–`psg3` | SN76489 square wave (3 channels)   |
| `noise`       | SN76489 noise channel              |

---

## 3. Note Names

Note names are lowercase only. Accidentals use `+` (sharp) and `-` (flat):

| Written | Pitch     |
| ------- | --------- |
| `c`     | C         |
| `c+`    | C♯        |
| `d-`    | D♭ (= C♯) |
| `d`     | D         |
| `e-`    | E♭        |
| `f`     | F         |
| `f+`    | F♯        |
| `g`     | G         |
| `a-`    | A♭        |
| `a`     | A         |
| `b-`    | B♭        |
| `b`     | B         |

Octave is set with `:oct N` (range 0–8, default 4).

### Absolute pitch

Append an octave number to a note name to pin it to a specific octave:

```lisp
(seq :oct 4 c e f+3 a)
```

`f+3` plays F♯ in octave 3. The current octave is **not** updated — `a` after it still plays in octave 4.

---

## 4. Note Lengths

`:len` accepts fraction (`n/d`) or denominator-only shorthand (`n/d` where numerator is 1 can be written as just `d`):

| Written        | Duration       | Ticks (PPQN=120) |
| -------------- | -------------- | ---------------- |
| `2/1`          | double whole   | 960              |
| `1/1` or `1`   | whole note     | 480              |
| `1/4` or `4`   | quarter note   | 120              |
| `1/8` or `8`   | eighth note    | 60               |
| `1/12` or `12` | triplet eighth | 40               |
| `3/16`         | dotted eighth  | 90               |
| `3/8`          | dotted quarter | 180              |

Any `n/d` fraction is valid. The minimum is `1/480` (1 tick).

### Delay / chorus example

```lisp
(defn melody [] (seq :len 1/4 g f e d c e f e d c b4 g4) (rest 1/1))

(score :tempo 120
  (track :ch fm1 (param-set :vol 11) (x (melody)))
  (track :ch fm2 (param-set :vol 7) (rest 3/16) (x (melody)))
)
```

---

## 5. seq Syntax

```lisp
(seq :oct 4 :len 1/8 c e g c :len 1/4 e :oct 5 c)
```

### Modifiers

| Modifier    | Effect                                              | Scope      |
| ----------- | --------------------------------------------------- | ---------- |
| `:oct N`    | Set octave (0–8)                                    | persistent |
| `:len val`  | Set step length                                     | persistent |
| `:gate val` | Set gate (ratio `0.0`–`1.0` or absolute ticks int)  | persistent |
| `@name`     | Switch voice (defined with `def`)                   | persistent |
| `>`         | Octave up by 1                                      | persistent |
| `<`         | Octave down by 1                                    | persistent |
| `_`         | Rest for the current `:len`                         | one step   |
| `~`         | Tie — extend previous note; `~ 1/2` sets tie length | one step   |
| `(a b c)`   | Subgroup — current `:len` divided equally           | one slot   |

### Rest

```lisp
(seq :len 1/8 c _ e _ g _ c _)
```

### Tie

```lisp
(seq :len 1/4 c ~ ~)       ; quarter × 3 = dotted half
(seq :len 1/4 c ~ 1/8)     ; quarter + eighth
```

### Octave shift

```lisp
(seq :oct 3 c d e f > c d e f)   ; > moves to oct 4
(seq :oct 4 c d e f < c d e f)   ; < moves to oct 3
```

### Subgroups (tuplets)

```lisp
(seq :len 1/4 c (e g a) f)       ; triplet (40 ticks each)
(seq :len 1/4 (c d e f g a b))   ; septuplet (Bresenham distribution)
```

---

## 6. Track Options

Options are placed after the track name:

| Option        | Effect                                             | Default          |
| ------------- | -------------------------------------------------- | ---------------- |
| `:ch name`    | Channel assignment (required)                      | —                |
| `:oct N`      | Initial octave                                     | `4`              |
| `:len val`    | Default step length                                | `1/8`            |
| `:gate val`   | Default gate                                       | `1.0` (legato)   |
| `:role name`  | Track role: `bgm`, `se`, `modulator`, `chaos`      | `bgm`            |
| `:shuffle N`  | Swing amount (51–90; 50 = straight)                | score-level or 0 |
| `:carry bool` | If `true`, modulator track persists across NOTE_ON | `false`          |

---

## 7. Voice Definitions

### PSG voices

```lisp
(def pluck :psg [15 13 11 9 7 5 3 1 0])
(def pad :psg [:seq 15 :loop 14 13 :release 3])
```

Bare vector = volume envelope steps (0–15, one per tick). `:loop` marks the loop start; `:release` sets the release rate.

### FM voices

```lisp
(def brass :fm
  ; alg fb ams fms
  [7 0 0 3]
  ; AR DR SR RR SL TL KS ML DT SSG AMEN
  [31  0  5  3  7  0  0  0  0  0  0]
  [31  0  5  3  7  0  0  0  0  0  0]
  [31  0  5  3  7  0  0  0  0  0  0]
  [31  0  5  3  7  0  0  0  0  0  0])
```

Channel vector: `(alg fb [ams [fms]])` — `ams` and `fms` are optional.  
Operator vector: `(AR DR SR RR SL TL KS ML DT [SSG [AMEN]])` — `SSG` and `AMEN` are optional trailing fields; omitting them leaves those registers unchanged.

### Using a voice

Set at track start with `@name`:

```lisp
(track :ch psg1
  @pad
  (seq :oct 2  c c g g))
```

Switch mid-seq with `@name`:

```lisp
(def bd :psg [15 14 12 9 5 0])
(def sd :psg [15 13 10 6 2 0])
(def hh :psg [15 8 0])

(track :ch psg1 :len 1/8
  (seq @bd c  @hh c  @sd c  @hh c
       @bd c  @hh c  @sd c  @hh c))
```

---

## 8. Loops

### Finite loop

```lisp
(x 4 (seq c e g e))    ; repeat 4 times
```

Compiles to `LOOP_BEGIN` / body / `LOOP_END`. Multiple body forms are allowed:

````lisp
(x 4
  (seq c e g e)
  (seq f g a g))

### Infinite loop

```lisp
#top
(seq c e g e)
(goto top)             ; loops forever
````

`#top` is a bare atom (label declaration). `(goto top)` references it without `#`.

### Finite loop with explicit label

```lisp
#verse
(seq c e g e)
(goto verse 4)         ; repeat 4 times, then fall through
```

### `x` without count — infinite shorthand

```lisp
(x (seq c e g e))      ; no leading integer = infinite loop
```

---

## 9. Phrase Reuse

### def — named phrase

Use `def` with a `seq` body to give a phrase a name:

```lisp
(def riff (seq c e g e))
(def bridge (seq :oct 5 :len 1/4  f g a g))

(score
  (track :ch fm1 :oct 4 :len 1/8
    riff
    riff
    bridge))
```

A phrase `def` can contain multiple forms:

```lisp
(def fill
  (seq :oct 4 :len 1/8  c e g e)
  (seq :oct 4 :len 1/4  f g))
```

The calling track's `:oct` / `:len` are inherited when the `seq` inside the `def` does not declare them.

### defn — parametric phrase

```lisp
(defn arp [root]
  (seq :oct 4  root  > root  < root))

(track :ch fm1 :len 1/8
  (arp c)
  (arp g))
```

---

## 10. Track Append

Repeating a track name appends events after the previous ones:

```lisp
(score
  ; Section A
  (track :ch fm1 :oct 4 :len 1/8
    (seq c e g e))

  (track :ch psg1 :oct 2 :len 1/4
    (seq c c))

  ; Section B — appended to the same tracks
  (track :ch fm1
    (seq f g a g))

  (track :ch psg1
    (seq f f)))
```

`:ch` and `:role` together identify the track — writing the same pair again appends to that track. `:oct`, `:len`, `:gate`, and `:shuffle` can be updated on append.

---

## 11. Modulator Tracks

A track with `:role modulator` runs on the same channel as a `bgm` track and fires events simultaneously:

```lisp
(track :ch fm1 :role modulator
  (x
    (param-set :FM_FMS 3)
    (rest 1/4)
    (param-set :FM_FMS 0)
    (rest 1/4)))
```

By default, a modulator track resets to its start position each time the primary track emits a NOTE_ON. Set `:carry true` to prevent the reset.

---

## 12. Gate and Swing

### Gate

Gate controls when KEY_OFF fires within a step. Default is `1.0` (legato — no early KEY_OFF).

```lisp
; Ratio: float 0.0–1.0 (relative to step length)
(track :ch fm1 :gate 0.5   ...)    ; staccato — KEY_OFF at half the step

; Length notation: same tokens as :len (1/16, 16, etc.)
(seq :gate 1/16  c d e f)          ; KEY_OFF 30 ticks after NOTE_ON regardless of step length
(seq :gate 16    c d e f)          ; same — denominator-only shorthand

; Override inside seq
(seq :len 1/8  :gate 0.9  c e  :gate 0.3  g c)
```

### Swing

```lisp
(track :ch fm2 :shuffle 67 :len 1/8
  (seq c d e f g a b c))
```

Swing reference: `50` = straight, `67` = standard swing (~2:1 triplet), `75` = heavy.

`:shuffle-base` sets the unit that alternates long/short (default `1/8`).

### Gate + swing interaction

Shuffle affects the _step length_. Gate ratio is applied to each individual (post-shuffle) step length — so KEY_OFF tracks the swung beat naturally. With ratio gate, a long beat gets a proportionally longer sound-on window and a short beat gets a shorter one, which is the correct swung feel. Absolute-tick gate ignores step length entirely and is unaffected by shuffle.
