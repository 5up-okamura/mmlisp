# Targets beyond the Mega Drive — rulings and open items

pc88, x68k, msx, pce, fc and gb sit on the part / chip / target layering
(`live/src/chips/parts.js`, `targets/`); language.md §19 says what each
does. This file holds the rulings, what the docs do not say, and what is
open, per machine; delete each item once the repo records it.

Why the other machines have no driver: a score there is composed in Live
and delivered as a VGM that existing players run; the preview and the VGM
come from one register log, so they match by construction. Hardware
playback and game integration are given up deliberately (VGMPlay-MSX
plays the MSX VGMs on hardware regardless).

## Rulings (2026-10-25)

- **`def-fm` stays the one FM voice form**, OPLL's 2 ops included — no
  `def-fm2`.
- **Play what can be played** (language.md §19): a voice says so once, and
  only if it plays, because a score's gm import alone gave 2,336 lines on
  msx (2026-11-03).
- In the Live panel, what a machine lacks is hidden; a menu item is disabled.
- **The voice hoist is the driver's alone** (`target.driver`; 2026-10-25,
  the user's reading): on a VGM target it only cut notes 40 ms and moved
  voices off their beat. No `voiceAtKey` per part.

## What lists show on a machine (rulings, 2026-11-03)

- **No declarations.** A set or snippet says nothing about targets: a mark
  comes from what it is (a def's kind) or writes (its channels).
- **An audition sounds on the score's machine.** A wave preset on a machine
  with no wave channels has no ▶ and no keys: sounding it elsewhere left the
  worklet on that machine until the next Play.

## Names (rulings, 2026-11-03)

The names themselves are guide.md §25; the reasons:
- **gm keeps its prefix** because the new-file template imports it, and an
  import hides a ROM voice of the name.
- **A wave's role is a macro** (`wave-piano`): a wave under a still level
  sounds much like any other, and the prefix keeps it from hiding a ROM
  voice of the name, as a macro `piano` would.
- **The ROM voices read as 4-op stay** as what a role is with nothing
  imported — the importers rely on it. fm-roles' voices were picked by
  instrument, not by ear; the user took them as they are for now.
- **Still to discuss:** a 4-bit wave set under the same names, swapped by its
  import as a kit is (`presets/wavetable-4bit`?), and sounds past the fifteen
  roles (`bell`), which might stay macro names only.

## The editor panel (ruled 2026-10-26)

- No wait for the cursor to rest before the panel swaps. (Drawing on a
  stage vector and wave generators are on the roadmap.)

## MIDI (midi; built 2026-11-07)

Rulings, not to re-propose:
- **No chords** (the user): a channel plays one note at a time, as every
  machine's; a chord is several channels.
- **The drums are eight tracks**, `drum1`–`drum8` on channel 10 (the user:
  singular and from 1, as `sqr1`; eight, above the YM2608 rhythm's six).
- **No `def-midi`**: an instrument is `:prog` / `:bank`, a patch a `def` of
  words.
- **`:vel` stays the language's 16 steps**; a finer velocity waits for a
  score that needs it.
- **A CC a word writes is the word's** (the user: both would be ideal, not
  at the cost of reconciling them); the mode messages are not restricted.
- **The faders scale the MIDI output's velocities**; the score is not
  edited.
- **The GM output is a node of its own** (spessasynth_core, FluidR3Mono or
  the user's SF2 / SF3). Turned down: GM in the chips' worklet, an FM GM
  (libOPNMIDI's bank), a first-party SF2 player.

Measured (an iPhone, iOS 18.7, 48 kHz): the worklet module 918 ms, the
sf3's fetch 4.2 s; a sample decodes on first use on the audio thread (a
block's worst 39–61 ms against a 2.9 ms budget), so a plan's programs and
keys are preloaded (141 ms); decoded memory +26 MiB for every program once,
+175 MiB for every sample; CPU 2–9 % for a five-part demo.

Open:
- The on-screen keyboard and a MIDI keyboard's preview notes go to the
  silent synth, not to the MIDI output.
- A program a hot-swap brings mid-play decodes on the audio thread (decode
  off it and `setAudioData` if it is heard).

## Machine conversion (built 2026-11-07)

A score of one 4-op FM machine on another — x68k, md, pc88 — at the words'
level, not through its VGM (the user: what the composer wrote — `:gate`, a
glide, a `:pitch+` curve, the voice defs, the loop — must survive; the VGM
road rebuilds them from registers). Two faces of one module, `score-port.js`:
- **An MDX's Target** (its dialog gets rows as the VGM's: FM A–H, PCM 1–8 →
  the target's channels / drop; Target x68k / md / pc88 / midi). MGS stays
  x68k-far: midi only.
- **Edit > Convert to Machine…**: the open score onto another, the same
  dialog, one undo step; midi offered there too (chipScoreToMidi). A line
  `; Converted from :target x68k` at the top, and the log lists every
  word dropped or approximated.
- Near = both machines have 4-op FM. msx (FM-PAC), pce, fc, gb: not
  offered (stand-ins all over); their road is midi.

What the compiler already does, measured on an x68k score with `:target`
swapped: DT2 is a W_TARGET warning (played without); `:mode whiteN` on an
SSG reads as `:noise-rate` (targets' `readsAs`); every other mismatch is
E_TARGET, the whole list below.

Rules (word-level; the VGM importer's readings, which live at register level
in vgmToMmlisp and cannot be called from here):
| from → to | rule |
| --- | --- |
| x68k fm7/fm8 → md/pc88 | sqr1/sqr2 as square stand-ins (presets/waveforms, `loud-*` as import-song.js), or drop: the rows decide |
| x68k fm8's `:mode noise` notes → md/pc88 | to `noise`: md the nearest `:mode whiteN` by Hz (125 kHz / n vs the PSG's rates, import-vgm nearestWhite), pc88 `:noise-rate` by Hz; its tone notes stay on the FM channel |
| `:lfo-freq N` (OPM) → OPN | `:lfo-rate 1–8` nearest in Hz; `:lfo-wave :lfo-pmd :lfo-amd` dropped (depth is already `:fms`/`:ams`) |
| OPN `:lfo-rate` → x68k | `:lfo-freq` nearest in Hz |
| md fm3-1…fm3-4 → x68k | each a free FM channel of the eight (fm7, fm8, any fm1–6 the score does not use), under a one-operator voice made from fm3's (operator N the carrier, the others TL 127): the same sound. Nothing drops while a channel is free (the user, 2026-11-07) |
| md fm3-csm → x68k | fm3's plain notes, the CSM rate dropped and said (the language has no CSM on x68k) |
| md sqr1–3 → x68k | free FM channels as square stand-ins, after the fm3-N; drop only past the eight, rows decide |
| md noise → x68k | fm8 `:mode noise` under a voice, `:noise-rate` by Hz (fm8 kept free for it when the score has a noise track) |
| pc88 sqr `:mode both` / `:env` / `:env-rate` → md | `:mode tone`, the envelope dropped and said (no reading on the PSG); `:mode env` notes dropped |
| pc88 rhythm1–6 (kit roles) ↔ md pcm1–3 (kit-role samples) | by role: a rhythm track is a pcm track playing `kick` … under the RX5 import, and back where the samples are roles (the import writes both so) |
| pcm: x68k pcm1–8 / md pcm1–3 / pc88 pcm1 | rows, first come; `:fx`, `:rate`, `:file` as they are |
| x68k fm `:pan` ↔ md/pc88 | as is (both have it) |
Levels: the voices' TL as written (the composer's balance); only stand-ins
take `loud-*` where there are no squares to sit beside.

Checks (`check:score-port`): the MDX fixture (check-import-to-midi.mjs
builds one) → md and pc88 compile clean and keep every melodic note (midiPlan
keys, as check-import-to-midi compares); tools/tests' md, pc88 and x68k
scores each onto the other two compile clean, notes kept where a channel
takes them; the dropped-words list is what the rules say.

All built: score-port.js + check, the MDX dialog's Target x68k / md / pc88 /
midi with rows (guide.md § Song imports), Edit > Convert to Machine… (the
import dialog reused; msx, pce, fc, gb offered midi only; guide.md
§ Converting to another machine). The log names a source channel by the
caller's `names` (an MDX's FM A–H, PCM n).

Built (score-port.js, `check:score-port`): `portRows(text, to)` gives the
dialog its rows ({key, head, kind, notes, to, choices}; x68k fm8's noise
notes are the row `fm8/noise`), `portScore(text, to, {rows, imports})` the
text and `said`. Every md score (drv/tests) and the pc88 / x68k test scores
onto the other two compile clean with each kept track's notes (midiPlan on,
key) the same. Where it went past the table above, or off it:
- md noise → x68k is the `noise` channel (fm8's fourth operator alone), not
  fm8 `:mode noise` under a voice: the same words (a noise track, its PSG
  level), fm8 kept free all the same (the rows share by voiceKey).
- OPN `:lfo-rate` → x68k stays `:lfo-rate`: the OPM reads it at full depth,
  which `:lfo-freq` alone would not (its pmd/amd at 0).
- pc88 sqr `:mode env` notes play as tone (the mode dropped and said), not
  dropped.
- fm3-N → x68k: the patch form `(fm3 v)` goes, its `:tempo` onto the first
  operator track; another operator's word on an fm3-N track is dropped; the
  patch's later voices are not followed (said).
- def-se is dropped off md; onto md `:pcm-voices` is set from the pcm rows;
  fm6 is taken while a row goes to pcm.
- The ADPCM-B: a def-pcm's loop becomes its range (`:loop-start` →
  `:pcm-start` …), the head before the loop cut (said).
- A song word in a macro is dropped where the part has no `songMacros`
  (the SSG's `:noise-rate` steps; the OPM's does not).

## Machine conversion, stage 2: PSG and 2-op FM (built 2026-11-08)

md, pc88, x68k, msx, fc, gb convert both ways (score-port.js, voice-port.js;
guide.md § Converting to another machine says what the user sees; Convert
to Machine, and the MDX's and the MGS's Target with rows). Decisions:
- The voice policy (the user's): a role (fm-roles' fifteen = the OPLL's ROM
  names, a gm-* by its program's family, the VRC7's names) plays the
  machine's voice for it; any other voice its nearest presets/waveforms
  voice (nearestRomVoice's weighing, `nearestVoiceOfWords`; a sine that has
  heard carriers above the first harmonic is the triangle — the weighing
  reads only modulators); on the OPLL that waveform's ROM voice, so no
  conversion writes the one user voice. A 4-op def under a ROM name (or an
  imported fm-roles) would hide the ROM voice: it goes. fm-roles' `:key`
  moves the sounding key: the check compares onsets only across the families.
- An OPLL user voice onto 4-op is read as 4-op (opllWordsAs4op), `:ws` and
  `:ksl` said. `:vib` / `:am` (def, inline, macro) are `:fms 4` / `:ams 2`
  (ymfm's OPLL: ±12 cents at 6.1 Hz, 4.8 dB), the LFO `:lfo-rate 4` once at
  the first channel form.
- The noise by Hz across its three writings: the SN's mode, a song-wide
  `:noise-rate`, the 2A03's / Game Boy's note pitch (noiseHzOfNote /
  noiseNoteOfHz in the chips), written again at each change and at a loop's
  bounds.
- Short of channels (the user): the most notes keep the channels, per pool
  (melodic, noise, sample); within the room, the table's order.
- A kit without pitch (pc88's ROM rhythm) plays every note at c4.
- fc's defaults are its own board (listsExpansions); the cartridges are
  choices. A song word counts as the target's only where its part is on the
  board or a row goes there (fc's 5B has :noise-rate, the 2A03 not).
- A split (`<head>/noise`): x68k fm8's `:mode noise` and an SSG square's
  `:mode noise` / `both` (MSX songs' PSG drums) go to the noise where the
  destination's own squares have no noise mode; the tone half keeps the
  song's words (tempo, master, LFO). A mode stepped by a macro is not split.
- Open (stage 3): an SCC song's dead def-wave / wave macros stay.


## Machine conversion, stage 3: the wave memories (built 2026-11-08)

pce joins; the SCC, pce, the FDS, the N163 and gb's wave convert both ways
(wave-port.js; guide.md § Converting to another machine). The user's
answers: a non-role FM voice onto a wave is its waveform's wave AND an
envelope macro off its main carrier's EG (`<voice>-env`, fm-model's egStep
a frame at a time, 2 dB a :vel step); the FDS's modulation ↔ pce's LFO is
mapped; a `(macro :wave …)` off a wave channel keeps all but its waves.
Decisions on the way:
- shapeOf: harmonics 1-15's magnitudes against the six plain shapes; a wave
  repeating within its cycle is read on one repeat (gb's `tri2`).
- pce's kinds share its six voices (wave5 / noise5 / pcm5): one room for
  them all, the noise placed first; FDS-modulated, wave2 is kept for the LFO
  and the FDS row goes to wave1.
- pce's noise is a third pitched noise (PITCHED_NOISE, huc6280
  noiseHzOfNote); it has no :mode.
- FM's LFO words onto pce / fc, and pce's / the FDS's onto anything but each
  other, are dropped (another LFO).
- A def-wave's own curve named as itself (`(def-wave saw :wave (saw …))`)
  is no use of it: pruning counts uses outside the def.
- The check: a channel the source shared between kinds (pce) keeps every
  note it played (a superset there).
- A review (2026-11-08) fixed: presets/wavetable's `wave-<role>` macros
  off a wave channel are their role; the FDS LFO's rate rides on the
  generated wave2 track and a depth written before a track's first note
  starts wave1; wave2 is no row's choice while it is the LFO; a voice after
  a role macro clears its waves (`(macro :wave none)`); fc's tri / vrc6-saw
  keep their shape on a wave; a :duty over half is its mirror; the envelope
  starts at key-on; a quiet wave's repeat tolerance is 3 % of its swing.
- The last three (2026-11-08): a track's `:wave (expr)` off a wave channel
  is read off the wave the compile folds it to (`wave1@line:col` in
  metadata.waves); a channel sharing another's wave memory (`waveRam`: the
  SCC's wave5) is taken last and said when its waves differ; a loop whose
  passes move the noise's octave or a split's :mode is written out pass by
  pass (not when it holds a label or a (break): said).

## FM kept on FM; the carrier's octave (2026-11-08)

The user, on a mucom88 song onto x68k ("FM同士はなるべく活かしてほしい"):
short of channels, a row of the machine's own kind keeps its channel before
a stand-in (then the most notes), so x68k's eight FM take md's six FM and
two of its squares. And onto pce "オクターブが低い印象": an FM voice whose
main carrier is at :ml 2 / 4 / 8 sounds that many octaves above the written
note; a wave or a square plays the written note. Onto them the track is
written up by `carrierOctave` (voice-port.js): `:oct+ k` at the voice, its
`:oct N` writes and `(glide cN …)` raised, back at the next voice (a role's
0: fm-roles' `:key` is theirs). A non-power-of-two multiple (3, 5) is a
partial: no shift. Not yet done for an FM voice onto the OPLL's ROM voices
(their own multiples differ by voice).

## 4-op onto the OPLL: the score's own voices kept (2026-11-08)

The user ("同じFMなのに音色定義捨ててるの、roleに寄りすぎてるんじゃない？"):
a non-role voice of the score's own onto the FM-PAC / VRC7 is no longer a
ROM voice by shape — it stays as a 2-op `def-fm` (`opnAs2op`: the main
carrier and the loudest of its modulators per MODULATORS_OF, rates >> 1,
modulator TL >> 1, FB where op1 is the modulator, SR > 0 → EG 0 with
RR = SR >> 1, OPLL ML nearest; the other operators and DT said). Only
one such voice (`pickUserVoice`): the chip's one user voice is every
channel's, so the own voice with the most notes on rows going to FM keeps
it, the others the ROM by shape (the user found several sounding at once
hard to hear: each key-on rewrote the others' sound). Roles and ROM-named
voices still play the ROM; imported voices (no def to rewrite) and waves
still the ROM by shape. A converted score holds only what it plays
(user, 2026-11-08): `pruneUnnamedDefs` (exported) takes out every def /
def-fm / def-wave / def-pcm nothing names, then what only those named — a
dropped track's macros, a replaced voice, a score's unused library alike
(no "library stays" exception any more); the mucom importer's own pc88 /
md writers run it too (a song's voice list it never plays). envelopeOf reads the carrier's rates with its
key scaling at the track's middle note (`kc >> (3 − ks)`, as fm-model.js):
without it a mucom voice of AR 4 / KS 3 at o5–6 read as a second of
silence and the pce waves were near inaudible (user: "only the PCM plays").
- **Samples on the PC Engine: one stream** (the user, 2026-11-08: its CPU
  feeds DDA a sample at a time; two at once is past it, one is the norm).
  `pceDda.streams: 1` (chips/huc6280.js) — a part's driver-side limit the
  conversion reads, not a compiler rule (a hand-written score may still use
  pcm1-6). planRows caps the sample pool at it; the rows past it are
  "layer" → the kept sample row's channel, and placeLayers writes each a
  `:prio` by drum role (DRUM_RANKS: kick 1, snare/clap 2, tom 3, rim/other 4,
  cymbal 5, hat 6) and `:gate 1t` where the row sets no :mode / gate, so a
  higher layer only wins simultaneous hits (a quarter-note kick held its
  quarter and swallowed every hat). portScore's one-row-a-channel rule lets
  sample rows share a sample channel; the corpus check holds a layered
  channel to sound, the rule test the order and that each hit keeps its
  sample (the voice is per note on PCM, not the channel's). The survey's
  note counts now unroll `(x N …)` — a hat `(x 64 c16 c16)` was 3 notes.
  A channel has one loop (E_PRIO_LAYER_LOOP, and each layer's `#loop`
  E_MARKER_DUP): planRows groups the sample rows by their endless loop,
  read at played ticks as alignLayerLoops does (convertCountedJumps, now
  exported, + expandLoops — a JUMP's own tick is the written one, 504 for
  a 6144-tick loop), keeps the group with the most notes (no-loop rows join
  any), its busiest row the channel's; the others drop, `loopWhy` saying so
  (the user's pcmt13.muc: part K beside part G's rhythm1-6). Its real
  cause was elsewhere: part K's and part G's loops matched, but pcm1 took
  :prio 2 as the snare row did — forms of an equal :prio append, not layer,
  which moved the loop. placeLayers now numbers the rows 1…n in DRUM_RANKS
  order (the busier first among alike).
- **The user's MDX set (DTWNB, 19 songs + PDX) onto every machine**
  (2026-11-08): no conversion errors. Fixed from it: opnAs2op's def is on
  `init-fm` (a channel coming from a ROM voice kept its :ws / :vib / :ksl,
  so its "user voice" differed from another channel's → W_TARGET); the
  compiler's W_SONG_WRITE_RACE only where the two writes differ (each MDX
  part writing :lfo-freq 204 became five equal `:lfo-rate 5`). Open:
  x68k's FM renders ~7 dB under the OPN's for one voice and note (−22.2 vs
  −15.2 dBFS RMS), so an MDX's levels clip on pc88 / md (25k samples on
  DTWNB00 pc88) — a per-machine gain the conversion does not make up; the
  user to decide. The fc triangle's `:vel 0` (a mute) still draws its
  W_TARGET note; left.
- **Open with a Target ≡ Open, then Convert to Machine…** (user, 2026-11-08:
  "is it the same processing?"). For the songs read as their own machine
  first — MDX, MGS, mucom88 past pc88 / md — the Open path is
  `portImported` (index.html): the source's imports resolved, then
  portScore, as Convert does; held equal in the browser (DTWNB00 onto pce /
  msx / md / gb, pcmt13 onto pce / x68k / msx: 0 lines differ). Convert to
  General MIDI now hands chipScoreToMidi the score's samples (`scorePcm`),
  as the import's readViaMidi does: without them the drums' roles were read
  from names (31 lines differed on DTWNB00). Still two roads: VGM, NSF,
  DefleMask / Furnace, MIDI and mucom88's md write each machine themselves,
  so Open onto X and Open + Convert differ (a VGM of ab-core onto pc88: its
  noise dropped by the writer, kept by the conversion; fc / gb channels
  chosen differently) — put to the user, undecided. Inline operator words on such a
track are still dropped (the operators are not the 4-op's).

## mucom88's FM3 operator mode, real songs (2026-11-08)

The user's "def-fm がなくてデフォルトの音" on mucom88 → x68k: Yuzo Koshiro's
sampl1.muc (onitama/mucom88 `package/`, with voice.dat; CC BY-NC-SA, not in
the repo — fetch them to test: raw.githubusercontent.com/onitama/mucom88/
master/package/sampl{1,2,3}.muc, voice.dat) uses FM3's operator mode, and
the pc88 writer puts the shared patch's voice on fm3-1's forms alone (no
note-less `(fm3 v)`). Onto channels of their own each operator track needs
it: `readOpVoices` reads a voice at the head of any fm3-N's n-th form as the
patch's for every fm3-N's n-th form (mucom's sections align forms); a voice
mid-form stays that track's and is said. Also found: the md writer commented
part J out on its first line only (a parse error) — every line now.
sampl3 is PSG-only (no FM voices: its x68k is stand-ins, right).

## Every import onto every machine (2026-11-08)

The user: with every machine converting to every other, no Target list is
held short. PORT_TARGETS is TARGETS' machines of chips (score-port.js). VGM,
NSF and DefleMask / Furnace offer every machine to their own writers (the
holdsSong filter, which kept only machines holding half the notes, is gone:
every machine's VGM onto every machine compiles clean, check:score-port);
mucom88 writes pc88 and md itself (its md reading does more than a
conversion: the SSG envelope as a level macro, the PCM fitted to the
driver's bank) and every other machine as its pc88 score converted; MDX,
MGS, MIDI and Convert to Machine already offered all. A split track's
halves count their own notes: a part all noise gives no channel to an empty
tone half.

## The PC Engine (pce; built 2026-10-27)

- **pce is built** (language.md §19; chips/huc6280.js, targets/pce.js,
  synth-pce.js). What the docs do not say:
  - The chip is read from MAME's c6280.cpp and Mednafen's pce_psg.cpp
    (they agree); the noise at rate 31 clocks every 32 (Mednafen).
  - A noise note is a rate index, not a Hz: the rates are LFSR clocks (1.8
    kHz up), so a Hz mapping put every note at rate 0.
  - A wave named under a note is written there, as Furnace does (the
    load's channel-off is turned back on in the same writes); it was held
    to the next key-on until Bad Dudes showed instruments stepping waves
    through a note (654×) — the reason `(macro :wave …)` exists. A wave
    step naming the wave already playing writes nothing, as Furnace's
    macro does; inline `:wave` always writes.
  - The LFO's depth is in period steps (±16/64/256), so a deep one wraps
    the 12-bit period (Mednafen's & 0xFFF) — not clamped. Measured: a4 at
    :fms 1 / 2 sways ±20 / ±70 Hz.
  - DDA's bytes go out on the CPU timer (`_writeTimer`, not the frame
    snap), a frame at a time (`_ddaFrame`), so another name's note
    dispatched meanwhile can cut the hit. Live gets a frame's ticks as one
    `stream` message: per-write messages stalled the page ~100 ms; streams
    measured as a wave-only score (p95 ~3 ms).
  - Furnace import fidelity is held to Furnace's own VGM of a song, frame
    by frame (pitch, level, wave up to rotation, noise/wave) — a scratch
    tool, not in the repo; Bad Dudes: channels 1-5 match, 6 differs by its
    duty flicker (roadmap).
- **Open:** Bad Dudes as imported since the `:wave` macro is not yet
  listened to in Live.

## The Famicom (fc; built 2026-10-27)

language.md §19 fc is the design (channels, `:duty` in sixteenths, the
triangle with no level, the noise's rates and modes, DPCM's one rate a
def-pcm); chips/rp2a03.js, targets/fc.js, synth-fc.js, tools/tests/fc. What
the docs do not say:

- Tables are nesdev's APU pages (fetched). The encoder queues its timed
  writes and `flush(horizon)`s them in time order (as the SSG's): a pulse's
  $4000 holds volume and duty, which the player sends out of order; a
  silence is written at once (level 0 is silent at any duty) with its state
  queued. The noise sits on the PSG's noise lane 3, pitched (part
  `rateNote`); the PSG encoder hands a view a lane (`lanes`) since each
  channel's period differs. `MASTER_OUTPUT_GAIN` 1.6 puts one pulse's RMS at
  one pce channel's. Open: no VGM player has checked the 0xB4 output.
- **DPCM** (fcDpcm, `frames: true` as pce's
  DDA; ir-player `_dispatchDpcmEvent`, `_dmcRateOf`). The memory is the
  chip's port 1 (RAM_PORT: an address latch, then bytes), a VGM 0xC2 block
  a run (export-vgm `ramBlock`); Live gets a hit's load as one `stream`
  message. Every hit loads its bytes to $C000 — no cache of what is
  resident: a VGM's loop jumps back with the RAM as the song's end left it,
  so a skip decided on the first pass would play the wrong bytes after it.
  The load goes DMC_LOAD_LEAD_SECS (0.5 ms) ahead of the frame's start
  writes (streams and timed writes are separate queues in the worklet).
  In Live the start goes as a stream too: the worklet writes timed writes
  at its 128-sample block's start but streams at their sample, so a start
  sent timed played the previous hit's bytes for up to a block. A seek
  does not replay the loads (`_ramPorts`). Left as they are (review,
  2026-10-27): a restart under a sounding hit carries up to 16 of its bits
  past $4011 (a DC offset, as on the chip); a `:len 0` hold on pcm1 is not
  released by triggerKeyOff (DDA's the same: sample handlers do not
  register holds). A long song's VGM grows a block a hit.
- **The VGM import** (import-vgm.js apuChip): the length and linear counters and
  the envelope run between writes (`advance`), so a note ends where its
  counter ran out and an envelope is a level envelope, the sweep on its
  half frames (and its mute); a DMC hit's sample is the memory as it stood (`bytes` on the
  hit, identity by content) since 0xC2 blocks rewrite it (bank switches);
  `$4011` written on and on is counted as CPU PCM, not imported.
  Approximations kept: a halt cleared under a
  held counter leaves it held; $4017's immediate clock in 5-step
  mode is not.
- Held to real rips (2026-10-27, the user's vgmrips packs, kept outside
  the repo in their Dropbox: Balloon Fight, SMB3, Kirby, Contra, Super
  Contra, Fantasy Zone): scratchpad abfc.mjs renders the VGM's own writes
  and the import's on FcSynth and compares each channel a frame at a time
  (sounding ±1 frame, the chip's own periods). Most tracks agree to a few
  frames (Gimmick 01 TRI pitch 87 %, Balloon Fight 07 SQ1 49 %: the rest is
  a fast fall a sub-frame off the frame grid). Open: Kirby 03 SQ1's 50
  extra frames are a staccato note held to the grid's
  unit (2.7 frames sounding as a 32nd's 5 at Kirby's tempo) at its
  sustain level; Kirby's DPCM not A/B'd. (A VGM's 5B and VRC7 land on
  fc's own chips: the expansions' section.)
- DefleMask / Furnace NES modules built 2026-10-27 (import-tracker.js, the
  readers' NES channels `chip: "nes"`), read from Furnace's nes.cpp
  (fetched): the noise's register rate 15 − (note & 15) under
  properNoiseLayout, else its 253-entry noiseTable (DMFs); the duty
  macro's first step the noise's mode (&1, or > 1 → 1); the volume macro
  and column (VOL_SCALE_LINEAR_BROKEN) multiply under newVolumeScaling
  (in dB they add: the column :vel, the macro :vol) and otherwise add their
  4-bit steps (VOL_SCALE_LOG, clamp(v + m − 15)): DMFs and .fur < 99 (the
  flag the compat block's tenth byte, or CFLG's key), a :vol def per
  column; the triangle on while a volume macro is not 0;
  the pulses' duty 0 (12.5 %) until something sets it, and a duty macro's
  last step held after its note. Open: Furnace's NES demos
  (/Applications/Furnace/demos/nes) not A/B'd against Furnace's own VGM;
  the user's real .dmf (Dropbox) not heard against DefleMask (Darius II
  "06 War Oh!" is corrupt at instrument 131); a fixed-pitch arpeggio (drums) is a :semi from the
  played note, an env a note (2026-10-28), not heard against Furnace yet;
  module DPCM (.fur SMP2/SMPL 8/16-bit and 1-bit DPCM; DMF samples and the
  legacy sample mode as convertLegacySamples, 2026-10-28; the DAC start
  `dpcmDelta`, a loop's part, a sample instrument's pitch and a DMF's DPCM
  at the sample's rate rather than a DMC rate not cross-checked against
  Furnace by ear); the level under a sounding note (a column without a
  note, 0Axy and its kin) as a level line (2026-10-28: :vol under the
  note's top :vel, :vel on fc / pce), not heard against Furnace — and a
  DMF's additive volume macro on fc stays baked at the note's column while
  the line moves it; the duty's
  12xx on a DMF read as Furnace's (DefleMask's own NES 12xx not
  cross-checked). The curve option `:duty` is 1–255 (128 = 50 %) while the track
  word is in sixteenths, as ruled — two scales under one name; raise it if
  it confuses.

## The Famicom's expansions (built 2026-10-28/29)

Ports, lanes and encoders are in synth-fc.js's header and the chips' files;
language.md §19 fc says what the language does.

Open:
- None heard in Live but the VRC6 and the FDS's test score (MMC5, 5B,
  VRC7, N163; the N163's 7-8-channel whine).
- Levels against the 2A03 are choices, not measures: each at full = a 2A03
  pulse at full (the 5B "very loud" per nesdev, its amp's nonlinearity not
  modelled; the N163's boards 11-19.5 dB louder). Every chip at once clips.
- The VRC6 mix not held to Mesen's; its saw's step order NSFPlay's.
- The FDS: a real song heard only from VGM (Zelda II's title); a Furnace /
  DefleMask FDS module checked only as one built in node; its hardware
  envelopes only node-checked (no score or import drives them); the mod
  arithmetic nesdev's, not held to NSFPlay / Mesen.
- :lfo-wave starts the FDS's counter over, so the structured writer's
  restatements (all switches rewritten where the set of kinds changes, a
  def's or a loop's head) add resets the game did not make — a free-
  running modulation's phase jumps there. Not decided (2026-10-29).
- Every fc render starts with a click, probably the DMC's $4011 init write
  (seen 2026-10-29, not checked or fixed).

## FM-PAC: why it is built so (2026-10-25)

- **The rhythm's encoder.** $0E's keys and the $36-$38 volume bytes hold
  several sounds, and hits from different tracks reach the encoder out of
  time order (each track is dispatched to the horizon in turn), so a write
  built from "the current state" would key another sound off. The OPLL's
  rhythm ops are queued with their times and written by `flush(horizon)`,
  which the player calls in `_scheduleStep` once every track is dispatched
  to the horizon (as `_chipPcmFrames`). A dump with no time (a stop) drops
  the queue. The player's rhythm path is the kit part's (`_rhythmEncOf`),
  not the YM2608's by name; the level is the part's ladder (il = top - att).
  The scope shows SD with HH and TOM with TOP, one lane per channel.
- **How the encoder works (chips/ym2413.js), and why.** The IR player does
  not send a channel's writes in time order: a note's pitch, level and op
  macros go out before its key-on, its key-off as it starts (gated) or with
  the next note (full gate). A first build read state from the order and
  lost every macro on the FM-PAC (a vibrato wrote nothing; the review
  caught it). So all of a channel's state is timelines (voice bytes, volume,
  pitch, sustain) and note spans; the player sends `noteOn(ch, when)` before
  a keyed note's macros, and each write reads the state at its own time. A
  run of voice writes at one time is held to the channel's next call and
  written then, stamped with its own time (a write's fourth element,
  `_fmWrites`), so a voice switch never leaves the shared user voice
  half-written. Known: a pitch step inside a `:keyon` macro's off-step is
  written keyed (the retrigger's key-offs go out after the pitch steps).
- **Levels.** `OPLL_GAIN` is set against the PSG and SCC as libkss
  (MSXplay) mixes them, measured on an MGS song (G2_00.MGS) chip by chip.
- **The −45 dB floor stays** (language.md §19 msx; ruled 2026-10-26: the
  chip cannot go lower, and MGSDRV's v0 is the same).
- **Open.** A call with no time (a live edit, a key preview)
  is the encoder's latest time, and `IRPlayer.setParam` writes the edit at
  once (`live`); checked in node, not by ear. A key held over a song
  channel (the OPLL's and the VRC7's: `opllHoldBus`) writes its voice,
  pitch and key past the encoder's timelines (`held`), so the song's stay
  its own; its user voice is the chip's one, the song's other user-voice
  channels' until the song's next key-on. Checked in node and by the
  page's writes, not by ear.
- **ROM voices.** The values are Nuked-OPLL's `patch_ym2413` (read from
  the die), packed into the user voice's layout in chips/ym2413.js; the
  emulator takes the same table (`ol_set_rom`), so a ROM voice and the same
  bytes as the user voice render sample-identical.

## The part model (rulings, 2026-10-26/27)

- **A part's resolution is its encoder's** (the user, 2026-10-26; parts.js
  header): `def-wave` stays −128..127 whatever the chip's bits, `:pan`
  reaches the encoder unsnapped, a wave's other step count (the FDS's 64)
  is a whole repeat, never interpolated.
- **No kind-adapter registry** (2026-10-27): 14 `kind` switches are
  enough; the Live page's channels are slots (`FM_SLOTS`, `TONE_SLOTS`,
  `PCM_SLOT`).
- Next (optional): VGM — one data-block hook for the DAC / ADPCM-B / OKI
  special cases.
- **Review the layering regularly** (the user, 2026-11-03): it was designed
  when the targets were planned, and building them drifts from it — a
  machine's ability answered where it is used (a target's or a part's name
  compared, or an ability inferred: "no FM_ALG, so no operator keys")
  instead of declared on its part or chip, so one output carries it and
  another misses it. What to grep for outside `chips/` and `targets/`:
  `=== "x68k"`-style target names, `part.name ===` / `hasPart("…")`, and a
  capability read off something else. The 2026-11-03 pass moved these into
  declarations: the part's `bank` (sample-bank.js, every consumer's bake),
  `audition`, `mixVoice`, `opKeys`; a synth's hold `bus`; the formants'
  one table (import-resynth.js FORMANT_VOICES). Open from that pass: the IR
  player's sample voices still branch by part name (PCM8's events, the
  ADPCM-B's voice, the DMC, the DDA: `setPcmTrackVol`, `triggerKeyOff`, the
  stop's cuts); the Library's sample preview plays on the Mega Drive's
  engine whatever the score's machine; import-tracker's per-chip writer
  branches (`onPce`, `onFc`) are the module mapping's and stay.

## Song importers for msx / x68k (MGS, MDX; 2026-10-25)

- `import-mgs.js` follows MGSC 1.11's MML reference (MGSC111.TXT, from the
  user: gigamix.jp is out of this environment's reach) and is held to the
  real MGSDRV: `tools/scripts/ab-mgsdrv.mjs` (libkss-js, installed with
  `npm i --no-save libkss-js`, runs the driver and writes VGM) compares an
  import frame by frame. On the five msxplay-js demos (copyrighted, kept
  out of the repo) sounding agrees 86-100% a channel, pitch within 50 cents
  92-100% (a PSG drum part 51%: tones near the period's floor, where our
  exact pitch and the driver's integer period part), levels within a step.
  What is left is a frame of phase on short notes. The rhythm is held to
  $0E's key bits (ko / kf, the end's all-off; Grider and Contrail agree
  99.8-100% a frame), $36-$38's levels and $16-$28's tunings, and y to the
  driver's register writes (a user voice's $00-$07, the PSG's $06/$07).
- MGSDRV's frame, as measured on libkss (2026-10-26, crafted MGS files,
  scratch `g2/mgsq.mjs`, `g2/mgstempo.mjs`): count c starts on frame
  round(c · W / 192), W = floor(14400 / t), a half up; a gate keys off
  floor(note frames · q / 8) frames in, one at least — the msx target
  plays so (`frameClock`, built). Left: a q8 note before a rest keys off
  one or two frames late in MGSDRV. libkss runs the MSX at 59.92 Hz:
  ab-mgsdrv reads it on that frame, mid-frame. A `y14`'s held keys (HH,
  CYM) ring once at the `y` at levels the file does not give (MGSDRV
  writes HH 3 with no `@`), so they are left out; only a song's first
  `y14` is read.
- A secondary source (an AI answer) had `/` `\` `_` in an envelope as volume
  moves or a loop and a rhythm hit's digits as its level: the reference
  says otherwise — not to be re-read from such a source.
- `import-mdx.js` follows MXDRV itself (portable_mdx's port of its 68000
  code), not mdxmini, which is wrong on volume, gates after a tie, `k`, the
  LFO shapes and MA (what it leaves out: the roadmap).
- How an MDX import is held to MXDRV (2026-10-26, on the user's Assault
  set): clone portable_mdx, add to `Opm::OpmPoke` an `fprintf(stderr, "W
  %ld %02x %02x", tick, reg, data)` with `tick` counted up in the Timer B
  interrupt (`OpmIntProc` call), build `examples/simple_mdx2wav`, run it on
  the MDX + PDX; turn the ticks to seconds from the `$12` writes (a clock
  is 1024·(256−TB)/4 MHz); compare against `IRPlayer.captureRegisterLog`
  of the import: key-ons ($08) per channel within 5 ms, KC/KF at each
  key-on, and the pitch held between. What still differs: the software
  LFOs' phase and depth within a note (MXDRV steps them a clock, ~10 ms;
  the import at 60 Hz), `v` rounded to :vel's 2 dB (≤ 1 dB), a looping
  tempo-only track averaged (≤ 1 % over its loop). The x68k synth's
  FM : PCM8 balance was measured on the same build (X68Sound: a TL 0
  carrier 3660/32768, PCM8 volume 8 at full scale 26886/32768). The
  quarter read off the notes (quarterOf) was checked on the Sho set
  (g_shomdx2: 176-clock bars, 44 a quarter; two tracks carry 7-9-clock
  runs, hence the nine-in-ten rule).
- Ruled (2026-10-26): the OPM's voiced noise is fm8's `:mode noise`, not a
  `def-fm` on the `noise` channel — a voice there is fm8 under another name
  (its pitch, :tl, :alg), two ways to write one thing. `noise` stays the
  operator alone, for scores moved from the PSG targets.
- Ruled (2026-10-26, the user): the IR player's `drvBpm` rounding on the
  driver-less targets (0.02-0.04 % off the BPM, ~50 ms over a 2.5-minute
  MDX against MXDRV) stays — not to be "fixed". An import compared against
  its driver drifts that much; compare note lengths (on → off), not
  absolute times, past the first minute.

## NSF in (built 2026-10-29)

import-nsf.js runs each song on cpu6502.js and feeds import-vgm.js's chip
models (`nesChips`: the VGM ones, plus vrc6Chip, n163Chip and apuChip's
`mmc5` mode, none of which a VGM reaches). How songs and loops are found is
guide.md §23; what it does not say: the state hash leaves out the chips'
registers, which would put the loop a section late; an N163 wave is kept on
32 steps at its own pitch (a wave length in the language is a separate
discussion, not proposed here).

Open:
- Held to synthesized NSFs (tools check:import-nsf), one headless run of
  Live's dialog, and two real NSFs against their VGM rips (the import
  session's review, 2026-10-29): SMB3 song 1 loops at 0 and ends at 14.40 s
  (the rip 14.38), the same strikes; Falsion song 1 (FDS) comes round at
  89.6 s where the rip loops at 44.7 — its driver detunes pulse 2 by one
  period step every other pass ($4006 aa/a9), so two passes are the exact
  loop (kept: not halved to the rip's). Frame by frame only Parodius Da!
  #03 (the user's Dropbox "Chip - NSF"; its own writes and the import's,
  both on FcSynth, each APU channel's level a frame — the session's
  scratchpad abnsf.mjs, not kept): SQ1 / SQ2 agree; TRI sounds ≤ 1 frame
  past each linear-counter end (its sub-frame end against a frame-clocked
  key-off); the DMC 92 frames short in runs under 4, not looked into.
- A play call's writes land a few cycles apart, so a strike and its
  retrig in one burst (0.1 ms) count as two notes in the dialog's row
  counts (SMB3's noise 133 against the rip's 85); the score keeps the later
  of two on one tick, so it is unchanged.
- The 6502's cycles are base counts (+ branch and page crossing), not
  bus-exact; $4015 and the FDS's other registers read back 0 — a driver
  waiting on the DMC's or a length counter's status would misread.
- VRC6 / N163 notes are keyed by level (no key bit): a pitch jump at a held
  level is a slur, as the 5B's and the FDS's are from VGM; $9003's
  frequency shift is not followed (its halt is).
- The FDS's state hash leaves out its RAM above $7FFF (a driver keeping
  its state there falls to the writes' period).

## Songs on another machine (built 2026-11-03)

x68k's quiet FM is the synth's, measured (a TL 0 carrier at −19 dBFS, X68Sound);
the waveforms stand-ins sit 12 dB under that, hence `loud-*` (import-song.js).

A 4-op voice on the OPLL / VRC7 is the nearest ROM voice (import-fm-voices.js
`nearestRomVoice`): as user voices three voices on six channels overwrote each
other at every key-on (Asuka 120% 07 on msx, the user's report).

Open: the conversions' voices and drums are chosen, not tuned by ear (the
nearest ROM voice's weights included); a stand-in
beside a song's own FM on x68k keeps the preset's level.

## The Game Boy (gb; built 2026-11-03)

language.md §19 gb says what the language does; chips/lr35902.js, targets/gb.js,
synth-gb.js, tools/tests/gb, `tools npm run check:gb-level`. What the docs do not
say:

- **The level (ruled 2026-11-03, the user).** Zombie mode with the target in the
  high nibble (chips/lr35902.js's header). SameBoy steps +1 a write whatever
  that nibble, MAME and libvgm's gb_mame.c take it as the volume at once, so
  both land on the target. Furnace's own sequence ends on `$08`, which reads as
  silence on the MAME cores: not copied. Rejected: a retrigger per level (the
  noise's LFSR goes to 0 each time, a 60 Hz loop); the hardware envelope as a
  word (imports bake it).
- The encoder's level is a count from the one before, so its queue is applied
  a time at a time. A VGM's loop jumps back with the level as the end left it:
  a move before the first key-on after the loop point lands off on SameBoy,
  until that key-on. Not handled.
- The wave lane is on the PSG encoder (`_toneEncodersOf`: a wave part of a chip
  with a psgEncoder), as NR51 is one register. A note does not trigger it: only
  a load does (Furnace's way, NR30 off at every key-on, pops).
- The synth starts its capacitor charged (`charge`): the DACs going on at the
  song's start are a step of up to 4 × the channel's swing, a full-scale thump.
- gbChip runs the synth's Apu and reads its state after each burst of writes
  (SETUP_T): a zombie move runs the level through every step on its way.
- Furnace's noise: gb.cpp's table at the note itself (held to its VGM of the
  demos, not `baseFreq − 60` as the source reads); a fixed arp 24 up.

Held to (2026-11-03; scratch tools, not in the repo; the music stays outside):
- The user's four vgmrips packs (Dropbox GameDev/VGM/Downloads/VGM - Game Boy:
  Kirby, Pokemon, Quarth, Super Mario Land, 100 tracks): each VGM's writes and
  the import's replayed on the Apu, first 30 s, a frame at a time, ±1 frame.
  All import and compile; sounding, period (1.2 %, the noise's rate a quarter
  octave) and level within 1 agree 99.7-100 % per channel. Left: Pokemon Healed
  SQ1 pitch 41 % (a fall of a frame a step, a frame off); Jigglypuff level
  32-39 % (a duty flickering every 2 frames makes short notes, each at its first
  level: Bad Dudes' duty flicker on fc).
- Furnace's 15 demos against the VGM its CLI writes (`furnace -vgmout`): sounding
  98-99.7 %, level 99.4-99.8 %, pitch 92-96 % (instruments'
  pitch macros, and a duty macro switching the noise under a note). Left:
  Pleasure_of_Tension SQ1 22 %, spreadtro SQ2 46 %, lagtrain SQ2 55 %, freedom
  SQ1 69 %, not looked into.
- The user's .dmf: none compared.

Open:
- Not run on a real core: the VGM on libvgm's sameboy_apu.c and gb_mame.c. The
  zombie rule is a transcription of SameBoy, unlocked envelope assumed, the MAME
  reading from its source; building libvgm in the scratchpad was refused by the
  session's auto mode. `tools check:gb-level` holds both readings on our log.
- `MASTER_OUTPUT_GAIN` puts one pulse at a 2A03 pulse's RMS: a choice, not a
  measure.
- A .fur in the old INST format (versions before 127): its software-envelope
  flag and sequence are past what the reader reads, so from 106 a volume macro
  stands in for the flag and a sequence is lost.
