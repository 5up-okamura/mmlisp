# GMLisp Roadmap

## Phase 0: Spec and Authoring Validation

- Define language subset and IR
- Build minimal web playback validation path
- Produce demo songs and prune unnecessary commands
- Freeze v0.1

## Phase 1: Web Authoring Environment (GMLisp Live)

- Editor and diagnostics
- Transport controls and marker/loop visualization
- Parameter modulation panel
- Runtime intervention simulator

## Phase 2: Compiler and Format Stabilization

- Source parser and AST
- IR generation
- GMB binary writer
- Compatibility/version checks

## Phase 3: Driver Implementation (GMLDRV)

- Minimal event playback on SGDK target
- Incremental command support based on frozen spec
- Performance/cycle-budget tuning

## Phase 4: Integration and Demo

- End-to-end toolchain: source to GMB to SGDK playback
- Example game-scene mappings for interactive music
- Documentation and migration notes for v0.2
