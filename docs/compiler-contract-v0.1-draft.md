# Compiler Contract v0.1 Draft

This document defines the minimal source-to-IR contract implemented for the
v0.1 draft workflow.

Related draft path now included: source -> IR -> GMB.

## 1. Scope

Implemented now:

1. Parse a subset of GMLisp source forms used in demo files
2. Emit deterministic IR JSON
3. Verify generated IR against canonical snapshots
4. Encode draft GMB binary from IR
5. Validate generated GMB structural integrity
6. Emit structured semantic diagnostics for marker, loop, and target checks
7. Encode fixed binary payloads per opcode (no JSON args payload)

Not implemented yet:

1. Full language surface
2. Full semantic diagnostics catalog coverage
3. Frozen opcode table and long-term compatibility proof with GMLDRV

## 2. CLI Commands

Run from tools directory.

1. `npm run gml2ir -- ../examples/source/demo1-stage-loop.gml --out ../examples/ir/demo1-stage-loop.ir.generated.json`
2. `npm run build:ir-demos`
3. `npm run check:ir-demos`
4. `npm run gml2gmb -- ../examples/ir/demo1-stage-loop.ir.canonical.json --out ../examples/gmb/demo1-stage-loop.gmb --meta ../examples/gmb/demo1-stage-loop.meta.json`
5. `npm run build:gmb-demos`
6. `npm run check:gmb-demos`

## 3. Input Contract

Accepted source constructs in v0.1 minimal compiler:

1. `(score ...)`
2. `(part ...)`
3. `(phrase ...)`
4. `(note ...)`, `(rest ...)`, `(tie ...)`
5. `(notes ...)` — sugar for batch note/rest sequences (expands to NOTE_ON / REST)
6. `(marker ...)`, `(jump ...)`
7. `(param-set ...)`, `(param-add ...)` — multiple KV pairs supported per call
8. `(loop-begin ...)`, `(loop-end ...)`
9. `:tempo` and `:len` phrase options
10. part option `:role` as track behavior declaration (bgm | se | modulator | chaos; default: bgm)
11. part option `:write` as write-scope vector (default: [:any])

`notes` expansion rules:

1. `(notes :c4 :e4 _ :g4)` expands to `(note :c4)` `(note :e4)` `(rest)` `(note :g4)` using phrase `:len`
2. `_` is the rest symbol
3. Optional `:len` keyword overrides default length: `(notes :len 1/16 :c4 :e4)`
4. Expansion happens before IR emission; no dedicated IR command exists

`param-set` / `param-add` multiple KV rules:

1. `(param-set :fm-fb 2 :fm-tl1 40)` emits two PARAM_SET events at the same tick
2. Each keyword-value pair is expanded independently
3. `param-add` follows the same pattern with PARAM_ADD events
4. Single-pair form remains valid and unchanged

Track role model:

1. `:bgm` owns note-on/off; default for music tracks
2. `:se` can evict bgm tracks from channels
3. `:modulator` blends FM parameters without eviction; multiple can stack on one channel
4. `:chaos` no ownership; writes freely; intentional undefined behavior is permitted

## 4. Output Contract

IR root fields:

1. `version`
2. `ppqn`
3. `metadata`
4. `tracks`

Track fields:

1. `id`
2. `name`
3. `channel` (legacy preferred channel)
4. `route_hint`
5. `events`

`route_hint` fields in current draft implementation:

1. `allocation_preference`
2. `channel_candidates`
3. `role`
4. `write_scope`

Event fields:

1. `tick`
2. `cmd`
3. `args`
4. `src`

GMB output contract (draft):

1. Header with magic/version/section directory count
2. Section directory with absolute offsets and sizes
3. Track table section
4. Event stream section
5. Metadata section

## 5. Determinism Rules

1. Object keys are sorted before serialization
2. Event order follows source order at equal tick
3. Tick progression is computed from normalized note/rest/tie lengths

## 6. Current Limitations

1. One emitted track per part (track splitting and voice stealing are not yet implemented)
2. No macro expansion
3. No reserved v0.2 command handling
4. Error handling is basic and not yet code-based

## 7. Next Steps

1. Expand diagnostics to additional semantic rules and edge cases
2. Freeze opcode table and argument packing for v0.1
3. Add compatibility fixtures consumed by future GMLDRV decoder tests
