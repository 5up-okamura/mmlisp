# MMLispDRV — the driver

The Mega Drive sound driver for MMLisp scores: a sequencer on the 68000 and a
DAC/chip-write engine on the Z80. The design is `docs/driver.md`; the MMB it
plays is `docs/mmb.md` / `docs/opcodes.md`; integrating it into a game is
`sgdk/README.md`.

## Layout

```
68k/mmlispseq.{c,h}   the sequencer — plain C99, compiled into the game, and
                      for the host by the gates
68k/mmlpairs.{c,h}    the frame → {op, val} pair converter (driver.md §6.6)
68k/tables.c          GENERATED constant tables (tools/gen-c-tables.mjs)
68k/mml_rate.h        GENERATED engine images' rate stamps (tools/gen-c-tables.mjs)
68k/*_main.c          host harnesses for c-gate and pairs-gate
sgdk/mmlispdrv.{c,h}  the SGDK host: engine bring-up, the pumps, the API
sgdk/mmlispdrv_bin.h  GENERATED engine images + ABI constants (tools/emit-bin.mjs)
sgdk/example/         a minimal player program
engine/               the Z80 engine generator: config, the slot schedule and the
                      pair expander (gen-stream), the tables (lut)
tools/                build, install and gate tools (below)
tests/                gate scores (.mmlisp, host-command .cmds.json, samples)
blastem/              the headless probe BlastEm: setup.sh, host.c, probe.patch
out/                  gate reports, scratch projects, the built BlastEm (git-ignored)
```

## Build

```
cd drv
node tools/emit-bin.mjs          # engine image → sgdk/mmlispdrv.{bin,_bin.h}
node tools/gen-c-tables.mjs      # 68k/tables.c + 68k/mml_rate.h
node tools/install-sgdk.mjs <project> [--song score.mmlisp]   # into an SGDK project
node tools/mmb-build.mjs score.mmlisp song.mmb                # a score on its own
```

`install-sgdk` regenerates the artifacts before copying, and never overwrites a
project's `main.c` or `song.res` (`--help` lists the options).

## Verify

```
cd drv
npm run verify:all
```

| gate | what it proves |
| --- | --- |
| `mirrors` | `68k/mml_rate.h`, `sgdk/mmlispdrv_bin.h` and `live/src/engine-images.js` carry the same engine images, and the two generated files are what the images build to now |
| `selftest` | the assembler and the emulator against their own cases |
| `c-gate` | the C sequencer ≡ `live/src/drv-player.js`, byte for byte, 48 scores |
| `pairs-gate` | `mmlpairs.c` ≡ `tools/pairs-model.mjs`, late grabs, leads 0–2, one/two grabs a frame |
| `sgdk:lint` | the SGDK glue and example compile against a shim of SGDK |
| `engine:gate` | the three engine images (one per PCM voice count): intervals, every DAC byte against `live/src/pcm-model.js`, what each start and retarget applied, the chip's settling table, the expander's pairs |
| `engine:score` | real scores through the image each names, driven by the host model: FM writes per port, PSG bytes, DAC bytes, the clock, PCM-vs-FM sync |
| `verify:ab` | the drv-player ↔ ir-player A/B signatures (`tests/ab-baseline.json`) |
| `pcm-ab` | the browser's IR preview sends the driver's PCM commands, each within a frame |
| `pcm-loop` | each note plays the loop the score says (`tests/m4-pcm-loop-mode.mmlisp`): the note's `:mode` decides, track loop writes before a note are the note's and stay |

On the machine (needs SGDK, the m68k toolchain, and `sh blastem/setup.sh`):

```
npm run sgdk:gate -- <score.mmlisp> [--seconds N] [--burn N]   # build, run, grade
npm run sgdk:profile -- <score.mmlisp> [--pc] [--peak N]       # where the 68000's time goes
```

Other tools: `npm run engine:gate:negatives` (the light gate's own faults
must fail), `npm run emit-images` (regenerate `live/src/engine-images.js`),
`npm run level-diff -- <score>` (where the driver is louder than
ir-player), `npm run pcm-render -- <score> [--seconds N] [--out F.wav]` (the
score's PCM as the DAC plays it, for listening; into `out/pcm-render/`), and
`npm run light-study` (the highest rate the generator places at each voice
count — where the images' periods come from).

## Tools

| file | role |
| --- | --- |
| `z80asm.mjs`, `z80cpu.mjs`, `selftest.mjs` | first-party Z80 assembler and emulator (documented T-states, including the memory cycle every `(HL)` operand pays) |
| `machine.mjs` | the Mega Drive slice the engine runs in: YM2612 ports with a timer model from the chip, the bank register, PSG, the 68000's bus grab as injected stopped time |
| `probe-analysis.mjs` | reading the probe BlastEm's event log |
| `build-engine.mjs`, `emit-bin.mjs` | assemble the generated engine; emit the image and its header |
| `emit-images.mjs` | the light images' descriptors into `live/src/engine-images.js` |
| `gen-c-tables.mjs`, `c-tables.mjs` | the sequencer's tables — into the tree, or into a gate's temp directory |
| `mmb-build.mjs`, `wav.mjs` | `.mmlisp` → MMB (+ sample bank) through the live toolchain |
| `pairs-model.mjs` | the JS twin of `mmlpairs.c` |
| `c-gate.mjs`, `pairs-gate.mjs`, `engine-*-gate.mjs`, `ab-gate.mjs`, `pcm-ab-gate.mjs`, `rate-mirrors.mjs` | the gates above |
| `light-study.mjs` | the image-rate study |
| `pcm-render.mjs` | a score's PCM through the engine model, as a WAV at the image's rate |
| `sgdk-project.mjs`, `sgdk-gate.mjs`, `sgdk-profile.mjs`, `sgdk-lint.mjs`, `sgdk-shim/` | the SGDK build path and its gates |
| `install-sgdk.mjs` | install the driver into an SGDK project |
| `level-diff.mjs` | per-frame level comparison against ir-player |

The toolchain has no binary dependencies: the whole verify loop runs wherever
node runs. The assembler and the emulator reject anything outside their subset
(unknown mnemonic at assembly, unknown opcode at execution), so they cannot
silently diverge.
