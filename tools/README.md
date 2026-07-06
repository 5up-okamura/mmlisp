# tools

Local CLI tooling for the compile/verify workflow.

MMB encoding lives in the browser toolchain (`live/src/export-mmb.js`, File >
Export > MMB…), not here; the v0.1 MMB scripts were removed with the format's
v0.2 rewrite. Driver A/B verification runs in the live app —
`window.__abCompare()` — see docs/driver.md §12.

## Requirements

1. Node.js 18+

## Commands

Run from tools directory:

1. `npm run format:mmlisp`
2. `npm run check:format:mmlisp`
3. `npm run mmlisp2ir -- ../examples/source/demo1.mmlisp --out ../examples/ir/demo1.ir.generated.json`
4. `npm run build:ir-demos`
5. `npm run verify-ir -- ../examples/ir/demo1.ir.canonical.json ../examples/ir/demo1.ir.generated.json`
6. `npm run check:ir-demos`
7. `npm run check:mmlisp-strict`

## Notes

1. Generated files use deterministic key ordering to simplify diffs.
2. `build:ir-demos` runs in strict mode and emits diagnostics JSON files under
   `examples/ir`.
