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
- tools/: compiler and web tooling (planned)
- driver/: GMLDRV implementation (planned)
- examples/: demo songs and test assets (planned)

## Naming

- Project: GMLisp
- Web tool: GMLisp Live
- Driver: GMLDRV

## File Extensions (draft)

- .gml: source score
- .gmb: compiled binary song data

## Status

No production code yet. This is an initial spec and planning baseline.
