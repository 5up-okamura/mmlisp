# MMLispDRV (Z80 driver) — status and remaining work

Updated: 2026-07-07. Narrative history lives in `docs/roadmap.md` Phase 3;
architecture in `docs/driver.md`; port facts/deviations in `drv/README.md`.
This file is the compact continuation state.

## Done (verified in emulation, `cd drv && npm run verify:all`, 18-19 trace scores, zero-diff)

- M1 core + **all of M2** (sweeps/PARAM_ADD/TEMPO_SWEEP, cent-interpolated
  NOTE_PITCH, CSM, single-DAC PCM, KEY_OFF/SET_PARAM/FADE_TRACK mailbox).
- Most of M3: FM3 independent-OP, macro engine (MACRO_SET/CLEAR +
  MACRO_TABLE §0x0007; step/curve/stage; `:semi`; i16 pitch macros; up to 3
  concurrent macros/channel), dynamic value slots (SET_VAL,
  PARAM_FROM_VAL/_ADD_VAL/_MUL_VAL, `$time`), 3-channel PCM soft-mix
  (~10.5 kHz, hard-clip), `:keyon` retrigger, slur/legato (NOTE_ON_EX bit3).
- Infra: TCB=16 (full track capacity), LUTs in ROM (LUT_TABLE §0x0008),
  code overlays (`ovl_boot`/`ovl_cmd`/`ovl_setup`/`ovl_pcm`) broke the 8KB
  ceiling; resident image ~6.3KB with **~14 B headroom** at `DATA_BASE=$18F0`.

## Remaining work (in rough priority order)

1. **M3 tail**: VOICE_SET opcode + the exporter's VOICE_TABLE coalescing
   pass (voices currently ride as PARAM_SET runs — correctness-equal, just
   bigger streams); CALL/RET + encode-time dedup pass; NOTE_ON_EX
   `macro_ref` field.
2. **`:pitch+` / `:semi+` additive macros** — live/compiler + MMB side LANDED
   (committed). The **Z80 driver additive branch is still pending** (~50-60 B
   resident code — fund by common-subroutining `psf_pitch`/`ps_psg_pitch`, or a
   `DATA_BASE` bump). NOTE: the operator's surface/mechanism is being
   reconsidered under **v0.6** (operator→arithmetic consolidation) — the runtime
   add-per-frame becomes the lowering target for `(+ signal runtime)`. See
   [plan-v0.6.md](plan-v0.6.md) "Operator consolidation"; hold the driver branch
   until the eval design settles rather than build it as a one-off.
3. **Hardware bring-up + cycle tuning** (the real frontier): run on a real
   Mega Drive / flashcart; measure worst-case frame cycles (PCM mix rate is
   the dominant term — ~10.5 kHz × 3ch soft-mix), validate YM BUSY-wait
   behavior on silicon, measure interrupt stack depth (relevant before any
   `DATA_BASE` bump). Emulator is not cycle-accurate by design.
4. **PAL correction** — deferred (driver.md §3.3): scale increments 6/5 at
   load or PAL-precomputed MMB via the reserved PAL_TIMEBASE header flag.
5. Deferred/known-open (docs): batched frame flush + state-based comparator
   (drv/README deviations §1); ir.md §11 residual asymmetries (`:keyon` on
   FM3-op/PSG, inline-sweep `:wait`/`dyn.len`, PCM shot length).

## Extension budget — how much room is left, and where the next bytes come from

Decision material for weighing any new driver-side feature (v0.6 lowering
targets included). Numbers verified against `drv/src/mmlispdrv.z80` equ
comments at 7bbbba5; re-check them there before relying on this table.

| Resource | Now | Notes |
| --- | --- | --- |
| Resident code | **~14 B free** (image 6370 B, code owns $0000–$18EF, `DATA_BASE=$18F0`) | The scarce resource. Everything per-frame must live here. |
| Overlay slot | 451 B ($172D–$18EF); largest overlay 445 B → **6 B slack** | 4 overlays exist (boot/cmd/setup/pcm). A *new* overlay can be up to 451 B; growing an existing one has 6 B. |
| RAM data region | $18F0–$1FAD, **packed** (mailbox, val slots, globals, 10×64 B channel state, 16×32 B TCB, 304 B shadow + 38 B bitmap) | No free holes; per-channel state bytes must displace something. |
| Stack | **~82 B slack** ($1FAE–$1FFF) | Worst-case interrupt depth (incl. PCM mix) NOT measured — measure before spending this. |
| ROM side | effectively unlimited | LUT_TABLE MMB section (§0x0008), overlay blob, banked song data. |

Funding menu, cheapest first (with precedent):

1. **Commonize resident code.** The table-drive refactor of the FM op-param
   handlers recovered ~169 B; `psf_pitch`/`ps_psg_pitch` share a
   store→emit tail and are the next known candidate (~15-20 B).
2. **Put new cold code in an overlay, not the resident image.** Allowed only
   for non-per-frame paths (command handlers, setup, per-note-rare work);
   per-frame engines (macro stepper, sweeps, PCM mix, dispatch) must stay
   resident.
3. **Move constant data to ROM** (LUT_TABLE pattern) — anything the driver
   never writes.
4. **Bump `DATA_BASE`** (+N B code, −N B stack slack). Gated on measuring
   real interrupt stack depth; also touches the absolute
   `CH_STATE`/`TCB_BASE`/`SHADOW`/`SHVALID` equs, `drv/sgdk/mmlispdrv.c`
   published addresses, and driver.md §5.
5. **68k offload** — architectural last resort (drv/README).

v0.6 interplay (see plan-v0.6.md): eval is compile-time-only by design, so
new language power should reach the driver as **static data (ROM) or
existing opcodes**, not new per-frame engines. The only runtime carriers are
`$slot` reads and the landed runtime-add lowering (`G_MADD` non-storing
pitch path, pending ~50-60 B). Judge any v0.6 feature request against this
table: per-frame resident cost is the expensive axis; data and cold code are
cheap.

## How to verify any driver change

`cd drv && npm run verify:all` — assembles, runs the first-party Z80
emulator, and diffs raw register traces against `live/src/drv-player.js` at
**zero tolerance** across all gate scores. Add a gate score under
`drv/tests/` for any new feature. The JS reference itself is A/B-verified
against `ir-player.js` in the live app (`window.__abCompare()`, bands in
`docs/driver.md` §12).
