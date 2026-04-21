# MMLisp

MMLisp is an interactive music authoring system for retro video game hardware.

- Web authoring tool: https://mmlisp.vercel.app/
- Playback driver: MMLispDRV (Z80/SGDK target)

## Current Stage

This repository starts with specification-first development:

1. Build and validate music ideas in the web environment.
2. Freeze format and command specs.
3. Implement MMLispDRV against the frozen spec.

## Repository Structure

- docs/: specifications and design notes
- tools/: compiler and validation tooling
- driver/: web authoring environment (driver/web/) and future MMLispDRV target
- examples/: demo songs and test assets
- mmlisp-syntax/: VS Code TextMate grammar for .mmlisp syntax highlighting

## Naming

- Project: MMLisp
- Driver: MMLispDRV

## File Extensions

- .mmlisp: source score
- .mmb: compiled binary song data

## Status

Implemented toolchain:

1. source (.mmlisp) → deterministic IR (.json)
2. IR comparison against canonical snapshots with strict semantic checks
3. GMB export and structural validation for demo artifacts
4. Web authoring environment (driver/web/) with chip emulator AudioWorklet, MMLisp editor, sound parameter panel

## Documents

- docs/spec-v0.1.md — language and system specification (v0.1)
- docs/spec-v0.2.md — v0.2 design notes (in progress)
- docs/commands.md — command set definition
- docs/ir.md — IR JSON schema
- docs/gmb.md — binary format
- docs/opcodes.md — opcode assignments (provisional)
- docs/compiler.md — compiler pipeline contract
- docs/driver.md — decoder contract for MMLispDRV

## Next Steps

1. Expand semantic diagnostics coverage beyond current marker/loop/target checks.
2. Freeze IR-to-GMB opcode table and argument packing.
3. Implement MMLispDRV on SGDK/Z80 target.

## Acknowledgements

This project was inspired by and built with reference to the following works:

- **[SGDK (Sega Genesis Dev Kit)](https://github.com/Stephane-D/SGDK)** — Z80 driver infrastructure and toolchain conventions for Mega Drive homebrew.
- **[MDSDRV](https://github.com/superctr/MDSDRV)** — Sound driver for Sega Mega Drive. Invaluable reference for register usage patterns and real-hardware timing.
- **[NDP](https://ndp.squares.net/web/)** — PSG sound driver and MML authoring tool for MSX by naruto2413. Influenced the score and MML authoring model.
- **[Strudel](https://strudel.cc/)** — Live coding music environment (TidalCycles ported to JavaScript). Influenced the generative and pattern-based composition model.
- **[Opusmodus](https://opusmodus.com/)** — Common Lisp-based music composition system. Influenced the computational and algorithmic approach to score authoring.
- **[Pure Data](https://puredata.info/)** / **[Max](https://cycling74.com/products/max)** — Visual dataflow environments for audio and interactive media. Foundational influences on the idea of bringing modern compositional tooling to game music.
- **[glisp](https://github.com/baku89/glisp)** — Lisp-based creative coding environment by Baku Hashimoto. Influenced the MMLisp language design.

## License

MIT License — Copyright (c) 2026 Hiroshi Okamura (5&UP Inc.)

See [LICENSE](LICENSE) for the full text.
