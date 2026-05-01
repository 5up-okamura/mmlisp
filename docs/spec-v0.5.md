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

_Nothing decided yet — all items below are open questions._

---

## 2. Open Questions

### 2.1 FM3 independent-operator mode

YM2612 FM channel 3 has a special mode where each of its 4 operators can be
given an independent F-number (pitch), while still being combined via the
algorithm. This enables:

- Chord voicing from a single FM channel (4 independent pitches)
- Pseudo-polyphony for drum kits (different pitched hits from one channel)
- Spectral shaping — tuning individual partials for bell, glass, or inharmonic
  timbres

**Proposed: `fm3-1`–`fm3-4` channel names for independent-OP authoring.**

Each `fm3-N` track drives OP N's F-number. The shared voice (ALG, FB, TL,
ADSR per operator) is declared via a note-less `(fm3 voice-name)` form.

```lisp
; drum kit using FM3 independent-OP mode
(fm3 drum-kit)            ; declare shared patch — enables FM3 special mode

(fm3-1 :oct 5 :len 8  c c)   ; OP1 — high hit
(fm3-2 :oct 3 :len 4  c _ )  ; OP2 — low hit
(fm3-3 :oct 4 :len 8  c c)   ; OP3 — mid hit
(fm3-4 :oct 2 :len 2  c _)   ; OP4 — sub hit
```

**Open questions:**

- How is `fm3` special mode enabled in the IR? Implicit from the presence of
  `fm3-N` channels? Or explicit compiler flag?
- `s mask` (PMD) maps to which `fm3-N` tracks are present — confirm the
  bitmask definition (OP4=8, OP3=4, OP2=2, OP1=1).
- Can `fm3` and `fm3-N` coexist in the same score, or are they mutually
  exclusive within a section?
- Envelope attachment per operator: does each `fm3-N` track carry its own
  `:macro` independently?
- Is `:glide` supported per operator on `fm3-N` tracks?

### 2.2 CSM — composite sinusoidal modelling

CSM mode uses YM2612 Timer A overflow to repeatedly key-on FM3, producing a
pitched buzz useful for speech synthesis and experimental effects. By sweeping
`csm-rate` over time (like a VCF cutoff), vowel-like timbral shifts and
growl/wah effects are possible.

**Proposed: `csm` channel name for CSM authoring.**

```lisp
(csm brass  :csm-rate 200  :len 4
  c d e f)

; sweep csm-rate inline — same as any other param sweep
(csm brass  :csm-rate (ease-out :from 440 :to 880 :len 8)
  c c c c)
```

CSM model: melodic — the note on the `csm` channel defines the tonal center;
`csm-rate` controls the Timer A frequency.

**IR events:**

- `CSM_RATE`: `{ cmd: "CSM_RATE", args: { hz: N } }` — sets Timer A frequency
- `CSM_ON`: implicit on every NOTE_ON for a `csm` channel

**Open questions:**

- CSM is exclusive with `fm3` and `fm3-N` — Timer A is consumed by CSM.
  How does the compiler enforce this? Compile error if both present?
- `LOOP_BEGIN` countdowns must use Timer B when CSM is active — driver concern,
  but does the compiler need to flag this?
- What is the valid range for `:csm-rate` (Hz)? What happens at the limits?
- Is `:glide` applicable to CSM channels (sliding `csm-rate`)?

### 2.3 PCM playback

**Proposed: Plan B — up to 3ch software-mixed PCM with pitch and volume control.**

PCM channels `pcm1`–`pcm3` play back raw sample data via YM2612's DAC (the
fm6 DAC output). The Z80 mixes up to 3 channels at up to 17.5 kHz (2ch) or
13.3 kHz (3ch) per-frame, with pitch transposition and volume scaling.

Reference implementations: MDSDRV (2ch 17.5 kHz, 16-step volume, batch DMA),
Sonic 3 K driver (1ch PCM + FM6 alternation).

```lisp
; single PCM hit
(pcm1 :len 4  :mode shot  kick _ snare _)

; pitched melodic PCM (transposed from base sample)
(pcm2 :oct 4 :len 8  :mode melodic  c d e f)

; texture / drone
(pcm3 :len 1 :vol 8  :mode texture  c)
```

**Open questions:**

- Sample declaration syntax: how are sample files referenced? A `(sample ...)` def?
  What format — raw 8-bit signed, or 4-bit DPCM?
- Pitch transposition method: accumulator-based resampling from nearest base sample?
  How many semitones of range per sample?
- Volume control: 16-step (4-bit) or full 0–15 logical scale matching `:vol`?
- PCM channel names `pcm1`–`pcm3`: does using any of them automatically disable
  fm6 as an FM channel for that section?
- Can fm6 and pcmN coexist via mid-track mode switching (as noted in v0.4)?
  If so, what is the syntax — a bare `:mode` switch on the track?
- 3ch vs 2ch: is the channel count fixed per score, or dynamic?
  How does the compiler communicate the mix configuration to the driver?
- DPCM compression format selection — still deferred?
- DMA protection scheme — still deferred?

---

## 3. Out of Scope for v0.5

- DT2 (second detune register) — deferred indefinitely
- FM3 chord polyphony — explicitly out of scope (no chord model; each
  `fm3-N` OP is sequenced independently as a monophonic voice)
- Runtime subroutines (`CALL`/`RET`) — `defn` remains compile-time only
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
| `SET_PARAM ch k v` | Write a delta value to `key` on channel `ch` at runtime        |
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
- PCM loops (`loop` / `loop-gate` mode) held open indefinitely

```lisp
; loop indefinitely until game sends KEY_OFF
(sqr1 :len 0 :macro pad-env  c)

; PCM texture loop — holds open until STOP_TRACK
(pcm2 :mode loop :len 0
  :loop-start 0 :loop-end 4096  drone)
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

## 5. OQ Resolution Priority

Open questions pending resolution:

| Priority | §    | Topic                   | Status  | Notes                                               |
| -------- | ---- | ----------------------- | ------- | --------------------------------------------------- |
| 1        | §2.2 | CSM                     | ⬜ Open | Timer A exclusivity with FM3; csm-rate range        |
| 2        | §2.1 | FM3 independent OP mode | ⬜ Open | Channel naming, mask bitmask, mode enable mechanism |
| 3        | §2.3 | PCM playback            | ⬜ Open | Sample declaration, pitch range, fm6 coexistence    |
