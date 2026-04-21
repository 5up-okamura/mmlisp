# Compiler Contract v0.1 Draft

This document defines the minimal source-to-IR contract implemented for the
v0.1 draft workflow.

Related draft path now included: source -> IR -> GMB.

## 1. Scope

Implemented now:

1. Parse a subset of MMLisp source forms used in demo files
2. Emit deterministic IR JSON
3. Verify generated IR against canonical snapshots
4. Encode draft GMB binary from IR
5. Validate generated GMB structural integrity
6. Emit structured semantic diagnostics for marker, loop, and target checks
7. Encode fixed binary payloads per opcode (no JSON args payload)

Not implemented yet:

1. Full language surface
2. Full semantic diagnostics catalog coverage
3. Frozen opcode table and long-term compatibility proof with MMLispDRV

## 2. CLI Commands

Run from tools directory.

1. `npm run mmlisp2ir -- ../examples/source/demo1-stage-loop.mmlisp --out ../examples/ir/demo1-stage-loop.ir.generated.json`
2. `npm run build:ir-demos`
3. `npm run check:ir-demos`
4. `npm run mmlisp2mmb -- ../examples/ir/demo1-stage-loop.ir.canonical.json --out ../examples/gmb/demo1-stage-loop.mmb --meta ../examples/gmb/demo1-stage-loop.meta.json`
5. `npm run build:gmb-demos`
6. `npm run check:gmb-demos`

## 3. Input Contract

Accepted source constructs in v0.3 compiler:

1. `(def name value)` — compile-time constant
2. `(defn name [params ...] body ...)` — template macro (expanded before compilation)
3. `(score ...)`
4. `(track ...)`
5. `(seq ...)` — inline note/rest sequence with persistent state
6. `(rest ...)`, `(tie ...)`
7. `(marker ...)`, `(jump ...)`
8. `(param-set ...)`, `(param-add ...)` — multiple KV pairs supported per call
9. `(loop-begin ...)`, `(loop-end ...)`, `(x N ...)` — loop forms
10. track option `:oct` — initial octave (default: 4)
11. track option `:len` — default note length (default: `1/8`)
12. track option `:gate` — default gate (default: `1.0`)
13. track option `:role` — track behavior declaration (bgm | se | modulator | chaos; default: bgm)
14. track option `:write` — write-scope vector (default: [:any])
15. track option `:ch` — channel hint vector (default: auto-increment by track index; track 0 → fm1, track 1 → fm2, …)
16. track option `:carry` — carry enable flag
17. track option `:shuffle`, `:shuffle-base` — shuffle/swing timing

Removed in v0.3 (emit E_PHRASE_REMOVED / E_NOTE_REMOVED diagnostics):

- `(phrase ...)`, `(note ...)`, `(notes ...)`, `(tuplet ...)` — replaced by `seq`

`seq` modifier rules:

1. `:oct N` — set current octave (0–8); persists for subsequent notes in this seq
2. `:len val` — set current note length (fraction `1/4`, denominator `4`, etc.); persists
3. `:gate val` — set current gate (ratio `0.0`–`1.0` or percent `80%`); persists
4. `>` — increment current octave by 1 (persistent)
5. `<` — decrement current octave by 1 (persistent)
6. `_` — rest using current length
7. `~` — tie: extend previous note by current length; optionally `~ 1/2` to specify length explicitly
8. `:c4`, `:d#3`, `:bb5`, etc. — absolute pitch note; updates current octave to the specified octave
9. `c`, `d#`, `bb`, etc. — bare note name; plays at current octave with current length and gate
10. Each seq has independent state initialized from the enclosing track defaults

`def` / `defn` rules: 2. `(defn name [params] body...)` defines a template macro; `(name arg1 arg2)` expands to body with params substituted 3. defn may call other defn (chain expansion); recursion is rejected (depth limit 16) 4. def/defn must appear at top level, before `(score ...)` 5. Expansion is purely compile-time; no IR commands are emitted for def/defn themselves

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

1. One emitted IR track per source track (track splitting and voice stealing are not yet implemented)
2. No reserved v0.2 command handling
3. Error handling is basic and not yet code-based

## 7. Next Steps

1. Expand diagnostics to additional semantic rules and edge cases
2. Freeze opcode table and argument packing for v0.1
3. Add compatibility fixtures consumed by future MMLispDRV decoder tests
