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
| `fm1`–`fm6`     | YM2612 FM channels 1–6             | Already valid in v0.3; `fm6` is exclusive with `pcmN`                                                      |
| `fm3`           | YM2612 FM channel 3 (normal use)   | Already valid in v0.3; note-less use alongside `fm3-N` tracks = patch declaration                          |
| `fm3-1`–`fm3-4` | FM3 OP1–OP4 in independent OP mode | New in v0.4; any `fm3-N` declaration enables FM3 special mode; exclusive with note-bearing `fm3` and `csm` |
| `csm`           | YM2612 FM3 + Timer A in CSM mode   | New in v0.4; exclusive with `fm3` and `fm3-N` tracks                                                       |
| `srq1`–`srq3`   | SN76489 square-wave tone channels  | Renamed in v0.4 (was `psg1`–`psg3` in v0.3)                                                                |
| `noise`         | SN76489 noise channel              | Already valid in v0.3                                                                                      |
| `pcm1`–`pcm3`   | YM2612 DAC (fm6 in PCM mode)       | New in v0.4; any `pcmN` declaration enables PCM mode; exclusive with `fm6`                                 |

When a `csm` channel is declared, the compiler emits `CSM_ON` and reserves fm3 and
Timer A. When any `pcmN` is declared, fm6 is switched to PCM mode; any `fm6`
track in the same score is a compiler error (`E_PCM_FM6_CONFLICT`).

### 1.2 Loop break

`(break)` form (track body) and `:break` modifier (inline) are adopted.
Both compile to `LOOP_BREAK` — PMD `:` equivalent: on the final pass of `(x N ...)`,
skip everything from the break point to the end of the loop body.

```
pass 1–(N-1): part_A  part_B
pass N:       part_A             ← break exits before part_B
```

Multiple `(break)` in one loop → `E_MULTIPLE_BREAK`.

Cycle-alt (Strudel-style per-pass pattern switching via `|`) → out of scope for v0.4.

### 1.3 Syntax unification

| Change                              | Before                     | After                                                            |
| ----------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| Note sequence form                  | `(seq ...)` / `[...]`      | flat inline — notes written directly in channel body             |
| Subgroup / tuplet                   | `[e g a]` in item position | `(e g a)` in item position                                       |
| Subgroup with explicit total length | —                          | `(1/4 e g a)` — first element is a length token                  |
| Single-stage curve spec             | `[:fn easeOut ...]`        | `(easeOut ...)`                                                  |
| Multi-stage curve spec              | `[(easeIn ...) (sin ...)]` | unchanged (after `:env` only)                                    |
| Track declaration                   | `(track :ch X ...)`        | `(X ...)` — channel name as form head                            |
| Mid-track defaults                  | `(default :oct 3 ...)`     | removed — channel options set initial state; all state is sticky |
| `def` reference / voice switch      | `@name`                    | bare identifier `name`                                           |
| Hardware param write                | `(set :tl1 30)`            | inline `:tl1 30` — same position as `:oct`/`:len`                |

`[:fn ...]` wrapper is removed. Curve forms are `(curve-name :key val ...)` directly.
`track` keyword and `:ch` option are removed. The channel name is the form head directly:
`(fm1 :oct 4  c e g e)`, `(csm brass  c e g)`, `(pcm1 :mode drum  :len 1/4  kick _ snare _)` etc.
All state (`:oct`, `:len`, `:gate`, `:vol`) is sticky. `(default ...)` and `(set ...)` are removed.

**Token disambiguation rule** — the parser resolves tokens in this order:

| Token shape                     | Interpretation                              |
| ------------------------------- | ------------------------------------------- |
| `a`–`g` (optionally `+` or `-`) | Note name                                   |
| `_`                             | Rest                                        |
| `~`                             | Tie                                         |
| `:keyword`                      | Modifier or key-value pair                  |
| `(form ...)`                    | Structural form (`x`, `break`, curve, etc.) |
| Any other identifier            | `def` reference — compiler resolves content |

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
by `csm` and `pcmN`.

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
  :pitch (easeOut :from 0 :to 24 :len 16)   ; sweep modulation ratio
  :oct 4 :len 1/1  c)               ; hold C; timbre changes over 16 frames

(fm3-2                              ; OP2 = carrier, alg4
  :oct 4 :len 1/1  c)               ; output pitch = C4
```

**Drum kit example (alg7 — all carriers):**

```lisp
(fm3-1             ; OP1 as kick
  :oct 2 :len 1/4  c _ _ _)

(fm3-2             ; OP2 as snare
  :oct 3 :len 1/4  _ c _ c)
```

- No new track options needed — fits entirely within the existing channel model
- Each `fm3-N` track has its own tick timeline and phrase structure
- `fm3-1`–`fm3-4` are exclusive with `csm` in the same score
- A `(fm3 voice-name)` with **no note sequence** is allowed alongside
  `fm3-N` tracks — it declares the shared algorithm/feedback/OP parameters
  for FM3 special mode. The compiler treats a note-less `fm3` form as a
  patch-only declaration and does not emit any note events for it.
- A `(fm3 voice-name notes...)` with notes alongside any `fm3-N`
  track is a compiler error (`E_FM3_MODE_CONFLICT`).

**Patch declaration example:**

```lisp
(fm3 drum-kit)               ; shared algorithm, OP TL/AR/DR/SL/RR — no notes

(fm3-1             ; OP1 as kick — uses drum-kit's OP1 params
  :oct 2 :len 1/4  c _ _ _)

(fm3-2             ; OP2 as snare
  :oct 3 :len 1/4  _ c _ c)
```

A note on any `fm3-N` track always triggers KEY-ON for that OP. On modulator
OPs this starts the OP's ADSR, controlling modulation depth over time — the
same behaviour as any FM synth. To update F-number _without_ KEY-ON (smooth
modulation-ratio sweep), use `:pitch (curve-name ...)` instead of a note.

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
harmonic structure (the overtone content set by the voice def) stays fixed; only the
key-on rate changes.

```lisp
(csm vowel                         ; FM3 voice defines harmonic timbre
  :oct 4 :len 1/4  c e g           ; csm-rate follows C E G at oct 4
  :oct 5            c)             ; then C at oct 5 — it sings
```

The compiler converts note pitch to the Timer A reload value (Hz-to-register
conversion is a compiler detail; authoring uses standard note syntax).

**Static rate override — `:csm-rate val`:**

```lisp
(csm vowel
  :csm-rate 220                    ; hold Timer A at 220 Hz regardless of notes
  :len 1/1  c)
```

**Swept rate — PARAM_SWEEP (§2.11):**

```lisp
(csm vowel
  :csm-rate (easeIn :from 80 :to 440 :len 32)   ; sweep over 32 frames
  :oct 4 :len 1/1  c)
```

**KEY-ON envelope on csm-rate — ENVELOPE_TABLE (§2.5):**

```lisp
(def vowel-open :env :csm-rate (easeOut :from 200 :to 800 :len 24))

(csm vowel
  :oct 4 :len 1/4 :env vowel-open  c e g)     ; envelope fires on each NOTE_ON
```

**Decided: CSM_ON is implicit from `csm` channel presence.**

Declaring `csm` in a score activates CSM mode for the entire score — the
same implicit-enable pattern as `pcmN` and `fm3-N`. Mid-score CSM ON/OFF
switching is out of scope for v0.4. To use normal fm3, use a score without
a `csm` channel.

Constraints:

- Exclusive with `fm3` and `fm3-N` channels in the same score
- Timer A is consumed by CSM; `LOOP_BEGIN` countdowns must use Timer B only
  (driver concern)
- `CSM_RATE` IR event: `{ cmd: "CSM_RATE", args: { hz: N } }`

### 2.4 PCM playback

**Decided: Plan B — up to 3ch software-mixed PCM with pitch and volume control.**

Reference implementations: MDSDRV (2ch 17.5 kHz, 16-step volume, batch
processing), MegaPCM2 (DMA protection, DPCM compression), XGM2 (68000↔Z80
communication, ROM sample streaming).

#### Hardware constraints

`pcmN` switches fm6 to 8-bit PCM output mode. The Z80 writes one byte at a
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

Each PCM channel operates in one of two modes, set at score/scene level:

**Drum mode** — short one-shot samples (kicks, hats, etc.)

- Plays to end on trigger; no automatic looping
- Low latency; supports a sample table for multiple voices per channel
- Limited pitch control (pitched drums)

**Texture mode** — looped ambient/glitch audio (Oval-style loops, noise
textures)

- Loop region set on the channel via `:loop-start` / `:loop-end` (sample byte offsets)
- No `:loop-start`/`:loop-end` → one-shot (plays to end)
- `:loop-start` and `:loop-end` accept an integer or a curve form — enabling animated loop windows
- Full pitch and volume modulation via inline `:key (curve ...)` and `PARAM_SWEEP`

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
(pcm1
  :pitch 0 :vol 12
  :len 1/1  drone)

; game runtime can add delta_pitch / delta_volume at any time
; driver blends back to base when delta is released
```

Z80 work area per channel (23 bytes):

```
mode:          1 byte   DRUM or TEXTURE
sample_ptr:    3 bytes  ROM address (with bank)
loop_start:    3 bytes  0 = no loop
loop_end:      3 bytes  0 = no loop
current_pos:   3 bytes  + 1 byte fraction (for pitch accumulator)
base_pitch:    2 bytes  fixed-point
delta_pitch:   2 bytes  game-side
base_volume:   1 byte
delta_volume:  1 byte   game-side
reserved:      3 bytes
```

#### MMLisp authoring syntax

```lisp
; drum samples — no loop, one-shot
(def kick  :pcm "samples/kick.raw"  :rate 8000)
(def snare :pcm "samples/snare.raw" :rate 11025)

; texture sample (pcm file only — loop region set on channel)
(def drone :pcm "samples/drone.raw" :rate 17500)

; two independent PCM tracks
(pcm1 :mode drum
  :len 1/4  kick _ snare _)

; texture: loop region set inline, curve value sweeps loop-end (Oval-style window)
(pcm2 :mode texture
  :loop-start 1024 :loop-end 4096
  drone
  :vol 10 :pitch (easeOut :from -12 :to 0 :len 16))

; change loop window mid-track
(pcm2
  :loop-start 2048 :loop-end 2560)

; animated loop window — loop-end sweeps over 64 frames
(pcm2
  :loop-end (linear :from 4096 :to 2048 :len 64))
```

- bare identifier in pcm context emits `PCM_TRIGGER { sample: id }` (drum) or
  `PCM_LOAD { sample: id }` (texture) IR events
- `:pitch val` / `:vol val` emit `PARAM_SET` or `PARAM_SWEEP` (when value is a curve)
  as in §2.9/§2.11 — same authoring model as FM channels.
  `:pitch` is in **semitones** (`0` = original pitch, `-12` = one octave down,
  `7` = +5th). The compiler converts to `pitch_increment` (`2^(n/12)`) for the
  Z80 accumulator. Integer values only.
- `:loop-start val` / `:loop-end val` emit `PARAM_SET` (integer) or `PARAM_SWEEP`
  (curve form) — same `:key val` / `:key (curve ...)` rule as all other params.
  Omitting both → one-shot playback

**GMB section `0x0004 SAMPLE_TABLE`:**

```
count:     u8
entries[]:
  id:        u8
  flags:     u8   (0x01 = DPCM compressed)
  rate:      u16  (Hz)
  len:       u16  (bytes, after decompression)
  data:      u8[len]
```

Loop region (`loop_start`, `loop_end`) is runtime state on the channel, not
stored in the sample table.

**Deferred to driver design phase:**

- DPCM compression format selection (XGM2 variant vs custom) — deferred
- DMA protection scheme (MegaPCM2 approach vs SGDK integration) — deferred
- `:mode` per-channel vs per-sample-def — deferred; future versions may
  allow Strudel-style pattern-driven sample scheduling (e.g. per-step sample
  selection without a separate track)
- **Note-driven PCM (Future Vision)** — treat a `pcmN` channel as a pitched
  instrument: each note event selects a sample pitched to that note. For pitches
  not covered by the sample set, the compiler auto-generates pitch-shifted
  variants from the nearest base sample (accumulator-based resampling). This
  enables full melodic lines from PCM samples — going beyond the traditional
  Mega Drive kick/snare-only PCM usage and opening up non-hardware-sounding
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
│     NOTE_ON  pitch=c4  len=120  envIds=[2]
│
└── ENVELOPE_TABLE  (section 0x0005)
      [id=2]  target=pitch  curve=easeOut  from=0  to=-48  frames=16
              delay=0  loop=false
      [id=3]  [target=tl4  curve=triangle  from=0  to=6  frames=8  loop=true]
              [target=tl1  curve=triangle  from=0  to=2  frames=8  loop=true]
```

**MMLisp authoring syntax:**

```lisp
; one-shot: synth tom pitch sweep
(def syntom-pitch :env :pitch (easeOut :from 0 :to -48 :len 16))

; one-shot: brass scoop-up
(def scoop :env :pitch (easeIn :from -18 :to 0 :len 6))

; looping LFO: vibrato (delay before onset)
(def vibrato :env :pitch (sin :from -10 :to 10 :len 16
                          :delay 24))

; looping LFO: tremolo on TL (carrier level)
(def tremolo :env :tl1 (triangle :from 0 :to 3 :len 8))

; step sequence: traditional PSG vol envelope
(def pluck :env :vol [15 12 8 4 2 1 0])
(def pad   :env :vol [15 :loop 14 13])
(def organ :env :vol [15 :loop 14 13 :release 3])
```

**Decided: `:vol` is a logical volume scale — `0` = silent, `15` = maximum — on all
channel types.** The compiler maps to hardware per channel:

| Channel          | Hardware mapping                                        |
| ---------------- | ------------------------------------------------------- |
| PSG (srq, noise) | `hw_attenuation = 15 − vol` (SN76489: 0=max, 15=silent) |
| FM (fm1–fm4)     | carrier-TL offset applied to all carrier operators      |
| PCM (dac)        | direct mixing-volume scaling                            |

`[15 12 8 4 2 1 0]` therefore reads as "loud → silent" on every channel type; no
polarity surprises for the composer.

**`:extends` — compile-time def inheritance:**

A FM voice def can inherit all parameter values from a base def and override
only specific keys. The compiler merges the two at compile time — one complete
`VOICE_SET` is emitted with no runtime cost.

```lisp
; base: safe "all-zero" initialisation patch
(def fm-init
  :alg 0 :fb 0
  :ar1 31 :dr1 0 :sr1 0 :rr1 15 :sl1 0 :tl1 127 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2 0 :sr2 0 :rr2 15 :sl2 0 :tl2 127 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3 0 :sr3 0 :rr3 15 :sl3 0 :tl3 127 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4 0 :sr4 0 :rr4 15 :sl4 0 :tl4 127 :ks4 0 :ml4 0 :dt4 0)

; brass = fm-init values, with specific keys overridden
(def brass :extends fm-init
  :alg 7
  :tl1 20 :tl2 30 :tl3 25 :tl4 0
  :ar1 28 :dr1 10 :sr1 5)

; chaining: dark-brass extends brass, overrides tl further
(def dark-brass :extends brass
  :tl1 40 :tl2 50)
```

Rules:

- `:extends` is a compile-time operation only — no runtime branching
- Any key present in the child overrides the parent; unmentioned keys are
  inherited from the parent
- Chains are resolved depth-first; cycles are a compiler error
- `:extends` is valid only on FM voice defs (not on envelope defs or PCM defs)

**Attaching an envelope to a voice def:**

```lisp
(def syntom
  :alg 7  :fb 0
  :ar1 31 :dr1  5 :sr1  0 :rr1  3 :sl1  7 :tl1  0 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2  5 :sr2  0 :rr2  3 :sl2  7 :tl2  0 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3  5 :sr3  0 :rr3  3 :sl3  7 :tl3  0 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4  5 :sr4  0 :rr4  3 :sl4  7 :tl4  0 :ks4 0 :ml4 0 :dt4 0
  :env syntom-pitch)            ; envelope fires on every NOTE_ON

(def brass
  :alg 7  :fb 0
  :ar1 31 :dr1  0 :sr1  5 :rr1  3 :sl1  7 :tl1  0 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2  0 :sr2  5 :rr2  3 :sl2  7 :tl2  0 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3  0 :sr3  5 :rr3  3 :sl3  7 :tl3  0 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4  0 :sr4  5 :rr4  3 :sl4  7 :tl4  0 :ks4 0 :ml4 0 :dt4 0
  :env scoop)                   ; scoop fires on every note
```

**Inline override:**

```lisp
(fm1  :oct 4 :len 1/4
  syntom :env syntom-pitch  c
  snare                     c)   ; explicit per-note env attach
```

**Multi-stage envelopes** — a vector of `(curve ...)` forms, parsed automatically:

```lisp
(def vib-entry :env :pitch
  [(easeIn :from -12 :to 0 :len 6)          ; scoop up
   (sin    :from -10 :to 10 :len 16)]        ; then vibrato
```

**Multi-target envelope** — a single `def :env` can drive multiple parameters
simultaneously by listing multiple `:key (curve ...)` pairs:

```lisp
; two TL parameters simultaneously
(def trem-brass :env
  :tl4 (triangle :from 0 :to 6 :len 8)
  :tl1 (triangle :from 0 :to 2 :len 8))

; vol step sequence + pitch sweep in one def — valid combination
(def syntom :env
  :vol   [15 12 8 4 2 1 0]
  :pitch (easeOut :from 0 :to -48 :len 16))

; voice def: env fires on every NOTE_ON
(def brass :extends fm-init
  :alg 7
  :env trem-brass)

; inline override per note
(fm1 :oct 4 :len 1/4
  brass :env trem-brass  c e g e)
```

Parser rule:

| `[...]` content after `:env` | Meaning                         |
| ---------------------------- | ------------------------------- |
| `(curve-name ...)` forms     | Multi-stage — sequential stages |

**Multi-stage execution order — sequential:** stages run one after another on
the same key. Stage N begins only after stage N−1 completes (`frames` elapsed).
If stage N−1 is a loop waveform, it loops indefinitely and stage N is never
reached — use this to model an attack → sustain-loop pattern.

**Contrast with multi-target:** listing multiple `:key (curve ...)` pairs in one
`def :env` runs all targets **simultaneously** from KEY-ON — each on its own
independent timeline. Multi-stage (sequential) and multi-target (simultaneous)
compose freely: each target key can independently carry a single curve or a
`[...]` stage vector.

```lisp
; sequential: scoop then loop-vibrato on pitch
(def vib-entry :env :pitch
  [(easeIn :from -12 :to 0 :len 6)    ; stage 1 — completes after 6 frames
   (sin    :from -10 :to 10 :len 16)])  ; stage 2 — starts at frame 7, loops by nature

; simultaneous: two TL targets fire together at KEY-ON
(def trem-brass :env
  :tl4 (triangle :from 0 :to 6 :len 8)
  :tl1 (triangle :from 0 :to 2 :len 8))

; both at once: :pitch is sequential, :vol runs in parallel alongside it
(def syntom-env :env
  :vol   [15 12 8 4 0]                ; vol stages run sequentially
  :pitch (easeOut :from 0 :to -48 :len 16))  ; pitch curve runs simultaneously
```

**Driver state per channel:** up to 4 env slots `{ envId, stage, phase, delay_count }` —
all slots reset on every KEY-ON, each advanced independently every frame tick.

**FM vs PSG F-number resolution:** the `:pitch` delta unit in an envelope is defined
as a hardware-independent semitone-fraction. The compiler scales to F-number
bits at emit time based on channel type (FM: 11-bit F-number; PSG: 10-bit
tone register). Envelope table stores the logical delta; the driver reads the
pre-scaled value from the table.

**Decided: `:from`/`:to` unit is semitone-cents (100 = 1 semitone).** The compiler
scales to F-number register bits at emit time based on channel type. Authors never
deal with raw F-number delta; hardware differences are a compiler detail.

**Decided: `:len` for curve duration.**

Wherever a duration appears in a curve form — including `:delay` — `:len`
accepts either an integer (= frames) or a fraction (= musical time).
The compiler converts ticks → frames using the score's BPM and driver frame
rate (typically 60 fps):

```
frames = (ticks / PPQN) * (BPM / 60) * fps
```

```lisp
(def vibrato :env :pitch (sin :from -10 :to 10 :len 1/4
                          :delay 1/4))    ; both period and delay in musical time

(def syntom-pitch :env :pitch (easeOut :from 0 :to -48 :len 1/4))

(def vibrato-late :env :pitch (sin :from -10 :to 10 :len 1/4
                               :delay 8)) ; delay in frames, period in musical time
```

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

**Decided: No chord syntax. Write each channel independently.**

Each channel form addresses a single channel. For chord writing across
multiple FM channels, use explicit parallel channel forms — one per voice:

```lisp
(fm1 :oct 3  c)
(fm2 :oct 3  e)
(fm3 :oct 3  g)
```

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

Loop waveforms (`sin`, `triangle`, `saw`, `square`, `noise`, `pink`, `perlin`) always loop — no `:loop` flag needed. Easing curves and `linear` are always one-shot. The compiler sets the `loop` flag in the binary based on curve name.
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
| `NF` | 2 bit | 00/01/10 = fixed rate ÷16/÷32/÷64; 11 = srq3 freq |

When `NF=11`, the noise channel clocks from `srq3`'s tone generator. `srq3`
simultaneously produces its own tone output, enabling **tone + noise mix**.

**Design: `:mode` is a channel option and inline modifier.**

Noise mode is set via `:mode` on the `noise` channel — the same pattern as
`:mode drum` on `pcmN`.
Envelope is attached separately via `:env` or via a `def` reference.

```lisp
; named envelope defs
(def hh-closed-env :env :vol [15 8 0])
(def hh-open-env   :env :vol [15 12 10 8 4 0])
(def ride-env      :env :vol [15 14 13 :loop 12 11])

; noise track
(noise :mode white0
  :len 1/8 :env hh-closed-env
  c c
  :mode white2 :env hh-open-env
  c
  :mode white0 :env hh-closed-env
  c c
  :mode periodic0 :env ride-env
  c)
```

A `:mode` change emits `NOISE_MODE` IR event (FB + NF bits).
A `:env` change emits `ENV_ATTACH` IR event.

`:noise` values — single keyword encoding FB + NF bits:

| Value       | FB  | NF   | Meaning                    |
| ----------- | --- | ---- | -------------------------- |
| `white0`    | 1   | `00` | white, fastest (÷16)       |
| `white1`    | 1   | `01` | white, medium (÷32)        |
| `white2`    | 1   | `10` | white, slowest (÷64)       |
| `white3`    | 1   | `11` | white, freq = srq3         |
| `periodic0` | 0   | `00` | periodic buzz, fastest     |
| `periodic1` | 0   | `01` | periodic buzz, medium      |
| `periodic2` | 0   | `10` | periodic buzz, slowest     |
| `periodic3` | 0   | `11` | periodic buzz, freq = srq3 |

**srq3 link example:**

```lisp
(noise :mode white3
  :len 1/4  c _ c _)

(srq3                              ; srq3 drives noise frequency
  :oct 4 :len 1/4  c _ c _)       ; also audible as tone
```

**Decided: `:mode` inline modifier covers mid-track noise change.** No
additional syntax needed. Use `:mode white2` mid-track
to change noise mode.

---

### 2.9 Inline parameter authoring (PMD-style)

**Decided: inline `:key val` for all parameter writes. `(set ...)` and `param-set` are removed.**

Hardware parameter writes use the same `:key val` syntax as note modifiers.
The compiler distinguishes them by key name:

| Key class       | Examples                                              | Compile behaviour                                                                   |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Sequencer state | `:oct` `:len` `:gate` `:vol`                          | compile-time state only — folded into NOTE_ON; `:vol` uses logical scale (see §2.5) |
| Hardware params | `:tl1`–`:tl4` `:ar1`–`:ar4` `:fb` `:dt1` `:mode` etc. | emit `PARAM_SET` IR event                                                           |
| Curve value     | `:tl2 (easeOut ...)`                                  | emit `PARAM_SWEEP` IR event                                                         |

All hardware parameter values are **absolute** (register value written directly).
Relative/delta notation (e.g. `:tl1 +5`) is not supported.

```lisp
(fm1 :oct 4 :len 1/8
  :tl1 30 :dt1 5        ; PARAM_SET — hardware writes
  c e g e
  :tl2 (easeOut :from 28 :to 20 :len 8)   ; PARAM_SWEEP
  c e g e)
```

**PMD command mapping — updated:**

| PMD command         | MMLisp v0.4                  | Status                             |
| ------------------- | ---------------------------- | ---------------------------------- |
| `@N` (tone)         | bare identifier `name`       | ✅                                 |
| `o N` (octave)      | `:oct N`                     | ✅                                 |
| `l N` (length)      | `:len N`                     | ✅                                 |
| `Q/q` (gate)        | `:gate N`                    | ✅                                 |
| `v N` (volume)      | `:vol N`                     | ✅                                 |
| `D N` (detune)      | `:dt1 N`                     | ✅ one IR write; HW state persists |
| `O slot,val` (TL)   | `:tl1 N` etc.                | ✅ same                            |
| `s mask` (FM3 slot) | implicit from `fm3-N` tracks | ✅ resolved by §2.1                |
| `P N` (SSG mix)     | `:mode` on `noise` channel   | ✅ resolved by §2.8                |
| `w N` (noise freq)  | `:mode` on `noise` channel   | ✅ resolved by §2.8                |
| `M` (software LFO)  | `:param (curve-name ...)`    | ✅ resolved by §2.11               |

---

### 2.10 Loop break (volta-style last-pass skip)

A common pattern in music: repeat a phrase N times, but on the final pass skip
a tail section (e.g. a fill or transition). PMD MML uses `[A:B]N` — part A plays
every iteration, part B is skipped on the last pass.

Proposed MMLisp syntax — two equivalent forms:

**Track-body level** — when part A and part B are separate note groups or other forms:

```lisp
(x 4
  c d e          ; part A: every pass
  (break)        ; on final pass: jump past LOOP_END
  f g)           ; part B: skipped on pass 4
```

**Inline** — when the break point falls mid-sequence:

```lisp
(x 4
  c d e :break f g)   ; :break splits the sequence into part A / part B
```

Both compile to the same `LOOP_BREAK` IR event at the current tick position.
`:break` is an inline modifier that emits `LOOP_BREAK` and continues parsing
the remaining items as part B.

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

Distinct from KEY-ON envelopes (§2.5): a sweep (one-shot or looping) that
starts at the current track position and runs independent of note events.
Useful for filter-style TL sweeps, cross-section pitch glides, synth-pad
slow attacks, or track-position-locked LFOs driven from the track timeline
rather than per-note.

**Authoring syntax** — inline `:key curve-form` (same position as any `:key val`):

```lisp
; one-shot: TL sweep over 8 frames starting now
(fm1 :oct 4 :len 1/8
  :tl2 (easeOut :from 28 :to 20 :len 8)
  c e g e)

; one-shot: pitch glide between sections
(fm1 :oct 4 :len 1/4
  :pitch (linear :from 0 :to 12 :len 16)
  c d e  :pitch 0  f g)

; looping: track-position-locked tremolo starting at this point
(fm1 :oct 4 :len 1/4
  :tl1 (triangle :from 0 :to 4 :len 8)
  c e g e ...)
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
    "frames": 8,
    "loop": false
  }
}
```

The `loop` field in the IR is **compiler-derived** from the curve name: loop waveforms (`sin`, `triangle`, etc.) emit `loop: true` automatically; easing curves and `linear` emit `loop: false`. A looping `PARAM_SWEEP` repeats indefinitely from the track position
where it was emitted. A subsequent `PARAM_SWEEP` for the same target cancels
the looping sweep and replaces it (same rule as one-shot).

**Driver implementation:** one `PARAM_SWEEP` opcode. The driver stores a
per-channel sweep state `{ target, curve, from, to, frames, phase, loop }` and
advances it each frame tick, writing the interpolated register value.
When `loop=true`, `phase` wraps back to 0 on completion instead of stopping.
A new `PARAM_SWEEP` for the same target cancels the previous one (one-shot or looping).

This is the track-timeline counterpart to `ENVELOPE_TABLE`. Together they
cover all time-varying parameter needs:

| Trigger         | Mechanism                             | Use case                                  |
| --------------- | ------------------------------------- | ----------------------------------------- |
| KEY-ON per note | `ENVELOPE_TABLE` + `envId` in NOTE_ON | vibrato, synth tom, scoop                 |
| Track timeline  | `PARAM_SWEEP` opcode (one-shot)       | TL fade, global pitch slide               |
| Track timeline  | `PARAM_SWEEP` with loop waveform      | section-locked LFO, persistent tremolo/TL |

**Decided: `:from` is optional.** When omitted, the sweep starts from the
current value of that parameter. The driver maintains one `last_written[target]`
register per parameter per channel, updated by NOTE_ON, PARAM_SWEEP, and `:glide`
alike — so a PARAM_SWEEP ending at value X means the next `:glide` starts from X.

```lisp
; portamento — from current pitch, slide to note pitch over 8 frames
(def portamento :env :pitch (linear :to 0 :len 8))
; :to 0 = note's own pitch; :from omitted = last_written[pitch]
```

Applies to both `ENVELOPE_TABLE` (§2.5) and `PARAM_SWEEP` (§2.11).

---

### 2.12 Portamento — `:glide` channel option

**Decided:**

`:glide N` is a sticky channel option that enables automatic portamento: before
each NOTE_ON the compiler inserts a `PARAM_SWEEP` that slides pitch from the
previous note's pitch to the new note's pitch over `N` frames.

```
:glide N          — slide duration in frames (integer); 0 = disabled
:glide-from note  — override the starting pitch for the next note only
                    (note token, e.g. c4, g+3)
```

**Rules:**

- `:glide` applies to FM, PSG, and CSM channels. Not applicable to PCM.
- On CSM channels, the sweep target is `csm-rate` instead of `pitch`; the
  compiler converts note tokens to Timer A Hz values automatically.
- On the **first note** of a channel (no previous pitch in `last_written[pitch]`),
  portamento is skipped — the note fires directly.
- `:glide-from` overrides the starting pitch for **one note**, then resets.
  Useful for starting a phrase from an arbitrary pitch.
- `:glide 0` disables portamento mid-track.

**Examples:**

```lisp
; basic portamento — 8-frame slide between every note
(fm1 :oct 4 :len 1/4 :glide 8
  c e g e)

; start from an explicit pitch (c3 → e4 over 8 frames)
(fm1 :oct 4 :len 1/4 :glide 8 :glide-from c3
  e g a g)

; disable mid-phrase
(fm1 :oct 4 :len 1/4 :glide 8
  c e
  :glide 0
  g e)
```

**Compiled IR sketch (`:glide 8`, previous pitch = c4, current note = e4):**

```json
{ "op": "PARAM_SWEEP", "target": "pitch", "from": "c4", "to": "e4", "curve": "linear", "frames": 8 }
{ "op": "NOTE_ON", "note": "e4", ... }
```

---

### 2.13 Note sequences — flat inline syntax

**Decided** (per §1.3):

Notes, rests, modifiers, and structural forms are written directly in the channel
body — no sequence wrapper.

| Form                   | Context                                     | Interpretation                                     |
| ---------------------- | ------------------------------------------- | -------------------------------------------------- |
| note / rest / modifier | Channel body; `(x N ...)` body; `def` body  | Direct sequencing                                  |
| `(notes...)`           | Inline when first element is a note         | Subgroup / tuplet — current `:len` divided equally |
| `(len notes...)`       | Inline when first element is a length token | Subgroup with explicit total length                |
| `(curve-name ...)`     | After `:env`; value of `:key` inline        | Curve spec                                         |
| `[(stage1) (stage2)]`  | After `:env`                                | Multi-stage envelope                               |

**Examples:**

```lisp
; note sequence flat in channel body
(fm1 :oct 4 :len 1/4  c e g c)

; :oct 5 persists after the phrase
(fm1 :oct 4 :len 1/8  c e g e  :oct 5  c e g e)

; bare identifier switches voice (no @ prefix)
(fm1 :oct 4 :len 1/8  brass  c e g e  :tl1 20  c e g e)

; subgroup (triplet): 3 notes sharing current :len (1/4 → 40 ticks each)
(fm1 :len 1/4  c  (e g a)  f)

; subgroup with explicit length: 3 notes sharing 1/2
(fm1 :len 1/8  c  (1/2 e g a)  f)

; single-stage envelope
(def syntom-pitch :env :pitch (easeOut :from 0 :to -48 :len 16))

; multi-stage envelope ([...] retained after :env only — data vector, not note sequence)
(def vib-entry :env :pitch
  [(easeIn :from -12 :to 0 :len 6)
   (sin    :from -10 :to 10 :len 16)])

; curve value inline (emits PARAM_SWEEP)
(fm1 :len 1/8  :tl2 (easeOut :from 28 :to 20 :len 8)  c e g e)
```

**Decided: `(seq ...)` and `[...]` (note sequence form) are both removed in v0.4.** No deprecated aliases.
`[...]` is retained **only** after `:env` for multi-stage envelopes (data vector context).
Existing demo sources (`demo1-stage-loop.mmlisp`, `demo2-event-recovery.mmlisp`)
use `(seq ...)` and `(track :ch ...)` throughout — a one-time rename pass is
required before those files are used with the v0.4 compiler.

---

## 3. Out of Scope for v0.4

- DT2 (second detune register) — out of scope for all versions until needed
- FM3 + CSM simultaneous use (hardware exclusive)
- 3ch PCM at 17.5 kHz with full pitch+volume (cycle budget; use 13.3 kHz for 3ch)
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

| Priority | §                           | Status     | Notes                                                                                |
| -------- | --------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| 1        | §2.10 Loop break            | ✅ Decided | `LOOP_BREAK` opcode, `(break)` / `:break`                                            |
| 2        | §2.1 FM3 OP syntax          | ✅ Decided | `fm3-N` channel names, patch-only `fm3` track                                        |
| 3        | §2.8 PSG noise              | ✅ Decided | `:mode` channel option; inline `:mode noise-val` mid-track                           |
| 4        | §2.3 CSM                    | ✅ Decided | melodic model, `CSM_ON` implicit, `:csm-rate val` inline                             |
| 5        | §2.5 + §2.11 Envelope/sweep | ✅ Decided | `ENVELOPE_TABLE`, `PARAM_SWEEP`; KEY-OFF release deferred                            |
| 6        | §2.7 Curve functions        | ✅ Decided | LUT 256-entry, easings.net 30 + 8 loop waveforms                                     |
| 7        | §2.9 Inline param authoring | ✅ Decided | `(set ...)` removed; inline `:key val` for all param writes; `param-set` removed     |
| 8        | §2.4 PCM                    | ✅ Decided | Plan B: up to 3ch (`pcm1`–`pcm3`), pitch+vol, drum/texture; sub-items deferred       |
| 9        | §2.13 Note sequence syntax  | ✅ Decided | `(seq)` and `[...]` both removed; flat inline; `(default)` removed                   |
| 10       | §2.6 Chord/multi-ch         | ✅ Decided | No chord syntax; use explicit parallel channels                                      |
| 11       | §1.3 channel-as-form        | ✅ Decided | `(track :ch X ...)` → `(X ...)`; `@voice` → bare identifier; `track` keyword removed |
| —        | §2.2 FM3 chord              | ✅ Decided | No chord syntax; write each `fm3-N` channel independently                            |

### FM3 OP syntax (§2.1) — current thinking

`fm3-N` channel names (rather than `:op N` option) is the preferred direction:

- No new syntax — channel names extend the existing name table (same as `csm`, `pcmN`)
- Implicit special-mode enable from channel name alone, consistent with other exclusive channels
- PMD `s mask` (bit field OP4=8, OP3=4, OP2=2, OP1=1) maps to which `fm3-N`
  tracks are present in the score
- Shared patch declared via note-less `(fm3 voice-name)` — no new syntax needed
