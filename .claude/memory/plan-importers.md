# Song importers (MIDI, VGM, DMF, FUR) and VGM export with PCM — plan

Decided in discussion 2026-10-05; nothing implemented yet. Implementation goes
to other chats. Delete this file once the repo records the outcome (guide /
README for the importers, the export-vgm.js header for PCM).

## Order (user: OK)

1. Import menu split by a separator (voices / songs) + VGM export with PCM
2. MIDI → 3. DMF → 4. VGM → 5. FUR

## Shared shape

- Every importer is `bytes, options → { source, warnings }` like
  `importMucom`: MMLisp source text out, anything unsupported dropped and
  reported. The importer is a pure function; the UI only fills `options`, so
  the same call works headless (MCP, node).
- **A conversion dialog** (user's idea, 2026-10-05): after the file is parsed,
  before the source is written, a modal shows what was found and lets a few
  things be set. Defaults must be right so Enter alone imports. Contents:
  - the source channels/tracks: note count, max polyphony, program or chip,
    each with a destination (fm1-6 / sqr1-3 / noise / pcm / drop);
  - tempo: the detected value (editable), with the other candidates;
  - for trackers: phrase mode on/off (below).
  Not the place for every knob — only what a user would change per file.
- Menu: voices group (DMP, FUI, TFI, VGI, OPNI, mucom voice bank, mucom PCM
  bank) ── separator ── songs group (MIDI, VGM, DMF, FUR, mucom MML). The
  drop-to-open extension routing learns the new extensions.

## MIDI

- Ticks rescaled from the file's division to PPQN 96; tempo map imported.
- Programs → `presets/gm` (import the set, name the voice); ch10 →
  `presets/gm-drums` PCM.
- **Apply the GM bank's per-voice note offsets at import** (user: YES) — the
  set itself does not apply them (presets/gm/README.md); the importer needs
  the offsets from the source bank.
- Polyphony: a channel gets as many tracks as its max simultaneous notes;
  when tracks run out, cut from the channels with the most polyphony, and
  warn (user: OK). The dialog can override the assignment.

## VGM

- Rebuild notes from the write log: voice = registers at key-on, pitch =
  F-number/block, length = until key-off.
- OPN family (2612/2203/2608/2610): voice + notes near 1:1, SSG → PSG.
  OPM (2151): voice approximated (DT2 dropped), 8 ch → 6. OPL/OPLL/others:
  notes only on a stand-in voice. SN76489/AY → sqr.
- **Tempo: estimate it** (user: wants it, rather than a fixed 1/60 s grid).
  Most VGMs come from a tick-driven driver, so key-ons sit on an integer
  frame grid: find the grid (inter-onset GCD/histogram), then the beat
  (autocorrelation of onsets), quantize, and measure the residual. Above a
  threshold fall back to the frame grid and say so. The dialog shows the
  candidates. Mid-song tempo changes: later.
- YM2612 DAC data blocks → PCM notes is a separate later step (mixed streams
  break it).

## Trackers (DMF, FUR)

- **Phrase output** (user's idea, 2026-10-05): each channel's pattern becomes
  a `(def …)` phrase, and each track lays out its phrases in order-list
  order — the source's own structure stays readable. Identical patterns
  share one def; consecutive repeats become `(x n …)`; the order list's
  loop becomes `#top … (go top)`.
- Caveat: a phrase must not depend on state left by the previous one (a loop
  bakes its state, cheatsheet). Each phrase restates what it relies on —
  octave, voice, volume, any running effect — at its head. Patterns that only
  differ by that state still share a def when the restated head is equal.
- Speed/rows → ticks; basic effects only (arpeggio, portamento, vibrato,
  volume); the rest warned.
- DMF first (frozen, small format). FUR: Genesis chip setups (YM2612 +
  SN76489) first; other chips notes only. Instruments go through the existing
  DMP/FUI parsers.

## VGM export with PCM (user: OK)

- The DAC byte stream mixed by `pcm-model.js` (what the driver plays) goes
  into one data block; `0xE0` seek + `0x8n` (DAC write + wait n). Same sound
  as the driver; cost is size (engine rate × length, a few MB).
- DAC stream control (`0x90`-`0x95`) was rejected: it plays one sample at a
  time, and the engine mixes several in software.
