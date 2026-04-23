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

| Name    | Hardware                              | Notes                                     |
| ------- | ------------------------------------- | ----------------------------------------- |
| `fm3`   | YM2612 FM channel 3 (normal use)      | Already valid in v0.3                     |
| `csm`   | YM2612 FM3 + Timer A in CSM mode      | New in v0.4; exclusive with `fm3` and FM3 OP tracks |
| `noise` | SN76489 noise channel                 | Already valid in v0.3                     |
| `dac`   | YM2612 DAC (fm6 in PCM mode)          | New in v0.4; exclusive with `fm6`         |

When `:ch csm` is declared, the compiler emits `CSM_ON` and reserves fm3 and
Timer A. When `:ch dac` is declared, fm6 is switched to DAC mode; any `fm6`
track in the same score is a compiler error (`E_DAC_FM6_CONFLICT`).

---

## 2. Open Questions

### 2.1 FM3 independent-operator mode

YM2612 FM3 allows each of its 4 operators to use an independent F-number,
enabling 4 different pitches on one FM channel. This is useful for:

- **Drum kit**: OP1=kick, OP2=snare, OP3=tom, OP4=hihat (each key-ons
  independently)
- **4-voice chord**: all 4 OPs key-on simultaneously at different pitches

Two syntaxes are under consideration:

**Option A — 4 separate tracks with `:op N`:**

```lisp
(track :ch fm3 :op 1 :role bgm   ; OP1 as kick
  (seq :oct 2 :len 1/4  c _ _ _))

(track :ch fm3 :op 2 :role bgm   ; OP2 as snare
  (seq :oct 3 :len 1/4  _ c _ c))
```

- Natural fit with existing track append model
- Each OP has its own tick timeline and phrase structure
- `:op` is a new track option (1–4); implies `FM3_MODE` enable

**Option B — single track with `(op1 ...)` sub-forms:**

```lisp
(track :ch fm3 :role fm3-kit
  (op1 (seq :oct 2 :len 1/4  c _ _ _))
  (op2 (seq :oct 3 :len 1/4  _ c _ c)))
```

- More compact for drum kits
- Harder to reuse phrases across OPs

**Open**: which syntax, or context-dependent choice?

### 2.2 FM3 chord — multi-pitch simultaneous key-on

When all 4 OPs key-on at the same tick (chord use case), a dedicated
chord form may be more natural than 4 synchronized tracks:

```lisp
(track :ch fm3
  (chord c3 e3 g3 b3)   ; key-on all 4 OPs simultaneously
  (chord f3 a3 c4 e4))
```

`(chord ...)` in FM3 context sets each OP's F-number independently then
fires a single key-on write.

**Relationship to §2.1**: the `:op` track model and `chord` are not
mutually exclusive. `:op` tracks handle rhythmic/independent timelines;
`chord` handles homophonic writing on the same timeline.

**Open**: how does `chord` interact with `:ch` for non-FM3 channels?
(See §2.6 for general chord / multi-ch design.)

### 2.3 CSM — composite sinusoidal modelling

CSM mode uses YM2612 Timer A overflow to repeatedly key-on FM3, producing
a pitched buzz useful for speech synthesis and experimental effects.

```lisp
(track :ch csm
  (csm-rate 220)      ; set Timer A frequency (Hz or ticks)
  (seq :oct 3  c e g))
```

Constraints:
- Exclusive with `:ch fm3` and FM3 `:op` tracks in the same score
- Timer A is consumed; LOOP_BEGIN countdowns must use Timer B only (driver concern)
- `CSM_RATE` IR event: `{ cmd: "CSM_RATE", args: { hz: N } }`
- `CSM_ON` / `CSM_OFF` bracket the active region

**Open**: authoring syntax for `CSM_ON`/`CSM_OFF` — implicit from track
presence, or explicit `(csm-on)` / `(csm-off)` calls?

### 2.4 DAC / PCM playback

`:ch dac` switches fm6 to 8-bit PCM output mode. Sample data is referenced
by name and stored in a new `samples` section of the GMB file.

```lisp
(def kick-sample :pcm "samples/kick.raw")  ; 8-bit unsigned, 8kHz

(track :ch dac
  (seq :len 1/4  @kick-sample _ @kick-sample _))
```

- `@name` in dac context emits `DAC_NOTE { sample: "kick-sample" }` instead
  of `NOTE_ON`
- No pitch control in v0.4 (fixed playback rate); pitch-shifted DAC is future scope
- Sample data in GMB: new section type `0x0004 SAMPLE_TABLE`

**Open**: sample rate and format constraints (8kHz? 11kHz? mono only?).
Driver-side buffering design needed before this can be frozen.

### 2.5 Pitch envelope

A named pitch envelope definition, applicable to any tone channel (FM or PSG).
The envelope describes F-number delta over time, resolved at compile time to
`PARAM_SET :pitch` / `PARAM_ADD :pitch` events.

```lisp
(def tom-pitch :pitch-env
  [:seq 0 -8 -16 -24 -32 -40])   ; downward sweep, 6 frames

(def tom-pitch-smooth :pitch-env
  [:fn easeOut 0 -48 16])        ; fn-generated: start 0, end -48, 16 frames

(track :ch psg1
  (seq @tom  c4  @snare  c3))    ; @tom triggers note + pitch envelope
```

Pitch envelope trigger options:
- Attached to a `def :psg` voice (envelope fires on every note using that voice)
- Inline with `(pitch-env name)` before a note

**Open**: how does pitch envelope interact with FM vs PSG (F-number resolution
differs between hardware)?

### 2.6 Chord / multi-channel syntax

In v0.3, `:ch` accepts a single channel only. For chord writing across
multiple FM channels (e.g. fm1+fm2+fm3 playing the same rhythm at different
pitches), options are:

**Option A — `(chord ...)` form in track body:**

```lisp
(track :ch fm1
  (chord :chs [fm1 fm2 fm3]  c3 e3 g3))  ; 3-ch chord
```

**Option B — restore multi-ch `:ch` with voice-stealing rules:**

```lisp
(track :ch [fm1 fm2 fm3] :role bgm
  (seq c3 e3 g3))   ; compiler assigns notes round-robin or by pitch
```

**Option C — explicit parallel tracks (current workaround):**

```lisp
(track :ch fm1 :oct 3 (seq c))
(track :ch fm2 :oct 3 (seq e))
(track :ch fm3 :oct 3 (seq g))
```

Option C works today but is verbose. Options A and B require new compiler logic.

**Open**: no decision yet. Depends on authoring experience from v0.4 compositions.

### 2.7 `:fn` — function-generated envelope

Currently reserved with `E_FN_NOT_IMPL` error. Defines an envelope using a
named curve function and parameters:

```lisp
(def sweep    :psg [:fn easeOut 15 0 32])  ; easeOut from 15 to 0 over 32 frames
(def attack   :psg [:fn linear  0 15 8])   ; linear from 0 to 15 over 8 frames
(def tom-env  :psg [:fn easeOut 15 0 16])  ; synth tom volume

(def tom-pitch :pitch-env [:fn easeOut 0 -48 16])  ; pitch sweep
```

Built-in curve names (proposed):

| Name       | Shape                                      |
| ---------- | ------------------------------------------ |
| `linear`   | straight line                              |
| `easeOut`  | fast attack, slow decay (exponential)      |
| `easeIn`   | slow attack, fast decay                    |
| `easeInOut`| S-curve                                    |
| `reverse`  | reverse of the referenced sequence         |

`reverse` takes a named `:seq` envelope as argument:

```lisp
(def pluck-rev :psg [:fn reverse pluck])   ; play pluck envelope backwards
```

**Open**: curve function set — start with `linear` + `easeOut` only?

### 2.8 PSG noise control

SN76489 noise register (byte format: `111 FB NF1 NF0`):

| Bits | Field | Meaning                                           |
| ---- | ----- | ------------------------------------------------- |
| `FB` | 1 bit | 0 = periodic (pitched buzz), 1 = white noise      |
| `NF` | 2 bit | 00/01/10 = fixed rate ÷16/÷32/÷64; 11 = PSG3 freq |

When `NF=11`, the noise channel clocks from PSG3's tone generator. PSG3
simultaneously produces its own tone output, enabling **tone + noise mix**.

Proposed syntax — `:noise-mode` as a track option or inline `param-set`:

```lisp
(track :ch noise :noise-mode [:white :psg3]   ; white noise, freq from psg3
  (seq :len 1/4  c _ c _))

(track :ch psg3                               ; psg3 sets noise frequency
  (seq :len 1/4  c4 _ c4 _))                 ; also audible as tone
```

`:noise-mode` values:

| Value              | FB | NF   | Meaning                         |
| ------------------ | -- | ---- | ------------------------------- |
| `[:white :rate0]`  | 1  | `00` | white, fastest (÷16)            |
| `[:white :rate1]`  | 1  | `01` | white, medium (÷32)             |
| `[:white :rate2]`  | 1  | `10` | white, slowest (÷64)            |
| `[:white :psg3]`   | 1  | `11` | white, freq = PSG3              |
| `[:periodic :rate0]`| 0 | `00` | periodic buzz, fastest          |
| `[:periodic :rate1]`| 0 | `01` | periodic buzz, medium           |
| `[:periodic :rate2]`| 0 | `10` | periodic buzz, slowest          |
| `[:periodic :psg3]`| 0 | `11` | periodic buzz, freq = PSG3      |

`:noise-mode` can be changed inline with `(param-set :noise-mode [...])`.

**Open**: should `:noise-mode` be changeable per-note (inline in `seq`) or
only as a track-level option and explicit `param-set`?

---

## 3. Out of Scope for v0.4

- DT2 (second detune register) — out of scope for all versions until needed
- FM3 + CSM simultaneous use (hardware exclusive)
- Pitch-shifted DAC playback (fixed rate only in v0.4)
- PCM/WAV sample instruments beyond `:pcm` raw format
- Runtime subroutines (`CALL`/`RET`) — `defn` remains compile-time only
- Patch import system — Future Vision
