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
68k/mml_rate.h        GENERATED single-bank images' rate stamps (tools/gen-c-tables.mjs)
68k/mml_banked_rate.h GENERATED banked images' rate stamps (tools/emit-banked.mjs)
68k/*_main.c          host harnesses for c-gate and pairs-gate
sgdk/mmlispdrv.{c,h}  the SGDK host: engine bring-up, the pumps, the API
sgdk/mmlispdrv_bin.h  GENERATED single-bank engine images + ABI constants (tools/emit-bin.mjs)
sgdk/mmlispdrv_banked_bin.h  GENERATED block-banked engine images (tools/emit-banked.mjs)
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
node tools/emit-bin.mjs          # the engine images → sgdk/mmlispdrv_bin.h
node tools/emit-banked.mjs       # the multi-bank images → sgdk/mmlispdrv_banked_bin.h + 68k/mml_banked_rate.h
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
| `mirrors` | `68k/mml_rate.h`, `sgdk/mmlispdrv_bin.h` and `live/src/engine-images.js` carry the same single-bank images, and every generated artifact — those three and the banked ones (`sgdk/mmlispdrv_banked_bin.h`, `68k/mml_banked_rate.h`, `live/src/engine-banked-images.js`) — is what the generators build now |
| `selftest` | the assembler and the emulator against their own cases |
| `voice-hoist` | the voice-hoist pass moves time, never notes: every onset stays put and every moved voice write lands in silence, over the corpus and the SGDK example |
| `c-gate` | the C sequencer ≡ `live/src/drv-player.js`, byte for byte, over the corpus — every `tests/*.mmlisp` but the claim-gate twins (`corpus()` in `c-gate.mjs`) — and the SGDK example's bundle; the gate prints the count it ran |
| `c-gate:pal` | the same corpus on PAL-baked streams — the sequencer reads no frame rate, and this is what keeps it that way |
| `claim-gate` (and `:pal`) | a channel changes hands cleanly: modulators do not outlive their owner, and a part an effect displaced comes back exactly when the effect ends, in time with the song as if the effect had never fired (driver.md §2.2, §2.5) |
| `pairs-gate` | over c-gate's corpus: the C sequencer's frames in write order ≡ the reference's; `mmlpairs.c` ≡ `tools/pairs-model.mjs`, late grabs, leads 0–2, one/two grabs a frame (a banked score's pairs are `banked:gate`'s); the SGDK host's frame-view path ≡ the record path |
| `sgdk:lint` | the SGDK glue and example compile against a shim of SGDK |
| `engine:gate` | the three single-bank engine images (one per PCM voice count): intervals, every DAC byte against `live/src/pcm-model.js`, what each start and retarget applied, the chip's settling table, the expander's pairs |
| `engine:score` | real scores through the image each names, driven by the host model: FM writes per port, PSG bytes, DAC bytes, the clock, PCM-vs-FM sync |
| `verify:ab` | the drv-player ↔ ir-player A/B signatures (`tests/ab-baseline.json`) |
| `glide-gate` | a glide longer than its note slides on from where the pitch (or CSM rate) is — no jump at any key-on — and a note that does not glide starts at its own pitch (`tests/m4-glide-lag`, `tests/m4-csm-glide`; language.md §14) |
| `pal-gate` | a score baked for 50 Hz is the same music as the one baked for 60 (driver.md §12.8) |
| `pcm-ab` | the browser's IR preview sends the driver's PCM commands, each within a frame |
| `pcm-loop` | each note plays the loop the score says (`tests/m4-pcm-loop-mode.mmlisp`): the note's `:mode` decides, track loop writes before a note are the note's and stay |
| `banked:gate` | multi-bank PCM (docs/pcm-multibank.md): the `.smp` format (directory bank, whole 32 KiB banks, silence pages, relocation that keeps ids and aliases), the C sequencer ≡ `drv-player.js` on banked scores at 60 and 50 Hz, the banked converter's grab reservation and fences (`tests/banked-pairs.c`), auto-expansion, the bundle, corrupt banks refused |
| `multibank:gate` | the banked engine images on the JS machine with the real nine-bit bank latch: intervals, every DAC byte against `live/src/pcm-banked-model.js`, what each start and retarget applied, the pair schedule, and that its own faults are caught |

On the machine (needs SGDK, the m68k toolchain, and `sh blastem/setup.sh`):

```
npm run sgdk:gate -- <score.mmlisp> [--seconds N] [--burn N]   # build, run, grade
npm run sgdk:profile -- <score.mmlisp> [--pc] [--peak N]       # where the 68000's time goes
```

Other tools: `npm run engine:gate:negatives` (the light gate's own faults
must fail), `npm run emit-images` (regenerate `live/src/engine-images.js`),
`npm run pcm-render -- <score> [--seconds N] [--out F.wav]` (the score's PCM as
the DAC plays it, for listening; into `out/pcm-render/`), `npm run pcm-trace --
<score> [--frames N] [--list N]` (what both sequencers tell the PCM voices,
decoded, for a score that sounds wrong on the machine), and `npm run
light-study` (the highest rate the generator places at each voice count — where
the images' periods come from).

## Tools

| file | role |
| --- | --- |
| `z80asm.mjs`, `z80cpu.mjs`, `selftest.mjs` | first-party Z80 assembler and emulator (documented T-states, including the memory cycle every `(HL)` operand pays) |
| `machine.mjs` | the Mega Drive slice the engine runs in: YM2612 ports with a timer model from the chip, the bank register, PSG, the 68000's bus grab as injected stopped time |
| `probe-analysis.mjs` | reading the probe BlastEm's event log |
| `build-engine.mjs`, `emit-bin.mjs` | assemble the generated engine; emit the images' header |
| `build-multibank.mjs`, `emit-banked.mjs`, `multibank-*.mjs` | the multi-bank engine: build, emit its headers, model, run and render it |
| `multibank-render.mjs` | a score's banked PCM through the banked engine model, as a WAV (a listening aid; its sample file is not a production `.smp`) |
| `banked-sgdk-gate.mjs` | the banked host on BlastEm: the SGDK example built with a score, graded against the engine model and the sequencer (`banked:sgdk`, below) |
| `gen-test-sample.mjs` | writes `tests/pcmbank.wav`, the synthesized PCM fixture the loop gates play |
| `pcm-trace.mjs` | the PCM commands from both sequencers for one score, decoded and checked (`npm run pcm-trace`) |
| `bundle.mjs` | several scores against one sample bank (a game's songs) |
| `emit-images.mjs` | the light images' descriptors into `live/src/engine-images.js` |
| `gen-c-tables.mjs`, `c-tables.mjs` | the sequencer's tables — into the tree, or into a gate's temp directory |
| `mmb-build.mjs`, `wav.mjs` | `.mmlisp` → MMB (+ sample bank) through the live toolchain |
| `pairs-model.mjs` | the JS twin of `mmlpairs.c` |
| `c-gate.mjs`, `pairs-gate.mjs`, `engine-*-gate.mjs`, `ab-gate.mjs`, `glide-gate.mjs`, `claim-gate.mjs`, `voice-hoist-gate.mjs`, `pal-gate.mjs`, `pcm-ab-gate.mjs`, `pcm-loop-gate.mjs`, `banked-export-gate.mjs`, `multibank-gate.mjs`, `rate-mirrors.mjs` | the gates above |
| `light-study.mjs` | the image-rate study |
| `pcm-render.mjs` | a score's PCM through the engine model, as a WAV at the image's rate |
| `onset-timing.mjs` | how late each FM key-on reaches the chip through the light engine, and what the frames ahead of it held |
| `sgdk-project.mjs`, `sgdk-gate.mjs`, `sgdk-profile.mjs`, `sgdk-lint.mjs`, `sgdk-shim/` | the SGDK build path and its gates |
| `install-sgdk.mjs` | install the driver into an SGDK project |

The toolchain has no binary dependencies: the whole verify loop runs wherever
node runs. The assembler and the emulator reject anything outside their subset
(unknown mnemonic at assembly, unknown opcode at execution), so they cannot
silently diverge.

## Multi-bank PCM tools

For export, browser playback, capacity limits, and SGDK usage, see
[Multi-bank PCM](../docs/pcm-multibank.md). `banked:gate` and `multibank:gate`
run inside `verify:all`; the rest need SGDK and the patched BlastEm and leave
recordings and reports under `out/`:

```sh
npm run banked:sgdk -- tests/multibank.mmlisp --seconds 8 [--pal] [--minimal] [--lead N] [--ahead N]
npm run multibank:render -- tests/multibank.mmlisp --seconds 6 --out out/multibank
```

`banked:sgdk` builds the SGDK example with the score, runs it, and grades the
DAC against the engine model, the FM and PSG streams against the sequencer (the
FM order through `prioritizeFmNotes` in `pairs-model.mjs`, the reference for
`banked_writes` in `mmlpairs.c`, `$2B` graded apart since it rides the PCM
lane), the bus loss, the key-on interval error, and the PCM-vs-FM onset lag:
each start's first output sample against the median FM key-on, both measured
from their frame's video time (`pcmOnset`). `tests/onset-3v.mmlisp` is the
score for that lag: FM chords keyed with a three-voice kit, with voice changes.
`--lead N` builds the host with `MMLISP_LEAD=N` (frames rendered ahead of their
release) and `--ahead N` with `MMLISP_AHEAD=N` (pairs past the engine's index a
grab writes at), to compare a score's timing at other settings.
`multibank:render` renders a score through the banked engine model alone —
a listening aid; the sample file it writes is not a production `.smp`.
