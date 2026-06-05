# Nuked-OPN2 WASM Backend

This folder contains the build scaffold for the high-accuracy YM2612 backend
used by the standalone VGM player.

Chosen core:

- `Nuked-OPN2` by `nukeykt`
- Why: cycle-accurate YM3438/YM2612-family core, suitable for FM validation
- License: LGPL-2.1-or-later

Local source layout:

```text
third_party/
  Nuked-OPN2/
    ym3438.c
    ym3438.h
```

Generated output:

```text
player/wasm/dist/
  nuked-opn2.js
```

Build prerequisites:

- Emscripten (`emcc`, `em++`)
- Vendored `third_party/Nuked-OPN2`

Build:

```bash
player/wasm/build-nuked.sh
```

Integration notes:

1. `player/wasm/nuked_adapter.c` wraps the upstream core with a small C API.
2. `player/wasm/build-nuked.sh` builds a single-file ES module for AudioWorklet
   loading.
3. `player/nuked-worklet.js` loads the generated module and handles timed YM
   register writes.
4. `live/worklet.js` can reuse the same generated backend while PSG and PCM stay
   on the existing path.

Notes:

- The generated module is emitted as a single JS file containing embedded WASM.
- This keeps AudioWorklet loading simple while still using a real WASM core.
- The repo vendors the upstream source and license text so the library can be
  rebuilt or replaced locally.
