# Project memory (cross-session, in-repo)

State and reasoning that the code and docs do **not** record — checked in, so a
cloud session and a local one share it. Not documentation (that is `docs/`), not
personal workflow preferences.

Rules:

- One topic per file. Keep each current: edit in place, delete when the work
  lands and the repo itself records the outcome.
- **A file here must never assert something the docs also assert.** When it
  does, the docs win and this copy rots — which is exactly what happened to the
  five driver files merged away on 2026-09-22.
- If a file describes a build that no longer exists, say so in its first
  sentence or delete it.

## Index

- [driver-decisions.md](driver-decisions.md) — **why MMLispDRV is shaped as it
  is.** The measurement that moved the sequencer off the Z80, which of the
  pivot's decisions were later reversed, the competitor survey (XGM2's hardware
  write-timing table, what MDSDRV and XGM2 do about holes), the three bugs no
  gate could see, how this repo's gates fail, the C-port lessons, and the
  user's rulings on how to work here. The design itself is `docs/driver.md`.
- [plan-se.md](plan-se.md) — **SE: the settled design for work not yet ported.**
  SE exists only in `drv-player.js`; the C sequencer and the SGDK host have
  none. Read `drv-player.js` as the spec and this for the decisions behind it.
- [plan-pcm-spec.md](plan-pcm-spec.md) — **PCM: the user's decisions behind the
  shipped light engine, with their reasons, and what is still open.** Read
  before touching PCM in any layer.
- [language-open.md](language-open.md) — **the language and IR: what is open.**
  The questions from the 2026-09-18 audit that need the user's decision, what
  was decided and fixed, and why compile-time eval and the value machine have
  their shape — including the latent hold-sentinel collision.
- [plan-editor-input-aids.md](plan-editor-input-aids.md) — the live editor's
  Lisp input aids: the implementation deviations and their reasons (why no
  `@codemirror/lint`, the layer-only rule, which shortcuts Chrome steals), the
  Edit menu's measurement, and the standing decisions — never auto-repair
  brackets, no full paredit, no rainbow parens.

## Not in this repo

`docs/dac-engine-implementation.md` is the DAC engine's designer↔implementer
instruction document (R1–R28). It is **local only** — kept out of git on the
user's instruction (`.git/info/exclude`), so a fresh clone and every cloud
session lack it. Six files in `drv/engine/` and `drv/tools/` cite its sections
for provenance; each quotes the requirement it needs inline, so the code stands
without it. The shipped engine's design is `docs/driver.md` §5.
