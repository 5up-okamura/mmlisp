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
2. **v0.6 driver track** — the eval design is settled
   ([design-eval.md](design-eval.md) §10/§12); the driver-side sequence is:
   ~~measurement infra~~ (DONE — `npm run size`/`budget`) → budget prep
   (rare-handler overlay eviction, psf commonization, DATA_BASE bump) →
   **generic shadow read** (`op_param_tab`
   inverse, ~35-55 B) → **additive macro branch** (held since the `:pitch+`
   landing; ~50-60 B) → **scaled macro flag** (~30-40 B) → M3 dyn slice →
   CALL/RET (~45-60 B, control-stack tag already reserved in the TCB
   layout). Costs and funding are measured — see the budget table below.
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
targets included). Numbers are now **tool-emitted** (v0.6 step 6 DONE):
`cd drv && npm run size` (static audit) and `npm run budget` (audit + stack
watermark over the full gate corpus). Every `verify.mjs` run also prints a
`stack …` line. Re-run after any driver change — values below are the
2026-07-14 baseline (drv/src unchanged since 18abe79).

| Resource | Now | Notes |
| --- | --- | --- |
| Resident code | **34 B free** (resident 5848 B vs G_PCMV ceiling 5882 B / $16FA) | The scarce resource. Everything per-frame must live here. (Prior "24 B/5872" was a stale doc figure — the build-driver comment's $16F0 was 10 B off; `npm run size` is authoritative.) |
| Rare-event handlers resident | pure cold setup **167 B gross** (d_tempo_sweep 61, CSM setup 48, d_marker 25, d_fm3_mode 21, d_tempo_set 12) | Evictable to a 5th overlay → **~100-130 B net** after trampolines. Overlay load ≈ 9.5k cycles (~16% frame), fine at rare-event rate. |
| Overlay slot | 451 B ($172D–$18EF); overlays 445/268/255/238 B | A *new* overlay can be up to 451 B; growing the largest has 6 B. |
| RAM data region | $18F0–$1FAD, **packed** (mailbox, val slots, globals, 10×64 B channel state, 16×32 B TCB, 304 B shadow + 38 B bitmap) | No free holes; per-channel state bytes must displace something. |
| Stack | 82 B window ($1FAE STACK_FLOOR..$1FFF); **worst case 40 B used** on m3-macro-keyon (42 B reserve) | → DATA_BASE bump of ~20-26 B leaves a hardware-interrupt reserve; confirm on hardware. |
| ROM side | effectively unlimited | LUT_TABLE MMB section (§0x0008), overlay blob, banked song data. |

v0.6 near-term costs vs funding (design-eval.md §10): costs 160-215 B
(generic read 35-55 + additive 50-60 + scaled 30-40 + CALL/RET 45-60) vs
funding ~165-205 B (headroom 24 + eviction ~100-130 + DATA_BASE ~24-32 +
psf commonization 15-20) — fits; the VAL-op reserve (~45-60 B) rides later
funding.

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

v0.6 interplay (see design-eval.md): eval itself is compile-time-only; the
driver gains **readers and flags, never an evaluator**. The runtime carriers
are the sampling tiers — tick (`$slot`/RMW opcode chains over the generic
shadow read), note-on (dyn slot reads at macro fire), frame (additive +
scaled macro flags). Judge any v0.6 feature request against this table:
per-frame resident cost is the expensive axis; data, cold code (overlays),
and ROM are cheap.

## How to verify any driver change

`cd drv && npm run verify:all` — assembles, runs the first-party Z80
emulator, and diffs raw register traces against `live/src/drv-player.js` at
**zero tolerance** across all gate scores. Add a gate score under
`drv/tests/` for any new feature. The JS reference itself is A/B-verified
against `ir-player.js` in the live app (`window.__abCompare()`, bands in
`docs/driver.md` §12).
