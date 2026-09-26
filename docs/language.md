# MMLisp Language Reference

Describes the current MMLisp language (v0.5 lineage).

This is the canonical reference for the language as implemented by
`live/src/mmlisp2ir.js`. For a learning-ordered introduction, see
`docs/guide.md`. IR event shapes are noted where they define observable
behavior; the full IR format lives in `docs/ir.md`.

---

## 1. Source model

**1 file = 1 score.** There is no wrapper form — the file *is* the score. A
source file is a sequence of top-level forms, in source order:

| Form              | Role                                             |
| ----------------- | ------------------------------------------------ |
| `(def name …)`    | Named definition (snippet, voice, sample, macro) |
| `(def-val name …)`| Runtime value slot declaration                   |
| `(import "…")`    | Fold another file's defs in at compile time (§9.2) |
| `(channel …)`     | Track form — any list whose head is a channel name (§2) |

- `;` starts a line comment.
- Strings use double quotes (`"…"`).
- `#name` atoms are labels (§13).
- `def`/`def-val` and track forms interleave freely; a def only needs to
  precede its first use. Any other top-level list head (usually a channel-name
  typo) is `E_UNKNOWN_TOPLEVEL_FORM`.

### File metadata and global options

```lisp
(def title "Song")
(def author "Me")
(def pcm-voices 2)

(fm1 :tempo 140 :lfo-rate 5 c e g e)
```

- **`(def title "…")` / `(def author "…")`** — reserved defs carrying the file
  metadata (only the string form is special; the names stay usable as ordinary
  defs otherwise).
- **`(def pcm-voices N)`** — how many PCM voices the driver plays, 0–3. This is
  a whole-song choice: it picks the engine image, and with it the DAC rate
  (1 voice 14.4 kHz, 2 voices 10.1 kHz, 3 voices 6.7 kHz) and how much sample
  data fits in the song's 32 KB bank (2.3 / 3.2 / 4.9 seconds). Fewer voices
  buy a higher rate, so state the number you actually need. Omitted, it is the
  highest `pcmN` track the score uses; a `pcmM` track above the stated number
  is `E_PCM_VOICES`, and a value outside 0–3 is the same error. Unlike
  `title`/`author` the name is reserved outright — there is no ordinary-def
  fallback for it. See §16 and driver.md §5.
- **`:tempo` / `:lfo-rate`** — score-global effects, written on any track
  (leading position or mid-body); they apply to the whole song regardless of
  which track carries them. `:tempo` takes a BPM number or a curve
  (`TEMPO_SWEEP`, §5); the tempo at tick 0 also seeds `Nf` conversion (§4) for
  every track. Default 120.
- **`:shuffle` / `:shuffle-base`** — per-track body keywords (§5.2); there is
  no score-wide default.

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
- Non-note events pass through in tick order. A counted loop — `(x N …)` or
  `(go label N)` — on any layer of a layered channel is `E_PRIO_LAYER_LOOP`:
  it is compiled once, so the layers' ticks after it no longer line up. An
  infinite jump (the song loop) is fine on one layer; on more than one it is
  not reconciled (`W_PRIO_LAYER_FLOW`).

```lisp
(fm1 :prio 1 :len 4   c _ _ g _ _)                 ; lead — always sounds
(fm1 :prio 5 :len 16  e e e e e e e e e e e e)    ; filler — yields
```

The flattened output is one track per channel; player and driver are
unaffected by layering.

---

## 2. Channels

| Name            | Hardware                | Notes                                             |
| --------------- | ----------------------- | ------------------------------------------------- |
| `fm1`–`fm5`     | YM2612 FM channels      |                                                   |
| `fm6`           | YM2612 FM               | FM only; PCM is `pcm1`–`pcm3`. A score that plays PCM owns fm6 as the DAC, so an `fm6` track in it is `E_FM6_DAC` (§16) |
| `fm3`           | YM2612 FM3, normal mode | Note-less `(fm3 voice)` declares the shared patch for independent-OP mode |
| `fm3-1`–`fm3-4` | FM3 independent-OP mode | One track per operator F-number; presence enables the mode (`FM3_MODE op`) |
| `fm3-csm`       | FM3 CSM mode            | Tonal center; standard note syntax                |
| `fm3-csm-rate`  | FM3 CSM Timer A         | Buzz frequency as notes / raw Hz                  |
| `sqr1`–`sqr3`   | SN76489 square channels |                                                   |
| `noise`         | SN76489 noise channel   | Modes `white0`–`white3`, `periodic0`–`periodic3`  |
| `pcm1`–`pcm3`   | PCM on the fm6 DAC      | Sample symbol is the first positional argument    |

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

`~` follows the loop's control flow, not the text order. A `~` ending a loop
body connects to the body's first note on the passes that loop back, and one
before `(go label)` to the label's first note — when that note is a tie
continuation (`c ~ #loop (x 2 c2 …`), the tail is tied into it. With a `(break)`
the last pass leaves from the break, so the note after the loop connects to
the note before the `(break)` (a `~` on the body's tail does not reach it).

The left note of a slur always sounds its **full slot**: its gate (`:gate`,
`:gate*`, `:gate-`) is ignored, so it never keys off before the connection (a
hold, gate 0, stays a hold). The right note keeps its own gate — end a slurred
run staccato and only the last note is cut. Slur/legato is an **FM/PSG** feature (the macro/keying
model of channels 0–9); on other channels a different-pitch `~` is treated as a
normal note. Encoded as `NOTE_ON_EX` bit3 (opcodes.md §5.1).

### Tuplets — `(t …)`

`(t elem …)` divides **one** current `:len` slot among its elements
(Bresenham distribution, so remainders spread evenly):

```lisp
(fm1 :len 4
  c (t e g a) f     ; triplet inside one quarter
  (t c _ c))       ; rests allowed
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
| `Nf`  | N frames (1/60 s on NTSC); context-dependent (see below) | —           |
| `Nms` | N milliseconds, absolute and tempo-independent         | `125ms` → 24 at 120 BPM |
| `0`   | Hold: KEY-ON without advancing / without KEY-OFF (§17) | 0             |

Accepted wherever a length appears: `:len`, note/rest suffix, `:gate`,
`:gate-`, curve `:len`, macro `:step`, `(wait N)`, `(glide T)`,
`(delay … :time T)`, `:shuffle-base`.

A **computed** length is also allowed at `:len`, `:gate`, and a note's second
argument (§7.4): a bare expression is a denominator like a literal number
(`(+ 2 2)` ≡ `4`), and `(ticks expr)` / `(frames expr)` give an explicit unit.

`Nf` is a true frame count — scheduled per frame, tempo-independent — in
curve `:len`, macro `:step`, a `(wait Nf)` stage, and `def-val :unit frame`
slots (the player runs these off its own frame clock). **It stays a frame count
on PAL:** `30f` is thirty refreshes on either standard, and so lasts 20% longer
at 50 Hz. A frame count is a hardware quantity — an LFO's update rate, an
attack's write budget — and rescaling it would make it something else. What
does keep its wall-clock length on PAL is everything written in musical time
(driver.md §3.3). `Nms` has no such
special context: it is a duration, converted to ticks at the tempo in force,
and it is the only token finer than a tick (5.2 ms at 120 BPM). The PCM loop
points (§16) are the one place it is not rounded to ticks at all — they take
their value in seconds, so `1ms` reaches the engine's own floor.

In **structural** contexts that advance the musical timeline — note length,
`:gate`, `~` (tie), rests, `(glide T)`, and `(delay … :time T)` — `Nf` is
converted to ticks at the tempo active at compile time — on the target
standard's clock, so `c16f` is sixteen frames there too. So `c16f` lasts
16/60 s on NTSC at the tempo it was authored under; a mid-track `:tempo` change before the note
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

### The head: `:prio`

`:prio` is the one head option. It picks the layer the form belongs to (§1), so
it must come right after the channel name (after a `pcm` track's sample, §16);
anywhere else it is `E_UNKNOWN_KEYWORD`, and a value that is not a
non-negative integer is `E_PRIO_INVALID`. Everything after it is body — `:oct`,
`:len`, `:shuffle` and the rest at the start of a form are ordinary body
keywords at the form's first tick.

### Body keywords

| Keyword    | Value                     | Effect                                                   |
| ---------- | ------------------------- | -------------------------------------------------------- |
| `:oct`     | integer ≥ 0               | Octave (also `:oct+` / `:oct*`, §7)                      |
| `:len`     | length token              | Default note length; `0` = hold, no timeline advance     |
| `:gate`    | length token              | Absolute sounding time per slot; `0` = hold until runtime KEY-OFF |
| `:gate*`   | ratio `0.0`–`1.0`         | Gate as a fraction of the note length (`1.0` = full; above 0 it keeps at least one tick) |
| `:gate-`   | length token              | Gate = note length minus this time; a note no longer than it is not cut (full gate) |
| `:vel`     | 0–15                      | Note-on velocity (also `:vel+` / `:vel*`)                |
| `:vol`     | 0–31 or curve             | Channel fader → `PARAM_SET` / `PARAM_SWEEP`              |
| `:master`  | 0–31 or curve             | Global fader → `PARAM_SET` / `PARAM_SWEEP`               |
| `:tempo`   | number > 0 or curve       | Global: `TEMPO_SET` / `TEMPO_SWEEP` at this tick (0 or less: `E_TEMPO_INVALID`) |
| `:pan`     | `left`/`center`/`right`, −1/0/1, curve, `none` | FM stereo bits            |
| `:mode`    | symbol                    | `pcm1`–`pcm3`: `shot`/`loop`; `noise`: `white0`–`white3`/`periodic0`–`periodic3` (both sticky) |
| `:sample`  | sample def name           | Re-bind the PCM sample (PCM-active tracks)               |
| `:csm-rate`| Hz or curve               | Timer A rate (`fm3-csm` only, §15)                       |
| `:shuffle` | 51–90 or `none`           | Swing ratio (§5.2)                                       |
| `:shuffle-base` | length token         | The swung length (default: eighth, §5.2)                 |
| hardware params | value / curve / `none` / `$slot` | `:alg :fb :ams :fms :lfo-rate :tl1`–`:tl4` `:ar :dr :sr :rr :sl :ml :dt :ks :ssg :am`(1–4) — §5.1 |

The gate family decides how *short* a note is inside its slot, never whether
the next note attacks: **a note keys off at its gate even when that gate fills
the slot**, so the note after it always re-attacks. The one thing that carries a
note into the next is `~` (§3.1). This is what FM needs — the key-off → key-on
transition is the envelope's attack — and it costs nothing on PSG or PCM, which
re-assert attenuation / restart the sample on every note-on anyway.

The relative gates (`:gate*` / `:gate-`) resolve against the **whole tied note**,
not just its first segment: for `c4 ~ c8` with `:gate- 1f` the key-off lands one
frame before the tied end, so the tie stays connected. Absolute `:gate N` is
unaffected by ties.

`:tempo N` reanchors the timeline instantly; `:tempo (linear :from A :to B
:len L)` emits `TEMPO_SWEEP` over `L` (any non-`const` curve name works —
there is no curve literally named `curve`). Tempo changes apply to all tracks.
Written in a track's leading position it sets the song's initial tempo (§1).
`:tempo`/`:master` are global, so if two tracks write one at the same
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
| `:tl1 (+ $a (* $b 2))` | opcode chain            | Runtime `$slot` expression (§7.1.2) |

The value is read the same way in every row: a literal, a `let` name, an
expression (§7.1), a curve, or anything carrying a `$` reference. An operator
reads the parameter itself — `:tl1+ e` is `(+ $tl1 e)` and `:tl1* e` is
`(* $tl1 e)` (§7.1.2) — so `:tl1+ (+ 2 3)` and a `let` name work, and a
shape with no opcode (`:tl1* -1`, `:tl1+ (* $x 2)`) is `E_EVAL_NOT_LOWERABLE`.
A curve has no operator form (`E_EVAL_TYPE`), and a bare word the parameter
does not name (`:tl1 foo`) is `E_PARAM_VALUE`. `:vol` and `:master` are
parameters like any other; values are clamped to the register's range where
they are written, not in the IR.

The read-modify-write forms (`+` / `*` / self-ref) work on **every** FM
op-param (AR/DR/SR/RR/SL/KS/ML/DT/SSG/AMEN), not just level/TL — the base is
read live from the register shadow.

`(param-set :target v :target v …)` batches absolute integer writes
(`E_UNSUPPORTED_TARGET` for unknown targets).

An inline `:keyword` that is neither a known directive nor a hardware param
target (a typo, or the head option `:prio` used mid-body) is rejected
with `E_UNKNOWN_KEYWORD` rather than silently dropped.

### 5.2 Shuffle

`:shuffle R` (51–90; `none` = straight) swings note/rest pairs whose nominal
length equals `:shuffle-base` (default: eighth). The pair spans 2× the base;
the first beat takes `R` % of it. Each track sets its own swing, anywhere in
the body; a change restarts the pairing, so the next swung note is a first
beat. A value that is neither a number nor `none` is `E_SHUFFLE_INVALID`.

```lisp
(sqr1 :shuffle 66 :len 8  c c c c)
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

`:tl1`–`:tl4` set that **voiced** level, not the register: a `:tl` written
mid-song keeps whatever `vel`/`vol`/`master` the channel is already playing at
— it re-voices the timbre, it does not reset the mix. The same holds when a
patch is swapped as a whole (a voice name mid-track). A modulator's `:tl` is
not a level but modulation depth, so on a normal channel only the current
algorithm's carriers compose; CH3's operators in special mode each carry their
own level and all four compose (§15).

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

## 7. Operators and expressions

### 7.0 Operator suffixes (`+` / `*`)

One rule across the language: a trailing operator on a target keyword combines
the value with the target's base. No suffix = absolute, `+` = add, `*` =
multiply. There is no `-` / `/` — subtract with a negative (`:vel+ -2`),
divide with a fraction (`:vel* 0.5`).

| Context             | Absolute    | Add           | Multiply       | Resolution   |
| ------------------- | ----------- | ------------- | -------------- | ------------ |
| inline vel / oct    | `:vel 12`   | `:vel+ 2`     | `:vel* 0.5`    | compile time |
| inline other params | `:tl1 30`   | `:tl1+ 5`     | `:tl1* 0.5`    | runtime `PARAM_ADD` / `PARAM_MUL` |
| macro `:vel`        | `:vel [..]` | `:vel+ [..]`  | `:vel* [..]`   | per note-on (baked) |
| macro `:pitch`/`:semi` | `:pitch [..]` | `:pitch+ [..]` | —          | per frame (additive over live offset) |
| echo / delay        | —           | `:vel+`       | `:vel*`        | compile time |

- `vel`/`oct` have a compile-time base in the track state, so the IR carries
  plain absolute values.
- Inline hardware params (`:tl1+`, `:ar1*`, …) are runtime read-modify-write on
  the register's live value — every FM op-param, not just level/TL. A full
  `$slot` expression (`:tl1 (+ $a (* $b 2))`) lowers to a param-opcode chain;
  see §7.1.2.
- In macros, `*` applies only to `:vel`. `+` applies to `:vel`, `:pitch`, and
  `:semi`; any other target (or `*` on `:pitch`/`:semi`) raises
  `E_MACRO_OP_NO_BASE`. `:vel*` scales the macro by the note's 0–1 vel ratio and
  `:vel+` offsets it by the note's vel — both baked per note-on. `:pitch+` /
  `:semi+` are **additive**: each frame writes `note + (live pitch offset +
  macro sample)`, so a static `:pitch N` plus a shared vibrato macro wobbles
  centered at `+N` cents (e.g. two voices sharing one LFO but detuned by their
  own `:pitch` → chorus). Plain `:pitch` / `:semi` (no `+`) still **override**
  the offset. The additive offset is read live, so the macro rides a running
  pitch sweep.
- **Scaled macros — the interactive depth knob.** A macro value of the form
  `(* <signal> $slot)` (an LFO/curve times a value slot, in either order)
  multiplies each frame's sample by the slot, read **live every frame**:
  `write((sample × depth) >> 8)`. The slot is a 0..255 depth (its low byte;
  255 ≈ full, 0 = off), so the game scales a vibrato/tremolo in real time:

  ```lisp
  (def-val depth 128 0..255)
  (fm1 (macro :pitch (* (sin -40..40 :rate 6 :len 4f) $depth)) c e g) ; live vibrato depth
  (fm2 (macro :tl1 (* (triangle 0..40 :len 8f) $depth)) c e g) ; live tremolo
  ```

  Works on any macro target (the scale applies before the target write). The
  operand must be a signal — `(* 2 $depth)` (scalar × slot) is `E_EVAL_TYPE`;
  a bare `$slot` in a plain arithmetic macro value stays
  `E_EVAL_NOT_LOWERABLE`. Scaling is orthogonal to `+` (additive): the MVP
  covers `(* signal $slot)` only, and it combines with `:pitch+` — the scaled
  signal is added to the note's own pitch offset.
- Echo/delay taps are always relative, so an operator is **required**: bare
  `:vel` raises `E_ECHO_OP_REQUIRED` / `E_DELAY_OP_REQUIRED` (the clear forms
  `(delay none)` / `(delay :vel none)` excepted).

### 7.1 Compile-time expressions

A `()` form whose head is an arithmetic or math builtin is **evaluated at
compile time** and folds to a static value — zero runtime cost. Heads:

| Head | Arity | Notes |
| ---- | ----- | ----- |
| `+` `*` | 0+ | variadic; `(+)` = 0, `(*)` = 1 |
| `-` | 1+ | `(- x)` negates; `(- a b c)` = `a − b − c` |
| `/` | 1+ | `(/ x)` = `1/x`; `/` by zero → `E_EVAL_DIV_ZERO` |
| `min` `max` | 1+ | scalar only |
| `abs` `round` `floor` | 1 | scalar only |

Operands are numbers, nested expressions, and `let`-bound names (§7.2).
Floats flow through a computation; integerization happens only where the value
binds (the target's own round/clamp). A note/length token as an operand is
`E_EVAL_OPERAND` (no implicit note→number). Nesting deeper than 32 →
`E_EVAL_DEPTH`; wrong argument count → `E_EVAL_ARITY`.

Expressions are accepted in **value positions**: an inline param write
(`:tl1 (+ 20 10)`), a `(param-set …)` value, and inside `let` / `note` /
`(ticks …)` / `(frames …)`.

```lisp
(fm1 :tl1 (+ 20 10)              ; = :tl1 30
     :fb  (min 7 (round 5.4))    ; = :fb 5
     c e g)
```

Track-header options are not evaluated (write the expression in the body, not
the head).

### 7.1.1 Arithmetic on curves

A curve (§11) is a value too, so arithmetic composes with it:

- **Scalar ± / × a curve stays a symbolic curve** (affine, no cost).
  `(+ (sin :from -40 :to 40 :len 8) 10)` is byte-identical to
  `(sin :from -30 :to 50 :len 8)`; `(* (sin :from -1 :to 1 :len 8) 40)` scales a
  normalized shape to ±40. `(- 40 curve)` flips and offsets. Non-affine
  (scalar ÷ curve, or `min`/`max`/`abs`/… on a curve) → `E_EVAL_SIGNAL_NONAFFINE`.
- **Two curves combined** (`(* a b)`, `(+ a b)`) are **materialized** — sampled
  point-by-point into a baked step vector at compile time. MVP scope: frame-based
  `:len` (`Nf`) on both, in a **macro** value only (an inline sweep cannot carry
  a step vector → `E_EVAL_SIGNAL_SHAPE`). The two must be the **same region
  kind** — both looping (`sin`/`saw`/… and the stochastic curves) or both
  one-shot (`linear`/easings); mixing them, a tick `:len`, a `:wait` prefix, or a
  combined loop period over 255 steps each raise a specific `E_EVAL_SIGNAL_*`
  error. (Loop⊕one-shot — the classic `env × lfo` AM — is a later relaxation.)

```lisp
(fm1 (macro :pitch (* (sin :from -1 :to 1 :rate 6 :len 4f) 40))  ; ±40¢ vibrato
     (macro :tl1 (* (sin :from 8 :to 0 :len 8f)
                    (sin :from 1 :to 0 :rate 4 :len 8f)))         ; two LFOs, baked
     c e g)
```

### 7.1.2 Runtime value expressions (`$slot`) — the value machine

A `$slot` (§8) makes an expression **runtime-valued**. In a hardware-param
value position, such an expression lowers to a short chain of param opcodes
with **the parameter itself as the accumulator** — no new opcodes, evaluated on
the driver each time the write fires:

```lisp
(def-val tension 0 0..100)
(fm1 brass
     :tl1 (+ 40 (* $tension 2))    ; FROM_VAL $tension → MUL 2 → ADD 40
     :ar1 (+ $ar1 5)               ; self-ref: read AR1's live value, +5
     c e g)
```

- **Seed**: a constant → `PARAM_SET`; a `$slot` → `PARAM_FROM_VAL`; a self-ref
  `$<param>` (naming the target being written) starts from the param's current
  value (read live — works on **every** FM op-param via the generic shadow
  read, not just level/TL).
- **Terms**: `+ const` → `PARAM_ADD`; `+ $slot` → `PARAM_ADD` (slot); `× const`
  → `PARAM_MUL`; `× $slot` → `PARAM_MUL` (slot). Constant sub-trees fold first
  (any builtin or `let` name), and a variadic `(+ a b c)` chains as
  `(+ (+ a b) c)`.

Not every shape lowers to this accumulator form (`E_EVAL_NOT_LOWERABLE`, the
honest list): subtract-from / divide-by a slot and subtracting a slot (no
`SUB_VAL` opcode — invert the slot's range instead); a product or sum of **two**
runtime sub-expressions (needs a scratch slot — not built yet); multiply by a
negative constant (`PARAM_MUL` is unsigned); and `× $slot` on an i16 target
(`NOTE_PITCH` / `TEMPO_SCALE`). A chain over ~6 register writes warns
`W_EVAL_CHAIN_LONG` — each op writes the register (intermediate values reach the
chip within the same frame; a later batched flush collapses them).

### 7.2 `let` — local bindings

`(let ((name value) …) body…)` binds names for its body — sequential
(`let*`: later bindings see earlier ones), lexically scoped, nestable.

```lisp
(fm1 :len 8
  (let ((root 60))                       ; a value, not a phrase
    (note root) (note (+ root 4)) (note (+ root 7)))   ; c e g
  (let ((amp 40))
    (macro :pitch (* (sin :from -1 :to 1 :len 4f) amp))))
```

- **Item position** (in the note stream): the body compiles in place — sticky
  state changes inside behave as if unwrapped.
- **Value position**: the body is one expression (`:tl1 (let ((x 30)) (+ x 5))`);
  a bare bound name is also a value (`:vel v`).
- **Bindable**: numbers and curves (a phrase/stream cannot be bound — use a
  `def`, §9).
- **Names** must not be note/length tokens (so single letters `a`–`g`, `_`,
  `>`, `4t`, `v+` … are rejected — `E_LET_NAME`) and must not shadow a def
  (`E_LET_SHADOWS_DEF`). Use multi-letter words (`root`, `amp`, `base`).

`let` vs `def` (§9): `def` is **global token substitution** (a phrase, voice, or
file-wide constant, expanded verbatim); `let` is a **local evaluated value**
scoped to its body.

### 7.3 `(note …)` — computed pitches

`(note expr [length])` evaluates `expr` to a MIDI number (C4 = 60) and emits one
note, behaving exactly like a literal note (ties, glide, shuffle, PCM, macros).
The optional length is any length token (`4`, `24t`, `20f`, `1/2`), a
`(ticks …)` / `(frames …)` bridge, or a bare expression (§7.4). Out of MIDI
range 0–127 → `E_NOTE_RANGE`.

```lisp
(fm1 :len 8 (note 60) (note (+ 60 7)) (note (* 12 6)))   ; c4 g4 c6
```

### 7.4 Lengths from expressions — `ticks` / `frames`

In a length position (`:len`, `:gate`, a note's second argument) a **bare
number is a note denominator** — and a computed number is the same:
`(+ 2 2)` ≡ `4` ≡ a quarter note; `(* 2 4)` ≡ `8` ≡ an eighth. For an absolute
duration wrap the unit explicitly:

- `(ticks expr)` — `expr` rounded, in ticks.
- `(frames expr)` — `expr` rounded, in 60 Hz frames (converted to ticks at the
  authoring tempo, §4). For a literal count the `Nt` / `Nf` suffix is shorter
  (`24t`, `20f`); the form is for computed counts (`(frames (* base 2))`).

---

## 8. Dynamic values — `(def-val …)`, `$name`

Runtime values for interactive playback. The host writes slots; the score
reads them — directly (`:tl1 $level`), as an operator operand (`:tl2+ $level`),
or combined in a runtime value expression (`:tl1 (+ 40 (* $tension 2))`) that
lowers to a param-opcode chain on the driver (§7.1.2).

```lisp
(def-val level 20 0..40 :step 2)
(def-val depth 30)

(fm1 :tl1 $level               ; PARAM_FROM_VAL
     :tl2+ $level              ; PARAM_ADD (slot-relative)
     :vol* $level              ; PARAM_MUL
     :ar1 $time                ; built-in source
     (macro :pitch (sin :from -40 :to $depth :rate 2))
     c e g e)
```

`(def-val name init A..B :step S :unit U)` — or the explicit
`:from A :to B` form:

| Field      | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `init`     | Positional default (integer). Omitted → defaults to the range start |
| `A..B`     | Positional range sugar (§11) for the slider endpoints — the same `:from A :to B`, so `90..10` runs the slider downward |
| `:from` / `:to` | Order-free directional endpoints — the live slider runs from A to B (either direction, negatives fine). `:min` / `:max` are accepted synonyms |
| `:step`    | Slider granularity, integer > 0 (default `1`)                    |
| `:unit`    | `frame` (default) or `tick` — how the value is read when the slot feeds a curve `:len` |

Slots are indexed in declaration order and emitted in `metadata.vals` as
`{name, slot, init, min, max, step, reversed, unit}`. The live app renders one
Dynamic Parameters slider per slot. Names must not start with `$`
(`E_DEFVAL_NAME`); a non-integer `init` is `E_DEFVAL_INIT`, and an unknown or
malformed option (`:step 0`, `:unit beat`) is `E_DEFVAL_OPTION`.

- `$name` references a slot in a value or operator-operand position of a
  runtime parameter write (§5.1). `vel`/`oct` resolve at compile time — a
  number, a `let` name or an expression — so a `$` there, or a curve, is
  `E_VALUE_COMPILE_TIME`.
- `$time` is built in: elapsed 60 Hz frames since track start, read-only.
- An undefined `$name` raises `E_VAL_UNDEFINED`.
- A slot is a signed 16-bit integer, and that is its only bound: a host
  `setVal` is rounded and clamped to i16, and a non-finite write is ignored,
  leaving the slot as it was. `:from`/`:to` are the **slider's** endpoints,
  not a limit on the slot. A value is bounded where it is *used*, per target
  (`:tl1` 0–127, `:vol` 0–31, `:pan` −1..+1, …), by the same clamps MMLispDRV
  applies — so the preview and the driver agree on whatever a host writes, and
  nothing out of range can reach a register.
- `init` is kept as written. An init outside the slider's travel is
  `W_DEFVAL_INIT_RANGE` — the score and its control disagree, which is worth
  saying where it was authored rather than folding in at playback. An init
  that cannot fit a 16-bit slot is `E_DEFVAL_INIT`.

**Dynamic curve parameters.** A `$name` may feed a curve's `:from`, `:to`,
`:rate`, or `:len`. The slot is read **once at note-on** (the note-on sampling
tier), so the value is constant for that note. `:len` uses the slot's
`def-val :unit` to pick frame/tick interpretation. The macro `:step` clock is
static. The curve spec records these in a `dyn` map the player resolves at
schedule time.

On the MMB driver, an **inline sweep's `:from`/`:to`** are fully slot-fed:
the driver reads the slot when the sweep dispatches (PARAM_SWEEP flags, so a
game-controlled `def-val` moves the swell target in real time). Slot-fed
**macro-curve** params and sweep `:rate`/`:len` are not yet lowered — those bake
to the slot init on MMB (`W_MMB_MACRO_SKIPPED` / `W_MMB_DYN_SWEEP_BAKED`),
matching the live player only when the slot stays at its init.

---

## 9. `def` forms

`def` names any inline-writable notation; a bare reference in a channel body
expands or applies it. Definitions are top-level forms and interleave freely
with track forms (§1). `title` and `author` are reserved for file metadata
when given a string, and `pcm-voices` for the PCM voice count (§1). A def (or parametric def) named after an eval builtin
(`+`, `-`, `*`, `/`, `min`, `max`, `abs`, `round`, `floor`, `let`, `note`,
`ticks`, `frames`) is rejected with `E_DEF_RESERVED`.

`def` vs `let` (§7.2): a `def` is a **global** name bound by **token
substitution** — the body is spliced verbatim wherever the name appears, so it
can name a phrase (`(def riff c e g)`), a voice, a sample, or a file-wide
constant (`(def depth 40)`, usable inside expressions). A `let` is a **local**,
**evaluated** value scoped to one body.

| Form                                  | Kind                                    |
| ------------------------------------- | --------------------------------------- |
| `(def name item…)`                    | Snippet — inline expansion at the reference (snippets within snippets ≤ 16 deep, else `E_DEF_RECURSION`) |
| `(def (name param…) item…)`           | Parametric snippet — call as `(name arg…)`; each `arg` node is substituted for its `param` in the body (§9.1) |
| `(def name :alg … :tl1 … …)`          | FM voice, keyword map                   |
| `(def name :extend base :tl1 … …)`    | FM voice inheriting `base` (child keys override; unknown/non-voice base is `E_EXTENDS_BASE_UNKNOWN`, cycles `E_EXTENDS_CYCLE`) |
| `(def name :sample :file "…" …)`      | PCM sample (§16)                        |
| `(def name :extend sample …)`         | PCM sample inheriting a sample def (§16) |
| `(def name (macro :target spec …))`   | Macro preset — single or multi target   |
| `(def name (macro :target none))`     | Clear-def — applying it clears that target's macro |

An FM voice def is recognized by its first keyword being one of the
`:alg`/`:fb`/`:ar*`/`:tl*`/`:dr*`/`:sr*`/`:rr*` families (or `:extend`).
Unset operator parameters are not emitted — start from a full patch (or
`:extend` one) for deterministic timbres. The built-in voice `init-fm`
(ALG 7, AR 31, RR 15, ML 1, TL 0 on all operators) is always available:

```lisp
(def lead :extend init-fm
  :alg 4 :fb 3
  :tl1 30 :tl2 0 :tl3 30 :tl4 0)

(fm1 lead c e g e)
```

Voice names are plain identifiers — no special prefix (voices are recognized by
their keyword content, not a sigil). The mucom importer, whose voice names are
machine-generated, prefixes them with `@` (e.g. `@1`, `@brass`) purely as a
name-mangling safety measure — a numeric mucom voice id would otherwise be a
length token, and a name colliding with a note token could not be referenced.
That `@` is an importer-output detail, not part of hand-written voice notation.

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
(def (beat n) (x 8 > n < n))        ; one bar of n, octave-bounced ×8

(fm1 :oct 1
  (beat c) (beat b-) (beat a) (beat f))
```

### 9.2 `import` — reuse defs across files

`(import "path")` folds another file's **defs** into this file at compile time.
It is the way to share a voice bank, a macro set, or a snippet library between
scores. Import resolves entirely at compile time and bakes into the IR — there
is no runtime dependency, exactly as if the imported defs had been written
inline.

```lisp
(import "voices-lib.mmlisp")     ; a defs-only library file

(fm1 lead vib c e g e)           ; lead / vib come from the library
```

- **Path** is a string literal (bare atoms are `E_IMPORT_PATH`), resolved
  relative to the importing file — through the opened source folder (File >
  Open Folder…), like a PCM `:file` (§16); a served or URL score resolves it
  from the server root. A path that cannot be read is `E_IMPORT_NOT_FOUND`.
- **What is imported**: the four def namespaces — plain and parametric snippets
  (`def`), FM voices, macro presets, and PCM sample defs. Imports are
  transitive (an imported file may itself `import`). An imported sample def
  keeps its own base directory, so its `:file` reads from the imported file's
  folder, not the score's (§16).
- **What is not imported**: `def-val` slots and track/other forms. A slot's
  index is the importing file's host-visible layout, and tracks are songs, not
  a library, so both are ignored with a `W_IMPORT_IGNORED` warning. Import
  folds defs only.
- **`:effect`**: `(import "path" :effect [...])` puts one effect chain (§16)
  on every sample the import brings in — a whole kit processed at once. It
  runs **before** each def's own `:effect`, so the kit is evened out first and
  a sound's own adjustment lands on top (a per-sound `gain` survives a
  kit-wide `normalize`). Nested imports stack outermost first. Other defs are
  untouched.
- **Collision policy**: imported defs are overridable **defaults** — a local
  `def` of the same name **wins** silently (so you can import a bank and tweak
  one patch inline). Two different imported files defining the same name is an
  error (`E_IMPORT_CONFLICT`); a diamond (two imports pulling in the same third
  file) dedups and is fine. An import cycle is `E_IMPORT_CYCLE`.

**Drag & drop in the live editor.** ⇧Shift-dropping a `.mmlisp` onto the window
inserts its `(import "…")` line at the cursor rather than opening the file; a
plain drop opens it. The path written is folder-relative when the file comes out
of the opened source folder, and the bare file name otherwise — in which case
the editor holds the file's text in memory so the score compiles at once, and
warns that it must be moved next to the score to survive a reload. Drop rules
are the same as for samples, below.

This is the first increment of a fuller import/patch system (presets via
`:from`, version pinning); the `(import "path")` surface stays as it grows.

---

## 10. Macros — `(macro …)`

Macros are KEY-ON scoped: each `NOTE_ON` snapshots the track's active macros
and runs them for that note. Setting a macro is sticky until cleared.

```lisp
(def pluck (macro :vel [15 12 8 4 0]))

(fm1 pluck c                                ; bare def name
     (macro :vel [15 10 5 0]) c             ; inline anonymous
     (macro pluck :pan [left center right]) c   ; mix named + inline
     (macro :vel none) c                    ; clear one target
     (macro none) c)                       ; clear all
```

If the same target is set twice, the last one wins.

### Targets

| Keyword    | IR target    | Range        | Notes                                  |
| ---------- | ------------ | ------------ | -------------------------------------- |
| `:vel`     | `VEL`        | 0–15         | Accepts `+` and `*` (§7)               |
| `:pitch`   | `NOTE_PITCH` | ±32768 cents | Continuous pitch offset, no retrigger; `:pitch+` is additive over the live offset (§7) |
| `:semi`    | `NOTE_SEMI`  | ±48          | Semitone steps (×100 cents), no retrigger — chiptune arpeggio; `:semi+` additive (§7) |
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
| `:dt` (1–4) | `FM_DT`     | −3–+3        | Signed detune. The chip field is sign-magnitude (0–3 = 0,+1,+2,+3 / 4–7 = −0,−1,−2,−3); the encoder maps it, so 4–7 are not input values |
| `:ks` (1–4) | `FM_KS`     | 0–3          |                                        |
| `:ssg` (1–4) | `FM_SSG`   | 0–15         |                                        |
| `:am` (1–4) | `FM_AMEN`   | 0–1          |                                        |

Out-of-range step values are clamped to the target's range (relative `+`/`*`
macros stay unclamped until combined with the base).

### Spec forms

| Form                        | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `[v v v …]`                 | Step vector — one value per `:step`. A value is a number (rounded where it binds) or the target's symbol (`left`, `white2`); anything else is `E_MACRO_VALUE_INVALID` |
| `[… :hold …]`               | `:hold` marks the loop point: steps from it cycle until key-off |
| `[… :off …]`                | `:off` marks the release section: steps after it run after key-off |
| `_` (inside a vector)       | Hold: advance one step, no write                     |
| `(curve …)` (§11)           | Sampled every `:step`                                |
| `[(stage) (stage) …]`       | Multi-stage: curve / `(wait N)` / `(wait key-off)` stages run sequentially |
| scalar (e.g. `1`, `left`)   | Constant signal, equivalent to `[:hold v]`           |
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

(fm1 organ :len 2 c e)
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
(fm1 (macro [:tl1 :tl2 :tl3 :tl4] (linear :from 40 :to 0 :len 8)) c
     (macro [:tl1 :tl2] none) d)
```

### `:semi` and `:keyon`

`:semi` is the discrete counterpart of `:pitch` (semitones vs cents); neither
retriggers the envelope.

`:keyon` is sampled once per `:step`; a sampled value ≥ 0.5 fires a key-on
retrigger (key-off then key-on across the player's `KEY_OFF_LEAD` gap,
restarting the envelopes). The first sample at t = 0 coincides with the note's
own attack and is a no-op, so a roll starts at the second step whether it is
written `[0 :hold 1]` or `[1 1 1 …]`. Steps before `:off` loop until note-off (a roll);
steps after `:off` fire after note-off (a one-channel echo tail). While a
`:keyon` macro is active it owns the channel keying.

| Form                           | Result                                    |
| ------------------------------ | ----------------------------------------- |
| `:keyon 1`                     | Fire every `:step`                        |
| `:keyon 0`                     | Never fire (= omitting `:keyon`)          |
| `:keyon [1]`                   | Nothing — step 0 is the note's own attack |
| `:keyon [:hold 1 0]`           | Alternate steps                           |
| `:keyon (square 0..1 :duty 128 :len 8)` | Duty-gated regular retrigger (period: one 8th) |
| `:keyon (noise :from 0 :to 1 :len 1)` | Probabilistic retrigger (~50 % per step) |

```lisp
(fm1 (macro :step 32 :keyon 1) c)                            ; drum roll
(fm2 (macro :step 1/16 :semi [:hold 0 4 7] :keyon 1) c)      ; retriggered arp
(fm4 (macro :step 1/8 :keyon [0 :off 1 1 1]
            :vel   [15 :off 11 7 3]) c)                     ; echo tail
```

---

## 11. Curves

Curve forms appear in macros, inline parameter sweeps, `:tempo`, `:csm-rate`,
and `(delay …)`:

```text
(curve-name :from A :to B :len L …optional-params)
(curve-name A..B :len L …)        ; positional range sugar for :from/:to
(const V :len L)                  ; flat segment — positional value
```

`A..B` is shorthand for `:from A :to B` (signed decimals; `40..0` descends).
It works anywhere a curve does, including inside arithmetic
(`(* (sin -1..1 :len 8f) 40)`) and score `:tempo (linear 120..80 :len 4)`.
Combining it with an explicit `:from`/`:to`, or two ranges, is
`E_CURVE_RANGE_CONFLICT`; a `..`-token that is not a clean `A..B` is
`E_CURVE_RANGE_MALFORMED`.

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
literal word `curve`) is rejected with `E_EVAL_UNKNOWN_HEAD`, as any unknown
function is.

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
| all four  | `:seed`        | u32       | `0xDEAD`| RNG seed — a distinct sequence per seed (§11.1) |
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

### 11.1 Curves as values (`:seed`, arithmetic)

A curve is a first-class value: arithmetic composes with it — a scalar shift or
scale stays a symbolic curve, two curves multiply/add into a baked step vector.
See §7.1.1.

Stochastic curves (`noise`/`pink`/`perlin`/`brown`) default to seed `0xDEAD`, so
a seedless source is always byte-identical. `:seed N` (any u32) regenerates a
**statistically independent** sequence — unlike `:phase`, which shifts the same
table. The seed is compile-time only (the driver replays the sampled values);
distinct seeds bake distinct data.

```lisp
(sqr1 (macro :pitch (noise :from -60 :to 60 :len 4f :seed 1))  c c c c)
```

```lisp
(fm1 (macro :tl1 (brown :from 24 :to 34 :len 4 :rate 0.5 :hold 2 :leak 0.995))
  c e g e)
(sqr1 (macro :pitch (pink :from -40 :to 40 :len 8 :beta 1.2 :phase 32))
  c c c c)
(fm2 (macro :pan (perlin :from -1 :to 1 :len 16 :octaves 4 :persistence 0.6))
  c _ c _)
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
(fm1 c (echo :vel+ 3 :by -1)          ; vel−1, −2, −3 decaying trail
     c (echo :vel* 3 :by 0.7)         ; ×0.7, ×0.49, ×0.343
     c e (echo :vel+ 1 :by -4 :back 2))  ; replay the c once at vel−4
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
(fm1 (delay :vel+ 3 :by -4 :time 1/8)
  c e g e)                                     ; phrase + 3 decaying repeats
(fm2 :len 16 (delay :vel* (linear :from 0.8 :to 0 :len 4) :time 16)
  c _ _ _ _)                                   ; four fading repeats in the rests
```

---

## 13. Flow control

| Form           | IR                     | Meaning                                     |
| -------------- | ---------------------- | ------------------------------------------- |
| `#label`       | —                      | Position label: a compile-time jump target, no stream bytes (duplicate id = `E_MARKER_DUP`; empty = `E_LABEL_EMPTY`) |
| `(go label)`   | `JUMP {to}`            | Infinite loop back to `#label`              |
| `(go label N)` | `LOOP_BEGIN`/`LOOP_END`| The `#label`…`go` section plays N times, then falls through |
| `(x N body…)`  | `LOOP_BEGIN`/`LOOP_END`| Counted loop sugar                          |
| `(x body…)`    | `JUMP` (to a label)    | Infinite loop sugar                         |
| `(break)`      | `LOOP_BREAK`           | On the final pass of the enclosing counted loop, exit here |
| `(trig N)`     | `TRIG {code}`          | Music→game sync point: writes id `N` to the track's status byte (`E_TRIG_ARITY`, `E_TRIG_RANGE`) |

- `(go label N)` is rewritten post-merge into the same `LOOP_BEGIN`/`LOOP_END`
  as `(x N …)`, so the label and the `go` may live in different forms of the
  same channel. The `#label` must **precede** the counted `go` (a backward
  jump); a forward counted `(go label N)` is unsupported (`E_GO_FORWARD_COUNT`).
  Infinite `(go label)` may jump either direction.
- `go` arity: label plus optional positive count (`E_GO_NO_LABEL`,
  `E_GO_ARITY`, `E_GO_COUNT`). A `go` without a matching label is
  `E_JUMP_UNRESOLVED`. A label is a compile-time name: the jump is a resolved
  offset, so `#label` itself costs nothing at runtime and emits no bytes.
- `(break)` binds to the innermost counted loop, also from inside an infinite
  loop nested in it. With no counted loop around it there is no final pass to
  exit, so it does nothing and is dropped with `W_BREAK_OUTSIDE_LOOP`. It takes
  no arguments (`E_BREAK_ARITY`).
- **`(trig N)`** marks a position for the game to read. It emits the `TRIG`
  opcode with an explicit id `N` (0..63), and the sequencer writes the track's
  **status byte**: the id in bits 5-0 under a 2-bit firing counter in bits 7-6
  that runs 1→2→3→1 from 0 (opcodes.md §0x42). The game reads it with
  `MMLisp_trig(track_id)` and compares it with the byte it last saw — **any
  difference is a trigger**, including the same id firing again, which is what a
  cue inside a loop does. `0x00` means the track has not passed a trigger yet,
  so it never looks like `(trig 0)`. Within one frame the last trigger wins
  (cross-track never drops), and reading does not clear it. `(trig N)` is never
  a jump target, so it is exempt from label uniqueness. Auto-numbered `(trig)`
  is not yet supported — give an explicit id.
- **A loop replays baked notes; compile-time state does not accumulate.** The
  body is compiled **once**, so state the compiler resolves (octave `>`/`<`,
  `:oct`, `:vel`, `:len`, `:gate`, …) is baked into that single pass and does
  **not** carry from one iteration to the next. A register-relative write is
  different: `:tl1+ 2` is a runtime `PARAM_ADD`, so `(x 3 :tl1+ 2 c)` adds 2
  on every pass. `(x 4 c >)` plays `c c c c`, not an ascending run —
  the `>` shifts the octave only for whatever follows the loop. When a body has a
  non-zero net octave (or other sticky) change and is reused or followed by more
  notes, rebalance it explicitly, e.g. `(x 4 n > n <)`, so the state returns to
  where it started after each invocation.

```lisp
(fm1
  (x 4 c d e (break) f g)    ; body ×4; final pass stops before f g
  #verse
  c e g e
  (go verse 2)               ; the #verse section plays twice
  #head
  c g
  (go head))                ; infinite outer loop
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
(fm1 (glide 8) c e (glide f5 32) g (glide none) c)
```

---

## 15. FM3 modes and CSM

### Independent-operator mode

`fm3-1`–`fm3-4` each drive one operator's F-number as a monophonic track;
their presence enables the mode (`FM3_MODE op` at tick 0). The shared patch
(ALG, FB, per-op TL/ADSR) is declared with a note-less `(fm3 voice)` form.
Pitch is per operator: `:pitch`, `(glide …)`, an inline `:pitch (curve …)`
sweep and the `:pitch` / `:semi` macros on an `fm3-N` track bend that
operator's F-number alone, `:keyon` re-attacks that operator alone — the others
keep sounding — and `:vel`/`:vol` are that operator's own level. The `(fm3 …)`
track keeps `:vol` as the **group fader** over all four, and `:master` is
global as ever; the three compose on one dB ladder. The patch is the shared
channel's. On alg 7 (four operators in parallel) each `fm3-N` is a voice with
its own fader; on an algorithm where the operator modulates, its level is
modulation depth rather than volume.

```lisp
(def kit :extend init-fm :alg 7 :tl1 20 :tl2 30 :tl3 25 :tl4 0)

(fm3 kit)                     ; shared patch — no notes here
(fm3-1 :oct 5 :len 8  c c)
(fm3-2 :oct 3 :len 4  c _)
(fm3-3 :oct 4 :len 8  c c)
(fm3-4 :oct 2 :len 2  c _)
```

### CSM mode

`fm3-csm` carries the tonal center (standard note syntax and range): a note
sets where all four operators ring, each at the note times its own multiple,
which is heard as the formant. The sound itself comes only from Timer A —
each overflow re-attacks the operators and its rate is the pitch — so a
note's length neither starts nor stops it.
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
(def brass :extend init-fm :alg 4 :tl1 24 :tl3 24)

(fm3-csm brass :oct 4 :len 2
  c _ e _ g _)
(fm3-csm-rate :oct 6 :len 1
  c d e f  g a b 20000)    ; notes → Hz; raw Hz literal above oct 10
```

---

## 16. PCM

Samples are declared with `def :sample` and bound to a track as the first
positional argument (or re-bound mid-track with `:sample name` / a bare
sample symbol). How many voices play at once is a whole-song choice (§1):

```lisp
(def pcm-voices 3)
(def kick  :sample :file "sounds/kick.wav")
(def snare :sample :file "sounds/snare.wav" :rate 11025)
(def pad   :sample :file "sounds/pad.wav" :loop-start 300ms :loop-len 100ms)

(pcm1 kick :tempo 120  :len 4  c _ c _)
(pcm2 snare :len 4  _ c _ c)
(pcm3 pad :len 0 :vol 8 :mode loop  c)
```

### Voices and the rate

`pcm1`–`pcm3` are soft-mixed on the Z80 to the single fm6 DAC. The driver
carries one engine image per voice count, and the image is what sets the rate:

| `pcm-voices` | DAC rate | bank holds |
| --- | --- | --- |
| 1 | 14,375.7 Hz | 2.26 s |
| 2 | 10,111.7 Hz | 3.22 s |
| 3 | 6,653.4 Hz | 4.89 s |

The bank is one 32 KB window a song, and every note a sample is played at is
baked into it separately, so the seconds above are the total of all of them.
**Only what the score plays is baked.** A def the score never sounds — most of
a drum kit, every time you import one — declares a name and costs no bank
bytes, so importing a whole set is free until you write the note.
The voices are summed and **hard-clipped**: loud simultaneous hits distort by
design, and headroom is the composer's to manage with `:vel` / `:vol`.

A score that uses PCM owns fm6 as the DAC for the whole song — the driver
enables it once and never gives the channel back. An `fm6` track in such a
score is `E_FM6_DAC`; move the part to `fm1`–`fm5`, or drop the PCM. With
`pcm-voices 0` (or no PCM at all) `fm6` is an ordinary FM channel and the DAC
is never touched.

### Sample def keys

| Key           | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `:file`       | WAV path, relative to the source file. Required (`E_SAMPLE_FILE`). See *Sample paths in the live editor* below |
| `:rate`       | C4 playback rate in Hz (default: the WAV's native rate)        |
| `:offset`     | Start frame within the file (default 0). See *Sample banks*   |
| `:frames`     | Frame count (default: to the end of the file)                 |
| `:loop-start` / `:loop-end` / `:loop-len` | Sustain loop, as LENGTHS (see below) |
| `:effect`     | The processing chain, `[(effect …) …]` — see *Effects* below   |

All conversion is compile-time: stereo is downmixed `(L+R)/2`, the `:effect`
chain runs, and the data becomes raw 8-bit signed PCM.

### Sample banks (many samples in one file)

`:offset` / `:frames` cut one sample out of a file that holds several — a drum
kit in a single wav, or an imported instrument bank. Both count **frames**, not
bytes, and a negative `:offset` or a non-positive `:frames` is `E_SAMPLE_SLICE`.

```lisp
(def kick  :sample :file "kit.wav" :offset 0    :frames 3904)
(def snare :sample :file "kit.wav" :offset 3904 :frames 6400)

(pcm1 :len 8  kick c snare c  kick c c)
```

The file is decoded once and shared by every def that slices it, so a bank costs
no more than a single sample would. `:loop-start` / `:loop-end` are **relative to
the slice**, not to the file — a def is one sample, so its loop points don't move
when `:offset` changes.

**A relative `:file` resolves against the file that defined it** — the score for
a def written there, and the imported file for one folded in by `import` (§9.2).
So a preset set keeps its samples next to itself: `:file "wav/kick.wav"` inside
`presets/808/set.mmlisp` reads `presets/808/wav/kick.wav`, however deep the
score that imports it sits. Copying such a def into a score makes it the score's
own, so its path has to be rewritten to match.

**Sample paths in the live editor.** A relative `:file` resolves against the
score's folder, but a browser only hands the editor a *file* when you use
`File > Open` — it never reveals that file's directory, so a sibling wav cannot
be found (the compiler warns `W_SAMPLE_BASE_UNKNOWN`). Use **`File > Open
Folder…`** to open the score's folder instead: the wav next to the score then
loads, and paths into subfolders (`:file "sounds/kick.wav"`) work the same way.
The folder is **session-scoped** — a reload starts clean, so open it again
rather than have samples silently resolve against an earlier sitting's folder.

Opening a folder loads its first score (alphabetically) straight away; any
others are listed under **`File > Scores in Folder`** (a check marks the open
one), so switching between a project's scores is one click and keeps the
samples resolved.

Chrome refuses to grant access to well-known folders themselves (`Desktop`,
`Documents`, …, reported as "contains system files"), so keep a score in a
subfolder — `~/Desktop/mysong/` opens, `~/Desktop/` does not.

Without a folder, `:file` falls back to the dev server's root, so absolute
server paths (`/drv/tests/blip.wav`) and full URLs (CORS permitting) also work.

**Dropping a wav** writes its def at the cursor — `(def kick :sample :file "…")`,
no `:rate`, so the wav's own rate stands. A wav dragged out of the opened folder
gets the correct folder-relative path (`"sounds/kick.wav"`); one dragged from
anywhere else gets its bare name and is decoded into memory, so it plays at once
but needs to be moved next to the score (and the folder reopened) to survive a
reload. Only `.wav` is accepted: the browser would decode mp3/flac/ogg too, but
the exporters read RIFF WAV only, so those are refused with a message rather
than left to break at export time.

Full drop routing for every accepted format: `guide.md` §23.

### The loop

`:loop-start`, `:loop-end` and `:loop-len` say where a `loop` note repeats.
They take **lengths** — the same grammar as `:len` and `:gate` (§4), including
`Nms`, which is what you want when the point is a place in the wave rather than
a place in the bar. `:loop-end` and `:loop-len` both set the far bound — one
pins the end, the other the length, which differ once `:loop-start` moves (see
below) — and the last one written is the one in force.

They belong on a `def` and on a track, and they mean the same thing in both —
unlike `:offset` / `:frames`, which cut a sample out of a file and have nothing
to do with playback. On a def they set the sample's own sustain loop:

```lisp
(def pad :sample :file "pad.wav" :loop-start 300ms :loop-len 100ms)
```

On a track they set the loop of the notes that follow, like any track
parameter — laid over the def's, and kept until the next write — and they MOVE
it while a note sounds, as a literal or as a curve, a thing no other Mega
Drive driver offers:

```lisp
(pcm1 pad :mode loop :len 1
  :loop-start 300ms :loop-len 16                    c ; a 16th-note loop, head fixed
  :loop-len (linear :from 100ms :to 2ms :len 2)     c ; tighten it to a buzz
  :loop-len 100ms
  :loop-start (linear :from 100ms :to 900ms :len 2) c) ; slide it through the sample
```

A curve keeps its last value too: the second line ends at 2 ms, which is why
the third sets `:loop-len` again. `:loop-len` holds the length when
`:loop-start` moves — which is what the third line relies on. `:loop-end` pins the end instead, and then moving the
start changes the length. A curve's ends are lengths too, so write `:from` and
`:to` rather than the `A..B` range sugar (`8...4` would be unreadable).

Three limits worth knowing:

- **The engine rounds the loop to 16 bytes** — 1.11 ms at `pcm-voices 1`,
  1.58 at 2, 2.40 at 3. That is also the shortest loop there is, so the
  highest buzz `pcm1` reaches is about 900 Hz and the pitches below it are
  `14375.7 / 16n` Hz. **This is a rhythmic device, not a pitch one.**
- A note-off ends the loop: the voice plays its tail and parks. Loop writes
  after that do not move the tail; they are kept for the next loop note.
- **Frame of reference.** On a def the value is time in the sample's own
  recording, so a loop stays where you set it however the note transposes. On a
  track it is time as you HEAR it, so `:loop-len 16` is a 16th note at every
  pitch. At C4 the two coincide.

### Effects

A def's `:effect` takes a `[...]` of effects, applied **in order** to the
sample when it is baked. They are compile-time sample processing: the driver
never runs them, so they cost no Z80 time — only what they do to the bank
(a fade saves bytes). Use them to make a sample hold its own against FM:

```lisp
(def snare :sample :file "snare.wav"
  :effect [(comp :threshold -20 :ratio 4 :attack 0ms :release 60ms)
           (gain 8)
           (limit)
           (fade :at 120ms :len 80ms :curve ease-out-expo)])
```

Each effect is `(name :param value …)`; a param left out takes its default.
Levels are dB (plain numbers), times are lengths (§4 — `Nms` is the usual
choice, as for the loop points).

| Effect | Does |
| --- | --- |
| `gain` | Scales the level |
| `normalize` | Scales so the peak lands on `:peak` dBFS |
| `comp` | Compressor: above the threshold the level rises 1/`:ratio` as fast, over a soft knee `:knee` dB wide |
| `limit` | Brickwall limiter with a 2 ms lookahead: the peak never passes `:ceiling` dBFS |
| `crush` | Quantizes to N bits — the lo-fi step |
| `fade` | Fades to silence from `:at` over `:len` and **cuts the sample there** |

Parameters — a positional value fills the one marked *positional*
(`(gain 6)` is `(gain :db 6)`); anything outside a range is
`E_SAMPLE_FX_PARAM`:

| Effect | Param | Value | Range | Default |
| --- | --- | --- | --- | --- |
| `gain` | `:db` | dB | any | required, *positional* |
| `normalize` | `:peak` | dBFS | ≤ 0 | `0` |
| `comp` | `:threshold` | dBFS | ≤ 0 | `-18` |
| | `:ratio` | ratio (`4` = 4:1) | ≥ 1 | `4` |
| | `:attack` | length | ≥ 0 (`0ms` = instant) | `5ms` |
| | `:release` | length | ≥ 0 | `80ms` |
| | `:knee` | dB (width) | ≥ 0 (`0` = hard knee) | `6` |
| | `:makeup` | dB | any | `0` |
| `limit` | `:ceiling` | dBFS | ≤ 0 | `0` |
| | `:release` | length | ≥ 0 | `50ms` |
| `crush` | `:bits` | integer | 1–8 | required, *positional* |
| `fade` | `:len` | length | > 0 | required |
| | `:at` | length, from the sample's start | ≥ 0 | `:len` before the end |
| | `:curve` | a one-shot curve name (§11): `linear`, `ease-*` | not `const` or a looping curve | `linear` |

Numbers are plain decimals (`-18`, `1.5`); lengths are §4 lengths (`60ms`,
`16`, `4f`). The fade's gain is 1 − curve, so `ease-out-expo` drops fast and
tails off like a natural decay.

- **Nothing clips inside the chain.** The one hard clip is the 8-bit quantize
  at its end, so a `gain` that overshoots is caught by a later `limit` or
  `normalize` — or clips there, which `crush` aside is rarely the sound you
  want. `comp` takes level off; follow it with `gain` + `limit` (or
  `normalize`) to bring the loudness back up.
- **An instant attack for short hits.** With a slow `:attack` a drum's first
  milliseconds pass the compressor uncompressed, and a following `normalize`
  scales to that spike. `:attack 0ms`, or a `limit` in front of the
  `normalize`, is what a short sample needs.
- **Times are the sample's own time**, like the def's loop points: a sample
  played an octave up plays its fade in half the time.
- **A fade inside the loop** is baked into the bytes the loop repeats, so it
  warns (`W_SAMPLE_FX_FADE_LOOP`); a fade that runs past the sample's end
  warns `W_SAMPLE_FX_FADE_PAST_END`. A `loop` note on a def with no loop
  points loops the whole sample, fade included.
- **Loud samples overlap loud.** Voices are summed and hard-clipped (above),
  so a kit brought up to full scale distorts where hits overlap — trade that
  against `:vel` / `:vol`.
- **A kit, or a variant.** `(import "kit" :effect [...])` processes every
  sample of a kit (§9.2); its chain runs before each def's own.
  `(def snare-hot :extend snare :effect [...])` is a variant of one sound: it
  takes the base's `:file` (still read from the base's folder), slice, loop
  points and effects — the import's chain included — and overrides the keys it
  writes; its own `:effect` replaces the base's, the import's stays in front.
  A variant is a def of its own, so playing both bakes both.
- An unknown effect is `E_SAMPLE_FX_UNKNOWN`; a bad or unknown param, or a
  missing required one, is `E_SAMPLE_FX_PARAM`; `:effect` given anything but
  a `[...]` is `E_SAMPLE_FX`.

### Playback

- **Pitch is baked, not played.** A note picks a blob resampled for that note;
  the voice then plays it back one byte a sample and cannot bend. So there is
  no practical-range clamp — any note works, it just costs bank space. What is
  rejected is every RUNTIME pitch move on a pcm track: `:pitch`, `:semi`,
  `(glide …)` and a `(macro :pitch …)` vibrato are `E_PCM_NO_PITCH` rather
  than silently dropped.
- **`:mode`** is sticky track state like every other parameter — it holds
  until the next `:mode` — and it is the note, not the sample, that decides:
  `shot` (the default) plays start→end once, even on a sample whose def has
  loop points; `loop` plays the attack, cycles the loop until KEY-OFF (a
  `PCM_NOTE_OFF` at the gate), then plays the release tail. A `loop` note on a
  def with no loop points loops the whole sample. Write `:mode shot` to go
  back.
  > A `shot` plays to its end regardless of the note's `length` / `gate`;
  > only `loop` mode honors KEY-OFF.
- `:len 0` holds a loop open until runtime `KEY_OFF` / `STOP_TRACK` (§17).
- `:vel`, `:vol`, `:master` compose through the standard level stack (§6), but a
  PCM voice's resolution is COARSER than FM's or PSG's: the mixer attenuates by
  an arithmetic shift, so the ladder is 6 dB per step, not 2. `:vel` + `:vol`
  reach −24 dB and clamp there (deeper is quantisation noise at 8 bit);
  `:master` folds into the same ladder and reaches −36 dB before the voice
  mutes. So a PCM fade is stepped where an FM one is smooth, and it lands on
  silence from −36 dB rather than gliding there. That is the model, not a
  limitation to work around (driver.md §5). Automate `:vol` on FM or PSG when a
  fade has to be smooth.
- A PCM note without a bound sample is `E_PCM_SAMPLE_REQUIRED`; an unknown
  sample name is `E_PCM_SAMPLE_UNDEFINED`. `:mode shot`/`loop`, `:sample` and
  the loop points on any other channel (fm6 included — it is FM only) are
  `E_UNSUPPORTED_TARGET`.

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

A hold is the one place a following note does **not** re-attack on FM: the
channel is still keyed, so the next note moves the pitch and the envelope
carries on — `:gate 0 c e g` sounds like `c ~ e ~ g`, and reads as a sticky
legato passage. That is deliberate. The key-off belongs to the runtime here,
which is what the form is for, and unlike a full gate (§5) the hold is
something the score asked for in writing. A rest or `END_OF_TRACK` still ends
it, and on PSG every note-on re-asserts its attenuation, so PSG re-attacks
either way.

```lisp
(sqr1 :len 0 (macro :vel [15 :hold 14 13 :off 8 4 0])
  c)
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
(fm1 :oct 4 :len 8
  c c c c c c c c |
  c c c c c c c c |)   ; two 384-tick bars
```
