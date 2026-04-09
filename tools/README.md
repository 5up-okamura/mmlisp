# tools

Local tooling for the draft workflow.

## Requirements

1. Node.js 18+

## Commands

Run from tools directory:

1. `npm run gml2ir -- ../examples/source/demo1-stage-loop.gml --out ../examples/ir/demo1-stage-loop.ir.generated.json`
2. `npm run build:ir-demos`
3. `npm run verify-ir -- ../examples/ir/demo1-stage-loop.ir.canonical.json ../examples/ir/demo1-stage-loop.ir.generated.json`
4. `npm run check:ir-demos`
5. `npm run gml2gmb -- ../examples/ir/demo1-stage-loop.ir.canonical.json --out ../examples/gmb/demo1-stage-loop.gmb --meta ../examples/gmb/demo1-stage-loop.meta.json --target-profile md-full`
6. `npm run build:gmb-demos`
7. `npm run verify-gmb -- ../examples/gmb/demo1-stage-loop.gmb`
8. `npm run check:gmb-demos`
9. `npm run build:gmb-fixtures`
10. `npm run check:gmb-fixtures`

## Notes

1. The current compiler is intentionally minimal and supports only the v0.1 subset used in the demo files.
2. Generated files use deterministic key ordering to simplify diffs.
3. The current GMB writer uses fixed binary payloads per opcode, but the opcode table is not yet frozen.
4. `build:ir-demos` runs in strict mode and emits diagnostics JSON files under `examples/ir`.
5. `check:gmb-fixtures` verifies both expected-valid and expected-invalid fixture binaries.
6. `gml2gmb` supports `--target-profile` (`md-full`, `ym2612`, `psg`) and resolves track-to-channel mapping per profile. `md-full` and `ym2612` include `fm3op1`-`fm3op4` for FM3 independent-frequency mode, and `dac` (shared ID with `fm6`).
