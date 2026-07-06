# MMLispDRV — Z80 assembly port (Phase 3, step 3)

The Z80 sound driver specified by `docs/driver.md` / `docs/mmb.md` /
`docs/opcodes.md`, ported from the JS reference implementation
(`live/src/drv-player.js`). Current coverage: **M1 (core playback)**.

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
values, same frames, same order (driver.md §12.4). Current status: all
three scores diff clean.

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
2. **Shadow file size/placement.** driver.md §5 reserves 192 B at $16E0.
   Change-only suppression needs value + valid planes: 2×152 B each
   (YM $22–$B9 per port), placed at $17A0 in the M2 PCM-reserved area for
   now. The $16E0 block holds driver globals instead. The RAM map needs a
   recut when M2 PCM lands.
3. **Per-track increment slot reused.** Tempo is per-MMB (one MMB in M1), so
   the TCB increment field ($0C) holds the gate key-off countdown instead;
   the increment lives in a global. Revisit for cross-MMB layering.
4. **`PARAM_SET NOTE_PITCH` is a no-op** in the asm: cents interpolation is
   an M2 sweep-engine concern (driver.md §8 "never in the M1 note path").
   The JS reference *does* implement it (the live app wants it), so a score
   using `:pitch` inline will diff — none of the gate scores do.
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
