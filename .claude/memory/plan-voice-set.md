# VOICE_SET / VOICE_TABLE — Part 1 in progress (2026-07-18)

Status: **Part 1 (encoding + runtime) partly done — drv-player side works and is
verified; Z80 handler + one verification-methodology decision remain.** Committed
behind an **off-by-default** flag so `verify:all` stays green; a cloud session
continues from here.

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

## PENDING (cloud continues here)

1. **Z80 VOICE_SET handler + VOICE_TABLE reader.** Block-copy the 29-byte entry
   into the raw Z80 op-shadow (304 B shadow region) and queue the register
   writes. **Critical parity:** it must reproduce drv-player's *change-only*
   behavior — drv-player's `_voiceSet` skips a register write when the new byte
   equals the value derived from the STRUCTURED shadow (not `_shadow`), which
   matters for **$90/SSG**: `_emitInitWrites` never writes $90, so a voice that
   omits SSG must leave $90 unwritten (both burst and VOICE_SET). Make the Z80
   side skip $90 (and any register) when unchanged vs its shadow, and ensure the
   Z80 shadow treats $90 as its init value. Placement: cold (per-note-rare) so an
   overlay fits, BUT ovl_rare is now full (0 slack after the d_marker eviction) —
   so resident (~60-80 B; **90 B free** after eviction) or a new/rebalanced
   overlay. Add a gate score `m3-voice.mmlisp` (2+ voices, a mid-song voice
   change) once the Z80 side lands; verify:all Z80≡drv-player.
2. **ab-compare granularity — DECISION NEEDED (user's call, was mid-discussion
   when we checkpointed).** VOICE_SET inherently collapses same-frame *transient*
   writes: the burst writes some registers twice (via two params each — $30=ML+DT,
   $50=KS+AR, $60=DR+AMEN, $80=SL+RR, $B0=ALG+FB), VOICE_SET writes each once.
   Per-frame FINAL state is identical (verified), but ab-compare compares
   change-point RUNS (finer than the frame-quantized drv-player), so it flags the
   collapsed transients — all at f0, all same-frame. ab-gate baseline therefore
   changes for every voice-using score (e.g. m2-mailbox 0→16, m2-csm 68→76).
   Options:
   - **(a)** Re-freeze the ab-baseline (accept; many scores, incl. clean ones,
     gain same-frame-collapse "mismatches" — pollutes ab-core's pristine role).
   - **(b)** Change ab-compare's `normalize` to per-frame-final (collapse
     same-frame writes to last-wins). This is the *correct* comparison for a
     frame-quantized reference driver (drv-player's `_when()` is frame-level, so
     same-frame writes hit the synth at one instant, last wins), keeps baselines
     clean, and makes the baseline coalescing-invariant. **Recommended (b).**
     Caveat: [[z80-driver-status]] cautioned "do NOT add a same-frame-collapse
     tolerance to ab-compare until the divergence is understood" — that condition
     is **now met** (the divergence is VOICE_SET's inherent transient collapse),
     and same-frame YM collapse is provably safe w.r.t. the Layer-2 PSG issue
     (that is a *cross-frame* key-off divergence; collapsing within a frame can't
     hide it). Confirm (a) vs (b) with the user, then finish accordingly.

## Commit state / how to resume

- **`opts.voiceCoalesce` defaults OFF** in export-mmb.js, so no VOICE_SET is
  emitted and `verify:all` is green with the WIP committed. The drv-player
  handler + mmb-voices are dormant until the flag flips on.
- Cloud sequence: (1) implement the Z80 VOICE_SET handler with change-only parity;
  (2) get the (a)/(b) decision and apply it; (3) flip voiceCoalesce default ON;
  (4) re-freeze / adjust ab-baseline; (5) add `m3-voice` gate; (6) verify:all
  Z80≡drv-player + ab-gate; (7) docs (driver.md §10 status, mmb.md §11, opcodes
  0x14, drv/README) + update this memory / mark Part 1 done.
- Budget: **90 B free** (after the d_marker eviction). VOICE_SET Z80 handler is
  the main new resident cost if not overlaid.
- Verify the drv-player side without the Z80: the per-frame-final probe (compare
  `encodeMmb(ir,{voiceCoalesce:false})` vs `{voiceCoalesce:true}` in drv-player,
  last write per (port,addr) per frame — must be identical), and `abCompare` on a
  voice score (currently shows the same-frame-collapse diffs described above).
