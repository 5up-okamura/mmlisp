# MMLispDRV in an SGDK project

How to play an MMLisp score on a real Mega Drive (or an accurate emulator)
from an [SGDK](https://github.com/Stephane-Dallongeville/SGDK) program.

> **Verification status.** The Z80 driver (the same ~6.5 KB image this
> integration ships) covers **all of M1 and M2** plus several M3 features —
> **FM3 independent-operator mode**, the **macro engine** (step/curve/stage +
> `:semi` arpeggios), and **dynamic value slots** — FM/PSG notes, level model,
> loops, holds, sweeps/PARAM_ADD/TEMPO_SWEEP, cent pitch (glide/vibrato), FM3
> CSM, FM3 independent-OP, macros, host-set value slots, 3-channel PCM soft-mix,
> and the host mailbox commands. Its register output is proven
> byte-for-byte against the JS reference *in emulation* (`drv/tools/verify.mjs`;
> fourteen gate scores diff clean at zero tolerance). What
> is **not** yet verified is this 68k glue and the driver under a real Mega
> Drive bus/interrupt model: the C here is written against SGDK's ~1.6x Z80 API
> and has not been compiled or run in this repo (no SGDK/m68k toolchain here).
> Follow "Confirming it works" below on an emulator before trusting it. (The
> PCM DAC feed is modelled frame-quantized in the verified build — see below and
> `drv/README.md`; its sub-frame feed timing is a hardware-bring-up item.)

## Files

```
drv/sgdk/mmlispdrv.h        host API (load driver, start/stop tracks)
drv/sgdk/mmlispdrv.c        host implementation (mailbox, banking)
drv/sgdk/mmlispdrv_bin.h    generated: the resident Z80 image as a C array
drv/sgdk/mmlispdrv.bin      generated: the same image as a raw blob
drv/sgdk/mmlispdrv_ovl.bin  generated: the overlay ROM blob (cold code the Z80 pages in)
drv/sgdk/mmlispdrv_ovl_bin.h generated: the same overlay as a C array (reference
                            only — a C array carries no 32 KB alignment, so the
                            ROM copy must come from the BIN resource)
drv/sgdk/example/main.c     minimal player program
drv/sgdk/example/song.res   BIN resources for the MMB + overlay (32 KB aligned)
```

Regenerate the four generated files after any driver change:

```
cd drv && node tools/emit-bin.mjs
```

## Installing into your project

`tools/install-sgdk.mjs` copies the files above into an SGDK project in the
layout below — use it instead of copying by hand after every driver change:

```
cd drv
node tools/install-sgdk.mjs ~/path/to/project                 # driver files only
node tools/install-sgdk.mjs ~/path/to/project --song mysong.mmlisp
node tools/install-sgdk.mjs ~/path/to/project --dry-run       # show what would change
```

It regenerates the Z80 artifacts first (so a stale `mmlispdrv_bin.h` can never
be installed), overwrites the four driver-owned files, and **only ever creates**
the files that become yours to edit — `res/song.res` when the project has none,
and `src/main.c` only with `--example`. Your `main.c` is never touched. With
`--song` it also compiles the score to `res/song.mmb` (plus `res/song.smp` for
PCM scores) and prints the track ids `MMLisp_startTrack` takes. Set
`MMLISP_SGDK_PROJECT` to skip the path argument; `--help` lists every option.

## The pipeline

```
mysong.mmlisp ──mmb-build.mjs──▶ song.mmb ──rescomp(BIN)──▶ ROM
                                                              │
   mmlispdrv.z80 ──emit-bin.mjs──▶ mmlispdrv_bin.h ──gcc──────┤
                                                              ▼
                                     68k: MMLisp_init(); MMLisp_startTrack(...)
                                                              │ mailbox (0xA018F0)
                                                              ▼
                                     Z80: MMLispDRV plays YM2612 + PSG @ 60 Hz
```

1. **Compile the score to an MMB:**
   ```
   node drv/tools/mmb-build.mjs mysong.mmlisp res/song.mmb
   ```
   The tool prints the track count; track ids are `0..count-1` in declaration
   order.

2. **Drop the driver + glue into your SGDK project** (what
   `node tools/install-sgdk.mjs <project>` does for you):
   - `src/mmlispdrv.c`, `inc/mmlispdrv.h`, `inc/mmlispdrv_bin.h`
   - `res/mmlispdrv_ovl.bin` (copy the blob itself into `res/`)
   - `res/song.res` with both blobs, each 32 KB aligned:
     ```
     BIN song_mmb   "song.mmb"          32768
     BIN mmlisp_ovl "mmlispdrv_ovl.bin" 32768
     ```
     SGDK's makefile runs rescomp over every `res/*.res` and generates
     `res/song.h` declaring `song_mmb` / `mmlisp_ovl` — include that from your
     `main.c`. Leave the compression field unset: a compressed BIN is unpacked
     to RAM, and both blobs must stay in ROM for the Z80's bank window to reach
     them.
     A PCM score adds a third blob, `res/song.smp` — see "PCM sample banks".
   - your `src/main.c` (start from `example/main.c`)

3. **`make`** with SGDK as usual, then run the `.bin`/`.md` in an emulator.

## How it works

- **Loading.** `MMLisp_init(overlay_rom)` uploads the resident Z80 image to Z80
  RAM at 0x0000 **and publishes the overlay ROM bank (`G_OVL_BANK`) while the Z80
  is held in reset**, then releases and polls the mailbox `driver_ready` byte
  until it reads `0xD2`. The bank-before-reset order matters: the boot code
  itself is an overlay (`ovl_boot`), so the reset stub needs `G_OVL_BANK` to load
  it (`drv/README.md`). While MMLispDRV owns the Z80 you must not use SGDK's
  XGM/PCM drivers — MMLispDRV writes the YM2612 (0x4000–0x4003) and PSG (0x7F11)
  itself. Pass a 32 KB-aligned pointer to the overlay ROM blob (`mmlispdrv_ovl.bin`).

- **Timing.** The driver runs `IM 1` and takes one frame per Z80 vblank
  interrupt (the 60 Hz `/INT` the VDP raises each vblank — the same tick every
  Mega Drive Z80 sound driver uses). The 68k does not pump it; after starting
  tracks the score is autonomous.

- **Control.** `MMLisp_startTrack` / `MMLisp_stopTrack` / `MMLisp_keyOff` /
  `MMLisp_setParam` / `MMLisp_fadeTrack` post commands into an 8-slot ring in
  Z80 RAM at 0xA018F0 (`docs/driver.md` §6). Posting requests the Z80 bus
  (briefly halting it), writes the 4-byte cell with the command byte last, and
  releases the bus. The Z80 drains the ring at the top of each frame. Use
  `MMLisp_fadeTrack` for DJ-style scene transitions (fade one scene's tracks
  while starting the next).

- **Starting tracks: all in one frame, up to seven.** Post every
  `MMLisp_startTrack` in the same frame — each track's clock starts in the frame
  the driver sets it up in, so staggering the starts leaves the tracks
  permanently out of phase by that many frames. The setup frame is silent by
  construction (`T_STATUS` armed, `docs/driver.md` §4.2), so a burst of starts
  costs one long frame nobody hears rather than a ragged opening bar.

  The limit is the ring, not the cycles: it has 8 cells but holds **7 entries**
  (`head == tail` means empty), and `mailbox_send` drops anything past that
  **silently**. A song with more than 7 tracks must split its starts across two
  frames — those tracks then begin one frame late, which is the price. Same rule
  for any host-side burst: at most 7 commands per frame.

- **Markers.** Each track mirrors the last `MARKER` it passed into a status
  byte; `MMLisp_trackStatus(i)` reads it (bit7 active, bit6 fading, bits5-0
  marker id) so the game can sync to musical positions.

### Banking (the 32 KB alignment rule)

The Z80 reads song data through its 0x8000–0xFFFF **bank window** — a 32 KB
page of the 68k address space chosen by the bank register. `MMLisp_startTrack`
computes `bank = ((u32)mmb) >> 15` and the driver latches it, so the driver
sees the MMB at window base 0x8000.

For that to line up, **the MMB blob must be 32 KB aligned** in ROM. The
`BIN song_mmb "song.mmb" 32768` alignment argument does this. An MMB is ≤ 32 KB
by construction (`docs/mmb.md` §12), so one aligned blob always fits one
window. (If your rescomp rejects 32768, align via a linker section instead, or
place the MMB first in a bank.) Multiple simultaneous tracks must come from the
**same** MMB in M1 — one window, one bank.

### PCM sample banks

A score with `def :sample` compiles to **two** blobs: the MMB and a `song.smp`
sidecar holding the raw 8-bit sample data (`docs/mmb.md` §10). The samples live
outside the MMB because one window cannot hold both — so `song.smp` gets its own
32 KB-aligned bank, which the soft-mixer latches for the mix and swaps back
before returning (`docs/driver.md` §5, §14).

Three things, all of them required:

```
res/song.res:   BIN song_smp "song.smp" 32768
main.c:         MMLisp_init(mmlisp_ovl);
                MMLisp_setSampleBank(song_smp);      // after init, before playing
```

The BIN line ships commented out in the seed `song.res` because rescomp fails on
a BIN whose file does not exist; uncomment it for a PCM score.
`MMLisp_setSampleBank` must come **after** `MMLisp_init` — init clears Z80 RAM,
which would wipe an earlier publish. Non-PCM scores need no call at all.

**Uncommenting the BIN line alone does nothing.** rescomp then puts `song.smp`
in the ROM and declares the symbol, but nobody tells the Z80 where it is:
`G_SMP_BANK` stays 0, `pcm_note_on` returns immediately, and the song plays FM
and PSG with **every PCM note dropped and the DAC never enabled** — it sounds
like a missing part, not like noise. Measured on a real 9-track import: 1 `$2A`
write over 600 frames without the call, 94,851 with it. (Noise is what a
*wrong* non-zero bank gives you.)

Two more things that silence PCM without any error, both host-side:

- **Your track count must cover the PCM tracks.** `mmb-build` prints
  `N tracks — 0:fm1 1:fm2 …`; a `TRACK_COUNT` smaller than N simply never starts
  the tail of that list, and the PCM tracks are usually near the end.
- **The mailbox ring holds 7 entries, not 8** (`head == tail` means empty). A
  song with more than 7 tracks cannot have all of its starts posted in one
  frame — `mailbox_send` drops the overflow silently. Post 7, then the rest on
  the next frame; those tracks begin one frame later.

`node tools/install-sgdk.mjs <project> --song mysong.mmlisp` writes
`res/song.smp` alongside `res/song.mmb` and prints whichever of the two steps
above is still missing.

## Confirming it works

Because the driver logic is already proven, the on-target check is really a
check of *the glue + the bus/interrupt model*. In rough order of effort:

1. **Boot flag.** In your emulator's debugger, break after `MMLisp_init()` and
   read Z80 RAM 0x1922 — it should be `0xD2`. If it never flips, the upload or
   the Z80 reset/interrupt-enable path is wrong, not the driver.

2. **Listen.** Run in an accurate emulator (BlastEm, Genesis Plus GX). You
   should hear the score. Silence with `0xD2` set usually means the vblank
   `/INT` isn't reaching the Z80 (frame loop never runs).

3. **Register-trace diff (rigorous, expert path).** BlastEm can log YM2612/PSG
   writes. Capture them for the first N frames and compare against the JS
   reference for the same MMB:
   ```
   node drv/tools/dump-trace.mjs res/song.mmb --frames 400
   ```
   `dump-trace` prints the exact writes MMLispDRV is specified to make, decoded
   (KEY-ON fm1, F-num, TL, PSG att, …). The emulator log should match, modulo
   the YM BUSY-wait timing. Any structural difference is a glue/hardware issue
   to chase, and the decoded reference tells you what *should* have happened at
   that frame.

`drv/tools/run-trace.mjs` runs the identical Z80 image under this repo's
emulator, so if the real emulator diverges from `dump-trace`, the difference is
in the Mega Drive bus/interrupt environment, not the driver.

### Two tools that settle almost any "it sounds wrong" report

Found the hard way during the first on-target bring-up (2026-07-26), and worth
reaching for before theorising:

- **VGM log = what the chips actually got.** In BlastEm, `m` starts/stops a VGM
  recording (`ui.vgm_log`). Every YM2612/PSG write lands in it with timing, so
  parsing it tells you whether the driver stopped writing, wrote something
  wrong, or wrote correct music that you nonetheless could not hear. A silence
  that shows a *uniform* write stream is not a driver bug.
- **Driver state = what the driver thinks.** `example/main.c` reads the mailbox,
  `G_FRAME`, `G_INC`, `G_MMB_BANK`, `G_MASTER` and each TCB's `T_STATUS`/`T_PC`/
  `T_WAIT` on a button press. `G_FRAME` climbing proves the Z80 takes its
  interrupt; `T_PC` moving inside EVENT_STREAM proves the score advances;
  `T_STATUS` distinguishes playing (1) from held (2), which the 68k-facing
  status byte does not.

  Read this **on demand only**. Every read halts the Z80, and a read right after
  `SYS_doVBlankProcess()` lands on the scanline where the Z80's own vblank
  interrupt is asserted: sampling five values every frame stopped the score
  outright, once a second was harmless.

One emulator gotcha, since it cost an evening: **BlastEm's audio output on macOS
dies after a few minutes** — a burst of noise, then permanent silence, while the
emulated machine keeps running normally. Raising `audio { buffer 512 }` to 2048
stops the crackling that precedes it but not the dropout itself. Restart the
emulator, or use another one for long listening sessions.

Three independent checks pinned that on the emulator rather than the driver, and
they are the ones to repeat if playback ever "stops": driver state read back
healthy (`G_FRAME` climbing, `T_STATUS`=1, `T_PC` moving inside EVENT_STREAM), a
VGM log of the same session uniform end to end, and **BlastEm's oscilloscope
(`o`, `ui.oscilloscope`) still showing waveforms while nothing is audible** —
that last one takes two seconds and settles it outright.

## What plays (M1 + M2 + FM3-op)

- Notes/rests/ties, per-note length + gate, loops (counted + infinite JUMP),
  markers, `len=0` holds, FM + PSG voices and levels, tempo changes.
- **Motion (M2a):** `:vol`/`:master` curve fades and level LFOs
  (`PARAM_SWEEP`/`_STOP`), relative writes (`:vel+` etc via `PARAM_ADD`), and
  tempo ramps (`TEMPO_SWEEP`).
- **Pitch (M2b):** inline `:pitch` detune, glides, and vibrato
  (cent-interpolated `NOTE_PITCH` on FM and PSG).
- **CSM (M2):** `fm3-csm` tracks — CSM mode + Timer A rate (const and swept).
- **FM3 independent-OP (M3):** `(fm3 …)` + `fm3-1`…`fm3-4` — CH3's four
  operators at independent F-numbers with their own `$28` key bits.
- **Macros (M3):** `(macro :target …)` — step vectors, `(curve …)` envelopes,
  multi-stage sequences (attack / sustain-loop / release), `:semi` chiptune
  arpeggios, i16 `:pitch` envelopes, and `:keyon` retrigger (drum rolls), on
  level, FM-op, and pitch targets — up to 3 concurrent macros per channel.
- **Dynamic values (M3):** `(def-val …)` + `$name` — the host sets 16 i16 slots
  with `MMLisp_setVal` (or reads with `MMLisp_getVal`); the score folds them into
  parameters via `PARAM_FROM_VAL` / `_ADD_VAL` / `_MUL_VAL` / `PARAM_MUL`, plus
  the built-in `$time`. E.g. a live filter/LFO-depth slider or game-state timbre.
- **PCM soft-mix (M3):** `pcm1`–`pcm3` — three sample voices (`:mode
  shot`/`loop`) summed in software to the single `fm6` DAC at a fixed ~10.5 kHz
  mix rate, hard-clipped (`fm6` itself is FM-only). The feed is modelled
  frame-quantized in the verified build (see `drv/README.md`); the real
  sub-frame feed timing is a hardware-bring-up item.

- **Mailbox (M2/M3):** `MMLisp_keyOff` (release a `len=0` hold / truncate a
  note), `MMLisp_setParam` (one-shot param write), `MMLisp_fadeTrack` (fade a
  track to silence then stop), `MMLisp_setVal` / `MMLisp_getVal` (dynamic value
  slots).

## Limits

- One MMB per bank window; all live tracks share it.
- Full **16 concurrent tracks** (6 FM + 4 PSG, or FM3-op + PCM soft-mix + the
  rest). Note: the emulation gate harness starts all tracks through the 8-cell
  mailbox ring, so it exercises ≤8 at once; the driver itself holds 16.
- Remaining M3 stream features (VOICE_SET, CALL/RET)
  are length-decoded and skipped; notes stay in time. Z80 code overlays keep the
  resident image under the 8 KB ceiling, so these land on the Z80 as they're
  built (the 68k-offload architecture stays the last resort; see `drv/README.md`).

> **Mailbox address.** The data floor — and with it the mailbox (`0xA018F0`)
> and val slots (`0xA01930`) — moves as the image grows. If you pinned an older
> address in your own code, update it (the constants in `mmlispdrv.c` are always
> current).

See `drv/README.md` for the full deviation list and the driver-side design.
