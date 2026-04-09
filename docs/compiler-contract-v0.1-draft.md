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

1. One emitted track per part (first channel in `:ch` vector)
2. No macro expansion
3. No reserved v0.2 command handling
4. Error handling is basic and not yet code-based

## 7. Next Steps

1. Expand diagnostics to additional semantic rules and edge cases
2. Freeze opcode table and argument packing for v0.1
3. Add compatibility fixtures consumed by future GMLDRV decoder tests
