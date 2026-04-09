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
5. `npm run gml2gmb -- ../examples/ir/demo1-stage-loop.ir.canonical.json --out ../examples/gmb/demo1-stage-loop.gmb --meta ../examples/gmb/demo1-stage-loop.meta.json`
6. `npm run build:gmb-demos`
7. `npm run verify-gmb -- ../examples/gmb/demo1-stage-loop.gmb`
8. `npm run check:gmb-demos`

## Notes

1. The current compiler is intentionally minimal and supports only the v0.1 subset used in the demo files.
2. Generated files use deterministic key ordering to simplify diffs.
3. The current GMB writer is a draft implementation aligned to section layout goals, not a frozen opcode format.
