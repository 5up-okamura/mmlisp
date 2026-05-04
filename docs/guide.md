# MMLisp Composer's Guide (v0.4)

Practical authoring guide for the current MMLisp language.

---

## 1. Minimal Score

```lisp
(score
  (fm1 c e g c))
```

- `score` is the root form.
- Channel forms are written directly as `(fm1 ...)`, `(sqr1 ...)`, `(noise ...)`.
- Notes/rests/modifiers are written inline in the channel body.

Default state:

- `:oct` = `4`
- `:len` = `8` (eighth note)
- `:vol` = `31`
- `:vel` = `15`

---

## 2. Channel Reference

| Name          | Hardware                     |
| ------------- | ---------------------------- |
| `fm1`-`fm6`   | YM2612 FM channels           |
| `sqr1`-`sqr3` | SN76489 square tone channels |
| `noise`       | SN76489 noise channel        |

---

## 3. Notes and Rests

### Note names

`c d e f g a b` with accidentals `+` / `-`:

- `c+` = C sharp
- `d-` = D flat

Octave comes from current `:oct`.

### Rest tokens

- `_` uses current `:len`
- `_8`, `_4.`, `_12t`, `_6f` are explicit-length rests

### Per-note length

Append a length token to one note:

```lisp
(fm1 :oct 4 :len 8
  c4 e8 g8 c4.)
```

This affects only that note.

---

## 4. Length Syntax

These formats are accepted wherever a length value appears — `:len`, note/rest suffix, `:gate` (absolute form), curve `:len`, `:shuffle-base`, `(rest N)`, `(tie N)`, `~ N`:

| Form  | Meaning                                                          |
| ----- | ---------------------------------------------------------------- |
| `N`   | note-length denominator (`4` = quarter, `8` = eighth)            |
| `N.`  | dotted length (`1.5x`)                                           |
| `N/M` | fraction of a whole note (`2/1` = 2 bars, `1/3` = triplet whole) |
| `Nt`  | exact tick count                                                 |
| `Nf`  | exact frame count (60 Hz)                                        |

Examples:

- `4` = quarter note
- `4.` = dotted quarter
- `2/1` = 2 whole notes (2 bars at 4/4)
- `1/3` = triplet whole
- `24t` = 24 ticks exactly
- `8f` = 8 frames exactly

---

## 5. Inline Modifiers (Persistent State)

```lisp
(fm1 :oct 4 :len 8 :gate 0.8
  c e g e
  :oct 5
  c e g e)
```

Common modifiers:

- `:oct N` — octave (`0`–`8`)
- `:len token` — default note length (length token); `0` emits a held note and does not advance the timeline
- `:gate token-or-ratio` — gate time; ratio `0.0`–`1.0` or absolute length token; `0` holds until runtime KEY-OFF
- `:vel N` — note-on velocity (`0`–`15`)
- `:vol N` — channel output level (`0`–`31`)
- `:master N` — global master level (`0`–`31`)
- `:shuffle N` — swing ratio (`51`–`90`; `50` = straight)
- `:glide N` — portamento duration in frames (plain integer)
- `:glide-from note` — override start pitch for next note only

Shorthands:

- `>` octave up
- `<` octave down
- `v+`, `v-`, `v+N`, `v-N` adjust `:vol` (0-31)

---

## 6. Subgroups, Loops, and Break

### Subgroup / tuplet

```lisp
(fm1 :len 4
  c (e g a) f)
```

`(e g a)` divides the parent slot using Bresenham distribution.

### Counted loop

```lisp
(fm1 :len 8
  (x 4
    c d e :break f g))
```

- `(x N ...)` repeats body `N` times.
- `:break` skips the tail on the last pass.

---

## 7. Definitions and Reuse

### `def` (named snippet)

```lisp
(def riff c e g e)

(score
  (fm1 :oct 4 :len 8
    riff
    riff))
```

`def` expands inline.

### `defn` (parametric)

```lisp
(defn arp [root]
  root > root < root)

(score
  (fm1 :oct 4 :len 8
    (arp c)
    (arp g)))
```

---

## 8. FM Voice Definitions

FM voice defs use keyword maps (and can use `:extends`):

```lisp
(def fm-init
  :alg 0 :fb 0 :ams 0 :fms 0
  :ar1 31 :dr1 0 :sr1 0 :rr1 15 :sl1 0 :tl1 127 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2 0 :sr2 0 :rr2 15 :sl2 0 :tl2 127 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3 0 :sr3 0 :rr3 15 :sl3 0 :tl3 127 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4 0 :sr4 0 :rr4 15 :sl4 0 :tl4 127 :ks4 0 :ml4 0 :dt4 0)

(def brass :extends fm-init
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0)
```

Use by bare identifier:

```lisp
(score
  (fm1 :oct 4 :len 8
    brass
    c e g e))
```

---

## 9. Macro Basics (`:macro`)

Macros are KEY-ON scoped per NOTE_ON.

### Single-target def

```lisp
(def pluck :macro :vel [15 12 8 4 0])
```

### Multi-target def (list form)

```lisp
(def synth-env :macro [
  :vel   [15 12 8 4 0]
  :pitch (linear :from 0 :to -1200 :len 8)
])
```

### Use-site forms

```lisp
(def pluck :macro :vel [15 12 8 4 0])

(fm1 pluck c)                              ; bare name — applies the macro def
(fm1 :macro :vel [15 10 5 0] c)           ; inline anonymous macro
(fm1 :macro [pluck :pan [left center right]] c)  ; mix named + inline
```

If the same target appears multiple times, last one wins.

---

## 10. Multi-stage Macro and `wait key-off`

Multi-stage uses a vector of curve/wait stages and runs sequentially for one target.

```lisp
(def adsr-curve :macro :vel [
  (linear :from 0  :to 15 :len 4)
  (wait key-off)
  (linear :from 15 :to 0  :len 4)
])
```

Behavior:

- Triggered at KEY-ON
- First stage runs attack
- `(wait key-off)` holds value until KEY-OFF
- After KEY-OFF, following stage runs release

`(wait N)` waits N frames (plain integer, not a length token).

---

## 11. Curve and Step Value Domains

### `:pan`

Accepted values:

- Symbolic: `left` = `-1`, `center` = `0`, `right` = `+1`
- Numeric: `-1`, `0`, `1` are also valid directly

Curve/function outputs are snapped to `-1 / 0 / +1`.

### `:mode` (noise)

Accepted symbolic values:

- `white0`-`white3`
- `periodic0`-`periodic3`

Default: `white0`. Curve/function outputs are snapped to integer `0..7`.

---

## 12. Noise Authoring (`noise` channel)

```lisp
(def perc-buzz :macro :mode [white0 :loop periodic3])
(def hh-env :macro :vel [15 9 4 0])

(score
  (noise :len 8 :mode white0 :macro [perc-buzz hh-env]
    c c c c))
```

- `:mode` writes `NOISE_MODE`
- `:macro :mode` allows per-frame timbre motion

---

## 13. Gate and Hold Notes

`:gate` controls how long the note sounds within its slot.

```lisp
(fm1 :len 8 :gate 0.5 c d e f)   ; KEY-OFF at 50% of each slot
(fm1 :len 8 :gate 6f  c d e f)   ; KEY-OFF 6 frames into each slot
```

### `:gate 0` — hold, timeline advances

`:gate 0` fires KEY-ON and holds indefinitely, but the timeline still advances by `:len`. Use this when the channel needs to stay in sync with others while holding a note.

```lisp
(fm1 :len 4 :gate 0
  c _ _ _)   ; KEY-ON on beat 1, timeline moves 4 beats, KEY-OFF via runtime
```

### `:len 0` — hold, timeline does not advance

`:len 0` fires KEY-ON, holds indefinitely, and does not advance the timeline. Any subsequent notes in the same channel all land at tick 0. Useful for a single held note with a release macro:

```lisp
(sqr1 :len 0 :macro :vel [15 :loop 14 13 :release 8 4 0]
  c)
```

In both cases, KEY-OFF is triggered at runtime via `triggerKeyOff()`.

---

## 14. Track Append by Channel Name

Repeating the same channel form appends events and keeps sticky state.

```lisp
(score
  (fm1
    c e g e)
  (fm1
    f g a g))
```

---

## 15. Practical v0.4 Example

```lisp
(def fm-init
  :alg 0 :fb 0 :ams 0 :fms 0
  :ar1 31 :dr1 0 :sr1 0 :rr1 15 :sl1 0 :tl1 127 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2 0 :sr2 0 :rr2 15 :sl2 0 :tl2 127 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3 0 :sr3 0 :rr3 15 :sl3 0 :tl3 127 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4 0 :sr4 0 :rr4 15 :sl4 0 :tl4 127 :ks4 0 :ml4 0 :dt4 0)

(def brass :extends fm-init
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0)

(def phrase c e g e)
(def env :macro [
  :vel [15 12 8 4 0]
  :pan [:loop left center right center]
])

(score
  (fm1
    brass
    env
    phrase
    (x 2 phrase))

  (noise :mode white0
    c _ c _))
```

---

## 16. Migration Checklist (Old to v0.4)

- Replace `(track :ch fm1 ...)` with `(fm1 ...)`
- Replace `(seq ...)` with direct inline body items
- Replace `psg1`-`psg3` with `sqr1`-`sqr3`
- Replace `@voice` with bare identifier `voice`
- Replace `(set ...)` and `(default ...)` with inline modifiers
- Use length tokens consistently (`N`, `N.`, `N/M`, `Nt`, `Nf`)
