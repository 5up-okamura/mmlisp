# Nuked WASM Backends (FM + PSG)

This folder contains the build scaffold for the high-accuracy YM2612 (FM) and
SEGA PSG backends used by the live tool and the standalone VGM player.

Chosen cores:

- `Nuked-OPN2` by `nukeykt` — cycle-accurate YM3438/YM2612-family FM core.
  License: LGPL-2.1-or-later.
- `Nuked-PSG` by `nukeykt` — cycle-accurate SEGA Mega Drive PSG (SN76489) core,
  the same core Furnace exposes as its accurate PSG option.
  License: GPL-2.0-or-later.

Local source layout:

```text
third_party/
  Nuked-OPN2/
    ym3438.c
    ym3438.h
  Nuked-PSG/
    ympsg.c
    ympsg.h
```

Generated output:

```text
player/wasm/dist/
  nuked-opn2.js
  nuked-psg.js
live/
   nuked-opn2.js
   nuked-psg.js
```

Build prerequisites:

- Emscripten (`emcc`, `em++`)
- Vendored `third_party/Nuked-OPN2`

Build:

```bash
player/wasm/build-nuked.sh   # FM (YM2612)
player/wasm/build-psg.sh     # PSG (SN76489)
```

If `emcc` aborts with a Python syntax error, point Emscripten at a modern
Python: `EMSDK_PYTHON=$(command -v python3.14) player/wasm/build-psg.sh`.

Integration notes:

1. `player/wasm/nuked_adapter.c` / `psg_adapter.c` wrap the upstream cores with
   a small C API. The FM adapter also streams the YM2612 DAC (registers 0x2b
   enable / 0x2a data) folded into the per-sample clock budget, so PCM plays
   through the real chip rather than a software mixer.
2. `build-nuked.sh` / `build-psg.sh` build single-file ES modules for
   AudioWorklet loading, and sync copies to `live/` for Vercel/static deploys
   that only publish the `live/` directory.
3. `live/worklet.js` loads the generated module and handles timed YM register
   writes.
4. `player/vgm-player.js` loads `../live/worklet.js` so both apps share the
   same worklet implementation.

Notes:

- The generated module is emitted as a single JS file containing embedded WASM.
- This keeps AudioWorklet loading simple while still using a real WASM core.
- The repo vendors the upstream source and license text so the library can be
  rebuilt or replaced locally.
