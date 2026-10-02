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
- [plan-se.md](plan-se.md) — **SE: the decisions behind the shipped design
  (suspend/restore, the claim rule, `def-se` shared by every song, CH3 taken
  whole, restore from the register shadow, no `:master`/`:lfo-rate` in an
  effect), and what is still open.** The behaviour itself is `driver.md` §2.5 and
  `drv-player.js`; read this for why, not what.
- [plan-multi-score.md](plan-multi-score.md) — **several songs: the shared
  sample bank is built (`bundle.mjs`); two scores RESIDENT at once is not.**
  The channel budget that makes a score one song, the decisions inside the
  bundle, and what moving the per-score state off the sequencer would cost.
- [plan-pcm-spec.md](plan-pcm-spec.md) — **PCM: the user's decisions behind the
  shipped light engine, with their reasons, and what is still open.** Read
  before touching PCM in any layer.
- [language-open.md](language-open.md) — **the language and IR: what is open.**
  The seven questions that need the user's decision (the 2026-09-26
  syntax audit is all landed or decided), the preview-vs-driver residue, and
  why compile-time eval and the value machine have their shape, with the
  risks that are still live.
- [plan-68k-optimization.md](plan-68k-optimization.md) — **cutting the
  68000's share — CLOSED 2026-10-02**: the result (sin008: 24.5% → 16.3%),
  what landed and what was undone for readability, the bugs found on the
  way, how to measure, and what is left for when a game drops a frame
  (assembly for the hot paths only).
- [plan-z80-only.md](plan-z80-only.md) — **a Z80-only build (roadmap Phase 3
  #6): the measurements (the archived sequencer with PCM off, the jitter
  listening set, poll overhead, the RAM budget) and the decisions taken
  (poll points, ~10 kHz, Timer A) — SET ASIDE 2026-09-28** in favour of
  plan-68k-optimization: the user judged the build would lose most of what
  makes the driver distinctive. Kept for the day it is revisited — with a
  second shape seen 2026-10-02: MMLisp as the composing tool, a pre-rendered
  stream (XGM) plus a few live controls on the Z80.
- [plan-editor-input-aids.md](plan-editor-input-aids.md) — the live editor's
  Lisp input aids: the implementation deviations and their reasons (why no
  `@codemirror/lint`, the layer-only rule, which shortcuts Chrome steals), the
  Edit menu's measurement, and the standing decisions — never auto-repair
  brackets, no full paredit, no rainbow parens.
