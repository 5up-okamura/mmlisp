# MMLisp v0.4 Design Notes

Document status: design-in-progress
Started: 2026-04-24

This document captures decisions and open questions for v0.4, based on design
discussions following the v0.3 freeze (tag: v0.3-freeze at c3bdc72).

The central themes of v0.4 are **hardware depth** and **expressive envelopes**:
reaching the full capability of YM2612 and SN76489 that v0.1–v0.3 left as out
of scope.

---

## 1. Decided

### 1.1 Channel name additions

| Name            | Hardware                           | Notes                                                                                                      |
| --------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `fm3`           | YM2612 FM channel 3 (normal use)   | Already valid in v0.3; note-less use alongside `fm3-N` tracks = patch declaration                          |
| `fm3-1`–`fm3-4` | FM3 OP1–OP4 in independent OP mode | New in v0.4; any `fm3-N` declaration enables FM3 special mode; exclusive with note-bearing `fm3` and `csm` |
| `csm`           | YM2612 FM3 + Timer A in CSM mode   | New in v0.4; exclusive with `fm3` and `fm3-N` tracks                                                       |
| `noise`         | SN76489 noise channel              | Already valid in v0.3                                                                                      |
| `dac-1`–`dac-3` | YM2612 DAC (fm6 in PCM mode)       | New in v0.4; any `dac-N` declaration enables DAC mode; exclusive with `fm6`                                |

When a `csm` channel is declared, the compiler emits `CSM_ON` and reserves fm3 and
Timer A. When any `dac-N` is declared, fm6 is switched to DAC mode; any `fm6`
track in the same score is a compiler error (`E_DAC_FM6_CONFLICT`).

### 1.2 Loop break

`(break)` form (track body) and `:break` modifier (inline in `[...]`) are adopted.
Both compile to `LOOP_BREAK` — PMD `:` equivalent: on the final pass of `(x N ...)`,
skip everything from the break point to the end of the loop body.

```
pass 1–(N-1): [part A] [part B]
pass N:       [part A]           ← break exits before part B
```

Multiple `(break)` in one loop → `E_MULTIPLE_BREAK`.

Cycle-alt (Strudel-style per-pass pattern switching via `|`) → out of scope for v0.4.

### 1.3 Syntax unification

| Change                              | Before                     | After                                           |
| ----------------------------------- | -------------------------- | ----------------------------------------------- |
| Note sequence form                  | `(seq ...)`                | `[...]`                                         |
| Subgroup / tuplet                   | `[e g a]` in item position | `(e g a)` in item position                      |
| Subgroup with explicit total length | —                          | `(1/4 e g a)` — first element is a length token |
| Single-stage curve spec             | `[:fn easeOut ...]`        | `(easeOut ...)`                                 |
| Multi-stage curve spec              | `[(easeIn ...) (sin ...)]` | unchanged                                       |
| Track declaration                   | `(track :ch X ...)`        | `(X ...)` — channel name as form head           |

`[:fn ...]` wrapper is removed. Curve forms are `(curve-name :key val ...)` directly.
`track` keyword and `:ch` option are removed. The channel name is the form head directly:
`(fm1 :oct 4 [...])`, `(csm @voice [...])`, `(dac-1 :mode drum [...])` etc.

---

## 2. Open Questions

### 2.1 FM3 independent-operator mode

YM2612 FM3 allows each of its 4 operators to use an independent F-number,
enabling 4 different pitches on one FM channel. This is useful for:

- **Drum kit**: OP1=kick, OP2=snare, OP3=tom, OP4=hihat (each key-ons
  independently)
- **4-voice chord**: all 4 OPs key-on simultaneously at different pitches

**Proposed syntax — `fm3-N` channel names:**

Rather than adding a new `:op N` track option, each OP is addressed as a
distinct channel name (`fm3-1`–`fm3-4`). Declaring any `fm3-N` track
implicitly enables FM3 special mode — the same implicit-enable pattern used
by `csm` and `dac-N`.

`fm3-N` means **"set OP N's F-number to this pitch"** — regardless of whether
that OP is a carrier or modulator in the patch algorithm. The algorithm
determines what the F-number _does_, not whether it can be set:

| OP role   | Effect of setting F-number via `fm3-N`                           |
| --------- | ---------------------------------------------------------------- |
| Carrier   | Output pitch — you hear this note directly                       |
| Modulator | Modulation ratio vs. its carrier changes → timbre/overtone shift |

This makes `fm3-N` algorithm-agnostic. The same track syntax works for:

- **alg7** (all carriers): 4 independent pitched voices — drum kit or 4-voice chord
- **alg4** (OP1→OP2, OP3→OP4): OP2/OP4 = output pitches; OP1/OP3 = modulation
  ratio control — two FM voices with independently pitched modulators
- **any algorithm**: carrier OPs define output pitch; modulator OPs define
  timbre by their frequency ratio to the carrier they feed

**Analog-style FM modulation via note syntax:**

Setting a modulator's F-number with a musical note specifies the modulation
ratio. Combined with `PARAM_SWEEP` (§2.11), the modulator pitch can sweep
over time — changing timbre dynamically like an analog FM synth:

```lisp
; alg4: OP1 modulates OP2. Sweep OP1 (modulator) pitch = timbre sweep
(fm3-1                              ; OP1 = modulator, alg4
  (set :pitch (easeOut :from 0 :to 24 :frames 16))   ; sweep modulation ratio
  [:oct 4 :len 1/1  c])             ; hold C; timbre changes over 16 frames

(fm3-2                              ; OP2 = carrier, alg4
  [:oct 4 :len 1/1  c])             ; output pitch = C4
```

**Drum kit example (alg7 — all carriers):**

```lisp
(fm3-1             ; OP1 as kick
  [:oct 2 :len 1/4  c _ _ _])

(fm3-2             ; OP2 as snare
  [:oct 3 :len 1/4  _ c _ c])
```

- No new track options needed — fits entirely within the existing channel model
- Each `fm3-N` track has its own tick timeline and phrase structure
- `fm3-1`–`fm3-4` are exclusive with `csm` in the same score
- A `(fm3 @voice)` with **no note sequence** is allowed alongside
  `fm3-N` tracks — it declares the shared algorithm/feedback/OP parameters
  for FM3 special mode. The compiler treats a note-less `fm3` form as a
  patch-only declaration and does not emit any note events for it.
- A `(fm3 @voice [...notes])` with notes alongside any `fm3-N`
  track is a compiler error (`E_FM3_MODE_CONFLICT`).

**Patch declaration example:**

```lisp
(fm3 @drum-kit)              ; shared algorithm, OP TL/AR/DR/SL/RR — no notes

(fm3-1             ; OP1 as kick — uses @drum-kit's OP1 params
  [:oct 2 :len 1/4  c _ _ _])

(fm3-2             ; OP2 as snare
  [:oct 3 :len 1/4  _ c _ c])
```

**Key-on semantics for modulator OPs:** a note event on any `fm3-N` track
always triggers key-on for that OP, regardless of its carrier/modulator role.
For modulator OPs, key-on starts the OP's own ADSR — which controls modulation
_depth_ over time (AR = sharp timbral attack, DR/SL = timbre decay/sustain,
RR = timbre release on key-off). This is standard FM synthesis behaviour and
musically intentional.

For smooth F-number updates _without_ key-on (e.g. PARAM_SWEEP of modulation
ratio), use `(set :pitch (curve ...))` on the modulator track — this emits a
`PARAM_SWEEP` event without triggering key-on.

### 2.2 FM3 chord — multi-pitch simultaneous key-on

**Decided: No chord syntax. Write each `fm3-N` track independently.**

Synchronizing multiple `fm3-N` tracks at the same tick is sufficient for
the chord use case. A dedicated `(chord ...)` form adds compiler complexity
without clear benefit — the explicit parallel-track model (same decision as
§2.6) is consistent and sufficient.

### 2.3 CSM — composite sinusoidal modelling

CSM mode uses YM2612 Timer A overflow to repeatedly key-on FM3, producing
a pitched buzz useful for speech synthesis and experimental effects. By sweeping
`csm-rate` over time (like a VCF cutoff), vowel-like timbral shifts and
speech-synthesis effects become possible.

**Decided: seq notes drive csm-rate (melodic model).**

Timer A overflow frequency is the "pitch" of the CSM buzz. Notes in a `csm`
sequence set csm-rate directly — the track behaves as a melodic voice. FM3's
harmonic structure (the overtone content set by `@voice`) stays fixed; only the
key-on rate changes.

```lisp
(csm @vowel                        ; FM3 voice defines harmonic timbre
  [:oct 4 :len 1/4  c e g          ; csm-rate follows C E G at oct 4
   :oct 5            c])           ; then C at oct 5 — it sings
```

The compiler converts note pitch to the Timer A reload value (Hz-to-register
conversion is a compiler detail; authoring uses standard note syntax).

**Static rate override — `(set :csm-rate ...)`:**

```lisp
(csm @vowel
  (set :csm-rate 220)              ; hold Timer A at 220 Hz regardless of notes
  [:len 1/1  c])
```

**Swept rate — PARAM_SWEEP (§2.11):**

```lisp
(csm @vowel
  (set :csm-rate (easeIn :from 80 :to 440 :frames 32))   ; sweep over 32 frames
  [:oct 4 :len 1/1  c])
```

**KEY-ON envelope on csm-rate — ENVELOPE_TABLE (§2.5):**

```lisp
(def vowel-open :env (easeOut :target csm-rate :from 200 :to 800 :frames 24))

(csm @vowel
  [:oct 4 :len 1/4 :env vowel-open  c e g])   ; envelope fires on each NOTE_ON
```

**Decided: CSM_ON is implicit from `csm` channel presence.**

Declaring `csm` in a score activates CSM mode for the entire score — the
same implicit-enable pattern as `dac-N` and `fm3-N`. Mid-score CSM ON/OFF
switching is out of scope for v0.4. To use normal fm3, use a score without
a `csm` channel.

Constraints:

- Exclusive with `fm3` and `fm3-N` channels in the same score
- Timer A is consumed by CSM; `LOOP_BEGIN` countdowns must use Timer B only
  (driver concern)
- `CSM_RATE` IR event: `{ cmd: "CSM_RATE", args: { hz: N } }`

### 2.4 DAC / PCM playback

**Decided: Plan B — up to 3ch software-mixed PCM with pitch and volume control.**

Reference implementations: MDSDRV (2ch 17.5 kHz, 16-step volume, batch
processing), MegaPCM2 (DMA protection, DPCM compression), XGM2 (68000↔Z80
communication, ROM sample streaming).

#### Hardware constraints

`dac-N` switches fm6 to 8-bit PCM output mode. The Z80 writes one byte at a
time to register `$2A`; sample rate equals the Z80 write frequency. FM ch6 is
lost for the duration. Hardware provides one output — multiple channels require
Z80 software mixing.

#### Cycle budget

| Sample rate | Frame budget consumed |
| ----------- | --------------------- |
| 8 kHz       | ~20%                  |
| 11 kHz      | ~27%                  |
| 17.5 kHz    | ~35%                  |

Pitch change adds ~4–6% per channel. Per additional mixed channel adds ~3%.
MDSDRV uses 32-byte batch processing for efficiency.

**Practical limit**: 2ch at 17.5 kHz with pitch + volume is tight but
achievable. 3ch requires dropping to ~13.3 kHz (still feasible for
ambient/texture use). Channel count is chosen per-score based on sample rate.

#### Channel modes

Each DAC channel operates in one of two modes, set at score/scene level:

**Drum mode** — short one-shot samples (kicks, hats, etc.)

- Plays to end on trigger; no automatic looping
- Low latency; supports a sample table for multiple voices per channel
- Limited pitch control (pitched drums)

**Texture mode** — looped ambient/glitch audio (Oval-style loops, noise
textures)

- Loop points defined in sample def; continues until overridden
- Full pitch and volume modulation via `(set ...)` and `PARAM_SWEEP`
- Loop point can be switched dynamically — immediately or at loop-end boundary
  (glitch-free switch)
- Multiple named loop-point sets per sample enable structured glitch control:

```lisp
(def drone :pcm "samples/drone.raw" :rate 17500
  :loops { :default [1024 4096]     ; normal loop
           :tense   [2048 2560]     ; short, tight loop — glitchy
           :long    [0    8192] })  ; full sample loop

; switch loop point at loop boundary (glitch-free)
(dac-1
  (set :loop-point :tense)
  [:len 1/1  @drone])
```

#### Software mixing implementation

**Volume** — bit-shift method (Z80 has no multiply instruction):

- 8–16 discrete steps; `volume=8` → pass through, `volume=4` → 1-bit right
  shift, `volume=2` → 2-bit right shift
- ~10 cycles/sample; RAM-efficient (no LUT needed)

**Pitch** — accumulator method:

```
each sample: phase += pitch_increment
advance to next sample when integer part of phase changes

pitch_increment = 1.0  → original pitch
pitch_increment = 1.5  → ~+7 semitones
pitch_increment = 0.5  → −1 octave
```

~40 cycles/sample additional cost.

**2ch mixing**: ch1 + ch2 → add → clip → write to `$2A`.

#### Two-layer control (base + delta)

Follows the v0.1 control model: score defines base values; game runtime
supplies delta. Z80 computes `final = base + delta` each frame. Delta returns
to zero when game intervention stops.

```lisp
; score defines base pitch and volume
(dac-1
  (set :pitch 0 :vol 12)
  [:len 1/1  @drone])

; game runtime can add delta_pitch / delta_volume at any time
; driver blends back to base when delta is released
```

Z80 work area per channel (23 bytes):

```
mode:          1 byte   DRUM or TEXTURE
sample_ptr:    3 bytes  ROM address (with bank)
loop_start:    3 bytes
loop_end:      3 bytes
current_pos:   3 bytes  + 1 byte fraction (for pitch accumulator)
base_pitch:    2 bytes  fixed-point
delta_pitch:   2 bytes  game-side
base_volume:   1 byte
delta_volume:  1 byte   game-side
loop_mode:     1 byte   IMMEDIATE or LOOP_BOUNDARY
reserved:      2 bytes
```

#### MMLisp authoring syntax

```lisp
; drum samples
(def kick  :pcm "samples/kick.raw"  :rate 8000)
(def snare :pcm "samples/snare.raw" :rate 11025)

; texture sample with named loop points
(def drone :pcm "samples/drone.raw" :rate 17500
  :loops { :default [1024 4096]
           :tense   [2048 2560] })

; two independent DAC tracks
(dac-1 :mode drum
  [:len 1/4  @kick _ @snare _])

(dac-2 :mode texture
  @drone
  (set :vol 10 :pitch (easeOut :from -12 :to 0 :frames 16)))

; loop point switch (glitch)
(dac-2
  (set :loop-point :tense :loop-switch immediate))
```

- `@name` in dac context emits `DAC_TRIGGER { sample: id }` (drum) or
  `DAC_LOAD { sample: id }` (texture) IR events
- `(set :pitch ...)` / `(set :vol ...)` emit `PARAM_SET` or `PARAM_SWEEP` as
  in §2.9/§2.11 — same authoring model as FM channels
- `(set :loop-point name :loop-switch immediate|loop-boundary)` emits
  `DAC_LOOP_SET`

**GMB section `0x0004 SAMPLE_TABLE`:**

```
count:     u8
entries[]:
  id:        u8
  flags:     u8   (0x01 = DPCM compressed, 0x02 = has named loops)
  rate:      u16  (Hz)
  len:       u16  (bytes, after decompression)
  loop_count: u8  (number of named loop-point pairs, 0 if none)
  loops[]:   { name_hash: u8, start: u16, end: u16 }
  data:      u8[len]
```

**Deferred to driver design phase:**

- DPCM compression format selection (XGM2 variant vs custom) — deferred
- DMA protection scheme (MegaPCM2 approach vs SGDK integration) — deferred
- `:mode` per-channel vs per-sample-def — deferred; future versions may
  allow Strudel-style pattern-driven sample scheduling (e.g. per-step sample
  selection without a separate track)
- **Note-driven DAC (Future Vision)** — treat a `dac-N` channel as a pitched
  instrument: each note event selects a sample pitched to that note. For pitches
  not covered by the sample set, the compiler auto-generates pitch-shifted
  variants from the nearest base sample (accumulator-based resampling). This
  enables full melodic lines from PCM samples — going beyond the traditional
  Mega Drive kick/snare-only DAC usage and opening up non-hardware-sounding
  timbres (e.g. real instrument samples, vocals, synthetic textures as
  pitched voices).

### 2.5 KEY-ON envelope / LFO (unified model)

All time-varying parameter changes that are **triggered per note** share a single
model. This avoids expanding envelopes into per-tick `PARAM_SET` events, which
would cause binary bloat proportional to note count.

**Binary representation — `ENVELOPE_TABLE` section (`0x0005`):**

Each named `def` with an envelope body becomes one entry in the table. Track
bytes carry only an `envId` reference; the driver evaluates the curve in real
time per channel per frame.

```
GMB binary
├── TRACK_DATA
│     NOTE_ON  pitch=c4  len=120  envId=2   ; reference only — 1 byte
│     NOTE_ON  pitch=d4  len=120  envId=2
│
└── ENVELOPE_TABLE  (section 0x0005)
      [id=2]  target=pitch  curve=easeOut  from=0  to=-48  frames=16
              delay=0  loop=false
```

**MMLisp authoring syntax:**

```lisp
; one-shot: synth tom pitch sweep
(def syntom-pitch :env (easeOut :target pitch :from 0 :to -48 :frames 16))

; one-shot: brass scoop-up
(def scoop :env (easeIn :target pitch :from -18 :to 0 :frames 6))

; looping LFO: vibrato (delay before onset)
(def vibrato :env (sin :target pitch :from -10 :to 10 :frames 16
                   :loop true :delay 24))

; looping LFO: tremolo on TL (carrier level)
(def tremolo :env (triangle :target tl1 :from 0 :to 3 :frames 8
                   :loop true :delay 0))

; step sequence: traditional vol envelope
(def pluck :env [:seq :target vol  15 12 8 4 2 1 0])   ; :seq form TBD
```

`:target` specifies which parameter the envelope drives. Any `param-set`-capable
target is valid: `pitch`, `vol`, `tl1`–`tl4`, `fb`, `dt1`, etc.

**Attaching an envelope to a voice:**

```lisp
(def syntom :psg { :env syntom-pitch })    ; fires on every NOTE_ON with @syntom
(def brass  :fm  { :env scoop })           ; scoop fires on every note
```

**Inline override within `[...]`:**

```lisp
[:oct 4 :len 1/4
  @syntom :env syntom-pitch  c
  @snare                     c]   ; explicit per-note env attach
```

**Multi-stage envelopes** — a vector of `(curve ...)` forms, parsed automatically:

```lisp
(def vib-entry :env
  [(easeIn :target pitch :from -12 :to 0 :frames 6)     ; scoop up
   (sin    :target pitch :from -10 :to 10 :frames 16    ; then vibrato
           :loop true :delay 0)])
```

Parser rule: `(curve-name ...)` → single-stage; `[(curve-name ...) ...]` → multi-stage.
No `compose` keyword needed.

**Driver state per channel:** `{ envId, stage, phase, delay_count }` —
reset on every KEY-ON, advanced every frame tick.

**FM vs PSG F-number resolution:** the `:target pitch` delta unit is defined
as a hardware-independent semitone-fraction. The compiler scales to F-number
bits at emit time based on channel type (FM: 11-bit F-number; PSG: 10-bit
tone register). Envelope table stores the logical delta; the driver reads the
pre-scaled value from the table.

**Decided: `:from`/`:to` unit is semitone-cents (100 = 1 semitone).** The compiler
scales to F-number register bits at emit time based on channel type. Authors never
deal with raw F-number delta; hardware differences are a compiler detail.

**Decided: `:len` as musical-time alternative to `:frames`.**

LFO period and one-shot duration can be specified in musical time instead of
frame count. The compiler converts ticks → frames using the score's BPM and
the driver frame rate (typically 60 fps):

```
frames = (ticks / PPQN) * (BPM / 60) * fps
```

Both `:frames` and `:len` are accepted wherever a duration appears in a curve form:

```lisp
; vibrato period locked to one quarter note (musically in-tempo)
(def vibrato :env (sin :target pitch :from -10 :to 10 :len 1/4
                   :loop true :delay 1/4))

; tremolo period = one eighth note
(def tremolo :env (triangle :target tl1 :from 0 :to 3 :len 1/8
                   :loop true))

; pitch sweep lasting exactly one beat (frame-count equivalent at compile time)
(def syntom-pitch :env (easeOut :target pitch :from 0 :to -48 :len 1/4))
```

`:delay` also accepts `:len`-style values when written as a keyword argument:

```lisp
(def vibrato :env (sin :target pitch :from -10 :to 10 :len 1/4
                   :loop true :delay-len 1/8))   ; delay = 1/8 note before onset
```

`:frames` remains valid for frame-accurate control (e.g. sweep tied to a
specific hardware animation frame). `:len` and `:frames` are mutually exclusive
per duration slot; using both is a compiler error.

**Decided: KEY-OFF release deferred. Use `:gate` ratio as workaround.**

The v0.4 `ENVELOPE_TABLE` model is KEY-ON triggered only. The v0.2 `:release`
and `:rr` behaviours have no direct equivalent.

**Workaround:** set `:gate` to a fixed ratio so the release phase is compiled
into the note length. Covers most game BGM patterns where note length is known
at compile time.

True KEY-OFF trigger (driver splits `gate_len` / `step_len`, adds
`release_stage_index` to `ENVELOPE_TABLE`) is deferred to v0.4+ and only
needed for organ-style variable-length PSG notes.

### 2.6 Chord / multi-channel syntax

In v0.3, each channel form addresses a single channel. For chord writing across
multiple FM channels (e.g. fm1+fm2+fm3 playing the same rhythm at different
pitches), options are:

**Option A — `(chord ...)` form in track body:**

```lisp
(fm1
  (chord :chs [fm1 fm2 fm3] :oct 3  c e g))  ; 3-ch chord at oct 3
```

**Option B — restore multi-channel form with voice-stealing rules:**

```lisp
([fm1 fm2 fm3] :role bgm
  [:oct 3  c e g])   ; compiler assigns notes round-robin or by pitch
```

**Option C — explicit parallel tracks (current workaround):**

```lisp
(fm1 :oct 3 [:oct 3  c])
(fm2 :oct 3 [:oct 3  e])
(fm3 :oct 3 [:oct 3  g])
```

**Decided: No new chord syntax in v0.4.** Option C (explicit parallel tracks)
is the only supported method. Options A and B add compiler complexity without
clear authoring benefit; deferred. A future version may introduce
Strudel-style multi-channel pattern scheduling as a higher-level abstraction.

### 2.7 Curve functions

**Decided: LUT approach. The compiler pre-generates curves; the driver does
table lookup only.**

The compiler (JS) generates a 256-entry u8 normalized LUT for each distinct
curve name used in a score. LUTs are stored in a new GMB section
`CURVE_TABLE (0x0006)`. The Z80 driver evaluates:

```
idx = phase * 256 / frames       ; 8-bit index into LUT
val = from + (to - from) * LUT[curveId][idx] / 255
```

All curve shapes have identical Z80 runtime cost. Unused curves emit no LUT
data — cost is 256 bytes per distinct curve name referenced in the score.

**Easings.net family (30 curves):**

Reference: https://easings.net/

| Family  | In              | Out              | InOut              | Character                      |
| ------- | --------------- | ---------------- | ------------------ | ------------------------------ |
| Sine    | `easeInSine`    | `easeOutSine`    | `easeInOutSine`    | Sinusoidal — smooth, gentle    |
| Quad    | `easeInQuad`    | `easeOutQuad`    | `easeInOutQuad`    | $t^2$                          |
| Cubic   | `easeInCubic`   | `easeOutCubic`   | `easeInOutCubic`   | $t^3$                          |
| Quart   | `easeInQuart`   | `easeOutQuart`   | `easeInOutQuart`   | $t^4$                          |
| Quint   | `easeInQuint`   | `easeOutQuint`   | `easeInOutQuint`   | $t^5$                          |
| Expo    | `easeInExpo`    | `easeOutExpo`    | `easeInOutExpo`    | $2^{10t}$ — sharp acceleration |
| Circ    | `easeInCirc`    | `easeOutCirc`    | `easeInOutCirc`    | Circular arc                   |
| Back    | `easeInBack`    | `easeOutBack`    | `easeInOutBack`    | Slight overshoot               |
| Elastic | `easeInElastic` | `easeOutElastic` | `easeInOutElastic` | Spring / wobble                |
| Bounce  | `easeInBounce`  | `easeOutBounce`  | `easeInOutBounce`  | Bouncing ball                  |

**Loop waveforms (MMLisp-specific; not in easings.net):**

| Name       | Shape                                                                    | Loop | Primary use                     |
| ---------- | ------------------------------------------------------------------------ | ---- | ------------------------------- |
| `linear`   | Straight line from `from` to `to`                                        | —    | One-shot ramp; portamento       |
| `sin`      | Full sine cycle per period                                               | ✓    | Vibrato, smooth LFO             |
| `triangle` | Linear ramp up then down per period                                      | ✓    | Tremolo                         |
| `saw`      | Linear ramp up then hard reset per period                                | ✓    | Sawtooth LFO, pitch drift       |
| `square`   | `from` for first half-period, `to` for second half                       | ✓    | Hard LFO gate, chiptune         |
| `noise`    | White: pseudo-random value in `[from, to]` re-rolled each frame          | ✓    | Random vibrato, roughness       |
| `pink`     | 1/f filtered noise — low-frequency bias, natural-feeling flutter         | ✓    | Breath, strings, organic wobble |
| `perlin`   | Gradient noise — smoothly varying, never repeats within 256-frame window | ✓    | Pitch drift, csm-rate wander    |

All loop waveforms are naturally looping — combine with `:loop true`.
All noise/stochastic LUTs (`noise`, `pink`, `perlin`) are generated from a fixed seed
at compile time (deterministic builds; same score always produces the same binary).

`brown` (1/f² noise) deferred to v0.4+ — musical character overlaps with `perlin`.

**Short aliases (for convenience; resolve at compile time):**

| Alias       | Resolves to     |
| ----------- | --------------- |
| `easeIn`    | `easeInQuad`    |
| `easeOut`   | `easeOutQuad`   |
| `easeInOut` | `easeInOutQuad` |

Multi-stage envelopes use `[(curve ...) (curve ...)]` syntax (see §2.5); no
special curve name needed.

`reverse` is not a curve name; reverse a curve by swapping `:from` and `:to`.

### 2.8 PSG noise control

SN76489 noise register (byte format: `111 FB NF1 NF0`):

| Bits | Field | Meaning                                           |
| ---- | ----- | ------------------------------------------------- |
| `FB` | 1 bit | 0 = periodic (pitched buzz), 1 = white noise      |
| `NF` | 2 bit | 00/01/10 = fixed rate ÷16/÷32/÷64; 11 = PSG3 freq |

When `NF=11`, the noise channel clocks from PSG3's tone generator. PSG3
simultaneously produces its own tone output, enabling **tone + noise mix**.

**Design: `:noise` is a voice-level field, changed via `@voice` switch.**

Rather than an inline track modifier, `:noise` lives inside a PSG voice
`def`. Switching noise timbre mid-track is done by switching `@voice` — the
same mechanism already used for FM voice changes. This means noise-mode change,
envelope change, and voice change are all one operation.

```lisp
; define named noise instruments
(def hi-hat-closed :psg { :noise white0      :env hh-closed-env })
(def hi-hat-open   :psg { :noise white2      :env hh-open-env })
(def ride          :psg { :noise periodic0   :env ride-env })

; use them — @voice switch fires noise register write + envelope attach
(noise
  [:len 1/8
    @hi-hat-closed  c c @hi-hat-open c
    @hi-hat-closed  c c @ride        c])
```

A `@voice` change on a noise track emits:

1. `NOISE_MODE` IR event (noise register write: FB + NF bits)
2. `ENV_ATTACH` IR event (envelope reference for next NOTE_ON)

`:noise` values — single keyword encoding FB + NF bits:

| Value           | FB  | NF   | Meaning                    |
| --------------- | --- | ---- | -------------------------- |
| `white0`        | 1   | `00` | white, fastest (÷16)       |
| `white1`        | 1   | `01` | white, medium (÷32)        |
| `white2`        | 1   | `10` | white, slowest (÷64)       |
| `white-psg3`    | 1   | `11` | white, freq = PSG3         |
| `periodic0`     | 0   | `00` | periodic buzz, fastest     |
| `periodic1`     | 0   | `01` | periodic buzz, medium      |
| `periodic2`     | 0   | `10` | periodic buzz, slowest     |
| `periodic-psg3` | 0   | `11` | periodic buzz, freq = PSG3 |

**PSG3 link example:**

```lisp
(def noise-psg3 :psg { :noise white-psg3 })

(noise @noise-psg3
  [:len 1/4  c _ c _])

(psg3                              ; psg3 drives noise frequency
  [:oct 4 :len 1/4  c _ c _])     ; also audible as tone
```

**Decided: `(set :noise ...)` (§2.9) covers inline override.** No
additional syntax needed. Use `(set :noise white2)` mid-phrase
to change noise mode without a full `@voice` switch.

---

### 2.9 Sticky parameter authoring (PMD-style)

**Decided: Option B — `(set ...)` as a dedicated IR-emitting form.**

`(default ...)` remains compile-time only. `(set ...)` always emits IR events.
`param-set` is removed.

```lisp
(default :oct 3)             ; compile-time state — no IR emitted
(set :tl1 30 :dt1 5)   ; PARAM_SET IR events — hardware writes
```

`(set ...)` accepts multiple key-value pairs in one form; each pair emits one
`PARAM_SET` event. It can also accept a curve form as its value to emit
`PARAM_SWEEP` (see §2.11):

```lisp
(set :tl2 (easeOut :from 28 :to 20 :frames 8))   ; PARAM_SWEEP
```

**PMD command mapping — updated:**

| PMD command         | MMLisp v0.4                  | Status                             |
| ------------------- | ---------------------------- | ---------------------------------- |
| `@N` (tone)         | `@voice`                     | ✅ sticky                          |
| `o N` (octave)      | `:oct N` in seq              | ✅ sticky                          |
| `l N` (length)      | `:len N` in seq              | ✅ sticky                          |
| `Q/q` (gate)        | `:gate N` in seq             | ✅ sticky                          |
| `v N` (volume)      | `:vol N` in seq              | ✅ sticky                          |
| `D N` (detune)      | `(set :dt1 N)`               | ✅ one IR write; HW state persists |
| `O slot,val` (TL)   | `(set :tl1 N)` etc.          | ✅ same                            |
| `s mask` (FM3 slot) | implicit from `fm3-N` tracks | ✅ resolved by §2.1                |
| `P N` (SSG mix)     | `@voice` with `:noise`       | ✅ resolved by §2.8                |
| `w N` (noise freq)  | `@voice` with `:noise`       | ✅ resolved by §2.8                |
| `M` (software LFO)  | `(set :param (curve ...))`   | ✅ resolved by §2.11               |

---

### 2.10 Loop break (volta-style last-pass skip)

A common pattern in music: repeat a phrase N times, but on the final pass skip
a tail section (e.g. a fill or transition). PMD MML uses `[A:B]N` — part A plays
every iteration, part B is skipped on the last pass.

Proposed MMLisp syntax — two equivalent forms:

**Track-body level** — when part A and part B are separate note sequences or other forms:

```lisp
(x 4
  [c d e]        ; part A: every pass
  (break)        ; on final pass: jump past LOOP_END
  [f g])         ; part B: skipped on pass 4
```

**Inline within `[...]`** — when the break point falls mid-sequence:

```lisp
(x 4
  [c d e :break f g])   ; :break splits the sequence into part A / part B
```

Both compile to the same `LOOP_BREAK` IR event at the current tick position.
`:break` inside `[...]` is a sequence modifier that emits `LOOP_BREAK` and
continues parsing the remaining items as part B.

`(x)` nesting is already supported (each loop gets a unique `_xN` id);
`(break)` inside a nested `(x)` exits only the innermost loop.

**Driver implementation — Option A (adopted):**

```
LOOP_BEGIN          ; push { return_addr, counter }
  ... (part A) ...
LOOP_BREAK 0x1234   ; if counter == 1: jump to 0x1234 (= LOOP_END + 1)
  ... (part B) ...
LOOP_END            ; counter--; if counter > 0: jump to return_addr
```

- `LOOP_BREAK` carries the exit address as a 2-byte operand, resolved by the
  GMB compiler via forward reference on the matching loop id.
- The Z80 driver loop stack entry (`{ return_addr, counter }`) is **unchanged**.
- `LOOP_BEGIN` opcode format is **unchanged** — full backward compatibility.
- Only new opcode: `LOOP_BREAK <u16 exit_addr>`.

IR representation:

```json
{ "cmd": "LOOP_BREAK", "args": { "id": "_x0" } }
```

The `id` links `LOOP_BREAK` to its enclosing loop; the GMB compiler resolves
the exit address at binary emit time.

**Decided**: multiple `(break)` markers in one loop body → `E_MULTIPLE_BREAK`.

### 2.11 PARAM_SWEEP — track-timeline smooth parameter change

Distinct from KEY-ON envelopes (§2.5): a one-shot sweep that starts at the
current track position and runs over N frames, independent of note events.
Useful for filter-style TL sweeps, cross-section pitch glides, or synth-pad
slow attacks driven from the track timeline rather than per-note.

**Authoring syntax** — value argument to `(set ...)` or seq inline modifier:

```lisp
; track body: TL sweep over 8 frames starting now
(set :tl2 (easeOut :from 28 :to 20 :frames 8))

; seq inline: pitch glide between sections (depends on §2.11 :pitch modifier being adopted)
(set :pitch (linear :from 0 :to 12 :frames 16))
[c d e  :pitch 0  f g]
```

**IR representation:**

```json
{
  "cmd": "PARAM_SWEEP",
  "args": {
    "target": "tl2",
    "curve": "easeOut",
    "from": 28,
    "to": 20,
    "frames": 8
  }
}
```

**Driver implementation:** one `PARAM_SWEEP` opcode. The driver stores a
per-channel sweep state `{ target, curve, from, to, frames, phase }` and
advances it each frame tick, writing the interpolated register value.
A new `PARAM_SWEEP` for the same target cancels the previous one.

This is the track-timeline counterpart to `ENVELOPE_TABLE`. Together they
cover all time-varying parameter needs:

| Trigger         | Mechanism                             | Use case                    |
| --------------- | ------------------------------------- | --------------------------- |
| KEY-ON per note | `ENVELOPE_TABLE` + `envId` in NOTE_ON | vibrato, synth tom, scoop   |
| Track timeline  | `PARAM_SWEEP` opcode                  | TL fade, global pitch slide |

**Decided: `:from` is optional.** When omitted, the driver starts the sweep from
the current hardware value of that parameter. The driver maintains a
`last_written[target]` register per channel. This enables portamento-style use:

```lisp
; portamento — from current pitch, slide to note pitch over 8 frames
(def portamento :env (linear :target pitch :to 0 :frames 8))
; :to 0 = delta 0 = note's own pitch; :from omitted = current pitch
```

Applies to both `ENVELOPE_TABLE` (§2.5) and `PARAM_SWEEP` (§2.11).

---

### 2.12 `(seq ...)` → `[...]` vector notation

**Decided** (per §1.3):

| Form                  | Context                                                       | Interpretation                                     |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `[...]`               | Track body / top-level                                        | Note sequence (replaces `(seq ...)`)               |
| `(notes...)`          | Item position inside `[...]`, first element is a note         | Subgroup / tuplet — current `:len` divided equally |
| `(len notes...)`      | Item position inside `[...]`, first element is a length token | Subgroup with explicit total length                |
| `(curve-name ...)`    | After `:env`; argument to `(set :key ...)`                    | Curve spec                                         |
| `[(stage1) (stage2)]` | After `:env`                                                  | Multi-stage envelope                               |

Context is always determined by syntactic position. `[...]` never appears in
item position as a subgroup — that role is taken by `(...)`, freeing `[...]`
from disambiguation complexity.

**Examples:**

```lisp
; note sequence
[:oct 4 :len 1/4  c e g c]

; subgroup (triplet): 3 notes sharing current :len (1/4 → 40 ticks each)
[:len 1/4  c  (e g a)  f]

; subgroup with explicit length: 3 notes sharing 1/2
[:len 1/8  c  (1/2 e g a)  f]

; single-stage envelope
(def syntom-pitch :env (easeOut :target pitch :from 0 :to -48 :frames 16))

; multi-stage envelope
(def vib-entry :env
  [(easeIn :target pitch :from -12 :to 0 :frames 6)
   (sin    :target pitch :from -10 :to 10 :frames 16 :loop true)])

; curve in (set ...)
(set :tl2 (easeOut :from 28 :to 20 :frames 8))
```

**Decided: `(seq ...)` is removed in v0.4.** No deprecated alias.
Existing demo sources (`demo1-stage-loop.mmlisp`, `demo2-event-recovery.mmlisp`)
use `(seq ...)` and `(track :ch ...)` throughout — a one-time rename pass is
required before those files are used with the v0.4 compiler.

---

## 3. Out of Scope for v0.4

- DT2 (second detune register) — out of scope for all versions until needed
- FM3 + CSM simultaneous use (hardware exclusive)
- 3ch DAC at 17.5 kHz with full pitch+volume (cycle budget; use 13.3 kHz for 3ch)
- DPCM compression format selection — deferred to driver design phase
- DMA protection scheme — deferred to driver design phase
- PCM/WAV sample instruments beyond `:pcm` raw format
- Runtime subroutines (`CALL`/`RET`) — `defn` remains compile-time only; `def`
  (no parameters) could be compiled to a subroutine when referenced more than
  once, avoiding binary duplication. Revisit when designing the driver.
- Patch import system — Future Vision

---

## 4. OQ Resolution Priority

All open questions resolved. Summary:

| Priority | §                           | Status     | Notes                                                                            |
| -------- | --------------------------- | ---------- | -------------------------------------------------------------------------------- |
| 1        | §2.10 Loop break            | ✅ Decided | `LOOP_BREAK` opcode, `(break)` / `:break`                                        |
| 2        | §2.1 FM3 OP syntax          | ✅ Decided | `fm3-N` channel names, patch-only `fm3` track                                    |
| 3        | §2.8 PSG noise              | ✅ Decided | `:noise` in voice def, `@voice` switch; inline via §2.9                          |
| 4        | §2.3 CSM                    | ✅ Decided | melodic model, `CSM_ON` implicit, `(set :csm-rate ...)`                          |
| 5        | §2.5 + §2.11 Envelope/sweep | ✅ Decided | `ENVELOPE_TABLE`, `PARAM_SWEEP`; KEY-OFF release deferred                        |
| 6        | §2.7 Curve functions        | ✅ Decided | LUT 256-entry, easings.net 30 + 8 loop waveforms                                 |
| 7        | §2.9 Sticky param / `(set)` | ✅ Decided | Option B: `(set ...)`, `param-set` removed                                       |
| 8        | §2.4 DAC                    | ✅ Decided | Plan B: up to 3ch (`dac-1`–`dac-3`), pitch+vol, drum/texture; sub-items deferred |
| 9        | §2.12 `(seq)` → `[...]`     | ✅ Decided | `(seq)` removed in v0.4; rename pass needed on demo sources                      |
| 10       | §2.6 Chord/multi-ch         | ✅ Decided | No new syntax in v0.4; explicit parallel tracks only                             |
| 11       | §1.3 channel-as-form        | ✅ Decided | `(track :ch X ...)` → `(X ...)`; `track` keyword removed                         |
| —        | §2.2 FM3 chord              | ✅ Decided | No chord syntax; write each `fm3-N` channel independently                        |

### FM3 OP syntax (§2.1) — current thinking

`fm3-N` channel names (rather than `:op N` option) is the preferred direction:

- No new syntax — channel names extend the existing name table (same as `csm`, `dac-N`)
- Implicit special-mode enable from channel name alone, consistent with other exclusive channels
- PMD `s mask` (bit field OP4=8, OP3=4, OP2=2, OP1=1) maps to which `fm3-N`
  tracks are present in the score
- Shared patch declared via note-less `(fm3 @voice)` — no new syntax needed
