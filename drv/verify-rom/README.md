# verify-rom — the driver on an emulated Mega Drive, from a script

A Mega Drive ROM that plays one score through the **shipped** driver glue
(`drv/sgdk/mmlispdrv.c`, `drv/68k/mmlispseq.c`, the Z80 engine image) and
publishes what happened into a struct in work RAM.

```
sh drv/blastem/setup.sh                                   # once
node drv/tools/blastem-probe.mjs drv/tests/m3-pcm-softmix.mmlisp --seconds 10
```

```
blastem-probe: m3-pcm-softmix.mmlisp — 10s · PCM_SPG=1 TIMER_B_K=1
  tracks 2
  music  0x0100 (100.0%)   worst 1s 0x00fb (98.0%)
  host   0x00ff (99.6%)   541 frames consumed in 540 vblanks
  lost/s 0   starv 12 (0/s)
  audio  drv/out/probe.wav
```

Those are the same numbers `drv/sgdk/example/main.c` puts on screen, and the
`.wav` is what the YM2612 actually produced.

## Why it exists

Every gate in this repository was green through three bugs a real machine found
in minutes (`.claude/memory/plan-68k-split.md`, 2026-08-29): a `di` longer than
the VDP's interrupt pulse, a ring cursor that read the engine's own code as
samples, and a catch-up that compounded until a fifth of frames were lost. They
were invisible because nothing here ran the actual program on the actual
machine — the answer always came back through somebody building a ROM,
launching it, and listening. This closes that loop.

It does **not** replace the hardware round. BlastEm is a very good model and it
is still a model. What this removes is the iteration on somebody's attention.

## It is a jig, not a product

What ships to a user is `tools/install-sgdk.mjs` into their SGDK project. This
directory is a measurement fixture that happens to boot: its own vector table,
its own VDP bring-up, and the handful of SGDK calls `mmlispdrv.c` makes,
implemented against the hardware registers (`sys.c`). The point is that
`mmlispdrv.c` and `mmlispseq.c` are compiled **as they ship**, with nothing of
ours between them and the machine.

| file             | what it is                                                    |
| ---------------- | ------------------------------------------------------------- |
| `boot.s`         | vectors, cartridge header, VDP bring-up, the exception traps   |
| `rom.ld`         | flat cartridge image; ROM at 0, work RAM at `0xFF0000`         |
| `sys.c`          | the SGDK calls `mmlispdrv.c` needs, against real registers     |
| `main.c`         | the probe: start every track, run, publish                     |
| `probe.h`        | the mailbox the frontend reads, and the fault codes            |
| `libgcc68000.c`  | 32-bit multiply/divide, because the toolchain's are for a 68020 |
| `song.c`         | generated from the score — not committed                       |

## The toolchain, and three ways it will bite you

Built with Ubuntu's `gcc-m68k-linux-gnu` (`apt-get install gcc-m68k-linux-gnu`),
not SGDK's `m68k-elf-gcc`, because a CI job can install the first one. That
toolchain targets **Linux on a 68020+**, and three of its defaults are wrong for
a 68000. All three present as the ROM dying silently:

1. **`-fno-store-merging`.** Its store-merging pass turns `b[i]=v; b[i+1]=v>>8`
   into a word store at whatever offset it lands on — an address error on a
   68000. `-mstrict-align` was verified NOT to prevent this.
2. **No `-lgcc`.** The only libgcc it ships is built for a 68020, and its
   `__modsi3` uses `bsr.l`, which a 68000 decodes as a branch to an odd address.
   `libgcc68000.c` supplies the helpers instead.
3. **Alignment of the MMB.** The sequencer reads 16- and 32-bit fields straight
   out of it; `res/song.res` spells the same requirement as its `2` field.

A crash reports itself: the exception handlers in `boot.s` record the fault kind,
the address, and the PC into the mailbox, and `blastem-probe.mjs` prints them
with the objdump line to run. That is the difference between "the MMB is bad"
and "the 68000 took an address error inside `mml_load`", which have nothing in
common as bugs.

## The rate knobs

`PCM_SPG` and `TIMER_B_K` decide the DAC's sample clock, and they must agree
across three generated things: the MMB's baked sample bank, the generated mixer,
and `mml_rate.h`.

Building the ROM therefore **rewrites three tracked files** —
`68k/mml_rate.h`, `sgdk/mmlispdrv_bin.h` and `sgdk/mmlispdrv.bin` — because it
regenerates them under the probe's knobs while they are committed at values the
generators do not produce by default. The diff is not a change anyone made;
restore them (`git checkout drv/68k/mml_rate.h drv/sgdk/mmlispdrv_bin.h
drv/sgdk/mmlispdrv.bin`) rather than committing them.

That mismatch is deliberate for now: the plan is Timer B at 3.3 kHz and Timer A
for the higher rates, so the generators' defaults stay where they are until that
spec settles and the artifacts can be regenerated once against it. `src/mixer.z80`
is NOT in the list any more — assembling hands the generated mixer to z80asm in
memory (`sources`), so measuring the engine no longer writes anything.

The knobs default here to the branch's only working configuration —
`PCM_SPG=1 TIMER_B_K=1`, every sample gated, 3,329 Hz. Mismatch them and
`mml_load_samples` refuses the bank on its stamp: the song plays and every PCM
note is silently dropped, which the probe reports as `PCM MUTE`.
