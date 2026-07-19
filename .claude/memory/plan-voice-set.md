# VOICE_SET / VOICE_TABLE — Part 1 DONE (2026-07-19)

Status: **Part 1 (encoding + runtime) COMPLETE — coalescing ON by default; Z80
handler landed; ab-compare decision (b) applied; `verify:all` green (33 TRACE
MATCH + ab-gate 34 scores, 20 clean).** Part 2 (SE/BGM voice restore) is the
remaining work — see the updated scope note below (user flagged SE can steal
PSG/PCM channels, not only FM).

## Part 1 — what landed (2026-07-19)

- **Z80 handler** in a NEW overlay `ovl_voice` (index 6), reached via resident
  `tramp_voice` (~14 B resident: trampoline + ovl_desc_tab entry). Chosen over
  resident because VOICE_SET is cold (per voice switch); the handler measured
  ~166 B and the resident image had only ~76 B free. `load_overlay` re-latches
  the MMB bank before the handler runs, so it reads the event stream + the
  VOICE_TABLE from the window. `G_VOICE` = VOICE_TABLE base (`ovl_mmb` locates
  section 0x0006 → payload+2). `G_VS_*` loop scratch at `G_BASE+$57..$5d`.
- **Write order mirrors drv-player `_voiceSet` exactly** (zero-tolerance trace):
  op outer (0..3), register inner ($30/$40/$50/$60/$70/$80/$90), then $B0.
  Change-only via `ym_shadow_read` (unwritten reads 0 = drv init baseline, so an
  SSG-omitting voice never writes $90). The four TL bytes seed `CHS_VTL`.
- **Two Z80 bugs found + fixed (both real, keep):**
  1. **CHS_ALG not updated** — VOICE_SET wrote $B0 raw but not the `CHS_ALG`
     field `write_carrier_tls` reads to pick the carrier mask, so the vel/vol
     recompose used a stale mask (boot ALG7 = all-carriers) and wrote extra
     carrier TLs. Fix: `(iy+CHS_ALG) = entry[28] & 7` at the $B0 write (psf_alg
     parity). Reproduces only with `:vel < 15` (attenuated recompose).
  2. **`$B0` wrote the wrong port** — `ld de,28` (to index entry[28]) clobbered
     D (= port) to 0, so fm4's (port 1) $B0 landed on port 0. Invisible for
     port-0 channels. Fix: add 28 to HL via A, leaving D intact. Gate `m3-voice`
     covers both ports + a mid-song switch specifically to lock these.
- **ab-compare decision (b) applied**: `normalize` (live/src/ab-compare.js)
  collapses same-frame YM (port 0/1) writes to the per-frame FINAL value
  (drv-player's `_when()` is frame-level), so a full-voice burst (which writes
  some registers twice/frame, e.g. $30 = ML then DT) and the VOICE_SET it folds
  into share a signature → the ab baseline is coalescing-invariant. Baseline
  re-frozen (`ab-gate --update`): counts only dropped (spurious transients
  removed), no clean score broke, +1 clean (m3-voice).
- **Flag**: `export-mmb.js` `voiceCoalesce !== false` (ON by default; pass
  `false` to force the raw burst). Docs: driver.md §10 updated.

Design is frozen: driver.md §10 (Option B), mmb.md §11 (29-byte entry, layout
frozen), opcodes.md 0x14. This is the M3-tail encoding optimization + the
mechanism Part 2 (SE/BGM voice restore) needs.

## The two parts

- **Part 1 (this file): VOICE_TABLE + VOICE_SET.** Fold a same-tick full-voice
  PARAM_SET burst (~38 events, ~90 B) into a deduplicated 29-byte VOICE_TABLE
  entry + a 2-byte VOICE_SET (0x14). IR unchanged, live player unchanged. Pure
  encode transform — verified like the CALL/RET dedup pass (ab-compare is the
  safety net).
- **Part 2 (later): SE + BGM voice restore.** Uses VOICE_SET at runtime to
  re-establish a displaced BGM voice after an SE ends. **Open design question**
  (see [[plan-driver-features]] item 2): does a BGM re-key restore the patch for
  free, or must a note *held under the SE* be restored mid-sustain? Needs the
  SE/channel-ownership mechanism (driver.md §2.2) studied. Do after Part 1.

## DONE (drv-player + exporter, verified)

- **`live/src/mmb-voices.js` (new)** — `planVoices(ir)`: per-track op-shadow
  tracking; detects a same-tick maximal PARAM_SET run that covers the 38 CORE
  targets (AR/DR/SR/RR/SL/TL/KS/ML/DT × 4 + ALG + FB); SSG/AMEN are optional and
  folded from the shadow; builds the 29-byte register-order entry
  ($30/$40/$50/$60/$70/$80/$90 × 4 ops, then $B0), dedups, returns
  `{table, plans}` (plans[trackIdx] = {emit: Map<firstVoiceParamIdx, voiceId>,
  drop: Set<eventIdx>}).
- **export-mmb.js** — calls planVoices behind `opts.voiceCoalesce`; in the event
  loop, drops the burst's voice-param events and emits one VOICE_SET at the
  first; emits the VOICE_TABLE section (0x0006).
- **drv-player.js** — loads VOICE_TABLE into `this._voices` (29-byte
  Uint8Array views); VOICE_SET dispatch case → `_voiceSet(ch, id)` which applies
  the entry to `this._fm[ch]` (structured shadow) and writes the registers.

**Verified:** per-frame FINAL register state is byte-identical with
voiceCoalesce on vs off across the WHOLE corpus (drv-player probe). ab-core saves
~150 B (2 voices: lead + bass).

## Two bugs found + fixed while implementing (both real, keep the fixes)

1. **encodeB0 field-name mismatch** — `encodeB0(regs)` reads `regs.feedback` /
   `regs.algorithm`, but the mmb-voices shadow uses `sh.fb` / `sh.alg`, so $B0
   came out 0. Fixed: compute `b[28] = ((sh.fb&7)<<3)|(sh.alg&7)` directly.
2. **DT clamp** — `FM_DT` range is `{min:0, max:7}` (the raw 3-bit register
   field, 4-7 = negative detune), so the exporter's PARAM_SET path emits
   `Math.round(clampForTarget("FM_DT3", -2))` = **0** (ab-core's `:dt3 -2` is
   out-of-range and clamps to 0, NOT the 3-bit 6). mmb-voices must clamp the
   same way. Fixed: `applyToShadow` runs `Math.round(clampForTarget(target,
   value))` before storing. Without this, VOICE_SET wrote $34=0x64 vs the burst's
   0x04.

## Part 2 — SE + BGM voice restore (NOT started; scope widened 2026-07-19)

Uses VOICE_SET at runtime to re-establish a displaced BGM voice after an SE
ends. Prereq for the SE feature ([[plan-driver-features]] item 2). **Open design
question**: does a BGM re-key restore the patch for free, or must a note *held
under the SE* be restored mid-sustain (the hard case)? Needs the SE/channel-
ownership mechanism (driver.md §2.2) studied.

**User input 2026-07-19 (important scope correction):** SE is NOT FM-only — it
can steal a **PSG (sqr1-3/noise)** or **PCM (pcm1-3)** channel too. The eviction
side (driver.md §2.2 ownership) is already channel-type-agnostic; the RESTORE
side must be designed per channel family, because "voice" means different things:

- **FM (fm1-6):** restore the 29-byte patch → this is VOICE_SET (Part 1 gives the
  mechanism). The heavy case.
- **PSG (sqr1-3/noise):** no patch table — state is tone period (pitch) + 4-bit
  attenuation (+ soft-envelope/macro state). Restore is light: re-key or
  re-write period+att. No VOICE_TABLE needed.
- **PCM (pcm1-3):** state is sample assignment + `PV_VOL` (ties into
  [[plan-driver-features]] item 4) + playback position. Restore = re-arm sample +
  volume.

Common hard sub-case across all three: a note/sample *held* under the SE (mid-
sustain) vs one that re-keys naturally after. Design the restore for all three
families together before implementing.

## Part 1 history (superseded detail — kept for the two exporter bugs)

The exporter/drv-player side (`live/src/mmb-voices.js` `planVoices`, export-mmb
`voiceCoalesce`, drv-player `_voiceSet`) landed earlier and is verified. Two
exporter bugs found + fixed then (keep):

1. **encodeB0 field-name mismatch** — `encodeB0` read `regs.feedback/algorithm`
   but the mmb-voices shadow uses `sh.fb/sh.alg` → $B0 came out 0. Fixed:
   `b[28] = ((sh.fb&7)<<3)|(sh.alg&7)`.
2. **DT clamp** — `FM_DT` range is `{0,7}` (raw 3-bit field), so PARAM_SET emits
   `Math.round(clampForTarget("FM_DT3", -2))` = 0 (out-of-range clamps to 0, not
   the 3-bit 6). mmb-voices must clamp the same way in `applyToShadow`.
