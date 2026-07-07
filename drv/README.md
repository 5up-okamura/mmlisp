# MMLispDRV — Z80 assembly port (Phase 3, step 3)

The Z80 sound driver specified by `docs/driver.md` / `docs/mmb.md` /
`docs/opcodes.md`, ported from the JS reference implementation
(`live/src/drv-player.js`). Coverage: **M1 (core playback)**, **all of M2**
— motion (sweeps, PARAM_ADD, TEMPO_SWEEP), cent-interpolated NOTE_PITCH
(glide / vibrato / detune), FM3 CSM mode, single-channel PCM DAC (shot / loop,
frame-quantized), and the host mailbox commands (KEY_OFF / SET_PARAM /
FADE_TRACK) — plus several **M3** features: **FM3 independent-operator mode**
(FM3_MODE / FM3_OP_PITCH, driver.md §13.4), the **macro engine** (MACRO_SET /
MACRO_CLEAR, driver.md §13 — step/curve/stage forms + `:semi` arpeggios), and
**dynamic value slots** (SET_VAL + PARAM_FROM_VAL / _ADD_VAL / _MUL_VAL /
PARAM_MUL + `$time`, driver.md §6.4).

## Layout

```
src/mmlispdrv.z80   the driver (M1)
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
tools/dump-trace.mjs  decode a trace to readable lines (KEY-ON, F-num, TL…)
tools/emit-bin.mjs    emit the Z80 image as .bin + C array for SGDK/68k
tools/wav.mjs         load WAV → 8-bit signed PCM for the SAMPLE_BANK (PCM songs)
tests/*.mmlisp        trace-stress scores beyond ab-core's coverage (+ .wav fixtures)
sgdk/                 SGDK (68k) integration — glue, sample, guide (sgdk/README.md)
```

## Build & verify

Everything runs on plain node — no external assembler or emulator binaries:

```
cd drv
npm run selftest    # assembler/emulator self-tests
npm run verify      # ab-core.mmlisp: the M1 acceptance gate
node tools/verify.mjs tests/stress-m1.mmlisp --frames 1800
node tools/verify.mjs tests/stress-m2skip.mmlisp --frames 1200
```

`verify` recompiles the score, regenerates `tables.z80`, assembles the
driver, replays the MMB in the emulator (mailbox-started like a real 68000
host), and diffs the frame-stamped register log against
`drv-player.js` — **raw equality, zero tolerance**: same writes, same
values, same frames, same order (driver.md §12.4). Current status: all nine
gate scores diff clean (ab-core, stress-m1, stress-m2skip, m2-motion,
m2b-pitch, m2-csm, m2-pcm, m2-pcmloop, m2-mailbox).

Host mailbox commands (KEY_OFF / SET_PARAM / FADE_TRACK) are host-driven, not
in the MMB stream, so a test may carry a sidecar `<song>.cmds.json` holding
`[{frame, cmd, a0, a1, a2}]`. The verify harness injects the same schedule into
both players (the reference applies it at the top of the frame; the emulator
posts it into the mailbox ring before that frame's interrupt).

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

## M2 PCM (single-channel DAC)

`fm6 :mode shot`/`loop` plays a sample through the YM2612 DAC. **The DAC feed
is frame-quantized** (the chosen model — asked and confirmed): each 60 Hz frame
advances a 16.16 sample-position accumulator by `base_rate × MULT_FRAME[note]`
(the per-frame increment; `mmb.js` `pcmIncrement`, table generated by
`gen-tables.mjs`) and bursts the covered sample bytes — signed→unsigned via XOR
0x80 — to $2A. `$2B` enables/releases the DAC (change-only). shot plays to the
sample end (note length does not truncate it, opcodes.md §6); loop cycles
`loop_start…loop_end` until `PCM_NOTE_OFF`, then plays the tail. The 16.16
increment needs a 16×16→32 multiply; the position is a 32-bit accumulator.

**This verifies the meaningful logic deterministically** — rate stepping,
sample indexing, loop wrap, the note→rate table — since asm and reference burst
the identical sample sequence each frame. It is **not** the real hardware feed:
samples burst at frame start here, not spread across the frame by cycle-timed
loops. That sub-frame timing (and the choice of a timer/DMA feed) is a
hardware-bring-up concern; the frame-stamped trace only fixes *which* samples
play in *which* frame, which the real feed will reproduce. The reference reads
sample blobs the node toolchain loads from the WAVs (`drv/tools/wav.mjs`) into
the MMB SAMPLE_BANK; asm and reference read the same bytes.

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
2. **RAM map: all data above the code; LUTs in ROM.** The image grows through
   the milestones, so every RAM region sits above the code at `DATA_BASE = $18F0`
   (code owns $0000–$18EF): mailbox $18F0, val slots $1930, globals $1950,
   channel state $19D8, TCB $1C58–$1E57 (16 blocks), shadow $1E58–$1F87, valid
   bitmap $1F88–$1FAD, stack top $2000. **The 8 KB image is full** (~14 B headroom)
   at **full 16-track capacity**: an M3 memory compaction had trimmed TCB to 11,
   but the **table-drive refactor** (FM op-param handlers → descriptor table,
   ~169 B) recovered enough to restore all 16 tracks. This is the boundary — the
   remaining M3 (multi-macro, i16 pitch, CALL/RET, PCM soft mix) does not fit the
   monolith, so it moves to the **68k-offload architecture** (engines on the main
   68000, the Z80 a thin register + PCM executor). Further table-driving (opcode
   dispatch ~32 B) is available but won't change that boundary. The macro
   channel-RAM at channel-block 0x30–0x3E moved
   FADE-frames-left to 0x3F (driver.md §5.1). Earlier reworks keep it under 8 KB:
   - the shadow's valid plane is a **bitmap** (1 bit/register, 2×19 B), not a
     byte-per-register plane;
   - the **constant LUTs moved out of Z80 RAM into ROM** — a LUT_TABLE MMB
     section (mmb.md §16) read through the bank window, freeing ~726 B. The
     driver derives a window pointer per table at START_TRACK; `gen-tables.mjs`
     now emits only the byte offsets, and `live/src/lut-blob.js` is the shared
     LUT source for the section and the JS reference.

   The resident RAM image is **5.7 KB with ~175 B of headroom** (was ~14 B). A
   **code-overlay pass** moved the cold control-plane code (start_track, the
   mailbox handlers, the MMB-section parsing — ~660 B) out of Z80 RAM into a
   713 B overlay ROM blob (`mmlispdrv_ovl.bin`) that the driver loads on demand
   into OVERLAY_SLOT ($1700), keeping the 68k free and the per-frame loop
   resident. Since cold code now lives in ROM, more overlays (boot, CSM, …) can
   free further RAM, and the remaining M3 fits without the 68k offload — that
   stays the last resort. The mailbox and val slots are the only 68k-published
   addresses; they **move with the floor**, so `drv/sgdk/mmlispdrv.c` and
   driver.md §5 carry the current values. The image exceeds the driver.md §5
   "≤4.5 KB" *design target*; size/cycle tuning is the hardware phase.
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
