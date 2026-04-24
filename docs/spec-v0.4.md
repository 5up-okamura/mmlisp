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

| Name    | Hardware                         | Notes                                               |
| ------- | -------------------------------- | --------------------------------------------------- |
| `fm3`   | YM2612 FM channel 3 (normal use) | Already valid in v0.3                               |
| `csm`   | YM2612 FM3 + Timer A in CSM mode | New in v0.4; exclusive with `fm3` and FM3 OP tracks |
| `noise` | SN76489 noise channel            | Already valid in v0.3                               |
| `dac`   | YM2612 DAC (fm6 in PCM mode)     | New in v0.4; exclusive with `fm6`                   |

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
  (chord :oct 3  c e g b)          ; key-on all 4 OPs at oct 3
  (chord :oct 3  f a  :oct 4  c e)) ; F3 A3 C4 E4 — oct changes mid-chord
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

The `:ch csm` track is also intended to function as a **synthesizer formant
filter**: by sweeping `csm-rate` over time (like a VCF cutoff), vowel-like
timbral shifts and speech-synthesis effects become possible. This is a primary
motivation for the driver's expressive design — not just a static register write.

**Static rate:**

```lisp
(track :ch csm
  (csm-rate 220)           ; set Timer A frequency to 220 Hz
  (seq :oct 3  c e g))
```

**Swept rate — using PARAM_SWEEP (§2.11):**

```lisp
(track :ch csm
  (set :csm-rate [:fn easeIn 80 440 32])   ; sweep 80→440 Hz over 32 frames
  (seq :oct 3  c e g))
```

**KEY-ON triggered rate envelope — using ENVELOPE_TABLE (§2.5):**

```lisp
(def vowel-open :env [:fn easeOut :target csm-rate :from 200 :to 800 :frames 24])

(track :ch csm
  (set :env vowel-open)    ; fires on each NOTE_ON
  (seq :oct 3  c e g))
```

`:target csm-rate` in an envelope definition maps to Timer A reload value.
The driver converts Hz to the YM2612 Timer A register byte at emit time.

**Note-pitch as csm-rate (design idea):**

Since Timer A frequency is directly the "pitch" of the CSM buzz, specifying
`csm-rate` as a musical note is more natural than Hz:

```lisp
(csm-rate :oct 4 c)   ; Timer A = 261.6 Hz — C at octave 4
(csm-rate :oct 3 a)   ; Timer A = 220 Hz — A at octave 3
```

Taken further, the notes in a `:ch csm` `seq` could **directly drive csm-rate**,
turning the track into a melodic voice:

```lisp
(track :ch csm @vowel              ; FM3 voice defines harmonic timbre
  (seq :oct 4 :len 1/4  c e g      ; csm-rate follows C E G at oct 4
       :oct 5            c))       ; then C at oct 5 — it sings
```

FM3's F-number (the overtone structure set by `@voice`) stays fixed; only the
key-on rate moves. The result is a sung, speech-like pitch line rather than a
static buzz.

This also composes naturally with KEY-ON envelopes (§2.5) for portamento-style
slides between notes, and PARAM_SWEEP (§2.11) for filter-sweep effects within
a held note.

**Open**: whether `:ch csm` `seq` notes mean csm-rate (melodic model) or FM3
pitch (harmonic model), or whether both are controllable independently.

Constraints:

- Exclusive with `:ch fm3` and FM3 `:op` tracks in the same score
- Timer A is consumed by CSM; `LOOP_BEGIN` countdowns must use Timer B only
  (driver concern)
- `CSM_RATE` IR event: `{ cmd: "CSM_RATE", args: { hz: N } }`
- `CSM_ON` / `CSM_OFF` bracket the active region

**Open**: authoring syntax for `CSM_ON`/`CSM_OFF` — implicit from track
presence, or explicit `(csm-on)` / `(csm-off)` calls?

**Open**: Hz-to-TimerA conversion precision — Timer A has 10-bit resolution;
musical use requires the compiler or driver to pre-compute a lookup table or
interpolate between integer register values.

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
(def syntom-pitch :env [:fn easeOut :target pitch :from 0 :to -48 :frames 16])

; one-shot: brass scoop-up
(def scoop :env [:fn easeIn :target pitch :from -18 :to 0 :frames 6])

; looping LFO: vibrato (delay before onset)
(def vibrato :env [:fn sin :target pitch :from -10 :to 10 :frames 16
                   :loop true :delay 24])

; looping LFO: tremolo on TL (carrier level)
(def tremolo :env [:fn triangle :target tl1 :from 0 :to 3 :frames 8
                   :loop true :delay 0])

; step sequence: traditional vol envelope
(def pluck :env [:seq :target vol  15 12 8 4 2 1 0])
```

`:target` specifies which parameter the envelope drives. Any `param-set`-capable
target is valid: `pitch`, `vol`, `tl1`–`tl4`, `fb`, `fm-dt1`, etc.

**Attaching an envelope to a voice:**

```lisp
(def syntom :psg { :env syntom-pitch })    ; fires on every NOTE_ON with @syntom
(def brass  :fm  { :env scoop })           ; scoop fires on every note
```

**Inline override within seq:**

```lisp
(seq :oct 4 :len 1/4
  @syntom :env syntom-pitch  c
  @snare                     c)   ; explicit per-note env attach
```

**Multi-stage envelopes** — a vector of `(curve ...)` forms, parsed automatically:

```lisp
(def vib-entry :env
  [(easeIn :target pitch :from -12 :to 0 :frames 6)     ; scoop up
   (sin    :target pitch :from -10 :to 10 :frames 16    ; then vibrato
           :loop true :delay 0)])
```

Parser rule: `[:fn curve ...]` → single-stage; `[(curve ...) ...]` → multi-stage.
No `compose` keyword needed.

**Driver state per channel:** `{ envId, stage, phase, delay_count }` —
reset on every KEY-ON, advanced every frame tick.

**FM vs PSG F-number resolution:** the `:target pitch` delta unit is defined
as a hardware-independent semitone-fraction. The compiler scales to F-number
bits at emit time based on channel type (FM: 11-bit F-number; PSG: 10-bit
tone register). Envelope table stores the logical delta; the driver reads the
pre-scaled value from the table.

**Open**: exact scaling factor and rounding for FM vs PSG; whether `:from`/`:to`
are in semitone-cents or raw F-number delta.

**Open — KEY-OFF triggered release stage:**

The v0.2 PSG envelope model had two KEY-OFF-triggered mechanisms:

- `[:seq ... :release N]` — volume decreases by 1 every N frames after key-off
- `[:adsr ... :rr N]` — release rate after key-off

The v0.4 `ENVELOPE_TABLE` model is KEY-ON triggered only. The v0.2 `:release`
and `:rr` behaviours have no direct equivalent.

**Workaround available:** set `:gate` to a fixed ratio so the release phase
is always compiled into the note length. This works for most game BGM patterns
where note length is known at compile time.

**True KEY-OFF trigger** would require:

- The driver to split NOTE_ON into `gate_len` (key-on duration) + `step_len`
  (full step), and advance the envelope to a designated release stage at
  `gate_len` expiry.
- `ENVELOPE_TABLE` to store a `release_stage_index` field (1 extra byte per
  entry).
- FM channels: FM hardware RR handles release automatically; this only affects
  PSG software envelopes.

Deferred to v0.4+ unless organ-style variable-length PSG notes are needed.

### 2.6 Chord / multi-channel syntax

In v0.3, `:ch` accepts a single channel only. For chord writing across
multiple FM channels (e.g. fm1+fm2+fm3 playing the same rhythm at different
pitches), options are:

**Option A — `(chord ...)` form in track body:**

```lisp
(track :ch fm1
  (chord :chs [fm1 fm2 fm3] :oct 3  c e g))  ; 3-ch chord at oct 3
```

**Option B — restore multi-ch `:ch` with voice-stealing rules:**

```lisp
(track :ch [fm1 fm2 fm3] :role bgm
  (seq :oct 3  c e g))   ; compiler assigns notes round-robin or by pitch
```

**Option C — explicit parallel tracks (current workaround):**

```lisp
(track :ch fm1 :oct 3 (seq c))
(track :ch fm2 :oct 3 (seq e))
(track :ch fm3 :oct 3 (seq g))
```

Option C works today but is verbose. Options A and B require new compiler logic.

**Open**: no decision yet. Depends on authoring experience from v0.4 compositions.

### 2.7 Curve functions for `:fn` envelopes

Used inside `[:fn ...]` envelope bodies (see §2.5). The driver stores the curve
type as an enum byte in the `ENVELOPE_TABLE` entry; values are computed per
frame in real time — no pre-expansion at compile time.

**Built-in curve names:**

| Name        | Shape                                          | Notes               |
| ----------- | ---------------------------------------------- | ------------------- |
| `linear`    | straight line from `from` to `to`              |                     |
| `easeOut`   | fast start, slow finish (exponential decay)    | synth tom, pluck    |
| `easeIn`    | slow start, fast finish                        | scoop, brass attack |
| `easeInOut` | S-curve                                        | smooth transitions  |
| `sin`       | full sine cycle over `frames`; loops naturally | vibrato             |
| `triangle`  | linear up then down; loops naturally           | tremolo             |

Multi-stage envelopes use `[(curve ...) (curve ...)]` syntax (see §2.5); no
special curve name is needed.

`reverse` is removed as a first-class curve; reversing a seq can be expressed
by swapping `:from` and `:to`.

**Open**: `easeInOut` can be deferred to v0.4+; minimum viable
set for v0.4 is `linear`, `easeOut`, `easeIn`, `sin`, `triangle`.

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
  (seq :oct 4 :len 1/4  c _ c _))            ; also audible as tone
```

`:noise-mode` values:

| Value                | FB  | NF   | Meaning                    |
| -------------------- | --- | ---- | -------------------------- |
| `[:white :rate0]`    | 1   | `00` | white, fastest (÷16)       |
| `[:white :rate1]`    | 1   | `01` | white, medium (÷32)        |
| `[:white :rate2]`    | 1   | `10` | white, slowest (÷64)       |
| `[:white :psg3]`     | 1   | `11` | white, freq = PSG3         |
| `[:periodic :rate0]` | 0   | `00` | periodic buzz, fastest     |
| `[:periodic :rate1]` | 0   | `01` | periodic buzz, medium      |
| `[:periodic :rate2]` | 0   | `10` | periodic buzz, slowest     |
| `[:periodic :psg3]`  | 0   | `11` | periodic buzz, freq = PSG3 |

`:noise-mode` can be changed inline with `(param-set :noise-mode [...])`.

**Open**: should `:noise-mode` be changeable per-note (inline in `seq`) or
only as a track-level option and explicit `param-set`?

---

### 2.9 Sticky parameter authoring (PMD-style)

In PMD MML, nearly every command — `@N` (tone), `o` (octave), `l` (length),
`v` (volume), `D` (detune), `s` (FM3 slot mask), `O` (TL per slot),
`P` (SSG tone/noise mix), `w` (noise freq) — is **sticky**: once written, it
applies to all subsequent notes until explicitly changed.

**Comparison with current MMLisp:**

| PMD command         | MMLisp today                 | Status                                          |
| ------------------- | ---------------------------- | ----------------------------------------------- |
| `@N` (tone)         | `@voice`                     | ✅ sticky, works inside `seq`                   |
| `o N` (octave)      | `:oct N` in seq              | ✅ sticky                                       |
| `l N` (length)      | `:len N` in seq              | ✅ sticky                                       |
| `Q/q` (gate)        | `:gate N` in seq             | ✅ sticky                                       |
| `v N` (volume)      | `v+`/`v-` or `:vol N`        | ✅ sticky                                       |
| `D N` (detune)      | `(param-set :fm-dt1 N)`      | ✅ fires once; HW state is sticky — but verbose |
| `O slot,val` (TL)   | `(param-set :fm-tl1 N)` etc. | ✅ same                                         |
| `s mask` (FM3 slot) | not implemented              | ⬜ depends on §2.1 FM3 OP design                |
| `P N` (SSG mix)     | `:noise-mode` (§2.8)         | ⬜ not yet implemented                          |
| `w N` (noise freq)  | no equivalent                | ⬜ covered by §2.8                              |
| `M` (software LFO)  | `:role modulator` track      | ✅ handled by separate model                    |

**The core issue:** `(param-set ...)` already behaves exactly like PMD sticky
commands — it fires one IR event and hardware state persists. The ergonomics
problem is verbosity: PMD's `D+10` is one token; MMLisp's `(param-set :fm-dt1 10)`
is a full form.

**Proposed solutions:**

**Option A — extend `(default ...)` to also accept param-set targets:**

```lisp
; :oct → updates compile-time state
; :fm-tl1 → emits PARAM_SET IR event
(default :oct 3 :fm-tl1 30)
```

The compiler dispatches on whether the key is a compile-time variable or a
param-set target. Concern: `default` gains a side-effectful path (IR emission),
blurring its current purely compile-time semantics.

**Option B — introduce `(set ...)` as a separate form:**

```lisp
(default :oct 3)            ; compile-time state only
(set :fm-tl1 30 :fm-dt1 5)  ; param-set IR events only
```

`set` always emits IR events. Role separation from `default` is clear.
Implementable as an alias for `param-set` with multi-key syntax.

**Option C — status quo (`param-set` + `default` as needed):**

Mid-track FM parameter changes are not expected to be frequent.
Common patterns can be wrapped in named `defn` macros to reduce verbosity.

**Open**: option A / B / C — or defer until v0.4 composition experience reveals
whether verbosity is actually a problem?

---

### 2.10 Loop break (volta-style last-pass skip)

A common pattern in music: repeat a phrase N times, but on the final pass skip
a tail section (e.g. a fill or transition). PMD MML uses `[A:B]N` — part A plays
every iteration, part B is skipped on the last pass.

Proposed MMLisp syntax — two equivalent forms:

**Track-body level** — when part A and part B are separate `seq` or other forms:

```lisp
(x 4
  (seq c d e)   ; part A: every pass
  (break)        ; on final pass: jump past LOOP_END
  (seq f g))     ; part B: skipped on pass 4
```

**Inline within `seq`** — when the break point falls mid-sequence:

```lisp
(x 4
  (seq c d e :break f g))   ; :break splits the seq into part A / part B
```

Both compile to the same `LOOP_BREAK` IR event at the current tick position.
`:break` inside `seq` is a seq state modifier that emits `LOOP_BREAK` and
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

**Open**: multiple `(break)` markers in one loop body — allow or reject?
(Likely reject with `E_MULTIPLE_BREAK`.)

### 2.11 PARAM_SWEEP — track-timeline smooth parameter change

Distinct from KEY-ON envelopes (§2.5): a one-shot sweep that starts at the
current track position and runs over N frames, independent of note events.
Useful for filter-style TL sweeps, cross-section pitch glides, or synth-pad
slow attacks driven from the track timeline rather than per-note.

**Authoring syntax** — value argument to `(set ...)` or seq inline modifier:

```lisp
; track body: TL sweep over 8 frames starting now
(set :tl2 [:fn easeOut 28 20 8])

; seq inline: pitch glide between sections
(seq :oct 4 :len 1/4
  :pitch [:fn linear 0 12 16]  c d e
  :pitch 0                     f g)
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

**Open**: whether `PARAM_SWEEP` with `from=null` means "start from current
hardware value" (requires driver to track last-written register value).

---

### 2.12 `(seq ...)` → `[...]` vector notation

**Motivation:** `(seq ...)` is the primary note-sequence form but visually it
looks like a function call, not a sequence. Using `[...]` directly makes the
data-vs-code distinction clearer and is consistent with how the language
already uses `[]` in envelope and sweep specs.

**Proposed rules:**

| Position                        | `[...]` interpretation      |
| ------------------------------- | --------------------------- |
| Track body / top-level item     | Note sequence (was `(seq)`) |
| After `:env` in `(ch ...)`      | Envelope spec               |
| After `:key` inside `(set ...)` | Value literal (fn spec)     |
| After modifier key inside `[`   | Value literal (fn spec)     |

Context is always determined by syntactic position; there is no ambiguity.

**Disambiguation examples:**

```lisp
; outer [] = note seq; inner [:fn ...] = :pitch value
[:oct 4 :len 1/4
  :pitch [:fn linear 0 12 16]  c d e
  :pitch 0                     f g]

; [] inside (set ...) as value
(set :tl1 [:fn easeOut 28 20 8])   ; inner [] → fn spec, not seq

; nested sub-group (triplet feel) — [] in item position, first element is a note
[:len 1/4  c  [e g a]  f]          ; [e g a] → sub-group, not fn spec
```

The parser distinguishes a fn-spec `[...]` from a sub-group `[...]` by whether
the first element is a curve-keyword (`:fn`, `linear`, `easeOut`, …) or a note
/ note-modifier. No first-element overlap exists.

**`(seq)` retained for compatibility?** — **OQ**: keep `(seq ...)` as an
alternate form for v0.4, or drop it entirely. If the live-player and
tools/scripts still use `(seq ...)` in source, a rename pass is needed.

---

## 3. Out of Scope for v0.4

- DT2 (second detune register) — out of scope for all versions until needed
- FM3 + CSM simultaneous use (hardware exclusive)
- Pitch-shifted DAC playback (fixed rate only in v0.4)
- PCM/WAV sample instruments beyond `:pcm` raw format
- Runtime subroutines (`CALL`/`RET`) — `defn` remains compile-time only; `def`
  (no parameters) could be compiled to a subroutine when referenced more than
  once, avoiding binary duplication. Revisit when designing the driver.
- Patch import system — Future Vision

---

## 4. OQ Resolution Priority

Recommended order for resolving open questions. Later OQs depend on earlier decisions.

| Priority | §                           | Rationale                                                                   |
| -------- | --------------------------- | --------------------------------------------------------------------------- |
| 1        | §2.10 Loop break            | Self-contained; driver option A already decided                             |
| 2        | §2.1 FM3 OP syntax          | CSM (§2.3) depends on this                                                  |
| 3        | §2.8 PSG noise              | Relatively self-contained; resolves PSG3 link design                        |
| 4        | §2.3 CSM                    | Can follow once FM3 OP mode is settled                                      |
| 5        | §2.5 + §2.11 Envelope/sweep | Unified model designed; needs FM/PSG scaling and PARAM_SWEEP open questions |
| 6        | §2.7 Curve functions        | Follows from §2.5 design                                                    |
| 7        | §2.9 Sticky param / `(set)` | `(set :x [:fn ...])` form ties into §2.11                                   |
| 8        | §2.4 DAC                    | Blocked on driver-side SAMPLE_TABLE design                                  |
| 9        | §2.2 / §2.6 Chord/multi-ch  | Most complex; design after v0.4 composition experience                      |
| 10       | §2.12 `(seq)` → `[]` rename | Purely syntactic; depends on all other seq-inline designs being stable      |

### FM3 OP syntax (§2.1) — current thinking

PMD specifies FM3 slot selection via the `s mask` command (bit field:
OP4=8, OP3=4, OP2=2, OP1=1). This maps naturally to the `:op N` track option
in Option A.

- Option A (`:op N` separate tracks) fits most naturally into the existing
  track-append model
- Option B (`(op1 ...)` sub-forms) is more compact for drum kits but makes
  phrase reuse harder
- **Anticipated decision**: adopt Option A as the base; Option B (drum-kit
  shorthand) deferred to v0.4+ if composition experience demands it
