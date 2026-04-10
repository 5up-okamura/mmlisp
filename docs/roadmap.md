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
- **Patch preview is a must-have**: before loading a voice or effect into a song,
  users need to audition it in-browser — single-note preview with the target chip

### Fork & collaboration (GitHub model)

- Any uploaded patch can be **forked** — publish a derived version under your own name
- Reverse lineage links are preserved so the full derivation tree is browsable
- "Suggest improvement" flow (PR-style) back to the original author
- Example: `dx7-brass` → fork → `dx7-brass-warmer` (user B) → fork → `dx7-brass-warmer-megadrive` (user C)

### Multi-chip expansion

Primary target is YM2612 (Mega Drive), but the community vision covers:

| Chip | System | Type |
|------|--------|------|
| YM2612 | Sega Mega Drive | FM (OPN2) — current baseline |
| YM2151 | arcade, X68000 | FM (OPM) |
| YM2413 | Sega Master System, MSX | FM (OPLL, ROM voices) |
| SID 6581/8580 | Commodore 64 | analog multi-mode filter |
| 2A03 / RP2A07 | NES / Famicom | pulse + triangle + noise + DPCM |
| HuC6280 | PC Engine | wavetable (32-byte waveforms) |

Each chip needs its own target profile, register encoder, and JS emulator.
The IR layer is designed to be chip-agnostic; only the backend (gml2gmb + driver) is chip-specific.

### Monetization

- Per-patch wallet / Stripe link for tip-jar donations
- Optional paid patches (pay-to-download)
