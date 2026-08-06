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

**What is left of (b): the register file itself, ~2,659 cyc/frame (4.5%).**
`mix_seg` 1,981 (its IX-indexed load of frac/incF/incI/ptr) + `ms_done` 678 (the
store back). Carrying those across a voice's consecutive segments needs
`mvf_seg`'s boundary math to stop reading `PV_PTR` from the struct and work out
of DE instead — with IX and IY both already committed, that means parking
`oldptr` in the alternate `BC'`. It is a real rewrite of the interlock between
hand-written `mvf_seg` and generated `mix_seg`, verifiable only in emulation.
**Deliberately not attempted yet**: the margin recovered above is already larger
than the deficit, and the hardware numbers from (1)+(2) should say whether more
is needed before that risk is taken.

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
