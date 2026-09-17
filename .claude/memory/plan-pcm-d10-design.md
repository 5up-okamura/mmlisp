# D10 — the light PCM engine: the design (2026-09-17)

The implementation spec for plan-pcm-spec.md D10 (the user's big goal: no
pitch step, 1–3 voices chosen per score, 6 dB levels, the highest rate, loops
with per-note and curve-driven start/end, light over exact, VSync-only host,
YM writes stay on the Z80). Written in a design session; the implementing
sessions build it in the order of §8, one step per session, `verify:all`
green after every step. Where this file and an older document disagree, THIS
file and the user's decisions win — flag the contradiction, never carry the
older text silently (the 15-level LUT precedent, plan-pcm-spec.md D4).

Every rate below was MEASURED by placing and assembling the image with the
generator (`npm run dac-stream:light`, experimental/dac-stream/light-study.mjs,
the `loops: true` profile in drv/engine/gen-stream.mjs). Nothing here is an
estimate unless it says so.

## Progress

- **S1 — DONE 2026-09-17.**
  `tools/build-engine.mjs` `LIGHT_IMAGES` / `buildLightImage(voices)` /
  `lightDescriptor`; `live/src/pcm-model.js` (`PcmEngineModel`,
  `pcmLoopPoints`, `pcmShotPoints`, `pcmOp`, `pcmPageOfShift`);
  `tools/engine-gate.mjs` (`npm run engine:gate`, in `verify:all`;
  `engine:gate:negatives` proves mis-cost/wrap/idle are caught);
  `tools/emit-images.mjs` → `live/src/engine-images.js`, checked by `mirrors`.
  Measured rates unchanged: 14,375.7 / 10,111.7 / 6,653.4 Hz.
  DEVIATIONS from the text below, decided while building S1:
  1. **The IDLE count is per image, computed, not "three"** (§2.3):
     `descriptor.idleAfterGen` = the most expander steps that can fall between
     a generation pair's consumption and the last read of its staged bytes —
     **pcm1 1, pcm2 1, pcm3 5**. Three would corrupt starts at pcm3. Measured:
     one fewer than computed breaks INTENT at pcm1/pcm2.
  2. **The generation pieces read the generation ONCE, through main B, no
     `exx`** — 75 cycles, not 82.
  3. **The C header is NOT emitted in S1** (§1.9 said emit-bin writes it):
     `mmlispdrv_bin.h` is still the shipped image's, because the SGDK host
     links it until S4. S2 adds the three images and the new op macros to the
     C side together with the converter that uses them.
  4. `engine:1v` / `engine:fifo` stay in `verify:all` until S2 removes the
     shipped image; `engine:gate` runs beside them.
  5. The model's `log` (start-apply / start / retarget) is how INTENT is
     graded; S2's drv-player can use the same log for its own checks.

- **S2 — DONE 2026-09-17.** The shipped driver now IS the light images: the
  sequencer (C ≡ drv-player, 41 scores), slot format v2, the converter (C ≡
  JS twin, 41 scores), bank v0.3 + MMB v0.3 header (PCM voices in flags bits
  2-3), `mmlispdrv_bin.h` with the three images, the SGDK host booting the
  score's image, `engine:score` on 12 real scores through their own images.
  The one-voice image, `engine:1v`, `engine:fifo`, `mmlispdrv.bin` and
  `stop-listen.mjs` are gone. verify:all green; `engine:gate:negatives` green.
  DEVIATIONS / DECISIONS TAKEN WHILE BUILDING S2:
  1. **$2B is sent on the score's first PCM note** (the design said frame 0 by
     pcm-voices). Same result for a PCM score, and it did not wait for S3.
  2. **The armed frame now stops at PCM_NOTE_ON too.** Removing the PCM lead
     exposed that the armed dispatch only stopped at FM/PSG notes, so PCM notes
     sounded in the armed frame, a frame early.
  3. **The MMB header's PCM voice count is written in S2**, from
     `metadata.pcmVoices` when present (S3) else the highest `pcmN` track
     (`export-mmb.js scorePcmVoices`). MMB VERSION_MINOR is 3.
  4. **Kept until S6**: `mmb.js`'s old clock/ring/bake constants
     (`mucom-pcm.js` and `lut-blob.js` still import them), the LUT_TABLE
     section, `drv/engine/` decode/corrector/protocol/pair-host/pcm1-ref
     modules (the research bench imports them).
  5. **`sgdk:gate` stops with a message** until S4 ports its grading to the
     images (its DAC reference was the one-voice image's).
  6. **The SGDK host keeps two pumps × 8 pairs** for now; S4 moves to VSync-only.
     `MMLispStats.dropped/stepRounded` → `faults` + `image`.
  7. **drv-player live path**: the DAC bytes come from `PcmEngineModel` fed the
     player's own commands at once (no pair delay). An SE that steals a looping
     PCM voice restarts that note at SE end (the engine keeps no position);
     muting a PCM track parks its voice.
  8. **`mml_done` / `_done` no longer wait for PCM tails.**
  9. **A/B baseline**: m3-pcm-master went 528 → 0 mismatches (the PCM lead had
     moved its master changes a frame early); re-frozen.
  10. SYNC on m3-pcm-sync: PCM onsets −0.3..−1.3 ms against the fm1 key-on.

- **S3 — PART DONE 2026-09-18.** Everything of §4.1 EXCEPT the
  `:loop-start`/`:loop-end` TARGETS: `(def pcm-voices N)` (reserved metadata,
  `metadata.pcmVoices`, no ordinary-def fallback), `E_PCM_VOICES` (a value
  outside 0-3, and a `pcmM` track above the stated count), `E_PCM_NO_PITCH`
  (`:pitch`, `:semi`, `(glide …)`, `(macro :pitch/:semi …)` on a pcm track —
  three chokepoints: the inline-param default branch, `applyMacroEntryToState`,
  the glide directive), `E_FM6_DAC`, `W_SAMPLE_KEY_UNIMPLEMENTED`, and the
  C2-C6 clamp + `W_PCM_PITCH_CLAMP` removed. Docs: language.md §1/§9/§16
  (rewritten: a Voices-and-the-rate table, the fm6 rule, the baked-pitch rule),
  ir.md §2/§2.2/§5.17, guide.md §19, roadmap. New scores `m4-pcm-loop`,
  `m4-pcm-2v-master`, `m4-pcm-3v`, `m4-fm6-only`; `m3-fm6-pcm` DELETED (its
  premise — fm6 FM alongside PCM — is what D6 forbids). c-gate, pairs-gate,
  engine:score lists updated; ab baseline re-frozen (54 scores; only the five
  score entries moved, no existing signature changed). verify:all green.

  **STILL OPEN — the loop-point targets, and why.** §4.1 says the value is "in
  source frames of the sample" and §3.1 has the driver convert
  `value × len_baked / src_frames`. But the value machine's WIDEST value
  anywhere is i16: `PARAM_SWEEP` is a fixed 9-byte payload with `from i16,
  to i16`, and a macro blob is i8 (i16 with flags bit0). A sample that fills
  the 32 KB bank at pcm1 is 2.26 s — 99,750 source frames at 44.1 kHz, 49,875
  at 22.05 kHz. Source frames do not fit, so the unit is a real decision and
  not something to infer. Three candidates, costed:
  1. **Q15 fraction of the slice** (0..32767 = 0..1). Fits every existing wire
     unchanged; the driver's conversion becomes `(v × len_baked) >> 15`, which
     is CHEAPER than the design's divide and needs no `src_frames`. Cost: the
     track target's unit differs from the def's `:loop-start` frames.
  2. **Source frames, converted to Q15 by the EXPORTER**, which knows
     `srcFrames`. Keeps one unit everywhere. Cost: the exporter must know which
     sample a track has bound at the moment of the curve — fine for one
     binding, a new diagnostic for a track that re-binds (drum kits).
  3. **An i32 width class.** Exact, no compile-time sample knowledge. Cost: a
     third width in `targetWidth`, a 6-byte PARAM_SET, and PARAM_SWEEP needs a
     wide variant (a new opcode) — the most expensive of the three for the
     least musical gain.
  Recommendation: 1, with the def keeping frames. Ask the user.

## 1. The engine

### 1.1 What the image is, and what it no longer carries

IN: the unrolled constant-time lap (one DAC write a slot, the slot boundary is
the `$2A` write, a group of slots exact in cycles), the N-voice mix (D4 rung
pages, master folded in by the host, the 512 B clamp cascaded per extra
voice), the six-piece loop-capable block edge per voice (§1.5), the pair
expander at its fixed sites, the boot with the READY mark.

OUT (the light direction, plan-pcm-spec.md D9/D10): the H-counter phase
decode, the corrector and its seven ladders, the runtime protocol (control
block, snapshots, boot/phase generations, commits), the phase table page, the
`lap ≤ 8.01 ms` rule (it existed for the corrector's one-grab-a-lap budget),
the octave step (`stStep`, `mix_st`, the `inc de` form is the only advance),
the `$2B` write at boot (§3.7), every timer write (already gone in
production). A bus stop is simply not repaid: the DAC runs slow by the stop
time (the ear accepted 200 µs twice a frame; the shipped pumps cost ~25 µs
once a frame under §5).

The generator's entry point is `generate()` (gen-stream.mjs), never
`generateSplit()` (decode-split.mjs — the decode, corrector and protocol
chain; it stays in the tree until §8 S6 deletes it with its gates).

### 1.2 Three images, one per voice count

One image cannot change its voice count at run time (the slots are unrolled),
so `(def pcm-voices N)` picks the image. Measured, loops in, no octave step,
wire 960 pairs/s, work ceiling 100% (the edge: the binding slot has no pad):

| image | voices | period (Z80 cyc) | rate | lap (samples) | expander steps a lap | mean work | code | binding slot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pcm1` | 1 | 249 | 14,375.7 Hz | 112 | 8 | 59.8% | 2,578 B | mix + expander A (151) |
| `pcm2` | 2 | 354 | 10,111.7 Hz | 80 | 8 | 83.9% | 2,820 B | mix + expander A |
| `pcm3` | 3 | 538 | 6,653.4 Hz | 48 | 8 | 84.4% | 2,363 B | mix + an edge piece + expander A (no plain slot exists at 3 voices: 18 edge pieces over 16 block positions) |

At a 95% ceiling: 13,610 / 9,597 / 6,313 Hz. The ceiling is a build constant
(`workTarget`/`meanTarget` in the image's config); the user chose the edge.
What the edge risks: the only unmodelled cycle is the 68k-window read wait
(3 cycles, measured on BlastEm with an idle 68000); a heavier wait on real
silicon stretches the binding slot and the DAC runs a little slow — no crash,
no hole. Verify on hardware before calling the rate final.

The sample bank is ONE 32 KB window a song (§4.2), so the rate is also the
bank's capacity: 32,512 usable bytes = 2.26 s at `pcm1`, 3.22 s at `pcm2`,
4.89 s at `pcm3`. XGM2 for comparison: 13.3 kHz, 3 voices, no PCM levels,
timer-paced with a ring (plan-pcm-spec.md D10 round 2).

Rates are what the generator finds for the FINAL image; the implementer
re-runs the study after any change to the pieces and puts the measured
numbers in the header, never these.

### 1.3 The RAM map — identical for the three images

`RAM_NV(3)` for every image, so nothing the host or the exporter addresses
moves between them (`pcm1` simply leaves the clamp page unused):

| region | address | contents |
| --- | --- | --- |
| code | `$0000–$10FF` | boot, the lap, `mix_one`, `xp_a`/`xp_b` |
| clamp | `$1100–$12FF` | 512 B saturating add (lut.mjs `buildClamp`) |
| lut | `$1300–$1AFF` | 8 rung pages: page 0 silence, page 7−r = `s >> r`, r = 6..0 (lut.mjs `buildRungs`) |
| (free) | `$1B00–$1BFF` | the old phase page — reserved, unused |
| ring | `$1C00–$1CFF` | finished samples, LEAD (18) ahead of the play cursor |
| fifo | `$1D00–$1DFF` | 128 `{op,val}` pairs (`MMLISPDRV_FIFO`) |
| state | `$1E00–$1E5F` | reserved for the expander (unused today) |
| (free) | `$1E60–$1E7F` | the old protocol block — reserved, unused |
| glob | `$1F00–$1F7F` | `G_*` bytes; the PCM state block at `$1F30` (§1.4) |
| stack | `$1F80–$1FFF` | |

The image uploaded is code + clamp + lut = `$1B00` = 6,912 B (was 7,168).

### 1.4 The state block and the ops (`PCMN_L`, config.mjs)

At `PCM_STATE = $1F30`. Op `o < $20` is a STORE `(PCM_STATE + o) := val`;
`$20` is PORT; `$22..$B6` is a RAW YM register write on the current port.
The 68000-writable bytes, NINE a voice from op `$01` (three voices end at
`$1B`):

| op (voice v) | name | meaning |
| --- | --- | --- |
| `$01 + 9v` | `LEVEL` | the voice's absolute rung page (host-computed, master folded in, §1.6) |
| `$02/$03 + 9v` | `SRC_LO/HI` | staged start: the source address in the window |
| `$04/$05 + 9v` | `END_LO/HI` | staged END (§1.5 contract) |
| `$06/$07 + 9v` | `WRAP_LO/HI` | staged WRAP: where the pointer goes when it reaches END |
| `$08 + 9v` | `START` | a NEW value: pointer, END and WRAP := the staged ones at the next edge |
| `$09 + 9v` | `RETARGET` | a NEW value: END and WRAP := the staged ones at the next edge (the pointer keeps playing) |

The Z80's own bytes, above any op's reach: per voice `liveEnd` u16, `liveWrap`
u16, `lastStart`, `lastEnd`, `parkMask`, `startMask`, `applyMask` (nine bytes
from `$22 + 9v`), then `fifoLo` at `$3D` (what the 68000 reads) and `ready` at
`$3E` (`$D2` once boot is done). `size` `$3F`; the block ends at `$1F6F`.

The C header carries these as macros of the voice: `MMLISPDRV_OP_LEVEL(v)`
… `MMLISPDRV_OP_RETARGET(v)` (= `1 + 9*v` …), plus `MMLISPDRV_OP_STRIDE 9`.
The pair-host's JS twin reads `PCMN_L_OPS(v)`.

### 1.5 The edge — six constant-time pieces a voice a block

A voice is a POINTER, an END and a WRAP. At every block edge, if the pointer
has reached END it is sent to WRAP. That one rule is a shot (WRAP = the
silence page `$FF00`: it parks, and re-parks at every edge for ever, exactly
as today), a loop (WRAP = the loop start, END = the loop end), a release
(RETARGET: END = the sample's end, WRAP = silence — the tail plays out and
parks), and a loop point moved by a curve (RETARGET with the new END/WRAP).

Pieces, at the voice's own phase (`voiceOffsets`: 0 / 0,8 / 0,5,11), each
with every path the same length:

| position | piece | cycles (v0 / v1,v2) | what |
| --- | --- | --- | --- |
| `LP_LIGHT_AT[N][0]` | START-GEN | 82 | `startMask := (startGen != lastStart)`, latch — branch-free |
| `LP_LIGHT_AT[N][1]` | END-GEN | 82 | `applyMask := (endGen != lastEnd)`, latch — branch-free |
| `LP_LIGHT_AT[N][2]` | APPLY | 138 | if `applyMask \| startMask`: `liveEnd := stEnd`, `liveWrap := stWrap`, clear `applyMask` |
| b14 | COMPARE | 65 / 79 | `parkMask := pointer >= liveEnd` |
| b15 | WRAP | 97 / 109 | the rung page into the mix; if `parkMask`: pointer := `liveWrap` |
| b0 (before the mix) | START | 81 / 93 | if `startMask`: pointer := `stSrc`, clear |

`LP_LIGHT_AT = {1: [11,12,13], 2: [11,12,13], 3: [1,12,13]}` — searched over
the piece costs so the three voices' pieces collide least (at three voices
every block position carries at least one piece; the worst collision is
82 + 82 = 164 cycles). COMPARE at b14, WRAP at b15 and START at b0 are fixed
by the END contract below and by "the start is applied before the first mix
of the block".

Why END and WRAP may be applied (b13) before the pointer (b0): COMPARE then
judges the OLD pointer against the NEW END, and a spurious park sends the
pointer to the new WRAP — which START overwrites before the block's first
mix. Nothing is read that the host may still be writing: the staged bytes are
read at APPLY and START only, and the host's three-IDLE rule (§2.3) keeps the
next staged store behind the edge.

THE END CONTRACT (unchanged from today, with the step gone): COMPARE sees the
pointer after the block's fifteenth mix; if it does not wrap, the next block
reads pointer+1 .. pointer+16. So the value the host sends is

    END = (address of the last byte to play) + 1 − 16

and the voice wraps at the last edge before it would read past. Every blob is
padded to a multiple of 16 bytes by the exporter (§4.2), so a shot loses no
tail and the loop arithmetic is exact:

THE ROUNDING CONTRACT (one function, `pcm_loop_points()` in the sequencer,
mirrored in JS, §3.3): with the blob at bank offset S and loop points ls < le
in baked bytes,

    le' = 16 · round(le / 16)                       (≤ blob length, a multiple of 16)
    ls' = le' − 16 · max(1, round((le − ls) / 16))  (≥ 0)
    END  = WINDOW + S + le' − 16,  WRAP = WINDOW + S + ls'

so the first pass plays exactly [0, le') and every later pass exactly
[ls', le'). On a one-cycle loop the rounding is a detune; the user accepted
that (plan-pcm-spec.md D10 round 2).

### 1.6 Levels

Eight rung pages, one table read a voice, no master stage: the HOST folds the
master into the page it sends. With the sequencer's `shift_v` (0..4, from
vel+vol as today) and `master_shift` (0..6):

    total = shift_v + master_shift
    mute  = (vol == 0) || (master == 0) || total >= 7
    page  = LUT_PAGE + (mute ? 0 : 7 − total)

A `MASTER` change therefore re-sends `LEVEL` for every voice (three pairs).
`PCM_VOL` re-sends the voice's. A level change takes effect at the voice's
next WRAP piece (whole-block, as today).

### 1.7 The expander and the wire

Unchanged pieces (`xp_a` 151 cycles, `xp_b` 82), `xpSteps = max(8, ceil(960 ×
lap seconds))` — the same 960 pairs/s the host has today (§5.3). At 8 steps
on these laps the engine eats 1,027–1,076 pairs/s. The planner places sites
on the roomiest slot in each step's window (gen-stream.mjs `nvExpanderPlan`,
the `cfg.loops` branch), not the first that fits.

The one lever not taken, for the record: splitting `xp_a` into a fetch piece
(op and value into main BC, ~65 cycles) and an execute piece (~114) would
lift `pcm1` to ~16.0 kHz and `pcm3` to ~7.1 kHz (ARITHMETIC, not placed).
The bank's capacity, not the Z80, is what argues against it at `pcm1`.

### 1.8 Boot and handshake

Boot: `di`, stack, every voice parked (pointer `$FF00`, `liveEnd` 0,
`liveWrap` `$FF00`, rung page 0 = silence, masks 0), the ring silent, the
FIFO all IDLE with `fifoLo` 0, IX/IY set, then `ready := $D2`, the `$2A`
latch, and the lap. No `$2B`, no timers, no control block. The host: upload,
reset, release, poll `READY` — exactly today's `MMLisp_init` minus the
control-block zeroing (§5.2).

### 1.9 The per-image descriptor

`buildEngine(voices)` returns bytes + header; `emit-bin` writes the three
images and ONE `mmlispdrv_bin.h`. Identical across images: FIFO, FIFO_PAIRS,
PAIRS_PER_GRAB, STATE, the OP macros, FIFO_LO, READY, READY_MARK, LUT_PAGE,
SILENCE, PROTO_VER (12). Per image, `MMLISPDRV_IMG[N]`: `bin`, `bin_size`,
`voices`, `period_master` (= period × 15), `rate_hz` (a rounded u16 stamp,
§4.2), `lap_samples`, `steps_per_lap`. The JS mirror `live/src/engine-images.js`
carries the same three rows (§4.1), written by `gen-c-tables` beside
`mml_rate.h`; `rate-mirrors` checks all three copies agree.

## 2. The wire: what the host writes for each command

### 2.1 The converter (`drv/68k/mmlpairs.c`, twin `drv/tools/pairs-model.mjs`)

Per voice the converter keeps: `page` (last LEVEL sent), `shift_v`, the
staged shadow (`src`, `end`, `wrap` — six bytes, valid flag), `start_gen`,
`end_gen`, `since_gen` (the three-IDLE counter). Globally `master_shift`.

| slot command (§3.2) | pairs, in order |
| --- | --- |
| `PCM_START v shift src end wrap` | `LEVEL(v)` if the page changed; then only the staged bytes that differ from the shadow, in the order `SRC_LO SRC_HI END_LO END_HI WRAP_LO WRAP_HI`; then `START(v) := ++start_gen` |
| `PCM_RETARGET v end wrap` | the differing `END_*`/`WRAP_*` bytes; then `RETARGET(v) := ++end_gen` |
| `PCM_VOL v shift` | `LEVEL(v)` (recomputed with the master) |
| `PCM_MASTER shift` | `LEVEL(v)` for every voice of the image whose page changes |

Dropped and counted: nothing. `pcm2`/`pcm3` commands go to their voice; a
command for a voice the image does not have cannot occur (the compiler
refuses it, §4.1), and the converter treats one as a fault (`stats.fault++`)
rather than silently dropping.

`$2B` passes through `q_push` (§3.7); `$2A` is still dropped (the engine owns
the DAC data).

### 2.2 What goes

The octave step (`STEP` pair, `step_of`, `step_rounded`), `PCM_STOP` (a
note-off is a RETARGET), `PCM_LOOP`'s old payload, `dropped_voice`,
`dropped_loop`, `MML_PCM_VOICES`-many segment-plan runs in the slot (§3.2).

### 2.3 The three-IDLE rule, per voice

After a `START(v)` or `RETARGET(v)` pair the converter emits
`idleAfterGen` IDLE pairs (per image: 1 / 1 / 5 — see Progress) before any
staged store FOR THAT VOICE (`since_gen[v] < idleAfterGen`, as today's
`since_start`): the expander reads up to three more pairs in the same block,
and a staged byte overwritten before the edge would be applied by the wrong
generation. Other voices' stores and RAW pairs are not delayed.

A pitch pair (`$A4..$A6` then `$A0..$A2`, or `$AC`/`$A8`) is still written
whole in one grab (the chip-wide frequency latch, driver.md §6.1).

## 3. The sequencer (`drv/68k/mmlispseq.c` ≡ `live/src/drv-player.js`)

### 3.1 The note model

The sequencer no longer models sample playback (no ring, no chunk, no segment
plan, no `pos`/`left`/`tail` advance): the engine owns the pointer. Per voice
it keeps what it needs to send commands: `active`, `blob` (offset, length,
loop points, `src_frames`), `looping`, `shift_v`, and the current loop points
in baked bytes. `MML_PCM_VOICES` = 3 in the struct (`pcm[3]`) — bug 2 is gone
by construction; the score's `pcm-voices` (§4.1) only decides the image and
which channels the compiler accepts.

- NOTE_ON (`PCM_NOTE_ON sample note dur`): the blob is the (sample, note)
  entry; `src = WINDOW + S`; a looping note (`has_loop`) gets `END/WRAP` from
  `pcm_loop_points(S, ls, le)`, a shot gets `END = WINDOW + S + len − 16`,
  `WRAP = SILENCE`. Emits `PCM_START`.
- NOTE_OFF on a looping voice: `PCM_RETARGET` with `END = WINDOW + S + len − 16`,
  `WRAP = SILENCE` (the release tail). On a shot: nothing (it plays to its end).
- `:loop-start` / `:loop-end` as a PARAM_SET or a running curve (PARAM_SWEEP /
  macro through the existing value machine, targets `T_LOOP_START` /
  `T_LOOP_END`): the value is in SOURCE frames; baked bytes =
  `value × len_baked / src_frames` (32-bit, once per change); then
  `pcm_loop_points()` and a `PCM_RETARGET` — at most one a frame a voice, the
  last value wins. Only meaningful on a looping voice; on a shot it is stored
  for the next looping note.
- VEL/VOL/MASTER: as today (`pcm_compose_shift`, `pcm_compose_master`), emitting
  `PCM_VOL` / `PCM_MASTER`; the page fold is the converter's (§1.6).

### 3.2 The slot format, v2

```
[u8 n_writes] [u8 n_pcm] [pcm command × n_pcm]
[u8 n_psg] [val × n_psg] [u8 n_fm0] [{reg,val} × n_fm0] [u8 n_fm1] [{reg,val} × n_fm1]
```

`pcm_chunk` and the per-voice plan runs are gone (`SLOT_SUBS` stays 1).
PCM commands (`PCM_LEN = {0, 9, 0, 3, 6, 2}`; `src/end/wrap` are window
addresses the sequencer computed):

| op | name | payload |
| --- | --- | --- |
| 0x01 | `PCM_START` | voice u8, shift u8 (8 = mute), src u16, end u16, wrap u16 — 9 B |
| 0x03 | `PCM_VOL` | voice u8, shift u8 — 3 B |
| 0x04 | `PCM_RETARGET` | voice u8, end u16, wrap u16 — 6 B |
| 0x05 | `PCM_MASTER` | shift u8 — 2 B |

`live/src/slot-builder.js` (`PCM_VOICES`, `decodeSlot`), `mmlispseq.c`
(`encode_slot`, `pcm_emit`), `mmlpairs.c` (`slot_body`) and the c-gate move
together.

### 3.3 `pcm_loop_points()` — one function, two languages

The rounding contract of §1.5, in `mmlispseq.c` and in `live/src/pcm-model.js`
(§6.1), gated by the c-gate through drv-player. The exporter never rounds:
the bank carries the sample's own loop points in baked bytes, unrounded.

### 3.4 The PCM lead and the one-slot hold

Today PCM tracks run one frame ahead and the converter holds their commands
one slot — a net zero that dates from the ring. Both go: PCM commands are
emitted in the frame they belong to and converted with it. The
`m3-pcm-sync` SYNC row (PCM onset vs fm1 key-on, −2..+5 ms) is the gate that
says the timing did not move.

### 3.5 Rates

`mml_rate.h` no longer carries `MML_SPG_NUM/DEN`, `MML_PCM_RING_TARGET`,
`MML_PCM_MULT_FRAME`; it carries the image table (§1.9). The sequencer needs
no rate at all (it computes no increment); the loader checks the bank's stamp
against the image's `rate_hz` (§4.2, bug 3).

### 3.6 fm6 (D6, bug 1)

A score with `pcm-voices > 0` owns fm6 as the DAC for the whole song: the
sequencer emits `$2B = $80` as the first port-0 write of frame 0 and never
`$2B = 0`. A score without PCM never writes `$2B`: fm6 is FM. The engine's
own `$2A` writes with the DAC off are inert.

### 3.7 `q_push`

Drops `$2A` only. `$2B` is the sequencer's (§3.6).

## 4. The exporter and the language

### 4.1 `(def pcm-voices N)` and the diagnostics

- `(def pcm-voices N)`, N ∈ 1..3, a reserved metadata def beside `title` /
  `author` (mmlisp2ir.js `collectDefs`, the `fileMeta` gate accepts an integer
  for this name). Absent: N = the highest `pcmN` channel the score uses, 0 if
  none. A `pcmM` track with M > N is `E_PCM_VOICES` (error). Emitted as
  `metadata.pcmVoices`.
- D5: `:pitch`, `:semi`, `(glide …)`, `(macro :pitch …)`, vibrato — any pitch
  parameter or macro on a pcm track — is `E_PCM_NO_PITCH` (error), instead of
  being silently dropped. `W_PCM_PITCH_CLAMP` and the C2–C6 clamp go: every
  note is baked, the bank is the only limit.
- `:loop-start` / `:loop-end` on a track: a number (`PARAM_SET`), a curve or a
  `(macro …)` (the value machine, as any other parameter). New targets
  `LOOP_START` / `LOOP_END` in ir.md / opcodes.md / mmb.js `TARGET_ID`. In
  source frames of the sample, relative to the slice, as the def keys are.
- D6: an `fm6` track in a score with `pcm-voices > 0` is `E_FM6_DAC` (error).
- D7: `:bit-depth`, `:volume`, `:compress`, `:reverb` are
  `W_SAMPLE_KEY_UNIMPLEMENTED` (warning) until implemented.
- The MMB header flags word: bits 2–3 = `pcm-voices` (0..3). `VERSION_MINOR`
  → 3 (the bank entry changed, §4.2).

### 4.2 The sample bank, v0.3

- Baked at the IMAGE'S rate: `to = R(N) / 2^((note − 60) / 12)` with `R(N)`
  from `live/src/engine-images.js` (§1.9), one blob per (sample, note),
  deduplicated as today. `PCM_BAKE_RATE_REF`, `PCM_SAMPLES_PER_GATE`,
  `PCM_FM_*`, `PCM_MULT_FRAME`, `pcmBakeRate(note)` go; `pcmBakeRate(note, N)`
  replaces it.
- Every blob is padded with silence to a multiple of 16 bytes (§1.5).
- A looping sample is NOT unrolled (`bakeLooped`'s repeats and
  `MIN_BAKED_LOOP` go): the blob is the whole sample resampled, and the entry's
  loop points are the def's `:loop-start`/`:loop-end` mapped through the same
  ratio, unrounded.
- Entry, 24 bytes: `id u8, flags u8 (bit0 has_loop; bits 1–7 zero), offset u32,
  length u32 (baked, padded), src_frames u32 (the slice's frame count),
  loop_start u32, loop_end u32` (baked bytes, unrounded). `base_rate` and the
  bake-shift bits go.
- Directory: `entry_count u16, bake_stamp u16` where `bake_stamp = round(R(N))`
  — the loader refuses a bank whose stamp is not its image's (bug 3 closed by
  construction).
- The bank is still 32 KB, top page silence, `E_MMB_BANK_FULL` (a diagnostic,
  not a `RangeError`) when the blobs reach `$7F00`.
- `LUT_TABLE` (section 0x0008) is no longer emitted (no reader).

### 4.3 The browser's compile path

`live/index.html` `pcmSampleBlobsForMmb` passes `srcFrames` and the loop
points are the IR's (as today). The exporter needs `pcmVoices` from the IR
metadata to pick `R(N)`.

## 5. The SGDK host (`drv/sgdk/`)

### 5.1 Images

`mmlispdrv_bin.h` carries three `mmlispdrv_bin_pcmN[]` arrays and the table of
§1.9; `MMLisp_init(const u8* mmb)` reads `pcm-voices` from the MMB header and
uploads that image (a score with none uses `pcm1` — the engine is the FM/PSG
writer too). `MMLisp_readStats` reports the image.

### 5.2 Init

As today minus the control-block writes; `READY` polled under a grab.

### 5.3 The pump — VSync only

One grab a frame from the VBlank callback, SIXTEEN pairs a grab (two
`GrabBlock`s, eight `movep.l`; `MMLISPDRV_PAIRS_PER_GRAB 16`): 960 pairs/s,
today's wire. `MMLP_AHEAD_ONE` (48) is the head distance. The grab is about
twice today's — ~2,400 master ≈ 45 µs — inside the ear's verdict. The HBlank
pump, `MMLisp_hint`, `MMLisp_setPumpsPerFrame`, `MMLisp_attachInterrupts`'s
HInt half and the `onePump` branches go; `MMLisp_attachVBlankOnly` becomes
`MMLisp_attachInterrupts`. SGDK's own halts (`JOY_update`, `DMA_flushQueue`)
are still not repaid — the README's table stays, reworded: they now cost
pitch, not phase.

### 5.4 Copy list

After the change, the files an SGDK project copies: `mmlispdrv.c`,
`mmlispdrv.h`, `mmlispdrv_bin.h`, `mmlispseq.c`, `mmlispseq.h`, `mmlpairs.c`,
`mmlpairs.h`, `mml_rate.h`, `tables.c`, `res/song.res` (their `main.c` is
their own; the `BIN song_smp` line stays).

## 6. The browser (D0: it must sound like the driver)

### 6.1 One PCM model, three consumers — `live/src/pcm-model.js`

A JS module with no DOM and no audio dependency:

- `pcmLoopPoints(S, ls, le)` — §1.5's rounding, the twin of the C.
- `class PcmEngineModel({ voices, rateHz, bank })` — the engine as a state
  machine: per voice pointer/END/WRAP/page, `start(v, src, end, wrap, page)`,
  `retarget(v, end, wrap)`, `level(v, page)` applied at the next block edge,
  `next()` → one 8-bit biased DAC byte: each voice's byte through its rung,
  the sum saturated in the clamp's order, exactly `mixRungs` (lut.mjs).

Consumers: (a) `drv-player.js` — `_pcmFrame` becomes "`R/60` samples from the
model this frame, each `$2A` byte stamped at its own instant" (the ring, the
chunk, `PCM_RING_*`, the plan all go); it is the c-gate's twin of the C. (b)
the engine gates' VALUE reference (§7). (c) the worklet (§6.2).

### 6.2 The IR playback path

`ir-player.js` sends `pcm-note-on {voice, src, end, wrap, page}` computed with
`pcmLoopPoints` from the baked bank (the editor already builds it for export;
`syncPcmSamplesToWorklet` sends the bank bytes instead of float samples), and
`pcm-retarget` / `pcm-level`. The worklet drives a `PcmEngineModel` at `R(N)`
and holds each of its bytes for `nativeRate / R(N)` native samples in
`getDacByte` — 8-bit, at the engine's rate, with the engine's levels and
block quantisation. The float mixer, `shiftToGain`, the 53 kHz voices go.
The MMLispDRV backend keeps working unchanged (it replays drv-player's own
`$2A` stream). Per-track PCM faders in the editor apply before the rung (a
UI-only gain, documented as such).

## 7. Gates — value and time, per image

`verify:all` = `mirrors && selftest && c-gate && pairs-gate && sgdk:lint &&
engine:gate && engine:score && verify:ab`.

- `engine:gate` (new, `tools/engine-gate.mjs`, from gate-nv + engine-fifo-gate):
  for each image, in the JS machine: TIME (every interval = its slot's length;
  no holes), VALUE (every DAC byte = the model's, §6.1), WRITES (the chip's
  settling table), the expander (RAW/PORT/STORE, page wrap, pitch pairs, CSM
  traffic). Cases: shots on every voice, a loop that wraps (start ≠ 0), a
  retarget mid-loop (both directions), a release to the tail, a retarget and
  a start in one block, level walks incl. mute and master folds, full-scale
  clipping at 2 and 3 voices, a drum roll, restarts. Negatives it must fail
  on: a mis-costed instruction (TIME), a wrapping reference (VALUE), a staged
  store inside the three-IDLE window (VALUE).
- `engine:score`: real scores through each image with the JS host model:
  VALUE + TIME + WRITES + PSG + SYNC. New scores: `m4-pcm-loop` (loop, release),
  `m4-pcm-loop-curve` (`:loop-start` curve), `m4-pcm-3v`, `m4-pcm-2v-master`,
  `m4-fm6-only` (no PCM: fm6 FM, `$2B` never written), `m3-pcm-sync` kept.
- `c-gate` (C ≡ drv-player on the v2 slot format), `pairs-gate` (converter ≡
  twin on the new ops), `mirrors` (three images in C, header and JS agree),
  `selftest`, `sgdk:lint`, `verify:ab` (FM/PSG only, unchanged).
- `sgdk:gate` on BlastEm per image (not in `verify:all`; run before a hand-off).
- Removed: `engine:1v`, `engine:fifo`, `engine:1v:split`, `engine:fifo:split`;
  the bench's protocol/corrector/observer cases and machine-probe; the
  `machine-probe`/`decoder-eval` scripts (they test what the image no longer
  has). `voice-study`, `gate-nv`, `light-study`, `stop-listen` stay as
  research.

## 8. The order of work

Each step is one session, leaves `verify:all` green, and syncs the docs it
touches (present-only, driver.md rewritten in place). The shipped image
changes at S2, not before.

- **S1 — the engine.** gen-stream/config: the `loops` profile becomes the
  production profile (`buildEngine(voices)` in `tools/build-engine.mjs`, three
  images, the header of §1.9, `emit-bin` writes them and the JS mirror);
  `engine-gate.mjs` on the model of §6.1 (write `pcm-model.js` here, it has
  no other dependency). The old image and gates keep running until S2.
  Files: `drv/engine/config.mjs, gen-stream.mjs, lut.mjs`, `drv/tools/build-engine.mjs,
  emit-bin.mjs, engine-gate.mjs, gen-c-tables.mjs, rate-mirrors.mjs`,
  `live/src/pcm-model.js`, `live/src/engine-images.js` (generated).
- **S2 — the sequencer, the converter, the bank.** Slot format v2 and the
  commands of §3.2; `mmlispseq.c`/`.h` (three voices, the note model of §3.1,
  `pcm_loop_points`, `$2B`, the lead removed); `drv-player.js` on the model;
  `slot-builder.js`; `mmlpairs.c`/`.h` and `pairs-model.mjs` (§2);
  `export-mmb.js`/`mmb.js` bank v0.3 (§4.2) and header flag; `mmb-build.mjs`;
  `engine-score-gate` on the three images; the old image, `engine-1v-gate`,
  `engine-fifo-gate` deleted; `verify:all` rewired. Docs: driver.md §5, §6,
  §14; mmb.md §4, §10; opcodes.md §6.
- **S3 — the language.** `pcm-voices`, `E_PCM_VOICES`, `E_PCM_NO_PITCH`,
  `E_FM6_DAC`, `W_SAMPLE_KEY_UNIMPLEMENTED`, the loop targets and their value
  machine path, `W_PCM_PITCH_CLAMP` removed; ir.md, language.md §9/§16/§17,
  guide.md; the formatter/importer if they know the keys; test scores of §7.
- **S4 — the SGDK host.** §5; `sgdk-gate` per image on BlastEm; `sgdk/README.md`
  and the copy list.
- **S5 — the browser.** §6.2; `live/index.html` plumbing; the editor's PCM
  faders; docs/guide.md.
- **S6 — cleanup.** `decode-split.mjs`, `corrector.mjs`, `observer.mjs`,
  `protocol.mjs`, `phase-table.json`, the bench's protocol/corrector cases,
  `machine-probe`, `decoder-eval`, `PCM_RING_*` and the `PCM_SPG`/`PCM_FM`
  knobs, `LUT_TABLE`; driver.md/README/roadmap present-only; delete this file
  and fold plan-pcm-spec.md down to what is still open (SE, D7 keys).

## 9. Open points and risks

- **100% work ceiling on real silicon**: the window wait is a BlastEm number.
  First hardware run decides whether the images keep the edge or take a few
  percent of margin (a config constant; the study prints the ladder).
- **Bank capacity** is the real limit at `pcm1` (2.3 s of samples a song).
  DECIDED (user, 2026-09-17): stay with one 32 KB bank a song. How others do
  it, for the record: XGM2's Z80 writes the bank register itself per chunk
  (97–105 cycles a switch, amortised over 4 samples a channel through its
  ring) and offers 4-bit ADPCM. The step to take later, if ever: on the
  one-voice image the START piece writes the bank (constant time, ~100
  cycles; a blob must not cross a 32 KB boundary) — any ROM address, pcm1
  only, about 14.4 → ~12 kHz. Two/three voices read different banks a sample
  and would need a per-block copy into RAM (~25 cyc/sample/voice). Not in
  this design.
- **Latency**: a note reaches the DAC at most one frame (pump) + one lap
  (expander) + one block after its frame; the SYNC gate measures it.
- **PAL**: unsupported, as before.
- **`pcm3` at 6.65 kHz** (Nyquist 3.3 kHz) is dull; it is the composer's
  choice per score, and the study's `pcm3` row is the honest price.
