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

- **Slots** (`_slots`, `_slotKey`, `SLOT_FREEING`): every sweep that writes
  through `_applyParam`, MASTER's and an FM / fm3 operator's :vol hold a
  slot keyed as the driver's; a value, a sweep or a stop of the word frees
  it, a `+` / `*` / `$slot` does not; frames write only while their sweep
  holds it.
- **One word, one handler**: MASTER from any track (`_masterEvent`); every
  relative write through `_writeValue`. The keys play through the player's
  API (`keyTone`, `keyPatchWrites` …), at the level the panel shows.

Open, in the order worth taking:

1. **The frame's order — the next design decision.** The IR player queues
   its future work by time; the driver runs each frame as dispatch, then
   channel engines (sweeps, then macros), then the song's sweeps (driver.md
   §4). A note's frame (`_eventFrame`) can fall after its time, and a
   frame's sweep step is stamped at the frame's start, so a time-ordered
   queue runs a step before a note the driver runs first. The predictors
   (`_masterAt*`, `_masterAtNoteOn`, `_fmVolAtFrame`, `_psgVolAtNoteOn`,
   `_volSetsAhead`, `_levelMacroLines`' dry run, `_psgLevelAhead`, the
   sounding-flag save/restore) encode that order by hand and cannot go
   until the queue keys engine work by (frame, phase) and stamps it after
   the frame's last event. What it costs today: a write the driver makes
   before a frame's sweep step shows for one frame in the preview
   (m2-master-every-track: 40 mismatches, all of this kind). Needs the
   user's go-ahead: it moves every target's register log, and only the
   Mega Drive has an oracle.
2. **Five queues of their own** that write "up to the horizon"
   (`_fm3TlQueue` / `_flushFm3Keys`, `_flushEncoders`, `_chipPcmFrames`,
   `_waveExprFrames`, `_tempoChangesAhead`) — fold into 1.
3. **Stateful tone encoders compose a note's level frames at dispatch**
   (queued-tone.js, the Game Boy's, the 2A03's, the PC Engine's): a hand on
   such a lane reaches a note with a level macro only from its next note.
   Needs every lane call of a note deferred together, not the level alone.
4. **A strip's :vol is still kept six ways** (FM regs + sweep + lines, an
   fm3 operator's, the PSG's arrays, `_pcmVolNow`, the chip-sample lines,
   `:target midi`'s lines) — why `_volOf` / `_volSites` switch on kind. The
   other words a sample track writes (`:pan`, `:pitch`) are still per
   dispatcher; probe each against the driver as MASTER and :vol were.
5. Bounds of the lookahead, as they are: a hand has the chip within it
   (0.2 s visible) while a sweep or macro runs; a score event's gate is
   judged when it is dispatched, so a hand let go less than the lookahead
   before a score write misses it. A hot-swap keeps the outgoing score's
   writes ahead; a seek drops a running sweep's remainder (both as before).
6. The A/B probe that found each of these: `abCompare(src, { samples })`
   from `live/src/ab-compare.js` run from `drv/tests` (for its wavs), on a
   word written every way on every kind of track. A probe that comes back
   clean goes in as `drv/tests/m2-*-every-track.mmlisp`.
