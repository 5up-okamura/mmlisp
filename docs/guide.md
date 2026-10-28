# MMLisp Composer's Guide

Practical authoring guide for the current MMLisp language. This is the
tutorial; the full reference (every keyword, range, and rule) is
`docs/language.md`, and `docs/cheatsheet.md` is all of it on two pages.

---

## 1. Minimal Score

```lisp
(fm1 c e g c)
```

- The file is the score — no wrapper form. Channel forms are written directly
  at top level as `(fm1 ...)`, `(sqr1 ...)`, `(noise ...)`.
- Notes/rests/modifiers are written inline in the channel body.
- File metadata is `(def-score :title "…" :composer "…" :author "…")`;
  global `:tempo` / `:lfo-rate` are written on any track (see
  `docs/language.md` §1).

Default state:

- `:oct` = `4`
- `:len` = `8` (eighth note)
- `:gate` = full note length
- `:vol` = `31`
- `:vel` = `15`

---

## 2. Channel Reference

| Name                      | Hardware                                              |
| ------------------------- | ----------------------------------------------------- |
| `fm1`-`fm6`               | YM2612 FM channels (a score that uses PCM gives up `fm6` — it is the DAC) |
| `fm3-1`-`fm3-4`           | FM3 independent-operator mode (one track per OP)      |
| `fm3-csm`, `fm3-csm-rate` | FM3 CSM mode (§17)                                    |
| `sqr1`-`sqr3`             | SN76489 square tone channels                          |
| `noise`                   | SN76489 noise channel                                 |
| `pcm1`-`pcm3`             | Software-mixed PCM channels (§19)                     |

See `docs/language.md` §2 for mode-exclusivity rules.

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

### Tie and slur — `X ~ Y`

Every note attacks. `~` between two notes is what joins them:

```lisp
(fm1 :oct 4 :len 8
  c ~ c      ; same pitch  → tie: one attack, held for both slots
  e ~ g      ; other pitch → slur: the pitch moves, the envelope carries over
  c ~ d ~ e) ; chains: one attack gliding through all three
```

`~` attaches to the next real note, skipping state tokens (`c ~ > d` slurs to
the octave-up `d`), and the right note keeps its own length.

The left note of a slur always sounds its full slot: its `:gate` is ignored,
so it never keys off before the connection and the envelope carries over. The
right note keeps its own gate. Slur is an FM/PSG thing; on PCM a
different-pitch `~` is just a new note.

---

## 4. Length Syntax

These formats are accepted wherever a length value appears — `:len`, note/rest
suffix, `:gate` / `:gate-`, curve `:len`, macro `:step`, `(wait N)`,
`(glide T)`, `(delay … :time T)`, `:shuffle-base`:

| Form  | Meaning                                                          |
| ----- | ---------------------------------------------------------------- |
| `N`   | note-length denominator (`4` = quarter, `8` = eighth)            |
| `N.`  | dotted length (`1.5x`)                                           |
| `N/M` | fraction of a whole note (`2/1` = 2 bars, `1/3` = triplet whole) |
| `Nt`  | exact tick count                                                 |
| `Nf`  | frame count (60 Hz) — a true frame count in curve `:len`, macro `:step` and `(wait …)`; elsewhere converted to ticks at the tempo in force |
| `Nms` | milliseconds — the nearest frame count where `Nf` is one; elsewhere converted to ticks at the tempo in force |
| `0`   | hold (`:len 0` waits for the key-off, `:gate 0` holds through the slot) |

Examples:

- `4` = quarter note
- `4.` = dotted quarter
- `2/1` = 2 whole notes (2 bars at 4/4)
- `1/3` = triplet whole
- `24t` = 24 ticks exactly
- `8f` = 8 frames (on a note or rest, the ticks they take at this tempo)
- `100ms` = 100 milliseconds

The tick grid is PPQN 96 (quarter = 96 ticks, whole = 384). See
`docs/language.md` §4.

### Bar markers — `|`

Put `|` at the **end of each bar**. It is editorial only — no effect on playback
— and lets the editor show a bar's tick count: each bar runs from the previous
`|` up to this one, and the first bar counts implicitly from the track start (no
leading `|` needed). The Nth `|` closes bar N. There is no fixed meter, so bars
may be any length; comparing a bar's tick count across tracks is the quick way to
catch drift.

In the live app, tap a `|` to pop up its bar number and tick count; the popup
stays open and follows the marker as you edit above it (see §22).

```lisp
(fm1 :oct 4 :len 8
  c c c c c c c c |
  c c c c c c c c |)
```

---

## 5. Inline Modifiers (Persistent State)

```lisp
(fm1 :oct 4 :len 8 :gate* 0.8
  c e g e
  :oct 5
  c e g e)
```

Common modifiers:

- `:oct N` — octave (an integer ≥ 0; `4` holds middle C)
- `:len token` — default note length (length token); `0` holds the note and stops the track until the key-off (§15)
- `:gate token` — gate time as an absolute length token (e.g. `8`, `12t`); `0` holds until runtime KEY-OFF
- `:gate* ratio` — gate as a fraction of the note length (`0.0`–`1.0`)
- `:gate- token` — shorten the gate: note length **minus** this time (key off early / staccato)
- `:vel N` — note-on velocity (`0`–`15`); a ~2 dB/step musical ladder (PMD /
  MDSDRV style). `15` plays at the patch level, `0` is a ~-30 dB floor —
  velocity **never mutes** (use a rest for silence)
- `:vol N` — channel output level (`0`–`31`); a mixer-fader with unity (0 dB)
  at the top: `31` = full, lower values cut — a pure attenuator; **`0`
  mutes**. Default (unset) = `31` (unity).
- `:master N` — global master level (`0`–`31`); same fader as `:vol`; **`0`
  mutes**
- `:shuffle N` — swing: each pair of `:shuffle-base` lengths (a sixteenth) splits
  `N` : 100−`N` (`1`–`99`; `none` = straight), and any length lands on the
  swung grid; `:shuffle [7 6 3 4]` is a groove of four steps; per-track (no
  score-wide default)
- `(glide T)` — portamento from the pitch sounding over duration `T` (same
  length-token forms as `:len`); a `T` longer than the notes keeps sliding on
  from wherever the pitch has got to, like a mono synth's slow portamento.
  `(glide none)` disables, and the next note starts at its own pitch.
- `(glide from-pitch T)` — glide from an explicit start pitch. The start pitch is
  an absolute pitch (note + octave, e.g. `f5`, where the trailing number is the
  **octave**); `T` is the duration. Example: `(glide f5 32)`.

Shorthands:

- `>` octave up
- `<` octave down
- `o+`, `o-`, `o+N`, `o-N` adjust `:oct`
- `v+`, `v-`, `v+N`, `v-N` adjust `:vel` (0-15)

---

## 6. Tuplets, Loops, and Break

### Tuplet

```lisp
(fm1 :len 4
  c (t e g a) f)
```

`(t e g a)` divides one `:len` slot among its notes and rests using Bresenham
distribution. Octave and velocity shifts (`>` `<` `o±N` `v±N`) may sit between
them and take no share: `(t b > c d <)` is b4 c5 d5 in one slot.

### Counted loop

```lisp
(fm1 :len 8
  (x 4
    c d e (break) f g))
```

- `(x N ...)` repeats body `N` times.
- `(break)` skips the tail on the last pass.

**`(x N …)` is a loop, not an unroll.** The body is compiled **once** and
replayed `N` times, so sticky state changed inside the body (octave `>`/`<`,
`:oct`, `:vel`, `:len`, …) does **not** accumulate across iterations — each pass
replays the same baked notes. A net octave shift inside the body therefore does
not climb:

```lisp
(x 4 c >)        ; plays c c c c — NOT c, c↑, c↑↑, c↑↑↑
c > c > c > c    ; this climbs (spell it out, or (go … N) which is the same loop)
```

A trailing shift only moves the state for what comes **after** the loop:
`(x 4 n > n <)` plays `n n↑` four times (the `<` is a no-op inside the loop),
but the `<` keeps the octave from drifting up by one each time you re-invoke the
snippet or continue with more notes. So use `<`/`o-` to rebalance a body whose
net octave change is non-zero when it is reused or followed by more notes.

### Labels and `go`

```lisp
(fm1 :len 8
  #verse
  c e g e
  (go verse 4)     ; the #verse section plays 4 times, then falls through
  #head
  c g
  (go head))       ; infinite loop
```

`(go label N)` compiles to the same loop as `(x N ...)`; the label and the
`go` may even live in different forms of the same channel. A loop resumes at
the label, so what is written before it — a `:tempo`, `:lfo-rate`, voice or
`:vel` ahead of `#label` — plays once and is not re-applied on the way round.
See `docs/language.md` §13.

---

## 7. Definitions and Reuse

### `def` (named snippet)

```lisp
(def riff c e g e)

(fm1 :oct 4 :len 8
  riff
  riff)
```

`def` expands inline.

### Parametric snippet — `(def (name param…) …)`

When phrases differ by only a token or two, give the snippet parameters and call
it as `(name arg…)`. Each argument node is substituted for its parameter in the
body (token-level only — no arithmetic); a wrong argument count is `E_DEF_ARITY`.
A `let` or `for` inside the body keeps its own names, so an argument always
means what it meant where the call is written.

```lisp
(def (beat n) (x 8 > n > n <))

(fm1 :oct 1
  (beat c) (beat b-) (beat a) (beat f))
```

### Sharing across files — `(import "…")`

Put voices, macros, or snippets you reuse into their own file and pull them in
with `import`. It merges those defs at compile time — no runtime cost, exactly
as if you'd pasted them in.

```lisp
; voices-lib.mmlisp — a defs-only library (no tracks)
(def-fm lead init-fm :alg 4 :fb 3 :tl1 30)
(def vib  (macro :pitch+ (sin -30..30 :len 8)))
```

```lisp
; song.mmlisp
(import "voices-lib.mmlisp")
(fm1 lead vib c e g e)          ; lead / vib come from the library
```

The path is relative to your score (open its folder with File > Open Folder…).
In the live editor, **⇧Shift-dragging a `.mmlisp` onto the window** writes the
`(import "…")` line for you — a plain drag opens the file instead.
An imported def is a **default you can override** — a local `(def lead …)` of
the same name wins. Only defs are imported; `def-val` slots and tracks in the
library file are ignored. Two imports that define the same name are an error,
unless the later one says `:over` — then its defs replace the earlier ones', and
the names it lacks stay. That is how one kit fills in for another:

```lisp
(import "presets/gm-drums/set.mmlisp")      ; every GM drum name
(import "presets/tr808/set.mmlisp" :over)   ; the 808 where it has one
```

Full reference: `docs/language.md` §9.2.

---

## 7b. Compile-time Expressions

Parenthesized forms with an arithmetic head are computed at compile time and
bake to static data — the sound is the same as if you'd typed the number, but
you write intent. Full reference: `docs/language.md` §7.

**Numbers.** `+ - * / min max abs round floor` in any value position:

```lisp
(fm1 :tl1 (+ 20 10)              ; = :tl1 30
     :fb  (min 7 (round 5.4)))   ; = :fb 5
```

**Curves.** A curve is a value too. Shift or scale one and it stays a curve
(zero cost); multiply two same-kind curves and it bakes to a step vector:

```lisp
(fm1 (macro :pitch (* (sin :from -1 :to 1 :rate 6 :len 4f) 40)))  ; ±40¢ vibrato
```

**`let`** binds a local value (number or curve) for its body — handy for a
root note or a shared depth you tweak in one place:

```lisp
(fm1 :len 8
  (let [root 60]
    (note root) (note (+ root 4)) (note (+ root 7))))   ; c e g, from one root
```

**`(note n)`** plays a computed MIDI number (C4 = 60), otherwise a normal note.
An optional second argument is its length — a token (`4`, `20f`), `(ticks …)` /
`(frames …)`, or an expression (a bare number is a denominator, so `(+ 2 2)` is
a quarter). `let` names must be words, not note letters (`a`–`g`).

**`for`** writes its body out once for each value — a run, an arpeggio, a
pattern that shifts each time:

```lisp
(fm1 :len 16
  (for [i 0..7] (note (+ 60 i)))              ; c up to g, a semitone at a time
  (let [root 48]
    (for [n [0 4 7 12]] (note (+ root n)))))  ; c e g c, offsets from one root
```

Values are a range (`0..7`, both ends included) or a list of numbers; notes
are MIDI numbers, so write a chord as offsets from a `let` root. Several
names nest: `(for [o 0..1 n [0 7]] …)`. When every pass is the same, use
`(x N …)` instead — it repeats one body on the driver.

**`if`** chooses between two branches when the score compiles. With `for` it
varies a pattern pass by pass:

```lisp
(fm1 :len 16
  (for [i 0..15]
    (if (= (mod i 4) 0) (note 72) (note 60))))   ; up an octave on each beat
```

A comparison (`=` `<` `>` `<=` `>=`) gives 1 or 0, `not` flips it, and `if`
takes any non-zero as true. In the note stream the `else` may be left out; in
a value (`:tl1 (if … 20 30)`) it is required. The test cannot read a `$`
value — the driver does not branch, so a choice made while the song plays is
written another way (a `$` in the value itself, §7.1.2 of the reference).

---

## 8. FM Voice Definitions

An FM voice is a `def-fm`: a keyword map of the YM2612 algorithm/operator
parameters. The quickest way is to extend the built-in neutral patch `init-fm`
— name it first — and override only what you need:

```lisp
(def-fm brass init-fm
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0)

; use by bare identifier:
(fm1 :oct 4 :len 8
  brass
  c e g e)
```

`init-fm` (ALG 7, full envelope, TL 0 on all operators) is always available as
a base, and any voice of yours can be one too. You can also write a full patch
from scratch — every operator's `:ar`/`:dr`/`:sr`/`:rr`/`:sl`/`:tl`/`:ks`/`:ml`/`:dt`
plus `:alg`/`:fb`/`:ams`/`:fms`; unset params are not emitted, so start from a
full patch or extend one. See
`docs/language.md` §9 for the full parameter list.

### Velocity that changes the timbre

`:vel` normally moves only the carriers, so a softer note is quieter but the
same colour. `:vel1`–`:vel4` give an operator its own share of the velocity,
a ratio from 0 to 1. On a modulator it makes a soft note darker as well as
quieter, the way a struck instrument behaves:

```lisp
(def-fm keys init-fm :alg 4 :fb 5
  :tl1 28 :vel1 0.5        ; op1 modulates op2: half the velocity
  :tl2 0
  :tl3 32 :tl4 0)

(fm1 keys :len 8 :vel 15 c :vel 9 e :vel 4 g e)
```

Unset, a carrier takes all of it and a modulator none, so existing voices
sound as before. A carrier below 1 narrows the voice's dynamic range. `:vol`
and `:master` never reach a modulator, so a fade keeps the timbre. The FM
panel's VEL row sets it per operator (language.md §6).

---

## 9. Macro Basics (`(macro ...)`)

Macros are KEY-ON scoped per NOTE_ON.

### Single-target def

```lisp
(def pluck (macro :vel [15 12 8 4 0]))
```

### Multi-target def

```lisp
(def synth-env (macro
  :vel   [15 12 8 4 0]
  :pitch (linear :from 0 :to -1200 :len 8)))
```

### Use-site forms

```lisp
(def pluck (macro :vel [15 12 8 4 0]))

(fm1 pluck c)                              ; bare name — applies the macro def
(fm1 (macro :vel [15 10 5 0]) c)           ; inline anonymous macro
(fm1 (macro pluck :pan [left center right]) c)  ; mix named + inline
```

If the same target appears multiple times, last one wins.

### Relative macros (`+` / `*`)

A macro target may take a trailing operator to combine its values with a base
instead of replacing it.

**`*` multiplies** (ratios, typically `0`–`1`; `effective = value × base`).
Supported on `:vel`, whose base is the note's `:vel` — resolved per note, so the
def tracks per-note `:vel` changes:

```lisp
(fm1 :vel 12 (macro :vel* [1 0.5 0]) c)   ; peaks at 12, then 6, then 0
```

**`+` adds.** On `:vel` it offsets by the note's vel (baked per note-on). On the
offset targets `:pitch` / `:semi` it is **additive over the channel's live pitch
offset** — each frame writes `note + (offset + macro sample)`. So one shared
vibrato macro plus a per-voice static `:pitch` detune makes a chorus:

```lisp
(def vib (macro :pitch+ (sin :from -40 :to 40 :len 8 :wait 4)))

(fm1 :oct 5          vib c e g)    ; wobble centered at 0
(fm2 :oct 5 :pitch 8 vib c e g)   ; centered at +8c → detuned against fm1
```

Plain `:pitch` / `:semi` (no `+`) **override** the offset instead. `*` on an
offset target (e.g. `:pitch*`) has no base to scale and is a compile error
(`E_MACRO_OP_NO_BASE`).

---

## 10. Multi-stage Macro and `wait key-off`

Multi-stage uses a vector of curve/wait stages and runs sequentially for one target.

```lisp
(def adsr-curve (macro :vel [
  (linear :from 0  :to 15 :len 4)
  (wait key-off)
  (linear :from 15 :to 0  :len 4)
]))
```

Behavior:

- Triggered at KEY-ON
- First stage runs attack
- `(wait key-off)` holds value until KEY-OFF
- After KEY-OFF, following stage runs release

`(wait token)` waits by length token (same forms as `:len`).

### Cycling sustain (looping stage)

A **looping** curve stage runs until KEY-OFF instead of for a fixed `:len`,
giving a modulated sustain (LFO). Loop-wave curves (`sin` `triangle` `square`
`saw` `ramp`) loop by default; any other curve loops with **`:mode loop`**
(and `:mode shot` plays a loop wave once):

```lisp
(def organ (macro :vel [
  (ease-in :from 0 :to 15 :len 2)         ; attack
  (sin :from 13 :to 15 :len 4)            ; vibrato sustain — loops until key-off
  (ease-out :from 15 :to 0 :len 6)        ; release
]))
```

`:mode loop` makes a non-loop curve cycle, e.g.
`(ease-out :from 15 :to 0 :len 4 :mode loop)` as a pulsing sustain stage.

### Numbers and curves in one vector

A vector can mix plain values with stages: a number is one `:step`, a curve
runs for its `:len`. A flat run is a curve from a value to itself — combined
with `:step` it fires once per step, e.g. to retrigger for a fixed span after
key-off without listing repeats (see §12):

```lisp
(def swell (macro :vel [15 12 (linear 12..0 :len 8f)]))   ; two steps, then a fade
(def tail (macro :step 16 :keyon [(wait key-off) (linear 1..1 :len 8)]))

(fm1 tail :len 4 c)   ; fire every :step across :len 8 after key-off
```

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
Inline `:mode white2` sets the mode as persistent channel state — it holds
across notes until the next `:mode`. A `:mode` macro (see §14) layers a
temporary per-note override on top.

---

## 12. Step Macros (`:semi`, `:keyon`, `:step`)

Step-vector macro targets for arpeggios, drum rolls, and per-note echo tails.

### `:semi` — semitone arpeggio

Discrete semitone offsets (the counterpart to `:pitch`, which is continuous
cents). On a sustained voice this is a classic arpeggio. `#sus` marks the loop
point.

```lisp
(fm1 (macro :step 1/16  :semi [#sus 0 4 7])  c)   ; c–e–g, looping
```

### `:snap` — stay in a scale

`:snap` gives the channel a scale (its pitch classes, 0 = C), and every pitch
it writes from then on — the notes, a `:semi` arp's steps, a transposition —
snaps down onto it; cents (vibrato, glide) ride the snapped note. So a
chromatic arp becomes a scale run, and the same line changes mode when the
mask changes — from a `$slot` the game writes, if you like (§18b).

```lisp
(def major [0 2 4 5 7 9 11])
(fm1 :snap major (macro :step 1/16 :semi [#sus 0 1 2 3 4 5 6 7]) c1)  ; c d e f g a b c
(fm1 :snap none c+)                                                   ; off again
```

### `:keyon` — retrigger gate

Sampled once per `:step`; a value `>= 0.5` fires a key-on retrigger (re-attacks
the envelope). Accepts `0`/`1` step lists, a scalar, or a curve/stochastic
signal.

- `:keyon 1` — retrigger every step (drum roll)
- `:keyon [0 #rel 1 1 1]` — retrigger only in the release section (after KEY-OFF)

`:keyon` honors `#rel`: steps before `#rel` loop until the gate (a roll that
stops at KEY-OFF); steps after `#rel` fire after KEY-OFF (a 1-channel echo
tail). While a `:keyon` macro is active it owns the channel keying — the note
keys off after the last retrigger.

```lisp
(fm1 (macro :step 32 :keyon 1)  c)   ; drum roll
```

### `:step` — sampling clock

`:step token` lives inside the `(macro ...)` form and sets the **sampling
interval**. It is **position-free**: one `:step` applies to every target in that
macro, wherever you write it. Default `1f` (one 60 Hz frame). A macro takes at
most one `:step` (a second is `E_MACRO_STEP_DUP`); for two different rates, use
two `(macro …)` forms — they compose.

It applies to every macro form: a **step vector** advances one step per `:step`;
a **curve** is sampled-and-held every `:step` (so a coarse step turns a smooth
curve into a stepped / sample-and-hold one — e.g. `:step 8 :tl1 (sin …)` is a
1/8 stepped LFO; the default `1f` keeps curves smooth). A curve-form `:keyon` is
just a curve sampled at `:step`, so `:keyon (square …) :step 16` gates
retriggers on the 1/16 grid.

```lisp
(fm1 (macro :step 1/16 :semi [#sus 0 4 7])   ; arp on the 1/16 grid
     (macro :step 1/8  :keyon [0 #rel 1 1 1])  ; echo tail on the 1/8 grid
     c)
```

### Echo-tail preset (1-channel delay on one note)

```lisp
(def echo-tail (macro :step 1/8  :keyon [0 #rel 1 1 1]
                                 :vel   [15 #rel 10 5 0]))

(fm1 echo-tail :len 8  c _ _ _)
```

After KEY-OFF the note retriggers three times at 1/8 spacing, decaying via the
phase-locked `:vel` release. (`:vel` floors at ~-30 dB; for a tail that fades to
true silence, automate `:tl` to 127 instead — see §5.) For a long tail, replace
the `1 1 1 …` list with `[(wait key-off) (linear 1..1 :len N)]` — it fires once per
`:step` across `:len` without counting taps (see §10).

Clear a macro with `none`: `(macro :semi none)`, or `(macro none)` clears all.

---

## 13. Track Delay (`(delay ...)`)

`(delay ...)` echoes the **written notes** at compile time — a whole phrase
repeats, shifted and decayed. (Distinct from `:keyon`, which retriggers a single
note.) Taps are **relative** to each note's own value: an echo follows whatever
velocity that note carries.

```text
(delay N :vel+ step :time T)      ; N taps, each `step` further (tap k = vel + k·step)
(delay N :vel* ratio :time T)     ; N taps, each × ratio (tap k = vel · ratio^k)
(delay :vel+ [d1 d2 …] :time T)   ; the taps themselves, each relative to the note
(delay :vel* (curve …) :time T)   ; an envelope: its :len ÷ T taps
```

- `:vel+` adds, `:vel*` multiplies — the value after it is what each tap
  changes, as everywhere else (§7.0 of the reference).
- `:time T` — tap spacing (length token).

`(delay ...)` is **sticky** track state that applies to following notes;
`(delay none)` clears it, `(delay :vel none)` clears one target. Delay is an
**overlay** that fills gaps — it does **not** lengthen the phrase.

```lisp
(fm1 (delay 3 :vel+ -4 :time 1/8)
  c e g e)
```

plays the phrase plus three decaying repeats (−4 vel each tap), spaced an eighth
apart. The same taps written out: `(delay :vel+ [-4 -8 -12] :time 1/8)`.

```lisp
(fm1 (delay 3 :vel+ -1 :time 4t)  c e g e)   ; 3 echoes, −1 vel each, spaced 4t
(fm1 :len 16 (delay :vel* (linear 0.8..0 :len 4) :time 16)  c _ _ _ _)  ; ratio fade
```

The channel is monophonic: written notes take priority. A tap that would start
while a written note sounds is dropped; one that starts in a gap is cut short
at the next written note, and a newer tap cuts an older one. So the dry note's
`:gate` decides where the taps get in — a dotted-eighth delay on quarter notes
needs the quarters released at the dotted eighth:

```lisp
(fm1 (delay 3 :vel+ -4 :time 8.)  :len 4 :gate 8. c _ g _ e _ d _)
```

For true overlapping delay, `def` the phrase and replay it on another channel.

### `(echo ...)` — phrase-lengthening replay

`(echo ...)` is an inline note-replay that **lengthens** the phrase: its taps
occupy real time, so later notes shift back. This is the opposite of `(delay
...)`, which overlays into gaps without lengthening. `(echo ...)` is relative and
**one-shot** at its position (not sticky). It is how the mucom88 import writes
`\=`; for an echo effect in your own score, write `(delay ...)`.

```text
(echo N :vel+ step [:back B])      ; N taps at the current :len, each `step` further
(echo N :vel* ratio [:back B])
(echo :vel+ [d1 d2 …] [:back B])   ; the taps themselves
(echo :vel* (curve …) [:back B])   ; an envelope: its :len ÷ the current :len taps
```

- The value reads as in `(delay …)`; the taps are spaced by the current
  `:len`.
- `:back B` — replay the single note B positions back (`B=1` = the last note,
  the default).

```lisp
(fm1 c (echo 3 :vel+ -1))         ; last note replayed at vel−1, −2, −3 (decaying trail)
(fm1 c (echo 3 :vel* 0.7))        ; ×0.7, ×0.49, ×0.343
(fm1 c e (echo 1 :vel+ -4 :back 2))  ; replay the note 2 back (c) once at vel−4
(fm1 c (echo :vel+ [-1 -4 -8]))    ; three taps, written out
```

### Echoes inherit articulation

Delay echoes carry the source's per-note macros (`:keyon`, `:semi`, …), so a
phrase with a 1-channel `:keyon` tail repeats with that tail.

```lisp
(def echo-tail (macro :step 16 :vel [15 #rel 10 5 0] :keyon [0 #rel 1 1 1]))

(fm1 echo-tail (delay 4 :vel+ -3 :time 4)
  :len 16 c _ _ _ :len 4 _ _ _)
```

Each phrase repeat retriggers like the source; its vel tail rides the note's
velocity, lowered by the delay's per-tap step.

---

## 14. Noise Authoring (`noise` channel)

```lisp
(def perc-buzz (macro :mode [white0 #sus periodic3]))
(def hh-env (macro :vel [15 9 4 0]))

(noise :len 8 (macro perc-buzz hh-env)
  c c c c)
```

- The channel starts in `white0`; inline `:mode` sets the persistent mode
  (see §11), and a `:mode` macro writes `NOISE_MODE` for per-frame timbre
  motion as a temporary override

---

## 15. Gate and Hold Notes

The gate family controls how long the note sounds within its slot. The
operation is chosen by the keyword so the argument is never ambiguous:

```lisp
(fm1 :len 8 :gate  24t  c d e f)  ; absolute: KEY-OFF 24 ticks into each slot
(fm1 :len 8 :gate* 0.5  c d e f)  ; ratio:    KEY-OFF at 50% of each slot
(fm1 :len 8 :gate- 2t   c d e f)  ; minus:    KEY-OFF 2 ticks before each slot ends
```

> **Every note attacks; `~` is how you join them.** A note at full gate sounds
> for its whole slot and still keys off at the very end, so the note after it
> attacks. You never need a cut just to hear the repeats:
>
> ```lisp
> (fm1 :len 16 c c c c)     ; four distinct attacks
> (fm1 :len 16 c ~ c ~ c c) ; one attack held over three slots, then a new one
> ```
>
> The gate family is for articulation — how *short* a note is inside its slot —
> not for separating notes. Joining them is `~` (§3): a tie at the same pitch,
> a slur at a different one.
>
> This matters on FM, where the key-off → key-on transition *is* the attack: a
> note that ran into the next without one would swallow it. PSG re-asserts its
> attenuation and PCM restarts its sample on every note, so those attack either
> way; `~` is what holds them over.

### `:gate 0` — hold, timeline advances

`:gate 0` fires KEY-ON and holds indefinitely, but the timeline still advances by `:len`. Use this when the channel needs to stay in sync with others while holding a note.

```lisp
(fm1 :len 4 :gate 0
  c _ _ _)   ; KEY-ON on beat 1, timeline moves 4 beats, KEY-OFF via runtime
```

### `:len 0` — hold, the track waits

`:len 0` fires KEY-ON, holds indefinitely, and **stops the track** there: what follows waits for the key-off, then plays on from that moment. Useful for a held note with a release macro, or a charge-up whose release shot follows it:

```lisp
(sqr1 :len 0 (macro :vel [15 #sus 14 13 #rel 8 4 0])
  c)
(fm1 :len 0 c :len 8 > c)   ; c holds; the key-off lets it go and > c plays
```

In both cases the key-off is the game's (`MMLisp_keyOff`); in MMLisp Live it is Tools > Release Holds (⌘⇧↩ / Ctrl+Shift+Enter).

---

## 16. Track Append by Channel Name

Repeating the same channel form appends events and keeps sticky state.

```lisp
(fm1
  c e g e)
(fm1
  f g a g)
```

---

## 16b. Layering with `:prio`

By default, repeated forms of a channel **append** (§16). To instead **layer**
two forms on the same channel at the same time, give them different `:prio`
values.

- `:prio N` — unsigned integer, **lower number = higher priority**. Default `8`.
- **Same `:prio` → append** (one timeline; the §16 behaviour).
- **Different `:prio` → layer** as parallel timelines on the one physical
  channel. The channel is monophonic, so collisions are resolved by priority:
  the higher-priority (lower-number) note sounds, and the lower-priority part
  fills the gaps it leaves.
- Resolution is **preemptive**: a higher-priority note that begins while a
  lower-priority note is sounding cuts it off (the lower note is simply
  silenced at that point — no release tail).

```lisp
(fm1 :prio 1  :len 4   c _ _ g _ _)   ; sparse lead — always sounds
(fm1 :prio 5  :len 16  e e e e e e e e e e e e)  ; filler — yields to the lead
```

The whole thing is resolved at compile time into a single event stream, so the
player and driver still see one track per channel. A counted loop on a layer
is written out before the layers merge, so it plays as written. The channel
has one song loop: any layers may carry it, but they must start and end it on
the same ticks (`E_PRIO_LAYER_LOOP` otherwise), and notes past its end never
play.

---

## 17. FM3 CSM Mode

In CSM, Timer A re-keys FM3 at an audio rate: the rate is the pitch you hear,
and where the four operators ring is the formant.

```lisp
(fm3-csm :csm-rate 110
  c _ c _)
```

- `fm3-csm` puts FM3 in CSM mode; its notes set the formant (each operator
  rings at the note times its own `:ml`).
- `:csm-rate N` sets the Timer A frequency, `:csm-rate (curve ...)` sweeps
  it; an `fm3-csm-rate` track writes the rate as notes instead.

A formant per operator — a vowel, a vocoder voice — is the same channel with
the operators as tracks: a note-less `(fm3-csm voice)` holds the patch,
`fm3-1`–`fm3-4` each put one operator at a frequency and a level, and the
`fm3-csm-rate` track sings. The buzz plays while that track plays; a rest on it
is a breath.

```lisp
(def-fm vowel init-fm :alg 7 :rr1 15 :rr2 15 :rr3 15 :rr4 15)
(fm3-csm vowel)
(fm3-1 :oct 5 :len 2 c+ ~ c+)        ; F1 ≈ 550 Hz
(fm3-2 :oct 6 :len 2 f+ (macro :vol [31 28 24 20]) a)   ; F2 moves: "ah" to "eh"
(fm3-3 :oct 7 :len 1 d+ :vol 20)     ; F3, softer
(fm3-csm-rate :oct 2 :len 4 g g _ a)
```

---

## 18. Tempo Sweeps

`:tempo` is written inline in a track body and accepts a curve form for
smooth changes:

```lisp
(fm1 :tempo 120 :len 4
  c e
  :tempo (linear :from 120 :to 180 :len 8)
  g c)
```

- `:tempo N` changes tempo immediately (`TEMPO_SET`).
- `:tempo (linear :from N :to M :len L)` emits `TEMPO_SWEEP` — any curve name
  works (`ease-out`, `sin`, …; there is no curve literally named `curve`).
- Tempo is global: all tracks follow the change.

---

## 18b. Dynamic Parameters (`def-val` / `$name`)

Declare a runtime value with `(def-val ...)` and reference it with `$name`
anywhere a runtime parameter takes a value. The live app renders a **Dynamic
Parameters** slider for each one — drag it while the score plays — and marked
`:public` it is also an input the game writes.

```lisp
(def-val cutoff 30 0..127 :public)
(def-val depth 20 0..60 :public)

(fm1 :tl1 $cutoff                              ; absolute from the slot
     :tl2+ $cutoff                             ; relative to the slot
     (macro :pitch (sin :from -40 :to $depth)) ; dynamic LFO depth
     c e g e)
```

A slot can also be a scale: `(def-val scale 2741 0..4095 :public)` and
`:snap $scale` (§12) — the game writes the mask, and the melody changes mode.

- `:from` / `:to` set the slider's endpoints (either direction); the
  positional value is the initial setting.
- `$time` is built in: elapsed 60 Hz frames since playback started.

**The score's own values.** Without `:public` a `def-val` is a variable of
the score: nothing the game sees (its slider is still there, so you can nudge
it by hand — a hand's write ends the score's sweep of it, as the game's
would). The score writes it like any
parameter — `:name 12`, `:name+ -4`, `:name (linear 0..40 :len 8)` — from any
track, and every track reads it. One sweep can then turn a knob across the
whole song, wherever it is read:

```lisp
(def-val open 16)                                    ; 16 = dark
(fm1 :open (linear 16..0 :len 8/1) :len 1 (x 8 _))   ; eight bars to open up
(fm2 :len 8 (x 64 :tl2 (+ 20 $open) c e g e))        ; read at each write
```

**Expressions over slots.** A `$name` can sit inside an arithmetic expression;
it is evaluated at the event, so the write tracks the slot live:

```lisp
(fm1 :tl1 (+ 20 (* $tension 0.2))   ; the level follows tension every write
     c e g e)
```

**When each read happens (sampling tiers).** The same `$name` differs only in
*when* it is read:

- **event** — `:tl1 (+ $a 5)` reads at the directive (game writes → next write follows).
- **note-on** — a sweep's `:from`/`:to` read when the sweep fires, so a later
  note swells to a new target:  `:vol (linear :from $lo :to $hi :len 60f)`.
- **frame** — a **scaled macro** `(* <LFO> $slot)` reads every frame, so the
  slot is a live **depth knob**:

```lisp
(def-val depth 128 0..255)                       ; 0 = off, 255 ≈ full
(fm1 (macro :pitch (* (sin -40..40 :len 8f) $depth)) c e g)  ; live vibrato depth
(fm2 (macro :tl1  (* (triangle 0..40 :len 8f) $depth)) c e g)  ; live tremolo
```

Curve `:from`/`:to`/`:rate`/`:len` also accept a bare `$name`, read once per
note-on. (On the driver, inline-sweep endpoints are slot-fed; slot-fed
macro-curve params and a sweep's `:len` bake to the slot's initial value.)

See `docs/language.md` §7 (expressions, scaled macro) and §8 (`:step`, `:unit`,
the IR mapping).

---

## 19. PCM Samples

Samples are defined with `(def-pcm name …)`, then named in a `pcm1` / `pcm2` / `pcm3` body — before the notes, and again wherever the sound changes — as a voice is on FM.

```lisp
(def-score :pcm-voices 2)
(def-pcm kick :file "sounds/kick.wav")
(def-pcm snare :file "sounds/snare.wav" :rate 11025)

(pcm1 kick :tempo 120  :len 4  c _ c _)
(pcm2 snare :len 4  _ c _ c)
```

- `:file` is required.
- `:rate` overrides the C4 playback rate.
- Stereo WAV files are downmixed to mono at compile time.
- WAV data is converted to 8-bit signed PCM at compile time.

**Decide how many voices you need first.** `(def-score :pcm-voices N)` is a whole-song
choice, and it buys quality: one voice plays at 14.4 kHz, two at 10.1 kHz,
three at 6.7 kHz. Leave it out and it is the highest `pcmN` track you wrote,
so an idle third track costs the other two their bandwidth. The samples all
share the available sample storage, and every note you play a sample at is
baked separately. Single-bank profiles hold about 2.3 seconds at one voice or
4.9 seconds at three. NTSC and PAL songs with up to three voices automatically expand
to [multi-bank PCM](pcm-multibank.md) when needed, at about 10.1/10.0 kHz for one or two voices and 6.65/6.59 kHz for three (NTSC/PAL). This expands
total storage; an individual baked sample must still fit within 32,512 bytes.

**Make it loud before it is baked.** An 8-bit sample next to FM tends to sound
thin; `:fx` processes it at compile time, in the order written, at no cost
to the driver (language.md §16):

```lisp
(def-pcm snare :file "sounds/snare.wav"
  :fx [(comp :threshold -30 :ratio 8)   ; squeeze the body up to the peak
           (normalize)                        ; put the peak back at full scale
           (fade :len 60ms :curve ease-out-expo)])  ; shorten the tail
```

`comp` alone only takes level off — end the chain with `(normalize)` (or push
with `gain` and cap with `(limit)`) to turn it into loudness. `(normalize)` on
its own scales a quiet file to full scale, `(crush 4)` is the lo-fi
step, `(hpf 100)` / `(lpf 3000)` cut the lows or highs, `(drive 12)`
saturates, and `(fade …)` cuts the sample where it ends — which also frees bank
space. A whole kit takes one chain on its import, and one sound a variant of
its own:

```lisp
(import "presets/tr808/set.mmlisp" :fx [(gain 12) (limit)])
(def-pcm snare-hot snare :fx [(fade :len 60ms)])
```

**Put the cursor on a sample def to play it from the keyboard**, as with an FM
voice: each key bakes that def at that note, effects included, and plays it on
the driver's engine; the next Play or Build puts the song's bank back. While
the song plays, the engine is the song's, so the key — and Library's ▶, and
the completion list — plays the same baked bytes on a player of its own beside
it: you can play along. That player
follows the key's velocity smoothly rather than in the driver's 6 dB steps.

Two things a PCM voice cannot do: **bend** (a note picks a pre-baked blob, so
`:pitch`, `:semi`, `(glide …)` and a pitch vibrato are errors on a pcm track)
and **fade smoothly** (the level ladder is 6 dB a step). Put a fade on FM or
PSG when it has to be smooth.

A note plays between four points of its sample, the way a sampler does:

```
:pcm-start ── :loop-start ════ :loop-end ── :pcm-end
```

The **range** (`:pcm-start`, `:pcm-end`, `:pcm-len`) is what a note plays: a
`shot` plays it once — the tail of a crash, one word of a phrase. The **loop**
(`:loop-start`, `:loop-end`, `:loop-len`) sits inside it: `:mode loop` plays
from the range's start, repeats the loop while the note is held, and after the
note-off runs on to the range's end — attack, sustain, release. Leave the loop
out and it is the whole range. All six take lengths — `300ms`, `16`, `6t` — on
the sample def and on the track, and on the track they also take curves. On a
track they hold for the notes that follow, like any track parameter — and so
does `:mode loop`, until a `:mode shot`. A shot plays on through its gate;
**`:mode gate`** plays the range once and is cut at the gate, so `:gate` is
how long it sounds — a hi-hat closed short and opened long on one channel.

One thing it can do that nothing else on this machine does: **move its loop
while the note sounds**:

```lisp
(pcm1 pad :mode loop :len 1
  :loop-len 16                                   c   ; a 16th-note loop
  :loop-len (linear :from 100ms :to 2ms :len 2)  c)  ; tightened to a buzz
```

The points round to 16 bytes (1.11 ms at one voice), which is also the shortest
loop there is — so this is a rhythmic device, not a way to play pitches.
language.md §16 has the rest.

**What you hear in the editor is the driver.** The preview bakes the samples
exactly as an export does and plays them through the driver's own engine: 8-bit,
at the rate your `pcm-voices` picks, with the same 6 dB level steps and the
same loop rounding. A sample that sounds dull or stepped in the editor will
sound that way on the Mega Drive, and the other way round. The mixer's PCM
faders are the one exception — a preview convenience the driver does not have.

**Drag a `.wav` onto the live editor** and its `def` is written for you at the
cursor. Drag it out of the folder you opened with `File > Open Folder…` and the
`:file` path is the right relative one; drag it from anywhere else and the def
gets the bare file name — it plays straight away from memory, but only survives
a reload once the wav actually sits next to the score.

---

## 20. Stochastic Curves

The curve system includes `noise`, `pink`, `perlin`, and `brown`. They are
**macro-only**: a macro bakes their values into the table the driver plays,
while an inline sweep (`:tl1 (brown …)`, `:tempo`, `:csm-rate`) would reach
the driver as a bare curve id it cannot evaluate, so it is an error
(`E_CURVE_MACRO_ONLY`). A macro restarts at each key-on, so the movement lives
inside each note — a long note wanders furthest.

They are **deterministic** — the same source always bakes the same sequence.
Add `:seed N` to pick a different (statistically independent) sequence; the
default seed is fixed, so a seedless curve is stable across builds. `:seed`
costs nothing at runtime (the values are baked at compile time).

```lisp
(fm1 (macro :tl1 (noise :from 8 :to 0 :len 8f))          ; one fixed sequence
     (macro :tl2 (noise :from 8 :to 0 :len 8f :seed 42)) ; a different one
     c e g)
```

---

## 21. Example

```lisp
(def-fm fm-init :alg 0 :fb 0 :ams 0 :fms 0
  :ar1 31 :dr1 0 :sr1 0 :rr1 15 :sl1 0 :tl1 127 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2 0 :sr2 0 :rr2 15 :sl2 0 :tl2 127 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3 0 :sr3 0 :rr3 15 :sl3 0 :tl3 127 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4 0 :sr4 0 :rr4 15 :sl4 0 :tl4 127 :ks4 0 :ml4 0 :dt4 0)

(def-fm brass fm-init
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0)

(def phrase c e g e)
(def env (macro
  :vel [15 12 8 4 0]
  :pan [#sus left center right center]))

(fm1
  brass
  env
  phrase
  (x 2 phrase))

(noise
  c _ c _)
```

---

## 22. Editing values in the live app

Every adjustable value in the source can be nudged in place — no retyping. This
covers keyword numbers (`:vel 12`, `:tl1 45`, `:pitch -40`, `:oct 4`), every
note-length form (`8`, `8.`, `16t`, `16f`, `3/4`), note names (`c`, `c+`), the
note + length compound (`c4`, `e8.` — the note and the length edit separately),
and the `v±` / `o±` shifts. A voice or sample name a track plays is a token
too: long-pressing it opens the name list (Completions, below) on it.

Hover a value to confirm it is editable: the whole token gets a dotted underline
and a hint shows its range. Three ways to change it:

- **Long-press** the token (works with mouse and touch) to open a popup — a
  slider + `−`/`+` steppers for a bounded number, or a one-octave piano for a
  note (tap a key to audition and set it, staying in the current octave). The
  popup stays open until you dismiss it (click away or `Esc`). On a voice or
  sample name it opens the name list instead, starting at that name: `↓` / `↑`
  step through its neighbours in the set, sounding each, and the pick replaces
  the name.
- **Alt-drag** the token up/down to scrub it — up raises, down lowers, like a
  slider (hold `Shift` for a coarse step). Desktop only; the pointer turns into
  a resize cursor.
- **`Cmd/Ctrl+Shift+.`** / **`Cmd/Ctrl+Shift+,`** nudge the value under the
  cursor up / down (the `>` / `<` keys, matching MML's octave shifts); add
  `Alt` for a coarse step.

While the score is playing, an edit hot-swaps at the next bar so you hear it
immediately; stopped, changes apply on the next **Build**. Tap a bar marker `|`
for its bar number and tick count (§4).

### Following the playback

`MMLisp > Follow Playback` keeps the highlighted notes in view while the score
plays. The view stays put as long as they sit comfortably inside the editor —
a looping pattern never moves it — and glides once one drifts toward the edge,
turning the page so the notes land near the top. When the tracks are too far
apart to show at once, it goes where the music is busiest — the biggest group
of highlights that fits, the lowest track first — but leaves what is on screen
only for a clearly bigger group, and not again for a few seconds after a
turn. Scrolling, clicking or typing in the editor hands the view back to you
for a few seconds.

### The piano roll

`MMLisp > View` turns the score's three views on and off, each on its own:
**Source** (the text and its line numbers), **Piano Roll** (a pane under the
editor; drag the line between them to size it) and **Oscilloscope** (each
channel's waveform behind the text; a PCM track shows its own voice, not the
DAC's mix — under MMLispDRV, which streams the DAC itself, their sum). With
Source off the oscilloscope fills the editor's place; with both off the piano
roll takes the whole column — a view for listening, or for a phone. While a
phone's or tablet's on-screen keyboard is up, the piano roll steps aside and
gives its height to the text. In the piano roll, every pitched channel shares
one pitch axis, with the keys down the left, so what the tracks play at one
moment — the chord, the spacing, a clash — reads at a glance; noise and PCM
tracks, and each sound of a ROM rhythm (`kick`, `snare` …), are rows of onset
marks underneath. Many rows (x68k's `pcm1`–`pcm8`, pc88's rhythm) grow thinner
rather than crowd out the pitches — together they take at most a third of the
pane — and once too thin to name, only the focus's row is named. The playhead
stands still and the music runs past it.

One channel is in focus: the one whose form holds the editor cursor, or
whose note you click. It is drawn bright, the others dim, its sounding keys
light up, and behind the playhead a line traces the pitch the chip actually
played — glides, vibrato and arpeggio macros as they sounded. The pitch axis
follows it: its range and a few semitones either side, so a wide song stays
readable; the other channels show what falls inside. With the cursor in no
channel's form (a comment, a def with no note there, the score's settings),
nothing is in focus: every channel is drawn alike over the whole song's
range. Clicking a note
selects the note it came from in the score (for a note inside `(x …)` or a
def, the one written there); hovering one names its channel, pitch and
length. The other way round, the notes written at the cursor (or inside the
selection) are drawn solid in the roll, every time they play — a note in a
def lights up wherever the def is used.

The grid marks quarter notes from the top of the song. MMLisp has no meter, and
`|` goes wherever each track's writer wants it, so the roll draws no bars.
**1× 2× 4×** zooms; a wider pane shows more of the song at the same scale, and
zoomed in, eighths and sixteenths are marked too. On a phone the zoom control
can sit over the top note; scrolling the roll shows it. Drag the roll sideways
to move through the song, as the TIME bar does: playing, the song pauses while
you drag and plays on from where you let go; stopped or paused, it sets where
Play starts. The roll shows the last build: after an edit, play or Build to
bring it up to date.

### Playing from a point

**TIME**, under Global in the panel, shows where the song is, and its bar spans
one pass of it: up to where every part is in its loop — a part that plays once,
to its end — and one time round from there, that point marked on the bar. Past the end the position carries on from the loop start, as the
song does. While it plays, tap or drag the bar to play from there; as you
drag, it keeps playing a moment from under your finger, so the spot can be
found by ear. Stopped or paused, the bar only sets the point — the piano
roll moves to it — and Play starts there, Resume picks up there, and Stop
puts it back to the top.

**Tap a line number** to play from that line's first note — for a line in a
loop, the first time round. A label's line (`#top`) plays from the label; a line
with no note (a def, a comment) does nothing.

Either way the song is played up to the point without a sound, in an instant,
so it arrives as it would have: the voice, `:vol`, tempo and every other change
before the point are in place, not just the notes after it.

### Font size

`MMLisp > Font Size` sets the editor's text size in pixels, typed or stepped in
the same popup as a panel value — anywhere from 8 to 96, so it can go large for a
projector or a recording. It is remembered, and holds on touch screens too:
tapping into the editor does not zoom the page, whatever the size.

### The panel's editor

Below Channels the panel has one editor, for what you touched last: a strip
picked in Channels, or the def or vector the cursor went into. Its title
says what it edits — `FM`, `Wave`, `Macro :vel` — and names it. An FM
channel or voice brings the FM editor; a wave channel, a `def-wave` or a
macro's step vector brings the vector editor. When the cursor leaves what
it was on, a picked strip is the subject again; with none picked, the editor
dims and keeps showing what it had, until something else is touched.

**A voice in the FM editor.** The cursor's voice is the `(def-fm …)` it is
in, or the voice whose name it is on — in a track, or a `def-mod :voice` —
whether the score defines it or an import does, and the keyboards play it.
The title names it, with the preset set it comes from. Moving a slider writes
the def: in place for the score's own, and for an imported one, first a copy
of its def, as its file writes it, under the score's imports — a def of the
same name in the score wins over the import's (language.md §9.2), so the
tracks keep the name. One undo takes the copy back out; deleting it goes back
to the preset.

**A vector in the vector editor.** A `def-wave`'s wave, or a macro's step
vector (`(macro :vel [15 #sus 12 10 #rel 6 0])`), drawn as bars: press and
drag across, and every step the pointer passes takes the value under it, as
an array is drawn in Max or Pd. The editor draws only what the score can
hold — a wave's 32 steps at −128..127, a macro target's range (§10), and for
a relative one (`:pitch`, `:semi`, a `+` or `*` macro) a view around its
values — whole numbers, so nothing it writes is out of range. `#sus` and
`#rel` show as marks, a hold (`_`) as an empty step. Letting go writes the
vector into the score, each changed step in place (a wave written as a curve
becomes its 32 values); one undo takes the stroke back. A macro written as
one curve (`(macro :vel (ease-out 15..0 :len 4))`) shows as the steps it
plays — at its `:step`, its lengths at the song's opening tempo — and drawing
on it writes those steps as a vector, a loop curve's cycle after `#sus`; the
steps no longer follow the tempo, as a written vector does not. While a stroke goes,
a wave sounds at once on every channel playing it, so a held note changes as
you draw; with the cursor on a `def-wave`, the keys play it on a wave
channel. With Alt (Option) held, a stroke over a macro's steps makes them
holds (`_`); − and + under a macro's vector take its last step off or add
one, a copy of the last. A def-wave from an import is copied into the score
at the first stroke, under its imports, as an imported voice is. A macro
written as stages (`[(ease-in …) (wait key-off) (linear …)]`) is shown — each
stage's steps, a looping one's cycle between `loop` and `key-off`, a
`(wait key-off)` as a mark — but not drawn on.

### Chords on the keyboards

The keys play what is selected: a channel picked in the panel's Channels plays
its voice — the one the score has on it while it plays, the one its part
opens with while stopped (a PCM part, its sample: the one it last played, or
opens with) — and with no channel picked, the voice or sample under the
cursor, else FM1's. The cursor's voice or sample wins over a picked
channel from when the cursor goes into it until it leaves (The panel's
editor, above).

Every keyboard — on screen, the computer's, MIDI — is polyphonic: each held
key takes a channel of its own, with the voice copied onto it. An FM voice
has the six FM channels, a PSG one the three square channels; the noise
channel plays one note. While the score is stopped all of them are free.
While it plays, the keys take the channels it has no track on first, then
borrow its own: the selected channel — the part you are replacing — then the
parts with the fewest notes, so a chord drops the quietest ones (fm6 is never
borrowed while PCM holds its DAC). A borrowed FM channel is the keys' alone,
as an effect takes a part on the driver: the score's writes to it wait, the
release rings out, and the part comes back at its next note. A PSG channel,
or CH3 while the score uses `fm3-1`… or `fm3-csm`, is played over the score's
own writes instead. With every channel held, the oldest key gives its channel
to the newest. A sample plays one note: while the score is stopped on the
driver's engine, while it plays on a player of its own beside the song (§19).
With `Tools > MMLispDRV Backend` on, the keys sound FM and PSG only while the
score is stopped.

### Sound effects over the song

With `Tools > MMLispDRV Backend` on, a score with `def-se` forms (§9.3 of
the reference) gets a **Sound Effects** section in the panel, one button per
effect with its number — the one `MMLisp_playSe` takes. A tap while the
score plays does what the game does: the effect takes its channels from the
song, which comes back when it ends. Stopped, a tap plays the effect alone,
like Play with the cursor inside the `def-se`. An effect that holds (a
`:len 0` note) sounds while the button is held. The button is lit while
the effect plays. The IR player plays an effect alone only, so the section
is not shown with it.

### Two values under one finger: the XY pad

A score with two or more `def-val`s gets an **XY** button in the Dynamic
Parameters title. It opens a pad under the sliders: pick a value for X and
one for Y, then drag — the pointer writes both at once, their sliders follow,
and the score reads them as it does any `$name`. Each axis runs the way its
slider does (`90..10` runs its axis backwards, and `:step` snaps it), and a
slider or a learned CC moving one of the two moves the dot. A controller's XY
pad sends two CCs, so MIDI Learn on the two sliders (below) plays the pad
from the hardware. Neither value needs `:public` — a value the game never
sees is still yours to play. The pad and its axes are remembered by this
browser, as MIDI assignments are.

### A MIDI keyboard and knobs

`MMLisp > MIDI > MIDI Input` listens to every connected MIDI input (Chrome,
Edge and Firefox; Safari, and so every iPad and iPhone browser, has no Web
MIDI, and the menu is not shown there). The choice is remembered.

- **Keys** play where the on-screen keyboard plays — the selected channel, or
  the voice under the cursor — and with the step-input button (●) on they are
  written into the score the same way. Rests and ties stay on the on-screen
  buttons.
- **Step input writes octaves relatively**, from any keyboard: a note in
  another octave than the one in force at the cursor gets `>` / `<` (or
  `o+N` / `o-N` for a bigger jump) in front of it — never an `:oct`. The
  octave in force is what the score has there, `:oct`, earlier shifts and a
  `:key` voice included. The delete button takes back a shift or a `:vel` too.
- **`Velocity`** makes how hard a key is struck matter: the preview sounds at
  that `vel` (127 → 15), and step input writes `:vel N` whenever it changes.
  Off, every key plays at the channel's level.
- **`MIDI Learn`** assigns knobs to the panel's sliders: click a slider (it
  is picked, not moved), then turn a knob. The slider shows its CC
  (`CC74`, or `CC74/2` on MIDI channel 2), and the knob then moves it across
  its whole range. An FM parameter writes where the slider writes — the
  selected channel live, or the `def-fm` under the cursor in the source — so
  no `def-val` is needed; a Dynamic Parameters slider moves its slot. `Delete`
  unassigns the picked slider, `Esc` ends. `Clear CC Assignments` removes them
  all. Assignments belong to this browser, not to the score.

---

### Reopening scores

The score being edited is kept in the browser as you type, and comes back
when the page is opened again — after a reload, or a phone dropping the tab.
It is one score, the one in the editor: `File > New` or opening another file
replaces it. A share link only shows its score; that score takes the place of
yours at its first edit. The kept copy has no file behind it, so `Save` after
a reload asks where.

While a song plays the screen stays on (where the browser allows a page to
ask: Chrome, and Safari from iOS 16.4), and the page goes on playing when it
is hidden behind another tab or app. On an iPhone or iPad the sound plays as
media, so the lock screen and Control Center show the song with play, pause
and stop. In a Safari tab on an iPhone, Safari floats its address bar above
the on-screen keyboard, and a strip of the page shows around it; the app
added to the home screen has no such strip.

A browser without file pickers — Safari on iPhone and iPad, Firefox — opens
with a plain file chooser, has only Save (every save asks where, so there is
no Save As…), and Save and the exports hand the file over: on a touch device to the share sheet (`Save to Files` on iOS), else as
a download. An export that took a while to render asks for one more tap in
the console (`Save…`), since the share sheet needs one. Such a browser cannot
open a folder, so `Open Folder…` is not offered — but an archive opens as one
(below). When a score's own `:file`
samples or `(import …)`s are missing, a `Load … missing files` button over the
editor names them: pick those files (several at once) and they are matched by
file name and held until the app is closed. Presets and URLs load as usual.

`File > Open Recent` lists the last ten scores opened or saved (Chrome and
Edge; a browser without file handles has no such menu). A score opened from
its folder (`File > Open Folder…`) comes back with the folder, so its samples
play again; one opened from an archive comes back with the archive. The browser may ask for access again the first time after a
reload; an installed app can keep the grant. A score that has since moved or
been deleted drops off the list when picked, and `Clear Menu` empties it.

With the app installed from Chrome or Edge, a `.mmlisp` can also be opened
from the Finder or Explorer (double-click, or Open With > MMLisp) — it opens
in a window of its own, and Save writes back to that file. An app installed
that is not offered for `.mmlisp` may need reinstalling.

A score opened on its own this way (or with `File > Open…`) comes with
access to that one file only — not to the wavs and imports beside it, which
the browser grants only from a click. When it needs them, a **Load samples
from …'s folder** button appears over the editor: it opens the folder picker
already in the score's folder, so one click on Open does it. From then on
Open Recent brings the score back with its folder.

### Folders, archives and songs

`File > Files in Folder` lists what the open folder holds: its scores and its
songs — `.vgm` `.vgz` `.mid` `.dmf` `.fur` `.mdx` `.mgs` `.muc`, each with its
format beside it. A song opens as `File > Open…` opens one: converted, through
the import dialog, as a new unsaved score. Opened from the folder, it keeps the
folder, so the next song is one click away, and what the song names beside
itself is read from there — an MDX's `.pdx`, a mucom88 song's `#voice` and
`#pcm` banks. Opening a folder opens its first score, or its one file when it
holds only one; a folder of songs only lists them.

The top line of Global in the panel names what is open — the folder first
when it came from one (`pack.zip / daisy.vgm`) — and the browser's title says
the same. A converted song keeps its own name until it is saved; `Save` then
offers it as `.mmlisp`. A `●` after the name means edits not yet saved. With a
folder open, the name ends in `⌄` and tapping it opens the folder's list
there, and the two buttons at the line's end step to the previous and next
file, round from the last to the first. A name too long for the line loses its
middle, as much kept of its start as of its end. Moving on from edits asks first;
a song just converted, or a score as it was opened or saved, goes without
asking.

An archive — `.zip`, `.lzh` (`.lha`) — opened with `File > Open…` or dropped
opens as the folder it holds, in every browser, an iPhone's and iPad's too: a
downloaded song pack needs no unpacking. It is read in memory, each file when
it is opened; an archive with one folder inside opens as that folder. A score
in it has no file to write back to, so `Save` asks where. ZIP: stored and
deflate (not encrypted, not ZIP64). LZH: `-lh0-`, LHarc's `-lh1-`, and
`-lh4-` to `-lh7-`, header levels 0 to 2. Names are read as UTF-8, or as
Shift_JIS when they are not UTF-8.

A score that comes with no file at all — brought back from the browser's
draft after a reload, opened from a share link, or never saved — has no folder
to start that picker from. Then Chrome and Edge show the same `Load … missing
files` button as the browsers without pickers: pick the wavs and imports it
names, or open the score's folder with `File > Open Folder…`.

## 23. Dragging files into the live app

Drop files anywhere on the window. They are routed by extension — the same
formats `File > Import` accepts, where `Song…` opens a song as a new document
and `Instruments…` inserts voices and drum kits at the cursor:

| Dropped                            | Result                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| a folder                           | same as `File > Open Folder…`                             |
| `.zip` / `.lzh`                    | opens it as a folder (§22)                                 |
| `.mmlisp`                          | opens it — **⇧Shift** inserts `(import "…")` instead (§7) |
| `.mmb`                             | loads it as a binary preset                                |
| `.wav`                             | inserts a sample def (§19)                                 |
| `.dmp` `.fui` `.tfi` `.vgi` `.opni` | inserts the FM voice def                                  |
| `.opm`                            | inserts a VOPM / MiOPMdrv bank's named voices, DT2 as `:dt2-N` (an `x68k` score's) |
| `.muc` / `.mml`                    | mucom88 import — drop its `.dat` / `.bin` alongside to get voices and drums in one go |
| `.dat` / `.bin` alone              | inserts a mucom88 voice bank / PCM bank's defs             |
| `.sf2`                             | inserts a SoundFont's drum kit as sample defs (below)      |
| `.mid`                             | MIDI import, through the import dialog (below)             |
| `.dmf` / `.fur`                    | DefleMask / Furnace module import, through the import dialog (below) |
| `.vgm` / `.vgz`                    | VGM import, through the import dialog (below)              |
| `.mdx` (+ `.pdx`)                  | MDX import as an `x68k` score — drop its `.pdx` alongside for the ADPCM (below) |
| `.mgs`                             | MGS import as an `msx` score (below)                        |

A mucom88 PCM bank decodes to one wav that every drum def slices. It plays
from memory until it is saved: **Save** asks for it right after the score, in
the score's folder with its name filled in, until it is written (also
`File > Export > Imported…`); a VGM's DAC or PCM-chip samples arrive the
same way (below). A song that uses both part J and the drums (K or G) arrives with its
`fm6` lines commented out — on the Mega Drive fm6 is the DAC the drums play
through; move them to a free channel to hear them. NTSC and PAL drum
libraries with up to three PCM voices can expand to multiple sample banks
automatically. If an individual baked sample is still too large, the
importer can select a lower-rate voice profile with `(def-score :pcm-voices 2)` or
`3`. A sample that cannot fit even then is omitted, its notes become rests,
and the log identifies it.

A SoundFont (`.sf2`, also `File > Import > Instruments…`) gives its drum
kit, inserted at the cursor like any instrument import — the dialog asks
which kit when the file has several. Each GM drum key comes
out under the role name every preset kit uses (`kick`, `snare`, `hat`,
`tom1`–`tom6`, …), so a score written against `presets/rx5` plays it
unchanged — and since a local def wins over an import, inserted into a score
that imports a kit it takes over those names. Keys outside that vocabulary
are skipped and named in the log.
A key is rendered as the SoundFont plays it at full velocity — every layer,
at that key's pitch, through the volume envelope — then shaped like the
preset kits: mono, 22,050 Hz, shortened with a fade, and its loudest 50 ms
set to the role's level (`presets/rx5/README.md`). The kit is one wav that
the defs slice, held in memory until Save writes it, as above. Melodic
presets are not imported; filters, modulators and LFOs are not read.

### What a mucom88 import carries

FM parts A–C / H–J go to `fm1`–`fm6`, SSG D–F to `sqr1`–`sqr3` (the notes an
SSG part plays with noise on go to `noise`), ADPCM K to `pcm1`, rhythm G to
the RX5 kit on one PCM track (`pcm1`, or `pcm2` beside K). Notes, lengths
and ties land on mucom's clock grid; loops, breaks and the last `L` become the
loop point (a part without `L` plays once). **Every mucom command imports**:
key shift `K`/`k`, detune `D` (relative `D n+` too), `v`, `)`/`(`, `V`, `q`,
reverb `R`, register writes `y`, SSG `E` envelopes and `@n` presets, `P`/`w`,
slot detune `S`, key-on revise `s`, mucomDotNET's SSG hardware envelope `S`
/ `m`, inline, `@%` and `.dat` voices, macros,
echo, portamento, hardware and software LFO, and both tempo commands. Where
mucom's driver behaves in a particular way, the import does the same rather
than approximating:

- **Loop passes.** `)`/`(`, `D n+`, `q` and ties act on every pass of a loop,
  so a loop whose passes would differ — or one tied into or out of — is
  written out pass by pass.
- **Bars.** mucom has no meter: a `|` (and a line break) goes at each whole
  note of the part, as the text runs (an `(x …)` body once), where a note
  ends on it. A part stops marking at its first macro call (`*n`, whose
  notes take the length where it is called) or at a loop across lines kept
  as a `#label`. A key shift's octave wrap meeting the part's own `>` / `<`
  is written as the one move it makes. `:len` is chosen as the notes read,
  not copied from `l`: three notes of one length in a row write it once and
  go bare (`c+ d+ f g+` under `:len 8`), any other is written with its own
  length — and it is the default length again before an echo tap or a
  macro, which play at `:len`. A macro's def keeps its lengths as written.
- **Software LFO and detune** move the raw pitch word, so their cents depend
  on the note. An LFO that keeps the word in range is a triangle, however
  slow — one `lfoN` def a setting, its depth the mean of the twelve pitch
  classes' (a low note's swing a few cents off mucom's); one that carries
  into the block is a sweep, drawn per pitch class from
  the exact curve as far as its longest note — counted as the part plays, so
  a note tied through a loop's passes (`[b8&)]7`) is one long note. An LFO or
  SSG envelope longer than a driver macro holds (255 steps) is sampled at a
  coarser `:step`. The driver steps its LFO on its own clock and a macro steps
  on the frame, so a fast vibrato drifts against mucom's by up to a step.
- **Levels.** mucom sets every carrier TL from its volume table and ignores
  the voice's own, so voices come in with carrier TL 2 (the `v15` value). An
  SSG level (3 dB steps) plays as the PSG `:vel` nearest in dB on the Mega
  Drive's measured attenuator, whose bottom steps are wider; SSG envelopes
  land on those steps, drawn per `v`. SSG noise at a short `w` shifts faster
  than hearing — most of it is inaudible, while the PSG's is all heard — so
  the noise copy plays that much lower (`w0`: −4.9 dB).
- **Slot detune** `S a,b,c,d` (part C) puts CH3 in the chip's
  independent-operator mode and offsets each operator's pitch word — the
  values are operators 4, 3, 1, 2, as the chip's registers run. The part
  renders once per operator onto `fm3-1`–`fm3-4`, each copy carrying its
  offset in the `:pitch` cents it writes per note; the voice and `:pan` ride
  the first copy (they are the shared channel's), and `v` reaches the
  carriers alone, as mucom's volume table writes them. All-zero offsets are
  the normal mode, so a part that only ever writes those stays one `fm3`
  track.
- **The SSG's hardware envelope** (mucomDotNET's `S n` / `m n` on D–F;
  mucom88 itself rejects them) imports on pc88 as `:env n` — the shape, R13
  as written — and the song's `:env-rate`, `m`'s period as a cycle's Hz on
  the shape in force. `v` turns it off (`:env none`), `)`/`(` are not read
  under it, a `P0` on it is the envelope alone (`:mode env`), and the `E`
  envelope's macro is off while it plays, as the driver writes none of it.
  On md it is dropped, with a warning.
- **Key-on revise** `s n` adds n clocks to a note's length and flips the
  sign, so a run alternates +n, −n — a micro-shuffle whose pairs still add
  up. Rests keep their length; a tie and a portamento count as notes. The
  flip is the compiler's, so a loop body plays the lengths it was compiled
  with, as an `(x …)` body does.
- **Tempo** is `BPM = 832000 / ((256 − t) × C)`, to two decimals; `T` goes
  through the Timer-B value it compiles to.
- **ADPCM**: o1 c plays at 16,143.6 Hz, the bank's labelled rate; the driver
  stops a drum at its key-off, so each sample's `:frames` is cut to the
  longest stretch the song plays of it.
- **Rhythm** keys up to six sounds at once (`@` is a mask: 1 BD, 2 SD, 4 TOP,
  8 HH, 16 TOM, 32 RIM), each its own voice. On the one PCM track each sound
  is a `:prio` layer — snare 1, tom 2, ride 3, kick 4, rim 5, hi-hat 6 — so a
  hit plays the highest-priority sound and is dropped while a higher one still
  rings: its `:gate` is the ring, the time the RX5 sample stays within 6 dB of
  its peak. `v`'s total and per-sound levels become `:vel`, the loudest sound
  at 15.

The chip's own limits stay visible as warnings: SSG notes below A2 play an
octave up (the PSG's floor), one noise channel serves the first part that uses
it, and SSG reverb rings without its level drop. What the Mega Drive has no
place for is dropped and said so: rhythm's per-sound pan, the ADPCM part K's
pan `p` and detune `D` (a PCM voice has neither), and K's volume mode
`vm<n>`.

**For pc88.** A `.muc` is written for the YM2608, so the import dialog's
**Target** starts at pc88 (the NEC PC-8801), which keeps what the chip has
instead of reading it for the Mega Drive (language.md §19); md converts it
for the Mega Drive as above:

- **Rhythm** G plays the chip's own sounds, a track each — BD on
  `rhythm1`, SD on `rhythm2`, TOP, HH, TOM and RIM on `rhythm3`–`rhythm6`,
  under the kit roles (`kick` `snare` `ride` `hat` `tom4` `rim`) with no
  `:gate` (each sound is a voice of its own, and rings as the ROM has it);
  `v`'s total and per-sound levels become an absolute `:vel`, which the
  chip's level takes back. The RX5 kit is imported beside it: its sounds
  stand in for the ROM's until you load yours (File ▸ Import ▸ YM2608 Rhythm ROM…).
- **SSG** `P` is the channel's `:mode tone|noise|both` (`P0` rests the
  notes), `w` the song's `:noise-rate`; no part is split into a noise copy
  and low notes stay where they are. A level is the channel's fader: `v` is
  the `:vol` that lands on the same register step, every one of the sixteen
  (`:vel`'s ladder would end 30 dB down), so a `(` / `)` inside a tie is a
  fader move. An `E` envelope is a `:vel*` macro under it, drawn per `v` and
  reaching 30 dB below the note's top; where mucom's level reaches silence,
  its `:vol` drops to 0.
- **FM** is as above, and `fm6` stays (there is no DAC to own).
- **ADPCM** K comes in on `pcm1` with its bank's defs, `v` as the fader
  (the level register mucom88 writes, `v` + 4, to within 1 dB) and `p` as
  `:pan`; `K` / `k` shift its notes as they do on the chip (on md too).
  `D` is the `:pitch` it moves the note's Delta-N by, and under `vm<n>` each
  sample brings its bank level, which `v` adds to.

### Resynthesizing a recording on FM3

`File > Import > Audio as Formants…` reads any recording — WAV, or whatever the
browser decodes (MP3, AAC / M4A, FLAC, Ogg, Opus) — as four formant tracks
(language §15): every 60 Hz frame gets a loudness, a pitch and the four peaks
of its spectral envelope, and each peak becomes one `fm3-N` track — a long
note per phrase with a `:pitch` table for its frequency and a `:vol` table
for its level, one value a frame — while the frames that hiss rather than
buzz become bursts on the `noise` track. The dialog chooses the synthesis:

- **CSM** — a note-less `(fm3-csm formant)`, the operators as the formants
  and an `fm3-csm-rate` track as the voice, its rates the recording's pitch
  phrase by phrase (or the one given) and its rests the breaths: a vocoder's
  voice. The formant width is each ring's decay (`:rr` / `:ks`).
- **Sine waves** — the four operators as sine waves on the formants:
  sine-wave speech, a whistled voice with no pitch of its own.

The tracks are the score's machine's: on `pc88` the same as on the Mega
Drive (the YM2608's FM3 has both modes); on `x68k`, whose YM2151 has neither,
the sine waves only, all four on `fm1`. Its operators share the channel's
pitch, each at a ratio of it (`:ml` ½–15 times `:dt2-` ×1–×1.73), so each
frame's pitch is the base whose ratios come nearest the four formants — a few
tens of cents off at worst, under the analysis's own wander — written as
`:pitch`, `:ml1`–`:ml4`, `:dt2-1`–`:dt2-4` and `:tl1`–`:tl4` tables. The hiss
is `fm8`'s `:mode noise`, and the formants sit 6 dB down so the consonants,
the OPM's noise being quieter than a sine, keep their place. On `msx` the
sine waves are the SCC's: `wave1`–`wave4` each play one cycle of a sine
(`def-wave sine`) at a formant, its level the chip's 16 linear steps, and
the hiss is the PSG's `noise`, 5 dB down against the SCC. The SCC's period
grows coarse up high (some 50 cents a step near 3.4 kHz), about what x68k's
ratios give. On `pce` the same four sines are the HuC6280's `wave1`–`wave4`
(its period as coarse up high as the SCC's), the level its 5-bit volume,
and the hiss is `noise5` at its fastest rate. The Famicom has neither FM
nor wave channels to sing on, so the import is disabled there.

It reads best what has a shaped envelope — a voice, a wah or a moving
filter, a drum's body. A sound whose colour is its partials (a bell, a
metallic hit) or that has no envelope shape (noise, a dense chord) comes out
as its rough outline.

The result goes in at the cursor, like an instrument. In an empty document it
brings its tempo, 150 BPM, where a frame is four ticks and every table lands
on its frame; in a score it takes the score's tempo and the frames round to
its ticks, the same way on every track. The recording is read down to 8 kHz
(formants live below 4 kHz); a few seconds of a clear, dry sound work best,
and the noise track's level is a dial. The result is a sketch of the sound to
edit — a table's values are the score's, so a formant can be redrawn, a phrase
retimed, the rate track given a melody. Under CSM each phrase's tables hold
their vowel (`#sus`) and carry their tail (`#rel`), and the note is gated at
the vowel: a longer note and gate hold the vowel longer, the tail follows by
itself (the rate track's `:len` and the noise track's rest are stretched by
hand to match).

### An FM voice from a recording

`File > Import > Audio as FM Voice…` estimates a YM2612 patch for one note of
a recording — a bass, a piano, a bell, a pluck — in WAV or any format the
browser decodes. FM has no way back from a
sound to its patch, so this searches: candidate patches are played on a fast
model of the chip, compared with the recording, and moved towards it. The
pitch and the loudness contour are read first; then every algorithm is
searched side by side (in as many workers as the computer has cores), and the
best three are refined.

A modal lists the recording and the three candidates, nearest first. ▶ plays
one against the recording at the same loudness, and the keyboard — on screen
or MIDI — plays the one chosen on the chip, so you can hear it across the
range before deciding. **Insert** puts it at the cursor as a `def-fm` named
after the file; a comment says the note it was read at. The page stays live
under the modal.

Give it one note, from its start, with little else under it: the first 0.8 s
is read. Simple tones (bass, electric piano, bell, organ) come close; a
complex one (strings, a voice) comes out as a starting point to adjust. A
search takes some 10–20 seconds.

A sound with no pitch — a hat, a snare, a clap, a cymbal — is read as a
noise. FM makes noise from an operator fed back on itself near the top of
its range, so the search then looks for the note it plays at as well, and
compares the sounds by their colour (the spectrum smoothed across
neighbouring bands) rather than by lines a noise does not have. Its voice
comes out with that note as `:key`, as the `presets/fm-drums` voices do: c4
plays it as found, other notes retune it.

### Song imports: MIDI, DefleMask / Furnace, VGM, MDX, MGS

**A song import opens a dialog first**: what the file holds, the timing and
tempo (a MIDI file's), the loop, and one row per source part with its destination.
**Enter** imports with the defaults. The loop is the file's own when it marks
one; otherwise the box loops the whole song — ticked for a MIDI file (they
rarely mark one), unticked for a VGM (one without a loop point is usually a
jingle).

**MIDI.** The dialog shows the quantize grid (the coarsest one the notes sit
on) and the loop marked with CC111 or `loopStart` / `loopEnd` markers. MIDI
plays chords on one channel and a track plays one note, so a channel is
split into lanes, one a track; the defaults put each channel's first lane on
FM before any second lane, then the PSG, with channel 10 on `pcm1`–`pcm2`,
and drop what does not fit.

- A program names its `presets/gm` voice, played at the bank's own note
  offset; drums play `presets/gm-drums`. A part sent to a PSG channel takes
  the envelope of its program's family from `presets/envelopes` (piano →
  `env-piano`, organ → `env-organ`, strings and pads → `env-pad`, brass →
  `env-brass`, leads → `env-lead`, …).
- Velocity, volume (CC7) and expression (CC11) become `:vel`, the loudest
  note at 15; pan (CC10) sets `:pan`; the sustain pedal holds notes.
- Pitch bend (its range from RPN 0) becomes a `:pitch` macro on the notes it
  moves — a vibrato or a few lines, shared as `vib-…` / `bend-NN` defs as a
  VGM's are (below). The modulation wheel (CC1) is a vibrato on a fixed
  mapping, 127 → ±50 cents at 5.5 Hz, coming in 12 frames (0.2 s) into the
  note — a held note starts to wobble, a short one stays still. Other
  controllers are skipped, and the log says how many.
- The music starts at the first note: a silent setup section before it, and
  the tempo it runs at, are left out. When the notes do not sit on the
  file's own beat (a recorded performance, a file converted from a log), the
  timing is the beat estimated from the notes' times instead of the file's
  tempo map; **Timing** switches between the two.

**DefleMask and Furnace.** A DefleMask module from v5.1 on is read, and a
module plays its order list as the tracker does
— `0Bxx` jumps, `0Dxx` breaks, looping where it jumps back to (or to the
start) — with a row a fixed number of ticks and the speed as `:tempo`
(speeds that take turns a row each — a swing, a Furnace groove `09xx`
picks — at their average, for now; the log names them). By
default each pattern of each channel becomes a phrase `(def fm1-p03 …)` that
restates its voice, octave and velocity, and each track names its phrases in
order (`(x 2 …)` for a run); a note held into the next pattern starts that
phrase with `~`. Untick **One def per pattern** for one long body instead.

- FM instruments become `def-fm`s; a volume or arpeggio macro becomes a
  `(macro …)` def, its loop a `#sus` and its release point a `#rel` (held
  there until the note is let go). An instrument's pitch macro (Furnace's,
  1/128 semitone a step, relative ones added up, its delay and speed kept)
  is a `(def pitch-… (macro :pitch+ […]))` the note names, unless a slide,
  portamento or vibrato on its row takes the note's one pitch macro (the
  log counts it). A Furnace song's tuning (its A-4) and the fine tune are
  the channel's `:pitch`, which the pitch macros and arpeggios ride. Notes sound where Furnace plays them: the FM chips and
  the AY at their names, the SN76489 two octaves up and the other PSGs and
  wavetables (the SCC, the HuC6280, the 2A03, the VRC6) one, as Furnace
  reckons their periods. A fixed-pitch arpeggio (a drum's pitch sweep) becomes a
  `:semi+` from the note played, so it gets one def for each note it plays.
  The volume column, pan (`08xy`; Furnace's `80xx`, a side only at its
  end), arpeggio (`00xy`), note
  cut (`ECxx`) and delay (`EDxx`) come along. The arpeggio is a `(macro
  :semi+ …)` that runs on through the notes as Furnace's does — its
  phase carried from note to note at the song's arpeggio speed (`E0xx`)
  — and on the PSGs and wave chips (not FM, the OPLL or the SCC) a new
  note stops it until its row's `00xy` starts it again.
- The volume column is the note's `:vel`. Where the level moves under a
  sounding note — a column written on a row without a note, or a volume
  slide (`0Axy`, `05xy`, `06xy`, `FAxy`, `F3xx`/`F4xx`, `F8xx`/`F9xx`) —
  the note gets a level line, a `(macro :vol […])` of `(linear …)` and
  `(wait …)` stages in ticks, under a `:vel` that is the loudest the line
  reaches (`(macro :vel […])` on `fc` and `pce`, where the instrument's
  volume macro is the `:vol` one). A slide goes on into the next notes as in
  the tracker, each starting where it has got to, until `0A00` or a tremolo
  (`07xy`) stops it; `05xy` and `06xy` also bring back the last vibrato and
  portamento. A volume of 0 is silent on every chip, FM's too: a note
  there is left out, and a slide that reaches 0 ends its note.
- The pitch effects come along as `:pitch+` macros over the channel's
  `:pitch`: a vibrato (`04xy`) is a shared `(def vib-xy (macro :pitch+
  (sin …)))`, from the middle rising as Furnace's starts, a slide (`01xx`/`02xx`,
  `E1xy`/`E2xy`) a line on its note, a portamento (`03xx`) a slur with a
  `(glide Nf)` over the frames its speed takes (beside the note's vibrato or
  pitch macro), and fine tune (`E5xx`) an offset rounded to 10 cents. Furnace's
  slide/portamento compatibility flags are followed approximately.
- The log counts the effects that do not come along. On a non-Genesis
  system the channels play their notes on a `presets/waveforms` stand-in
  voice; sample channels are left out, but for the YM2612's DAC: FM6's
  sample notes come in on `pcm1` (below). Of a Furnace module, the first
  subsong is imported; a song on several chips lists every chip's channels.
- A **PC Engine** module offers a **Target**: `pce` (the default) or `md`.
  As `pce` each channel goes to its own `wave1`–`wave6`: the module's
  wavetables become `def-wave`s, and the wave a channel plays is its
  instrument's wave macro (a `(macro :wave …)` where it moves) and `10xx`.
  Channel 5 or 6 that turns its noise on (an instrument's duty macro, or
  `11xx`) goes to `noise5` / `noise6`, each note at the rate the tracker
  plays it (Furnace's: the note; a DefleMask module's: its table by the
  note's name); one that plays both kinds goes to both names, the noise
  over the wave where they meet (§19's `:prio` across a channel's names).
  The LFO (`12xx` `13xx`) and DDA (`17xx`) are left out. `08xy` is the channel's pan between its left and right
  levels, the volume column the chip's 5-bit volume (1.5 dB a step).
- An **NES** module offers `fc` (the default where the 2A03 and the VRC6
  play the most notes) or `md`. The VRC6's channels go to `sqr3`, `sqr4`
  and `saw1`: a pulse's duty is its duty macro and `12xx` (eight, `:duty
  1`–`8`), the columns and volume macros linear (the saw's to 63); a
  pulse's PCM mode (a sample instrument, `17xx`) is left out, as are the
  other expansions' channels (VRC7, FDS, N163, MMC5). As `fc` the pulses go to `sqr1` / `sqr2`, the triangle to `tri`,
  the noise to `noise`, as Furnace plays them: a pulse's duty is its
  instrument's duty macro (a `(macro :duty …)`, starting over at each note)
  and `12xx`, from 12.5 % where nothing sets it (Furnace's), written as
  `:duty`; the volume column is the chip's linear 4-bit level, as `:vel`
  in dB, and the volume macro a `:vol` macro in dB of the level Furnace
  writes — the column times the step, rounded down (Furnace's newer
  modules), or the two added (a DefleMask module, an older Furnace one) —
  a def for each column level it plays at, named `-v8` … (the SCC's and
  the VRC6's macros alike). A `12xx` under a sounding note takes effect at the next note
  (the log counts it). The triangle has no level: its notes say no `:vel`;
  its volume macro's 0 silences it, and a column of 0 only where a volume
  macro reads it. A noise note is its rate
  (Furnace's: the note's low four bits; a DefleMask module's: its table),
  its mode the duty macro's first step or `12xx` (`:mode white` /
  `periodic`). A Furnace module's DPCM channel comes in on `pcm1`: each
  note its instrument's sample (its note map's, or its one) at the DMC rate
  the note picks (an NES instrument's map or the note's low four bits; a
  sample instrument's note, C-4 its rate, at the nearest DMC rate), played
  to the next note or a note off (`:mode gate`, or `:mode loop` for a
  looping sample) — a `def-pcm` for each sample and rate, all in one wav
  (`<song>-dpcm.wav`, Save writes it beside the score). The sweep (`13xy`
  `14xy`) and the other 2A03 effects are left out.
- A module of another machine's chips offers that machine as its
  **Target** (the default where its chips play the most notes), and md:
  `msx` for the AY-3-8910, the SCC and the YM2413, `x68k` for the YM2151,
  `pc88` for the YM2203, YM2608 and YM2610 (and an AY's songs, after
  msx). A channel goes to its own chip's part there. The SSG's mixer
  (the wave macro, `20xx`) is `:mode tone|noise|both|env`, its noise period
  (the duty macro, `21xx`) `:noise-rate`, each a `(macro …)` where it moves;
  the hardware envelope is `:env` with its shape (`22xy`, the ex2 macro)
  and its period — `:env-rate note` with an `:env-semi` for the
  auto-envelope (`29xy`, ex3 : alg), else `:env-rate` in Hz (`23xx`
  `24xx`, ex5). The SCC's wavetables are `def-wave`s as the PC Engine's
  are, its volume linear. A YM2413 instrument is its ROM voice by name
  (`piano` …) or a 2-op `def-fm` of the FM-PAC's words; its drums mode
  goes to `rhythm1`–`rhythm5` (`kick` `snare` `tom4` `ride` `hat`), at c4,
  and takes `fm7`–`fm9`. The YM2608's rhythm goes to pc88's
  `rhythm1`–`rhythm6`, with the RX5 kit imported to stand in for a
  rhythm ROM not loaded; the ADPCM is left out. On x68k DT2 comes along
  and channel 8's noise (`10xx`, the duty macro) is `fm8`'s `:mode noise`
  with its `:noise-rate`. The SSG's and the YM2413's volume column and
  macro are 3 dB steps, the rhythm's 0.75 dB.
- **The DAC and the legacy sample mode.** A Genesis module's FM6 notes that
  play samples go to `pcm1`, as `md` plays them. While the DAC plays, `fm6`
  is the DAC's, so FM6's FM notes move to an `fm1`–`fm5` no channel takes,
  or are left out (the log says which). A sample instrument's note plays
  its sample. In a DefleMask module, or a Furnace one of a format before
  239 (which Furnace converts the same way), `17xx` turns FM6's sample mode
  on and off, and a note plays sample 12 × bank + its place in the octave
  (`EBxx` the bank) at the sample's rate, as an NES module's DPCM channel
  always does. Each sample is a `def-pcm` in one wav, `<song>-dac.wav`
  (`-dpcm` on `fc`), read as Furnace reads it, its amp and pitch applied.

**VGM.** A VGM is a log of register writes, so its notes are rebuilt from
them: a key-on starts a note, a key-off ends it.

- On the YM2612, YM2203, YM2608, YM2610 and YM2151 the voice is the
  channel's registers at the key-on. A file with a YM2151 asks for its
  **Target**: x68k (the default when the YM2151 is its only tone chip) keeps
  the eight channels on `fm1`–`fm8` (on their own numbers when they all
  fit), DT2 as `:dt2-N`, channel 8's noise as `fm8`'s `:mode noise` — its
  voice whole, its period as `:noise-rate` — and the OKIM6258's samples on
  PCM8's `pcm1`–`pcm8`, whole; md fits them to the Mega Drive, drops DT2 and reads
  the noise's period as the nearest `:mode white0`–`white2`. The
  carriers' TL is taken relative to the voice's loudest use and the rest
  becomes `:vel`. The SSG and the SN76489 become `sqr` and `noise` tracks;
  the OPL chips give notes on a stand-in voice. The YM2413's notes keep
  their voice, read on four operators: a ROM voice by its name (`piano`), a
  VRC7's ROM voice (its YM2413 clock's bit 31) as `vrc7-1`…`vrc7-15`, the
  user voice as `opll-user-01` … each as it stood at the key-on, at the
  channel's volume (3 dB a step). A note keeps
  the pitch it played: its cents off the semitone (a chip tuned off A440, a
  driver's table, a step after the strike) are a `:pitch` on it, to 5. A
  header that gives a chip no clock gets the chip's usual one (some
  arrangements leave it 0).
- A file with a YM2608 or YM2203 can be the **PC-8801**'s score
  (`:target pc88`), and one with an AY-3-8910 the **MSX**'s (`:target
  msx`) — each the default when that chip plays every channel. There the
  SSG is the machine's own: each channel keeps its noise (`:mode noise`, or
  `:mode both` with the tone) with the song's `:noise-rate`, so the shared
  noise row is not offered, and its hardware envelope comes back as `:env`
  — the shape — and the song's `:env-rate`: `note` where the period follows
  the notes (a buzzer, `:mode env`, at its own pitch; a tone whose period
  sets it, with `:env-semi` / `:env-detune`), else the cycle in Hz. A note
  the driver does not start the envelope over for runs it on, slurred. On
  md the envelope has no sound — the log counts the notes on it, which play
  at their level — and a buzzer plays as a square at its pitch. The MSX's
  FM-PAC (YM2413) channels are not imported onto it yet.
- The **YM2608's rhythm** is a row per ROM sound it keys (`YM2608 rhythm
  BD` … `RIM`), its hits counted with the onsets the tempo is read from. On
  pc88 each comes back on its own `rhythm1`–`rhythm6` track under its kit
  role (`kick`, `snare`, `ride`, `hat`, `tom4`, `rim`), its level the
  chip's total and own level as `:vel` and its pan the hit's; a hit lower
  than the IL reaches (23 dB down) plays at that floor. On md the sounds are
  the RX5 kit's on `pcm1`, as a mucom88 import plays part G: one `:prio`
  layer a sound, a hit dropped while a higher one rings, levels against the
  loudest hit — and fm6 gives way to the PCM. Either way the score imports
  `presets/rx5`, which on pc88 stands in for a rhythm ROM not loaded.
- A wavetable chip's channels — the SCC's (an MSX file, `:target msx`) and
  the HuC6280's (a **PC Engine** file, `:target pce`, the default when it
  plays every channel) — go to the target's `wave` channels, each keeping
  its number. Each distinct wave they start a note with becomes a
  `def-wave` (`wave-01` …), named where a track's wave changes. On the
  SCC a wave rewritten under a sounding note steps a frame at a time as a
  `(macro :wave …)` (`wmac-01` …: a driver's frame of a noisier wave as a
  strike, a timbre stepping through waves); on the HuC6280 it is not
  followed. On the SCC a key let
  go and taken again within 2 ms is no new note (a driver dropping every
  key for a moment as one channel starts), and a level jumping up three
  steps or more is a new one (the next note on a channel kept keyed). A HuC6280 channel on
  its noise is a row of its own (`HuC6280 CH5 noise`) that goes to
  `noise5` / `noise6` at the rate it played, and where a channel plays
  both, the row with more notes keeps it. Its left and right levels come
  back as `:pan` with the note (a pan moving under a note is not
  followed); its LFO and DDA are counted. On md the waves play on a
  `presets/waveforms` stand-in and the busier noise on `noise`.
- A **Famicom** file (the 2A03, `:target fc` by default) goes to `sqr1`,
  `sqr2`, `tri` and `noise`, each keeping its place. A pulse's duty comes
  back as `:duty` (12.5 / 25 / 50 / 75 % as 2 / 4 / 8 / 12), its sweep as
  the pitch moving under the note (a bend; a sweep that mutes a high
  period, a silence): a duty
  macro's steps through a note's first frames are its attack, and the note
  takes the duty it settles on; one moved later under the note starts a
  new note. Its hardware envelope comes back as a `:vel+` envelope,
  its length counter as the note's end. The channels start enabled (a rip
  of an NSF often leaves out the player's `$4015`), and the 2A03's pitches
  are read as its clock gives them (no tuning estimate). The triangle
  has no level, so its notes say no `:vel`; a note ends where its linear
  counter runs out, and a `$400B` starts a new one except in a glide (a
  drum's fall crossing a high byte). The noise's notes are its rates (c2 the slowest) with
  `:mode white` or `periodic`. The DMC's samples come from the memory
  blocks the file carries, each hit's the memory as it stood (a bank
  switched is another sample), decoded to one wav and `pcm1`; a sample the
  driver loops is a `:mode loop` note. On md the triangle is an FM
  channel's on `wave-triangle` (the SN76489 stops at 109 Hz, above a
  triangle's bass and drums), a tone channel past `sqr3` (a Sunsoft 5B's)
  goes to a free FM channel, the
  noise's modes the nearest `white` / `periodic` rate, and the duties are
  left out; the DAC written on and on by the CPU (a PCM the game streams)
  is counted, not imported.
  The Disk System's channel (the FDS: the 2A03's clock with bit 31) goes
  to `fds-wave`. Its 64-step memory is a `def-wave` — 32 steps where each is
  held twice, and on a 32-step chip's `wave1` (msx, pce) every other step —
  rewritten under a note a `(macro :wave …)`; its gain is `:vel`, its
  volume envelope a `:vel+` envelope; a note starts where the pitch and the
  gain are written together (the gain up or the pitch a semitone away), or
  the pitch jumps with the modulation set. The modulation a note starts
  with is the song's `:lfo-wave` (a def, `lfo-01` …), `:lfo-freq` and
  `:lfo-pmd`; a depth moved under a note (a delayed vibrato) is written
  where it moved, the note tied on there (`~`), its envelope and release one
  macro through the tie. A rate swept under a note, the modulation's own
  envelope and the pitch it bends are left to the chip (on msx and pce,
  left out).
  A YM2413 whose clock has bit 31 set is the VRC7: on `fc` its channels go
  to `vrc7-fm1`–`vrc7-fm6` by number, a ROM voice by the VRC7's own name
  (`wurly` …), a user voice a 2-op `def-fm` in the chip's words
  (`opll-user-01` …); elsewhere it plays as a YM2413 does, on 4-op voices.
  An AY beside the 2A03 is the Sunsoft 5B: its channels go to `5b-sqr1`–
  `5b-sqr3` as an MSX's SSG goes to `sqr1`–`sqr3` (its noise a channel's
  `:mode noise`, its hardware envelope `:env`). A YM2149 the file runs with
  its divider pin low (the 5B's) plays at half its clock. The MMC5 and the
  N163 have no VGM slot.
- A pitch moved during a note is followed — untick it to keep only the
  struck pitch. A jump it then stays at is a new note, slurred (`~`); a
  wobble is a vibrato, a shared `(def vib-40-10 (macro :pitch (sin -40..40
  :len 10f)))` (depth to 20 cents, period to the frame); any other move — a
  scoop, a fall — a few `linear` lines, a `(def bend-NN …)` once two notes
  share it (a note cut short shares a longer one's).
- A level that moves during a note — the driver's envelope on the PSG, a
  carrier TL it steps on the FM — becomes a `:vel+` macro in a shared def
  (`(def env-01 (macro :vel+ [0 -1 -2 #sus -3 #rel -5 -7]))`), the note's
  `:vel` its loudest point. A level held four frames or more is the `#sus`,
  and on the PSG what follows it is the release, so the note is keyed off
  there and plays it as `#rel`. A note cut short names the shape it is the
  start of.
- Time is kept, not read as beats: the score runs at 150 BPM, a tick
  1/240 s (a frame four ticks), and each note sits where the driver wrote
  it and lasts as long as it sounded — a rest after it where it was keyed
  off before the next. A groove, a swing, a tempo of the driver's own timer
  play as they did (to 2 ms on a timer not of the frame), which a beat grid
  would bend. An import is a performance to listen to and to take voices
  and pitches from; the bar lines are marks a 4/4 bar of 150 BPM apart, not
  the song's. The file's loop becomes `#top … (go top)`, at the first note
  within a frame of the point the file marks (a driver marks it a moment
  off the notes it goes back to).
- An SSG level becomes `:vel` by its decibels (the SSG's steps are 3 dB,
  `:vel`'s 2 dB), so a decay keeps its depth; the quietest levels (under
  `:vel`'s 30 dB) sit at its floor.
  A tone above hearing (a period of 0 to 5) counts as off: a driver sets
  one to hear the hardware envelope alone (a kick's click). What a driver
  writes within 2 ms of a key-on — the mixer, the shape — is the note's
  own, its pitch as it then stands.
- The YM2612's DAC comes in as a `pcm1` track (the `YM2612 DAC` row). The
  VGM's PCM data bank becomes one wav, `<song>-dac.wav`, and each place the
  driver starts a sample from is a `(def-pcm dac-NN … :offset … :frames …)`
  slicing it, at the rate most of its hits play (`:rate`); a hit at another
  rate is that many semitones off, and each hit lasts to the next. Seeks with
  `8n` writes and DAC stream control both read, and so does a hit the
  stream plays on into without a seek — where the driver turns the DAC on
  again, or a few bytes written straight to it start one (Revenge of
  Shinobi's). A seek a few bytes into a sample (a driver a byte late) is
  that sample's. A DAC written byte by byte, without a data bank, does
  not read — nor can a driver's own mix of several samples be split again.
  FM6 is the DAC then, so its track is dropped.
- An arcade, X68000 or PC-8801 chip's PCM comes in too: **SegaPCM** (System
  16, X, OutRun), the **YM2610's ADPCM-A and ADPCM-B** (Neo Geo, Taito), the
  **X68000's OKIM6258** and the **YM2608's ADPCM-B** (its RAM image, data
  block 0x81, or the bytes a driver loads through the chip). Each of its
  channels is a row (`pcm1–3` or drop);
  the sample data the file carries is decoded into one wav,
  `<song>-pcm.wav`, sliced by `(def-pcm sega-NN …)`, `pcma-NN`, `pcmb-NN`
  or `oki-NN` defs — one gain for the song brings its loudest sample to full
  scale, though the X68000's samples still come in a little quiet (a `:fx`
  `comp` on its defs raises them) — and each hit's level becomes `:vel` (the
  loudest hit 15).
  **PCM voices** picks how many of pcm1–3 the score uses — the rate the
  driver plays them at — and starts at the most that ring at once, three at
  most. With as many voices as channels, a channel is a track; with fewer,
  each hit takes a free voice, or cuts the sound that began longest ago —
  never an ADPCM-B note, the one melodic part — and the log counts the hits
  cut. A sample too long to bake into one 32 KB bank at its lowest pitch is
  cut to fit; pan is not imported (the DAC is one channel). With PCM in the
  song, FM is offered fm1–fm5. On pc88 the YM2608's ADPCM-B is `pcm1`
  again: a note per key-on at its Δ-N's pitch, its level the register's as
  `:vol` (at `:vel 15`, as a mucom88 part K) and its pan the hit's — what the
  driver writes just after the key-on (level, pan, Δ-N) counts as the
  hit's; a level moved while it sounds is not followed. The YM2608's rhythm
  on md then takes the next voice.
- The OKI MSM6295, QSound and the other PCM chips are not imported — the log
  names each VGM command it skipped — and neither is a second chip, which the
  log reports. (A tempo change within the song needs nothing: the notes
  keep their times.)

**MDX (X68000) and MGS (MSX).** A song compiled for MXDRV (`.mdx`) or
MGSDRV (`.mgs`, MGSARC's compressed form too) is played as its driver plays
it — repeats unrolled, each track up to its own loop point or its end — and
written for the song's own machine: an MDX as an `x68k` score, an MGS as an
`msx` one. Both count in clocks, 48 a quarter, so the timing is exact (no
tempo is estimated); an MDX whose notes sit on another grid (176-clock
bars: 44 a quarter) is read on that one, its notes 8ths and 16ths and its
tempo scaled to match and the tempo commands become `:tempo`. Each track keeps
its own loop, `#top … (go top)`, as the drivers loop each track on its own.

- **MDX:** FM A–H go to `fm1`–`fm8`, each voice a `def-fm` with its DT2 (and
  the track's `MH` sensitivities as `:fms` / `:ams`); `v` / `@v` become
  `:vel` (0.75 dB a TL step), `p` `:pan`, `q` / `@q` `:gate*` / `:gate-` on
  notes written their whole length, `&` a tie or slur, `k` a late key-on,
  `D` `:pitch`, `_` a portamento — one that lands on a note as that note
  glided to from its own over the length (`c_e` as `(glide c4 T) e`), else a
  `:pitch+` line — and the software LFOs (`MP`, `MA`) `:pitch+` / `:vel+`
  curves, each one written twice or more a def named by its curve
  (`vib-tri-19-24t`, `bend-up200-24t`, `trem-…`), `MH` the OPM's LFO words, and track H's noise (`w`, or `y$0F`)
  stays on `fm8` as its `:mode noise` / `:mode tone`, the voice whole — a
  hi-hat keeps its envelope. A track with no notes that only sets the tempo — a
  loop dithering it between two Timer B values, for one in between — becomes
  its average, one `:tempo`. The ADPCM — one track, or eight under PCM8 — plays
  the song's PDX: pick (or drop) the `.pdx` together with the `.mdx`; its
  samples are decoded into one wav, `<song>-pdx.wav`, a `def-pcm pdx-NNN`
  each, held in memory until Save writes it. Their `v` is PCM8's volume, as
  MXDRV sets it: `v8` the sample as it is (`:vel 15`), louder above — the
  loudest a sample plays at becomes its def's `:fx [(gain …)]`. Without the
  PDX the PCM tracks are left out, and the log says so.
- **MGS:** read as MGSC 1.11's reference (MGSC111.TXT) defines the MML,
  and held to MGSDRV itself where the reference leaves numbers open (the
  pitch tables, the tempo's frames, the envelopes, the detunes).
  The PSG goes to `sqr1`–`sqr3`, its mixer (`/`, or the mode an `@` sets)
  as `:mode tone | noise | both` and `n` as `:noise-rate`, `s` and `m` as
  the hardware envelope's `:env` and `:env-rate` (`v` turns it off); the SCC to
  `wave1`–`wave5`, each `@s` wave a `def-wave scc-NN`. `v` is `:vol` (the
  SSG's and the OPLL's 3 dB steps, the SCC's linear volume; 0 until a `v`).
  A tone's envelope — the `@e` or `@r` of its number, or the one `@e<n>`
  puts in — is a `(def vol-… (macro :vol …))` at that `v`, frame by frame
  (`n:c` held, `n=c` moved to, `[ ]` the sustain loop); `@r`'s RR, or `k`
  on the PSG and the SCC, is its release after `#rel`, written as its level
  steps, and an `@e`'s `\` steps a `(def bend-… (macro :pitch+ …))` — its
  noise and mixer steps a note's `(macro :noise-rate …)` and `(macro :mode …)`. The FM-PAC goes to `fm1`–`fm9`
  (`fm1`–`fm6` beside the rhythm, `#opll_mode 1`): `@0`–`@14` are the ROM's
  voices 1–15 (`violin` …, as `@#` assigns them), a tone on the original
  voice its `@v` as a `def-fm mgs-vNN` on the OPLL's words; `so` / `sf` are
  `:sus`, and `q0` holds a note to the next `/`. `q` is `:gate*` on notes
  written their whole length, `&` a tie or slur, `\` / `@\` `:pitch`, `h` a `:pitch+` triangle — one `(def vib-…)`
  a setting, its depth the middle of its notes' swings (in cents a setting's
  swing grows with the pitch) — `_` a portamento as `(glide <base> T)` over
  the note (MGSDRV's slide is a line on the frequency, the glide's on the
  cents; a track's first note, which never glides, keeps it as a `:pitch+`
  line) and `p` a fall. The rhythm track goes to `rhythm1`–`rhythm5`, a track a
  sound (`b s m c h` as `kick snare tom4 ride hat`), each hit ringing
  to the sound's next (`kf`: keyed off at the next hit of any, `:mode
  gate`), `v` and `vb` … `vh` its `:vol`. `y` is read where MGSDRV reads
  it: the user voice's registers as the OPLL's words after its `def-fm`,
  the PSG's mixer and noise, the rhythm's levels and tunings (a hit's
  note, c4 the chip's datasheet tuning). A `y14` that turns the rhythm on
  outside `#opll_mode 1` makes `fm7`–`fm9`'s notes its hits: `fm7` the kick,
  `fm8` the snare and hat, `fm9` the tom and ride, each at its note's pitch
  with its pitch moves, its gate and its `v` (the hat's and the tom's level
  their channel's `@`), less the sounds the `y` holds keyed. The log counts
  what was left out.

**A MIDI, VGM, MDX or MGS import is structured** (a MIDI or VGM import's
dialog has **Fold repeats** to untick, for one bar after another): bars that
repeat back to back become `(x n …)`, a run that comes round once more cut
short becomes `(x n A (break) B)`, and a run that comes back elsewhere
becomes a `(def fm1-a …)` named in place. Bars match
when they play the same — velocity compared at its 16 steps. A part that
plays behind the beat (an echo a 16th late) has every bar tied on from the
last; its repeats fold as `~ (x n … ~)` — the `~` before the loop ties the
first pass on, the one ending it each pass into the next. A def states the
voice, octave and velocity it starts with; a loop body states a voice only
where one changes — on the way in, or coming back round from its end. Where
a MIDI file timed by its notes gives no bars, the meter
comes from how the song repeats: 3/4 where the song comes back every three
beats clearly more than every four, 4/4 otherwise. The downbeat comes from
the drums (GM's kick and snare) where a 4/4 song
has a backbeat: the duller drum of the pair on 1 and 3, the other on 2 and
4 — 1 rather than 3 where clearly more long notes start on it, as chords
change on 1 — and a pickup where the song starts before that 1. With no backbeat to go
by the first bar starts at the first note; a change of meter within the
song is not read. On a PCM or ROM rhythm
track a hit is cut at the bar line (and the loop point) rather than tied
over it: a shot plays out whatever its length.

Several files at once are fine. Everything except opening a document appends at
the cursor, so a handful of `.dmp`s or `.wav`s lands as a block of defs — press
**Build** to apply them. Only one document can be open, so a multi-score drop
opens the first and turns the rest into `(import …)` lines.

**Paths follow the opened folder.** A file dragged out of the folder you opened
with `File > Open Folder…` is written with its correct folder-relative path
(`"sounds/kick.wav"`) — something the file picker cannot do, since a picked file
never reveals its directory. A file dragged from anywhere else gets its bare
name and is held in memory, so it works immediately; move it next to the score
and reopen the folder to keep it after a reload.

---

## 24. Typing help in the live app

### Brackets

Typing `(`, `[` or `"` inserts the closer too, with the cursor between them.
Typing the closer yourself steps over the one already there rather than adding
a second, `Backspace` on an empty pair removes both, and typing a bracket with
text selected wraps the selection instead of replacing it — so
`(x 16 c _ g _)` can be built by selecting `c _ g _` and pressing `(`. `'` is
an ordinary atom character in MMLisp and is left alone.

The form the cursor sits in is highlighted: both of its brackets, plus a faint
fill over the whole form when it is on one line. A form spanning several lines
(a track, a long `def`) shows only its brackets, so the highlight never floods
the editor.

An unclosed `(` / `[`, or a closer with nothing to close, is underlined in the
error color and counted in the badge at the top-right of the editor; click the
badge to jump to the first one. Nothing is repaired behind your back — where a
missing bracket belongs is a guess, and in a score a wrong guess silently
changes what plays. **Edit ▸ Close Open Brackets** (`Cmd/Ctrl+Alt+]`) closes
them on request: it appends, at the cursor, the closers for every form still
open there, innermost first. Reformatting (**Edit ▸ Format Source**,
`Cmd/Ctrl+Shift+F`) is the fastest way to see whether the structure is really
what you meant.

### Selecting by form

`Alt+↑` grows the selection one step outward — the contents of the form the
cursor is in, then that form including its brackets, then the next level out.
`Alt+↓` retraces the same steps inward. Combined with bracket-wrapping, this is
the quick way to restructure: `Alt+↑` until the phrase you want is selected,
then `(` to wrap it and type the head.

### Looping a selection

**Edit ▸ Loop Selection** (`Cmd/Ctrl+Alt+Shift+L`) writes the loop for you. With
notes of one channel selected, they become the loop: `#loop` goes in front of
the first and `(go loop)` after the last, widened to whole notes and forms so
nothing is split (selecting the whole channel writes `#top` instead). With a selection across channels — or just the cursor in a
channel — each channel it touches loops whole, `#top` at its head and
`(go top)` at its end (a channel written in several forms loops across all of
them; one that already ends in a `go` is left alone). On a channel with
`:prio` layers the loop belongs to a layer: the cursor's layer, or each layer
the selection touches — and layers that loop must start and end together
(`E_PRIO_LAYER_LOOP`, which the log repeats). The log says how long
each loop is in bars, since channels that loop at different lengths drift
apart, and warns when notes follow a loop and so never play. It is one undo
step.

### The Logical Editor

**Edit ▸ Logical Editor…** picks notes by a condition and acts on all of them
at once, the way a DAW's logical editor does. Its panel sits beside the
editor and marks every note the condition matches as you change it.

- **Scope**: the selection, the layer the cursor is in (its channel at its
  `:prio` — every form of it, since they append), the channel with all its
  layers, or the whole score. Notes a higher `:prio` layer hides count too:
  they are in the text even when they do not sound.
- **Condition**: pitch (any note, a note name in any octave, a range such as
  `c4`–`b4`, or rests), length (`=`, `>` or `<` a length written as the score
  writes one — `8`, `4.`, `96t`), and voice or sample (`snare`, `lead`).
- **Do**: delete (leaving a rest, so nothing after it moves, or closing up),
  set / add to / multiply the length, **transpose** by semitones (a note that
  crosses an octave is written `> c <`, so its neighbours stay put), or **reverse** — the run from the first
  matched note to the last, rests and all, played backwards, in each layer on
  its own. A reversed note
  is written out in full (`> e+8 <`), so the notes around it keep their octave
  and sample.

Notes in a `def` or a counted loop are **shared**: one token plays in several
places, so editing it changes all of them. They are marked with an outline and
left alone unless you tick *Include shared notes*; reverse never touches them.
Tied and slurred notes are left alone too. Apply is one undo step.

### Finding, replacing, and editing every occurrence at once

`Cmd/Ctrl+F` (**Edit ▸ Find / Replace…**) opens the find/replace panel at the
bottom of the editor. `Enter`
(`Shift+Enter`) steps through the matches, **all** puts a cursor on every one of
them, and the second row replaces the current match or all of them. `Esc` closes
the panel. The query is plain text unless **regexp** is ticked — a typed `\n` is
a backslash and an `n`, never a newline — and **match case** / **by word**
narrow it further.

`Cmd/Ctrl+D` is the one to reach for while composing: with nothing selected it
takes the token at the cursor, and every further press adds the next occurrence
as another cursor. Type once and all of them change together — renaming a `def`,
turning `:vel 10` into `:vel 12` down a track, fixing an octave you spelled four
times. `Cmd/Ctrl+Shift+L` takes every occurrence at once instead. Both are in the
**Edit** menu, which is also where undo and redo live when there is no keyboard
to press `Cmd/Ctrl+Z` on. Whatever is
selected has its other occurrences tinted, so the next press is never a guess.

Cursors can also be placed by hand: `Alt+click` — or `Cmd/Ctrl+click` — puts one
wherever you click, and clicking an existing cursor the same way takes it back
out, so overshooting costs nothing. `Cmd/Ctrl+Alt+↑` / `↓` adds one on the line
above / below, which turns a column of note lengths into a single edit. On a
touch screen, with no key to hold, **Edit > Add Cursor Above / Below** does the
same, as VS Code's Selection menu does on a tablet. `Esc` collapses them all
back to one cursor.

Over a value token, `Alt` is shared with the scrub (§22), and the press decides
which one you meant: click and it places a cursor, drag and it scrubs the
value.

A "word" in the editor is a whole MMLisp atom — `:vel*`, `def-val`, `1/4`,
`c4~` — so a double-click, and `Cmd/Ctrl+D` on its own, take the token you see
rather than a fragment of it. Two things follow from it: a `"` typed right
before such a character does not close itself, and a double-click in a
comment takes the punctuation after a word with it.

### Completions

Typing `(` opens the form and track list; `:` opens the keyword list. Beside
the highlighted entry the list shows what it is — its syntax and one line from
the reference (Library's Ref, §25) — and resting the mouse on a keyword or a
form head in the score shows the same card (on a touch screen, tapping one);
it goes when you type, move the cursor or tap it. Forms with a fixed argument shape
insert a filled-in template instead of a bare name, with `Tab` moving between
the fields:

| Typed          | Inserted                              |
| -------------- | ------------------------------------- |
| `(x`           | `(x 4 )`                              |
| `(go`          | `(go head)`                           |
| `(echo`        | `(echo 3 :vel+ -1)`               |
| `(delay`       | `(delay 3 :vel+ -4 :time 1/8)`    |
| `(def-val`     | `(def-val name 0 0..127)`             |
| any curve head | `(linear 0..100 :len 8)`              |

The placeholders are usable defaults, so leaving a template early (`Esc`) still
leaves valid source. Forms whose shape genuinely varies — a track, `t`, the
eval heads — insert just the name.

Names complete too. Two characters of a word offer the voices, samples, macros
and snippets the score can use — its own defs, everything its imports bring
in, and every preset set's voices and samples, imported or not — each labelled
with its kind and the set it comes from, and with the comment above its def as
the description (`gm-piano` — *GM 1 / MIDI 0: GrandPiano*; a kit's sample
shows its file). What you type is matched anywhere in the name **or** the
description, so `piano` finds `gm-piano` and `ride` every kit's ride. A local
def hides an imported one of the same name, as it does when compiling. A name
from a set the score does not import yet is marked `+ import`: picking it also
writes that set's `(import …)` at the top (one undo takes both back out).
`$` offers the `def-val` slots and `$time`, and `(` offers the parametric defs
next to the forms. Notes stay quiet: one letter never opens the list, nor does
a word that reads as music (`a-`, `e8.`, `v-2`).

The list follows the track the cursor is in: an `fm…` track is offered FM
voices, a `pcm…` track samples, a PSG track the macros — an envelope is the
voice it does not have, and `presets/envelopes` ships a set of them; outside
a track, everything. What the track plays comes first, the rest after.

Typing `@` where no name is being written opens the whole list without
knowing a single letter of a name; what follows narrows it, and the pick
replaces the `@` too. `@` is an editor shortcut, not notation — but a mucom
import names its voices `@1`, `@brass`, and those are in the list as typed, so
writing `@12 c` by hand still works: the space closes the list and types on.

The list never takes typing — letters go into the score and narrow it; Space,
`(` and the like close it and are typed. Only `↑` / `↓`, `Enter` and `Esc`
belong to it. Moving the selection with `↑` / `↓` auditions the highlighted
voice or sample (as Library's ▶ does), after a short pause so running
down the list does not sound every row; during playback a sample sounds on
the player beside the song (§19). Imported names are read when the score
compiles, so a set of your own imported by hand joins the list after the next
Play or Build; a preset set's names are there all along.

A new score (**File ▸ New**) imports the `gm` and `waveforms` voice sets and
the `tr808` kit without assigning any of them, so every preset name completes
from the first keystroke. Only what a track plays reaches the song.

---

## 25. The Library: what the app ships

The side panel (the ⚙ button) has two tabs: **Params**, the sliders and the
mixer, and **Library**, everything that comes with the app in one list — the
language reference (**Ref**), the **Presets** (the voice and sample sets), the
**Snippets** and the **Scores** (the examples) — so looking up a keyword,
picking a voice or trying a technique takes one click instead of a file
dialog. **Tools ▸ Library** — or **⌘K** / **Ctrl+K** from
anywhere, the editor included — opens the panel on Library with the search box
taking the keys; **Tools ▸ Params** — **⌘J** / **Ctrl+J** — opens it on Params,
and closes it again when Params is already showing. The ⚙ button reopens the
panel on the tab it was left on; a fresh launch starts on Params, with
Library's filters cleared.

**MMLisp ▸ Language** picks the language the reference and the snippets are
explained in — the Ref entries' summaries and category names, the snippets'
descriptions, in the Library, the completion's info and the hover card. The
app starts in the browser's language when it has one (English, 日本語,
Español) and remembers the choice. The language's own words, the menus, the
log and the compiler's messages stay in English.

- **Search** matches a name, then the description (`piano` finds `gm-piano`,
  `env-piano` and every voice whose comment says piano). While there is a
  query the list is one list, ranked as the completion ranks names.
- **All / Ref / Presets / Snippets / Scores**, the bar across the top, picks
  one source.
- The chips under it each narrow on their own. **FM / PCM / Macro** keep
  only those kinds of preset (any number of them; none means all). **Fits
  track** keeps what the track at the cursor can play — voices on an fm
  track, samples on a pcm track, macros everywhere — and follows the cursor.
  **A–Z** shows one alphabetical list instead of groups. A chip that means
  nothing for the source picked is greyed out and rests —
  FM / PCM / Macro apply to All and Presets, Fits track to all but Snippets
  and Scores — and takes effect again when its source comes back.
- Without a query the list is grouped — a preset set, a snippet topic, an
  examples folder — every group folded until opened. The line under the list
  describes the highlighted row: a preset's comment, a file's leading comment.

Each preset set is one directory under `presets/`, and its rows are read
straight out of the `set.mmlisp` a score would import — so a name in the
panel is always the def behind it, never a copy that drifted.

What the panel offers comes from three files, `presets/index.json`,
`examples/index.json` and `snippets/index.json`, each a plain list of paths — a
directory cannot be listed over HTTP, so a new set, example or snippet has to
be named in one of them to show up. They hold paths and nothing else: the names, kinds and contents are
read from the files themselves. The panel shows them in the order listed; presets are kept in
alphabetical order of their directory names.

| Row                | ▶                                       | Other actions |
| ------------------ | --------------------------------------- | ------------- |
| an FM voice (`fm`) | one `len 4` c4 on FM1 — a `:key` voice (an FM drum) at its key | **Insert** pastes the definition at the cursor, to edit as your own |
| a sample (`pcm`)   | one c4, baked and played through the driver's own engine — what an export will sound like | **Import set** (a sample's `:file` is relative to its set, so importing is how a score reaches it) |
| a macro (`macro`)  | a half-note c4 on sqr1 shaped by it, then a rest for its release | **Insert** pastes the definition at the cursor |
| a set (group)      | —                                       | **Import set** |
| a Ref entry        | plays its example                       | **Insert** writes the form at the cursor |
| a score            | plays it, without opening it            | **Open** puts it in the editor |
| a snippet          | plays it, without opening it            | **Insert** puts it at the cursor; **Open** puts it in the editor |

**Ref** is the language in short entries, one per feature, grouped as the
reference is (score, channels, notes, track keywords, FM, definitions,
macros, curves, echo/delay/glide, flow, FM3/CSM, PCM, sample effects). The
line under the list shows the highlighted entry's syntax, what it does, its
example and the section of `docs/language.md` that has the rest; a search
finds an entry by its other spellings too (`:vel+` finds `:vel`), and
**Fits track** keeps the entries the track at the cursor can use. The entries
live in `live/src/reference.js`; `cd tools && npm run check:reference`
compiles every example.

The audition is one note: enough to tell a sound, and a drum has only the one.
To hear a voice or a sample across its range, play the keyboard: while Library
shows, the keys (on screen, the computer's, a MIDI keyboard) play the
highlighted FM voice or sample, and the keyboard is shown only then — a macro,
a snippet or a score has nothing for the keys to play. Back on Params, the keys
play the channel or the def at the cursor.

The list is driven from the keyboard, from the search box as from the list:
**↑↓** moves through it, **Enter** is the row's action (the first button —
insert the def or the snippet, import the sample's set, open the score) or
opens and folds a group, and **Esc** empties the search, then goes back to the
score. In the list itself **Space** auditions the highlighted row (and stops a
score that is playing) and **←→** fold and open the groups. Everything is
clickable too.

An insert hands the focus to the editor with the inserted text selected, so
writing goes on from there; on a phone, where the panel covers the screen, it
also closes the panel.

**Snippets** are short scores, one technique each — echo and delay, `trig`,
FM3 and CSM, curves and the noise curves, parametric defs, and tricks like
`:prio` layering or runtime accumulation — grouped by topic, with the comment
at the top of each file shown as you move through the list. They play on their
own player, so listening to one leaves the score in the editor, its compiled
song and its mixer alone; starting one stops the song, since there is one
chip. **Insert** moves the snippet's `(import …)` lines to the top of the score
(skipping any already there) and puts the rest at the cursor, in one undo step.
A snippet is written as if it sat next to a new score, so its imports read
`presets/…` wherever it ends up. `voices/fm-voice-template` is the blank to
start a voice from: a `def-fm` with every register written out at the chip's
start values.

A `(trig N)` cue has no sound, so the log shows it as it passes — `trig 2 —
fm1` — whether the score is playing from the editor or from the panel.

**Import set** adds `(import "presets/…/set.mmlisp")` to the top of the score.
A sample def has no **Insert def**: its `:file` is relative to the set's own
folder (language.md §16), so importing is the only way to reach it from a score
somewhere else. Importing a whole kit costs nothing in the sample bank —
only the samples you actually play are baked (language.md §16).

A sample preview replaces the loaded PCM bank, so it waits for playback to
stop; the next **Play** or **Build** puts the score's bank back, and the same
goes for a score or snippet played from the panel. A played score's
`def-val` sliders are not shown until it is opened. Opening a score replaces
what is in the editor, as `File ▸ Open…` does.

### Drum kits swap

Every kit names its sounds by role — `kick` `snare` `hat` `hat-open` `rim`
`clap` `crash` `ride` `tom1`–`tom6` (low to high), and the percussion beyond
them — so changing which kit you import changes the sounds under the same
names, and the score is untouched:

```lisp
(import "presets/tr808/set.mmlisp")        ; ← swap this line for
; (import "presets/gm-drums/set.mmlisp") ;   this one
(pcm1 :len 8 kick c4 hat c4 snare c4 hat c4)
```

Two kits imported at once is `E_IMPORT_CONFLICT`, which is the point: they
compete for the same names. A kit that lacks a sound the other has simply has
no def of that name; fill the gap with an alias to one it does have
(`(def clap snare)`), or copy the def line from the other kit's `set.mmlisp`.

Six of the roles are also the sounds of the YM2608's ROM kit: `kick` BD,
`snare` SD, `ride` TOP, `hat` HH, `tom4` TOM, `rim` RIM. A `pc88` score plays
the chip's own sound under the same name on `rhythm1`–`rhythm6`, with or without a kit
imported (language.md §19). The ROM is the user's to bring (File ▸ Import ▸
YM2608 Rhythm ROM…); until then an imported kit's sounds stand in, cut to the ROM
sounds' lengths.

The FM drums (`presets/fm-drums`) use the same vocabulary with an `fm-`
prefix — `fm-kick`, `fm-snare`, `fm-tom1` — so they import alongside a PCM
kit: PCM kick and snare on `pcm1`, FM toms and cymbals on a spare FM channel.
The set holds five kits in one: the standard kit under those names, and the
drums of four more under `fm-std2-`, `fm-analog-`, `fm-elec-` and
`fm-symph-`, to mix freely. Each FM drum is a voice with a `:key`
(language.md §9): on a track at `:oct 4`, `c` plays it at the bank's pitch,
and another note retunes it:

```lisp
(import "presets/tr808/set.mmlisp")
(import "presets/fm-drums/set.mmlisp")
(pcm1 :len 8 kick c4 hat c4 snare c4 hat c4)
(fm5 :oct 4 :len 8 fm-tom3 c fm-tom4 c fm-tom6 c d fm-crash c2)
```

An FM drum rings until its note keys off, so a cymbal wants a long note.

---

## 26. Sharing a score

`File > Share…` turns the open score into a short link (`/s/…`) for posting.
Copy it, or post it straight to X (**More…** opens the system share
sheet where the browser has one). The link's card on a timeline shows the
score's name.

The score is stored on the server under an id made from its contents: sharing
the same score again gives the same link, and a link never changes what it
plays — edit and share again for a new one. Where there is no server (the local
dev server, offline), the dialog gives the long form instead, with the whole
score compressed after the `#`; it needs nothing but the app, and still opens
anywhere.

Whoever opens the link gets the score in the editor with a **Play** button over
it — a browser only lets sound start after a tap. From there it is an ordinary
unsaved score: they can edit it, play it, save it, or share their own version.

The link carries the score's text only. Preset sets and samples the app ships
(`presets/…`, §25) and a Library score's own folder resolve for everyone; imports
and `.wav`s from a folder you opened or dropped in do not, and the Share dialog
names any it finds. A score that fails to compile is flagged too.

## 27. Writing with an AI

An AI client on your computer — Claude Code or Claude Desktop, on your own
subscription — can work on the score open in the editor: read it, change it,
and play it, while you keep editing and listening in the same window. It needs
the MMLisp MCP server (`tools/mcp/README.md`) registered with the client.

Turn on **Tools > Connect to AI** (or open the app with `?ai-bridge=5190`);
the log says when the AI is connected, and the choice is remembered. The
browser may ask to let the site reach the local network — allow it. Then ask
the AI in its own window: "add a bass line to fm2", "make the lead brighter".

Each AI change is one entry in the log and one step of **Undo**, so a change
you do not like is a Cmd/Ctrl+Z away. The AI can start playback too, but only
after you have clicked the page once — before that it puts up a Play button for
you. The connection stays on this computer (127.0.0.1), and turning the menu
item off ends it.

### A video to post with it

A link alone does not play on a timeline. `File > Export > Video…` (or **Make
video** in the Share dialog) records the editor as the score plays — the
oscilloscope behind the code, the notes lighting up — into a square 1080×1080
video with its sound, the score's name on top and the site underneath. Post
the video, and the link in a reply for anyone who wants to open it.

It plays the score from the top for the length you set (30 seconds by default,
up to 140, X's limit), in real time; **Stop** ends it early. For the take the
editor becomes a fixed square without line numbers, the same on a phone and a
desktop — the screen looks off meanwhile and comes back after — and follows the
music as `MMLisp > Follow Playback` does, even when that is off. What changes
the picture is yours to pick: the theme's colors, and `MMLisp > Font Size` for
how much code fits. The take draws the editor with the oscilloscope behind it,
on for the take even when `MMLisp > View > Oscilloscope` is off (the piano
roll's pane is outside the frame); with `MMLisp > View > Source` off it is the
oscilloscope alone. X takes
H.264 video in MP4, which recent Chrome and Safari record; other browsers say
so before recording.

---

## 28. Keyboard shortcuts in the live app

| macOS              | Windows / Linux     | Action                                   |
| ------------------ | ------------------- | ---------------------------------------- |
| **File and play**  |                     |                                          |
| `Cmd+O`            | `Ctrl+O`            | Open                                     |
| `Cmd+S`            | `Ctrl+S`            | Save                                     |
| `Cmd+Shift+S`      | `Ctrl+Shift+S`      | Save As                                  |
| `Cmd+B`            | `Ctrl+B`            | Build                                    |
| `Cmd+Return`       | `Ctrl+Enter`        | Play / Pause                             |
| `Cmd+.`            | `Ctrl+.`            | Stop                                     |
| `Cmd+Shift+Return` | `Ctrl+Shift+Enter`  | Release Holds — the key-off a game sends: `:len 0` / `:gate 0` holds let go, a held track plays on |
| **Side panel**     |                     |                                          |
| `Cmd+J`            | `Ctrl+J`            | Params — open the panel on it, or close it |
| `Cmd+K`            | `Ctrl+K`            | Library — search the reference, presets, snippets, scores |
| **Editor**         |                     |                                          |
| `Cmd+Z` / `Cmd+Shift+Z` | `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo                  |
| `Cmd+F`            | `Ctrl+F`            | Find / Replace                           |
| `Cmd+D`            | `Ctrl+D`            | Add next occurrence                      |
| `Cmd+Shift+L`      | `Ctrl+Shift+L`      | Add all occurrences                      |
| `Cmd+Option+↑` / `↓` | `Ctrl+Alt+↑` / `↓` | Add a cursor on the line above / below |
| `Esc`              | `Esc`               | Back to one cursor                       |
| `Option+↑` / `↓`   | `Alt+↑` / `↓`       | Grow / shrink the selection by form      |
| `Cmd+/`            | `Ctrl+/`            | Comment / uncomment lines                |
| `Cmd+Option+]`     | `Ctrl+Alt+]`        | Close the open brackets                  |
| `Cmd+Shift+F`      | `Ctrl+Shift+F`      | Format current score                     |
| `Cmd+Shift+.` / `,` | `Ctrl+Shift+.` / `,` | Nudge the value at the cursor up / down (add `Option` / `Alt` for a coarse step) |
| `Cmd+Option+Shift+L` | `Ctrl+Alt+Shift+L` | Loop Selection — `#loop` … `(go loop)` around the selected notes, `#top` … `(go top)` around whole channels |
| **Library list**   |                     |                                          |
| `↑` `↓`            | `↑` `↓`             | Move through the list (from the search box too) |
| `Return`           | `Enter`             | Insert / open the highlighted row, or fold a group |
| `Space`            | `Space`             | Play the highlighted row (in the list)   |
| `←` `→`            | `←` `→`             | Fold / open a group (in the list)        |
| `Esc`              | `Esc`               | Clear the search, then back to the score |
