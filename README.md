# GMLisp

GMLisp is an interactive music authoring system for Mega Drive game development.

- Authoring tool: GMLisp Live (web editor)
- Playback driver: GMLDRV (Z80/SGDK target)

## Current Stage

This repository starts with specification-first development:

1. Build and validate music ideas in the web environment.
2. Freeze format and command specs.
3. Implement GMLDRV against the frozen spec.

## Planned Repository Structure

- docs/: specifications and design notes
- tools/: compiler and web tooling
- driver/: GMLDRV implementation
- examples/: demo songs and test assets

## Naming

- Project: GMLisp
- Web tool: GMLisp Live
- Driver: GMLDRV

## File Extensions (draft)

- .gml: source score
- .gmb: compiled binary song data

## Status

Draft implementation in progress.

Implemented toolchain stage:

1. source (.gml) -> deterministic IR (.json)
2. IR comparison against canonical snapshots with strict semantic checks
3. draft GMB export and structural validation for demo artifacts

## Key Draft Documents

1. docs/spec-v0.1-draft.md
2. docs/command-table-v0.1-draft.md
3. docs/ir-v0.1-draft.md
4. docs/gmb-format-v0.1-draft.md
5. docs/freeze-checklist-v0.1.md
6. docs/opcode-mapping-provisional-v0.1.md
7. docs/reviews/freeze-candidate-template.md
8. docs/compiler-contract-v0.1-draft.md
9. docs/gmldrv-decoder-contract-v0.1-draft.md

## Next Local Steps

1. Expand semantic diagnostics coverage beyond current marker/loop/target checks.
2. Freeze IR-to-GMB opcode table and argument packing.
3. Cross-check generated GMB with decoder-side compatibility fixtures.
4. Iterate freeze review notes in docs/reviews.
