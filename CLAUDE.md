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
| `nuked-opn2.js`, `sn76489.js` | YM2612 / PSG emulation cores                          |

Specs: `docs/spec-v0.5.md` is canonical (`§5` is the decision table).
`docs/spec-v0.4.md` is **legacy** — reference only, do not implement against it.

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
