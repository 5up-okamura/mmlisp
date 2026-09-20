# examples

This directory will hold demo songs and exported artifacts used for spec freeze.

Suggested layout:

1. source/: .mmlisp files
2. ir/: canonical IR snapshots
4. notes/: listening and validation notes

Current demo skeletons:

1. source/demo1.mmlisp

## YM2612 GM presets

[GM-order 128-voice bank and usage](../presets/README.md).
Play [gm-audition.mmlisp](source/gm-audition.mmlisp) to audition all voices.

[NES / VRC6 FM audition](source/nes-vrc6-audition.mmlisp) uses the shared waveform bank.

[Acid saw](source/acid-saw.mmlisp) / [Acid square](source/acid-square.mmlisp): 16-step ordinary-FM bass with accents and legato slides.

[アナログ基本波形の試聴](source/analog-audition.mmlisp): サイン、三角、ノコギリ、矩形、25%パルス。音色定義は`presets/waveforms/waveforms.mmlisp`。
