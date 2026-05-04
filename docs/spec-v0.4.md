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
| `sqr1`–`sqr3` | SN76489 square-wave tone channels | Renamed in v0.4 (was `psg1`–`psg3` in v0.3) |
| `noise`       | SN76489 noise channel             | Already valid in v0.3                       |

---

### 1.2 Syntax unification

| Change                         | Before                      | After                                                            |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| Note sequence form             | `(seq ...)` / `[...]`       | flat inline — notes written directly in channel body             |
| Subgroup / tuplet              | `[e g a]` in item position  | `(e g a)` in item position                                       |
| Single-stage curve spec        | `[:fn ease-out ...]`        | `(ease-out ...)`                                                 |
| Multi-stage curve spec         | `[(ease-in ...) (sin ...)]` | unchanged (after `:macro` only)                                  |
| Track declaration              | `(track :ch X ...)`         | `(X ...)` — channel name as form head                            |
| Mid-track defaults             | `(default :oct 3 ...)`      | removed — channel options set initial state; all state is sticky |
| `def` reference / voice switch | `@name`                     | bare identifier `name`                                           |
| Hardware param write           | `(set :tl1 30)`             | inline `:tl1 30` — same position as `:oct`/`:len`                |

`[:fn ...]` wrapper is removed. Curve forms are `(curve-name :from ... :to ... :len ...)` directly.
`track` keyword and `:ch` option are removed. The channel name is the form head directly:
`(fm1 :oct 4  c e g e)`, `(sqr1 :oct 3  c d e)`, `(noise :mode 7  x x x x)` etc.
All state (`:oct`, `:len`, `:gate`, `:vel`, `:vol`, `:mode`, `:macro`, `:pitch`, etc.) is sticky — within a
form and **across consecutive forms of the same channel name**. The compiler maintains a
per-channel state map; state is never reset automatically between forms.
`:master` is score-level state (not channel-local). `(score :master N)` sets the initial
global value; inline `:master` writes on any channel update that same global value at
their timeline tick.
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
| `:keyword`                      | Modifier or parameter pair                                          |
| `(form ...)`                    | Structural form (`x`, `break`, curve, etc.)                         |
| Any other identifier            | `def` reference — compiler resolves content                         |

**Length token formats** — wherever a length value appears (`:len`, explicit note/rest suffix) the following forms are accepted:

| Format      | Example | Resolved as                      |
| ----------- | ------- | -------------------------------- |
| Integer     | `4`     | note-length (quarter = 48 ticks) |
| Dotted int  | `4.`    | note-length × 1.5 (72 ticks)     |
| Frame count | `16f`   | exactly 16 driver frames         |
| Tick count  | `14t`   | exactly 14 ticks                 |

`4.` is shorthand for `4 * 1.5`. A single dot is supported; double-dot is out of scope for v0.4.
Fraction notation (`1/N`, `N/M`) is not supported — use ties (`~`) for durations longer than a whole note.
The `f` and `t` suffixes are valid wherever a length value appears: `:len`, `:gate`, note/rest suffix, `:wait`.
Use `Nt` when the desired duration does not align to any note-length integer — e.g. splitting an 8th note
(24 ticks) into a 1-tick attack and a 23-tick body:

```lisp
; SN76489 periodic noise with white-noise attack on each 8th note
; (sqr3 provides frequency for periodic noise, muted via :vol)
(noise :len 8
  :mode white      c1t    ; 1-tick attack click
  :mode periodic3  c23t   ; 23-tick periodic body  (1 + 23 = 24 = 8th note)
  :mode white      c1t
  :mode periodic3  c23t
  :mode white      c1t
  :mode periodic3  c23t)
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
| `(curve-name ...)`     | After `:macro`; inline curve form          | Curve spec                                                         |
| `[(stage1) (stage2)]`  | After `:macro`                             | Multi-stage macro                                                  |

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

Example: `:len 4` (48 ticks), 5 notes → `[9, 10, 9, 10, 10]` (total = 48).

**Examples:**

```lisp
; note sequence flat in channel body
(fm1 :oct 4 :len 4  c e g c)

; :oct 5 persists after the phrase
(fm1 :oct 4 :len 8  c e g e  :oct 5  c e g e)

; bare identifier switches voice (no @ prefix)
(fm1 :oct 4 :len 8  brass  c e g e  :tl1 20  c e g e)

; subgroup (triplet): 3 notes in a quarter note (48 ticks / 3 = 16 ticks each — exact)
(fm1 :len 4  c  (e g a)  f)

; subgroup (5 in a quarter): 48 ticks / 5 = 9.6 — Bresenham distributes as [9, 10, 9, 10, 10]
; total always equals parent :len; max per-note error is 1 tick (< 1/60 s, inaudible)
(fm1 :len 4  (c e g a b))

; single-stage envelope (:pitch values are cents; -4800 = -4 octaves)
(def syntom-pitch :macro :pitch (ease-out :from 0 :to -4800 :len 8))

; Multi-stage macro ([...] retained after :macro only — data vector, not note sequence)
; cents again: -1200 = -1 octave, +/-1000 = +/-10 semitones
(def vib-entry :macro :pitch
  [(ease-in :from -1200 :to 0 :len 16)
   (sin    :from -1000 :to 1000 :len 8)])

; curve value inline (emits PARAM_SWEEP)
(fm1 :len 8  :tl2 (ease-out :from 28 :to 20 :len 8)  c e g e)

; dotted notes — length × 1.5
(fm1 :len 4  c. e. g)       ; c. = dotted quarter using current :len
(fm1 :len 8  c4. e8.)       ; c4. = dotted quarter, e8. = dotted eighth (explicit)

; dotted :len
(fm1 :len 4.  c e g e)        ; :len 4. = dotted quarter (72 ticks) for all notes

; rest with explicit length — independent of current :len
(fm1 :len 4  c _8 c _16 c)

; dotted rests
(fm1 :len 4  c _. e _4.)    ; _. = dotted quarter rest, _4. = same explicit

; cross-form state inheritance — :oct 5 and :macro persist into next form
(fm1 :oct 4 :len 4 :macro scoop  c e g e)
(fm1  c e g e)   ; :oct 4, :len 4, :macro scoop all still active
(fm1 :oct 5  c e g e)   ; only :oct changes; other state unchanged
```

**Decided: `(seq ...)` and `[...]` (note sequence form) are both removed in v0.4.** No deprecated aliases.
`[...]` is retained **only** after `:macro` for Multi-stage macros (data vector context).
Existing demo source (`demo1.mmlisp`) used `(seq ...)` and `(track :ch ...)`
throughout — a one-time rename pass was required before it could be used with
the v0.4 compiler.

---

### 1.4 Inline parameter writes

**Decided: inline `:<target> value` for all parameter writes. `(set ...)` and `param-set` are removed.**

Hardware parameter writes use the same `:<target> value` syntax as note modifiers.
The compiler distinguishes them by key name:

| Key class       | Examples                                                     | Compile behaviour                                                                                                        |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Sequencer state | `:oct` `:len` `:gate` `:vel` `:vol`                          | `:oct/:len/:gate/:vel` are note-generation state (KEY-ON scoped). `:vol` is channel-level control on timeline (see §1.5) |
| Hardware params | `:tl1`–`:tl4` `:ar1`–`:ar4` `:fb` `:dt1` `:mode` `:pan` etc. | emit `PARAM_SET` IR event                                                                                                |
| Curve value     | `:tl2 (ease-out ...)`                                        | emit `PARAM_SWEEP` IR event                                                                                              |

All hardware parameter values are **absolute** (register value written directly).
Relative/delta notation (e.g. `:tl1 +5`) is not supported.

`PARAM_SWEEP` trigger scope:

- Inline curve writes such as `:alg (sin ...)`, `:fb (triangle ...)`, `:pitch (sin ...)` are **timeline-driven**.
- They are **not** KEY-ON scoped. The curve starts at that tick and continues by channel time.
- A later write on the same target (`PARAM_SET` or another `PARAM_SWEEP`) overrides and ends the previous sweep.
- Loop waveforms (`sin`, `triangle`, `square`, `saw`, `ramp`) are treated as periodic and continue across phrase/track loops unless explicitly overwritten.

This model is intentionally different from `:macro :vel` / `:macro :pitch` attached to `NOTE_ON`, which are KEY-ON scoped.

**Trigger scope summary:**

| Form               | Example                             | Trigger                        | Continuity                                               |
| ------------------ | ----------------------------------- | ------------------------------ | -------------------------------------------------------- |
| Inline curve write | `:alg (sin ...)`                    | Timeline tick (place of write) | Continues until overwritten; persists across track loops |
| `:macro :pitch`    | `(def vib :macro :pitch (sin ...))` | KEY-ON (each NOTE_ON)          | Restarted from phase 0 on every note                     |
| `:macro :vel`      | `(def att :macro :vel [15 10 5 0])` | KEY-ON (each NOTE_ON)          | Restarted on every note                                  |

The distinction is: directly writing a curve (`:target (fn ...)`) is a channel-level timeline operation; attaching a curve after `:macro` makes it note-level (KEY-ON scoped).

`PARAM_ADD` in v0.4 is out of scope for authoring and runtime semantics in this document.

```lisp
(fm1 :oct 4 :len 8
  :tl1 30 :dt1 5        ; PARAM_SET — hardware writes
  c e g e
  :tl2 (ease-out :from 28 :to 20 :len 8)   ; PARAM_SWEEP
  c e g e)
```

### 1.5 Level model - `:master` / `:vol` / `:vel`

**Decided: v0.4 uses a 3-layer logical level stack.**

| Layer     | Scope                        | Range | Default | Meaning of max value |
| --------- | ---------------------------- | ----- | ------- | -------------------- |
| `:master` | score-global (`(score ...)`) | 0-31  | 31      | no attenuation       |
| `:vol`    | channel-local state          | 0-31  | 31      | no attenuation       |
| `:vel`    | note strength                | 0-15  | 15      | full note strength   |

`0` is silence on every layer. Larger values are louder. Composition is multiplicative
in the logical domain (driver/compiler implementation can use fixed-point integers).

`master` semantics:

- Scope is global (one value shared by all channels).
- Initial value is set at score head (`(score :master 31 ...)`).
- Inline writes on any channel update the same global value at that tick.

Trigger model for level layers:

- `:macro :vel` is KEY-ON scoped (per-note trigger).
- `:vol` is not KEY-ON scoped: it changes when timeline events occur (`:vol N`, `:vol (curve ...)`).
- `:master` is not KEY-ON scoped: it changes when timeline events occur (`:master N`, `:master (curve ...)`).
- `:vol`/`:master` may also be updated by runtime external control flags/messages from game code.

`macro-vel` from `:macro :vel` remains 0-15 and is intentionally composer-friendly
for PSG/SSG-style authoring (`[15 10 5 0]` reads naturally as loud to soft).

Effective note level is determined by all four terms:

```
effective_level = macro_vel(0-15) * vel(0-15) * vol(0-31) * master(0-31)
```

After logical composition, each backend maps to hardware:

| Channel          | Hardware mapping                                            |
| ---------------- | ----------------------------------------------------------- |
| PSG (srq, noise) | convert to SN76489 attenuation (`0=max`, `15=silent`)       |
| FM (fm1-fm6)     | convert to carrier TL offset (carrier mask resolved by ALG) |
| PCM (dac)        | convert to mixer gain                                       |

Curves are the preferred way to author fades and musical motion; raising `:vol`
resolution beyond 0-31 is deferred unless real content shows a need.

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

`:glide N` enables automatic portamento: before
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

**Authoring syntax** — inline `:<target> curve-form` (same position as any `:<target> value`):

```lisp
; one-shot: TL sweep over one 8th note
(fm1 :oct 4 :len 8
  :tl2 (ease-out :from 28 :to 20 :len 8)
  c e g e)

; one-shot: pitch glide between sections (+1200 = +1 octave, in cents)
(fm1 :oct 4 :len 4
  :pitch (linear :from 0 :to 1200 :len 4)
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
(def portamento :macro :pitch (linear :to 0 :len 8f))
; :to 0 = note's own pitch; :from omitted = last_written[pitch]
```

Applies to both `ENVELOPE_TABLE` (§2.5) and `PARAM_SWEEP` (§2.11).

---

### 2.x Macro value model

**Decided: the following rules apply to all macro step vectors.**

#### Numeric representation

Macro functions always generate numeric vectors. Symbolic inputs are resolved
at compile time:

| Lane        | Symbol input            | Internal value                        |
| ----------- | ----------------------- | ------------------------------------- |
| `:pitch`    | `c` `d` `e` … `b`       | cents offset relative to current note |
| `:pan`      | `left` `center` `right` | -1 / 0 / +1                           |
| `:vel` etc. | integer literal         | integer as-is                         |

#### Pitch macro — relative cents

`:macro :pitch` values are **relative pitch deltas in cents** from the current
note at KEY-ON (`100 = 1 semitone`, `1200 = 1 octave`).

Accepted numeric range is signed 16-bit (`i16`): `-32768..32767`.

The full pitch computation before backend conversion is:

```
final_pitch = base_note + :oct adjustment + :pitch offset + macro:pitch delta
```

This wide authoring range is intentional so `:pitch` can be used as a primary
composition lane. Backend writers clamp only at the final hardware write stage.

Future: a quantize snap (scale mask) may be applied after the sum, rounding to
the nearest pitch in the specified set (e.g. `[c e g]`). The snap repeats
across all octaves.

#### Pan lane

`:pan` applies to FM channels (fm1–fm6) and PCM (fm6 as DAC). It is not
applicable to SN76489 channels (sqr1–sqr3, noise); the compiler emits a
warning and ignores `:pan` on those channels.

Allowed values: `left` (-1), `center` (0), `right` (+1).
Raw integers are also valid: `-1` = left, `0` = center, `+1` = right.

`:macro :pan` is a valid macro target. Both symbolic and numeric forms are
accepted in step vectors:

```lisp
(def pan-sweep :macro :pan [left left center right right center])
(def pan-sweep :macro :pan [-1 -1 0 1 1 0])
```

#### Envelope targets

All hardware-writable parameters are valid `:macro` targets. The table below is
the complete list. Per-OP targets repeat for each operator suffix (`1`–`4`).

**Common — all channel types**

| Target   | Channels     | Range           | Notes                           |
| -------- | ------------ | --------------- | ------------------------------- |
| `:vel`   | FM, PSG, PCM | 0–15            | KEY-ON scoped; see §1.5         |
| `:pitch` | FM, PSG, PCM | cents Δ (`i16`) | KEY-ON scoped; relative to note |
| `:pan`   | FM, PCM      | -1 / 0 / +1     | `left`/`center`/`right`; no PSG |

**FM operator params (`:xx1`–`:xx4`)**

| Target        | Range | Description                 |
| ------------- | ----- | --------------------------- |
| `:tl1`–`:tl4` | 0–127 | total level                 |
| `:ar1`–`:ar4` | 0–31  | attack rate                 |
| `:dr1`–`:dr4` | 0–31  | decay rate                  |
| `:sr1`–`:sr4` | 0–31  | sustain rate (D2R)          |
| `:rr1`–`:rr4` | 0–15  | release rate                |
| `:sl1`–`:sl4` | 0–15  | sustain level               |
| `:ml1`–`:ml4` | 0–15  | multiplier                  |
| `:dt1`–`:dt4` | 0–7   | detune 1                    |
| `:ks1`–`:ks4` | 0–3   | key scale                   |
| `:am1`–`:am4` | 0–1   | amplitude modulation on/off |

**FM channel params**

| Target | Range | Description          |
| ------ | ----- | -------------------- |
| `:alg` | 0–7   | algorithm            |
| `:fb`  | 0–7   | feedback             |
| `:ams` | 0–3   | AM sensitivity (LFO) |
| `:fms` | 0–7   | FM sensitivity (LFO) |

**PSG / noise**

| Target  | Channels | Range | Description          |
| ------- | -------- | ----- | -------------------- |
| `:mode` | noise    | 0–7   | noise type; see §4.2 |

#### Hold token

`_` in a step vector means **do nothing** — no register write, no value change.
The previous state for that lane is preserved. There is no dedicated "silence"
token (`r` is not defined).

#### Inline vs. macro conflict resolution

When an inline parameter write and a macro step target the same lane at the
same tick, **inline wins**. The macro step is discarded for that tick only;
the macro continues advancing on the next tick.

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
│     NOTE_ON  pitch=c4  len=48   envId=2   ; u8; 0 = no envelope
│
└── ENVELOPE_TABLE  (section 0x0005)
      [id=2]  target=pitch  curve=ease-out  from=0  to=-4800  frames=16
              wait=0  loop=false
      [id=3]  [target=tl4  curve=triangle  from=0  to=6  frames=8  loop=true]
              [target=tl1  curve=triangle  from=0  to=2  frames=8  loop=true]
      [id=4]  target=vel  curve=triangle  from=12  to=15  frames=15
              carrier_mask=0b1001  loop=true   ; FM only — compiler resolves from ALG
```

**Entry byte layout — per target sub-entry:**

```
Header (3 bytes):
  u8   target        ; pitch=0  vel=1  tl1=2  tl2=3  tl3=4  tl4=5  dt1=6  …
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
[id=5]  target=vel  carrier_mask=0xFF  stage_count=4
  stage[0]  curve_id=ease-out  flags=0          from=0   to=15  frames=4   ; Attack
  stage[1]  curve_id=ease-in   flags=0          from=15  to=10  frames=2   ; Decay
  stage[2]  curve_id=0xFF      flags=koff_wait  from=10  to=10  frames=0   ; Sustain
  stage[3]  curve_id=ease-in   flags=0          from=10  to=0   frames=4   ; Release
```

**Decided: `NOTE_ON` carries a single `envId` (u8).** `0` = no envelope. Multiple
targets (e.g. `:tl4` + `:tl1` + `:pitch` simultaneously) are packed into one
`ENVELOPE_TABLE` entry with multiple sub-entries; the NOTE_ON still references a
single id. Inline `:macro` overrides replace the id on that NOTE_ON only — the
compiler resolves the substitution statically.

**MMLisp authoring syntax:**

```lisp
; one-shot: synth tom pitch sweep
(def syntom-pitch :macro :pitch (ease-out :from 0 :to -4800 :len 8))

; one-shot: brass scoop-up
(def scoop :macro :pitch (ease-in :from -1800 :to 0 :len 16))

; looping LFO: vibrato (wait before onset)
(def vibrato :macro :pitch (sin :from -1000 :to 1000 :len 8
                          :wait 4))

; looping LFO: tremolo on TL (carrier level)
(def tremolo :macro :tl1 (triangle :from 0 :to 3 :len 8))

; step sequence: traditional PSG velocity envelope
(def pluck :macro :vel [15 12 8 4 2 1 0])
(def pad   :macro :vel [15 :loop 14 13])
(def organ :macro :vel [15 :loop 14 13 :release 3])

; curve vector: attack then release (no sustain loop — both stages complete)
(def psg-punch :macro :vel
  [(ease-out :from 15 :to 8 :len 16)    ; stage 1 — quick attack fade, completes
   (ease-in  :from 8  :to 0 :len 8)])   ; stage 2 — tail out, then silence

; curve vector: attack then sustain-loop (release NOT reachable — loop stage is terminal)
(def psg-pad :macro :vel
  [(ease-in    :from 0  :to 14 :len 8)  ; stage 1 — fade in, completes
   (triangle  :from 12 :to 15 :len 8)]) ; stage 2 — tremolo loops indefinitely; no further stage

; curve: AM/tremolo via logical velocity envelope — works on all channel types
(def tremolo-psg :macro :vel (triangle :from 12 :to 15 :len 8))   ; gentle PSG tremolo
(def am-fade     :macro :vel (ease-out  :from 15 :to 0  :len 1))   ; fade over 1 whole note

; ADSR in step-vector form — attack / decay / sustain-loop / release
(def adsr-soft :macro :vel
  [3 7 12 15                         ; Attack  — 4-step ramp up
   :loop 14 14 15 15                 ; Sustain — gentle shimmer (loops until KEY-OFF)
   :release 12 9 6 3 1 0])          ; Release — ramp down after KEY-OFF
```

**Rule: a looping curve stage is terminal — stages after it are never reached.**
To combine a sustain-loop with a release tail, use the step-vector
`[:loop ... :release ...]` form, not `[curve-vec]`.

**Decided: `:macro :vel` is the envelope-layer loudness scale (`0` = silent, `15` = max envelope output) on all
channel types.** Final loudness also includes `:vel`, `:vol`, and `:master` (see §1.5).
The compiler/driver maps the composed level to hardware per channel:

| Channel          | Hardware mapping                                      |
| ---------------- | ----------------------------------------------------- |
| PSG (srq, noise) | SN76489 attenuation conversion (`0=max`, `15=silent`) |
| FM (fm1–fm4)     | carrier-TL offset applied to carrier operators        |
| PCM (dac)        | direct mixing-volume scaling                          |

`[15 12 8 4 2 1 0]` therefore reads as "loud → silent" for the envelope layer on every channel type; no
polarity surprises for the composer.

**`:macro :vel` accepts both step-vector and curve forms.** `:from`/`:to` values use
the same 0-15 envelope scale. This envelope output is composed with `:vel`/`:vol`/`:master`
before hardware conversion.

**FM `:vel` curve — `carrier_mask` resolved at compile time.** The compiler
determines which OPs are carriers from the voice def's `:alg` value and embeds a
`carrier_mask` (u8 bitmask, bit0=OP1…bit3=OP4) in the `ENVELOPE_TABLE` entry.
The driver reads the mask and updates only the flagged TL registers each frame.
No runtime ALG lookup is needed.

When the same `:macro` def is attached to voice defs with different ALG values, the
compiler generates a separate `ENVELOPE_TABLE` entry per (env-def × carrier_mask)
combination. Authors write one def; the compiler deduplicates automatically.

For FM tremolo, choosing between `:vel (curve ...)` and `:tl1 (curve ...)`:

| Approach                | Range | Scope                                        | Use when                                |
| ----------------------- | ----- | -------------------------------------------- | --------------------------------------- |
| `:vel (curve ...)`      | 0-15  | envelope layer, then level-stack composition | all channel types; coarse AM/tremolo    |
| `:tl1 (curve ...)` etc. | 0–127 | one operator at a time                       | FM fine-grained tremolo or filter sweep |

Step-vector `[...]` and curve `(curve ...)` can also be combined per-target in a
multi-target envelope (sequential vel, simultaneous pitch, etc.).

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
- `:extends` is valid only in `def` forms for FM voice parameters; def is
  expanded at the use site, so inline `:extends` (e.g., directly in channel body)
  is not supported. Use a named def reference instead.

**Attaching an envelope to a voice def:**

```lisp
(def syntom
  :alg 7  :fb 0
  :ar1 31 :dr1  5 :sr1  0 :rr1  3 :sl1  7 :tl1  0 :ks1 0 :ml1 0 :dt1 0
  :ar2 31 :dr2  5 :sr2  0 :rr2  3 :sl2  7 :tl2  0 :ks2 0 :ml2 0 :dt2 0
  :ar3 31 :dr3  5 :sr3  0 :rr3  3 :sl3  7 :tl3  0 :ks3 0 :ml3 0 :dt3 0
  :ar4 31 :dr4  5 :sr4  0 :rr4  3 :sl4  7 :tl4  0 :ks4 0 :ml4 0 :dt4 0
  :macro syntom-pitch)            ; envelope fires on every NOTE_ON
```

**Inline override:**

```lisp
(fm1  :oct 4 :len 4
  syntom :macro syntom-pitch  c   ; explicit per-note env attach
  snare                     c)
```

**Multi-stage macros** — a vector of `(curve ...)` forms, providing sequential
stages on one target. `[...]` is **required** to delimit the stage list; without
it, in a multi-target def, a second `(curve ...)` form would be ambiguous (another
stage, or the value of the next target key?). The `[...]` wrapper makes stage count
explicit at the parser level.

```lisp
(def vib-entry :macro :pitch
  [(ease-in :from -1200 :to 0 :len 16)         ; scoop up
   (sin    :from -1000 :to 1000 :len 8)])      ; then vibrato
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

Multi-stage envelopes are triggered by KEY-ON: the first stage starts at KEY-ON,
`(wait key-off)` holds at the current value, and the following stage starts when
KEY-OFF arrives.

```lisp
; ADSR via multi-stage with wait stage
(def adsr-curve :macro :vel
  [(ease-out :from 0  :to 15 :len 4)    ; Attack
   (ease-in  :from 15 :to 10 :len 2)   ; Decay
   (wait key-off)                       ; Sustain — hold at 10 until KEY-OFF
   (ease-in  :from 10 :to 0  :len 4)]) ; Release — tail after KEY-OFF
```

**Macro list — `:macro [...]`** — multiple macro entries can be combined at the
use site by passing a vector. Each element is either a **named def** or an
**inline `:<target> curve` pair** written directly in the list. All targets are merged
and run simultaneously from KEY-ON. If two entries target the same lane, the
**last one wins**.

```lisp
(def ar1-sweep :macro :ar1 (ease-in :from 0 :to 31 :len 8))
(def ar2-sweep :macro :ar2 (ease-in :from 0 :to 20 :len 8))

; named defs
(fm1 :macro [ar1-sweep ar2-sweep]  c d e)

; inline — no def needed
(fm1 :macro [:ar1 (ease-in :from 0 :to 31 :len 8)
             :ar2 (ease-in :from 0 :to 20 :len 8)]  c d e)

; mixed — named def + inline
(fm1 :macro [ar1-sweep  :pitch (ease-out :from 0 :to -1200 :len 4)]  c d e)

; duplicate target — last wins
(fm1 :macro [ar1-sweep  :ar1 (triangle :from 0 :to 4 :len 4)]  c)  ; triangle wins
```

A single name (no brackets) remains valid: `:macro trem-brass`.
A single inline pair is also valid: `:macro :vel [15 12 8 0]`.

Combining multiple targets per channel can be authored in two ways:

1. `:macro [list]` at the use site
2. A multi-target `def :macro` with `:macro [ ... ]`

```lisp
(def synth-env :macro [
  :vel   [15 12 8 4 0]
  :pitch (linear :from 0 :to -1200 :len 8)
])

(fm1 :macro synth-env c)
```

When the same target appears multiple times in one multi-target def, the last
entry wins.

```lisp
; voice def: macro fires on every NOTE_ON
(def brass :extends fm-init
  :alg 7
  :macro trem-brass)

; inline override per note
(fm1 :oct 4 :len 4
  brass :macro trem-brass  c e g e)
```

**Multi-stage execution order — sequential:** stages run one after another on
the same key. Stage N begins only after stage N−1 completes (`frames` elapsed).
If stage N−1 is a loop waveform, it loops indefinitely and stage N is never
reached — use this to model an attack → sustain-loop pattern.

**Multi-target — simultaneous:** the `[list]` form at the use site merges
entries targeting different parameters. All targets start simultaneously from
KEY-ON, each on its own independent timeline. Multi-stage (sequential per
target) and multi-target (simultaneous across targets) compose freely: each
target key can independently carry a single curve or a `[...]` stage vector.

```lisp
; both at once: :pitch is sequential stages, :vel runs in parallel alongside it
(def syntom-vel   :macro :vel   [15 12 8 4 0])
(def syntom-pitch :macro :pitch (ease-out :from 0 :to -4800 :len 8))

(fm1 :macro [syntom-vel syntom-pitch]  c d e)
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
(portamento between notes) and `:macro :pitch` (per-note LFO/scoop) compose without
interference:

```lisp
; glide slides base_pitch c4→e4 over 8 frames;
; vibrato runs on env_pitch_delta simultaneously — they add
(fm1 :glide 8 :macro vibrato  :oct 4 :len 4  c e g e)
```

PARAM_SWEEP for `:pitch` (§2.11) also targets `base_pitch`, not `env_pitch_delta`.
This keeps track-timeline pitch glides independent of per-note envelope pitch curves.

**FM vs PSG F-number resolution:** the `:pitch` delta unit in a macro is defined
as a hardware-independent cents value. The compiler scales to F-number
bits at emit time based on channel type (FM: 11-bit F-number; PSG: 10-bit
tone register). Envelope table stores the logical delta; the driver reads the
pre-scaled value from the table.

**Decided: `:from`/`:to` unit is semitone-cents (100 = 1 semitone).** The compiler
scales to F-number register bits at emit time based on channel type. Authors never
deal with raw F-number delta; hardware differences are a compiler detail.

**Decided: `:pitch` value domain is `i16` cents (`-32768..32767`) for inline,
step-vector, and curve `:from`/`:to` values.**

**Decided: backend clamp policy.** Values are clamped only when converted to
chip registers:

- FM (YM2612): clamp to representable pitch domain (effective `block`/`fnum` write range).
- PSG (SN76489): clamp to representable tone period domain (`1..1023`).

The compiler may emit diagnostics for extreme values, but source values inside
`i16` remain valid language input.

**Decided: `:len` for curve duration.**

Wherever a duration appears in a curve form — including `:wait` — the same
length formats as note/rest lengths apply:

| Format      | Example    | Meaning                                         |
| ----------- | ---------- | ----------------------------------------------- |
| Integer     | `:len 4`   | note-length — quarter note (48 ticks @ BPM=120) |
| Dotted int  | `:len 4.`  | note-length × 1.5                               |
| Frame count | `:len 16f` | exactly 16 driver frames (BPM-independent)      |

Frame-count (`Nf`) is useful for effects where timing is hardware-fixed —
e.g. a whistle attack of 3 frames, or a PCM gate of exactly 10 frames.
Musical durations (integer, dotted) scale with BPM; `Nf` does not.

The compiler converts musical lengths to frames using:

```
frames = ticks * fps * 60 / (BPM * PPQN)
```

At BPM=120, fps=60, PPQN=48: frames = ticks \* 5 / 8 (quarter = 30 frames).

```lisp
(def vibrato :macro :pitch (sin :from -1000 :to 1000 :len 4
                          :wait 4))           ; period = quarter note, wait before onset

(def syntom-pitch :macro :pitch (ease-out :from 0 :to -4800 :len 8f)) ; exactly 8 frames

(def whistle-on :macro :pitch (ease-in :from -2400 :to 0 :len 3f))    ; 3-frame attack

(def vibrato-late :macro :pitch (sin :from -1000 :to 1000 :len 4
                               :wait 8f))     ; wait=8 frames fixed, period=quarter

; release swell: after KEY-OFF, scoop up pitch
(def release-scoop :macro :pitch (ease-in :from -2400 :to 0 :len 4
                                :wait key-off)) ; curve starts after KEY-OFF
```

`:wait` accepts the same values as `(wait)` stage form — `N`, `Nf`, or `key-off`.
**Compiler:** `:wait N` on a single-stage curve expands to `[(wait N) (curve ...)]`
internally; the wait and curve run as consecutive stages sharing one `envId`.

**Decided: `:release` in step-vector — compiler emits `KEY_OFF` at `gate_ticks`.**

The step-vector format for `:macro :vel` is:

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
(def organ :macro :vel [15 14 :loop 13 12 :release 11 9 7 5 3 1 0])

; no attack — sustain immediately, release on gate close
(def pad :macro :vel [:loop 14 13 :release 5 3 1 0])

; one-shot, no loop, no release — envelope plays to end regardless of gate
(def pluck :macro :vel [15 12 8 4 2 1 0])
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
(sqr1 :len 0 :macro psg-asr  c)
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
  key_off_flags:   u16  ; bitmask, one bit per channel (fm1–fm6=6, sqr1–sqr3=3, noise=1 → 10 bits used)
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
| 6     | sqr1       |
| 7     | sqr2       |
| 8     | sqr3       |
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

Multi-stage macros use `[(curve ...) (curve ...)]` syntax (see §2.5); no
special curve name needed.

`reverse` is not a curve name; reverse a curve by swapping `:from` and `:to`.

---

## 4. Hardware

### 4.1 PSG noise control

SN76489 noise register (byte format: `111 FB NF1 NF0`):

| Bits | Field | Meaning                                           |
| ---- | ----- | ------------------------------------------------- |
| `FB` | 1 bit | 0 = periodic (pitched buzz), 1 = white noise      |
| `NF` | 2 bit | 00/01/10 = fixed rate ÷16/÷32/÷64; 11 = sqr3 freq |

When `NF=11`, the noise channel clocks from `sqr3`'s tone generator. `sqr3`
simultaneously produces its own tone output, enabling **tone + noise mix**.

**Design: `:mode` is a channel option and inline modifier.**

Noise mode is set via `:mode` on the `noise` channel.
Envelope is attached separately via `:macro` or via a `def` reference.

```lisp
; named envelope defs
(def hh-closed-env :macro :vel [15 8 0])
(def hh-open-env   :macro :vel [15 12 10 8 4 0])
(def ride-env      :macro :vel [15 14 13 :loop 12 11])

; noise track
(noise :mode white0
  :len 8 :macro hh-closed-env
  c c
  :mode white2 :macro hh-open-env
  c
  :mode white0 :macro hh-closed-env
  c c
  :mode periodic0 :macro ride-env
  c)
```

A `:mode` change emits `NOISE_MODE` IR event (FB + NF bits).
A `:macro` change emits `ENV_ATTACH` IR event.

`:noise` values — single keyword encoding FB + NF bits:

| Value       | FB  | NF   | Meaning                    |
| ----------- | --- | ---- | -------------------------- |
| `white0`    | 1   | `00` | white, fastest (÷16)       |
| `white1`    | 1   | `01` | white, medium (÷32)        |
| `white2`    | 1   | `10` | white, slowest (÷64)       |
| `white3`    | 1   | `11` | white, freq = sqr3         |
| `periodic0` | 0   | `00` | periodic buzz, fastest     |
| `periodic1` | 0   | `01` | periodic buzz, medium      |
| `periodic2` | 0   | `10` | periodic buzz, slowest     |
| `periodic3` | 0   | `11` | periodic buzz, freq = sqr3 |

**sqr3 link example — sweep noise frequency with a curve:**

```lisp
; noise gates on every quarter note; frequency follows sqr3
(noise :mode white3  :len 1  c c c c  c c c c)

; sqr3 sweeps pitch up an octave (+1200 cents) over 4 frames — noise frequency tracks it
; sqr3 is also audible as a tone alongside the noise
(sqr3 :len 1  :pitch (linear :from 0 :to 1200 :len 4f)
  c c c c  c c c c)
```

**Decided: `:mode` inline modifier covers mid-track noise change.** No
additional syntax needed. Use `:mode white2` mid-track
to change noise mode.

---

**`:macro :mode` — frame-based noise mode envelope**

`:macro :mode` accepts a step-vector of mode keywords or raw numeric values
(the 3-bit FB+NF hardware field written directly), advancing one step per
driver frame. This enables sub-note timbre changes while note sequencing
remains tick-based.

Raw numeric values map directly to the SN76489 noise register bits (0–7);
using the symbolic names (`white0`–`white2`, `periodic0`–`periodic3`) is
preferred for readability but both forms are valid.

```lisp
; attack: 2 frames white → sustain: periodic3 (loops until KEY-OFF or end of note)
(def noise-atk :macro :mode [white0 white0 :loop periodic3])

; attack: white → sustain: periodic → release: white on key-off
(def noise-asr :macro :mode [white0 white0 :loop periodic3 :release white2])
```

`:loop` and `:release` semantics are identical to `:macro :vel` step-vector:

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
; sqr3 provides frequency for periodic3 mode (muted via :vol)
(def perc-buzz :macro :mode [white0 :loop periodic3])

(noise :len 8 :macro perc-buzz
  c c c c  c c c c)
```

The compiler encodes `:macro :mode` step-vectors as `MODE_ENV_TABLE` entries
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

`:pan` emits a `PARAM_SET` for the B4 register.
Applies to `fm1`–`fm6` only; SN76489 has no stereo hardware.

| Value    | Bits 7–6 | Output          |
| -------- | -------- | --------------- |
| `center` | `11`     | L + R (default) |
| `left`   | `10`     | L only          |
| `right`  | `01`     | R only          |

```lisp
(fm1 :pan center  c e g e)   ; L+R — default
(fm1 :pan left    c e g e)   ; L only
(fm1 :pan right   c e g e)   ; R only
```

The compiler initial default is `center`; no `PARAM_SET` is emitted unless
`:pan` appears in the source.

B4 also carries bits 5–4 (AMS, PMS — hardware LFO sensitivity). The compiler
preserves the AMS/PMS bits from the current voice def when writing `:pan`:

```
new_B4 = (pan_bits << 6) | (current_B4 & 0x3F)
```

This means `:pan` and `:lfo-ams`/`:lfo-pms` parameters do not interfere.
