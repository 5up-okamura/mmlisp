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

No production code yet. This repository currently contains draft specs and
scaffold directories for implementation phases.

## Key Draft Documents

1. docs/spec-v0.1-draft.md
2. docs/command-table-v0.1-draft.md
3. docs/ir-v0.1-draft.md
4. docs/gmb-format-v0.1-draft.md
5. docs/freeze-checklist-v0.1.md
6. docs/opcode-mapping-provisional-v0.1.md
7. docs/reviews/freeze-candidate-template.md
8. docs/compiler-contract-v0.1-draft.md

## Next Local Steps

1. Add semantic diagnostics and validation rules to source-to-IR compiler.
2. Implement first IR to GMB writer path for demo data.
3. Export and validate first .gmb artifacts in examples/gmb.
4. Iterate freeze review notes in docs/reviews.
