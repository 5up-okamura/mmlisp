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
- `:macro` and `:glide` are independent per `fm3-N` track.
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
- `fm3-csm-rate` supports `:glide` (slides Timer A Hz between notes).
- `fm3-csm` supports `:glide` (slides FM3 F-number / tonal center pitch).
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
(fm1 :macro :tl1 (brown :from 20 :to 30 :len 4)
  c e g e)
```

**Implementation note:** `noise`, `pink`, and `perlin` are specified in v0.4
but not yet present in `sampleCurveUnit` in `ir-utils.js` or in
`CURVE_NAMES`/`LOOP_CURVE_NAMES` in `mmlisp2ir.js`. `brown` can be implemented
in the same pass as these three.

**LUT generation rule:** fixed seed (`0xDEAD`) at compile time; same source
always produces identical LUT data.

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

**WAV conversion** (compile time):

- Stereo → mono via `(L + R) / 2` downmix
- Converted to 8-bit signed PCM
- `:rate` sets the C4 playback rate (Hz); defaults to the WAV native sample
  rate if omitted

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
(sqr1 :len 0 :macro pad-env  c)

; PCM texture loop — holds open until STOP_TRACK
(pcm2 drone :mode loop :len 0
  :loop-start 0 :loop-end 4096  c)
```

### 4.6 Implications for the compiler

The MMLisp compiler is unaffected by this model. Each track compiles
independently to its GMB binary representation. Track identity, lifetime
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
| §1.6 | PCM sample file system   | ✅ Decided | `def` sample model, WAV conv; see §1.6         |
| §1.7 | PCM mixing               | ✅ Decided | 3ch soft-mix, raw 8-bit PCM; see §1.7          |
| §1.8 | FM3 independent-OP       | ✅ Decided | `fm3-1`–`fm3-4` independent F-number; see §1.8 |
