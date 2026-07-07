# MMLispDRV in an SGDK project

How to play an MMLisp score on a real Mega Drive (or an accurate emulator)
from an [SGDK](https://github.com/Stephane-Dallongeville/SGDK) program.

> **Verification status.** The Z80 driver's register output is proven
> byte-for-byte against the JS reference *in emulation* (`drv/tools/verify.mjs`
> — the same Z80 image this integration ships). What is **not** yet verified is
> this 68k glue and the driver running under a real Mega Drive bus/interrupt
> model. The C here is written against SGDK's ~1.6x Z80 API and has not been
> compiled or run in this repo (no SGDK/m68k toolchain here). Follow
> "Confirming it works" below on an emulator before trusting it.

## Files

```
drv/sgdk/mmlispdrv.h        host API (load driver, start/stop tracks)
drv/sgdk/mmlispdrv.c        host implementation (mailbox, banking)
drv/sgdk/mmlispdrv_bin.h    generated: the Z80 image as a C array
drv/sgdk/mmlispdrv.bin      generated: the same image as a raw blob
drv/sgdk/example/main.c     minimal player program
drv/sgdk/example/song.res   BIN resource for the MMB (32 KB aligned)
```

Regenerate the two generated files after any driver change:

```
cd drv && node tools/emit-bin.mjs
```

## The pipeline

```
mysong.mmlisp ──mmb-build.mjs──▶ song.mmb ──rescomp(BIN)──▶ ROM
                                                              │
   mmlispdrv.z80 ──emit-bin.mjs──▶ mmlispdrv_bin.h ──gcc──────┤
                                                              ▼
                                     68k: MMLisp_init(); MMLisp_startTrack(...)
                                                              │ mailbox (0xA01680)
                                                              ▼
                                     Z80: MMLispDRV plays YM2612 + PSG @ 60 Hz
```

1. **Compile the score to an MMB:**
   ```
   node drv/tools/mmb-build.mjs mysong.mmlisp res/song.mmb
   ```
   The tool prints the track count; track ids are `0..count-1` in declaration
   order.

2. **Drop the driver + glue into your SGDK project:**
   - `src/mmlispdrv.c`, `inc/mmlispdrv.h`, `inc/mmlispdrv_bin.h`
   - `res/song.res` with `BIN song_mmb "song.mmb" 32768`
   - your `src/main.c` (start from `example/main.c`)

3. **`make`** with SGDK as usual, then run the `.bin`/`.md` in an emulator.

## How it works

- **Loading.** `MMLisp_init()` uploads the ~3.5 KB Z80 image to Z80 RAM at
  0x0000 via `Z80_loadCustomDriver`, then polls the mailbox `driver_ready`
  byte until it reads `0xD2`. While MMLispDRV owns the Z80 you must not use
  SGDK's XGM/PCM drivers — MMLispDRV writes the YM2612 (0x4000–0x4003) and PSG
  (0x7F11) itself.

- **Timing.** The driver runs `IM 1` and takes one frame per Z80 vblank
  interrupt (the 60 Hz `/INT` the VDP raises each vblank — the same tick every
  Mega Drive Z80 sound driver uses). The 68k does not pump it; after starting
  tracks the score is autonomous.

- **Control.** `MMLisp_startTrack` / `MMLisp_stopTrack` post commands into an
  8-slot ring in Z80 RAM at 0xA01680 (`docs/driver.md` §6). Posting requests
  the Z80 bus (briefly halting it), writes the 4-byte cell with the command
  byte last, and releases the bus. The Z80 drains the ring at the top of each
  frame.

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

## Confirming it works

Because the driver logic is already proven, the on-target check is really a
check of *the glue + the bus/interrupt model*. In rough order of effort:

1. **Boot flag.** In your emulator's debugger, break after `MMLisp_init()` and
   read Z80 RAM 0x16B2 — it should be `0xD2`. If it never flips, the upload or
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

## What plays (M1 + M2)

- Notes/rests/ties, per-note length + gate, loops (counted + infinite JUMP),
  markers, `len=0` holds, FM + PSG voices and levels, tempo changes.
- **Motion (M2a):** `:vol`/`:master` curve fades and level LFOs
  (`PARAM_SWEEP`/`_STOP`), relative writes (`:vel+` etc via `PARAM_ADD`), and
  tempo ramps (`TEMPO_SWEEP`).
- **Pitch (M2b):** inline `:pitch` detune, glides, and vibrato
  (cent-interpolated `NOTE_PITCH` on FM and PSG).

## Limits

- One MMB per bank window; all live tracks share it.
- CSM, PCM/DAC, and the M2 mailbox commands (KEY_OFF, SET_PARAM, FADE_TRACK,
  SET_VAL) are not yet implemented — accepted and ignored / skipped.
- Remaining M3 stream features (macros, dynamic value slots, CALL/RET) are
  length-decoded and skipped; notes stay in time.

The RAM-map remap that M2 introduced (internal regions moved above the
mailbox) does **not** affect this glue — the mailbox and val-slot addresses it
uses are unchanged.

See `drv/README.md` for the full deviation list and the driver-side design.
