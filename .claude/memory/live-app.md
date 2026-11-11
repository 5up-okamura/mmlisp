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

**Where the restructuring stopped (2026-11):** the five rules hold (frame
order, state now, one rule a word, slots, the public API — the page and the
exports read the player only through it: `playedIr()`, `loadedIr()`,
`machine()`). Left by choice: (1) a held note let go releases where the
sent writes end, ~the lookahead late — undoing writes already sent needs
a per-channel retraction in the worklet for all eight machines; (2) the
parts are mixins, not components — they call into each other and share
the core's state freely (samples: 31 calls, 27 fields; measured with a
script) — to draw when a part next has to change.

`ir-player.js` is split into parts (`ir-player-work / -words / -macros /
-levels / -samples / -panel / -keys / -shared .js`), each a set of methods
mixed into IRPlayer: the function names below are where they were, in
the part their topic names.

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
5a. **Pause → play with nothing done in between goes on as it was**, the
   panel's values too (`seek(…, { hands: player.hands() })`, the page's
   `_pausedAsLeft`). Anything else — a seek (paused or not), an edit, stop →
   play — reads the score's. User's rule (2026-11): only that one case,
   kept simple; the rest may change as long as the reason is clear.
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
   **A macro steps one at a time too**: `_macroSteps` is a generator (the
   one core every target and type shares), `_scheduleMacro` writes a step
   as frame work (MACRO) and pulls the next; a :keyon's retriggers come one
   at a time (`_keyonRetrigs`, `_eachTime`), the envelopes restarting at
   each. What waited for a macro's end hears it when it comes (`onEnd`:
   the level tail's silence and the CSM mute through `_lvEnded`, a :keyon
   note's last key-off). A held note's chains are endless work. Each step
   asks whether the track's note is still its own (`_noteOf`,
   `_noteScope`): the next note takes the lane over on its frame. The
   scale slot is read at the step (`_macroValue`). The panel's marks and
   a step vector's outline are laid out for the eye only (`_macroShown`, a
   held note's first minute). `_macroDry` and the eager layout are gone;
   a held note with a sustain loop, a looping :keyon or a curve no longer
   runs the player out of memory (check:loops holds three to the driver).
   **No tie look-ahead**: a note's length is its own (a TIE is the
   track's to play, as the driver's extends its wait). A note whose gate
   reaches its end (no gate, or one past its own length into a tie) is
   held until it closes — the track's next event (`_resolveOff`: key-off
   first, then `_letGoNote`), or its gate's end inside a tie — its macros
   run as a held note's (`macroGate` / `psgMacroGate` 0). A macro reads
   its gate as it steps (`_macroSteps`' `G` holder: offT / offFrame /
   activeFrames are functions; `{ wait }` at a release until it closes);
   let go, the gate is set and the steps go on — a pending step no longer
   the note's (its own `valid()`) dropped (`next(false)`: not where a
   release-from-now starts). No replay: replaying a tick-clocked macro
   from its note after a tempo change counted it at the new tempo. On the
   frame-clocked machines a macro now runs to the next event's frame (one
   more frame than the old note-length estimate at a song's end).

   macros' release where the sent steps end (the lookahead late), its
   retriggers stop, a tone lane falls silent after the release. With no
   run (it is over: a song that is only held notes; or stopped) a held
   note's chains are not stepped at all — `_scheduleMacro` and `_eachTime`
   both check the cursor each pull (the second was missed at first: a
   stack overflow on pce :lfo-sync and the chips' sample hits). **Key edges are the driver's too**: a gate shorter than its note
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
   UI hint. (The tie look-ahead `_resolveTiedLength` is gone too.)
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
   `strk<track>`). Value slots too: `_writeVal` is a word (`_word`), the
   slot (`_vals`) its value now, a sweep in a song-wide slot (`song:VALn`,
   `isSongWord`, stepped in SONG as the driver's global sweeps), so an
   event reads what the frame before left; `_resolveSrc` reads the value.
   A wave expression's frames are KEYED work at each frame's head
   (`_waveExprFrame`). The panel reads a swept slot moving (it read the
   pre-sweep value).

## The note path, one for every voice (in progress, 2026-11)

User's goal (verbatim intent): the same function, the same operation, runs
the same path whatever the chip or target — no per-chip copies, no ad-hoc
second implementations. Approved: unify the path first, then let each kind
of voice answer at fixed points. PSG has no hardware envelope (a soft
envelope: its level macros), PCM rarely uses gate (its `:mode` does).

Review count before starting: 7 note-on handlers, 3 gate rules, 5 pending
key-off flags (`_pendingKeyOff`, `_fm3Pending`, `_psgPending`, `_fm3Held`,
`_holdChannels`), 5 :keyon retrigger paths, 3 onset paths, 6 word tables.

Design:
- One per-track "open note" record and one close path: `_closeNote(ti, t,
  by)` — by the next note (legato or not), a REST, TRACK_END, a gate's end
  (a timer), the host's key-off (a hold), a hot-swap, a PCM_NOTE_OFF. It
  keys off / silences through the voice, then lets its macros go.
- One gate rule (the driver's, FM's): a gate shorter than the note closes
  at its end; one that reaches the note's end (none, or into a tie) closes
  at the track's next event or its gate's end, whichever first; length or
  gate 0 is a hold. PCM: its note closes at its NOTE_OFF (gate / loop
  mode), else as the rule says; what closing does is the mode's.
- A voice is an adapter: key on, close (what the gate's end does: FM key
  off — before the next note's key-on, none on a slur; FM3 op an edge; CSM
  a TL 127 after the level tail; PSG its level macros' release, then
  silence — nothing when a note follows; PCM by mode: shot nothing, gate
  cut, loop release), retrigger (a :keyon step), level site (_lv), pitch.
- Stages, each committed with the gates green: (1) close path and the
  open record; (2) one gate rule; (3) one retrigger path; (4) levels and
  onset through _lv for every voice; (5) pitch; (6) the note function and
  the voice adapters; (7) the word tables (VOL / PAN once).
- Done: (1) — `_open[ti]` (`_openNote` / `_closeNote` in
  ir-player-levels.js) replaces `_pendingKeyOff`, `_fm3Pending`,
  `_psgPending`, `_fm3Held`; closes by `{next, legato, keys}`, `{host}`
  or plain (rest / track end / gate end). A hold now ends at END_OF_TRACK
  (language.md §17; it was left keyed before); a track end's silence is on
  its frame, not ε before.
- Done: (2) — `_noteGate(ev, when)` (ir-player-levels.js) is the one gate
  rule (hold / open = the driver's pendingOff / timed), decided once per
  note in `_dispatchEvent` (`_openNote`), read by every voice
  (`_gateOf(ti)`); a voice only says what closing is (`_noteCloses`), a
  sample voice through `_sampleCloses` (cut / release / a shot's no-op;
  chips' `release(t, h, how)` in `_chipPcmHit`). A timed gate closes on a
  timer at its end ({ gate }: whole frames on a frame-clocked machine); a
  pcm note's PCM_NOTE_OFF closes it too, in its track's order (pcm-ab).
  `_holdChannels` is gone (holds are `_open` records with `gate.hold`).
  PSG now reads an explicit full gate as FM does; FM's short gate with a
  :keyon keys off at the gate and again after an echo tail (the driver's);
  MD PCM's retriggers run on `_eachTime`. A one-shot capture ends at the
  song's end at the earliest (a muted track's writes set it before).
- Done: (3) — a note's :keyon retriggers are one stream on its record
  (`_openNote`: `_keyonRetrigs`, ending with `{ end }`), read by its
  envelopes (`_envRetrigs = _retrigsOf(ti)`) and its voice
  (`_noteRetriggers(ti, retrigger, keyOff)`: work in the KEYON phase,
  after the frame's dispatch and sweeps, before its macros, in track
  order); an echo tail past the close keys off a step after the macro's
  end (FM and now FM3 alike). `_scheduleKeyonMacro`, `_fm3Retriggers`,
  `_letGoAt` / `_letGo` are gone; `_eachTime` has one caller.
- Done: (4) — every voice's level is an `_lv` site and its onset one rule:
  `_lvNoteOn`, then `_lvMacros(site, args, when, gate, live)` — first steps
  on the note move the level at once, the key-on composes from them
  (`live()` false till keyed), a :keyon retrigger starts over from them
  (`note.first`, `_lvRetrig`). FM / FM3 now so too (its redundant first TL
  write gone; frame-equal). Chip samples' level is `voice:<voice>`
  (`_sampleLevel`: over the track's `strk:` fader), DMC's `voice:dpcm`;
  MD PCM's `pcm:<n>` sends each step to the driver's voice model
  (`_lvWrite(site, t, key)` → `_pcmLevelStep`, a due retrigger carrying
  it). `_macroOnset` remains only for pitch (stage 5);
  `macroLeadsWithHold` is gone.
