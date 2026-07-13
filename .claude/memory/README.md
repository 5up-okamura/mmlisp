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
  import, compile-time eval, phase status and sequencing. roadmap.md has the
  compact public version.
- [plan-range-sugar.md](plan-range-sugar.md) — deferred `A..B` curve range
  sugar: settled design + implementation sketch, to land as its own small
  commit later. Independent of the eval steps.
- [design-eval.md](design-eval.md) — v0.6 Phase 3 settled design: the
  compile-time eval spec (dispatch, value model, curves-as-library, `:seed`,
  operator desugaring, `let`), the value machine (sampling tiers, generic
  shadow read, left-fold lowering, slot allocation), CALL/RET + dedup, the
  measured Z80 budget + reduction ladder, and the ordered implementation
  plan with per-step gates. Implement from here.
