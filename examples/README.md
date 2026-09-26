# examples

`index.json` lists the songs **File ▸ Browse… ▸ Scores** offers (guide §25) —
scores worth playing to someone. A directory cannot be listed over HTTP, so a
song has to be named there to appear.

The songs themselves live with what they show off: a preset set keeps its own
demo, such as `presets/waveforms/demo-acid.mmlisp`. Scores that test the driver
live in `drv/tests/`, and short scores that show how a feature is used live in
[snippets](../snippets/README.md).

## Presets

Voices and PCM samples live in their own sets under `presets/`:
[gm](../presets/gm/README.md), [waveforms](../presets/waveforms/README.md),
[808](../presets/808/README.md) and [gm-drums](../presets/gm-drums/README.md).
