# MMLisp Roadmap

## Phase 0: Spec and Authoring Validation ✓

- Define language subset and IR
- Build minimal web playback validation path
- Produce demo songs and prune unnecessary commands
- Freeze v0.1

Status: **complete** — v0.1-candidate tag at b61eb11 (2026-04-09).

Outputs:

1. docs/spec-v0.1.md
2. docs/commands.md
3. docs/ir.md
4. docs/gmb.md

## Phase 0.5: Editor Tooling ✓

- VS Code syntax highlighting via custom TextMate grammar (mmlisp-syntax/)
- Format-on-save via format-mmlisp.js

Status: **complete**.

## Phase 1: Web Authoring Environment (MMLisp Live)

- Editor and diagnostics
- Transport controls and marker/loop visualization
- Parameter modulation panel
- Runtime intervention simulator

Current status: partially implemented (live/). See docs/spec-v0.2.md for planned additions.

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
- GMB binary writer
- Compatibility/version checks

Status: **complete** — deterministic IR and GMB outputs verified for both demo artifacts.

## Phase 3: Driver Implementation (MMLispDRV)

- Minimal event playback on SGDK target
- Incremental command support based on frozen spec
- Performance/cycle-budget tuning

Phase 3 entry condition:

1. v0.1 freeze checklist complete

## Phase 4: Integration and Demo

- End-to-end toolchain: source to GMB to SGDK playback
- Example game-scene mappings for interactive music
- Documentation and migration notes for v0.2

## Language Version Status

| Version | Status      | Tag            | Themes                                                                      |
| ------- | ----------- | -------------- | --------------------------------------------------------------------------- |
| v0.1    | frozen      | v0.1-candidate | Core language, IR, GMB format                                               |
| v0.2    | frozen      | v0.2-freeze    | FM/PSG voices, modulator, UI, source map                                    |
| v0.3    | frozen      | v0.3-freeze    | seq, gate, shuffle, track append, voice reference, relative volume controls |
| v0.4    | in-progress | —              | Envelopes/macros, multi-stage macro, pitch env, PSG noise, pan, level model |

### v0.4 Implementation Progress

#### Compiler (live/src/mmlisp2ir.js)

**Syntax / Language**

- [x] Channel name forms `(fm1 ...)` / `(sqr1 ...)` / `(noise ...)`
- [x] Inline `:key val` → `PARAM_SET`
- [x] Inline `:key (curve ...)` → `PARAM_SWEEP`
- [x] `def` bare reference (no `@` sigil required)
- [x] `(x N ...)` loop + `:break` / `LOOP_BREAK`
- [x] Subgroup / tuplet `(e g a)` with Bresenham tick distribution
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
- [x] Step-vector `:loop` — loop sustain region until gate (all targets)
- [x] Step-vector `:release` — release region played after gate (all targets)
- [x] `_` hold token in step-vector — advances 1 frame, skips write (all targets)
- [x] Single curve form `(ease-in :from ... :to ... :len ...)`
- [x] Looping single-stage curve `(sin ...)` / `(triangle ...)`
- [x] Multi-stage form `[(stage1) (stage2) ...]` — stages run sequentially by own `:len`
- [x] `(wait N)` / `(wait Nf)` pause stage inside multi-stage
- [x] `(wait key-off)` — stage loops until gate, then advances; curve-form equivalent of `:release`

_Symbolic → numeric coercion at compile time (all targets):_

- [x] `:pan` — `left` / `center` / `right` → -1 / 0 / +1
- [x] `:mode` — `white0`–`white3` / `periodic0`–`periodic3` → 0–7
- [ ] Curve/function output for `:pan` — snap to -1 / 0 / +1
- [ ] Curve/function output for `:mode` — snap to integer 0–7

_Compiler — `parseMacroSpec` refactor:_

- [x] `:macro :vel` parsed via `parseVelMacroSpec` (current, pre-unification)
- [x] `:macro :pitch` parsed via `parseCurveSpec` (current, single curve only)
- [x] Unify into single `parseMacroSpec(node, target)` covering all forms + all targets
- [x] `collectDefs` emits unified `{ tag: "macro", target, spec }` for all `:macro` defs

_Compiler — per-target gaps (after unification):_

- [x] `:macro :pitch` step-vector `[0 -100 :loop -200 :release 0]`
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
- [x] FM vel macro — sustain loop (`:loop`) / release tail (`:release`)
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
- [x] PSG vel macro — sustain loop (`:loop`) / release tail (`:release`)
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

6. ~~`:macro :pitch` step-vector + `:loop` / `:release`~~ (done — falls out of unified parseMacroSpec/scheduleMacro)
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
    | v0.5 | planned | — | FM3 independent-OP mode, CSM, PCM/DAC |

## Backlog

Done (confirmed implemented, not yet removed from backlog):

- ~~Cmd+Enter pause/resume and Cmd+. stop~~ — live/index.html L978
- ~~Cursor-line seek from source map~~ — IRPlayer.playFromLine() in ir-player.js
- ~~Named FM/PSG voice data (legacy voice-def syntax)~~ — implemented in compiler + player pipeline (v0.2 era)
- ~~Mid-track default-state mutation~~ — implemented (see spec-v0.3 §1.2; guide §6)
- ~~FM patch vector column order~~ — confirmed `[AR DR SR RR SL TL KS ML DT (SSG) (AMen)]`; spec-v0.2 §2.5

Active:

1. Freeze IR-to-GMB opcode table
2. Begin MMLispDRV implementation (Phase 3)
3. Furnace/DefleMask voice data interoperability (spec-first, then implementation)

- Define canonical mapping from Furnace/DefleMask FM instrument fields to the new MMLisp voice schema
- Implement import path (converter + validation + diagnostics) in tools/compiler layer
- Add round-trip fixtures and compatibility tests before any patch-sharing/community rollout

v0.5 candidates:

- `defn` — compile-time function definition; returns note sequences or values computed
  from arguments. Arguments resolved at call site; output folded into IR via LUT.
  Enables numeric note input (semitone integers) from computed sequences.
- arpeggio macro (`:macro :pitch` with note/rest sequences)
- quantize snap (scale mask applied after pitch sum)
- OP mask (per-channel operator enable/disable)
- AMS/FMS macros

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
