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
