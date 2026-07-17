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
- [plan-dac-ownership.md](plan-dac-ownership.md) — fm6 vs PCM: approved and not
  started. "Last KEY-ON wins" (fm6 preempts all three voices), why the other two
  policies lose, the measured cost (no MMB change; the Z80 gets *cheaper*), and
  the staged order — with a listening gate before the Z80, since reversing later
  costs two trace-gate re-takes.
- [plan-mucom-pcm.md](plan-mucom-pcm.md) — mucom88 PCM (part K / ADPCM) import:
  **done**, both ear-gates passed. Kept only for the open items it lists (all
  also in roadmap.md); delete once those move out.
- [design-eval.md](design-eval.md) — v0.6 Phase 3 settled design: the
  compile-time eval spec (dispatch, value model, curves-as-library, `:seed`,
  operator desugaring, `let`), the value machine (sampling tiers, generic
  shadow read, left-fold lowering, slot allocation), CALL/RET + dedup, the
  measured Z80 budget + reduction ladder, and the ordered implementation
  plan with per-step gates. Implement from here.
