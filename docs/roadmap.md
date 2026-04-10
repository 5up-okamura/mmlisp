# GMLisp Roadmap

## Phase 0: Spec and Authoring Validation

- Define language subset and IR
- Build minimal web playback validation path
- Produce demo songs and prune unnecessary commands
- Freeze v0.1

Current concrete outputs:

1. v0.1 spec draft
2. command table draft
3. IR draft
4. GMB format draft
5. freeze checklist

## Phase 1: Web Authoring Environment (GMLisp Live)

- Editor and diagnostics
- Transport controls and marker/loop visualization
- Parameter modulation panel
- Runtime intervention simulator

Phase 1 exit signal:

1. Demo songs can be edited and auditioned end-to-end in the web workflow

## Phase 2: Compiler and Format Stabilization

- Source parser and AST
- IR generation
- GMB binary writer
- Compatibility/version checks

Phase 2 exit signal:

1. Deterministic IR and GMB outputs for freeze demos

## Phase 3: Driver Implementation (GMLDRV)

- Minimal event playback on SGDK target
- Incremental command support based on frozen spec
- Performance/cycle-budget tuning

Phase 3 entry condition:

1. v0.1 freeze checklist complete

## Phase 4: Integration and Demo

- End-to-end toolchain: source to GMB to SGDK playback
- Example game-scene mappings for interactive music
- Documentation and migration notes for v0.2

## Immediate Local Backlog

1. Fill demo1-stage-loop and demo2-event-recovery with validation phrases
2. Produce initial IR snapshots in examples/ir
3. Produce initial GMB exports in examples/gmb
4. Record first actionable freeze review using docs/reviews template

---

## Future Vision (post-MVP ideas)

### GML `import` system

```lisp
(import "reverb"    :from :stdlib)
(import "dx7-brass" :from :patches)
(import "my-arp"    :from "https://gml.community/patches/okamura/arp01")
```

- `import` resolves at compile time and folds into IR — no runtime dependency
- Patch types:
  - **Function effects** (delay, arpeggiator, LFO, ...) — implementable in the ir-player.js scheduler layer
  - **FM voices** — define as a `VOICE_LOAD` opcode in v0.2 scope
- Version pinning (`@1.2.3`) is required for reproducibility

### Patch server / community

- `GET /patches/:slug[@version]` → GML snippet or FM voice JSON
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
Cloudflare R2      — patch files (.gml / voice .json) + index.json
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
  "gml_version": "0.1", // minimum GML spec version required

  // UX
  "description": "Warm brass lead, good for slower melodic lines.",
  "demo_url": "https://www.youtube.com/watch?v=..."  // finished work link (YouTube, SoundCloud, etc.),
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
The IR layer is designed to be chip-agnostic; only the backend (gml2gmb + driver) is chip-specific.

### Monetization

- Per-patch wallet / Stripe link for tip-jar donations
- Optional paid patches (pay-to-download)
