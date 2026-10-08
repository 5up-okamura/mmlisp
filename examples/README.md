# examples

`index.json` lists the songs the Library panel's **Scores** source offers (guide §25) —
scores worth playing to someone. A directory cannot be listed over HTTP, so a
song has to be named there to appear.

The songs themselves live with what they show off: a preset set keeps its own
demo, such as `presets/waveforms/demo-acid.mmlisp`. Scores that test the driver
live in `drv/tests/`, and short scores that show how a feature is used live in
[snippets](../snippets/README.md).

## Presets

Voices and PCM samples live in their own sets under `presets/`:
[gm](../presets/gm/README.md), [waveforms](../presets/waveforms/README.md),
[tr808](../presets/tr808/README.md), [tr909](../presets/tr909/README.md),
[cr78](../presets/cr78/README.md), [dr220](../presets/dr220/README.md),
[dx](../presets/dx/README.md), [rx5](../presets/rx5/README.md),
[gm-drums](../presets/gm-drums/README.md), the orchestral samples
[orch](../presets/orch/README.md), the voices and effects
[sfx](../presets/sfx/README.md), the guitar and bass
[band](../presets/band/README.md), the FM drums
[fm-drums](../presets/fm-drums/README.md), and the PSG's envelopes
[envelopes](../presets/envelopes/README.md).
