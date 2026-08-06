# MMLispDRV — Z80 assembly port (Phase 3, step 3)

> ## ⚠ Superseded by the 68k/Z80 split (2026-08-02)
>
> Everything below describes the **all-Z80 driver**, in which the Z80 both
> sequenced the score and mixed PCM. Cycle measurement showed those two
> workloads do not fit in one Z80 — 2 PCM voices at the theoretical floor is
> 99.7% of the frame with the sequencer executing zero instructions — so the
> sequencer moves to the 68000 and the Z80 becomes a PCM mixer and chip-write
> engine. See **`docs/driver.md` §1.1** for the measurement and the new
> architecture, and `.claude/memory/plan-68k-split.md` for the decision record.
>
> **In particular, the "68k offload is the architectural last resort" position
> in §2 of the deviations below no longer holds.** It was argued on *bytes*,
> and the code-overlay pass solved the byte problem; the binding constraint is
> now *cycles*, which no Z80-side technique moves by the required factor.
>
> What survives, and why this file is still worth reading: the MMB format,
> opcodes, level model, macro semantics, SE model, voice tables, the language,
> `export-mmb.js`, `drv-player.js`, `mmb-build`, `ab-gate`, the whole gate
> corpus, banking, the SGDK glue skeleton, and the first-party Z80
> assembler/emulator/trace toolchain in `tools/`. What is rewritten is ~5,600
> bytes of Z80 sequencing assembly, which becomes C on the 68000 with
> `drv-player.js` as its port spec. The measurements and the port deviations
> recorded here are the reason the new design looks the way it does.

The Z80 sound driver specified by `docs/driver.md` / `docs/mmb.md` /
`docs/opcodes.md`, ported from the JS reference implementation
(`live/src/drv-player.js`). Coverage: **M1 (core playback)**, **all of M2**
— motion (sweeps, PARAM_ADD, TEMPO_SWEEP), cent-interpolated NOTE_PITCH
(glide / vibrato / detune), FM3 CSM mode, PCM via the fm6 DAC, and the host
mailbox commands (KEY_OFF / SET_PARAM / FADE_TRACK) — plus most of **M3**:
**FM3 independent-operator mode** (FM3_MODE / FM3_OP_PITCH, driver.md §13.4),
the **macro engine** (MACRO_SET / MACRO_CLEAR, driver.md §13 — step/curve/stage
forms, `:semi` arpeggios, i16 NOTE_PITCH envelopes, `:keyon` retrigger, up to 3
concurrent per channel), **dynamic value slots** (SET_VAL + PARAM_FROM_VAL / _ADD_VAL /
_MUL_VAL / PARAM_MUL + `$time`, driver.md §6.4), and **3-channel PCM soft-mix**
(`pcm1`–`pcm3` summed to the fm6 DAC, driver.md §14).

## Layout

```
src/mmlispdrv.z80   the driver (M1)
src/engine.z80      the POST-SPLIT Z80 engine (ring consume + PCM mixer) — see "P0/P1"
src/mixer.z80       GENERATED (tools/gen-mixer.mjs) — the mixer core engine.z80 includes
src/ovl_*.z80       on-demand overlays (setup/cmd/pcm/boot/rare/mmb) loaded into OVERLAY_SLOT
src/tables.z80      generated constant tables — do not edit (gen-tables.mjs)
tools/z80asm.mjs    first-party two-pass Z80 assembler (subset, no deps)
tools/z80cpu.mjs    first-party Z80 CPU emulator (same subset, no deps)
tools/selftest.mjs  assembler + emulator self-tests
tools/gen-tables.mjs  emits the asm LUT byte offsets (the LUT data ships in the
                      MMB LUT_TABLE section via live/src/lut-blob.js, not the image)
tools/mmb-build.mjs   .mmlisp → .mmb via the live/src toolchain
tools/ref-trace.mjs   .mmb → JS-reference register-write log
tools/run-trace.mjs   .mmb + driver.bin → Z80-emulated register-write log
tools/verify.mjs      the bring-up gate: assemble, emulate, raw-diff traces
tools/size-audit.mjs  static resident/overlay size report (`npm run size`)
tools/budget.mjs      size audit + stack watermark over the gate corpus (`npm run budget`)
tools/gen-mixer.mjs   generates src/mixer.z80 (8 shift-specialised loops, unrolled)
tools/mixer-bench.mjs the P0 cost+correctness gate for the mixer (`npm run mixer`)
tools/engine-gate.mjs the P1 contract gate for src/engine.z80 (`npm run engine`)
tools/slot-gate.mjs   P1 end to end: score → drv-player → slots → engine (`npm run slots`)
tools/gen-c-tables.mjs generates 68k/tables.c from live/src/ir-utils.js
tools/c-gate.mjs      P2 hard gate: 68k C ≡ drv-player.js on the slot stream (`npm run c-gate`)
tools/ring-gate.mjs   P3: the ring transport is a pipeline, not a filter (`npm run ring`)
tools/sgdk-lint.mjs   P3: type-check the SGDK glue against mmlispseq.h (`npm run sgdk:lint`)
tools/build-engine.mjs assemble src/engine.z80 + the generated mixer (the shipped image)
tools/dump-trace.mjs  decode a trace to readable lines (KEY-ON, F-num, TL…)
tools/level-diff.mjs  where is the driver LOUDER than ir-player, and by how much
                      (`npm run level-diff -- <song.mmlisp>`) — the diagnostic to
                      reach for when a score blasts; see driver.md §12.5
tools/emit-bin.mjs    emit the Z80 ENGINE image as .bin + C array for SGDK/68k
tools/install-sgdk.mjs copy the sgdk/ host files (and optionally a compiled
                      score) into an SGDK project (`npm run sgdk:install -- <dir>`)
tools/wav.mjs         load WAV → 8-bit signed PCM for the SAMPLE_BANK (PCM songs)
tests/*.mmlisp        trace-stress scores beyond ab-core's coverage (+ .wav fixtures)
68k/                  the POST-SPLIT sequencer in portable C99 (P2) — see below
sgdk/                 SGDK (68k) integration — glue, sample, guide (sgdk/README.md)
```

## Build & verify

Everything runs on plain node — no external assembler or emulator binaries:

```
cd drv
npm run verify:all   # selftest + the post-split gates + the ir↔drv A/B
```

> **The all-Z80 trace gate is retired** (it survives as `npm run legacy:verify`
> and friends, and no longer passes). `drv-player.js` is the port spec, and it
> now specifies the *post-split* architecture: 8-bit saturating-add PCM
> (driver.md §5.3.1) and DAC registers owned by the engine. The superseded
> all-Z80 driver implements neither, so the two diverge by construction. Keeping
> that gate green would have meant freezing the reference, which is exactly what
> the port cannot do. Sub-ticks (driver.md §3.5) widened the gap again — 3 of
> the corpus mismatched before them, 11 after — so `npm run size` / `npm run
> budget`, which run over that driver, report the stack watermark against a
> known-diverging build.

The historical description of that gate follows, since the mechanism (assemble,
emulate, raw-diff traces) is what the P0/P1 gates reuse:

```
npm run legacy:verify    # ab-core.mmlisp against the all-Z80 driver — now diverges
```

`verify` recompiles the score, regenerates `tables.z80`, assembles the
driver, replays the MMB in the emulator (mailbox-started like a real 68000
host), and diffs the frame-stamped register log against
`drv-player.js` — **raw equality, zero tolerance**: same writes, same
values, same frames, same order (driver.md §12.4). Current status: all
trace gate scores diff clean (`npm run verify:all`) — ab-core, the two
stress scores, the M2 set (motion, pitch, CSM, PCM, PCM-loop, mailbox), and the
M3 set (FM3-op, macros: step/curve/semi/dynval/pitch/multi/keyon, PCM soft-mix,
CALL/RET dedup). Any score with repeated phrases now carries CALL/RET (the
encode-time dedup pass, `live/src/mmb-dedup.js`), so the trace gate exercises
`d_call`/`d_ret` on real streams; `m3-callret` is the dedicated case.

Every `verify` run also diffs the **marker gate**: `(trig N)` and `#label`
markers have no register effect — they land in the track's 68k-readable status
byte (`MB_TSTAT`, driver.md §6.1). `run-trace` snapshots those bytes per frame
and `verify.mjs` diffs their id bits against drv-player (`markerLog`) at zero
tolerance, so trig sync points (and every label marker, previously ungated) are
verified Z80 ≡ drv-player. `m3-trig` is the dedicated case.

`verify:all` also runs **`verify:ab`** (`tools/ab-gate.mjs`) — the *other* axis:
`ir-player` ≡ `drv-player`, which the Z80↔drv trace gate cannot see (when both
references share a bug it passes). Because M2/M3 scores diverge by construction
(the exporter pre-samples curves `ir-player` evaluates continuously,
driver.md §12/§13), this is a **characterization** gate: each corpus score's
mismatch signature is frozen in `tests/ab-baseline.json` and the gate fails when
one *changes*. Pure-M1 (ab-core) baselines to zero. After an intended behaviour
change, review the printed mismatches and re-freeze with
`node tools/ab-gate.mjs --update`.

When a *specific score* misbehaves rather than the corpus, the gate is the wrong
tool — it answers "did the divergence set move", not "what is wrong here". Use
**`npm run level-diff -- <song.mmlisp>`**: it prints every span where the driver
plays louder than `ir-player`, in dB, with the loop frames alongside. That is how
the loop-point blast of 2026-08-04 was finally located after three wrong guesses
(opcodes.md §4.1).

Host mailbox commands (KEY_OFF / SET_PARAM / FADE_TRACK) are host-driven, not
in the MMB stream, so a test may carry a sidecar `<song>.cmds.json` holding
`[{frame, cmd, a0, a1, a2}]`. The verify harness injects the same schedule into
both players (the reference applies it at the top of the frame; the emulator
posts it into the mailbox ring before that frame's interrupt).

Every `verify` run also prints a `stack N B used / window · reserve` line — the
lowest SP the emulator reached (min-SP hook in `z80cpu.mjs`) against the 82 B
`STACK_FLOOR..STACK_TOP` window. `npm run size` reports resident/overlay
sizes and free headroom; `npm run budget` combines that audit with the
worst-case stack across the full gate corpus (the living design-eval.md §10
budget table). Current: resident 5881 B, 178 B free under the G_PCMV ceiling
(after splitting `ovl_setup`/`ovl_mmb` shrank the slot and freed ~183 B); worst
stack 40 B of 82 (on m3-macro-keyon).

`ovl_rare` (overlay 4) holds rarely-fired event-stream handlers — TEMPO_SET/
TEMPO_SWEEP, CSM_ON/OFF/RATE, FM3_MODE — evicted from the resident image to
reclaim per-frame code space. A resident `tramp_rare` trampoline loads it and
re-dispatches on the opcode; each handler ends `jp d_next` unchanged. MARKER
stays resident (no gate score exercises it, so its eviction is unverifiable).

## M2a — motion (sweeps / PARAM_ADD / TEMPO_SWEEP)

Implemented for **level and tempo targets**: `:vol`/`:master` curve fades
(one-shot `PARAM_SWEEP` + `PARAM_SWEEP_STOP`), looping level LFOs (loop-curve
sweeps, cancelled by the next note), relative writes (`PARAM_ADD`, e.g.
`:vel+`), and tempo ramps (`TEMPO_SWEEP`). The engine:

- **Curves are integer-only and single-sourced.** `mmb.js` `curveUnit8(id,t)`
  maps an 8-bit phase to an 8-bit unit for all eight driver curves (four
  easings computed via one multiply, four loop waveforms — only `sin` needs a
  256-byte table, exported as `SIN_LUT`). drv-player.js, gen-tables.mjs, and
  the asm all use it, so they cannot disagree.
- **Per-channel sweep slots** (2 × 12 B at CHS+$18/$24) hold target, curve,
  loop flag, from/to, frames-left, phase, and step. Value =
  `from + trunc((to-from)·unit / 256)`, endpoint forced exactly on one-shot
  completion. Phase advances by a step precomputed with a 16-round division.
- **Frame order** follows driver.md §4 step 3: after track dispatch, sweep
  engines run ascending channel then the global tempo sweep, writing through
  the change-only shadow.

## M2b — cent-interpolated NOTE_PITCH (glide / vibrato / detune)

Inline `:pitch` (PARAM_SET NOTE_PITCH), pitch glides (one-shot NOTE_PITCH
sweeps), and vibrato (loop NOTE_PITCH sweeps) now bend pitch on FM and PSG.
The channel's cent offset is sticky state (CHS+$0C) applied at every note-on
and every sweep frame. Cent interpolation (driver.md §8) runs between the two
neighbouring semitone LUT entries:

- **FM:** interpolate in the *lower* note's F-number units (not the full
  `fnum<<block` space) with a non-negative numerator, so it stays in 16-bit
  integers and the endpoint re-normalizes block/F-number. drv-player.js's
  `_fnumBlockFor` was reformulated to this same 16-bit form (≤ 1 F-number LSB
  from the old float-space version) so JS and asm match exactly.
- **PSG:** interpolate the period LUT; period decreases with pitch, so the
  driver subtracts a non-negative delta.
- Shared helpers: `fold_cents` (peels whole semitones out of the cent
  offset), `divmod100`/`div100` (the ÷100 the round-half-up needs).

## M2 CSM (FM3 CSM mode)

An `fm3-csm` track drives the YM2612 CSM mode: `CSM_ON`/`CSM_OFF` toggle bit 7
of reg $27 (tracked in a shadow so bit 6 / FM3-special survives into M3), and
`CSM_RATE` writes the Timer A period ($24 hi / $25 lo) — const, or swept over
`len` frames via the same integer curve engine (a global slot processed after
the tempo sweep in step 3). The period reaches the Z80 precomputed (Hz never
does; opcodes.md §6), so the driver interpolates in period space. Stopping an
`isCsm` track (END_OF_TRACK, and later STOP/FADE) clears the CSM bit
(driver.md §9). Notes on the track are ordinary FM3 note-ons (the tonal
centre).

## M3 PCM soft-mix (`pcm1`–`pcm3` → fm6 DAC)

`pcm1`–`pcm3` are three PCM voices summed in software to the single fm6 DAC
(driver.md §14). Each frame emits a fixed `PCM_MIX_R = 175` DAC writes
(~10.5 kHz); per tick every active voice is resampled nearest-neighbour to that
grid (`sample[pos>>16]`, `pos += inc`), the ≤3 signed samples are summed and
**hard-saturated to int8**, and written to $2A (signed→unsigned via XOR 0x80).
The per-tick increment is `floor(inc_frame / R)`, computed once at note-on
(`mmb.js` `pcmTickIncrement`; a 16×16→32 multiply then a 32-bit ÷175). `$2B`
enables/releases the DAC (change-only, first voice on / last voice off). A
`shot` plays to the sample end (length does not truncate it, opcodes.md §6); a
`loop` cycles `loop_start…loop_end` until `PCM_NOTE_OFF`, then plays the tail.

The hot mixer (`process_pcm` + `pcm_voice_acc`) stays resident; the cold
per-note setup (`pcm_note_on` + the ÷175) rides the `ovl_pcm` overlay. **This
verifies the mix logic deterministically** — resample rate, indexing, loop wrap,
summation, saturation — since asm and reference produce the identical `$2A`
sequence each frame. It is **not** the real hardware feed: samples burst at
frame start here, not spread across the frame by a cycle-timed loop. That
sub-frame timing is a hardware-bring-up concern; the frame-stamped trace fixes
*which* samples play in *which* frame. The reference reads sample blobs the node
toolchain loads from the WAVs (`drv/tools/wav.mjs`) into the MMB SAMPLE_BANK.

## M2 mailbox commands (host → driver)

The 68000 drives runtime control through the mailbox ring (driver.md §6):
`KEY_OFF` (release a `len=0` hold or truncate a note on a channel), `SET_PARAM`
(one-shot absolute param write, as if a stream `PARAM_SET`), and `FADE_TRACK`
(ramp a track's channel vol to 0 over N frames, then stop it — for DJ-style
scene transitions). The fade is a division-free Bresenham vol ramp
(`process_fades`, iterated in track order to match the reference); the track
keeps playing while it fades. `START_TRACK`/`STOP_TRACK` also exist; the
verification harness auto-starts all tracks, so those are exercised implicitly.

Note the DrvPlayer↔ir-player A/B (`ab-compare.js`) is *informational* for M2:
the driver's integer curve crosses each TL/att boundary a few frames off from
ir-player's float easing, exceeding the tight ±1-frame band on slow fades.
Fades are musically faithful (same shape/endpoints); the hard gate is
asm↔DrvPlayer raw equality, which is exact.

## P0/P1 — the post-split engine (`npm run verify:engine`)

`src/engine.z80` is the Z80 half of the 68k/Z80 split: it consumes one
pre-rendered slot per vblank, paces its bytes onto the YM2612 and PSG, and
spends the rest of the frame software-mixing PCM into the fm6 DAC — and feeding
it *from inside the mix loop*, one sample every three ticks, so the DAC gets its
bytes at its own rate instead of in a burst (driver.md §5.1). It sequences
nothing and evaluates nothing — 4756 B against the old driver's 5.8 KB of
sequencing assembly, with no overlays, no shadow file, no LUTs and no TCB.

Since 2026-08-05 it also delivers the slot in `SLOT_SUBS` = 3 **sub-slots**
(driver.md §3.5): sub-slot 0 at the frame head as before, the other two at the
mixer's voice-pass boundaries, which already sit at 1/3 and 2/3 of a paced
frame. Note onsets therefore land within 5.56 ms instead of 16.7 ms, at no extra
chip writes and no new engine structure. When no PCM is sounding the mixer is
not entered at all, so that path runs a small paced idle loop to give the same
two boundaries. The image growing past 4 KB is what moved the mix planes above
the ring — the published header's address is unchanged, so no host rebuild is
implied beyond the new `mmlispdrv.bin`.

The **write pump** (driver.md §5.1.1) is built and gated but **ships off**
(`PUMP_ON` in `src/engine.z80`). It makes the slot's YM writes ride the mix loop
instead of bursting at their sub-tick instant: `cs_runs` queues the two runs in
place, and each unrolled iteration takes one write in the cycles it would
otherwise have padded. The hot path pays nothing — while writes are queued the
bound loop copy's first instruction (`ld a,(iy+0)`, three bytes, the size of a
`jp`) is patched to jump into the pump and restored when the queue empties, so
an unarmed loop is the unmodified code.

It works, and it is still not worth it yet. On a score carrying both FM/PSG
traffic and three PCM voices: worst in-frame DAC hold 16.1 -> 14.3 periods,
frame-boundary hold 21.7 -> 19.9 — **and 17.9% -> 24.6% of frames over their
59,659-cycle budget**, because a pumped write costs ~236 cycles against a
bursted one's ~113. Every over-budget frame is a lost vblank, a catch-up and one
DAC hiccup, and seven more points of that is ~4 extra hiccups a second: on
hardware it reads as clicking with the tempo wobbling behind it. No gate here
can see that trade (an emulated frame never runs out of cycles and its YM is
never BUSY), so `npm run engine` assembles the engine **both ways** and the
choice is made on the machine.

**The pump also corrected the diagnosis it was built from**, and that correction
is what the next round follows. The median in-frame DAC hold is not the chip
writes at all — profiled, it is the ~3.2k cycles of voice-pass transition
(`ms_load`, `pcm_debt`, the voice-pointer arithmetic, `ms_bind`, `mvf_idle`)
during which no sample is fed. That is simultaneously the frame's real overhead
and the hold the pump was aimed at by mistake; cutting it is what makes the pump
affordable.

One piece landed in every build regardless: **the burst path's BUSY polls are
inline** rather than `call ym_busy0`. 27 cycles of call/ret on each of two polls
a write is ~2.2k on a 40-write frame, spent while the DAC holds; a 95-write
frame went 69.4k -> 64.3k cycles.

The slot's frame-level fields (`n_writes`, then the PCM command list) lead the
sub-slots because the engine wants both at the frame head — the commands before
it mixes, the count before `pcm_debt` sizes the frame's pad. And that pad is now
sized from a **measured** segment count rather than the previous frame's:
`G_NSEGF` is pinned once every sounding pass is done, which is before the first
pad that carries any authority (see driver.md §5.1). Frame-length spread went
87-104% -> 98-102% and every `npm run dac` metric improved; `tools/seg-bench.mjs`
is the profiler those numbers come from.

A real Mega Drive then reported an extremely slow tempo, and it was **the ring
geometry, not the cycle budget**. Since sub-ticks the engine reads sub-slots at
1/3 and 2/3 of the frame, so the slot it is consuming stays its own for the whole
frame and the tail is released at the end — but the 68k renders from a loop woken
by the *same* vblank, so its render lands inside that frame and sees a full ring.
Pending lookahead is `RING_DEPTH - 2`, which at depth 2 is zero: the host
produced nothing, the next vblank starved, and the music advanced every other
frame. Measured at 50% of frames on hardware and 51% in the gate. `RING_DEPTH`
is now **3**, restoring the one slot of lookahead depth 2 gave before sub-ticks,
at one more frame of host->music latency (driver.md §3.4).

Two things about that are worth carrying forward. `slot-gate.mjs` posted its
slots *before* the interrupt, so it never modelled a host rendering mid-frame
and could not see this at all — it now renders ~20% into the engine's frame and
fails on any starvation. And `frames_consumed` used to tick on a starved frame,
so a host-side speed readout showed correct tempo while half the frames played
nothing; it counts consumed slots now.

The mixer's specialised loop copy is also bound **once per voice pass** rather
than per segment — (role, shift) is constant for a whole pass, so resolving it
per segment was ~1,700 cycles a frame re-deriving known values — which took the
mean frame from 98-100% of budget to 94-96% and `m3-pcm-slice` from 24% of
frames over budget to 3%.

`tools/engine-gate.mjs` gates it against its contract (driver.md §12.3): feed a
recorded slot stream and assert that the chip writes are exactly the slot's
bytes in order on the right ports, and that the `$2A` DAC stream matches a JS
model sample for sample. Ten scenarios, including the ones that pin the
segment arithmetic — a loop wrapping several times per frame, a shot ending
mid-frame, a sample crossing a ROM bank boundary, a mid-flight `PCM_LOOP`
retarget, and a starved ring — plus one that places writes in every sub-slot,
with and without PCM sounding, so both delivery paths are covered.

The segment split is what makes the inner loop cheap: a voice-outer pass bounds
each run away from its loop and sample boundaries (conservatively, by
`avail >> ksh`, so no division), and the inner loop then carries no bounds check
at all. It is also **the engine's biggest per-frame cost** — ~2.4k cycles a
segment, 5–10 a frame — which is invisible to the per-tick mixer bench and is
what limits how evenly the DAC can be fed (`npm run dac`). `mvf_exact` counts a
region's tail exactly once the shift bound collapses, instead of halving toward
it a segment at a time; the rest is still on the table.

`tools/dac-gate.mjs` (`npm run dac`) gates the feed's TIMING, which every other
gate here is structurally unable to see: they all compare sample values. It
measures, per frame, how much of the frame the writes span and how far each
sample lands from its own instant. The burst it exists to catch spans 12% and
wanders 14.7 ms; the engine spans ~90% and wanders ~3.4 ms.

`tools/frame-budget.mjs` (`npm run budget:frame`) answers the one question none
of the others do: **does the frame fit?** Cycles per frame, with the ROM-window
stall charged, and the share of frames past 59,659 — each of which is a vblank
the Z80 never sees, a catch-up, and one DAC hiccup. It exists because the write
pump improved every `npm run dac` number on a busy score while taking 17.9% ->
24.6% of its frames over budget, and the machine reported that as clicking and a
wobbling tempo while every gate here said "ok". There is no pass/fail bar — a
patch-dump frame is *supposed* to run long — so run it before and after anything
that touches the frame and compare. `--pump` prices the write pump switch
without editing the source.

`tools/slot-gate.mjs` closes the loop with a real score: `.mmlisp` → MMB →
`drv-player.js` → slot stream (through the real cap and spill queue in
`live/src/slot-builder.js`) → the engine, asserting the chip writes *are* the
sequencer's register writes and that the transport only ever delays one, never
reorders or drops it. On the corpus the write cap binds only at a score's head
and never in steady state.

## The mixer prototype (`npm run mixer`)

`src/mixer.z80` is the voice-outer PCM mixer the 68k/Z80 split is built around
(driver.md §5.3), written standalone so its cost could be measured before
anything was built on top of it. `tools/mixer-bench.mjs` assembles it at each
mix rate, runs one frame per configuration in the emulator with the cycle
counter on, attributes cycles per routine, and **diffs every DAC byte against a
JS model of the same mix** — cost and correctness in one gate, so a
fast-but-wrong loop cannot pass.

Going first was the right call. The estimate that motivated the split's PCM
plan was **~50% optimistic**: it predicted 301 cycles per mix tick at 3 voices
and the first honest implementation measured **449**. Shift specialisation, the
increment in a register and a 2x unroll took that to **384** — still 113% of the
frame, so 3 voices at 10.5 kHz does not fit with sum-then-saturate semantics;
the knee is around 8.6 kHz. Full table, and the two decisions the measurement
reopens (pre-resampling, i16 vs i8 buffer), in driver.md 5.3.1.

`tools/gen-mixer.mjs` generates `src/mixer.z80`: the loop has to exist in ten
copies (eight shifts, mute, idle) x two roles and be unrolled by three, so it is
generated rather than hand-maintained -- the same pattern as `gen-tables.mjs`.
The generator also owns the pacing model: it prices the instructions it emits,
and from that bakes each copy's pad. The bench keeps the unpaced form, since
what it measures is mixing throughput.

Numbers are a **floor**: the emulator charges documented Z80 cycles with no
bank-window wait states, and the loop's most-executed instruction is the sample
fetch through that window.

## P2 — the sequencer in C (`npm run c-gate`)

`68k/mmlispseq.c` is the port of `live/src/drv-player.js` to the 68000. It is
plain C99 with no SGDK dependency, which is the whole trick: it compiles for
the host too, so the gate runs both sides natively — no emulator, no assembler,
a debugger on each — and compares the SLOT STREAM, which is what the 68000
actually hands the Z80.

M1, M2 and M3 are done and byte-identical on 39 corpus scores — the core
opcode set, the sweep engine and its eight integer curves, PARAM_ADD, tempo
sweeps, cent pitch, CSM and the host control API (key-off, set-param, the
Bresenham fade, gated with a real host-command schedule), plus the macro engine,
the value machine's stream ops, FM3 independent-OP mode, and PCM command
emission.

PCM is the one place the sequencer carries state you would not guess from the
opcode list: it **shadows each voice's position** — never a sample byte, the
mixer is the Z80's — because it has to know when a voice retires before it can
decide whether a PCM_VOL or a PCM_NOTE_OFF is worth emitting at all.

Opcodes not yet ported stop their track fail-safe instead of mis-decoding a
length, and the gate reports those scores as PEND with the opcode and the
number of leading frames that matched, so the remaining surface reads straight
off the gate output and a regression upstream of a stop shows up as that number
falling. Nothing is PEND today; what is left is SE (track lifecycle, START_SE,
suspend/restore, priority), whose gate scores are reported SKIP.

`68k/tables.c` is generated from `live/src/ir-utils.js` by `gen-c-tables.mjs`,
the same single-source rule the Z80 tables follow: neither side derives a
constant table, so they cannot disagree.

## P3 — the SGDK integration (`npm run ring`, `npm run sgdk:lint`)

`sgdk/mmlispdrv.c` was rewritten for the split. The mailbox is gone: track
control is now ordinary calls into `mmlispseq.c`, which the game compiles in
alongside its generated tables, and the only thing crossing the bus per frame is
the slot. `MMLisp_frame()` is the §6.6 hook — call it once per vblank, last in
the frame — and it TOPS THE RING UP rather than rendering exactly one slot, so
lookahead is an invariant the call maintains and a game frame that overran
refills itself.

The split inside that call is deliberate and load-bearing: **the policy
(`mml_pump` — how many slots to render) lives in the sequencer where a gate can
reach it; the mechanism (the bus grab, the byte copy) lives in the glue where
none can.** Keeping the untestable part down to about ten lines is the point.

Two gates, both host-side:

- `npm run ring` runs a score twice — once calling `mml_render_frame` directly,
  once through the real ring with a model of the Z80 consuming one slot per its
  own vblank, at depths 2/3/4/8, skipping every seventh host frame to stand in
  for an overrun — and requires the byte streams to be identical.
- `npm run sgdk:lint` compiles the sequencer, the glue and the example against a
  hand-written shim of the SGDK symbols they use — with `-DSGDK_GCC` and a
  `types.h` that mirrors SGDK's macro conventions rather than a tidy one,
  because "it builds on the host" turned out not to imply "it builds for SGDK".
  The first real SGDK build found three failures the earlier, friendlier shim
  had hidden: `<stdint.h>` cannot follow `<genesis.h>` (SGDK `#define`s
  `uint8_t`/`size_t`/… as macros), SGDK's `<string.h>` is not
  standalone-includable and has no `memcpy`/`memset`, and its `s8` is `char`
  rather than `signed char`. The sequencer now takes SGDK's types under
  `SGDK_GCC`, uses no libc at all, and asserts `char` is signed at compile time.

  The glue **has been built for real** since — SGDK 2.x + m68k-elf-gcc 13.2.0,
  clean compile and link to a 256 KB ROM — but never run, so nothing about its
  behaviour is established.

The build path moved with it: `tools/build-engine.mjs` assembles `src/engine.z80`
with the generated mixer, and `tools/emit-bin.mjs` emits the one resident image
(4,141 B, 1,467 B free below the mix plane) plus the header constants. The
overlay blob is deleted. `build-driver.mjs` still builds the superseded all-Z80
driver; nothing ships from it.

Two integration consequences worth knowing: the **score no longer needs 32 KB
alignment** (the 68000 reads it from its own address space; only the sample bank
still rides the Z80's window), and there is **no start-burst ceiling** any more
(the mailbox ring held seven).

## Why a first-party assembler/emulator

The driver needs only a well-understood subset of the Z80 (no undocumented
opcodes), and keeping the whole verify loop inside node means the trace gate
runs anywhere the rest of the toolchain runs, with no binary dependencies.
The source stays in classic sjasmplus-compatible syntax, so moving to a full
assembler for the hardware build is a Makefile change, not a rewrite. The
emulator is not cycle-accurate (the M1 gate is frame-driven); cycle budgets
are a hardware-phase concern.

Both tools reject anything outside their subset (unknown mnemonic at
assembly, unknown opcode at execution), so they cannot silently diverge.

## Implementation notes / deviations to resolve in review

Behavioral contract: the asm mirrors `drv-player.js` exactly; where the
prose spec and the reference differ, the reference (and the trace gate) won.
These are the deltas against the docs as written:

1. **Inline writes, not a batched flush.** driver.md §4 step 4 specifies a
   frame-end write-queue flush in fixed register order. The reference emits
   change-only writes inline in dispatch order, and the asm does the same —
   that is what makes raw-trace equality possible. Moving to the batched
   flush (and re-basing the comparator on per-frame *state* equality) is
   deferred to the on-hardware cycle-budget phase, where bounding per-frame
   chip access actually matters.
2. **RAM map: all data above the code; LUTs in ROM; cold code in overlays.**
   Every RAM region sits above the code at `DATA_BASE = $18F0` (mailbox $18F0,
   val slots $1930, globals $1950, channel state $19D8, TCB $1C58–$1E57 (16
   blocks), shadow $1E58–$1F87, valid bitmap $1F88–$1FAD, stack top $2000), at
   **full 16-track capacity**. Two reworks keep it under 8 KB: the shadow's
   valid plane is a **bitmap** (1 bit/register, 2×19 B); and the **constant LUTs
   moved out of Z80 RAM into ROM** (a LUT_TABLE MMB section, mmb.md §16, read
   through the bank window — the driver derives a window pointer per table at
   START_TRACK, `gen-tables.mjs` emits only offsets, `live/src/lut-blob.js` is
   the shared source).

   A **Z80 code-overlay pass** then broke the ceiling without touching the 68k:
   cold code moves out of RAM into a 32 KB-aligned overlay ROM blob
   (`mmlispdrv_ovl.bin`) the driver LDIRs on demand into the shared
   `OVERLAY_SLOT`, then runs there, keeping the per-frame loop resident and the
   Z80 autonomous. Overlays share the slot (a `G_CUR_OVL` guard skips a reload
   when the wanted overlay is already in it): `ovl_mmb` (the MMB directory walk)
   then `ovl_setup` (the TCB fill) run in sequence on START_TRACK, `ovl_cmd` (the
   mailbox commands), `ovl_pcm` (PCM per-note setup), `ovl_boot` (the one-shot
   power-on init), and `ovl_rare` (rarely-fired stream handlers). The slot is
   sized by the largest overlay and each slot byte costs a resident byte, so
   `ovl_setup` was split (MMB walk out to `ovl_mmb`) to shrink it 451→274 B and
   reclaim ~183 B of resident image. The boot
   overlay is loaded once by a tiny resident reset stub, so the host must publish
   `G_OVL_BANK` **before releasing the Z80 from reset**, and `ovl_boot`'s RAM
   clear preserves the overlay-bank globals. That freed headroom carried the rest
   of M3 — i16 pitch macros, 3 concurrent macros/channel, PCM soft-mix, and
   `:keyon` retrigger — onto the Z80. **This is the passage the banner at the top
   supersedes:** the overlay pass won the byte argument decisively, and that is
   precisely why the *cycle* argument became the binding one. The resident image
   is **~5.77 KB**; the 3 PCM voice structs
   (17 B × 3) live in the RAM gap just below `OVERLAY_SLOT` (the region above
   `DATA_BASE` is packed), zeroed at boot.
   The mailbox and val slots are the only 68k-published addresses; they **move
   with the floor**, so `drv/sgdk/mmlispdrv.c` and driver.md §5 carry the current
   values. The image exceeds the driver.md §5 "≤4.5 KB" *design target*;
   size/cycle tuning is the hardware phase.
3. **Per-track increment slot reused.** Tempo is per-MMB (one MMB in M1), so
   the TCB increment field ($0C) holds the gate key-off countdown instead;
   the increment lives in a global. Revisit for cross-MMB layering.
4. **Pitch interpolation reformulated** (M2b): drv-player.js's `_fnumBlockFor`
   / `_psgPeriodFor` were changed to a 16-bit-friendly, non-negative-numerator
   form so the asm matches bit-for-bit. This shifts the reference's cent-bent
   pitch by ≤ 1 F-number / period LSB versus the old float-space rounding —
   inaudible, and M1 (no cents) is untouched.
5. **Mailbox commands beyond START/STOP_TRACK** (KEY_OFF, SET_PARAM,
   FADE_TRACK, SET_VAL) are consumed and ignored — M2/M3 per §6.2.
6. **START_TRACK resets** the channel's vel/vol/gate; the global `master` is
   only set at boot (§6.3 reads as if master were per-channel — it is global
   in the reference and here). **Exception:** channel 2 (the FM3 shared
   channel) is exempt from ownership eviction and the reset — the `(fm3 …)`
   voice and `fm3-1` track coexist there (driver.md §2.2 / §13.4). This
   realigns the port with the reference, which never evicts.
7. **Out-of-gamut notes**: MIDI < 9 clamps to block 0 with the LUT F-number
   (the reference computes a shifted value); > 116 clamps to the top PSG
   entry. Both are outside the musical range (driver.md §8 tolerates ±1 LSB
   there); the gate scores stay inside MIDI 9–116.
8. **Reference bug found & fixed during the port**: `drv-player.js` skipped
   reserved `PARAM_SWEEP` opcodes by 9 bytes; the opcode is op + 9 payload
   bytes = 10 (opcodes.md §6). Never hit by ab-core (no sweeps), caught by
   the stress score.

## Driver facts (M1)

- Image: ~3.5 KB including all tables — inside the 4.5 KB budget (§5).
- Timing: IM 1 vblank interrupt; per-track 8.8 tick accumulators; a
  TEMPO_SET decoded by an earlier track applies to later tracks the same
  frame (reference-exact).
- Mailbox: ring discipline per §6.1; `driver_ready = $D2`,
  `protocol_version = 2`; per-track status bytes carry active bit + last
  MARKER id.
- Implemented M3 opcodes (FM3_MODE / FM3_OP_PITCH, MACRO_SET / MACRO_CLEAR,
  PARAM_MUL / PARAM_FROM_VAL / _ADD_VAL / _MUL_VAL, SET_VAL) execute; the remaining
  M3 opcodes are length-decoded and skipped; unknown opcodes stop the track
  (fail-safe, mmb.md §13).
