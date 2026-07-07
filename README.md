# MMLisp

MMLisp is a Lisp-like music language for the Sega Mega Drive (YM2612 FM +
SN76489 PSG). You write scores as s-expressions, audition them instantly in a
browser authoring environment running a cycle-accurate chip emulator, and
compile them to a compact binary for a Z80 sound driver — with a design built
around *interactive* music: tracks that start, stop, layer, and respond to
game state at runtime.

- **Try it now:** https://mmlisp.vercel.app/
- **Playback driver:** MMLispDRV (Z80, SGDK integration) — trace-verified
  against the JS reference in emulation.

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
- **3-channel PCM, software-mixed.** `pcm1`–`pcm3` mix in software to the single
  DAC, so a kick, a bass hit, and a sample can sound together.
- **Interactive by design.** Tracks start / stop / layer / fade at runtime, and
  `def-val` slots let game code drive parameters live via `$name` — built for
  game music, not just linear playback.
- **Keeps the 68000 free.** Compiles to a compact (~6 KB) autonomous Z80 driver,
  **MMLispDRV**, that runs off the vblank interrupt on its own — the main CPU
  stays yours for the game. SGDK integration included. (Verified in emulation;
  real-hardware bring-up is the next milestone.)
- **Provably faithful.** Every register write the Z80 driver makes is checked
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

(score :tempo 112
  (fm1 epiano :oct 4 :len 8      ; FM electric piano, arpeggiated line
    c e g b > c e d c <)

  (sqr1 :oct 5 :len 4 :vel 9     ; PSG square counter-line
    e g a b)

  (noise :len 8 hat              ; PSG noise as a hi-hat via a velocity macro
    c c c c  c c c c))
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

- CodeMirror editor with MMLisp syntax highlighting, autocomplete, and
  format-on-demand
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

MMLispDRV plays a compiled score (`.mmb`) on the Mega Drive's Z80, driven by the
60 Hz vblank interrupt and controlled by the 68000 through a small mailbox
(start / stop / fade tracks, live parameter and value writes). It plays
everything the language expresses — FM + PSG voices and the full level model,
motion (sweeps / glide / vibrato / tempo ramps), FM3 independent-operator mode
and CSM, the macro engine, dynamic value slots, and 3-channel PCM soft-mixing —
reading song data from banked ROM so it needs only ~6 KB of Z80 RAM, and leaves
the 68000 free for the game.

It's built reference-first: a JS implementation (`drv-player.js`) validated in
MMLisp Live, then a Z80 assembly port whose **every register write is checked
byte-for-byte against it at zero tolerance** (18 trace scores, `drv/`). The
driver is verified in emulation today; real-hardware bring-up is the next
milestone. See [docs/driver.md](docs/driver.md) for the architecture,
[drv/README.md](drv/README.md) for the port and verification, and
[docs/roadmap.md](docs/roadmap.md) for detailed status.

## Repository Structure

- `docs/` — language reference, driver design, formats
- `live/` — MMLisp Live web authoring environment (editor, compiler, player)
- `drv/` — MMLispDRV Z80 driver: assembly source, first-party toolchain
  (assembler, Z80 emulator, trace harness), and SGDK integration
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
