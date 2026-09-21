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
3. `npm run mmlisp2ir -- ../examples/source/ab-core.mmlisp --out /tmp/ab-core.ir.json`
4. `npm run verify-ir -- a.ir.json b.ir.json`
5. `npm run check:mmlisp-strict`

## Notes

1. Generated files use deterministic key ordering to simplify diffs.
