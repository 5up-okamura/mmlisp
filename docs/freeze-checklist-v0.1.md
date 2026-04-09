# GMLisp v0.1 Freeze Checklist

Use this checklist when proposing the v0.1 freeze candidate.

## A. Authoring Validation

1. Two or more demo songs exist in examples/source.
2. Each demo exercises loop and marker behavior.
3. Each demo includes at least one base/delta modulation case.

## B. Compiler and IR Validation

1. Source files compile without warnings in strict v0.1 mode.
2. IR snapshots are exported for each demo.
3. IR snapshots are deterministic across repeated runs.
4. Marker and jump references are fully resolved.

## C. GMB Validation

1. GMB exports are produced for each demo.
2. Header version and flags are valid.
3. Section directory is in bounds and consistent.
4. Track event offsets and lengths are valid.

## D. Review and Change Control

1. Spec, command table, IR draft, and GMB draft are cross-reviewed.
2. Excluded features are listed with rationale.
3. Known risks are documented with owner and follow-up version.
4. Freeze review note is committed under docs/reviews.

## E. Exit Criteria

1. All checklist items are checked.
2. Draft docs are tagged as freeze candidate.
3. No unresolved blocker remains for starting GMLDRV implementation.
