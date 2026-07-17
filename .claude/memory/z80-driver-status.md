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

## PSG soft-envelope: release-decay fix + a deeper ir↔drv divergence (2026-07-18)

This began as "PSGのソフトエンベロープが効いてない" and unfolded in layers. Recording
the whole arc because it exposed a structural gate blind spot and an unresolved
player divergence.

### Layer 1 — release (`:off`) decay dropped. FIXED (commit e88e97e).

The audible complaint was the **release tail doing nothing** — the note jumped
straight to silence at key-off. PSG has no hardware EG, so a `:vel`/`:vol` macro
**is** the envelope, including the release, which runs **entirely while keyed off**.
Both players gated the PSG att write on the keyed state, so every release-region
write was dropped. Fix: a macro is the channel's envelope authority, so its writes
land even after key-off; non-macro writes (mailbox SET_PARAM, sweeps) keep the
keyed guard so they never un-mute a silenced channel. drv-player: `force` arg on
`_paramSet` (set by the macro step). Z80: `psg_att_gate` helper keyed on `G_MADD`
(already the macro-apply flag), +9 B (free 178→169). Gate `m3-psg-release`,
verify:all 30/30. **PCM-in-DrvPlayer mute** fixed alongside (commit 717cdfe) —
`_applyAudibility`/`_pcmNoteOn` ignored PCM tracks — so the channel can be soloed
by ear.

### Layer 2 — the deeper divergence the fix EXPOSED. NOT fixed (left as-is per user).

Diagnostic detours worth not repeating: (a) my first guess was "note-on macro value
one frame late" — WRONG; drv writes the macro value same-frame (raw dump), the
apparent lag was ab-compare not collapsing same-frame writes. (b) The residual
ab-compare mismatches are **frame-invisible**: drv PSG writes use `_when()`
(frame-level timestamp), so same-frame writes (base then macro) hit the synth at one
instant, last wins. (c) The attack was fine in both players (an earlier "attack only
in drv" suspicion did not hold).

The real remaining bug surfaced on the user's actual score (`:vel*` curve envelope,
`(wait key-off)`, long `(linear 11..0 :len 65t)` release, `:gate- 10t` → gate floored
to 1 tick, notes re-triggering every ~7 frames):

- ir inserts a **1-frame hard key-off (att 15 = silence) at each note boundary**
  (writes the release step, then 15), so notes audibly separate.
- drv writes the key-off (15) and the release value on the **same frame**, release
  wins → no inter-note silence → the envelope **drones / notes connect**.
- The key-off even lands on **different frames** in the two players (ir ~f7 vs drv
  ~f4), so it is not purely a same-frame-ordering artifact — gate key-off *timing* ×
  PSG key-off sequencing × `:vel*` curve-release re-trigger interact.

Before the Layer-1 fix this was hidden (release dropped → boundaries silent →
accidentally staccato). The fix is correct in isolation (simple release now decays,
gated) but for this complex envelope it **made the user's specific song worse**
(drone). **Ground truth is unknown** — the source is a finished *mucom* song, so
neither ir nor drv is authoritatively right; the user's goal is simply **ir ≡ drv**.
User chose to leave it as-is for now (keep both fixes; do NOT revert).

### Open action items

1. **Automate ab-compare into a CI gate. DONE (2026-07-18).** `drv/tools/ab-gate.mjs`
   + `npm run verify:ab`, folded into `verify:all`. It is a **characterization**
   gate, not 0-diff: M2/M3 scores diverge by construction (exporter pre-samples
   curves ir-player evaluates continuously — driver.md §12/§13), so each corpus
   score's mismatch signature (count + FNV digest of the sorted mismatch list) is
   frozen in `drv/tests/ab-baseline.json`; the gate fails when a signature
   *changes*. Baseline: **31 scores, 17 clean, 14 with known divergence** (2530
   total mismatches). Pure-M1 (ab-core) = 0. Layer-2 is NOT papered over — it is
   recorded as m3-psg-release's 8-mismatch signature and any change re-surfaces.
   Empirical finding when wiring it: all 14 divergences are the documented
   pre-sample-vs-continuous class ($48/$4c macro-TL, $a4 pitch-macro, $24 CSM
   timer, psg-att Layer-2) — **no surprise bugs**. Re-freeze after an intended
   change: `cd drv && node tools/ab-gate.mjs --update`.
2. **Investigate the Layer-2 gate/key-off/re-trigger timing** (drv-player + Z80) to
   make note-boundary silence match ir. Needs design — spans gate key-off timing,
   PSG key-off vs macro-write ordering, and `:vel*` curve-release re-trigger.

## Remaining work (in rough priority order)

1. **M3 tail**: VOICE_SET opcode + the exporter's VOICE_TABLE coalescing
   pass (voices currently ride as PARAM_SET runs — correctness-equal, just
   bigger streams); NOTE_ON_EX `macro_ref` field.
   **CALL/RET + encode-time dedup pass — DONE (2026-07-18).** Z80 `d_call`/`d_ret`
   share the loop control stack (CALL entries tagged remaining=0xFF), ~101 B
   resident (free 169→68 B — heavier than the 45-60 B estimate; a shared
   `ctrl_entry` helper across d_loop_*/d_call/d_ret is the obvious later trim).
   Encoder: `live/src/mmb-dedup.js` factors control-flow-free runs at loop
   depth 0, within a track, ≥8 bytes, ≥2 occurrences → fragment pool + CALLs.
   Pure encode transform (relinks track offsets + JUMP dests; **JUMP opcode is
   the unit's last 3 bytes, not byte 0 — the backward-loop path emits a
   sticky-state prelude first**, the one bug found). Saves ~4-8% on structured
   scores (demo1 −54 B, stress −106 B). Verified two ways: trace gate exercises
   Z80 CALL/RET on every factored M2/M3 score (m3-callret dedicated) **and**
   ab-gate baseline is byte-unchanged (dedup is trace-neutral). verify:all
   trace 31/31 + ab-gate 32 scores. Default-on in `encodeMmb` (`opts.dedup`).
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
   **M3 dyn slice** (DONE for sweeps, step 11 — inline sweep `:from`/`:to`
   slot-fed via PARAM_SWEEP flags bit1/2, read live at dispatch; gate
   m3-dynsweep, verify:all 28/28; ~34 B. Deferred: macro-curve dyn + sweep
   rate/len) → CALL/RET (~45-60 B, control-stack tag already reserved in the
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
   **Decide PCM `:vel` here** — parked on this measurement (2026-07-17, user):
   - **Confirmed bug**: `:vel` on a pcm track reaches the driver (export-mmb
     emits it as `PARAM_SET VEL` on the pcm channel) but is **silently dropped**
     — `_paramSet` bails at `channelId >= 6`, and the PCM voice has no amplitude.
     Proof: DAC ($2A) output is **byte-identical across `:vel` 12/4/1** on
     m3-pcm-softmix (52,500 samples). ir-player *does* honour it (worklet gain),
     so this is an ir↔drv divergence the Z80≡drv gate can't see (both ignore it)
     — same blind spot as the 2026-07-15 trio.
   - **Design settled**: attenuate by **arithmetic shift**, not a multiply or a
     LUT (user: "ビットシフトで十分"). `shift = (15 - vel) >> 2` → 0/-6/-12/-18 dB,
     `vel 0` = silent (matches FM/PSG). Fits with no RAM growth: **PV_ACT spare
     bits** (bit1 silent, bit4/5 = binary shift count) + sticky per-channel vel in
     the free globals at `G_BASE+$57`. Snapshot the shift into the voice at
     note-on and on live `PARAM_SET VEL`, so the mix loop stays one `sra` chain.
   - **Blocked on bytes**: the mix loop is per-frame → resident. The shift alone
     measured **+21 B vs 13 B free** (resident 5890 > G_PCMV ceiling 5882); the
     whole feature needs ~50 B. Fund via **d_marker eviction (~25 B, needs a
     marker gate first — see the rare-handler row)** + psf commonization, or the
     `DATA_BASE` bump this item unblocks.
   - **Cycles are the real question**: the shift runs 525×/frame on the already
     dominant term. Measure here before spending the bytes.
   - JS-reference-only is **not** shippable: drv would attenuate and Z80 would
     not → verify:all breaks. Both sides land together or neither.
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
| Resident code | **178 B free** (resident 5881 B vs G_PCMV ceiling 6059 B / $17AB) after the ovl_setup/ovl_mmb split (`npm run size`) | The scarce resource. Was 13 B; **splitting the fat `ovl_setup` (445 B) into `ovl_setup`+`ovl_mmb` (220/222 B)** shrank the slot 451→274 and freed ~183 B resident (−12 B for the desc-tab entry + the two-load sequence = net +166 vs the old 13). This lever is now spent: the six overlays are 220–268 B, so further splits yield only ~13 B each. |
| Rare-event handlers resident | **25 B** (d_marker only) | tempo set/sweep, CSM, FM3 mode evicted to ovl_rare (step 7). d_marker stays resident — no gate covers it, so eviction is unverifiable until a marker gate exists. |
| Overlay slot | 274 B ($17DE–$18EF); overlays 220/268/255/238/250/220 (ovl_mmb) B | Sized by the largest (ovl_cmd 268), 6 B slack. Every slot byte costs a resident byte — keep overlays balanced. |
| RAM data region | $18F0–$1FAD, **packed** (mailbox, val slots, globals, 10×64 B channel state, 16×32 B TCB, 304 B shadow + 38 B bitmap) | No free holes; per-channel state bytes must displace something. |
| Stack | 82 B window ($1FAE STACK_FLOOR..$1FFF); **worst case 40 B used** on m3-macro-keyon (42 B reserve) | → DATA_BASE bump of ~20-26 B leaves a hardware-interrupt reserve; confirm on hardware. |
| ROM side | effectively unlimited | LUT_TABLE MMB section (§0x0008), overlay blob, banked song data. |

v0.6 near-term costs vs funding (design-eval.md §10): the VAL-op arithmetic
was landed; **CALL/RET (~45-60 B)** is the remaining M3 resident item. Beyond
M3 the requested set is PCM runtime volume, SE + BGM voice restore, DJ-style
cross-MMB banking, and the PCM 32K-wall countermeasure (WIDE_OFFSETS,
mmb.md §12). Funding is **178 B free** after the ovl_setup/ovl_mmb split, plus
the still-unspent DATA_BASE bump (~20-26, hardware-gated) and psf
commonization (~15-20). The split is what put cross-MMB banking (a per-frame
resident cost) in reach at all.

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
