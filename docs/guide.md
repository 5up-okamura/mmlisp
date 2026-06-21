# MMLisp Composer's Guide

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
- `:vel N` — note-on velocity (`0`–`15`); a ~2 dB/step musical ladder (PMD /
  MDSDRV style). `15` plays at the patch level, `0` is a ~-30 dB floor —
  velocity **never mutes** (use a rest for silence)
- `:vol N` — channel output level (`0`–`31`); **`0` mutes**
- `:master N` — global master level (`0`–`31`); **`0` mutes**
- `:shuffle N` — swing ratio (`51`–`90`; `50` = straight)
- `:glide token` — portamento duration (same length-token forms as `:len`)
- `:glide-from note` — override start pitch for next note only

Shorthands:

- `>` octave up
- `<` octave down
- `v+`, `v-`, `v+N`, `v-N` adjust `:vel` (0-15)

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

FM voice defs use keyword maps (and can use `:extend`):

```lisp
(def fm-init
  :alg 0 :fb 0 :ams 0 :fms 0
  :ar1 31 :dr1 0 :sr1 0 :rr1 15 :sl1 0 :tl1 127 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2 0 :sr2 0 :rr2 15 :sl2 0 :tl2 127 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3 0 :sr3 0 :rr3 15 :sl3 0 :tl3 127 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4 0 :sr4 0 :rr4 15 :sl4 0 :tl4 127 :ks4 0 :ml4 0 :dt4 0)

(def brass :extend fm-init
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

`(wait token)` waits by length token (same forms as `:len`).

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

## 12. Step Macros (`:semi`, `:keyon`, `:step`)

Step-vector macro targets for arpeggios, drum rolls, and per-note echo tails.

### `:semi` — semitone arpeggio

Discrete semitone offsets (the counterpart to `:pitch`, which is continuous
cents). On a sustained voice this is a classic arpeggio. `:hold` marks the loop
point.

```lisp
(fm1 :macro [ :step 1/16  :semi [:hold 0 4 7] ]  c)   ; c–e–g, looping
```

### `:keyon` — retrigger gate

Sampled once per `:step`; a value `>= 0.5` fires a key-on retrigger (re-attacks
the envelope). Accepts `0`/`1` step lists, a scalar, or a curve/stochastic
signal.

- `:keyon 1` — retrigger every step (drum roll)
- `:keyon [0 :off 1 1 1]` — retrigger only in the release section (after KEY-OFF)

`:keyon` honors `:off`: steps before `:off` loop until the gate (a roll that
stops at KEY-OFF); steps after `:off` fire after KEY-OFF (a 1-channel echo
tail). While a `:keyon` macro is active it owns the channel keying — the note
keys off after the last retrigger.

```lisp
(fm1 :macro [ :step 32 :keyon 1 ]  c)   ; drum roll
```

### `:step` — step duration

`:step token` lives inside the `:macro [...]` list and sets the step length for
the targets that **follow** it (until the next `:step`). Default `1f` (one
60 Hz frame). Each macro/target carries its own step, so different targets can
run at different rates.

```lisp
(fm1 :macro [ :step 1/16 :semi [:hold 0 4 7]  :step 1/8 :keyon [0 :off 1 1 1] ]  c)
```

### Echo-tail preset (1-channel delay on one note)

```lisp
(def $echo :macro [ :step 1/8  :keyon [0 :off 1 1 1]
                                :vel   [15 :off 10 5 0] ])

(fm1 $echo :len 8  c _ _ _)
```

After KEY-OFF the note retriggers three times at 1/8 spacing, decaying via the
phase-locked `:vel` release. (`:vel` floors at ~-30 dB; for a tail that fades to
true silence, automate `:tl` to 127 instead — see §5.)

Clear a macro with `none`: `:macro :semi none`, or `:macro none` clears all.

---

## 13. Track Delay (`:delay`, `:delay-vels`)

`:delay` echoes the **written notes** at compile time — a whole phrase repeats,
shifted and decayed. (Distinct from `:keyon`, which retriggers a single note.)

- `:delay token` — echo tap spacing (length token); persistent track state;
  `:delay none` turns it off
- `:delay-vels [...]` — per-echo velocities; a step vector lists the taps, or a
  curve derives the count from `:len ÷ :delay`

```lisp
(fm1 :delay 1/4 :delay-vels [11 7 3]
  c e g e)
```

plays the phrase plus three decaying repeats (vel 11, 7, 3), each a quarter
later. The original note keeps its own velocity — `:delay-vels` lists the echoes
only (so its first value is the **first echo**, not the dry note).

The channel is monophonic: written notes take priority, so an echo overlapping a
written note is dropped and echoes fill the gaps. For true overlapping delay,
`def` the phrase and replay it on another channel.

### Echoes inherit articulation

Echoes carry the source's per-note macros (`:keyon`, `:semi`, …), so a phrase
with a 1-channel `:keyon` tail repeats with that tail. The `:vel` macro is
inherited but **scaled** so each echo's tail peaks at its `:delay-vels` value:

```lisp
(def $echo :macro [:step 16 :vel [15 :off 10 5 0] :keyon [0 :off 1 1 1]])

(fm1 $echo :delay 4 :delay-vels [10 5 2 0]
  :len 16 c _ _ _ :len 4 _ _ _)
```

Each phrase repeat retriggers like the source; its vel tail is `[15 10 5 0]`
scaled to the echo's level (echo at 10 → `~10 7 3 0`, at 5 → `~5 3 2 0`, …).

---

## 14. Noise Authoring (`noise` channel)

```lisp
(def perc-buzz :macro :mode [white0 :hold periodic3])
(def hh-env :macro :vel [15 9 4 0])

(score
  (noise :len 8 :mode white0 :macro [perc-buzz hh-env]
    c c c c))
```

- `:mode` writes `NOISE_MODE`
- `:macro :mode` allows per-frame timbre motion

---

## 15. Gate and Hold Notes

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
(sqr1 :len 0 :macro :vel [15 :hold 14 13 :off 8 4 0]
  c)
```

In both cases, KEY-OFF is triggered at runtime via `triggerKeyOff()`.

---

## 16. Track Append by Channel Name

Repeating the same channel form appends events and keeps sticky state.

```lisp
(score
  (fm1
    c e g e)
  (fm1
    f g a g))
```

---

## 17. FM3 CSM Mode

Use `fm3-csm` when you want FM3 to run in CSM mode.

```lisp
(score
  (fm3-csm :csm-rate 60
    c _ c _))
```

- `fm3-csm` enables the FM3 special mode.
- `:csm-rate N` sets the Timer A frequency.
- `:csm-rate (curve ...)` sweeps the rate over time.

---

## 18. Tempo Sweeps

`:tempo` now accepts a curve form for smooth changes:

```lisp
(score
  (:tempo (curve :from 120 :to 180 :len 8))
  (fm1 c e g c))
```

- `:tempo N` changes tempo immediately.
- `:tempo (curve :from N :to M :len L)` emits `TEMPO_SWEEP`.

---

## 19. PCM Samples

Samples are defined with `def :sample`, then used as the first positional argument of `pcm1` / `pcm2` / `pcm3`.

```lisp
(def kick  :sample :file "sounds/kick.wav")
(def snare :sample :file "sounds/snare.wav" :rate 11025)

(score :tempo 120
  (pcm1 kick  :len 4  c _ c _)
  (pcm2 snare :len 4  _ c _ c))
```

- `:file` is required.
- `:rate` overrides the C4 playback rate.
- Stereo WAV files are downmixed to mono at compile time.
- WAV data is converted to 8-bit signed PCM at compile time.

---

## 20. Stochastic Curves

The curve system now includes `noise`, `pink`, `perlin`, and `brown`.
They can be used anywhere curve expressions are accepted, including `:macro` and `:tempo`.

---

## 21. Example

```lisp
(def fm-init
  :alg 0 :fb 0 :ams 0 :fms 0
  :ar1 31 :dr1 0 :sr1 0 :rr1 15 :sl1 0 :tl1 127 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2 0 :sr2 0 :rr2 15 :sl2 0 :tl2 127 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3 0 :sr3 0 :rr3 15 :sl3 0 :tl3 127 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4 0 :sr4 0 :rr4 15 :sl4 0 :tl4 127 :ks4 0 :ml4 0 :dt4 0)

(def brass :extend fm-init
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0)

(def phrase c e g e)
(def env :macro [
  :vel [15 12 8 4 0]
  :pan [:hold left center right center]
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
