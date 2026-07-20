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

- [z80-driver-status.md](z80-driver-status.md) — MMLispDRV living status: the
  Done list (M1–M3, v0.6 value machine, VOICE_SET, CALL/RET, SE, PCM volume,
  trig), the remaining-work list (hardware bring-up, PAL, open ir↔drv
  divergences), the byte/stack budget, and how to verify. **The driver's
  compact record — roadmap.md does not cover driver internals.**
- [plan-se.md](plan-se.md) — SE (sound effects): **core LANDED** (sample-bank
  separation, FM/PSG/PCM suspend-restore, priority, PCM per-channel volume).
  Kept for the remaining work — the BGM+SE bundler/link tool (not started),
  the N=1→pool, stop_track reclaim, and the worklet/hardware follow-ups. The
  SE implementation record.
- [plan-driver-features.md](plan-driver-features.md) — post-M3 driver feature
  roadmap (budget-meeting outcome): the two-budget frame (resident bytes vs
  per-frame cycles) + the overlay-split enabler. **Most items landed**
  (CALL/RET, SE, PCM volume, trig, sample-bank); remaining = DJ cross-MMB
  transitions (hardware-gated), WIDE_OFFSETS, the CALL/RET shared-loop-body
  extension. Also holds the folded-in DAC-ownership decision (static `:prio`).
- [design-eval.md](design-eval.md) — v0.6 Phase 3 normative design: the
  compile-time eval spec (dispatch, value model, curves-as-library, `:seed`,
  operator desugaring, `let`), the value machine (sampling tiers, generic
  shadow read, left-fold lowering, slot allocation), CALL/RET + dedup, the
  measured Z80 budget + reduction ladder, and the ordered implementation
  plan with per-step gates. The design rationale record (language.md carries
  the shipped spec).
