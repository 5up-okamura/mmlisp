# MMLisp v0.5 Design Notes

Document status: design-in-progress
Started: 2026-04-28

This document captures decisions and open questions for v0.5, based on design
discussions following the v0.4 freeze.

The central theme of v0.5 is **extended hardware depth**: the YM2612 features
that v0.4 explicitly deferred — FM3 independent-operator mode, CSM (composite
sinusoidal modelling), and PCM playback via the DAC channel.

---

## 1. Decided

### 1.1 FM3 channel modes

YM2612 FM3 has three mutually exclusive operating modes (register $27):

| Mode           | Syntax                                 | Hardware                         |
| -------------- | -------------------------------------- | -------------------------------- |
| Normal FM      | `(fm3 :mode fm ...)`                   | Standard FM channel              |
| Independent OP | `(fm3-1)`–`(fm3-4)`                    | Each OP has independent F-number |
| CSM            | `(fm3-csm ...)` + `(fm3-csm-rate ...)` | Timer A KEY-ON buzz              |

CSM mode (`fm3-csm`/`fm3-csm-rate`) is a score-level commitment — it cannot be
mixed with normal `fm3` or `fm3-N` in the same score (compile error).

**FM3 independent-OP details:**

- IR mode enable: implicit from the presence of any `fm3-N` channel.
- `(macro ...)` and `(glide ...)` are independent per `fm3-N` track.
- S_MASK (KEY-ON slot mask): OP1=1, OP2=2, OP3=4, OP4=8.
- `fm3` voice declaration and `fm3-N` tracks are mutually exclusive within
  a score (one commits to special mode for the entire score).

**CSM details:**

- `fm3-csm` controls the tonal center (FM3 F-number); standard note/`:oct`
  syntax, same range as other FM channels.
- `fm3-csm-rate` controls the Timer A buzz frequency via note tokens. Notes are
  converted to Hz at compile time. `:oct` range is `0..10` for this channel
  only (C0≈16 Hz – B10≈31,609 Hz), covering the audible spectrum. The
  hardware ceiling is 53,270 Hz (Timer A at 7.67 MHz NTSC); values above
  `:oct 10` require a raw Hz literal.
- `:csm-rate` valid range: 52–53,270 Hz. Out-of-range values are clamped
  with a compiler warning.
- `fm3-csm-rate` supports `(glide ...)` (slides Timer A Hz between notes).
- `fm3-csm` supports `(glide ...)` (slides FM3 F-number / tonal center pitch).
- Timer A frequency can be specified in two ways (mutually exclusive per score):
  - **Inline on `fm3-csm`**: `:csm-rate N` (constant Hz) or
    `:csm-rate (curve ...)` (swept Hz). No `fm3-csm-rate` track needed.
  - **Companion track**: `fm3-csm-rate` for note-based independent-rhythm control.
- A score with neither inline `:csm-rate` nor a `fm3-csm-rate` track simply
  produces no Timer A retrigger (fm3-csm plays silently).
- `LOOP_BEGIN` Timer B conflict when CSM active: driver concern only;
  compiler does not flag.

**CSM examples:**

```lisp
; inline :csm-rate — constant Hz, no companion track needed
(fm3-csm brass :csm-rate 440 :oct 4 :len 4
  c d e f)

; inline :csm-rate with curve sweep
(fm3-csm brass :csm-rate (ease-out :from 220 :to 880 :len 8) :oct 4 :len 4
  c c c c)

; companion track — independent note rhythm for Timer A frequency
(fm3-csm brass :oct 4 :len 4
  c d e f)

(fm3-csm-rate :oct 5 :len 4
  a b c d)   ; A5(880 Hz)→B5(988 Hz)→C6(1047 Hz)→D6(1175 Hz)

; different rhythms on each track
(fm3-csm brass :oct 4 :len 2
  c _ e _ g _)

(fm3-csm-rate :oct 6 :len 1
  c d e f  g a b c)

; raw Hz literal for ultrasonic range
(fm3-csm-rate :len 4
  20000 20000 20000 20000)
```

**CSM IR events:**

- `CSM_RATE`: `{ cmd: "CSM_RATE", args: { hz: N } }` — sets Timer A frequency
- `CSM_ON`: implicit on every NOTE_ON in `fm3-csm`
- `CSM_OFF`: emitted at score end or when `fm3-csm` track is silenced

### 1.2 PCM — decided items

- **Pitch:** note names map to playback rate relative to C4 (base = 1.0×).
  `rate = 2^(semitones_from_C4 / 12)`. Practical range: C2–C6 (0.25×–4.0×).
  Out-of-range notes are clamped with a warning.
- **Volume:** 0–15, same scale as `:vel`. Composes with `:vol` / `:master`
  via the standard level stack.
- **Track form:** `(pcm1 sample-name ...)` / `(pcm2 ...)` / `(pcm3 ...)` —
  numbered channels (like `fm1`, `sqr1`). Sample name is the first positional
  argument, binding that sample to the channel for the track (analogous to FM
  voice binding). Notes specify pitch.
- **PCM modes** (`:mode` on `pcm1`–`pcm3`):
  - `shot` — one-shot: plays start→end once, then stops.
  - `loop` — sustain loop: plays attack (start→`:loop-start`), loops
    `:loop-start`–`:loop-end` until KEY-OFF, then plays release
    (`:loop-end`→end). Equivalent to the SF2/SFZ `sustain-loop` pattern.
    Use `len=0` to hold until `STOP_TRACK` or `KEY_OFF` from the game.
    Default is `shot` per playback event — not a sticky channel state.
    Same model as `:mode` on `noise` (per-note, not per-channel initial value).
- **fm6 coexistence:** `fm6` track supports `:mode fm` (FM channel),
  `:mode shot` (one-shot PCM), and `:mode loop` (sustain loop PCM).
  Mid-track switching is allowed.
- **PCM channel count:** limited by Z80 throughput at the chosen mix rate
  (higher rate = fewer channels). `pcm1`–`pcm3` are the declared maximum;
  the driver manages the actual constraint.
- **Sample format:** raw 8-bit signed PCM (no compression). WAV files are
  converted at compile time (see §1.6). The Z80 mixer reads this format
  directly; no decompression step in the driver.
- **DMA protection:** driver responsibility. The Z80 uses a ring buffer and
  VBlank acknowledgement protocol (same pattern as MDSDRV). The compiler
  outputs raw sample data only; buffer sizing and DMA handshake are
  driver implementation details.

### 1.3 Tempo change

`:tempo` accepts either a bare number or a curve expression — same pattern as
other param keywords:

- **`:tempo N`** → `TEMPO_SET`: instant change. Player reanchors
  `audioTimeAtTick0` at the change point.
- **`:tempo (curve :from N :to M :len L)`** → `TEMPO_SWEEP`: gradual change
  over `L` beats. Player interpolates `secsPerTick` on each scheduler pass.

IR representations:

```json
{ "tick": 0,   "cmd": "TEMPO_SET",   "args": { "bpm": 80 } }
{ "tick": 192, "cmd": "TEMPO_SWEEP", "args": { "from": 120, "to": 80, "len": 192 } }
```

`len` in `TEMPO_SWEEP` is ticks (= `:len` beats × ppqn). Any curve type
(`linear`, `ease-in`, `ease-out`, etc.) is valid.

**Syntax** (inline mid-track):

```lisp
(score :tempo 120
  (fm1 :oct 4 :len 4
    c d e f          ; plays at 120 BPM
    :tempo 80
    g a              ; plays at 80 BPM
    :tempo 120
    b5 c5))          ; back to 120 BPM
```

Tempo changes apply globally (all tracks advance together).

**Player implementation:** `TEMPO_SET` mid-track requires reanchoring the time
origin at the change point:

```
newAudioTimeAtTick0 = audioTimeOfChange - changeTick * newSecsPerTick
```

where `audioTimeOfChange = oldAudioTimeAtTick0 + changeTick * oldSecsPerTick`.
Reanchoring happens at dispatch time (`_dispatchEvent`), updating
`track.audioTimeAtTick0` for all tracks. The scheduler then uses the new
`secsPerTick` for all subsequent events.

**`TEMPO_SWEEP` examples:**

```lisp
:tempo (linear :from 120 :to 80 :len 4)
:tempo (ease-out :from 80 :to 160 :len 8)
```

### 1.4 Stochastic LUT seed

All stochastic curves (`noise`, `pink`, `perlin`, `brown`) use a single
hardcoded compile-time constant (e.g., `0xDEAD`). No user-configurable
option. Same seed across all scores.

### 1.5 `brown` noise — IIR spec

Generated by a one-pole leaky integrator (IIR) on white noise:

$$y[n] = 0.99 \cdot y[n-1] + 0.01 \cdot x[n]$$

where $x[n]$ is uniform white noise in $[-1, 1]$. The raw output is then
normalized (min–max of the generated sequence) and linearly mapped to the
`:from`–`:to` range. No spectral target is guaranteed; the leaky integrator
produces a brown/red-noise character sufficient for timbral drift use cases.

`brown` joins `noise`, `pink`, and `perlin` in the stochastic loop-waveform
set. All four are LUT-based at the driver level (Z80 table lookup) and use a
seeded JS `sampleCurveUnit` in the live player.

```lisp
; slow timbral drift on an FM operator
(fm1 (macro :tl1 (brown :from 20 :to 30 :len 4))
  c e g e)
```

**Implementation note:** `noise`, `pink`, and `perlin` are specified in v0.4
but not yet present in `sampleCurveUnit` in `ir-utils.js` or in
`CURVE_NAMES`/`LOOP_CURVE_NAMES` in `mmlisp2ir.js`. `brown` can be implemented
in the same pass as these three.

**LUT generation rule:** fixed seed (`0xDEAD`) at compile time; same source
always produces identical LUT data.

### 1.5.1 Curve parameter extension (v0.5)

v0.5 adds optional keyword arguments to curve forms, especially for
stochastic waveforms (`noise`, `pink`, `perlin`, `brown`).

This section defines authoring semantics only. Z80 driver storage layout,
LUT count limits, paging strategy, and memory budget are intentionally
deferred to the driver implementation phase.

Base curve form (unchanged):

```lisp
(curve-name :from A :to B :len L ...optional-params)
```

Common optional params (all curve names):

| Key      | Type   | Default | Meaning                                       |
| -------- | ------ | ------- | --------------------------------------------- |
| `:phase` | int    | `0`     | Start phase offset (0..255)                   |
| `:rate`  | number | `1.0`   | Phase speed multiplier (relative to `:len`)   |
| `:loop`  | flag   | —       | Force the curve to loop (cycle until key-off) |

Loop-wave curves (`sin` `triangle` `square` `saw` `ramp`) loop by default; the
value-less `:loop` flag forces any other curve (e.g. an easing) to cycle too,
acting as a looping sustain stage. Loop direction is forward only.

`const` is an additional curve: `(const V :len L)` holds the **positional**
value `V` for `:len` (a flat segment / constant signal); it is sugar for a
non-looping `linear` with `:from` = `:to` = `V`.

Loop-wave optional params:

| Curve              | Key     | Type | Default | Meaning                       |
| ------------------ | ------- | ---- | ------- | ----------------------------- |
| `square`           | `:duty` | int  | `128`   | Duty cycle (1..255)           |
| `sin/triangle/saw` | `:skew` | int  | `0`     | Shape skew amount (-127..127) |

Stochastic optional params:

| Curve                     | Key            | Type   | Default | Meaning                                         |
| ------------------------- | -------------- | ------ | ------- | ----------------------------------------------- |
| `noise/pink/perlin/brown` | `:hold`        | int    | `1`     | Sample-and-hold interval in frames              |
| `noise/pink/perlin/brown` | `:jitter`      | number | `0.0`   | High-frequency randomness mix amount (0.0..1.0) |
| `pink`                    | `:beta`        | number | `1.0`   | Spectral tilt control                           |
| `perlin`                  | `:octaves`     | int    | `3`     | Fractal octave count (1..8)                     |
| `perlin`                  | `:lacunarity`  | number | `2.0`   | Frequency ratio per octave                      |
| `perlin`                  | `:persistence` | number | `0.5`   | Amplitude ratio per octave                      |
| `brown`                   | `:leak`        | number | `0.99`  | Integrator leak coefficient                     |

Compile-time normalization rules:

- Unknown keyword for a curve name is a compile error.
- Out-of-range values are clamped and emit a warning.
- All optional params are part of the LUT identity key.
- Identical `(curve-name + params)` combinations reuse one LUT.

Examples:

```lisp
; brown drift with slower motion and mild hold
(fm1 (macro :tl1 (brown :from 24 :to 34 :len 4 :rate 0.5 :hold 2 :leak 0.995))
  c e g e)

; pink flutter with stronger low-frequency bias
(sqr1 (macro :pitch (pink :from -40 :to 40 :len 8 :beta 1.2 :phase 32))
  c c c c)

; perlin wander with explicit fractal controls
(fm2 (macro :pan (perlin :from -1 :to 1 :len 16 :octaves 4 :persistence 0.6))
  c _ c _)
```

### 1.5.2 Step macros — `:step`, `:semi`, `:keyon` (v0.5)

v0.5 adds three macro facilities built on one model: a per-step sequence
clock (`:step`), a discrete semitone pitch sequence (`:semi`), and a key-on
retrigger gate (`:keyon`). They are orthogonal targets — used alone or layered
through the existing multi-target macro list — so arpeggios, drum rolls, and
stochastic retriggers all fall out of the same primitives.

This section defines authoring semantics only. Z80 driver storage layout and
event encoding are deferred to the driver implementation phase.

#### `:step` — macro sampling clock (macro-list element)

`:step` is the **sampling interval for the macro** — the rate at which the macro
is evaluated and written. It applies to **every** macro form:

- **step vector** — advances one step per `:step` (discrete steps).
- **curve** — sampled-and-held every `:step`. At the default it's smooth; a
  coarser `:step` gives a stepped / sample-and-hold curve (e.g.
  `:step 8 :tl1 (sin …)` is a 1/8 stepped LFO).

It is an element **inside the `(macro ...)` form** and applies to the targets
that **follow** it (until the next `:step`). It accepts the length-token grammar:

| Token | Meaning            |
| ----- | ------------------ |
| `1`   | whole note         |
| `1/4` | quarter note       |
| `8`   | eighth note        |
| `16f` | 16 frames (1/60 s) |
| `14t` | 14 ticks           |

```lisp
; one step for the whole group
(fm1 (macro :step 1/16  :semi [:hold 0 4 7]  :keyon 1)  c)

; different step per target (positional)
(fm1 (macro :step 1/16 :semi [:hold 0 4 7]  :step 1/8 :keyon [0 :off 1 1 1])  c)
```

- Default when omitted: **`1f`** (one 60 Hz frame) = sample every frame, so
  curves are smooth and existing macros are unchanged.
- Because `:step` belongs to the macro (not the track), each macro — and each
  preset bundled in a `def` — carries its own step. A track is no longer
  limited to a single step rate.
- Targets sharing one `:step` advance on the same grid and stay phase-locked
  (step N of `:semi` coincides with step N of `:keyon`).
- `:step` governs both the sustain loop and the `:off` release section.
- A curve-form `:keyon` is therefore just "a curve sampled at `:step`" — no
  special rule. `:keyon (square …) :step 16` gates retriggers on the 1/16 grid;
  `:step 1f` samples it at 60 Hz.

#### `:semi` — semitone pitch sequence

`:semi` is a step-vector macro whose values are **semitone offsets** relative
to the note. It is the discrete counterpart to `:pitch`, which is curve-based
and measured in cents:

| Target   | Domain     | Value unit | Key-on retrigger |
| -------- | ---------- | ---------- | ---------------- |
| `:pitch` | continuous | cents      | no               |
| `:semi`  | discrete   | semitones  | no               |

- `:semi` changes pitch only; it never retriggers the envelope. On a sustained
  voice this is the classic chiptune arpeggio.
- A semitone is ×100 cents internally and shares the `NOTE_PITCH` apply path.
- `:hold` / `:off` loop and release markers behave as for any step vector.

```lisp
; sustained-voice arpeggio (no retrigger), 60 Hz default step
(fm1 (macro :semi [:hold 0 4 7])  c)
```

#### `:keyon` — retrigger gate

`:keyon` is sampled once per `:step`; when the sampled value is **≥ 0.5** a
key-on retrigger fires (key-off then key-on across the existing `KEY_OFF_LEAD`
gap, restarting the operator envelopes). The 0.5 threshold matches the integer
rounding (`Math.round`) used for every other macro target.

`:keyon` accepts any macro signal, so the full curve/stochastic engine doubles
as a gate generator:

| Form                           | Result                                       |
| ------------------------------ | -------------------------------------------- |
| `:keyon 1`                     | constant gate — fire **every** `:step`       |
| `:keyon 0`                     | never fire (same as omitting `:keyon`)       |
| `:keyon [:hold 1]`             | every step (equivalent to `1`)               |
| `:keyon [1]`                   | one-shot — fire once at step 0, then stop    |
| `:keyon [:hold 1 0]`           | fire on alternate steps                      |
| `:keyon (square :duty D)`      | duty-controlled regular gating               |
| `:keyon (noise :from 0 :to 1)` | probabilistic retrigger (~50 % per step)     |

Scalar `1` / `0` are accepted as constant signals; `1` is the shorthand for
the common "retrigger every step" case.

Retrigger rules:

- The first sample at t = 0 coincides with the note's own NOTE_ON and is a
  no-op, so a note never double-triggers on its own attack.
- `:keyon` honors the `:off` release marker exactly like any other step macro
  (e.g. `:vel`). Steps **before** `:off` are the sustain section — they loop
  until gate, so the retriggers stop at note-off (a drum roll). Steps **after**
  `:off` are the release section — they fire **after** note-off, so retriggers
  continue past the gate (a single-note echo / reverb tail).
- Two consecutive firing steps produce two attacks — the intended behavior for
  rolls and tails.

```lisp
; drum roll — no :off, all sustain; stops at note-off
(fm1 (macro :keyon [:hold 1])  c)

; single-note echo tail — taps in the release section fire after note-off,
; decaying via the phase-locked :vel release
(fm1 (macro :step 1/8  :keyon [0 :off 1 1 1]
                       :vel   [15 :off 11 7 3])  c)
```

A target's `:step` governs the spacing of **both** its sustain and its `:off`
release section, so the tail taps above are spaced at `:step` (1/8), not at the
60 Hz frame rate.

#### Clearing and reset — `none`

The value keyword `none` clears an active macro (there is otherwise no way to
stop one once set).

| Statement            | Effect                                              |
| -------------------- | --------------------------------------------------- |
| `(macro :semi none)`  | clear the `:semi` macro on this track              |
| `(macro :keyon none)` | clear the `:keyon` macro on this track             |
| `(macro none)`        | clear all active macros on this track             |
| `:pan none`          | stop a running inline `PARAM_SWEEP`, freezing the value |

`none` reads as "no modulation / no override": the baseline for a macro target
is its absence.

`none` also stops a **timeline (inline) `PARAM_SWEEP`** — e.g. an auto-pan
started with `:pan (sin ...)`. Inline curves run free of key-on and otherwise
have no off switch; `:target none` stops the sweep and **freezes the parameter
at its current value** (write an explicit `:target value` to set a specific
one). This makes `none` the single "stop modulating" word across both key-on
macros and timeline sweeps.

#### Composition

The three facilities are orthogonal targets, each carrying its own `:step`:

```lisp
; drum roll — retrigger only, 32nd-note rate
(fm1 (macro :step 32 :keyon 1)  c)

; classic arpeggio — pitch only, no retrigger (default 1f step)
(fm1 (macro :semi [:hold 0 4 7])  c)

; decaying-voice arpeggio — pitch + retrigger every step
(fm1 (macro :step 1/16  :semi [:hold 0 4 7]  :keyon 1)  c)

; stochastic stutter — random retrigger on a held note
(fm1 (macro :step 1/16 :keyon (noise :from 0 :to 1))  c)
```

### 1.5.3 Track delay — `(delay ...)` (v0.5)

`(delay ...)` is a per-note echo applied at compile time. It is distinct from the
single-note retrigger of §1.5.2 (`:keyon`): `:keyon` re-fires one note's
envelope, whereas `(delay ...)` echoes the **written note stream**. Because every
note is offset by the same delay time, a constant per-note echo reproduces a
**phrase-level delay** — the whole passage repeats, shifted and decayed.

This is event expansion (same family as `defn`): each source note emits N extra
NOTE_ON copies at compile time. Zero runtime cost; no driver feature is needed.

This section defines authoring semantics only.

#### Form

```lisp
(delay <target> <count|list|curve> :by N :time T)
```

Delay taps are **relative** to each note's own value — an echo rides whatever
velocity that note carries, rather than restating an absolute level. `(delay
...)` is **sticky** track state (applies to following notes, like `:len` /
`:gate`); `(delay none)` turns it off, `(delay :vel none)` clears one target.

- `<target>` — `:vel` (additive deltas) or `:vel*` (multiplicative ratios).
  `:vol` is reserved (not yet supported).
- The 2nd argument is polymorphic:
  - a **number** = tap count (pair with `:by`).
  - a **`[list]`** = explicit per-tap deltas (`:vel`) or ratios (`:vel*`); the
    count is the list length.
  - a **`(curve …)`** = a relative envelope; the tap count is derived as its
    `:len ÷ :time`, with each tap sampling the curve at its position.
- `:by N` — per-tap step: on `:vel`, tap k = note_vel + N·k; on `:vel*`,
  tap k = note_vel · N^k.
- `:time T` — tap spacing, using the standard length-token grammar (`1/4`, `8`,
  `16f`, `14t`).

Delay is an **overlay** that fills the gaps the written part leaves — it does
**not** lengthen the phrase (contrast `(echo ...)` below). Echoes are generated
from the original note only — no feedback recursion.

**Cross-channel delay is explicitly out of scope.** To overlap echoes with a
still-playing source, `def` the phrase and replay it on a separate channel —
the MMLisp-idiomatic way — rather than injecting events across tracks.

#### Expansion

```lisp
(fm1 (delay :vel 3 :by -4 :time 1/8)
  c e g e)
```

Each note emits three echoes at +1/8, +2/8, +3/8, each −4 vel from the note's
value. The constant offset shifts the whole phrase, so it repeats and decays.
The parametric `:by` form is preferred for regular ramps; the explicit list form
`(delay :vel [-4 -8 -12] :time 1/8)` is equivalent. A curve gives a non-linear
fade:

```lisp
(fm1 (delay :vel* (linear :from 0.8 :to 0 :len 10t) :time 2t)  c)
```

#### Monophonic priority

The channel is monophonic, so only one note sounds at any tick. Written
(source) notes always take priority over echo taps: where an echo would collide
with a written note, the echo is dropped — effect taps never preempt real
notes, so echoes sound only in the gaps the written part leaves. Exact behavior
at partial overlaps is to be refined with use.

#### Inherited articulation

Echo notes inherit the source note's per-note **articulation** macros —
`:keyon`, `:semi`, `:pitch`, and the FM operator macros, each with its own
`:step` — so a phrase that carries a 1-channel echo tail (`:keyon`) repeats with
that tail intact. The `:vel` macro is inherited and rides each echo's velocity,
lowered by the delay's per-tap step.

(Inherited `:keyon` tails extend past a note's gate; on a monophonic channel a
long tail can overrun the next echo — the same "echoes fill the gaps" reality.)

### 1.5.3b Phrase echo — `(echo ...)` (v0.5)

`(echo ...)` is an inline note-replay that **lengthens** the phrase: its taps
occupy real time, so notes after it shift back. This is the opposite of `(delay
...)`, which overlays into gaps and does not lengthen. `(echo ...)` is relative
and **one-shot** at its position in the note stream (not sticky track state).

```lisp
(echo <target> <count> :by N [:back B])
```

- `<target>` — `:vel` (additive) or `:vel*` (multiplicative).
- `<count>` — number of taps. `:by N` — per-tap step (`:vel` → note_vel + N·k;
  `:vel*` → note_vel · N^k).
- `:back B` — replay the single note B positions back (`B=1` = the last note,
  the default). Matches mucom `\=n1,n2` where `n1` = how many notes back.

```lisp
(fm1 c (echo :vel 3 :by -1))         ; last note replayed at vel−1, −2, −3 (decaying trail)
(fm1 c (echo :vel* 3 :by 0.7))       ; ×0.7, ×0.49, ×0.343
(fm1 c e (echo :vel 1 :by -4 :back 2))  ; replay the note 2 back (c) once at vel−4
```

### 1.5.4 Velocity and volume → level (v0.5)

`vel` / `vol` / `master` scale a note's loudness as **signed dB offsets composed
by addition** on top of each operator's voiced (timbre) TL. The offsets are
summed in float and quantized **once** at the register write. This is the
PMD/MDSDRV table style and maps directly onto a Z80 driver (per-control offset
tables, add + clamp — no float/log).

```
FM:  carrier TL = clamp(0,127, round( voicedTL[op] + dVel + dVol + dMaster ))
PSG: attenuation = clamp(0, 15, round(             dVel + dVol + dMaster ))
```

Because the offset is **uniform across carriers**, the patch's per-carrier
balance is preserved (not flattened to one composed TL).

- **`:vel` (0–15) — velocity.** A 2 dB/step ladder (PMD/MDSDRV coarse-volume
  convention). `vel 15` = 0 dB (patch level); `vel 0` ≈ **−30 dB floor**.
  Attenuation only — velocity **never mutes** (silence is a rest).
- **`:vol` / `:master` (0–31) — volume.** A **mixer-fader** with unity (0 dB)
  at the **top**: `31` = full (no attenuation), lower values cut — a pure
  attenuator, like a master fader. **`0` is a hard mute** (FM skips key-on;
  PSG → max att). vol and master share the curve and their offsets add. The
  unspecified default is `31` (unity, 0 dB = voiced).

The dB constants are **tunable** (`VEL_DB_PER_STEP`, `VOL_STEP_DB`, `VOL_UNITY`
in `ir-utils.js`); defaults are vel 2 dB/step, vol 2 dB/step with unity at 31
(cut to ~−62 dB at 1).

Resolution: authored values are integer (`vel` 0–15, `vol`/`master` 0–31), but
**computed** values (curve macros, delay scaling) stay float through the
pipeline and reach the hardware's native resolution — on FM, the TL 0.75 dB step
(~41 distinct levels over the vel range) instead of 16. PSG is hardware-capped at
its 16-step attenuator. A `:vel` macro fades only to the velocity floor; to fade
a note to true silence automate `:tl` (carrier TL → 127) or use `:vol`.

### 1.5.5 Channel priority layering — `:prio` (v0.5)

Multiple forms of the same channel default to **append** (sticky-state
concatenation). `:prio` lets forms instead **layer** on the one physical channel.

- `:prio N` — track option, unsigned integer, **lower number = higher
  priority**. Default `8` (leaves headroom on both sides; the absolute value is
  arbitrary, only relative ordering matters).
- **Equal `:prio` → append** (one timeline; unchanged behaviour).
- **Distinct `:prio` → parallel timelines** on the same channel, each starting
  at tick 0. Internally each `(channel, prio)` pair is its own track keyed
  `head:prio`.
- Resolution is **compile-time and monophonic**: a post-pass flattens the layers
  into one event stream. Note events are arbitrated **preemptively** — a note is
  dropped where a higher-priority note is already sounding, and **cut** (gate
  truncated to silence, no release tail) where a higher-priority note begins
  mid-sustain. This generalizes the §1.5.3 echo "source outranks tap" rule.
- Non-note events pass through in tick order; loops/flow control across layers
  are not reconciled (compiler warns `W_PRIO_LAYER_FLOW`).

The flattened output is one track per channel, so the IR, player, and eventual
Z80 driver are unchanged by this feature. This **replaces** the former `:role`
(`se`/`bgm`/`modulator`/`chaos`) concept, which is removed. Runtime dynamic
parameter performance (the "modulator" idea — live timbre automation via
`SET_PARAM`, §4.3) is a separate future concern, not part of `:prio`.

### 1.6 Sample file system

**Declaration:** samples are defined with `def` (same style as FM voice
definitions), then referenced by symbol from PCM tracks.

```lisp
(def kick  :sample :file "sounds/kick.wav")
(def snare :sample :file "sounds/snare.wav" :rate 11025)

(score :tempo 120
  (pcm1 kick  :len 4  c _ c _)   ; kick on beats 1, 3
  (pcm2 snare :len 4  _ c _ c))  ; snare on beats 2, 4
```

`def` declarations are score-independent and reusable across scores. This
makes sample assets library-friendly in the same way as FM voice definitions.

Semantics note: `def` binds a name to a value in the symbol table (reference
semantics). This applies to all `def` uses — FM voices, samples, and
sequences alike. `defn` by contrast performs inline copy expansion at compile
time. No `CALL`/`RET` exists in the current binary format; subroutine
reference is a future upgrade path once those opcodes are implemented in the
driver. The syntax is forward-compatible — no source changes needed when the
upgrade lands.

**Path resolution:** paths are relative to the `.mmlisp` source file.

**Sample import-time effects and conversion (compile time):**

- Stereo → mono via `(L + R) / 2` downmix
- Bit depth conversion: `:bit-depth` (e.g. 4/6/8) — quantizes to target depth, expands to 8bit for playback
- Volume normalization or gain: `:volume` (dB or linear)
- Simple compressor: `:compress` (preset or ratio/threshold)
- Simple reverb: `:reverb` (preset or time/amount)
- Additional effects (future): drive, filter, etc.
- All effects are applied at compile time; the processed PCM is baked into the ROM
- `:rate` sets the C4 playback rate (Hz); defaults to the WAV native sample rate if omitted

**Authoring example:**

```lisp
(def snare :sample :file "sounds/snare.wav" :bit-depth 4 :volume -6 :compress "lofi" :reverb "room")
```

**Output:** compiled `.mmb` is written to the same directory as the source `.mmlisp` file, named `<score-name>.mmb`.

**Output:** compiled `.mmb` is written to the same directory as the source
`.mmlisp` file, named `<score-name>.mmb`.

### 1.7 PCM mixing

Up to 3ch software-mixed PCM via YM2612's DAC (fm6 DAC output). The Z80 mixes
up to 3 channels at up to 17.5 kHz (2ch) or 13.3 kHz (3ch) per-frame, with
pitch transposition and volume scaling.

Reference implementations: MDSDRV (2ch 17.5 kHz, 16-step volume, batch DMA),
Sonic 3 K driver (1ch PCM + FM6 alternation).

```lisp
; one-shot percussion — sample name is first positional arg, notes specify pitch
(pcm1 kick  :len 4  c _ c _)   ; C4 = native rate
(pcm2 snare :len 4  _ c _ c)

; pitched PCM — C4 = 1.0×; other notes are rate-transposed
(pcm1 bass :oct 3 :len 8  c c c16 c16 c16)

; looping texture — sustain loop held until STOP_TRACK
(pcm3 pad :len 0 :vol 8  :mode loop  c)
```

### 1.8 FM3 independent-operator mode

Each of FM3's 4 operators can be given an independent F-number (pitch), while
still being combined via the algorithm. This enables chord voicing from a
single FM channel, drum kit pseudo-polyphony, and spectral shaping for
inharmonic timbres.

`fm3-1`–`fm3-4` tracks each drive one OP's F-number. The shared voice (ALG,
FB, TL, ADSR per operator) is declared via a note-less `(fm3 voice-name)` form.

```lisp
; drum kit using FM3 independent-OP mode
(fm3 drum-kit)            ; shared patch — enables FM3 special mode

(fm3-1 :oct 5 :len 8  c c)   ; OP1 — high hit
(fm3-2 :oct 3 :len 4  c _ )  ; OP2 — low hit
(fm3-3 :oct 4 :len 8  c c)   ; OP3 — mid hit
(fm3-4 :oct 2 :len 2  c _)   ; OP4 — sub hit
```

### 1.9 Loops and labels — `#label`, `go`, `x` (v0.5)

One label/jump primitive handles all looping and branching. The jump command is
**`go`** (renamed from `goto`; the old name is removed).

```lisp
#head                       ; label — bare atom, leading #
(seq c e g e)
(go head)                   ; infinite loop — jump back to #head forever
```

```lisp
#verse
(seq c e g e)
(go verse 4)                ; finite: the #verse…go section plays 4 times, then falls through
:break                      ; optional — on the final pass, exit the loop here
```

- `(go label)` → `JUMP { to: label }` (infinite; the player loops the track to it).
- `(go label N)` → the `#label`→`go` section plays **N times** then continues.
  Compiles to the same `LOOP_BEGIN`/`LOOP_END` as `(x N …)` (a post-merge pass
  rewrites a counted `JUMP` + its `MARKER`), so the label and the `go` may live
  in **different track forms** — they merge into one channel first.
- **`x` is sugar** for the counted form: `(x N body)` ≡ `#auto body (go auto N)`;
  `(x body)` (no count) is the infinite form.
- **`:break`** marks the early-exit point of the enclosing counted loop (works in
  both `(x N …)` and `#label …(go label N)`): the final pass stops at `:break`.

---

### 1.10 Time base — ticks and note lengths (v0.5)

The IR timeline is measured in **ticks**. The resolution is **PPQN = 96**: a
quarter note is 96 ticks, so a **whole note is 384 ticks**. The IR carries this
as the `ppqn` field; the player and the VGM/WAV exporters derive seconds-per-tick
from it (`60 / (bpm × ppqn)`), so a tick count is musical, not wall-clock.

> **Changed in v0.5:** PPQN was raised from 48 to **96** (whole note 192 → 384
> ticks). 384 is the LCM of MMLisp's note fractions (192) and the common
> imported driver grid (mucom's default 128 clocks/whole), so a whole note is
> divisible by all of `1,2,4,8,16,32,64,128`, their single dot (×3/2), triplets
> (÷3), **and** 128th notes (= 3 ticks). Imported lengths that previously had to
> round now land on exact ticks. All existing tick values simply double; musical
> timing is unchanged because the player reads `ppqn` from the IR.

Note/`:len` length tokens:

| Token  | Meaning                                  | Ticks (at 384/whole) |
| ------ | ---------------------------------------- | -------------------- |
| `4`    | quarter note                             | 96                   |
| `8.`   | dotted eighth                            | 72                   |
| `16`   | sixteenth                                | 24                   |
| `128`  | 128th note                               | 3                    |
| `6t`   | raw ticks — exactly N ticks              | 6                    |
| `16f`  | frames — N × (1/60 s), tempo-independent | —                    |

Use a fraction for ordinary durations; `Nt` expresses any value off the fraction
grid (e.g. an importer reproducing a driver's truncated length).

---

## 2. Resolved — moved to §1

All v0.5 open questions resolved. Design promoted to §1:

- §1.1 FM3 channel modes (CSM details, code examples, IR events)
- §1.3 Tempo change (TEMPO_SET / TEMPO_SWEEP, player reanchoring)
- §1.5 `brown` noise (IIR spec, LUT generation rule)
- §1.6 PCM sample file system (`def` model, WAV conversion)
- §1.7 PCM mixing (3ch soft-mix, raw 8-bit PCM)
- §1.8 FM3 independent-operator mode (`fm3-1`–`fm3-4`)

Deferred to v0.6+: `PARAM_ADD`, cycle-alt `|` — see §3.

---

## 3. Out of Scope for v0.5

- DT2 (second detune register) — deferred indefinitely
- FM3 chord polyphony — explicitly out of scope (no chord model; each
  `fm3-N` OP is sequenced independently as a monophonic voice)
- Runtime subroutines (`CALL`/`RET`) — `defn` currently compiles to inline
  copy expansion (no `CALL`/`RET` in the driver yet). Subroutine reference is
  a future upgrade; syntax is forward-compatible.
- `PARAM_ADD` / relative runtime value operations — deferred until interactive
  control direction is defined
- Cycle-alt `|` in `(x N ...)` — parse-model interaction with `:break` and
  nested loops is high-complexity; revisit after loop grammar test matrix is
  expanded (v0.6+)
- Patch import system — Future Vision

---

## 4. Design Vision — Interactive & Continuous Playback

### 4.1 Goal

MMLisp is not a fixed-BGM driver. The goal is a **DJ-style continuous audio
environment** where scenes transition musically without silence gaps:

- A title screen sound effect's reverb tail continues into the next scene
- Stage music begins layered on top of the decaying effect
- Boss → stage clear → next stage transitions flow like a DJ mix — connected,
  not cut

**Tempo does not need to match between scenes.** Tracks from different scores
run at their own BPM independently. No beat-matching or phase sync is required.

### 4.2 Track lifetime model — channel ownership

The fundamental unit of runtime control is the **track**, not the score.
A score is a named collection of tracks; the game can start and stop individual
tracks independently.

```
Score "title"
  └─ track fm2: reverb sfx (len=0, holds until KEY-OFF)

Score "stage1"
  ├─ track fm1: lead
  ├─ track sqr1–sqr3: harmony
  └─ track pcm1: drums

Game event: "START pressed"
  → START_TRACK(stage1.fm1)     ; drums begin — title sfx still playing on fm2
  → START_TRACK(stage1.sqr1)    ; harmony added
  → KEY_OFF(title.fm2)          ; sfx release tail fires, fades naturally
```

**Channel ownership rule:** when a newly started track claims a channel already
owned by a running track, the running track is released on that channel
(with its release tail if `:release` is defined, otherwise immediately).

### 4.3 68000 → Z80 control interface (design intent)

The exact binary protocol is a driver design phase decision. The intent:

| Command            | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `START_TRACK id`   | Begin playback of a named track from the start                 |
| `STOP_TRACK id`    | Stop a track (fires release tail if defined, else immediately) |
| `KEY_OFF ch`       | Send KEY-OFF to a specific channel (triggers `:release`)       |
| `SET_PARAM ch k v` | Write an absolute value to `key` on channel `ch` at runtime    |
| `FADE_TRACK id n`  | Fade out track over `n` frames then stop                       |

The communication area is a Z80 RAM region polled every frame tick.
The 68000 writes commands; the Z80 processes them on the next tick and clears
the pending flag.

### 4.4 Layering and scene transitions

Multiple scores from different scenes can be active simultaneously.
Each score's tracks run independently on their assigned channels.

**Recommended transition pattern:**

```
; scene A is playing on fm1, sqr1
; transition: start scene B on fm2, sqr2; fade scene A out

68000:
  START_TRACK(sceneB.fm2)
  START_TRACK(sceneB.sqr2)
  FADE_TRACK(sceneA.fm1, 60)    ; fade over 60 frames (~1 second)
  FADE_TRACK(sceneA.sqr1, 60)
```

Because tempo does not need to match, scene B can start immediately at its
own BPM. The overlap period sounds intentional — a crossfade rather than a cut.

### 4.5 `len=0` — indefinite hold

Notes with `len=0` hold until the game sends `KEY_OFF` or `STOP_TRACK`.
This enables:

- Sound effects that last as long as the game state (e.g. engine rumble,
  charge-up sound, boss warning siren)
- Musical phrases that loop until the scene changes
- PCM loops (`:mode loop`) held open indefinitely

```lisp
; loop indefinitely until game sends KEY_OFF
(sqr1 :len 0 (macro pad-env)  c)

; PCM texture loop — holds open until STOP_TRACK
(pcm2 drone :mode loop :len 0
  :loop-start 0 :loop-end 4096  c)
```

### 4.6 Implications for the compiler

The MMLisp compiler is unaffected by this model. Each track compiles
independently to its MMB binary representation. Track identity, lifetime
management, and the 68000→Z80 protocol are entirely driver concerns.

The compiler does need to:

- Assign stable track IDs (for the game to reference in `START_TRACK` etc.)
- Validate that `len=0` notes only appear in channels that support it
- Warn when `len=0` appears without a `:loop` or without a `:release`
  (the note will play the attack once then go silent — likely unintended)

---

## 5. v0.5 Design Decisions

| §    | Topic                    | Status     | Notes                                          |
| ---- | ------------------------ | ---------- | ---------------------------------------------- |
| §1.1 | FM3 channel modes        | ✅ Decided | CSM + independent-OP; see §1.1, §1.8           |
| §1.3 | Tempo change             | ✅ Decided | TEMPO_SET / TEMPO_SWEEP; see §1.3              |
| §1.5 | `brown` / stochastic LUT | ✅ Decided | IIR spec, LUT generation; see §1.5             |
| §1.5.2 | Step macros              | ✅ Decided | `:step` clock, `:semi` arp, `:keyon` gate; see §1.5.2 |
| §1.5.3 | Track delay / echo       | ✅ Decided | `(delay ...)` overlay + `(echo ...)` lengthening replay, both relative; see §1.5.3 |
| §1.5.4 | Velocity / volume → level | ✅ Decided | vel = 2 dB/step ladder (floors); vol/master mute at 0; see §1.5.4 |
| §1.5.5 | Channel priority layering | ✅ Decided | `:prio` compile-time monophonic layering (lower = higher, default 8); replaces `:role`; see §1.5.5 |
| §1.6 | PCM sample file system   | ✅ Decided | `def` sample model, WAV conv; see §1.6         |
| §1.7 | PCM mixing               | ✅ Decided | 3ch soft-mix, raw 8-bit PCM; see §1.7          |
| §1.8 | FM3 independent-OP       | ✅ Decided | `fm3-1`–`fm3-4` independent F-number; see §1.8 |

---

## 6. Live Tooling Addendum (Implemented, not core language spec)

The following features are implemented in the live authoring environment but
are not currently captured as core MMLisp language/IR spec items in v0.5.

### 6.1 File > Import FM Voice

FM voice import from external tracker/instrument formats is implemented in the
live UI:

- DefleMask DMP
- Furnace FUI
- TFI
- VGI
- OPNI

Imported data is converted into MMLisp `def` text for authoring use.

### 6.2 Panel workflow enhancements

The right-side panel supports direct live control and preview workflows:

- FM parameter editing via UI sliders/controls
- Channel context switching (selected FM/PSG target)
- Keyboard note preview for selected target (FM/PSG)
- Keyboard-driven step input into the editor

### 6.3 Tools menu editor actions

Tools menu includes editor convenience actions:

- Toggle Comment
- Format Source

### 6.4 Additional implemented live conveniences

Also implemented in the live UI:

- Collapsible parameter panel
- FM/PSG channel strips (select / mute / solo)
- File open/save/save-as integration
- `.mmb` binary preset loading path in live mode

### 6.5 Playback backend status (temporary)

Current implementation direction in the live/player environment:

- FM playback accuracy is being prioritized first, with validation work centered
  on a higher-accuracy YM2612 backend.
- PSG playback remains on the current implementation temporarily.
- PCM playback remains on the current implementation temporarily.

PSG and PCM are intentionally left in their current state for now and are
expected to be reviewed/replaced later, after FM playback behavior is settled.
