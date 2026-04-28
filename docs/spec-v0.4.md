# MMLisp v0.4 Design Notes

Document status: design-in-progress
Started: 2026-04-24

This document captures decisions and open questions for v0.4, based on design
discussions following the v0.3 freeze (tag: v0.3-freeze at c3bdc72).

The central themes of v0.4 are **hardware depth** and **expressive envelopes**:
reaching the full capability of YM2612 and SN76489 that v0.1–v0.3 left as out
of scope.

---

---

## 1. Syntax & Language

### 1.1 Channels

| Name          | Hardware                          | Notes                                       |
| ------------- | --------------------------------- | ------------------------------------------- |
| `fm1`–`fm6`   | YM2612 FM channels 1–6            | Already valid in v0.3                       |
| `fm3`         | YM2612 FM channel 3 (normal use)  | Already valid in v0.3                       |
| `srq1`–`srq3` | SN76489 square-wave tone channels | Renamed in v0.4 (was `psg1`–`psg3` in v0.3) |
| `noise`       | SN76489 noise channel             | Already valid in v0.3                       |

---

### 1.2 Syntax unification

| Change                         | Before                      | After                                                            |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| Note sequence form             | `(seq ...)` / `[...]`       | flat inline — notes written directly in channel body             |
| Subgroup / tuplet              | `[e g a]` in item position  | `(e g a)` in item position                                       |
| Single-stage curve spec        | `[:fn ease-out ...]`        | `(ease-out ...)`                                                 |
| Multi-stage curve spec         | `[(ease-in ...) (sin ...)]` | unchanged (after `:env` only)                                    |
| Track declaration              | `(track :ch X ...)`         | `(X ...)` — channel name as form head                            |
| Mid-track defaults             | `(default :oct 3 ...)`      | removed — channel options set initial state; all state is sticky |
| `def` reference / voice switch | `@name`                     | bare identifier `name`                                           |
| Hardware param write           | `(set :tl1 30)`             | inline `:tl1 30` — same position as `:oct`/`:len`                |

`[:fn ...]` wrapper is removed. Curve forms are `(curve-name :key val ...)` directly.
`track` keyword and `:ch` option are removed. The channel name is the form head directly:
`(fm1 :oct 4  c e g e)`, `(srq1 :oct 3  c d e)`, `(noise :mode 7  x x x x)` etc.
All state (`:oct`, `:len`, `:gate`, `:vol`, `:mode`, `:env`, `:pitch`, etc.) is sticky — within a
form and **across consecutive forms of the same channel name**. The compiler maintains a
per-channel state map; state is never reset automatically between forms.
`(default ...)` and `(set ...)` are removed.

**Token disambiguation rule** — the parser resolves tokens in this order:

| Token shape                     | Interpretation                                                      |
| ------------------------------- | ------------------------------------------------------------------- |
| `a`–`g` (optionally `+` or `-`) | Note name (current `:len`)                                          |
| `aN` (e.g. `c8`, `g+4`)         | Note name with explicit length — overrides `:len` for one note      |
| `a.` / `aN.` (e.g. `c.`, `c4.`) | Dotted note — length × 1.5 (current `:len` or explicit, then × 1.5) |
| `_`                             | Rest (current `:len`)                                               |
| `_N` (e.g. `_4`, `_8`, `_16`)   | Rest with explicit length — overrides `:len` for one rest           |
| `_.` / `_N.` (e.g. `_.`, `_4.`) | Dotted rest — length × 1.5 (current `:len` or explicit, then × 1.5) |
| `aNf` (e.g. `c8f`, `g+3f`)      | Note with exact frame count — BPM-independent; overrides `:len`     |
| `_Nf` (e.g. `_8f`, `_16f`)      | Rest with exact frame count — BPM-independent; overrides `:len`     |
| `aNt` (e.g. `c14t`, `g+1t`)     | Note with exact tick count — BPM-independent; overrides `:len`      |
| `_Nt` (e.g. `_14t`, `_1t`)      | Rest with exact tick count — BPM-independent; overrides `:len`      |
| `~`                             | Tie                                                                 |
| `:keyword`                      | Modifier or key-value pair                                          |
| `(form ...)`                    | Structural form (`x`, `break`, curve, etc.)                         |
| Any other identifier            | `def` reference — compiler resolves content                         |

**Length token formats** — wherever a length value appears (`:len`, explicit note/rest suffix) the following forms are accepted:

| Format      | Example | Resolved as                      |
| ----------- | ------- | -------------------------------- |
| Integer     | `4`     | note-length (quarter = 30 ticks) |
| Dotted int  | `4.`    | note-length × 1.5 (45 ticks)     |
| Frame count | `16f`   | exactly 16 driver frames         |
| Tick count  | `14t`   | exactly 14 ticks                 |

`4.` is shorthand for `4 * 1.5`. A single dot is supported; double-dot is out of scope for v0.4.
Fraction notation (`1/N`, `N/M`) is not supported — use ties (`~`) for durations longer than a whole note.
The `f` and `t` suffixes are valid wherever a length value appears: `:len`, `:gate`, note/rest suffix, `:wait`.
Use `Nt` when the desired duration does not align to any note-length integer — e.g. splitting an 8th note
(15 ticks) into a 1-tick attack and a 14-tick body:

```lisp
; SN76489 periodic noise with white-noise attack on each 8th note
; (srq3 provides frequency for periodic noise, muted via :vol)
(noise :len 8
  :mode white      c1t    ; 1-tick attack click
  :mode periodic3  c14t   ; 14-tick periodic body  (1 + 14 = 15 = 8th note)
  :mode white      c1t
  :mode periodic3  c14t
  :mode white      c1t
  :mode periodic3  c14t)
```

`:gate` accepts the same length formats as `:len` — integer note-length, dotted, `Nf` frame count, or `Nt` tick count.
Example: `:gate 8f` — the compiler emits `KEY_OFF` at exactly 8 frames regardless of BPM; the release tail begins there.

---

### 1.3 Note sequences & subgroups

**Decided** (per §1.3):

Notes, rests, modifiers, and structural forms are written directly in the channel
body — no sequence wrapper.

| Form                   | Context                                    | Interpretation                                                     |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| note / rest / modifier | Channel body; `(x N ...)` body; `def` body | Direct sequencing                                                  |
| `cN` (e.g. `c8`)       | Inline in note position                    | Note with explicit length; overrides `:len` for that note only     |
| `_N` (e.g. `_8`)       | Inline in note position                    | Rest with explicit length; overrides `:len` for that rest only     |
| `(notes...)`           | Inline when first element is a note        | Subgroup / tuplet — current `:len` distributed by Bresenham method |
| `(curve-name ...)`     | After `:env`; value of `:key` inline       | Curve spec                                                         |
| `[(stage1) (stage2)]`  | After `:env`                               | Multi-stage envelope                                               |

**Subgroup tick distribution — Bresenham method:**

`(notes...)` divides the current `:len` ticks among all notes in the subgroup.
When the division is not exact, the compiler uses Bresenham error accumulation
to distribute ticks as evenly as possible:

```
acc = 0
for each note i in subgroup (count = N):
  acc += parent_ticks
  this_note_ticks = floor(acc / N)
  acc -= this_note_ticks * N
```

The total always equals `parent_ticks` exactly. The per-note error is at most
1 tick (< 1/60 s at 60 fps — inaudible). No compiler error is raised for
non-divisible counts.

Example: `:len 4` (30 ticks), 4 notes → `[8, 7, 8, 7]` (total = 30).

**Examples:**

```lisp
; note sequence flat in channel body
(fm1 :oct 4 :len 4  c e g c)

; :oct 5 persists after the phrase
(fm1 :oct 4 :len 8  c e g e  :oct 5  c e g e)

; bare identifier switches voice (no @ prefix)
(fm1 :oct 4 :len 8  brass  c e g e  :tl1 20  c e g e)

; subgroup (triplet): 3 notes in a quarter note (30 ticks / 3 = 10 ticks each — exact)
(fm1 :len 4  c  (e g a)  f)

; subgroup (4 in a quarter): 30 ticks / 4 = 7.5 — Bresenham distributes as [8, 7, 8, 7]
; total always equals parent :len; max per-note error is 1 tick (< 1/60 s, inaudible)
(fm1 :len 4  (c e g a))

; single-stage envelope
(def syntom-pitch :env :pitch (ease-out :from 0 :to -48 :len 8))

; multi-stage envelope ([...] retained after :env only — data vector, not note sequence)
(def vib-entry :env :pitch
  [(ease-in :from -12 :to 0 :len 16)
   (sin    :from -10 :to 10 :len 8)])

; curve value inline (emits PARAM_SWEEP)
(fm1 :len 8  :tl2 (ease-out :from 28 :to 20 :len 8)  c e g e)

; dotted notes — length × 1.5
(fm1 :len 4  c. e. g)       ; c. = dotted quarter using current :len
(fm1 :len 8  c4. e8.)       ; c4. = dotted quarter, e8. = dotted eighth (explicit)

; dotted :len — sticky
(fm1 :len 4.  c e g e)        ; :len 4. = dotted quarter (45 ticks) for all notes

; rest with explicit length — independent of current :len
(fm1 :len 4  c _8 c _16 c)

; dotted rests
(fm1 :len 4  c _. e _4.)    ; _. = dotted quarter rest, _4. = same explicit

; cross-form state inheritance — :oct 5 and :env persist into next form
(fm1 :oct 4 :len 4 :env scoop  c e g e)
(fm1  c e g e)   ; :oct 4, :len 4, :env scoop all still active
(fm1 :oct 5  c e g e)   ; only :oct changes; other state unchanged
```

**Decided: `(seq ...)` and `[...]` (note sequence form) are both removed in v0.4.** No deprecated aliases.
`[...]` is retained **only** after `:env` for multi-stage envelopes (data vector context).
Existing demo sources (`demo1-stage-loop.mmlisp`, `demo2-event-recovery.mmlisp`)
use `(seq ...)` and `(track :ch ...)` throughout — a one-time rename pass is
required before those files are used with the v0.4 compiler.

---

### 1.4 Inline parameter writes

**Decided: inline `:key val` for all parameter writes. `(set ...)` and `param-set` are removed.**

Hardware parameter writes use the same `:key val` syntax as note modifiers.
The compiler distinguishes them by key name:

| Key class       | Examples                                                     | Compile behaviour                                                                   |
| --------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Sequencer state | `:oct` `:len` `:gate` `:vol`                                 | compile-time state only — folded into NOTE_ON; `:vol` uses logical scale (see §2.5) |
| Hardware params | `:tl1`–`:tl4` `:ar1`–`:ar4` `:fb` `:dt1` `:mode` `:pan` etc. | emit `PARAM_SET` IR event                                                           |
| Curve value     | `:tl2 (ease-out ...)`                                        | emit `PARAM_SWEEP` IR event                                                         |

All hardware parameter values are **absolute** (register value written directly).
Relative/delta notation (e.g. `:tl1 +5`) is not supported.

```lisp
(fm1 :oct 4 :len 8
  :tl1 30 :dt1 5        ; PARAM_SET — hardware writes
  c e g e
  :tl2 (ease-out :from 28 :to 20 :len 8)   ; PARAM_SWEEP
  c e g e)
```

---

## 2. Sequencing & Control

### 2.1 Loop break

`:break` modifier is adopted. It compiles to `LOOP_BREAK` — PMD `:` equivalent:
on the final pass of `(x N ...)`, skip everything from the break point to the
end of the loop body.

```
pass 1–(N-1): part_A  part_B
pass N:       part_A             ← break exits before part_B
```

A common pattern in music: repeat a phrase N times, but on the final pass skip
a tail section (e.g. a fill or transition). PMD MML uses `[A:B]N` — part A plays
every iteration, part B is skipped on the last pass.

MMLisp syntax:

```lisp
(x 4
  c d e :break f g)   ; :break splits the sequence into part A / part B
```

`:break` emits `LOOP_BREAK` at the current tick position and continues parsing
the remaining items as part B.

`(x)` nesting is supported (each loop gets a unique `_xN` id);
`:break` inside a nested `(x)` exits only the innermost loop.

Multiple `:break` in one loop — first break wins; subsequent breaks are silently ignored.

Cycle-alt (Strudel-style per-pass pattern switching via `|`) → out of scope for v0.4.

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

---

### 2.2 Portamento — `:glide`

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
(fm1 :oct 4 :len 4 :glide 8
  c e g e)

; start from an explicit pitch (c3 → e4 over 8 frames)
(fm1 :oct 4 :len 4 :glide 8 :glide-from c3
  e g a g)

; disable mid-phrase
(fm1 :oct 4 :len 4 :glide 8
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

### 2.3 PARAM_SWEEP — track-timeline parameter change

Distinct from KEY-ON envelopes (§2.5): a sweep (one-shot or looping) that
starts at the current track position and runs independent of note events.
Useful for filter-style TL sweeps, cross-section pitch glides, synth-pad
slow attacks, or track-position-locked LFOs driven from the track timeline
rather than per-note.

**Authoring syntax** — inline `:key curve-form` (same position as any `:key val`):

```lisp
; one-shot: TL sweep over one 8th note
(fm1 :oct 4 :len 8
  :tl2 (ease-out :from 28 :to 20 :len 8)
  c e g e)

; one-shot: pitch glide between sections
(fm1 :oct 4 :len 4
  :pitch (linear :from 0 :to 12 :len 4)
  c d e  :pitch 0  f g)

; looping: track-position-locked tremolo starting at this point
(fm1 :oct 4 :len 4
  :tl1 (triangle :from 0 :to 4 :len 8)
  c e g e ...)
```

**IR representation:**

```json
{
  "cmd": "PARAM_SWEEP",
  "args": {
    "target": "tl2",
    "curve": "ease-out",
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
(def portamento :env :pitch (linear :to 0 :len 8f))
; :to 0 = note's own pitch; :from omitted = last_written[pitch]
```

Applies to both `ENVELOPE_TABLE` (§2.5) and `PARAM_SWEEP` (§2.11).

---

## 3. Envelope & Curves

### 3.1 KEY-ON envelope model

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
│     NOTE_ON  pitch=c4  len=120  envId=2   ; u8; 0 = no envelope
│
└── ENVELOPE_TABLE  (section 0x0005)
      [id=2]  target=pitch  curve=ease-out  from=0  to=-48  frames=16
              wait=0  loop=false
      [id=3]  [target=tl4  curve=triangle  from=0  to=6  frames=8  loop=true]
              [target=tl1  curve=triangle  from=0  to=2  frames=8  loop=true]
      [id=4]  target=vol  curve=triangle  from=12  to=15  frames=15
              carrier_mask=0b1001  loop=true   ; FM only — compiler resolves from ALG
```

**Entry byte layout — per target sub-entry:**

```
Header (3 bytes):
  u8   target        ; pitch=0  vol=1  tl1=2  tl2=3  tl3=4  tl4=5  dt1=6  …
  u8   carrier_mask  ; FM only: bitmask OP1–OP4; 0xFF = N/A (PSG/PCM)
  u8   stage_count   ; number of sequential stages (≥1)

Stage descriptor (8 bytes × stage_count):
  u8   curve_id   ; CURVE_TABLE index; 0xFF = hold/pause stage
  u8   flags      ; bit0=loop  bit1=koff_wait
  i16  from       ; start value (target units; ignored for hold stage)
  i16  to         ; end value  (same units)
  u16  frames     ; duration in driver frames; ignored when koff_wait (bit1) set
```

Hold stage values:

- `(wait N)` / `(wait Nf)` → `curve_id=0xFF  flags=0  from=to=<prev_stage.to>  frames=N`
  Both length formats compile to frame counts; no sentinel needed.
- `(wait key-off)` → `curve_id=0xFF  flags=koff_wait  from=to=<prev_stage.to>  frames=0`

Multi-stage example — ADSR curve (`adsr-curve` from §2.5):

```
[id=5]  target=vol  carrier_mask=0xFF  stage_count=4
  stage[0]  curve_id=ease-out  flags=0          from=0   to=15  frames=4   ; Attack
  stage[1]  curve_id=ease-in   flags=0          from=15  to=10  frames=2   ; Decay
  stage[2]  curve_id=0xFF      flags=koff_wait  from=10  to=10  frames=0   ; Sustain
  stage[3]  curve_id=ease-in   flags=0          from=10  to=0   frames=4   ; Release
```

**Decided: `NOTE_ON` carries a single `envId` (u8).** `0` = no envelope. Multiple
targets (e.g. `:tl4` + `:tl1` + `:pitch` simultaneously) are packed into one
`ENVELOPE_TABLE` entry with multiple sub-entries; the NOTE_ON still references a
single id. Inline `:env` overrides replace the id on that NOTE_ON only — the
compiler resolves the substitution statically.

**MMLisp authoring syntax:**

```lisp
; one-shot: synth tom pitch sweep
(def syntom-pitch :env :pitch (ease-out :from 0 :to -48 :len 8))

; one-shot: brass scoop-up
(def scoop :env :pitch (ease-in :from -18 :to 0 :len 16))

; looping LFO: vibrato (wait before onset)
(def vibrato :env :pitch (sin :from -10 :to 10 :len 8
                          :wait 4))

; looping LFO: tremolo on TL (carrier level)
(def tremolo :env :tl1 (triangle :from 0 :to 3 :len 8))

; step sequence: traditional PSG vol envelope
(def pluck :env :vol [15 12 8 4 2 1 0])
(def pad   :env :vol [15 :loop 14 13])
(def organ :env :vol [15 :loop 14 13 :release 3])

; curve vector: attack then release (no sustain loop — both stages complete)
(def psg-punch :env :vol
  [(ease-out :from 15 :to 8 :len 16)    ; stage 1 — quick attack fade, completes
   (ease-in  :from 8  :to 0 :len 8)])   ; stage 2 — tail out, then silence

; curve vector: attack then sustain-loop (release NOT reachable — loop stage is terminal)
(def psg-pad :env :vol
  [(ease-in    :from 0  :to 14 :len 8)  ; stage 1 — fade in, completes
   (triangle  :from 12 :to 15 :len 8)]) ; stage 2 — tremolo loops indefinitely; no further stage

; curve: AM/tremolo via logical vol — works on all channel types
(def tremolo-psg :env :vol (triangle :from 12 :to 15 :len 8))   ; gentle PSG tremolo
(def am-fade     :env :vol (ease-out  :from 15 :to 0  :len 1))   ; fade over 1 whole note

; ADSR in step-vector form — attack / decay / sustain-loop / release
(def adsr-soft :env :vol
  [3 7 12 15                         ; Attack  — 4-step ramp up
   :loop 14 14 15 15                 ; Sustain — gentle shimmer (loops until KEY-OFF)
   :release 12 9 6 3 1 0])          ; Release — ramp down after KEY-OFF
```

**Rule: a looping curve stage is terminal — stages after it are never reached.**
To combine a sustain-loop with a release tail, use the step-vector
`[:loop ... :release ...]` form, not `[curve-vec]`.

**Decided: `:vol` is a logical volume scale — `0` = silent, `15` = maximum — on all
channel types.** The compiler maps to hardware per channel:

| Channel          | Hardware mapping                                        |
| ---------------- | ------------------------------------------------------- |
| PSG (srq, noise) | `hw_attenuation = 15 − vol` (SN76489: 0=max, 15=silent) |
| FM (fm1–fm4)     | carrier-TL offset applied to all carrier operators      |
| PCM (dac)        | direct mixing-volume scaling                            |

`[15 12 8 4 2 1 0]` therefore reads as "loud → silent" on every channel type; no
polarity surprises for the composer.

**`:env :vol` accepts both step-vector and curve forms.** `:from`/`:to` values use
the same 0–15 logical scale. The compiler applies the same per-channel mapping as
the integer `:vol` state — no separate scale for curve targets.

**FM `:vol` curve — `carrier_mask` resolved at compile time.** The compiler
determines which OPs are carriers from the voice def's `:alg` value and embeds a
`carrier_mask` (u8 bitmask, bit0=OP1…bit3=OP4) in the `ENVELOPE_TABLE` entry.
The driver reads the mask and updates only the flagged TL registers each frame.
No runtime ALG lookup is needed.

When the same `:env` def is attached to voice defs with different ALG values, the
compiler generates a separate `ENVELOPE_TABLE` entry per (env-def × carrier_mask)
combination. Authors write one def; the compiler deduplicates automatically.

For FM tremolo, choosing between `:vol (curve ...)` and `:tl1 (curve ...)`:

| Approach                | Range | Scope                                | Use when                                |
| ----------------------- | ----- | ------------------------------------ | --------------------------------------- |
| `:vol (curve ...)`      | 0–15  | carrier OPs only (compiler-resolved) | all channel types; coarse AM            |
| `:tl1 (curve ...)` etc. | 0–127 | one operator at a time               | FM fine-grained tremolo or filter sweep |

Step-vector `[...]` and curve `(curve ...)` can also be combined per-target in a
multi-target envelope (sequential vol, simultaneous pitch, etc.).

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
```

**Inline override:**

```lisp
(fm1  :oct 4 :len 4
  syntom :env syntom-pitch  c   ; explicit per-note env attach
  snare                     c)
```

**Multi-stage envelopes** — a vector of `(curve ...)` forms, providing sequential
stages on one target. `[...]` is **required** to delimit the stage list; without
it, in a multi-target def, a second `(curve ...)` form would be ambiguous (another
stage, or the value of the next `:key`?). The `[...]` wrapper makes stage count
explicit at the parser level.

```lisp
(def vib-entry :env :pitch
  [(ease-in :from -12 :to 0 :len 16)         ; scoop up
   (sin    :from -10 :to 10 :len 8)])       ; then vibrato
```

**`(wait)` — pause stage:** holds the ending value of the previous stage for the
given duration before proceeding to the next stage.

```
(wait N)        — pause for N note-lengths (same format as :len)
(wait Nf)       — pause for exactly N frames
(wait key-off)  — hold indefinitely until KEY-OFF arrives, then proceed
```

`(wait key-off)` enables a release tail in a multi-stage curve envelope
without using the step-vector form:

```lisp
; ADSR via multi-stage with wait stage
(def adsr-curve :env :vol
  [(ease-out :from 0  :to 15 :len 4)    ; Attack
   (ease-in  :from 15 :to 10 :len 2)   ; Decay
   (wait key-off)                       ; Sustain — hold at 10 until KEY-OFF
   (ease-in  :from 10 :to 0  :len 4)]) ; Release — tail after KEY-OFF
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
  :pitch (ease-out :from 0 :to -48 :len 8))

; voice def: env fires on every NOTE_ON
(def brass :extends fm-init
  :alg 7
  :env trem-brass)

; inline override per note
(fm1 :oct 4 :len 4
  brass :env trem-brass  c e g e)
```

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
; both at once: :pitch is sequential stages, :vol runs in parallel alongside it
(def syntom-env :env
  :vol   [15 12 8 4 0]                ; vol stages run sequentially
  :pitch (ease-out :from 0 :to -48 :len 8))  ; pitch curve runs simultaneously
```

**Driver state per channel:** up to 4 env slots `{ envId, stage, phase, delay_count, flags }` —
all slots reset on every KEY-ON, each advanced independently every frame tick.

`flags` (per slot): `bit0 = koff_wait` — slot is suspended waiting for KEY-OFF.
When KEY-OFF fires (compiled `KEY_OFF` event or runtime `key_off_flags`), the driver
scans all slots for the channel and resumes every slot with `koff_wait` set in the same
frame tick. `key_off_flags` is cleared only after all slots have been notified.

**Additive pitch model — `base_pitch` + `env_pitch_delta`:**

The driver maintains two independent values per channel for pitch:

```
base_pitch[ch]       ← set by NOTE_ON; updated by :glide PARAM_SWEEP
env_pitch_delta[ch]  ← driven by ENVELOPE_TABLE :pitch curve (vibrato, scoop, etc.)
hardware_reg = base_pitch[ch] + env_pitch_delta[ch]
```

`base_pitch` and `env_pitch_delta` are written to different internal registers and
summed before the hardware F-number write each frame. This means `:glide`
(portamento between notes) and `:env :pitch` (per-note LFO/scoop) compose without
interference:

```lisp
; glide slides base_pitch c4→e4 over 8 frames;
; vibrato runs on env_pitch_delta simultaneously — they add
(fm1 :glide 8 :env vibrato  :oct 4 :len 4  c e g e)
```

PARAM_SWEEP for `:pitch` (§2.11) also targets `base_pitch`, not `env_pitch_delta`.
This keeps track-timeline pitch glides independent of per-note envelope pitch curves.

**FM vs PSG F-number resolution:** the `:pitch` delta unit in an envelope is defined
as a hardware-independent semitone-fraction. The compiler scales to F-number
bits at emit time based on channel type (FM: 11-bit F-number; PSG: 10-bit
tone register). Envelope table stores the logical delta; the driver reads the
pre-scaled value from the table.

**Decided: `:from`/`:to` unit is semitone-cents (100 = 1 semitone).** The compiler
scales to F-number register bits at emit time based on channel type. Authors never
deal with raw F-number delta; hardware differences are a compiler detail.

**Decided: `:len` for curve duration.**

Wherever a duration appears in a curve form — including `:wait` — the same
length formats as note/rest lengths apply:

| Format      | Example    | Meaning                                         |
| ----------- | ---------- | ----------------------------------------------- |
| Integer     | `:len 4`   | note-length — quarter note (30 ticks @ BPM=120) |
| Dotted int  | `:len 4.`  | note-length × 1.5                               |
| Frame count | `:len 16f` | exactly 16 driver frames (BPM-independent)      |

Frame-count (`Nf`) is useful for effects where timing is hardware-fixed —
e.g. a whistle attack of 3 frames, or a PCM gate of exactly 10 frames.
Musical durations (integer, dotted) scale with BPM; `Nf` does not.

The compiler converts musical lengths to frames using:

```
frames = (ticks / PPQN) * (BPM / 60) * fps
```

At BPM=120, fps=60, PPQN=120: frames = ticks (quarter = 30 frames).

```lisp
(def vibrato :env :pitch (sin :from -10 :to 10 :len 4
                          :wait 4))           ; period = quarter note, wait before onset

(def syntom-pitch :env :pitch (ease-out :from 0 :to -48 :len 8f)) ; exactly 8 frames

(def whistle-on :env :pitch (ease-in :from -24 :to 0 :len 3f))    ; 3-frame attack

(def vibrato-late :env :pitch (sin :from -10 :to 10 :len 4
                               :wait 8f))     ; wait=8 frames fixed, period=quarter

; release swell: after KEY-OFF, scoop up pitch
(def release-scoop :env :pitch (ease-in :from -24 :to 0 :len 4
                                :wait key-off)) ; curve starts after KEY-OFF
```

`:wait` accepts the same values as `(wait)` stage form — `N`, `Nf`, or `key-off`.
**Compiler:** `:wait N` on a single-stage curve expands to `[(wait N) (curve ...)]`
internally; the wait and curve run as consecutive stages sharing one `envId`.

**Decided: `:release` in step-vector — compiler emits `KEY_OFF` at `gate_ticks`.**

The step-vector format for `:env :vol` is:

```
[attack... :loop sustain... :release release...]
```

| Region  | Marker               | Playback                                          |
| ------- | -------------------- | ------------------------------------------------- |
| attack  | (before `:loop`)     | played once on KEY-ON                             |
| sustain | `:loop` … `:release` | looped until `KEY_OFF` event in stream            |
| release | after `:release`     | played once after `KEY_OFF`; then holds final val |

For fixed-length notes (`len > 0`), `gate_ticks` is known at compile time.
The compiler emits an explicit `KEY_OFF` event at the `gate_ticks` position
directly into the event stream. The driver processes events sequentially —
no per-channel elapsed tracking or runtime comparison is needed.

```
event stream (fixed-length note):
  NOTE_ON  @t=0          → starts attack, enters sustain loop
  KEY_OFF  @t=gate_ticks → exits sustain, fires release tail
  (next event at t=step_ticks)
```

```
|<----- gate_ticks ----->|<-- step_ticks - gate_ticks -->|
 attack → sustain loop…    release tail (plays once)
```

If the release tail ends before `step_ticks`, the envelope holds the final value
until the step ends (natural: last release value is usually 0 = silent).

```lisp
; attack(15,14) → loop(13,12) → release(11,9,7,5,3,1,0)
(def organ :env :vol [15 14 :loop 13 12 :release 11 9 7 5 3 1 0])

; no attack — sustain immediately, release on gate close
(def pad :env :vol [:loop 14 13 :release 5 3 1 0])

; one-shot, no loop, no release — envelope plays to end regardless of gate
(def pluck :env :vol [15 12 8 4 2 1 0])
```

`:release` without `:loop` is valid — the envelope plays attack then release
(no loop phase). `:loop` without `:release` loops indefinitely (original
behaviour — abrupt cut on step end, which is fine for short staccato notes).

**`:gate` interaction:** set `:gate` to control where the compiler places `KEY_OFF`.
With `:gate 8f`, the compiler emits `KEY_OFF` at exactly 8 frames — BPM-independent,
useful for hardware-timed sounds. The sustain loop runs up to that point; the
release tail begins immediately after.

**Decided: True KEY-OFF — variable-length hold — is in scope for v0.4.**

For interactive music, the game must be able to trigger KEY-OFF at runtime
(not known at compile time). MMLisp supports this with `len=0` notes:

```lisp
; len=0: hold indefinitely until the game sends KEY-OFF on this channel
(srq1 :len 0 :env psg-asr  c)
```

**`len=0` semantics:**

| Phase   | Trigger                                                                 |
| ------- | ----------------------------------------------------------------------- |
| attack  | fires immediately on NOTE_ON                                            |
| sustain | loops until KEY-OFF arrives                                             |
| release | fires on KEY-OFF; walks ENVELOPE_TABLE release steps; holds final value |

**Unified KEY-OFF mechanism:** the channel state machine treats all KEY-OFF
signals identically — exit sustain, walk ENVELOPE_TABLE `:release` steps one
per tick, hold final value. The source of KEY-OFF differs by note type:

| Note type         | KEY-OFF source                                     |
| ----------------- | -------------------------------------------------- |
| `len > 0` (fixed) | compiler-emitted `KEY_OFF` event in event stream   |
| `len = 0` (hold)  | runtime `key_off_flags` bit set by 68000 game code |

**Driver mechanism for `len=0`:** The Z80 work area contains `key_off_flags`.
The 68000 sets a bit to request KEY-OFF. The driver checks each frame tick:

- If the bit is set, signal KEY-OFF to the channel state machine (same path
  as a compiler-emitted `KEY_OFF` event), then clear the bit.

```
Z80 work area (game-driver communication):
  key_off_flags:   u16  ; bitmask, one bit per channel (fm1–fm6=6, srq1–srq3=3, noise=1 → 10 bits used)
  ; 68000 sets bit → driver processes on next frame tick → clears bit
```

Bit assignment (low bit = 0):

| Bit   | Channel    |
| ----- | ---------- |
| 0     | fm1        |
| 1     | fm2        |
| 2     | fm3        |
| 3     | fm4        |
| 4     | fm5        |
| 5     | fm6        |
| 6     | srq1       |
| 7     | srq2       |
| 8     | srq3       |
| 9     | noise      |
| 10–15 | (reserved) |

`:release` without `:loop` with `len=0` is valid: attack plays once, then
the note holds the final attack value until KEY-OFF fires the release tail.

---

### 3.2 Curve functions

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

Curve names use kebab-case — consistent with MMLisp's identifier convention.

| Family  | In                | Out                | InOut                | Character                      |
| ------- | ----------------- | ------------------ | -------------------- | ------------------------------ |
| Sine    | `ease-in-sine`    | `ease-out-sine`    | `ease-inout-sine`    | Sinusoidal — smooth, gentle    |
| Quad    | `ease-in-quad`    | `ease-out-quad`    | `ease-inout-quad`    | $t^2$                          |
| Cubic   | `ease-in-cubic`   | `ease-out-cubic`   | `ease-inout-cubic`   | $t^3$                          |
| Quart   | `ease-in-quart`   | `ease-out-quart`   | `ease-inout-quart`   | $t^4$                          |
| Quint   | `ease-in-quint`   | `ease-out-quint`   | `ease-inout-quint`   | $t^5$                          |
| Expo    | `ease-in-expo`    | `ease-out-expo`    | `ease-inout-expo`    | $2^{10t}$ — sharp acceleration |
| Circ    | `ease-in-circ`    | `ease-out-circ`    | `ease-inout-circ`    | Circular arc                   |
| Back    | `ease-in-back`    | `ease-out-back`    | `ease-inout-back`    | Slight overshoot               |
| Elastic | `ease-in-elastic` | `ease-out-elastic` | `ease-inout-elastic` | Spring / wobble                |
| Bounce  | `ease-in-bounce`  | `ease-out-bounce`  | `ease-inout-bounce`  | Bouncing ball                  |

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

| Alias        | Resolves to       |
| ------------ | ----------------- |
| `ease-in`    | `ease-in-quad`    |
| `ease-out`   | `ease-out-quad`   |
| `ease-inout` | `ease-inout-quad` |

**Curve keyword arguments:**

| Keyword | Applies to | Values                    | Description                                                                     |
| ------- | ---------- | ------------------------- | ------------------------------------------------------------------------------- |
| `:from` | all curves | number                    | Starting value (inclusive)                                                      |
| `:to`   | all curves | number                    | Ending value (inclusive)                                                        |
| `:len`  | all curves | length token              | Duration of one cycle / one-shot; same formats as note length (`N`, `N.`, `Nf`) |
| `:wait` | all curves | length token or `key-off` | Delay before curve starts; `key-off` = start after KEY-OFF signal               |

All four keywords are required for every curve form. `:wait` defaults to `0` when omitted.

Multi-stage envelopes use `[(curve ...) (curve ...)]` syntax (see §2.5); no
special curve name needed.

`reverse` is not a curve name; reverse a curve by swapping `:from` and `:to`.

---

## 4. Hardware

### 4.1 PSG noise control

SN76489 noise register (byte format: `111 FB NF1 NF0`):

| Bits | Field | Meaning                                           |
| ---- | ----- | ------------------------------------------------- |
| `FB` | 1 bit | 0 = periodic (pitched buzz), 1 = white noise      |
| `NF` | 2 bit | 00/01/10 = fixed rate ÷16/÷32/÷64; 11 = srq3 freq |

When `NF=11`, the noise channel clocks from `srq3`'s tone generator. `srq3`
simultaneously produces its own tone output, enabling **tone + noise mix**.

**Design: `:mode` is a channel option and inline modifier.**

Noise mode is set via `:mode` on the `noise` channel.
Envelope is attached separately via `:env` or via a `def` reference.

```lisp
; named envelope defs
(def hh-closed-env :env :vol [15 8 0])
(def hh-open-env   :env :vol [15 12 10 8 4 0])
(def ride-env      :env :vol [15 14 13 :loop 12 11])

; noise track
(noise :mode white0
  :len 8 :env hh-closed-env
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

**srq3 link example — sweep noise frequency with a curve:**

```lisp
; noise gates on every quarter note; frequency follows srq3
(noise :mode white3  :len 1  c c c c  c c c c)

; srq3 sweeps pitch up an octave over 4 frames — noise frequency tracks it
; srq3 is also audible as a tone alongside the noise
(srq3 :len 1  :pitch (linear :from 0 :to 12 :len 4f)
  c c c c  c c c c)
```

**Decided: `:mode` inline modifier covers mid-track noise change.** No
additional syntax needed. Use `:mode white2` mid-track
to change noise mode.

---

**`:env :mode` — frame-based noise mode envelope**

`:env :mode` accepts a step-vector of mode keywords, advancing one step per
driver frame. This enables sub-note timbre changes while note sequencing
remains tick-based.

```lisp
; attack: 2 frames white → sustain: periodic3 (loops until KEY-OFF or end of note)
(def noise-atk :env :mode [white0 white0 :loop periodic3])

; attack: white → sustain: periodic → release: white on key-off
(def noise-asr :env :mode [white0 white0 :loop periodic3 :release white2])
```

`:loop` and `:release` semantics are identical to `:env :vol` step-vector:

| Region  | Marker               | Playback                                      |
| ------- | -------------------- | --------------------------------------------- |
| attack  | (before `:loop`)     | played once on KEY-ON, one step per frame     |
| sustain | `:loop` … `:release` | looped until `KEY_OFF`                        |
| release | after `:release`     | played once after `KEY_OFF`; holds final mode |

Without `:release`, the last sustain mode persists after the loop until the
note ends — natural for periodic-buzz sustain that simply cuts off.

**Why this matters:** note duration is specified in ticks (tempo-relative), but
the mode envelope runs in frames (hardware-relative). A 1-frame white-noise
attack stays exactly 1 frame regardless of BPM; the rest of the note uses
periodic mode for as long as the note lasts.

```lisp
; 8-beat pattern: each 8th note gets a 1-frame white attack, then periodic buzz
; srq3 provides frequency for periodic3 mode (muted via :vol)
(def perc-buzz :env :mode [white0 :loop periodic3])

(noise :len 8 :env perc-buzz
  c c c c  c c c c)
```

The compiler encodes `:env :mode` step-vectors as `MODE_ENV_TABLE` entries
(same section as `ENVELOPE_TABLE`, target=mode). Each step is a 1-byte FB+NF
value; the driver writes the noise register each frame tick.

---

### 4.2 FM panning — `:pan`

YM2612 register B4 (per-channel) carries a 2-bit L/R output enable in bits 7–6:

| Bits 7–6 | L   | R   | Meaning          |
| -------- | --- | --- | ---------------- |
| `11`     | ✓   | ✓   | Center (default) |
| `10`     | ✓   |     | Left only        |
| `01`     |     | ✓   | Right only       |
| `00`     |     |     | Off (mute)       |

`:pan` is a sticky channel option. It emits a `PARAM_SET` for the B4 register.
Applies to `fm1`–`fm6` only; SN76489 has no stereo hardware.

| Value    | Bits 7–6 | Output          |
| -------- | -------- | --------------- |
| `center` | `11`     | L + R (default) |
| `left`   | `10`     | L only          |
| `right`  | `01`     | R only          |
| `off`    | `00`     | Muted           |

```lisp
(fm1 :pan center  c e g e)   ; L+R — default
(fm1 :pan left    c e g e)   ; L only
(fm1 :pan right   c e g e)   ; R only
(fm1 :pan off     c e g e)   ; silent (useful for muting without stopping the note)
```

`:pan` is sticky — it persists across forms of the same channel until changed.
The compiler initial default is `center`; no `PARAM_SET` is emitted unless
`:pan` appears in the source.

B4 also carries bits 5–4 (AMS, PMS — hardware LFO sensitivity). The compiler
preserves the AMS/PMS bits from the current voice def when writing `:pan`:

```
new_B4 = (pan_bits << 6) | (current_B4 & 0x3F)
```

This means `:pan` and `:lfo-ams`/`:lfo-pms` parameters do not interfere.
