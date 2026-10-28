# tools

Local CLI tooling for the compile/verify workflow.

MMB encoding lives in the browser toolchain (`live/src/export-mmb.js`, File >
Export > MMB…), not here. Driver A/B verification is `cd drv && npm run
verify:ab` (the gate) or `window.__abCompare()` in the live app — see
docs/driver.md §12.

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
9. `npm run check:reference` — every example of the Live reference compiles and plays, and every completion word has an entry
10. `npm run check:sample-fx` — a sample def's `:fx` chain and its bake
11. `npm run check:scope-trigger` — the oscilloscope's trigger holds a stationary picture
12. `npm run check:snapshot` — the compiler's IR, the IR player's register log, the MMB
    and the VGM of every score in `drv/tests` (NTSC and PAL), the SGDK example and
    `examples/` still hash to `snapshot-baseline.json`; a score in `tests/<target>/`
    (a target with no driver) holds what its chips have so far — its IR and
    diagnostics, the register log and VGM once they encode. A change that should not move
    the output keeps it green; one that should, is reviewed (`-- --dump DIR` before and
    after, then `diff -r`) and re-frozen with `-- --update`.
13. `npm run check:resynth` — the FM3 resynthesis finds a synthesized vowel's
    formants and its hiss, and both scores it writes compile
14. `npm run check:voice-estimate` — the FM voice estimate: its chip model held to
    Nuked, and a known patch's pitch read, its sound come within a few dB, and
    its def-fm compile
15. `npm run check:import-mdx-mgs` — the MDX and MGS song imports, on files built
    there: each command family lands where it should, and every score compiles
16. `npm run check:import-vgm` — the VGM import, on the toolchain's own VGM of a
    test score: the YM2151's noise as x68k's fm8 `:mode noise`, md's `noise`;
    the SSG's mixer and envelope; the SCC's and the HuC6280's waves as def-waves,
    the HuC6280's noise at the rates it played and its pan; the 2A03's duties,
    triangle and noise modes, and its DMC samples from the file's memory blocks;
    the FDS's waves, gain and modulation on `fds-wave`
17. `npm run check:import-tracker` — a PC Engine and an NES DefleMask module
    written there, byte by byte: the PC Engine's wavetables, wave macro, `10xx`,
    `08xy` and noise come back as pce; the NES's duty macro and `12xx`, linear
    volumes, triangle and noise rates and modes as fc, and a Disk System
    channel as fc's `fds-wave` (its 64-step wave, `11xx` `13xx` `15xx` `16xy`
    as the song's LFO words); every score compiles
18. `npm run check:archive` — the archives Live opens as folders, on ZIP and LZH
    files written there (and an `-lh5-` encoder written from LHA's): names,
    folders, damage; `-- <dir>` also reads every archive under a directory,
    CRC-checked (lhasa's `test/archives` held the LHA variants to it)
19. `npm run snapshot:imports -- --out <dir> --set <name> <folder>...` — not a
    check: the song importers (MDX, MGS, mucom88, MIDI, DMF, FUR) on a folder
    of real songs kept outside the repo, each score and its diagnostics written
    under `<dir>/<name>/`. Take a set before an importer change and one after,
    then `diff -r`: a refactor leaves none, a notation change only the ones it
    means (`--limit N` takes N files of each kind, `--only mdx,mgs` some kinds).
    `--out <dir> --moves base,now` compiles two sets taken `--flat` (no
    repeats folded, so a note's tick is its time) and lists the tracks whose
    notes lose a pitch move — a rewritten notation that drops a vibrato or a
    slide shows there, which the diff hides in the lines it rewrites;
    `--regs base,now` plays them and compares their register writes — a
    rewrite that must sound the same writes the same
20. `node scripts/ab-mucom88.mjs song.muc song.vgm [--flat] [channel]` — not a
    check: a mucom88 import held to the real mucom88's VGM of the song (built
    from `github.com/onitama/mucom88`, `make OS_SDL=0` with the dummy OS's two
    missing stubs; it reads the `.muc` as UTF-8 — convert from CP932, not
    Shift_JIS, or `\` becomes `¥`), frame by frame on FM, SSG and the rhythm:
    sounding, pitch and level, at the offset and clock ratio that agree best

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
