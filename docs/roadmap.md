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

v0.2 planned additions (design in progress):

- Cmd+Enter play/pause toggle; Cmd+. full stop
- Marker-based playback start from cursor position
- Named FM/PSG voice data via `def :fm` / `def :psg`
- same-ch bgm collision diagnostic
- modulator track note/LFO separation; `:reset-on-note` option
- PWA top bar UI; FM params slide-in panel; line numbers

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

## Backlog

1. Implement Cmd+Enter pause/resume and Cmd+. stop (spec-v0.2 §1.1)
2. Cursor-line seek from source map (spec-v0.2 §1.11)
3. Named FM/PSG voice data via `def :fm` / `def :psg` (spec-v0.2 §1.2, §1.7)
4. Freeze IR-to-GMB opcode table
5. Begin MMLispDRV implementation (Phase 3)
6. Finalize FM patch vector column order and add example to spec-v0.2-draft.md
7. Resolve open questions in docs/spec-v0.2-draft.md §2 before implementing

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
  - **FM voices** — define as a `VOICE_LOAD` opcode in v0.2 scope
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
