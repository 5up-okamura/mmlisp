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

## CodeMirror 6

- Upstream: https://codemirror.net/ (`@codemirror/view`, `state`, `language`,
  `commands`, `autocomplete`, `search`, and `@lezer/highlight`; the versions are
  in the bundle's header comment).
- Copyright (C) 2018-2021 Marijn Haverbeke and others.
- License: MIT, preserved in `live/vendor/LICENSE-codemirror.txt`.
- Included: `live/vendor/codemirror.js`, a minified bundle of those packages
  built by `live/scripts/vendor/build.mjs` so the app runs offline.

## Open Sans

- Upstream: https://github.com/googlefonts/opensans, via `@fontsource/open-sans`.
- Copyright 2020 The Open Sans Project Authors.
- License: SIL Open Font License 1.1, preserved in
  `live/vendor/fonts/LICENSE-open-sans.txt`.
- Included: the unmodified latin and latin-ext WOFF2 files for weights 400,
  600 and 700 in `live/vendor/fonts/`, with `live/vendor/open-sans.css`.

## Virtuosity Drums

- Upstream: https://github.com/sfzinstruments/virtuosity_drums
- Revision: `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`
- Creators: Versilian Studios and Karoryfer Samples; drummer Austin McMahon.
- License: CC0-1.0, preserved in `presets/gm-drums/LICENSE-CC0.txt`.
- Included: GM-selected, shortened derivatives in `presets/gm-drums/`
  (22,050 Hz, 16-bit mono; pitch-shifted toms and faded tails). The
  unprocessed upstream WAVs are not vendored. The snare is
  `Samples/mid/snare/mid_snare_center_vl36.flac`.
- Conversion: trimmed to the attack, shortened with a half-cosine fade, and
  resampled to 22,050 Hz; the toms are pitch-shifted from the low and
  high tom (`Samples/mid/ltom/mid_ltom_center_vl14.flac`,
  `Samples/mid/htom/mid_htom_center_vl14.flac`);
  each hit is then set to a level by role
  (a limiter and clip to raise, a gain to lower).

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
- Conversion: channel mean, polyphase resampling, faded tails, and a
  level set by role (a limiter and clip to raise, a gain to lower).

## TR-909 JGB samples

- Source: https://freesound.org/people/altemark/packs/1643/ (TR-909 JGB pack).
- Original recording: Janne G:son Berg, from his own TR-909; cut up and
  published on Freesound by altemark.
- License: CC BY 4.0, preserved in `presets/tr909/LICENSE-CC-BY-4.0.txt`.
  Attribution is required when the samples are redistributed.
- Included: 13 GM-numbered WAVs in `presets/tr909/`, converted to 22,050 Hz /
  16-bit mono; the Freesound IDs of their sources are listed in
  `presets/tr909/README.md`.
- Conversion: 2:1 low-pass decimation, half-cosine-faded tails, and a level set by role (a
  limiter and clip to raise, a gain to lower).

## CR-78 samples

- Source: https://freesound.org/people/wikter/packs/40417/ (Roland CR78 sounds).
- Recorded by wikter from a Roland CR-78.
- License: CC0-1.0, preserved in `presets/cr78/LICENSE-CC0.txt`.
- Included: 10 GM-numbered WAVs in `presets/cr78/`, converted to 22,050 Hz /
  16-bit mono.
- Conversion: resampling, a short end fade, and a level set by role (a
  limiter and clip to raise, a gain to lower).

## DR-220E samples

- Source: https://freesound.org/people/esnow/packs/31223/ (BOSS DR-220E Drum Machine).
- Recorded by esnow from a Boss DR-220E.
- License: CC0-1.0, preserved in `presets/dr220/LICENSE-CC0.txt`.
- Included: 11 GM-numbered WAVs in `presets/dr220/`, converted to 22,050 Hz /
  16-bit mono.
- Conversion: resampling, half-cosine-faded tails, and a level set by role (a
  limiter and clip to raise, a gain to lower).

## Oberheim DX samples

- Source: https://freesound.org/people/oceansonmars/packs/39619/ (DX Drum Kit).
- Recorded by oceansonmars from an Oberheim DX.
- License: CC0-1.0, preserved in `presets/dx/LICENSE-CC0.txt`.
- Included: 11 GM-numbered one-shots in `presets/dx/` (the pack's loops are
  not), converted to 22,050 Hz / 16-bit mono.
- Conversion: channel mix, resampling, leading-silence trim, a short end
  fade, and a level set by role (a
  limiter and clip to raise, a gain to lower).

## Yamaha RX5 samples

- Source: https://github.com/MckAudio/MckSamplePacks (`RX5/`).
- Recorded by MckAudio from a Yamaha RX5 with a ZOOM U-24.
- License: CC0-1.0, preserved in `presets/rx5/LICENSE-CC0.txt`.
- Included: 36 GM-numbered WAVs in `presets/rx5/`, converted to 22,050 Hz /
  16-bit mono; two toms are pitched down from one source.
- Conversion: resampling, leading-silence trim, half-cosine-faded tails, and
  a level set by role (a
  limiter and clip to raise, a gain to lower).

## Orchestral, effect, guitar and bass samples

- Source: https://freesound.org/people/druidbloke/sounds/165599/ (A
  recreation of the classic 80s orchestral stab),
  https://github.com/MckAudio/MckSamplePacks (`RX5/MISC`, `RX5/PERC`), and
  https://github.com/sgossner/VSCO-2-CE (Versilian Studios Chamber Orchestra
  2 Community Edition).
- Made by druidbloke as a recreation of the Fairlight ORCH5 stab; recorded by
  MckAudio from a Yamaha RX5; recorded by Versilian Studios.
- License: CC0-1.0, preserved in `presets/orch/LICENSE-CC0.txt`,
  `presets/sfx/LICENSE-CC0.txt` and `presets/band/LICENSE-CC0.txt`.
- Included: in `presets/orch/wav/`, `orch-hit.wav` (druidbloke),
  `orch-hit2.wav` and `timpani.wav` (RX5) and `pizz.wav` (VSCO); in
  `presets/sfx/wav/`, six RX5 voices and effects; in
  `presets/band/wav/`, nine RX5 guitar and bass notes; all converted to
  22,050 Hz / 16-bit mono.
- Conversion: MP3 decode (orch-hit), resampling, a cut with a half-cosine
  fade, and a level set by role (a
  limiter and clip to raise, a gain to lower).

## Zap sample

- Source: https://freesound.org/s/751110/ (Hiphop - Zap Lock Loop).
- Made by kontraamusic.
- License: CC BY 4.0, preserved in `presets/sfx/LICENSE-CC-BY-4.0.txt`.
  Attribution: "Zap by kontraamusic (freesound.org), CC BY 4.0".
- Included: the loop's first hit as `presets/sfx/wav/zap.wav`, converted to
  22,050 Hz / 16-bit mono.
- Conversion: channel mix, resampling, a cut to 0.15 s with a half-cosine
  fade, and a level set by role (a
  limiter and clip to raise, a gain to lower).

## Zap 2 sample

- Source: https://freesound.org/s/82529/ (ROBO KISS).
- Made by zgump.
- License: CC0-1.0, preserved in `presets/sfx/LICENSE-CC0.txt`.
- Included: `presets/sfx/wav/zap2.wav`, converted to 22,050 Hz / 16-bit mono.
- Conversion: channel mix, resampling, a short end fade, and a level set by role (a
  limiter and clip to raise, a gain to lower).
