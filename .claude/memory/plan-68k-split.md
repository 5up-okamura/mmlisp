# Architecture pivot: 68k sequencer + Z80 PCM engine (decided 2026-08-02)

**The design now lives in `docs/driver.md`** (rewritten 2026-08-02: §1.1 the
measurement, §4 the 68k frame, §5 the Z80 engine, §6 the ring/slot interface,
§11 the port milestones, §12 the gates). `drv/README.md` carries a banner
superseding its "68k offload is the last resort" position.

This file keeps only what the docs do not: the decision record, and the port's
running state.

## Why (the measurement that settled it)

Z80 frame = 59,659 cycles. The all-Z80 PCM soft-mix measured **~240 cyc per
voice per mix tick + ~260 fixed per tick**; 3 voices × 175 ticks = 170k = 285%
of budget. Rewritten to the theoretical floor for the same semantics (16.16
resampling + per-voice volume + i16 sum), ~110/voice + ~120 fixed →

- 2 voices × 175 ticks = **59,500 = 99.7% of the frame, sequencer executing
  zero instructions**.

The sequencer is not the reason — its median is 19.7k (33%). The two workloads
do not fit in one Z80. The old position was argued on *bytes* and the overlay
pass solved that; the binding constraint is *cycles*.

## Decisions (all 2026-08-02)

1. **Split (option C).** 68k sequences; Z80 = PCM mixer + chip-write engine.
2. **The Z80 keeps the clock.** 68k pre-renders per-frame write lists into a
   ring in Z80 RAM; the Z80 consumes one per its own vblank. Tempo stays
   60 Hz-exact and a heavy game frame is absorbed by the ring — the property
   that motivated the all-Z80 design, preserved.
3. **SE moves to the 68k.** Keeps the Z80 a pure engine; costs SE 1–2 frames.
4. **PCM voice count fixed at 3.** Lets the mixer be fully specialised.
5. **No compile-time pre-resampling** ("option B" dropped) — per-note PCM pitch
   and dynamic loop points are worth more than the cycles. **Re-examined after
   P0 and upheld**: the resampler measured ~37 cyc/voice/tick (29% of the mixer,
   not the 11% assumed) and removing it would lift the 3-voice ceiling from
   10.9 kHz to 17.2 — but the chosen configuration fits without it.
6. **Ring depth default 2, a per-game knob.** Deep lookahead and continuous
   live control are mutually exclusive (driver.md §3.4). Escape hatch if 2
   proves too shallow: indirect write-list entries ("write reg X from slot S"),
   deliberately deferred — it puts resolution logic back on the Z80.
7. ~~16-bit mix buffer~~ → **SUPERSEDED by P0 measurement. 8-bit
   saturating-add, 3 voices, `PCM_MIX_R` = 175 (10.5 kHz), unroll 2**
   (2026-08-02). 89% of the frame, 95 chip writes left. i16 sum-then-saturate
   could not hold 10.5 kHz at 3 voices (113%) and its knee was 8.6 kHz. The
   deciding argument was asymmetry of cost: i8sat is **bit-identical to i16
   below 3 simultaneous voices** and its divergence above that is avoidable by
   backing off `:vol`, whereas the mix rate is paid on every sample of every
   score. **The rate stays a knob to raise** (ceiling 10.9 kHz at unroll 2,
   11.3 at unroll 4) if a real score and hardware leave room — raising it
   re-freezes every gate baseline, so it needs a measured reason.
8. **Change-only suppression moves to the 68k.** It holds the shadow and emits
   only changed registers, so the Z80's shadow file, valid plane and the ~550
   cyc/write of bookkeeping all disappear.
9. **Writes are appended in dispatch order, not coalesced full-frame.** Keeps
   the slot's per-port write sequence byte-identical to `drv-player.js`, so the
   zero-tolerance gate survives. Full-frame coalescing saves ~1% of writes and
   costs that gate — not worth it unless a write-cap squeeze forces it.
10. **Per-slot write cap with 68k-side spill** (default 64 writes). Bound is
    *cycles*, not bytes: the Z80 frame is shared with the mixer. Excess writes
    keep their order and prepend to the next slot — never dropped, never
    reordered. `drv-player.js` models the same cap/spill so the gate stays at
    zero tolerance.
11. **Implementation order: Z80 mixer first** (chosen 2026-08-02). The §5.3
    cost estimate is load-bearing for the whole architecture, and the prototype
    that tests it is small — so it goes before anything is built on top of it.

## Port state

- **Docs rewritten — DONE 2026-08-02** (`docs/driver.md`, `drv/README.md`,
  roadmap, README, CLAUDE.md, mmb.md §12, sgdk/README).
- **P0 mixer prototype — DONE 2026-08-02.** `drv/tools/gen-mixer.mjs`
  (generates `src/mixer.z80`) + `drv/tools/mixer-bench.mjs` (`npm run mixer`);
  every configuration verified against a JS model of the mix, so cost and
  correctness gate together. Full table in driver.md §5.3.1.
  **The estimate was ~50% optimistic** — 301 predicted vs **449** measured at
  3 voices, i16, R = 175; optimization took it to **384**, still 113%.
  - **3 voices at 10.5 kHz does not fit with sum-then-saturate.** The knee for
    those semantics is ~8.6 kHz (R = 144, 91%, 83 FM writes).
  - **It DOES fit with an 8-bit saturating-add buffer** — 305 cyc/tick, 89%,
    95 writes at R = 175, ceiling **10.9 kHz**. `add a,(hl)` sets P/V on signed
    overflow, so the common path is one not-taken `jp pe` (10) against the i16
    high plane's ~26. Costs: clips earlier and is order-dependent — but it is
    **bit-identical to i16 at 1 and 2 voices** (one add = one saturation point
    either way), so the cost exists only at 3 simultaneous voices, measures 5.1%
    of samples on worst-case full-scale noise, and disappears under any `:vol`
    below unity.
  - Mix-rate ceilings at 3 voices (60 writes/frame reserved): i16 **8.6 kHz**,
    i8sat **10.9**, i16 pre-resampled **12.2**, i8sat pre-resampled **17.2**.
  - **i8 headroom is dominated and is out** — slower than saturating-add (the
    per-voice `ceil(log2 N)` attenuation is extra `sra`s in the hot loop) *and*
    worse (the headroom tracks the active voice count, so a sustained voice
    jumps 12 dB when another starts — pumping).
  - **2 voices fit at 10.5 kHz in every variant** (79%, 197 writes).
  - Z80 techniques worth not rediscovering: accumulate **biased-unsigned**
    (`sample ^ $80`) — then the i16 sum needs no sign extension anywhere, the
    high plane only ever takes a carry, and the output pass subtracts 128*(N−1).
    Two page-aligned planes let one 8-bit index address both (`inc h`/`dec h`).
    The 16.16 advance is one 32-bit add split across the register sets, because
    **`exx` is flag-transparent** so the frac carry chains into the pointer add
    — but `exx` swaps BC too, so load the increment into C *after* it. Shift
    specialisation (8 loop copies) removes a 12-cycle per-tick dispatch `jr`;
    unroll 2 is the size/speed knee (`djnz` can't reach across an unrolled body).
  - Numbers are a **floor** — no bank-window wait states in the emulator, and
    the sample fetch is the most exposed instruction.
- **Configuration SETTLED 2026-08-02** — see decision 7. `SLOT_MAX_WRITES`
  therefore starts at **95** (what the mixer leaves at R = 175).
- **P1 interface — Z80 HALF DONE 2026-08-02.** `drv/src/engine.z80` (2560 B,
  ends $9FB, under MIXLO $1000): boot, vblank ISR, ring consume (PSG/FM0/FM1
  length-prefixed runs), PCM commands, published header at $1300, and the
  segment-split per-voice driver. `npm run engine` gates it — 7 scenarios, chip
  writes byte-exact vs the slot AND the DAC stream vs a JS model.
  Gotchas worth not rediscovering:
  - `ld (nn),bc` stores C first, so reading back a tick count stored that way
    gets the wrong register.
  - The gate harness must run the CPU to its idle `halt` *before* the first
    interrupt, or every frame's slot is serviced one frame late.
  - The forced one-tick segment (when `avail >> ksh` rounds to 0) can consume
    more than `LEFT`, so the countdown needs a clamp at 0 — otherwise it wraps
    and the voice runs off the end of the sample.
  - Distances (countdowns), not absolute end addresses, are what make ROM bank
    crossing free: the pointer wraps at the window top, the bank steps, the
    countdown is untouched.
  **Slot builder DONE too** — `live/src/slot-builder.js` (its own module: the
  wire format and cap/spill are spec, not either player's business) plus
  `DrvPlayer.captureSlotLog`. `npm run slots` runs a real score end to end and
  asserts the chips receive exactly the sequencer's writes, in order, and that
  the transport only ever DELAYS one. Corpus behaviour: the 95-write cap binds
  only at a score's head (2 frames held back, ≤2 frames late) and never in
  steady state, on scores from 395 to 1801 writes — i.e. the armed-frame burst
  driver.md §4.2 predicted, and nothing else.

  **PCM DONE too (2026-08-02).** `drv-player._pcmFrame` re-based onto the
  engine's structure (voice-outer plane, 8-bit saturating-add, `LEFT` countdown
  checked after the advance); `MUTE_SHIFT = 8` added to the generated mixer for
  `:vol 0`; PCM_START/STOP/VOL emitted from the sequencer side with every field
  resolved there. `npm run slots` compares the DAC stream sample for sample
  across the PCM corpus (52,685 writes on m3-pcm-softmix, all matching).

  **The bug worth remembering:** `pc_stop` computed `left += tail` in HL — which
  is the *command cursor*. A STOP alone was fine, so four gate scenarios missed
  it; a real score retriggers a looped note with STOP+START in ONE slot, and
  everything after the STOP was then read from garbage. Rule: **every PCM
  handler must return HL untouched.** Gate scenario "STOP and START in the same
  slot" now covers it.

  **$2A/$2B ownership.** Both are the engine's and never enter a slot. The
  sequencer *could* predict the `$2B` edges (it knows when a shot ends) but then
  both sides would have to agree on the exact frame — a coupling worth avoiding
  when voice activity is the one piece of state the Z80 already owns. The
  neutral patch still writes them for ir-player parity (removing them cost
  ab-core its 0-diff property, which is worth more), and `DrvPlayer._pcmLog`
  records mixer-produced DAC traffic separately so the gate compares like with
  like.

  **The all-Z80 trace gate is retired** (`legacy:verify*`, no longer passing):
  drv-player now specifies the post-split architecture and the old driver
  implements neither its PCM semantics nor its DAC ownership. `verify:all` is
  now selftest + the P0/P1 gates + the ir↔drv A/B. ab-baseline re-frozen: still
  **18 clean of 40**, with the PCM scores' signatures changed by design.
- **P2 sequencer — M1 + M2 + M3 DONE 2026-08-03.** `drv/68k/{mmlispseq.h,
  mmlispseq.c, gate_main.c}` + generated `tables.c`; gate `npm run c-gate`
  (tools/c-gate.mjs). **38 scores byte-identical, 0 PEND** (was 12 at M2).
  - M2 covers the sweep engine (PARAM_SWEEP/_STOP, 2 slots/channel, the 8
    integer curves), PARAM_ADD + read_param, TEMPO_SWEEP, cent pitch, CSM
    (ON/OFF/RATE const+swept), and the §6.5 host API (key_off / set_param /
    fade_track's Bresenham ramp / set_val), the last gated with a real
    host-command schedule (`m2-mailbox`) — c-gate grew sidecar `.cmds.json`
    support for that.
  - M3 covers the macro engine (sticky binds, note-on re-instantiation,
    attack/sustain/release, NOTE_SEMI, NOTE_PITCH override+additive, scaled
    macros, KEYON retrigger), the value machine's stream ops (PARAM_MUL /
    _FROM_VAL / _ADD_VAL / _MUL_VAL), FM3_MODE + FM3_OP_PITCH with the
    per-operator key path, and PCM_NOTE_ON/_OFF + §6.3 command emission.
  - **Both M2 and M3 went in with zero gate failures on the first run**, which
    says the M1 groundwork (shadow validity, write paths, frame order) really
    was the hard part — and that porting from a *validated implementation*
    rather than prose is what makes this cheap.
  Things the C needs that the JS gets for free, all found BY the gate:
  - **a shadow-validity plane** — drv-player keys its shadow with a Map so an
    unwritten register never compares equal; a zero-initialised C array
    suppresses the neutral patch's many writes of 0. (The Z80 dodged this by
    writing every covered register at boot, which is why it could drop its own
    plane.)
  - **VOICE_SET compares against the STRUCTURED shadow**, not the register
    shadow: the burst it replaced only wrote registers a PARAM_SET touched, so
    e.g. $90/SSG must stay unwritten when the voice omits it.
  - **the drain must not render.** `gate_main` closes slots until the spill
    queue empties; those must be *encode-only* (`mml_drain_frame`). Running a
    frame there invents traffic (a sweep step, a retiring PCM voice) the
    reference — which only calls `endFrame` — never produces.
  M3 design notes worth not rediscovering:
  - **The 68k shadows each PCM voice's POSITION** (3 × 175 add/compare per
    frame), never a sample byte. Not for the audio — for its own decisions: a
    PCM_VOL for a dead voice is wasted slot bytes, and PCM_NOTE_OFF on a
    finished shot must emit nothing. A closed form exists for the non-looping
    case if a cycle count ever asks.
  - **The slot's byte budget can bind before its write cap** once PCM commands
    are in play (3 PCM_STARTs = 54 B), and PSG writes cost 1 byte while FM cost
    2 — so the "longest prefix that fits" test has to count real costs, not
    `take * 2`.
  - The sample bank is a **separate ROM bank, not an MMB section**, so
    `mml_load_samples` is a separate call and c-gate passes it as `--samples`.
    Only the 20-byte entry table is the sequencer's business.
  - Macro binds are an **ordered** map: replacing a target's macro keeps its
    original position (JS Map semantics), and that order is the step order.
  **Remaining for P2: SE** (plan-se.md) — track lifecycle / START_SE /
  suspend-restore / priority. Its gate scores (`m3-se`, `m3-se-prio`) carry a
  richer sidecar (`autoStart: false` + `remapChannels`) and c-gate reports them
  SKIP rather than crashing.
- **P3 integration — the GLUE landed 2026-08-03; hardware has not.**
  `drv/sgdk/{mmlispdrv.c,mmlispdrv.h}` rewritten for the split, plus
  `example/{main.c,song.res}`, `install-sgdk.mjs`, and a new build path.
  - **Build:** `tools/build-engine.mjs` (gen-mixer + assemble `src/engine.z80`)
    → `tools/emit-bin.mjs` emits `sgdk/mmlispdrv.bin` + `mmlispdrv_bin.h`
    (**2,668 B, 1,428 B free below MIXLO**). `mmlispdrv_ovl.bin` and
    `_ovl_bin.h` DELETED. `build-driver.mjs` still builds the all-Z80 driver;
    nothing ships from it.
  - **Core additions:** `mml_start_track` / `mml_stop_track` (ported from
    drv-player `_startTrack(false)` / `_mailboxStop`, SE branches omitted so
    they drop in later), `mml_mmb_size`, `mml_pump`, `mml_drain_frame`,
    `MMLTrack.event_offset`. `mml_command` now routes 0x01/0x02.
  - **Header grew** (PROTO_VER 3 → **4**): `H_DEPTH`, `H_SLOTSH`, `H_RING`.
    Decision on open item 1 — the Z80 publishes the ring's geometry and the 68k
    reads it, so `MMLISPDRV_HDR` is the host's ONLY compile-time Z80 constant.
    A depth mismatch fails silently, so exactly one side owns it.
  - **Decision on open item 2:** policy (`mml_pump`) in the sequencer where a
    gate reaches it, mechanism (bus grab + copy) in the glue where none can.
    That is what keeps the untestable part ~10 lines.
  - **New gates:** `npm run ring` (tools/ring-gate.mjs — plain vs pumped byte
    streams identical at depths 2/3/4/8, every 7th host frame skipped to model
    an overrun, and gate_main asserts §6.6 self-limiting inside the loop) and
    `npm run sgdk:lint` (tools/sgdk-lint.mjs + tools/sgdk-shim/ — compiles the
    glue AND example/main.c against the real mmlispseq.h). Both in `verify:all`.
    New c-gate score `p3-lifecycle` (39 total) covers start/stop + eviction.
  - Traps found while writing it, worth not rediscovering:
    - `head == tail` is EMPTY, so a depth-N ring holds **N-1** slots — which is
      exactly §3.4's "at depth N the game may overrun N-1 frames". Consistent,
      but easy to misread as N.
    - `mml_load` memsets everything, so a `setSampleBank` before `loadScore`
      would be silently wiped. The glue remembers the pointer and re-applies it
      on every load rather than documenting an order.
    - Host-compiling 68k code needs `-Wno-pointer-to-int-cast
      -Wno-int-to-pointer-cast` (pointers are 64-bit here, 32 on m68k) and, for
      the example, `-Dmain=sgdk_main -Wno-unused-parameter` (SGDK's entry point
      is `int main(bool hardReset)`, which a hosted compiler rejects outright).
  - **Integration consequences:** the score no longer needs 32 KB alignment
    (only `song.smp` still rides the Z80 window), and the 7-starts-per-frame
    mailbox ceiling is gone.
  - **FIRST REAL SGDK BUILD 2026-08-03** — SGDK 2.x + m68k-elf-gcc 13.2.0,
    clean compile + link to a 256 KB ROM at `~/build/verify-hello-world`.
    **Not run yet** (hardware/emulator behaviour still establishes nothing).
    It exposed three things the host gate could not see, all now fixed AND
    covered by `sgdk:lint` (which gained `-DSGDK_GCC` + a faithful shim; the
    old tidy shim had hidden every one of them):
    - **SGDK's `types.h` `#define`s `uint8_t`/`int8_t`/`size_t`/`ptrdiff_t` as
      MACROS**, so `<stdint.h>` after `<genesis.h>` is a hard error.
      `mmlispseq.h` now takes SGDK's types under `SGDK_GCC`.
    - **SGDK's `s8` is `char`**, not `signed char` — implementation-defined
      signedness that every i8 value here rides on. Compile-time assertion added.
    - **SGDK's `<string.h>` is not standalone-includable** (prototypes typed with
      u16/s8, assumes types.h first) and has NO memcpy/memset (those are
      `<memory.h>`, different signature). mmlispseq.c now uses zero libc —
      `mml_zero` / `mml_copy` — which also makes good on its header comment.
    - **GNU Make 3.81 (Apple's) fails SILENTLY** — `make: *** [release] Error 2`
      and nothing else — during `-include $(DEPS)` when `out/<build>/res/song.o`
      is stale or missing, because the .d rules list it as a prerequisite and
      errors in that phase are suppressed. Bites once, on any project whose
      `out/` predates a `song.res` change (i.e. every pre-split migration).
      `rm -rf out res/song.h` fixes it; `make CLEAN=TRUE <target>` shows the
      real error. Not our bug, but it costs an hour if you do not know it.

## P3 entry — what is decided, and what has to be decided first

**Decided 2026-08-03: the per-frame hook.** `MMLisp_frame()`, called once per
vblank by the host; the driver does NOT register with SGDK's vblank callback.
The call **tops up the ring** rather than rendering one slot, so lookahead is an
invariant it maintains, not the host's job — and it is self-limiting, so being
called twice in a frame is harmless. Bus grabbed once per call, not per slot.
Control calls go BEFORE the render call in the host's frame. No
`MMLisp_autoVBlank()` convenience — it would be a second path the host gate
cannot reach. Full rationale in driver.md §6.6; the load-bearing part is that
explicit calling is safe *because the Z80 owns the clock*, so render jitter
lands in the ring's fill level and never in the tempo.

**Still to decide, roughly in the order P3 needs them:**

~~1. How the ring depth is shared.~~ **DONE** — published in the header.
~~2. Who owns the transport.~~ **DONE** — policy in the core, mechanism in the glue.
~~3. Per-track start/stop.~~ **DONE** — `mml_start_track` / `mml_stop_track`.

4. **`(trig N)` delivery — the biggest undesigned piece.** Markers are rendered
   AHEAD by the ring depth, so handing them straight to game code would fire
   them early. §6.4 says compare against the Z80's consumed-frame counter, but
   there is no API: the natural shape is a small queue of (marker, rendered
   frame) that `MMLisp_frame()` releases as the counter catches up. The C keeps
   `marker_id` per track today and never surfaces it.
5. **Multiple scores loaded at once.** §2.3's DJ transitions became free with the
   split, but `mml_load` fills one `MMLSeq`. Two sequencers would duplicate the
   shadow and the slot queue; one sequencer with a per-track score pointer is
   what §4.3 already describes.
6. **SE port** ([[plan-se]]). The model (priority, suspend/restore, snapshots)
   should carry over unchanged — SE moved to the 68k in decision 3, so the
   ring-latency cost is already accepted. `m3-se` / `m3-se-prio` are SKIP in
   c-gate today.
7. **PAL** (§3.3) — the correction is now one multiply; undecided whether it
   scales at load or at each TEMPO_SET. Needs a PAL target to settle.
8. **Raising the mix rate** (10.5 → up to 10.9/11.3 kHz, §5.3.1) — deliberately
   parked until hardware measurement gives a reason.

## The DAC feed was BURST, not paced — FIXED 2026-08-03

**Measured three ways and confirmed on a real BlastEm VGM log of the reporter's
own ROM.** `out_pass` in the generated mixer dumps all 175 samples in one tight
`djnz` loop:

- emulator: span 7,134 cyc = 1,993 us = **12% of the frame**, gap 41 cyc,
  effective **87 kHz** against an intended 10.5, then 6 ms holding one value.
- BlastEm VGM: 175 writes in **94 of 735 samples = 13% of the frame**, every
  frame, 3,788 frames of it.

So every PCM sample plays ~8x too fast in a 2 ms burst, 60 times a second. This
is the "sub-frame feed timing is a hardware bring-up item" note in mmb.js and
driver.md coming due. **The gates cannot see it**: they compare sample VALUES,
never their timing — which is why it survived every zero-tolerance gate and cost
three bring-up rounds.

**FIXED 2026-08-03 — see "the fix, as built" below.** What follows is the
diagnosis, kept because the numbers are the reason the fix looks as it does.

**The structural cause is P0's voice-outer decision.** Paced output needs
175 x 341 = 59,675 cyc ~ the whole frame, so output and mixing must overlap; but
voice-outer only finalises a sample after the LAST voice adds to it, so output
can only happen at the end. P0 chose voice-outer on mixing cost alone and never
considered output pacing — that is the actual oversight, not an implementation
slip. Correct pacing needs the emit interleaved into the mix at a small
granularity (re-entering mix_seg with a small B, paying the register-file reload
more often) and padded to a constant tick period. `npm run mixer` is the tool
for pricing it; 10.5 kHz may have to come down.

**Everything else about the timing is exact**, so this is the only bug left:

- engine frame period from the VGM: mean **735.32 samples = 59.974 Hz**, i.e.
  every interrupt taken.
- ring starvation: **1 single-frame hole in 3,834 DAC-active frames**.
- note onsets land on exact frame multiples (inter-onset intervals cluster at
  7.00 / 8.00 / 15.00 frames).

So the reported "tempo wobbles" is NOT the sequencer, the transport or the ring
— it is the burst, heard on a rhythm the PCM carries. One fix, two symptoms.

### The fix, as built (2026-08-03) — DONE, `npm run dac` is in verify:all

The design above survived contact only in part. What shipped:

- **The feed is inside the mix loop**, not between chunks: one `$2A` write at the
  head of every unrolled iteration, IY as the cursor. Chunk granularity was
  dropped because re-entering `mix_seg` costs ~2.4k cycles, not the ~100 the
  estimate assumed (see below) — the register-file reload was never the price of
  a chunk, the SEGMENT was.
- **Unroll 3, three passes, always.** R x 3 tick bodies carry exactly R samples,
  so the cadence is one emit per 3 ticks and needs no counter. An absent or
  finished voice runs a pass through `G_IDLEV` at PV_SHIFT = 9 (IDLE — like MUTE
  but it does not advance a position, 35 cycles a tick cheaper, and those cycles
  are the pad). Order: sounding voices first, silent passes last.
- **Double-buffered plane**, so PCM lags one frame — which the sequencer then
  cancels by promoting PCM tracks in their own armed frame, so they run one
  frame ahead of every other track for the rest of the score (driver.md §4.2).
  Reported the same day it shipped: 16.7 ms drags audibly on a drum part. `drv-player.js` models it;
  `engine-gate.mjs` grew a `ModelFeed` for it. A burst opens with a frame of
  silence and closes with a flush frame that carries the tail, and `$2B` is
  released after that, not before.
- **Pad = baked base − runtime debt.** The base is per (role, shift), computed by
  the generator from its own emitted instructions (it prices them, and throws on
  an instruction it cannot price). The debt is what the frame spends outside the
  loops, in 16-cycle units spread over all R samples.

**The number that dominated everything: the segment costs ~2.4k cycles**, and a
frame runs 5–10 of them — 13k to 18k, a FIFTH of the frame, none of it feeding.
Nothing in the repo had measured this before (the mixer bench is per-tick and
says the segment split "is not modelled"). Consequences:

- The paced stretches have to run ~20% fast to give those cycles back, so the
  feed is right on average and pauses at each segment. Wander is ~3.4 ms against
  the burst's 14.7 ms — better by 4x, not fixed. **Cutting the per-segment cost
  is the only thing that tightens it**, and it is now the top driver item.
- Half the segments were the conservative `avail >> KSH` bound HALVING toward a
  region end (21 ticks, 10, 5, 2, 1 — a segment each). `mvf_exact` walks the tail
  a tick at a time (75 cyc/tick) once the bound collapses below 16, and takes it
  in one segment: 8 segments a frame down to 5.
- The debt is estimated from the last frame's segment count, revised upward
  within the frame as it proves heavier, plus the slot's own write count (a
  patch-dump frame costs 10k cycles more than a steady one). The silent passes
  run last precisely so the biggest pads are spent against a measured count.

Measured, on the three PCM gate scores, 300 frames each: **frame length 94–98%
of budget** (was 49–58% before pacing, because the driver simply idled the rest
away), 2–56 frames over budget out of ~300, **feed spans ~90% of the frame**
(was 12%), 96–100% of frames inside the gate's tolerances.

Known limits, all measured and none new to pacing:

- **TWO loud voices do not fit — not three. Measured 2026-08-06**, and this is
  the sharpest number in this file, so do not restate it from the old estimate:

  | PCM voices sounding | frames | over budget |
  | --- | --- | --- |
  | 1 | 228 | **0** |
  | 2 | 6 | **6** |
  | 3 | 6 | **6** |

  (`m3-pcm-softmix`, 240 frames, `probe`/`seg-bench`.) The correlation is
  total: every frame with a second voice sounding overruns, every single-voice
  frame fits. Attribution on those frames: **+11,198 cycles** against a
  one-voice frame, nearly all of it in the per-tick mix bodies of the added
  voice (`mix_add_s1_lp` +4,414, the unrolled bodies +2,500..2,900 each), while
  the pad had already collapsed by **−14,154** giving back everything it had.
  Pacing neither helps nor hurts here; the frame is simply 19% too long.

  Pre-existing, NOT a sub-tick regression: the same 6/6 and 6/6 at 7f5f102. What
  did change is the single-voice case, 12 over-budget frames -> 0.

  **This is what a periodic tempo wobble on hardware sounds like**, because
  overlapping drum hits are exactly how a score gets two voices at once. Closing
  an 11.2k gap needs more than (b) (2,659): the levers are the score's PCM
  overlap, `PCM_MIX_R`, or a cheaper mixer variant (§5.3.1) — all of which have
  to be measured before being claimed.
- The first frames of a score run 120–145% (patch dump + a cold estimator). One
  off, at the start, before anything is audible.
- The pad quantum is 16 cycles a sample = 2.8k cycles a frame = 4.7%, so the
  frame length can only be tuned in steps that coarse. PACE_RESERVE picks which
  side of the step to land on; it is set to land under.

## Hardware round 2026-08-04 — three symptoms, two causes, both located

Reported after the pacing fix: (1) tempo still wobbles, (2) **pitch-shifted PCM
sounds like a fine LFO / an effect**, (3) **a loud FM blast at every loop point**.

**The decisive test — playing with PCM removed — settled the split**: no PCM, no
tempo wobble; the loop blast reproduces anyway. So (1)+(2) are the mixer, (3) is
its own thing, and they are unrelated. (3) was attributed to VOICE_SET at the
time; that attribution was **wrong** — see §(3).

Doing that test needed `sgdk/example/main.c` unblocked: it halted forever on
`MMLisp_needsSampleBank()`. **Removed 2026-08-04** — it warns in the ready line
and plays with PCM muted. A project's own `main.c` is never overwritten by
`install-sgdk.mjs`, so existing projects must delete their own copy of the
`while (TRUE)`.

### (3) The loop-point blast — SOLVED 2026-08-04 (commit 4494a21)

**It was the ENCODER, not the driver.** `export-mmb.js` restored sticky VEL at
the backward JUMP from a snapshot taken at the target MARKER. A marker at the
top of a track snapshots the encoder's *initial* vel 15, so the restore emitted
`PARAM_SET VEL 15` **while the previous iteration's last note was still
sounding** — and VEL is the one sticky param the driver acts on immediately (it
recomposes carrier TL). Measured on the reporter's score (`sin008.muc`, mucom88
import): **+21.8 dB on fm4/fm5 at the loop point, held 787 frames = 13 s**,
because the loop head starts with a long rest and nothing re-asserts vel until
the body's next note. Confirmed in the stream bytes: `60 06 0f` immediately
before the `43` JUMP.

Fixed by *not* restoring VEL at the JUMP: a backward-JUMP target MARKER
invalidates the encoder's VEL tracking instead, so the body re-asserts its own
velocity where it needs it (docs/opcodes.md §4.1). GATE and macro binds keep the
snapshot-restore — they are silent state, so they cannot disturb a sounding note.
Gate: `m3-loop-vel-hold`. Reproducing needs **all three** of: marker at the top
of the track, a quiet `:vel`, and rests at the loop head — with a note right
after the marker the wrong level lasts under a frame and is invisible.

**How it was found, and the tool that now does it for you**:
`npm run level-diff -- <song.mmlisp>` (drv/tools/level-diff.mjs, docs
driver.md §12.5) — prints every span where the driver plays LOUDER than
ir-player, in dB, with the loop frames alongside. Point it at any score that
blasts; it names the channel, the register and the frame range.

`ab-compare` had been reporting this bug all along as `missing-in-b` on a `$4x`
register mid-body — ir writes a TL the driver never writes. That class reads
like frame-0 seeding noise in a gate summary and is trivially skimmed past,
which is why the tool exists. Two traps it took two wrong versions to learn:
(1) **tile ir's loop** — `captureRegisterLog` captures ONE pass and reports
loopStartSec/endSec, so without re-emitting the body at +P (like export-wav)
every later iteration reads as "driver louder" and the loop point itself falls
outside the comparison; (2) **drop spans < 3 frames** — the allowed ±1 frame
note skew shows up as a level difference on every note. Self-check it by
stubbing `DrvPlayer.prototype._restoreVelBase` to a no-op and running it on
`m3-macro-vel-clear`: it must report +18 dB. Also useful and headless: the nuked
cores load fine in node, so a per-frame peak render is available if needed.

**Process note, worth more than the fix**: three rounds were burned on the
driver because the hypothesis below (§3c) was inherited and never re-tested
against a failing input. Getting the reporter's actual song took the diagnosis
from "no reproduction anywhere in the corpus" to a named register in under half
an hour. **Ask for the failing input first.**

### (3b) Driver: `vel` needed a base and a live value — BUILT (commit be090fc)

A real bug found while chasing the above, but **not** the reported symptom. A
`:vel` macro writes the channel's live vel every frame, and nothing in the MMB
stream re-asserts the score's own (the IR carries vel per NOTE_ON; the stream
carries it as change-only sticky state). So the macro's **last sample became the
channel's velocity for the rest of the song** — every note after a cleared level
macro played at the macro's level. Fixed by splitting `vel_base` (score,
PARAM_SET only) from `vel` (live, macro), copying base → live at every note-on,
on FM/PSG/PCM alike; a channel with a VEL macro *bound* is skipped (its
retrigger writes the attack the same frame, so copying would only add a register
write). Without that guard the A/B went 4 → 27 on `m3-macro-vel` and 26 → 270 on
`demo1`. Docs driver.md §7.1, gate `m3-macro-vel-clear`.

Not reachable from a mucom88 import (every note carries a vel macro, so nothing
ever clears), which is why it changed nothing for the reporter.

### (3c) Fix A — VOICE_SET algorithm change: BUILT, then REVERTED 2026-08-04

Fix A muted (TL=127, before `$B0`) the ops in
`old_carrier_mask & ~new_carrier_mask` and wrote their real TL after `$B0`. It
was built, gated and correct — and then **reverted, because it never fixed an
audible symptom**. Do not re-implement it without a measurement first.

Why it was reverted:

- The loop blast it was decided for turned out to be §(3), the encoder. Fix A
  was attributed to a symptom it did not cause.
- **Measured on the reporter's score**: 15 VOICE_SET calls, 7 needing the mute,
  **0 of them on a keyed channel**. Nothing was sounding, so there was nothing
  to protect.
- In `drv-player` / live it is unobservable by construction — a frame's writes
  reach the chip together, and both gates (c-gate byte-identical, ab baseline
  unchanged) were indifferent to adding *or* removing it. That indifference is
  itself the tell: nothing we can measure could see it.

The hazard is still real on hardware, and this is the analysis, kept so it does
not have to be re-derived. Confirmed by `tools/dump-trace.mjs` on a
two-algorithm repro; three facts compose into it:

1. `voice_set` writes `$B0` (algorithm) **last**, after all four TLs.
2. TLs are composed against the **new** algorithm's carrier mask, so an op that
   is a modulator under the new algorithm goes out as its **raw** `voiced_tl` —
   a small number, i.e. loud.
3. `encode_slot` cuts the write queue at an arbitrary prefix (95 writes / 256 B)
   — **nothing keeps a VOICE_SET's 29 writes together**.

So where several tracks re-apply voices in one frame, the burst splits and `$B0`
lands a frame late. For that frame the chip runs **old algorithm × new TLs**, and
an op that was a carrier under the old algorithm emits its raw modulator TL
straight to the output: **16.7 ms at full volume**, not a click. Normally the
window is only the ~340 µs the writes themselves take. e12e096 (composed carrier
TL) fixed the +10 dB step; this is what it did not reach.

**Fix B — grouping the queue so `encode_slot` cannot split a VOICE_SET — was
considered and REJECTED.** It only shrinks the blast (16.7 ms → 340 µs) where A
removes it, and it edits the §6.2 wire format, which is spec. What B would still
leave after A is one frame of channel mute — the same class as the
already-accepted "a key-on in a write-dense frame can land one frame late".

**Bring A back only if the blast is heard on hardware**, on a score that changes
a voice's algorithm on a channel that is still sounding — check that first, since
the reporter's score never did it once.

### (1)+(2) The mixer's segments — CAUSE IDENTIFIED, DEBT FIXED 2026-08-05

The chain: `mvf_seg` splits a voice's frame at every loop/sample/bank boundary;
crossings per frame are `R x inc / loop_len`, so **pitching a looped sample up
multiplies them**. Each segment costs ~2,400 cycles during which the feed does
not run, and `pcm_debt` charges them at a **fixed** `PACE_SEG` estimated from the
*previous* frame's count, revisable only upward within the frame. So a frame
whose segment count moves is a frame whose length moves: one segment of error is
**4% of the frame = ~68 cents of pitch deviation**, at frame rate — which is the
"fine LFO" — and the same error on the over-budget side drops the vblank INT
outright, which is the tempo wobble. `dac-gate.mjs`'s own header already
documents the mechanism ("one that crosses a loop point runs several times as
many mixer segments as its neighbours") and its bar is a *share* of frames, so
**the gate passes while this is audible**.

Also unaccounted, smaller: `tickCost` prices the i8sat clip branch `jp pe,ov` at
not-taken only — a clipping sample costs **27 uncounted cycles**, so loud
passages run long.

#### MEASURED 2026-08-05 — `drv/tools/seg-bench.mjs`

The tool attributes every executed cycle to the nearest engine label over a real
score, and regresses per-frame cycles on per-frame segment count. Frame
composition (m2-pcmloop, 240 frames), AFTER the fixes below:

| | cyc/frame | share |
| --- | --- | --- |
| pad (idle by design) | ~22,000 | 37% |
| mix tick bodies | ~18,300 | 31% |
| **segment set-up** | **~9,900** | **17%** |
| slot consume | 293 | 0.5% |
| pad accounting (`pcm_debt`) | ~1,400 | 2.3% |

**Two numbers in the first version of this section were wrong. Do not quote the
old ones.**

- **The segment count was doubled.** `seg-bench` counted entries into the
  `mix_seg` *label bucket*, and control re-enters that bucket on the return from
  `ms_call_unrolled` — so every segment counted twice. Real count is **3..11 per
  frame, mean 5.3–6.2**, not 6..18/10.7. The tool now reads the engine's own
  `G_NSEG`, which is the only count comparable to `PACE_SEG` because it is the
  one `pcm_debt` itself reads.
- **`PACE_SEG = 2400` was therefore never "1.7–2.2x too steep".** Against the
  corrected count the marginal cost measured **2,146–4,403** — i.e. 2400 sits
  inside the range and low for `m3-pcm-slice`. That is why halving it made
  frames longer and overruns worse: it was under-charging, not over-charging.
  **Constants were re-measured and left at 2400 / 7200.**
- **The over-budget discrepancy is resolved, and it was sub-ticks.** Measured on
  the same tool across the commit: pre-sub-tick (7f5f102) p50 frame = 57,042 cyc
  (95.6%), **2/240 over budget**; post-sub-tick p50 = 59,821 (100.3%),
  **139/240 over**. Both earlier figures were right about different engines. The
  slot-block consume added ~2,780 cyc/frame that nothing charged the pad for.
- Secondary, still true: **`PCM_START` costs ~1,960 cycles** (`ps_in`), part of
  why note-on frames reach 140–150%.

#### FIXED 2026-08-05 — the debt is a measurement now

**(a) The plan pass was not built, and should not be.** The idea was to hoist
`mvf_seg`'s boundary math to a frame-head scan so the segment count is known
before the first pad is chosen. Measuring the pad tables killed it:

    pad_first_tab  5,3,2,0,0,0,0,0,6,14      (by PV_SHIFT; 8 = mute, 9 = idle)
    pad_add_tab    2,0,0,0,0,0,0,0,8,16

A *sounding* pass holds 0–5 pad units and the debt (≥3) clamps it to the floor
of 1 — confirmed in a live probe, which shows pads `1,1,1,1,9,8` every frame.
**All of the frame's ~22,000 cycles of pad live in the silent passes**, and
those run last. So "the count before the first pad that matters" needs nothing
hoisted: at the start of `pp_idle` every sounding segment has been counted and
each remaining silent pass is worth exactly one more.

A literal plan pass would also have to *predict byte consumption* over n ticks
to reproduce the same boundaries — a 24x8 multiply per segment, ~600 T-states,
~3,000 cyc/frame on a frame already at 100% of budget. It buys nothing the cheap
version does not.

**What shipped instead:**

1. `G_NSEGF` — the frame's exact segment total, pinned at the start of
   `pp_idle` as `G_NSEG + G_NIDLE`. `pcm_debt` uses it once set, and the running
   `G_NSEG` before that. `G_NSEGL` is deleted: **nothing crosses a frame
   boundary any more.** Frame-length spread collapsed 87–104% -> 98–102%.
2. **Slot head fields** (docs/driver.md §6.2): `n_writes` and the PCM command
   list moved to the FRONT of the slot. The engine wants both at the frame head;
   with them trailing the sub-slots it had to walk past every block and tally
   every run — `cs_skip`/`cs_count`, deleted. Slot consume 1,682 -> 293
   cyc/frame.
3. `pp_idle` calls `pp_sounding_at`, not `pp_voice_at`: it overwrites IX with
   `G_IDLEV` immediately, so computing a voice pointer for it was ~470 cyc/frame
   thrown away.

**Result vs the pre-sub-tick baseline** (probe over 240 frames; `npm run dac`
share of paced frames):

| score | dac % paced | over budget | wander p50 | wander max | span worst |
| --- | --- | --- | --- | --- | --- |
| m2-pcmloop | 100 -> **100** | 2 -> **2** | 3.45 -> **3.15** | 4.16 -> **4.14** | 76 -> **83%** |
| m3-pcm-softmix | 98 -> **99** | 24 -> **16** | 3.39 -> **3.10** | 4.68 -> 4.70 | 77 -> **84%** |
| m3-pcm-slice | 96 -> **98** | 43 -> 57 | 4.07 -> **3.58** | 8.49 -> **5.08** | 49 -> **82%** |

Every gate metric improved. The one regression is `m3-pcm-slice`'s overrun
count, and it is a knife-edge artifact, not a structural loss: its p50 frame is
58,671 -> 58,867 cyc against a 59,659 budget, so ~200 cycles of residual
sub-tick cost move 14 frames across a line the distribution is already piled
against. **Frame length is not a tunable here** — every (PACE_SEG, PACE_RESERVE)
pair that pushes slice's overruns below baseline fails `npm run dac` on slice's
wander tail. Tried and measured: 3200/4200 gives over 2/24/20 but dac
FAIL 54% on slice; 2800/7200 gives 2/12/7 and the same failure. Wander and
overrun are the same axis once the variance is gone — longer frame, better
feed span, more overruns.

#### 2026-08-06 — reported: the tempo is EXTREMELY slow on hardware

Three things landed in response. The first two are instruments, because the
report arrived with no numbers and there was no way to get any.

**1. `overrun_frames`, published in the §6.4 header
(`MMLisp_overrunFrames()`).** A Z80 frame that runs past its budget loses the
next vblank outright — the VDP holds `/INT` for about a scanline — so the engine
consumes one slot where it owed two and the music runs slow **with nothing
anywhere to point at**. It is unobservable from inside the Z80 unless the
handler lets the interrupt in, so the handler now runs the frame with interrupts
ENABLED: the successor re-enters, finds `G_BUSY` set, counts itself and leaves.
Everything else is unchanged — the frame still finishes late and still loses
that slot. Gated by an engine-gate scenario that asserts `/INT` mid-handler,
because no emulated frame runs out of cycles and it would otherwise ship
untested.

**2. `sgdk/example/main.c` shows the speed directly**: `audibleFrame` against
the program's own vblank count, as a ratio x256 (0x100 = correct), with
`overrun` and `starved` under it, redrawn every frame. Those two are mutually
exclusive and name the culprit — overrun = the Z80 is over budget, starved = the
68k is late. **This is the first measurement to take on hardware**, before
changing anything.

**3. The `ms_bind` hoist — most of (b), and it is large.** The specialised loop
copy is chosen by (role, shift) and BOTH are constant for a whole voice pass,
yet it was resolved per SEGMENT along with a pad that had not changed either.
Binding once per pass (and again when a pass falls through to the silent loop,
the one thing that changes the shift under a running pass) turns the per-segment
path into a single self-modified `jp`.

Measured, against the pre-sub-tick baseline (7f5f102) — the honest reference,
since sub-ticks are what put the frame over budget in the first place:

| score | dac % paced | over budget | wander p50 | wander max | span worst |
| --- | --- | --- | --- | --- | --- |
| m2-pcmloop | 100 -> **100** | 2 -> **2** | 3.45 -> **3.08** | 4.16 -> 4.20 | 76 -> **81%** |
| m3-pcm-softmix | 98 -> **100** | 24 -> **12** | 3.39 -> **3.10** | 4.68 -> **4.15** | 77 -> **82%** |
| m3-pcm-slice | 96 -> **99** | 43 -> **6** | 4.07 -> **3.63** | 8.49 -> **4.59** | 49 -> **81%** |

Mean frame length 94-96% of budget (was 98-100% before this, 95.6-98.3% at the
baseline). **Every metric is now past the baseline**, and `m3-pcm-slice` — the
score that was 24% over budget — is at 3%. `PACE_SEG`/`PACE_RESERVE` were NOT
touched; see the note above on why they cannot be.

**What was left of (b) — the register file itself — BUILT 2026-08-06,
UNCOMMITTED pending a hardware listen.** The shape that shipped: `ms_pload`
fills DE = ptr / C = incInt / HL' = frac / DE' = incFrac once at pass entry,
`mix_seg_live` runs a segment without touching the struct, `ms_pstore` writes
back once at pass end; the idle path keeps the old `mix_seg`. `mvf_seg`'s
boundary math was rewritten onto the live file: avail via the `LEFT + ptr`
carry trick (no second register pair), consumption measured as `DE −
(G_OLDPTR)` with 8-bit chains, window-top and loop-wrap fix `D`/`DE` in place,
and `mvf_exact` takes/returns the bound in B, walks the LIVE `HL'` and
push/pops it (C is the live incInt it subtracts). `oldptr` went to `G_OLDPTR`
(`ld (nn),de`), not `BC'` — cheaper than the exx dance. Measured (stall-read
14): −1.4–1.8k cyc/frame; slice 1v overruns 3 → 1, over-budget 8 → 6; dac
100% paced on all three, spans 84-86%. Engine 4,214 B (1,674 free), gates all
green (engine 10 scenarios incl. bank crossing, c-gate 41, ring, ab).
Segment marginal cost is now BELOW `PACE_SEG` = 2400 (seg-bench's regression
goes noisy, −736..3136 range) — overcharge lands frames early = the safe
side; retune only with a hardware reason, same rule as always.
**Hardware listened 2026-08-06: NO audible change — correctly, in hindsight:
wander had measured 4.13 -> 4.13 before the flash. (b) is budget recovery,
not a smoothness fix. Kept (it funds what follows), still uncommitted.**

#### 2026-08-06 — the wobble MEASURED on the reporter's song, and what it is

The song itself (`~/Developer/gendev/verify-hello-world/res/song.mmb` +
`.smp`) profiles directly now: `seg-bench` and `dac-gate` both take a `.mmb`,
and dac-gate reports **feed holds** — the largest silences between consecutive
DAC writes, in-frame and across the frame boundary (the boundary one is
invisible to WANDER, which removes per-frame offset).

- The song: 3.1 segments/frame (NOT a segment storm), mean 89% of budget with
  the stall model, **5 over-budget frames in 2400**. The steady `lost 4`
  spikes at spots are NOT over-budget frames in this model.
- **The wobble is the feed holds: p50 10.6 periods in-frame PLUS 23.4 periods
  (~8k cycles = 2.2 ms) at EVERY frame boundary — a 60 Hz hold/catch-up
  cycle covering ~19% of every frame.** The live reference is uniform; this
  is the entire audible difference.
- Constants sweep (SEG x RES, with the new gap metric): **hole p50 tracks
  headroom exactly** — SEG=1200/RES=2400 reaches boundary p50 1.6 periods
  (near-uniform) at 83% of frames over budget. The identity behind it:
  **uniform feed occupies 100.0% of the frame by construction** (R x period =
  frame), so hole size IS the only overrun insurance. "Wander and overrun are
  the same axis" was this, made exact.
- `SLOT_MAX_WRITES` 95 -> 48 -> 32 sweep: gaps 12.5k -> 11.3k -> 8.8k — writes
  are NOT the dominant gap either. Cap stays 95.
- f788 anatomy (the +9k over-budget spike class, = burst-open+1 with a heavy
  slot): `cr_p1` 4.8k + `ym_busy0` 3.8k — **the write charge under-priced
  writes because the YM busy-wait is real**: ~90 cyc/write, not 61. `pcm_debt`
  write charge fixed to /32 (was /43). Worst frame 70.2k -> 68.2k, gates
  green. In the tree, uncommitted.

#### Catch-up BUILT 2026-08-06 (approved same day) — awaiting hardware

Implemented as proposed below, plus what building it settled:

- `H_VBL` = HDR+14 (68k-owned, low byte of SGDK `vtimer`), stamped in
  `MMLisp_frame`'s existing tail-read grab. **PROTO_VER 6 -> 7.**
- Engine: `G_INTS` (G_BASE+$0c) counts ANSWERED vblanks; after `frame_step`
  the handler compares, catches up `delta` in 1..8 (CATCH_WIN) at most 2 per
  interrupt (CATCH_MAX), resyncs silently outside the window. Boot zeroes
  H_VBL so the first check reads in-step. Harnesses that never stamp resync
  every frame = behavior unchanged — that is why every pre-existing gate
  passes untouched.
- **Why it cannot fire spuriously**: a stamp cannot arrive EARLIER than its
  own vblank, and the Z80's frame starts AT the vblank — so stamp-ahead
  always means a real miss. A late-stamping host only delays detection.
- **Chronic overrun is still forbidden** (measured reasoning, driver.md
  §6.7): a steady-over engine gets caught up every frame, the ring throttles
  the 68k, and the music runs smoothly SLOW by the overrun. Catch-up heals
  transients only; typical frames must land under budget. This is what
  bounded the constants below.
- Constants: `PACE_RESERVE` 7200 -> **4800** (one debt quantum — the next
  step lands the steady frame ON the line = chronic). With the /32 write
  charge: the song's boundary hold 23.6 -> **15.4 periods** (wander 2.54 ->
  2.03 ms, span 91%), over-budget 5 -> 89/2400 — ALL of which catch-up now
  converts to one-off hiccups. Corpus: 14/5/6 over (was 12/2/6), same deal.
  The debt quantum (16 x R = 2.8k cyc) is the floor on further tightening.
- Gate: engine-gate scenario 11, "missed vblank is caught up, not lost" —
  stamps H_VBL two ahead with a backlog posted, asserts both slots consumed
  in ONE interrupt, the audible clock counting both, and no spurious
  catch-up on the in-step frames. `verify:all` green, 4,244 B, proto 7.
- `pcm_debt`'s write charge /43 -> **/32** (~90 cyc/write measured with the
  ym_busy wait — the +9k f788-class spikes were under-charged writes).

**Hardware next (everything uncommitted until then):** copy
`sgdk/mmlispdrv.bin` + `mmlispdrv_bin.h`, rebuild, listen for the wobble and
watch `lost/s` and `music`. Expected: wobble narrower (boundary hold −35%),
`lost/s` ~0 with `music` = 0x100 (spikes heal), `starv` unchanged. If the
wobble is still audible, the remaining lever is structural (the in-frame
10.6-period holds at pass boundaries / the head consume), and the write-pump
idea (writes ride the mix loop) is the next design discussion. **The write pump
was built on 2026-08-06 — see the section below, and note that it also proved
those in-frame holds are the PASS TRANSITION, not the head consume.**

#### PROPOSED 2026-08-06 (awaiting sign-off): move PCM MIXING to the 68k

Prompted by "can pitch/volume be faster — LUTs?". Z80-side LUTs were priced
and are the wrong size: a page-aligned volume table via BC' is 19 cyc flat
(wins only at shift >= 3 — quiet voices, not the crunch), a step-pattern
table saves ~10 cyc/tick; both are fractions of one 2.8k debt quantum. The
real answer: the 68k has the multiplier, the flat address space, and ALREADY
shadows every PCM voice's position. Proposal: the 68k mixes 175 bytes/frame
into a buffer that rides the ring next to the slot; the Z80 becomes writes +
a uniform local-RAM feed. Deletes: window fetch stalls (−2.5k), segments,
banks, pass boundaries — the wobble's entire mechanism — and the knife edge
(feed ~5k, 3 voices trivial, catch-up becomes rare insurance). Gains: real
multiply volume, free pitch, mixer verified in C against drv-player by
c-gate (stronger than emulated asm). Subsumes the 1-variable+2-fixed plan.
Costs: §6.2 wire change (PCM data block replaces PCM commands), gate
re-freeze, 68k +15-25% (measure first), and the bus-grab stall (~1.6k) must
be CHUNKED (~32 B per grab) so no single feed hold exceeds a sample period —
note the CURRENT one-piece slot copy also holds the feed on hardware and no
harness models it. Build order if approved: (1) port drv-player's _pcmFrame
to C under c-gate, (2) wire format + slot builder, (3) shrink the Z80.

#### The original proposal, kept for the reasoning

The knife edge exists because a missed vblank INT loses a frame of MUSIC. The
Z80 cannot see a missed edge (the VDP holds /INT one scanline), but the 68000
can: `MMLisp_frame` already grabs the bus every vblank — it can stamp a
vblank counter byte into Z80 RAM. Then a frame that ran long finds, on
finishing, that the stamp advanced by 2: it consumes the next slot
IMMEDIATELY instead of halting — the frame is late, the DAC hiccups once,
but the music does not lose a frame. **That decouples the axis**: with
overruns self-healing, PACE_RESERVE/PACE_SEG can be tightened toward the
measured costs and the boundary hole drops from ~23 periods toward ~4-7
(flutter down ~4-6x), leaving rare hiccups where the insurance used to be
paid every frame. Surface: +1 header byte (proto bump), one 68k write per
frame inside the existing grab, an engine idle-loop check, a catch-up cap of
one frame, and an engine-gate scenario that forces an over-budget frame and
asserts the next slot still gets consumed. Design questions to settle first:
where the stamp lives in the header, interaction with `H_FRAMES`/starvation
accounting (a caught-up frame must not count as starved), and whether
catch-up frames skip their pads (they should — they are late by definition).

#### 2026-08-06 — the slow tempo was RING GEOMETRY, not cycles

Two hardware runs, and the first one measured only itself.

**Run 1** (`audible 08E9 / vbl 0789 / over 090A / starv 0471`) was invalid:
`vbl` counted main-loop iterations, and a loop that misses a frame waits for the
next vblank, so it under-counts elapsed time and the ratio came out **1.18** —
above 1, which the music cannot do. And the readout took four Z80 bus grabs per
frame; the Z80 does not run while the 68000 holds its bus, so those grabs cost
the engine frames that `over` then counted. Reference clock must be `vtimer`
(SGDK increments it from the vertical interrupt); counters must be read in ONE
grab, rarely.

**Run 2** (`music 00FF / host 00FF / over 0642 / starv 0323 / audible 0643`)
gave the answer, and two more of my own bugs with it:

- `over` (1602) ≈ `audible` (1603). The overrun counter was nonsense. It ran the
  frame with interrupts enabled so the successor's vblank could re-enter and
  tally itself — but the VDP holds Z80 `/INT` for about a scanline, so the
  **same** vblank re-triggers the instant `ei` executes, every frame. **Removed,
  along with the interrupts-enabled ISR.** The ratio below answers the same
  question from the host with nothing added to the engine.
- `music` read 0xFF (correct speed) while `starv` was 50% — impossible, and the
  reason is that `H_FRAMES` ticked on starved frames too. §6.4 calls it the
  audible clock; a starved frame plays nothing, so **it counts consumed slots
  now**. The metric had been blind to the only failure it existed to catch.
- **`starv` 803/1603 = 50.1% is the actual fault, and it is mine.** Sub-ticks
  moved the ring's tail release from the frame head to ~2/3 of the frame (the
  last sub-slot). The consumed slot is therefore held for the WHOLE frame, so
  pending lookahead is `depth-2` — at depth 2, zero. The 68k renders from a loop
  woken by the same vblank, so its render lands inside the engine's frame, sees
  a full ring, produces nothing, and the next vblank starves. Every other frame.
  Half-speed music.

**Fix: `RING_DEPTH` 2 -> 3** (+256 B Z80 RAM, the map moves up a page; +1 frame
of host->music latency, §3.4). That restores exactly the one slot of lookahead
depth 2 gave before sub-ticks. Rejected alternative: release the tail at the
frame head and `ldir` the remaining sub-slots to scratch — ~100 cycles typical
but ~4,000 on a patch-dump frame, and this driver has no cycles to spare.

**Why no gate caught it.** `slot-gate.mjs` posted its slots BEFORE the
interrupt. A real 68k renders *during* the engine's frame, which fills ~95% of
the period. That ordering difference hid the fault completely. The gate now
renders ~20% into the frame and fails on any starvation: at depth 2 it reports
128/250 = 51% starved and a 1,400-sample DAC divergence, at depth 3 it is clean.
**Reproducing a hardware fault in a gate before fixing it is the only reason the
fix is trustworthy** — the two previous attempts at this were guesses.

#### 2026-08-06 — the ~2.2% steady loss: ROM-window fetch stall. CONFIRMED on
#### hardware (PCM-muted A/B), fix BUILT and gated; one flash still owed

**State: VERIFIED ON HARDWARE 2026-08-06 and committed (815b7fb). The steady
loss is gone — "much better", no more flat 2-3/s. What remains, reported the
same day: (1) event spikes of `lost` 4 at specific spots — the expected
residual, i.e. multi-voice overlap / PCM note-on / score-head frames, all
measured limits; (2) pitched PCM still audibly wobbles — the per-segment feed
pauses plus the fix's own +0.5 ms give-back shape, see "levers" below.
CORRECTION same day: the reporter's song never sounds 2 PCM voices, so for THAT
song the spike candidates are note-on frames, segment-storm frames (the 1v
overruns in the corpus are 8+seg frames sitting at 100-116%), score head — or
starvation, which `lost/s` also counts; the `starv` line at the same moment is
what distinguishes them. Spikes and wobble likely co-locate: both scale with
R x inc / loop_len on the pitched loop, and the (b) rewrite attacks both.**

Hardware (`verify-hello-world`, the reporter's song, 1 PCM voice):

| | value | reading |
| --- | --- | --- |
| `music x256` | 0x00F8 | 96.9% of correct speed, cumulative |
| `1s` / `lost/s` | 0x00F3 / 3 | **2-3 frames lost every second, steadily** |
| `worst 1s` | 0x00DD | 86.3% — no second is much worse than the rest |
| `starv` | 34 of ~3973 | 0.9%, and `host` reads 0x00FD (98.8%) — these match |
| interrupts not taken | ~89 | **2.2%: the Z80's frame ran over budget** |

**The loss is STEADY, not event-driven.** That is the one thing the counters
have settled, and it kills the whole family of "a loop point / a note-on / a
particular bar" hypotheses: those would swing `lost/s` between 0 and 10 and put
`worst 1s` far lower. A flat 2-3 per second means a per-frame cost that is
always slightly over the line.

The same song in emulation: **mean 90% of budget, 5 over-budget frames in 2400**
(3 of them the score head). `seg-bench --stall N` charges N cycles a frame for
work the harness does not model and finds the cliff:

    stall 0 -> 0.2%   2000 -> 0.5%   2400 -> 3%   2700 -> 10%   4000 -> 74%

So the missing cost is **~2,400-2,600 Z80 cycles per frame**, and it is
something no gate here models. Candidates, none verified: the 68000 holding the
Z80 bus (three grabs per `MMLisp_frame`), Z80 wait states on YM writes, and
contention between the Z80's $8000 ROM window (175 sample reads a frame) and the
68000's own bus traffic.

**Three hypotheses tried and disproved — do not re-run these:**

1. *"Two or more PCM voices do not fit."* True (measured, see above), but the
   reporter's song plays ONE voice. Measured on the wrong score.
2. *"The segment bound is too coarse, so note-on frames run long."* `MVF_TAIL`
   swept 16/24/32/48: raising it does cut segments (9-seg frames 6 -> 0) but
   `mve_lp`'s walk costs more than the segments it saves — over-budget went
   12 -> 26 -> 102. **16 is already optimal; leave it.**
3. *"Too many Z80 bus grabs per frame."* Staged the slot copy so `MMLisp_frame`
   took the bus twice instead of three-to-four times. **Hardware: `music` 249 ->
   248. No measurable effect.** Reverted; the handshake count is not the cost.

**RUN, and it localised the cost.** Same song with `MMLISP_PCM_SAMPLES 0`
(PCM muted, FM/PSG only):

| | with PCM | PCM muted |
| --- | --- | --- |
| `music x256` | 0x00F8 (96.9%) | **0x00FF (99.6%)** |
| `lost/s` | 3 | **1** |
| `worst 1s` | 0x00DD (86.3%) | **0x00FB (98.0%)** |
| `starv` | 34 / ~3973 | 6 / ~1818 (matches `host` 99.6%) |

**Z80-side loss goes to zero when nothing fetches a sample.** The cost is in the
mixer path, and the only per-tick bus traffic there is `ld a,(de)` with DE in
the $8000 window — a 68000-bus access, arbitrated and wait-stated, that the
generator's COST table prices at the Z80's own 7 cycles. `body()` emits that
fetch only for shifts 0-7; MUTE and IDLE do not fetch, which is exactly the
shape of the experiment's result. 175 fetches a frame against a ~2,500 cycle
deficit implies **~14 cycles of un-modelled cost per fetch**.

**4. Hypothesis four, also disproved: charging that penalty in `padFor`.**
Added `PACE_WINDOW = 14`, subtracted per fetch from the fetching loops' pads.
Hardware: no change. **The reason is visible in the pad table and is worth
keeping** —

    first s0:2 s1:1 s2:0 s3:0 s4:0 s5:0 s6:0 s7:0 mute:6 idle:14
    add   s0:0 s1:0 s2:0 s3:0 s4:0 s5:0 s6:0 s7:0 mute:8 idle:16

**the fetching loops have no pad to take away.** At shift >= 2 it is already 0,
and every `add`-role loop is 0 at every shift. All of the frame's ~23,000 cycles
of pad live in the MUTE and IDLE passes — the ones that do NOT fetch. So a
per-fetch charge applied through `padFor` is a near no-op; it only moved
`first` at shifts 0 and 1.

**Where it belongs instead**: `pcm_debt`, which is the frame-level charge and is
what sizes the idle passes' pads. The count is available exactly where the debt
is computed — `G_ACTM` holds the sounding-voice mask at frame head, and each
sounding voice fetches `PCM_MIX_R` times:

    debt += (popcount(G_ACTM) * PCM_MIX_R * PACE_WINDOW) / (16 * PCM_MIX_R)
          =  popcount(G_ACTM) * PACE_WINDOW / 16          ~= 1 pad unit per voice

That was the untried fix. **BUILT 2026-08-06 (later the same day), and it is
exactly that**: `pace_win_tab[sounding passes]` (generated next to `debt_tab`,
`= round(i * PACE_WINDOW / 16)` = 0,1,2,3) added inside `pcm_debt`;
`G_ACTM`/`G_NIDLE` computed BEFORE the first debt call so the charge is exact
from the frame head. The `padFor` subtraction is reverted — one mechanism, and
the one that reaches the pads that exist. MUTE/IDLE charge nothing, so a
PCM-muted song is untouched, which is what the decisive experiment demands.

**Reproduced in a gate before trusting it** (the RING_DEPTH lesson):
`seg-bench --stall-read 14` charges every $8000-window read on the instruction
that made it. Over-budget frames, 240 each, softmix / pcmloop / slice:

| | softmix | pcmloop | slice |
| --- | --- | --- | --- |
| no charge + stall-read 14 (= hardware today) | 70 (58 on 1v) | 25 (all 1v) | 86 (81 on 1v) |
| charge + stall-read 14 (= fixed hardware) | 12 (**0** on 1v) | 2 | 8 (3 on 1v) |
| charge, no stall (= plain emulation) | 11 | 2 | 6 |
| old baseline (no charge, no stall) | 12 | 2 | 6 |

The reproduction has the hardware's exact shape — a steady loss concentrated
on one-voice frames — and the charge removes it under the same model. What
stays over budget is the known 2–3-voice limit and score heads.

**The price, and its shape is forced**: the stall lands on the SOUNDING third
of the feed while the give-back can only come from the silent passes, which
run last (that ordering is what makes the segment count a measurement). One
debt unit across two silent passes returns 16 x 2R/3 = ~1,870 cyc, so the feed
error swings +800/−1,870 ≈ **+0.5 ms of wander on every PCM score** — measured,
matching that arithmetic. `dac-gate` now models the same per-read stall (spans
read 87–88%, closer to hardware) and `MAX_WANDER` is repriced 0.25 -> 0.31 with
this derivation in the file. Cutting the mixer's real per-segment cost — the
deferred (b) rewrite — is still what tightens wander; the bar move only prices
a cost that was always there and newly visible.

`mmlispdrv.bin` rebuilt: **4,164 B, 1,724 B free below the mix plane.**

**Hardware ran it 2026-08-06: steady loss GONE.** Residual: `lost` 4 at
specific spots, and the pitched-PCM wobble persists. Both were predicted by
existing measurements; neither is the stall coming back.

#### The levers that remain, with their measured sizes (discussion state)

- **Event spikes (`lost` 4 at spots).** The measured causes, in likely order:
  frames with 2+ PCM voices sounding (EVERY such frame overruns, +11.2k cyc
  net of a fully-collapsed pad), PCM note-on frames (`ps_in` ~1,960 cyc,
  140-150% frames), score head (patch dump, 120-145%). Attribution needs no
  new tool: `node tools/seg-bench.mjs path/to/song.mmb --stall-read 14` reads
  the SGDK project's own res/ files and lists the over-budget frames with
  voice count and segment count.
- **The wobble on pitched PCM.** Two known components: (a) the feed pauses
  ~2.4k cyc at every segment and a pitched-up loop multiplies segments
  (`R x inc / loop_len`); (b) the stall fix's give-back rides the silent
  passes, so the feed has a 60 Hz sawtooth component (+800/−1,870 cyc). The
  measured next lever is the deferred **(b) register-file carry** (~2,659
  cyc/frame: `ms_load` 1,981 + `ms_done` 678) — it directly shrinks the pauses
  of (a). A second, unpriced idea for (b-the-sawtooth): let a debt-clamped pad
  bind the UNPADDED loop copy instead of flooring at 1 — that hands the
  sounding pass 16 cyc/sample right where the stall costs 14, cancelling in
  place; costs code size (1,724 B free) and needs the bind path to know.
- **3 simultaneous voices: NOT at R = 175, measured** (the 2-voice table
  above). P0's 10.9 kHz ceiling was mixing-only — no segments, no feed, no
  bus stall — and reality is well under it. The levers, each a design trade:
  `PCM_MIX_R` down (~8-9 kHz territory; costs fidelity on ALL PCM, re-freezes
  every gate baseline), compile-time pre-resampling (saves ~37 cyc/voice/tick
  ≈ 19k at 3v — the single biggest lever, but decision 5 traded it away for
  per-note pitch and dynamic loop points; a per-sample opt-in flag would be a
  middle path and new design), and the (b) rewrite (~2.7k, helps but small).
  An emulation sweep with `--stall-read 14` over candidate R values is the
  cheap way to put numbers on this BEFORE any design discussion — nothing has
  to touch hardware to scope it.

#### 2026-08-06 — "XGM/MDSDRV manage 3-4 PCM voices" — the comparison, priced

Raised as doubt about the split itself. The split is not the gap: those
drivers' multi-voice PCM is FIXED-RATE and pre-baked (no per-note pitch = no
16.16 resampler, no dynamic loop/slice boundaries = no segment machinery), and
this repo's own P0 bench prices this engine at that same configuration:
**i8sat pre-resampled ceiling = 17.2 kHz at 3 voices** — the same class of
number on the same Z80. The difference is the per-voice feature bill, chosen
in decision 5 (per-note pitch + dynamic loops > cycles), not the architecture.
Rough per-tick arithmetic (bench-derived, needs a real mixed-mode bench before
being claimed): pitched ~88 cyc/voice/tick, fixed ~51 → 3 pitched ≈ 264,
1 pitched + 2 fixed ≈ 190 (saves ~13k/frame ≈ the measured 2v gap), 3 fixed
≈ 153 (fits with margin). The candidate design, NOT yet agreed: **per-sample
opt-in pre-resampling** — a sample flagged fixed-pitch is resampled at export
and mixed by a no-resampler loop copy; drums go cheap, one voice keeps pitch.
Costs: export-side resampling in the MMB tool, mixed-mode loop copies (code
size vs 1,724 B free), and the gate baselines. Decision 5 gets re-examined
with these numbers, in a design discussion, before any code.

**Direction agreed 2026-08-06 (spec still to be written): 1 variable + 2 fixed
voices, and a fixed voice bakes VOLUME as well as pitch** (the user's point:
baking both is what makes a voice truly fixed — no resampler AND no shift in
its loop). Open spec questions for that discussion: what PCM_VOL / a :vol
macro means on a fixed voice (probably ignored except :vol 0 = MUTE), whether
fixed voices still slice (segments exist without a resampler), MMB format for
pre-resampled blobs, and which voice index is the variable one. Order agreed:
(b) register-file rewrite FIRST (unconditional win), then the mixed-mode
bench, then the spec.

**A real instrument, still unbuilt**: the YM2612's Timer B is unused (CSM takes
Timer A), so the engine could time its own frame on hardware and publish the
max. Four hypotheses have now been argued from emulated cycle counts against a
machine whose bus they do not model; that number would end the argument.

#### The A/B that attributes it, if hardware still drags

Set `SLOT_SUBS` to 1 in all three ports and rebuild:

    live/src/slot-builder.js   export const SLOT_SUBS = 1
    drv/68k/mmlispseq.h        #define MML_SLOT_SUBS 1
    drv/src/engine.z80         SLOT_SUBS   equ 1
    cd drv && npm run emit-bin      # then re-copy mmlispdrv.bin to the project

K=1 is byte-identical to the pre-sub-tick slot format by design, so if the tempo
comes back the cost is sub-ticks and nothing else; if it does not, suspect
something outside this file. **Put K back to 3 afterwards** — the gate suite
only ever runs at the shipped value.

## Per-note timing: what 60 Hz costs (reported 2026-08-03, ADDRESSED 2026-08-05)

Reported as "notes speed up and slow down". Measured on the reporter's song —
`TEMPO_SET increment 874` = 3.4141 ticks/frame = **128.03 BPM**, PPQN 96:

| value | frames | lands on |
| --- | --- | --- |
| 1/4 | 28.119 | 28 or 29 (12% long) |
| 1/8 | 14.059 | 14 or 15 (6% long) |
| 1/16 | **7.030** | 7 or 8 (**3% long**) |
| 1/8 triplet | **9.373** | 9 or 10 (**37% long**) |

The 8.8 accumulator distributes this optimally (Bresenham), so it is the 60 Hz
grid, not a driver bug — but a note that is 14% long 3% of the time is still
audible in a fast passage, and triplets are far worse at this tempo.

**Resolved by sub-ticks** ([[plan-subtick-timing]], driver.md §3.5): note
dispatch runs three times a frame on the mixer's voice-pass boundaries, so the
grid above is three times finer — a 1/8 triplet is now up to a sixth of a frame
out instead of half. FM and PSG only; **PCM onsets are still on the 60 Hz grid**
and are gated on cutting the mixer's per-segment cost, which is the (1)+(2) item
in this file. Since rhythm is perceived from attacks and the drums are the
attacks, that remains the part most likely still audible — re-listen and, if it
survives, separate triplets (37%) from 16ths (3%) in a VGM log.

## Fixed limits (expectation-setting, unchanged by the split)

8-bit DAC, nearest-neighbour only (interpolation needs a multiply per sample),
DAC jitter from the 68k's per-frame bus grab (~tens of µs, ~0.2%; **measure on
hardware**).

## 2026-08-06 (late) — segment plan shipped; the wobble is the CHIP WRITES

Committed this session, in order: the ROM-window stall charge (815b7fb,
hardware-confirmed), missed-vblank catch-up (549a909), the segment plan
(1801317). Also proposed and NOT taken: moving PCM mixing to the 68k — the
68000 is the game's CPU and spending 15-25% of it on the mixer is the wrong
currency, and it would leave the Z80 idle. Direction agreed instead was
1 variable + 2 fixed (pitch AND volume baked) PCM voices, still unbuilt.

### The segment plan (§6.3.1) — built, gated, and it did not move the wobble

The sequencer ships each voice's break list (loop wrap / sample end) in the
slot; the engine follows it. Free on the 68k (its position advance already
finds the breaks) and it deletes `mvf_exact`'s tick-by-tick tail walk, the
worst per-segment spike. Fallback to the old avail/shift bound survives for a
starved frame (no slot) and for a run longer than `MML_PCM_PLAN_MAX` = 16.
**Measured on the reporter's song: segment-count spread 3..6 -> 3..4, cycles
neutral, DAC hold unchanged.** Keep it — it removes a real variance source that
a pitched-up looping score DOES pay — but it was not this song's problem.

### What the wobble actually is, measured

`dac-gate` now reports feed HOLDS (the largest silence between consecutive
`$2A` writes), which the per-frame WANDER metric could not see. On the song:
**in-frame p50 10.7 sample periods, frame boundary p50 15.3.** Both are
`cs_runs` — the slot's chip writes, at ~90 cycles each with the YM busy poll.
The pad quantum (16 cyc/sample = 2.8k/frame = 8.2 periods) is the other term
and is smaller. Constants sweep confirms it: the hold only moves in ~5-8 period
steps, and no (PACE_SEG, PACE_RESERVE) pair reaches below ~15 without putting
most frames over budget.

### The WRITE PUMP — BUILT 2026-08-06 (driver.md §5.1.1)

Shipped as designed: **do not feed inside the consume, consume inside the
FEED.** `cs_runs` queues the sub-slot's two YM runs in place (nothing is
copied) and every unrolled mix iteration takes one write out of the queue.

How the four open design points were settled:

- **A write may not cross its sub-tick boundary.** Kept. Whatever the pump still
  holds is flushed at the pass boundary before the next sub-slot is queued.
- **Per-write cost is not constant.** PSG bytes are NOT pumped — a PSG write is
  13 cycles and a whole run is under one sample period. Only the YM runs go
  through the pump, and the port is baked into two self-modified `ld (nn),a`
  operands so the write path has no dispatch.
- **A patch-dump frame has more writes than iterations.** Decided the other way
  round: such a frame does not use the pump AT ALL. `PCM_DRAIN` = 56 is tested
  against the slot's leading `n_writes` at the frame head; past it the frame
  bursts exactly as before. A pass only has 58 iterations, and a frame that
  dense is over budget however its writes go out — while spreading them makes
  the feed's own rate uneven (dac-gate WANDER went 3.3 -> 9.3 ms when it did),
  whereas a burst landing before the frame's first sample is a constant offset
  and inaudible. A first attempt draining two writes an iteration was measured
  and dropped for the same reason.
- **The pad, and the branch.** Neither a second set of generated copies nor a
  runtime branch. The bound copy's own first instruction — `ld a,(iy+0)`, three
  bytes, exactly the size of a `jp` — is PATCHED to jump into the pump while
  writes are queued and restored when the queue empties, so an unarmed loop is
  the unmodified code and pays nothing. Only one copy is bound at a time
  (`ms_bind`), so only one site is ever patched; `pump_sync` moves it on rebind.
  While armed the pad drops by `PCM_PUMP_U` = 15 units (`PUMP_CYCLES` = 236,
  priced in gen-mixer.mjs), which is where the write's cycles come from.

One structural consequence: **the ring tail is released at the END of the frame**
(`slot_release`), not when the last sub-slot is read, because the pump keeps
reading the slot in place after that.

### …and it SHIPS OFF. Hardware said so.

Turned on, it was reported from the machine as **clicking with the tempo
wobbling**. Reproduced in emulation the moment the right thing was measured —
not the DAC hold, the FRAME BUDGET. On a scratch score with demo1's FM/PSG
traffic plus three PCM voices (240 frames, ROM-window stall charged):

| | pre-pump | pump OFF (as shipped) | pump ON |
| --- | --- | --- | --- |
| frame cycles, p50 | 57,370 | 57,752 | 58,707 |
| **frames over 59,659** | **18.3%** | **17.9%** | **24.6%** |
| in-frame hold, worst | 17.5 periods | 16.1 | **14.3** |
| frame-boundary hold, p50 | 22.6 | 21.7 | **19.9** |

A pumped write is ~236 cycles against a bursted one's ~113 (the extra BUSY poll,
the `$2A` re-latch, the queue bookkeeping). At 40 writes a frame that is ~5% of
the budget on a driver already at 98-102%. **Every over-budget frame is a lost
vblank, a catch-up and one DAC hiccup (§6.7)** — +6.7 points is ~4 extra hiccups
a second. Two sample periods of hold do not buy that.

`PUMP_ON` in engine.z80 is the switch; the default is 0. `npm run engine`
assembles the engine BOTH ways and gates both, so the off-by-default path cannot
rot. Nothing in this repo can decide the switch — an emulated frame never runs
out of cycles and its YM is never BUSY — so it is decided by ear on hardware,
and the budget table above is the thing to re-run first when it is reconsidered.

**Lesson worth keeping: `npm run dac` was the wrong gate to optimise against.**
It measures hold and wander and reports both as "ok"; it says nothing about
whether the frame fits. The scratch budget harness (frame cycles p50/p95/max +
over-budget share, with `PACE_WINDOW` charged per window read) is the one that
predicted the hardware report, and it should be run on any change that touches
the frame — it belongs in `tools/`.

### 2026-08-06 — a re-run of a DISPROVED hypothesis, and what it cost

The wobble was reported again (pump on, then pump off — so the pump was never
it). The response was to measure a synthetic two-PCM-voice score and conclude
"2 voices do not fit". That is hypothesis 1 in the "tried and disproved" list
above, verbatim, and the correction is written five paragraphs above it: **the
reporter's song sounds ONE PCM voice.** Measured on the wrong score, twice, a
day apart.

The rule this file already states, restated because it did not take: **before
proposing a cause, run `node tools/seg-bench.mjs <the song>.mmb --stall-read 14`
on the ACTUAL song** — the SGDK project's `res/` holds the `.mmb` and `.smp`, no
new tool is needed, and it prints the over-budget frames with their voice and
segment counts. A synthetic score answers a question nobody asked.

Two things did come out of it and are worth keeping.

**A build hole, now closed.** The engine's code runs from `$0000` and must stop
below `HDR = $1300`. Nothing checked it. An engine that grew past it assembled
cleanly, overwrote the header and the ring with its own code, and presented as
the mixer executing data. `npm run engine` now gates it, both builds, and prints
the margin — which is **71 B**. That number is the real constraint on every
remaining mixer idea, and it was not written down anywhere.

**The padless-twin idea is now PRICED: it does not fit.** The "second, unpriced
idea for (b-the-sawtooth)" in the levers list — let a debt-clamped pad bind the
UNPADDED loop copy instead of flooring at 1 — was built. It works and it is
worth ~1.4k cycles a frame on the sounding pass, delivered exactly where the
stall is charged. It costs **~500 B** (a twin for every copy whose baked pad is
non-zero: first s0/s1/s2/mute/idle, add s0/mute/idle) against 71 B of headroom,
and reverted. Restricted to the copies that matter (`first` s0-s2, the only ones
a one-voice frame ever clamps) it is still ~180 B. **It needs the RAM map moved
first, and the header cannot move** (§6.4). Half of it is available for free —
patching the bound copy's `ld a,(G_PAD)` to a `jr` over the pad, the write
pump's own trick — for 12 of the 24 cycles a sample; unbuilt.

Also cut while looking, live in every build: **`pcm_debt`'s frame-constant half
hoisted** out of the per-bind path (`pcm_debt_base`, ~135 cyc x 4 calls a frame)
and **`latch_bank` skips a bank that is already latched** (414 cyc a call, and a
song's samples are normally all in one bank). ~900 cycles a frame.

### The write pump: REMOVED 2026-08-06. Design kept, code not.

Built, gated, switched off, then deleted — and the deletion is the right call,
not a retreat. Three measured reasons:

1. What it fixes is second-order. It took the worst in-frame hold from write
   bursts 17.5 -> 14.3 periods, while the sample clock's median interval sits
   29% off nominal with sidebands above the carrier. Polish on the wrong face.
2. On this architecture it does not pay: ~236 cyc a pumped write against ~113
   bursted (with the polls inlined), and it pushed a busy score from 17.9% to
   24.6% of frames over budget.
3. **287 B in an image with 71 B of headroom.** It is why the padless-twin
   experiment overflowed the published header. Removing it took the image
   4793 -> 4424 B and headroom 71 -> 440 B, which is what the frame-loop rewrite
   will need.

**In the rewrite it comes back, mandatory rather than optional** — a 20-write
burst is 2,200+ cycles, six sample intervals, and by definition a clock break.
But the shape changes: the current version is built to be an OPTIONAL add-on to
a mix-driven loop, which is where the self-modified patch site, the PCM_DRAIN
gate and the flush fallback come from. Under a feed-driven loop the dispatch is
unconditional and all three disappear. Re-derive it from these, which is all
that was worth keeping:

- queue the slot's runs IN PLACE; nothing is copied.
- bake the port into the two `ld (nn),a` operands by self-modification, so the
  write path carries no dispatch at all.
- **one `$2A` re-latch plus a BUSY poll per YM write is unavoidable** (~44 cyc)
  because the feed writes `$2A` blind. This is a direct input to the rewrite's
  per-sample slice budget: a slice must be able to hold ~113-160 cycles.
- order rules: per-port order is the transport's contract; a write may not cross
  its sub-tick boundary.
- measured cost: ~113 cyc/write bursted, ~236 through the optional machinery.

What stayed from that work, because it is independent and unconditional: the
burst path's **BUSY polls are inlined** (167 -> 113 cyc a write; a 95-write
frame 69.4k -> 64.3k), `pcm_debt`'s frame-constant half hoisted, `latch_bank`
skipping a bank already latched, the image-size gate, `npm run budget:frame`,
`npm run dac:clock`, and the `.mmb` sample-length defaults.

### 2026-08-06 — THE SAMPLE CLOCK. The pacing design does not work.

`npm run dac:clock` (new, `tools/dac-clock.mjs`). Nominal sample period at
R = 175 is 341 Z80 cycles. Measured, on the reporter's song and on a synthesised
steady tone:

    interval  min 41  p10 243  p50 243  p90 319  p99 3558  max 8213   (nominal 341)
    68% of samples arrive EARLY (<90% of nominal), 2.3% are held past 150%
    the DAC's instantaneous rate swings 0.4 kHz .. 87 kHz   (nominal 10.5 kHz)

**The median interval is 243 cycles — 29% short.** Two thirds of every frame's
samples come out ~40% fast, and the frame squares its average up by stopping.
A DAC does not average; it is a zero-order hold. So a steady 1 kHz tone comes
back with sidebands at multiples of the frame rate that are LOUDER THAN THE
TONE:

    offset        real    same bytes, uniform clock
    f0 + 1x60Hz   +5.1 dB        -48.3 dB
    f0 + 2x60Hz   +6.5 dB        -58.6 dB
    f0 + 3x60Hz   +7.9 dB        -64.0 dB
    f0 + 4x60Hz   +8.6 dB        -67.6 dB

Same bytes in both columns. The only difference is WHEN each was written. That
is the "プチプチ", it is the "テンポよれ" on anything pitched, and it is why one
PCM voice has never once sounded right while the frame sits at 92% of budget.

**Why, mechanically.** The pad is baked per loop copy as (period − that copy's
tick cost), so a SOUNDING copy gets 0-5 units and a MUTE/IDLE copy gets 14-16 —
and `pcm_debt` then subtracts a CONSTANT from all of them. At a typical debt of
5-6 units the sounding copy's pad clamps to the floor and the idle copies keep
8-10. The pass that produces the audio therefore runs completely unpaced, and
the silent passes stretch to make the frame come out with exactly R samples.
gen-mixer.mjs already states the first half of this ("the fetching loops have no
pad to take away… all of the frame's ~23,000 cycles of pad live in the MUTE and
IDLE passes") — as an explanation for why a per-fetch charge did nothing. The
conclusion was never drawn.

**No constant fixes it, and that is the point.** `PACE_RESERVE`, `PACE_SEG`,
`PACE_WINDOW`, the segment plan, the write pump — every one of them moves the
frame's AVERAGE, which every gate here measures, and none of them can make an
interval constant. To hold the interval, the ~12k cycles of per-frame overhead
(pass transitions, segment set-up, the frame head, the slot consume) must be cut
into slices small enough to fit BETWEEN two sample writes, and the feed has to
become the outer structure that dispatches them — not an interleave inside the
mix. That is the same inversion the write pump did for chip writes, applied to
everything, and it is a rewrite of the frame loop, not a tuning pass.

**Gate it before rebuilding it.** `npm run dac:clock` reports the interval
distribution and the tone's sidebands; `dac-gate` cannot see either, and it is
what let this ship. The target is a flat interval distribution — p10 = p50 =
p90 = 341 — and sidebands at the uniform-clock column.

### 2026-08-06 — the song ITSELF, profiled. Frames are NOT overrunning.

**Read the frame count before reading anything else.** Every tool here defaulted
to `--frames 240`, which is FOUR SECONDS, and every measurement in this session
was taken on it. A gate score is short and deterministic and four seconds is all
of it; a song's interesting frames are the loop point, the section change and
the dense bar, and it has none of those in its first four seconds. On this song
the worst frame-boundary hold reads **29.7 periods over 240 frames and 45.5 over
4000**. The defaults are fixed — `seg-bench`, `dac-gate` and `frame-budget` all
give a `.mmb` 4000 frames unless told otherwise, and `frame-budget` prints the
seconds covered — but the habit is the thing: state the sample length, or the
number is not a measurement.

`seg-bench ~/Developer/gendev/verify-hello-world/res/song.mmb --stall-read 14`
over the whole song:

    4000 frames (66.8 s), mean 54,650 cyc (92% of budget), worst 64,025 (107%)
    OVER BUDGET: 4/4000 (0.1%) — f0, f1 (score head), f788, f901 (100-101%)
    by PCM voices sounding: 0v 0/865   1v 4/3135

**So lost vblanks are not the cause of anything this song does.** That rules out
the whole family — the write pump, the 2-voice limit, the frame budget. The
frame has 10% of headroom and spends it on nothing.

What it does instead, from `npm run dac` on the same file, 3344 full frames:

    span 87% of the frame
    feed hold p50: in-frame 10.7 periods, FRAME BOUNDARY 23.2 periods
    feed hold MAX: in-frame 28.1,          FRAME BOUNDARY 45.5  (f788, f901)

The p50 is the continuous one — every frame, at 60 Hz. The max is two spikes in
56 seconds, at exactly the two frames that overran; those are the hardware's
"`lost` 4 at specific spots" and they are 4 ms holes, but twice a minute is not
what "プチプチ" describes. The p50 is.

**The DAC is frozen for ~18% of every frame, in two chunks, at 60 Hz** — 2.2 ms
at the boundary plus 1.0 ms mid-frame. A frame that finishes its R samples early
does not go quiet, it HOLDS its last value, so the unspent pad is not slack: it
is a periodic discontinuity at frame rate. That is the shape of "プチプチ", and
the same arithmetic explains the pitched wobble — the samples that do play come
out ~10% fast across the 87%, then stop.

**`PACE_RESERVE` 7200 -> 5600, measured, and re-measured over the whole song
after the 240-frame default was caught.** It was a safety margin nobody had
priced. 5600 is the last step down that costs nothing anywhere: 3-8 sample
periods off every score's boundary hold, every score's OVER BUDGET count
unchanged (song 4/4000, softmix 12, slice 6, pcmloop 2). The song reads 23.2 ->
20.5 periods p50 and 45.5 -> 42.8 max, span 87% -> 88%. The cliff is one step
below and it is steep at full length too: 5000 takes the song from 4 over-budget
frames to **428**.

**`PACE_SEG` is 2.36x its measured marginal cost (1,016) and must STAY there.**
Cutting it to 1,200 takes another 5 periods off the hold — but only off
segment-heavy frames, which are the multi-voice ones with no headroom:
m3-pcm-softmix goes 12 -> 179 over-budget frames. Measured, do not re-try.

**What blocks the rest is QUANTISATION, and that is the next lever.**
`paceDebt` rounds to whole 16-cycle pad units, and one unit is 16 x R = 2,800
cycles = 8 sample periods spread over the frame. There is no way to ask for
half a unit, so the tuning cliff is one unit wide: 5600 is safe and 5000 costs
the song 27 frames. The fix is free and per-PASS, not per-sample: keep the
remainder as well as the quotient and hand one extra unit to some of the three
passes (`debt_frac_tab[segs]`, compared against `G_PASS` in `pcm_debt`), which
takes the granularity from 2,800 to ~930-1,400 cycles and lets PACE_RESERVE come
down the rest of the way. ~40 cycles a bind. UNBUILT.

**And the tempo is a separate, already-documented thing.** With 2 lost frames in
240 the tempo cannot be drifting from lost vblanks. What remains is
[[plan-subtick-timing]] steps 2-3: **PCM note onsets are still on the 60 Hz
grid** while FM/PSG ride the three sub-ticks. If the rhythm is carried by the
PCM — and drums are the attacks — a 1/16 lands up to 3% long and a triplet up to
37%, at 128 BPM. That is the reported "テンポよれ" and it is a known unbuilt
item, not a regression.

### One piece landed regardless: the burst path's BUSY polls are INLINE

`cr_p0`/`cr_p1` called `ym_busy0`; a call/ret is 27 cycles on each of two polls
a write. Inlined, that is ~2.2k cycles back on a 40-write frame — spent while
the DAC is holding its last sample. A 95-write frame went 69.4k -> 64.3k. On in
every build, pump or no pump.

### THE CORRECTION: the median hold was never the chip writes

The entry above this one attributed both holds to `cs_runs`. **Profiled, that is
wrong** — and the profile is `scratchpad/gap.mjs`-style PC sampling over the
largest `$2A` gap of each frame, which is what should have been run first.

On the baseline, the median in-frame gap is 3,643 cycles and `cs_runs`
contributes 159 of them. The rest is the **voice-pass transition**: `voice_ptr`
286, `ms_load` 227, `pcm_debt` 200, `pv_sh` 172, `mvf_planr` 149, `mix_seg` 137,
`pp_act_next` 123, `mvf_idle` 123, `ms_bind` 106 … ~3.4k cycles of per-pass
set-up during which no sample is fed. Only the WORST frames' gaps were the
writes, which is exactly what the pump fixed.

So the next piece of work is not another transport idea: it is the (1)+(2)
per-segment/per-pass cost already listed in this file. Concretely, the largest
single items to attack are `ms_load` (the idle path still round-trips the voice
struct per segment), `pcm_debt` (recomputed per bind for a value that moves
once), and the voice-pointer arithmetic in `pp_voice_at`/`pv_sh`.

**And it is the same work that would pay for the pump**: those cycles are both
the median DAC hold AND the frame overhead that leaves no room for the pump's
~123 cycles a write. Cut ~3k a frame there and `PUMP_ON = 1` becomes a real
option — which is why the pump is parked behind a switch rather than reworked
or deleted.

## External data point 2026-08-06 — 吉村ことり's Mega Drive driver

Reported by the user (Star Cruiser etc.; driver + editor in progress):
**PCM 8 voices fixed-pitch <-> PCM 2 voices with pitch, SWITCHABLE**, plus FM 5
and SSG 3. Not verified by us — no results seen, the source post is behind a
login.

Why it matters here: that switch is the same axis this project already agreed
on (1 variable + 2 fixed, "the feature bill, not the architecture"). It is
independent confirmation that fixed-vs-pitched is THE lever for PCM voice count
on this machine, and the 8:2 ratio says the gap is far wider than our estimate
(pitched ~88 vs fixed ~51 cyc/voice/tick, only 1.7x). If fixed-pitch really
buys 4x, our "2 fixed voices" target is conservative and the fixed inner loop
deserves its own cost design rather than being a resampler with the resampler
removed.

What it does NOT answer, and what to look for if his work becomes visible: any
driver feeding a software-mixed DAC has to interleave the frame's chip writes
without stopping the feed — our measured wobble (in-frame 10.7 sample periods,
boundary 15.3). Voice count and feed uniformity are separate problems; his
voice count says nothing about how he solved the second one, and that is the
part worth learning.

## 2026-08-06 — MDSDRV / XGM2 の実コード調査(決定を変える3点)

読んだのは実アセンブラ(MDSDRV `src/mdssub.z80`+`mdsdrv.68k`、XGM2 は
`Stephane-D/SGDK` の `src/snd/xgm2/drv_xgm2.s80` + `*.i80`)。README ではない。

1. **どちらもリサンプラを持たない。** MDSDRV = 8段の離散レート(`nop`/`inc hl`
   を自己書き換えでばら撒く、N/8 の整数分周)、2声@18kHz または 3声@13.5kHz。
   XGM2 = 等速 or 半速のみ、基準レートは全チャンネル共通。我々の 16.16
   リサンプラは両者より高機能で、声数の差はその請求書。決定5の分析が実コードで
   裏付けられた。
2. **XGM2 の DAC ペーシングは YM Timer A のフラグポーリング**
   (`drv_xgm2_pcm_mac.i80` `sampleOutput`: `BIT 0,(HL) / JR Z,.wait` →
   `$2A` 書き込み)。サイクル計算のパッドは存在しない。レートはチップが強制し、
   ドライバの義務は「十分な頻度で `sampleOutput` に到達すること」だけ。
   **これは我々の PACE_SEG / PACE_RESERVE / pcm_debt / パッド量子(8.2周期)を
   まるごと置き換える。** 我々は Timer B を「計測器」としてしか検討しなかった。
3. **XGM2 の設計規則: `sampleOutput` 間は最大 ~168 サイクル。** 29レジスタの
   音色ロード(`FM_loadInst`)の中に 16 個、V-int ハンドラの中に 8 個、DMA 待ちの
   ポーリングループにも入っている。つまりライトポンプの正解は「1周に1書き込み」
   ではなく「コード全域で 168 サイクルごとに DAC を出す」。我々のポンプが失敗した
   のは 1書き込み 236 サイクルにしたから(ビジーポール追加)。XGM2 はタイマーが
   ゲートなのでブラインドで書ける。
4. 劣化の優先順位が逆。XGM2 は **DAC を守り音楽フレームを捨てる**
   (`MISSED_FRAME++`、バッファ150未満でフレーム処理を飛ばす)。我々は逆に
   フレームを守って DAC に穴を開けている。MDSDRV は 68k がバスを掴む間 Z80 が
   止まるので、キーオン+音色転送で **最悪 ~313us = 5-6サンプル周期の穴を許容**
   している。つまり穴自体は許容範囲の概念で、我々の 14-20 周期は約3倍大きい。

**次の一手(証拠付き): DAC のペーシングを YM タイマーに移す。** 決めるべき衝突が
一つ — CSM が Timer A を使っている。Timer B は空いているが分解能が粗い
(Timer A = 12x(1024-TA)/clk、Timer B = その 16 倍刻み)ので 10.5kHz を正確に
出せるか要検証。CSM と Timer A のどちらを取るかは設計判断。

## Timer-B pacing + sample ring — PARAMETERS LOCKED 2026-08-07 (decided: try it)

CSM keeps Timer A, so pacing rides Timer B. All numbers below are derived, not
measured; they are the spec the implementation works to.

    YM2612 NTSC FM sample rate      53267 Hz   (7.67 MHz / 144)
    Timer B step                    16 FM samples = 300.37 us  (Timer A x 16)
    TB = 255  (k = 256-TB = 1)      one gate every 300.37 us = 3329.2 Hz
    GROUP = 3 samples per gate      PCM rate = 9987.6 Hz   (was 10483)
    Z80 cycles per sample           358.4  (was 341 — 5% MORE room per sample)
    Z80 cycles per group            1075.2
    frame = 16.6882 ms              55.56 gates = 166.68 samples per frame

**Samples per frame is 166 or 167, never constant** — that is the whole reason a
ring is mandatory, and why both MDSDRV and XGM2 have one and we do not. Nothing
about G or k removes it: frame rate and 53267 Hz are not nicely commensurate.

Gate placement: emit at the gate, then 2 more samples cycle-paced. The timer
pulls the phase back every 3 samples, so pad error cannot accumulate — the pad
quantum (16 cyc) only ever spans 2 samples. **Hole bound = 1 gate = 3 sample
periods** (measured today: 14-20). Larger GROUP keeps 10.5 kHz (GROUP 19, k 6 =
10542 Hz) but re-admits drift across the group; 3/9988 is Timer B's best point.

Ring: 256 B, replacing the 2 x 256 B double-buffered planes at $1700-$18FF (net
-256 B of RAM). Thresholds to copy from XGM2's shape: refill below ~192, and
**drop a music frame rather than a DAC sample** below ~150 — the opposite of
this driver's current priority, and the one both reference drivers chose.

What is deleted with this: `PACE_SEG`, `PACE_RESERVE`, `pcm_debt`, `debt_tab`,
`pad_first_tab`/`pad_add_tab`, `G_DEBT`/`G_NSEG*`/`G_PAD`, `pace_win_tab`, the
whole per-frame overhead estimator, and the plane swap. The segment plan (§6.3.1)
SURVIVES and gets easier: the mixer produces into the ring in chunks, so a
segment no longer has to align with a frame's tick count.

Build order (JS first so quality is a number before any Z80 is written):
1. `drv-player.js`: ring + Timer-B-timed consumption model; `PCM_MIX_RATE` ->
   9988-equivalent (166/167 per frame). Keep the DAC value log so the existing
   zero-tolerance comparison survives the rate change.
2. `dac-gate.mjs`: drive the model, assert the hole bound (<= 3 sample periods)
   and no underrun. This is the number that decides whether to continue.
3. Only then the Z80: `sampleOutput` macro (BIT poll on $4000 status bit 1 for
   Timer B overflow, reset via $27), ring producer/consumer, delete the pacing
   machinery above.
4. Re-freeze every gate baseline; `PCM_MIX_R` changes so all DAC streams change.

### Step 1 LANDED 2026-08-07 — the ring is in `drv-player.js` (the port spec)

`live/src/mmb.js` + `live/src/drv-player.js`. `PCM_MIX_RATE` is GONE; the sample
clock is a rational, not a count:

    PCM_SAMPLES_NUM/DEN = 37335/224 = 166.674 samples a frame  (896040/5376)
    pcmSampleIndex(frame), pcmFrameSamples(frame) -> 166 or 167
    PCM_RING_SIZE 256, PCM_CHUNK_MAX 192
    pcmTickIncrement now divides by the AVERAGE (x224/37335), not by 175

Measured on the PCM gate scores (m3-pcm-softmix, m2-pcmloop, m3-pcm-slice,
m2-pcm, m3-pcm-vol, m3-fm6-pcm): every feeding frame's count is exactly
`pcmFrameSamples(frame)`, 0 off-schedule, **0 underruns**, `$2B` claim/release
edges unchanged in shape. Pitch is preserved and slightly better quantised:
worst per-frame advance error 41.7 ppm (0.072 cents) against 175's 48.9 ppm.

Four decisions taken while implementing that the locked parameters did not name:

- **Feed first, then mix, inside `_pcmFrame`.** That ordering IS the one frame
  of latency — the frame's chunk is not final until its last voice pass, so the
  feed can only drain what the previous frame produced. §4.2's one-frame PCM
  lead still cancels it. Mixing first would have silently deleted the lag and
  put PCM a frame ahead of the score.
- **Chunk = min(192, 256 - fill)**, i.e. top the ring up, capped. Uncapped, a
  burst's opening frame mixes all 256 (1.5x a steady frame) — a lost vblank at
  every note start. Capped, the fill climbs to the 256 ceiling over ~4 frames
  and then sits between ~89 and 256; the ~89 floor is the jitter margin that
  the old frame-boundary hold (23 periods, p50) was eating.
- **The chunk length is the SEQUENCER's.** The segment plan is tick distances
  off the 68k's own voice positions, so the engine must mix exactly what was
  planned or the two desync. The ring's fill absorbs the model-vs-timer phase
  error; an overrun that exhausts it must DROP samples, never shorten a chunk.
- **Underrun = a dry ring with the mixer still running.** The two dry rings that
  are not underruns: the claim frame (the opening frame of silence) and the
  frame a tail runs out in. Both are written as silence, which closes a burst
  without the DC hold. Without that distinction m2-pcm reads 464 "underruns"
  that are just short shots ending.

Gate fallout, expected and left red on purpose: `npm run c-gate` and
`npm run slots` FAIL on PCM scores (the 68k C and the Z80 both still mix 175 a
frame — c-gate's first divergence is the `PCM_START` increment, byte 17 of f0).
Non-PCM scores stay byte-identical; `ab-gate`, `ring`, `selftest` green. The C
mirror is ~20 lines (a fill counter + a remainder accumulator + a 64-bit
divide) and is the cheapest thing to do next if a green c-gate is wanted before
the Z80 work; note the slot must then carry the chunk length for the engine.

### Step 2 + the 68k C mirror LANDED 2026-08-07

**`npm run dac:model`** (`drv/tools/dac-model.mjs`, new) is step 2's gate. It
drives `drv-player.js` and asserts what `npm run dac` structurally cannot see
now that a timer, not the engine, decides when a sample goes out: schedule
integrity (every feeding frame takes exactly `pcmFrameSamples(frame)`), zero
underrun under a running mixer, and the ring's SLACK. Over the six PCM gate
scores and `verify-hello-world/res/song.mmb` (4000 frames, 592,191 samples):

    0 off-schedule, 0 underruns, fill peak 256/256
    slack 89 samples = 8.9 ms steady, 25 = 2.5 ms at a burst's 2nd frame

Two metric definitions took a try to get right, and both are worth keeping:
slack is only meaningful **in frames the mixer ran in** (a ring emptying under
an idle mixer is a burst ENDING, not starvation — counting those read -167) and
**not on the claim frame** (empty by construction; that is the opening frame of
silence). Without both filters the gate reads FAIL on healthy scores.

**89 samples does not cover a lost frame (167), and cannot at 256 B** — the fill
has to peak a whole chunk above its floor, so covering one would need ~512 B.
The consequence: the XGM2-derived "drop a music frame below ~150" threshold is
meaningless at this geometry (the fill sits at ~89 EVERY frame, so it would fire
always). The rule that survives is the plain one: **PCM mixing outranks the
slot**; a frame that cannot do both drops the music frame. If a 512 B ring is
ever wanted, it costs exactly the RAM the two planes used to (net 0 vs before
this change) and buys cover for one lost vblank — an open, priced option.

**The 68k C mirrors the ring** (`68k/mmlispseq.{c,h}`): `pcm_fill` + `pcm_sched`
(a 151/224 remainder accumulator, advanced BEFORE any early exit or the schedule
slips a frame whenever the DAC is idle), feed-then-mix ordering, the same
`min(192, 256-fill)` chunk, and `pcm_tick_increment` via the exact 32-bit
identity `floor(a*b/c) = (a/c)*b + floor((a%c)*b/c)` — no 64-bit divide on the
68000. **`npm run c-gate` 41/41 byte-identical.**

Left: the Z80 (step 3). Two expected reds until it lands, both the same cause —
the engine is handed plans measured against a chunk length it does not mix:
`npm run slots` on every PCM score, and `npm run dac` on m3-pcm-slice (91%
paced, worst wander 6.40 ms against 3.54 before). `verify:all` stops at the
first. Everything else is green: selftest, engine, ring, c-gate 41/41, ab-gate,
sgdk:lint, dac:model.

**Do not re-copy the 68k C into an SGDK project before the Z80 lands** — a
project running the new `mmlispseq.c` against the shipped `mmlispdrv_bin.h`
would have the two sides disagreeing about the chunk (5% pitch error and wrong
loop points). `npm run sgdk:install` copies mmlispseq.c/.h + tables.c, and all
three moved in this change. The engine also
needs the chunk length; it is not in the slot format yet, and the cheapest place
is beside the segment plan in the frame head (§6.2).

### 2026-08-07 — designing step 3 broke two locked parameters. Corrected.

Both were found by working the Z80 loop out on paper before writing it, and both
are already fixed in the reference + the 68k C (c-gate 41/41, dac:model green).

**1. The 256 B ring cannot work, and the arithmetic says so in one line.** The
mixer is voice-outer, so while a chunk is being built NONE of it is playable —
and the finished samples must still be there to play. Both regions are live:
`fill + chunk`. The feed takes `want` during a frame whose chunk is not ready
until its end, so `fill >= want = 167`; and `fill + chunk <= RING`. With
chunk = want that needs RING >= 334. **512 B buffer, 256-sample lead**
(`PCM_RING_BYTES` / `PCM_RING_TARGET`). It is exactly the two planes' footprint,
so it costs nothing against what it replaces — the "net -256 B" line was written
before the two-region requirement existed. The only way to a 256 B ring is
BLOCK-WISE mixing (3 voices over <=128 samples, then the next block), which
triples the ~3.2k-cycle voice-pass transitions to save RAM the engine has spare.
Rejected on that trade, and priced here so it is not re-proposed.

**2. The chunk cap / 4-frame ramp had to go.** The engine emits one sample per
three mix ticks, so ticks-mixed and samples-fed are THE SAME NUMBER. A frame
that mixes 192 while the feed owes 167 would have to wait out 25 extra gates and
lose its vblank — a dropped frame at every burst start. So: **chunk = want,
always**, and the lead is built by a PRIME frame (any frame starting with an
empty ring) that mixes `PCM_RING_TARGET` and feeds nothing but a single silence
byte to park the DAC. Consequences, all measured with `npm run dac:model`:
slack is a constant 89 samples (8.9 ms) from the first fed frame — the ramp's
2.5 ms dip at a burst's second frame is gone — and the price is the prime
frame's 256-tick mix (1.5x a steady frame's), one per burst: 210 of them over
the song's 4000 frames. Fine at 1-2 voices; a 3-voice simultaneous burst start
is the one frame that can overrun.

**Still open, and it wants the hardware judgement, not the code's:** Timer B
gates every 3 samples, so the emit needs to know which of the three it is. The
cheapest form is a phase counter at the emit site (~30 cyc/emit, ~5k a frame,
8%) — no code-size growth, CSM keeps Timer A. The alternative is **Timer A at
1:1** (step = 144 YM clocks = one FM sample; 5 steps = 10653 Hz, a BETTER rate
than Timer B's 9988, and no phase counter at ~28 cyc/emit) at the cost of CSM,
which cannot share it: reprogramming Timer A to 94 us keys FM3 at 10.6 kHz.
Default taken: **Timer B + phase counter**, because it breaks nothing.

Also settled for the engine, both engine-local: the flag reset writes `$27`,
which also carries the CH3/CSM mode bits, so the engine SNOOPS `$27` in the
port-0 run loop and merges (bits 6-7 the sequencer's, 0-5 its own); and the slot
gains one frame-head byte for the chunk length, so a starved frame can fall back
instead of guessing.

### 2026-08-07 — the model that had to be built to hear it, and what it proved

`npm run dac:wav` (`tools/dac-wav.mjs`, new) renders the DAC as .wav by
zero-order hold: **a-today** is the committed engine MEASURED (built and run out
of a detached `git worktree` of `--baseline`, default HEAD, so a half-converted
tree cannot contaminate it), **b-timerb** is the Timer-B design modelled from
this repo's own measured costs, **c-nopad** is that design with one rule
forgotten, **d-flat** is a perfect clock. On the synthesised tone:

    sideband at 1x/2x/3x the frame rate, dB relative to the tone
    a-today   +3.6 / -5.2 / -19.6      <- the 1x sideband is LOUDER than the tone
    b-timerb  -28.5 / -33.8 / -39.9
    d-flat    -28.3 / -35.0 / -40.5    <- b IS the flat clock, to within noise
    interval p10/p50/p90: today 243/243/319 cyc, b 358/358/358 (nominal 358)

**Building it proved the thing that reshapes step 3.** A frame's emission span
IS the frame: 166.674 samples x 358.4 cycles = 59,736 = one frame, by
construction. So a cycle spent NOT emitting is not a hole to catch up from
later — it is a sample that never goes out, and Timer B cannot give it back
because the overflow flag is ONE BIT: however many gates were missed, the engine
gets one group and then the gate rate again. Modelled with the emit only inside
the mix loop (the "stage 1" this file proposed), every frame slipped ~5k cycles
and the render was unlistenable.

Therefore **the "<=1 sample period between emits, EVERYWHERE" rule is mandatory
from the first line, not a later polish stage** — the slot's chip-write run, the
voice-pass transition, the segment set-up and the frame head all carry emit
points. That is XGM2's "<=168 cycles between sample outputs everywhere",
arrived at from the other end. Consequence for the loop structure: emits are no
longer 1:1 with mix iterations, so the frame needs an EMIT BUDGET counter
(samples still owed) that every emit point decrements, and the mix loop's emit
becomes conditional on it.

Second consequence: **Timer B gates only every third sample and the Z80 cannot
read a clock, so samples 2 and 3 of each group are paced by CODE PLACEMENT.** A
loop copy cheaper than a sample period (mute/idle: ~100 cyc against 358) bunches
its three against the gate unless padded. So the baked per-copy pad SURVIVES the
timer — as a constant, with none of the debt/estimator machinery. Measured cost
of forgetting it (c-nopad): a few dB at 3x the frame rate and no frame-rate
sidebands at all, i.e. real but second-order — worth doing, not worth blocking on.

The 3-voice limit shows up here too and unchanged: on m3-pcm-softmix the model
reports 6 frames in 600 costing more than a frame (lost vblanks).

### 2026-08-07 — the judgement call, and what the spec is aiming at

**Heard and accepted** ("思ったより いいよ"), so step 3 proceeds on Timer B. The
listening set is `npm run dac:wav`; the file that settles it is **a-today vs
a2-flat — the same bytes, uniformly clocked**, because that isolates the clock
from every other difference. On the synthesised 1 kHz tone:

    partial          1000 Hz   1420 Hz   +-60 Hz
    a-today (real)    -27.3     -18.8    -23.3 / -22.8
    a2-flat (same     -11.0     -79.6    -54.2 / -53.0
    bytes, uniform)

i.e. today a SPURIOUS partial 40% sharp is 8.5 dB LOUDER than the note being
played, and the frame-rate sidebands are louder than it too. Uniform: the note
gains 16 dB and everything else falls 40+. That is the whole case, in one A/B.

**The spec the work is aiming at**, from the per-sample budget at 9987.6 Hz
(358.4 Z80 cycles a sample; mix priced from gen-mixer's own model at shift 0,
+8 cyc per shift step per voice):

    voices  mix   emit  frame overhead  ROM stall  total  max rate
      1      69    90        105           14       278   12.9 kHz
      2     143    90        105           28       366    9.8 kHz
      3     217    90        105           42       454    7.9 kHz

So: **3 slots, 2 sounding, 9988 Hz, 8-bit, nearest-neighbour, saturating add,
flat clock.** 2 voices land at ~102% of the sample budget — the ~10 cyc/sample
that closes it has to come out of the 105 of frame overhead (chip writes 27,
voice-pass transitions 45, segments 30), not out of a constant. 3 voices need
the rate down at ~8 kHz (Timer B point k=5,G=12 = 7990 Hz).

**DECIDED: voice count and rate become per-song settings** ("同時発音数と音質は
設定できても良さそう"). Not yet built — but nothing may hardcode the rate from
here on: the 68k computes increments from it, the Z80's Timer B config is two
bytes ($26/$27), and the ring geometry scales with it. `PCM_SAMPLES_NUM/DEN`
in mmb.js is the single source; keep it that way.

Landed for it already: **the slot carries `chunk`** — a new frame-head byte
after `n_writes`, 0 meaning a prime frame (driver.md §6.2). c-gate 41/41 with it.

**One sizing note for whoever writes the emit block:** inline it is ~30 B x 20
loop copies = ~600 B against 440 B of image headroom, and making it a `call`
costs ~27 cyc/emit (4.5k a frame) which takes 2 voices from 102% to 110% of
budget. The order that resolves it: DELETE the pacing machinery first
(`div_tab` alone is 176 B, plus `debt_tab`, `pad_*_tab`, `pace_win_tab`,
`pcm_debt`/`pcm_debt_base`), which returns ~400-500 B, and only then inline.

### 2026-08-07 — the two cursors, and why the ring wraps at SEGMENT boundaries

Writing the emit block ran straight into the thing that decides the ring's
shape, so it is settled here before any asm exists.

A 512-byte ring has two cursors in it and both have to wrap:

- the MIXER's is HL, and the body's `inc l` only wraps inside a 256-byte page;
- the FEED's is IY (`ld a,(iy+0)` / `inc iy`), and `inc iy` walks straight out
  of the ring's top instead of round to its base.

Everything cheap needs undocumented opcodes — `inc iyl` sets Z on the wrap in
8 cycles — and **`tools/z80asm.mjs` deliberately does not assemble them**
("Not supported (deliberately): … undocumented opcodes"), nor does z80cpu's
`stepIndex`. Teaching both is possible; doing it to save cycles in one loop is
how a first-party toolchain stops being trustworthy.

Everything documented is expensive per sample: reading IYH at all costs
`push iy` / `pop hl` (24 cycles), and a page flip in the mix body would put
+7 cycles on every one of ~500 tick bodies (3.5k a frame).

**So neither cursor wraps in the hot path. Both wrap at SEGMENT boundaries.**
The mixer already splits a pass into segments at the plan's breaks and the ROM
window's top, and the machinery for "how many ticks until X" is exactly what a
bound is — so the ring's page edge and the feed's ring top become two more
bounds. Cost: a compare per segment (~5-10 a frame), and one extra segment per
256 samples (~0.65 a frame). Per sample: nothing.

Consequences to carry into the code:
- `mvf_seg`'s bound becomes `min(plan break, window top, mix page edge,
  3 x samples to the feed's ring top, ticks left)`.
- IY is loaded once a frame and reset to the ring base at the segment boundary
  that hits the top; H is set per segment for the same reason.
- The 512-byte ring must be 512-ALIGNED, so a page edge is `L == 0` and the
  page bit is one bit of H.

Rejected on the way, with the reason, so they are not re-proposed:
- **two 256-byte planes swapped per frame** (today's shape, no wrap at all):
  the lead is then exactly one frame and the slack at the frame boundary is
  ZERO, which is the artifact this whole change exists to remove.
- **feed cursor = mix cursor XOR $100** (the lead is half the ring, so the two
  addresses differ in one bit): the mixer advances 3 positions per emit in a
  voice-outer pass, so there is no constant offset between them.
- **SP as the feed cursor** (`pop` reads two samples in 10 cycles): the mixer
  calls, so the stack is not free.

### 2026-08-07 — step 3 STAGE A landed: the debt is gone, the pads are baked

`gen-mixer.mjs` + `engine.z80`, and the tree still assembles and gates:

    engine image 4424 -> 4186 B, headroom to $1300 440 -> 678 B
    npm run engine: 12/12 scenarios pass
    deleted: PACE_RESERVE, PACE_SEG, PACE_SEG_MAX, paceDebt, debt_tab,
             pace_win_tab, pad_first_tab/pad_add_tab, ms_set_pad, pcm_debt,
             pcm_debt_base, G_DEBT, G_DEBTC, G_NSEG, G_NSEGF, G_NIDLE, G_PADN,
             G_PAD and the per-segment segment counter
    added:   SAMPLE_CYCLES = 358 (2304 YM clocks / GROUP, x7/15), PCM_GROUP,
             PAD_TARGET = SAMPLE_CYCLES - 16, EMIT_CYCLES = 49

**`PAD_TARGET` is one quantum SHORT of the period on purpose.** A loop padded to
the exact period could never give back the cycles the frame spends outside it
(the slot's writes, the pass transitions) — it would fall behind by them every
frame for ever. The gate bounds the other direction for free, since sample 1 of
each group waits for Timer B anyway. This is the one number here that is a
judgement rather than a measurement; `npm run dac:wav` re-judges it.

**And the pads exposed the next problem, which is real and structural.** With
the ROM-window stall charged where it belongs (in the tick, not in a debt), one
unrolled iteration — 3 ticks + emit + `dec b`/`jp nz` — costs:

    shift   0    1    2    3    4    5    6    7   mute  idle
    cycles 339  363  387  411  435  459  483  507  340   339   (period 358)

So **only an UNATTENUATED voice keeps up at 3 ticks per emit.** Every 6 dB of
attenuation is 8 cycles a tick on the `sra` chain, 24 an iteration, and at
shift 1 the pass is already 1.4% slow, at shift 7 it is 42% slow. The mix work
per emit, not the frame's total, is what has to fit — that is what a clock
means.

Two ways out, and the second is the one to build:

- vary the unroll per copy (U ticks per emit, U = (PAD_TARGET-63)/tick). It
  works per pass but the three passes must satisfy `sum(1/U_pass) = 1` or the
  frame stops emitting exactly `chunk` samples, so U cannot be a property of a
  copy alone. Rejected as a first move.
- **a runtime pad on the IDLE and MUTE copies only.** They are the passes with
  slack (their iteration is 339 against a 507 worst case), they run last, and
  everything their pad needs is known AT FRAME START: the shifts, the chunk, and
  the slot's write count. One divide a frame, no estimation, no carry-over from
  the previous frame — the debt's job without the debt's guesswork. It also
  degrades correctly: three sounding voices leave no idle pass to absorb
  anything, which is exactly the case that already does not fit.

Remaining for step 3: Stage B (ring + Timer B + prime/steady + the chunk byte
the slot already carries), Stage C (that runtime idle pad), Stage D (emit points
in the slot-consume loop and the pass transitions, the <=1 period rule).

### 2026-08-07 — step 3 STAGE B: the ring and Timer B are IN, one bug open

`engine.z80` + `gen-mixer.mjs` + `engine-gate.mjs`. The engine now assembles at
**4649 B (215 B headroom)** and runs on the timer; **4 of 12 engine scenarios
pass**, the other 8 fail on one localised bug (below).

What landed:

- **512 B sample ring at $1A00**, 512-aligned, replacing the two planes.
  `G_RD`/`G_WR`/`G_FILL` + `G_WRP`/`G_WRI` (the frame's write base, restored per
  pass because every pass covers the same chunk).
- **Timer B**: `$26` = 255 and Load B at boot; `gate_step`/`gate_wait` — one
  emit in GROUP holds for the overflow flag, the other two are placed by the
  baked pad. The phase counter is continuous across frames.
- **`$27` is snooped** in the port-0 run (`cs_r27`): bits 6-7 are the score's
  CH3/CSM, bits 0-5 the engine's, and the gate's flag reset has to write the
  same register. It re-latches `$2A` afterwards because the feed writes blind.
- **prime / steady / tail** in `process_pcm`, with the fill settled at the
  decision rather than at the frame's end; the slot's `chunk` byte read in
  `consume_slot`; `PCM_RING_TARGET` = **255**, not 256, because a pass's tick
  count is a byte.
- **Neither cursor wraps in a hot loop**: `mvf_ringcap` bounds a segment by the
  mixer's page edge and by 3x the feed's distance to the ring top, and the
  wrap/page-step happens at the segment boundary (`feed_wrap`).
- `engine-gate` now **models Timer B** (status bit 1 rises GATE_CY after the
  last reset; the `$27` bit-5 write advances it), encodes the chunk byte, and
  its expectation model is the ring — including the sequencer's own tick count,
  which is TARGET while the ring is empty and the chunk after.
- **`WATCH=<hex>`** in engine-gate names the code that wrote a RAM byte. It is
  what localised the bug below in one run, and the ring's cursor bugs are
  invisible in the DAC stream until several frames later.

**That bug: FOUND and FIXED.** The ring-edge block was inserted immediately
before `mvf_wtop`, and `mvf_seg`'s LEFT-clamp does `jr nc,mvf_wtop` — so the
common path (no clamp) **jumped straight over the page flip**, and a segment
that had stopped on the page edge carried on writing into the base page, over
the samples the feed had not read yet. It now sits immediately after
`call mix_seg_live`, before anything conditional. **12/12 engine scenarios
pass**, and `npm run slots` is byte-exact on ab-core again.

The lesson is about the tool, not the bug: `WATCH=<hex>` in engine-gate (and now
slot-gate) prints who wrote a RAM byte, and it took this from "the DAC is wrong
several frames later" to a program counter in one run. Both cursors' bugs look
like that, so reach for it first.

One trade taken to fit the image: **the emit's phase step is a `call
gate_step`, not inline** — inline costs 11 B in each of 20 copies (220 B) and
the image had tens to spare. It is 27 cycles an emit, so it comes back per copy,
hottest first, once the frame budget is measured.

### 2026-08-07 — STAGE B is in: the engine runs on Timer B

    npm run engine   12/12 scenarios         image 4654 B (210 B headroom)
    npm run slots    ab-core byte-exact; PCM scores match for 60 FRAMES
                     (10,090 samples) then diverge — see below
    npm run c-gate   41/41                   npm run dac:model  green

`slot-gate` and `engine-gate` both model Timer B now (status bit 1 rises
GATE_CY = 1075 cycles after the last reset; the `$27` bit-5 write advances it to
the next multiple, because the timer free-runs). Two register-ownership rules
came out of it and are in both harnesses: **`$26` is never the sequencer's**,
and **`$27` is compared by its mode bits alone** (bits 6-7 the score's CH3/CSM,
0-5 the engine's Load B and flag reset) — plus the engine's boot writes are not
part of any frame.

**The one open divergence.** On m2-pcmloop the engine's DAC stream is
byte-identical to `drv-player` for 10,090 samples and then, at the FIRST sample
of frame 60's chunk (ring position $1B69), the engine mixes **0** where the
reference has 67. The writes around it are contiguous and single (one voice, so
the two idle passes correctly add nothing), so nothing is being skipped or
double-written — the first tick of that chunk simply mixed silence. Suspects, in
order: a 1-tick segment at a chunk boundary binding the MUTE copy; a loop wrap
landing on the frame boundary and the engine taking it one tick early; the
`forced progress` path in `mvf_ringcap`. `WATCH=1b60` in slot-gate prints the
window; the next step is the same trick on the reference side to see which tick
the two disagree about.

Still to do after it: Stage C (the runtime idle/mute pad), Stage D (emit points
in the slot-consume loop and the pass transitions), then re-freeze the gates and
re-run `npm run dac:wav` to hear it.

### 2026-08-07 — the install path was BROKEN by the ring, and is fixed

`tools/build-engine.mjs` asserted the image against **`MIXLO`**, the mix planes'
base — which the ring deleted — so `npm run sgdk:install` died with
"engine.z80 defines no MIXLO" before copying anything. It now asserts against
**`HDR`**, which is the real ceiling and the one address the 68k compiles in:
growing past it overwrites H_HEAD/H_TAIL and the slot ring with code, which
presents as the mixer executing data. `headroom` is now measured to the header
too (210 B at 4654 B).

The FILE LIST needed nothing: `install-sgdk.mjs` already copies
`mmlispdrv_bin.h` + `68k/mmlispseq.c` + `68k/mmlispseq.h` + `68k/tables.c`, and
its staleness check regenerates the image (it reported `4424 -> 4654 B`).
`npm run sgdk:lint` is green. **All four must move together** — the C and the
Z80 image now agree about the ring, the chunk byte and `$27`'s ownership, and a
project with one old and one new is a 5% pitch error and wrong loop points.

### The remaining slot-gate divergence, narrowed

On m2-pcmloop the engine matches `drv-player` for 10,090 samples and then
**drops exactly one sample** — the reference's stream has a 195 the engine's
does not, and everything after is the same sequence shifted by one. What is
ruled out, each by measurement rather than reasoning:

- **not a tick-count error.** Ring writes per frame are 167/166/167/167/166,
  exactly the schedule (`COUNT=1 node tools/slot-gate.mjs …` prints them).
- **not a read past the sample bank.** `PROBE=1` makes an out-of-range read
  return $55 instead of 0; the stray sample stays 0, so it is a real sample
  byte.
- **not the LEFT clamp** (a segment consuming more than the boundary): a probe
  counter on that path never fired.
- **not a ROM window crossing**: no bank bits are shifted anywhere near it.

So one tick advanced the position twice, or a loop wrap subtracted one too few,
and it happens once in ~10k samples. The tooling to finish it is in place:
`COUNT=1` also prints the engine's `PV_PTR/PV_FRAC/PV_LEFT` beside the
reference's per frame — but BEWARE, the two are not the same frame (the engine
consumes a slot up to RING_DEPTH frames after the sequencer emitted it), so they
have to be aligned by matching fractions before the numbers mean anything. That
alignment is the next step.

### 2026-08-07 — STAGE B COMPLETE: `npm run verify:all` is GREEN on the ring

Every value gate passes: **engine 12/12, slot-gate byte-exact AND
"the mixers agree sample for sample" on every PCM score, c-gate 41/41, ring,
ab-gate, sgdk:lint, dac:model.** Image 4643 B.

Three bugs closed after the ring landed, all of them state-machine edges:

1. **The prime frame's length disagreed** — `PCM_RING_TARGET` was 255 in the
   engine (a pass's tick count is a byte) and 256 in mmb.js/the C. One extra
   tick in the reference, once per burst, which showed up 10,000 samples later
   as a single dropped sample. **255 everywhere now.**
2. **`$2B` was released when the last VOICE ended, not when the RING ran dry** —
   so a tail toggled fm6 back to FM and re-claimed it the next frame (16 edges
   against 8).
3. **The write cursor is DERIVED, not stepped.** A tail frame feeds a chunk and
   mixes silence, so `read` and `fill` do not move together and `G_WR += chunk`
   drifted. It is now recomputed as `G_RD + G_FILL` at the frame's end, which is
   what "the mixer writes at read + fill" means and cannot drift.

Also settled: **a tail frame mixes SILENCE into the ring** (it stores, it does
not skip) so that a burst ends in silence rather than in whatever an earlier lap
left there — that is what makes the engine's blind `inc iy` agree with the
reference's fill-guarded read. And the slot carries the sample count on a tail
frame too, or the engine replays the last chunk and feeds 167 where the schedule
says 166.

**`npm run dac` now measures the right thing, and it says the frame does not
fit.** It models Timer B (like slot-gate and engine-gate) and its period is the
sample clock's, not the frame's:

    span 140% of the frame (worst 132%) · wander ~7 ms
    in-frame hold p50 8-10 periods, max 13-15

The values are right and **the frame takes ~1.4x too long** — exactly the
arithmetic that made Stage D mandatory, now measured instead of predicted. The
two levers, in order:

- **Stage C first, because it is the bigger one.** With one voice sounding, two
  of every three iterations are IDLE and each is padded to 342 cycles when its
  own work is ~75 — that is ~30k cycles a frame of pure padding. Sizing the
  idle/mute pad at runtime from what the frame has left (the shifts, the chunk
  and the slot's write count are all known at frame start) hands those cycles
  back to the head and the transitions.
- **Stage D then removes the HOLES** (the 8-10 period in-frame hold is the pass
  transitions) by putting emit points in the slot-consume loop and the
  transitions, per the <=1 sample period rule.

### 2026-08-07 — Stage C landed, Stage D partly, and the IMAGE is now the wall

**Stage C (the runtime idle pad) is in and it works.** `pcm_pad` sizes what an
IDLE iteration holds to, once a frame, from what the frame is doing: a
`pass_cost_tab` (generated: one pass's unpadded cost by shift) summed over the
three passes, subtracted from `PCM_BUDGET`, divided by the silent passes as a
SHIFT (896 -> 1024, 1792 -> 2048, 2688 -> 4096 — each rounds the pad down, and
down is the safe direction: an under-padded frame bunches a group slightly, an
over-padded one loses its vblank). Only the IDLE copies read `G_PAD`; MUTE keeps
its baked pad, and the sounding copies have none to give. Measured: span
**140% -> 127%** of the frame.

**Stage D is half in.** `feed_one` — the out-of-line twin of the loops' inline
emit — is called from the slot's YM write runs (**every fourth write**, ~450
cycles, near one sample period; every write was three times the frame's fair
share and starved the mix passes instead), and 2-3 times per voice-pass
transition. The accounting that makes it possible is per SEGMENT, not per
sample: `mix_seg_live`/`mix_seg` cap their iteration count by `G_EMITS` and
charge it in one subtraction, so the hot loop's emit stays bare and whatever the
loop may not emit runs through the single-tick copies. The frame's budget is
settled in `consume_slot`, BEFORE the head's writes spend part of it; a starved
frame (which never gets that far) re-arms it in `pp_emits`.

Gates: **engine 12/12, slot-gate byte-exact and sample-for-sample, c-gate 41/41,
dac:model green.** `npm run dac` reads span **128-133%**, in-frame hold ~10
periods.

**What is left, and what blocks it.** The remaining ~30% of a frame with no
sample in it is the segment set-ups (~5 x 1k, no emit points at all), the rest
of each pass transition, and the frame's fixed head. Each needs one more
`call feed_one` — and **the image has 4 BYTES of headroom** (4860 B against
$1300). That is now the binding constraint, not cycles.

The unlock is a **two-segment upload**: $0000-$12FF as now, plus a second span
at $1C00+ (the ring is $1A00-$1BFF and the stack tops at $1F00, so ~700 B is
free there). It cannot be one contiguous blob — that would zero the published
header, which the host may already have written H_SMPBANK into — so
`emit-bin.mjs` and `sgdk/mmlispdrv.c` have to upload two ranges. Cold routines
go there first (`pcm_pad` alone is ~120 B and runs once a frame).

### 2026-08-07 — Stage D in (minus one piece), `verify:all` GREEN including `dac`

**The image ceiling is gone.** Cold code — `pcm_pad`, which runs once a frame —
now lives at **`org $1c00`**, above the sample ring, behind a `CODE_END` label.
The blob spans the gap (7270 B) and that is safe: the host uploads BEFORE the
Z80 boots and writes H_SMPBANK after it, so zeroing the header on the way past
costs nothing. **The boot RAM clear had to stop at `RING_TOP`** — it used to run
to the stack and would have erased the routine it was about to call.
`build-engine`/`engine-gate` now check `CODE_END` against `$1300` and the blob
against the stack: **94 B free below the header, and ~700 B above the ring.**

**Stage D's emit points are in** at the pass transitions (3 per pass), the
segment bounds, `mvf_bound`'s wrap/window/plan work, and the silent pass's own
segment loop. Two ordering rules came out of it, both learned the hard way:

- **`feed_one` goes BEFORE `mvf_ringcap`, never after.** The bound is measured
  from IY, and an emit advances IY — computing the bound first let a segment
  overrun the ring's top by up to 3 ticks.
- The frame's emit budget is settled in `consume_slot` and must NOT be reset in
  `process_pcm` (only a starved frame re-arms it), or the head's emits are free
  extras.

**`PCM_BUDGET` = 42000**, tuned with `npm run dac`: what the LOOPS may take, so
the pad leaves room for everything they do not do. 46000 still reads 96-100%
paced; below 42000 the span stops moving.

    npm run verify:all — GREEN, exit 0 (engine 12/12, slots sample-for-sample,
    c-gate 41/41, ring, sgdk:lint, ab-gate, and `dac` now 96-100% paced,
    wander 3.7-4.3 ms against the old design's 2.5 ms of a wrong clock)

**Two things are left, and both are named.**

1. **The frame still costs 123-127%** (`npm run budget:frame`, which now models
   Timer B too — it was reporting 44000% because `gate_wait` spun into the
   guard). The emission alone is 100.4% of dac-gate's 59,659 (167 samples x
   358.4 = the true NTSC frame), so the excess is ~14k cycles of work that does
   not overlap a gate wait. **Every frame is a lost vblank until it comes down.**
2. **The write-loop emit is in on PORT 0 and out on PORT 1.** `ld a,b / and 3 /
   call z,feed_one` after each YM write is correct in `cr_p0` (gates green, and
   port 0 carries the bulk of a frame's traffic) and breaks the mix in `cr_p1`:
   the prime frame's 255 ticks all get mixed, the cursor ends where it should,
   and every sample comes out ZERO — the voice's ROM reads return nothing, which
   is a wrong bank, from a routine that touches neither $6000 nor anything the
   bank depends on. Narrowed by measurement, not yet explained. Ruled out on the
   way: starvation (0), the PCM command never running (`pc_start` does), the
   tick count (255 mixed), `G_TICKSF`/`G_WRP`/`G_WRI`/`G_EMITS` (all correct in
   the trace), and the assembler's `call cc,nn` encoding (correct). The comment
   at the site says all of this so it is not re-added blind.

**Where the 123-127% actually goes, for whoever picks this up.** The emission
itself is 100.4% (167 samples x 358.4 = the true NTSC frame, against dac-gate's
59,659). So there is ~14k cycles of work a frame that does not overlap a gate
wait, and the emit points added so far do not reach it. The candidates, in the
order they are worth attacking: the port-1 write loop (blocked on the bug
above), the frame's fixed head (slot claim, PCM commands, `pcm_pad` itself), and
`consume_sub` at the two sub-tick boundaries. `npm run budget:frame` is the
gate that answers it — and it now models Timer B, so its numbers mean something
again.

### 2026-08-07 — the frame FITS: the 14k was the pacing model's own error

`npm run budget:frame` **123-127% -> 97%**, over-budget frames **100% -> 4.6%**,
and `npm run verify:all` is GREEN (engine 12/12, slots byte-exact and
sample-for-sample, c-gate 41/41, ring, sgdk:lint, ab-gate, dac). Image 7270 B
with **26 B free below the header** — that is now the tightest constraint again.

The ~14k of "work that does not overlap a gate wait" was not work. It was three
things, and the first is the one to remember:

1. **`EMIT_CYCLES` was 49 — the emit as it existed BEFORE Timer B.** Stage B put
   `call gate_step` in front of the block and never moved the constant, so the
   generator was 69 cycles short on every emit. It propagates twice: the baked
   pads over-ran a sample period by 69, and `pass_cost_tab` under-reported a
   pass by ~4,000 — so `pcm_pad` subtracted three passes from `PCM_BUDGET`
   against a sum ~12,000 too small and **handed the idle passes ~13,000 cycles
   of pad the frame did not have.** A model that under-prices the work pads
   harder, which is backwards in exactly the case that cannot afford it. Alone:
   123% -> 110%.
2. **The phase counter cost 69 of a sample's 358.** `gate_step` kept a 1..GROUP
   countdown in a RAM byte behind a call. **It is A' now** — the shadow
   accumulator — and the step is inline in 8 bytes: `ex af,af'` / `dec a` /
   `jr nz` / `call gate_wait` / `ex af,af'`, **24 cycles**, with `gate_wait`
   returning `A = PCM_GROUP` so the gating emit reloads the phase for free.
   110% -> 98%. `EMIT_CYCLES` = 73, and `GATE_CYCLES` = 141 (what the gating
   emit adds, once per group) is priced SEPARATELY because the pad has no
   interest in an interval the timer sets.

3. **`feed_wrap` used a 16-bit compare** (`push de`/`push iy`/`pop hl`/
   `sbc hl,de`/`pop de`, 86 cycles, ~17 calls a frame) to find a wrap that fires
   once per 512 samples. The ring is 512-ALIGNED and the cursor can only be
   `RING_BUF..RING_TOP`, so **the high byte alone answers it** — 47 cycles and
   5 B smaller. Worth only ~740 cycles, and it took the over-budget share from
   **24% to 4.6%**: that is what "the clock leaves no slack" means in practice —
   the 1-voice frame sat a hair over the line and nearly all of it crossed back
   at once. Expect that shape again; near the floor, small trims are cliffs.

**AF' IS RESERVED FOR THE PACING, ENGINE-WIDE.** Nothing else may use
`ex af,af'`. The ISR's `push af`/`pop af` does not, which is what carries the
phase across the frame boundary — and it must be continuous, because neither 166
nor 167 divides GROUP. `exx` is unaffected. A second user would not fail a gate;
it would drift the DAC's phase and read as jitter. Called out at `gate_wait`, at
`gatePrologue` in gen-mixer, and in driver.md §5.1.3.

`npm run dac` moved with it: wander **3.74-4.26 -> 2.31-2.73 ms**, span
**121-124% -> 111-114%**, paced **96-100% -> 100%**.

**The tool that found it, and it had rotted.** `tools/seg-bench.mjs` was written
before Timer B: it returned 0 for the YM status byte, so `gate_wait` spun into
the 3M-step guard and every run read 42,000% of budget, and it still imported
the deleted `PACE_SEG`/`PACE_RESERVE`/`G_NSEG`. It is repaired and is now
`npm run seg-bench`. It models the gate the way `frame-budget.mjs` does — the
overflow flag is satisfied ON DEMAND, so the profile shows WORK and not spin —
charges `PACE_WINDOW` per window read by default, counts the frame's DAC writes
to get the chunk, and prints the arithmetic that actually decides everything:

    165.3 samples x 358 = 59174 the timer's floor (99.2% of a frame)
    work 59314 (99.4%) — 140 OVER its own clock, so the frame is the work
    of that, 41686 inside the padded loops and 17628 outside them

The frame cannot be shorter than the floor, so **only the out-of-loop work
competes with it** and the loops' pad can always be resized to fill the rest.
Reach for this before theorising about where a frame goes.

**WHAT IS LEFT IS POLYPHONY, AND IT IS A RATE DECISION — NOT AN OPTIMISATION.**
`seg-bench` now prints the frame's mean cost by voices sounding, which is the
number that sets expectations:

    0v  72%          1v  95-97%  (0/189 over)
    2v  120-136%     3v  150%

A sounding voice costs **~25-30% of a frame** — 167 ticks x (78 mixing + 14
ROM-window) ~ 15.4k — and that is the mixer at the floor §5.3.1 already computed
for these semantics, not slack. **The engine fits ONE PCM voice at 9987.6 Hz.**
§1.1 predicted precisely this before the split ("2 voices x 175 ticks = 99.7% of
the frame with the sequencer executing zero instructions"); the split bought the
sequencer's 19.7k, which is one voice. The 3ch soft-mix target is met in value
terms (every gate is 0-diff) and NOT in cycles.

The only lever with the required size is the **sample rate**, because ticks
scale with it one-for-one: `GROUP = 2` is 6658.4 Hz and ~111 ticks a pass,
buying back ~1/3 of both the mix and the emits. It trades bandwidth for
polyphony and moves `mmb.js` + `drv-player.js` + the C together, so it is a
DECISION to take with the user, not a patch. Do not try to grind it out of the
overhead instead: out-of-loop work is ~16.7k total, spread flat over ~40 labels
(`ms_load`, `mvf_*`, `pp_*`, none above 800 cyc), and a second voice needs 15.4k.

Still open from the previous section, unchanged: **the write-loop emit is in on
port 0 and out on port 1** (`cr_p1` mixes all 255 prime ticks to ZERO; ruled out:
starvation, the PCM command, the tick count, the globals, the `call cc,nn`
encoding). The comment at the site carries the list.

**The image is the wall again: 21 B.** The next emit point, or any inlining,
needs `org $1c00` (~640 B free above the ring, behind `CODE_END`) — and only cold
code may go there.

### 2026-08-07 — HARDWARE: `$27` needed ENABLE B. One note, then a hang.

Reported from blastem: **one note sounded and the driver stopped.** Root cause,
and it had shipped past every gate in the repo.

**`$27` bit 3 (Enable B) was never set.** Boot wrote `$27 = $02` (Load B alone)
and `cs_r27` ORed `$02` into every `$27` the sequencer sent. Load B runs the
counter; **Enable B is what publishes the overflow to the status byte the gate
polls.** Nuked-OPN2 is the authority and it is one line (`third_party/
Nuked-OPN2/ym3438.c`, `OPN2_DoTimerB`):

    timer_b_overflow_flag |= timer_b_overflow & timer_b_enable;

So the counter ran and the flag never appeared: `gate_wait` spun for ever at the
FIRST emit of the FIRST frame. The frame's chip writes had already gone out —
one note — and nothing came after. **Fixed: `$0A` = Load B | Enable B, at boot
and in `cs_r27`.** Enable B also gates the YM2612's `/IRQ`, which is not
connected on the Mega Drive, so it costs nothing; it is the normal idiom for a
polling driver.

**Why nothing caught it, and this is the part worth carrying.** `engine-gate`,
`slot-gate`, `dac-gate`, `frame-budget` and `seg-bench` ALL modelled Timer B as
"status bit 1 rises GATE_CY cycles after the last reset". That model was written
from §5.1.2 — from the DESIGN — and the design never mentioned bit 3, so all
five harnesses raised the flag whether or not the engine had enabled the timer.
Every one of them was green against an engine that cannot run on hardware.

> **A harness that models a peripheral from the design document cannot fail on a
> register the design document forgot.** When a model of a chip is written, read
> the chip — `third_party/Nuked-OPN2/ym3438.c` is IN THIS REPO and is the same
> core `live` plays through.

All five now read bit 3. `engine-gate` additionally reports the poll-with-it-
clear case by name (`the engine polled Timer B's flag N times with ENABLE B
CLEAR`) instead of letting it present as "frame did not complete" — a spin is
otherwise indistinguishable from a hang anywhere else. Confirmed by running the
corrected model against the OLD engine: 599,937 polls, no frame.

Also learned in the same round, about where the fault could NOT be:
- The engine's DAC stream is healthy on every PCM gate score, measured
  absolutely rather than by comparison (a scratch dump of `$2A`/`$2B`):
  m2-pcm 62% non-silent, m2-pcmloop 100%, m3-pcm-slice 98.5%, `$2B` toggling
  once per burst. **The gates compare the engine to `drv-player` and would be
  green if BOTH were silent** — keep an absolute check in reach.
- `live` on the MMLispDRV backend plays fine, because `drv-player.js` is a JS
  reimplementation and never polls a real timer. A hardware-only fault is
  invisible there by construction.

### 2026-08-07 — BUSY modelled too; and the Z80 frame does NOT explain "very slow"

Hardware after the Enable B fix: **sound plays, but the tempo is very slow and
the DAC crackles.** Two things came out of chasing it.

**1. BUSY was the other free lunch, and it is small.** Every harness returned
status bit 7 clear, so `cr_p0d`/`cr_p1d`/`cs_r27d` never spun. Nuked-OPN2 holds
BUSY 32 internal cycles after a DATA write (`write_busy_cnt >> 5`) = 6 YM clocks
each = **90 Z80 cycles**. Now charged in `budget:frame` and `seg-bench`.
Measured: **~1k cycles a frame, no verdict changes** — `feed_one` every fourth
write already spaces data writes wider than 90. Charged anyway; "checked, small"
is not "never looked".

> **Judge BUSY on a MONOTONIC counter.** First cut compared against the
> per-frame `cyc`, which restarts — so the chip read BUSY at every frame
> boundary and `ym_busy0` spun 13,800 cycles A CALL, showing p95 186% and
> `m3-fm6-pcm` at 123%. All invented. An instrumentation bug that fabricates a
> plausible hardware cost is worse than none.

**2. With every known cost charged, the Z80 frame still reads p50 96-97% and
0.8-4.6% over.** That does NOT predict a large slowdown, so the cause is
probably NOT the Z80's frame. The one cost still unmodelled everywhere is the
**68000's bus grab** (`seg-bench --stall`, off by default because it has never
been measured on hardware) and its sensitivity is brutal: stall 500 takes the
over-budget share 6% -> 20%, stall 2000 -> 48%. The frame's margin is ~1,900
cycles (3%).

**The measurement that settles it is on the machine, and the driver already
publishes it.** `MMLisp_readStats` (audible / starved) against SGDK's `vtimer`,
per the contract in `sgdk/mmlispdrv.h`:

    audible_delta / vtimer_delta ~ 1.0, starved flat -> the driver is keeping up
    < 1 and starved CLIMBING  -> the ring ran dry: the 68k/host loop is late
    < 1 and starved FLAT      -> the Z80 is missing interrupts: its frame is over

Sample every ~32 frames (each read grabs the bus; sampling often costs the
engine the frames it then reports). Until that number exists, do not optimise
either side — the two diagnoses have opposite fixes (deeper RING_DEPTH / less
host work vs. less Z80 work per frame).

### 2026-08-07 — HARDWARE READOUT: it is the Z80's frame, and the 68k bus grab is ~1000 cyc

blastem, mucom song, the example's readout:

    music x256 00C1 (75%)   host x256 00FF (the 68k loop is fine)
    lost/s 000F             starv 001C cumulative   audible 04DF

**~400 lost frames against 28 starved, with `host` at 0xFF.** Both other
branches of the header's decision table are ruled out by measurement: the host
loop keeps up, and the ring is not running dry. So the Z80 is missing about a
quarter of its interrupts — **its frame is over budget on hardware while
`budget:frame` said 4.6%.**

**The gap is the 68000's BUS GRAB, and it is now charged by default.**
`MMLisp_frame` holds the Z80 bus to read `tail`, copy the slot and write `head`,
and the Z80 executes nothing meanwhile; every harness here writes the slot in as
a free array assignment. `frame-budget.mjs` now charges **1000 cycles a frame**
(`--stall N` overrides). 1000 is CALIBRATED, not derived: it is the value that
reproduces the machine (24% over budget against the measured ~25% loss).

**Then `pcm_pad` turned out to be dead weight — ~1,200 cycles a frame.** Stage C
sizes the idle pad from `PCM_BUDGET` minus the three passes' cost, and once the
emit was priced honestly there is nothing left to hand out: with ANY voice
sounding the answer is the floor (1) at every shift. It was computing that with
three `pp_sounding_at` calls and a divide. Now an early-out on `G_ACTM`, 59
cycles, and **`build-engine.mjs` asserts the shortcut** by running pcm_pad's own
arithmetic over the roomiest sounding frame and requiring a pad of 1.

> That assertion earned itself immediately: my first version compared against
> `>= PCM_BUDGET` and FAILED THE BUILD, because the roomiest sounding frame is
> 40,716 against a budget of 42,000. The conclusion still held (1,284 >> 11 = 0,
> floored to 1) but the reasoning I had written in the comment did not. Assert
> the routine's arithmetic, not your paraphrase of it.

    budget:frame with the bus grab charged:
      over budget 24.2% -> 4.6% (softmix), 21.3% -> 0.4% (pcmloop)

Predicts `music x256` moving 0x0C1 -> ~0x0F3. **UNCONFIRMED — needs the machine.**

Also: the working tree moved under this session (`gen-mixer` gained the inline
AF' gate, `EMIT_CYCLES` 118 -> 73). Re-read generated constants before quoting
them; the seg-bench GROUPS regex needing `gt\d+` was the tell.

### 2026-08-08 — the fix did NOT work, and the calibration was fitted to a coincidence

Second hardware round, same song: `music x256 0x0BF` (74.6%) against the
previous 0x0C1 (75.4%). **Unchanged.** `host 0x0FE`, `lost/s 15`, and the new
`starv/s` reads **6** — so the ring IS running dry, on top of ~9 missed
interrupts a second. "starv flat" in the previous round was a misreading of a
cumulative counter; that is what `starv/s` was added for.

**The frame's real length, from `music`:** 3,579,545 cycles a second / 44.8
consumed frames = **~80,000 cycles = 134% of budget**. `budget:frame` says 95%.
The model is short by ~22,000 cycles a frame — not by the ~1,200 `pcm_pad` gave
back, and not by any bus grab.

> **The 1000-cycle bus-grab default has been WITHDRAWN.** It was fitted because
> it made `m3-pcm-softmix` report 24% over against a machine losing ~25% of its
> frames. Different score, and the very next reading (134%) contradicts it. A
> constant that matches one number and breaks on the next is worse than no
> constant. `--stall N` still sweeps it; the grab is real and its SIZE HAS NEVER
> BEEN MEASURED. Do not put a number back without measuring the grab.

**And the corpus cannot reproduce it.** Both cycle tools were SKIPPING every
score without a sample bank, so every cycle number in this repo has come from
PCM gate scores — and those are musically trivial: **18-23 B mean slots**.
Lifted (an empty bank runs fine; only PCM commands read one), and now
demo1 / ab-core / stress-m1 / m2-motion all measure — at **71-72%**, with the
same 18-23 B slots. Nothing here is dense. The heaviest thing in the repo is
still 95%.

So the next step is not another guess: **profile THEIR song.** `budget:frame`
and `seg-bench` both take a `.mmb` with its `.smp` beside it, which is exactly
what an SGDK `res/` holds. Asked for `res/song.mmb` + `res/song.smp`.

Standing suspicion to test with it, not before: a mucom import drives 6 FM + PSG
with envelopes every frame, so its slot is many times the corpus's 20 B, and the
consume loop costs ~100 cycles a write. 200 writes would be ~20k — the right
size for the gap. UNVERIFIED.

### 2026-08-08 — THE TOOL WAS MEASURING THE WRONG QUANTITY

Their song profiled (`res/song.mmb`, 4000 frames): **slot 20 B mean — the same
density as the corpus.** The "a mucom song is denser" hypothesis is DEAD; it was
never the score.

`budget:frame` said 88% / 0.2% over. `dac-gate` said **span 110%**. The machine
said **134%**. Two of this repo's own gates disagreed by 22 points and nobody
had reconciled them.

**`budget:frame` modelled Timer B as satisfied-on-demand, so gate waits were
free and it reported the frame's WORK.** A frame is not its work:

    167 samples x 358.4 cyc = 59,853 = 100.3% of a vblank, BY ITSELF

The sample clock alone consumes the whole frame, and every cycle of work that
does not land inside a gate wait is added ON TOP. `seg-bench` had the right
arithmetic in its summary all along (floor + outside-the-loops):
59,853 + 18,705 = 78,558 = 132%, against the machine's 134%.

Fixed: the timer free-runs on the monotonic clock and the engine really waits.
Now reads **116% / 83.7% over** on their song, agreeing with dac-gate and with
the machine's direction.

> **When two gates disagree, do not average them and do not trust the friendlier
> one — find out which measures the quantity you care about.** `dac-gate` had
> been reporting span > 100% for months while the tool literally named "does the
> frame fit" said 88%.

**The real work list is now visible and it has not changed shape**: ~18,700
cycles a frame OUTSIDE the paced loops, flat across ~40 labels (`ms_load`,
`mvf_*`, `pq_in`, `feed_wrap`, `pp_*`). The clock leaves nothing, so all of it
is overrun. Cutting it is the task; the sample rate (ticks scale 1:1 with it) is
still the only lever big enough to change the shape.

### 2026-08-08 — dead-time ranking: the holes are PRIME FRAMES + a flat 19%

Added to `seg-bench`: charge every cycle spent more than one sample period after
the last `$2A` write to the label running at the time, and report the biggest
single holes with where in the frame they fell. Cost-ranking cannot answer this
— a cheap label can hold the DAC through a hole and an expensive one can cost
the feed nothing because it emits as it goes.

Two instrument bugs found on the way, both the same shape as the BUSY one:
charge it only BETWEEN two emits (a no-PCM frame feeds nothing by design, so
`pace_sub` ranked first at 5,115 cyc/frame of "dead time" on frames where the
DAC is not running), and only on frames that emit at all.

Their song, corrected:

    DEAD TIME 11,466 cyc/frame (19.2% of a frame)
    biggest single holes: 355p / 135p / 135p / 135p / 126p — ALL in pp_setup, all at 4% into the frame
    then flat: gate_wait 1355, mix_first1_s0_lp 1043, ms_load 760,
               mix_add1_s9_lp 634, mvf_idle_seg 451, feed_one 435, gt* ~700

**Two separate problems, and they need different fixes.**

1. **PRIME FRAMES.** A burst's first frame builds the whole lead and feeds
   NOTHING — 135 to 355 sample periods of DAC silence, one to two whole frames.
   ~4-5 per 67 s in their song (the `1smp` frames: f1363, f2425, f2875, f3739).
   Each is a discrete audible click. The ring drains between PCM bursts and the
   next hit has to prime again.

   **Proposed, NOT implemented (needs the user):** when no voice sounds, mix
   SILENCE into the ring instead of `pace_sub` burning 19,952 cycles doing
   nothing. Then the ring never drains and no burst ever needs a prime frame.
   Cycle cost is comparable (three idle passes ~25,400 against pace_sub's
   19,952) and a 0-voice frame is at 78%, so there is room. The design
   consequence is that fm6/`$2B` stays claimed for PCM continuously, which
   collides with a score that wants fm6 for FM (§14) — that is the call to make.

2. **A FLAT 19.2%.** No single hole; ~8 labels between 300 and 1,400. This is
   the steady-state overrun (116% modelled / 134% measured). No cause isolated
   yet — do not guess at it again.

**Answered with measurement, for the record:** coarser pitch resampling does NOT
fix it. The mix loops hold only ~2,400 of the 11,466 dead cycles, so a free
mixer still leaves ~9,000. And lowering the sample rate is not the lever either.

### 2026-08-08 — fm6 IS NOW CLAIMED FOR THE WHOLE SCORE (user approved the trade)

The prime-frame holes are gone. Once PCM has sounded once, the ring is kept
topped up with SILENCE and `$2B` is never released, so a later hit is a STEADY
frame and never a PRIME one. Cost: fm6 stops being available as an FM channel
for the rest of the score (§14's "claimed, not owned" becomes claimed and kept).
A score with no PCM never claims and is untouched.

Landed in all THREE implementations together, which is the only way this works:
`live/src/drv-player.js` (the port spec), `drv/68k/mmlispseq.c`, `drv/src/
engine.z80` — plus `engine-gate`'s model, whose scenarios asserted the old rule
("175 DAC writes with no voice active") and had to be taught the new one.

    their song: worst frame 519% -> 145%; the recurring 135/355-period holes are
    gone, the one left is 163p at f1 — the score's first frame, which must prime
    verify:all exit 0 (engine 12/12, c-gate 41/41, slots sample-for-sample,
    ring, dac, sgdk:lint, ab-gate)

**`pp_tail` is deleted.** A tail frame and a steady frame are now the same
thing: mix `chunk`, feed `chunk`, `fill` unchanged. The real tail plays out
ahead of the silence in FIFO order.

> **`_done()` in drv-player had to stop consulting `_pcmFill`.** It read "the
> ring still holds a tail, so the song is not over" — which became permanently
> true once the ring is deliberately kept full, so the reference ran forever
> while the C stopped at `mml_done` (121 slots vs 400). The C's predicate
> (voices active + tracks running) was always the right one and the two now
> agree. Expect this shape whenever a "still busy" test reads a buffer that
> something else decides to keep full.

**What is NOT fixed: the steady-state 116%.** p50 is unchanged — the flat 19.2%
of dead time spread over ~8 labels is a separate problem and still has no
isolated cause. The clicks should be much better; the slow tempo will not be.

### 2026-08-08 — PCM_PASSES 3 -> 2 landed. THREE coupled constants, all baked at 3.

The pass count is the emit cadence, and a pass's iteration is `PACE_PASSES`
ticks of ONE voice plus an emit, which must fit ONE sample period:

    P*(tick + PACE_WINDOW) + 134 <= 358      (tick = 78 variable, ~40 fixed)
    variable: P=2 318 ok, P=3 410 OVER (15%, AT EVERY VOLUME)
    fixed:    P=2 242,  P=3 296,  P=4 350 — all ok

**Three voices never fitted the clock.** The value gates said 3ch because they
compare mixers to each other, never to a clock.

Changing the constant was not enough — THREE places had 3 baked in, and each one
presents as something else entirely:

1. **`ms_owed` / `msl_owed` (GENERATED, two sites)** — `add a,a / add a,l`,
   "3 x iterations", converting an iteration count to a tick count. A 175-tick
   pass ran 96 ticks and the DAC diverged at ring position 511 (the page edge),
   which reads as a mixer bug. Now `mulByUnroll(unroll)` in gen-mixer, which
   throws past 4 rather than emitting silently wrong code.
2. **`mvf_ringcap` (hand-written)** — the same x3, samples -> ticks for the ring
   top bound. `build-engine.mjs` asserts `PCM_PASSES == 2` against that site.
3. **`SLOT_SUBS = 3`** — the sub-slots "ride the mixer's voice-pass boundaries,
   which sit at 1/3 and 2/3". With two passes there is only 1/2, so the third
   sub-slot had no boundary and `pace_sub` placed it by hand. **The user heard
   this as clicks on TIMBRE CHANGES** — a patch dump is ~30 FM writes and they
   were landing in the hand-placed sub-slot. Now 2, in engine.z80 +
   slot-builder.js + mmlispseq.h.

Also: `m3-pcm-softmix` / `m3-pcm-slice` rewritten to two voices, drv-player
ignores a voice index this build lacks, engine-gate's scenarios and its
hardcoded `new Array(3)` plan block parameterised from `PCM_VOICES`, ab baseline
re-frozen (6 scores moved — sub-slot placement changed; 2 improved to 0).

    verify:all exit 0 · image 7282 B, headroom 75 -> 506 B
    their song: p50 116% -> 114%, dead time 11,466 -> 8,957 cyc/frame

**HARDWARE SAID IT GOT WORSE, on the build that still had SLOT_SUBS = 3:**
`music x256` 0x0BF (74.6%) -> **0x087 (52.7%)**, `starv/s` 6 -> 14. That build
had the mismatch above. UNVERIFIED whether SLOT_SUBS = 2 recovers it — that is
the next hardware run and it is the question to answer before anything else.

**The tempo win did NOT arrive.** The sounding pass now fits its period (pads
went 0 -> positive, which is the proof) and the model moved 116% -> 114%. The
remaining 15% of dead time is led by `gate_wait` at 37 cyc/visit — the engine
arriving LATE at gates — and has no isolated cause. Do not predict again; measure.

### 2026-08-08 — SLOT_SUBS fix CONFIRMED on hardware. The gap is a CONSTANT ~22k.

    music x256 0x0BC (73.4%)   host 0x0FE   lost/s 16   starv/s 0000   starv 123

Both kinds of click are gone (user confirmed) and **starvation is now ZERO** —
6 at P=3, 14 on the broken SLOT_SUBS=3/P=2 build, 0 now. `music` recovered
0x087 -> 0x0BC, so the regression WAS the sub-slot mismatch.

The decision table is now unambiguous for the first time: **`music < 1` with
`starv/s == 0` = the Z80 is not taking every interrupt.** The host and the ring
are both exonerated by measurement.

**And the model's error is a CONSTANT, not a proportion:**

    P=3   model 116%   hardware 134%    gap ~22,000 cyc
    P=2   model 114%   hardware 136%    gap ~22,000 cyc

Same gap across a configuration change that moved the whole workload. That is
the signature of a fixed per-frame cost the emulator does not charge — chase
THAT, not the workload.

**Ruled out this round: the host's bus grab.** `MMLisp_frame` (sgdk/
mmlispdrv.c) takes the bus three times and each is scoped tight — read `tail` +
stamp `H_VBL`, the per-slot copy in `slot_to_z80`, write `head`. **`mml_pump`
renders the sequencer WITHOUT holding the bus.** A ~20 B slot cannot be 22k Z80
cycles. Already ruled out earlier: YM BUSY (~1k, modelled), the ROM-window
charge (PACE_WINDOW=14, would need ~240/read), the score's write density
(20 B mean slots — same as the corpus).

Still unexplained. Candidates not yet measured: the Z80's real access time to
$4000-$4003 and to the $8000 window while the 68k/VDP hold the bus during
ACTIVE DISPLAY (all harnesses charge a flat PACE_WINDOW and nothing for YM
port access at all), and the interrupt-acceptance path itself.

**P=2's verdict, honestly: neutral on tempo** (0.746 at P=3 -> 0.734 now),
**good on starvation** (6 -> 0) and it freed 430 B of image. It cost a voice.

### 2026-08-08 — THE ~22k GAP DID NOT EXIST. The harness never let the vblank arrive.

`budget:frame` now reproduces the machine EXACTLY on the one song with ground
truth:

    model    music x256 00bc (74%) · lost 16/s
    machine  music x256 00BC       · lost/s 0010 = 16

The missing ingredient was never a hidden per-frame cost. **The harness ran
frames back to back** — `intRequest`, run to halt, `intRequest` again — so the
Z80 never idled, the vblank never arrived on its own clock, Timer B never had
real time to advance in, and the catch-up never engaged. Every conclusion drawn
from the difference was an artifact, including the "constant ~22,000 cycles a
frame" I twice called a signature. It was my instrument.

What the model needed:

- the Z80 SLEEPS to the next vblank when it finishes early (`tcyc = nextVbl`),
  because it gets FRAME_CYCLES of real time per vblank whether it works or not;
- /INT is asserted for ~one scanline (INT_WINDOW = 228 Z80 cycles) and a frame
  still inside the ISR when the window closes LOSES that interrupt;
- the host stamps `H_VBL` every real vblank, which is what arms the catch-up;
- **`music` is CONSUMED frames (the engine's own H_FRAMES) over real vblanks**,
  not interrupts taken. Counting interrupts read 26% where the machine said
  74%, because catch-up makes one interrupt consume up to CATCH_MAX frames —
  the interrupt count and the music's clock are different numbers. This is the
  same class of error as everything else this session: measuring a quantity
  that resembles the one you want.

**The actionable number is now: one frame of MUSIC costs 114% of a vblank.**
(m3-pcm-softmix 117%, m2-pcmloop 116%, m3-fm6-pcm 111%.) Cut 14% and it fits.

> CAVEAT, unresolved: all three corpus scores report the SAME music ratio
> (74%) and lost/s (16) despite different per-frame costs (111-117%). The ratio
> looks pinned by the catch-up saturating rather than by the work, so trust the
> "cost per music frame" line and treat the ratio as calibrated on one song
> until a second ground truth exists. Get `music x256` for a LIGHT score.

### 2026-08-08 — the port-1 emit bug was the FEED CURSOR's ordering, not a bank

`ld iy,(G_RD)` lived inside `process_pcm`, which runs AFTER `consume_slot` —
so at the frame head IY held only whatever the previous frame's `ld (G_RD),iy`
had left in it. The port-0 write loop's emit got away with that by luck; a
SECOND emit site walked IY far enough off that the mixer's own reads came back
wrong, which is why it presented as "a wrong ROM bank from a routine that
touches neither $6000 nor anything the bank depends on". Moved to `frame_step`,
before `consume_slot`. The port-1 emit then just works. ab-gate's clean scores
17 -> 19; `cr_p0`, `cr_fm0` and `pp_pass_done` all left the biggest-hole list.

**A voice change stops being a click** — that was a ~30-register patch dump
running with no emit in it.

**THE FRAME'S ARITHMETIC, settled:**

    clock floor (167 x 358.4)  59,853
    + dead time                 +8,695
    = 68,548   vs measured 67,881, vs the vblank's 59,659

So **frame = floor + dead time**, and cutting dead time IS cutting tempo — the
earlier note that holes buy "smoothness, not tempo" was wrong. What is true is
that the holes closed so far were RARE (specific frames); the steady 8,695 is
what moves the number.

**Where the steady dead time is**, measured by splitting the interval between
consecutive $2A writes:

    loop's own emits  n=165,567  mean 267 cyc   (period 358 — 91 UNDER)
    the GATING emit   n= 82,779  mean 401 cyc   (43 OVER)

One in PCM_GROUP emits is the slow one and it is `gate_wait`: the poll, the
$27 flag reset and the $2A re-latch. 56 x 43 = ~2,400 of the 8,695. Precomputing
`G_R27 | $20` (G_R27G) took 7 of those cycles and moved the frame 68,045 ->
67,881 — the first prediction today that matched its measurement.

**Still on the table in gate_wait:** feed_one re-latches $2A immediately after
`call gate_wait`, which already re-latched it — 20 cycles duplicated on the
gate path. Restructuring costs a `jr`, so net ~8; measure before believing it.

**The rest of the 8,695 is not yet located.** `mvf_idle_seg` shows at 11-22
periods on scattered frames. Do not guess at it — the interval split above is
the instrument that works.

### 2026-08-08 — the remaining 14%, located precisely

`seg-bench` now buckets dead time by HOLE SIZE and names the label that opens
each hole. Their song, 1500 frames:

    358.. 500   2414 cyc  33.8 holes/frame  28%   the GATING emit (43 over each)
    500.. 800    872       3.1              10%
    800..1500   2981       5.3              34%   <- the target
    1500..4000  1220       0.8              14%

The 800-1500 band opens at the SEGMENT SET-UP, which Stage D's emit points at
the segment BOUNDS do not cover:

    mix_add1_s9_lp 689   mix_seg 621   mvf_idle_seg 573
    mvf_n 472            mix_first1_s0_lp 439   msb_s 375     = 3,169 cyc/frame

Each hole is ~1,120 cycles = 3 sample periods, so each wants two or three
emits, not one. **NOT attempted, and the reason matters:** `mix_seg`'s entry has
A (the store flag) and L (the buffer index) LIVE, and `feed_one` clobbers A, HL,
IY and the flags. A naive `call feed_one` there corrupts the mix. Doing it needs
either a save/restore whose cost has to be weighed against the ~358 cycles each
emit recovers, or an emit variant that preserves A and HL.

Order of value, measured:
1. 5.3 segment-set-up holes  ~3,000 cyc  (needs the register problem solved)
2. the gating emit           ~2,400 cyc  (43 over x 56; $2A is re-latched
                                          twice on the gate path, worth ~8 net)
3. the 1500-4000 band        ~1,200 cyc  (0.8 a frame — find them first)

`budget:frame` reproduces the machine, so any of these can be checked before
believing it. That is the thing that was missing all day.

### 2026-08-08 — ATTEMPTED and REVERTED: an emit in mix_seg's set-up

Tried the #1 item above — `call feed_one` immediately after `ld (G_SEG_I),a` in
`mix_seg` (gen-mixer.mjs). **The register worry was unfounded** and worth
recording: the two stores at mix_seg's entry have just spilled A and L (which is
what its own comment means by "the last moment HL and DE are free"), and
feed_one touches A, HL (saved), IY and the flags — never B, IX or DE. So the
placement is register-safe.

**It broke the sample ACCOUNTING**: 5 of 12 engine scenarios failed with one
EXTRA sample in the stream (`got 128,186,128…` against `want 128,128,128…`,
everything after shifted by one). Reverted; the branch is green.

Ruled out while looking:
- not re-entry — `mix_seg` is called once per segment (engine.z80:1508) and
  `ms_call_unrolled` is INSIDE it, not a second entry;
- the obvious balance holds on paper: feed_one charges G_EMITS, the split then
  caps `G_SEG_N` by G_EMITS and charges it too, single-tick copies do not emit.

**CAUSE FOUND on the second attempt, and it is a rule already written down:**

> `feed_one` goes BEFORE `mvf_ringcap`, never after. The bound is measured from
> IY, and an emit advances IY.

`mix_seg` runs AFTER `mvf_ringcap` has computed the segment's bound, so an emit
in its set-up walks IY past what the bound reserved and the segment overruns the
ring's top. The symptom fits exactly: the emit COUNT is unchanged (166.3 a frame
with and without) and a single VALUE is wrong — slot-gate, m2-pcmloop,
DAC[4097] frame 25: engine 186, reference 218. It was never an accounting bug;
the "extra sample" in engine-gate was the same overrun seen from the model side.

**So the hole cannot be closed by an emit where it is.** The set-up sits between
the bound and the loop by construction. The options, none tried:

1. RESERVE a sample in `mvf_ringcap` — compute the bound from (distance - 1) so
   the set-up's emit is already paid for. One `dec` per segment; the awkward
   part is distance 0, which currently takes the forced-progress path.
2. Move the set-up ABOVE `mvf_ringcap` — the split, the bind and the register
   load do not depend on the bound, only the ITERATION COUNT does. Bigger
   change, and it removes the hole rather than filling it.
3. Leave it and take the other two bands first (the gating emit, the 1500-4000
   holes), which do not have this constraint.

**Option 1 was BUILT and MEASURED, then reverted — it is net negative as one
emit, and the arithmetic says three would win.** `mvf_ringcap` reserving a
sample (`or a / jr z / dec a` before the x2) and a `call feed_one` after
`ld (G_SEG_I),a` GATES CLEAN — verify:all exit 0, engine 12/12, slot-gate
sample-for-sample. The mechanism is sound. But:

    800..1500   5.3 holes -> 3.2   (-1,149 cyc)
    500.. 800   3.1 holes -> 7.4   (+1,016 cyc)
    dead time   8,695 -> 8,684 (-11)      frame 67,881 -> 67,954 (+73)

**One emit only SPLITS a hole, it does not close it.** A 1,120-cycle hole
halved is two 560s, and 560 is still over the 358-cycle period, so the dead time
is conserved while the emit's own ~70 cycles are added. The frame got worse.

The arithmetic for doing it properly, which is why this is worth returning to:
a 1,120-cycle hole needs THREE emits to land four ~280-cycle stretches, all
under the period — that removes 762 cyc per hole x 5.3 = **~4,000 cycles a
frame**, against 2 extra emits x 5.3 x ~70 = ~740. **Net ~+3,300, half the
overrun.** Each emit needs its own reserved sample in the bound and a
register-safe site inside the set-up; only one such site (after
`ld (G_SEG_I),a`) has been found so far. Finding two more is the task.

> The general rule this taught: an emit point pays only if it leaves EVERY
> resulting stretch under one sample period. Splitting a hole in two buys
> nothing and costs the emit. Size the hole first, then decide how many.

**A SECOND emit was then added (after ms_load's register-file load, with
PCM_SETUP_EMITS = 2 reserved in the bound). It gated clean and changed NOTHING:**

    baseline    67,881 cyc/frame
    +1 emit     67,954  (+73)
    +2 emits    68,119  (+238)     dead-time distribution IDENTICAL to +1

The hole distribution did not move at all between one emit and two, so the
second landed outside any hole: after the first emit, the split and the register
load are only ~200-300 cycles, already under a period. The prediction of "three
emits per hole" was wrong about WHERE the rest of the hole is.

**The 3.2 remaining 800..1500 holes open at `mvf_n`, which is the LIVE path —
`mix_seg_live`, the SOUNDING pass.** `mix_seg` (instrumented above) is the IDLE
path only. That is the next site if this line is resumed.

> **Three attempts at this band, all net negative.** Every emit costs ~70
> cycles and only pays where the DAC is actually holding. `seg-bench`'s
> band-by-label line is what says where that is — read it BEFORE choosing a
> site, not after. All three of these were chosen from the per-label ranking,
> which sums holes of every size and pointed at the wrong path.

Also gate on the BENCH build: `generateMixerCore` is called with `paced: false`
by mixer-bench.mjs, where `feed_one` does not exist — guard any new call site
with `${paced ? … : ""}` or `npm run mixer` fails to assemble.

### 2026-08-08 — WHY the emit points do nothing: the frame is invariant to them

Four experiments, one conclusion.

    baseline                        67,884 cyc/frame
    + 1 emit in mix_seg's set-up    67,954
    + 2 emits                       68,119
    - the two write-loop emits      67,884   (unchanged)

**The frame does not move when emits are added OR removed.** `G_EMITS` fixes a
frame's emit TOTAL at `chunk`, so an emit at a boundary only stops a loop
emitting later: pure redistribution. Every "close the holes" plan — mine and
Stage D's remaining list — is zero-sum on the frame's length. It buys DAC
SMOOTHNESS, which is real (it is what killed the voice-change clicks), and
nothing else.

**Where the overrun is, by elimination:**

    the timer's floor        59,630   (166.6 samples x 358.4 — 99.8% of a frame)
    work after the last emit  1,587   (2.7%, measured — NOT the problem)
    the frame                67,884
    => ~6,700 is the last emit itself arriving LATE

**And lateness is permanent.** The gate passes PCM_GROUP samples per Timer B
overflow — 3 per 1,075 cycles. Two of the three can be emitted as fast as the
code likes; the third waits for the timer whatever happens. So a group that
runs long is never made up, and a group with slack cannot give it away.

    work per group   51,421 / 55.5 = 926 cyc      available 1,075

**It fits ON AVERAGE and fails UNEVENLY.** The blocks of out-of-loop work — the
segment set-ups, the slot's chip writes, pcm_pad, the frame head — push
individual groups past 1,075, and only the excess accumulates.

So the two routes that can actually work:

1. **Even out the work per group.** Not emit points — the WORK has to be broken
   up and interleaved with the mixing so no group exceeds 1,075. Deep.
2. **Less total work**, which lowers every group at once. The user's own
   BAKED-voice idea does exactly this: no 16.16 advance is ~40 cycles a tick
   instead of 78, so a 1-voice frame drops ~6,300 cycles and every group gains
   ~115 of margin. It needs no hole filled at all.

> Do not add emit points to fix TEMPO again. Four measurements say they cannot.

## HANDOFF — 2026-08-09, branch `drv/timer-b` (12 commits, verify:all green)

**Where it stands.** The driver plays on real hardware. It did not at the start
of the last session — it emitted one note and hung.

    hardware   music x256 0x00BB (73%) · lost/s 16 · starv/s 0 · no clicks
    model      one frame of music 65,593 cyc = 110% of a vblank (was 123-127%)
    image      7,282 B, 532 B free below the header

`backup-timer-b-16commits` holds the pre-squash history if anything is missing.

### The one thing to read first

`npm run budget:frame <song.mmb>` **reproduces the machine**: it prints
`music x256` and `lost/s` and both match the hardware readout on two separate
runs. Anything you change can be checked before you believe it. That did not
exist a session ago and three tools disagreed by 22 points; getting it was worth
more than any of the code changes.

Its companion is `node tools/seg-bench.mjs <song.mmb> --top 0`, which prints, in
order of usefulness:

1. **PER TIMER B GROUP** — the distribution and the total excess. This is the
   overrun and nothing else is.
2. **what is IN the over-budget groups, by kind** — the work list.
3. the measured interval between $2A writes, split into the loop's own emits
   and the gating one.
4. dead time by hole size, and the label that opens each hole.

### The target, measured

    per group: budget 1,074 · mean 897 · only 10% exceed it
    their excess: 7,415 cyc/frame  == the frame's overrun

    inside those groups:   segment set-up 4,235   mix bodies 2,132
                           PCM commands   1,715   gate+emit  1,447
                           frame's head     816   slot consume 466

**SEGMENT SET-UP is the target — 4,235.** Chip writes are not (816). The lever
is FEWER SEGMENTS, not cheaper ones: ~6 a frame at ~700 cycles of set-up each.
Four things split a segment — the plan's breaks (loop/end points, musical), the
ROM window top (hardware), **the ring's 256-byte page edge**, and **the feed's
distance to the ring top**. The last two are artefacts of holding a 512-byte
ring in 256-byte-page addressing, not of the music. `mvf_rc_feed` (364) and
`feed_wrap` sit exactly there. Changing the ring's shape is a design question,
not a patch — that is where the last session stopped.

### Rules this cost real time to learn

- **"Fewer instructions" and "less time" are different things.** Inside a
  timer-paced stretch, removing work only lengthens the wait. Four experiments
  adding and removing emit points left the frame at the SAME cycle; PAD_TARGET
  swept 180..290 is flat. Only work that pushes a GROUP past 1,074 costs time.
- **An emit point pays only if every resulting stretch is under one sample
  period.** Splitting a 1,120-cycle hole in two buys nothing and costs the emit.
- **`feed_one` must precede `mvf_ringcap`**, because the segment bound is
  measured from IY and an emit advances it. `mix_seg` runs after the bound, so
  an emit there needs a sample reserved in the bound (built, gated clean,
  measured net-negative, reverted).
- **Model peripherals from the chip, not from docs/driver.md.** The Enable B
  hang and the unmodelled BUSY both came from harnesses written off our own
  design document. `third_party/Nuked-OPN2/ym3438.c` is checked in.
- **Judge anything time-based on a MONOTONIC counter.** A per-frame counter
  made BUSY read as 13,800 cycles a call — an invented hardware cost.
- Do not commit per experiment. Six docs(memory) commits were squashed into one.

### Not taken, with numbers

- **PACE_PASSES = 1** (one variable PCM voice): 64,671 cyc, **108%**, DAC hold
  2.6/5.4 periods — better than the shipped 2-voice build on both counts. Costs
  `pcm2` in the language and touches five test scores. Set `PACE_PASSES = 1` in
  gen-mixer plus PCM_VOICES / SLOT_SUBS / MML_PCM_VOICES / slot-builder /
  drv-player, and mvf_ringcap's x2 becomes x1 (build-engine asserts it).
- Voice kinds (variable vs fixed per channel): the arithmetic is in the
  2026-08-08 entry — variable needs P<=2, fixed allows P<=4, and per-channel U
  is feasible when sum(1/U_i) = 1. **The user has asked not to be offered this
  again; do not raise it unprompted.**

## 2026-08-09 — INVESTIGATION ONLY. Timer B's WINDOW is the thing that is wrong.

Nothing shipped this session. The engine, the format and the language are
untouched; only `drv/tools/` moved. What follows is what was measured, and it
changes where the work goes.

**The song under test is `res/song.mmb` — ONE PCM voice, pitched.** That is the
cheapest configuration there is, and it runs at 110%. Two and three voices were
never the question.

### The finding, in one line

> Timer B converts a TOTAL budget into a PER-GROUP one. The frame's whole work
> is 49,708 cyc = **83% of a vblank** — nothing here is too slow. What fails is
> that a group of 3 samples is too small a window to average over.

Inside a group only the first sample waits; the rest run at code speed, so the
loop banks (period − iteration) a sample and that is the entire budget for
catching up after an out-of-loop block:

    recoverable lump = PCM_GROUP x (period − iteration cost)
                     = 3 x 87..98  =  261..295

Measured out-of-loop lumps are **819..1053**. That is the whole 110%.

**And PCM_GROUP = 3 was never a design decision.** engine.z80 says it: `TB = 255`
is the timer's SHORTEST period, and 3 samples per overflow fell out of it. The
window is free — TB = 256−k gives PCM_GROUP = 3k at the SAME sample rate.

### The window sweep, frame-accurate

`seg-bench` now replays the recorded per-emit costs on frame-budget's wall clock
(the Z80 sleeps to the vblank, the ISR emits `chunk`, Timer B free-runs). N=3
flat IS the shipping engine, so it calibrates everything: it reads 64,421 where
`budget:frame` measures 65,593 — **every row is ~2 points optimistic.**

    PCM_GROUP  3 flat   64,421 (108%)   holes >=2p 21.7  >=4p  1.8   <- shipping
    PCM_GROUP 12 flat   59,790 (100%)              13.7      10.0
    PCM_GROUP 24 flat   55,451 ( 93%)               8.2       5.0
    PCM_GROUP 48 flat   50,022 ( 84%)               5.7       3.0
    PCM_GROUP 12 aimed  60,877 (102%)               4.6       1.8
    PCM_GROUP 24 aimed  57,375 ( 96%)               4.5       1.8
    PCM_GROUP 32 aimed  55,462 ( 93%)               4.7       1.8
    PCM_GROUP 48 aimed  52,068 ( 87%)               4.5       1.8

- **Widening alone (flat) fixes tempo and WRECKS the spacing**: the slack the
  loop banks lands as one hold at the group's end, 4p holes 1.8 -> 10.0. That is
  a regular artefact at 9987/N Hz.
- **An AIMED pad** — hold sample i to groupStart + i x period instead of to a
  constant — pins 4p holes at the shipping 1.8 at every window, and *improves*
  2p holes 21.7 -> 4.5. It costs 2-3 points of tempo, which is the slack being
  spent on spacing instead of on absorbing blocks.
- The two are a SET. Either alone is worse than useless.

**Not modelled: the aimed pad's own cost.** A debt counter is ~15-25 cyc/sample
= 2,500-4,200 cyc/frame, against ~1,200 of margin at N=24 and ~6,700 at N=48.
That is what points at **N=48 + aimed** (TB=240, 36,864 YM clocks/overflow), and
it is the next thing to build and measure. Note this debt is the mechanism
Timer B *deleted*; the difference is that a 48-sample window can repay it.

### Method notes that cost time

- **`Σ max(0, group − budget)` OVERSTATES the frame's overrun by ~55%** (7,372
  against 4,766 frame-accurate). A group that finishes early while the engine is
  ALREADY late runs straight through and recovers — "a group with slack cannot
  give it away" holds only when the engine is on time. Judge on the wall clock.
- **The engine only runs inside the ISR.** A simulation that replays the emit
  stream continuously reports ZERO lateness for an engine the machine measures
  at 110%, because it lets a frame borrow from the next one.
- Both deadlines are ABSOLUTE (`j x period`). Targeting a group's actual start
  compounds a late start and the run diverges — 25M cyc/frame of nonsense.
- Counterfactuals per KIND ("if this alone cost nothing") do NOT add: each is
  measured with the others present, so a group can only ever return its own
  excess. Only the joint one is a ceiling.

### What the counterfactuals said before the window idea

Breaking the blocks up — the road this branch was on — **does not close it.**

    ALL out-of-loop work removed          leaves    1 of excess (P=2) /   9 (P=1)
    …minus the pass's entry+exit          leaves 1256              /  823
      => ~101-102%, against a budget of 81 cyc/frame of lateness

The vblank has **81 cycles** left once the DAC's own clock (166.674 x 358.4 =
59,655) is paid. That is the entire margin, and it is why nothing else fits.

### Segment splits, by the bound that caused them (new in seg-bench)

Every path bounds B then calls `mvf_ringcap`, so a call there is one segment; B
at entry / `mvf_rc_feed` / `mvf_rc_done` names the bound that ended it.

    the ring's page edge      1.29 a frame   926 cyc/frame   819 each
    the feed's ring top       0.33           239             727
    the plan's break          0.05            52             990
    the ROM window top        0               —
    (ran to the pass end)     2.00          1882            1053
    (the pass's own entry)                  1132

**1.62 of the 1.7 splits a frame are the ring's SHAPE, not the music.** Two
counts validate the attribution against arithmetic: 1.29 = 333 ticks / 256, and
0.33 = 166.6 samples / 512. Reshaping the ring (256 B in one 256-aligned page,
so `inc l` wraps for free) returns a measured **1,052 cyc/frame**. Real, and
much smaller than the window.

### Voice kinds — the fit criterion, corrected

The bar is **`PAD_TARGET` (260), not the sample period**, and the generator's own
test is `padFor()`. One iteration is `U x (tick + 14) + 87`, so per-pass cadence
(`sum(1/U_i) = 1`, rational U allowed) is feasible **iff `Σ(tick_i + 14) <= 173`**.

    VARIABLE first 61   VARIABLE add 78      (shift 0; +8 per 6 dB of attenuation)
    FIXED    first 24   FIXED    add 41      (pre-resampled AND volume baked)

    可変1        75 OK      固定3        148 OK      可変1+固定2  185 NO
    固定2        93 OK      可変2        167 OK      固定4        203 NO
    可変1+固定1 130 OK                                可変3        259 NO

- **The shipped 2-variable build is already 11 cycles past the bar at FULL
  volume** (add iter 271 vs 260) — consistent with the 110%.
- 可変2 and 固定3 need per-pass emit cadence, which is uniform today.
- A LUT for volume is a LOSS: no free 16-bit pointer exists in the tick body
  (A/A'/DE/HL/HL'/DE'/C/B/IY all live), so the cheapest lookup is `ld ixl,a` +
  `ld a,(ix+0)` = **27 cycles flat**, against `sra a` = 8 x shift. It only wins
  below −24 dB and costs 27 where shift 0 costs nothing. Runtime volume at zero
  per-tick cost is a ROM problem — pre-attenuated copies selected by a pointer
  offset — not a Z80 one. (`add a,a` is 4 and `sra a` is 8: amplifying is half
  the price of attenuating.)
- **Playback position costs nothing.** `pcm_compose_start` already sends an
  absolute `{bank, window addr}` (`abs = sample_rom_base + v->base`), so an
  offset is 68k arithmetic and the Z80's 18-byte command is unchanged.

### PACE_PASSES = 1, re-measured — and a cost the handoff did not record

64,546 cyc = **108%**, reproducing the recorded number exactly. But it forces
`SLOT_SUBS` to 1, because sub-slots ride voice-pass boundaries and one pass has
no interior one. `docs/driver.md` §3.5: onset error goes back from 8.35 ms to
**16.7 ms**, for every score, PCM or not. That is on top of losing pcm2/pcm3.
Reverted; the tree is 2-voice.

### A harness bug found and fixed on the way

`slot-gate` timed the host's post at a fraction of frame 0's INSTRUCTION COUNT.
At `SLOT_SUBS = 1` a frame with no PCM is **81 instructions** against a threshold
of 317, so the host never posted again — 120 starved frames the hardware would
not have had. It is on Z80 CYCLES now. The 68000 renders from its own vblank
loop and does not care whether the Z80 is still running.

### 2026-08-09 (later) — LANDED: the window is 24 samples, and the song fits

    before   65,593 cyc (110%) · music x256 00bc (74%) · lost 16/s · hold 3.6/5.1
    after    58,731 cyc ( 98%) · music x256 00fe (99%) · lost  0/s · hold 7.4/8.3
    image    7,282 B, 564 B free below the header · verify:all exit 0

**`TIMER_B_K` is the one knob** (`gen-mixer.mjs`): k = 256 − TB buys 2304k YM
clocks a gate and 3k samples out of it, at the SAME sample rate. k = 8, so
PCM_GROUP = 24 and the engine writes TB = 248 to `$26`. Everything that models
the timer now imports `GATE_CY` from the generator instead of re-deriving 2304 —
that constant had SEVEN copies, which is what made every previous change to it a
bug hunt. `PCM_TB` is generated into mixer.z80 so the engine's own `$26` byte
cannot drift from the harnesses'.

The measured trade, on `budget:frame` + `npm run dac`, sweeping k alone:

    k= 1 (GROUP  3)   74% · lost 16/s · 110% · hold  3.6      <- was shipping
    k= 2 (GROUP  6)   74% · lost 16/s · 106% · hold  4.4
    k= 4 (GROUP 12)   82% · lost 11/s · 101% · hold  8.4
    k= 8 (GROUP 24)  100% · lost  0/s ·  97% · hold 16.4      <- the knee
    k=16 (GROUP 48)  100% · lost  0/s ·  95% · hold 29.7

**Widening alone doubles the DAC's hold, and the cause was NOT the pad's bank
rate** — at k=8 the hold sat at 16.4 for every `PAD_TARGET` from 260 to 340.
It was `pcm_pad`'s shortcut: any voice sounding and it stored a pad of **1**, so
the SILENT pass ran at full speed, banked the time it did not spend, and the
gate handed it back as one hold at the group's end. At GROUP = 3 that was three
samples' worth and invisible; at 24 it is the whole in-frame hold.

`pp_pad_floor` now stores **`PCM_IDLE_PAD`** — the pad the generator already
computes for an idle iteration. Sweeping it alone:

    floor  1   97% · lost  0/s · hold 16.4
    floor 10   98% · lost  0/s · hold  7.4      <- PCM_IDLE_PAD, taken
    floor 14   99% · lost  3/s · hold  4.8
    floor 16  102% · lost 13/s · hold  3.6      <- the old hold, at the old tempo

That last row is the frontier stated plainly: the pre-existing 3.6-period hold
was only ever available at 102%+. **7.4 periods is what full-speed music costs.**

> **build-engine's pcm_pad assertion fired, and it was right.** The wider window
> amortises the gating emit's 141-cycle premium over 24 samples instead of 3, so
> a sounding frame got cheap enough to afford a real pad and the old shortcut
> would have kept handing out the floor. The check is now one-sided — the
> shortcut may be GENEROUS, never stingy — and compares against PCM_IDLE_PAD.
> Note `verify:all` does NOT run build-engine, so this only fires on
> `node tools/build-engine.mjs` / `emit-bin`; worth wiring into the gate.

**Still open, and the reason the hold is 7.4 rather than 3.6:** the pad is a
constant, so a group's unspent slack still lands at its end. An AIMED pad (hold
sample i to groupStart + i x period) simulated at 4.5/1.8 holes a frame against
the flat pad's 4.5/10.0 — see the earlier entry. It needs a debt counter the
per-sample cost of which is not yet priced.

### 2026-08-10 — hardware after the window change, and where the clicks are now

Readout (BlastEm, their example program), against the previous 74% / lost 16:

    Music x256 00FC (98.4%) · host 00FE · 1s 00F7 · worst 1s 00DD
    lost/s 2 · starv 0127 · starv/s 1 · audible 13CB

**`starv/s` was 0 and is now 1, and the program's own hint line reads that as
"the 68000 is the bottleneck".** It is not a regression in the 68k: the Z80 went
from consuming 74% of the frames to 99%, so it now drains the slot ring at the
rate the host fills it and the host's jitter stopped being hidden by a slow
engine. **RING_DEPTH 3 -> 4**, which costs nothing — $1700..$17FF was already
reserved and unused, and the 68k reads the depth out of the published header at
runtime, so only the blob changes.

The model is ~2 points optimistic against this readout (it says 99% / lost 0
where the machine says 98.4% / lost 2). That gap is the 68000's bus grab, which
`--stall` prices and no default charges. **Assume ~2 points of hardware margin
on every number below.**

#### The clicks, located — and they are ONE cause with two faces

    PAD_TARGET   music  lost/s   in-frame hold   frame-boundary hold
       260        99%     0        7.4/8.3          10.9/130.6
       280        99%     1        6.2/7.1          11.0
       300        98%     1        4.1/6.0          11.3
       310        79%    13        3.6/5.1            —

- **`PAD_TARGET` is capped at ~302 by arithmetic, and the cliff is measured
  there**: pad + mix + out-of-loop = 166.6 x PAD + 9,395, which passes 59,736 at
  PAD = 302. Nothing above that is reachable without removing out-of-loop work.
- **The frame-boundary hold does not respond to the pad at all** (10.9 -> 11.3).
  It is ~3,900 cycles = the ISR's tail + the Z80's idle + the next frame's head
  before its first emit. At PCM_GROUP = 3 it was NEGATIVE (-5.6, i.e. no hold)
  for an ugly reason: the engine was 10% over budget and never finished early,
  so it emitted right up to the interrupt. **Fixing the tempo created the idle
  time the DAC now holds through.**
- Re-sweeping the window WITH the idle-pad fix in place (the earlier k sweep
  predates it) still puts the knee at k=8; the hold rises monotonically with k
  and k=8 is the only point with lost 0/s:

      k=3 (GROUP  9)  74% · lost 16/s · hold 3.6      k=6 (18)  96% · lost 3/s · hold 6.3
      k=4 (12)        78% · lost 13/s · hold 4.4      k=8 (24)  99% · lost 0/s · hold 7.4
      k=5 (15)        87% · lost  8/s · hold 5.3

**Both holds are the same mechanism**: inside a group the loop runs ahead of the
timer and the wait lands as ONE gap — at the group's end (7.4 periods, ~7 a
frame, ~415 Hz) and at the frame's start (10.9 periods, 60 Hz). No constant
removes it; the pad is a constant and cannot know how much of the group is left.
**The AIMED pad is now the only item left on this line**, and the earlier
simulation put it at 4.5/1.8 holes a frame against the flat pad's 4.5/10.0.

Settled: k=8, PAD_TARGET 260, pp_pad_floor = PCM_IDLE_PAD, RING_DEPTH 4.

### 2026-08-10 (2) — depth 4 confirmed on hardware; the PAD is now the tempo cost

    starv 0127 -> 0007 · starv/s 1 -> 0        RING_DEPTH 4 worked
    clicks: GONE (their ear)                   the PCM_IDLE_PAD floor worked
    Music x256 00FA (97.7%) · lost/s 9 (peak C) · 1s 00D9 (84.8%) · worst 1s 00CC

**Removing the starvation made `lost/s` WORSE (2 -> 9), and that is not a
regression — starvation was a relief valve.** A frame with no slot is a cheap
frame; with the ring always full the engine does a full frame's work every
frame, sits at ~100%, and any jitter tips it into a missed interrupt. The
catch-up then makes the next ISR do two frames, which misses again: that
cascade is the `1s` dropping to 85% while the average stays at 97.7%.

**`seg-bench`'s PER TIMER B GROUP section was still hardcoded to 3 samples** —
it did not follow PCM_GROUP, so every per-kind number printed after the window
change was measuring the wrong window. Fixed (it derives the budget from
GATE_CY / PCM_GROUP now). With the right window:

    OVER budget: 33% of groups, excess 4,472 cyc/frame
      if this kind alone cost nothing:
        pad (idle by design)   3537    <- the largest single item
        mix tick bodies        3531
        segment set-up         2382
        PCM commands           ~1650

**The pad that fixed the clicks is now the biggest thing costing tempo.** That
is the same trade as before, seen from the other side: a pad in a group with
slack is FREE (the group ends when the timer says it does either way), and a pad
in a group already over budget is pure loss.

#### ATTEMPTED and REVERTED: making the gate switch the pad off when behind

The signal is free — if Timer B's overflow is up on the FIRST look in
`gate_wait`, the engine arrived late rather than early. Test bit 1 alone, not
the combined `and $82 / cp $02`, because BUSY is normally set there (the emit
just wrote $2A) and asking for both reads "not late" every time.

Built, gated clean (verify:all exit 0), frame 58,731 -> 57,995 (98% -> 97%),
music x256 00ff. **But the DAC's in-frame hold went straight back to 16.4 —
the no-pad value — so the "late" branch fires nearly every group and the pad is
effectively disabled.** That trades the clicks back for the tempo, which is the
wrong direction from where their ear is. Reverted.

Worth knowing before the next attempt: the engine emits its 24 samples in
~7,600 cycles against a group of 8,602, so it should arrive EARLY most of the
time. It does not. Find out why before rebuilding this — the flag may be up
from an overflow inside the group (the gate only clears it at the group's end),
in which case the test needs to distinguish "up since before I started" from
"up because the group boundary passed while I worked".

#### Where the margin has to come from

`budget:frame --stall` cannot reproduce the machine's lost/s even at 2000
cycles of bus grab: it stays at lost 0/s and 100%. The frame is simply AT the
line — 59,547 of 59,736 at stall 2000, **189 cycles of margin.** Widening the
window further buys almost nothing (k=8 98%, k=12 97%, k=16 96%) and costs the
DAC (in-frame hold 7.4 -> 10.2 -> 11.3), so it is not the lever.

The measured levers left, in order: the pad made conditional (3,537, needs the
question above answered), the ring reshaped to one 256-aligned page (1,052,
measured earlier and costs no DAC quality), PCM commands (~1,650).

### 2026-08-10 (3) — the window is 36 samples. Hardware picked it, not the model.

    k= 8 (GROUP 24)   music 98.0% · 1s 84.8% · worst 1s 81.6% · lost/s 9 (peak B) · starv/s 0
    k=12 (GROUP 36)   music 99.2% · 1s 98.0% · worst 1s 96.5% · lost/s 1 (peak 2) · starv/s 1

**The model said this was worth one point (98% -> 97%) and on hardware it was
worth the whole cascade.** `1s` going 84.8% -> 98.0% and `worst 1s` 81.6% ->
96.5% is the catch-up loop breaking: at k=8 the frame sat close enough to the
line that a missed interrupt made the next ISR do two frames, which missed
again. One more point of margin stops the first miss and the rest never happens.

> **A model that reports a linear cost can be hiding a threshold.** Nothing in
> `budget:frame` distinguishes 98% from 97% — both read `lost 0/s`. The machine
> distinguishes them by a factor of nine. Sweep on hardware near the line.

The DAC's in-frame hold goes 7.4 -> 10.2 periods and the frame boundary 10.9 ->
10.0. Their ear: the clicks did NOT come back; occasional dropouts remain, and
`starv/s` is back to 1 (16 in 6,320 frames) — the engine now drains the slot
ring faster still. $1800..$18FF is free, so RING_DEPTH 5 is the next free thing
to try against that, at one more frame of host->music latency.

### 2026-08-10 (4) — RING_DEPTH 5. The dropouts are gone; the arc is 74% -> 99.6%.

    depth 4   music 99.2% · 1s 98.0% · worst 96.5% · lost/s 1 · starv 16/6320 · starv/s 1
    depth 5   music 99.6% · 1s 98.0% · worst 94.9% · lost/s 1 · starv  5/5722 · starv/s 0

Their ear: **the dropouts are gone**, the tempo wobbles only very occasionally.
The fifth slot went into $1800..$18FF, which was free; the image is still
7,282 B and the 68k reads the depth out of the published header, so only the
blob changed. Cost is one more frame of host->music latency (five now).

**The whole round, on the machine:**

    before   music x256 00BC (74%) · lost 16/s · clicks · one note then a hang earlier still
    after    music x256 00FF (99.6%) · lost 1/s (peak 2) · no clicks · no dropouts

Three constants did it — `TIMER_B_K` 1 -> 12, `pp_pad_floor` -> PCM_IDLE_PAD,
`RING_DEPTH` 3 -> 5 — and none of them would have been found without the
per-kind counterfactual and the window sweep saying the frame's total work was
never the problem.

**Where the last 0.4% is.** `host x256` reads 00FE (99.2%), i.e. the 68k's own
main loop misses ~0.8% of vblanks, and `starv/s` is 0 so the ring is not dry.
By the example program's own diagnosis that puts the remainder on the Z80 —
but the two numbers are now within noise of each other and of 100%, and
`budget:frame` cannot resolve differences this small (it reads lost 0/s across
the whole region). **Do not tune further against the model; only the machine
can see it.**

### 2026-08-10 (5) — PCM_GROUP 48. The machine reads 0x0100 across the board.

    Music x256 0100 (100%) · host 00FE · 1s 0100 · worst 1s 0100 · lost/s 0
    starv 5 · starv/s 0 · no clicks · no dropouts · no tempo wobble

The hardware sweep, all with RING_DEPTH 5 and pp_pad_floor = PCM_IDLE_PAD:

    k= 8 (GROUP 24)   music 98.0% · 1s 84.8% · worst 81.6% · lost/s 9 (peak B)
    k=12 (GROUP 36)   music 99.2% · 1s 98.0% · worst 96.5% · lost/s 1 (peak 2)
    k=16 (GROUP 48)   music  100% · 1s  100% · worst  100% · lost/s 0

> **`dac-gate`'s hold number measures SPACING, not audibility, and I twice
> treated it as the second.** It flagged a real problem exactly once — the idle
> pass banking time with a floor pad, which was audible as clicks — and has
> over-predicted every time since. Going 24 -> 36 -> 48 took the in-frame hold
> 7.4 -> 10.2 -> 11.4 periods and the frame boundary 10.9 -> 10.0 -> 14.8, and
> NONE of it was audible. A frame-boundary hold is a regular 60 Hz jitter of the
> sample instant; the clicks came from irregular holes inside the group. Do not
> refuse a tempo win on the strength of this number alone — check it on the
> machine.

`host x256` is 00FE, so the 68k's own loop still misses ~0.8% of vblanks while
the music reads a clean 0x0100. Nothing left to chase on the Z80 side for one
variable voice.

**Budget for the dac1-3 spec, measured** (tests/budget-2v.mmlisp is the probe —
the shipped gate scores only overlap for a handful of ATTACK frames, which are
the most expensive frames there are and useless for a budget question):

    a pass, per frame at R = 175:   IDLE 700 · FIXED add 7,175 · VARIABLE add 13,650
    two VARIABLE voices, steady:    work 64,238 = 108% — over the vblank by 4,502
    one VARIABLE + one FIXED:       ~57,763 = 97%   — fits
    two FIXED:                      ~51,288 = 86%   — comfortable

So the spec's shape is right: **per-channel fixed/variable is what makes a
second channel affordable**, and two variable voices are 4,502 short against
~8,000 of identified-but-unspent cycles (pad 6,852, the ring's shape ~860, PCM
commands and the frame head ~2,400) — every one of which costs something.

### 2026-08-10 (6) — volume costs NOTHING until the work reaches the floor

Two measurement errors of mine, corrected, and then the rule that actually holds.

**Error 1: `seg-bench`'s gate model did not follow the window.** It returned
Timer B's flag as up once `fcyc >= GATE_CY`, which is harmless while a period is
1,075 cycles and catastrophic at 17,203: every frame opened with `gate_wait`
spinning up to a third of a frame, charged to whatever label was running. One
2-voice frame read 76,500 instead of 61,173. **Every per-kind number I took
after the window widened was inflated by it.** The flag is now simply up
whenever enabled, which is what "satisfied on demand" in the header always
meant. Two conclusions built on the bad number were withdrawn: that two
variable voices cost 108% (they cost 99%), and that the sample rate had to drop
to fit them (it does not).

**Error 2: `seg-bench`'s "pad" is cycles SPENT in pad loops, not cycles the
frame would get back.** Sweeping PAD_TARGET 260 -> 120 returns only 948 cycles
at two voices and 515 at one, while the DAC's in-frame hold goes 11.4 -> 29.7
periods. The pad is free where there is slack and refunds almost nothing where
there is not. **Do not treat it as headroom.**

#### The rule, measured

    vel 15 / 7 / 0     1 voice   57,215 / 57,230 / 57,224 cyc   (96%, flat)
                       2 voices  59,001 / 64,847 / 67,331 cyc   (99% / 109% / 113%)

**One sounding voice pays nothing for attenuation anywhere in the range** — its
work is ~20,000 under the timer's floor, so the `sra` chain is absorbed by gate
waits. Two voices sit AT the floor at 0 dB, so every step costs its full
1,460 cyc/frame immediately. The cost is not per step; it is
`max(0, work + volume - floor)`.

#### PCM_MAX_SHIFT = 4 (live/src/mmb.js, MML_PCM_MAX_SHIFT in mmlispseq.h)

The samples are 8-bit signed, so shift 5 leaves 3 bits, 6 leaves 2, 7 leaves 1 —
quantisation noise, not a quiet sample. Capping at 4 costs nothing audible and
bounds the two-voice worst case from 118% to 113% (2,920 cycles). It CLAMPS
rather than mutes, so `vol 0` / `master 0` remain the only hard mutes and the
documented "vel alone never silences a voice" still holds. The Z80's loop copies
for 5..7 are still generated and simply never selected — leaving them costs 
image bytes we have and makes the cap one constant to undo.

Also checked and rejected: a cheaper attenuation. `sra a` at 8 cycles is optimal
for one step (`cp $80 / ccf / rra` is 15), and a 256-byte LUT is flat 27 cycles
via `ld ixl,a` + `ld a,(ix+0)` — it wins from shift 4 up and would give smooth
256-level fades, but the table has to be rebuilt whenever the level moves (~5,000
cycles on the Z80, i.e. every frame during a fade) and `ld ixl,a` is undocumented
and absent from this repo's assembler and emulator. Parked.

### 2026-08-11 — XGM2's PCM loop, read. My reconstruction of it was wrong.

Read for structure only (`Stephane-D/SGDK`, `src/snd/xgm2/drv_xgm2_pcm_mac.i80`),
same terms as the 2026-08-06 pass: numbers and design decisions, no code.

**It is VOICE-OUTER, like ours** — one channel mixed across a destination buffer,
not all channels per output sample. Saturation is decided at RUNTIME on the
parity flag, not avoided by pre-scaling the data. There is no per-voice volume
in the inner loop at all. Source lives in the banked $8000 window and the bank
register is written once at macro entry, not per read. The mix buffer is 64
bytes; `sampleOutput` polls Timer A's flag and writes `$27` then `$2A`.

**So none of the three things I had reconstructed were true.** I had argued
sample-outer mixing, four channel pointers in DE/HL/IX/IY, and free saturation
from bake-time scaling — a coherent story built backwards from "14 kHz 4ch",
presented before checking. The real difference is two constants:

    per sample per channel   XGM2 42 T-states   ours 41 (+14 window) = 55
    per emit                 XGM2 ~67           ours 87

    4 voices at 14 kHz, period 256 cycles
      XGM2   4 x 42 + 67 = 235   fits
      ours   4 x 55 + 87 = 307   does not

**The whole 72-cycle gap is PACE_WINDOW (52 of it) and the emit (20).** The mix
loops are the same cost. There is no structural magic.

#### PACE_WINDOW = 14 is now the biggest unverified assumption in the repo

It charges every read through the $8000 window 14 Z80 cycles beyond the CPU's
own 7, for the 68000's bus arbiter. At four voices that is 52 cycles a sample —
over 12,000 a frame — and it is an ESTIMATE, never measured. XGM2 reads through
the same window and budgets nothing for it (its gate is a timer, so a slow read
eats margin instead of breaking). `seg-bench` and `frame-budget` both take
`--stall-read`, so bracketing 0 against 14 and comparing to the machine settles
it. **Every rate/voice table in this file is derived with 14 and moves if it is
wrong.**

#### Still unexploited from the 2026-08-06 read

`sampleOutput` is sprinkled at ~189-cycle intervals through ALL of their code,
not just the mix loop. I concluded "emit points cannot help" from measurements
taken when PCM_GROUP was 3; that premise expired when the window went to 48.
Re-evaluate. Their emit is not tied to the voice-pass count — the buffer
decouples it — and we have the same ring.

---

## PLAN — agreed 2026-08-11, to implement in a fresh session

Order is deliberate: each step's numbers depend on the one before it.

### 0. Calibrate PACE_WINDOW against hardware  (measurement only)

Everything below is costed with it. Build a config that sits NEAR the line (the
current one is clean at 100%, so it cannot discriminate) — two variable voices
is the natural probe, `drv/tests/budget-2v.mmlisp` already exists. Run
`budget:frame --stall-read 0` and `--stall-read 14`, put both beside the
machine's `music x256` / `lost/s`, and keep whichever reproduces it. If 14 is
too high, re-derive the rate x voice map before doing anything else.

### 1. Move MASTER volume out of the per-voice shift  —  DONE 2026-08-11

Landed, but NOT for the reason written below. The costing here was wrong twice
and the change is worth having anyway:

- **The fold was not costing 16,800.** The baked pads absorb roughly half of a
  shift chain. Measured, two voices going from shift 0 to shift 4 cost +8,624
  cyc/frame, and the first step is nearly free (+570). The plan's per-voice
  figure was the instruction count, not the frame's.
- **Applying master once per sample costs a dispatch the plan did not count.**
  The emit is inlined into twenty loop copies and has no free register, so the
  choice between a plain and an attenuated emit has to be a branch: a flat 12
  cycles a sample (2,000/frame) whenever master is not unity, on top of the 8
  a step. Net, at two voices: unity +67, shallow master ~+3,300, deep master a
  wash. **It buys no frame budget.**
- **What it does buy is the fade.** Folded in, master shared PCM_MAX_SHIFT with
  vel/vol, so a PCM voice stopped attenuating at -24 dB, held there for
  `master 12..1`, and fell off a cliff at 0 while FM and PSG kept going. Now
  master has its own deeper ceiling (PCM_MASTER_MAX_SHIFT = 6, -36 dB) and a
  total-shift mute (PCM_TOTAL_MAX_SHIFT = 7). Measured peak, one voice:

      master   31    28    25    22    19    16    13    10     7     4     1     0
      before  -3.1  -9.1 -14.9 -20.6 -26.6 -26.6 -26.6 -26.6 -26.6 -26.6 -26.6  -inf
      after   -3.1  -9.1 -14.9 -20.6 -26.6 -32.6 -36.1 -36.1 -36.1 -36.1 -36.1  -inf

Four things the plan did not mention and which cost most of the work:

1. **It is a format change.** Master had no path to the engine once it left
   PCM_VOL. `PCM_MASTER` (op 0x05, one byte) is new, and PROTO_VER went 7 -> 8
   because pcm_command RETURNS on an unknown opcode — an old image would ignore
   master silently.
2. **21 emit sites**, all from `feed()` and `feed_one` in gen-mixer, so one
   generator edit reaches all of them. The shift lives as PATCHED CODE
   (`mst_tab`/`mst_tab1`, `mst_apply` in engine.z80); affordable only because
   the 6 dB grid means a full fade patches ~7 times, not once a frame.
3. **The hot code ran into the header.** +512 bytes took CODE_END from ~$10EE
   past HDR ($1300) and NOTHING NOTICED — `org` keeps assembling. Fixed by
   moving `mst_apply` into the $1C00 once-a-frame region (140 B headroom left)
   and by giving z80asm an `assert` directive plus comparison operators, with
   `assert CODE_END <= HDR` in place. Check that first next time space is tight.
4. **Saturation order changed** — the sum saturates then attenuates, so a fade
   holds what the mix clipped and takes it down. Deliberate, recorded in
   driver.md §14.1.

Re-baseline came out exactly as proposed: five master-invariant PCM scores are
BIT-IDENTICAL on the DAC stream before and after, and only the master-moving one
moved (546/20002 samples, max delta 11). New gate `tests/m3-pcm-master.mmlisp`
walks master to 0 and is in `verify:engine`, along with `m3-pcm-volmix` which was
not there before — the Z80 sample-for-sample gate had NO master coverage at all,
and it is what caught a chain-displacement bug in this work.

The original text follows.

#### (original plan text)


`_pcmComposeShift` folds `(31 - master)` into EVERY sounding voice's shift, so a
master fade multiplies its cost by the voice count: three voices at -24 dB is
16,800 cyc/frame against ~9,000 of room, i.e. a fade-out breaks any multi-voice
build. Master is by definition common to all voices, so apply it ONCE per
sample in `feed_one` instead: 8 cycles a step per SAMPLE (1,333/frame) rather
than per voice-tick (1,400 x voices).

- `live/src/drv-player.js` (the spec), `drv/68k/mmlispseq.c`, and the generated
  `feed_one` in `drv/tools/gen-mixer.mjs` move together.
- **Saturation order changes**: today each voice is attenuated before the
  saturating add; after this the sum saturates at full scale and is then
  attenuated. That is a real audio change and `slot-gate`'s sample-for-sample
  comparison will move. Re-baseline deliberately, do not paper over it.
- Deep master + deep voice exceeds one period (348 + 32 > 358.4 at three
  voices), so mute past the point where both are deep.

### 2. Fixed (pitch-baked) voices

The measured prize: a fixed voice's tick is 41 against a variable voice's 78, so
three fixed voices cost 85% of a vblank where two variable ones cost 99%.

- **No MMB format change is needed.** "Pitch baked" simply means the 16.16
  increment comes out exactly 1.0, and `PCM_START` already carries `incF`/`incI`.
  The engine picks the no-resampler loop copy at `ms_bind` on
  `incI == 1 && incF == 0` — once per segment, not per tick.
- Generate the `nr` loop copies (`i8satnr` is already priced in gen-mixer as a
  control case) and dispatch to them.
- Export side: resample to the DAC rate at each note actually used, dedup
  identical blobs by hash. **One-shots only** — resampling moves a loop's points
  off integer samples, so looped material stays variable.
- **Bake ONE-SHOT PITCH, not volume.** Volume baking multiplies blobs again
  (pitch x level), permanently destroys bits at 8 bit, and buys nothing: volume
  is free while work stays under the timer's floor, and a fixed voice's runtime
  shift is 41+8s, still far cheaper than variable.
- **Stamp the bake rate in the MMB and check it at load.** Baked data is
  rate-bound; without a stamp a rate change becomes "the pitch is slightly off",
  which is the least debuggable failure there is. A shared sample bank is
  therefore bound to one rate.

### 3. Then re-decide the rate  (depends on 0 and 2)

Derived map, at PACE_WINDOW 14 — treat as provisional until step 0:

    rate    可変1   可変1+固定1   可変2   固定2   固定3
    10 kHz   58%      74%         84%     63%     82%
    12 kHz   68%      86%         98%     74%     95%
    14 kHz   77%      98%         period  84%    108%
    16 kHz   86%      period      period  94%     period
    18 kHz   95%      period      period 104%     period

"period" = one iteration no longer fits a sample period, which bites before the
frame budget does as the rate rises. Raising the rate touches
`PCM_SAMPLES_NUM/DEN` in three implementations, so it is a bigger change than
the window was; do it after the cheap wins, not before.

### Not doing, and why

- **Volume LUT.** CLOSED 2026-08-12, on requirements rather than cost: a stepped
  DAC level is the model, so the smooth 256-level fade it buys is not wanted
  (driver.md §14.1). The cost arguments stand behind that and are recorded so
  the question is not reopened as if it were cheap — the table must be rebuilt
  whenever the level moves (~5,000 cycles on the Z80, i.e. every frame during a
  fade) and `ld ixl,a` is undocumented and absent from this repo's assembler and
  emulator.
- **Per-channel max-attenuation declaration.** Dropped in priority: volume costs
  nothing while work stays under the floor, so the single `PCM_MAX_SHIFT = 4`
  suffices. That cap is also load-bearing for three voices — at U = 3 a fixed
  voice at shift 5 needs 372 cycles against a 358.4 period.

### 2026-08-11 (2) — step 0's probe, corrected twice

**The plan's `budget:frame --stall-read` does not exist.** That flag is
`seg-bench`'s. `frame-budget` had `--frames`, `--pump` and `--stall`, and
`--stall` is the 68000's bus grab in cyc/frame — a different, also unmeasured
quantity, left at 0.

**And sweeping PACE_WINDOW itself is a bad probe, because it acts twice in
opposite directions.** `padFor` SUBTRACTS `fetches x PACE_WINDOW` when it sizes
the generated pad; `frame-budget` ADDS `winReads x PACE_WINDOW` when it times
the frame. Lowering the constant grows the pad in the ROM while shrinking the
model's frame and the two nearly cancel — the sweep moved a two-voice frame ~600
cycles where the charge itself is 4,667. That reads as "the probe cannot tell",
and it is a property of the sweep, not of the question.

`frame-budget` now takes **`--pace N`**, overriding the MODEL's charge only. The
build is held fixed and only the model is swept, which is the right shape: the
machine is what we are trying to identify.

**The second correction: the observable saturates below 100%.** Held fixed and
swept, `budget-2v` gives

    --pace  0   56,429 (94%)   music x256 00fa (98%)   lost 1/s
    --pace 14   59,001 (99%)   music x256 00f9 (97%)   lost 2/s

— the frame moves 4.3% and `music x256` moves ONE count, because nothing crosses
100% and the catch-up cascade never starts. Same lesson as k=8 vs k=12: this
system's observable is a threshold, so a probe has to STRADDLE it.

**`drv/tests/budget-2v-edge.mmlisp`** is tuned to do that — two voices, one
attenuated a single 6 dB step (vel 12 -> shift 1, +1,460 cyc/frame):

    --pace  0   56,704 ( 95%)   music x256 00fa (98%)   lost 1/s
    --pace 14   59,736 (100%)   music x256 00ed (93%)   lost 5/s

Five counts and a 5x on `lost/s`. Deeper is WORSE, not better — both voices at
one step lands at 99% and collapses back to a single count, because it stops
straddling.

Flashable build: `drv/out/probe/song.mmb` + `song.smp` (976 B / 534 B). Copy
over an SGDK project's `res/` — **back the real song up first**, the names
collide.

**Step 0 is blocked on one hardware reading**: that probe's `music x256` and
`lost/s`. ~98/1 says the window read is free and every rate x voice table in
this file is pessimistic; ~93/5 says PACE_WINDOW = 14 is right and they stand.

## 2026-08-27 — THE DAC HOLE, FOUND AND MEASURED. Branch `drv/dac-rate-probe`.

Every earlier attempt tuned a constant (PAD_TARGET, PACE_WINDOW, the rate, the
voice count) and none of them moved the artifact. They could not: the defect was
never a constant.

### The arithmetic that ends the guessing

A gated emit PINS the frame. `chunk` samples at one gate period each span
`chunk × PCM_TICK_CY` cycles however cheap the code between them is, and every
cycle the frame spends OUTSIDE that span is added to it — with the DAC holding
throughout, because there is no sample to send. So

    the DAC's hole per frame  =  frame code cycles  −  samples × sample period

and that hole falls in one contiguous stretch at the frame boundary, 60 times a
second. THAT is the 60 Hz sideband. Nothing else was ever wrong: `a2-flat` (the
same bytes on a flat clock) has always been −46 dB.

The corollary is why the emit's own cost is NOT the lever: making the emit 44
cycles cheaper moved the frame by 84 cycles, because the saved cycles went into
the gate's spin, not into the frame. Only work REMOVED from the boundary, or
covered by an emit, shortens it.

### Why the boundary carried no emit

`G_EMITS` is the frame's quota, and `mix_seg_live` claimed every sample of it.
By the time the last pass ended the quota was zero, so `feed_one` — which is
already called at the pass transitions and every fourth chip write — returned
without emitting for the whole of the frame's tail, the ISR's epilogue and
prologue, and the next frame's slot head. Measured: 2 holes a frame, 3.45 sample
periods lost, both at 98–102 % of the frame.

### The fix (three parts, all measured)

1. **`PCM_EMIT_RESERVE = 3`** — `ms_paced`/`msl_paced` claim
   `min(iterations, G_EMITS − RESERVE)`, so the boundary has samples to send.
2. **Emit points through the boundary**: after the slot's PCM commands, after
   the segment plan, and in the frame's tail before `flush_rest`.
3. **An emit at the top of `mix_voice_frame`, BEFORE the sounding test** — the
   silent path (`mvf_idle`) ran pp_pass_done → consume_sub → voice_ptr →
   pp_sounding_at → ms_bind with no emit at all: 1,960 cycles, the largest
   recurring hole once the boundary was closed.

`out/diag/b-pcm1.mmlisp`, PCM_SPG=1, 150 frames:

    holes ≥1.5 periods   1.99/frame → 0.11/frame
    sample periods lost  3.45/frame → 0.40/frame  (and 0.40 is mostly frame 1)
    frame                61,782 cyc (103%) → 59,849 (100%)
    lost frames          16/s → ~5/s
    60/120/180 Hz        −12.5 / −10.4 / −17.8 dB → −19.3 / −28.9 / −23.3 dB

Ordering note that cost a gate failure: the head's emit must go AFTER the slot's
PCM commands. `PCM_MASTER` rewrites the emit, and a sample sent before the
command goes out at the previous frame's level — `m3-pcm-volmix` frame 15,
engine 132 vs reference 128.

### Also on the branch

* **`PCM_IDLE_PAD` could be generated as 0**, and the pad loop counts DOWN — 256
  iterations, ~4,000 cycles an idle tick, stored unguarded by `pp_pad_floor`.
  That is what made PAD_FRACTION=0.05 read 209 %. Floored at 1.
* **`emit_gate`** — at `PCM_GROUP = 1` every sample gates, so there is no phase
  to keep: AF' carries nothing, the dispatch branch the phase doubled as is
  gone, and the emit collapses from 24 inline copies with a master chain apiece
  into ONE out-of-line routine. 226 → 182 cycles a sample and ~1,100 bytes back.
  `MST_N = 0`; `mst_apply` needed a guard for it. `EG_R27P` lets `cs_r27` patch
  the $27 byte into the emit's own immediate (−6 a sample).

### THE STANDING CONSTRAINT — Timer B cannot gate faster than 3,329 Hz

Its shortest period is 16 FM samples. Per-sample gating therefore needs
`PCM_GROUP = 1`, which is `PCM_SAMPLES_PER_GATE = 1` — 3,329 Hz. Timer A's
shortest is one FM sample (53 kHz), which is why XGM2 uses it and we cannot.

Same tree, same score, the two rates:

    S=1  3,329 Hz  every sample gated   100% of a vblank  −19.3 / −28.9 / −23.3 dB
    S=3  9,987 Hz  1 sample in 3 gated  112%              −6.5 / −20.7 / −17.9 dB
                                        27.8% of samples held past 150%

Above 3,329 Hz the intermediate samples are paced by CODE PLACEMENT, and no pad
constant makes lumpy out-of-loop work uniform. **The rate and the artifact are
the same decision.**

### Where the remaining 13 dB is

`d-flat` — these values on a perfect clock — is −32.2 dB, so that is the ceiling
for this test, not −46. We are 13 dB under it, and `seg-bench` names the cause:
937 cyc/frame "after the last sample" that no emit point can reach — the ISR's
epilogue, `reti`, the next interrupt's prologue, and `frame_step`'s head before
the quota is settled. It shows up as the emit interval by tenth of the frame:

    1001  1074  1075  1075  1075  1075  1083  1067  1075  1165   (nominal 1075)

— exact through the middle, 8 % long in the last tenth, catching up in the
first. A clean sawtooth at 60 Hz, and it is the whole of what is left.

**NOT VERIFIED ON HARDWARE.** Nothing here has been to a Mega Drive.

## 2026-08-29 — THE DAC IS A PRODUCER/CONSUMER NOW. Branch `drv/dac-rate-probe`.

Waiting for the gate put Timer B INSIDE the interrupt. At one sample per gate
that is 55 waits of a full period — 97% of a vblank of pure spin against 40% of
actual work — and an ISR that long loses the next vblank outright whenever a
frame runs heavy. A lost vblank is a lost frame of music, which is the tempo
wobble, not a hiccup. Measured before the change: work 23,602 cyc, wall 59,290.

**Nothing blocks any more.**

* `emit_try` replaces `emit_gate`: 38 cycles to answer "not due", and the caller
  carries straight on. Whoever is running when the timer comes due sends the
  sample. This is XGM2's structure and its "≤168 cycles between sample outputs
  EVERYWHERE" rule is what makes it work — the rule is not advice, it is the
  contract, because **Timer B's flag is ONE BIT and a missed overflow is gone.**
* `idle:` is a feed loop, not a `halt`. The interrupt does the frame's work and
  returns; the other ~67% of the frame is the DAC being fed.
* The per-frame emit debt is gone. The **ring's fill** is the accounting: the
  mixer adds what it wrote, every send takes one back, and a send is legal
  exactly when something is finished. A frame quota cannot survive a
  non-blocking send — the count a frame gets out varies, and resetting per frame
  turns the surplus into skipped and repeated samples.

`~/Desktop/sin008.mmlisp`, 3,329 Hz, 1,800 frames (30 s):

    ISR                 p50 19,831 cyc (33% of a frame) · p95 40%
    tempo               1,800 frames in 1,800 vblanks · lost 0/s · x256 = 0100
    sample stream       a2-flat -46.6 / -53.1 / -52.2 dB (correct)
    DAC clock           -21.5 / -36.9 / -29.5 dB   (d-flat's ceiling: -32.2 / -47.2 / -49.7)
    holes               0.51 sample periods a frame (was 3.45)
    startup silence     gone (the prime frame no longer parks the DAC)

### Three bugs this cost, all of them invisible without measurement

1. **The idle loop and the interrupt raced for `G_RD`.** Read, advance,
   write-back is not atomic against a vblank landing inside it: the handler runs
   a whole frame, advances the cursor, and then the idle loop writes its stale
   copy back. The cursor rewinds, `G_FILL` stops matching it, and since the
   mixer takes its write cursor from `G_RD + G_FILL` it walks out of the ring
   and over the engine's own code. Presented as a hang. Fixed with `di`/`ei` —
   ~200 cycles against the VDP's ~228-cycle /INT, so a vblank inside it is
   delayed, never lost.
2. **The prime frame counted the lead twice** (510 in a 512-sample ring).
3. **`mix_seg_live` still tested the debt that no longer existed**, so every
   segment took the unpaced path and the mixer emitted nothing at all. Fixing it
   took `a2-flat` from −24 dB back to −46.6.

`G_FILL` is clamped at `PCM_FILL_MAX` as a backstop: the mixer adds a chunk a
frame whatever happens and the feed only sends when a gate is BOTH due and
asked for, so a persistent deficit climbs until the write cursor leaves the ring.
The clamp turns "the driver hangs" into "a sample is lost"; the fix is that no
stretch runs longer than a period.

### Harnesses

`halt` no longer means "the frame is done". Every harness runs a frame for
FRAME_CYCLES instead, which is what the hardware does anyway (a halted Z80 burns
4-cycle NOPs). Changed: run-trace, slot-gate, engine-gate, dac-gate, dac-wav,
song-check, frame-budget. frame-budget and song-check now report the ISR's own
length — cycles until the engine first reaches `idle` — because counting to the
vblank would report 100% for every score and say nothing.

### NOT DONE

* **`engine-gate` fails 8 of 12 scenarios.** The DAC's per-frame write count
  changed by design (the prime frame sends 25 samples where it used to park with
  one write). `drv-player.js` is the port spec and has NOT been moved to the
  ring-fill model. **This is the remaining work.** `c-gate` (the 68k sequencer),
  `ring-gate` and `sgdk-lint` are all clean — nothing on the 68k side moved.
* 0.51 sample periods a frame still lost. `scratchpad/asks.mjs` measures the
  stretches that cause it directly.
* **9,987 Hz (K=16) is broken by this** — the build is 3,329 Hz only.
* Never run on hardware.

## 2026-08-29 — HARNESS CALIBRATION: it FAILED, and that is the finding.

Two points from the machine (BlastEm), same score (`sin008.mmlisp`, 3,329 Hz),
two engine revisions:

    A  badd4fa   music x256 00CB (79%)   lost/s 12   starv/s 0   host 99%
    B  4d73e40   music x256 0100 (100%)  lost/s 0    starv/s 0   host 99.6%

`frame-budget` at its defaults reports **100% / 0 lost for BOTH**. So the model
is wrong, and the question was whether a constant fixes it.

### The sweep

Three knobs, swept against both points at once — two points with opposite
outcomes, so a fit cannot be the coincidence the 2026-08 note warns about:

* `--pace` (the $8000 window read): 0…250. Moves A from 91% to 70%; never
  moves B. On its own it cannot reach 79% with 12 lost.
* `--busy` (YM2612 BUSY after a data write): 90…600. **450 reproduces both
  points exactly, hex digit for hex digit.**
* `--ym` (a flat cost on EVERY $4000–$4003 access, a different shape): 0…80.
  **55 also lands near both points.**

### Why both fits are spurious

At the fitted values the model's own internal state contradicts its output:

    --busy 450 : ISR p50 335% of a vblank, 98.2% of interrupts overrun → music 79%
    --ym   55  : ISR p50 346% of a vblank, 100%  of interrupts overrun → music 74%

An engine that overruns EVERY interrupt by 3.5x cannot be consuming 79% of its
frames. The knobs are not finding the machine's cost; they are pushing the
model over a cliff, and past the cliff `music` SATURATES at ~73% no matter how
large the constant gets (55 → 74%, 58 → 74%, 60 → 73%, 80 → 72%).

**The tool's host/interrupt coupling is a step function, not a curve, so there
is nothing to calibrate against.** Fitting a constant to it would have produced
exactly the kind of number the earlier note warns about — one that matches the
measurement it was fitted to and mispredicts the next change.

### What the model is actually missing

Its ISR distribution is **p50 43%, p95 54%, max 128%**. The machine's 12 lost/s
means ~20% of frames run past a vblank. There is no mechanism in the model that
puts a fifth of frames past 100% while the median sits at 43% — the shape is
wrong, not the scale. Whatever the machine charges, it charges it with far more
VARIANCE than anything modelled here.

### Harness fixes made along the way (these are real, and they stay)

* **`z80cpu.mjs`: /INT is a PULSE, not a latch** (`Z80Cpu.INT_PULSE = 228`,
  `decay()`). The latch made a `di` of any length free, which is how a `di`
  longer than the VDP's pulse reached a ROM and played nothing at all while
  every gate stayed green. Harnesses age it now.
* **The frame loop no longer stops at FRAME_CYCLES.** It ran the ISR to
  completion first; capping it hid every overrun and reported 0 lost against a
  machine losing 12 a second.
* **`frame-budget` reports "ISR past its own vblank"** — the share of interrupts
  that overran. That is the number the machine's `lost/s` is.
* **`--stall` is charged as REAL TIME at the frame head.** It used to be added
  to the reported cost after the fact, so sweeping it could not change whether
  the interrupt overran — it moved the number and nothing else.
* **`--busy` and `--ym`** are knobs for the two distinguishable YM cost shapes.

### The next job, and it is not speculative

Make the model's host/engine coupling match the C: the Z80 takes an interrupt
only if it is not still inside the previous ISR, and the catch-up is driven by
`H_VBL` exactly as `mmlispdrv.c` drives it. Until `music` responds to load as a
CURVE, no constant in this tool means anything.

### 2026-08-29 (later) — the harness IS calibratable now, and there is a test

The step function was the tool's own **host/interrupt coupling**. It ran one
ISR per iteration and re-aligned the clock to the vblank at the top of each
(`if (tcyc < nextVbl) tcyc = nextVbl`), so an overrun could never delay the next
interrupt and the interrupt was always delivered. `frame-budget` is a loop over
INSTRUCTIONS now, with vblanks at fixed instants: /INT is requested at the
instant and taken only if the Z80 can take it. An interrupt that arrives while
IFF1 is clear is LOST, which is the one rule that makes `music` move.

With that, `music` responds as a curve, and one constant reproduces the machine:

    --ym 55   (Z80 cycles charged on EVERY $4000-$4003 access, read or write)
      badd4fa  music 00C7 (78%)  lost 13/s     machine: 00CB (79%)  lost 12/s
      4d73e40  music 0100 (100%) lost 0/s      machine: 0100 (100%) lost 0/s

**It is one constant fitted to one observable, and the mechanism is unverified.**
A and B differ only in the catch-up, not in YM traffic, so they do not
discriminate the cost's SHAPE. The falsifiable test is the pair that does:

    ym=55 predicts   90bd83f (no per-write BUSY polls, 5 YM accesses an emit)  -> 100%
                     badd4fa (with them,               8 YM accesses an emit)  ->  78%

If the machine runs 90bd83f at 100%, the per-access cost is real. If it still
reads ~79%, the constant is a coincidence and the real cost is elsewhere.

Consequence either way: **the three per-write BUSY polls added in badd4fa were a
regression.** Under the calibrated cost they take the frame from 53.1 emitted
samples to 48.9 (against 55.48 nominal) and nearly double the DAC's holes
(1.86 -> 3.12 a frame). `EMIT_BUSY_POLLS` defaults OFF now; `EMIT_BUSY=1`
builds them back. The shape without them is what was demonstrably playing
before they were added.

# =====================================================================
# HANDOFF — 2026-08-30. Read THIS section first; the rest is detail.
# =====================================================================

Branch `claude/plan-68k-split-handoff-2dlw0v`, from `drv/dac-rate-probe`.
**`main` is untouched.** The engine is UNCHANGED — still ea020d4's revert to
4d73e40, the only state a machine has measured at 100%.

## THE LOOP IS CLOSED. You can measure without asking anyone.

    sh drv/blastem/setup.sh                                    # once
    node drv/tools/blastem-probe.mjs drv/tests/m3-pcm-softmix.mmlisp --seconds 10

BlastEm builds as a libretro core with no SDL and no display, and
`drv/verify-rom/` is a Mega Drive ROM that plays a score through the SHIPPED
glue (mmlispdrv.c, mmlispseq.c, the engine image) and publishes the example
program's counters into 68000 work RAM, which the frontend reads straight out
of the core. Output: the four numbers, plus the YM2612's own 53 kHz stereo
output as a .wav. **No listening round, no desktop, no hardware.**

Add `MMLISP_PROBE_LOG=<file>` and the patched core logs every $2A write, every
68000 bus grab and every Z80 vblank; `tools/dac-log.mjs` reads it.

Three toolchain traps are documented in `drv/verify-rom/README.md` and all
three present as the ROM dying silently — read that file before touching the
build.

## THE DIAGNOSIS, AND IT IS MECHANICAL NOW

    music x256 0100 (100%) · host 00ff · lost/s 0 · starv/s 0
    rate 2267 Hz measured against 3329 nominal — 68.1% of the samples owed
    17.89 sample periods LOST a frame
    by tenth of the frame:  2412 3380 1606 1149 1181 1148 1117 1086 1252 1568

The sequencer is exactly on time and a THIRD OF THE SAMPLES NEVER HAPPEN. That
is why "it sounds unstable" survived every green gate: `music` counts FRAMES,
and a frame can be on time while the samples inside it are not.

`tools/frame-budget.mjs --starve` charges every cycle executed after the sample
clock is already overdue to the PC executing it (the emulator's x86 JIT cannot
do this; the JS Z80 interprets, so it can):

    cycles spent PAST the sample deadline: 20267 a frame (18.8 sample periods)
      pd85     6378  31.5%    mix_add_s9_lp's pacing pad — a MUTED voice
      pd5      3960  19.5%    mix_first_s1_lp's pacing pad
      et_busy  2026  10.0%    the emit's own YM BUSY poll
      emit_try  691   3.4%

`pd*` are the mixer's pacing delay loops (`src/mixer.z80`, generated):

    mix_add_s9_lp:
            call emit_try          ; a sample IF one is due
            ld   a,(G_PAD)         ; pace: what this frame can afford
    pd85:   dec  a
            jr   nz,pd85
            ...

One ask, then a spin of up to a few thousand cycles. **Timer B's overflow flag
is ONE BIT — a missed overflow is gone for ever**, so every spin longer than a
sample period is a permanently lost sample. That is XGM2's rule
("<=168 cycles between sample outputs EVERYWHERE") being violated by the pacing
mechanism itself, and it accounts for over half the deficit on its own.

## THE MODEL IS NOT THE BLOCKER IT WAS DECLARED TO BE

The 2026-08-29 note ended "the model cannot predict this machine ... every
engine change is a guess". That was about `music x256`/`lost/s` on a different
revision. For **the DAC's sample clock** the model and the machine agree to
within a percent:

                         model     machine
      rate             2271 Hz     2267 Hz
      p05/p50/p95   782 1083 1630   781 1081 1641
      periods lost/frame 18.08       17.89

    PCM_SPG=1 TIMER_B_K=1 node tools/frame-budget.mjs <score> --probe-log out/model.log
    node tools/dac-log.mjs out/model.log      # and out/probe.log for the machine

So the DAC work can be done in JS at JS speed. Keep the comparison honest by
re-running the emulator after each change rather than trusting the model alone.

Still suspect in `frame-budget`: it reports "ISR past its own vblank 61%" while
`music` reads 0x0100 in the same run. The DAC numbers are sound; that internal
inconsistency is not, and nothing should be concluded from the ISR percentiles.

## THE OBVIOUS FIX, NOT YET AGREED

Make the pacing pads ask. A pad loop that calls `emit_try` instead of `dec a`
both paces and feeds, which is XGM2's structure. It changes the pad's
granularity (emit_try is ~38 cycles when not due) and needs the generator's pad
arithmetic reworked, so it is a design change and not a patch. Confirm before
implementing (CLAUDE.md).

## WHAT IS STILL TRUE FROM BEFORE

* The three machine-found bugs and their fixes stand (/INT is a pulse, the ring
  cursor must wrap on every emit path, a caught-up frame consumes its slot
  without mixing).
* The per-write BUSY polls are ON and removing them made the machine audibly
  worse; note that `et_busy` is now measured at 10% of the starvation, so this
  is a real trade and not a free win either way.
* `engine-gate` fails 8 of 12: `drv-player.js` has not been moved to the
  ring-fill DAC model. Unchanged, still the remaining port work.
* 9,987 Hz (TIMER_B_K=16) is broken; the branch is 3,329 Hz only.
* Never run on real hardware.
* The 68000's bus grab measures 665 cycles a frame across three grabs — about
  1% of the frame. It is not a candidate for anything, and frame-budget's fixed
  `--stall` charge is not what is missing from the model.

# =====================================================================
# HANDOFF — 2026-08-29 (superseded by the section above; kept for detail)
# =====================================================================

Branch `drv/dac-rate-probe`, 65 commits ahead of `main`. **`main` is untouched
and is the pre-DAC-work state.** Everything below is the probe branch.

Build the probe branch with BOTH knobs set, or you get a broken configuration:

    PCM_SPG=1 TIMER_B_K=1 node tools/install-sgdk.mjs <proj> --song <score>

## THE ONE FACT THAT SHOULD SHAPE WHAT YOU DO NEXT

The machine (BlastEm, `verify-hello-world`, `~/Desktop/sin008.mmlisp` — a PCM
drum track) reports, on the engine now on the branch:

    music x256 0100 (100%)   lost/s 0   starv/s 0   host 99.6%

**and it still sounds badly unstable.** The frame budget is NOT the problem. The
sequencer is consuming exactly one slot per vblank. What wobbles is the SAMPLE
CLOCK: the intervals between $2A writes. On a percussion track that is
indistinguishable from tempo wobble by ear, which is why it was misdiagnosed as
one for several rounds.

So: stop looking at `music x256`. It is green and it is not the question. The
question is why the emit interval is not 1075 cycles every time.

## WHAT IS VERIFIED ON THE MACHINE

Three bugs, all found by running on BlastEm, none of them visible to any gate:

1. **A `di` longer than the VDP's /INT pulse destroys the vblank.** The pulse is
   ~228 Z80 cycles and it is DROPPED, not latched. An idle loop guarded by `di`
   played nothing at all. `z80cpu.mjs` models /INT as a pulse now
   (`Z80Cpu.INT_PULSE`, `decay()`) and the harnesses age it.
2. **The ring cursor must wrap on every emit path.** The inline emit relied on
   the mixer's segment bounds keeping it short of RING_TOP — true only while the
   feed advanced in step with the mix, which it stopped doing when the idle loop
   began feeding. It read the engine's own code as samples.
3. **The catch-up compounds.** An ISR that overruns loses the next interrupt;
   the catch-up then runs two frames inside the following one and overruns
   again. It settles into a steady loss (measured 79% music, 12 lost/s) and
   never recovers. A caught-up frame now consumes its slot without mixing.

## WHAT IS FALSIFIED

**"The machine charges N cycles per YM access" is WRONG.** `frame-budget --ym 55`
reproduced both hardware points exactly, and predicted that removing the
per-write BUSY polls would take the losing revision from 79% to 100%. On the
machine that change made things AUDIBLY WORSE. So:

* the fitted constant was a coincidence — do not resurrect it;
* **the per-write BUSY polls matter.** Writing the YM without waiting out BUSY
  loses writes on this machine, and a lost $2A write is a dropped sample.
  `EMIT_BUSY_POLLS` is ON in the engine now on the branch.

## WHAT IS STILL UNKNOWN, AND IT IS THE BLOCKER

**The model cannot predict this machine.** `frame-budget` puts the ISR at p50
43% of a vblank; the machine's behaviour on the revision it lost frames on
requires ~20% of frames past 100%. The shape is wrong, not the scale, and the
three knobs (`--pace` the $8000 window, `--busy` the YM BUSY window, `--stall`
the 68000's bus grab) cannot produce it. Every attempt to fit one produced a
number that matched the observable and mispredicted the next change.

Until the model predicts the machine, every engine change is a guess, and each
guess costs a build-and-listen round of the user's time. **Do not spend those
rounds on guesses.** Fix the model first, or measure the machine directly.

## THE TOOLS, AND WHAT THEY ARE WORTH NOW

* `frame-budget` — rewritten as a loop over INSTRUCTIONS with vblanks at fixed
  instants: /INT is requested at the instant and taken only if the Z80 can take
  it. This is what made `music` a curve instead of a step. Reports the ISR's own
  length (cycles to the idle loop) and "ISR past its own vblank". Trustworthy in
  SHAPE; its absolute cost model is not calibrated.
* `scratchpad/holes.mjs` — emit-interval and hole analysis on the real $2A
  stream, with the interval broken down by tenth of the frame. **This is the
  tool that matters for the remaining problem.**
* `scratchpad/asks.mjs` — the XGM2 rule, measured directly: the stretches where
  the engine runs longer than a sample period without asking `emit_try`. Every
  one of those is a Timer B overflow lost for ever (the flag is one bit).
* `engine-gate` FAILS 8 of 12. The DAC's per-frame write count changed by design
  (the ring's fill drives the feed now, not a per-frame quota) and
  `drv-player.js` — the port spec — has NOT been moved to that model. `c-gate`
  (the 68k sequencer), `ring-gate`, `selftest` and `sgdk-lint` are all clean;
  nothing on the 68k side moved.
* **9,987 Hz (TIMER_B_K=16) is broken by this work.** The branch is 3,329 Hz only.

## PROCESS, AND THIS IS THE PART I GOT WORST

* I shipped stacked changes and then could not attribute a regression. **One
  variable per build.**
* I reported metric movement as progress. The user's judgement — "it has never
  once been good" — is the correct summary of the whole line of work.
* I asked for listening tests that were my experiments, not improvements. If a
  build is an experiment, say so, and only ask when the answer actually
  discriminates between hypotheses.
