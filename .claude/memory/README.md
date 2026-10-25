# Project memory (cross-session, in-repo)

State and reasoning that the code and docs do **not** record — checked in, so a
cloud session and a local one share it. Not documentation (that is `docs/`), not
personal workflow preferences.

Rules:

- **The goal is an empty directory.** Work that is done is deleted; what a
  user or composer needs moves into the matching document (`docs/`, a
  README, the roadmap for what is ahead); only what serves development alone
  — rulings not to re-propose, measurements, reasons the docs state as bare
  facts — stays here.

- **One file per AREA, not per feature** — driver, PCM, language, the live
  app. A new feature's reasons go into its
  area's file as a section; a new file only for a new area. Keep each current:
  edit in place, delete an item when the work lands and the repo records the
  outcome. (2026-10-09: thirteen per-feature files had piled up again.)
- **A file here must never assert something the docs also assert.** When it
  does, the docs win and this copy rots — which is exactly what happened to the
  five driver files merged away on 2026-09-22.
- If a file describes a build that no longer exists, say so in its first
  sentence or delete it.
- **Record what is open, never that something was checked.** "Not yet
  listened to / not run on hardware" is a reminder; once it is done, delete the
  line — do not reword it into "the user listened and accepted it". A
  listening verdict stays only as the reason for a decision.

## Index

- [driver-decisions.md](driver-decisions.md) — **why MMLispDRV is shaped as it
  is**: the measurement that moved the sequencer off the Z80, the reversed
  decisions, the competitor survey, the bugs no gate could see and how the
  gates fail, the 68000's share and the figures to reopen it with, onset
  jitter under write bursts, SE and several songs, and the user's rulings on
  how to work here. The design itself is `docs/driver.md`.
- [pcm.md](pcm.md) — **PCM: the user's decisions with their reasons, the
  multi-bank measurements, and what is open.** Read before touching PCM in any
  layer.
- [language-open.md](language-open.md) — **the language and IR**: the rulings
  not to re-propose, why the value machine and score-written values have
  their shape, and one known A/B divergence.
- [live-app.md](live-app.md) — **the live app**: what was decided against
  (not to be proposed again) and working lessons.
- [targets.md](targets.md) — **machines beyond the Mega Drive**: the rulings
  for SCC / OPLL and the restructure plan (and its state) that comes before
  them.
