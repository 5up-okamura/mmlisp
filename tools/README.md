# tools

Local CLI tooling for the compile/verify workflow.

MMB encoding lives in the browser toolchain (`live/src/export-mmb.js`, File >
Export > MMB…), not here. Driver A/B verification runs in the live app —
`window.__abCompare()` — see docs/driver.md §12.

## Requirements

1. Node.js 18+

## Commands

Run from tools directory:

1. `npm run format:mmlisp`
2. `npm run check:format:mmlisp`
3. `npm run mmlisp2ir -- ../drv/tests/ab-core.mmlisp --out /tmp/ab-core.ir.json`
4. `npm run verify-ir -- a.ir.json b.ir.json`
5. `npm run check:mmlisp-strict`
6. `npm run check:cheatsheet` — the examples in docs/cheatsheet.md still compile
7. `npm run mcp` — the MMLisp MCP server for AI clients (see [mcp/README.md](mcp/README.md))
8. `npm run check:i18n` — every translation of the Live reference and snippets present and current

## i18n

The Live app shows the reference's summaries and the snippets' descriptions
in the user's language (MMLisp ▸ Language); the rest of the app stays in
English. The English is the source, read from `live/src/reference.js` and the
snippets' leading comments; each language is one generated pack,
`live/src/i18n/<lang>.js`, that pairs every text with a hash of the English it
translates. Nobody edits a pack:

1. `node scripts/i18n-sync.mjs --todo ja > /tmp/ja.json` — the texts the pack
   lacks or whose English changed, as `{"section/key": "English"}`.
2. Translate the values in place (an AI session does this, with
   [i18n/glossary.md](i18n/glossary.md) — the terms to keep and the ones never
   translated — in hand).
3. `node scripts/i18n-sync.mjs --apply ja /tmp/ja.json` — merges the
   translations in and drops texts the English no longer has.

`npm run check:i18n` fails on anything missing, stale or orphaned, so a
changed summary or a new snippet is translated before it lands. A new language
is a pack `--apply` creates, plus its import and name in `live/src/i18n.js`.

## Notes

1. Generated files use deterministic key ordering to simplify diffs.
