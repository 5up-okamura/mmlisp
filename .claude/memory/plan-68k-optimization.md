# The 68000's share — CLOSED 2026-10-02

The user's direction after the Z80-only study ([[plan-z80-only]]): keep the
68k/Z80 split and make the 68000 side cheap, so a game keeps the CPU for
raster effects and 3D. Ran 2026-09-28 .. 10-02; **closed by the user's call**:
what is left is the price of moving parameters every frame, which is what
this driver is for. The working notes (the issue list, every profile) are in git
history: this file at `afef069`.

## Result (sin008 played whole, `sgdk-profile --pc`, 30 s)

| | before (`ba094a6`) | after (`bf50bdc`) |
| --- | --- | --- |
| driver + API | **24.5%** | **16.3%** |
| idle (the game's) | 72.8% | 80.6% |
| run_frame (tick walk) | 6.8% | 3.7% |
| macro engine | 7.0% | 4.8% |
| API polls (`MMLisp_trig`, track lookups) | 3.0% | 1.3% |
| pump | 3.6% | 3.2% |
| worst 3 renders (`--peak 3`) | 98.8% | 94.0% |

The worst frames are the setup burst (251 writes at f0 of sin008) and a
mid-song voice change on several channels (79 writes at 15 s); the pass
barely touched them.

## What landed, and the rule that pruned it

Kept: the track-id table (an index table since `386caa1`); live bitmasks so
the frame walks only active sweep banks, macro channels and fades; the op
tables in place of `% 9` / `/ 9` (libgcc calls); one tick loop that takes the
quiet ticks in one subtraction (`e039d6b`); the macro descriptor decoded once
a note into its slot (`8a27775`: `macro_desc` 1.27% → 0.05%, slot 12 → 22 B,
MMLSeq 13,322 → 14,682 B).

**The user's rule (2026-10-02): readability over noise-level gains.** Undone
for it (`e9b53c8`, `386caa1`): the walking bit in `process_macros`, the
three-way `carrier_tl` split, the byte-offset track table (cost ~0.24%,
accepted). Comments say why, not what it cost (`bf50bdc`). Any future
speed-up must show in an A/B profile and read plainly.

## Correctness found on the way (all gated now)

- fm4–6 key-ons reached the chip ahead of their own port-1 pitch (the slot
  bucketed writes by port): the host now takes a frame in the sequencer's
  order, port 1 held to the frame end or an fm4–6 `$28` (`c92f7da`);
  `pairs-gate` KEY ORDER.
- PCM starts queued behind a burst's FM backlog (8–18 frames): PCM commands
  and `$2B` ride their own lane, drained first (`4aac18f`); `engine:score`
  LATENCY ≤ 4 frames (typical 2.3).
- `mmb-dedup` left a `(break)` skip stale when it landed past its LOOP_END's
  join pins; tracks stopped mid-song in both sequencers (`b54d937`). c-gate
  now FAILS a stopped track (it had counted it "pending").
- Lesson: C ≡ JS gates prove agreement, not correctness — both were wrong
  the same way in the last two. Ears and BlastEm found them.

## How to measure

- `node tools/sgdk-profile.mjs <score> --pc --seconds 30`, and `--peak 3`
  for the heaviest renders. Line attribution is ±1 instruction (a long
  instruction's time lands on the next line); per-function totals hold.
- A/B a driver change with the same tools: `git checkout <rev> -- drv/68k
  drv/sgdk`, profile, `git checkout HEAD -- drv/68k drv/sgdk`.
- Reading generated code in the cloud: `m68k-linux-gnu-gcc -m68000 -O3
  -fomit-frame-pointer` (apt) is close enough to the SGDK build.
- **Profiles taken before `b54d937` ran a broken sin008** (tracks stopped at
  frame 788, ~13 s); do not compare against them.

## Left, for when a game actually drops a frame

- **Hand-written assembly for the hot paths only** (the macro step, the tick
  walk, `mmlp_plan`), the C kept as the reference and swapped out only in
  the SGDK build — the one lever that keeps every feature. The gates would
  need a first-party 68000 emulator (the C runs on the host today) or a
  BlastEm A/B on the user's machine.
- A per-frame-numbered `sgdk-profile` output, to measure a mid-song burst
  alone.
- Voice changes stacked in one frame: the exporter could move those on
  channels resting (keyed off) one frame earlier, reported as an info
  diagnostic, IR player alike. Discussed, not designed; the composer should
  not have to do it (no `-1f` length arithmetic for this — `c-` is a flat).
- Step 2, the sequencer pushing pairs directly (~1–2%, a large code change).

Rejected: pre-rendering macros (XGM by another name — the user wants a
synth the game can play); a split render spreading one frame over the
render lead (control calls deferred to the next frame head; not worth it
for these bursts).
