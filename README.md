# MMLisp

MMLisp is a Lisp-like music language for the Sega Mega Drive (YM2612 FM +
SN76489 PSG). You write scores as s-expressions, audition them instantly in a
browser authoring environment running a cycle-accurate chip emulator, and
compile them to a compact binary for a Mega Drive sound driver — with a design
built around *interactive* music: tracks that start, stop, layer, and respond to
game state at runtime.

- **Try it now:** https://mmlisp.vercel.app/
- **Playback driver:** MMLispDRV (68k sequencer + Z80 PCM/write engine, SGDK
  integration) — trace-verified against the JS reference in emulation.

## Highlights

- **Music as code, not a tracker.** Scores are Lisp s-expressions — name a voice
  once and reuse it, factor phrases into definitions, build envelopes and LFOs
  from composable curves, expand echoes and arpeggios at compile time. A
  programming language's expressiveness, aimed at the YM2612 + PSG.
- **Hear it instantly, accurately.** [MMLisp Live](https://mmlisp.vercel.app/)
  auditions your score in the browser through a cycle-accurate **Nuked-OPN2**
  (YM2612) core — the same register writes the real chip sees — and hot-swaps
  the recompiled score without stopping playback.
- **Deep FM expression as language features.** Per-operator envelope/LFO macros,
  cent-accurate glide and vibrato, **FM3 independent-operator mode** and CSM,
  chiptune arpeggios (`:semi`) and drum rolls (`:keyon`) — advanced YM2612
  techniques you write, not hand-poke.
- **PCM on the DAC.** `pcm1`–`pcm3` play samples through the fm6 DAC (the
  browser mixes all three; the hardware driver plays one voice today).
- **Interactive by design.** Tracks start / stop / layer / fade at runtime, and
  `def-val` slots let game code drive parameters live via `$name` — built for
  game music, not just linear playback.
- **Built for a game's frame.** **MMLispDRV** splits across both CPUs: the
  68000 sequences the score a frame ahead and releases it on the video clock,
  and the Z80 keeps a fixed-rate DAC clock of its own. A heavy game frame delays
  nothing that was ready. SGDK integration included. (Verified in emulation;
  real hardware is next.)
- **Provably faithful.** Every register write the driver makes is checked
  **byte-for-byte** against a JS reference at zero tolerance — so what you hear
  in the browser is what the driver emits.
- **Bring your own voices.** Import FM patches from DefleMask (DMP), Furnace
  (FUI), TFI, VGI, OPNI, and mucom88 `.muc` / `.dat` banks.

## What it looks like

```lisp
(def epiano :alg 4 :fb 2
  :ar1 31 :dr1 8 :sr1 2 :rr1 8 :sl1 2 :tl1 28 :ks1 0 :ml1 2 :dt1 3
  :ar2 31 :dr2 12 :sr2 3 :rr2 8 :sl2 3 :tl2 4 :ks2 0 :ml2 1 :dt2 0
  :ar3 31 :dr3 8 :sr3 2 :rr3 8 :sl3 2 :tl3 32 :ks3 0 :ml3 6 :dt3 -3
  :ar4 31 :dr4 12 :sr4 3 :rr4 8 :sl4 3 :tl4 4 :ks4 0 :ml4 1 :dt4 0)

(def hat (macro :vel [15 8 2]))

(fm1 :tempo 112 epiano :oct 4 :len 8      ; FM electric piano, arpeggiated line
  c e g b > c e d c <)

(sqr1 :oct 5 :len 4 :vel 9     ; PSG square counter-line
  e g a b)

(noise :len 8 hat              ; PSG noise as a hi-hat via a velocity macro
  c c c c  c c c c)
```

Paste it into [MMLisp Live](https://mmlisp.vercel.app/), press Cmd/Ctrl+Enter,
and you get an FM e-piano arpeggio over a square-wave line with a ticking
noise hat — synthesized by the same register writes the real chips would see.

Beyond notes, the language gives you envelopes and LFOs as composable curve
macros (`(macro :tl1 (sin :from 20 :to 30 :len 4))`), chiptune arpeggios and
drum rolls (`:semi` / `:keyon`), compile-time echo and delay expansion, FM3
special modes (independent-operator, CSM), PCM tracks, and live-controllable
parameters (`def-val` sliders / `$name`) designed to be driven by game code.

## MMLisp Live (web authoring environment)

`live/` hosts the full authoring workflow in the browser — no install:

- CodeMirror editor with MMLisp syntax highlighting, template completions,
  format-on-demand, and structure help (bracket auto-close, enclosing-form
  highlight, unmatched-bracket marks, select-by-form)
- Hot-swap compile on edit: the score rebuilds while playing and resumes at
  the next bar boundary
- Accurate FM sound via a Nuked-OPN2 (YM2612) WebAssembly core in an
  AudioWorklet
- FM parameter panel: per-channel ALG/FB and per-operator sliders, updated
  live from playback and editable while the song runs
- Dynamic Parameters panel: one slider per `def-val` slot, driving `$name`
  values in real time
- Channel strips (select / mute / solo), keyboard note preview, and
  keyboard-driven step input
- FM voice import: DefleMask DMP, Furnace FUI, TFI, VGI, OPNI
- mucom88 `.muc` / `.dat` song and voice-bank import
- VGM and WAV export; open/save `.mmlisp` sources with the File System
  Access API

```
cd live && npm run serve        # dev server on :5173 (serve:https for HTTPS)
```

## MMLispDRV (the hardware driver)

MMLispDRV plays a compiled score (`.mmb`) using both Mega Drive CPUs. The
**68000** runs the sequencer — it walks the score, runs the tick accumulators,
sweeps and macros, composes levels and pitch, and renders each frame into
register writes, which it hands to the Z80 in short bus grabs from the VBlank
and HBlank interrupts. The **Z80** keeps a fixed 9,987.57 Hz DAC clock from its
own instruction stream, plays a PCM voice on it, and puts the FM writes on the
YM2612 between samples ([docs/driver.md](docs/driver.md)).

It plays FM + PSG voices and the full level model, motion (sweeps / glide /
vibrato / tempo ramps), FM3 independent-operator mode and CSM, the macro
engine, dynamic value slots, and one PCM voice. Sound effects and more PCM
voices are not on the hardware driver yet (driver.md §11).

It's built reference-first: a JS implementation (`drv-player.js`) validated in
MMLisp Live, then a C sequencer whose **every register write is checked
byte-for-byte against it at zero tolerance** (41 scores), and an SGDK build
graded write by write and DAC byte by DAC byte in an emulator. See
[docs/driver.md](docs/driver.md) for the architecture,
[drv/README.md](drv/README.md) for building and verification, and
[docs/roadmap.md](docs/roadmap.md) for status.

## Repository Structure

- `docs/` — language reference, driver design, formats
- `live/` — MMLisp Live web authoring environment (editor, compiler, player)
- `drv/` — MMLispDRV: the 68k sequencer, the Z80 engine generator, SGDK
  integration, and a first-party toolchain (assembler, Z80 emulator, gates)
- `examples/` — demo songs and test assets
- `tools/` — command-line compiler and validation scripts
- `mmlisp-syntax/` — VS Code TextMate grammar for `.mmlisp`
- `player/`, `third_party/` — chip emulator cores (Nuked-OPN2 WASM build)

File extensions: `.mmlisp` (source score) · `.mmb` (compiled binary song data).

## Documents

- [docs/language.md](docs/language.md) — canonical language reference
- [docs/guide.md](docs/guide.md) — composer's guide (tutorial)
- [docs/ir.md](docs/ir.md) — IR JSON reference (compiler output)
- [docs/mmb.md](docs/mmb.md) — MMB binary container format
- [docs/opcodes.md](docs/opcodes.md) — MMB opcode and target tables
- [docs/driver.md](docs/driver.md) — MMLispDRV architecture and milestones
- [docs/roadmap.md](docs/roadmap.md) — project roadmap and version history

## MMLisp Live — Keyboard Shortcuts

| macOS         | Windows / Linux | Action               |
| ------------- | --------------- | -------------------- |
| `Cmd+Return`  | `Ctrl+Enter`    | Play / Pause         |
| `Cmd+.`       | `Ctrl+.`        | Stop                 |
| `Cmd+Shift+F` | `Ctrl+Shift+F`  | Format current score |

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
