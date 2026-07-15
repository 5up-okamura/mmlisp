# MMLisp IR Reference (v0.5)

Describes the IR emitted by the current compiler (v0.5 lineage). The MMB
binary encoding is specified in docs/mmb.md / docs/opcodes.md.

Ground truth: `live/src/mmlisp2ir.js` (producer) and `live/src/ir-player.js`
(consumer). Where the two disagree, a **Notes** line calls it out — these
asymmetries matter for the Z80 driver.

## 1. Compiler output

`compileMMLisp(src, filename)` returns:

```json
{ "ir": { ... }, "diagnostics": [ ... ], "sourceMap": [ {"line": 12, "tick": 96}, ... ] }
```

| Field         | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `ir`          | The song object (below). All object keys recursively sorted (`sortObject`).  |
| `diagnostics` | `{ severity, code, message, line, column, track }` — not part of the IR.     |
| `sourceMap`   | Sorted `{ line, tick }` pairs (earliest tick per source line). Sits **beside** the IR, not inside it. |

## 2. Song object

```json
{
  "version": 1,
  "ppqn": 96,
  "metadata": {
    "title": "...", "author": "...", "source": "song.mmlisp",
    "vals": [ ... ], "samples": [ ... ]
  },
  "tracks": [ ... ]
}
```

| Field      | Type   | Semantics                                                            |
| ---------- | ------ | -------------------------------------------------------------------- |
| `version`  | int    | Always `1`.                                                          |
| `ppqn`     | int    | Always `96` ticks per quarter (384/whole; LCM of MMLisp fractions and mucom's 128/whole grid). |
| `metadata` | object | See below.                                                           |
| `tracks`   | array  | Track objects in score order (see §3).                               |

There is **no top-level tempo field.** The initial tempo travels as a
`TEMPO_SET` event at tick 0, emitted by the track that carries the leading
`:tempo` (the player scans all tracks for a tick-0 `TEMPO_SET` and falls back
to 120 BPM); `:lfo-rate` likewise emits a `PARAM_SET LFO_RATE` on its own
track. The presence of any `fm3-1..fm3-4` track prepends a tick-0
`FM3_MODE { mode: "op" }` into `tracks[0]` — the only compiler-injected init
event.

### 2.1 `metadata.vals[]` — dynamic value slots (`def-val`)

One entry per `(def-val name …)`, in declaration order:

| Field      | Type              | Semantics                                                       |
| ---------- | ----------------- | ---------------------------------------------------------------- |
| `name`     | string            | Slot name; scores reference it as `$name`.                       |
| `slot`     | int               | Declaration index (stable slot id for the binary encoding).      |
| `init`     | int               | Initial value; the player seeds its runtime slot table from it.  |
| `min`, `max` | int             | Control bounds (slider range).                                   |
| `step`     | int ≥ 1           | Control granularity.                                             |
| `reversed` | bool              | True when declared `:from > :to` (slider direction).             |
| `unit`     | `"frame"`\|`"tick"` | Time unit when the slot feeds a dynamic `:len`/`:step`.        |

Notes: the player consumes only `name`, `init`, `unit`; `slot`/`min`/`max`/
`step`/`reversed` are for the host UI (Dynamic Parameters panel).

### 2.2 `metadata.samples[]` — PCM sample defs (`def name :sample …`)

| Field          | Type        | Semantics                                          |
| -------------- | ----------- | --------------------------------------------------- |
| `name`         | string      | Symbol referenced by `PCM_NOTE_ON.sample`.          |
| `file`         | string      | As written in the source.                           |
| `resolvedFile` | string      | `file` resolved against the source file's directory.|
| `rate`         | int\|null   | Source sample rate; also copied per-note as `baseRate`. |
| `loopStart`, `loopEnd` | int\|null | Loop points in frames.                      |
| `bitDepth`     | int\|null   | Declared bit depth.                                 |
| `volume`, `compress`, `reverb` | string\|null | Raw option strings (host-side processing). |

## 3. Track object

```json
{
  "id": 0,
  "scoreChannel": "fm3-1",
  "channel": "fm3",
  "events": [ ... ]
}
```

| Field          | Type   | Semantics                                                                |
| -------------- | ------ | ------------------------------------------------------------------------ |
| `id`           | int    | Index into `tracks` (re-numbered after layer flattening).                 |
| `scoreChannel` | string | Original channel head (`fm3-1`, `pcm2`, …) — preserved for UI labeling; also the label used in track diagnostics. |
| `channel`      | string | Physical channel name. FM3 variants (`fm3-1..4`, `fm3-csm`, `fm3-csm-rate`) collapse to `fm3`. |
| `events`       | array  | Time-ordered event list (see §4).                                        |
| `bars`         | array  | Optional. Bar markers (`|`) for the editor: `{ordinal, tick, line, column}` per marker. Inspection metadata only — no playback effect; absent when the track has no `|`. |

Tracks have no `name` field; the player routes purely by `channel`.

### 3.1 Channel names and player routing

The JSON IR addresses channels **by name**; the player maps names to hardware
indices at load:

| `channel`            | Route                                    | Index                    |
| -------------------- | ---------------------------------------- | ------------------------ |
| `fm1` … `fm6`        | YM2612 FM (`CH_NAME_TO_INDEX`)           | 0–5                      |
| `sqr1` `sqr2` `sqr3` | SN76489 tone (`PSG_CH_NAME_TO_INDEX`)    | PSG 0–2                  |
| `noise`              | SN76489 noise                            | PSG 3                    |
| `pcm1` … `pcm3`      | Software PCM worklet, keyed by track id  | (FM index fallback only) |

Unknown names fall back to `min(trackIndex, 5)` on the FM side. The numeric
channel ids 0–5 / 6–9 / 16–18 / 20–22 exist only in the legacy MMB decoder at
the top of `ir-player.js` (scheduled for deletion); the binary channel-id
registry is (re)defined in docs/mmb.md.

## 4. Event encoding

Every event is:

```json
{ "tick": 192, "cmd": "NOTE_ON", "args": { ... }, "src": { "line": 9, "column": 14, "endLine": 9, "endColumn": 16 } }
```

| Field  | Semantics                                                                       |
| ------ | -------------------------------------------------------------------------------- |
| `tick` | Absolute PPQN-96 tick from track start. Non-decreasing within a track.            |
| `cmd`  | Command name (catalog in §5).                                                     |
| `args` | Command-specific payload. Always an object (possibly `{}`).                       |
| `src`  | 1-based source span of the emitting token (`endColumn` is one past the end). Debug/editor aid only — drop it for MMB. |

## 5. Event catalog

Every command the compiler can emit. `req` = required.

### 5.1 NOTE_ON

FM / PSG note. Also used (with extra fields) on FM3 operator tracks.

| Arg          | Type       | Unit    | Req | Semantics                                                                    |
| ------------ | ---------- | ------- | --- | ----------------------------------------------------------------------------- |
| `pitch`      | string     | —       | yes | Note + octave, e.g. `"c4"`, `"f+3"`, `"b-5"`.                                  |
| `length`     | int        | ticks   | yes | Timeline advance. `0` = hold note (key-off only via runtime `triggerKeyOff`).  |
| `gate`       | int        | ticks   | no  | Sounding span. **Present only when `gate < length`**; absent ⇒ gate = length. `0` = hold. |
| `vel`        | int        | 0–15    | no  | Velocity. **Omitted when 15** (the default).                                   |
| `pitchMacro` | spec (§6)  | cents   | no  | `NOTE_PITCH` macro — cent offset around the note's own pitch. `:pitch+` sets `add: true` on the spec: the player/driver composes each sample with the channel's live pitch offset (from inline `:pitch`) instead of overwriting it. |
| `velMacro`   | spec (§6)  | 0–15    | no  | `VEL` macro — absolute velocity envelope. `:vel*`/`:vel+` are pre-combined with the note's `vel` at compile time (no `op` field survives). Values may be float after scaling. |
| `note_semi`  | spec (§6)  | ±48 semi| no  | `NOTE_SEMI` macro (×100 to cents at playback). `:semi+` sets `add: true` (same additive composition as `pitchMacro`). |
| `keyon`      | spec (§6)  | 0/1     | no  | Retrigger gate: sampled per `:step`; value ≥ 0.5 fires key-off→key-on.         |
| `pan`        | spec (§6)  | −1/0/+1 | no  | `PAN` macro.                                                                   |
| `noise_mode` | spec (§6)  | 0–7     | no  | `NOISE_MODE` macro (noise channel notes only).                                 |
| `fm_tl1` … `fm_amen4` | spec (§6) | per target | no | FM operator-param macros: any supported target lower-cased (`FM_TL1` → `fm_tl1`). |
| `vol`, `master`, `lfo_rate`, `fm_alg`, `fm_fb`, `fm_ams`, `fm_fms` | spec (§6) | per target | no | Emittable (targets are macro-legal in the compiler) but **ignored by the player** — see §11. |
| `fm3Op`      | int 1–4    | —       | no  | FM3 operator-track notes only: which operator this note keys.                  |
| `opMask`     | int        | bitmask | no  | 0x28 key nibble; `0x10 << (fm3Op-1)`. Emitted together with `fm3Op`.           |

```json
{ "tick": 0, "cmd": "NOTE_ON", "args": { "pitch": "c4", "length": 48, "gate": 36, "vel": 12,
  "velMacro": { "type": "steps", "steps": [12, 9, 6], "loopIndex": null, "releaseIndex": null } } }
```

Notes:
- The transient `_delay` stamp (`{ ticks, vels }`) used by the compile-time
  delay expansion is **always stripped** before the IR is returned; echoes
  appear as ordinary extra `NOTE_ON` events.
- Player key-off: written at the gate boundary. When the gate fills the note
  and the next note starts immediately, the key-off is suppressed (legato
  slur). Macro schedules are hard-limited to 5 ms (`KEY_OFF_LEAD_SECS`)
  before the next `NOTE_ON` on the channel (monophonic priority).
- `keyon` retrigger is honored on plain FM notes only — ignored on FM3
  operator notes and on PSG.

### 5.2 REST

| Arg      | Type | Unit  | Req | Semantics                       |
| -------- | ---- | ----- | --- | -------------------------------- |
| `length` | int  | ticks | yes | Silent gap. Player no-op (spacing already baked into ticks). |

```json
{ "tick": 48, "cmd": "REST", "args": { "length": 48 } }
```

### 5.3 TIE

| Arg      | Type | Unit  | Req | Semantics |
| -------- | ---- | ----- | --- | ---------- |
| `length` | int  | ticks | yes | Extends the preceding note. The player resolves ties at `NOTE_ON` dispatch by scanning forward for `TIE` events landing exactly at the note's current end tick (chains accumulate). |

```json
{ "tick": 96, "cmd": "TIE", "args": { "length": 48 } }
```

### 5.4 LOOP_BEGIN / LOOP_END / LOOP_BREAK

Counted loop `(x N …)`, and `(go label N)` after `convertCountedJumps`
rewrites the backward `MARKER`+`JUMP{repeat}` pair into the same shape.

| Cmd          | Args                       | Semantics                                                    |
| ------------ | -------------------------- | ------------------------------------------------------------- |
| `LOOP_BEGIN` | `{ id }`                   | `id`: compiler-generated `"_xN"` or the user label.            |
| `LOOP_END`   | `{ id, repeat }`           | `repeat`: int ≥ 1 iteration count.                             |
| `LOOP_BREAK` | `{ id }` (`id` may be null)| Final-pass exit point inside the loop body. `null` only if authored outside any counted loop (then inert). |

```json
{ "tick": 0,  "cmd": "LOOP_BEGIN", "args": { "id": "_x0" } }
{ "tick": 96, "cmd": "LOOP_END",   "args": { "id": "_x0", "repeat": 4 } }
{ "tick": 48, "cmd": "LOOP_BREAK", "args": { "id": "_x0" } }
```

Notes: the player expands loops **structurally at load time**
(`_expandLoops`, nesting depth ≤ 8, missing `repeat` defaults to 2);
`LOOP_BREAK` truncates only the final pass. None of the three survive into
the flattened runtime schedule.

### 5.5 MARKER / JUMP

| Cmd      | Args                       | Semantics                                                                 |
| -------- | -------------------------- | --------------------------------------------------------------------------- |
| `MARKER` | `{ id }`                   | Label from `#name`, or the anchor of an uncounted `(x …)` (`"_xN"`).        |
| `JUMP`   | `{ to }` or `{ to, repeat }` | `to`: marker id. A **backward** `JUMP` without `repeat` is the track's structural loop point. `{ to, repeat }` is transient: converted to `LOOP_BEGIN`/`LOOP_END` when a backward marker exists on the same track; if it survives (forward target), the player ignores the repeat. |

```json
{ "tick": 0,   "cmd": "MARKER", "args": { "id": "loop" } }
{ "tick": 768, "cmd": "JUMP",   "args": { "to": "loop" } }
```

Notes: tracks loop **independently**; the player picks the backward `JUMP`
with the earliest target tick as the loop boundary, trims events after it,
and re-anchors each iteration. Duplicate marker ids and unresolved jump
targets are compile diagnostics (`E_MARKER_DUP`, `E_JUMP_UNRESOLVED`).

### 5.6 PARAM_SET

| Arg      | Type   | Req | Semantics                                              |
| -------- | ------ | --- | ------------------------------------------------------- |
| `target` | string | yes | Canonical target name (§7).                             |
| `value`  | number | yes | Absolute value; rounded + clamped at the register write. `PAN` uses −1/0/+1; `NOISE_MODE` 0–7 (FB bit 2, NF bits 1–0). |

```json
{ "tick": 0, "cmd": "PARAM_SET", "args": { "target": "FM_TL1", "value": 32 } }
```

Notes: voice defs (`(def name :alg …)` etc.) compile to a burst of same-tick
`PARAM_SET`s in a fixed key order (ALG, FB, AMS, FMS, then op1–4 ×
AR,DR,SR,RR,SL,TL,KS,ML,DT,SSG,AMEN). `param-set` with an unsupported target
emits a diagnostic **but still emits the event**; the player's default case
drops unknown targets silently.

### 5.7 PARAM_ADD / PARAM_MUL

Runtime read-modify-write against the player's shadow register file.

| Arg      | Type                    | Req | Semantics                                          |
| -------- | ----------------------- | --- | --------------------------------------------------- |
| `target` | string                  | yes | Canonical target (§7).                              |
| `delta`  | number \| `{ "src": s }`| yes (`PARAM_ADD`) | Added to the current shadow value.    |
| `factor` | number \| `{ "src": s }`| yes (`PARAM_MUL`) | Multiplies the current shadow value.  |

`src` is `"$time"` (elapsed 60 Hz frames since play start) or a `def-val`
slot name, resolved at dispatch time.

```json
{ "tick": 96, "cmd": "PARAM_ADD", "args": { "target": "FM_TL1", "delta": 5 } }
{ "tick": 96, "cmd": "PARAM_MUL", "args": { "target": "FM_TL1", "factor": { "src": "depth" } } }
```

Notes: the readable shadow set is `FM_*` op/channel params (TL reads the
*voiced* timbre TL, so relative TL composes under vel/vol attenuation),
`VOL`, `PAN`. Anything else reads 0.

### 5.8 PARAM_FROM_VAL

| Arg      | Type   | Req | Semantics                                             |
| -------- | ------ | --- | ------------------------------------------------------ |
| `target` | string | yes | Canonical target (§7).                                 |
| `src`    | string | yes | `"$time"` or slot name; resolved at dispatch, then applied as a `PARAM_SET`. Missing slots read 0. |

```json
{ "tick": 0, "cmd": "PARAM_FROM_VAL", "args": { "target": "FM_TL1", "src": "bright" } }
```

### 5.9 PARAM_SWEEP

Channel-level curve automation (inline `:target (curve …)`, `:vol`/`:master`
curves, and glide portamento). Args = `target` + the curve-spec fields (§6.2):

| Arg          | Type    | Unit  | Req | Semantics                                                        |
| ------------ | ------- | ----- | --- | ----------------------------------------------------------------- |
| `target`     | string  | —     | yes | Canonical target (§7).                                            |
| `curve`      | string  | —     | yes | Curve name (§6.4). `const` is pre-lowered to `linear` with `from == to`. |
| `from`       | number  | target| no  | Start value. Absent ⇒ player uses 0.                              |
| `to`         | number  | target| yes | End value (0 if unspecified).                                     |
| `frames`     | int     | ticks | no  | Sweep length. **In ticks** despite the name (the player converts ticks → 60 Hz frames at dispatch). |
| `lenFrames`  | bool    | —     | no  | True when `:len` was written as `Nf` (absolute frames). **Ignored on PARAM_SWEEP by the player** — see §11. |
| `loop`       | bool    | —     | yes | True for loop waveforms (`sin`/`triangle`/`square`/`saw`/`ramp`/`noise`/`pink`/`perlin`/`brown`) or an explicit `:loop` flag. |
| `waitTicks` / `waitKeyOff` | int / bool | ticks | no | Pre-delay before the curve. **Ignored on PARAM_SWEEP** (macro-only) — see §11. |
| `params`     | object  | —     | no  | Curve shape params (§6.4).                                        |
| `dyn`        | object  | —     | no  | `{ from?, to?, rate?, len? }` slot refs; `from`/`to`/`rate` resolved at sweep start. `len` is **not** resolved on PARAM_SWEEP — see §11. |
| `bounded`    | bool    | —     | no  | Glide only: the sweep lasts exactly `frames` then stops (never extended to the next automation event). |

```json
{ "tick": 0, "cmd": "PARAM_SWEEP", "args": { "target": "NOTE_PITCH", "curve": "linear",
  "from": -200, "to": 0, "frames": 12, "loop": false, "bounded": true } }
```

Notes: the player samples the curve at 60 Hz. A non-`bounded` sweep runs until
the next `PARAM_SET`/`PARAM_SWEEP`/`PARAM_SWEEP_STOP` on the same target, else
one structural-loop duration (loop waveforms are kept alive ~16 loop
iterations so LFO-style sweeps persist). `NOTE_PITCH` sweeps track upcoming
`NOTE_ON` base pitches per frame; `VOL` sweeps keep persistent state so
note-ons sample the instantaneous volume.

### 5.10 PARAM_SWEEP_STOP

| Arg      | Type   | Req | Semantics                                                        |
| -------- | ------ | --- | ----------------------------------------------------------------- |
| `target` | string | yes | Freezes a running inline sweep at its current value (`:target none`). |

```json
{ "tick": 192, "cmd": "PARAM_SWEEP_STOP", "args": { "target": "VOL" } }
```

### 5.11 TEMPO_SET

| Arg   | Type   | Req | Semantics                                  |
| ----- | ------ | --- | ------------------------------------------- |
| `bpm` | number | yes | New tempo (quarter notes per minute). Global — dispatched from any track, applies to the whole song. |

```json
{ "tick": 0, "cmd": "TEMPO_SET", "args": { "bpm": 140 } }
```

Notes: cancels any running tempo sweep and **re-anchors** every track's
tick→time mapping so the change tick keeps its audio time (ticks before/after
stay continuous).

### 5.12 TEMPO_SWEEP

| Arg      | Type   | Unit  | Req | Semantics                              |
| -------- | ------ | ----- | --- | --------------------------------------- |
| `from`   | number | BPM   | yes | Start tempo (compiler fills the current tempo when omitted in source). |
| `to`     | number | BPM   | yes | End tempo.                              |
| `len`    | int    | ticks | yes | Sweep length. Note: `len`, not `frames`. |
| `curve`  | string | —     | yes | Curve name (§6.4).                      |
| `params` | object | —     | no  | Curve shape params.                     |

```json
{ "tick": 384, "cmd": "TEMPO_SWEEP", "args": { "from": 120, "to": 90, "len": 384, "curve": "ease-out" } }
```

Notes: interpolated continuously — the player re-evaluates BPM each scheduler
pass (~25 ms) and re-anchors the clock each step; on completion it pins `to`.

### 5.13 CSM_ON / CSM_OFF

No args (`{}`). Emitted on `fm3-csm` tracks: `CSM_ON` once before the first
note, `CSM_OFF` at the end of the track body. Sets/clears YM2612 reg 0x27 bit
7 (CSM mode).

```json
{ "tick": 0, "cmd": "CSM_ON", "args": {} }
```

### 5.14 CSM_RATE

Timer A rate for CSM. Two forms:

Constant:

| Arg  | Type   | Unit | Req | Semantics                        |
| ---- | ------ | ---- | --- | --------------------------------- |
| `hz` | number | Hz   | yes | Clamped to 52–53270 Hz at compile. |

Swept (inline `:csm-rate (curve …)` or `fm3-csm-rate` glide):

| Arg      | Type   | Unit  | Req | Semantics                       |
| -------- | ------ | ----- | --- | -------------------------------- |
| `from`   | number | Hz    | yes | Clamped 52–53270.                |
| `to`     | number | Hz    | yes | Clamped 52–53270.                |
| `len`    | int    | ticks | yes | Sweep length (`len`, not `frames`). |
| `curve`  | string | —     | yes | Curve name.                      |
| `params` | object | —     | no  | Curve shape params.              |

```json
{ "tick": 0,  "cmd": "CSM_RATE", "args": { "hz": 220 } }
{ "tick": 96, "cmd": "CSM_RATE", "args": { "from": 220, "to": 440, "len": 48, "curve": "linear" } }
```

Notes: the player converts Hz → Timer A value
(`TA = 1024 − clock/(144·hz)`) and, for the swept form, writes per 60 Hz
frame over `len` ticks.

### 5.15 FM3_MODE

| Arg    | Type   | Req | Semantics                                                       |
| ------ | ------ | --- | ---------------------------------------------------------------- |
| `mode` | string | yes | Only `"op"` is ever emitted (tick 0, `tracks[0]`, when fm3-1..4 tracks exist). Sets reg 0x27 bit 6 and seeds all four operator F-numbers. |

```json
{ "tick": 0, "cmd": "FM3_MODE", "args": { "mode": "op" } }
```

### 5.16 FM3_OP_PITCH

| Arg     | Type    | Req | Semantics                                                       |
| ------- | ------- | --- | ---------------------------------------------------------------- |
| `op`    | int 1–4 | yes | Operator whose F-number register to write (op1→A9/AD, op2→AA/AE, op3→A8/AC, op4→channel base A6/A2). |
| `pitch` | string  | yes | Note + octave.                                                   |

Emitted immediately before each `NOTE_ON` on an `fm3-N` track (same tick).

```json
{ "tick": 0, "cmd": "FM3_OP_PITCH", "args": { "op": 2, "pitch": "e5" } }
```

### 5.17 PCM_NOTE_ON

| Arg        | Type   | Unit    | Req | Semantics                                                       |
| ---------- | ------ | ------- | --- | ----------------------------------------------------------------|
| `sample`   | string | —       | yes | Name of a `metadata.samples` entry.                              |
| `pitch`    | string | —       | yes | Note + octave (informational; clamped C2–C6 at compile).         |
| `rate`     | number | ratio   | yes | Playback rate = `2^((midi−60)/12)` (1.0 at C4).                  |
| `length`   | int    | ticks   | yes | Timeline advance.                                                |
| `mode`     | string | —       | yes | `"shot"` or `"loop"`.                                            |
| `baseRate` | int    | Hz      | no  | Sample's source rate (from the sample def), when known.          |
| `vel`      | int    | 0–15    | no  | Omitted when 15.                                                 |
| `gate`     | int    | ticks   | no  | Present only when `< length`.                                    |

```json
{ "tick": 0, "cmd": "PCM_NOTE_ON", "args": { "sample": "kick", "pitch": "c4", "rate": 1,
  "length": 48, "mode": "shot", "baseRate": 13000 } }
```

Notes: the player forwards only `sample`/`rate`/`baseRate`/`vel`/`mode` to the
PCM worklet — `pitch`, `length`, and `gate` are not sent. Shot samples play to
completion regardless of gate; loop samples stop only at `PCM_NOTE_OFF`.

### 5.18 PCM_NOTE_OFF

| Arg      | Type   | Req | Semantics                                              |
| -------- | ------ | --- | ------------------------------------------------------- |
| `sample` | string | yes | Sample to stop.                                          |
| `mode`   | string | yes | `"loop"` (only emitted for loop-mode notes with gate > 0, at `tick + gate`). |

```json
{ "tick": 36, "cmd": "PCM_NOTE_OFF", "args": { "sample": "pad", "mode": "loop" } }
```

There is no `NOISE_MODE` command: PSG noise mode is a `PARAM_SET` target
(the compiler auto-emits `PARAM_SET NOISE_MODE 4` = white0 at tick 0 on the
noise track, and inline `:mode` emits further `PARAM_SET NOISE_MODE`). It is
persistent player state re-asserted on every noise `NOTE_ON`; the
`NOTE_ON`-embedded `noise_mode` macro layers a temporary per-note override.

## 6. Macro spec shapes

`NOTE_ON` embeds one spec object per active macro target. The same grammar
serves every target; values are clamped to the target's range (§7) at compile
time (relative `:vel+`/`:vel*` specs are combined with the note velocity and
re-clamped before emission).

All spec kinds may carry:

| Field  | Type                                   | Semantics                                                       |
| ------ | -------------------------------------- | ---------------------------------------------------------------- |
| `type` | `"steps"` \| `"curve"` \| `"stages"`   | Discriminator.                                                    |
| `step` | `{ "unit": "frame"\|"tick", "value": n }` | Per-macro sampling clock (`:step`). Absent ⇒ 1 frame = 60 Hz. For step vectors: time per step. For curves/stages: sample-and-hold interval. |
| `scale` | string | **Scaled macro** (`(* <signal> $slot)`, language.md §7). A value-slot name (no `$`, or `"$time"`). The player/driver reads the slot **live every frame** and writes `(sample × (slot & 0xFF)) >> 8` (0..255 depth, magnitude multiply, re-signed toward zero). Applies to any target, before the target write. MMB → MACRO_TABLE flags bit2 + an appended slot byte (mmb.md §15). |

### 6.1 Step vector — `type: "steps"`

```json
{ "type": "steps", "steps": [15, null, 13, 11, 9], "loopIndex": 1, "releaseIndex": 3,
  "src": { "line": 3, "column": 20, "endLine": 3, "endColumn": 44 } }
```

| Field          | Type            | Semantics                                                              |
| -------------- | --------------- | ------------------------------------------------------------------------ |
| `steps`        | (number\|null)[] | One value per step; `null` = hold (advance one step, no write). Floats allowed (post-scaling). |
| `loopIndex`    | int\|null       | `:hold` position — sustain loops back here until gate. `null` = one-shot (hold last value). |
| `releaseIndex` | int\|null       | `:off` position — steps from here play after key-off, spaced by `step`.  |
| `src`          | object          | Source span of the `[...]` literal (playhead highlight). Scalar-constant sugar (`:keyon 1`) emits `steps:[v], loopIndex:0` without `src`. |

Playback: attack runs from index 0; the sustain section (up to
`releaseIndex`, or the whole vector) advances one step per `step` interval,
looping from `loopIndex` until the gate boundary; release steps then run from
the gate boundary. `NOISE_MODE` step vectors accept mode symbols at compile
time (`white0–3` → 4–7, `periodic0–3` → 0–3); `PAN` accepts
`left`/`center`/`right` → −1/0/+1.

### 6.2 Curve — `type: "curve"`

```json
{ "type": "curve", "curve": "ease-out", "from": 15, "to": 0, "frames": 96,
  "loop": false, "params": { "rate": 2 }, "dyn": { "to": "depth" } }
```

The curve-spec fields (shared verbatim with `PARAM_SWEEP` args §5.9):

| Field        | Type    | Semantics                                                                       |
| ------------ | ------- | --------------------------------------------------------------------------------|
| `curve`      | string  | Curve name (§6.4).                                                               |
| `from`       | number  | Start value (optional; player defaults 0). `const v` lowers to `linear` with `from == to == v`. |
| `to`         | number  | End value (always present; 0 default).                                           |
| `frames`     | number  | `:len`. Ticks by default; absolute 60 Hz frames when `lenFrames` is true (`Nf`); placeholder `1` when `dyn.len` is set. |
| `lenFrames`  | bool    | Present (true) only for `Nf` lengths.                                            |
| `loop`       | bool    | Loop waveforms and `:loop`-flagged easings cycle until gate; non-loop curves clamp at phase 1 and hold. |
| `waitTicks`  | int     | Pre-delay in ticks before the curve starts (`:wait N`).                          |
| `waitKeyOff` | bool    | Start at the key-off boundary (`:wait key-off`) — e.g. release envelopes.        |
| `params`     | object  | Shape params (§6.4). Only emitted when non-empty.                                |
| `dyn`        | object  | `{ from?, to?, rate?, len? }` — slot names (no `$`). The player resolves them **once per note at note-on**; `len` is interpreted by the slot's `unit` (`frame` as-is, `tick` × tempo). Static placeholders (`from:0`, `to:0`, `rate:1`, `frames:1`) hold the field shape. |

### 6.3 Multi-stage — `type: "stages"`

An ordered stage list; the time cursor advances through it. Each entry is
either a curve spec (§6.2 fields, no `type`) or a wait:

```json
{ "type": "stages", "stages": [
  { "curve": "linear", "from": 0, "to": 300, "frames": 12, "loop": false },
  { "waitTicks": 24 },
  { "waitKeyOff": true },
  { "curve": "sin", "from": -50, "to": 50, "frames": 8, "loop": true }
] }
```

| Stage field   | Semantics                                                                    |
| ------------- | ------------------------------------------------------------------------------|
| `waitKeyOff: true` | Snap the cursor to the gate boundary.                                     |
| `waitTicks: N`     | Advance the cursor N ticks (tempo-scaled).                                 |
| `waitFrames: N`    | Advance the cursor N 60 Hz frames (wall-clock). Emitted for `(wait Nf)`.   |
| curve stage        | Plays for its `frames`; a `loop: true` stage cycles until the gate.       |

A `:wait` **inside** a curve stage acts as that stage's pre-delay.

### 6.4 Curve names and `params`

Easings (non-loop): `linear`, `ease-in`, `ease-out`, `ease-inout`, and the
`ease-{in,out,inout}-{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}`
family. Loop waveforms: `sin`, `triangle`, `square`, `saw`, `ramp`. Stochastic
(fixed-seed LUTs — deterministic): `noise`, `pink`, `perlin`, `brown`.
`const` is compile-time sugar (never appears in IR).

`params` keys (all optional, numeric; clamped with warnings at compile):

| Key       | Range        | Applies to        | Semantics                          |
| --------- | ------------ | ----------------- | ----------------------------------- |
| `phase`   | 0–255        | all               | Phase offset (/256 of a cycle).     |
| `rate`    | > 0          | all               | Phase multiplier (cycles per `len`).|
| `duty`    | 1–255        | `square`          | Duty threshold (/256).              |
| `skew`    | −127–127     | `sin` `triangle` `saw` `ramp` | Waveform skew.          |
| `hold`    | ≥ 1          | stochastic        | Sample-and-hold frames in the LUT.  |
| `jitter`  | 0–1          | stochastic        | White-noise mix-in.                 |
| `beta`    | > 0          | `pink`            | Spectral slope blend.               |
| `octaves` | 1–8          | `perlin`          | fBm octaves.                        |
| `lacunarity`, `persistence` | > 0 | `perlin`   | fBm frequency/amplitude ratios.     |
| `leak`    | 0–0.9999     | `brown`           | Integrator leak.                    |

## 7. Target name registry

Every `PARAM_SET` / `PARAM_ADD` / `PARAM_MUL` / `PARAM_FROM_VAL` /
`PARAM_SWEEP` `target` string the compiler emits, with the value range the
pipeline clamps to (`clampForTarget`; numeric-suffixed targets fall back to
the suffix-stripped key) and the register family the player maps it to.
Values stay float through the pipeline and are quantized once at the register
write.

| Target            | Range          | Chip mapping                                               |
| ----------------- | -------------- | ----------------------------------------------------------- |
| `NOTE_PITCH`      | −32768–32767 cents | Re-applied through F-number (A4/A0, or FM3 op registers) or PSG tone period. |
| `NOTE_SEMI`       | −48–48         | Semitone offset ×100 cents on the pitch path. **Macro-only** — rejected as a `param-set`/inline PARAM target (`E_UNSUPPORTED_TARGET`). |
| `KEYON`           | 0–1            | Retrigger gate (reg 0x28 key pulses). **Macro-only** — rejected as a PARAM target. |
| `VEL`             | 0–15           | Velocity ladder (2 dB/step) folded into carrier TL / PSG att. **Macro / `:vel` note-scoped only** — rejected as a PARAM target. |
| `VOL`             | 0–31           | Channel fader → carrier TL offset (FM) / attenuator (PSG). 0 = hard mute. |
| `MASTER`          | 0–31           | Global fader → all FM carrier TLs + all sounding PSG channels. |
| `LFO_RATE`        | 0–8            | Reg 0x22 (0 = off, 1–8 = `0x08 \| rate−1`). Global.          |
| `FM_ALG`          | 0–7            | B0 bits 2–0.                                                 |
| `FM_FB`           | 0–7            | B0 bits 5–3.                                                 |
| `FM_AMS`          | 0–3            | B4 bits 5–4.                                                 |
| `FM_FMS`          | 0–7            | B4 bits 2–0.                                                 |
| `PAN`             | −1–1           | B4 bits 7–6 (−1 = L `10`, 0 = LR `11`, +1 = R `01`); snapped to the tri-state lane. |
| `NOISE_MODE`      | 0–7            | SN76489 noise control (FB bit + NF bits). Persistent noise-channel state via `PARAM_SET` (inline `:mode` / tick-0 default), re-asserted on each `NOTE_ON`; the NOTE_ON macro is a temporary override. |
| `FM_TL1`–`FM_TL4` | 0–127          | 0x40+op. PARAM_SET also updates the voiced (timbre) TL base. |
| `FM_AR1`–`FM_AR4` | 0–31           | 0x50+op bits 4–0 (shared byte with KS).                      |
| `FM_DR1`–`FM_DR4` | 0–31           | 0x60+op bits 4–0 (shared byte with AMEN).                    |
| `FM_SR1`–`FM_SR4` | 0–31           | 0x70+op.                                                     |
| `FM_RR1`–`FM_RR4` | 0–15           | 0x80+op bits 3–0 (shared byte with SL).                      |
| `FM_SL1`–`FM_SL4` | 0–15           | 0x80+op bits 7–4.                                            |
| `FM_ML1`–`FM_ML4` | 0–15           | 0x30+op bits 3–0 (shared byte with DT).                      |
| `FM_DT1`–`FM_DT4` | 0–7            | 0x30+op bits 6–4.                                            |
| `FM_KS1`–`FM_KS4` | 0–3            | 0x50+op bits 7–6.                                            |
| `FM_SSG1`–`FM_SSG4` | 0–15         | 0x90+op. Emitted by voice defs only (no `:ssg` inline keyword resolves — see §11). |
| `FM_AMEN1`–`FM_AMEN4` | 0–1        | 0x60+op bit 7.                                               |

CSM rate is not a PARAM target (own `CSM_RATE` command; 52–53270 Hz).
`canonicalTarget` also knows `:tempo-scale` → `TEMPO_SCALE`, but it is not in
`SUPPORTED_TARGETS` and is never emitted. On PSG-routed tracks only `VOL` and
`NOTE_PITCH` PARAM events are honored.

## 8. Normalization invariants

- **Ticks are non-decreasing per track.** Events are emitted in timeline
  order; the post-passes (delay expansion, priority-layer flattening) re-sort
  by tick with JS's stable sort, so **same-tick events keep their emission
  (source) order**. The player relies on this (equal-time register writes
  apply in insertion order, last wins).
- **Determinism: same source → byte-identical IR.** No randomness (stochastic
  curves are playback-side fixed-seed LUTs), no timestamps, and `sortObject`
  alphabetizes every object key recursively before return. Generated loop ids
  (`_x0`, `_x1`, …) come from a single per-compile counter in score order.
- **Marker/loop id resolution.** Loop ids pair `LOOP_BEGIN`/`LOOP_END`;
  `LOOP_BREAK` binds to the innermost counted loop (a break authored under a
  `#label…(go label N)` loop gets its id assigned when `convertCountedJumps`
  rewrites the pair — that pass runs on the *merged* track, so label and jump
  may come from different source forms). `JUMP.to` must resolve to a `MARKER`
  on the same track (validated; forward or backward).
- **Post-passes** (in order): per-layer delay expansion → `:prio` layer
  flattening (note drop/truncate under higher-priority layers) → track
  re-numbering → counted-jump conversion → validation → tick-0 `FM3_MODE`
  unshifted into `tracks[0]` (when fm3-1..4 tracks exist).
- Transient fields (`_delay`) are stripped; `src` spans are the only
  non-semantic payload that remains.

## 9. Playback semantics notes

- **gate vs length.** `length` is pure timeline spacing (the compiler already
  placed the next event); `gate` is the sounding span. The player clamps
  `gate` to `length`, keys off at the gate boundary, and suppresses the
  key-off when the gate fills the note and the next note follows immediately
  (legato slur). Macro schedules use a gate reference 5 ms early
  (`KEY_OFF_LEAD_SECS`) and are cut 5 ms before the next note-on on the same
  channel (monophonic priority).
- **Holds.** `length: 0` or `gate: 0` = hold indefinitely; the channel is
  parked in a hold set until the host calls `triggerKeyOff(ch)` (FM 0–5,
  PSG `psgCh + 6`). Macro budgets use the `HOLD_FRAMES` sentinel.
- **TEMPO_SET re-anchoring.** Tempo changes re-anchor every track's
  tick→audio-time base so the change tick's audio time is preserved — tick
  durations before and after differ, absolute positions never jump.
- **TEMPO_SWEEP** interpolates BPM along the curve over `len` ticks,
  re-evaluated every scheduler pass; a `TEMPO_SET` (or the host `setTempo`)
  cancels it.
- **PARAM_ADD / PARAM_MUL** are read-modify-write against the player's shadow
  register file (never the chip): read the stored value (voiced TL for
  `FM_TL*`), apply the operand (literal or slot ref), write back through the
  normal `PARAM_SET` path (round + clamp at the register write).
- **Dynamic values.** Slots live in a name→value table seeded from
  `metadata.vals[].init` and mutated by the host (`setVal`). `PARAM_FROM_VAL`
  and slot-ref operands resolve at event dispatch; macro `dyn` fields resolve
  once per note at note-on (constant for that note). `$time` = elapsed 60 Hz
  frames since playback start.
- **Loops.** `LOOP_*` are expanded structurally at load; the backward `JUMP`
  defines the per-track structural loop, and tracks loop independently
  (re-anchored each iteration). Events after the backward `JUMP` are trimmed
  from linear playback.
- Macro and sweep sampling is 60 Hz (per `:step` for step vectors /
  sample-and-hold); level moves write one TL byte per carrier operator of the
  current algorithm.

## 10. Minimal example

```json
{
  "version": 1,
  "ppqn": 96,
  "metadata": { "title": "demo", "author": "unknown", "source": "demo.mmlisp", "vals": [], "samples": [] },
  "tracks": [ {
    "id": 0, "scoreChannel": "fm1", "channel": "fm1",
    "events": [
      { "tick": 0,  "cmd": "TEMPO_SET", "args": { "bpm": 120 }, "src": { "line": 1, "column": 2, "endLine": 5, "endColumn": 2 } },
      { "tick": 0,  "cmd": "PARAM_SET", "args": { "target": "FM_ALG", "value": 4 }, "src": { "line": 2, "column": 4, "endLine": 2, "endColumn": 9 } },
      { "tick": 0,  "cmd": "NOTE_ON",   "args": { "pitch": "c4", "length": 48 }, "src": { "line": 3, "column": 4, "endLine": 3, "endColumn": 5 } },
      { "tick": 48, "cmd": "REST",      "args": { "length": 48 }, "src": { "line": 3, "column": 6, "endLine": 3, "endColumn": 7 } }
    ]
  } ]
}
```

## 11. Known compiler/player asymmetries

Fields the compiler emits that the player ignores (or vice versa). These are
the open items to settle for the MMB/Z80 encoding.

1. **`keyon` macro ignored on FM3-op and PSG notes.** The `keyon` NOTE_ON macro
   (retrigger gate) has no scheduler path on FM3 independent-op or PSG channels.
2. **`waitTicks` / `waitKeyOff` / `dyn.len` on inline PARAM_SWEEP.** Honored in
   NOTE_ON macro curves; `_applyParamSweep` starts immediately and ignores a
   pre-delay or dynamic length. (An `Nf` `:len` *is* honored — `lenFrames`
   schedules absolute frames.)
3. **`param-set` emits even on unsupported targets** (diagnostic + event);
   the player drops unknown targets silently.
4. **PCM `pitch`/`length`/`gate`** are emitted but not forwarded to the
   worklet: shot samples play to completion; loop samples stop only at
   `PCM_NOTE_OFF`. Accepted as an M1 limitation (see language.md §16).
