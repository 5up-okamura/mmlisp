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

`ir-player.js` is split into parts (`ir-player-work / -words / -macros /
-levels / -samples / -panel / -keys / -shared .js`), each a set of methods
mixed into IRPlayer. The page and the exports read the player only through
its public API (`playedIr()`, `loadedIr()`, `machine()`).

How it stands (the 2026-11 restructuring: the user wanted structure over
behaviour — fixing knobs one by one kept surfacing faults, because the IR
player wrote everything an event set going at dispatch, a lookahead early,
where the driver steps frames and puts every word through one `_paramSet`):

- **Frame work.** Work waits keyed by its frame and phase (`_at`, `_step`,
  `_putWork`: KEYED, SWEEP, MACRO, SONG, AFTER, FM3_KEYS, FM3_TL, VOICES,
  KEYON) and runs once the frame's events are dispatched. The player's state
  is the song at its cursor; the chip is behind it by the lookahead
  (`_write`, `_sendAhead`: a write composed from state reads it at its time).
- **A sweep and a macro step one at a time** (`_runSweep`, `_sweepWord`,
  `_sweepUnits`; `_macroSteps`, a generator every target shares, pulled by
  `_scheduleMacro`): nothing of either is forecast. A loop curve and a held
  note's chains are endless work (`_workFinite`). Each macro step asks
  whether the track's note is still its own (`_noteOf`, `_noteScope`).
- **Slots** (`_slots`, `_slotKey`, `SLOT_FREEING`): a sweep holds its
  word's slot as the driver's does; a value, a sweep or a stop frees it, a
  `+` / `*` / `$slot` does not.
- **One word, one rule** (`_word(ev, when, w)`): a track gives only the
  word `{ read, write, sweep? }` — `_volWord`, `_panWord`, `_pitchWord`,
  `_snapWord` on every track; `_songWord` for the song-wide ones (MASTER,
  VALn, NOISE_RATE, ENV_RATE, a wave chip's LFO words); `_fmWord`,
  `_psgWord`, `_pcmWord`, `_sampleWord`. The FM's LFO words read the rate as
  last written (`_readParam`; drv-player.js and the C's read_param too).
- **Levels are live values** (`_lv(site)` + `_lvWrite`, the note path
  below): a macro's step, the fader and the panel's hand all write the level
  again; `:target midi`'s are `mtrk:<track>`'s record for the panel.
- **The panel's contract**: a control (`{ id, kind: word | vol | reg | val }`)
  and `hold` / `release` / `read` on both players; the page keeps one
  registry (`panelControl`, `panelHold`, `panelRelease`,
  `syncPanelControls`). A level's hand (a strip's :vol, MASTER) is laid over
  the score's where a level is composed (`read().score` is the score's); a
  word, a register, a slot are gated (`_scoreWrites`).
- **Pause → play with nothing done in between goes on as it was**, the
  panel's values too (`seek(…, { hands: player.hands() })`, index.html's
  `_pausedAsLeft`). Anything else — a seek, an edit, stop → play — reads the
  score's. User's rule (2026-11): only that one case.

The gates for it: `check:words` (every word every way on every kind of Mega
Drive track against the driver; a new word or way goes into its tables
first), `check:word-rule` (the same rule on every machine's channels, sample ones
too, no driver),
`check:loops` (several passes of a track's loop against the driver),
`check:note-path`, `check:panel`.

Open, in the order worth taking:

1. **Not yet listened to**: the frame-order change moved the other seven
   machines' register logs (48 scores) with no oracle; Mega Drive A/B was
   no worse (118 of 134 clean then).
2. **Tone encoders' other calls** (pitch sweeps, the encoders' own queues)
   are made at dispatch: the Game Boy's, the 2A03's and the PC Engine's
   encoders order and drop writes by the calls they have seen. Listen to
   those first.
3. Bounds of the lookahead, left by choice: a held note let go releases
   where the sent writes end (~the lookahead late; undoing sent writes needs
   a per-channel retraction in the worklet for all eight machines); a score
   event's gate is judged at dispatch, so a hand let go less than the
   lookahead before a score write misses it; a hot-swap keeps the outgoing
   score's writes ahead; a seek drops a running sweep's remainder.
4. The parts are mixins, not components — they call into each other and
   share the core's state freely (samples: 31 calls, 27 fields, measured
   with a script) — to draw when a part next has to change.

## The note path, one for every voice (done, 2026-11)

User's rule: the same function, the same operation, runs the same path
whatever the chip or target — no per-chip copies; a voice differs only
where its chip does (PSG's soft envelope, PCM's modes). Do not add a
voice-specific copy of any of these; extend the adapter instead:
- `_playNote(ev, when, v)` — every note (ir-player-levels.js); `v.key(n)`
  is the voice's key-on, returning `{ close, retrigger, tailOff }`
  (`_fmNoteKey`, `_psgNoteKey`, `_chipPcmHit`, the DMC's, the MD PCM's).
- `_noteGate` / `_openNote` / `_closeNote` — the driver's gate rule and
  the one close; `_sampleClose` the samples' close by mode.
- `_keyonRetrigs` / `_noteRetriggers` — one retrigger stream; its taps stepped by
  `_scheduleMacro` (the one macro loop) in the KEYON phase. A held note's
  let-go list is its record's (`_onLetGo`, `_letGo`), beside `closed`.
- `_lv` + `_lvMacros` + `_lvWrite(site, t, why)` — every level, whatever
  moved it (a step, the fader, the panel's hand); onset from first steps.
- `_pt` + `_ptMacros` + `_ptWrite` — every pitch, the driver's rule.
- `_volWord` / `_panWord` / `_pitchWord` / `_snapWord` — :vol :pan :pitch
  :snap on every track, dispatched in `_dispatchEvent` beside MASTER (only
  PARAM_ events: ef46725 swallowed every MIDI event until 844529b).
- `_noteMacro` — a note's macro on any other word of its voice (pan, FM
  operator words, wave, duty, mode, mixer, noise period): a :keyon restart
  but for :pan, the driver's rule.
- `_silence(site, t)` — a voice silenced, for a mute landing
  (`_applyAudibility`) and a muted track's note (`_playNote`) alike.
- `VOICE_KINDS` (ir-player-levels.js) — each kind of voice's level, pitch,
  pan, silence and fader site in one entry (`_onVoice(site, op, …)`); add a
  kind there, not a branch in a dispatcher.
- `tools npm run check:note-path` holds all of it on every channel of every
  machine, sample ones included (closes, retriggers, mutes): 107 channels.

## Waiting on the user (ask, do not decide)

From the 2026-11-11 review (its items 1–4 are done: the song words' table,
check:word-rule, the MIDI port's offs on a stop, stale names). Commits
follow the repo's style (`refactor(player): …`, `fix(live): …`); author
and committer hiroshi okamura <hiroshi_okamura@me.com>, no Claude
attribution; work on `main` and push (it deploys mmlisp.com). Run every
gate before each push (drv `verify:all`, `node tools/ab-gate.mjs`,
`npm run pcm-ab`; tools `check:snapshot`, `check:note-path`,
`check:word-rule`, `check:words`, `check:loops`, `check:panel`,
`check:stems`, `check:gm-output`, `check:midi-out` …).

- Tempo look-ahead: `_timeAfterTicks` reads tempo changes not yet
  dispatched (`_tempoChangesAhead`) for a gate's end and a tick-clocked
  macro's steps; `_nextNote` looks ahead for the sample editor. Against
  "state is now only" — the alternative is counting ticks (a big change).
- Live's keys: an FM key writes through preview writes, a PSG key
  through the player's own state (`keyTone` → `_psgSetPitch`) — so the
  song and the key can overwrite each other on a lane the song plays.
  The fix is in index.html (no tests): only playback verifies it.
- The PC Engine's PCM sounds quieter than its waves: measured, the DDA
  and a wave channel peak alike (−18.1 dBFS); a sample carries ~13 dB
  less energy than a full-scale saw. It is a mix default, not a bug;
  the score can lower its waves now (`(def-mod :ch [...] :vel* 0.7)`
  or `(def-wave … (saw -64..63))`). A different default is a design
  change.
- Not yet heard on a device (the user checks on their phone):
  :target midi playback, mute / solo switching, the DMC's :keyon, the
  GM note-off fix (cce183d); a stop on an external MIDI port (each key
  gets its own off now); a :noise-rate / :env-rate / :lfo-rate sweep with
  no :from, and their `+` (from the value now).
  A Mega Drive pcm track's `:pan` (fm6's L / R, every voice's): heard
  in the preview, not yet on hardware.
