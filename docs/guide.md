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
- File metadata is the reserved defs `(def title "…")` / `(def author "…")`;
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

The slur carries the envelope over only if the left note has a **full gate**
(the default). A `:gate`-cut note keys off first, so the slur starts from a
decaying tone. Slur is an FM/PSG thing; on PCM a different-pitch `~` is just a
new note.

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
| `Nf`  | frame count (60 Hz) — honored in curve `:len` and macro `:step`  |

Examples:

- `4` = quarter note
- `4.` = dotted quarter
- `2/1` = 2 whole notes (2 bars at 4/4)
- `1/3` = triplet whole
- `24t` = 24 ticks exactly
- `8f` = 8 frames (curve `:len` / `:step` contexts; use `Nt` elsewhere)

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

- `:oct N` — octave (`0`–`8`)
- `:len token` — default note length (length token); `0` emits a held note and does not advance the timeline
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
- `:shuffle N` — swing ratio (`51`–`90`; `none` = straight); per-track (no
  score-wide default)
- `(glide T)` — portamento from the previous note over duration `T` (same
  length-token forms as `:len`); `(glide none)` disables.
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
`go` may even live in different forms of the same channel. See
`docs/language.md` §13.

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
library file are ignored. Full reference: `docs/language.md` §9.2.

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
  (let ((root 60))
    (note root) (note (+ root 4)) (note (+ root 7))))   ; c e g, from one root
```

**`(note n)`** plays a computed MIDI number (C4 = 60), otherwise a normal note.
An optional second argument is its length — a token (`4`, `20f`), `(ticks …)` /
`(frames …)`, or an expression (a bare number is a denominator, so `(+ 2 2)` is
a quarter). `let` names must be words, not note letters (`a`–`g`).

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

The channel is monophonic: written notes take priority, so an echo overlapping a
written note is dropped and echoes fill the gaps. For true overlapping delay,
`def` the phrase and replay it on another channel.

### `(echo ...)` — phrase-lengthening replay

`(echo ...)` is an inline note-replay that **lengthens** the phrase: its taps
occupy real time, so later notes shift back. This is the opposite of `(delay
...)`, which overlays into gaps without lengthening. `(echo ...)` is relative and
**one-shot** at its position (not sticky).

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

### `:len 0` — hold, timeline does not advance

`:len 0` fires KEY-ON, holds indefinitely, and does not advance the timeline. Any subsequent notes in the same channel all land at tick 0. Useful for a single held note with a release macro:

```lisp
(sqr1 :len 0 (macro :vel [15 #sus 14 13 #rel 8 4 0])
  c)
```

In both cases, KEY-OFF is triggered at runtime via `triggerKeyOff()`.

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
  silenced at that point — no release tail in this version).

```lisp
(fm1 :prio 1  :len 4   c _ _ g _ _)   ; sparse lead — always sounds
(fm1 :prio 5  :len 16  e e e e e e e e e e e e)  ; filler — yields to the lead
```

The whole thing is resolved at compile time into a single event stream, so the
player and driver still see one track per channel. Layers are straight
lines: a counted loop on a layered channel is an error (write it out), and the
song loop `(go …)` belongs on one layer only.

---

## 17. FM3 CSM Mode

Use `fm3-csm` when you want FM3 to run in CSM mode.

```lisp
(fm3-csm :csm-rate 60
  c _ c _)
```

- `fm3-csm` enables the FM3 special mode.
- `:csm-rate N` sets the Timer A frequency.
- `:csm-rate (curve ...)` sweeps the rate over time.

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

Declare a runtime value slot with `(def-val ...)` and reference it with
`$name` anywhere a runtime parameter takes a value. The live app renders one
**Dynamic Parameters** slider per slot — drag it while the score plays.

```lisp
(def-val cutoff 30 0..127)
(def-val depth 20 0..60)

(fm1 :tl1 $cutoff                              ; absolute from the slot
     :tl2+ $cutoff                             ; relative to the slot
     (macro :pitch (sin :from -40 :to $depth)) ; dynamic LFO depth
     c e g e)
```

- `:from` / `:to` set the slider's endpoints (either direction); the
  positional value is the initial setting.
- `$time` is built in: elapsed 60 Hz frames since track start.

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
note-on. (On the driver today, inline-sweep endpoints are slot-fed; slot-fed
macro-curve params still bake to the slot's initial value.)

See `docs/language.md` §7 (expressions, scaled macro) and §8 (`:step`, `:unit`,
the IR mapping).

---

## 19. PCM Samples

Samples are defined with `(def-pcm name …)`, then named in a `pcm1` / `pcm2` / `pcm3` body — before the notes, and again wherever the sound changes — as a voice is on FM.

```lisp
(def pcm-voices 2)
(def-pcm kick :file "sounds/kick.wav")
(def-pcm snare :file "sounds/snare.wav" :rate 11025)

(pcm1 kick :tempo 120  :len 4  c _ c _)
(pcm2 snare :len 4  _ c _ c)
```

- `:file` is required.
- `:rate` overrides the C4 playback rate.
- Stereo WAV files are downmixed to mono at compile time.
- WAV data is converted to 8-bit signed PCM at compile time.

**Decide how many voices you need first.** `(def pcm-voices N)` is a whole-song
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
step, and `(fade …)` cuts the sample where it ends — which also frees bank
space. A whole kit takes one chain on its import, and one sound a variant of
its own:

```lisp
(import "presets/tr808/set.mmlisp" :fx [(gain 12) (limit)])
(def-pcm snare-hot snare :fx [(fade :len 60ms)])
```

**Put the cursor on a sample def to play it from the keyboard**, as with an FM
voice: each key bakes that def at that note, effects included, and plays it on
the driver's engine. It takes over the PCM bank, so stop playback first; the
next Play or Build puts the song's bank back.

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
does `:mode loop`, until a `:mode shot`.

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
apart to show at once, it stays with any highlight already on screen, and only
once none is left there turns to the biggest group that fits, the lowest track
first. Scrolling, clicking or typing in the editor hands the view back to you
for a few seconds.

### Playing from a point

**TIME**, under Global in the panel, shows where the song is, and its bar spans
one pass of it: the intro and one time round the loop, the loop's start marked
on the bar. Past the end the position carries on from the loop start, as the
song does. Tap or drag the bar to play from there; while you drag, it keeps
playing a moment from under your finger, so the spot can be found by ear.
Stopped, it starts playback at that point.

**Tap a line number** to play from that line's first note — for a line in a
loop, the first time round. A label's line (`#top`) plays from the label; a line
with no note (a def, a comment) does nothing.

Either way the song is played up to the point without a sound, in an instant,
so it arrives as it would have: the voice, `:vol`, tempo and every other change
before the point are in place, not just the notes after it.

### Font size

`MMLisp > Font Size` sets the editor's text size in pixels, typed or stepped in
the same popup as a panel value — anywhere from 8 to 96, so it can go large for a
projector or a recording. It is remembered. On touch screens the text never
goes below 16 px (smaller makes iOS zoom in when you tap the editor).

### A MIDI keyboard and knobs

`MMLisp > MIDI > MIDI Input` listens to every connected MIDI input (Chrome,
Edge and Firefox; Safari, and so every iPad and iPhone browser, has no Web
MIDI, and the menu is not shown there). The choice is remembered.

- **Keys** play where the on-screen keyboard plays — the selected channel, or
  the voice under the cursor — and with the step-input button (●) on they are
  written into the score the same way. A channel plays one note: the newest
  key sounds, and letting it go returns to the one still held. Rests and ties
  stay on the on-screen buttons.
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

`File > Open Recent` lists the last ten scores opened or saved (Chrome and
Edge; a browser without file handles has no such menu). A score opened from
its folder (`File > Open Folder…`) comes back with the folder, so its samples
play again. The browser may ask for access again the first time after a
reload; an installed app can keep the grant. A score that has since moved or
been deleted drops off the list when picked, and `Clear Menu` empties it.

With the app installed from Chrome or Edge, a `.mmlisp` can also be opened
from the Finder or Explorer (double-click, or Open With > MMLisp) — it opens
in a window of its own, and Save writes back to that file. An app installed
before this came in may need reinstalling to be offered for `.mmlisp`.

A score opened on its own this way (or with `File > Open…`) comes with
access to that one file only — not to the wavs and imports beside it, which
the browser grants only from a click. When it needs them, a **Load samples
from …'s folder** button appears over the editor: it opens the folder picker
already in the score's folder, so one click on Open does it. From then on
Open Recent brings the score back with its folder.

## 23. Dragging files into the live app

Drop files anywhere on the window. They are routed by extension — the same
formats `File > Import` accepts:

| Dropped                            | Result                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| a folder                           | same as `File > Open Folder…`                             |
| `.mmlisp`                          | opens it — **⇧Shift** inserts `(import "…")` instead (§7) |
| `.mmb`                             | loads it as a binary preset                                |
| `.wav`                             | inserts a sample def (§19)                                 |
| `.dmp` `.fui` `.tfi` `.vgi` `.opni` | inserts the FM voice def                                  |
| `.muc` / `.mml`                    | mucom88 import — drop its `.dat` / `.bin` alongside to get voices and drums in one go |
| `.dat` / `.bin` alone              | mucom88 voice bank / PCM bank                              |
| `.mid`                             | MIDI import, through the import dialog (below)             |
| `.dmf` / `.fur`                    | DefleMask / Furnace module import, through the import dialog (below) |
| `.vgm` / `.vgz`                    | VGM import, through the import dialog (below)              |

A mucom88 PCM bank decodes to one wav that every drum def slices. It plays
from memory until it is saved: **Save** asks for it right after the score, in
the score's folder with its name filled in, until it is written (also
`File > Export > mucom88 PCM Bank WAV…`). A song that uses both part J and the
drums arrives with its `fm6` lines commented out — on the Mega Drive fm6 is
the DAC the drums play through; move them to a free channel to hear them.
NTSC and PAL drum libraries with up to three PCM voices can expand to multiple sample
banks automatically. If an individual baked sample is still too large, the
importer can select a lower-rate voice profile with `(def pcm-voices 2)` or
`3`. A sample that cannot fit even then is omitted, its notes become rests,
and the log identifies it.

**Song imports open a dialog first.** A MIDI file is read, then
the dialog shows its timing, the tempo, the quantize grid (the coarsest one
the notes sit on), the loop — the file's when it marks one (CC111 or
`loopStart` / `loopEnd` markers), else the whole song — and one row per source part with its destination. MIDI plays chords
on one channel and a track plays one note, so a channel is split into lanes,
one a track; the defaults put each channel's first lane on FM before any
second lane, then the PSG, with channel 10 on `pcm1`–`pcm2`, and drop what
does not fit. **Enter** imports with the defaults. A program names its
`presets/gm` voice, played at the bank's own note offset; drums play
`presets/gm-drums`. Velocity, volume (CC7) and expression (CC11) become
`:vel`, the loudest note at 15; pan (CC10) sets `:pan`; the sustain pedal
holds notes. A part sent to a PSG channel takes the envelope of its program's
family from `presets/envelopes` (piano → `env-piano`, organ → `env-organ`,
strings and pads → `env-pad`, brass → `env-brass`, leads → `env-lead`, …). Pitch bend (its range from RPN 0) becomes a `:pitch` macro on
the notes it moves — a vibrato or a few lines, shared as `vib-…` / `bend-NN`
defs as a VGM's are (below); the modulation wheel (CC1) is a vibrato on a
fixed mapping, 127 → ±50 cents at 5.5 Hz, coming in 12 frames (0.2 s) into
the note — a held note starts to wobble, a short one stays still. Other controllers are skipped, and
the log says how many. The music starts at the first note: a silent setup section before
it, and the tempo it runs at, are left out. When the notes do not sit on the
file's own beat (a recorded performance, a file converted from a log), the
timing is the beat estimated from the notes' times, as for a VGM, instead of
the file's tempo map; **Timing** switches between the two.

A DefleMask or Furnace module plays its order list as the tracker does — `0Bxx` jumps,
`0Dxx` breaks, looping where it jumps back to (or to the start) — with a row
a fixed number of ticks and the speed as `:tempo`. By default each pattern of
each channel becomes a phrase `(def fm1-p03 …)` that restates its voice,
octave and velocity, and each track names its phrases in order (`(x 2 …)`
for a run); a note held into the next pattern starts that phrase with `~`.
Untick **One def per pattern** for one long body instead. FM instruments
become `def-fm`s; a volume or arpeggio macro becomes a `(macro …)` def; the
volume column, pan (`08xy`), arpeggio (`00xy`), note cut (`ECxx`) and delay
(`EDxx`) come along, and so do the pitch effects, as `:pitch` macros: a
vibrato (`04xy`) is a shared `(def vib-xy (macro :pitch (sin …)))`, a slide
(`01xx`/`02xx`, `E1xy`/`E2xy`) a line on its note, a portamento (`03xx`) a
slur that glides in, and fine tune (`E5xx`) an offset rounded to 10 cents.
The log counts the effects that do not come along. On a
non-Genesis system the channels play their notes on a `presets/waveforms`
stand-in voice; sample channels are left out. Of a Furnace module, the first
subsong is imported; a song on several chips lists every chip's channels.

A VGM is a log of register writes, so its notes are rebuilt from them: a
key-on starts a note, a key-off ends it, and on the YM2612, YM2203, YM2608,
YM2610 and YM2151 the voice is the channel's registers at the key-on (DT2
dropped on the YM2151). The carriers' TL is taken relative to the voice's
loudest use and the rest becomes `:vel`. The SSG and the SN76489 become
`sqr` and `noise` tracks; the YM2413 and the OPL chips give notes on a
stand-in voice. A chip tuned off A440 on the whole (an arcade board's clock)
is taken back onto the semitones. A pitch moved during a note is followed —
untick it to keep only the struck pitch: a jump it then stays at is a new
note, slurred (`~`); a wobble is a vibrato, a shared `(def vib-40-10 (macro
:pitch (sin -40..40 :len 10f)))` (depth to 20 cents, period to the frame);
any other move — a scoop, a fall — a few `linear` lines, a `(def bend-NN
…)` once two notes share it (a note cut short shares a longer one's). A
level that moves during a note — the driver's envelope on the PSG, a carrier
TL it steps on the FM — becomes a `:vel+` macro in a shared def (`(def env-01
(macro :vel+ [0 -1 -2 #sus -3 #rel -5 -7]))`), the note's `:vel` its loudest
point: a level held four frames or more is the `#sus`, and on the PSG what
follows it is the release, so the note is keyed off there and plays it as
`#rel`. A note cut short names the shape it is the start of. The
tempo is estimated from the onsets (the dialog shows how well they fit and
the other readings, double or half — typing one keeps the measured beat and
reads it so); when no beat fits, the notes go on the
frame grid (1/60 s = 4 ticks). The file's loop becomes `#top … (go top)`;
a file without one (a jingle) can loop whole — the box is offered unticked.
DAC samples, a second chip and tempo changes within the song are not
imported, and the log says so. A header that gives a chip no clock gets the
chip's usual one (some arrangements leave it 0). A driver whose timer drifts
is followed onset by onset, so its bars stay bars; a part a little off the
beat (a late echo) is put on the nearest step without moving it.

**A MIDI or VGM import is structured** (untick **Fold repeats** for one bar
after another): bars that repeat back to back become `(x n …)`, a run that
comes round once more cut short becomes `(x n A (break) B)`, and a run that
comes back elsewhere becomes a `(def fm1-a …)` named in place. A part that
plays behind the beat (an echo a 16th late) has every bar tied on from the
last; its repeats fold as `~ (x n … ~)` — the `~` before the loop ties the
first pass on, the one ending it each pass into the next. Bars match when
they play the same — velocity compared at its 16 steps. A def states the
voice, octave and velocity it starts with; a loop body states a voice only
where one changes — on the way in, or coming back round from its end. Where the file
gives no bars (a VGM, a MIDI file timed by its notes), they are placed — bar
length and pickup — where the song folds most. On a PCM track a hit is cut at
the bar line rather than tied over it: a shot plays out whatever its length.

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
above / below, which turns a column of note lengths into a single edit. `Esc`
collapses them all back to one cursor.

Over a value token, `Alt` is shared with the scrub (§22), and the press decides
which one you meant: click and it places a cursor, drag and it scrubs the
value.

A "word" in the editor is a whole MMLisp atom — `:vel*`, `def-val`, `1/4`,
`c4~` — so a double-click, and `Cmd/Ctrl+D` on its own, take the token you see
rather than a fragment of it.

### Completions

Typing `(` opens the form and track list; `:` opens the keyword list. Forms
with a fixed argument shape insert a filled-in template instead of a bare name,
with `Tab` moving between the fields:

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
eval heads — insert just the name, as before.

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
voice or sample (as Browse's preview does), after a short pause so running
down the list does not sound every row; a sample waits for playback to stop,
since its preview reloads the PCM bank. Imported names are read when the score
compiles, so a set of your own imported by hand joins the list after the next
Play or Build; a preset set's names are there all along.

A new score (**File ▸ New**) imports the `gm` and `waveforms` voice sets and
the `tr808` kit without assigning any of them, so every preset name completes
from the first keystroke. Only what a track plays reaches the song.

---

## 25. Browsing what the app ships

**File ▸ Browse…** lists what comes with the app on three tabs — **Presets**
(the voice and sample sets), **Scores** (the examples) and **Snippets** — so
picking a voice or trying a technique takes one click instead of a file
dialog. Presets has two columns, the sets and the picked set's contents;
Scores and Snippets are one list each.

Each preset set is one directory under `presets/`, and the list on the right is
read straight out of the `set.mmlisp` a score would import — so a name in the
panel is always the def behind it, never a copy that drifted.

What the panel offers comes from three files, `presets/index.json`,
`examples/index.json` and `snippets/index.json`, each a plain list of paths — a
directory cannot be listed over HTTP, so a new set, example or snippet has to
be named in one of them to show up. They hold paths and nothing else: the names, kinds and contents are
read from the files themselves. The panel shows them in the order listed; presets are kept in
alphabetical order of their directory names.

| Row                | ▶                                       | Other actions |
| ------------------ | --------------------------------------- | ------------- |
| an FM voice (`fm`) | one `len 4` c4 on FM1 — a `:key` voice (an FM drum) at its key | **Insert def** pastes the definition at the cursor, to edit as your own |
| a sample (`pcm`)   | one c4, baked and played through the driver's own engine — what an export will sound like | — |
| a macro (`macro`)  | a half-note c4 on sqr1 shaped by it, then a rest for its release | **Insert def** pastes the definition at the cursor |
| a score            | plays it, without opening it            | **Open** puts it in the editor |
| a snippet          | plays it, without opening it            | **Insert** puts it at the cursor; **Open** puts it in the editor |

The audition is one note: enough to tell a sound, and a drum has only the one.
To hear a voice or a sample across its range, put the cursor on its def and
play the keyboard.

The panel is driven from the keyboard: **Tab** / **Shift+Tab** switches tabs,
**↑↓** moves through the list, **←→** steps between sets on Presets, **Space** auditions the highlighted row (and stops a score
that is playing), **Enter** is its action — open the score, insert the snippet,
paste the voice's definition, import the sample's set — and **Esc** closes.
Everything is clickable too.

**Snippets** are short scores, one technique each — echo and delay, `trig`,
FM3 and CSM, curves and the noise curves, parametric defs, and tricks like
`:prio` layering or runtime accumulation — grouped by topic, with the comment
at the top of each file shown as you move through the list. They play on their
own player, so listening to one leaves the score in the editor, its compiled
song and its mixer alone; starting one stops the song, since there is one
chip. **Insert** moves the snippet's `(import …)` lines to the top of the score
(skipping any already there) and puts the rest at the cursor, in one undo step.
A snippet is written as if it sat next to a new score, so its imports read
`presets/…` wherever it ends up. **Tools ▸ Snippets ▸ Browse Snippets…** opens
the panel on this tab.

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
(`presets/…`, §25) and a Browse score's own folder resolve for everyone; imports
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
visualizer behind the code, the notes lighting up — into a square 1080×1080
video with its sound, the score's name on top and the site underneath. Post
the video, and the link in a reply for anyone who wants to open it.

It plays the score from the top for the length you set (30 seconds by default,
up to 140, X's limit), in real time; **Stop** ends it early. What the editor
shows is what the video shows, so frame it first: `MMLisp > Font Size` sets
how much code fits, and `MMLisp > Follow Playback` moves the picture with the
music (off, it stays where you left it). With the visualizer off, the
oscilloscope stands in for the take. X takes H.264 video in MP4, which recent
Chrome and Safari record; other browsers say so before recording.
