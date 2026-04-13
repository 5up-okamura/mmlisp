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

```lisp
(def finger-bass :fm
  [3 0]                            ; ALG FB
  [31  0 19  5  0 23  0  0  0  0] ; OP1: AR DR SR RR SL TL KS ML DT SSG
  [31  6  0  4  3 19  0  0  0  0] ; OP2
  [31 15  0  5  4 38  0  4  0  0] ; OP3
  [31 27  0 11  1  0  0  1  0  0] ; OP4
)

(def rise-env :psg [0 3 6 9 12 15])

(def lookup-table [0 32 64 96 128])  ; no tag = generic data
```

Tag semantics:

- `:fm` — YM2612 FM patch. Compiler expands to a `PARAM_SET` sequence at
  voice-load time. Vector layout: `[ALG FB]` then four `[AR DR SR RR SL TL KS ML DT SSG]`
  rows for OP1–OP4 in order.
- `:psg` — PSG volume envelope sequence. Compiler emits as a volume-step
  sequence targeted at the assigned PSG channel. `:psg` = volume contour;
  pitch is still track-owned.
- No tag — compile-time constant binding. No IR emitted for the `def` itself.

No `:table` tag. Tagless vectors are already generic and can be displayed
as a pd-array-style bar chart in the editor.

### 1.3 Same-channel track behavior

| Combination                         | Behavior                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| `:bgm` + `:bgm` on same `:ch`       | Compiler diagnostic (error or warning — severity TBD)          |
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

---

## 2. Open Questions

### 2.1 Marker-based playback

`Cmd+Enter` should ideally play from the nearest preceding marker to the
cursor position. Questions:

- How is the "active marker" determined — cursor line vs. playhead position?
- If no preceding marker exists, play from the top?
- Does `Cmd+Enter` during playing jump to the nearest marker and continue,
  or does it pause?

### 2.2 def with phrase / track block reference

Pattern A (currently supported via `defn`):

```lisp
(defn riff [] (note :c4 1/8) (note :e4 1/8))
(track :t1 (phrase (riff)))
```

Pattern B (not defined in v0.1 — needs v0.2 spec):

```lisp
(def riff (phrase :len 1/8 (note :c4) (note :e4)))
(track :t1 riff)
(track :t2 riff :ch fm2)  ; same phrase, different channel override?
```

Pattern B raises questions about option override semantics when referencing
a named phrase block.

### 2.3 PSG envelope loop and sustain point

ctrmml uses `|` for loop point and `/` for sustain within PSG envelope
sequences. GMLisp equivalent is undefined:

```lisp
; ctrmml: @13 psg  15 14 / 13>0:7
; GMLisp equivalent?
(def fade-env :psg [15 14 :sustain 13 12 11 10 5 0])  ; keyword sentinel?
```

### 2.4 modulator reset-on-note

When the `:bgm` track fires a `NOTE_ON`, should the `:modulator` track's
playhead reset to its beginning?

- Without reset (`carry` in ctrmml): modulator continues through note changes
- With reset: modulator envelope restarts on every note

Proposed: `:reset-on-note true/false` track option (default TBD).

### 2.5 FM patch vector — column order confirmation

The column order `[AR DR SR RR SL TL KS ML DT SSG]` per operator follows
ctrmml convention. Needs validation against YM2612 register layout and
confirmation that DT2 (second detune) is out of scope for v0.2.

### 2.6 Compiler diagnostic severity for same-ch bgm collision

Should two `:bgm` tracks on the same `:ch` be:

- a hard compiler error (reject IR generation)?
- a warning (emit IR, flag for developer)?

### 2.7 PWA UI layout

Proposed top bar: `File ▾ | Examples ▾ | [● Bar:Beat BPM] | [⌘↵ Play/Pause] [⌘. Stop] | Help ▾`

- FM parameter panel as slide-in drawer (not always visible)
- CodeMirror `lineNumbers()` extension
- Remove decorative panel borders/titles from current layout

---

## 3. Out of Scope for v0.2

- Full macro language parity with MML ecosystems
- PCM/WAV sample instruments
- Patch server / community infrastructure (see roadmap Future Vision)
- Contextual note editor (keyboard/envelope UI triggered by note selection)
