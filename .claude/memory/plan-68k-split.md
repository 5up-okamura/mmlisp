# Architecture pivot: 68k sequencer + Z80 PCM engine (decided 2026-08-02)

Supersedes the "68k offload is the last resort" position in `drv/README.md`
§2. That position was argued on **bytes**, and the overlay pass solved the byte
problem. The binding constraint is now **cycles**, which no Z80-side technique
can move by the required factor.

## What the measurements settled

Z80 frame = 59,659 cycles. PCM soft-mix measured (after this session's
optimisations): **~240 cycles per voice per mix tick + ~260 fixed per tick**,
i.e. 3 voices = 972/tick = 170k/frame = 285% of the budget.

Rewritten to the theoretical floor for the current semantics (16.16 resampling
+ per-voice volume + i16 sum): ~110/voice + ~120 fixed →

- 2 voices × 175 ticks = **59,500 cycles = 99.7% of the frame, with the
  sequencer running zero instructions**.

So a Z80 that also sequences cannot do 2 voices at 10.5 kHz, and the
sequencer's own cost is not the reason — its median is only 19.7k (33%). The
two workloads simply do not fit in one Z80.

## Decisions

1. **Split (option C).** 68k runs the sequencer; the Z80 becomes a PCM mixer +
   chip-write engine.
2. **The Z80 keeps the clock.** The 68k pre-renders per-frame register-write
   lists into a ring in Z80 RAM; the Z80 consumes one per frame at its own
   vblank. Tempo stays 60 Hz-exact and a heavy game frame is absorbed by the
   ring instead of stuttering the music — this is the property that motivated
   the all-Z80 design in the first place, and it survives the split.
3. **SE moves to the 68k** (2026-08-02). Keeps the Z80 a pure engine; costs SE
   1–2 frames of latency, accepted.
4. **PCM voice count fixed at 3** (2026-08-02). Lets the mixer be fully
   specialised (three passes, no voice-count loop).
5. **No compile-time pre-resampling** (the "option B" idea is dropped). After
   the split, runtime 16.16 resampling costs ~25 cyc/voice/tick — 11% of the
   PCM budget — so per-note PCM pitch is affordable and the ROM cost and loss
   of freedom are not worth paying.

## Why the mixer gets fast: the RAM, not just the cycles

The sequencer leaving frees **~7 KB of Z80 RAM** (5.6 KB of code plus TCB 512 B,
channel state 640 B, shadow 304 B, macro/sweep state). That is what makes the
real fix possible: **voice-outer passes over a full-frame mix buffer**. Today's
mixer is tick-outer and therefore re-reads every voice's state from RAM on every
tick; with a buffer, one voice owns the register file for its whole 175-tick
pass. The buffer had nowhere to live before.

Estimated per tick (same instruction-level model that matched the measured
240/voice): output pass 26, first voice 60, each further voice +71.

| voices | cyc/tick | max rate at ~55k cycles |
| --- | --- | --- |
| 1 | 86 | ~38 kHz |
| 2 | 157 | 21 kHz |
| 3 | **228** | **14.5 kHz** |
| 4 | 299 | 11 kHz |

3 voices at 10.5 kHz = 40k = **73% of a dedicated Z80**. With a 16-bit mix
buffer (sum then saturate, preserving per-voice dynamic range) it is ~301/tick
= 52.7k = 96% — fits, with 160 ticks (9.6 kHz) as the fallback. **16-bit chosen**
unless measurement says otherwise: RAM is free now, so do not trade audio
quality first.

## What this unlocks beyond voice count

- **Dynamic loop points are free.** Voice-outer loads loop start/end into
  registers once per frame, so changing them costs nothing per tick and takes
  effect the next frame. Ping-pong loops and macro-modulated loop length become
  cheap the same way. This was the user's reason for rejecting pre-resampling.
- **The 32 KB sample-bank wall dies.** A voice reads a contiguous run of ~175
  samples per frame, so each voice pass can latch its own ROM bank (at most one
  boundary crossing per frame to handle). Sample memory becomes ROM-sized.
- **The 8 KB ceiling stops governing the design** — overlays, the byte-funding
  menu, DATA_BASE bumps, WIDE_OFFSETS/cross-MMB/PAL deferrals all go away.

## Fixed limits (expectation-setting)

8-bit DAC (YM2612), nearest-neighbour only (interpolation needs a multiply per
sample — impossible at any rate), and DAC jitter from the 68k's per-frame bus
grab (~tens of µs, ~0.2%; **measure on hardware**).

## The interface (proposed, not yet settled)

Chip writes stay on the Z80 rather than the 68k writing the YM directly: the
68k would have to hold the Z80 bus for every write plus BUSY waits (100+ µs,
an audible DAC gap), whereas dumping ~150–250 bytes into Z80 RAM is one short
grab and the Z80 paces the writes itself (~61 cycles per FM write, ~3.7k/frame
at 60 writes).

One ring slot = one frame, holding both the chip writes and that frame's PCM
voice commands, so a PCM note-on lands in the same frame as the music:

```
[u8 psg_count][bytes…]
[u8 fm0_count][reg,val…]     ; length-prefixed runs, so the consume loop
[u8 fm1_count][reg,val…]     ; needs no per-write dispatch
[u8 pcm_count][pcm commands…] ; start/stop voice, set vol/inc/loop points
```

**Ring depth: default 2, and treat it as a per-game tuning knob, not a design
constant** (decided 2026-08-02).

Depth is lookahead, not decimation — the Z80 still consumes one slot per vblank,
so the music keeps 60 Hz resolution at any depth. What depth buys is tolerance:
at depth N the game may overrun N-1 frames without the music stuttering. What it
costs is the latency of **every host→music operation**, and SE is only the most
obvious one: `MMLisp_setVal` (`$slot` live control), `setParam`, `fadeTrack` and
`stopTrack` all inherit it.

Re-rendering the ring on invalidation rescues a one-shot (an SE start, a fade),
at a cost of depth × the per-frame sequencer work — ~24k 68k cycles at depth 4,
19% of a frame. It does **not** rescue continuous control: a game driving
`setVal` every frame would re-render every frame, throwing the lookahead away
*and* paying depth-times the cost — the worst case of both. So **deep lookahead
and continuous live control are mutually exclusive**, and since interactive
music is a stated goal of the language, the shallow default is the honest one.

If depth 2 later proves too shallow for a real game, the escape is **indirect
write-list entries** ("write register X from val slot S"), resolved by the Z80
at consume time, which keeps live control at one frame while the music stays
pre-rendered. Deliberately deferred: it puts a little resolution logic back on
the Z80 and blurs the "pure engine" line, so it should be paid for by a measured
need, not designed in up front.

Independent of depth: the Z80 must publish a consumed-frame counter so the 68k
can fire `(trig N)` when the frame is actually heard rather than when it was
rendered, since the 68k runs ahead by the ring depth.

Also available at any depth: the 68k may render N slots in one burst every N
frames rather than one slot per frame, moving its sequencer work to 60/N Hz.
That trades a steady ~5% load for an N× taller spike at 1/N the rate — better or
worse depending on the game's own frame-budget shape, so it is a per-game choice
too, not part of the interface.

## What survives, what is rewritten

**Survives:** the MMB format, opcodes, level model, macro semantics, SE model,
voice tables, the language, `export-mmb.js`, `drv-player.js`, `mmb-build`,
`ab-gate`, the gate corpus, banking, the SGDK glue skeleton, and the Z80
assembler/emulator/trace toolchain.

**Rewritten:** ~5,600 bytes of Z80 sequencing assembly → C on the 68k.
**`drv-player.js` is the port spec** — it is already a complete, validated
implementation of the sequencer in a portable language, which is why this port
is far less risky than the original Z80 one was. The gate becomes "68k C vs
drv-player.js" (both host-runnable, easier than the emulator gate), plus a
smaller Z80 gate for the mixer and the write-list consumer.

**Next:** settle the ring depth and the slot format, then rewrite
`docs/driver.md`'s architecture sections before any code.
