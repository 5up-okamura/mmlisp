# Project memory (cross-session, in-repo)

State and reasoning that the code and docs do **not** record — checked in, so a
cloud session and a local one share it. Not documentation (that is `docs/`), not
personal workflow preferences.

Rules:

- **One file per AREA, not per feature** — driver, PCM, language, the live
  app (and the set-aside Z80-only build). A new feature's reasons go into its
  area's file as a section; a new file only for a new area. Keep each current:
  edit in place, delete an item when the work lands and the repo records the
  outcome. (2026-10-09: thirteen per-feature files had piled up again.)
- **A file here must never assert something the docs also assert.** When it
  does, the docs win and this copy rots — which is exactly what happened to the
  five driver files merged away on 2026-09-22.
- If a file describes a build that no longer exists, say so in its first
  sentence or delete it.

## Index

- [driver-decisions.md](driver-decisions.md) — **why MMLispDRV is shaped as it
  is**: the measurement that moved the sequencer off the Z80, the reversed
  decisions, the competitor survey, the bugs no gate could see and how the
  gates fail, the 68000 pass (closed), onset jitter under write bursts, SE and
  several songs, and the user's rulings on how to work here. The design itself
  is `docs/driver.md`.
- [pcm.md](pcm.md) — **PCM: the user's decisions with their reasons, the
  multi-bank measurements, and what is open.** Read before touching PCM in any
  layer.
- [language-open.md](language-open.md) — **the language and IR**: the two
  questions that need the user's decision, the syntax rulings not to
  re-propose, why compile-time eval and the value machine have their shape,
  and the risks still live.
- [live-app.md](live-app.md) — **the live app**: why the editing aids, the
  Library panel, the voice picker and the importers have their shape, the
  user's rulings, device measurements, and what is open.
- [z80-only.md](z80-only.md) — **a Z80-only build, set aside 2026-09-28**: the
  user's reasons, the measurements (archived sequencer, poll overhead, the RAM
  budget, the listening verdicts), the decisions taken, and a second shape seen
  2026-10-02 (MMLisp as the composing tool over a pre-rendered stream).
