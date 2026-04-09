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

## Notes

1. The current compiler is intentionally minimal and supports only the v0.1 subset used in the demo files.
2. Generated files use deterministic key ordering to simplify diffs.
