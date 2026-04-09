# Compiler Contract v0.1 Draft

This document defines the minimal source-to-IR contract implemented for the
v0.1 draft workflow.

## 1. Scope

Implemented now:

1. Parse a subset of GMLisp source forms used in demo files
2. Emit deterministic IR JSON
3. Verify generated IR against canonical snapshots

Not implemented yet:

1. Full language surface
2. Semantic diagnostics catalog
3. Binary GMB writer

## 2. CLI Commands

Run from tools directory.

1. `npm run gml2ir -- ../examples/source/demo1-stage-loop.gml --out ../examples/ir/demo1-stage-loop.ir.generated.json`
2. `npm run build:ir-demos`
3. `npm run check:ir-demos`

## 3. Input Contract

Accepted source constructs in v0.1 minimal compiler:

1. `(score ...)`
2. `(part ...)`
3. `(phrase ...)`
4. `(note ...)`, `(rest ...)`, `(tie ...)`
5. `(marker ...)`, `(jump ...)`
6. `(param-set ...)`, `(param-add ...)`
7. `(loop-begin ...)`, `(loop-end ...)`
8. `:tempo` and `:len` phrase options

## 4. Output Contract

IR root fields:

1. `version`
2. `ppqn`
3. `metadata`
4. `tracks`

Track fields:

1. `id`
2. `name`
3. `channel`
4. `events`

Event fields:

1. `tick`
2. `cmd`
3. `args`
4. `src`

## 5. Determinism Rules

1. Object keys are sorted before serialization
2. Event order follows source order at equal tick
3. Tick progression is computed from normalized note/rest/tie lengths

## 6. Current Limitations

1. One emitted track per part (first channel in `:ch` vector)
2. No macro expansion
3. No reserved v0.2 command handling
4. Error handling is basic and not yet code-based

## 7. Next Steps

1. Add structured diagnostic codes and source spans
2. Add semantic checks for marker and loop validity
3. Add minimal GMB writer from IR
