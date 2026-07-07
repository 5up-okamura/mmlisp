# MMLispDRV — Z80 assembly port (Phase 3, step 3)

The Z80 sound driver specified by `docs/driver.md` / `docs/mmb.md` /
`docs/opcodes.md`, ported from the JS reference implementation
(`live/src/drv-player.js`). Current coverage: **M1 (core playback)**,
**M2a (motion: sweeps, PARAM_ADD, TEMPO_SWEEP)**, **M2b (cent-interpolated
NOTE_PITCH — glide / vibrato / detune)**, and **M2 CSM (FM3 CSM mode:
CSM_ON/OFF, Timer A rate const + swept)**.

## Layout

```
src/mmlispdrv.z80   the driver (M1)
src/tables.z80      generated constant tables — do not edit (gen-tables.mjs)
tools/z80asm.mjs    first-party two-pass Z80 assembler (subset, no deps)
tools/z80cpu.mjs    first-party Z80 CPU emulator (same subset, no deps)
tools/selftest.mjs  assembler + emulator self-tests
tools/gen-tables.mjs  prints every LUT from the live/src math (driver.md §12.3)
tools/mmb-build.mjs   .mmlisp → .mmb via the live/src toolchain
tools/ref-trace.mjs   .mmb → JS-reference register-write log
tools/run-trace.mjs   .mmb + driver.bin → Z80-emulated register-write log
tools/verify.mjs      the bring-up gate: assemble, emulate, raw-diff traces
tools/dump-trace.mjs  decode a trace to readable lines (KEY-ON, F-num, TL…)
tools/emit-bin.mjs    emit the Z80 image as .bin + C array for SGDK/68k
tests/*.mmlisp        trace-stress scores beyond ab-core's coverage
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
values, same frames, same order (driver.md §12.4). Current status: all six
gate scores diff clean (ab-core, stress-m1, stress-m2skip, m2-motion,
m2b-pitch, m2-csm).

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
2. **RAM map remapped for M2.** The M2 code+table image (5150 B) grew past
   the old 0x1200 data floor, so the internal data regions moved above the
   mailbox: channel state → $1740, TCB → $19C0, shadow (value+valid planes,
   2×152 B each) → $1BC0. Code+tables now own $0000–$167F (5760 B, of which
   5150 are used). The **68k-published addresses are unchanged** — mailbox
   $1680, val slots $16C0 — so the host interface (and the SGDK glue) is
   unaffected. The image exceeds the driver.md §5 "≤4.5 KB" *design target*; it
   still fits with the remap, and size/cycle tuning is the hardware phase.
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
   in the reference and here).
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
- M2/M3 opcodes are length-decoded and skipped; unknown opcodes stop the
  track (fail-safe, mmb.md §13).
