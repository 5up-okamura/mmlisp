# tools

Local tooling for the draft workflow.

## Requirements

1. Node.js 18+

## Commands

Run from tools directory:

1. `npm run format:mmlisp`
2. `npm run check:format:mmlisp`
3. `npm run mmlisp2ir -- ../examples/source/demo1-stage-loop.mmlisp --out ../examples/ir/demo1-stage-loop.ir.generated.json`
4. `npm run build:ir-demos`
5. `npm run verify-ir -- ../examples/ir/demo1-stage-loop.ir.canonical.json ../examples/ir/demo1-stage-loop.ir.generated.json`
6. `npm run check:ir-demos`
7. `npm run mmlisp2mmb -- ../examples/ir/demo1-stage-loop.ir.canonical.json --out ../examples/gmb/demo1-stage-loop.mmb --meta ../examples/gmb/demo1-stage-loop.meta.json --target-profile md-full`
8. `npm run build:gmb-demos`
9. `npm run verify-mmb -- ../examples/gmb/demo1-stage-loop.mmb`
10. `npm run check:gmb-demos`
11. `npm run build:gmb-fixtures`
12. `npm run check:gmb-fixtures`

## Notes

1. The current compiler is intentionally minimal and supports only the v0.1 subset used in the demo files.
2. Generated files use deterministic key ordering to simplify diffs.
3. The current GMB writer uses fixed binary payloads per opcode, but the opcode table is not yet frozen.
4. `build:ir-demos` runs in strict mode and emits diagnostics JSON files under `examples/ir`.
5. `check:gmb-fixtures` verifies both expected-valid and expected-invalid fixture binaries.
6. `mmlisp2mmb` supports `--target-profile` (`md-full`, `ym2612`, `psg`) and resolves track-to-channel mapping per profile. `md-full` and `ym2612` include `fm3op1`-`fm3op4` for FM3 independent-frequency mode, and `dac` (shared ID with `fm6`).
