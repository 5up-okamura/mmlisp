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
8. `npm run check:i18n` — every translation of the Live reference, snippets and lessons present and current
9. `npm run check:reference` — every example of the Live reference compiles and plays, and every completion word has an entry
   (`npm run check:def-templates`: every def the completion writes out, from each
   machine's parts, compiles on its machine)
10. `npm run check:sample-fx` — a sample def's `:fx` chain and its bake
11. `npm run check:scope-trigger` — the oscilloscope's trigger holds a stationary picture
12. `npm run check:snapshot` — the compiler's IR, the IR player's register log, the MMB,
    the VGM and the MIDI of every score in `drv/tests` (NTSC and PAL), the SGDK example and
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
17. `npm run check:import-nsf` — the NSF import, on NSFs built there (a small
    6502 driver playing a table of writes): the 2A03 and all six expansions on
    their own fc channels, the loop where the state comes round and where a
    counter keeps it from coming round, a song that stops, banks and a DMC
    sample as they map it; every score compiles
18. `npm run check:import-midi` — a MIDI file written there (a chord, a bent
    lead, drums) on every target at its defaults: each compiles clean, keeps
    the parts it has room for, and reads a program and a drum by the channel
    they land on
19. `npm run check:export-midi` — File > Export > MIDI on every test score:
    the file reads back as the notes the export wrote, each key on goes off,
    and every note of a track's first pass starts where the IR's does; one
    score written there holds each row of the mapping (a gm voice's program,
    the faders' CC7, a pan, a glide's bend and its range, a slur, a hold,
    `:snap`, a kit role on channel 10, the loop's marks, a tempo change)
20. `npm run check:stems` — File > Export > Stems on a score of each machine:
    a stem a mixer strip (a ROM rhythm sound its own), one length, each
    sounding and none off zero; where the chips mix their channels on their
    own (the SSG, the AY, the Game Boy, the HuC6280's waves) the stems and the
    floor add up to the WAV export, sample for sample
21. `npm run check:midi-out` — MMLisp > MIDI > Output: on an IR player
    stepped by hand, each note on goes out with the YM2612's key-on, through
    a tempo change and round the loop, and a seek chases the channel's
    program and level; on a stand-in player, mute, stop (no key left held),
    a hot-swap at its bar, the loop leaving what stood before its label, a
    plan made again and one that comes late
22. `npm run check:import-tracker` — a PC Engine and an NES DefleMask module
    written there, byte by byte: the PC Engine's wavetables, wave macro, `10xx`,
    `08xy` and noise come back as pce; the NES's duty macro and `12xx`, linear
    volumes, triangle and noise rates and modes as fc, and a Disk System
    channel as fc's `fds-wave` (its 64-step wave, `11xx` `13xx` `15xx` `16xy`
    as the song's LFO words); every score compiles
23. `npm run check:archive` — the archives Live opens as folders, on ZIP and LZH
    files written there (and an `-lh5-` encoder written from LHA's): names,
    folders, damage; `-- <dir>` also reads every archive under a directory,
    CRC-checked (lhasa's `test/archives` held the LHA variants to it)
24. `npm run check:font-sizes` — Live's type sizes stay `--text`, `--label` and
    `--mark`: no size written as a number outside `style.css`'s `:root`
25. `npm run check:gb-level` — the Game Boy's level under a note, read as the
    chip steps it and as MAME's core takes it; a stop's and a hot swap's
    key-offs, the wave's loads
26. `npm run check:new-score` — File > New: each machine's empty score compiles
    clean, with its tracks, its imports and a sound on each rhythm track
27. `npm run check:edit-tools` — the Logical Editor's edits on score text:
    a transpose, a reverse, a shuffle moved once and where they should
28. `npm run check:ab-snapshots` — A/B Compare's two working copies: switching,
    copying across, each keeping its own state
29. `npm run gen:wavetable` / `npm run check:wavetable` — `presets/wavetable`,
    computed from formulas; the check fails if the set is not what it writes
30. `npm run gen:fm-roles` / `npm run check:fm-roles` — `presets/fm-roles`, the
    melodic roles as FM voices read off `presets/gm`; the check as above
31. `npm run snapshot:imports -- --out <dir> --set <name> <folder>...` — not a
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
32. `node scripts/ab-mucom88.mjs song.muc song.vgm [--flat] [channel]` — not a
    check: a mucom88 import held to the real mucom88's VGM of the song (built
    from `github.com/onitama/mucom88`, `make OS_SDL=0` with the dummy OS's two
    missing stubs; it reads the `.muc` as UTF-8 — convert from CP932, not
    Shift_JIS, or `\` becomes `¥`), frame by frame on FM, SSG and the rhythm:
    sounding, pitch and level, at the offset and clock ratio that agree best
33. `node scripts/ab-mgsdrv.mjs song.mgs [seconds] [channel]` — not a check: an
    MGS import held to the real MGSDRV (`npm i --no-save libkss-js`, which runs
    it on an emulated MSX), frame by frame on every PSG, SCC and FM channel
34. `npm run check:lessons` — the Guide (MMLisp Live's tutorial, tours and tools, `tutorial/`): every
    step compiles clean, its exercise is not done before the learner starts,
    and its answer does it; the walk (Next runs on through the lessons, never
    into or out of a machine's tour; Start Lesson resumes at the first step
    not done) and a Try's states, as `live/src/lessons.js` gives them
35. `npm run check:share` — share links with files (`live/worker/`,
    `live/src/share-files.js`) against an in-memory KV: a score alone keeps its
    id, files are stored and served, the same files get the same id however
    they were packed, a bundle the app would not write is refused, and a wav
    travels mono, 16-bit, at most 22.05 kHz unless a def counts its frames
36. `npm run gen:snippet-targets` / `npm run check:snippet-targets` —
    `snippets/targets.json`, the machines each snippet plays on (every
    snippet ported to every target and compiled; the Library marks by it);
    the check fails if the file is not what the snippets and compiler give

## i18n

The Live app shows the reference's summaries and the snippets' descriptions
in the user's language (MMLisp ▸ Language), and so do the lessons and the
dialogs that ask; the rest of the app stays in English. The English is the
source, read from `live/src/reference.js`, the snippets' leading comments, the
tutorial (`tutorial/lessons.json`'s titles, its steps' leading comments) and
`live/src/ui-texts.js` (a dialog's `{name}` marks, which a translation keeps
— the check says when one is lost); each language
is one generated pack, `live/src/i18n/<lang>.js`, that pairs every text with a
hash of the English it translates. Nobody edits a pack:

2. `node scripts/i18n-sync.mjs --todo ja > /tmp/ja.json` — the texts the pack
   lacks or whose English changed, as `{"section/key": "English"}`.
2. Translate the values in place (an AI session does this, with
   [i18n/glossary.md](i18n/glossary.md) — the terms to keep and the ones never
   translated — in hand).
4. `node scripts/i18n-sync.mjs --apply ja /tmp/ja.json` — merges the
   translations in and drops texts the English no longer has.

`npm run check:i18n` fails on anything missing, stale or orphaned, so a
changed summary or a new snippet is translated before it lands. A new language
is a pack `--apply` creates, plus its import and name in `live/src/i18n.js`.

## Notes

1. Generated files use deterministic key ordering to simplify diffs.
