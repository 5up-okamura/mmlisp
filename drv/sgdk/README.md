# MMLispDRV in an SGDK project

How to play an MMLisp score on a real Mega Drive (or an accurate emulator) from
an [SGDK](https://github.com/Stephane-Dallongeville/SGDK) program.

> **Verification status (2026-08-03).** The sequencer's output is proven
> byte-for-byte against the JS reference on the host — `cd drv && npm run
> c-gate`, **39 scores byte-identical at zero tolerance**, covering everything
> the language compiles to except SE. The Z80 engine is proven against the slot
> stream in emulation (`npm run engine`, `npm run slots`), and the ring
> transport has its own gate (`npm run ring`).
>
> The glue **has now been built for real** — SGDK 2.x + m68k-elf-gcc 13.2.0,
> clean compile and link to a 256 KB ROM. It has **not been run**, on hardware
> or in an emulator, so nothing about its behaviour is established yet. Follow
> "Confirming it works" below before trusting it.
>
> No m68k toolchain lives in this repo, so `npm run sgdk:lint` stands in for the
> compiler: it builds the sequencer, the glue and the example against a shim of
> the SGDK symbols they use — with `-DSGDK_GCC` and a `types.h` that mirrors
> SGDK's macro conventions, because a friendlier shim hid three real build
> failures once already.

## What changed with the split

The architecture pivoted on 2026-08-02 (`docs/driver.md` §1.1): **the 68000 runs
the sequencer and the Z80 is a PCM mixer + chip-write engine.** If you integrated
the older all-Z80 driver, the differences that touch your code are:

| | before | now |
| --- | --- | --- |
| Track control | mailbox commands posted across the bus | ordinary C calls into `mmlispseq.c` |
| Start burst | ≤ 7 per frame, overflow dropped silently | no limit — a whole score starts in one frame |
| Per-frame work | none; the Z80 was autonomous | `MMLisp_frame()` once per vblank |
| Z80 image | ~6.5 KB resident + a 2.3 KB overlay blob | one 2,668 B image, no overlay |
| `MMLisp_init` | took the overlay ROM pointer | takes nothing |
| Score in ROM | 32 KB aligned, read through the Z80 window | plain 68k memory, no alignment |
| Sample bank | 32 KB aligned | unchanged — still the Z80's window |
| Val slots | read back out of Z80 RAM | plain 68k variables |

`MMLisp_loadScore` is new: the sequencer parses the MMB itself now, so loading
is a separate step from starting a track.

## Files

```
drv/sgdk/mmlispdrv.h        host API
drv/sgdk/mmlispdrv.c        host implementation (Z80 bring-up, the ring copy)
drv/sgdk/mmlispdrv_bin.h    generated: the Z80 engine image + header constants
drv/sgdk/mmlispdrv.bin      generated: the same image as a raw blob
drv/68k/mmlispseq.{c,h}     the sequencer — 68k code, compiled INTO your game
drv/68k/tables.c            generated: its constant tables
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
inc/mmlispdrv.h  inc/mmlispseq.h  inc/mmlispdrv_bin.h  inc/mml_rate.h
res/song.res  res/song.mmb  [res/song.smp]
```

## The pipeline

```
mysong.mmlisp ──mmb-build.mjs──▶ song.mmb ──rescomp(BIN)──▶ ROM
                                                              │
   engine.z80 ──emit-bin.mjs──▶ mmlispdrv_bin.h ──gcc─┐       │
   mmlispseq.c ───────────────────────────────gcc─────┤       │
                                                      ▼       ▼
                        68k: MMLisp_frame() renders one slot per frame
                                                      │ ring in Z80 RAM
                                                      ▼
                        Z80: engine puts the slot on the chips, mixes PCM
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
for (u8 id = 0; id < TRACK_COUNT; id++) MMLisp_startTrack(id);

while (TRUE) {
    /* … your game … */
    MMLisp_frame();                  // ONCE per frame, last
    SYS_doVBlankProcess();
}
```

## How it works

- **Loading.** `MMLisp_init()` uploads the engine image to Z80 RAM at 0x0000,
  pulses reset, and polls the published header until `engine_ready` reads `0xD2`
  — then reads the ring's depth, slot stride and base address out of that same
  header, so the geometry has exactly one owner and a rebuilt engine cannot
  silently disagree with your compiled-in constants. A protocol-version mismatch
  makes `MMLisp_isReady()` return false rather than write into RAM whose layout
  moved. While MMLispDRV owns the Z80 you must not use SGDK's XGM/PCM drivers —
  it writes the YM2612 (0x4000–0x4003) and PSG (0x7F11) itself.

- **Timing — the Z80 still keeps the clock.** The engine runs `IM 1` and
  consumes exactly one slot per Z80 vblank interrupt. So although the 68k now
  does the sequencing, *tempo does not depend on when the 68k gets around to it*:
  a frame your game overran eats into the ring's lookahead and the music is
  unaffected. That property is the whole reason the split works
  (`docs/driver.md` §1).

- **`MMLisp_frame()` — the one hard rule.** Call it **once per vblank**, and put
  it **last** in your frame, after the control calls. It tops the ring *up*
  rather than rendering exactly one slot, so the lookahead is an invariant the
  call maintains, not something you manage: an empty ring renders a ring's worth,
  steady state renders one, and a frame you overran refills itself next call. It
  is self-limiting — called twice in one frame, the second call finds the ring
  full and does nothing — so calling it from both a vblank handler and a game
  loop is not a bug.

  In the default depth-2 configuration a steady-state call is three short bus
  grabs — read `tail`, copy one 256-byte slot, publish `head` — and it never
  holds the bus across the rendering itself, which would stall the mixer for
  milliseconds. Each grab still halts the Z80 briefly, so pick a point in your
  frame where that is cheapest. The driver deliberately does *not*
  register itself with SGDK's vblank callback: that callback is effectively a
  single slot, and taking a resource you may need is the sort of implicit magic
  worth avoiding (`docs/driver.md` §6.6 has the full argument).

- **Control.** `MMLisp_startTrack` / `stopTrack` / `keyOff` / `setParam` /
  `fadeTrack` / `setVal` are plain calls into the sequencer — no bus, no ring, no
  overflow. They take effect on the next frame rendered, so they are **heard one
  ring-depth of frames later** (`docs/driver.md` §3.4). Put them before
  `MMLisp_frame()` and that is the whole latency; put them after and you pay one
  frame more.

- **Starting tracks: all in one frame.** Each track's clock starts on the frame
  it was set up in, so staggering the starts leaves the tracks permanently out of
  phase by that many frames. The setup frame is silent by construction (the
  *armed* frame, `docs/driver.md` §4.2), so a burst of starts costs one long
  frame nobody hears rather than a ragged opening bar. The pre-split ceiling of
  seven starts per frame is gone with the mailbox.

- **Sync to the music, not to your own frame counter.** The sequencer runs ahead
  of what the player hears by the ring's fill level. `MMLisp_audibleFrame()`
  returns the engine's consumed-frame counter — the audible clock — and anything
  that has to line up with the sound compares against that.

### Banking

**The score needs no alignment.** The 68000 reads the MMB out of its own address
space now; nothing about it goes through the Z80's window. The 32 KB rule that
governed the pre-split integration survives in exactly one place:

**The PCM sample bank still rides the window.** `song.smp` must be 32 KB
aligned, because the mixer latches its bank and reads samples from the window
base (`docs/driver.md` §5.4).

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

Call `MMLisp_setSampleBank` after `MMLisp_init` — init clears Z80 RAM, which
would wipe an earlier publish. Its order against `MMLisp_loadScore` does not
matter: the pointer is remembered and re-applied on every load.

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

### Diagnosing an uneven tempo

`MMLisp_starvedFrames()` is the engine's count of frames it had to hold the
chips because the ring was empty. Ring-empty is not an error by design (§6.1) —
the engine keeps mixing and the music simply does not advance that frame — which
means a 68k that misses 60 Hz presents as **the tempo wobbling, with nothing to
point at**. The counter is what makes it attributable.

It should stay at 0. If it climbs, `MMLisp_frame()` is not running every frame,
and the answer is either less work per frame or a deeper ring: `RING_DEPTH` in
`engine.z80` absorbs N-1 late frames at N frames of control latency (§3.4). The
default of 2 absorbs exactly **one**, so a single long frame is already audible
— and how close a song runs to that edge depends on its own per-frame work
(voice applies, macro steps, sweeps, PCM voice bookkeeping), which is why an
uneven tempo can show up on one song and not another.

Only the 68k side needs changing for a depth experiment on the engine — the host
reads depth out of the published header.

### If `make` fails with no output at all

GNU Make 3.81 — the one Apple ships, and what SGDK's makefile runs under on
macOS — can fail **silently** during its `-include $(DEPS)` phase when
`out/<build>/res/song.o` is missing or stale, because the dependency rules list
it as a prerequisite and errors in that phase are suppressed. You get
`make: *** [release] Error 2` and not one line more.

It bites exactly once, when an existing `out/` predates a change to
`res/song.res` — which is every project migrating from the pre-split driver. The
fix is a clean build:

```
rm -rf out res/song.h && make -f $GDK/makefile.gen
```

A clean tree builds fine, so this is a migration hazard rather than a standing
one. (If you want to see what make is hiding: `make CLEAN=TRUE <target>` skips
the include phase and prints the real error.)

## Confirming it works

The sequencer logic is proven on the host, so the on-target check is really a
check of *the glue + the bus/interrupt model*. In rough order of effort:

1. **Boot flag.** Break after `MMLisp_init()` and read the header's
   `engine_ready` byte in Z80 RAM (its address is `MMLISPDRV_HDR + 4`, printed in
   the generated `mmlispdrv_bin.h`). It should be `0xD2`. If it never flips, the
   upload or the reset path is wrong, not the engine.

2. **Is the Z80 taking its interrupt?** `MMLisp_audibleFrame()` must climb by
   ~60 per second. If it is frozen while `engine_ready` is set, the vblank
   `/INT` is not reaching the Z80.

3. **Is the 68k feeding it?** Silence with a climbing frame counter means the
   ring is starving — check that `MMLisp_frame()` really is being called, that
   `MMLisp_loadScore` returned true, and that the tracks were started.

4. **Register-trace diff (rigorous, expert path).** BlastEm can log YM2612/PSG
   writes. Capture them for the first N frames and compare against the reference
   for the same MMB:
   ```
   node drv/tools/dump-trace.mjs res/song.mmb --frames 400
   ```
   `dump-trace` prints the exact writes MMLispDRV is specified to make, decoded
   (KEY-ON fm1, F-num, TL, PSG att, …). The emulator log should match, modulo the
   YM BUSY-wait timing. Any structural difference is a glue/hardware issue to
   chase, and the decoded reference tells you what *should* have happened.

### Two tools that settle almost any "it sounds wrong" report

Found the hard way during the first on-target bring-up (2026-07-26), and worth
reaching for before theorising:

- **VGM log = what the chips actually got.** In BlastEm, `m` starts/stops a VGM
  recording (`ui.vgm_log`). Every YM2612/PSG write lands in it with timing, so
  parsing it tells you whether the driver stopped writing, wrote something wrong,
  or wrote correct music that you nonetheless could not hear. A silence that
  shows a *uniform* write stream is not a driver bug.
- **Driver state = what the driver thinks.** Post-split this is nearly free:
  almost all of it is 68k memory, so `MMLisp_trackActive` and the `MMLSeq` struct
  are readable in your own debugger with no bus grab at all. Only
  `MMLisp_audibleFrame()` still crosses.

  The one pre-split lesson that still applies: **read Z80 RAM on demand only.**
  Every read halts the Z80, and a read right after `SYS_doVBlankProcess()` lands
  on the scanline where the Z80's own vblank interrupt is asserted. Sampling five
  values every frame stopped the score outright; once a second was harmless.
  `MMLisp_frame()` itself is one grab per frame by design — do not add more.

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
- **PCM soft-mix:** `pcm1`–`pcm3` — three sample voices (`:mode shot`/`loop`)
  summed in software to the single `fm6` DAC at a fixed ~10.5 kHz mix rate,
  hard-clipped (`fm6` itself is FM-only).

## Limits

- **One score loaded at a time.** `MMLisp_loadScore` resets the sequencer, so
  cross-score DJ transitions (`docs/driver.md` §2.3) are not wired up yet — the
  split made them cheap, but they are still unimplemented.
- **SE is not ported.** `MMLisp_startSe` and the suspend/restore model
  (`.claude/memory/plan-se.md`) exist in the reference and in the superseded
  all-Z80 build, but not yet on the 68k.
- **`(trig N)` markers are not surfaced.** The sequencer tracks each track's last
  marker, but there is no host API for it: markers are rendered ahead of what is
  audible by the ring depth, so releasing them correctly means comparing against
  `MMLisp_audibleFrame()`, and that queue is undesigned.
- **NTSC only.** PAL is a one-multiply correction that needs a PAL target to
  settle (`docs/driver.md` §3.3).
- 16 concurrent tracks (6 FM + 4 PSG + FM3-op + 3 PCM soft-mix voices).
- 8-bit DAC, nearest-neighbour resampling; expect DAC jitter from the 68k's
  per-frame bus grab (~tens of µs — **measure it on hardware**).

See `drv/README.md` for the driver-side design and the deviation list.
