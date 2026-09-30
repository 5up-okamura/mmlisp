# Cutting the 68000's share — the issue list (2026-09-28)

The user's direction after the Z80-only study ([[plan-z80-only]]): **keep the
split, make the 68000 side cheap.** The game wants the 68000 for raster
effects and 3D; the driver's 28% average / 116% worst render (`drv/sgdk/README.md`)
is too much. Nothing here is implemented: the user is still making small
fixes, and the optimization pass starts after. This file is the survey that
precedes it, from reading `drv/68k/mmlispseq.c`, `mmlpairs.c` and
`drv/sgdk/mmlispdrv.c`; every cycle figure below that is not marked measured
is a reading of the code, to be replaced by `npm run sgdk:profile` numbers.

## 0. What is known, and the holes in it

Known (one six-channel song, `sgdk:profile`): driver ~28% of the 68000 on
average — render ~18%, "the pump the rest" — worst render ~116% of a frame on
a voice change over several channels. A previous pass already removed the
libgcc calls (`mod3`, `mml_muls`/`mml_divs`, the `%` on the queues) and
inlined the hot helpers, so the cheap arithmetic wins are largely taken.

Two of those figures do not match the code's shape and must be re-measured
before anything is optimized against them:

- **The pump at ~10%** is ~90,000 master cycles a frame for one 2,400-cycle
  grab, a 16-pair plan and a few PSG bytes. Either the profile charged the
  pump the vertical interrupt's other work (SGDK's own), the BUSACK poll
  waited on a long Z80 instruction, or the PSG run's interrupt masking is
  being counted. `--pc` sampling, not the mark wrappers, settles it.
- **The 116% render**: `apply_patch` is 29 compares and at most 29 `ym()`
  calls a channel — a few thousand cycles, not the ~130,000 a 116% frame
  holds. Something else runs in that frame (the loop head's re-dispatch of
  every track's setup? the queue walk?). `--peak 3` names it.

Both need the user's machine (SGDK + probe BlastEm); the cloud has neither.
**Profile the user's heaviest score, not the demo.**

**Measured 2026-09-30, `sin008`, `--pc` (29 s, 1,486,153 samples every
1,000 master; the wrapper run before it agreed in shape but under-counts,
since a wrapper sees only its own function's span):**

| | of the 68000's time |
| --- | --- |
| `VDP_waitVBlank` (idle) | 75.2% |
| example main.c, SGDK, text | ~2.5% |
| **the driver** | **~19.5%** |
| driver API polled by the example each frame (`MMLisp_trig`, `mml_track_id`) | ~3% |

Inside the 19.5%, by source line:

| block | share | what |
| --- | --- | --- |
| macro engine | ~6% | `step_channel_macros` 2.8, `macro_desc` **1.5** (the double decode, as read), `macro_sample` 0.8, `step_macro` 0.5, `fm3_op_for`+`channel_keyed`+`macro_ch` 0.6 |
| the track tick loop (`run_frame` 2273–2315) | ~3.7% | real work: accumulators, gate/wait countdowns |
| the sweep-bank walk (`run_frame` 2323/2327) | **~1.8%** | 17 banks × 2 slots tested a frame; `process_sweep` itself 0.08% — almost all of it is empty |
| pump | ~2.6% | `mmlp_plan` 1.4, grab 0.3, `released` 0.25 (called twice a pump), **libgcc `__udivsi3`+`__modsi3` 0.45** (the int-promoted `% 9` / `/ 9` in `staged_voice`/`gen_voice` are the suspects) |
| dispatch, note_on, level composition | ~1.7% | real work |
| write path (`view_body`, `push`, `q_push`, `frame_publish`, `slot_take`, `mml_pending`) | ~1.1% | |
| `process_macros`'s 17-channel scan (line 1377) | 0.74% | count tests only |
| `process_fades`'s track scan (2082/2084) | 0.45% | flag tests only |
| PCM | ~0.5% | |

The API 3%: `MMLisp_trig` (2.2%) and `mml_track_id` (0.7%) are linear
searches over the tracks, called per track per frame by the example's status
display — a game polling triggers does the same.

The README's "pump ~10%" and "worst 116%" were wrong (voice_set is 36k a
call, 4%). **`--pc --peak 3` (same run): the three heaviest renders average
~795k master = ~89% of a frame, and they are real work, not a stall** —
the samples spread over the driver's lines instead of pinning one PC. They
are setup bursts (the song's start and/or a loop head: every track's voice
and parameters at once, 600–700 writes in one frame): the write path
(`view_body` 221 + `push` 172 + `q_push` 194 + `ym` 66 + `psg_push` 23 of
2,384 samples = **28% of the frame**), `dispatch` 12%, `apply_patch` 5–11%,
`fm3_op_for` alone 82 samples (called per write/note-on to test one bit).
So §3 matters for the worst frame, not the average, and roadmap #3
(VOICE_SET bodies in ROM) is the structural answer.

**Ranking from the numbers (gain ÷ risk); none of 1–4 changes a register:**

1. **O(1) API lookups** (3%): a track-id → index table.
2. **No empty walks** (~3%): sweep banks, macro channels, fades, stopped
   tracks — walk the active set only (active lists or bitmasks).
3. **The write path (§3)**: 1.1% steady, **28% of the worst frame**. One
   walk in `view_body` first; then the sequencer pushing pairs directly.
4. **Macro engine** (~2–3%): cache the decoded descriptor (or at least
   `is_keyon`) in the slot, make `fm3_op_for`/`channel_keyed`/`macro_ch`
   channel properties (`fm3_op_for` is also hot in the burst), drop
   `macro_sample`'s struct copy. c-gate holds it.
5. **Pump** (~0.8%): no libgcc in `staged_voice`/`gen_voice`, `released`
   once a pump, `since_add` only for PCM pairs.
6. **The tick loop** (3.7%): real work; line by line after 1–5.
7. **VOICE_SET bodies in ROM** (roadmap #3): the worst frame's structural fix.

Expected: 19.5% → 10–11% from 1–5. What is left is the sequencer doing its
job; below that is §4 (pre-rendering), a design decision.

## 1. The fixed per-frame cost (paid with nothing to do)

`run_frame` walks every structure at its capacity every frame:

| walk | count | note |
| --- | --- | --- |
| tracks | `track_count` ≤ 32 | each: running/held/armed tests, the tick accumulator |
| sweep banks | 17 × 2 slots | `sweep_bank_ch` + two `active` tests each |
| macro channels | 17 | one count test each (already guarded) |
| fades | `track_count` | one flag test each |
| `MML_SLOT_SUBS` loop | 1 | folded by LTO at SUBS=1 (driver-decisions §9) |
| `mml_pending` per sub | 1 | |

Small individually; together they are the floor a silent driver pays. A
"dirty" bitmask per structure (which sweep banks have an active slot, which
tracks run) turns every walk into a scan of set bits. Low gain, low risk;
worth doing only once the profile shows the floor matters for the game.

## 2. The macro engine — the hottest steady-state path

The write census (driver-decisions §3): **99% of steady-state writes are
macro and sweep steps.** Per running slot per frame:

- **`macro_desc` decodes the descriptor from the ROM table every step** —
  and the same slot is decoded **twice a frame**: once in
  `step_channel_macros` to classify KEYON slots for the two-pass order, once
  in `step_macro`. A third decode per bound :vel macro in `restore_vel_base`
  on every note-on. 8 field reads + a 16-bit table offset each. Caching the
  decoded descriptor in the slot at bind/instantiate time (or at least the
  `is_keyon` bit) removes two of the three.
- **`macro_sample` copies the descriptor struct** (`const MMLMacro d = *dp`)
  on entry — 16+ bytes moved per sample for nothing.
- A pitch macro writes through `write_fm_pitch` → `fnum_block_for` →
  `fold_cents` — a `divs.w` whenever |cents| ≥ 100 (an additive vibrato on a
  detuned note, every frame) plus the `muls`/`divs` interpolation on every
  non-zero cent. A per-note cache of `(note, cents) → fnum` for the last
  value, or a cents-resolution F-number table (128 notes × 100 cents × 2 B =
  25 KB ROM, or 128 × 25 at 4-cent steps = 6 KB) makes it a lookup.
- Level macros go through `param_set_ex` → `recompose_carriers`: `carrier_tl`
  for each of up to 4 carriers, each three table reads and a rounding, then
  `ym()` with its shadow compare. A :vel envelope on a 4-carrier voice is 4
  composed writes a frame, of which the shadow drops the unchanged ones after
  the work is done. Composing once and applying the delta to the four voiced
  TLs is the same result with one composition.
- `channel_keyed` / `macro_ch` / `fm3_op_for` are re-derived per slot per
  frame from the channel id; they are properties of the channel.

Expected gain: the largest of the local items — this path runs once per slot
per frame on every score with envelopes, which is every score.

## 3. The write path: queue → view → pairs

A register write is handled three times before it is a pair: `ym()` (shadow
compare, `q_push` into the 3-byte queue), `view_body` (walks the frame's
queue **twice** — once for port 0 and PSG, once for port 1 — copying each
write into the pair queue's three parallel arrays), then `mmlp_plan` (per
pair: `staged_voice` with its `% 9` and `/ 9`, `is_pitch_hi`, `since_add`
over the voices, the page-end tests). Options, cheapest first:

- Keep per-port counts while queuing so `view_body` walks once.
- `staged_voice`/`gen_voice` only apply to PCM commands (`port == 0xff`);
  hoist the test so register pairs skip them (partly done for `staged_voice`).
- Let the sequencer push pairs directly (its `ym()` already knows the port
  and register) and drop the intermediate queue — the converter gate
  (`pairs-gate`) exists to keep that trace-identical.

## 4. Change-only cannot save the steady state — pre-rendering can

The census again: F-number/period writes are 65% of traffic and change every
frame, so no shadow helps, and every one of them is computed at runtime from
a curve that was **already sampled at compile time** (`ir-utils.js`). For a
track the game never touches — no `$slot`, no host SET_PARAM, not an SE
target — the whole per-frame write list is a pure function of the score and
could be emitted by the exporter as data the 68000 copies into the pair
queue. This is the option the user chose over the Z80-only build precisely
because it keeps every feature. What it costs and what it must keep:

- **ROM.** A vibrato is 2 pairs a frame a channel: 120 B/s/channel, 7 KB a
  minute a channel. The dedup pass and LOOP already factor the stream; the
  same passes would have to factor the write list, or the list is emitted
  per note as a "write macro" the runtime replays (a middle ground: the
  macro's samples pre-composed into register values for the note's voice).
- **Interaction stays runtime.** A pre-rendered track must still be
  stoppable, fadable, stealable by an SE with suspend/restore, and must key
  off on a host KEY_OFF. The register shadow must still see its writes
  (otherwise a later change-only write is wrongly suppressed). The runtime
  keeps the channel state; only the *composition* moves to compile time.
- **The gate.** The trace must stay identical to `drv-player.js` (c-gate),
  so the pre-render is an exporter pass with the reference player as its
  oracle — the cheapest kind of change to validate in this repo.
- **Design decision required** (CLAUDE.md: confirm before implementing).
  Which tracks qualify (static level+pitch macros only? sweeps too?), where
  the data lives, what a mixed frame looks like.

## 5. The worst frame, and the render lead

The measured worst case (§0) is the setup burst — every track's voice and
parameters in one frame, ~89% of it — not a voice change. Two structural
answers exist:

- **VOICE_SET bodies in the sample-bank ROM** (roadmap #3): a voice change
  becomes one pair on the wire and one ROM pointer on the 68000, instead of
  ~30 composed writes a channel. Also the fix for the wire budget.
- **Spread the frame.** The host already renders `MMLISP_LEAD` frames ahead;
  the measured worst frame (~89%) already fits a lead of 1; a lead of 2 buys margin. That is latency on the
  control calls, not CPU, and it is the cheapest knob of all.

## 6. The host side

- The grab is 2,400 master and already asm; the bank register write is asm.
  Nothing left there but the count of grabs (one a frame).
- `mmlp_plan` is per pair; see §3.
- The PSG run masks interrupts for its bytes; fine.
- `MMLSeq` is ~6 KB+ of RAM (a 1,024-entry write queue at 3 B, 1 KB of
  shadow, 32 TCBs, 17×8 macro slots and binds). Not a CPU issue, but a game
  that wants RAM too will ask.

## 7. Order of work (proposal)

1. §0's ranking, items 1–5, **one variable per build**, `verify:all` green
   after each, `--pc` after each. Starts once the user's current fixes land.
2. **Then decide §4** (pre-rendering) against what is left: if the steady
   state is under the game's budget, §4 is not worth its ROM.
