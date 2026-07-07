# MMLisp Roadmap

## Phase 0: Spec and Authoring Validation ✓

- Define language subset and IR
- Build minimal web playback validation path
- Produce demo songs and prune unnecessary commands
- Freeze v0.1

Status: **complete** — v0.1-candidate tag at b61eb11 (2026-04-09).

Outputs: the v0.1 spec, command table, and the first IR/MMB drafts.
(Per-version spec files were consolidated into docs/language.md and the
driver doc set in the v0.5 cleanup; the originals live in git history.)

## Phase 0.5: Editor Tooling ✓

- VS Code syntax highlighting via custom TextMate grammar (mmlisp-syntax/)
- Format-on-save via format-mmlisp.js

Status: **complete**.

## Phase 1: Web Authoring Environment (MMLisp Live)

- Editor and diagnostics
- Transport controls and marker/loop visualization
- Parameter modulation panel
- Runtime intervention simulator

Current status: partially implemented (live/).

Implemented (v0.1 + post-freeze):

- YM2612 AudioWorklet emulator with ahead-of-time timestamped register writes
- IR preset loader and local file browser with auto-stop on change
- Playback transport (Play/Stop) with loop support
- Per-track independent loop scheduling (each track loops on its own JUMP boundary)
- Non-cumulative loop time base (startAudioTime + loopCount × loopDuration)
- Automatic track→channel assignment from IR `track.channel` field; auto-increment fallback
- CodeMirror 6 source editor with MMLisp StreamLanguage syntax highlighting (One Dark)
- Playhead line highlight synchronized to source events
- Bar:Beat + BPM position display (25ms poll)
- FM parameter panel: ALG/FB + op TL/AR/DR/RR/MUL sliders per channel
- Slider values updated in real time from PARAM_SET/PARAM_ADD playback events
- Browser-side MMLisp compiler (mmlisp-parser.js + mmlisp2ir.js as ES modules)
- Hot-swap playback: live compile on edit (400ms debounce) with bar-boundary resume

v0.2 additions (complete):

- ~~Cmd+Enter play/pause toggle; Cmd+. full stop~~
- ~~Marker-based playback start from cursor position~~
- ~~Named FM/PSG voice data (legacy voice-def syntax)~~
- ~~same-channel BGM collision diagnostic~~
- ~~modulator track note/LFO separation; `:reset-on-note` option~~
- ~~PWA top bar UI; FM params slide-in panel; line numbers~~

Phase 1 exit signal:

1. Demo songs can be edited and auditioned end-to-end in the web workflow ✓

## Phase 2: Compiler and Format Stabilization ✓

- Source parser and AST
- IR generation
- MMB binary writer
- Compatibility/version checks

Status: **complete** — deterministic IR and MMB outputs verified for both demo artifacts.

## Phase 3: Driver Implementation (MMLispDRV)

Docs-first: the driver design is specified before any code. The doc set —
docs/mmb.md (MMB v0.2 container), docs/opcodes.md (opcode/target freeze),
docs/driver.md (MMLispDRV v0.2 architecture) — is written; **review of that
set is the Phase 3 entry condition.**

Order of work:

1. **Design docs** (done) — MMB v0.2 delta/duration stream format, frozen
   opcode + target tables, Z80 RAM map, mailbox protocol, timing model,
   level/pitch tables. Open decisions resolved: NOTE_ON vel/gate = track
   state + NOTE_ON_EX (opcodes.md §4); voice representation = export-time
   VOICE_TABLE coalescing (driver.md §10).
2. **JS reference implementation** (done, M1 coverage) — `mmb.js` +
   `export-mmb.js` + `drv-player.js` + `ab-compare.js` in live/src/.
   Integer-only 60 Hz decoder, normative main-loop order, LUTs exported
   for verbatim asm inclusion. A/B gate: `examples/source/ab-core.mmlisp`
   diffs clean against ir-player.js (0 mismatches; bands in driver.md
   §12). Live app: MMLispDRV backend toggle, File > Export > MMB…,
   `window.__abCompare()`. M2/M3 opcodes are length-decoded and skipped.
3. **Z80 assembly** (in progress — **M1 + all of M2 done in emulation**) —
   `drv/`: the driver (~6.3KB image) plus a first-party node toolchain
   (assembler, Z80 emulator, trace harness). Gate: raw register-trace
   equality vs the JS reference — nine scores diff clean at zero tolerance.
   **M2a** = sweep engine (PARAM_SWEEP/STOP), PARAM_ADD, TEMPO_SWEEP with a
   single-sourced integer curve model (`mmb.js` `curveUnit8`). **M2b** =
   cent-interpolated NOTE_PITCH (glide/vibrato/detune). **M2 CSM** = FM3 CSM
   mode. **M2 PCM** = single-channel DAC (shot/loop), frame-quantized (the
   sub-frame feed timing is a hardware concern). **M2 mailbox** = KEY_OFF /
   SET_PARAM / FADE_TRACK (host-driven; a sidecar cmd schedule is injected
   into both players). The shadow's valid plane is now a bitmap (fit 8 KB).
   Deviations in `drv/README.md`. **M3 binary formats now frozen** (2026-07-07):
   the macro engine (MACRO_TABLE §0x0007 + MACRO_SET/CLEAR opcodes 0xE0/0xE3,
   uniform pre-sampled step-stream) and VOICE_TABLE/VOICE_SET — see mmb.md §11
   /§15, opcodes.md §5/§6, driver.md §13. Next: **M3 implementation** (macro
   engine, dynamic value slots + SET_VAL, NOTE_ON_EX, FM3 independent-OP,
   CALL/RET + dedup, VOICE_SET) — needs a code-size rework first — then hardware
   bring-up + cycle tuning.

Milestone staging (full definitions in driver.md §11):

- **M1 — core playback**: core opcodes, FM + PSG, level tables,
  START_TRACK/STOP_TRACK, channel ownership, len=0 holds.
- **M2 — motion**: PARAM_SWEEP/STOP + glide, PARAM_ADD, TEMPO_SWEEP,
  LOOP_BREAK, CSM, single-channel PCM DAC, KEY_OFF/SET_PARAM/FADE_TRACK.
- **M3 — expression**: NOTE_ON_EX + macro engine, FM3 independent-OP,
  dynamic value slots, multi-channel PCM soft mix, CALL/RET + dedup pass.

Phase 3 entry condition:

1. Phase 3 doc set (mmb.md, opcodes.md, driver.md) reviewed and open
   decisions resolved

## Phase 4: Integration and Demo

- End-to-end toolchain: source to MMB to SGDK playback
- Example game-scene mappings for interactive music
- Documentation and migration notes for v0.2

## Language Version Status

| Version | Status   | Tag            | Themes                                                                               |
| ------- | -------- | -------------- | ------------------------------------------------------------------------------------ |
| v0.1    | frozen   | v0.1-candidate | Core language, IR, MMB format                                                        |
| v0.2    | frozen   | v0.2-freeze    | FM/PSG voices, modulator, UI, source map                                             |
| v0.3    | frozen   | v0.3-freeze    | gate, shuffle, track append, voice reference, relative volume controls               |
| v0.4    | frozen   | v0.4-freeze    | Envelopes/macros, multi-stage macro, pitch env, PSG noise, pan, level model          |
| v0.5    | complete | —              | FM3 independent-OP, CSM, PCM/DAC mixing, TEMPO_SWEEP, stochastic curves, File I/O UI |

### v0.4 Implementation Progress

#### Compiler (live/src/mmlisp2ir.js)

**Syntax / Language**

- [x] Channel name forms `(fm1 ...)` / `(sqr1 ...)` / `(noise ...)`
- [x] Inline `:key val` → `PARAM_SET`
- [x] Inline `:key (curve ...)` → `PARAM_SWEEP`
- [x] `def` bare reference (no `@` sigil required)
- [x] `(x N ...)` loop + `:break` / `LOOP_BREAK`
- [x] Tuplet `(t e g a)` with Bresenham tick distribution (originally the
      note-headed subgroup `(e g a)`; renamed to the explicit `(t …)` form in
      the v0.5 cleanup — note-headed lists are reserved)
- [x] All length token forms: integer, dotted (`4.`), frames (`Nf`), ticks (`Nt`)
- [x] Dotted notes / rests (`c4.`, `_8.`)
- [x] `:glide N` — emit `PARAM_SWEEP NOTE_PITCH` before NOTE_ON
- [x] `:glide-from` — one-shot start-pitch override

**Level Model**

- [x] `:vel` sticky state → NOTE_ON args
- [x] `:vol N` → `PARAM_SET VOL`
- [x] `:master N` → `PARAM_SET MASTER`
- [x] `:master (curve ...)` → `PARAM_SWEEP MASTER`
- [x] `:vol (curve ...)` → `PARAM_SWEEP VOL` (inline curve form)

**Macros — unified architecture**

All macro targets share a single parse path (`parseMacroSpec`) and a single
scheduler (`_scheduleMacro`). No per-target special cases.

_Input forms — identical for all targets:_

- [x] Numeric step-vector `[0 1 2]`
- [x] Step-vector `:hold` — hold/sustain region until gate (all targets)
- [x] Step-vector `:off` — release region played after gate (all targets)
- [x] `_` hold token in step-vector — advances 1 frame, skips write (all targets)
- [x] Single curve form `(ease-in :from ... :to ... :len ...)`
- [x] Looping single-stage curve `(sin ...)` / `(triangle ...)`
- [x] Multi-stage form `[(stage1) (stage2) ...]` — stages run sequentially by own `:len`
- [x] `(wait N)` / `(wait Nf)` pause stage inside multi-stage
- [x] `(wait key-off)` — stage loops until gate, then advances; curve-form equivalent of `:off`

_Symbolic → numeric coercion at compile time (all targets):_

- [x] `:pan` — `left` / `center` / `right` → -1 / 0 / +1
- [x] `:mode` — `white0`–`white3` / `periodic0`–`periodic3` → 0–7
- [x] Curve/function output for `:pan` — snap to -1 / 0 / +1
- [x] Curve/function output for `:mode` — snap to integer 0–7

_Compiler — `parseMacroSpec` refactor:_

- [x] `:macro :vel` parsed via `parseVelMacroSpec` (current, pre-unification)
- [x] `:macro :pitch` parsed via `parseCurveSpec` (current, single curve only)
- [x] Unify into single `parseMacroSpec(node, target)` covering all forms + all targets
- [x] `collectDefs` emits unified `{ tag: "macro", target, spec }` for all `:macro` defs

_Compiler — per-target gaps (after unification):_

- [x] `:macro :pitch` step-vector `[0 -100 :hold -200 :off 0]`
- [x] `:macro :pan` step-vector + curve
- [x] `:macro :mode` step-vector + curve
- [x] `:macro` FM operator params (`:tl1`–`:tl4`, `:ar1`–`:ar4`, etc.)
- [x] `def :macro` multi-target (`:macro :vel ... :pitch ...`) support
- [x] `:macro [list]` use-site macro array/list merge
- [x] `:extends` — compile-time FM voice inheritance
- [x] `len=0` hold note (KEY_OFF driven by runtime `key_off_flags`)

**PSG Noise**

- [x] `noise` channel basic NOTE_ON
- [x] `:mode white0`–`white3` / `periodic0`–`periodic3` → `NOISE_MODE` IR event

---

#### Player (live/src/ir-player.js)

**FM**

- [x] NOTE_ON F-number/block calculation (cents precision, fractional MIDI)
- [x] `PARAM_SET NOTE_PITCH` → store `pitchOffset` + immediate register write
- [x] `PARAM_SWEEP NOTE_PITCH` → 60 Hz frame-loop register writes
- [x] NOTE_ON applies stored `pitchOffset` (cents)
- [x] `_scheduleFmPitchMacro` — single-curve interpolation (current, pre-unification)
- [x] `_scheduleFmVelMacro` — step-vector + curve (current, pre-unification)
- [x] FM vel macro — hold/sustain (`:hold`) / release tail (`:off`)
- [x] Gate applied to FM key-off timing and macro gate boundary
- [x] Unify into `_scheduleMacro(target, spec, write_fn, when, gate)` — replaces both schedulers
- [x] FM: `_scheduleMacro` covers pitch + vel + pan + op params with unified step/curve/multi-stage logic
- [x] FM macro: `_` hold token (advance 1 frame, skip write)
- [x] FM macro: multi-stage sequential execution (each stage runs its own `:len`)
- [x] FM macro: `(wait key-off)` — loop stage until gate, then continue
- [x] `MASTER` → recalculate all carrier TL values (implemented; `_masterVol` + VOL interaction)
- [x] `:glide` PARAM_SWEEP handling (works via existing PARAM_SWEEP path)

**PSG**

- [x] `_psgSetPitch` with cents precision
- [x] `PARAM_SET NOTE_PITCH` → store `_psgPitchOffset` + immediate write
- [x] `PARAM_SWEEP NOTE_PITCH` → 60 Hz frame-loop writes
- [x] NOTE_ON applies `_psgPitchOffset`
- [x] `_schedulePsgPitchMacro` — single-curve interpolation (current, pre-unification)
- [x] `_schedulePsgVelMacro` — step-vector + curve (current, pre-unification)
- [x] PSG vel macro — hold/sustain (`:hold`) / release tail (`:off`)
- [x] Gate applied to PSG note-off timing and macro gate boundary
- [x] Share `_scheduleMacro` with FM (PSG provides its own `write_fn`)
- [x] PSG macro: `_` hold token, multi-stage, `(wait key-off)` — via unified scheduler
- [x] `NOISE_MODE` event handling (noise FB+NF register writes)
- [x] `MASTER` → PSG attenuation recalculation

---

#### Examples

- [x] Migrate `(def bd/sd/hh :psg [...])` → `(def bd/sd/hh :macro :vel [...])`
- [x] `(def down :macro :pitch ...)` updated to cents unit (`:to -2400`)
- [x] Add multi-stage `:macro :pitch` examples to spec v0.4 (`syntom-pitch`, `vib-entry`)
- [x] Retire demo2 example and keep demo set on `demo1`

---

#### Remaining Tasks (priority order)

Macro refactor first (unblocks all downstream macro features):

1. ~~**Unify** `parseMacroSpec` in compiler (covers all targets, all input forms)~~ (done)
2. ~~**Unify** `_scheduleMacro(target, spec, write_fn, when, gate)` in player (FM + PSG share)~~ (done)
3. ~~`_` hold token — advance 1 frame, skip write (falls out of unified scheduler)~~ (done)
4. ~~Multi-stage sequential execution (falls out of unified scheduler)~~ (done)
5. ~~`(wait key-off)` release stage (falls out of unified scheduler)~~ (done)

Then per-target gaps unlocked by the refactor:

6. ~~`:macro :pitch` step-vector + `:hold` / `:off`~~ (done — falls out of unified parseMacroSpec/scheduleMacro)
7. ~~`:macro :pan` step-vector + curve with snap~~ (done)
8. ~~`:macro :mode` step-vector + curve with snap; emit `NOISE_MODE` per step~~ (done)
9. ~~`:macro` FM operator params (`:tl1`\u2013`:tl4` etc.)~~ (done)

Other:

10. ~~`:glide` emit (compiler)~~ (done)
11. ~~`MASTER` player implementation~~ (done)
12. ~~`:vol (curve ...)` inline form~~ (done)
13. ~~`def :macro` multi-target in one def~~ (done)
14. ~~`:macro [list]` use-site merge~~ (done)
15. ~~`:extends`~~ (done)
16. ~~`len=0` hold note~~ (done)

---

### v0.5 Implementation Progress

#### Compiler (live/src/mmlisp2ir.js)

**FM3 CSM mode**

- [x] `fm3-csm` track form → emit `CSM_RATE` / `CSM_ON` / `CSM_OFF` IR events
- [x] `:csm-rate N` inline constant Hz on `fm3-csm`
- [x] `:csm-rate (curve ...)` inline swept Hz on `fm3-csm`
- [x] `fm3-csm-rate` companion track → note-based Timer A frequency
- [x] Score-level CSM/FM3/fm3-N mutual-exclusion compile error

**FM3 independent-operator mode**

- [x] `(fm3 voice-name)` form → enables FM3 special mode; shared voice declaration
- [x] `fm3-1`–`fm3-4` track forms → independent F-number per OP; emit `FM3_OP_PITCH` IR events

**TEMPO_SWEEP**

- [x] `:tempo N` mid-track → `TEMPO_SET` IR event
- [x] `:tempo (curve :from N :to M :len L)` → `TEMPO_SWEEP` IR event

**PCM / DAC**

- [x] `def :sample` declaration → WAV load + 8-bit signed PCM conversion at compile time
- [x] `:rate` on `def :sample` → C4 playback rate override
- [x] Stereo WAV → mono downmix `(L+R)/2` at compile time
- [x] Sample path resolution relative to `.mmlisp` source file location
- [x] `(pcm1 sample-name ...)` / `pcm2` / `pcm3` track forms → sample as first positional arg; emit `PCM_NOTE_ON` / `PCM_NOTE_OFF` IR events
- [x] `fm6 :mode shot|loop` → PCM note events on fm6 DAC channel (`loop` = sustain loop)
- [x] Pitch-to-rate mapping: `rate = 2^(semitones_from_C4 / 12)`; clamp C2–C6 with warning

**Stochastic curves**

- [x] `noise` / `pink` / `perlin` / `brown` in `CURVE_NAMES` / `LOOP_CURVE_NAMES`
- [x] `sampleCurveUnit` LUT generation with fixed seed `0xDEAD`
- [x] `brown` IIR implementation: `y[n] = 0.99 * y[n-1] + 0.01 * x[n]`, min-max normalize

---

#### Player (live/src/ir-player.js)

**FM3 CSM mode**

- [x] `CSM_RATE` → write Timer A frequency to YM2612
- [x] `CSM_ON` / `CSM_OFF` → YM2612 CSM mode register bit

**FM3 independent-OP mode**

- [x] `FM3_OP_PITCH` → write independent F-number/block per OP

**TEMPO_SWEEP**

- [x] `TEMPO_SET` dispatch → reanchor `audioTimeAtTick0` for all tracks
- [x] `TEMPO_SWEEP` dispatch → interpolate `secsPerTick` each scheduler pass

**PCM / DAC**

- [x] Sample buffer management (load compiled PCM data into AudioWorklet)
- [x] `PCM_NOTE_ON` → trigger soft-mix channel at computed rate with volume
- [x] `PCM_NOTE_OFF` / `loop` release from sustain loop playback
- [x] 3ch soft-mixer in Z80 worklet emulation path (or AudioWorklet mixing layer)

---

#### UI (live/index.html + live/src/)

**File menu**

- [x] File menu: **New** / **Open...** / **Save** / **Save As...** / **Examples ▶**
- [x] Open: use File System Access API (`showOpenFilePicker`) → load `.mmlisp`; set base directory
- [x] Save As: `showSaveFilePicker` → write `.mmlisp`; update base directory for sample resolution
- [x] Save: write to previously acquired `FileSystemFileHandle` (no picker re-prompt)
- [x] Unsaved-state guard: warn when compiling `def :sample` paths with no saved base directory
- [x] Examples item under File menu: load bundled `.mmlisp` sample into editor (currently: demo1; extensible)

**Tools menu**

- [x] Tools menu: **Format Source** / ── / **Snippets ▶** / **Theme ▶**
- [x] Format Source: reformat editor content (same as Cmd+Shift+F / Ctrl+Shift+F shortcut)
- [x] Snippets submenu: insert a code snippet at cursor (FM Voice Template)

---

#### Documentation (docs/guide.md)

- [x] Update guide for v0.5 features: FM3 CSM, FM3 independent-OP, PCM tracks, TEMPO_SWEEP, stochastic curves

---

## mucom88 Importer

Converts a mucom88 `.muc` song (PC-8801 / YM2608 OPNA) to MMLisp source.
Implementation: `live/src/import-mucom.js`. Pipeline: `.muc` → ops → MMLisp text
→ (compiled by the normal toolchain).

### Status — implemented

- **Channels**: FM A–C / H–J → `fm1`–`fm6`, SSG D–F → `sqr1`–`sqr3`.
  Dropped: part G (rhythm), part K (ADPCM).
- **Notes / lengths** on mucom's clock grid: `len` → `floor(C/len)` clocks →
  ticks (`× 384/C`); `%<clocks>` direct lengths; dots; `^`/`&`→tie.
- **Octave** (FM reads one higher → `:oct N-1`; SSG no shift), relative `<`/`>`.
- **Detune** `D` → `:pitch` (cents); **velocity** `v`/`(`/`)`; **pan** `p`.
- **Loops**: single-line `[…]n` → `(x n …)`; multi-line `[…]n` → `#labelK …
  (go labelK n)`; `/` break → `:break`; global `L` → `#loop`/`(go loop)`.
- **Voices**: inline `@n` FM defs, `@"name"`, external `.dat` bank load + merge.
- **Macros** `*n` → `(def *n …)`, tokenized at the song's C resolution.
- **Modulation**: portamento `{c2b}` → `:glide-from`/`:glide`; hardware LFO `H` →
  `:lfo-rate`/`:fms`/`:ams`; software LFO `M` → `(def lfoN :macro :pitch
  (triangle …))` + `(wait …)` delay; off `MF0` → `(def lfo-off :macro :pitch none)`.
- **Tempo**: `T` (BPM direct); `t` (Timer-B) via the driver formula
  `BPM = 830400 / ((256 − t) × C)`, deferred so a later `C` (and its first note)
  sets the resolution. First tempo seeds the score; changes emitted inline.

### Priority 1 — track alignment

Goal: every track in a song has the same total tick length (so they don't drift
apart over the loop). Current: **19 / 46** reference songs align exactly. Two
remaining classes of drift:

1. **Factor-rounding** — songs whose `C` doesn't divide the 384-tick grid
   (e.g. `C112`: slp020, bare21) accumulate per-note ±1-tick rounding in the
   clocks→ticks step. Fix options: raise the tick grid to an LCM that covers the
   common `C` values, or dither the clocks→ticks conversion with a running
   remainder so the total stays exact.
2. **Structural** — clean `C` but parts convert to different lengths. Either a
   conversion bug or a genuinely different part length (intro / non-looping
   tail). Needs per-song diagnosis. Remaining (spread in ticks):
   `pcmt12 12 · gh011 24 · pcmt31 48 · stk013/023 72 · stg001 96 ·
   sq1_103/disco4 192 · bare03 336 · pcmt16 384 · bos010(fm3) 768 · … bare21 7200`.

Method: compare a drifting part against a parallel aligned part to locate the
divergent measure; confirm against the raw MML clock count.

### Priority 2 — currently-dropped mucom commands

By musical impact (each maps onto existing MMLisp primitives):

- **High**: `q` quantize/gate (articulation — MMLisp has gate); `E` SSG soft
  envelope (PSG volume envelope — map like the LFO); `K`/`k` key shift (transpose).
- **Medium**: `&` slur (legato); `w` noise wave (PSG noise pitch); `J` tag jump
  (→ `#label`/`(go)`); `P` mix port (SSG tone/noise enable); `V` total volume
  offset.
- **Low**: `s` shuffle / key-on revise; `y` register write; `S` SE detune;
  `R` reverb.

### Priority 3 — dropped channels (larger effort)

- Part **G** rhythm (drums) → noise/PCM mapping + drum kit.
- Part **K** ADPCM (PCM samples) → MMLisp PCM channel + sample conversion.
- `@%` register-dump voice format.

### Reference

- Driver source (authoritative): `github.com/onitama/mucom88` →
  `pc8801src/ver1.2/{muc88,music,msub}.asm`. Command table: `msub.asm`. Tempo:
  `SETTMP` (T→Timer-B) + `INIT` (default `C = 128`) in `muc88.asm`.
- Tempo: `BPM = 830400 / ((256 − t) × C)`.
- Lengths: `floor(C / len)` clocks, each clock = `384 / C` ticks (PPQN 96).
- License: mucom88 is CC BY-NC-SA 4.0; the importer only reads the format and
  bundles no mucom88 code/data (see README).

---

## Backlog

Done (confirmed implemented, not yet removed from backlog):

- ~~Cmd+Enter pause/resume and Cmd+. stop~~ — live/index.html L978
- ~~Cursor-line seek from source map~~ — IRPlayer.playFromLine() in ir-player.js
- ~~Named FM/PSG voice data (legacy voice-def syntax)~~ — implemented in compiler + player pipeline (v0.2 era)
- ~~Mid-track default-state mutation~~ — implemented (guide §5)
- ~~FM patch vector column order~~ — confirmed `[AR DR SR RR SL TL KS ML DT (SSG) (AMen)]` (v0.2 era)

Active:

1. Freeze IR-to-MMB opcode table
2. Begin MMLispDRV implementation (Phase 3)
3. Furnace/DefleMask voice data interoperability (spec-first, then implementation)

- Define canonical mapping from Furnace/DefleMask FM instrument fields to the new MMLisp voice schema
- Implement import path (converter + validation + diagnostics) in tools/compiler layer
- Add round-trip fixtures and compatibility tests before any patch-sharing/community rollout

v0.5 candidates:

- arpeggio macro (`:macro :pitch` with note/rest sequences)
- quantize snap (scale mask applied after pitch sum)
- OP mask (per-channel operator enable/disable)
- AMS/FMS macros

Parked (out of current scope, post-core features):

- Parametric phrase definitions — `defn` (token-substitution templates) was
  removed in the v0.5 cleanup: zero usage, unhygienic parameter capture, and
  definition-site source maps. Redesign on demand when a composition needs it.
- Dynamic performance branch primitives (`|` alternation, random part switching, random label jump)
- Reproducible random sequence by seed-indexed LUT traversal (same seed => same sequence)
- Label numbering + jump-address table for O(1) branch target resolution in Z80 driver

---

## Future Vision (post-MVP ideas)

### MMLisp `import` system

```lisp
(import "reverb"    :from :stdlib)
(import "dx7-brass" :from :patches)
(import "my-arp"    :from "https://mmlisp.community/patches/okamura/arp01")
```

- `import` resolves at compile time and folds into IR — no runtime dependency
- Patch types:
  - **Function effects** (delay, arpeggiator, LFO, ...) — implementable in the ir-player.js scheduler layer
  - **FM voices** — define via a canonical voice asset schema compiled into IR/driver events
- Version pinning (`@1.2.3`) is required for reproducibility

### Patch server / community

- `GET /patches/:slug[@version]` → MMLisp snippet or FM voice JSON
- Each patch carries author ID, license, and version history
- Natural fit with the existing VGM community (snesmusic, hcs64, etc.)
- **Patch preview — dynamic, in-browser synthesis only**:
  the JS chip emulator already runs in the browser; preview = play a note
  through the emulator with no pre-rendered audio files, no R2 storage for audio
- **Finished works** — link out to external platforms (YouTube, SoundCloud, etc.)
  via a `demo_url` field on the song/patch metadata; no self-hosted audio hosting needed

### Infrastructure (Cloudflare stack)

**Phase 1 — R2 only (no DB)**

```
Cloudflare Pages   — static frontend
Cloudflare Workers — API (patch serve, index rebuild)
Cloudflare R2      — patch files (.mmlisp / voice .json) + index.json
```

- `index.json` — full patch list built by Workers on upload; filtered client-side
- Lineage resolved by following `fork_of` fields in patch metadata
- Sufficient up to ~hundreds of patches

**Phase 2 — add D1 when needed**

Trigger: complex tag/category queries get slow, user auth / donation records required,
or patch count exceeds thousands.

```
+ Cloudflare D1    — metadata DB (patches, authors, forks, tags)
```

All managed in a single `wrangler.toml`.
Audio preview synthesized on-demand in the client browser (JS emulator — no audio blobs in R2).

### R2 file naming convention

File type is encoded in the extension so Workers can distinguish without reading content:

```
r2/
  collections/
    dx7-voices@1.0.0.collection.json      ← uploaded by author
    tr-808@1.0.0.collection.json
  patches/
    dx7-voices--dx7-brass@1.0.0.json      ← auto-expanded from collection on upload
    dx7-voices--dx7-brass-warm@1.0.0.json ← fork (same naming, fork_of in metadata)
    tr-808--kick@1.0.0.json
  index.json                               ← rebuilt on every upload
```

**Naming rules:**

- Collection file: `{collection}@{version}.collection.json`
- Voice file: `{collection}--{voice}@{version}.json` (`--` separates collection from voice)
- Fork uses the same format; lineage is tracked via `fork_of` inside the JSON, not in the filename
- Workers expand a `.collection.json` upload into individual `patches/` entries automatically

**`import` syntax mapping:**

```lisp
(import "dx7-voices/dx7-brass" :from :patches)  ; single voice — resolves to dx7-voices--dx7-brass
(import "dx7-voices"           :from :patches)  ; entire collection
```

### PCM variant handling

Some PCM samples (e.g., a TR-808 kick) have multiple natural variants:
dry master, compressed, reverb tail, shortened, etc.

**Case A — Independent voices (MVP, current approach)**

Each variant is a separately named voice using the existing naming convention:

```
tr-808--kick@1.0.0.json          ← dry
tr-808--kick-comp@1.0.0.json     ← compressed
tr-808--kick-reverb@1.0.0.json   ← with reverb tail
```

- No new infrastructure; the `fork_of` field can optionally record the shared origin
- Cannot interpolate between variants or generate them programmatically
- Start here

**Case B — Processing chain in metadata (future)**

A single dry master `.wav` is stored in R2, and each voice declares a `processing` array
that Workers apply at build time to produce the final sample:

```jsonc
{
  "source_pcm": "tr-808--kick-dry@1.0.0.wav",
  "processing": [
    { "type": "compressor", "threshold_db": -12, "ratio": 4 },
    { "type": "fade_out_ms", "ms": 5 },
  ],
}
```

- One master file; variants are derived declaratively
- Enables programmatic generation of processing combinations
- Requires a Workers audio processing pipeline — build when worth it
- Particularly useful for:
  - **FM/PCM volume balance** — normalize relative levels between FM channels and PCM samples
    without modifying the master file
  - **Drum kit mixing** — declare per-hit `gain` in each voice's processing chain so a full kit
    (kick, snare, hi-hat, ...) has consistent levels even when sourced from different masters

For MVP, use Case A. Migrate to Case B when the processing pipeline justifies the investment.

### Voice metadata schema

`collection` is the proposed name for what might be called "series" — it covers both
real-model references ("TR-808 Collection") and curated sets ("PC Engine Waveforms").

```jsonc
{
  // Identity
  "id": "dx7-brass-warm",
  "version": "1.2.0",
  "fork_of": "dx7-brass@1.0.0", // lineage — null if original

  // Authorship
  "author": "okamura",
  "license": "CC-BY-4.0", // CC0 | CC-BY | proprietary | ...
  "created_at": "2026-04-10",
  "updated_at": "2026-04-10",

  // Classification (Cubase-style browsing)
  "category": "Brass", // Pad | Lead | Bass | Brass | Strings |
  // Keys | Pluck | Organ | Drums | SFX | ...
  "collection": "DX7 Voices", // real model or curated set name
  "tags": ["warm", "sustain", "fm"], // freeform keywords

  // Technical
  "chip": "YM2612", // target chip — required
  "patch_type": "voice", // voice | effect | sequence
  "base_note": 60, // MIDI note for preview / tuning reference
  "polyphony": "mono", // mono | poly
  "mmlisp_version": "0.1", // minimum MMLisp spec version required

  // UX
  "description": "Warm brass lead, good for slower melodic lines.",
  "demo_url": "https://www.youtube.com/watch?v=...", // finished work link (YouTube, SoundCloud, etc.),
}
```

**Category vocabulary** (aligned with GM / Cubase conventions, chip-music friendly):

`Pad` · `Lead` · `Bass` · `Brass` · `Strings` · `Keys` · `Pluck` · `Organ` ·
`Choir` · `Pipe` · `Drums` · `Percussion` · `SFX` · `Ambient` · `Noise`

### Fork & collaboration (GitHub model)

- Any uploaded patch can be **forked** — publish a derived version under your own name
- Reverse lineage links are preserved so the full derivation tree is browsable
- "Suggest improvement" flow (PR-style) back to the original author
- Example: `dx7-brass` → fork → `dx7-brass-warmer` (user B) → fork → `dx7-brass-warmer-megadrive` (user C)

### Multi-chip expansion

Primary target is YM2612 (Mega Drive), but the community vision covers:

| Chip          | System                  | Type                            |
| ------------- | ----------------------- | ------------------------------- |
| YM2612        | Sega Mega Drive         | FM (OPN2) — current baseline    |
| YM2151        | arcade, X68000          | FM (OPM)                        |
| YM2413        | Sega Master System, MSX | FM (OPLL, ROM voices)           |
| SID 6581/8580 | Commodore 64            | analog multi-mode filter        |
| 2A03 / RP2A07 | NES / Famicom           | pulse + triangle + noise + DPCM |
| HuC6280       | PC Engine               | wavetable (32-byte waveforms)   |

Each chip needs its own target profile, register encoder, and JS emulator.
The IR layer is designed to be chip-agnostic; only the backend (mmlisp2mmb + driver) is chip-specific.

### Monetization

- Per-patch wallet / Stripe link for tip-jar donations
- Optional paid patches (pay-to-download)
