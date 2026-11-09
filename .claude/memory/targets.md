# Targets beyond the Mega Drive — rulings and open items

What each machine does is language.md §19; how a chip's encoder works is in
its file's header (`live/src/chips/`). This file keeps only the rulings not
to re-propose, the traps the code does not explain, and what is open.

The other machines have no driver on purpose: a score there is delivered as
a VGM that existing players run (the preview and the VGM come from one
register log). Hardware playback and game integration are given up.

## Rulings

- **`def-fm` is the one FM voice form**, the OPLL's 2 ops included (no `def-fm2`).
- **Play what can be played** (§19): a voice says so once, and only if it
  plays. A gm import alone gave 2,336 lines on msx.
- What a machine lacks is hidden in the Live panel; a menu item is disabled.
- **The voice hoist is the driver's alone** (`target.driver`): on a VGM
  target it cut notes 40 ms and moved voices off their beat.
- **Lists declare nothing about targets**: a mark comes from what a set or
  snippet is (a def's kind) or writes (its channels). An audition sounds on
  the score's machine; a wave preset on a machine with no wave has no ▶.
- **Names** (guide.md §25): gm keeps its prefix (the new-file template
  imports it, and an import hides a ROM voice of the name); a wave's role is
  a macro (`wave-piano`) for the same reason; the ROM voices read as 4-op
  stay what a role is with nothing imported (the importers rely on it).
- **A part's resolution is its encoder's**: `def-wave` stays −128..127,
  `:pan` reaches the encoder unsnapped, the FDS's 64 steps are a whole
  repeat, never interpolated. No kind-adapter registry.
- **Review the layering regularly** (the user): grep outside `chips/` and
  `targets/` for `=== "x68k"`-style names, `part.name ===`, `hasPart("…")`
  and abilities inferred from something else; declare them on the part or
  chip instead.
- **The FM-PAC's −45 dB floor stays** (the chip, and MGSDRV's v0).
- **The OPM's voiced noise is fm8's `:mode noise`**; `noise` stays the bare
  operator, for scores moved from the PSG targets.
- **`drvBpm` rounding stays** (0.02–0.04 % off; ~50 ms over 2.5 min against
  MXDRV): compare note lengths, not absolute times, past the first minute.
- **gb level**: zombie mode with the target in the high nibble. Rejected: a
  retrigger per level (the LFSR resets, a 60 Hz loop); the hardware envelope
  as a word (imports bake it); Furnace's sequence ending on `$08` (silence on
  the MAME cores).
- **A 4-op voice on the OPLL / VRC7 is the nearest ROM voice**: as user
  voices, three voices on six channels overwrote each other at every key-on.

## MIDI (midi) rulings

- No chords (a chord is several channels); `drum1`–`drum8`; no `def-midi`
  (`:prog` / `:bank`, a patch a `def`); `:vel` stays 16 steps.
- A CC a word writes is the word's. The faders scale the output's
  velocities, not the score.
- The GM output is a node of its own. Turned down: GM in the chips'
  worklet, an FM GM (libOPNMIDI's bank), a first-party SF2 player.
- Measured (iPhone, iOS 18.7): a first-use decode on the audio thread costs
  a block 39–61 ms (hence the preload); every sample decoded is +175 MiB.

## Machine conversion rulings

- **At the words' level, not through the VGM**: `:gate`, glides, curves,
  the voices and the loop must survive.
- **Pool order is the user's**: nothing drops while a channel is free; FM
  stays on FM; bass and melody first; kick and snare a channel each, the
  rest layered.
- **Onto the OPLL, one own voice stays a 2-op def-fm** (only one: several
  rewrote one another's sound).
- **A converted score holds only what it plays.**
- **The mix never plays quieter than the song**; a level change is a
  `def-mod`; only normalize and the limiter sit in a def-pcm's `:fx`.
- **One road**: every song import writes its own machine's score, any other
  machine is that score converted (Open onto X ≡ Open + Convert). A song no
  one machine has every chip of becomes the machine's that keeps the most
  notes — never the MSX (its channels need tuning by hand).
- **Machine options** (fc's cartridges, msx's SCC / FM-PAC, pc88's Sound
  Board II, x68k's PCM8): the same on all four, remembered per machine in
  the prefs so a run of songs needs no resetting; not in the MCP.

Open:
- A phrase at several octaves takes its lowest play's lift under a tone's
  floor (said; split per octave if a score needs it).
- On pce / gb a wave row beats a noise row in three surveyed songs.
- Noise layers onto x68k give W_SONG_WRITE_RACE (one AY noise rate).
- The conversions' voices and drums are chosen, not tuned by ear; a stand-in
  beside a song's own FM on x68k keeps the preset's level.
- The song-import dialogs' machine boxes not checked in a browser (Convert
  to Machine was).

Test material (outside the repo): the user's Dropbox GameDev/VGM/Downloads
(VGM, MDX, MGS, mucom88, MIDI, NSF, .dmf); DTWNB MDX set; BF_4TH.MGS;
pcmt13.muc; Koshiro's sampl1–3.muc (onitama/mucom88 `package/`, CC BY-NC-SA).

## Traps the code does not explain

- **DPCM loads its bytes on every hit**, no residency cache: a VGM's loop
  jumps back with the RAM as the song's end left it.
- **Live sends a sample frame's writes as one `stream` message**
  (DDA, DPCM loads and starts): per-write messages stalled the page ~100 ms,
  and a timed start played the previous hit's bytes for up to a block.
- **The pce noise note is a rate index**, not Hz (a Hz mapping put every
  note at rate 0); the LFO's depth wraps the 12-bit period, not clamped.
- **pce `:wave` inside a note is written there** (Bad Dudes steps waves
  through notes); the macro skips a step naming the playing wave.
- **gb**: a VGM's loop jumps back with the level as the end left it, so a
  move before the first key-on after the loop lands off on SameBoy (not
  handled).
- **MDX follows MXDRV** (portable_mdx), not mdxmini (wrong on volume, gates
  after a tie, `k`, the LFO shapes, MA). MGS follows MGSC 1.11's reference;
  an AI answer that read `/ \ _` as volume moves is wrong.
- **The NSF state hash leaves out the chips' registers** (they would put
  the loop a section late). Falsion's two-pass loop is exact (its driver
  detunes pulse 2 every other pass): not halved.
- How to hold an MDX import to MXDRV: portable_mdx with an `fprintf` in
  `Opm::OpmPoke` and a tick counted in the Timer B interrupt, against
  `IRPlayer.captureRegisterLog`. MGS: `tools/scripts/ab-mgsdrv.mjs`
  (`npm i --no-save libkss-js`).

## Open per machine

- **pce**: Bad Dudes since the `:wave` macro not heard in Live; its channel 6
  differs by its duty flicker (roadmap).
- **fc**: no VGM player has checked the 0xB4 output; every render starts
  with a click (likely the DMC's $4011 init); Kirby 03 SQ1 holds a staccato
  note 50 frames long; Kirby's DPCM not A/B'd. Furnace NES demos, module
  DPCM, fixed arps and the level line not heard against Furnace. The curve
  option `:duty` is 1–255 while the track word is sixteenths (raise if it
  confuses).
- **fc expansions**: only the VRC6 and the FDS heard in Live; their levels
  against the 2A03 are choices; every chip at once clips.
- **NSF**: the 6502's cycles are not bus-exact; $4015 and the FDS's other
  registers read back 0; VRC6 / N163 notes are keyed by level; $9003's
  shift is not followed; Parodius #03's DMC is 92 frames short.
- **msx**: a live edit or key preview over a song channel (`opllHoldBus`)
  checked in node only, not by ear.
- **gb**: the VGM not run on libvgm's sameboy_apu.c / gb_mame.c;
  `MASTER_OUTPUT_GAIN` a choice; an old-INST .fur (< 127) loses its
  envelope sequence; Furnace demos Pleasure_of_Tension, spreadtro, lagtrain,
  freedom differ in pitch, not looked into.
- **Layering pass leftovers**: the IR player's sample voices still branch by
  part name (PCM8, ADPCM-B, DMC, DDA); the Library's sample preview plays on
  the Mega Drive's engine whatever the machine.
