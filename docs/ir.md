# MMLisp IR Reference (v0.7)

Describes the IR emitted by the current compiler (v0.7). The MMB
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
    "title": "...", "composer": "...", "author": "...", "source": "song.mmlisp", "pcmVoices": 2,
    "vals": [ ... ], "samples": [ ... ], "waves": [ ... ]
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
track. The compiler injects two init events: the presence of any
`fm3-1..fm3-4` track prepends a tick-0 `FM3_MODE { mode: "op" }` into
`tracks[0]` (`"csm-op"` when a note-less `fm3-csm` track stands beside them) (and into an effect's first part when the effect has operator
parts), and every noise track starts with a tick-0 `PARAM_SET NOISE_MODE 4`
(`white0`).

The PARAM targets `RANGE_START` / `RANGE_END` / `RANGE_LEN` (written
`:pcm-start` / `:pcm-end` / `:pcm-len`) and `LOOP_START` / `LOOP_END` /
`LOOP_LEN` (written `:loop-start` / `:loop-end` / `:loop-len`) (§5) carry a
point of a PCM note's range or loop in **seconds**, and are the one target
family whose IR value is not
an integer: the MMB exporter multiplies by the engine image's rate to get the
byte offset the driver wants. They are valid on `pcm1`–`pcm3` only.

`metadata.frameHz` is the frame clock the score was compiled for: `60` (NTSC,
the default and the editor's preview) or `50` (PAL, `compileMMLisp`'s
`options.frameHz`). Every `Nf`/`Nms` frame count, macro step and sweep length
in the IR was resolved against it, and the MMB exporter reads it so a score is
never compiled for one standard and baked for the other (driver.md §3.3).

`metadata.target` is the machine the score is for (`(def-score :target …)`,
language.md §19), present only when it is not the Mega Drive: `"pc88"`,
`"x68k"`, `"msx"`. A
consumer reads its chips from its profile (`live/src/targets.js`). The MMB exporter refuses
any target but the Mega Drive, and the IR player one whose chips have no
register encoder yet (`live/src/chips/`).

`metadata.pcmVoices` is how many PCM voices the Mega Drive's driver plays,
0–3, from `(def-score :pcm-voices N)` or the highest `pcmN` track the score
uses; 0 on a target with no DAC soft mix (its chips play their own). It picks the
engine image and with it the DAC rate, so the MMB exporter reads it before it
bakes a single sample (driver.md §5, mmb.md §10).

### 2.1 `metadata.vals[]` — dynamic value slots (`def-val`)

One entry per `(def-val name …)`, in slot order — the `:public` ones first,
each group in declaration order:

| Field      | Type              | Semantics                                                       |
| ---------- | ----------------- | ---------------------------------------------------------------- |
| `name`     | string            | Slot name; scores reference it as `$name`.                       |
| `slot`     | int               | Slot index (the binary's id, and the `VALn` target that writes it). |
| `init`     | int               | Initial value; the player seeds its runtime slot table from it.  |
| `min`, `max` | int             | Control bounds (slider range).                                   |
| `step`     | int ≥ 1           | Control granularity.                                             |
| `reversed` | bool              | True when declared `:from > :to` (slider direction).             |
| `unit`     | `"frame"`\|`"tick"` | Time unit when the slot feeds a dynamic `:len`/`:step`.        |
| `public`   | bool              | Declared `:public`: the host's to write (a slider, an MMB name). |

Notes: the player consumes `name`, `init`, `unit` and `slot`; `min`/`max`/
`step`/`reversed`/`public` are for the host UI (Dynamic Parameters panel).

### 2.2 `metadata.samples[]` — PCM sample defs (`(def-pcm name …)`)

| Field          | Type        | Semantics                                          |
| -------------- | ----------- | --------------------------------------------------- |
| `name`         | string      | Symbol referenced by `PCM_NOTE_ON.sample`.          |
| `file`         | string\|null | As written in the source; null for a `pc88` built-in rhythm sound. |
| `resolvedFile` | string\|null | `file` resolved against the source file's directory.|
| `rhythm`       | string      | On `pc88`, present on the six kit roles (language.md §19): their ROM sound, `bd` `sd` `top` `hh` `tom` `rim`. A `rhythm1`–`rhythm6` note on it plays that sound. |
| `rate`         | int\|null   | Source sample rate; also copied per-note as `baseRate`. |
| `offset`, `frames` | int\|null | Slice of `file` this sample is, in frames (a bank holds several). Null = whole file. |
| `startSec`, `endSec` | number\|null | The range a note plays (`:pcm-start` / `:pcm-end` / `:pcm-len`). In SECONDS of the sample's own recording, resolved from the def's length tokens at the score's opening tempo. Both null: the whole sample; a null end is the sample's end. The exporter turns them into baked bytes per note; the driver rounds them to its 16-byte block. |
| `loopStartSec`, `loopEndSec` | number\|null | The loop a held loop note repeats, inside the range (`:loop-start` / `:loop-end` / `:loop-len`), in the same seconds. A null point follows the range (its start, its end). The compiler has checked `startSec ≤ loopStartSec < loopEndSec ≤ endSec`. |
| `fx`           | array       | The sample's whole chain — its imports' `:fx` (outermost first), then the def's own — resolved: one `{type, …params}` per effect in order, every param filled in (defaults included), times in SECONDS (at the score's opening tempo, like the range), levels in dB. `gain {db}`, `normalize {peak}`, `comp {threshold, ratio, attack, release, knee, makeup}`, `limit {ceiling, release}`, `crush {bits}`, `hpf {freq}`, `lpf {freq}` (Hz), `drive {db}`, `fade {at\|null, len, curve}`, `reverb {size, damp, mix, predelay, tail}`. `[]` when the def has none. The exporter runs it (`live/src/sample-fx.js`) before baking. |

### 2.3 `metadata.waves[]` — wave defs (`(def-wave name …)`)

Present when the score has a def-wave (language.md §19, `msx`); a
`PARAM_SET WAVE` names an entry by its index, in def order.

| Field  | Type  | Semantics                                              |
| ------ | ----- | ------------------------------------------------------ |
| `name` | string | The def's name.                                       |
| `len`  | int   | Steps in one cycle: 32.                                 |
| `bits` | int   | The steps' resolution: 8, signed.                       |
| `data` | int[] | The `len` steps, each −128..127.                        |

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
| `se`           | object | Present on a sound effect's part (`def-se`, language.md §9.3): `{name, index, prio}` — the effect's name, its number (def-se order, imports first) and its default priority. These tracks follow the song's, run on the effect's own tempo (a TEMPO_SET at tick 0), and are not played with the song: the preview plays the song's tracks, or one effect's alone (`IRPlayer.loadJSON(ir, {se})`). |

Tracks have no `name` field; the player routes purely by `channel`.

### 3.1 Channel names and player routing

The JSON IR addresses channels **by name**; the player maps names to hardware
indices at load through the target's channel table (`live/src/targets/`,
each name's part and voice index). On the Mega Drive:

| `channel`            | Route                                    | Index                    |
| -------------------- | ---------------------------------------- | ------------------------ |
| `fm1` … `fm6`        | YM2612 FM                                | 0–5                      |
| `sqr1` `sqr2` `sqr3` | SN76489 tone                             | PSG 0–2                  |
| `noise`              | SN76489 noise                            | PSG 3                    |
| `pcm1` … `pcm3`      | Software PCM worklet, keyed by track id  | (FM index fallback only) |

Unknown names fall back to `min(trackIndex, 5)` on the FM side. The IR names
channels; the numeric channel ids 0–5 / 6–9 / 16–19 / 20–22 belong to MMB
(`live/src/mmb.js` `CHANNEL_ID`, docs/mmb.md §6.1).

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
| `src`  | 1-based source span of the emitting token (`endColumn` is one past the end), plus `file` (the import path) when the token is in an imported file — a span in that file, not in the score. Debug/editor aid only — drop it for MMB. |

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
| `vol`, `fm_alg`, `fm_fb`, `fm_ams`, `fm_fms` | spec (§6) | per target | no | Macros on those targets. |
| `legato`     | bool       | —       | no  | Present (true) on the right note of a slur (`e ~ g`, language.md §3): the pitch moves without a key-off/key-on (MMB `NOTE_ON_EX` bit3). FM/PSG only. |
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
  and the next note starts immediately, the key-off is written from that note's
  dispatch, just before its own key-on — unless the note carries `legato`, which
  suppresses it (slur). Macro schedules are hard-limited to 5 ms
  (`KEY_OFF_LEAD_SECS`) before the next `NOTE_ON` on the channel (monophonic
  priority).
- `keyon` retrigger is honored on FM, FM3 operator, PSG and PCM notes.

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
| `LOOP_BEGIN` | `{ id }`                   | `id`: compiler-generated `"(x N)"` (no `#name` can spell it) or the user label.            |
| `LOOP_END`   | `{ id, repeat }`           | `repeat`: int ≥ 1 iteration count.                             |
| `LOOP_BREAK` | `{ id }` (`id` may be null)| Final-pass exit point inside the loop body. `null` only if authored outside any counted loop (then inert). |

```json
{ "tick": 0,  "cmd": "LOOP_BEGIN", "args": { "id": "(x 0)" } }
{ "tick": 96, "cmd": "LOOP_END",   "args": { "id": "(x 0)", "repeat": 4 } }
{ "tick": 48, "cmd": "LOOP_BREAK", "args": { "id": "(x 0)" } }
```

Notes: the player expands loops **structurally at load time**
(`_expandLoops`, nesting depth ≤ 8);
`LOOP_BREAK` truncates only the final pass. None of the three survive into
the flattened runtime schedule.

### 5.5 MARKER / JUMP / TRIG

| Cmd      | Args                       | Semantics                                                                 |
| -------- | -------------------------- | --------------------------------------------------------------------------- |
| `MARKER` | `{ id }`                   | Label from `#name`, or the anchor of an uncounted `(x …)` (`"(x N)"`) — a `JUMP` target; emits no stream bytes. |
| `JUMP`   | `{ to }`                   | `to`: marker id. A **backward** `JUMP` is the track's structural loop point. A counted `(go label N)` never reaches the IR as a `JUMP`: it becomes `LOOP_BEGIN`/`LOOP_END` (a forward one is `E_GO_FORWARD_COUNT` and dropped). |
| `TRIG`   | `{ code }`                 | `(trig N)`: id 0..63 — a music→game sync point written to the track's status byte (opcodes.md §0x42). Never a jump target. |

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

Notes: voice defs (`(def-fm name :alg …)` etc.) compile to a burst of same-tick
`PARAM_SET`s in a fixed key order (ALG, FB, AMS, FMS, then op1–4 ×
AR,DR,SR,RR,SL,TL,KS,ML,DT,SSG,AMEN). An unsupported target is a diagnostic,
and no event is emitted.

### 5.7 PARAM_ADD / PARAM_MUL

Runtime read-modify-write against the player's shadow register file.

| Arg      | Type                    | Req | Semantics                                          |
| -------- | ----------------------- | --- | --------------------------------------------------- |
| `target` | string                  | yes | Canonical target (§7).                              |
| `delta`  | number \| `{ "src": s }`| yes (`PARAM_ADD`) | Added to the current shadow value.    |
| `factor` | number \| `{ "src": s }`| yes (`PARAM_MUL`) | Multiplies the current shadow value, unsigned 8.8: a number is the factor (×256, rounded); a slot's value is the 8.8 factor itself (256 = ×1). The product is floored. |

`src` is `"$time"` (elapsed 60 Hz frames since play start) or a `def-val`
slot name, resolved at dispatch time.

```json
{ "tick": 96, "cmd": "PARAM_ADD", "args": { "target": "FM_TL1", "delta": 5 } }
{ "tick": 96, "cmd": "PARAM_MUL", "args": { "target": "FM_TL1", "factor": { "src": "depth" } } }
```

Notes: the readable shadow set is `FM_*` op/channel params (TL reads the
*voiced* timbre TL, so relative TL composes under vel/vol attenuation),
`VOL`, `PAN`, `SNAP`, and `NOTE_PITCH` / `NOTE_SEMI` (the running cent offset, so
`:pitch+ N` accumulates). Anything else reads 0.

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
| `curve`      | string  | —     | yes | Curve name (§6.4).                                                |
| `from`       | number  | target| no  | Start value. Absent ⇒ the parameter's current value when the sweep starts (MMB `flags` bit3). |
| `to`         | number  | target| yes | End value (0 if unspecified).                                     |
| `frames`     | int     | ticks | no  | Sweep length. **In ticks** despite the name (the player converts ticks → 60 Hz frames at dispatch). |
| `lenFrames`  | bool    | —     | no  | True when `:len` was written as `Nf` or `Nms` (absolute frames); `frames` is then a frame count (language.md §4). |
| `loop`       | bool    | —     | yes | True for loop waveforms (`sin`/`triangle`/`square`/`saw`/`ramp`/`noise`/`pink`/`perlin`/`brown`) or `:mode loop`; `:mode shot` clears it. |
| `waitTicks` / `waitFrames` / `waitKeyOff` | int / int / bool | ticks / frames | no | Pre-delay before the curve. **Ignored on PARAM_SWEEP** (macro-only) — see §11. |
| `params`     | object  | —     | no  | Curve shape params (§6.4).                                        |
| `dyn`        | object  | —     | no  | `{ from?, to?, rate?, len? }` slot refs; `from`/`to`/`rate` resolved at sweep start. **`from`/`to` are slot-fed in MMB too** (PARAM_SWEEP flags bit1/bit2, read live at dispatch — opcodes.md §6); `len` is read at sweep start by the player, by the slot's `:unit`; on MMB `len` bakes to the slot's init (`W_MMB_DYN_SWEEP_BAKED`). |
| `bounded`    | bool    | —     | no  | Glide only: the sweep lasts `frames` then stops (never extended to the next automation event); the next `PARAM_SET`/`PARAM_SWEEP` on its target still ends it sooner. |

```json
{ "tick": 0, "cmd": "PARAM_SWEEP", "args": { "target": "NOTE_PITCH", "curve": "linear",
  "from": -200, "to": 0, "frames": 12, "loop": false, "bounded": true } }
```

A note that does not glide, while a glide is still running, ends it with a
one-tick hold sweep before its NOTE_ON: `bounded`, `from` = `to` = the sticky
`:pitch` offset, `frames: 1`.

Notes: the player steps the curve once a driver frame, with the driver's
integer math for the curves the driver computes (mmb.js `sweepFrameValue`;
the other curves sample the float curve), so preview and driver step the same
values on the same frames. A non-`bounded` sweep runs until
the next `PARAM_SET`/`PARAM_SWEEP`/`PARAM_SWEEP_STOP` on the same target, else
one structural-loop duration (loop waveforms are kept alive ~16 loop
iterations so LFO-style sweeps persist). `NOTE_PITCH` sweeps track upcoming
`NOTE_ON` base pitches per frame; `VOL`/`MASTER` sweeps and the other
parameters keep sweep state, so a later event composes from the value the
sweep holds at its time.

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

Notes: stepped once a frame, as the driver steps it — the tempos as tick
increments, the length as frames at the average tempo, one integer increment
a frame; the player re-anchors the clock at each step and on completion pins
`to`.

### 5.13 CSM_ON / CSM_OFF

No args (`{}`). Emitted on `fm3-csm` tracks: `CSM_ON` once before the first
note, `CSM_OFF` at the end of the track body. Sets/clears YM2612 reg 0x27 bit
7 (CSM mode). With formant tracks (language.md §15 — a note-less `fm3-csm`
beside `fm3-1..fm3-4`) the `fm3-csm-rate` track owns them instead: its
stream opens with `CSM_ON` and a `CSM_RATE { run: false }` at tick 0 (Timer A
held until its first rate) and closes with `CSM_OFF`, so the voice sounds
exactly while the rate track plays.

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

Gate (a rest on the rate source, and the note after it with an inline rate):

| Arg   | Type | Req | Semantics |
| ----- | ---- | --- | --------- |
| `run` | bool | yes | `false`: Timer A stops, CSM stays on; `true`: it runs again at the period it has. A const or swept rate also starts it. |

```json
{ "tick": 0,  "cmd": "CSM_RATE", "args": { "hz": 220 } }
{ "tick": 48, "cmd": "CSM_RATE", "args": { "run": false } }
{ "tick": 96, "cmd": "CSM_RATE", "args": { "from": 220, "to": 440, "len": 48, "curve": "linear" } }
```

Notes: the player converts Hz → Timer A value
(`TA = 1024 − clock/(144·hz)`) and, for the swept form, writes per 60 Hz
frame over `len` ticks, linear in that value, as the driver sweeps it. The
track's next CSM_RATE (const or swept) ends a running sweep.

### 5.15 FM3_MODE

| Arg    | Type   | Req | Semantics                                                       |
| ------ | ------ | --- | ---------------------------------------------------------------- |
| `mode` | string | yes | `"op"`: independent-operator mode (reg 0x27 bit 6); `"csm-op"`: CSM with the operators as tracks (bit 7, with each operator's own level and key — driver.md §9). Emitted at tick 0 into `tracks[0]` when fm3-1..4 tracks exist, `"csm-op"` when a note-less `fm3-csm` track stands beside them. |

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
| `pitch`    | string | —       | yes | Note + octave. The note is BAKED: it picks a blob resampled for it, and there is no range clamp. |
| `rate`     | number | ratio   | yes | Playback rate = `2^((midi−60)/12)` (1.0 at C4).                  |
| `length`   | int    | ticks   | yes | Timeline advance.                                                |
| `mode`     | string | —       | yes | `"shot"`, `"loop"` or `"gate"` — the NOTE's; it decides whether it loops, and what its gate does, whatever the sample def says. |
| `baseRate` | int    | Hz      | no  | Sample's source rate (from the sample def), when known.          |
| `vel`      | int    | 0–15    | no  | Omitted when 15.                                                 |
| `gate`     | int    | ticks   | no  | Present only when `< length`.                                    |
| `keyon` / `velMacro` / `vol` | spec (§6) | — | no | The note's macros, as on NOTE_ON — the only three a pcm track takes. |

```json
{ "tick": 0, "cmd": "PCM_NOTE_ON", "args": { "sample": "kick", "pitch": "c4", "rate": 1,
  "length": 48, "mode": "shot", "baseRate": 13000 } }
```

Notes: the player sends the worklet `sample`, the MIDI note, `vel` and `mode`
(ir-player.js `_dispatchPcmNoteOn`); the worklet plays the exported bank's entry
for that note. A shot plays to completion regardless of gate; a loop note loops
until `PCM_NOTE_OFF`; a gate note plays once and is silenced at its
`PCM_NOTE_OFF`.

### 5.18 PCM_NOTE_OFF

| Arg      | Type   | Req | Semantics                                              |
| -------- | ------ | --- | ------------------------------------------------------- |
| `sample` | string | yes | Sample to stop.                                          |
| `mode`   | string | yes | The note's `:mode`; `"gate"` silences the voice (MMB `PCM_NOTE_CUT`). Emitted at `tick + gate` for a loop or gate note with gate > 0, and for a shot whose macros listen for a key-off with 0 < gate < length. |

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
| `loopIndex`    | int\|null       | `#sus` position — sustain loops back here until gate. `null` = one-shot (hold last value). |
| `releaseIndex` | int\|null       | `#rel` position — steps from here play after key-off, spaced by `step`.  |
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
| `from`       | number  | Start value. Absent only on an inline `PARAM_SWEEP` (start from the current value); a macro curve always carries it (`E_CURVE_FROM`). |
| `to`         | number  | End value (always present; 0 default).                                           |
| `frames`     | number  | `:len`. On a macro, resolved at the note to the macro's clock: frames under a frame `:step` (the default), ticks under a tick `:step`. On an inline sweep, ticks unless `lenFrames`. Placeholder `1` when `dyn.len` is set. |
| `lenFrames`  | bool    | Present (true) when `frames` is a frame count — an `Nf`/`Nms` `:len`, or any macro curve under a frame `:step`. |
| `loop`       | bool    | Loop waveforms and `:mode loop` easings cycle until gate; non-loop curves clamp at phase 1 and hold. |
| `waitTicks`  | int     | Pre-delay in ticks before the curve starts (`:wait N`) — a macro under a tick `:step`. |
| `waitFrames` | int     | The same pre-delay in frames — a macro under a frame `:step` (the default), whatever unit `:wait` was written in. |
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
| `waitFrames: N`    | Advance the cursor N 60 Hz frames (wall-clock). Emitted for `(wait Nf)` / `(wait Nms)` and for `_`, under a frame `:step`. |
| curve stage        | Plays for its `frames`; a `loop: true` stage cycles until the gate.       |

A `:wait` **inside** a curve stage acts as that stage's pre-delay.

### 6.4 Curve names and `params`

Easings (non-loop): `linear`, `ease-in`, `ease-out`, `ease-inout`, and the
`ease-{in,out,inout}-{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}`
family. Loop waveforms: `sin`, `triangle`, `square`, `saw`, `ramp`. Stochastic
(fixed-seed LUTs — deterministic): `noise`, `pink`, `perlin`, `brown`.

`params` keys (all optional, numeric; clamped with warnings at compile):

| Key       | Range        | Applies to        | Semantics                          |
| --------- | ------------ | ----------------- | ----------------------------------- |
| `phase`   | 0–255        | all               | Phase offset (/256 of a cycle).     |
| `rate`    | ≥ 0          | all               | Phase multiplier (cycles per `len`); `0` freezes the phase. |
| `duty`    | 1–255        | `square`          | Duty threshold (/256).              |
| `skew`    | −127–127     | `sin` `triangle` `saw` `ramp` | Waveform skew.          |
| `hold`    | 0–1          | stochastic        | Sample-and-hold length as a share of `len` (`:hold` ÷ `:len`, resolved at compile time). |
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
| `SNAP`            | 0–4095         | The channel's pitch-class mask (bit 0 = C; 0 = off): every pitch write's whole semitone — the note plus its `NOTE_SEMI` — snaps down onto it before the cents are added (language.md §5.3). Sticky per FM/PSG channel (an fm3-N track's is CH3's). **Inline-only** — `PARAM_SET` / `PARAM_FROM_VAL`; not a macro target (`E_MACRO_TARGET`), no sweep. |
| `KEYON`           | 0–1            | Retrigger gate (reg 0x28 key pulses). **Macro-only** — rejected as a PARAM target. |
| `VEL`             | 0–15           | Velocity ladder (2 dB/step) folded into carrier TL / PSG att. **Macro / `:vel` note-scoped only** — rejected as a PARAM target. |
| `VOL`             | 0–31           | Channel fader → carrier TL offset (FM) / attenuator (PSG). 0 = hard mute. |
| `MASTER`          | 0–31           | Global fader → all FM carrier TLs + all sounding PSG channels. Song-wide: inline only, not a macro target. |
| `LFO_RATE`        | 0–8            | Reg 0x22 (0 = off, 1–8 = `0x08 \| rate−1`). Song-wide, as `MASTER`. On `x68k`: 0 both depths 0, 1–8 the nearest LFRQ at depth 127. |
| `LFO_FREQ`        | 0–255          | `x68k`: the YM2151's LFRQ (reg 0x18). Song-wide, as `MASTER`. |
| `LFO_PMD` / `LFO_AMD` | 0–127      | `x68k`: the LFO's pitch / level depth (reg 0x19, bit 7 set / clear). Song-wide. |
| `LFO_WAVE`        | 0–3            | `x68k`: the LFO's waveform (reg 0x1B bits 1–0): saw, square, triangle, noise. Song-wide. |
| `VAL0`–`VAL15`    | −32768–32767   | Value slot n (`:name` of a `def-val`, language.md §8). Song-wide, as `MASTER`; no register. |
| `FM_ALG`          | 0–7            | B0 bits 2–0.                                                 |
| `FM_FB`           | 0–7            | B0 bits 5–3.                                                 |
| `FM_AMS`          | 0–3            | B4 bits 5–4.                                                 |
| `FM_FMS`          | 0–7            | B4 bits 2–0.                                                 |
| `PAN`             | −1–1           | B4 bits 7–6 (−1 = L `10`, 0 = LR `11`, +1 = R `01`); snapped to the tri-state lane. |
| `NOISE_RATE`      | 1–31           | `pc88`, `msx`: the SSG's noise period (reg 0x06); `x68k`: NFRQ = 32 − n (reg 0x0F). Song-wide as `LFO_RATE`; inline or a sweep. |
| `SSG_MIX`         | 0–3            | `pc88`, `msx`: an SSG channel's mixer (reg 0x07), 0 tone, 1 noise, 2 both, 3 neither (the envelope alone) — sqr1–sqr3's `:mode`. |
| `SSG_ENV`         | −1–15          | `pc88`, `msx`: an SSG channel's level on the hardware envelope (the M bit), the value its shape (reg 0x0D, written at each key-on but a slur's); −1 the 4-bit level. Inline only (`:env`). |
| `ENV_SEMI`        | −48–48         | `pc88`, `msx`: semitones the period a channel gives (its notes', or a rate it writes) is moved. Inline only (`:env-semi`), a value; `none` is 0. |
| `ENV_DETUNE`      | −1000–1000     | `pc88`, `msx`: register steps added to that period (+ lower). Inline only (`:env-detune`), a value; `none` is 0. |
| `ENV_RATE`        | 0–8000         | `pc88`, `msx`: the envelope's period (regs 0x0B–0x0C) as one cycle's Hz of the writing track's shape then, a triangle's (shapes 10, 14) halved; 0 the writing track's pitch from its next note. Song-wide as `NOISE_RATE`. |
| `WAVE`            | index          | `msx`: a wave channel's wave, an entry of `metadata.waves` (§2.3), written whole to the channel's SCC memory. A track naming a def-wave emits it; a folded `:wave` expression is an entry of its own, named `<channel>@<line>:<column>`. One with a `$slot` carries `expr` instead of `value`: a tree of `{n}` (a number), `{data}` (32 steps), `{val}` (a slot's name) and `{op: "+"\|"-"\|"*"\|"/", args}`, taken step by step (`live/src/ir-utils.js` waveEval); the player writes it at once and again in every frame a slot it reads has moved, rounded and kept in −128..127. |
| `NOISE_MODE`      | 0–7            | SN76489 noise control (FB bit + NF bits). Persistent noise-channel state via `PARAM_SET` (inline `:mode` / tick-0 default), re-asserted on each `NOTE_ON`; the NOTE_ON macro is a temporary override. |
| `FM_TL1`–`FM_TL4` | 0–127          | 0x40+op. PARAM_SET also updates the voiced (timbre) TL base. |
| `FM_AR1`–`FM_AR4` | 0–31           | 0x50+op bits 4–0 (shared byte with KS).                      |
| `FM_DR1`–`FM_DR4` | 0–31           | 0x60+op bits 4–0 (shared byte with AMEN).                    |
| `FM_SR1`–`FM_SR4` | 0–31           | 0x70+op.                                                     |
| `FM_RR1`–`FM_RR4` | 0–15           | 0x80+op bits 3–0 (shared byte with SL).                      |
| `FM_SL1`–`FM_SL4` | 0–15           | 0x80+op bits 7–4.                                            |
| `FM_ML1`–`FM_ML4` | 0–15           | 0x30+op bits 3–0 (shared byte with DT).                      |
| `FM_DT1`–`FM_DT4` | −3–3           | 0x30+op bits 6–4, sign-magnitude at the write.               |
| `FM_KS1`–`FM_KS4` | 0–3            | 0x50+op bits 7–6.                                            |
| `FM_SSG1`–`FM_SSG4` | 0–15         | 0x90+op. `:ssg1`–`:ssg4`, inline, as a macro or in a voice def. |
| `FM_DT2_1`–`FM_DT2_4` | 0–3        | `x68k`: the YM2151's DT2, 0xC0+slot bits 7–6. `:dt2-1`–`:dt2-4`, inline, as a macro or in a voice def. |
| `FM_AMEN1`–`FM_AMEN4` | 0–1        | 0x60+op bit 7.                                               |
| `FM_VEL1`–`FM_VEL4` | −1, 0–16     | No register: the operator's velocity sensitivity in sixteenths (`:vel1 0.5` → 8), composed into its TL; −1 is the role's own (16 on a carrier, 0 on a modulator). PARAM_SET only. A score that writes one anywhere has every voice emit all four after its other params, −1 where it sets none (language.md §6). |

CSM rate is not a PARAM target (own `CSM_RATE` command; 52–53270 Hz). On
PSG-routed tracks only `VOL`, `NOTE_PITCH`, `SNAP` and (on the noise channel)
`NOISE_MODE` PARAM events are honored.

## 8. Normalization invariants

- **Ticks are non-decreasing per track.** Events are emitted in timeline
  order; the post-passes (delay expansion, priority-layer flattening) re-sort
  by tick with JS's stable sort, so **same-tick events keep their emission
  (source) order**. The player relies on this (equal-time register writes
  apply in insertion order, last wins).
- **Determinism: same source → byte-identical IR.** No randomness (stochastic
  curves are playback-side fixed-seed LUTs), no timestamps, and `sortObject`
  alphabetizes every object key recursively before return. Generated loop ids
  (`(x 0)`, `(x 1)`, …) come from a single per-compile counter in score order.
- **Marker/loop id resolution.** Loop ids pair `LOOP_BEGIN`/`LOOP_END`;
  `LOOP_BREAK` binds to the innermost counted loop (a break authored under a
  `#label…(go label N)` loop gets its id assigned when `convertCountedJumps`
  rewrites the pair — that pass runs on the *merged* track, so label and jump
  may come from different source forms). `JUMP.to` must resolve to a `MARKER`
  on the same track (validated; forward or backward).
- **Post-passes** (in order): per-layer delay expansion → `def-mod`
  application (language.md §9.4) → `:prio` layer flattening (note
  drop/truncate under higher-priority layers) → track re-numbering →
  counted-jump conversion → removal of a stray `LOOP_BREAK` no counted loop
  claims (`W_BREAK_OUTSIDE_LOOP`) → validation → voice hoisting, on the
  Mega Drive alone (`voice-hoist.js`: a voice change moves into the silence
  before its note, for the driver's wire)
  → tick-0 `FM3_MODE` unshifted into `tracks[0]` (when fm3-1..4 tracks
  exist).
- Transient fields (`_delay`) are stripped; `src` spans are the only
  non-semantic payload that remains.

## 9. Playback semantics notes

- **gate vs length.** `length` is pure timeline spacing (the compiler already
  placed the next event); `gate` is the sounding span. The player clamps
  `gate` to `length` and keys off at the gate boundary. When the gate fills the
  note and the next note follows immediately, that key-off is deferred to the
  next note's dispatch and written an ordering margin
  (`KEY_ORDER_EPS_SECS`) before its key-on — on FM the transition is the
  attack — and suppressed only when the incoming note carries `legato` (slur).
  Macro schedules use a gate reference 5 ms early (`KEY_OFF_LEAD_SECS`) and are
  cut 5 ms before the next note-on on the same channel (monophonic priority).
- **Holds.** `length: 0` or `gate: 0` = hold indefinitely; the channel is
  parked in a hold set until the host calls `triggerKeyOff(ch)` (FM 0–5,
  PSG `psgCh + 6`, PCM `20 + voice`). Macro budgets use the `HOLD_FRAMES` sentinel.
- **TEMPO_SET re-anchoring.** Tempo changes re-anchor every track's
  tick→audio-time base so the change tick's audio time is preserved — tick
  durations before and after differ, absolute positions never jump.
- **TEMPO_SWEEP** steps the tempo along the curve once a frame over `len`
  ticks (the frames they take at the average tempo); a `TEMPO_SET` (or the
  host `setTempo`) cancels it.
- **PARAM_ADD / PARAM_MUL** are read-modify-write against the player's shadow
  register file (never the chip): read the stored value (voiced TL for
  `FM_TL*`), apply the operand (literal or slot ref), write back through the
  normal `PARAM_SET` path (round + clamp at the register write).
- **Dynamic values.** Slots live in a name→value table seeded from
  `metadata.vals[].init` and written by the host (`setVal`) and by the
  score's `VALn` PARAM events, whatever track carries them; a `VALn` sweep is
  the slot's own, and a read sees the value the frame before wrote, as on
  the driver. `PARAM_FROM_VAL`
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
  "metadata": { "title": "demo", "composer": "", "author": "", "source": "demo.mmlisp", "vals": [], "samples": [] },
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

1. **`waitTicks` / `waitKeyOff` on inline PARAM_SWEEP.** Honored in NOTE_ON
   macro curves; `_applyParamSweep` starts immediately and ignores a
   pre-delay. (An `Nf` `:len` and a slot-fed `:len` *are* honored.)
