# MMLispDRV (Z80 driver) — status and remaining work

Updated: 2026-07-20. Narrative history lives in `docs/roadmap.md` Phase 3;
architecture in `docs/driver.md`; port facts/deviations in `drv/README.md`.
This file is the compact continuation state. Live byte/stack figures come from
`cd drv && npm run size` / `npm run budget` (authoritative; the numbers quoted
below are the 2026-07-20 baseline).

## Done (verified in emulation, `cd drv && npm run verify:all`, zero-diff, both ports)

- **M1 core + all of M2**: sweeps/PARAM_ADD/TEMPO_SWEEP, cent-interpolated
  NOTE_PITCH, CSM, single-DAC PCM, KEY_OFF/SET_PARAM/FADE_TRACK mailbox.
- **M3**: FM3 independent-OP; macro engine (MACRO_SET/CLEAR + MACRO_TABLE
  §0x0007; step/curve/stage; `:semi`; i16 pitch macros; up to 3 concurrent
  macros/channel; **additive** + **scaled** macro branches — `(macro :T (* LFO
  $slot))`); dynamic value slots (SET_VAL, PARAM_FROM_VAL/_ADD_VAL/_MUL_VAL,
  `$time`) + **M3 dyn slice** (inline sweep `:from`/`:to` slot-fed); 3-channel
  PCM soft-mix (~10.5 kHz, hard-clip); `:keyon` retrigger; slur/legato
  (NOTE_ON_EX bit3).
- **M3 tail**: **CALL/RET** (0x44/0x45, shared loop-control stack) + encode-time
  **dedup pass** (`live/src/mmb-dedup.js`, trace-neutral); **VOICE_SET/VOICE_TABLE**
  (0x14 §0x0006, coalescing ON by default, `ovl_voice`); **`(trig N)`** music→game
  triggers (MARKER 0x42 → MB_TSTAT, verified by the marker gate).
- **v0.6 value machine**: generic shadow read (`read_op_param`, `op_param_tab`
  inverse — all FM op params RMW-readable), left-fold lowering. Compile-side eval
  is compile-time only; the driver gained readers + flags, never an evaluator.
  (Batched frame flush was built then **reverted** — poor byte/benefit; redo as
  full-frame at the hardware phase.)
- **SE (sound effects)**: `START_SE` mailbox cmd 7; suspend-not-evict the
  displaced BGM (`T_STATUS=3`) with mid-sustain snapshot/restore per channel
  family — **FM + PSG + PCM all landed**; **priority** (N=1 slot, `a1`=prio:
  higher preempts, lower dropped). Overlays `ovl_se`/`ovl_claim`; snapshot pools
  `SE_SNAP`/`PCM_SNAP` carved off the stack. Sample-bank separation (PCM blobs
  in a dedicated ROM bank the mixer latches per frame, `G_SMP_BANK`) is the
  32K-wall enabler that rode in with it. Remaining SE work: [[plan-se]].
- **PCM per-channel volume**: `:vel`+`:vol`+`:master` compose to a bit-shift
  (`sra`) attenuation with mute (`PV_SHIFT`); matches FM/PSG loudness.
- Infra: TCB=16 (full track capacity), LUTs in ROM (LUT_TABLE §0x0008),
  **10 code overlays** (`ovl_setup`/`ovl_cmd`/`ovl_pcm`/`ovl_boot`/`ovl_rare`/
  `ovl_mmb`/`ovl_voice`/`ovl_se`/`ovl_sweep`/`ovl_claim`) broke the 8KB ceiling;
  resident 6036 B with **~20 B headroom** under `G_PCMV` ($17A8), overlay slot
  274 B, at `DATA_BASE=$18F0`.

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

## PCM on hardware — the two blockers are FIXED (2026-08-01)

Both were outside the driver (the Z80 PCM path was already gate-verified), and a
third silent-failure mode turned up while fixing them.

1. **`MMLisp_setSampleBank(const u8*)` — DONE.** `drv/sgdk/mmlispdrv.c`/`.h`
   publish `G_SMP_BANK` (**0x1929**, u16 LE, MB_RING+$39) as `(u32)smp >> 15`,
   bus-held, the same shape as `MMLisp_init`'s overlay publish. **Must be called
   after `MMLisp_init`** — init's `Z80_clear()` wipes Z80 RAM. Unpublished is
   **not** "noise" (an earlier note here said so — wrong): bank 0 means *none*,
   `pcm_note_on` does `ret z` at its first instruction, so PCM notes are dropped
   and the DAC is never even enabled — it sounds like a missing part. Noise is
   what a *wrong non-zero* bank gives. `example/song.res`
   documents the `BIN song_smp "song.smp" 32768` line (still shipped commented —
   rescomp fails on a BIN whose file is absent), `example/main.c` carries the
   commented call, README gained §PCM sample banks, and `install-sgdk --song`
   **uncomments the BIN line itself when it created song.res that run** (never in
   a project-owned one) and prints the remaining main.c step.
2. **`loadSamplesForIr` now slices `:offset`/`:frames` — DONE.** It mirrors the
   browser's `sliceDecodedSample` (frames, not bytes; clamps to the file; skips
   an empty slice with a diagnostic; `:loop-start`/`:loop-end` stay relative to
   the slice), and decodes each WAV **once, cached by path**, since a bank import
   is one file that every def cuts up. `buildMmb` threads the new diagnostics out
   with the compile/export ones. Gate: **`drv/tests/m3-pcm-slice.mmlisp`** (three
   defs over one WAV incl. an open-ended `:offset`) — added to `verify:m3`,
   ab-baseline re-frozen at **40 scores (18 clean)**. Verified byte-exactly by
   decoding the `.smp`: 512 blob bytes for three slices of a 512-frame WAV, each
   region matching, where before it was 3×512 all starting at frame 0.
3. **NEW guard: a sample bank > 32 KB is now refused** (`encodeMmb`, RangeError
   like the MMB one; mmb.md §10 updated). `pcm_note_on` reads only the **low u16**
   of an entry's `offset` and addresses blobs from the window base, so a larger
   bank silently wraps and plays another sample's bytes. This is the wall a real
   mucom import is most likely to hit next; WIDE_OFFSETS / multi-bank remains the
   deferred way out. Note fix (2) is also what makes the wall reachable at all —
   before it, every def carried the whole bank.

**First on-target attempt, same day — three host-side traps, none in the driver.**
The user's SGDK project (`~/build/verify-hello-world`, a 9-track mucom import)
had the driver files current and the `BIN song_smp` line uncommented, and still
played no PCM. Diagnosis method worth repeating: **run their built `res/song.mmb`
+ `res/song.smp` straight through `runTrace` and count `$2A` writes** — 1 write
per 600 frames vs 94,851 with the bank published settles it in seconds, without
an emulator.

1. `MMLisp_setSampleBank(song_smp)` was still commented out in *their* main.c.
   The BIN line alone only puts the blob in ROM; nothing tells the Z80 where.
2. `#define TRACK_COUNT 5` against a **9-track** song — ids 5..8 (the PCM track
   is id 5, ch 20) were never started. `mmb-build` prints the real count.
3. The **mailbox ring holds 7 entries, not 8** (`head == tail` = empty), and
   `mailbox_send` drops the overflow silently — so >7 tracks cannot all start in
   one frame, which is exactly what example/main.c told them to do. Docs and the
   example now carry the ceiling; `install-sgdk` prints it when a score has >7
   tracks. Also fixed the same off-by-one in `run-trace.mjs` (it guarded `> 8`,
   so an 8-track autoStart would have set `head == tail` and started nothing).

**PCM PLAYS ON TARGET (BlastEm, 2026-08-01) — and it is far too slow.** Tempo
drags and the sample pitch sits way below where it belongs, i.e. the Z80 is
missing interrupts. Measured, not guessed (`runTrace(..., {profile: symbols})`,
new opt-in cycle profiler — see below), on their 9-track song over 900 frames:

| | PCM on | same song, `G_SMP_BANK`=0 |
| --- | --- | --- |
| median | **211,784 (355%)** | 18,937 (32%) |
| p99 | 257,023 (431%) | 57,966 (97%) |
| over budget | **90.9%** | 0.9% |
| effective rate | **1 frame per 3.32** | — |

So the FM/PSG engine is fine (matches the gh002 baseline exactly); the soft-mixer
alone is **~193k cycles/frame ≈ 3.2× the whole budget with ONE voice active**.
Per mix tick (175/frame) it burns ~983 cycles: `pva_add` 292 (the 32-bit phase
update, ~14 IX-indexed accesses at 19-20 cycles each), `pcm_voice_acc` entry ×3
149, `pp_tick` body 156, `ym_hw` DAC write **115 (two BUSY polls)**, `pva_fetch`
94, `pp_have` 59, `pva_shot` 58, `pva_shtest` 40. Reference point: XGM mixes 4
channels at 14 kHz in ~25 cycles/sample/channel — it keeps state in registers and
**does not resample**. Our 12× gap is architectural, not a Z80 limit. Note the
emulator omits bank-window ROM wait states, so 3.55× is a **floor**.

Ordered fix list (not started, design not yet confirmed):
1. **DAC write without the BUSY poll** (`$2A` is port 0 and every MD PCM driver
   writes it blind) — ~15.6k/frame, **26% of budget**, trace-identical, ~10 B.
2. **Voice-outer restructure**: mix one voice for all 175 ticks with pos/inc
   register-resident (alt set), into a 175 B mix buffer — **the overlay slot
   ($17DE–$18EF, 274 B) is dead while `process_pcm` runs**, since it runs last in
   `frame_step`. Target ~250 cyc/tick for 3 voices.
3. `PCM_MIX_R` 175 → 128/96 as a quality/cycles knob (mirrored in
   `live/src/mmb.js PCM_MIX_RATE`; changes output, so re-baseline the gates).

**New tool: `runTrace(..., {profile: buildDriver().symbols})`** returns
`frameCycles` + `byRoutine` (cycles attributed to the nearest preceding symbol;
overlay code bucketed as `ovl<N>` via `G_CUR_OVL`). Opt-in, ~2× runtime. This is
the measurement the notes above kept prescribing ad hoc — use it, do not guess.

## Remaining work (in rough priority order)

1. **M3 tail** — **VOICE_SET + VOICE_TABLE coalescing DONE (2026-07-19)** (0x14
   §0x0006, ON by default, ovl_voice — see the Done list). Still open: NOTE_ON_EX
   `macro_ref` field.
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
3. **Hardware bring-up + cycle tuning** (the real frontier).
   **FIRST ON-TARGET PLAYBACK: 2026-07-26, BlastEm via SGDK** — demo1.mmlisp
   (3 FM + 2 PSG, looping) plays, `MMLisp_stopTrack` from the pad works. What
   the bring-up cost, all now fixed in-repo:
   - `MMLisp_init` loaded the Z80 image *while holding the Z80 in reset* and had
     no reset settle delay. Rewritten to mirror SGDK's own
     `Z80_loadDriverInternal` order (requestBus → clear+upload → startReset →
     releaseBus → waitSubTick(50) → endReset), and its ready-wait is now bounded
     (~1 s) instead of an infinite spin.
   - **START_TRACK read the bank window before latching the MMB bank** —
     `md_start_go` ran `ovl_mmb`'s `mmb_locate` (which reads `WINDOW+8`
     directly) with `G_MMB_BANK` still 0 from boot; the track's bank was only
     latched later in `ovl_setup`. On hardware bank 0 is the 68k ROM head, so
     the section directory was garbage. Fixed by publishing+latching the bank
     from the command args first; `ovl_setup`'s START_SE path now inherits
     `G_MMB_BANK` instead of forcing bank 0.
   - **Why 19/19 gates missed it:** `run-trace.mjs` returned the MMB for *any*
     bank register value, so a missing latch still read correctly. The harness
     now puts the MMB on bank 4 and returns 0xFF for unmapped banks (and
     `START_TRACK` schedules default their bank arg to it). Re-verified: all
     traces 0-diff, ab-gate 38 scores.
   - The shipped `drv/sgdk/mmlispdrv_bin.h` / `mmlispdrv_ovl.bin` were a stale
     2026-07-08 build (pre-slur, pre-PCM-softmix). Regenerate with
     `node tools/emit-bin.mjs` after *every* asm change — resident 6050 B,
     overlay 2321 B as of this fix.
   - **False alarm, recorded so it is not chased again:** "plays for 1-3 minutes,
     bursts into noise, then permanent silence while the game still responds" is
     **BlastEm's audio output dying on macOS**, not the driver and not the chip
     state. Raising `audio { buffer 512 }` to 2048 removed the crackling but not
     the dropout. Three independent proofs, in increasing order of speed to
     obtain: driver state read back healthy at the moment of silence (T_STATUS=1
     on all tracks, T_PC advancing inside EVENT_STREAM, G_INC/G_MASTER/
     G_MMB_BANK correct); a VGM log of the failing session uniform across its
     full 139.7 s (155-162 FM key-ons per 20 s, steady PSG writes, no TL-to-max,
     no $2C/$22 writes); and **BlastEm's oscilloscope (`o`) still showing
     waveforms with nothing audible** — two seconds, and conclusive.
     **Reusable method for any "it sounds wrong" report: VGM log = what the chips
     got, TCB/G_FRAME readback = what the driver thinks, oscilloscope = whether
     the chips are sounding.** (The first two suspects — a VDP-DMA vs
     Z80-ROM-read collision, and change-only writes never repairing a diverged
     chip — were both wrong.)
   - **Host-side frame budget is real:** starting 5 tracks in one frame is 172
     register writes + 15 overlay LDIRs, several times the ~59,600 cycles a
     60 Hz frame gives the Z80, and it is audible as a ragged opening. The
     example now starts one track per frame; documented in drv/sgdk/README.
   Still open on real silicon: worst-case frame cycles (PCM mix rate is
   the dominant term — ~10.5 kHz × 3ch soft-mix), validate YM BUSY-wait
   behavior on silicon, measure interrupt stack depth (relevant before any
   `DATA_BASE` bump). Emulator is not cycle-accurate by design.
   **PCM `:vel` — RESOLVED (PCM per-channel volume LANDED 2026-07-20).** The
   parked "confirmed bug" (`:vel` silently dropped on pcm channels — `_paramSet`
   bailed at `channelId >= 6`, no amplitude field) is fixed: `:vel`+`:vol`+
   `:master` now compose to a bit-shift (`sra`) attenuation with mute
   (`PV_SHIFT`), matching FM/PSG loudness — see the Done list and [[plan-se]].
   What this item still holds is the **cycle** question: the per-sample `sra`
   runs up to 175×3/frame on the dominant PCM term — trace-correct in emulation,
   needs hardware cycle validation.
4. **PAL correction** — deferred (driver.md §3.3): scale increments 6/5 at
   load or PAL-precomputed MMB via the reserved PAL_TIMEBASE header flag.
5. Deferred/known-open (docs): batched frame flush + state-based comparator
   (drv/README deviations §1); ir.md §11 residual asymmetries (`:keyon` on
   FM3-op/PSG, inline-sweep `:wait`/`dyn.len`, PCM shot length).
6b. **NEW ir↔drv divergence, and this one looks like an ir-player (live app) bug:
   a track that changes voice inside a loop does not get its loop-head voice back
   in ir-player, while drv-player restores it.** Surfaced by the new gate score
   `m3-voice-loop.mmlisp` (fm2 switches `lead`→`stab` mid-loop): at the loop frame
   drv writes the 29 `lead` registers back (`$b1 = $1C` = alg 4 / fb 3 etc.) and ir
   writes nothing, so **the live player keeps playing `stab` from iteration 2 on**.
   The score says the loop head binds `lead`, so **drv is right and live is wrong**.
   Frozen as known divergence #15 in ab-baseline (30 mismatches, all at one frame)
   — NOT caused by the VOICE_SET hoist: hoist on/off produces byte-identical
   register logs. Fix belongs in `live/src/ir-player.js`'s loop handling.
7. Residual ir↔drv **±1-2 frame** key-off skew on gate-cut notes where
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

## Frame-cycle budget — measured, 2026-07-30 (was the "hardware frontier")

A frame is **59,659 Z80 cycles**. Overrun costs a whole frame (the vblank `/INT`
lasts about a scanline, so a long frame simply misses the next one) and is audible.
`tools/run-trace.mjs` + `cpu.step()`'s cycle return + a PC histogram against
`buildDriver().symbols` gives per-frame cost and a per-routine profile; that is how
all of the below was found. **Re-measure this way rather than guessing** — every
guess in this session (DMA collisions, change-only never repairing a diverged chip,
overlay thrash at the loop) was wrong, and the profile was right each time.

gh002 (7-track mucom import, 12000 frames):

| | before | after |
| --- | --- | --- |
| median | 28,132 (47%) | **18,866 (32%)** |
| p99 | 68,458 (115%) | **58,574 (98%)** |
| over budget | 3.8% | **0.77%** |
| loop frame | 263,000 (**4.4×**) | **79,000 (1.3×)** |
| start frame (f0) | 344,000 (5.8×) | setup 69,000 — but see below |

What was actually expensive:

1. **Loop-head VOICE_SET, re-applied every iteration** — 29 registers of shadow
   bookkeeping per track (~30k cycles) that the chip never sees, because mucom MML
   puts `@n` at `#loop`. Fixed encode-side: `planVoiceHoists` in export-mmb.js
   hoists it above the marker when the loop body cannot disturb voiced state
   (driver.md §10.1, gate `m3-voice-loop`). Proven output-identical by A/B-ing
   `opts.voiceHoist` on/off (27,036 writes on the real song, 0 differences).
2. **`chs_ptr_iy` = 19% of every frame** — 32 calls × ~190 cycles, 92% of them from
   three sites in the two ascending channel loops. Both loops now walk an induction
   pointer (+64/channel); `process_slot` preserves IY so the sweep loop keeps its own.
3. **`process_slot` spent ~180 cycles of prologue before reporting an empty slot**,
   20× per frame. The caller now tests both target bytes first.

**The start frame, 2026-07-31.** `T_STATUS` gained **2 = armed** (driver.md §4.2):
the frame START_TRACK is drained in does not accumulate, so it stays silent
however long it runs, and every track armed in it starts together on the next
frame — frame-exact, tempo-independent, and it lets the host post all starts in
one frame instead of staggering them (which had left the tracks permanently up to
100 ms out of phase). Held moved 2→4 so promotion is one `dec`.

**That fixed the phase, not the smear.** The measurement that matters: the setup
frame is now 69k and silent, but the *score's* head — 7 `VOICE_SET`s at tick 0 —
lands in the first dispatching frame with the first notes: **264k cycles, 4.4×
budget**. Its profile says where to go next:

| | cycles | |
| --- | --- | --- |
| `ym_valid_ptr` (+yvp_lp/yvp_end) | 50,600 | change-only valid-bit plane |
| `ym_shadow_ptr` (+ysp_p0) | 33,500 | shadow index → pointer |
| `ym_shadow_read` | 13,400 | |
| `op_e` | 14,300 | operator address |
| **total** | **112,000 (42%)** | **~550 cycles of bookkeeping per register write** |

**The valid-bit plane is GONE (2026-07-31).** boot now writes every register the
shadow covers — the op table gained `$90`/SSG-EG and the four globals
(`$22 $27 $2A $2B`) were added, all through `ym_write_always` since that patch is
what *makes* the shadow true — so an entry is never "unwritten" and a matching
value can always be suppressed. Removed a `>>3` and a `1<<bit` loop from every
write: first sounding frame 228k → **165k**, p99 58.6k → **53.3k**, over-budget
0.78% → **0.30%**, resident **6054 → 5979 B (77 B free)**, and the 38 B went to
the stack window (**48 → 86 B**, worst case 40 B used). Watch out: the boot patch
itself must use `ym_write_always`, or its own zero-writes get suppressed against
the cleared shadow and never reach the chip.

**"Armed runs the score's head" — LANDED (2026-07-31).** `d_next` returns early
while armed, at the first opcode that sounds or consumes time ($10..$13),
writing T_PC back; fs_track's armed branch calls `dispatch` first. gh002: the
armed frame is **204k with 262 writes and no key-on**, the first sounding frame
**31.8k (53% of budget)** — the long first note is gone.

Landing it took one detour worth remembering: it changes *where* the driver and
ir-player sit relative to each other at track start, and ab-compare's ±1-frame
tolerance cannot absorb that for per-frame-varying signals. First attempt dirtied
**nine clean scores (m3-macro-pitchadd 0 → 482)**. The fix was to teach
`ir-player.captureRegisterLog` the same split (`_drvSetupShift`): timeline one
frame late, each track's leading events pulled back onto the preamble frame — and
critically **a quarter-frame in, not exactly on it**, or they sort ahead of
`_initDefaultVoices` and the neutral patch overwrites the voice. Residual: six
scores with 4-12 mismatches, all carrier TL at the track's first frame, because
the driver composes TL once in the armed frame with the head's vel while
ir-player recomposes at the note. Baseline now **17 clean / 22 with known
divergence** (was 24/15).

Also worth a look: `latch_bank`'s 9-bit shift loop is 39% of the setup frame
(27k) because every overlay load re-latches two banks — a "currently latched"
cache needs 2 B of RAM, and there is room now.

Still at the top of an ordinary frame and genuinely working: `fs_tick` (3.6k) /
`fs_wait` (2.7k) — the per-track tick accumulate and dispatch. Next candidates if more is needed: the
16-TCB and 30-macro-slot scans (~4k combined) via an active mask, and the start
frame, which needs the setup/first-note split (see the deferred item below).

## Extension budget — how much room is left, and where the next bytes come from

Decision material for weighing any new driver-side feature (v0.6 lowering
targets included). Numbers are now **tool-emitted** (v0.6 step 6 DONE):
`cd drv && npm run size` (static audit) and `npm run budget` (audit + stack
watermark over the full gate corpus). Every `verify.mjs` run also prints a
`stack …` line. Re-run after any driver change — values below are the
2026-07-14 baseline (drv/src unchanged since 18abe79).

| Resource | Now | Notes |
| --- | --- | --- |
| Resident code | **90 B free** (2026-07-18: after CALL/RET −101, `(trig N)` ±0, d_marker eviction +22; ceiling G_PCMV 6059 B / $17AB, `npm run size`) | The scarce resource. Was 13 B; **splitting the fat `ovl_setup` (445 B) into `ovl_setup`+`ovl_mmb` (220/222 B)** shrank the slot 451→274 and freed ~183 B resident (−12 B for the desc-tab entry + the two-load sequence = net +166 vs the old 13). This lever is now spent: the six overlays are 220–268 B, so further splits yield only ~13 B each. |
| Rare-event handlers resident | **0 B — all evicted** | tempo set/sweep, CSM, FM3 mode (step 7) **and now d_marker** (2026-07-18) live in ovl_rare. The marker gate (verify.mjs MB_TSTAT diff, `m3-trig` + every label marker, 0-diff) made d_marker's eviction verifiable. Recovered **+22 B (free 68→90)**: d_marker (~26 B) removed from resident; the MB_TSTAT-write tail shared by d_marker + d_eot commonized into resident helper `write_tstat` (~+3 B net). ovl_rare now fills the slot exactly (274 B, 0 slack) — next ovl_rare addition needs a slot/DATA_BASE bump. |
| Overlay slot | 274 B ($17DE–$18EF); overlays 220/268/255/238/250/220 (ovl_mmb) B | Sized by the largest (ovl_cmd 268), 6 B slack. Every slot byte costs a resident byte — keep overlays balanced. |
| RAM data region | $18F0–$1FAD, **packed** (mailbox, val slots, globals, 10×64 B channel state, 16×32 B TCB, 304 B shadow + 38 B bitmap) | No free holes; per-channel state bytes must displace something. |
| Stack | 82 B window ($1FAE STACK_FLOOR..$1FFF); **worst case 40 B used** on m3-macro-keyon (42 B reserve) | → DATA_BASE bump of ~20-26 B leaves a hardware-interrupt reserve; confirm on hardware. |

**2026-07-30 update after the frame-cycle work:** resident is **6055 B with 1 B
free** (ceiling G_PCMV 6056 / $17A8) — the cycle optimizations above had to be
paid for in bytes, and three of them were re-coded purely to fit (`ld bc,10*256`
for the two loop counters, `djnz` for both channel loops, a shorter `1<<bit` loop
in `ym_valid_ptr`). **The next driver change needs bytes freed first.** Stack
worst case is now **40 B / 48 B window (8 B reserve)** — `process_slot`'s added
`push iy` costs 2 B and buys 3.4k cycles/frame; the RAM data region is exactly
full ($18F0–$1FFF, 1808 B), which is why `CH_STATE` could **not** simply be
page-aligned for a cheaper `chs_ptr_iy`.
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
