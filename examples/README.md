# examples

This directory will hold demo songs and exported artifacts used for spec freeze.

Suggested layout:

1. source/: .mmlisp files
2. ir/: canonical IR snapshots
4. notes/: listening and validation notes

Current demo skeletons:

1. source/demo1.mmlisp

## Presets

Voices and PCM samples live in their own sets under `presets/`:
[gm](../presets/gm/README.md), [waveforms](../presets/waveforms/README.md),
[808](../presets/808/README.md) and [gm-drums](../presets/gm-drums/README.md).
Each set keeps its own demo score, such as
`presets/waveforms/demo-acid.mmlisp`; this directory holds songs.
