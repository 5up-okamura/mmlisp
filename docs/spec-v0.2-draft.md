# GMLisp v0.2 Design Notes

Document status: design-in-progress
Started: 2026-04-13

This document captures decisions and open questions for v0.2, based on design
discussions following the v0.1 freeze (tag: v0.1-candidate at b61eb11).

---

## 1. Decided

### 1.1 Keyboard shortcuts

| Key         | Behavior                                                                               |
| ----------- | -------------------------------------------------------------------------------------- |
| `Cmd+Enter` | Toggle: stopped → play from start (or last marker) / playing → pause / paused → resume |
| `Cmd+.`     | Full stop — discard position, return to start (or marker 0)                            |

Pause = position-preserving stop (audio silent, tick state held).
Stop = position reset.

### 1.2 Named voice data (`def` with type tag)

Two hardware-specific tags are reserved. All other `def` bindings remain
untagged generic data.

Tag semantics:

- `:fm` — YM2612 FM patch. Compiler expands to a `PARAM_SET` sequence at
  voice-load time. See vector layout below.
- `:psg` — PSG volume envelope. See §1.7 for envelope sub-types.
- No tag — compile-time constant binding. No IR emitted for the `def` itself.

No `:table` tag. Tagless vectors are already generic.

#### `:fm` vector layout

Channel vector (first vector) — **variable length 2–4**:

```
[ALG  FB  (AMS)  (FMS)]
  0    1    2      3     ← element index
```

- `ALG`, `FB` — required (algorithm 0–7, feedback 0–7)
- `AMS` — optional, YM2612 0xB4 bits 5–4 (0–3). Omit when not using HW LFO AM.
- `FMS` — optional, YM2612 0xB4 bits 2–0 (0–7). Omit when not using HW LFO FM.

Operator vectors (four vectors, OP1–OP4) — **variable length 9–11**:

```
[AR  DR  SR  RR  SL  TL  KS  ML  DT  (SSG)  (AMen)]
  0   1   2   3   4   5   6   7   8     9      10    ← element index
```

- Elements 0–8 — required. Column order follows ctrmml / YM2612 convention.
- `SSG` (index 9) — optional, SSG-EG mode (0–15, bit3=enable, bits2-0=shape).
- `AMen` (index 10) — optional, AM enable for this OP (0/1). Effective only
  when AMS is set in the channel vector.

Elements beyond the vector length are not emitted (no register write).

```lisp
;; Minimal (no LFO, no SSG-EG)
(def piano :fm
  [3 0]
  [31  0 19  5  0 23  0  0  0]
  [31  6  0  4  3 19  0  0  0]
  [31 15  0  5  4 38  0  4  0]
  [31 27  0 11  1  0   0  1  0])

;; With SSG-EG on OP4
(def pluck :fm
  [3 0]
  [31  0 19  5  0 23  0  0  0]
  [31  6  0  4  3 19  0  0  0]
  [31 15  0  5  4 38  0  4  0]
  [31 27  0 11  1  0   0  1  0  8])  ; SSG=8: attack-decay, no repeat

;; With HW LFO (AMS=1 FMS=2) and AM enable on OP4
(def strings :fm
  [3 0 1 2]
  [31  0 19  5  0 23  0  0  0]
  [31  6  0  4  3 19  0  0  0]
  [31 15  0  5  4 38  0  4  0]
  [31 27  0 11  1  0   0  1  0  0  1])  ; AMen=1

(def lookup-table [0 32 64 96 128])  ; no tag = generic data
```

#### TARGET_ID allocations (HW LFO additions)

| TARGET_ID | Name       | Register              |
| --------- | ---------- | --------------------- |
| 0x3a      | `FM_AMEN1` | 0x60+op1 bit7         |
| 0x3b      | `FM_AMEN2` | 0x60+op2 bit7         |
| 0x3c      | `FM_AMEN3` | 0x60+op3 bit7         |
| 0x3d      | `FM_AMEN4` | 0x60+op4 bit7         |
| 0x3e      | `FM_AMS`   | 0xB4 bits5-4          |
| 0x3f      | `FM_FMS`   | 0xB4 bits2-0          |
| 0x41      | `LFO_RATE` | 0x22 bits2-0 + enable |

`LFO_RATE` 0 = disable (writes `0x00` to reg 0x22). Values 1–8 map to
rates 3.98–72.2 Hz (writes `0x08 | (rate-1)`).

### 1.3 Same-channel track behavior

| Combination                         | Behavior                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| `:bgm` + `:bgm` on same `:ch`       | Compiler warning `W_SAME_CH_BGM` (IR still emitted)            |
| `:bgm` + `:modulator` on same `:ch` | Intentional merge; modulator writes FM params without eviction |
| `:se` + `:bgm` on same `:ch`        | `:se` evicts `:bgm` (already v0.1 behavior)                    |
| `:chaos` + anything                 | Undefined behavior, explicitly permitted                       |

### 1.4 modulator track for note/LFO separation

A `:modulator` track assigned to the same `:ch` as a `:bgm` track can write
FM parameters (e.g. pitch offset, operator volumes) independently on its own
tick timeline. This allows LFO-style modulation to be authored separately from
note sequences.

```lisp
(track :melody   :ch fm1 :role bgm
  (phrase (notes :c4 :e4 :g4)))

(track :vibrato  :ch fm1 :role modulator
  (phrase
    (loop (param-add :pitch 0) (param-add :pitch 5) (param-add :pitch -5))))
```

### 1.5 GMB event record: delta tick encoding

IR uses absolute ticks (`"tick": uint32`). GMB uses **delta ticks** — the number
of PPQN ticks elapsed since the previous event in the same track.

Rationale:

- IR absolute ticks are optimal for Web Audio pre-scheduling, multi-track merge,
  and binary-search seek.
- GMB delta ticks match the driver's countdown-timer execution model and reduce
  per-event byte cost.

The `gml2gmb` encoder is responsible for the conversion:
`delta[i] = tick[i] - tick[i-1]` (first event: `delta = tick[0]`).

GMB event record format (replaces provisional `tick: uint32`):

```
[delta: u16] [opcode: u8] [payload: fixed per opcode]
```

Delta range: 0..65535 ticks. Sequences requiring a gap larger than 65535 ticks
must insert a `REST` command to bridge the gap (TBD if needed in practice at
PPQN=120).

### 1.6 GMB JUMP address encoding

`JUMP` uses a **signed 16-bit relative byte offset** from the position of the
JUMP command itself.

```
driver:   PC += (int16) offset
encoder:  offset = markerBytePos - jumpBytePos
```

This matches the MDSDRV `f5 ww` convention. The offset is negative for
backward jumps (the common case: loop-to-top). Forward jumps use a positive
offset.

The encoder resolves all `MARKER` byte positions in a first pass, then fills
`JUMP` offsets in a second pass.

### 1.7 PSG envelope sub-types

`:psg` uses a **tagged union** format. The first element of the vector is a
keyword that identifies the sub-type.

#### bare sequence (no sub-type tag)

First element is an integer. No loop, no release. Envelope stops at the last
value. Retained for brevity.

```lisp
(def pluck :psg [15 12 9 6 3 0])
```

#### `:seq` — step sequence with loop and release

```lisp
(def organ   :psg [:seq 15 14 :loop 12 13 :release 6])
;;                              ↑ loop point    ↑ frames/step after key-off
(def tremolo :psg [:seq 15 :loop 12 14 12 14 :release 3])
(def attack  :psg [:seq 15 13 11 9 7 5 3 1 0])  ; no :loop, no :release
```

- Steps before `:loop` — played once on key-on.
- Steps from `:loop` to end — repeated while key is held.
- `:loop` absent — sequence plays once then holds the last value until key-off.
- `:release N` — after key-off, volume decreases by 1 every N frames.
- `:release` absent — volume cuts immediately on key-off.

#### `:adsr` — ADSR rate model

```lisp
(def brass :psg [:adsr :ar 3 :dr 8 :sl 10 :sr 0 :rr 6])
```

| Param | Meaning                                        | Unit        |
| ----- | ---------------------------------------------- | ----------- |
| `:ar` | Attack — frames to rise from 0 to 15           | frames      |
| `:dr` | Decay — frames to fall from 15 to `:sl`        | frames      |
| `:sl` | Sustain level (0–15)                           | volume      |
| `:sr` | Sustain rate — 0 = hold, N = frames/step decay | frames/step |
| `:rr` | Release rate — frames/step after key-off       | frames/step |

#### `:hard` — hardware/buzz mode (reserved)

Parsed and stored; emits `W_PSG_HARD_RESERVED` warning. No IR generated.
Future: PSG noise+buzz control (tone/noise mix, period).

```lisp
(def buzz :psg [:hard :detune 0])  ; reserved syntax
```

#### `:fn` — function-generated envelope (v0.3+)

`E_FN_NOT_IMPL` error if used in v0.2. Reserved for macro-arithmetic
based envelope generation.

```lisp
; (def sweep :psg [:fn easeOut 15 0 32])  ; v0.3+
```

### 1.8 Score-level initial values

The `score` form accepts chip-global initial value options that the compiler
prepends as events at tick 0 on the first track.

```lisp
(score :title "Stage 1" :author "foo"
       :tempo 150        ; TEMPO_SET bpm=150 at tick 0
       :lfo-rate 3       ; PARAM_SET :LFO_RATE 3 at tick 0
  (track ...) ...)
```

| Option        | IR event emitted                  | Notes                                        |
| ------------- | --------------------------------- | -------------------------------------------- |
| `:tempo N`    | `TEMPO_SET bpm=N` at tick 0       | Overrides phrase-level tempo if both present |
| `:lfo-rate N` | `PARAM_SET :LFO_RATE N` at tick 0 | 0 = LFO off                                  |

Dynamic changes mid-song use `param-set` / `tempo-set` inside a phrase as
before. Score-level options are syntactic sugar for the initial state only.

### 1.9 `:carry` — modulator playhead continuity

By default, when a `:bgm` track fires `NOTE_ON`, any `:modulator` track
assigned to the same channel resets its playhead to the beginning of the
current phrase (reset-on-note). This matches ctrmml/MDSDRV default behavior.

`:carry true` suppresses the reset: the modulator continues from its current
playhead position across note changes. Useful when the modulation envelope
spans multiple notes or is intended as a continuous sweep.

`:carry` can be specified at two levels with the following priority:

```
phraseCarry ?? trackCarry ?? false
```

**Track level** (applies to all phrases in the track unless overridden):

```lisp
(track :vibrato :ch fm1 :role modulator :carry true
  phrase-a   ; carry=true (inherited from track)
  phrase-b)  ; carry=true (inherited from track)
```

**Phrase level** (overrides track setting for this phrase only):

```lisp
(def sweep (phrase :carry false   ; override: always reset on note
  (note :c4 1/8) ...))

(track :vibrato :ch fm1 :role modulator :carry true
  sweep)   ; carry=false (phrase overrides track)
```

Default when neither is specified: `false` (reset on NOTE_ON).

### 1.10 `def` with untagged phrase node

A `def` binding may hold a bare `phrase` node (no `:fm` / `:psg` tag).
The compiler treats it as a compile-time alias: wherever the name appears
inside a `track` body, it is substituted with the phrase node before
compilation. No IR is emitted for the `def` itself.

```lisp
(def riff (phrase (note :c4 1/8) (note :e4 1/8) (note :g4 1/4)))

(track :t1 :ch fm1 riff)
(track :t2 :ch fm2 riff)  ; same phrase data, different channel
```

Per-track parameter variation can be achieved with `defn`:

```lisp
(defn chorus-line [detune]
  (phrase
    (param-set :fm-dt1 detune)
    (note :c4 1/8) (note :e4 1/8)))

(track :t1 :ch fm1 (chorus-line 0))
(track :t2 :ch fm2 (chorus-line 3))  ; slight detune for chorus effect
```

Track start offset — use `(rest N/M)` at the start of the phrase; no special
option is needed:

```lisp
(track :bass :ch fm3
  (phrase
    (rest 8/1)                   ; wait 8 bars before entering
    (note :c3 1/4) ...))
```

### 1.11 Source map and cursor-line playback

The compiler attaches a `src: { line, column }` field to every IR event. The
`compileGML` function (browser-side) returns an additional `sourceMap` array —
a sorted list of `{ line, tick }` pairs derived from the first event at each
unique source line.

```
sourceMap = [{ line: 5, tick: 0 }, { line: 22, tick: 0 }, { line: 24, tick: 120 }, …]
```

**Cursor-line seek (Cmd+Enter with no active playback):**

1. Read cursor line N from the editor.
2. Binary-search `sourceMap` for the entry with the largest `line ≤ N`.
3. Call `player.playFromTick(audioCtx, entry.tick)`.
4. If no entry is found (cursor before all notes), play from tick 0.

This replaces the `marker` node as the seek mechanism for authoring. The
`marker` / `jump` nodes remain in the language for loop control only — authors
do not need to add markers purely to set a playback start point.

**`Cmd+Enter` behavior:**

| State   | Action                     |
| ------- | -------------------------- |
| Stopped | Seek to cursor line → play |
| Playing | Pause (preserve tick)      |
| Paused  | Resume from saved tick     |

**`Cmd+.`:** Full stop, reset tick to 0, clear playhead highlight.

### 1.12 Channel mute / solo and operator on/off (UI layer only)

These are runtime playback controls with no representation in GML source or IR.
They are implemented purely in IRPlayer and the web UI.

**Channel mute / solo:**

- `player.muteChannel(ch, muted)` — suppresses `NOTE_ON` key-on writes for
  the channel. PARAM_SET events still apply (register state stays consistent).
- `player.soloChannel(ch)` — mutes all channels except `ch`.
- `player.clearSolo()` — unmute all.

**Operator on/off:**

YM2612 register `0x28` key-on byte encodes per-op enables in bits 7-4 (op4,
op3, op2, op1 respectively; actual op slot order applies). IRPlayer stores a
per-channel op mask (default `0xf0` = all on). Changing the mask takes effect
on the next NOTE_ON.

- `player.setOpMask(ch, mask)` — e.g. `setOpMask(0, 0xa0)` disables op1+op3
  on channel 0.
- `player.getOpMask(ch)` → current mask.

---

## 2. Open Questions

### ~~2.1 Marker-based playback~~ → resolved in §1.11

Cursor-line seek via compiler source map. No `marker` nodes required in source
for this purpose. See §1.11.

### ~~2.2 def with phrase / track block reference~~ → resolved in §1.10

Tagless `(def name (phrase ...))` is a compile-time alias. The name is
substituted by `expandNode` before `compileTrack`. Track options such as `:ch`
are specified on the `track` form, not on the shared phrase. See §1.10.

### ~~2.3 PSG envelope loop and sustain point~~ → resolved in §1.7

Tagged union design (`bare` / `:seq` / `:adsr` / `:hard` / `:fn`).
Release is part of the voice def, not a track option.
See §1.7 for full specification.

### ~~2.4 modulator reset-on-note~~ → resolved in §1.9

Default: reset on `NOTE_ON` (carry=false). `:carry true` suppresses reset.
Priority: `phraseCarry ?? trackCarry ?? false`. See §1.9.

### 2.5 FM patch vector — column order confirmation

Column order `[AR DR SR RR SL TL KS ML DT (SSG) (AMen)]` confirmed.
DT2 (second detune) is out of scope for v0.2 — omitted from vector.

### ~~2.6 Compiler diagnostic severity for same-ch bgm collision~~ → resolved

Warning `W_SAME_CH_BGM`. IR is still emitted to allow incremental authoring.
See §1.3.

### 2.7 PWA UI layout

Proposed top bar: `File ▾ | Examples ▾ | [● Bar:Beat BPM] | [⌘↵ Play/Pause] [⌘. Stop] | Help ▾`

- FM parameter panel as slide-in drawer (not always visible)
- CodeMirror `lineNumbers()` extension
- Remove decorative panel borders/titles from current layout

### 2.8 `defn` — compile-time macro vs. runtime subroutine

Current GMLisp behavior:

- `defn` is a **compile-time macro**. Call sites are AST-expanded by `expandRoots`
  before `compilePhrase`. No call/return record appears in IR or GMB.
- Each `(bend-down :e4)` expands to the full event sequence inline.

Pros of current approach:

- Simple; no new IR opcodes needed
- Arguments are substituted at compile time

Cons vs. runtime subroutines:

- Binary size grows linearly with call count (no sharing in GMB)
- No runtime parameterization — args are compile-time constants only

v0.3+ candidate: add `CALL target` / `RET` to GMB opcode set and emit a
subroutine block instead of inlining when `defn` is reused across multiple call
sites. The IR would gain a `CALL` command; subroutine bodies would live in a
separate `subroutines` section of the IR.

**v0.2 decision**: `defn` remains compile-time macro. Runtime subroutines deferred.

---

## 3. Out of Scope for v0.2

- Full macro language parity with MML ecosystems
- PCM/WAV sample instruments
- Patch server / community infrastructure (see roadmap Future Vision)
- Contextual note editor (keyboard/envelope UI triggered by note selection)
- Runtime subroutines (`CALL`/`RET` in GMB) — `defn` is compile-time only in v0.2 (see OQ 2.8)
- `REG_WRITE` — raw YM2612 register write. Parser token is reserved; compiler rejects in strict mode. Deferred until low-level register access design is settled.
- `FM3_MODE` — FM3 independent-operator mode. Same reservation policy as `REG_WRITE`.
- `CSM_ON` / `CSM_OFF` / `CSM_RATE` — YM2612 CSM (composite sinusoidal modeling) speech-synthesis mode. Out of scope for music demo use cases.
- Full semantic diagnostics catalog — error/warning coverage beyond current demo-driven checks (e.g. phrase nesting, duplicate track names). Sufficient coverage exists for v0.1 demos; exhaustive catalog deferred.
- Multi-track channel allocation — voice stealing and track splitting across tracks sharing a channel. Not yet implemented.
