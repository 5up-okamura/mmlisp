# MMLisp Composer's Guide

Practical authoring guide for the current MMLisp language. This is the
tutorial; the full reference (every keyword, range, and rule) is
`docs/language.md`.

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
| `fm1`-`fm6`               | YM2612 FM channels (`fm6` also plays PCM via `:mode`) |
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
- `:shuffle N` — swing ratio (`51`–`90`; `none` = straight). Head-only: write it
  right after the channel name, not mid-body; per-track (no score-wide default)
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

`(t e g a)` divides one `:len` slot among its elements using Bresenham
distribution.

### Counted loop

```lisp
(fm1 :len 8
  (x 4
    c d e :break f g))
```

- `(x N ...)` repeats body `N` times.
- `:break` skips the tail on the last pass.

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

An FM voice def is a keyword map of the YM2612 algorithm/operator parameters.
The quickest way is to `:extend` the built-in neutral patch `init-fm` and
override only what you need:

```lisp
(def brass :extend init-fm
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0)

; use by bare identifier:
(fm1 :oct 4 :len 8
  brass
  c e g e)
```

`init-fm` (ALG 7, full envelope, TL 0 on all operators) is always available as
an `:extend` base. You can also write a full patch from scratch — every operator's
`:ar`/`:dr`/`:sr`/`:rr`/`:sl`/`:tl`/`:ks`/`:ml`/`:dt` plus `:alg`/`:fb`/`:ams`/`:fms`;
unset params are not emitted, so start from a full patch or `:extend` one. See
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
`saw` `ramp`) loop by default; any other curve loops when you add the **`:loop`**
flag:

```lisp
(def organ (macro :vel [
  (ease-in :from 0 :to 15 :len 2)         ; attack
  (sin :from 13 :to 15 :len 4)            ; vibrato sustain — loops until key-off
  (ease-out :from 15 :to 0 :len 6)        ; release
]))
```

The value-less `:loop` flag forces a non-loop curve to cycle, e.g.
`(ease-out :from 15 :to 0 :len 4 :loop)` as a pulsing sustain stage.

### `(const V :len D)` — flat segment

`const` holds a single value (the positional argument) for `:len`. Useful as a
flat stage, or to retrigger for a fixed span after key-off without listing
repeats — combined with `:step` it fires once per step (see §12):

```lisp
(def tail (macro :step 16 :keyon [(wait key-off) (const 1 :len 8)]))

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
cents). On a sustained voice this is a classic arpeggio. `:hold` marks the loop
point.

```lisp
(fm1 (macro :step 1/16  :semi [:hold 0 4 7])  c)   ; c–e–g, looping
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
(fm1 (macro :step 1/16 :semi [:hold 0 4 7])   ; arp on the 1/16 grid
     (macro :step 1/8  :keyon [0 :off 1 1 1])  ; echo tail on the 1/8 grid
     c)
```

### Echo-tail preset (1-channel delay on one note)

```lisp
(def echo-tail (macro :step 1/8  :keyon [0 :off 1 1 1]
                                 :vel   [15 :off 10 5 0]))

(fm1 echo-tail :len 8  c _ _ _)
```

After KEY-OFF the note retriggers three times at 1/8 spacing, decaying via the
phase-locked `:vel` release. (`:vel` floors at ~-30 dB; for a tail that fades to
true silence, automate `:tl` to 127 instead — see §5.) For a long tail, replace
the `1 1 1 …` list with `[(wait key-off) (const 1 :len N)]` — it fires once per
`:step` across `:len` without counting taps (see §10).

Clear a macro with `none`: `(macro :semi none)`, or `(macro none)` clears all.

---

## 13. Track Delay (`(delay ...)`)

`(delay ...)` echoes the **written notes** at compile time — a whole phrase
repeats, shifted and decayed. (Distinct from `:keyon`, which retriggers a single
note.) Taps are **relative** to each note's own value: an echo follows whatever
velocity that note carries.

```text
(delay <target> <count|list|curve> :by N :time T)
```

- `<target>` — `:vel+` (additive deltas) or `:vel*` (multiplicative ratios);
  the operator is required. (`:vol` is reserved, not yet supported.)
- 2nd arg is polymorphic:
  - a **number** = tap count (pair with `:by`),
  - a **`[list]`** = explicit per-tap deltas (`:vel+`) or ratios (`:vel*`),
  - a **`(curve …)`** = relative envelope; tap count = its `:len ÷ :time`.
- `:by N` — per-tap step: on `:vel+`, tap k = note_vel + N·k; on `:vel*`,
  tap k = note_vel · N^k.
- `:time T` — tap spacing (length token).

`(delay ...)` is **sticky** track state that applies to following notes;
`(delay none)` clears it, `(delay :vel none)` clears one target. Delay is an
**overlay** that fills gaps — it does **not** lengthen the phrase.

```lisp
(fm1 (delay :vel+ 3 :by -4 :time 1/8)
  c e g e)
```

plays the phrase plus three decaying repeats (−4 vel each tap), spaced an eighth
apart. Equivalent explicit form: `(delay :vel+ [-4 -8 -12] :time 1/8)`.

```lisp
(fm1 (delay :vel+ 3 :by -1 :time 4t)  c e g e)   ; 3 echoes, −1 vel each, spaced 4t
(fm1 (delay :vel* (linear :from 0.8 :to 0 :len 10t) :time 2t)  c)  ; non-linear ratio fade
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
(echo <target> <count> :by N [:back B])
```

- `<target>` — `:vel+` (additive) / `:vel*` (multiplicative); the operator is
  required.
- `<count>` — number of taps. `:by N` — per-tap step (`:vel+` → note_vel + N·k;
  `:vel*` → note_vel · N^k).
- `:back B` — replay the single note B positions back (`B=1` = the last note,
  the default).

```lisp
(fm1 c (echo :vel+ 3 :by -1))         ; last note replayed at vel−1, −2, −3 (decaying trail)
(fm1 c (echo :vel* 3 :by 0.7))        ; ×0.7, ×0.49, ×0.343
(fm1 c e (echo :vel+ 1 :by -4 :back 2))  ; replay the note 2 back (c) once at vel−4
```

### Echoes inherit articulation

Delay echoes carry the source's per-note macros (`:keyon`, `:semi`, …), so a
phrase with a 1-channel `:keyon` tail repeats with that tail.

```lisp
(def echo-tail (macro :step 16 :vel [15 :off 10 5 0] :keyon [0 :off 1 1 1]))

(fm1 echo-tail (delay :vel+ 4 :by -3 :time 4)
  :len 16 c _ _ _ :len 4 _ _ _)
```

Each phrase repeat retriggers like the source; its vel tail rides the note's
velocity, lowered by the delay's per-tap step.

---

## 14. Noise Authoring (`noise` channel)

```lisp
(def perc-buzz (macro :mode [white0 :hold periodic3]))
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

### `:gate 0` — hold, timeline advances

`:gate 0` fires KEY-ON and holds indefinitely, but the timeline still advances by `:len`. Use this when the channel needs to stay in sync with others while holding a note.

```lisp
(fm1 :len 4 :gate 0
  c _ _ _)   ; KEY-ON on beat 1, timeline moves 4 beats, KEY-OFF via runtime
```

### `:len 0` — hold, timeline does not advance

`:len 0` fires KEY-ON, holds indefinitely, and does not advance the timeline. Any subsequent notes in the same channel all land at tick 0. Useful for a single held note with a release macro:

```lisp
(sqr1 :len 0 (macro :vel [15 :hold 14 13 :off 8 4 0])
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
player and driver still see one track per channel. Keep loops and heavy
parameter automation on a single layer — flow control across `:prio` layers is
not reconciled.

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
(def-val cutoff 30 :from 0 :to 127)
(def-val depth 20 :from 0 :to 60)

(fm1 :tl1 $cutoff                              ; absolute from the slot
     :tl2+ $cutoff                             ; relative to the slot
     (macro :pitch (sin :from -40 :to $depth)) ; dynamic LFO depth
     c e g e)
```

- `:from` / `:to` set the slider's endpoints (either direction); the
  positional value is the initial setting.
- `$time` is built in: elapsed 60 Hz frames since track start.
- Curve `:from` / `:to` / `:rate` / `:len` accept `$name`, read once at each
  note-on.

See `docs/language.md` §8 for `:step`, `:unit`, and the IR mapping.

---

## 19. PCM Samples

Samples are defined with `def :sample`, then used as the first positional argument of `pcm1` / `pcm2` / `pcm3`.

```lisp
(def kick  :sample :file "sounds/kick.wav")
(def snare :sample :file "sounds/snare.wav" :rate 11025)

(pcm1 kick :tempo 120  :len 4  c _ c _)
(pcm2 snare :len 4  _ c _ c)
```

- `:file` is required.
- `:rate` overrides the C4 playback rate.
- Stereo WAV files are downmixed to mono at compile time.
- WAV data is converted to 8-bit signed PCM at compile time.

---

## 20. Stochastic Curves

The curve system now includes `noise`, `pink`, `perlin`, and `brown`.
They can be used anywhere curve expressions are accepted, including `(macro ...)` and `:tempo`.

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
(def env (macro
  :vel [15 12 8 4 0]
  :pan [:hold left center right center]))

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
and the `v±` / `o±` shifts.

Hover a value to confirm it is editable: the whole token gets a dotted underline
and a hint shows its range. Three ways to change it:

- **Long-press** the token (works with mouse and touch) to open a popup — a
  slider + `−`/`+` steppers for a bounded number, or a one-octave piano for a
  note (tap a key to audition and set it, staying in the current octave). The
  popup stays open until you dismiss it (click away or `Esc`).
- **Alt-drag** the token up/down to scrub it — up raises, down lowers, like a
  slider (hold `Shift` for a coarse step). Desktop only; the pointer turns into
  a resize cursor.
- **`Cmd/Ctrl+Shift+.`** / **`Cmd/Ctrl+Shift+,`** nudge the value under the
  cursor up / down (the `>` / `<` keys, matching MML's octave shifts); add
  `Alt` for a coarse step.

While the score is playing, an edit hot-swaps at the next bar so you hear it
immediately; stopped, changes apply on the next **Build**. Tap a bar marker `|`
for its bar number and tick count (§4).
