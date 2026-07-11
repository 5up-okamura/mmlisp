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
- [plan-v0.6.md](plan-v0.6.md) — v0.6 approved design: score removal,
  compile-time eval (with the 5 open questions + the operator-consolidation
  discussion material folded in from the retired `:pitch+` plan), and import.
  Continue the design discussion from here; roadmap.md has the compact version.
