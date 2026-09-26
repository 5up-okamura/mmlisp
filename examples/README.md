# examples

Example scores.

- `source/` — `.mmlisp` scores. `ab-core.mmlisp` is the driver's A/B and C
  gate score (drv/tools); `import-demo.mmlisp` and `voices-lib.mmlisp` show
  `(import …)`. They are test and reference material, not pieces to listen to.
- `index.json` — the scores **File ▸ Browse…** offers (guide §25). List only
  what is worth playing to someone; add a score there to have it appear.

## Presets

Voices and PCM samples live in their own sets under `presets/`:
[gm](../presets/gm/README.md), [waveforms](../presets/waveforms/README.md),
[808](../presets/808/README.md) and [gm-drums](../presets/gm-drums/README.md).
Each set keeps its own demo score, such as
`presets/waveforms/demo-acid.mmlisp`; this directory holds songs.
Short one-technique scores live in [snippets](../snippets/README.md).
