# Known issue — DRV backend mis-plays complex mucom-imported songs

Reported 2026-07-14 (user). **Report-only — do NOT investigate/fix while the
v0.6 driver track is mid-implementation** (interleaving destabilizes the
in-flight work). Pick this up as its own focused task once the current step
lands.

## Symptom

Playing a *fully-composed* mucom-imported song through the **MMLispDrv
Backend** (the `drv-player.js` reference driver, toggled in the live app —
`project-live-value-editing-ui` / menu) plays back wrong:

- pitch is off in places,
- loop points are shifted,
- demo-level scores are fine, but a song that exercises the **full feature
  set** accumulates many small errors that compound into large audible drift.

The normal player (`ir-player.js`) presumably plays it correctly — the report
is specifically about the DRV backend path.

## Why the gates don't catch it (context, unconfirmed hypotheses)

- `cd drv && npm run verify:all` proves **Z80 ≡ drv-player.js at 0-diff**, but
  only on the ~20 hand-written gate scores. A full mucom song exercises
  feature *combinations* the corpus doesn't cover — so a real divergence
  (drv-player.js vs ir-player.js, or the MMB export lowering) can hide.
- "Pitch off + loop points shifted, scaling with feature count" points at
  candidates worth checking first (NOT yet verified): NOTE_PITCH i16/cent
  handling, `(go)`/loop-boundary lowering, macro↔sweep interaction, mucom
  importer emission vs what the driver expects. Treat all of these as leads,
  not findings.

## When resumed — first moves

1. Get one concrete failing mucom song from the user (or a `.muc` to import).
2. A/B compare drv-player.js vs ir-player.js on it (`window.__abCompare()`,
   bands in docs/driver.md §12) to localize the first divergence.
3. Bisect by feature: strip the song down until the drift disappears, to find
   the minimal trigger.
4. Capture that minimal repro as a new gate score under `drv/tests/` so the
   fix is regression-locked (the gate-coverage gap is the root cause of this
   slipping through).

Related: [[z80-driver-status]] (driver status + how to verify),
[[project-function-call-syntax-migration]] (mucom importer).
