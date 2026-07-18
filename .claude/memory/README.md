# Project memory (cross-session, in-repo)

Session-persistent project state that any Claude session — local or cloud —
needs to continue multi-session work. Unlike `~/.claude` local memory, these
files are checked in and travel with the repo.

Rules:

- One topic per file; keep each file current (edit in place, delete when the
  work lands and the repo itself records the outcome).
- This is for *state and plans that code/docs don't yet record* — not for
  documentation (that goes in `docs/`) or personal workflow preferences.

Index:

- [z80-driver-status.md](z80-driver-status.md) — MMLispDRV: what's done, the
  remaining-work list, and how to verify.
- [plan-v0.6.md](plan-v0.6.md) — v0.6 approved plan: score removal (done),
  import (done), compile-time eval, phase status and sequencing. roadmap.md has
  the compact public version.
- [plan-voice-set.md](plan-voice-set.md) — VOICE_SET/VOICE_TABLE **Part 1 in
  progress**: exporter coalescing + drv-player handler done & verified, committed
  behind an off-by-default flag; Z80 handler + an ab-compare granularity decision
  (a: re-freeze vs b: per-frame-final collapse) remain. Cloud resumes here.
- [plan-driver-features.md](plan-driver-features.md) — post-M3 driver feature
  roadmap (budget-meeting outcome): the two-budget frame (resident bytes vs
  per-frame cycles), the overlay split that freed 13→178 B, and the ordered plan
  — CALL/RET, SE+VOICE_SET restore, DJ transitions, per-voice PCM volume,
  32K-wall — plus `(trig N)` music→game triggers. Start here for what's next.
- [plan-dac-ownership.md](plan-dac-ownership.md) — fm6 vs PCM: **SUPERSEDED.**
  "Last KEY-ON wins" is on hold — mucom dropped as a policy input and the budget
  wall gone, so the live direction is a *static* compile-time rule (likely
  `:prio`), not runtime arbitration. Banner at top; measured cost table still
  useful. See plan-driver-features.md.
- [plan-mucom-pcm.md](plan-mucom-pcm.md) — mucom88 PCM (part K / ADPCM) import:
  **done**, both ear-gates passed. Kept only for the open items it lists (all
  also in roadmap.md); delete once those move out.
- [design-eval.md](design-eval.md) — v0.6 Phase 3 settled design: the
  compile-time eval spec (dispatch, value model, curves-as-library, `:seed`,
  operator desugaring, `let`), the value machine (sampling tiers, generic
  shadow read, left-fold lowering, slot allocation), CALL/RET + dedup, the
  measured Z80 budget + reduction ladder, and the ordered implementation
  plan with per-step gates. Implement from here.
