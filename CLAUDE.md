# MMLisp

MMLisp is a Lisp-like DSL for composing expressive, interactive music for the
Sega Mega Drive (YM2612 FM + PSG), ultimately compiled to a Z80 sound driver.

Current baseline: **v0.5**. The phase is "use and adjust" — the language and
API evolve from practical composition needs.

## Codebase map

The toolchain lives in `live/src/` and follows a single pipeline:

```
Source (.mmlisp) → AST → IR (JSON) → Player
```

| File                  | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| `mmlisp-parser.js`    | Tokenize + parse source into a generic list/atom AST          |
| `mmlisp2ir.js`        | Compile AST → IR: voice resolution, macro parsing, event emit |
| `ir-utils.js`         | Shared: pitch/MIDI conversion, target ranges, curve sampling  |
| `ir-player.js`        | Runtime: schedule IR events, run macros, write chip registers |
| `mmlisp-formatter.js` | Source formatter                                              |
| `nuked-opn2.js`, `nuked-psg.js` | YM2612 / PSG cores (WASM, built from `third_party/` via `player/wasm/`) |

The MMB/driver side of the pipeline is `mmb.js` (shared binary tables),
`export-mmb.js` (IR → MMB v0.2), `drv-player.js` (JS reference driver), and
`ab-compare.js` (register-log A/B) in the same directory.

The Z80 driver port (Phase 3) lives in `drv/`: `src/mmlispdrv.z80` (M1
driver) plus a first-party node toolchain in `drv/tools/` (Z80 assembler,
Z80 CPU emulator, trace harness — no external binaries). Its gate:
`cd drv && npm run verify:all` must show zero trace mismatches against
`drv-player.js`.

Docs: `docs/language.md` is the canonical language reference;
`docs/guide.md` is the tutorial. Driver/format design: `docs/driver.md`,
`docs/mmb.md`, `docs/opcodes.md`; IR: `docs/ir.md`. There are no per-version
spec files — new design decisions amend these documents directly.

## Running

```
cd live && npm run serve        # dev server on :5173 (serve:https for HTTPS)
```

There is **no automated test suite**. Verify changes by playing them back in
the live environment; call this out when a change is hard to verify that way.

## Working agreements

The working agreements (English-only, no AI attribution, no legacy support,
output-side minimalism, directness, design-first workflow) live in
`.claude/rules/working-agreements.md`, which Claude Code auto-loads. Read that
file for the canonical rules.
