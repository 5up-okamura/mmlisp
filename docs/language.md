# MMLisp Language Reference

Describes the current MMLisp language (v0.7).

This is the canonical reference for the language as implemented by
`live/src/mmlisp2ir.js`. For a learning-ordered introduction, see
`docs/guide.md`; for the whole language on two pages, `docs/cheatsheet.md`.
IR event shapes are noted where they define observable
behavior; the full IR format lives in `docs/ir.md`.

---

## 1. Source model

**1 file = 1 score.** There is no wrapper form — the file *is* the score. A
source file is a sequence of top-level forms, in source order:

| Form              | Role                                             |
| ----------------- | ------------------------------------------------ |
| `(def name …)`    | Named definition (snippet, voice, sample, macro) |
| `(def-val name …)`| Runtime value slot declaration                   |
| `(def-score …)`   | The score's settings: title, composer, author, PCM voices, target |
| `(def-mod …)`     | Score-wide note modifier (§9.4)                  |
| `(import "…")`    | Fold another file's defs in at compile time (§9.2) |
| `(channel …)`     | Track form — any list whose head is a channel name (§2) |

- `;` starts a line comment.
- Strings use double quotes (`"…"`).
- `#name` atoms are labels (§13).
- `def`/`def-val` and track forms interleave freely; a def only needs to
  precede its first use. Any other top-level list head (usually a channel-name
  typo) is `E_UNKNOWN_TOPLEVEL_FORM`.

### Score settings and global options

```lisp
(def-score :title "Song" :composer "Me" :author "Me" :pcm-voices 2)

(fm1 :tempo 140 :lfo-rate 5 c e g e)
```

`(def-score …)` holds the settings the whole score has one of. Every key is
optional; several `def-score` forms combine, a key given twice is
`E_SCORE_OPTION`, and so is a key it does not know. An imported file's
`def-score` is not imported (§9.2) — the settings are the score's own.

- **`:title "…"` / `:composer "…"` / `:author "…"`** — the file metadata: who
  wrote the music and who wrote this score of it (an arrangement, a port). IR
  `metadata.title` / `composer` / `author` and the MMB metadata section carry
  all three; the VGM GD3 tag has one name, the composer (else the author).
- **`:pcm-voices N`** — how many PCM voices the driver plays, 0–3. This is
  a whole-song choice: it picks the engine image, and with it the DAC rate
  (1 voice 14.4 kHz, 2 voices 10.1 kHz, 3 voices 6.7 kHz; 0.9% lower on PAL) and how much sample
  data fits in a single bank (2.3 / 3.2 / 4.9 seconds). NTSC and PAL scores with one
  to three voices automatically use multi-bank PCM when needed, both at
  about 10.1/10.0 kHz for one or two voices and 6.65/6.59 kHz for three (NTSC/PAL); see [Multi-bank PCM](pcm-multibank.md). Fewer voices
  buy a higher rate, so state the number you actually need. Omitted, it is the
  highest `pcmN` track the score uses; a `pcmM` track above the stated number
  is `E_PCM_VOICES`, and a value outside 0–3 is the same error. See §16 and
  driver.md §5.
- **`:target md|pc88`** — the machine the score is for (§19). Default `md`,
  the Mega Drive; `pc88` is the PC-8801 with Sound Board II (YM2608). Any
  other value is `E_SCORE_OPTION`.
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
  `(go label N)` — on a layered channel is written out before the layers
  merge, so it plays as written (and costs its passes in the output).
- The channel has one endless loop (`#loop … (go loop)`, an `(x …)` without a
  count). Any layers may carry it, but they must start and end it at the same
  ticks — otherwise `E_PRIO_LAYER_LOOP`. Every layer's notes inside it repeat;
  notes past its end never play (`W_PRIO_LAYER_PAST_LOOP`).
- A note's `:vel`, `:gate` and macros travel with it; the voice, `:pan`,
  `:vol` and the other channel parameters are the channel's, one of each, so
  priority decides them too: a parameter a higher layer sets is its, and a
  lower layer's writes to it are dropped. One that no higher layer sets is the
  lower layer's to set — for every layer's notes.
- Where one physical channel has several names of different kinds (`pce`'s
  `wave5`, `noise5` and `pcm5`, §19), every name may be written, and their
  notes layer the same way across the names: a lower `:prio` first, and at an
  equal one the kinds' own order (DDA, then the noise, then the wave). The
  names stay tracks of their own, each with its own parameters; only their
  notes are dropped or cut, and their endless loops must agree.

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
| `fm3-csm`       | FM3 CSM mode            | Tonal center; standard note syntax. Note-less `(fm3-csm voice)` beside `fm3-1`–`fm3-4`: the shared patch of CSM with formant tracks (§15) |
| `fm3-csm-rate`  | FM3 CSM Timer A         | Buzz frequency as notes / raw Hz; with formant tracks, the voice itself |
| `sqr1`–`sqr3`   | SN76489 square channels |                                                   |
| `noise`         | SN76489 noise channel   | Modes `white0`–`white3`, `periodic0`–`periodic3`  |
| `pcm1`–`pcm3`   | PCM on the fm6 DAC      | A sample name in the body binds the sample (§16)  |

Mode exclusivity (compile errors, score-wide):

- `fm3-csm`/`fm3-csm-rate` cannot be mixed with `fm3` (`E_FM3_MODE_CONFLICT`).
  `fm3-1`–`fm3-4` beside them is CSM with formant tracks (§15): it needs the
  note-less `(fm3-csm voice)` (`E_FM3_MODE_CONFLICT`) and an `fm3-csm-rate`
  track (`E_CSM_RATE_MISSING`).
- Beside `fm3-1`–`fm3-4`, `(fm3 …)` — or `(fm3-csm …)` — is the shared patch
  only: a note on it is `E_FM3_MODE_CONFLICT` (in that mode the channel's
  F-number is operator 4's). The same holds inside one `def-se`.
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
| `X ~ Y`        | Connector: same pitch **ties** (extends), different pitch **slurs** (legato — §3, *Tie and slur*) |
| `>` / `<`      | Octave up / down (±1)                                          |
| `o+N` / `o-N`  | Octave shift (no number = ±1)                                  |
| `v+N` / `v-N`  | Velocity shift (no number = ±1)                                |

The sounding octave comes from the sticky `:oct` (C at `:oct 4` = middle C,
MIDI 60); a voice with a `:key` moves its notes from there (§9).
Enharmonic accidentals are equivalent (`c+` = `d-`).

A definition cannot be named like a note: a `def`, `def-fm` or `def-pcm`
whose name reads as a note-stream token (`a`–`g`, `e8`, `c+`, `v+2`, `>`) is
`E_DEF_NAME` where it is defined — the rule `let` names follow. A `def-val`
(written `$a`) and a `def-se` (started by number) are never written bare and
may take such names.

### Tie and slur — `X ~ Y`

`~` is a binary connector between two notes. It attaches to the **next real
note**, skipping state tokens (`c ~ > d` slurs to the octave-up `d`). The right
note keeps its own length, so `~` takes none.

- **Same pitch → tie.** `c ~ c` (or `g8 ~ g8`) extends the first note by the
  second's length — one attack, held longer. Equivalent to a longer length token.
  On a PCM track too: the same sample at the same pitch is not struck again —
  a shot plays on, a `:mode loop` note keeps looping and releases at the gate
  of the whole tied length, and a `:mode gate` note is cut there. A slur, or
  another sample, strikes anew.
- **Different pitch → slur (legato).** `c ~ e` moves the frequency to `e`
  **without re-keying** — the FM envelope (or the PSG tone) carries over from
  `c`, no new attack. Chains: `c ~ d ~ e` is one attack gliding through all three.

`~` follows the loop's control flow, not the text order. A `~` ending a loop
body connects to the body's first note on the passes that loop back, and one
before `(go label)` to the label's first note — when that note is a tie
continuation (`c ~ #loop (x 2 c2 …`), the tail is tied into it. With a `(break)`
the last pass leaves from the break, so the note after the loop connects to
the note before the `(break)` (a `~` on the body's tail does not reach it); a
relative gate on that note resolves over each way on alone — into the body
on the passes that loop, out of the loop on the last.

The left note of a slur always sounds its **full slot**: its gate (`:gate`,
`:gate*`, `:gate-`) is ignored, so it never keys off before the connection (a
hold, gate 0, stays a hold). The right note keeps its own gate — end a slurred
run staccato and only the last note is cut. Slur/legato is an **FM/PSG** feature (the macro/keying
model of channels 0–9); on other channels a different-pitch `~` is treated as a
normal note. Encoded as `NOTE_ON_EX` bit3 (opcodes.md §5.1).

### Tuplets — `(t …)`

`(t elem …)` divides **one** current `:len` slot among its notes and rests
(Bresenham distribution, so remainders spread evenly):

```lisp
(fm1 :len 4
  c (t e g a) f     ; triplet inside one quarter
  (t c _ c)         ; rests allowed
  (t b > c d <))    ; octave shifts too: b4 c5 d5
```

Elements may be notes, per-note-length atoms (their suffix is ignored — the
slot division wins), or `_` rests; each takes an equal share. Between them go
the state tokens that take no time — `>` `<` `o±N` `v±N` — which take no share
and apply to the notes after them, inside the tuplet and on after it, as
anywhere in the stream. Anything else, a nested tuplet included, is
`E_UNKNOWN_TUPLET_ELEM`; a `(t)` with no note or rest is `E_TUPLET_EMPTY`.

A bare note-headed list `(e g a)` is not a tuplet — it is rejected with
`E_UNKNOWN_LIST`; the syntax is reserved.

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
| `0`   | Hold: KEY-ON, and the track waits for the runtime key-off (§17) | 0    |

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
(driver.md §3.3). `Nms` is a duration at any tempo: in those same frame
contexts it becomes the nearest whole frame count (`300ms` → 18 frames on
NTSC), and in a structural one it is converted to ticks at the tempo in force,
where it is the only token finer than a tick (5.2 ms at 120 BPM). The PCM loop
points (§16) are the one place it is not rounded at all — they take their
value in seconds, so `1ms` reaches the engine's own floor.

In **structural** contexts that advance the musical timeline — note length,
`:gate`, `~` (tie), rests, `(glide T)`, and `(delay … :time T)` — `Nf` is
converted to ticks at the tempo active at compile time — on the target
standard's clock, so `c16f` is sixteen frames there too. So `c16f` lasts
16/60 s on NTSC at the tempo it was authored under; a `:tempo` change before the
note — on any track, since tempo is song-wide — is accounted for, but a **runtime** tempo change (live `setTempo`, or a
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

`:prio` is the one head option. It picks the layer the form belongs to (§1),
so it must come right after the channel name; anywhere else it is
`E_UNKNOWN_KEYWORD`, and a value that is not a non-negative integer is
`E_PRIO_INVALID`. Everything after it is body — `:oct`,
`:len`, `:shuffle` and the rest at the start of a form are ordinary body
keywords at the form's first tick.

### Body keywords

| Keyword    | Value                     | Effect                                                   |
| ---------- | ------------------------- | -------------------------------------------------------- |
| `:oct`     | integer ≥ 0               | Octave (also `:oct+`, §7)                                |
| `:len`     | length token              | Default note length; `0` = hold, the track waits for the key-off (§17) |
| `:gate`    | length token              | Absolute sounding time per slot; `0` = hold until runtime KEY-OFF |
| `:gate*`   | ratio `0.0`–`1.0`         | Gate as a fraction of the note length (`1.0` = full; above 0 it keeps at least one tick) |
| `:gate-`   | length token              | Gate = note length minus this time; a note no longer than it is not cut (full gate). A gate value that is not a length (or a ratio outside 0–1) is `E_GATE_INVALID` |
| `:vel`     | 0–15                      | Note-on velocity (also `:vel+` / `:vel*`)                |
| `:vel1`–`:vel4` | ratio `0`–`1`        | An FM operator's velocity sensitivity (§6); a voice param, also in a `def-fm` |
| `:vol`     | 0–31 or curve             | Channel fader → `PARAM_SET` / `PARAM_SWEEP`              |
| `:master`  | 0–31 or curve             | Global fader → `PARAM_SET` / `PARAM_SWEEP`               |
| `:tempo`   | number > 0 or curve       | Global: `TEMPO_SET` / `TEMPO_SWEEP` at this tick (0 or less: `E_TEMPO_INVALID`) |
| `:pan`     | `left`/`center`/`right`, −1/0/1, curve, `none` | FM stereo bits            |
| `:snap`    | `[pitch classes]`, mask, `$slot`, `none` | The scale every pitch write snaps onto (§5.3) |
| `:mode`    | symbol                    | `pcm1`–`pcm3`: `shot`/`loop`/`gate` (anything else `E_PCM_MODE_INVALID`); `noise`: `white0`–`white3`/`periodic0`–`periodic3`; on `pc88`, `sqr1`–`sqr3`: `tone`/`noise`/`both` (§19) (all sticky) |
| `:noise-rate` | 1–31 or curve        | `pc88` only: the SSG's one noise period, song-wide like `:lfo-rate` (§19) |
| `:csm-rate`| Hz or curve               | Timer A rate (`fm3-csm` only, §15)                       |
| `:shuffle` | 51–90 or `none`           | Swing ratio (§5.2)                                       |
| `:shuffle-base` | length token         | The swung length (default: eighth, §5.2)                 |
| hardware params | value / curve / `none` / `$slot` | `:alg :fb :ams :fms :lfo-rate :tl1`–`:tl4` `:ar :dr :sr :rr :sl :ml :dt :ks :ssg :am`(1–4) — §5.1 |

The gate family decides how *short* a note is inside its slot, never whether
the next note attacks: **a note keys off at its gate even when that gate fills
the slot**, so the note after it always re-attacks. The one thing that carries a
note into the next is `~` (§3, *Tie and slur*). This is what FM needs — the key-off → key-on
transition is the envelope's attack — and it costs nothing on PSG or PCM, which
re-assert attenuation / restart the sample on every note-on anyway.

The relative gates (`:gate*` / `:gate-`) resolve against the **whole tied note**,
not just its first segment: for `c4 ~ c8` with `:gate- 1f` the key-off lands one
frame before the tied end, so the tie stays connected. Absolute `:gate N` is
unaffected by ties.

`:tempo N` reanchors the timeline instantly; `:tempo (linear :from A :to B
:len L)` emits `TEMPO_SWEEP` over `L` (any curve name works — there is no
curve literally named `curve`). Tempo changes apply to all tracks.
Written in a track's leading position it sets the song's initial tempo (§1).
**Song-wide values** — `:tempo`, `:master`, `:lfo-rate` and the `def-val`
values (§8) — belong to the song, not to the channel whose track writes them.
Their sweeps run on their own, one per value: an effect taking that channel
(§9.3) or the track ending does not stop them; the next write to the value
does. If two tracks write one at the same tick the **last writer wins** (track
order), and for all but `:tempo` that is flagged `W_SONG_WRITE_RACE`; the
tick-0 initial tempo resolves the same way. Keep song-wide automation on a
single track to avoid ambiguity.

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

A channel runs **two sweeps at once** (a glide and a fade, say); a third
started while two still run cuts one off, which is flagged `W_SWEEP_SLOTS`. A
song-wide value's sweep (§5) is not the channel's and does not count.

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
length — written (`c8`, `_8`) or the default — equals `:shuffle-base`
(default: eighth). The pair spans 2× the base;
the first beat takes `R` % of it. Each track sets its own swing, anywhere in
the body; a change restarts the pairing, so the next swung note is a first
beat. The pairing runs on through loops as played: a loop body holding an
odd count of swung notes swings its next pass the other way, so `(x …)` and a
`#label … (go label)` in one form are written two passes at a time (an odd
count's last pass after them), and what follows a loop goes on from where its
last pass left — past every pass, or from the `(break)`. A section that cannot
be copied so — a counted `(go label N)`, or a label in another form — plays as
written and is flagged `W_SHUFFLE_LOOP`. `0` plays straight, as `none` does;
a value 1–50 plays straight too (`W_SHUFFLE_STRAIGHT`), and one above 90 plays
as 90 (`W_SHUFFLE_CLAMPED`); a value that is neither a number nor `none` is
`E_SHUFFLE_INVALID`.

```lisp
(sqr1 :shuffle 66 :len 8  c c c c)
```

### 5.3 Snap to a scale (`:snap`)

`:snap` gives an FM or PSG channel a scale, and from then on **every pitch the
channel writes stays in it**: the notes as written, a `:semi` arpeggio's
steps, a slot-fed transposition — the whole semitone each pitch write is about
to sound moves **down** to the nearest pitch class in the scale, and the cents
(`:pitch`, a vibrato, a glide) ride on the snapped note, so a bend stays
smooth. The value is the scale's pitch classes (0 = C, 1 = C♯ … 11 = B; a
number outside that is folded mod 12, so `(+ root n)` transposes), the 12-bit
mask itself (bit 0 = C), a `$slot` (§8), or `none` (= 0, off):

```lisp
(def major [0 2 4 5 7 9 11])
(def-val scale 2741 0..4095 :public)        ; 2741 = 0xAB5 = C major

(fm1 :snap major  c c+ d d+ e f f+ g)        ; sounds c c d d e f f g
(fm2 :snap major (macro :step 16 :semi [#sus 0 1 2 3 4 5 6 7]) c1) ; a chromatic arp, in key
(sqr1 :snap $scale  c d e f g a b)           ; the game writes the slot: same line, new mode
```

The mask is sticky channel state (an fm3-N track's is CH3's, and every
operator snaps on it); setting it moves a sounding note at once. A mask is
state, not a level: `:snap` takes no curve and no `+`/`*`, is not a macro
target (`E_MACRO_TARGET`), and a pitch class that is not a whole number is
`E_PARAM_VALUE`. A pcm track has no pitch to snap (`E_PCM_NO_PITCH`). A
`$slot` is read where the `:snap` is written, as any slot-fed parameter is
(§8); a host changes the mode under a held note by writing the slot and the
channel's `SNAP` parameter (driver.md §8).

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
- **A `:vol` macro moves only its own note's level**: the
  fader stays where the score set it, and the next note starts from it (or
  from its own macro's first sample). So a gate pattern that ends a note on a
  `0` step does not silence the next one, and a macro's `0` is a very low level
  (about −62 dB on FM), not a mute — `:vol [0 8 16 24 31]` fades a note in.
  The hard mute is the fader's.

**Velocity sensitivity — `:vel1`–`:vel4`.** How much of a note's velocity
reaches each operator, as a ratio `0`–`1` of the `:vel` offset. A voice that
does not set it keeps the model above: `1` on a carrier, `0` on a modulator.
Set on a modulator, velocity moves the timbre — a soft note is darker as well
as quieter, as on a DX7; set below 1 on a carrier, it narrows how far velocity
moves the level. `:vol` and `:master` are the mix's faders and keep reaching
the carriers alone, whatever the sensitivity — a fader that moved a modulator
would move the timbre:

```text
carrier TL   = voicedTL[op] + k[op]·dVel + dVol + dMaster
modulator TL = voicedTL[op] + k[op]·dVel          (k 0 by default: the voiced TL)
```

```lisp
(def-fm piano init-fm :alg 4 :fb 5
  :tl1 28 :vel1 0.5            ; modulator: half the velocity — brighter when struck harder
  :tl2 0
  :tl3 32 :vel3 0.25
  :tl4 0 :vel4 0.75)           ; carrier: a narrower dynamic range than op2

(fm1 piano :len 8 :vel 15 c :vel 9 e :vel 4 g)
```

The value lands in sixteenths (`0.5`, `0.25`, `0.0625` …); one outside 0–1
is `E_VOICE_VALUE` in a `def-fm` and `E_PARAM_VALUE` inline. It is part of the
voice: a `def-fm` holds it, an inline write sets it until the next voice, and
switching to a voice that does not set it returns every operator to its
role's own — so it follows the algorithm, if a later `:alg` makes a modulator
a carrier. It is fixed when written: there is no `+`/`*` form, no curve, no
`$` value (`E_PARAM_VALUE`) and no macro (`E_MACRO_TARGET`). In FM3's
independent-operator mode (§15) every operator's own is `1`, as each is a
voice there. `:vel1` on a PSG or PCM track is `E_UNSUPPORTED_TARGET`.

Authored values are integers — except the ratios after a `*`, such as a
`:vel*` macro's `[1 0.75 0.5]`, and a velocity: `:vel` (inline, `+`, and a
macro's values) takes eighths of a step, as the driver holds it — `14.5`,
`13.625`, a finer value rounded to the eighth. A computed velocity (a `:vel`
macro's curve, a delay tap's `:vel*`) keeps eighths too, and the level is
quantized once, at the chip's own resolution — FM TL 0.75 dB steps, so a `:vel` fade moves smoothly;
the SN76489 its 2 dB attenuator, the SSG its 3 dB level (§19); PCM its 6 dB
mixer shift. A `:vel` macro fades only to
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
| gate (the exception) | `:gate 1/8` | —            | `:gate* 0.5`   | compile time, per note |

- **Gate is the one exception.** Its base is not the current gate but each
  note's own length — a gate is how much of *this* note sounds — so `:gate*
  0.5` is half of every note, and `:gate- 12t` (the only `-` suffix) is every
  note's length minus 12 ticks. A cut is always subtractive and a length is
  never negative, which is why it is spelled `-` rather than `+` with a
  negative length. There is no `:gate+`.

- `vel`/`oct` have a compile-time base in the track state, so the IR carries
  plain absolute values.
- Inline hardware params (`:tl1+`, `:ar1*`, …) are runtime read-modify-write on
  the register's live value — every FM op-param, not just level/TL. A full
  `$slot` expression (`:tl1 (+ $a (* $b 2))`) lowers to a param-opcode chain;
  see §7.1.2.
- In macros, `*` applies only to `:vel`. `+` applies to `:vel`, `:pitch`, and
  `:semi`; any other target (or `*` on `:pitch`/`:semi`) raises
  `E_MACRO_OP_NO_BASE`. `:vel*` multiplies the note's vel by each value (1 =
  unchanged: `:vel 12` with `:vel* [1 0.5 0]` plays 12, 6, 0) and `:vel+`
  adds each value to it — both baked per note-on. `:pitch+` /
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
  `E_EVAL_NOT_LOWERABLE`. Scaling is orthogonal to `+` (additive): only
  `(* signal $slot)` scales, and it combines with `:pitch+` — the scaled
  signal is added to the note's own pitch offset.
- Echo/delay taps are always relative, so the keyword is `:vel+` or `:vel*`
  and its value is the per-tap change (§12); bare `:vel` is
  `E_ECHO_TARGET` / `E_DELAY_TARGET` (the clear forms `(delay none)` /
  `(delay :vel none)` excepted).

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
| `mod` | 2 | floored: takes the divisor's sign, `(mod -1 4)` = 3; by zero → `E_EVAL_DIV_ZERO` |
| `=` `<` `>` `<=` `>=` | 2+ | 1 if each operand holds against the next, else 0: `(< 0 i 8)` |
| `not` | 1 | 1 for 0, else 0 |
| `midi` | 1 | a note name with its octave as a MIDI number: `(midi c+4)` = 61 (C4 = 60) |
| `hz` | 1 | a note's frequency: `(hz a4)` = 440; a MIDI number too, `(hz 69)` |

Operands are numbers, nested expressions, and `let`-bound names (§7.2).
A comparison is a number like any other result — 1 or 0 — so it also
feeds arithmetic (`(* 12 (= i 0))`); `if` (§7.6) reads it. Comparing a `$`
value or a curve is `E_EVAL_TYPE`: a comparison decides at compile time.
Floats flow through a computation; integerization happens only where the value
binds (the target's own round/clamp). A note/length token as an operand is
`E_EVAL_OPERAND` (no implicit note→number): `(midi …)` and `(hz …)` are
where a note becomes a number, its octave written so the value is the same
wherever it stands (`:oct` is not read). Nesting deeper than 32 →
`E_EVAL_DEPTH`; wrong argument count → `E_EVAL_ARITY`.

Expressions are accepted in **every value position**: an inline param write
(`:tl1 (+ 20 10)`), a `(param-set …)` value, a curve parameter
(`:to (* 2 10)`, §11), inside `let` / `note` / `(ticks …)` / `(frames …)`, and
every number that resolves at compile time — `:oct`, `:vel`, `:shuffle`,
`:gate*`, a count (`(x N …)`, `(go label N)`, `(echo N …)`, `(delay N …)`), a
`(trig N)` id, and the options of `def-score`, `def-se`, `def-val` and
`def-mod`; a length position takes a length expression (§7.4). Two places
are tokens, not values, and stay literal: the range shorthand `A..B` (write
`:from` / `:to` for computed ends) and a bare number on `fm3-csm-rate` (a Hz
note; `(note …)` computes one).

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
  point-by-point into a baked step vector at compile time. What lowers: a frame
  `:len` (`Nf` / `Nms`) on both, in a **macro** value only (an inline sweep cannot carry
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
  → `PARAM_MUL`; `× $slot` → `PARAM_MUL` (slot). A multiply is unsigned 8.8:
  a constant factor is kept to 1/256, and a slot **is** the 8.8 factor —
  `256` is ×1, `128` ×½, `512` ×2 (the /256 a scaled macro's depth slot reads
  too) — and the product drops its fraction. Constant sub-trees fold first
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

`(let [name value …] body…)` binds names for its body — sequential
(`let*`: later bindings see earlier ones), lexically scoped, nestable.

```lisp
(fm1 :len 8
  (let [root 60]                         ; a value, not a phrase
    (note root) (note (+ root 4)) (note (+ root 7)))   ; c e g
  (let [amp 40]
    (macro :pitch (* (sin :from -1 :to 1 :len 4f) amp))))
```

- **Item position** (in the note stream): the body compiles in place — sticky
  state changes inside behave as if unwrapped.
- **Value position**: the body is one expression (`:tl1 (let [x 30] (+ x 5))`);
  a bare bound name is also a value (`:vel v`).
- **Bindable**: numbers, curves and `$` expressions (a phrase/stream cannot be
  bound — use a `def`, §9). A `$` expression stays a runtime value, lowered
  where it is written (§7.1.2): `(let [lvl (* $a 2)] :tl1 lvl …)`. A
  self-read `$<param>` needs the parameter, so it binds only in a value-position
  `let` (`:tl1 (let [x $tl1] (+ x 3))`).
- **Bindings** are one vector of names and values in turn, as in Clojure:
  `[root 60 amp 40]`. A name without its value, or a list in place of the
  vector (`((root 60))`), is `E_LET_BINDING`.
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
range 0–127 → `E_NOTE_RANGE`; no pitch, or more than a pitch and a length, is
`E_NOTE_ARGS`.

```lisp
(fm1 :len 8 (note 60) (note (+ 60 7)) (note (* 12 6)))   ; c4 g4 c6
```

A `noise` curve in the pitch is one draw from its range — the computer's
pick, fixed by the score (§11.1): every written `(note …)` draws anew, so a
run of them is a run of different keys, and a `let` gives the root.

```lisp
(fm1 :len 8 (let [root 60]
  (note (+ root (noise 0..12))) (note (+ root (noise 0..12)))   ; two keys within the octave above root
  (for [i 0..3] (note (+ root (noise 0..12))))))               ; four more, each its own draw
```

### 7.4 Lengths from expressions — `ticks` / `frames`

In a length position (`:len`, `:gate`, a note's second argument, a curve's
`:len` / `:hold` / `:wait` and a stage's `(wait …)`) a **bare
number is a note denominator** — and a computed number is the same:
`(+ 2 2)` ≡ `4` ≡ a quarter note; `(* 2 4)` ≡ `8` ≡ an eighth. For an absolute
duration wrap the unit explicitly:

- `(ticks expr)` — `expr` rounded, in ticks.
- `(frames expr)` — `expr` rounded, in 60 Hz frames (converted to ticks at the
  authoring tempo, §4). For a literal count the `Nt` / `Nf` suffix is shorter
  (`24t`, `20f`); the form is for computed counts (`(frames (* base 2))`).

### 7.5 `for` — notes generated from values

`(for [name values …] body…)` compiles its body once for each value, in
place, with `name` bound to it — as if every pass were written out.

```lisp
(fm1 :len 16
  (for [i 0..7] (note (+ 60 i)))                    ; c c+ d … g
  (let [root 48]
    (for [n [0 4 7 12]] (note (+ root n)) _))       ; an arpeggio with rests
  (for [o 0..1 n [0 7]] (note (+ 60 (* 12 o) n)))) ; c4 g4 c5 g5
```

- **Values** are `A..B` — integers, both ends included, either direction
  (`7..0` counts down) — or a `[…]` of numbers, `let` names and expressions.
  Notes are written as MIDI numbers (`[60 64 67]`, or offsets from a `let`
  root as above): a note name is not a number (`E_EVAL_OPERAND`, §7.1). A
  step is arithmetic in the body (`(* 2 i)`). Anything else is
  `E_FOR_VALUES`; a `$` value is read at run time and a curve is not a list
  of numbers, so both are `E_EVAL_TYPE`. `[]` makes no pass.
- **Several pairs nest**, the first outermost, and a later pair's values may
  use the earlier names (`[lo [1 2] hi [lo (* lo 10)]]`). More than 4096
  passes in all is `E_FOR_COUNT`.
- **Names** follow `let`'s rules (§7.2): not a note or length token
  (`E_LET_NAME`), not a def's name (`E_LET_SHADOWS_DEF`).
- **The body** is an item position: sticky changes carry from pass to pass
  as written out (`(for [i 0..3] c >)` climbs four octaves), a tie at the end
  of a pass runs into the next, a `(break)` belongs to the `(x N …)` around
  the `for`, and a `#label` in it would be written once a pass
  (`E_MARKER_DUP`).

`for` and `(x N …)` differ in what they emit: `(x N …)` repeats one body as a
loop on the driver; `for` writes each pass out, because each differs. A body
that does not use its name is `(x N …)`'s job.

### 7.6 `if` — a choice made at compile time

`(if test then [else])` writes one of its branches: `then` when `test` is
non-zero, else `else`.

```lisp
(def depth 4)
(fm1 :len 16
  (for [i 0..15]
    (if (= (mod i 4) 0) (note 72) (note 60)))   ; an octave up on each beat
  :tl1 (if (> depth 3) 20 30))                  ; a def constant decides
```

- **In the note stream** the chosen branch compiles in place, as if it alone
  were written; with no `else`, a false test writes nothing. A branch is one
  item — a note, a form, or a snippet name, which stays one branch whatever it
  expands to.
- **In a value position** the `else` is required, and the result is the
  chosen branch's value — a number, a curve or a `$` expression.
- **The test** is a number decided now: a `$` value is known only on the
  driver, and the driver does not branch, so a `$` in the test is
  `E_EVAL_TYPE`, as is a curve. A wrong number of parts is `E_EVAL_ARITY`.

---

## 8. Dynamic values — `(def-val …)`, `$name`

Runtime values: the score's variables, and — marked `:public` — the inputs
the game writes. The score reads them
directly (`:tl1 $level`), as an operator operand (`:tl2+ $level`), or combined
in a runtime value expression (`:tl1 (+ 40 (* $tension 2))`) that lowers to a
param-opcode chain on the driver (§7.1.2) — and writes them like any
parameter, by name.

```lisp
(def-val level 20 0..40 :step 2 :public)
(def-val gain 128 0..256 :public)   ; a factor: 256 = ×1
(def-val swell 0)                   ; the score's own

(fm1 :tl1 $level               ; PARAM_FROM_VAL
     :tl2+ $level              ; PARAM_ADD (slot-relative)
     :vol* $gain               ; PARAM_MUL: × gain/256 — here ×½
     :ar1 $time                ; built-in source
     (macro :pitch (sin :from -40 :to $swell :rate 2))
     c e g e)
(sqr1 :swell (linear 0..60 :len 8/1) ; the score moves its own value, over 8 bars
      _1 :swell+ -10 _1)
```

`(def-val name init A..B :step S :unit U :public)` — or the explicit
`:from A :to B` form:

| Field      | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `init`     | Positional default (integer). Omitted → defaults to the range start |
| `A..B`     | Positional range sugar (§11) for the slider endpoints — the same `:from A :to B`, so `90..10` runs the slider downward. With no range at all the slider runs `0..127`; with only one of `:from` / `:to`, the other end is `0` |
| `:from` / `:to` | Order-free directional endpoints — the live slider runs from A to B (either direction, negatives fine); `A..B` positionally is the same |
| `:step`    | Slider granularity, integer > 0 (default `1`)                    |
| `:unit`    | `frame` (default) or `tick` — how the value is read when the slot feeds a curve `:len` |
| `:public`  | The game's to write: its name goes in the MMB's metadata. Without it the value is the score's own (the live app's panel writes either) |

A score holds 16 slots (`E_DEFVAL_COUNT`). The `:public` ones are indexed
first, each group in declaration order — so the indices a host writes do not
move when the score adds a value of its own — and all are emitted in
`metadata.vals` as `{name, slot, init, min, max, step, reversed, unit,
public}`. The live app renders a Dynamic Parameters slider for every slot,
the `:public` ones marked — `:public` says what the game may write, not what
the panel may. Names must not start with `$`, nor be a keyword the language already
has — `:name` writes the value, so `(def-val vel …)` or `(def-val time …)`
would mean two things (`E_DEFVAL_NAME`); a non-integer `init` is
`E_DEFVAL_INIT`, and an unknown or malformed option (`:step 0`, `:unit beat`)
is `E_DEFVAL_OPTION`.

**Writing a value.** `:name` is a parameter like `:tl1`, and every form of
§5.1 applies: `:swell 12`, `:swell+ -4`, `:swell* 0.5`, `:swell $other`,
`:swell (+ $other 4)`, `:swell (linear 0..40 :len 8/1)`, `:swell none`. The
value is song-wide (§5): written on any track, it is read by every track, and
its sweep runs in a slot of its own — an effect taking the writing track's
channel does not stop it. A reader takes the value when its own write runs
(`:tl1 (+ 22 $swell)` follows a sweep note by note, not within a note). A
host's write and the score's are the same write: the later one wins, and a
host write ends the score's sweep of that slot.

- `$name` references a slot in a value or operator-operand position of a
  runtime parameter write (§5.1). `vel`/`oct` resolve at compile time — a
  number, a `let` name or an expression — so a `$` there, or a curve, is
  `E_VALUE_COMPILE_TIME`.
- `$time` is built in: elapsed 60 Hz frames since playback started, read-only.
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
`:rate`, or `:len` — a **bare** `$name` only: the driver reads one slot as-is,
so an expression with a `$` in it (`:to (+ $v 4)`, or a `let` name bound to
one) is `E_CURVE_PARAM_RUNTIME`. (Compute it into a value of its own instead:
`(def-val lift 0)`, `:lift (+ $v 4)`, then `:to $lift`.) The slot is read
**once at note-on** (the note-on sampling
tier), so the value is constant for that note. `:len` uses the slot's
`def-val :unit` to pick frame/tick interpretation. The macro `:step` clock is
static. The curve spec records these in a `dyn` map the player resolves at
schedule time.

On the MMB driver, an **inline sweep's `:from`/`:to`** are fully slot-fed:
the driver reads the slot when the sweep dispatches (PARAM_SWEEP flags, so a
game-controlled `def-val` moves the swell target in real time). Slot-fed
**macro-curve** params and a sweep's `:len` are not read live — those bake to
the slot's init on MMB (`W_MMB_DYN_BAKED` / `W_MMB_DYN_SWEEP_BAKED`), matching
the live player while the slot stays at its init.

---

## 9. `def` forms

Each definition head means one thing. `def` names a **snippet** — any
inline-writable notation, expanded where its name is written. `def-fm`,
`def-pcm` and `def-wave` declare **named data** (an FM voice, a PCM sample, a
wave for the wave channels, §19 `msx`), as `def-val`
declares a value slot (§8); a bare reference in a channel body applies them.
`def-se` declares a **sound effect** — tracks the game starts, not the song
(§9.3). `def-mod` rewrites the notes it selects across the whole score (§9.4).
Definitions are top-level forms and interleave freely
with track forms (§1); the score's own settings are `def-score` (§1). A def (or parametric def) named after an eval builtin
(`+`, `-`, `*`, `/`, `min`, `max`, `abs`, `round`, `floor`, `mod`, `=`, `<`,
`>`, `<=`, `>=`, `not`, `let`, `if`, `note`, `for`, `ticks`, `frames`) is rejected with `E_DEF_RESERVED`. One named like a note or length token is `E_DEF_NAME` (§3).

`def` vs `let` (§7.2): a `def` is a **global** name bound by **token
substitution** — the body is spliced verbatim wherever the name appears, so it
can name a phrase (`(def riff c e g)`), a macro (`(def env (macro :vel […]))`),
a voice switch plus live writes (`(def lead-live lead :tl1 $bright)`), or a
file-wide constant (`(def depth 40)`, usable inside expressions). Expanding is
free: macros and voices land in deduplicated tables, and a repeated run of
stream bytes is shared by the encoder's CALL/RET pass (opcodes.md §5.2). A `let` is a **local**,
**evaluated** value scoped to one body.

| Form                                  | Kind                                    |
| ------------------------------------- | --------------------------------------- |
| `(def name item…)`                    | Snippet — inline expansion at the reference (snippets within snippets ≤ 16 deep, else `E_DEF_RECURSION`) |
| `(def (name param…) item…)`           | Parametric snippet — call as `(name arg…)`; each `arg` node is substituted for its `param` in the body (§9.1) |
| `(def-fm name :alg … :tl1 … …)`       | FM voice, keyword map                   |
| `(def-fm name base :tl1 … …)`         | FM voice extending `base` (its keys override; a base that is not a voice, or a cycle, is `E_VOICE_EXTENDS`) |
| `(def-fm name … :key N …)`            | FM voice that sounds c4 at MIDI note `N` — every note on it moves by `N − 60` (below) |
| `(def-pcm name :file "…" …)`          | PCM sample (§16)                        |
| `(def-pcm name base …)`               | PCM sample extending another sample (§16) |
| `(def-wave name :wave …)`             | A wave channel's wave (§19, `msx`)      |
| `(def-se name [:prio N] [:tempo T] (ch …)…)` | Sound effect: parts the game plays by number (§9.3) |
| `(def-mod [:ch …] [:voice …] action…)` | Score-wide modifier: silence or re-level the notes it selects (§9.4) |
| `(def name (macro :target spec …))`   | A snippet holding a macro form — written alone it applies the macro, and inside another `(macro name …)` it applies first, with its own `:step` |

A `def-fm` holds the channel's `:alg :fb :ams :fms`, the operator params
`:ar1`…`:am4` (and the FM-PAC's `:ws1` `:eg1` `:ksl1` `:vib1`, §19 `msx`),
the velocity sensitivities `:vel1`…`:vel4` (§6) and `:key` —
anything else is `E_VOICE_PARAM`. A value is anything
that evaluates to a number (a literal, a snippet constant, an expression); a
curve or a `$` value is `E_VOICE_VALUE`, since a voice is fixed data. A leading
name is the voice it extends: the base's params first, the voice's own over
them, as a sample does (§16). Unset operator parameters are not emitted —
start from a full patch (or extend one) for deterministic timbres. The
built-in voice `init-fm` is always available: a sine, as the score's FM
chip makes one — on the OPN and the OPM ALG 7, AR 31, RR 15, ML 1, TL 0 on
all operators; on the FM-PAC its modulator silent (`:tl1 63`), both
operators AR 15, RR 15, ML 1, `:eg 1` (§19 `msx`). A track that names no
voice plays it. The FM-PAC's fifteen ROM voices, `piano` … (§19 `msx`), are
built in the same way:

```lisp
(def-fm lead init-fm
  :alg 4 :fb 3
  :tl1 30 :tl2 0 :tl3 30 :tl4 0)

(fm1 lead c e g e)
```

**On the Mega Drive, a voice change is sent ahead of its note.** A voice is
about 36 register writes, and the driver's wire takes them a few per
millisecond; sent with the note, they would delay that note and every other
channel's note in the same frame. So on `md` the compiler moves a voice
written before a note into the silence before it,
together with the channel's own `:vel`, `:vol`, `:pan` and `:pitch` written
there (`:lfo-rate` and `:master` stay with the note):

- after a rest, the voice goes in the last four PAL frames (about 80 ms) of
  it. A voice written before the rest, `stab _ c`, goes there too, and so
  does one before a rest that runs on through rests and loops of rests,
  `stab _2 (x 4 _1) c`, or up to a loop or label, `stab _2 (x 4 _1 e …)`: a
  voice sounds at the next note wherever that is, so it waits at the end of
  the rest;
- after a note that runs into the next one, that note is **cut about 40 ms
  short** (two PAL frames, the same ticks on either standard) to make the
  silence; a `:gate-`/`:gate*` that already leaves one is
  used as it is;
- after a counted loop that ends in a rest, `(x N … _)`, the loop's last pass
  leaves the rest out and it is played after the loop, so the voice can go in.

Which frame of those: the first that is free — no other channel's voice
already there, no FM key-on there on any channel — else the one with the
fewest. Several channels changing voice before the same beat take several
frames, one voice each, instead of one frame (a voice is about 36 writes of
the driver's frame, and of its wire); a voice alone takes the earliest, as
before.

Nothing moves inside a slur (`c ~ lead e`), across a `#label` or `(go …)`, at a
track's start (it is sent at load, driver.md §4.1), at a loop's head, on an
`fm3-N` operator track or with CSM, or in an effect's part. Note onsets never
move. The editor plays the same moved stream as the driver. A VGM target
(`pc88`, `x68k`, `msx`) has no wire: a voice is written at its note.

**`:key N`** gives a voice its own pitch: c4 sounds at MIDI note `N`
(0–127, else `E_VOICE_VALUE`), and every note written on the voice moves by
`N − 60`. It is how a percussion voice is tuned — `(def-fm kick … :key 35)`
plays its bass drum when a track at `:oct 4` writes `c` — while a written
`d` still sounds two semitones higher, as a drum retuned. The compiler moves
the note itself, so ties, slurs, glides, `(note …)` and echoes all see the
sounding pitch, and nothing reaches the IR or the driver but the moved
note; a note moved outside 0–127 is `E_NOTE_RANGE`. Runtime pitch (`:semi`,
`:pitch`, `(glide from …)`'s absolute start) is not moved. A voice that
extends a `:key` voice inherits the key unless it sets its own, and
switching to a voice without one ends the move.

```lisp
(def-fm tom-lo init-fm :alg 7 :key 41)
(def-fm tom-hi tom-lo :key 48)

(fm5 :oct 4 tom-lo c tom-hi c c d)      ; 41, 48, 48, 50
```

Voice names are plain identifiers — no special prefix (a voice is recognized by
its `def-fm` head, not a sigil). The mucom importer, whose voice names are
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
inside the body. A `let` or `for` in the body keeps its own names: one of the
same name as a `param` shadows it inside, and an argument that mentions a
name the body binds still means what it meant at the call
(`(let [n 60] (tri n))` passes 60, whatever `tri` binds). A call whose argument count differs from the parameter count is
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
  Open Folder…), like a PCM `:file` (§16). A path not found there is read
  from the root instead, so a served score's `presets/tr909/set.mmlisp` works
  from any folder — and the file then counts as being where it was found, for
  its samples and its own imports. A path that cannot be read is
  `E_IMPORT_NOT_FOUND`.
- **What is imported**: the def namespaces — plain and parametric snippets
  (`def`), FM voices (`def-fm`), PCM samples (`def-pcm`) and sound effects
  (`def-se`, §9.3). Imports are
  transitive (an imported file may itself `import`). An imported sample def
  keeps its own base directory, so its `:file` reads from the imported file's
  folder, not the score's (§16).
- **What is not imported**: `def-val` slots, `def-score`, `def-mod` and
  track/other forms. A slot's index is the importing file's host-visible
  layout, the settings and modifiers are the score's own, and tracks are songs,
  not a library, so all are ignored with a `W_IMPORT_IGNORED` warning. Import
  folds defs only.
- **`:fx`**: `(import "path" :fx [...])` puts one effect chain (§16)
  on every sample the import brings in — a whole kit processed at once. It
  runs **before** each def's own `:fx`, so the kit is evened out first and
  a sound's own adjustment lands on top (a per-sound `gain` survives a
  kit-wide `normalize`). Nested imports stack outermost first. Other defs are
  untouched.
- **Collision policy**: imported defs are overridable **defaults** — a local
  `def` of the same name **wins** silently (so you can import a bank and tweak
  one patch inline). Two different imported files defining the same name is an
  error (`E_IMPORT_CONFLICT`); a diamond (two imports pulling in the same third
  file) dedups and is fine. An import cycle is `E_IMPORT_CYCLE`.
- **`:over`**: `(import "path" :over)` lets this import's defs **replace** the
  same names from the imports written **before** it, instead of conflicting;
  the names it does not define stay as they were. Layers stack in order, so a
  base set can be filled out and partly replaced:

  ```lisp
  (import "presets/gm-drums/set.mmlisp")         ; the base: every GM name
  (import "presets/tr808/set.mmlisp" :over)      ; 808's sounds replace GM's
  (import "presets/rx5/set.mmlisp" :over)        ; ...and RX5's replace both
  ```

  Here a name RX5 has is RX5's, one only the 808 has is the 808's, and the rest
  are GM's. `:over` reaches back only: a plain import written after it that
  defines one of its names is still `E_IMPORT_CONFLICT`, so write the base
  first and the layers after it. It covers the defs the import brings in
  through its own imports too, combines with `:fx` (which rides on the samples
  this import brings in), and a local def still wins over every import. A
  replaced sample that nothing plays is not baked.

**Drag & drop in the live editor.** ⇧Shift-dropping a `.mmlisp` onto the window
inserts its `(import "…")` line at the cursor rather than opening the file; a
plain drop opens it. The path written is folder-relative when the file comes out
of the opened source folder, and the bare file name otherwise — in which case
the editor holds the file's text in memory so the score compiles at once, and
warns that it must be moved next to the score to survive a reload. Drop rules
are the same as for samples, below.

### 9.3 `def-se` — sound effects

A game's sound effects are written once, as defs, and every song carries them.

```lisp
; se.mmlisp — the game's effects
(def-fm bell :alg 7 :tl1 10 :tl2 8 :tl3 12 :tl4 6)
(def-pcm crash :file "crash.wav")

(def-se jump :prio 3
  (fm1 bell :oct 5 :len 16 c e g > c))
(def-se boom :prio 9 :tempo 150              ; two parts, one effect
  (fm1 :oct 3 :len 4 c)
  (pcm1 crash :len 4 (macro :step 1/32 :keyon [1 1 1 1]) c))
```

- **Parts.** Each part is a channel form, written on the channel the effect
  **takes from the song** — `fm1` above is the song's lead's channel. When the
  effect plays, the song's part there is suspended — it plays on, unheard —
  and when the effect ends it comes back where the song is (driver.md §2.5):
  patch, levels, pan, a sweep still moving and, on `noise`, its mode, with a
  note it still holds re-keyed. One part a channel (`E_SE_PART`). An FM effect on a
  channel the song leaves free starts sooner: the first effect there has its
  voice loaded with the score (driver.md §4.1).
- **Not `:master`, `:lfo-rate` or a `def-val`.** Those are the song's — the
  game's fader, the chip's one LFO, the score's values — so an effect does not
  write them (`E_SE_PART`).
- **Not on CH3.** `fm3`, `fm3-1`…`fm3-4`, `fm3-csm` and `fm3-csm-rate` take
  no effect part (`E_SE_PART`): CH3's operator mode and CSM are chip-wide,
  so a song part there could not play on under an effect. Put an FM effect
  on `fm1`, `fm2` or `fm4`–`fm6`.

  ```lisp
  (def-fm kit :alg 7 :fb 0
    :ar1 31 :dr1 6 :sr1 1 :rr1 6 :sl1 2 :tl1 10 :ml1 2 :ks1 0 :dt1 0
    :ar2 31 :dr2 8 :sr2 2 :rr2 8 :sl2 2 :tl2 10 :ml2 1 :ks2 0 :dt2 0
    :ar3 31 :dr3 6 :sr3 1 :rr3 6 :sl3 2 :tl3 10 :ml3 4 :ks3 0 :dt3 0
    :ar4 31 :dr4 9 :sr4 2 :rr4 9 :sl4 3 :tl4 10 :ml4 1 :ks4 0 :dt4 0)
  (def-se chord :prio 5                      ; three pitches from one channel
    (fm3 kit)
    (fm3-1 :oct 5 :len 4 c e)
    (fm3-2 :oct 5 :len 4 e g)
    (fm3-3 :oct 5 :len 4 g b))
  (def-se buzz :prio 5                       ; a CSM formant, its rate swept
    (fm3-csm kit :oct 3 :len 4 :csm-rate 440 c :csm-rate (linear 440..880 :len 4) c))
  ```
- **Not the song's.** A part is compiled like any track, but it is never played
  with the song. The game plays an effect by its **number** — its place among
  the def-se forms, imports first. `tools/install-sgdk.mjs` writes the numbers
  to `inc/mmlisp_se.h` as `SE_<NAME>` (`jump` → `SE_JUMP`), and
  `MMLisp_playSe(SE_JUMP)` plays it (drv/sgdk/README.md).
- **`:prio`** (0-255, default 0) is the effect's priority against another
  effect on the same channel: a lower one is dropped, an equal or higher one
  takes over. The game may pass its own (`MMLisp_playSePrio`).
- **`:tempo`** (default 120) is the effect's own clock: an effect sounds the
  same in every song and under any tempo the song sets. A part may set it
  again, but not sweep it — a `:tempo` curve drives the song's clock
  (`E_SE_PART`). An option out of range, or any other key before the parts,
  is `E_SE_OPTION`.
- **Every song carries the same effects.** A bundle's `"se"` file (and
  `install-sgdk --se`) is compiled into every song as if it imported it, so
  the numbers are the same in every song and a song never names an effect. A
  song that defines a def-se of its own would move the numbers — the bundle
  refuses it.
- **Audition.** In the live editor, Play with the cursor inside a def-se plays
  that effect alone. With the MMLispDRV backend (Tools menu) the panel's
  **Sound Effects** buttons play an effect over the running song, as the
  game does (guide.md §22).

### 9.4 `def-mod` — score-wide modifiers

A `def-mod` changes every note it selects, wherever the note is written —
without touching the tracks. It is for trying things out: silence a part to
play it yourself on the MIDI keyboard over the rest of the song, or move the
hi-hats of an imported MIDI file down together.

```lisp
(def-mod :ch fm2 :keyon off)                        ; play fm2 yourself
(def-mod :ch [pcm1 pcm2] :keyon off)
(def-mod :voice [hat hat-open hat-pedal] :vel+ -3)
(def-mod :voice [hat hat-open] :vel* 0.5 :vel+ 7)   ; the hats' range → 7–14.5
(def hats [hat hat-open hat-pedal])
(def-mod :voice hats :vel 11)                       ; a def can name the list
```

A def-mod has no name — a comment says what it is for, and deleting or
commenting it out turns it off.

- **Selecting.** `:ch` names channels (`fm1`…`pcm3`, `fm3-1`, …, as the track
  forms are headed), `:voice` the `def-fm` voices and `def-pcm` samples the
  notes play. Each takes one name or a `[…]` list (any one of them); given
  both, a note must match both. Neither selects every note. A voice matches
  the notes played while the track has that name bound — not the voices that
  extend it. A name that is neither is `E_MOD_TARGET`.
- **`:keyon off`** turns each selected note into a rest of its length, with
  its ties. Everything else on the track stays — voice changes, `:vol`, pan,
  sweeps, loops, labels, and the song-wide `:tempo` / `:master` it carries — so
  the channel keeps following the part, and a key played on it in the live
  editor sounds in the part's voice. A track left with no notes is a free
  channel to the live keyboard, which takes it first when it is the target.
- **`:vel` / `:vel+` / `:vel*`** set, add to or scale each selected note's
  velocity, in the order written, and clamp the result to 0–15 without a
  diagnostic. A vel macro moves with its note: `+` and `*` apply to every
  value, `:vel V` shifts the envelope by the step it moves the note. 15 is the
  voice's own level, so a mod cannot boost past it — a louder sample is
  `:fx [(gain 6)]` on its def-pcm (§16). PCM levels move in 6 dB steps, so
  velocities three apart play alike there.
- **Order.** Mods apply after everything the tracks write (inline `:vel`,
  macros), in source order. Echo and delay taps (§12) are notes like any
  other; on a `:prio`-layered channel (§1) a mod applies to each layer before
  they merge, so a silenced note leaves its time to a lower layer.
- **Scope.** The song's tracks only — not the parts of a `def-se`. An imported
  file's def-mods are ignored (`W_IMPORT_IGNORED`): a modifier is the score's
  own. Mods are compile-time only — every output (preview, WAV, VGM, MMB)
  carries their result and the driver never sees one.
- Any other option is `E_MOD_OPTION`, as is a def-mod with no action.

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
| `:master`  | `MASTER`     | 0–31         | Song-wide (§5): inline only — a macro is a note's (`E_MACRO_TARGET`); sweep it instead |
| `:pan`     | `PAN`        | −1–1         | Symbols `left center right`. A chip with a left and a right bit (the OPN, the OPM) snaps it to −1 / 0 / +1; `pce` takes it whole (§19) |
| `:mode`    | `NOISE_MODE` | 0–7          | Symbols `white0`–`white3` (4–7), `periodic0`–`periodic3` (0–3); on a `pc88` / `msx` sqr track `SSG_MIX`, symbols `tone noise both env`; on `fc`'s noise `white` (4) and `periodic` (0) (§19) |
| `:duty`    | `DUTY`       | 0–16         | A pulse's duty in sixteenths, on `fc`'s `sqr1` / `sqr2`: the chip takes the nearest of 2, 4, 8, 12 (§19) |
| `:lfo-rate`| `LFO_RATE`   | 0–8          | Song-wide (§5): inline only, as `:master` |
| `:noise-rate` | `NOISE_RATE` | 1–31      | Song-wide, but a macro on a `pc88` / `msx` SSG track steps it from the note (the later write wins, §19) |
| `:wave`    | `WAVE`       | def-wave names | A wave channel's wave (`msx`, `pce`), a step vector of def-wave names alone; a step naming the wave already playing writes nothing (§19) |
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

A keyword that is not in this table is `E_MACRO_TARGET` (`(macro :foo …)`
and `(macro :foo none)` alike) — a typo is never a macro that silently drops.
Out-of-range step values are clamped to the target's range (relative `+`/`*`
macros stay unclamped until combined with the base).

### Spec forms

| Form                        | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `[v v v …]`                 | Step vector — one value per `:step`. A value is a number (rounded where it binds), the target's symbol (`left`, `white2`) or a `let` name bound to a number; anything else is `E_MACRO_VALUE_INVALID` |
| `[… #sus …]`                | `#sus` marks the sustain loop: steps from it cycle until key-off |
| `[… #rel …]`                | `#rel` marks the release section: steps after it run after key-off |
| `_` (inside a vector)       | Hold: advance one step, no write                     |
| `(curve …)` (§11)           | Sampled every `:step`                                |
| `[v (curve …) (wait N) …]`  | A vector holding any stage runs its items in order — see below |
| scalar (e.g. `1`, `left`)   | Constant signal, equivalent to `[#sus v]`           |
| `none`                      | Clear the target's macro                             |

**One vector grammar.** A vector of values alone is a step vector (above). A
vector holding any stage — a curve, `(wait …)`, arithmetic on a curve, or a
`let` name bound to one — runs its items in order, one after another:

- a number (or a `let` name bound to one) is one `:step` at that value, `_`
  waits one step;
- a curve runs for its `:len`; a curve that loops (a loop wave, or `:mode
  loop`) runs until key-off — a modulated sustain;
- `(wait N)` holds the current value for a length token, `(wait key-off)`
  until key-off (a `N` that is not a length waits one tick, `W_WAIT_INVALID`);
- `#sus` makes the stage after it loop until key-off, and `#rel` is where the
  release starts (as `(wait key-off)`);
- the curve right after `(wait key-off)` / `#rel` may leave out its `:from`:
  the release then starts where the macro is at the key-off — a note let go
  mid-decay falls from there, not from a fixed level — and it must be the
  whole release (a stage after it is `E_MACRO_VALUE_INVALID`). Its `:to`
  is 0 unless written.

A flat run is a curve from a value to itself, `(linear 1..1 :len 8)`.

```lisp
(def pluck (macro :vel [
  (ease-out :from 15 :to 4 :len 1)    ; decay
  (wait key-off)
  (linear :to 0 :len 8f)]))           ; release from wherever the decay is
```

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
compose. Default: `1f` (one 60 Hz frame). A `:step` that is not a length
above 0 (`0`, a typo) leaves the macro on that default, with
`W_MACRO_STEP_INVALID`.

A `:step` written as a note length or ticks (`16`, `1/16`, `24t`) is a **beat
clock**: the macro steps on its track's ticks, so a 16th-note roll or arp stays
on the beat at any tempo (a 16th at 118 BPM is 7.63 frames — rounding it to
frames would drift). A `:step` in frames (`Nf`) is a **frame clock**, for LFO
and envelope rates; one in milliseconds (`Nms`) is the frame clock of the
nearest whole frame count (§4).

- A step vector advances one step per `:step`; a curve is sampled-and-held
  every `:step` (coarse step = stepped LFO; default keeps curves smooth).
- All targets in a macro share its one `:step` and stay phase-locked.
- `:step` governs both the `#sus` sustain loop and the `#rel` release section.
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
restarting the envelopes: the FM EG and the note's level/timbre macros —
`:vel`, `:vol`, `:tl1`…; `:pitch` and `:semi` run on, so a retriggered arp keeps
its place, and so does `:pan`, a place rather than an envelope). The first sample at t = 0 coincides with the note's
own attack and is a no-op, so a roll starts at the second step whether it is
written `[0 #sus 1]` or `[1 1 1 …]`. Steps before `#rel` loop until note-off (a roll);
steps after `#rel` fire after note-off (a one-channel echo tail): each tap
re-keys the FM EG while the level macros play their own `#rel` through the
taps — `:vel [15 #rel 11 7 3]` makes each tap quieter — and the channel keys
off a step after the last tap. While a
`:keyon` macro is active it owns the channel keying.

| Form                           | Result                                    |
| ------------------------------ | ----------------------------------------- |
| `:keyon 1`                     | Fire every `:step`                        |
| `:keyon 0`                     | Never fire (= omitting `:keyon`)          |
| `:keyon [1]`                   | Nothing — step 0 is the note's own attack |
| `:keyon [#sus 1 0]`           | Alternate steps                           |
| `:keyon (square 0..1 :duty 128 :len 8)` | Duty-gated regular retrigger (period: one 8th) |
| `:keyon (noise :from 0 :to 1 :len 1)` | Probabilistic retrigger (~50 % per step) |

```lisp
(fm1 (macro :step 32 :keyon 1) c)                            ; drum roll
(fm2 (macro :step 1/16 :semi [#sus 0 4 7] :keyon 1) c)      ; retriggered arp
(fm4 (macro :step 1/8 :keyon [0 #rel 1 1 1]
            :vel   [15 #rel 11 7 3]) c)                     ; echo tail
```

---

## 11. Curves

Curve forms appear in macros, inline parameter sweeps, `:tempo`, `:csm-rate`,
and `(delay …)` — except the stochastic curves, which are macro-only (below):

```text
(curve-name :from A :to B :len L …optional-params)
(curve-name A..B :len L …)        ; positional range sugar for :from/:to
```

`A..B` is shorthand for `:from A :to B` (signed decimals; `40..0` descends).
Its ends are numbers only — the range is one token, so a `let` name or an
expression as an end goes in `:from` / `:to` (`0..n` is
`E_CURVE_RANGE_MALFORMED`).
It works anywhere a curve does, including inside arithmetic
(`(* (sin -1..1 :len 8f) 40)`) and score `:tempo (linear 120..80 :len 4)`.
Combining it with an explicit `:from`/`:to`, or two ranges, is
`E_CURVE_RANGE_CONFLICT`; a `..`-token that is not a clean `A..B` is
`E_CURVE_RANGE_MALFORMED`.

### Names

| Family      | Names                                                                 | Loops by default |
| ----------- | --------------------------------------------------------------------- | ---------------- |
| Linear      | `linear`                                                              | no               |
| Easing      | `ease-in`, `ease-out`, `ease-inout` (quad aliases) and `ease-{in,out,inout}-{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}` | no |
| Loop waves  | `sin`, `triangle`, `square`, `saw`, `ramp`                            | yes              |
| Stochastic  | `noise`, `pink`, `perlin`, `brown`                                    | yes              |

**The stochastic curves are macro-only.** A macro samples a curve into the
table the driver steps, so noise arrives as its values; an inline sweep
(`:tl1 (brown …)`, `:tempo`, `:csm-rate`) carries only a curve id, and the
driver has no random source to evaluate one with. One written there is
`E_CURVE_MACRO_ONLY` rather than noise in the preview and a straight ramp on
the driver. `(delay …)` takes them: its envelope is sampled at compile time.

Loop-wave and stochastic curves cycle until key-off; `:mode loop` makes any
other curve cycle (a looping sustain stage), and `:mode shot` plays a looping
one once (a bad value is `E_CURVE_MODE`). Loop direction
is forward only.

`curve-name` above is a placeholder — write a real name from the table. A
`(…)` in a curve position whose head is not one of these names (a typo, or the
literal word `curve`) is rejected with `E_EVAL_UNKNOWN_HEAD`, as any unknown
function is.

**Parameter values.** Every numeric parameter below takes a compile-time
value: a number, a `let` name (§7.2), a `def` constant, or an expression
(`:to (* 2 10)`, `:phase (+ root 4)`, §7.1), folded when the score compiles.
A length parameter (`:len`, `:hold`, `:wait`, a stage's `(wait …)`) reads a
computed number as the same bare number would read — a note denominator,
`(* 2 4)` ≡ `8` (§7.4) — and takes a `(ticks …)` / `(frames …)` bridge for an
absolute count; an integer parameter (`:phase`, `:duty`, `:skew`, `:octaves`,
`:seed`) rounds it. A curve's `:from`, `:to`, `:len` and `:rate` also take a bare
`$slot` (§8), but not an expression with a `$` in it (`E_CURVE_PARAM_RUNTIME`).

```lisp
(fm1 (let [top 40]
       (macro :tl1 (sin :from 0 :to top :len (* 2 4) :phase (/ 256 4))))
     c e g)
```

### Common parameters (all curves)

| Key      | Type          | Default | Meaning                                     |
| -------- | ------------- | ------- | ------------------------------------------- |
| `:from` `:to` | number   | see below | Endpoints (accept `$slot`, §8); `:to` defaults to 0 |
| `:len`   | length token  | —       | Duration; ticks, or absolute frames with `Nf`; accepts `$slot` |
| `:phase` | int 0–255     | `0`     | Start phase offset                          |
| `:rate`  | number ≥ 0    | `1.0`   | Phase speed multiplier (relative to `:len`); `0` freezes the curve at its start phase; accepts `$slot` |
| `:mode`  | `loop`/`shot` | per curve | Cycle until key-off, or play once         |
| `:wait`  | length token or `key-off` | — | Delay before the curve starts — in a `(macro …)` or a stage |

An omitted **`:from`** means one thing: *start where the parameter is now.*
That is only knowable where the curve runs against a live value — an inline
sweep (`:tl1 (linear :to 60 :len 2)`, `:vol`, a PSG level, `:pitch`) reads the
parameter when it starts, and `:tempo` starts from the tempo in force. A macro
curve is baked per note, a `(delay …)` envelope and a PCM range point are laid
out at compile time, and arithmetic on a curve shifts its start — so those
need the `:from` written (`E_CURVE_FROM`). The one macro curve that may leave
it out is a release's (§10): the driver reads where the macro is at the
key-off.

**`:wait`** delays a curve where it runs per note — in a `(macro …)` or as a
stage. An inline sweep starts where it is written, so a `:wait` on one does
nothing and is flagged `W_SWEEP_WAIT`; a `:wait` value that is neither a
length nor `key-off` is `W_WAIT_INVALID`, and the curve does not wait.

### Shape parameters

| Curves               | Key     | Range      | Default | Meaning              |
| -------------------- | ------- | ---------- | ------- | -------------------- |
| `square`             | `:duty` | 1–255      | `128`   | Duty cycle           |
| `sin` `triangle` `saw` `ramp` | `:skew` | −127–127 | `0` | Shape skew         |

### Stochastic parameters

| Curves    | Key            | Range     | Default | Meaning                          |
| --------- | -------------- | --------- | ------- | -------------------------------- |
| all four  | `:hold`        | length    | none    | Sample-and-hold: each value is held this long (`8`, `16.`, `3f`), whatever `:len` and `:rate` are; needs a literal `:len` (`E_CURVE_HOLD`, as is a `:hold` that is not a length) |
| all four  | `:jitter`      | 0.0–1.0   | `0.0`   | High-frequency randomness mix    |
| all four  | `:seed`        | u32       | `0xDEAD`| RNG seed — a distinct sequence per seed (§11.1) |
| `pink`    | `:beta`        | > 0       | `1.0`   | Spectral tilt                    |
| `perlin`  | `:octaves`     | 1–8       | `3`     | Fractal octave count             |
| `perlin`  | `:lacunarity`  | > 0       | `2.0`   | Frequency ratio per octave       |
| `perlin`  | `:persistence` | > 0       | `0.5`   | Amplitude ratio per octave       |
| `brown`   | `:leak`        | 0–0.9999  | `0.99`  | Integrator leak coefficient      |

Normalization rules:

- Unknown keyword for a curve name → `E_CURVE_PARAM_UNKNOWN` (error).
- A bare value where a param belongs → `E_CURVE_STRAY_VALUE` (error): the
  ends are `A..B` (or `:from` / `:to`) and every option is written
  `:key value`, so `(noise -12..12 3)` names no seed — write `:seed 3`.
  A comment is not an element of the form and may sit anywhere inside it.
- Out-of-range values are clamped with `W_CURVE_PARAM_CLAMPED`.
- A value that does not read as a number (`:phase x`, `:len 8x`) is ignored,
  with `W_CURVE_PARAM_INVALID`; an expression with a `$` is
  `E_CURVE_PARAM_RUNTIME`, and one that yields a curve is `E_EVAL_TYPE`.
- All params are part of the LUT identity; identical curve + params
  combinations share one LUT.

### 11.1 Curves as values (`:seed`, arithmetic)

A curve is a first-class value: arithmetic composes with it — a scalar shift or
scale stays a symbolic curve, two curves multiply/add into a baked step vector.
See §7.1.1.

Stochastic curves (`noise`/`pink`/`perlin`/`brown`) default to seed `0xDEAD`, so
a seedless source is always byte-identical. `:seed N` (any u32) regenerates a
**statistically independent** sequence, adjacent seeds included — unlike `:phase`, which shifts the same
table. The seed is compile-time only (the driver replays the sampled values);
distinct seeds bake distinct data. A seed picks a character of movement, not
a different run each playback: the same score always moves the same way.

```lisp
(sqr1 (macro :pitch (noise :from -60 :to 60 :len 4f :seed 1))  c c c c)
```

**A draw.** Where a number is needed — a `(note …)` pitch, a length
(`(ticks …)`, `(frames …)`), an inline value, `round` / `floor` / `min` /
`max` / `abs` — a `noise` curve is not a movement but one draw from its
range: `(+ 60 (noise 0..12))` is a number between 60 and 72. Every draw
advances the seed's stream, in the score's order, so written notes draw
different values and the same score always draws the same; `:seed` is another
stream. `(for …)` draws on every pass, `(x N …)` plays its one draw N times
(the driver repeats it), and a `let` name bound to the curve draws at each
use — bind `(round (noise …))` to hold one draw. `pink`, `perlin` and
`brown` are movement and stay curves there (`E_EVAL_TYPE`).

`noise` is two words of the language, told apart by where it stands: at the
head of a top-level form it is the PSG channel (§2), and where a value goes it
is this curve. The editor's hover and completion read the position the same
way, so each shows the one in hand.

```lisp
(fm1 (macro :tl1 (brown :from 24 :to 34 :len 4 :rate 0.5 :hold 16 :leak 0.995))
  c e g e)
(sqr1 (macro :pitch (pink :from -40 :to 40 :len 8 :beta 1.2 :phase 32))
  c c c c)
(fm2 (macro :pan (perlin :from -1 :to 1 :len 16 :octaves 4 :persistence 0.6))
  c _ c _)
```

---

## 12. Echo and delay

Both replay written notes relative to each note's own value and read their
arguments the same way: `[N] :vel+|:vel* V`. As everywhere (§7.0), the value
after `:vel+` is what is added and after `:vel*` what multiplies — here per
tap:

| `V`              | Taps                                  | Tap k                          |
| ---------------- | ------------------------------------- | ------------------------------ |
| a number `step`  | `N` (required)                        | `vel + k·step` / `vel · step^k` |
| `[d1 d2 …]`      | one per element (no `N`)              | `vel + dk` / `vel · dk`        |
| `(curve …)`      | its `:len ÷` the spacing (no `N`)     | `vel + c(t)` / `vel · c(t)`    |

The keyword is `:vel+` or `:vel*` (`E_ECHO_TARGET` / `E_DELAY_TARGET`); a
number without `N`, or an `N` with a vector or a curve, is `E_ECHO_ARGS` /
`E_DELAY_ARGS`. A curve needs its `:from` (§11).

### `(echo …)` — phrase-lengthening replay

```text
(echo [N] :vel+|:vel* V [:back B])
```

One-shot at its position in the note stream (not sticky). Replays the single
note `B` positions back (`:back 1` = the last note, the default; history depth
9) — before the track's first note there is none (`W_ECHO_NO_NOTE`; the
sticky form is `(delay …)`). The taps are spaced by — and play at — the
**current** `:len`/`:gate` (mucom `\=` semantics), not the source note's, and
occupy real time, so following notes shift back. A tap plays in the track's
current voice, so a `def-mod :voice` (§9.4) selects it as it does a written
note. On a pcm track a tap replays the note's own sample (and its `:mode`) at
its pitch. On an FM3 operator track (`fm3-1`…`fm3-4`) a tap keys that
operator alone, as the written note does.

```lisp
(fm1 c (echo 3 :vel+ -1)          ; vel−1, −2, −3 decaying trail
     c (echo 3 :vel* 0.7)         ; ×0.7, ×0.49, ×0.343
     c e (echo 1 :vel+ -4 :back 2)   ; replay the c once at vel−4
     c (echo :vel+ [-1 -4 -8]))      ; three taps, written out
```

### `(delay …)` — compile-time overlay

```text
(delay [N] :vel+|:vel* V :time T)
(delay none)          ; clear
(delay :vel none)     ; clear one target
```

Sticky track state: every following note emits echo copies at `+k·:time`, an
overlay that fills the gaps the written part leaves — it does **not** lengthen
the phrase.

- `:time T` — tap spacing (length token). Required (`E_DELAY_ARGS`).
- Monophonic priority: written notes win — a tap starting while a written
  note sounds is dropped, and one starting in a gap is cut short at the next
  written note. The dry note's `:gate` is where it lets the taps in: at full
  gate, a `:time` shorter than the note drops the taps it covers.
- Among taps, a newer one cuts the one still sounding; two on one tick keep
  the louder.
- Echo taps inherit the source note's articulation macros (`:keyon`, `:semi`,
  `:pitch`, operator macros, each with its own `:step`); the inherited `:vel`
  macro is rescaled so its peak matches the tap's velocity.
- Echoes are generated from the original note only — no feedback recursion.
  Cross-channel delay is out of scope: `def` the phrase and replay it on
  another channel.

```lisp
(fm1 (delay 3 :vel+ -4 :time 1/8)
  c e g e)                                     ; phrase + 3 decaying repeats
(fm1 (delay 3 :vel+ -4 :time 8.)
  :len 4 :gate 8. c _ g _)                     ; the dry note lets the taps in at 8.
(fm2 :len 16 (delay :vel* (linear 0.8..0 :len 4) :time 16)
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
- A loop resumes **at** the label: what is written before it plays once, even
  on the same tick — a leading `:tempo`, `:lfo-rate`, voice or `:vel` ahead of
  `#label` is not re-applied on the passes that loop back.
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
| `(glide T)`        | Portamento into each following note, from the pitch sounding, over `T` (length token) |
| `(glide from T)`   | One-shot override: next glide starts from absolute pitch `from` (note + octave, e.g. `f5`) |
| `(glide none)`     | Disable                                                     |

A `T` that is neither a length nor `none` leaves the glide as it was, with
`W_GLIDE_INVALID`.

Glide emits a bounded `NOTE_PITCH` sweep before the `NOTE_ON`: a cent offset
from the pitch sounding at the key-on to the note's own pitch over `T`, then
stopping. The pitch sounding is the previous note's — or, while the previous
glide is still under way, where that glide has got to: a `T` longer than the
note is a slow portamento, a pitch lagging behind the notes with no jump at
any of them, as on a mono synth. A glide lands on the sticky `:pitch` offset
(a literal one; one set by a curve or a `$value` is runtime, and the glide
lands on 0).

A glide never bleeds into a note that does not glide: a note after `(glide
none)` (or an echo's replay) starts at its own pitch, ending a glide still
running there. A `:pitch` write ends it too. The first note of a track never
glides. Where the glide has got to is reckoned at compile time, so under a
tempo change mid-glide it is approximate; across a loop's jump the first note
of the body starts from where the first pass entered it.

On `fm3-csm-rate`, glide instead slides the Timer A rate between rate notes
by the same rule: a swept `CSM_RATE {from,to,len}` from the rate running at
the note — a slide still under way included — over the full `T`; a rate
note with no glide ends a running slide. The `(glide from T)` override
accepts a raw Hz literal or a pitch.

```lisp
(fm1 (glide 8) c e (glide f5 32) g (glide none) c)
```

---

## 15. FM3 modes and CSM

### Independent-operator mode

`fm3-1`–`fm3-4` each drive one operator's F-number as a monophonic track;
their presence enables the mode (`FM3_MODE op` at tick 0). The shared patch
(ALG, FB, per-op TL/ADSR) is declared with a note-less `(fm3 voice)` form —
a note on it is `E_FM3_MODE_CONFLICT`.
Pitch is per operator: `:pitch`, `(glide …)`, an inline `:pitch (curve …)`
sweep and the `:pitch` / `:semi` macros on an `fm3-N` track bend that
operator's F-number alone, `:keyon` re-attacks that operator alone — the others
keep sounding — and `:vel`/`:vol` are that operator's own level. The `(fm3 …)`
track keeps `:vol` as the **group fader** over all four, and `:master` is
global as ever; the three compose on one dB ladder. The patch is the shared
channel's: any other parameter written on an `fm3-N` track — `:alg`, `:fb`,
an operator's `:tl2`/`:ar3`/`:ml4`…, `:pan` — inline, relative or as a macro,
applies to the `fm3` patch as if written there. On alg 7 (four operators in parallel) each `fm3-N` is a voice with
its own fader; on an algorithm where the operator modulates, its level is
modulation depth rather than volume.

```lisp
(def-fm kit init-fm :alg 7 :tl1 20 :tl2 30 :tl3 25 :tl4 0)

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
of the `fm3-csm` event stream**. **A rest on the rate source rests the buzz**:
Timer A stops (CSM stays on) and the next rate starts it again — a rest on the
`fm3-csm-rate` track, or, with an inline `:csm-rate`, a rest on the `fm3-csm`
track (whose next note starts it). With a rate track, an `fm3-csm` rest only
holds the formant; the buzz goes on. A rate glide runs on across a rest.
Clearing CSM on `STOP_TRACK` is a driver duty.

Timer A frequency comes from exactly one source per score:

1. **Inline** `:csm-rate N` (constant Hz, or an expression: `(hz a3)`) or
   `:csm-rate (ease-out :from A :to B :len L)` (swept Hz) on the `fm3-csm`
   track, or
2. **Companion track** `fm3-csm-rate`, where note tokens convert to Hz at
   compile time. `:oct` range is 0–10 on this track only (values above are
   clamped, `W_CSM_RATE_OCT_CLAMPED`); bare numeric atoms are raw Hz literals
   for the range above `:oct 10`. `(glide …)` slides Hz between notes (§14).

Valid rate range: 52–53270 Hz, clamped with `W_CSM_RATE_CLAMPED`. An inline
`:csm-rate` that is neither a number nor a curve is `E_CSM_RATE_INVALID`. A score
with neither source produces no Timer A retrigger (fm3-csm plays silently).

```lisp
(def-fm brass init-fm :alg 4 :tl1 24 :tl3 24)

(fm3-csm brass :oct 4 :len 2
  c _ e _ g _)
(fm3-csm-rate :oct 6 :len 1
  c d e f  g a b 20000)    ; notes → Hz; raw Hz literal above oct 10
```

### CSM with formant tracks

A formant per operator — a vowel, a vocoder's voice — is CSM with the
operators as tracks: the independent-operator form's tracks under the CSM
buzz. A note-less `(fm3-csm voice)` declares the shared patch (a note on it
is `E_FM3_MODE_CONFLICT`), `fm3-1`–`fm3-4` each drive one operator exactly
as in independent-operator mode — its F-number from the notes, `:pitch` and
the pitch macros, its level from `:vel`/`:vol` and their macros — and the
`fm3-csm-rate` track is the voice itself: its rates are the pitch, a rest on
it a breath — Timer A holds and the formants fall silent until the next rate —
and the buzz plays exactly while it plays (the mode turns on at its start and
off at its end). It is the one rate source here: an inline
`:csm-rate` is `E_CSM_RATE_SOURCE_CONFLICT`, no rate track
`E_CSM_RATE_MISSING`.

Timer A keys the channel, so an operator's key is its level: a note turns the
operator's TL on, its gate (or a rest) turns it to 127, and a `:vol` table
shapes the formant frame by frame. As on a PSG note, a `:vel` / `:vol` macro's
release plays past the gate and the operator falls silent at its end — so a
phrase written `[onset… #sus vowel #rel tail…]` holds its vowel for the gate
and keeps its tail: a longer note is a longer vowel. When the rate track ends,
or the song stops, the operators fall silent with it — no key-off reaches an
operator Timer A keyed, and a slow RR (a held formant) would ring on. Each operator sounds for one Timer A period
and decays at its own RR — a fast release (`:rr 15`, `:ks 3`) is a wide
formant, a slow one a narrow, ringing one. `:keyon` has no meaning here:
every Timer A overflow is a retrigger.

```lisp
(def-fm vowel init-fm :alg 7 :rr1 15 :rr2 15 :rr3 15 :rr4 15 :ks1 3 :ks2 3 :ks3 3 :ks4 3)

(fm3-csm vowel)                          ; the patch — no notes here
(fm3-1 :oct 5 :len 2 c+ ~ c+)            ; F1 ≈ 550 Hz
(fm3-2 :oct 6 :len 2 f+ (macro :vol [31 28 24 20]) a)   ; F2 moves: "ah" to "eh"
(fm3-3 :oct 7 :len 1 d+ :vol 20)         ; F3, softer
(fm3-csm-rate :oct 2 :len 4 g g _ a)     ; the voice: pitch, a breath, pitch
```

---

## 16. PCM

Samples are declared with `(def-pcm name …)` and bound to a track by
naming one in its body, before the notes — and again wherever the sound
changes — as a voice is on FM. How many voices play at once is a whole-song choice (§1):

```lisp
(def-score :pcm-voices 3)
(def-pcm kick :file "sounds/kick.wav")
(def-pcm snare :file "sounds/snare.wav" :rate 11025)
(def-pcm pad :file "sounds/pad.wav" :loop-start 300ms :loop-len 100ms)

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

The table describes the default single-bank profiles. Every note a sample is
played at is baked separately, so the listed seconds are shared across all
baked copies. NTSC and PAL scores with up to three voices can exceed this combined
capacity using [multi-bank PCM](pcm-multibank.md): one or two banked voices
run at about 10.1 kHz on NTSC or 10.0 kHz on PAL, three at 6.65 or 6.59 kHz.
Each baked blob must still fit within 32,512 bytes, and the maximum of 256
entries remains.
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
| `:pcm-start` / `:pcm-end` / `:pcm-len` | The range a note plays, as LENGTHS (see *The range and the loop*) |
| `:loop-start` / `:loop-end` / `:loop-len` | The loop a held `loop` note repeats, inside the range |
| `:fx`     | The processing chain, `[(effect …) …]` — see *Effects* below   |

`:rate`, `:offset` and `:frames` are whole numbers; one that does not read
(`8k`, `1.5`) keeps the key's default, with `W_SAMPLE_KEY_INVALID` — as does a
`:rate` of 0 or below.

All conversion is compile-time: stereo is downmixed `(L+R)/2`, the `:fx`
chain runs, and the data becomes raw 8-bit signed PCM.

### Sample banks (many samples in one file)

`:offset` / `:frames` cut one sample out of a file that holds several — a drum
kit in a single wav, or an imported instrument bank. Both count **frames**, not
bytes, and a negative `:offset` or a non-positive `:frames` is `E_SAMPLE_SLICE`.

```lisp
(def-pcm kick :file "kit.wav" :offset 0    :frames 3904)
(def-pcm snare :file "kit.wav" :offset 3904 :frames 6400)

(pcm1 :len 8  kick c snare c  kick c c)
```

The file is decoded once and shared by every def that slices it, so a bank costs
no more than a single sample would. The range and loop points are **relative to
the slice**, not to the file — a def is one sample, so its points don't move
when `:offset` changes.

**A relative `:file` resolves against the file that defined it** — the score for
a def written there, and the imported file for one folded in by `import` (§9.2).
So a preset set keeps its samples next to itself: `:file "wav/kick.wav"` inside
`presets/tr808/set.mmlisp` reads `presets/tr808/wav/kick.wav`, however deep the
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

**Dropping a wav** writes its def at the cursor — `(def-pcm kick :file "…")`,
no `:rate`, so the wav's own rate stands. A wav dragged out of the opened folder
gets the correct folder-relative path (`"sounds/kick.wav"`); one dragged from
anywhere else gets its bare name and is decoded into memory, so it plays at once
but needs to be moved next to the score (and the folder reopened) to survive a
reload. Only `.wav` is accepted: the browser would decode mp3/flac/ogg too, but
the exporters read RIFF WAV only, so those are refused with a message rather
than left to break at export time.

Full drop routing for every accepted format: `guide.md` §23.

### The range and the loop

A PCM note plays between four points, all **lengths** — the same grammar as
`:len` and `:gate` (§4), including `Nms`, which is what you want when the point
is a place in the wave rather than a place in the bar:

```
:pcm-start ── :loop-start ════ :loop-end ── :pcm-end
  the head       repeated while held          the tail
```

- **The range**, `:pcm-start` / `:pcm-end` / `:pcm-len`, is the part of the
  sample a note plays. With none set it is the whole sample; a missing start
  is the sample's start, a missing end its end.
- **The loop**, `:loop-start` / `:loop-end` / `:loop-len`, is the part a held
  `loop` note repeats. It sits inside the range; a loop point left out follows
  the range, so with none set the loop is the whole range. On a def, the four
  must keep their order — `pcm-start ≤ loop-start < loop-end ≤ pcm-end` —
  or it is `E_SAMPLE_RANGE`; on a track they are clamped into it.

A **shot** plays the range once and ignores the loop; a **`gate` note** plays
it the same way and is cut at its gate. A **`loop` note** starts
at `:pcm-start`, plays on to `:loop-end`, repeats `[:loop-start, :loop-end)`
while it is held, and at its note-off plays on from where it is to `:pcm-end`
and parks (*Playback*, below). `:pcm-end` and `:pcm-len` both set the range's
far bound, `:loop-end` and `:loop-len` the loop's — one pins the end, the other
the length, which differ once the start moves (see below) — and the last one
written is the one in force.

They belong on a `def` and on a track, and they mean the same thing in both —
unlike `:offset` / `:frames`, which cut a sample out of a file and decide the
bytes that go into the bank. The four points are what a note plays of those
bytes. On a def they are the sample's own:

```lisp
(def-pcm pad :file "pad.wav" :loop-start 300ms :loop-len 100ms) ; attack, then a 100 ms loop
(def-pcm crash-tail :file "crash.wav" :pcm-start 400ms)       ; a shot from 400 ms on
(def-pcm strings :file "str.wav"
  :pcm-start 20ms :loop-start 300ms :loop-end 600ms :pcm-end 1200ms)
```

On a track they set the points of the notes that follow, like any track
parameter — laid over the def's, and kept until the next write — and they MOVE
them while a note sounds, as a literal or as a curve, a thing no other Mega
Drive driver offers:

```lisp
(pcm1 pad :mode loop :len 1
  :loop-start 300ms :loop-len 16                    c ; a 16th-note loop, head fixed
  :loop-len (linear :from 100ms :to 2ms :len 2)     c ; tighten it to a buzz
  :loop-len 100ms
  :loop-start (linear :from 100ms :to 900ms :len 2) c) ; slide it through the sample
```

A curve keeps its last value too: the second line ends at 2 ms, which is why
the third sets `:loop-len` again. A `…-len` holds the length when its start
moves — which is what the third line relies on. A `…-end` pins the end
instead, and then moving the start changes the length. A curve's ends are
lengths too, so write `:from` and `:to` rather than the `A..B` range sugar
(`8...4` would be unreadable).

Limits worth knowing:

- **The engine rounds the points to 16 bytes** — 1.11 ms at `pcm-voices 1`,
  1.58 at 2, 2.40 at 3. A loop's ends round to the nearest block, and that is
  also the shortest loop there is, so the highest buzz `pcm1` reaches is about
  900 Hz and the pitches below it are `14375.7 / 16n` Hz. **This is a
  rhythmic device, not a pitch one.** The range is widened to whole blocks —
  the start down, the end up — so a note plays at least what you wrote.
- While a note sounds, a write moves its loop and its end; a moved
  `:pcm-start` reaches the next start (a note, or a `:keyon` step). After a
  loop note's note-off only `:pcm-end` still moves it.
- **Frame of reference.** On a def the value is time in the sample's own
  recording, so a point stays where you set it however the note transposes. On
  a track it is time as you HEAR it, so `:loop-len 16` is a 16th note at every
  pitch. At C4 the two coincide.
- A point written on a track — inline or in a `(param-set …)` — that is not a
  length is `E_PCM_RANGE_LENGTH`; one on a channel other than `pcm1`–`pcm3` is
  `E_UNSUPPORTED_TARGET`.

### Effects

A def's `:fx` takes a `[...]` of effects, applied **in order** to the
sample when it is baked. They are compile-time sample processing: the driver
never runs them, so they cost no Z80 time — only what they do to the bank
(a fade saves bytes). Use them to make a sample hold its own against FM:

```lisp
(def-pcm snare :file "snare.wav"
  :fx [(comp :threshold -30 :ratio 8)
           (normalize)
           (fade :at 120ms :len 80ms :curve ease-out-expo)])
```

Each effect is `(name :param value …)`; a param left out takes its default.
Levels are dB (plain numbers), times are lengths (§4 — `Nms` is the usual
choice, as for the range).

| Effect | Does |
| --- | --- |
| `gain` | Scales the level |
| `normalize` | Scales so the peak lands on `:peak` dBFS |
| `comp` | Compressor: above the threshold the level rises 1/`:ratio` as fast, over a soft knee `:knee` dB wide |
| `limit` | Brickwall limiter with a 2 ms lookahead: the peak never passes `:ceiling` dBFS |
| `crush` | Quantizes to N bits — the lo-fi step |
| `hpf` | High-pass filter, 12 dB/oct: cuts below `:freq` — a low cut also buys level headroom |
| `lpf` | Low-pass filter, 12 dB/oct: cuts above `:freq` — darker, duller |
| `drive` | Soft saturation (tanh): adds distortion and density, a full-scale peak stays at full scale |
| `fade` | Fades to silence from `:at` over `:len` and **cuts the sample there** |
| `reverb` | Freeverb-style room; **grows the sample by `:tail`** and fades the tail out over it |

Parameters — a positional value fills the one marked *positional*
(`(gain 6)` is `(gain :db 6)`); anything outside a range is
`E_SAMPLE_FX_PARAM`:

| Effect | Param | Value | Range | Default | Does |
| --- | --- | --- | --- | --- | --- |
| `gain` | `:db` | dB | any | required, *positional* | Positive is louder, negative quieter. Nothing clips until the chain ends |
| `normalize` | `:peak` | dBFS | ≤ 0 | `0` | Where the loudest point lands: `0` is full scale, `-1` leaves 1 dB of headroom |
| `comp` | `:threshold` | dBFS | ≤ 0 | `-18` | The level above which it squeezes. Lower catches more of the sound — the body, not just the hit |
| | `:ratio` | ratio (`4` = 4:1) | ≥ 1 | `4` | How hard: at 4, 4 dB over the threshold comes out as 1 dB over. `1` does nothing; `20` and up is close to a limiter |
| | `:attack` | length | ≥ 0 (`0ms` = instant) | `0ms` | How fast it clamps down. `0ms` catches the transient; a few ms lets the click through (punchier, but a following `normalize` scales to that click) |
| | `:release` | length | ≥ 0 | `20ms` | How fast it lets go. Shorter gives back more loudness between hits; on a low sound a very short one follows the waveform and adds grit |
| | `:knee` | dB (width) | ≥ 0 (`0` = hard knee) | `6` | How gradually it starts around the threshold: `0` switches on at the threshold, wider eases in |
| | `:makeup` | dB | any | `0` | Gain after compressing — the same as a `gain` after `comp` |
| `limit` | `:ceiling` | dBFS | ≤ 0 | `0` | The level no peak passes (the lookahead is a fixed 2 ms, so it never overshoots) |
| | `:release` | length | ≥ 0 | `5ms` | How fast the gain comes back after a peak. Shorter is louder; longer is smoother and quieter |
| `crush` | `:bits` | integer | 1–8 | required, *positional* | The steps the wave keeps: `8` changes nothing (the bank is 8-bit), `4` is gritty, `1`–`2` near a square wave |
| `hpf` | `:freq` | Hz | ≥ 1 | required, *positional* | The cutoff, −3 dB there. At 95% of the sample's Nyquist (half its rate) or above it is pulled to that 95%, with `W_SAMPLE_FX_FREQ` |
| `lpf` | `:freq` | Hz | ≥ 1 | required, *positional* | As `hpf`, from the other side |
| `drive` | `:db` | dB | ≥ 0 | required, *positional* | Gain into the saturation: `6` thickens, `18` and up is plainly distorted. The output is scaled back, so a full-scale input stays full scale and quieter parts come up |
| `fade` | `:len` | length | > 0 | required | How long the fade takes, from `:at` to silence |
| | `:at` | length, from the sample's start | ≥ 0 | `:len` before the end | Where the fade starts. Everything after `:at` + `:len` is cut |
| | `:curve` | a one-shot curve name — *Fade curves* below | not a looping curve | `linear` | The fade's shape |
| `reverb` | `:tail` | length | > 0 | required | How much is added after the sample; the tail fades out over it. This is the bank cost |
| | `:size` | 0–1 | 0–1 | `0.5` | Room size: higher decays longer (within `:tail`) |
| | `:damp` | 0–1 | 0–1 | `0.5` | How fast the highs die away: higher is darker, lower brighter and more metallic |
| | `:mix` | 0–1 | 0–1 | `0.3` | Wet share: `0` is the dry sample only, `1` the reverb only |
| | `:predelay` | length | ≥ 0 | `0ms` | A gap before the reverb starts — keeps the hit clear of its room |

Numbers are plain decimals (`-18`, `1.5`); lengths are §4 lengths (`60ms`,
`16`, `4f`).

**Fade curves.** `:curve` takes any one-shot curve of §11, and the fade's
gain is **1 − curve**, so each shape reads as follows:

| `:curve` | The level over the fade | For |
| --- | --- | --- |
| `linear` | Falls at an even rate | A plain fade |
| `ease-out`, `ease-out-{sine,quad,cubic,quart,quint,expo,circ}` | Drops fast, then tails off — steeper from `sine` to `expo` (`expo` is at half level a tenth of the way in) | A natural decay: shortening a drum's or cymbal's tail |
| `ease-in`, `ease-in-{sine,quad,cubic,quart,quint,expo,circ}` | Holds near full, then falls away at the end — sharper from `sine` to `expo` | Gate-like: keep the body, then cut |
| `ease-inout`, `ease-inout-{sine,quad,cubic,quart,quint,expo,circ}` | S-shaped: slow, fast, slow | A smooth rounding-off |
| `ease-in-back` | Swells about 10% above full, then falls | A lift before the cut |
| `ease-out-back` | Drops fast, dips about 10% below zero (the wave flips phase), then settles to silence | A subtly odd decay |
| `ease-inout-back` | Both of the above: a swell, then a dip past zero | — |
| `ease-in-elastic` | Wobbles and swells up to about 1.4× near the end, then snaps to silence | Effects |
| `ease-out-elastic` | Drops at once, then rings around zero with the phase flipping, dying away | Effects: a buzzing wobble |
| `ease-inout-elastic` | Both of the above | — |
| `ease-out-bounce` | Falls to near silence, bounces back up (to about 25%), falls again, smaller each time | A stutter or bouncing-ball decay |
| `ease-in-bounce` | Small dips early, then one long fall | A fade with a flutter in it |
| `ease-inout-bounce` | Both of the above | — |

The `ease-in`, `ease-out` and `ease-inout` without a suffix are `quad`. A
looping curve (`sin`, `triangle`, `square`, `saw`, `ramp`, `noise`, `pink`,
`perlin`, `brown`) is `E_SAMPLE_FX_PARAM`.

- **Louder is two idioms.** A sample already at full scale (the presets are)
  gets louder only by bringing its body up to its peak:
  `(comp :threshold -30 :ratio 8) (normalize)` — squeeze, then put the peak
  back at full scale — or `(gain 12) (limit)` — push, then cap. Each is about
  +4–6 dB of RMS on a drum. **`comp` alone makes a sample quieter**: it takes
  level off the peaks and nothing puts it back, so end the chain with
  `normalize` (a `gain` too small for what `comp` took, before a `limit`, ends
  up quieter than the dry sample).
- **Nothing clips inside the chain.** The one hard clip is the 8-bit quantize
  at its end, so a `gain` that overshoots is caught by a later `limit` or
  `normalize` — or clips there, which `crush` aside is rarely the sound you
  want.
- **The defaults are for short hits**: an instant `:attack`, and releases
  (`comp` 20 ms, `limit` 5 ms) fast enough to let go between a drum's
  transient and its body. A slower `:release` holds the transient's reduction
  over the body and gives back less loudness; a slower `:attack` lets the
  transient through, and a following `normalize` scales to that spike. On a
  long, low sound a fast release follows the waveform and adds grit — raise
  it there.
- **Times are the sample's own time**, like the def's range: a sample
  played an octave up plays its fade in half the time.
- **A fade inside the loop** is baked into the bytes the loop repeats, so it
  warns (`W_SAMPLE_FX_FADE_LOOP`); a fade that runs past the sample's end
  warns `W_SAMPLE_FX_FADE_PAST_END`. A `loop` note on a def with no range
  loops the whole sample, fade included.
- **A reverb costs its `:tail` in bank bytes** — at `pcm-voices 1`, 250 ms
  is about 3.6 KB, per note the sample is played at — which is why the tail is
  yours to set. It is baked into each def, not a shared bus: **the next note on
  the same voice cuts it**, so it rings on spaced hits (a backbeat snare, an
  effect) and all but vanishes on a busy hat. Short rooms and plates (0.2–0.6
  s) suit 8 bits best; a long tail decays into quantization grain. A reverb on
  a def with a range extends the sample the range can reach.
- **Loud samples overlap loud.** Voices are summed and hard-clipped (above),
  so a kit brought up to full scale distorts where hits overlap — trade that
  against `:vel` / `:vol`.
- **A kit, or a variant.** `(import "kit" :fx [...])` processes every
  sample of a kit (§9.2); its chain runs before each def's own.
  `(def-pcm snare-hot snare :fx [...])` is a variant of one sound: it
  takes the base's `:file` (still read from the base's folder), slice, range
  and effects — the import's chain included — and overrides the keys it
  writes; its own `:fx` replaces the base's, the import's stays in front.
  A base that is not a sample, or a cycle, is `E_SAMPLE_EXTENDS`.
  A variant is a def of its own, so playing both bakes both.
- An unknown effect is `E_SAMPLE_FX_UNKNOWN`; a bad or unknown param, or a
  missing required one, is `E_SAMPLE_FX_PARAM`; `:fx` given anything but
  a `[...]` is `E_SAMPLE_FX`.

### Playback

- **Pitch is baked, not played.** A note picks a blob resampled for that note;
  the voice then plays it back one byte a sample and cannot bend. So there is
  no practical-range clamp — any note works, it just costs bank space. What is
  rejected is every RUNTIME pitch move on a pcm track: `:pitch`, `:semi`,
  `(glide …)` and a `(macro :pitch …)` vibrato are `E_PCM_NO_PITCH` rather
  than silently dropped. (A chip that pitches its own sample voice takes
  them: `pc88`'s ADPCM-B, §19.)
- **`:mode`** is sticky track state like every other parameter — it holds
  until the next `:mode` — and it is the note, not the sample, that decides:
  `shot` (the default) plays the note's range once; `loop` plays the attack,
  cycles the range until KEY-OFF (a `PCM_NOTE_OFF` at the gate), then plays
  the release tail to the sample's end; `gate` plays the range once, as a
  shot, and stops it at the gate — the note's end at full gate. A note on a
  def with no range plays — or loops — the whole sample. Write `:mode shot`
  to go back.
  > A `shot` plays to its end regardless of the note's `length` / `gate`;
  > `loop` releases at KEY-OFF and `gate` is cut there (a shot's macros take
  > their release there too, below).
  > A `gate` note's sound ends at its gate, so the release section (`#rel`)
  > of its `:vel` and `:vol` macros is not heard: a fade before the cut is
  > written inside the gate. A `:keyon` step in the release section strikes
  > the sample again, and that strike plays the range through, as a shot.
  > The cut lands at the voice's next block edge after the gate's frame —
  > and, as when a note cuts the one before it, it can click.

  ```lisp
  (def-pcm hat :file "sounds/hat.wav")
  (pcm1 hat :mode gate :len 16 :gate 32 c c c :gate 16 c)   ; a closed hat, then an open one
  ```
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
- **Macros** (§10) on a pcm track drive `:keyon`, `:vel` and `:vol`. A
  `:keyon` step plays the blob again from its start — a roll, a flam, a
  stutter — and restarts the note's `:vel` / `:vol` envelopes, as it re-attacks
  an FM or PSG note; after key-off (an echo tail) it re-plays the released
  blob once through. `:vel` and `:vol` move the voice's level on the 6 dB
  ladder above. Every other target is a chip register a soft-mixed voice does
  not have: `E_PCM_MACRO_TARGET` (the pitch ones stay `E_PCM_NO_PITCH`). A
  shot's gate is its key-off for its macros — a release region starts there
  while the blob plays on.

  ```lisp
  (def-pcm snare :file "sounds/snare.wav")
  (pcm2 snare :len 4
    c (macro :step 1/32 :keyon [1 1 1 1 1 1 1 1]) (macro :vel (linear 8..15 :len 4f)) c)
  ```
- A PCM note without a bound sample is `E_PCM_SAMPLE_REQUIRED`; a word that
  names no def is `E_UNKNOWN_ATOM`. `:mode shot`/`loop`/`gate` and
  the range keys on any other channel (fm6 included — it is FM only) are
  `E_UNSUPPORTED_TARGET`. A def-pcm key it does not have is
  `E_UNKNOWN_KEYWORD`; a range that is not a length, or ends at or before it
  starts, is `E_SAMPLE_RANGE`.

---

## 17. Holds — `len 0` and `gate 0`

| Form      | KEY-ON | Timeline advances | KEY-OFF                        |
| --------- | ------ | ----------------- | ------------------------------ |
| `:gate 0` | yes    | yes (by `:len`)   | runtime (`triggerKeyOff` / host `KEY_OFF`) |
| `:len 0`  | yes    | **no**            | runtime                        |

`:gate 0` keeps the channel in sync with others while holding; `:len 0`
**stops its track** there: what follows waits for the key-off, then plays on
from it, the track's clock moved on by however long it held (driver.md §2.4)
— a charge-up held while the button is down, then its release shot. Both
enable game-state-driven sounds: the note holds until the host sends
`KEY_OFF` or `STOP_TRACK`, firing any `#rel` release macros. In MMLisp Live,
Tools > Release Holds (⌘⇧↩ / Ctrl+Shift+Enter) is that key-off.

A hold is the one place a following note does **not** re-attack on FM: the
channel is still keyed, so the next note moves the pitch and the envelope
carries on — `:gate 0 c e g` sounds like `c ~ e ~ g`, and reads as a sticky
legato passage. That is deliberate. The key-off belongs to the runtime here,
which is what the form is for, and unlike a full gate (§5) the hold is
something the score asked for in writing. A rest or `END_OF_TRACK` still ends
it, and on PSG every note-on re-asserts its attenuation, so PSG re-attacks
either way.

```lisp
(sqr1 :len 0 (macro :vel [15 #sus 14 13 #rel 8 4 0])
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

---

## 19. Targets — `:target`

A score is written for one machine, `(def-score :target …)` (§1). The
language is one; a target decides which chips its channels drive, and what
those chips cannot do is a compile error, not a different sound.

| Target | Machine | Delivered as |
| --- | --- | --- |
| `md` (default) | Sega Mega Drive: YM2612 + SN76489, PCM on fm6's DAC | MMB for MMLispDRV, VGM, WAV |
| `pc88` | NEC PC-8801 with Sound Board II: YM2608 (FM, SSG, rhythm, ADPCM-B) | VGM, WAV |
| `x68k` | Sharp X68000: YM2151 (FM, its noise), PCM8 on the MSM6258 | VGM, WAV |
| `msx` | MSX: the PSG, an AY-3-8910, and the SCC (K051649) and FM-PAC (YM2413) cartridges | VGM, WAV |
| `pce` | NEC PC Engine: the HuC6280's six wave channels, two of them noise | VGM, WAV |
| `fc` | Nintendo Famicom: the 2A03's two pulses, triangle and noise | VGM, WAV |

**`pc88` exports VGM (1.51)**: FM, the SSG, the rhythm and the ADPCM-B, its
samples baked into the chip's RAM image, which the VGM carries. Play and WAV
run ymfm's YM2608. The rhythm sounds are the chip's ROM, Yamaha's, which
MMLisp does not ship: the VGM keys them and a player supplies them, and Live
plays them from the user's own ROM (File ▸ Import ▸ YM2608 Rhythm ROM…, 8 KB, kept
in the browser). Without it the score's kit stands in: each role's `:file`,
encoded as the chip's ADPCM-A into the ROM's layout and cut to the ROM
sound's length (`kick` 48 ms, `snare` 69 ms, `ride` 0.64 s, `hat` 42 ms,
`tom4` 138 ms, `rim` 28 ms), plays with the hit's level and pan as the ROM
would; a built-in role with no `:file` is silent, and Play and WAV say so.
The MMB is the Mega Drive driver's and refuses a `pc88` score. What follows
is what the compiler holds a `pc88` score to.

**What a channel is.** Each of a target's channels is a *part* of one of
its chips — 4-op FM, the SN76489's square or noise, the SSG, a wavetable
channel, the ROM rhythm, a sample voice — and a part brings its own words: the FM operator keys, the
SN76489 noise's `white0`–`periodic3`, the SSG's `:noise-rate`, a sample
voice's range points, `:pan` where the chip pans (FM, the ADPCM-B, the ROM
rhythm). A part's word on another part's channel — `:tl1` on `sqr1`, `:pan`
on a PSG track, `:mode white0` on `fm1` — is `E_UNSUPPORTED_TARGET`, inline,
in a macro and in a `(param-set …)`, on every target; a word only other
targets' parts have is `E_TARGET` (`:noise-rate` on `md`). The rest of the
language — notes, lengths, flow, `:vel`, `:vol`, `:pitch`, `:snap`, the
song-wide `:tempo` / `:master` / `:lfo-rate`, the curves and macros — is
every channel's on every target. A channel name only another target has is
`E_TARGET` too, and two names that are one physical channel on the target
(the SSG's `noise` and `sqr3`) cannot both be in a score.

A `def-fm` voice is data, not a word: named on a channel, it plays what that
channel's part has of it. A register the target's chips lack (SSG-EG on the
OPM, DT2 on the OPN) is left out with `W_TARGET` at the def; a voice named on
a channel with no FM (`sqr1`, `pcm1`) keeps only its `:key` there, with
`W_TARGET` once per track and voice. A `def-wave` is data the same way: named
on a channel with no wave memory it is left out, with `W_TARGET` once per
track and wave.

**The line.** A setting that has no meaning on the target is ignored with
`W_TARGET` (`:pcm-voices`, the Mega Drive's white noise modes, which read as
the nearest `:noise-rate`). Anything that would change what is heard is
`E_TARGET`.

**FM.** `fm1`–`fm6`, FM3's independent-operator mode and CSM are as on the
Mega Drive; `fm6` is a plain FM channel (there is no DAC to own). Pitches and
CSM rates are computed on the YM2608's clock.

**SSG.** `sqr1`–`sqr3` are the SSG's three channels. Each has a mixer,
`:mode tone|noise|both` (sticky, default `tone`), and the three share one
noise period, `:noise-rate 1–31` (lower is higher; song-wide, written on any
track, a value or a sweep, starting at 9). The `noise` track is `sqr3` with
its mixer on noise: a score has one or the other (`E_TARGET`), and a noise
note's pitch is not read. A noise `:mode white0`–`white2` reads as
`:noise-rate` 9, 18, 31 (`W_TARGET`); `white3` and the periodic modes have
no SSG sound (`E_TARGET`), nor does a `:mode` macro on noise. A note's
macro steps the mixer and the noise period as a drum moves them through its
hit: `(macro :mode [both noise])` on a sqr track, and `(macro :noise-rate
[2 4 6 8])` on a sqr or the noise track, which writes the song's one period
while the note sounds (the later write wins, as for `:env-rate`). A macro is
its note's: the next note without one has the track's `:mode` and the
song's `:noise-rate` back.

**The SSG's hardware envelope.** A channel's level can be the envelope the
three channels share instead of its own 4-bit one: **`:env 0–15`** (sticky,
on `sqr1`–`sqr3` and `noise`) puts it on, the number the chip's shape (R13 —
8 and 12 the saws, 10 and 14 the triangles, 0 and 9 a decay, 11 and 13 an
attack that holds), and `:env none` gives the channel its level back. Each
key-on starts the envelope over (a slur's `~` goes on); the level a note
composes from `:vel`, `:vol` and `:master` is not heard on it, though 0
still silences (`W_TARGET` once on a track that writes one). The envelope's
period is the song's **`:env-rate`**, written on any track as `:noise-rate`
is: a rate in Hz (a value, `(hz a2)`, or a sweep) for one cycle of its
shape, or **`:env-rate note`**, which follows the writing track's pitch from
its next note — pitch macros, glide and vibrato with it. A triangle's period
is halved, so the cycle sounds the note written: a rate is for the shape of
the track that writes it, as the track has it then.
**`:env-semi n`** moves the period a track gives — its notes', or a rate it
writes — by n semitones (−48–48; `-12` an octave below the tone), and
**`:env-detune n`** adds n register steps to it (−1000–1000; + is lower).
Each is sticky on the track, a number, a `$value` read at the write, or
`none` (0, no move); a
following period moves at once, a rate at the track's next `:env-rate`.
With the tone on (`:mode tone`), the tone gates the envelope, and a period a
step off the note's turns the two against each other: the timbre beats,
about 0.6 Hz a step at c2, faster as the note rises. The period is the chip's
tone period / 16, so a rate keeps to bass notes (at a4 one step is about a
semitone). **`:mode env`** turns the channel's tone and noise off: what it
plays is the envelope alone, a saw or a triangle at the rate — the buzzer.
The shape and the period are the chip's one: a channel's key-on starts
every channel's envelope over, and the later rate wins.

```lisp
(def-score :target msx)
(sqr1 :env 8 :env-rate note :mode env :oct 2 :len 8   ; a saw buzzer bass
  c c g g a a g _)
(sqr2 :env 8 :env-detune 1 :mode tone :oct 3 :len 2   ; the tone over it, beating
  c g)
```

**PCM.** `pcm1` is the ADPCM-B: it plays a sample's `:file`, one voice. A
sample is baked once — its def's range and `:fx`, at its own rate up to
22.05 kHz, as Yamaha ADPCM into the chip's 256 KB of RAM (a sample past it is
left out, and the export says so) — and a note plays it at the pitch's rate,
its level vel + vol + master as the chip's linear level, its pan the
track's. The chip pitches the voice while it plays (Delta-N), so `pcm1`
takes the pitch moves FM does — `:pitch`, `(glide …)`, `(macro :pitch …)`
and `(macro :semi …)` — though not `:snap`. A `shot` plays to the range's end, a `gate` note stops at its gate,
a `loop` repeats the range until then. A range the track writes
(`:pcm-start` …) is read at each key-on, rounded to 8 frames; a curve there
is read as its start (`W_TARGET`).
`rhythm1`–`rhythm6` play the six ROM rhythm sounds, named by the kits' roles
(guide.md, the kits) — as many tracks as the kit has sounds, so each sound
can have a track, its `:vol` and `:pan`, of its own:

| Name | `kick` | `snare` | `ride` | `hat` | `tom4` | `rim` |
| --- | --- | --- | --- | --- | --- | --- |
| ROM sound | BD | SD | TOP | HH | TOM | RIM |

The six are built in, as `init-fm` is, so they play with no def. A score's
own def of one of these names (a kit's, imported) plays the ROM sound on a
rhythm track and its `:file` on `pcm1`; a built-in one has no `:file`, so it
cannot play on `pcm1`. Any other sample on a rhythm track is `E_TARGET`. A
rhythm sound has no pitch (write it at c4) and no loop (`E_TARGET`), and a
pcm point (`:pcm-start` …) on a rhythm track is `E_TARGET`; its def's `:fx`
does not reach the ROM sound (`W_TARGET`). A rhythm track is one line, as
any channel is: its `:prio` layers (§1) compete — a lower one's hit is
dropped while a higher one's sounds — and its `:vol` and `:pan` are the
track's, one of each, for every sound it plays. Sounds that ring together
are on tracks of their own, as many as the kit has:

```lisp
(def-score :target pc88)

(rhythm1 kick :len 4 c c c c)
(rhythm2 hat :len 8 c c c c c c c c)          ; with every kick
(rhythm3 snare :pan right :len 2 _ c)         ; its own track, its own pan
(rhythm4 :prio 1 tom4 :len 4 c _ c _)
(rhythm4 :prio 2 rim :len 8 c c c c c c c c)  ; only where no tom sounds
```

A sounding voice's level moves with the track's `:vol` (a value, a curve, a
`$slot`), the note's `:vel` / `:vol` macros and `:master`, a frame at a time:
the ADPCM-B's linear level, a rhythm sound's IL. A rhythm sound is one
register however many tracks hit it; it follows the track that keyed it
last. The IL reaches 23 dB down (31 steps of 0.75 dB): a hit starts no
quieter than that, and a sound whose level falls below it while it sounds,
or reaches `:vol 0`, is dumped (it stops). A note's `:keyon` macro keys
its sound or its ADPCM-B note again at each step, the level envelopes
starting over with it, as on the Mega Drive's PCM; a `gate` or `loop`
note's steps play inside its gate.

The ADPCM-B repeats a sample's whole range, so a `loop` note whose loop
starts after its range does is `E_TARGET`.

**Effects.** `def-se` is a sound effect a game starts through the Mega
Drive's driver; a `pc88` score has none (`E_TARGET`).

### `x68k`

**`x68k` exports VGM (1.61)** with the YM2151 at the X68000's 4 MHz and the
MSM6258's ADPCM stream, and Play and WAV run ymfm's YM2151 beside the same
stream. There is no PSG: `sqr1`–`sqr3` are `E_TARGET`.

**FM.** `fm1`–`fm8`, the OPN's language: the same voices, operator words and
`:pan`, pitches on the chip's clock. The OPM has no SSG-EG (`:ssg1`… is
`E_TARGET`) and no FM3 modes, and it has a second detune, **`:dt2-1`–`:dt2-4`
0–3**, the operator's coarse one (×1, ×1.41, ×1.57, ×1.73 on its multiple;
`:dtN` stays the fine one) — inline, as a macro, or in a `def-fm`. A voice
is the OPN/OPM family's on every target: a register the machine lacks
(`:ssg1` here, `:dt2-1` on `md` and `pc88`) is left out where the voice
plays, with `W_TARGET` when it is set to anything but 0, and on `x68k` a
voice without `:dt2-N` states it 0,
so a voice change resets it.

**LFO.** The OPM's one LFO is the song's, written on any track:
**`:lfo-freq 0–255`**, **`:lfo-pmd 0–127`**, **`:lfo-amd 0–127`** (how deep it
moves pitch and level) and **`:lfo-wave saw | square | triangle | noise`**; a
voice takes it through `:fms` and `:ams` as on the OPN. They start at 0. The
OPN's `:lfo-rate` reads as the OPM's: 0 sets both depths 0, 1–8 the nearest
`:lfo-freq` to the YM2612's rate with both depths at 127. These words are
`E_TARGET` on the OPN targets.

**Noise.** The OPM's noise is fm8's fourth operator turned to noise. On
fm8, **`:mode noise`** turns it (and **`:mode tone`**, the default, back):
the voice plays whole — its algorithm, its envelope, its other three
operators still FM — as MXDRV plays a noise, so a hi-hat is a `def-fm`
with a fast decay on its fourth operator; `:vel` moves it as on any FM
note (the noise's part follows the operator's attenuation linearly, not
its 0.75 dB steps). `:mode` is fm8's alone (`E_UNSUPPORTED_TARGET`
elsewhere). `noise` is the same operator played alone, sine-voiced at a
plain level, for a score written for the PSG's noise: a score has `noise`
or `fm8` (`E_TARGET`). The period is the song's **`:noise-rate 1–31`**
(lower is higher, 9 to start), 125 kHz / n — what the same rate is on
`pc88`'s SSG — whichever plays it. A noise note's pitch is not read, and
`noise` has no `:mode`.

**PCM.** `pcm1`–`pcm8` are PCM8's eight voices: a software mix, as the
X68000's PCM8 driver makes one, into the MSM6258's single 4-bit ADPCM
stream at 15.6 kHz (15,624 Hz: the VGM streams the chip whole bytes a
second). A note plays its sample's `:file` — its def's range and `:fx`, at
the sample's own rate — stepped at the note's pitch, so `pcm1`–`pcm8` take
the pitch moves FM does (`:pitch`, `(glide …)`, `(macro :pitch …)`,
`(macro :semi …)`, though not `:snap`); its level is vel + vol + master as
one linear gain, moving while it sounds. A `shot` plays to the range's end,
a `gate` note is cut at its gate, a `loop` repeats the loop (`:loop-start`
… within the range, the def's or the track's) until its gate and plays the
rest out. A point the track writes is read at each key-on (a curve there is
read as its start, `W_TARGET`). The eight voices sum and saturate at the
chip's 12 bits — eight loud voices clip, as they do on the machine. Play
and WAV mix it with the FM as X68Sound (the players MXDRV runs in) does: a
full-scale sample at vel 15 is 17 dB above one carrier at TL 0. The
stream has one pan, so a pcm track has no `:pan` (`E_UNSUPPORTED_TARGET`).
The VGM carries the encoded stream as one data block that DAC stream
control plays; Play and WAV decode the same encoding, so all three sound
alike, ADPCM grain included.


### `msx`

**`msx` exports VGM** with the MSX's PSG, an AY-3-8910 at 1.79 MHz, and
two cartridges a score has only when it plays their channels: the SCC's
K051649 at the same clock (VGM 1.61) and the FM-PAC's YM2413 at 3.58 MHz.
Play and WAV run ymfm's SSG, an SCC of the toolchain's own and ymfm's
YM2413. There is no PCM: `pcm1`–`pcm3` are `E_TARGET`. The chips hear the
song a frame (1/60 s) at a time, as the MSX's drivers play it on the video
frame: a note starts on the frame nearest its time, its macros step from
there, and a gate keys it off whole frames later — its share of the
note's frames, rounded down, one at least.

**PSG.** `sqr1`–`sqr3` and `noise` are the SSG's, as on `pc88`: each
channel's mixer, `:mode tone|noise|both`, the song's noise period
**`:noise-rate 1–31`** (112 kHz / n; 8 to start, the nearest to the Mega
Drive's `white0`), and `noise` as `sqr3` with its mixer on noise (a score
has one or the other). A noise `:mode white0`–`white2` reads as
`:noise-rate` 8, 16, 31 (`W_TARGET`); `white3` and the periodic modes are
`E_TARGET`. The level is the chip's 4-bit one, 3 dB a step. The mixer
keeps the I/O ports' directions as the BIOS sets them, so the VGM is safe
to play on the machine. The hardware envelope is as on `pc88`: `:env`,
`:env-rate` and `:mode env`.

**SCC.** `wave1`–`wave5` are the SCC's five channels. Each plays a wave of
32 steps, which a `def-wave` names and a track switches to by naming it, as
it does a voice:

```lisp
(def-score :target msx)
(def-wave saw :wave (saw -128..127))            ; one cycle of a curve
(def-wave hollow :wave [0 90 127 90 0 -90 -127 -90 0 90 127 90 0 -90 -127 -90
                        0 40 60 40 0 -40 -60 -40 0 40 60 40 0 -40 -60 -40])
(wave1 saw :len 8 c e g > c < hollow g e c e)
```

`:wave` is 32 values, each −128..127 (signed 8-bit, the chip's), or a wave
expression: a curve, read over one cycle whatever its `:len` (§11), another
def-wave's name, and `+ - * /` over them and numbers, taken step by step
(`(+ (* saw 0.6) (* soft 0.4))`). A written value outside −128..127 or a
count other than 32 is `E_WAVE_VALUE`, as is a def-wave made of itself; what
an expression computes is rounded and kept in range, as the chip's register
keeps it. Another key is `E_WAVE_PARAM`. A channel plays a
square until its track names a wave; the wave is written to the channel's
memory where it is named, so a switch is heard from the next sample on. The
pitch is the chip's 12-bit period (1.79 MHz / 32 / (n + 1)), and every pitch
move a PSG channel has works the same — `:pitch`, `(glide …)`, the pitch and
`:semi` macros, `:snap`.

A track's **`:wave`** takes a wave expression where a name will not do:

```lisp
(def-val x 0 0..100)
(wave1 :wave (* soft 0.5) c)                                     ; folded: a wave of its own
(wave2 :wave (+ (* saw (- 1 (/ $x 100))) (* soft (/ $x 100))) :len 1 c)   ; follows $x
```

Without a `$slot` it is folded when the score compiles, into a wave of its
own the track names. With one it is a wave that follows its slots: the
channel's memory is written again in each frame a slot it reads has moved —
a host's write, a slider or the XY pad, or the score's own sweep of the
slot (`:x (linear 0..100 :len 1)`) — until the track names another wave. A
mix of two waves is `+` and `*` over them; a `def` names one to reuse
(`(def (mix a b t) (+ (* a (- 1 t)) (* b t)))`). `:wave` on a channel with
no wave memory is `E_UNSUPPORTED_TARGET`, a number alone (`:wave 3`)
`E_WAVE_VALUE`.

A note's **`(macro :wave …)`** steps its waves a frame at a time, as a
tracker's wave macro does — a vector of def-wave names, with `_`, `#sus` and
`#rel` as any step vector (§10), and no curve or number:

```lisp
(wave1 (macro :wave [hollow saw saw #sus soft]) :len 4 c e g)
```

Each step writes its wave where it differs from the one the channel plays,
so a held step does not write it again; after the macro the channel keeps
its last wave. The level is the chip's 4-bit linear volume, vel +
vol + master composed as one gain (§6) and rounded to its 16 steps. `wave4`
and `wave5` share one wave memory: two tracks that name different waves there
play whichever was written last, and the compiler says so (`W_TARGET`).

**FM.** `fm1`–`fm9` are the FM-PAC's nine channels: 2-op FM, `op1` the
modulator and `op2` the carrier, mono. Its words are the OPN's on two
operators, narrower where the chip is — `:fb` 0–7, `:ar1` `:dr1` 0–15,
`:sl1` `:rr1` `:ml1` 0–15, `:ks1` 0–1, `:am1`, and `:tl1` 0–63 on the
modulator alone — and four of its own, each `1`–`2`:

| Word | Range | |
| --- | --- | --- |
| `:ws1` | 0–1 | 1: the half-wave rectified sine |
| `:eg1` | 0–1 | 1: the envelope holds at SL while keyed; 0 decays on at RR |
| `:ksl1` | 0–3 | the level's key scale |
| `:vib1` | 0–1 | the chip's vibrato |

They are `def-fm` keys, written inline and swept as macros as the OPN's
are. The carrier has no TL: its level is the channel's 4-bit volume, 3 dB
a step to −45 dB, where vel + vol + master are composed (§6); a
`:vel2` voice is velocity-sensitive there, a `:vel1` voice on op1's TL. A
channel's **`:sus 1`** (sticky, 0 to start) releases its keyed-off notes
at the slow rate 5 rather than at the voice's RR — a piano's pedal; it is
the channel's, not the voice's. There is no algorithm, `:dt`, `:sr`,
`:ssg`, `:pan`, LFO word or FM3 mode (`E_TARGET`); a 4-op voice plays its
op1 and op2 (`W_TARGET` for the rest).

**Voices.** The chip has fifteen voices in ROM, built in by name as
`init-fm` is, with the values read from the chip's die:

```lisp
(def-score :target msx)
(def-fm reed clarinet :ws1 1 :rr2 6)       ; extends one: the user voice
(fm1 piano :len 8 c e g > c)
(fm2 synth-bass :oct 2 :len 4 c c g g)
(fm3 reed :len 4 e g)
```

`violin` `guitar` `piano` `flute` `clarinet`
`oboe` `trumpet` `organ` `horn` `synth`
`harpsichord` `vibraphone` `synth-bass` `acoustic-bass`
`electric-guitar`. A channel plays a voice from the ROM when its
registers are one of these, and from the chip's **one user voice**
otherwise: a voice that extends a ROM one, a `def-fm` of its own, a voice
an inline write or a macro has moved. A voice is settled at a note's
key-on, which writes the user voice when the chip holds another, so a
score may have as many user voices as it likes and a channel may switch
between them freely. What the chip cannot do is play two at once: when
notes on different channels sound together on different user voices, the
note keyed last sets it for both, and the compiler says so (`W_TARGET`). On the other targets the fifteen names are 4-op voices, op1
into op2 on algorithm 4 with op3 and op4 silent, the rates on the 4-op
scale; their KSL, waveform and vibrato have no register there.

**Rhythm.** `rhythm1`–`rhythm5` play the FM-PAC's five rhythm sounds,
named by the kits' roles and built in as `pc88`'s are — as many tracks as
the kit has sounds, each playing any of them:

| Name | `kick` | `snare` | `tom4` | `ride` | `hat` |
| --- | --- | --- | --- | --- | --- |
| ROM sound | BD | SD | TOM | TOP-CYM | HH |

The rhythm takes the chip's channels 7–9, so a score with a rhythm track
has no `fm7`–`fm9` (`E_TARGET`); the mode is the whole song's. There is no
`rim` and no `:pan`. A hit's level is vel + vol + master on the sound's
4-bit volume (3 dB a step, as a channel's), moving while it sounds; a
`:vol 0` releases it. A sound is keyed until its next hit — which keys it
off and on, so it starts over — or, with `:mode gate`, until its note
ends, where it releases.

A hit's note tunes its sound: c4 is the chip's datasheet tuning, and every
other note moves it by its semitones (`(rhythm1 tom4 c g > c)` plays three
toms). Two sounds share each tuned channel — SD with HH, TOM with the
cymbal — so a pair sounds at the pitch of whichever was hit last, and the
compiler says so once when a score writes a pair at different pitches
(`W_TARGET`). The channel's tuning moves as an FM channel's pitch does —
`:pitch`, `:semi`, `(glide …)` and their macros — and a note's pitch macro
runs its whole length, on through the sound's release past a `:mode gate`
gate: a kick's or a tom's pitch-down (`(rhythm1 kick (macro :pitch+
(linear 1200..0 :len 12f)) c c)`). It moves a pair together.

```lisp
(def-score :target msx)
(fm1 piano :len 8 c e g e)
(rhythm1 kick :len 4 c c c c)
(rhythm2 hat :len 8 c c c c c c c c)
(rhythm3 snare :len 2 _ c)
```

**Effects.** `def-se` is the Mega Drive driver's; an `msx` score has none
(`E_TARGET`).

### `pce`

**`pce` exports VGM (1.61)** with the HuC6280's PSG at the PC Engine's
3.58 MHz, and Play and WAV run a HuC6280 of the toolchain's own. There is
no FM and no PSG square: `fm1`, `sqr1` and `noise` are `E_TARGET`, so are
`:noise-rate` and `:mode`. The chip hears the song a frame (1/60 s) at a
time, as on `msx` — but for DDA's samples, which the CPU's timer writes.

**Waves.** `wave1`–`wave6` are the chip's six channels. Each plays a wave
of 32 steps, which a `def-wave` names and a track switches to by naming it,
as on the SCC — the same `def-wave`, `:wave` expressions and `$slot`
waves (`msx` above), written at the chip's 5 bits (a −128..127 step is its
top five). A channel plays a square until its track names a wave. A wave
is written where it is named or a `:wave` macro steps to it, under a note
too: the chip loads it with the channel off, which the same writes turn
back on, so the note goes on from the new wave's first step.
The level is the chip's 5-bit volume, 1.5 dB a step, vel + vol + master
composed once onto it (§6). The pitch is the chip's 12-bit frequency
(3.58 MHz / 32 / n), and every pitch move a PSG channel has works the same
— `:pitch`, `(glide …)`, the pitch and `:semi` macros, `:snap`.

```lisp
(def-score :target pce)
(def-wave saw :wave (saw -128..127))
(def-wave soft :wave (sin -100..100))
(wave1 saw :len 8 c e g > c < soft g e c e)
(wave2 soft :len 2 (macro :pitch (sin -30..30 :len 8f)) e g)
```

**Noise.** `noise5` and `noise6` are channels 5 and 6 turned to noise.
Each is pitched by its notes — the chip has 32 noise rates a channel, and a
note picks one: c2 the slowest (its LFSR clocked at 1.8 kHz), each
semitone the next, g4 the fastest — at the channel's level, with `:vel`,
`:vol` and their macros as on a wave channel; `:pitch` moves of less than
a semitone do nothing.

```lisp
(def-score :target pce)
(noise5 :len 8 :oct 2 c c :vel 10 c c :oct 4 c _ c c)
(noise6 :len 4 :oct 3 (macro :vel [15 10 5 0]) c c c c)
```

**Pan.** Each channel, wave or noise, has its own 4-bit left and right
levels, so `:pan` is a place between the sides, not a side: −1..1 whole,
the centre both sides full, a side away from the pan a 3 dB step lower for
every fifteenth of the way, ±1 that side alone. It takes a value, a
`(macro :pan …)`, and a curve, stepped a frame at a time (`:pan (linear
-1..1 :len 1)`).

**LFO.** The chip's LFO is channel 2 swaying channel 1, and it is written
as the FM LFO is: the song's **`:lfo-freq 0–255`** sets its speed (larger is
faster), and `wave1` takes it with **`:fms 0–3`** — 0 off, 1–3 how deep
(the chip's three modes). Its shape is the def-wave `wave2` plays, its speed
`wave2`'s pitch / (256 − `:lfo-freq`): wave2 on c5 sways about 2 Hz at
`:lfo-freq 0`, 9 Hz at 200, and at the top it is a tone of its own (the
chip's "FM"). While `wave1`'s `:fms` is not 0, channel 2 stays on as the LFO:
`wave2`'s rests and `:vol 0` only silence it, and the LFO runs on at its last
pitch; a note of `wave2`, heard or at `:vol 0`, starts the LFO's wave over.
`:fms 0` stops it. The depth is in the chip's period steps — ±16, ±64 or
±256 added to channel 1's 12-bit period — so a higher note sways further,
and a deep sway on a high note wraps round to a low one, as on the chip.
`:fms` on another channel is `E_UNSUPPORTED_TARGET`.

```lisp
(def-score :target pce)
(def-wave tri :wave (triangle -128..127))
(wave2 tri :vol 0 :oct 5 :len 1 c ~ c)            ; the LFO: its shape, its speed
(wave1 lead :lfo-freq 200 :fms 2 :len 4 c e g e)  ; channel 1 swayed by it
```

**DDA.** `pcm1`–`pcm6` are channels 1–6 as the chip's DDA: the channel a
5-bit DAC the CPU writes a sample at a time on its timer, 6.99 kHz (7.16
MHz / 1024). A `def-pcm` plays there as on `md`: each note baked at its
own pitch (no pitch move while it sounds), its `:pcm-start` / `:loop-*`
points and `:mode shot | loop | gate`; its level is the channel's 5-bit
volume as a wave's is, with `:vel`, `:vol` and their macros, and `:pan`
the channel's. A note writes its samples to its end — the sample's, the
next note's on any of the channel's names, a gate's — and the channel goes
quiet.

**One channel, three names.** `waveN`, `noiseN` (5 and 6) and `pcmN` are
one channel, and a score may write any of them: where their notes meet, the
`:prio` layering decides across the names (§1) — a lower `:prio` first, at
the default one DDA over the noise over the wave. A note starting under a
higher one is dropped, one sounding when a higher one starts is cut there,
so a drum on `pcm5` punches through a line on `wave5`.

```lisp
(wave5 saw :len 4 c c c c)        ; cut where pcm5 hits, dropped under it
(pcm5 :len 8 kick _ c _ _ c c _ _)
(wave6 :prio 1 lead :len 2 e _)   ; :prio 1 puts the wave over DDA here
(pcm6 :len 4 snare c c c c)
```

```lisp
(def-score :target pce)
(def-pcm kick :file "kick.wav")
(def-wave saw :wave (saw -128..127))
(wave1 saw :len 4 c e g e)
(pcm6 :len 4 kick c c c c)
```

### `fc`

**`fc` exports VGM (1.61)** with the 2A03's APU at the Famicom's 1.79 MHz
(NTSC), and Play and WAV run a 2A03 of the toolchain's own (nesdev's APU
pages: the duties, the triangle's steps, the noise's rates and LFSR, the
nonlinear mixer). Its channels are `sqr1` and `sqr2`, the pulses; `tri`,
the triangle; `noise`; and `pcm1`, the DMC's samples. There is no FM, no
wave memory and no pan (the machine is mono): `fm1`, `wave1`, `:pan` and
`:noise-rate` are `E_TARGET`. The chip hears the song a frame (1/60 s) at
a time, as on `msx`.

**Pulses.** `sqr1` and `sqr2` take every pitch move a PSG channel has —
`:pitch`, `(glide …)`, the pitch and `:semi` macros, `:snap` — on the
chip's 11-bit period (1.79 MHz / 16 / (n + 1), A1 the lowest note, the
highest held at period 8, about 12.4 kHz). The level is the chip's 4-bit
volume (linear, 15 loud, 0 the key-off), vel + vol + master composed once
onto it (§6). The pulse's shape is **`:duty`**, in sixteenths of the cycle
(sticky, default 8): the chip has 2, 4, 8 and 12 (12.5, 25, 50 and 75 %;
75 sounds as 25 does), and a value between is the nearest of them, the
narrower at a tie. It takes a value, a `(macro :duty …)` and a curve,
stepped a frame at a time. The chip's hardware envelope, sweep and length
counter are not the language's: the encoder sets the volume itself, turns
the sweep off (so a low note is not muted by its overflow check) and starts
a pulse's duty over only where a pitch move crosses its period's top three
bits.

```lisp
(def-score :target fc)
(sqr1 :duty 8 :len 8 (macro :vel (linear 15..4 :len 4)) c e g > c < :duty 2 g e c e)
(sqr2 :len 4 :oct 3 (macro :duty [2 4 8 12]) c e g e)
```

**Triangle.** `tri` plays a fixed-level triangle an octave below a pulse
at the same period (1.79 MHz / 32 / (n + 1)), with the same pitch moves.
It has no level: a note sounds at the one the chip has, and a rest halts
it where it stands (the chip's linear counter, from its next quarter
frame; the output holds, so no click). `:vel` and `:vol` on `tri` say so
(`W_TARGET`, once a track) and only 0 silences; `:duty` is
`E_UNSUPPORTED_TARGET`.

```lisp
(def-score :target fc)
(tri :len 4 :oct 3 c _ g (macro :pitch (sin -30..30 :len 8f)) g)
```

**Noise.** The `noise` track's notes pick its rate: the chip has 16, and
c2 is the slowest (its LFSR clocked every 4068 CPU clocks, 440 Hz), each
semitone the next, d#3 the fastest; `:pitch` moves of less than a semitone
do nothing. **`:mode white | periodic`** (sticky, default `white`) is the
long LFSR or its 93-step loop, which has a pitch of its own. The level is
the 4-bit volume as a pulse's. The Mega Drive's `white0`–`periodic3` have no
`fc` sound (`E_TARGET`).

```lisp
(def-score :target fc)
(noise :len 8 :oct 2 c c+ :vel 10 d :mode periodic d+ :mode white c _ :oct 3 d d)
```

**DPCM.** `pcm1` is the chip's DMC, one voice: a `def-pcm` plays there as
on `md`, its `:pcm-start` / `:pcm-end` range and `:mode shot | loop |
gate`. The DMC plays 1-bit deltas — each bit moves its 7-bit DAC two steps
up or down — at one of 16 rates (4.2–33.1 kHz) from at most 4081 bytes of
memory, so each `def-pcm` gets one rate: the highest at which the whole
sample, at the lowest note the score plays it on, fits. Each note is baked
at its own pitch at that rate, with its level in it — `:vel`, `:vol` and
the master as they stand at its key-on (a level macro's first step; the
level does not move while it sounds) — loaded into the memory at its
key-on and started from the DAC's middle. A shot plays out, or until the
next note; `gate` stops at the note's gate; `loop` repeats the note's whole
range until it — the chip loops a sample from its start, so a `:loop-*`
point is left out (`W_TARGET`). A sample longer than 4081 bytes at the
lowest rate is cut there. The 1-bit delta follows a fast, loud attack only
two steps a bit, so it dulls and lowers it: a drum is best made loud and
short. The DAC's level also lowers the triangle and the noise (the chip's
mixer).

```lisp
(def-score :target fc)
(def-pcm kick :file "kick.wav")
(tri :len 4 :oct 3 c e g e)
(pcm1 :len 8 kick c > c < _ c :vel 8 c _ c c)
```

**Effects.** `def-se` is the Mega Drive driver's; an `fc` score has none
(`E_TARGET`).
