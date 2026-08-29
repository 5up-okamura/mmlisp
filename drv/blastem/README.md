# blastem — the emulator, headless

BlastEm builds as a libretro core with no SDL, no X11 and no audio device. That
is what lets it run in a container, from a script, and hand back a file.

```
sh drv/blastem/setup.sh
```

Clones the emulator into `drv/out/blastem/src`, applies `probe.patch` if there
is one, builds `blastem_libretro.so`, and builds `host.c` beside it. Nothing is
installed system-wide and nothing here is committed except the sources below.

| file           | what it is                                                     |
| -------------- | -------------------------------------------------------------- |
| `setup.sh`     | fetch, patch, build                                             |
| `host.c`       | a libretro frontend: run N frames, capture audio, read work RAM |
| `probe.patch`  | our changes to the emulator, if any — kept as a diff on purpose  |

`host.c` implements only the slice of libretro a measurement needs: video is a
no-op, audio is appended to a `.wav`, input is always zero. It also reads the
probe ROM's mailbox out of 68000 work RAM through `retro_get_memory_data`, which
costs the emulated machine nothing at all — no debug port, no bus grab, no
patched emulator.

The audio is the YM2612's own rate (master/1008 = 53,267 Hz NTSC), stereo s16:
the sample stream the DAC produced, not a resampling of it.

## The patch stays a patch

Anything we change about the emulator lives in `probe.patch` rather than a fork,
so that (a) what we changed is one readable diff and (b) a run can be repeated
against a stock core to check that our patch is not itself the finding. The
mirror's default branch is `libretro`, not `master` — `master` there is an old
snapshot with no `Makefile.libretro`.

## The probe log

`MMLISP_PROBE_LOG=<file>` makes the patched core write an 8-byte record per
event: every `$2A` write, every 68000 bus grab and release, and the instant of
each Z80 vblank. Cycles are master clocks. `tools/dac-log.mjs` reads it.

Nothing is written when the variable is unset — the emulated machine's timing
must not depend on whether it is being watched.

One caveat on `MML_PROBE_DACPC`, the Z80 PC at each DAC write: the x86 JIT does
not keep `context->pc` current between basic blocks, so it reports 0 about 40%
of the time and otherwise only ever names the emit routine itself — which is
where the write is, not where the time went. Attributing a hole to the code
that caused it needs the JS harness (`drv/tools/z80cpu.mjs`), which interprets
and therefore knows. The record is logged anyway because it costs nothing.

## What it is worth

BlastEm is the reference we are arguing with while the hardware round is
expensive, and it has already found things no gate here could: see
`.claude/memory/plan-68k-split.md`. It is a model. A green run here is a reason
to spend a hardware round, not a substitute for one.
