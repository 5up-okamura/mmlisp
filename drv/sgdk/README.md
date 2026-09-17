# MMLispDRV in an SGDK project

How to play an MMLisp score on a real Mega Drive (or an accurate emulator) from
an [SGDK](https://github.com/Stephane-Dallongeville/SGDK) program.

> **Verification status.** The sequencer is proven byte-for-byte against the
> JS reference on the host (`npm run c-gate`, 41 scores); the slot → pair
> converter against its JS twin (`npm run pairs-gate`); the three engine images
> with the converter in the JS instruction model (`npm run engine:gate`,
> `npm run engine:score`). `npm run sgdk:lint` type-checks the glue against a
> shim. The glue built with SGDK 2.x + m68k-elf-gcc 13.2.0 ran headless in a
> patched BlastEm on the one-voice engine that preceded the three images
> (`npm run sgdk:gate`); that gate is being moved to the images and stops with
> a message until it is. Not yet run on hardware.

## Files

```
drv/sgdk/mmlispdrv.h        host API
drv/sgdk/mmlispdrv.c        host implementation (Z80 bring-up, the two pumps, the grab)
drv/sgdk/mmlispdrv_bin.h    generated: the three Z80 engine images + their ABI constants
drv/68k/mmlispseq.{c,h}     the sequencer — 68k code, compiled INTO your game
drv/68k/mmlpairs.{c,h}      the slot -> pair converter, also compiled into your game
drv/68k/tables.c            generated: the sequencer's constant tables
drv/sgdk/example/main.c     minimal player program
drv/sgdk/example/song.res   the BIN resource for the MMB
```

Regenerate the generated files after any engine or table change:

```
cd drv && node tools/emit-bin.mjs && node tools/gen-c-tables.mjs
```

## Installing into your project

`tools/install-sgdk.mjs` copies the files above into an SGDK project — use it
instead of copying by hand after every driver change:

```
cd drv
node tools/install-sgdk.mjs ~/path/to/project                 # driver files only
node tools/install-sgdk.mjs ~/path/to/project --song mysong.mmlisp
node tools/install-sgdk.mjs ~/path/to/project --dry-run       # show what would change
```

It regenerates the artifacts first (so a stale `mmlispdrv_bin.h` or `tables.c`
can never be installed), overwrites the driver-owned files, and **only ever
creates** the files that become yours to edit — `res/song.res` when the project
has none, and `src/main.c` only with `--example`. Your `main.c` is never
touched. With `--song` it also compiles the score to `res/song.mmb` (plus
`res/song.smp` for PCM scores) and prints the track ids `MMLisp_startTrack`
takes. Set `MMLISP_SGDK_PROJECT` to skip the path argument; `--help` lists every
option.

The project layout it produces:

```
src/main.c                yours
src/mmlispdrv.c           host glue
src/mmlispseq.c           the sequencer
src/mmlispseq_tables.c    its constant tables
src/mmlpairs.c            the slot -> pair converter
inc/mmlispdrv.h  inc/mmlispseq.h  inc/mmlpairs.h  inc/mmlispdrv_bin.h  inc/mml_rate.h
res/song.res  res/song.mmb  [res/song.smp]
```

## The pipeline

```
mysong.mmlisp ──mmb-build.mjs──▶ song.mmb [+ song.smp] ──rescomp(BIN)──▶ ROM
                                                                          │
 main loop:  MMLisp_frame()  ─ mmlispseq.c renders one slot a frame ─┐    │
                              mmlpairs.c: slot -> {op,val} pairs     │    │
 interrupts: VBlank + HBlank line 93 pumps ─ ≤ 8 pairs a grab ───────┤    │
                                                                     ▼    ▼
 Z80: the score's engine image (1-3 PCM voices, 14,376 / 10,112 / 6,653 Hz);
      a fixed DAC clock from its own instruction stream; pairs go to the
      YM2612 or into the PCM voices' state
 PSG: written by the 68000 straight to $C00011
```

1. **Compile the score to an MMB:**
   ```
   node drv/tools/mmb-build.mjs mysong.mmlisp res/song.mmb
   ```
   The tool prints the track count; track ids are `0..count-1` in declaration
   order.

2. **Drop the driver + glue into your project** — `install-sgdk.mjs` above.

3. **`make`** with SGDK as usual, then run the `.bin`/`.md` in an emulator.

Minimal program (the full one is `example/main.c`):

```c
MMLisp_init();                       // upload + boot the engine
if (!MMLisp_isReady()) { /* bring-up failed */ }
MMLisp_setSampleBank(song_smp);      // PCM scores only
MMLisp_loadScore(song_mmb);
MMLisp_attachInterrupts();           // the two pumps: VBlank + HBlank line 93
for (u8 i = 0; i < MMLisp_trackCount(); i++) MMLisp_startTrack(MMLisp_trackId(i));

while (TRUE) {
    /* … your game … */
    MMLisp_frame();                  // ONCE per frame, last: renders, takes no bus
    SYS_doVBlankProcess();
}
```

## How it works

- **Loading.** `MMLisp_init()` uploads the one-voice engine image (6,912 B:
  code, the clamp table, the 8 rung pages) to Z80 RAM at 0x0000, pulses reset
  and polls the engine's ready mark (`MMLISPDRV_READY` reads `0xD2`) for up to
  a second. `MMLisp_loadScore()` boots the image the score's MMB header names
  (its PCM voice count) when that is another one, and re-applies the sample
  bank register. While MMLispDRV owns the Z80 you must not use SGDK's XGM/PCM
  drivers — it writes the YM2612 and the PSG itself.

- **The clock is the Z80's instruction stream.** No interrupt, no timer: the
  engine is an unrolled lap of constant-time slots, one DAC byte per slot at
  its image's rate. A bus stop is not repaid — the DAC holds its byte and runs
  slow by the time the bus was held. Everything else — FM register writes and
  the PCM voices' state — arrives as 2-byte `{op, val}` **pairs** in a 128-pair
  page the engine reads at fixed slots of its lap (`docs/driver.md` §5, §6).

- **`MMLisp_frame()` — once per frame, in the main loop — renders ahead.** It
  runs the sequencer and turns each slot into pairs (`mmlpairs.c`), up to
  `MMLISP_LEAD` (default 1) frames past the ones whose time has come; it takes
  no bus. The pumps send only frames whose time has come, counted from SGDK's
  `vtimer`, so **the tempo follows the video clock, not your main loop**: a
  main loop that runs late delays nothing that was ready, and the next call
  renders the missed frames (on BlastEm, sin008 with the example's main loop
  loaded to overrun every 64th frame: the FM timing moved 10.8 ms in 20 s,
  under one frame). A main loop more than three frames behind is a stop — a
  load, a pause screen — and the music pauses with it (`MMLispStats.pauses`)
  instead of bursting through the missed frames. Each frame of lead is a frame
  of latency on the control calls.

- **The two pumps — from interrupts.** `MMLisp_attachInterrupts()` installs a
  VBlank callback and an HBlank one at line 93. Each takes the bus once, reads
  the engine's pair index, writes eight pairs ahead of it (the real ones, then
  IDLE) with four `movep.l`, and releases — about 1,100–1,320 master clocks on
  BlastEm. Two a frame is 960 pairs a second. Line 93 puts them 131 lines apart
  both ways on NTSC. **A frame leaves from the HBlank pump;** the VBlank one
  sends only what the previous frame's could not fit, so in the usual frame it
  just reads the index, away from SGDK's DMA flush right after the VBlank
  interrupt. The music is a constant half-frame later for it. If your game has its own VBlank/HBlank callbacks, call
  `MMLisp_pump()` from them instead (at line 88–98 for the HBlank one); the
  HBlank vector needs an interrupt function, which is what `MMLisp_hint` is.

  A pump that comes late — the engine already past where the pairs were
  planned — notices it inside the grab, writes nothing, and the next one
  catches up (`MMLispStats.late`). Pairs are never handed to the engine behind
  its read index.

- **A game that needs HBlank for itself** (raster effects): call
  `MMLisp_attachVBlankOnly()` instead. One pump a frame from the VBlank
  callback, HBlank untouched. The DAC rate does not change — it never depends
  on the 68000 — but the wire halves to 480 register writes a second (a voice
  change on several channels mid-song takes ~8 frames instead of ~4 to reach
  the chip; the song's start is primed at load either way). If your own handlers
  call `MMLisp_pump()`, tell the host how often with
  `MMLisp_setPumpsPerFrame(1 or 2)` — a grab writes further ahead of the engine
  when the next one is a frame away.

- **PSG** bytes go straight from the 68000 to `$C00011`, one grab period after
  they were queued so they land with the FM they were cued with.

- **Load first, start when settled.** `MMLisp_loadScore()` primes the score:
  the chip's neutral patch and every track's leading setup (voices, levels)
  leave over the next frames, so the starts later send only what differs. A
  six-channel song's load is ~250 register writes — sixteen frames of the wire
  — and the first notes used to queue behind it (252 ms late on sin008). Load
  during a transition and start once `MMLisp_isSettled()` is TRUE; starting
  sooner is still correct, the first notes just come later.

- **Control.** `MMLisp_startTrack` / `stopTrack` / `keyOff` / `setParam` /
  `fadeTrack` / `setVal` are plain calls into the sequencer. They take effect on
  the next frame rendered and reach the chip within about a frame after that.

- **Starting tracks: all in one frame.** Each track's clock starts on the frame
  it was set up in, so staggering the starts leaves the tracks permanently out of
  phase. The setup frame is silent by construction (`docs/driver.md` §4.2).

- **PCM against FM.** A PCM start sounds within about 1.5 ms of the FM key-on
  on the same beat (`tests/m3-pcm-sync.mmlisp`, graded by the model gate). The
  converter sends a frame's PCM commands ahead of its FM writes, and only the
  staged bytes that changed, so a repeated drum hit costs one pair.

### Bus stops that are not the driver's

SGDK halts the Z80 on its own, and the engine repays no stop:

| halt | when | measured | what to do |
| --- | --- | --- | --- |
| `JOY_update` (`HALT_Z80_ON_IO`, default 1) | every VBlank, per pad port | ~2,490 master per 6-button pad | `JOY_setSupport(port, JOY_SUPPORT_OFF)` for ports you do not read; or rebuild SGDK with `HALT_Z80_ON_IO 0` |
| `DMA_flushQueue` (`HALT_Z80_ON_DMA`, default 1) | every VBlank with auto-flush on, **even with an empty queue** | ~600 master empty, growing with the DMA | `DMA_setAutoFlush(FALSE)` if you do not use the DMA queue |

With both pads read and the auto-flush on, the VBlank window carries ~5,700
master of stop a frame (~106 µs): the DAC runs slow by it, about 0.6%, a few
cents flat. A big DMA every frame stops the DAC for its whole length. Stops up
to 200 µs twice a frame were judged inaudible on drum PCM
(`.claude/memory/plan-pcm-spec.md`, D9).

### Banking

**The score needs no alignment.** The 68000 reads the MMB out of its own address
space.

**The PCM sample bank rides the Z80's window.** `song.smp` is a full 32 KB,
32 KB aligned (`BIN song_smp "song.smp" 32768`): the samples, then zeros up to
the top page (`$7F00..$7FFF` of the bank), which is the silence the voice parks
in between notes. The exporter refuses a bank whose samples reach that page.

### PCM sample banks

A score with `def :sample` compiles to **two** blobs: the MMB and a `song.smp`
sidecar holding the raw 8-bit sample data (`docs/mmb.md` §10). Two things, both
required:

```
res/song.res:   BIN song_smp "song.smp" 32768
main.c:         MMLisp_setSampleBank(song_smp);
```

Both ship commented out — the BIN because rescomp fails on a BIN whose file does
not exist, and the call because `song_smp` is not a symbol until the BIN exists,
so a non-PCM project would not link. In `example/main.c` step 2 is a single
`#define MMLISP_PCM_SAMPLES` near the top rather than a call buried in `main`,
and the program **refuses to start** if the score plays PCM and no bank was
published. That is deliberate: the misconfiguration is silent by construction,
and a warning sharing the screen with normal output is one you scroll past.

Call `MMLisp_setSampleBank` after `MMLisp_init`. Its order against
`MMLisp_loadScore` does not matter: the pointer is remembered and re-applied on
every load. Until it is called the engine plays silence (every voice boots
parked at rung 0), whatever ROM bank the window shows.

**Uncommenting the BIN line alone does nothing.** rescomp then puts `song.smp`
in the ROM and declares the symbol, but nobody tells the driver where it is:
every PCM note is dropped and the DAC is never enabled, so it sounds like a
missing part rather than like noise. Measured on a real 9-track import: 1 `$2A`
write over 600 frames without the call, 94,851 with it. (Noise is what a *wrong*
non-zero bank gives you.)

One more way to silence PCM with no error at all: **start the whole track list,
not a count of your own.** PCM tracks sit near the end of it, so a constant that
stops short drops exactly them — and nothing reports it. Ask the MMB instead:

```c
for (u8 i = 0; i < MMLisp_trackCount(); i++)
    MMLisp_startTrack(MMLisp_trackId(i));
```

This is the second-most-common way to lose PCM and it looks identical to the
first (the missing sample bank): the song plays, the drums do not.
`MMLisp_needsSampleBank()` tells the two apart — true means the bank, false with
missing PCM means the count.

### Two SGDK-specific traps, both found on the first real build

- **`<stdint.h>` cannot follow `<genesis.h>`.** SGDK's `types.h` `#define`s
  `uint8_t`, `int8_t`, `size_t`, `ptrdiff_t` and friends as **macros** over its
  own `u8`/`s8` types, so a standard header included afterwards goes on to
  declare names that are no longer identifiers — dozens of confusing errors far
  from the cause. `mmlispseq.h` therefore takes SGDK's types under `SGDK_GCC`
  and the standard ones everywhere else. The same applies to any file of yours
  that includes both.

  A consequence worth knowing: SGDK's `s8` is plain `char`, whose signedness is
  implementation-defined. The sequencer asserts it is signed at compile time,
  because getting that wrong would be an audible bug rather than a crash.

- **SGDK's `<string.h>` is not standalone-includable** — it types its prototypes
  with `u16`/`s8` and assumes `types.h` came first, and it does not declare
  `memcpy`/`memset` at all (those are in `<memory.h>`, with a different
  signature from the standard one). The sequencer uses no libc for exactly this
  reason.

### Reading `MMLispStats`

`MMLisp_readStats()` costs no bus grab — every number is the host's own:

- `pending` — pairs waiting for the wire. A handful is steady state; a number
  that keeps climbing means the score asks for more than two grabs a frame carry
  (960 pairs a second), or the pumps are not running.
- `grabs` — should advance by ~120 a second.
- `late` — grabs that found the engine past their destination and left the
  pairs to the next one. A few is harmless; steadily climbing means the pumps
  are not evenly spaced.
- `overflow` — pairs lost to a full queue. Must stay 0.
- `faults` — PCM commands for a voice the booted image does not have. Must
  stay 0: the score and its image disagree.
- `image` — the PCM voice count of the booted engine image.
- `rendered` / `due` — frames rendered, and frames whose time has come;
  `rendered - due` is the lead, normally `MMLISP_LEAD`.
- `pauses` — times the main loop fell more than three frames behind and the
  music paused with it.

### If `make` fails with no output at all

GNU Make 3.81 — the one Apple ships, and what SGDK's makefile runs under on
macOS — can fail **silently** during its `-include $(DEPS)` phase when
`out/<build>/res/song.o` is missing or stale, because the dependency rules list
it as a prerequisite and errors in that phase are suppressed. You get
`make: *** [release] Error 2` and not one line more.

It bites exactly once, when an existing `out/` predates a change to
`res/song.res`. The fix is a clean build:

```
rm -rf out res/song.h && make -f $GDK/makefile.gen
```

A clean tree builds fine. (If you want to see what make is hiding: `make CLEAN=TRUE <target>` skips
the include phase and prints the real error.)

## Confirming it works

1. **Ready mark.** `MMLisp_isReady()` false means the engine never reached its
   loop: the upload or the reset path is wrong, not the score.

2. **Is the wire moving?** `grabs` climbs by ~120 a second and `pending` stays
   small. `grabs` frozen means the pumps are not installed
   (`MMLisp_attachInterrupts()` or your own callbacks).

3. **Is the 68k feeding it?** `rendered` climbs by 60 a second; if not,
   `MMLisp_frame()` is not being called, `MMLisp_loadScore` returned false, or
   no track was started.

4. **The machine gate** does all of the above and more on a real SGDK build:
   `cd drv && npm run sgdk:gate -- path/to/score.mmlisp --seconds 20 --keep`
   (needs SGDK at `$GDK` or `~/Developer/gendev/SGDK`, the m68k toolchain, and
   the probe BlastEm from `drv/blastem/setup.sh`). Besides the chip writes and
   the DAC it grades the timing: the FM's lag behind the reference's frames may
   not climb over the run (a climb is a lost frame). `--burn N` loads the
   example's main loop like a game's, overrunning every 64th frame.

5. **Where the 68000's time goes:** `npm run sgdk:profile -- score.mmlisp`
   times the driver's functions in the same build (probe marks on entry and
   exit); `--pc` samples the 68000's PC instead and names the inlined source
   lines, `--peak N` only inside the N heaviest renders. On sin008 the driver
   takes ~28% of the 68000 on average — the render ~18%, the two pumps ~6% —
   and the worst render ~116% of a frame (a voice change on several channels),
   which the render lead absorbs.

### Two tools that settle almost any "it sounds wrong" report

Worth reaching for before theorising:

- **VGM log = what the chips actually got.** In BlastEm, `m` starts/stops a VGM
  recording (`ui.vgm_log`). Every YM2612/PSG write lands in it with timing, so
  parsing it tells you whether the driver stopped writing, wrote something wrong,
  or wrote correct music that you nonetheless could not hear. A silence that
  shows a *uniform* write stream is not a driver bug.
- **Driver state = what the driver thinks.** Almost all of it is 68k memory,
  so `MMLisp_trackActive` and the `MMLSeq` struct are readable in your own
  debugger with no bus grab at all.

  **Read Z80 RAM on demand only.** Every
  read halts the Z80, and the DAC runs slow by it.

One emulator gotcha, since it cost an evening: **BlastEm's audio output on macOS
dies after a few minutes** — a burst of noise, then permanent silence, while the
emulated machine keeps running normally. Raising `audio { buffer 512 }` to 2048
stops the crackling that precedes it but not the dropout itself. Restart the
emulator, or use another one for long listening sessions.

Three independent checks pinned that on the emulator rather than the driver, and
they are the ones to repeat if playback ever "stops": driver state read back
healthy, a VGM log of the same session uniform end to end, and **BlastEm's
oscilloscope (`o`, `ui.oscilloscope`) still showing waveforms while nothing is
audible** — that last one takes two seconds and settles it outright.

## What plays

Everything the language compiles to, except SE:

- Notes/rests/ties, per-note length + gate, slur/legato, loops (counted +
  infinite JUMP), `CALL`/`RET`, markers, `len=0` holds, FM + PSG voices and
  levels, `VOICE_SET`, tempo changes.
- **Motion:** `:vol`/`:master` curve fades and level LFOs
  (`PARAM_SWEEP`/`_STOP`), relative writes (`:vel+` etc), tempo ramps.
- **Pitch:** inline `:pitch` detune, glides, and vibrato (cent-interpolated
  `NOTE_PITCH` on FM and PSG).
- **CSM:** `fm3-csm` tracks — CSM mode + Timer A rate (const and swept).
- **FM3 independent-OP:** `(fm3 …)` + `fm3-1`…`fm3-4` — CH3's four operators at
  independent F-numbers with their own `$28` key bits.
- **Macros:** `(macro :target …)` — step vectors, `(curve …)` envelopes,
  multi-stage sequences (attack / sustain-loop / release), `:semi` chiptune
  arpeggios, i16 `:pitch` envelopes, scaled macros, and `:keyon` retrigger (drum
  rolls), on level, FM-op and pitch targets.
- **Dynamic values:** `(def-val …)` + `$name` — 16 i16 slots the host writes
  with `MMLisp_setVal` and reads with `MMLisp_getVal`; the score folds them into
  parameters via `PARAM_FROM_VAL` / `_ADD_VAL` / `_MUL_VAL` / `PARAM_MUL`, plus
  the built-in `$time`. E.g. a live filter/LFO-depth slider, or game-state
  timbre.
- **PCM:** `pcm1` — one sample voice on the `fm6` DAC at 9,987.57 Hz, with
  per-note level and a master level (15 linear steps on the 6 dB grid), pitch in
  octave steps of the baked sample. `pcm2`/`pcm3` and sample loops are dropped
  and counted in this profile (a looped sample plays through once).

## Limits

- **One PCM voice**, no sample loops, no runtime pitch (see above).
- **Wire: 960 pairs a second** (480 in VBlank-only mode). The song's opening
  voice setup is primed at load, but a mid-song voice change on several
  channels at once (~30 writes each) still takes a few frames through it, and
  scores that change many registers every frame (per-frame vibrato on every
  channel) can outrun it — watch `pending`.
- **One score loaded at a time.** `MMLisp_loadScore` resets the sequencer.
- **SE is not ported** to the 68k sequencer.
- **`(trig N)` markers are not surfaced** to the host.
- **SGDK's own Z80 halts** (pads, DMA) are outside the driver's budget — see
  "Bus stops that are not the driver's".
- **Not yet run on hardware.** In particular the pumps write Z80 RAM with
  `movep.l` (single byte cycles, as the 68000 defines it; correct in BlastEm).

The design is `docs/driver.md`; building and the gates are `drv/README.md`.
