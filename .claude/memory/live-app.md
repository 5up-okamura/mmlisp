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

1. **The frame's order is in (branch `dev`).** Work ahead waits keyed by
   its frame and phase (`_at`, `_step`: KEYED, SWEEP, MACRO, SONG, AFTER)
   and runs once the frame's events are dispatched; every macro step is such
   work (`_scheduleMacro`; `_macroDry` for a caller only reading values).
   MASTER, an FM / fm3 fader and a tone lane's level are live state
   (`_masterVol`, `regs.vol`, `_psgLive` + `_psgRecompose`): the forecasts
   (`_masterAt*`, `_fmVolAt*`, `_psgVolAt*`, `_volSetsAhead`,
   `_psgLevelAhead`, `_syncMasterSweep`) are gone. Mega Drive A/B: no score
   worse, 118 of 134 clean (was 113). **Not listened to; the other seven
   machines' register logs moved (48 scores) with no oracle.**
   Every sweep steps in its frames too (pitch and glides, register words,
   the song's words, a PCM voice's :vol and points), and an FM note's
   :vel / :vol macros are live values (`liveVel`, `liveVol`,
   `_fmNoteLevel`) as a tone lane's are. `_levelMacroLines` / `_lineAt`
   stay only for the chips' sample voices and `:target midi`, which keep
   lines of their own.
2. **The queues of their own are folded**: FM3's key edges and CSM levels
   are frame work (FM3_KEYS, FM3_TL); the tone encoders, the chips' sample
   frames and wave expressions write up to one point (`_settled`). Left:
   `_tempoChangesAhead`, a forecast the tick → second mapping needs (a
   gate's end in seconds) — inherent to scheduling by time, not a
   compensation.
3. **Tone encoders now get a lane's level at its own time on every
   machine** (the `attAnytime` exception is gone), but a lane's other calls
   ahead (pitch sweeps, the encoders' own queues) are still made at
   dispatch: the Game Boy's, the 2A03's and the PC Engine's encoders order
   and drop writes by the calls they have seen. Listen to those first.
4. **One level model for FM channels, fm3 operators and tone lanes**
   (`_lv(site)`: vel, vol, liveVel / liveVol, note, key, hand; `_lvWrite`
   is the only part that differs by kind). A Mega Drive PCM voice's
   fader and :vel are its record's too (`pcm:n`; the worklet's model
   composes them). The chips' own sample voices
   are live too: a sample track's fader is `strk:<track>`'s record, its
   :pitch `_chipPcm.cents`, a hit's macros live values on the hit (`mac`,
   its key composing from their first samples, `_macroOnset`), each voice's
   sounding hit its `owner`; any of them moving writes that hit's level,
   pitch and tune then (`_chipPcmWrite`), as FM and tone lanes do. Only the
   DDA's sample stream is per-frame work (VOICES). `:target midi`'s levels
   are `mtrk:<track>`'s record (`_midiLevel` through `_word`, a note's :vol
   macro by `_lvMacros`), its :master every machine's. The timelines
   (`_chipPcmParam`, `_levelMacroLines`, `_lineAt`, `insertLine`) are gone.
   Moved (tools/tests/*/sample-levels etc., no oracle): `+` / `*` under a
   running sweep keep it running (the driver's rule); on pc88 / x68k a
   move lands at its own time, not the next frame's start; a frame with a
   :vel and a :vol step writes once a step. A DDA frame's samples past a
   pass's horizon used to be lost when the next frame was a new hit's. The other
   words a sample track writes (`:pan`, `:pitch`) are still per dispatcher;
   probe each against the driver as MASTER and :vol were.
5. Bounds of the lookahead, as they are: a hand has the chip within it
   (0.2 s visible) while a sweep or macro runs; a score event's gate is
   judged when it is dispatched, so a hand let go less than the lookahead
   before a score write misses it. A hot-swap keeps the outgoing score's
   writes ahead; a seek drops a running sweep's remainder (both as before).
6. `check:words` (tools/scripts/probe-words.mjs) is the probe: every word
   every way on every kind of Mega Drive track against the driver. 0 cases
   part. A new word or way of writing goes into its tables first.
7. **A sweep is one step of frame work at a time** (`_runSweep`,
   `_sweepWord`): each step reads its slot, writes, and queues the next, so
   it has no length to forecast — the next write of its word, the loop's
   span, a glide's cut (`_resolveSweepBudgetFrames`, `_nextTargetWriteTick`,
   `_loopCurveSpanTicks`, `_glideCut`, … are gone). A loop curve is endless
   work (`_workFinite`: it does not keep a run alive). This also fixed what
   no gate saw: a sweep across its track's loop (one in the loop starts over
   each pass, one from before it runs on) — `check:loops` plays several
   passes against the driver, which the A/B gate's one pass does not.
   A macro's values are still laid out at its note, but each step asks as
   it runs whether the track's note is still its own (`_noteOf`,
   `_noteScope`) — the next note takes the lane over on its frame, as the
   driver's dispatch does before the frame's macros; no score's output
   moved. **Key edges are the driver's too**: a gate shorter than its note
   keys off at its end; a full gate's key-off waits for the track's next
   event (`_pendingKeyOff`, `_fm3Pending`, `_psgPending`, each with its
   gate's end `at`): a note keys off before its key-on (a slur cancels
   it), a REST or the track's end (`TRACK_END`, added by `_flattenTracks`
   with a REST in every gap, as export-mmb.js syncClock fills them) keys
   off / silences there (`_resolveOff`). Work that belongs to a note
   (a :keyon tail's key-off, a level tail's silence, a CSM mute, a DMC
   stop, an MD PCM retrigger) runs `_whileNote`: just after any event at
   its own time, and only while the note is still the track's. A hot-swap
   settles the outgoing pendings at their gate's end (`_settlePending`).
   No macro takes a limit any more. On the frame-clocked machines this
   removed a silence / key-off a frame early between abutting notes (the
   gate's end rounded to the frame before the next note's). `_nextNote` is
   left only for the sample editor's playhead (`_reportSample`'s `cut`), a
   UI hint. A scaled macro (`:scale $slot`) still reads its slot when laid
   out, not per step.
8. **A word's event is one rule** (`_word(ev, when, w)`): a value, a
   `$slot`, `+`, `*`, a sweep, a stop — the same for every word on every
   track; the track gives only the word, `{ read, write, sweep? }`
   (`_fmWord` over `_readParam` / `_applyParam`, `_psgWord`, `_pcmWord`,
   MASTER, the song's NOISE_RATE / ENV_RATE, a wave chip's LFO words).
   `_applyParamSweep`, `_writeSongRate`'s value half and the per-kind
   `PARAM_*` cases are gone, so a tone lane's every word takes `+` `*` and
   a sweep (only :vol and :pitch did), and a PCM voice's :vol sweep runs
   on through a `+` as the driver's does (it stopped; `check:loops` holds
   the voice's fader to the driver now — the A/B gate does not see it).
   The chips' sample tracks and `:target midi` are on it too
   (`_sampleWord`, `_midiLevel`; a sample track's slots are its own,
   `strk<track>`). Still on its own: value slots (`_writeVal`, a sweep
   read by formula).
