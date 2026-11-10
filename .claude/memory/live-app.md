# The live app — decided against, and lessons

What the app does is `docs/guide.md`; what is ahead is `docs/roadmap.md`.

## Decided against — do not re-propose

- **Editor:** no `@codemirror/lint`, no `bracketMatching()` (it moves the
  soft-wrap point), no rectangular selection (Alt-drag is the scrub), no
  full paredit, no rainbow parens, no touch symbol bar.
- **Library and keys:** the keys play no macro, except a wave's role macro;
  no ⌘⇧K; no Tools > Snippets; no Library state kept across launches.
- **Piano roll:** two colours, no bars, no channel chips, no Follow/Fixed
  switch, zoom is a scale, `MMLisp > View` a submenu, no edge markers, no
  transport or note editing in it.
- **Translation:** only what explains or asks; menus, log and diagnostics
  stay English; ja / es stay machine-written from the glossary, fixed via
  `i18n-sync.mjs --apply`, never by hand.
- Playback in the worklet: not now. The scope's cost while playing: left.
- **Archives:** ZIP and LZH only.
- No Import > Song… (Open takes a song).
- **Share links:** files as a ZIP beside the short link, not base64 in the
  score; no per-file opt-out; the 256 KB cap stays.
- Restructuring VGM / NSF imports stays human-guided (Tap Tempo).

## Lessons

- `noise` and other words have two reference entries by `ctx`; still
  first-wins for `<` `>`, `ticks` `frames`, `midi`, `repeat`, `:rate`.
- Check a change is deployed before a device test: a push to `main` deploys
  mmlisp.com; its result is the commit's check run.
- **Ask which backend played a report first**: under Tools > MMLispDRV
  Backend a Build does not swap in, so "fm6 still sounds after I commented
  it out" (2026-11-10) was the backend, not the IR player.
- Suspect the instrument first (a self-rewriting probe broke the iPad
  layout).
- playwright-core's WebKit with `devices['iPhone 13']` reproduces iPhone
  issues headless.

## The panel and the players — how it is built, and what is open

Investigated 2026-11-10 (the user: fixing the knobs one by one kept
surfacing new faults; structure over behaviour, regressions accepted).

**The root was in the IR player, not the panel.** It has no frame step: an
event is dispatched its lookahead ahead and everything it sets going was
written out at once, so nothing could reach a sweep's or a macro's frames
afterwards. The driver (and `drv-player.js`) steps frames and puts every
word through one `_paramSet`; there a hand is one gate. The IR player
emulates the frame machine by looking ahead, and each feature carries its
own compensation for it.

What stands now:

- **One contract**: a control (`{ id, kind: word | vol | reg | val }`) and
  `hold` / `release` / `read` on both players; the page keeps one registry
  (`panelControl`, `panelHold`, `panelRelease`, `syncPanelControls`).
- **The writes ahead** (`IRPlayer._write`, `_at`, `_sendAhead`): a write
  whose time the run has not reached waits in the player and goes out as
  the run reaches it; what composes a write from state (an FM level, an fm3
  operator's, a register word, the SN76489's level) waits too and reads the
  state at its time. The player's state is the song at its cursor; the chip
  is behind it by the lookahead.
- **Two kinds of hand**: a level (a strip's :vol, MASTER) is laid over the
  score's where a level is composed; a word, a register, a slot are gated.
  `read().score` is the score's value under a level's hand.

Open, in the order worth taking:

1. **The compensations for early expansion are still there** beside the
   queue that makes them unnecessary: `_followMasterSweep`,
   `_syncMasterSweep` / `_masterAt*`, `_syncParamSweeps`, `_volSetsAhead`,
   `_psgLevelAhead`, `_psgSounding` kept and put back around ahead writes,
   `_levelMacroLines`' dry run, and five queues of their own that write "up
   to the horizon" (`_fm3TlQueue` / `_flushFm3Keys`, `_flushEncoders`,
   `_chipPcmFrames`, `_waveExprFrames`, `_tempoChangesAhead`). Each can fold
   into `_at`, one at a time, under check:snapshot and the ab-gate — the
   first step moved the preview toward the driver (p3-se-ghost 96 → 0).
2. **Stateful tone encoders compose a note's level frames at dispatch**
   (queued-tone.js, the Game Boy's, the 2A03's, the PC Engine's): they order
   and drop writes by the calls they have seen, so deferring one call
   changed their output (tried: fc/apu, gb/apu, pce/noise moved). A hand on
   such a lane reaches a note with a level macro only from its next note.
   Needs every lane call of a note deferred together, not the level alone.
3. **A word is implemented per kind of track.** Ten dispatchers each handle
   PARAM_SET / _ADD / _MUL / _FROM_VAL / _SWEEP for the subset they know
   (`_relativeLevel` exists because sample tracks had no relative write;
   the five chip-sample dispatchers drop a `:master` sweep or `$slot`, read
   from the code, not run). A strip's :vol is kept six ways (FM regs + sweep
   + lines, an fm3 operator's, the PSG's arrays, `_pcmVolNow` beside the
   worklet's model, the chip-sample lines, `:target midi`'s lines) — which
   is why `_volOf` and `_volSites` switch on six kinds — and MASTER three
   ways. One table of words per site would remove the switches.
4. **The page plays the keys through the player's privates** (`_psgSetAtt`,
   `_composePsgAtt`, `_carrierTl`, `_writeFmLevel`, `_fmEnc`) and composes
   levels itself: a third level implementation after the two players.
   Stopped, the keys are a second, empty player (`initParamOnlyPlayer`).
5. **The FM panel reads one thing and writes another**: a carrier's TL
   slider shows the composed TL (`getChRegs`) and writes the voiced `:tl`.
6. Bounds of the lookahead, as they are: a hand has the chip within it
   (0.2 s visible) while a sweep or macro runs; a score event's gate is
   judged when it is dispatched, so a hand let go less than the lookahead
   before a score write misses it. A hot-swap keeps the outgoing score's
   writes ahead; a seek drops a running sweep's remainder (both as before).

