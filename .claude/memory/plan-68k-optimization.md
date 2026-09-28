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

A voice change on several channels is the measured worst case. Whatever the
re-profile finds, two structural answers exist:

- **VOICE_SET bodies in the sample-bank ROM** (roadmap #3): a voice change
  becomes one pair on the wire and one ROM pointer on the 68000, instead of
  ~30 composed writes a channel. Also the fix for the wire budget.
- **Spread the frame.** The host already renders `MMLISP_LEAD` frames ahead;
  a worst frame of 116% is absorbed by a lead of 2. That is latency on the
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

1. **Re-profile on the user's machine, heaviest score**, `--pc` and
   `--peak 3` — resolves §0's two anomalies and ranks §1–§3. Until then the
   ranking above is a reading, not a measurement.
2. **The macro engine's local fixes (§2)** — descriptor cache, no struct
   copy, keyed/channel properties cached — one variable per build, c-gate
   green after each, profile after each.
3. **The write path (§3)**, single walk first.
4. **Then decide §4** (pre-rendering) against the numbers 1–3 leave: if the
   steady state is already under the game's budget, §4 is not worth its ROM.
