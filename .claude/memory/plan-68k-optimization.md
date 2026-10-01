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
call, 4%). **`--pc --peak 3` (same run): the three heaviest renders of 1,767 are
91%, 120% and 72% of a frame (~89% mean) — three different places in the
song, not the start alone — and they are real work, not a stall** —
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

## 3a. Found while designing §3: fm4–6 key-ons reach the chip before their pitch (2026-10-01)

The slot format buckets a frame's writes by port (PSG, port 0, port 1) and
`slot-builder.js` calls that "safe by construction" because "everything
whose order carries meaning is port-0-local (the $28 key edges …)". **It is
not:** `$28` is on port 0 for EVERY channel, while fm4–6's F-number, TL and
patch are port 1. The sequencer writes a note's pitch then its key-on; the
bucket moves the key-on ahead of the pitch. Measured on the c-gate corpus
(drv-player write order vs the slot, 1,200 frames a score): **372 fm4–6
key-ons ahead of their own channel's port-1 writes** — 744 pitch writes
($A4/$A0), 67 patch, 22 TL — typically 3–7 pairs early, 2 by ≥16 pairs
(m3-voice, 24). The engine takes ~1 pair per ms (8 expander steps a
7.8 ms lap on pcm1), so an fm4–6 note attacks a few ms at the previous
pitch/voice, and a frame or more in a burst. **A model prediction, not yet
heard** — the discriminating check is the same phrase on fm1 and fm4. No
gate sees it: c-gate and pairs-gate compare the bucketed form on both
sides, ab-gate compares by frame. The slot format has lost the order, so
the fix has to work from the sequencer's own order (the view queue), i.e.
it belongs to §3's restructure: a `$28` for fm4–6 is a barrier — the
port-1 writes before it go out before it.

**Landed (`ac19c45`) and REVERTED the same day (`465b303`), 2026-10-01.**
The landing: the host took the frame uncapped and in sequencer order
(`fill_view` with no cap), `mmlpairs.c writes_body` held port 1 to the
frame's end or an fm4–6 `$28`, PCM commands first; gates moved to frame
records (`gate_main --frames`, `pairs-model.mjs FrameRecorder`,
`mmlp_frame`). On the corpus: 0 early key-ons (was 372), wire −0.09%,
verify:all green. **The user heard it broken on BlastEm**: DAC attacks off
their beat, and "too high" (not yet explained — may be a separate cause;
the revert is the discriminating build). Cause of the timing, measured in
the host model: uncapping put a burst's whole FM backlog in the pair queue
at once, so later frames' PCM commands queued behind it — worst PCM-start
latency stress-9ch 8 → 18 frames, demo 6 → 14, m3-pcm-sync 6 → 11. The
95-write cap had been giving PCM priority by accident: the excess waited in
the sequencer's queue and each frame's PCM went into the pair queue ahead
of it. **No gate measures PCM-start latency** — add one before re-landing.
A re-land needs PCM ahead of the FM backlog by design (its own lane in the
pair queue, released by frame like the rest), not by the cap. Even the old
path delays a start 6–8 frames behind an unprimed burst.

## 5. The worst frame, and the render lead

The measured worst case (§0) is the setup burst — every track's voice and
parameters in one frame, ~89% of it — not a voice change. Two structural
answers exist:

- **VOICE_SET bodies in the sample-bank ROM** (roadmap #3): a voice change
  becomes one pair on the wire and one ROM pointer on the 68000, instead of
  ~30 composed writes a channel. Also the fix for the wire budget.
- **Spread the frame.** The host already renders `MMLISP_LEAD` frames ahead;
  the measured worst frame (120%, with light frames after it) loses nothing at a lead of 1; a lead of 2 buys margin for a game that is heavy in the same frame. That is latency on the
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

1. §0's ranking, items 1–5 — **landed 2026-10-01 on main, one commit each**,
   gates green after each (c-gate, c-gate:pal, claim-gate, pairs-gate,
   sgdk:lint, engine:score): `4c50af1` the track-id table, `f2a30c2` the
   live masks, `6622a3b` the port-1 stretch, `9ea61ec` the macro engine,
   `fef512e` the op tables. Then `8d28b53` (offsets + KEYON pass) and
   `671bd2a` (the tick loop's uneventful frame taken before the loop), then
   `ac19c45` (§3a, the in-order frame — since reverted, `465b303`). **Re-profiled 2026-10-01 (sin008,
   `--pc`, 29 s):** idle 82.5%; driver 13.6% + API 1.0% = **14.6%** (from
   22.1% at the start). run_frame 4.46% → 3.13% (the tick fast path).
   Worst frames (`--peak 3`) unchanged at ~87% — the write path is still
   ~30% of them (`q_push`, `writes_body`, `port1_run`, `push`). What is left,
   by block: the macro engine ~4.5% (`step_channel_macros` 1.3,
   `macro_desc` 1.04, `macro_sample` 0.58, `process_macros` 0.53 — its
   `1u << mc` per channel is a variable 32-bit shift — `step_macro` 0.48,
   `fm3_op_for` 0.40, `macro_ch` 0.18), run_frame 3.1%, the pump ~2.6%
   (`mmlp_plan` 1.5), the write path ~1%.
   **Re-profiled 2026-10-01 (`sin008`, `--pc`, 29 s):** idle 75.2% → 80.3%.
   The driver (sum of its outer functions) 19.2% → 15.4%; the API polls
   2.9% → 1.3%; together 22.1% → 16.7%. What moved: the sweep walk (−1.8,
   run_frame 6.4 → 4.55%), fades (0.45 → 0.01), libgcc `__udivsi3`/`__modsi3`
   (0.44 → 0.03), the KEYON-classify decode (`macro_desc` non-constprop
   0.45 → 0). What did not: **the worst frame** (`--peak 3`: 89% → 86%,
   the write path still ~29% of it — the port-1 stretch saves nothing in a
   burst, where port 1 is spread across the frame); `macro_desc` in
   `step_macro` (1.07%, one decode per step remains); `mmlp_plan` (1.5%).
   `track_by_id` was still 1% after the table: `&trk[i]` is a `mulu.w`
   (MMLTrack is 152 B) — `8d28b53` stores byte offsets instead. **That
   commit also skips the KEYON pass on channels with no KEYON slot**
   (`keyon_retrigger` is the only writer of a PCM `retrig`, so the skipped
   pass could only skip slots) — two variables in one commit, message
   names only the first; they sit in different functions, so `--pc` still
   separates them.
   Reading the generated code: `m68k-linux-gnu-gcc` (apt, the cloud) with
   `-m68000 -O3 -fomit-frame-pointer` reproduces the SGDK build closely
   enough to see instructions per line. The `--pc` line counts credit an
   instruction's time to the NEXT instruction (a `lsr.w #8` is 22 cycles
   and its successor's line collects it), so read per-line counts ±1
   instruction; per-function totals hold.
   Left out of item 5 on purpose: `released` twice a pump (0.25%; caching
   it across plan and psg_take could take a frame's PSG bytes one grab
   later when frames_in advances between the two, a timing change the
   gates would have to re-baseline) and `since_add` (0.14%).
2. **Then decide §4** (pre-rendering) against what is left: if the steady
   state is under the game's budget, §4 is not worth its ROM.
