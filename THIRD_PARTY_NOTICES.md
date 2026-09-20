# Third-Party Notices

This repository includes third-party source code and audio samples with their own license terms.

## Nuked-OPN2

- Upstream: `third_party/Nuked-OPN2`
- Project: `Nuked-OPN2`
- Copyright: upstream project authors
- License: LGPL-2.1-or-later

Included files:

- `third_party/Nuked-OPN2/ym3438.c`
- `third_party/Nuked-OPN2/ym3438.h`
- `third_party/Nuked-OPN2/README.md`
- `third_party/Nuked-OPN2/LICENSE`

Local integration files in this repository:

- `player/wasm/nuked_adapter.c`
- `player/wasm/build-nuked.sh`
- `player/wasm/dist/nuked-opn2.js`
- `live/nuked-opn2.js`

The upstream license text is preserved at `third_party/Nuked-OPN2/LICENSE`.
When distributing builds that include the generated WASM wrapper, keep that
license text with the distribution and provide the corresponding source used to
rebuild the library.

## corrscope

- Upstream: https://github.com/corrscope/corrscope
- Copyright (c) 2018-2020+, nyanpasu64.
- License: BSD-2-Clause; the full license text is reproduced in the header of
  `live/src/scope-trigger.js`.
- Included: no upstream files. `live/src/scope-trigger.js` is a JavaScript port
  of corrscope's correlation trigger (`corrscope/triggers.py`,
  `corrscope/utils/trigger_util.py`, `corrscope/utils/windows.py`), adapted to
  take the wave period from the chip's pitch registers instead of estimating it
  by autocorrelation.

## Virtuosity Drums

- Upstream: https://github.com/sfzinstruments/virtuosity_drums
- Revision: `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`
- Creators: Versilian Studios and Karoryfer Samples; drummer Austin McMahon.
- License: CC0-1.0, preserved in `presets/drums/gm-muted/LICENSE-CC0.txt`.
- Included: GM-selected, shortened derivatives in `presets/drums/gm-muted/`
  (22,050 Hz, 16-bit mono; pitch-shifted muted toms and faded tails). The
  unprocessed upstream WAVs are not vendored.
- Provenance and conversion details, including each source file name and its
  SHA-256: `presets/drums/gm-muted/manifest.json`.

## libOPNMIDI XG GM melodic bank

- Upstream: https://github.com/Wohlstand/libOPNMIDI
- Revision: `8e0a0a6ac97a21f22c4b4d53d67a8d916d8c487b`, `fm_banks/xg.wopn`.
- Copyright (c) 2018-2026 Vitaliy Novichkov.
- License: MIT; upstream notice and full license in `presets/gm/licenses/libopnmidi-xg.txt`.
- Included: only 128 melodic programs from bank MSB 0 / LSB 0, converted to
  `presets/gm/gm.mmlisp`; source records in `presets/gm/source.json`.
- Voice definitions preserve register parameters. Original note offsets and the
  shared LFO rate are retained as provenance metadata, not applied by the voices.

## TR-808 Fischer samples

- Source: https://github.com/tidalcycles/sounds-tr808-fischer
- Revision: `85fbecf1bec32553395625ea659e2a56dfd7c0e1`.
- Original recording: Michael Fischer / Technopolis, 1994.
- Repository license: CC0-1.0, preserved in `presets/drums/tr808-gm/LICENSE-CC0.txt`.
- Included: 22 GM-numbered WAVs, converted to 22,050 Hz / 16-bit mono with shortened, faded tails.
- Source URLs, hashes and processing details: `presets/drums/tr808-gm/manifest.json`.
