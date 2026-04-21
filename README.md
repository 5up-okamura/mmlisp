# GMLisp

GMLisp is an interactive music authoring system for Mega Drive game development.

- Authoring tool: GMLisp Live (web editor)
- Playback driver: GMLDRV (Z80/SGDK target)

## Current Stage

This repository starts with specification-first development:

1. Build and validate music ideas in the web environment.
2. Freeze format and command specs.
3. Implement GMLDRV against the frozen spec.

## Repository Structure

- docs/: specifications and design notes
- tools/: compiler and validation tooling
- driver/: web authoring environment (driver/web/) and future GMLDRV target
- examples/: demo songs and test assets
- gml-syntax/: VS Code TextMate grammar for .mmlisp syntax highlighting

## Naming

- Project: GMLisp
- Web tool: GMLisp Live
- Driver: GMLDRV

## File Extensions

- .gml: source score
- .gmb: compiled binary song data

## Status

Implemented toolchain:

1. source (.gml) → deterministic IR (.json)
2. IR comparison against canonical snapshots with strict semantic checks
3. GMB export and structural validation for demo artifacts
4. Web authoring environment (driver/web/) with YM2612 AudioWorklet, GML editor, FM parameter panel

Web player features:

- Ahead-of-time timestamped writes to AudioWorklet (timing error ≤ 2.7ms)
- Per-track independent loop scheduling with non-cumulative time base
- Automatic track→channel mapping from IR `track.channel` field
- CodeMirror 6 editor with GML syntax highlighting (One Dark), playhead line highlight
- Bar:Beat position counter, FM parameter sliders with real-time playback feedback

## Key Draft Documents

1. docs/spec-v0.1.md
2. docs/commands.md
3. docs/ir.md
4. docs/gmb.md
5. docs/opcodes.md
6. docs/compiler.md
7. docs/driver.md

## Next Steps

1. Expand semantic diagnostics coverage beyond current marker/loop/target checks.
2. Freeze IR-to-GMB opcode table and argument packing.
3. Implement GMLDRV on SGDK/Z80 target.

## Acknowledgements

This project was inspired by and built with reference to the following works:

- **[SGDK (Sega Genesis Dev Kit)](https://github.com/Stephane-D/SGDK)** — Z80 driver infrastructure and toolchain conventions for Mega Drive homebrew.
- **[MDSDRV](https://github.com/superctr/MDSDRV)** — Sound driver for Sega Mega Drive. Invaluable reference for register usage patterns and real-hardware timing.
- **[NDP](https://ndp.squares.net/web/)** — PSG sound driver and MML authoring tool for MSX by naruto2413. Influenced the score and MML authoring model.
- **[Strudel](https://strudel.cc/)** — Live coding music environment (TidalCycles ported to JavaScript). Influenced the generative and pattern-based composition model.
- **[Opusmodus](https://opusmodus.com/)** — Common Lisp-based music composition system. Influenced the computational and algorithmic approach to score authoring.
- **[Pure Data](https://puredata.info/)** / **[Max](https://cycling74.com/products/max)** — Visual dataflow environments for audio and interactive media. Foundational influences on the idea of bringing modern compositional tooling to game music.
- **[glisp](https://github.com/baku89/glisp)** — Lisp-based creative coding environment by Baku Hashimoto. Influenced the GMLisp language design.

The YM2612 emulator (`driver/web/src/ym2612.js`) was generated with AI assistance. The log-sin/exponent table approach and detune table values follow algorithms and constants documented in Yamaha OPN2 application notes and widely-referenced open-source OPN2 emulators (Nuked-OPN2, MAME, Genesis Plus GX). No source code was directly ported, but the numeric constants are ultimately derived from the same chip documentation those projects use.

## License

MIT License — Copyright (c) 2026 Hiroshi Okamura (5&UP Inc.)

See [LICENSE](LICENSE) for the full text.
