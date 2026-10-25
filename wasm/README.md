# WASM Sound Cores (YM2612, PSG, YM2608, YM2151, AY-3-8910, YM2413)

This folder holds the build scaffold for the chip cores MMLisp Live plays
through: the Mega Drive's YM2612 (FM) and SEGA PSG, the PC-8801's YM2608,
the X68000's YM2151, the MSX's AY-3-8910 and the FM-PAC's YM2413. The build
emits single-file ES modules and syncs them to `live/nuked-opn2.js`,
`live/nuked-psg.js`, `live/ymfm-ym2608.js`, `live/ymfm-ym2151.js`,
`live/ymfm-ay8910.js` and `live/ymfm-ym2413.js`, which are the copies the app
ships.

Chosen cores:

- `Nuked-OPN2` by `nukeykt` — cycle-accurate YM3438/YM2612-family FM core.
  License: LGPL-2.1-or-later.
- `Nuked-PSG` by `nukeykt` — cycle-accurate SEGA Mega Drive PSG (SN76489) core,
  the same core Furnace exposes as its accurate PSG option.
  License: GPL-2.0-or-later.
- `ymfm` by Aaron Giles — the YM2608 (OPNA): FM, SSG, the rhythm (ADPCM-A)
  and the ADPCM-B, the YM2151 (OPM), its SSG engine alone as the MSX's
  AY-3-8910, and the YM2413 (OPLL), the chips MAME runs. The OPN, OPM and
  OPL families' files are vendored (`ymfm_opl` includes `ymfm_pcm`, for the
  OPL4). License: BSD-3-Clause.

Local source layout:

```text
third_party/
  Nuked-OPN2/
    ym3438.c
    ym3438.h
  Nuked-PSG/
    ympsg.c
    ympsg.h
  ymfm/
    ymfm.h  ymfm_fm.h  ymfm_fm.ipp
    ymfm_opn.h  ymfm_opn.cpp
    ymfm_opm.h  ymfm_opm.cpp
    ymfm_ssg.h  ymfm_ssg.cpp
    ymfm_adpcm.h  ymfm_adpcm.cpp
    ymfm_opl.h  ymfm_opl.cpp
    ymfm_pcm.h  ymfm_pcm.cpp
```

Generated output:

```text
wasm/dist/
  nuked-opn2.js
  nuked-psg.js
  ymfm-ym2608.js
  ymfm-ym2151.js
  ymfm-ay8910.js
  ymfm-ym2413.js
live/
   nuked-opn2.js
   nuked-psg.js
   ymfm-ym2608.js
   ymfm-ym2151.js
   ymfm-ay8910.js
   ymfm-ym2413.js
```

Build prerequisites:

- Emscripten (`emcc`, `em++`)
- Vendored `third_party/Nuked-OPN2`, `third_party/Nuked-PSG` and `third_party/ymfm`

Build:

```bash
wasm/build-nuked.sh   # FM (YM2612)
wasm/build-psg.sh     # PSG (SN76489)
wasm/build-ym2608.sh  # YM2608 (ymfm)
wasm/build-ym2151.sh  # YM2151 (ymfm)
wasm/build-ay8910.sh  # AY-3-8910 (ymfm's SSG)
wasm/build-ym2413.sh  # YM2413 (ymfm)
```

If `emcc` aborts with a Python syntax error, point Emscripten at a modern
Python: `EMSDK_PYTHON=$(command -v python3.14) wasm/build-psg.sh`.

Integration notes:

1. `wasm/nuked_adapter.c` / `psg_adapter.c` wrap the upstream cores with
   a small C API. The FM adapter also streams the YM2612 DAC (registers 0x2b
   enable / 0x2a data) folded into the per-sample clock budget, so PCM plays
   through the real chip rather than a software mixer.
   `wasm/ym2608_adapter.cpp` runs ymfm's YM2608 at its lowest fidelity and
   averages three of its samples into one at the FM's rate (clock / 144),
   handing out FM + rhythm + ADPCM-B (stereo) and the SSG apart. It reads
   the rhythm ROM and the ADPCM-B's RAM through the host, from buffers the
   caller fills; with no ROM loaded the rhythm is not keyed.
   `wasm/ym2151_adapter.cpp` runs ymfm's YM2151 at its own rate (clock / 64),
   stereo, with each channel's output beside it for the scope.
   `wasm/ay8910_adapter.cpp` clocks ymfm's SSG engine at the chip's clock / 8
   and averages four of its states into one sample (clock / 32), the three
   channels apart (unipolar), which the caller sums and DC-blocks.
   `wasm/ym2413_adapter.cpp` runs ymfm's YM2413 at its own rate (clock / 72),
   mono — the melody and rhythm outputs (MO, RO) summed — with each of its
   nine channels' output beside it for the scope.
2. `build-nuked.sh` / `build-psg.sh` / `build-ym2608.sh` / `build-ym2151.sh` /
   `build-ay8910.sh` / `build-ym2413.sh` build single-file ES modules for
   AudioWorklet loading, and sync copies to `live/` for static deploys
   that only publish the `live/` directory.
3. `live/src/synth-md.js` imports the generated modules (`../nuked-opn2.js`,
   `../nuked-psg.js`), `live/src/synth-pc88.js` imports
   `../ymfm-ym2608.js`, `live/src/synth-x68k.js` `../ymfm-ym2151.js` and
   `live/src/synth-msx.js` `../ymfm-ay8910.js` and `../ymfm-ym2413.js`; the
   worklet and the WAV export both run the chips
   through them, the score's target picking which.

Notes:

- The generated module is emitted as a single JS file containing embedded WASM.
- This keeps AudioWorklet loading simple while still using a real WASM core.
- The repo vendors the upstream source and license text so the library can be
  rebuilt or replaced locally.
