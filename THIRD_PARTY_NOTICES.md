# Third-Party Notices

This repository includes third-party source code and audio samples with their own license terms.

## Nuked-OPN2

- Upstream: https://github.com/nukeykt/Nuked-OPN2
- Project: `Nuked-OPN2`
- Copyright: (c) 2017-2022 Alexey Khokholov (Nuke.YKT)
- License: LGPL-2.1-or-later

Included files:

- `third_party/Nuked-OPN2/ym3438.c`
- `third_party/Nuked-OPN2/ym3438.h`
- `third_party/Nuked-OPN2/README.md`
- `third_party/Nuked-OPN2/LICENSE`

Local integration files in this repository:

- `wasm/nuked_adapter.c`
- `wasm/build-nuked.sh`
- `live/nuked-opn2.js` (the built WASM wrapper this repository ships)

The upstream license text is preserved at `third_party/Nuked-OPN2/LICENSE`.
When distributing builds that include the generated WASM wrapper, keep that
license text with the distribution and provide the corresponding source used to
rebuild the library.

## Nuked-PSG

- Upstream: https://github.com/nukeykt/Nuked-PSG
- Project: `Nuked-PSG`
- Copyright: (c) 2021 Nuke.YKT
- License: GPL-2.0-or-later

Included files:

- `third_party/Nuked-PSG/ympsg.c`
- `third_party/Nuked-PSG/ympsg.h`
- `third_party/Nuked-PSG/README.md`
- `third_party/Nuked-PSG/LICENSE`

Local integration files in this repository:

- `wasm/psg_adapter.c`
- `wasm/build-psg.sh`
- `live/nuked-psg.js` (the built WASM wrapper this repository ships)

`live/nuked-psg.js` is a build of this GPL-2.0-or-later source, so any
distribution of MMLisp Live that includes it carries GPL-2.0-or-later terms for
that component: keep `third_party/Nuked-PSG/LICENSE` with the distribution and
offer the corresponding source. This repository is that source, and the app's
Licenses dialog links it.

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
- License: CC0-1.0, preserved in `presets/gm-drums/LICENSE-CC0.txt`.
- Included: GM-selected, shortened derivatives in `presets/gm-drums/`
  (22,050 Hz, 16-bit mono; pitch-shifted muted toms and faded tails). The
  unprocessed upstream WAVs are not vendored.
- Conversion: trimmed to the attack, shortened with a half-cosine fade, and
  resampled to 22,050 Hz; muted toms are pitch-shifted from one source hit.

## libOPNMIDI XG bank (GM melodic voices and FM drum kits)

- Upstream: https://github.com/Wohlstand/libOPNMIDI
- Revision: `8e0a0a6ac97a21f22c4b4d53d67a8d916d8c487b`, `fm_banks/xg.wopn`.
- Copyright (c) 2018-2026 Vitaliy Novichkov.
- License: MIT; upstream notice and full license in
  `presets/gm/licenses/libopnmidi-xg.txt`, and a copy in
  `presets/fm-drums/licenses/`.
- Included: the 128 melodic programs of bank MSB 0 / LSB 0, converted to
  `presets/gm/set.mmlisp`; and GM notes 35-81 of five percussion banks
  (StandKit whole; of StndKit2, AnalgKit, ElctrKit and SymphKit the drums
  that differ), converted to `presets/fm-drums/set.mmlisp`.
- Voice definitions preserve the bank's register parameters; the shared LFO
  rate is not applied. The melodic voices drop the bank's note offsets; a drum
  keeps its fixed key as the voice's `:key`.

## TR-808 Fischer samples

- Source: https://github.com/tidalcycles/sounds-tr808-fischer
- Revision: `85fbecf1bec32553395625ea659e2a56dfd7c0e1`.
- Original recording: Michael Fischer / Technopolis, 1994.
- Repository license: CC0-1.0, preserved in `presets/tr808/LICENSE-CC0.txt`.
- Included: 22 GM-numbered WAVs, converted to 22,050 Hz / 16-bit mono with shortened, faded tails.
- Conversion: channel mean, polyphase resampling, and faded tails.

## TR-909 JGB samples

- Source: https://freesound.org/people/altemark/packs/1643/ (TR-909 JGB pack).
- Original recording: Janne G:son Berg, from his own TR-909; cut up and
  published on Freesound by altemark.
- License: CC BY 4.0, preserved in `presets/tr909/LICENSE-CC-BY-4.0.txt`.
  Attribution is required when the samples are redistributed.
- Included: 13 GM-numbered WAVs in `presets/tr909/`, converted to 22,050 Hz /
  16-bit mono; the Freesound IDs of their sources are listed in
  `presets/tr909/README.md`.
- Conversion: 2:1 low-pass decimation, half-cosine-faded tails, and peak
  normalization.

## CR-78 samples

- Source: https://freesound.org/people/wikter/packs/40417/ (Roland CR78 sounds).
- Recorded by wikter from a Roland CR-78.
- License: CC0-1.0, preserved in `presets/cr78/LICENSE-CC0.txt`.
- Included: 10 GM-numbered WAVs in `presets/cr78/`, converted to 22,050 Hz /
  16-bit mono.
- Conversion: resampling, a short end fade, and peak normalization.

## DR-220E samples

- Source: https://freesound.org/people/esnow/packs/31223/ (BOSS DR-220E Drum Machine).
- Recorded by esnow from a Boss DR-220E.
- License: CC0-1.0, preserved in `presets/dr220/LICENSE-CC0.txt`.
- Included: 11 GM-numbered WAVs in `presets/dr220/`, converted to 22,050 Hz /
  16-bit mono.
- Conversion: resampling, half-cosine-faded tails, and peak normalization.

## Oberheim DX samples

- Source: https://freesound.org/people/oceansonmars/packs/39619/ (DX Drum Kit).
- Recorded by oceansonmars from an Oberheim DX.
- License: CC0-1.0, preserved in `presets/dx/LICENSE-CC0.txt`.
- Included: 11 GM-numbered one-shots in `presets/dx/` (the pack's loops are
  not), converted to 22,050 Hz / 16-bit mono.
- Conversion: channel mix, resampling, leading-silence trim, a short end
  fade, and peak normalization.

## Yamaha RX5 samples

- Source: https://github.com/MckAudio/MckSamplePacks (`RX5/`).
- Recorded by MckAudio from a Yamaha RX5 with a ZOOM U-24.
- License: CC0-1.0, preserved in `presets/rx5/LICENSE-CC0.txt`.
- Included: 35 GM-numbered WAVs in `presets/rx5/`, converted to 22,050 Hz /
  16-bit mono; two toms are pitched down from one source.
- Conversion: resampling, leading-silence trim, half-cosine-faded tails, and
  peak normalization.
