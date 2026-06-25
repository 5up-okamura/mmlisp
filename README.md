# MMLisp

MMLisp is an interactive music authoring system for retro video game hardware.

- Web authoring environment: https://mmlisp.vercel.app/
- Playback driver: MMLispDRV (Z80/SGDK target) — **not yet implemented**

## Current Stage

This repository starts with specification-first development:

1. Build and validate music ideas in the web environment.
2. Freeze format and command specs.
3. Implement MMLispDRV against the frozen spec.

## Repository Structure

- docs/: specifications and design notes
- tools/: compiler and validation tooling
- live/: MMLisp Live — web authoring environment
- examples/: demo songs and test assets
- mmlisp-syntax/: VS Code TextMate grammar for .mmlisp syntax highlighting

## File Extensions

- .mmlisp: source score
- .mmb: compiled binary song data

## Status

Implemented toolchain:

1. source (.mmlisp) → deterministic IR (.json)
2. IR comparison against canonical snapshots with strict semantic checks
3. MMB export and structural validation for demo artifacts
4. MMLisp Live (live/) — web authoring environment with chip emulator AudioWorklet, MMLisp editor, sound parameter panel

## Documents

**Current** — read these:

- [docs/spec-v0.5.md](docs/spec-v0.5.md) — canonical spec (FM3 independent-OP, CSM, PCM/DAC, TEMPO_SWEEP)
- [docs/spec-v0.4.md](docs/spec-v0.4.md) — v0.4 spec (reference)
- [docs/guide.md](docs/guide.md) — composer's guide (language reference for authors, v0.4)

**Reference** — format and pipeline contracts:

- [docs/commands.md](docs/commands.md) — command set definition
- [docs/ir.md](docs/ir.md) — IR JSON schema
- [docs/mmb.md](docs/mmb.md) — binary format
- [docs/opcodes.md](docs/opcodes.md) — opcode assignments (provisional)
- [docs/compiler.md](docs/compiler.md) — compiler pipeline contract
- [docs/driver.md](docs/driver.md) — decoder contract for MMLispDRV

**Legacy specs** — historical, superseded by v0.4/v0.5; no need to read:

- [docs/spec-v0.1.md](docs/spec-v0.1.md)
- [docs/spec-v0.2.md](docs/spec-v0.2.md)
- [docs/spec-v0.3.md](docs/spec-v0.3.md)

## MMLisp Live — Keyboard Shortcuts

| macOS         | Windows / Linux | Action               |
| ------------- | --------------- | -------------------- |
| `Cmd+Return`  | `Ctrl+Enter`    | Play / Pause         |
| `Cmd+.`       | `Ctrl+.`        | Stop                 |
| `Cmd+Shift+F` | `Ctrl+Shift+F`  | Format current score |

## Next Steps

1. Expand semantic diagnostics coverage beyond current marker/loop/target checks.
2. Freeze IR-to-MMB opcode table and argument packing.
3. Implement MMLispDRV on SGDK/Z80 target.

## Acknowledgements

This project directly references the following works in its design and implementation:

- **[SGDK (Sega Genesis Dev Kit)](https://github.com/Stephane-D/SGDK)** — Z80 driver infrastructure and toolchain conventions for Mega Drive homebrew.
- **[MDSDRV](https://github.com/superctr/MDSDRV)** — Sound driver for Sega Mega Drive. Invaluable reference for register usage patterns and real-hardware timing.
- **[PMD](https://en.touhouwiki.net/wiki/User:Mami/Music_Dev/PMD)** — Professional Music Driver for PC-98 by KAJA. Influenced the MML command model and track sequencing design.
- **[NDP](https://ndp.squares.net/web/)** — PSG sound driver and MML authoring tool for MSX by naruto2413. Influenced the score and MML authoring model.
- **[mucom88](https://github.com/onitama/mucom88)** — MML sound driver for the PC-8801 (OPNA) by Yuzo Koshiro, maintained by onitama; licensed CC BY-NC-SA 4.0. Referenced for the `.muc` / `.dat` import path — MML command model and clock-grid note timing.
- **[Furnace](https://github.com/tildearrow/furnace)** / **[DefleMask](https://www.deflemask.com/)** — Multi-system chiptune trackers referenced for tracker workflow, pattern sequencing, and chip-focused composition practices.

## License

MIT License — Copyright (c) 2026 Hiroshi Okamura (5&UP Inc.)

See [LICENSE](LICENSE) for the full text.

This repository also vendors `Nuked-OPN2` under `third_party/Nuked-OPN2`, which
is licensed separately under LGPL-2.1-or-later. See
`THIRD_PARTY_NOTICES.md` and `third_party/Nuked-OPN2/LICENSE`.

### mucom88 import

The `.muc` / `.dat` importer (`live/src/import-mucom.js`) is original code that
**interoperates with** the mucom88 file formats. It does not include any of
mucom88's source code, sound driver, or bundled voice data, so it does not place
MMLisp under mucom88's license. mucom88 itself is distributed under
**CC BY-NC-SA 4.0** (© Yuzo Koshiro; maintained by onitama).

Imported content remains the property of its original authors. You are
responsible for holding the rights to any `.muc` song or `.dat` voice bank you
convert, and any sample music by Yuzo Koshiro must be credited per mucom88's
terms, e.g. `"<Title> / Copyright (C) by Yuzo Koshiro"`.
