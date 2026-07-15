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
   ~~measurement infra~~ (DONE — `npm run size`/`budget`) → ~~budget prep~~
   (DONE — ovl_rare eviction freed 201 B; 235 B free now covers the near-term
   total, so psf/DATA_BASE held in reserve) → **generic shadow read**
   (`op_param_tab` inverse — the value-machine Unit A, **DONE 2026-07-15**:
   read_op_param + JS parity + left-fold lowering, verify:all 22/22 + A/B 0-diff,
   commits 10a36cf/102a144; Unit B = compile shadow + desugar rewiring still
   open; design-eval §12 step 8 / §4.7) → **additive macro branch** (DONE,
   step 9, commit e4a6bbb) → **scaled macro flag** (DONE, step 10 — `(macro :T
   (* <LFO> $slot))` live depth knob, ~70 B Z80, gate m3-macro-scale,
   verify:all 24/24; MMB flags bit2 + appended slot byte, mmb.md §15) →
   M3 dyn slice → CALL/RET (~45-60 B, control-stack tag already reserved in the
   TCB layout). Costs and funding are measured — see the budget table below.
   **Batched frame flush** (item 5): model = **consecutive-coalesce** (§4.7
   option a; full-frame needs ~38 B RAM the packed layout can't spare cheaply).
   **Built then REVERTED (commit 4ae2089).** Consecutive-coalesce landed in both
   players and worked, but a budget review found it cost ~90 B resident for ~1%
   write reduction — poor ratio, blocking higher-value features. Reverted
   (reclaimed ~91 B); both players inline again. Redo at the hardware phase as
   **full-frame** (needs the DATA_BASE bump). design-eval §4.7.
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
6. Residual ir↔drv **±1-2 frame** key-off skew on gate-cut notes where
   `exGate < dur` (ir continuous clock vs drv frame-stepped tick accumulation) —
   inherent quantization, accepted like the FM roughness. Seen on gh002 fm5
   (`:gate- 6t`, 96-tick notes). Three drv/exporter bugs it used to hide behind,
   all **fixed 2026-07-15** (found via ACTRAISER gh002 A/B), verify **27/27**:
   - override-pitch-macro clobbered sticky `pitchCents` → detuned following notes
     (drv-player + Z80 G_MADD 3-state; gate `m3-macro-pitchovr`).
   - tied-note gate **clamp** (`gateLeft = min(exGate,dur)`) cut tied notes at the
     tie boundary → `gateLeft = exGate`, counts across TIE, REST clears it
     (drv-player + Z80; gate `m3-gate-tie`).
   - **loop sticky-state bleed**: the linear MMB encoder omitted a PARAM_SET whose
     value matched the state at `#loop`, but the loop tail left a different sticky
     GATE/VEL/macro state → full-gate head notes played short on iterations 2+
     (gh002 fm1 `:gate- 0t`). Fix: export-mmb snapshots sticky state at each
     MARKER and restores it before a backward JUMP (gate `m3-loop-gate`).
     **Encoder-only — no Z80 change; Z80≡drv holds because both replay the same
     stream, so the regression lock is really the ir↔drv A/B, not verify:all.**

## Extension budget — how much room is left, and where the next bytes come from

Decision material for weighing any new driver-side feature (v0.6 lowering
targets included). Numbers are now **tool-emitted** (v0.6 step 6 DONE):
`cd drv && npm run size` (static audit) and `npm run budget` (audit + stack
watermark over the full gate corpus). Every `verify.mjs` run also prints a
`stack …` line. Re-run after any driver change — values below are the
2026-07-14 baseline (drv/src unchanged since 18abe79).

| Resource | Now | Notes |
| --- | --- | --- |
| Resident code | **41 B free** (resident 5841 B vs G_PCMV ceiling 5882 B / $16FA) after the override-pitch-macro fix (`npm run size`) | The scarce resource. Step 7 freed 201 B (ovl_rare); steps 8/9/10 (read_op_param, additive, scaled ~70 B) + the 2026-07-15 override-pitch fix (+6 B, G_MADD 3-state) spent most of it. Held reserves: DATA_BASE bump (~20-26, hardware-gated) + psf commonization (~5). |
| Rare-event handlers resident | **25 B** (d_marker only) | tempo set/sweep, CSM, FM3 mode evicted to ovl_rare (step 7). d_marker stays resident — no gate covers it, so eviction is unverifiable until a marker gate exists. |
| Overlay slot | 451 B ($172D–$18EF); overlays 445/268/255/238/250 (ovl_rare) B | A *new* overlay can be up to 451 B; growing the largest (445) has 6 B. |
| RAM data region | $18F0–$1FAD, **packed** (mailbox, val slots, globals, 10×64 B channel state, 16×32 B TCB, 304 B shadow + 38 B bitmap) | No free holes; per-channel state bytes must displace something. |
| Stack | 82 B window ($1FAE STACK_FLOOR..$1FFF); **worst case 40 B used** on m3-macro-keyon (42 B reserve) | → DATA_BASE bump of ~20-26 B leaves a hardware-interrupt reserve; confirm on hardware. |
| ROM side | effectively unlimited | LUT_TABLE MMB section (§0x0008), overlay blob, banked song data. |

v0.6 near-term costs vs funding (design-eval.md §10): costs 160-215 B
(generic read 35-55 + additive 50-60 + scaled 30-40 + CALL/RET 45-60) vs
**235 B free after the step-7 eviction** — already covered without spending
the DATA_BASE bump (~20-26, hardware-gated) or psf commonization (~5). The
VAL-op reserve (~45-60 B) rides those held-back sources if demand appears.

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
