# MMLisp Language Reference

Describes the current MMLisp language (v0.5 lineage).

This is the canonical reference for the language as implemented by
`live/src/mmlisp2ir.js`. For a learning-ordered introduction, see
`docs/guide.md`. IR event shapes are noted where they define observable
behavior; the full IR format lives in `docs/ir.md`.

---

## 1. Source model

A source file is a sequence of top-level forms:

| Form              | Role                                             |
| ----------------- | ------------------------------------------------ |
| `(def name …)`    | Named definition (snippet, voice, sample, macro) |
| `(def-val name …)`| Runtime value slot declaration                   |
| `(score …)`       | The score — exactly one is required              |

- `;` starts a line comment.
- Strings use double quotes (`"…"`).
- `#name` atoms are labels (§13).
- Inside `(score …)`, keyword pairs before the first channel form are score
  options; every list whose head is a channel name (§2) is a track form.
  A list with any other head inside `score` is an error: an unknown head
  (usually a channel-name typo) is `E_SCORE_UNKNOWN_FORM`, and a `def`/`def-val`
  placed inside `score` is `E_DEF_IN_SCORE` (definitions must be top-level, §9).

### Score options

```lisp
(score :title "Song" :author "Me" :tempo 140 :lfo-rate 5 :shuffle 66
  (fm1 c e g e))
```

| Option      | Value                | Effect                                        |
| ----------- | -------------------- | --------------------------------------------- |
| `:title`    | string               | Metadata                                      |
| `:author`   | string               | Metadata                                      |
| `:tempo`    | integer BPM or curve | Bare integer → `TEMPO_SET` at tick 0 (default 120; fractional BPM needs a mid-track `:tempo`). A curve → `TEMPO_SWEEP` from tick 0, e.g. `:tempo (linear :from 120 :to 80 :len 4)` (`:from` defaults to 120 if omitted) |
| `:lfo-rate` | 0–8                  | YM2612 global LFO (`0` = off)                 |
| `:shuffle`  | 51–90 (`none` = off) | Score-wide swing default (§5)                 |

### Channel forms: append and layer

Multiple forms of the same channel with **equal `:prio`** append into one
timeline; sticky track state (octave, length, gate, …) carries across them.

Forms with **distinct `:prio`** become parallel timelines on the one physical
channel, each starting at tick 0, flattened at compile time into a single
monophonic event stream:

- `:prio N` — unsigned integer, **lower number = higher priority**, default `8`.
- A lower-priority note that starts while a higher-priority note is sounding
  is **dropped**; one interrupted mid-sustain is **cut** (gate truncated, no
  release tail).
- Non-note events pass through in tick order. Loops/flow control across
  layers are not reconciled (`W_PRIO_LAYER_FLOW`); keep loops on one layer.

```lisp
(score
  (fm1 :prio 1 :len 4   c _ _ g _ _)                 ; lead — always sounds
  (fm1 :prio 5 :len 16  e e e e e e e e e e e e))    ; filler — yields
```

The flattened output is one track per channel; player and driver are
unaffected by layering.

---

## 2. Channels

| Name            | Hardware                | Notes                                             |
| --------------- | ----------------------- | ------------------------------------------------- |
| `fm1`–`fm5`     | YM2612 FM channels      |                                                   |
| `fm6`           | YM2612 FM               | FM only; PCM is `pcm1`–`pcm3`. Using any `pcmN` puts fm6 in DAC mode (the hardware shares one DAC) |
| `fm3`           | YM2612 FM3, normal mode | Note-less `(fm3 voice)` declares the shared patch for independent-OP mode |
| `fm3-1`–`fm3-4` | FM3 independent-OP mode | One track per operator F-number; presence enables the mode (`FM3_MODE op`) |
| `fm3-csm`       | FM3 CSM mode            | Tonal center; standard note syntax                |
| `fm3-csm-rate`  | FM3 CSM Timer A         | Buzz frequency as notes / raw Hz                  |
| `sqr1`–`sqr3`   | SN76489 square channels |                                                   |
| `noise`         | SN76489 noise channel   | Modes `white0`–`white3`, `periodic0`–`periodic3`  |
| `pcm1`–`pcm3`   | Z80 soft-mixed PCM      | Sample symbol is the first positional argument    |

Mode exclusivity (compile errors, score-wide):

- `fm3-csm`/`fm3-csm-rate` cannot be mixed with `fm3` or `fm3-1`–`fm3-4`
  (`E_FM3_MODE_CONFLICT`).
- Inline `:csm-rate` and a companion `fm3-csm-rate` track are mutually
  exclusive (`E_CSM_RATE_SOURCE_CONFLICT`).

Details for FM3/CSM in §15, PCM in §16.

---

## 3. Notes, rests, ties, octaves

| Token          | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `c d e f g a b`| Note names; accidentals `+` (sharp) / `-` (flat): `c+`, `d-`   |
| `c4`, `e8.`, `f+12t`, `b-6f`, `a1/2` | Per-note length suffix (any length token, §4); affects only that note |
| `_`            | Rest at the current `:len`                                     |
| `_4`, `_4.`, `_14t`, `_1/2` | Explicit-length rest                              |
| `X ~ Y`        | Connector: same pitch **ties** (extends), different pitch **slurs** (legato — §3.1) |
| `>` / `<`      | Octave up / down (±1)                                          |
| `o+N` / `o-N`  | Octave shift (no number = ±1)                                  |
| `v+N` / `v-N`  | Velocity shift (no number = ±1)                                |

The sounding octave comes from the sticky `:oct` (C at `:oct 4` = middle C,
MIDI 60). Enharmonic accidentals are equivalent (`c+` = `d-`).

Note names shadow definitions: a `def` named `a`–`g` (or anything that parses
as a note/length token) cannot be referenced in a channel body.

### Tie and slur — `X ~ Y`

`~` is a binary connector between two notes. It attaches to the **next real
note**, skipping state tokens (`c ~ > d` slurs to the octave-up `d`). The right
note keeps its own length, so `~` takes none.

- **Same pitch → tie.** `c ~ c` (or `g8 ~ g8`) extends the first note by the
  second's length — one attack, held longer. Equivalent to a longer length token.
- **Different pitch → slur (legato).** `c ~ e` moves the frequency to `e`
  **without re-keying** — the FM envelope (or the PSG tone) carries over from
  `c`, no new attack. Chains: `c ~ d ~ e` is one attack gliding through all three.

For the slur to sustain across the connection the left note needs a **full gate**
(the default); a `:gate`-cut (staccato) note keys off first, so the slur starts
from a decaying tone. Slur/legato is an **FM/PSG** feature (the macro/keying
model of channels 0–9); on other channels a different-pitch `~` is treated as a
normal note. Encoded as `NOTE_ON_EX` bit3 (opcodes.md §5.1).

### Tuplets — `(t …)`

`(t elem …)` divides **one** current `:len` slot among its elements
(Bresenham distribution, so remainders spread evenly):

```lisp
(score
  (fm1 :len 4
    c (t e g a) f     ; triplet inside one quarter
    (t c _ c)))       ; rests allowed
```

Elements may be notes, per-note-length atoms (their suffix is ignored — the
slot division wins), or `_` rests. Tuplets do not nest
(`E_UNKNOWN_TUPLET_ELEM`); an empty `(t)` is `E_TUPLET_EMPTY`.

A bare note-headed list (the pre-v0.5 subgroup form `(e g a)`) is no longer a
tuplet — it is rejected with `E_UNKNOWN_LIST`; the syntax is reserved.

---

## 4. Time base and length tokens

The timeline is measured in ticks at **PPQN 96**: quarter = 96 ticks, whole
note = 384 ticks. The IR carries `ppqn`; players derive seconds-per-tick from
`60 / (bpm × ppqn)`.

Length token grammar:

| Form  | Meaning                                                | Example ticks |
| ----- | ------------------------------------------------------ | ------------- |
| `N`   | Note-length denominator (`4` = quarter, `8` = eighth)  | `4` → 96      |
| `N.`  | Dotted (×1.5)                                          | `8.` → 72     |
| `N/M` | Fraction of a whole note (`2/1` = 2 bars, `1/3` = triplet whole) | `1/3` → 128 |
| `Nt`  | Exact tick count                                       | `6t` → 6      |
| `Nf`  | N frames (1/60 s); context-dependent (see below)       | —             |
| `0`   | Hold: KEY-ON without advancing / without KEY-OFF (§17) | 0             |

Accepted wherever a length appears: `:len`, note/rest suffix, `:gate`,
`:gate-`, curve `:len`, macro `:step`, `~ N`, `(wait N)`, `(glide T)`,
`(delay … :time T)`, `:shuffle-base`.

`Nf` is a true 60 Hz frame count — scheduled per frame, tempo-independent — in
curve `:len`, macro `:step`, a `(wait Nf)` stage, and `def-val :unit frame`
slots (the player runs these off its own frame clock).

In **structural** contexts that advance the musical timeline — note length,
`:gate`, `~` (tie), rests, `(glide T)`, and `(delay … :time T)` — `Nf` is
converted to ticks at the tempo active at compile time. So `c16f` lasts 16/60 s
at the tempo it was authored under; a mid-track `:tempo` change before the note
is accounted for, but a **runtime** tempo change (live `setTempo`, or a
`TEMPO_SWEEP` spanning the note) scales it like any tick duration. Use `Nt` when
you want an exact, tempo-proof tick count.

---

## 5. Track state and keywords

All track state is sticky: it persists across items and across appended forms
of the same channel. Defaults:

| State      | Default            |
| ---------- | ------------------ |
| `:oct`     | `4`                |
| `:len`     | `8` (48 ticks)     |
| `:gate`    | full note length   |
| `:vel`     | `15`               |
| `:vol`     | `31`               |
| `:prio`    | `8`                |
| `:shuffle` | off (`none`)       |
| tempo      | 120 BPM            |

### Head-only options

These are consumed as key/value pairs immediately after the channel name and
must appear there (they are ignored in the body): `:prio`, `:shuffle`,
`:shuffle-base`. (`:oct` `:len` `:gate` `:gate*` `:gate-` `:vel` also parse in
head position, and equally as body directives.)

### Body keywords

| Keyword    | Value                     | Effect                                                   |
| ---------- | ------------------------- | -------------------------------------------------------- |
| `:oct`     | integer ≥ 0               | Octave (also `:oct+` / `:oct*`, §7)                      |
| `:len`     | length token              | Default note length; `0` = hold, no timeline advance     |
| `:gate`    | length token              | Absolute sounding time per slot; `0` = hold until runtime KEY-OFF |
| `:gate*`   | ratio `0.0`–`<1.0`        | Gate as a fraction of the note length                    |
| `:gate-`   | length token              | Gate = note length minus this time (floor 1 tick)        |
| `:vel`     | 0–15                      | Note-on velocity (also `:vel+` / `:vel*`)                |
| `:vol`     | 0–31 or curve             | Channel fader → `PARAM_SET` / `PARAM_SWEEP`              |
| `:master`  | 0–31 or curve             | Global fader → `PARAM_SET` / `PARAM_SWEEP`               |
| `:tempo`   | number > 0 or curve       | Global: `TEMPO_SET` / `TEMPO_SWEEP` at this tick         |
| `:pan`     | `left`/`center`/`right`, −1/0/1, curve, `none` | FM stereo bits            |
| `:mode`    | symbol                    | `pcm1`–`pcm3`: `shot`/`loop` (per-note); `noise`: `white0`–`white3`/`periodic0`–`periodic3` |
| `:sample`  | sample def name           | Re-bind the PCM sample (PCM-active tracks)               |
| `:csm-rate`| Hz or curve               | Timer A rate (`fm3-csm` only, §15)                       |
| `:break`   | (no value)                | Early exit of the enclosing counted loop (§13)           |
| hardware params | value / curve / `none` / `$slot` | `:alg :fb :ams :fms :lfo-rate :tl1`–`:tl4` `:ar :dr :sr :rr :sl :ml :dt :ks :ssg :am`(1–4) — §5.1 |

The relative gates (`:gate*` / `:gate-`) resolve against the **whole tied note**,
not just its first segment: for `c4 ~ c8` with `:gate- 1f` the key-off lands one
frame before the tied end, so the tie stays connected. Absolute `:gate N` is
unaffected by ties.

`:tempo N` reanchors the timeline instantly; `:tempo (linear :from A :to B
:len L)` emits `TEMPO_SWEEP` over `L` (any non-`const` curve name works —
there is no curve literally named `curve`). Tempo changes apply to all tracks.
The same curve form works as a score option (§1), emitting the sweep from
tick 0. `:tempo`/`:master` are global, so if two tracks write one at the same
tick the **last writer wins** (track order); the tick-0 initial tempo resolves
the same way. Keep global automation on a single track to avoid ambiguity.

On the `noise` channel, `:mode` sets the noise mode as **persistent channel
state**: it emits `PARAM_SET NOISE_MODE`, and every noise note re-asserts the
current mode. The channel starts in `white0`; `:mode white2` changes it and the
new mode holds across notes until the next `:mode`. A `:mode` macro (§10)
layers a *temporary* per-note override on top without disturbing this state. An
unknown symbol is rejected with `E_NOISE_MODE_INVALID`.

### 5.1 Inline parameter writes

Any macro target keyword (§10 table) written inline in the body is a
parameter write at the current tick:

| Form              | IR                       | Meaning                             |
| ----------------- | ------------------------ | ----------------------------------- |
| `:tl1 30`         | `PARAM_SET`              | Absolute write                      |
| `:tl1 (linear …)` | `PARAM_SWEEP`            | Timeline sweep, free of key-on      |
| `:tl1 none`       | `PARAM_SWEEP_STOP`       | Stop a running sweep, freeze value  |
| `:tl1+ 5`         | `PARAM_ADD`              | Runtime read-modify-write add       |
| `:tl1* 0.5`       | `PARAM_MUL`              | Runtime read-modify-write multiply  |
| `:tl1 $x`         | `PARAM_FROM_VAL`         | Read a value slot (§8)              |
| `:tl1+ $x` / `:tl1* $x` | `PARAM_ADD` / `PARAM_MUL` with `{src}` | Slot-relative     |

`(param-set :target v :target v …)` batches absolute integer writes
(`E_UNSUPPORTED_TARGET` for unknown targets).

An inline `:keyword` that is neither a known directive nor a hardware param
target (a typo, or a track-header option like `:ch` used mid-body) is rejected
with `E_UNKNOWN_KEYWORD` rather than silently dropped.

### 5.2 Shuffle

`:shuffle R` (51–90; `none` = straight) swings note/rest pairs whose nominal
length equals `:shuffle-base` (default: eighth). The pair spans 2× the base;
the first beat takes `R` % of it. Score-level `:shuffle` sets the default for
all tracks.

```lisp
(score
  (sqr1 :shuffle 66 :len 8  c c c c))
```

---

## 6. Level model

`vel` / `vol` / `master` are signed dB offsets composed by **addition** on top
of each operator's voiced (timbre) TL, summed in float and quantized **once**
at the register write:

```text
FM:  carrier TL  = clamp(0..127, round( voicedTL[op] + dVel + dVol + dMaster ))
PSG: attenuation = clamp(0..15,  round(               dVel + dVol + dMaster ))
```

The offset is uniform across carriers, preserving the patch's per-carrier
balance.

- **`:vel` 0–15** — a 2 dB/step ladder. `15` = 0 dB (patch level), `0` ≈
  −30 dB floor. Attenuation only — velocity **never mutes** (silence is a
  rest).
- **`:vol` / `:master` 0–31** — mixer-faders with unity (0 dB) at the top:
  `31` = full, lower cuts. **`0` is a hard mute** (FM skips key-on, PSG goes
  to max attenuation). Their offsets add.

Authored values are integers; computed values (macros, delay taps) stay float
through the pipeline and reach the hardware's native resolution (FM TL 0.75
dB steps; PSG capped at its 16-step attenuator). A `:vel` macro fades only to
the velocity floor — for a fade to true silence automate `:tl` (carrier TL →
127) or use `:vol`.

Tunable constants: `VEL_DB_PER_STEP`, `VOL_STEP_DB`, `VOL_UNITY` in
`live/src/ir-utils.js`.

---

## 7. Operators (`+` / `*`)

One rule across the language: a trailing operator on a target keyword combines
the value with the target's base. No suffix = absolute, `+` = add, `*` =
multiply. There is no `-` / `/` — subtract with a negative (`:vel+ -2`),
divide with a fraction (`:vel* 0.5`).

| Context             | Absolute    | Add           | Multiply       | Resolution   |
| ------------------- | ----------- | ------------- | -------------- | ------------ |
| inline vel / oct    | `:vel 12`   | `:vel+ 2`     | `:vel* 0.5`    | compile time |
| inline other params | `:tl1 30`   | `:tl1+ 5`     | `:tl1* 0.5`    | runtime `PARAM_ADD` / `PARAM_MUL` |
| macro (`:vel` only) | `:vel [..]` | `:vel+ [..]`  | `:vel* [..]`   | per note-on  |
| echo / delay        | —           | `:vel+`       | `:vel*`        | compile time |

- `vel`/`oct` have a compile-time base in the track state, so the IR carries
  plain absolute values.
- In macros, `+`/`*` apply only to `:vel` (the one macro target with a base);
  other targets raise `E_MACRO_OP_NO_BASE`. `:vel*` scales the macro by the
  note's 0–1 vel ratio; `:vel+` offsets it by the note's vel.
- Echo/delay taps are always relative, so an operator is **required**: bare
  `:vel` raises `E_ECHO_OP_REQUIRED` / `E_DELAY_OP_REQUIRED` (the clear forms
  `(delay none)` / `(delay :vel none)` excepted).

---

## 8. Dynamic values — `(def-val …)`, `$name`

Runtime values for interactive playback. Computation lives on the host; the
score only reads slots — there are no score-side expressions.

```lisp
(def-val level 20 :from 0 :to 40 :step 2)
(def-val depth 30)

(score
  (fm1 :tl1 $level               ; PARAM_FROM_VAL
       :tl2+ $level              ; PARAM_ADD (slot-relative)
       :vol* $level              ; PARAM_MUL
       :ar1 $time                ; built-in source
       (macro :pitch (sin :from -40 :to $depth :rate 2))
       c e g e))
```

`(def-val name init :from A :to B :step S :unit U)`:

| Field      | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `init`     | Positional default (integer). Omitted → defaults to `:from`      |
| `:from` / `:to` | Order-free directional endpoints — the live slider runs from A to B (either direction, negatives fine). `:min` / `:max` are accepted synonyms |
| `:step`    | Slider granularity, integer > 0 (default `1`)                    |
| `:unit`    | `frame` (default) or `tick` — how the value is read when the slot feeds a curve `:len` |

Slots are indexed in declaration order and emitted in `metadata.vals` as
`{name, slot, init, min, max, step, reversed, unit}`. The live app renders one
Dynamic Parameters slider per slot. Names must not start with `$`
(`E_DEFVAL_NAME`).

- `$name` references a slot in a value or operator-operand position of a
  runtime parameter write (§5.1). `vel`/`oct` resolve at compile time and do
  not accept `$`.
- `$time` is built in: elapsed 60 Hz frames since track start, read-only.
- An undefined `$name` raises `E_VAL_UNDEFINED`.
- A slot value is always clamped to its declared `[min, max]` finite range —
  at `init` and on every host `setVal` — so a bad (out-of-range or non-finite)
  value can never reach the pitch/length/gate/param math. This mirrors the
  bounded integer slots the Z80 driver will hold.

**Dynamic curve parameters.** A `$name` may feed a curve's `:from`, `:to`,
`:rate`, or `:len`. The slot is read **once at note-on**, so the value is
constant for that note. `:len` uses the slot's `def-val :unit` to pick
frame/tick interpretation. The macro `:step` clock is static. The curve spec
records these in a `dyn` map the player resolves at schedule time.

---

## 9. `def` forms

`def` names any inline-writable notation; a bare reference in a channel body
expands or applies it. Definitions are top-level: a `def`/`def-val` inside
`(score …)` is rejected with `E_DEF_IN_SCORE` (§1).

| Form                                  | Kind                                    |
| ------------------------------------- | --------------------------------------- |
| `(def name item…)`                    | Snippet — inline expansion at the reference (recursion depth ≤ 16) |
| `(def (name param…) item…)`           | Parametric snippet — call as `(name arg…)`; each `arg` node is substituted for its `param` in the body (§9.1) |
| `(def name :alg … :tl1 … …)`          | FM voice, keyword map                   |
| `(def name :extend base :tl1 … …)`    | FM voice inheriting `base` (child keys override; cycles are `E_EXTENDS_CYCLE`) |
| `(def name :sample :file "…" …)`      | PCM sample (§16)                        |
| `(def name (macro :target spec …))`   | Macro preset — single or multi target   |
| `(def name (macro :target none))`     | Clear-def — applying it clears that target's macro |

An FM voice def is recognized by its first keyword being one of the
`:alg`/`:fb`/`:ar*`/`:tl*`/`:dr*`/`:sr*`/`:rr*` families (or `:extend`).
Unset operator parameters are not emitted — start from a full patch (or
`:extend` one) for deterministic timbres. The built-in voice `@init-fm`
(ALG 7, AR 31, RR 15, ML 1, TL 0 on all operators) is always available:

```lisp
(def lead :extend @init-fm
  :alg 4 :fb 3
  :tl1 30 :tl2 0 :tl3 30 :tl4 0)

(score
  (fm1 lead c e g e))
```

Referencing a voice def mid-track re-emits its `PARAM_SET`s (patch switch).
Macro defs apply to the track's active-macro state exactly like the inline
`(macro …)` form; bare names may also be mixed inside `(macro …)` (§10).

### 9.1 Parametric snippets

`(def (name param…) body…)` is a snippet that takes arguments. A reference is a
call form `(name arg…)`; each `arg` (one atom or list node) is substituted for
the matching `param` wherever it appears in the body, then the result is
expanded like any snippet. Substitution is **token-level only** — there is no
computation — and a `param` **shadows** any note/length token of the same name
inside the body. A call whose argument count differs from the parameter count is
`E_DEF_ARITY`.

```lisp
(def (beat n) (x 8 > n > n <))      ; one bar of n, octave-bounced ×8

(score
  (fm1 :oct 1
    (beat c) (beat b-) (beat a) (beat f)))
```

---

## 10. Macros — `(macro …)`

Macros are KEY-ON scoped: each `NOTE_ON` snapshots the track's active macros
and runs them for that note. Setting a macro is sticky until cleared.

```lisp
(def pluck (macro :vel [15 12 8 4 0]))

(score
  (fm1 pluck c                                ; bare def name
       (macro :vel [15 10 5 0]) c             ; inline anonymous
       (macro pluck :pan [left center right]) c   ; mix named + inline
       (macro :vel none) c                    ; clear one target
       (macro none) c))                       ; clear all
```

If the same target is set twice, the last one wins.

### Targets

| Keyword    | IR target    | Range        | Notes                                  |
| ---------- | ------------ | ------------ | -------------------------------------- |
| `:vel`     | `VEL`        | 0–15         | Only target accepting `+`/`*` (§7)     |
| `:pitch`   | `NOTE_PITCH` | ±32768 cents | Continuous pitch offset, no retrigger  |
| `:semi`    | `NOTE_SEMI`  | ±48          | Semitone steps (×100 cents), no retrigger — chiptune arpeggio |
| `:keyon`   | `KEYON`      | 0–1          | Retrigger gate, thresholded at ≥ 0.5   |
| `:vol`     | `VOL`        | 0–31         |                                        |
| `:master`  | `MASTER`     | 0–31         |                                        |
| `:pan`     | `PAN`        | −1–1         | Values snap to −1 / 0 / +1; symbols `left center right` |
| `:mode`    | `NOISE_MODE` | 0–7          | Symbols `white0`–`white3` (4–7), `periodic0`–`periodic3` (0–3) |
| `:lfo-rate`| `LFO_RATE`   | 0–8          |                                        |
| `:alg` `:fb` | `FM_ALG` `FM_FB` | 0–7    |                                        |
| `:ams`     | `FM_AMS`     | 0–3          |                                        |
| `:fms`     | `FM_FMS`     | 0–7          |                                        |
| `:tl1`–`:tl4` | `FM_TL1–4` | 0–127       |                                        |
| `:ar` `:dr` `:sr` (1–4) | `FM_AR/DR/SR` | 0–31 |                             |
| `:rr` `:sl` `:ml` (1–4) | `FM_RR/SL/ML` | 0–15 |                             |
| `:dt` (1–4) | `FM_DT`     | 0–7          |                                        |
| `:ks` (1–4) | `FM_KS`     | 0–3          |                                        |
| `:ssg` (1–4) | `FM_SSG`   | 0–15         |                                        |
| `:am` (1–4) | `FM_AMEN`   | 0–1          |                                        |

Out-of-range step values are clamped to the target's range (relative `+`/`*`
macros stay unclamped until combined with the base).

### Spec forms

| Form                        | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `[v v v …]`                 | Step vector — one value per `:step`                  |
| `[… :hold …]`               | `:hold` marks the loop point: steps from it cycle until key-off |
| `[… :off …]`                | `:off` marks the release section: steps after it run after key-off |
| `_` (inside a vector)       | Hold: advance one step, no write                     |
| `(curve …)` (§11)           | Sampled every `:step`                                |
| `[(stage) (stage) …]`       | Multi-stage: curve / `(wait N)` / `(wait key-off)` stages run sequentially |
| scalar (e.g. `1`)           | Constant signal, equivalent to `[:hold v]`           |
| `none`                      | Clear the target's macro                             |

Multi-stage rules: a stage that loops (loop-wave curve, or any curve with the
`:loop` flag) runs until key-off — a modulated sustain; `(wait key-off)` holds
the current value until key-off; `(wait N)` waits a length token. `(const V
:len L)` is a flat stage holding positional value `V`.

```lisp
(def organ (macro :vel [
  (ease-in :from 0 :to 15 :len 2)     ; attack
  (sin :from 13 :to 15 :len 4)        ; vibrato sustain — loops until key-off
  (ease-out :from 15 :to 0 :len 6)])) ; release

(score (fm1 organ :len 2 c e))
```

### `:step` — sampling clock

`:step token` sets a macro's sampling interval. It is **position-free**: one
`:step` applies to **every** target in the `(macro …)`, wherever it sits, so
`(macro :vel […] :step 4 :tl1 …)` and `(macro :step 4 :vel […] :tl1 …)` are
identical. A macro takes at most one `:step`; a second is `E_MACRO_STEP_DUP`.
For two different clocks in one note, write two `(macro …)` forms — they
compose. Default: `1f` (one 60 Hz frame).

- A step vector advances one step per `:step`; a curve is sampled-and-held
  every `:step` (coarse step = stepped LFO; default keeps curves smooth).
- All targets in a macro share its one `:step` and stay phase-locked.
- `:step` governs both the sustain loop and the `:off` release section.
- Each macro (and each def preset) carries its own step.

### Target groups

A `[]` vector of macro keywords in target position applies one spec to every
listed target — pure compile-time sugar, values clamp per target:

```lisp
(score
  (fm1 (macro [:tl1 :tl2 :tl3 :tl4] (linear :from 40 :to 0 :len 8)) c
       (macro [:tl1 :tl2] none) d))
```

### `:semi` and `:keyon`

`:semi` is the discrete counterpart of `:pitch` (semitones vs cents); neither
retriggers the envelope.

`:keyon` is sampled once per `:step`; a sampled value ≥ 0.5 fires a key-on
retrigger (key-off then key-on across the player's `KEY_OFF_LEAD` gap,
restarting the envelopes). The first sample at t = 0 coincides with the note's
own attack and is a no-op. Steps before `:off` loop until note-off (a roll);
steps after `:off` fire after note-off (a one-channel echo tail). While a
`:keyon` macro is active it owns the channel keying.

| Form                           | Result                                    |
| ------------------------------ | ----------------------------------------- |
| `:keyon 1`                     | Fire every `:step`                        |
| `:keyon 0`                     | Never fire (= omitting `:keyon`)          |
| `:keyon [1]`                   | One-shot at step 0, then stop             |
| `:keyon [:hold 1 0]`           | Alternate steps                           |
| `:keyon (square :duty 128)`    | Duty-gated regular retrigger              |
| `:keyon (noise :from 0 :to 1)` | Probabilistic retrigger (~50 % per step)  |

```lisp
(score
  (fm1 (macro :step 32 :keyon 1) c)                            ; drum roll
  (fm2 (macro :step 1/16 :semi [:hold 0 4 7] :keyon 1) c)      ; retriggered arp
  (fm4 (macro :step 1/8 :keyon [0 :off 1 1 1]
              :vel   [15 :off 11 7 3]) c))                     ; echo tail
```

---

## 11. Curves

Curve forms appear in macros, inline parameter sweeps, `:tempo`, `:csm-rate`,
and `(delay …)`:

```text
(curve-name :from A :to B :len L …optional-params)
(const V :len L)                  ; flat segment — positional value
```

### Names

| Family      | Names                                                                 | Loops by default |
| ----------- | --------------------------------------------------------------------- | ---------------- |
| Linear      | `linear`, `const`                                                     | no               |
| Easing      | `ease-in`, `ease-out`, `ease-inout` (quad aliases) and `ease-{in,out,inout}-{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}` | no |
| Loop waves  | `sin`, `triangle`, `square`, `saw`, `ramp`                            | yes              |
| Stochastic  | `noise`, `pink`, `perlin`, `brown`                                    | yes              |

Loop-wave and stochastic curves cycle until key-off; the value-less `:loop`
flag forces any other curve to cycle (a looping sustain stage). Loop direction
is forward only.

`curve-name` above is a placeholder — write a real name from the table. A
`(…)` in a curve position whose head is not one of these names (a typo, or the
literal word `curve`) is rejected with `E_UNKNOWN_CURVE`.

### Common parameters (all curves)

| Key      | Type          | Default | Meaning                                     |
| -------- | ------------- | ------- | ------------------------------------------- |
| `:from` `:to` | number   | 0       | Endpoints (accept `$slot`, §8)              |
| `:len`   | length token  | —       | Duration; ticks, or absolute frames with `Nf`; accepts `$slot` |
| `:phase` | int 0–255     | `0`     | Start phase offset                          |
| `:rate`  | number ≥ 0    | `1.0`   | Phase speed multiplier (relative to `:len`); `0` freezes the curve at its start phase; accepts `$slot` |
| `:loop`  | flag          | —       | Force looping                               |
| `:wait`  | length token or `key-off` | — | Delay before the curve starts    |

### Shape parameters

| Curves               | Key     | Range      | Default | Meaning              |
| -------------------- | ------- | ---------- | ------- | -------------------- |
| `square`             | `:duty` | 1–255      | `128`   | Duty cycle           |
| `sin` `triangle` `saw` `ramp` | `:skew` | −127–127 | `0` | Shape skew         |

### Stochastic parameters

| Curves    | Key            | Range     | Default | Meaning                          |
| --------- | -------------- | --------- | ------- | -------------------------------- |
| all four  | `:hold`        | int ≥ 1   | `1`     | Sample-and-hold interval         |
| all four  | `:jitter`      | 0.0–1.0   | `0.0`   | High-frequency randomness mix    |
| `pink`    | `:beta`        | > 0       | `1.0`   | Spectral tilt                    |
| `perlin`  | `:octaves`     | 1–8       | `3`     | Fractal octave count             |
| `perlin`  | `:lacunarity`  | > 0       | `2.0`   | Frequency ratio per octave       |
| `perlin`  | `:persistence` | > 0       | `0.5`   | Amplitude ratio per octave       |
| `brown`   | `:leak`        | 0–0.9999  | `0.99`  | Integrator leak coefficient      |

Normalization rules:

- Unknown keyword for a curve name → `E_CURVE_PARAM_UNKNOWN` (error).
- Out-of-range values are clamped with `W_CURVE_PARAM_CLAMPED`.
- All params are part of the LUT identity; identical curve + params
  combinations share one LUT.
- Stochastic curves use one fixed compile-time seed (`0xDEAD`) — the same
  source always produces identical data.

```lisp
(score
  (fm1 (macro :tl1 (brown :from 24 :to 34 :len 4 :rate 0.5 :hold 2 :leak 0.995))
    c e g e)
  (sqr1 (macro :pitch (pink :from -40 :to 40 :len 8 :beta 1.2 :phase 32))
    c c c c)
  (fm2 (macro :pan (perlin :from -1 :to 1 :len 16 :octaves 4 :persistence 0.6))
    c _ c _))
```

---

## 12. Echo and delay

Both replay written notes relative to each note's own value; both require an
operator on the target (§7). `:vel+` adds per tap (`note_vel + N·k`); `:vel*`
multiplies (`note_vel · N^k`). Only `:vel` is supported as a target
(`E_ECHO_TARGET` / `E_DELAY_TARGET` otherwise).

### `(echo …)` — phrase-lengthening replay

```text
(echo <:vel+|:vel*> <count> :by N [:back B])
```

One-shot at its position in the note stream (not sticky). Replays the single
note `B` positions back (`:back 1` = the last note, the default; history depth
9) `count` times; the taps occupy real time, so following notes shift back.
Taps play at the **current** `:len`/`:gate` (mucom `\=` semantics), not the
source note's.

```lisp
(score
  (fm1 c (echo :vel+ 3 :by -1)          ; vel−1, −2, −3 decaying trail
       c (echo :vel* 3 :by 0.7)         ; ×0.7, ×0.49, ×0.343
       c e (echo :vel+ 1 :by -4 :back 2)))  ; replay the c once at vel−4
```

### `(delay …)` — compile-time overlay

```text
(delay <:vel+|:vel*> <count|[list]|(curve …)> :by N :time T)
(delay none)          ; clear
(delay :vel none)     ; clear one target
```

Sticky track state: every following note emits echo copies at `+k·:time`, an
overlay that fills the gaps the written part leaves — it does **not** lengthen
the phrase.

- 2nd argument: a **number** = tap count (pair with `:by`); a **`[list]`** =
  explicit per-tap deltas (`:vel+`) or ratios (`:vel*`); a **`(curve …)`** = a
  relative envelope, tap count = curve `:len ÷ :time`.
- `:time T` — tap spacing (length token). Required (`E_DELAY_ARGS`).
- Monophonic priority: written notes win — an echo tap overlapping any
  written note's sounding span is dropped.
- Echo taps inherit the source note's articulation macros (`:keyon`, `:semi`,
  `:pitch`, operator macros, each with its own `:step`); the inherited `:vel`
  macro is rescaled so its peak matches the tap's velocity.
- Echoes are generated from the original note only — no feedback recursion.
  Cross-channel delay is out of scope: `def` the phrase and replay it on
  another channel.

```lisp
(score
  (fm1 (delay :vel+ 3 :by -4 :time 1/8)
    c e g e)                                     ; phrase + 3 decaying repeats
  (fm2 (delay :vel* (linear :from 0.8 :to 0 :len 10t) :time 2t)
    c))
```

---

## 13. Flow control

| Form           | IR                     | Meaning                                     |
| -------------- | ---------------------- | ------------------------------------------- |
| `#label`       | `MARKER`               | Position label (duplicate id = `E_MARKER_DUP`; empty = `E_LABEL_EMPTY`) |
| `(go label)`   | `JUMP {to}`            | Infinite loop back to `#label`              |
| `(go label N)` | `LOOP_BEGIN`/`LOOP_END`| The `#label`…`go` section plays N times, then falls through |
| `(x N body…)`  | `LOOP_BEGIN`/`LOOP_END`| Counted loop sugar                          |
| `(x body…)`    | `MARKER` + `JUMP`      | Infinite loop sugar                         |
| `:break`       | `LOOP_BREAK`           | On the final pass of the enclosing counted loop, exit here |

- `(go label N)` is rewritten post-merge into the same `LOOP_BEGIN`/`LOOP_END`
  as `(x N …)`, so the label and the `go` may live in different forms of the
  same channel. The `#label` must **precede** the counted `go` (a backward
  jump); a forward counted `(go label N)` is unsupported (`E_GO_FORWARD_COUNT`).
  Infinite `(go label)` may jump either direction.
- `go` arity: label plus optional positive count (`E_GO_NO_LABEL`,
  `E_GO_ARITY`, `E_GO_COUNT`). A `go` without a matching marker is
  `E_JUMP_UNRESOLVED`.
- `:break` binds to the innermost counted loop; infinite loops do not support
  it.
- **A loop replays baked notes; body state does not accumulate.** The body is
  compiled **once**, so sticky state changed inside it (octave `>`/`<`, `:oct`,
  `:vel`, `:len`, …) is baked into that single pass and does **not** carry from
  one iteration to the next. `(x 4 c >)` plays `c c c c`, not an ascending run —
  the `>` shifts the octave only for whatever follows the loop. When a body has a
  non-zero net octave (or other sticky) change and is reused or followed by more
  notes, rebalance it explicitly, e.g. `(x 4 n > n <)`, so the state returns to
  where it started after each invocation.

```lisp
(score
  (fm1
    (x 4 c d e :break f g)     ; body ×4; final pass stops before f g
    #verse
    c e g e
    (go verse 2)               ; the #verse section plays twice
    #head
    c g
    (go head)))                ; infinite outer loop
```

---

## 14. Glide

| Form               | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `(glide T)`        | Portamento into each following note from the previous note over `T` (length token) |
| `(glide from T)`   | One-shot override: next glide starts from absolute pitch `from` (note + octave, e.g. `f5`) |
| `(glide none)`     | Disable                                                     |

Glide emits a bounded `NOTE_PITCH` sweep before the `NOTE_ON`: a cent offset
running from `(previous − new) × 100` cents to 0 over `T`, then stopping (it
never bleeds into the next note). The first note of a track never glides.

On `fm3-csm-rate`, glide instead slides Timer A Hz between rate notes: a swept
`CSM_RATE {from,to,len}` clamped to the note length. The `(glide from T)`
override accepts a raw Hz literal or a pitch.

```lisp
(score
  (fm1 (glide 8) c e (glide f5 32) g (glide none) c))
```

---

## 15. FM3 modes and CSM

### Independent-operator mode

`fm3-1`–`fm3-4` each drive one operator's F-number as a monophonic track;
their presence enables the mode (`FM3_MODE op` at tick 0). The shared patch
(ALG, FB, per-op TL/ADSR) is declared with a note-less `(fm3 voice)` form.
Macros and `(glide …)` are independent per `fm3-N` track.

```lisp
(def kit :extend @init-fm :alg 7 :tl1 20 :tl2 30 :tl3 25 :tl4 0)

(score
  (fm3 kit)                     ; shared patch — no notes here
  (fm3-1 :oct 5 :len 8  c c)
  (fm3-2 :oct 3 :len 4  c _)
  (fm3-3 :oct 4 :len 8  c c)
  (fm3-4 :oct 2 :len 2  c _))
```

### CSM mode

`fm3-csm` carries the tonal center (standard note syntax and range).
`CSM_ON` is emitted once at the first note; **`CSM_OFF` fires once at the end
of the `fm3-csm` event stream** — mid-track rests do *not* toggle CSM. To
silence CSM mid-track, rest the rate source or write `:vol 0`. Clearing CSM on
`STOP_TRACK` is a driver duty.

Timer A frequency comes from exactly one source per score:

1. **Inline** `:csm-rate N` (constant Hz) or `:csm-rate (ease-out :from A :to
   B :len L)` (swept Hz) on the `fm3-csm` track, or
2. **Companion track** `fm3-csm-rate`, where note tokens convert to Hz at
   compile time. `:oct` range is 0–10 on this track only (values above are
   clamped, `W_CSM_RATE_OCT_CLAMPED`); bare numeric atoms are raw Hz literals
   for the range above `:oct 10`. `(glide …)` slides Hz between notes (§14).

Valid rate range: 52–53270 Hz, clamped with `W_CSM_RATE_CLAMPED`. A score
with neither source produces no Timer A retrigger (fm3-csm plays silently).

```lisp
(def brass :extend @init-fm :alg 4 :tl1 24 :tl3 24)

(score
  (fm3-csm brass :oct 4 :len 2
    c _ e _ g _)
  (fm3-csm-rate :oct 6 :len 1
    c d e f  g a b 20000))    ; notes → Hz; raw Hz literal above oct 10
```

---

## 16. PCM

Samples are declared with `def :sample` and bound to a track as the first
positional argument (or re-bound mid-track with `:sample name` / a bare
sample symbol).

```lisp
(def kick  :sample :file "sounds/kick.wav")
(def snare :sample :file "sounds/snare.wav" :rate 11025)
(def pad   :sample :file "sounds/pad.wav" :loop-start 0 :loop-end 4096)

(score :tempo 120
  (pcm1 kick  :len 4  c _ c _)
  (pcm2 snare :len 4  _ c _ c)
  (pcm3 pad :len 0 :vol 8 :mode loop  c))
```

### Sample def keys

| Key           | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `:file`       | WAV path, relative to the source file. Required (`E_SAMPLE_FILE`) |
| `:rate`       | C4 playback rate in Hz (default: the WAV's native rate)        |
| `:loop-start` / `:loop-end` | Sustain-loop points (sample frames)              |
| `:bit-depth`  | Quantize to N bits (expanded to 8-bit for playback)            |
| `:volume`     | Gain / normalization                                           |
| `:compress`   | Compressor preset                                              |
| `:reverb`     | Reverb preset                                                  |

All conversion is compile-time: stereo is downmixed `(L+R)/2`, data becomes
raw 8-bit signed PCM.

`pcm1`–`pcm3` are three voices **soft-mixed** by the Z80 to the single fm6 DAC
at a fixed mix rate (~10.5 kHz): each voice is resampled to that grid, the
voices are summed and **hard-clipped**, so loud simultaneous hits distort by
design (headroom is the composer's to manage via `:vel`/`:vol`). A `shot` plays
to its end; a `loop` sustains until `KEY_OFF` then plays its tail. See
driver.md §14.

### Playback

- **Pitch → rate**: `rate = 2^(semitones_from_C4 / 12)`; C4 = 1.0×. Practical
  range C2–C6 (0.25×–4.0×); outside notes clamp with `W_PCM_PITCH_CLAMP`.
- **`:mode`** is per-note (not sticky): `shot` (default) plays start→end
  once; `loop` plays attack, cycles `:loop-start`–`:loop-end` until KEY-OFF
  (a `PCM_NOTE_OFF` at the gate), then plays the release.
  > M1 limitation: a `shot` sample plays to its end regardless of the note's
  > `length`/`gate` (they are not forwarded to the mixer worklet); only `loop`
  > mode honors KEY-OFF. Gated / length-limited one-shots are a later milestone.
- `:len 0` holds a loop open until runtime `KEY_OFF` / `STOP_TRACK` (§17).
- `:vel`, `:vol`, `:master` compose through the standard level stack (§6).
- PCM plays on `pcm1`–`pcm3`, three voices **soft-mixed** to the single fm6 DAC
  (driver.md §14). `fm6` is FM only (`fm6 :mode shot`/`loop` is an error); using
  any `pcmN` claims the DAC, so fm6 is unavailable as FM at the same time.
- A PCM note without a bound sample is `E_PCM_SAMPLE_REQUIRED`; an unknown
  sample name is `E_PCM_SAMPLE_UNDEFINED`.

---

## 17. Holds — `len 0` and `gate 0`

| Form      | KEY-ON | Timeline advances | KEY-OFF                        |
| --------- | ------ | ----------------- | ------------------------------ |
| `:gate 0` | yes    | yes (by `:len`)   | runtime (`triggerKeyOff` / host `KEY_OFF`) |
| `:len 0`  | yes    | **no**            | runtime                        |

`:gate 0` keeps the channel in sync with others while holding; `:len 0` is a
single indefinite hold (subsequent events land at the same tick). Both enable
game-state-driven sounds: the note holds until the host sends `KEY_OFF` or
`STOP_TRACK`, firing any `:off` release macros.

```lisp
(score
  (sqr1 :len 0 (macro :vel [15 :hold 14 13 :off 8 4 0])
    c))
```

---

## 18. Bar markers — `|`

`|` is a bar marker: a purely editorial aid for lining up and checking phrase
lengths. Put it at the **end of each bar**. It emits nothing to the event stream
and has no effect on playback or the driver. Each `|` in a channel body records
the running tick and a 1-based ordinal, surfaced per track as `bars` in the IR
(`{ordinal, tick, line, column}`). Bar N runs from the previous `|` up to the
Nth `|`; the first bar counts implicitly from the track start (no leading `|`),
so the Nth `|` closes bar N and its tick count is the difference from the prior
marker (or 0).

There is **no meter or time-signature concept** — a song may change bar length
freely; markers only measure the bars you write. Compare a bar's tick count
across tracks to catch length drift before it becomes an audible phase slip.

```lisp
(score
  (fm1 :oct 4 :len 8
    c c c c c c c c |
    c c c c c c c c |))   ; two 384-tick bars
```
