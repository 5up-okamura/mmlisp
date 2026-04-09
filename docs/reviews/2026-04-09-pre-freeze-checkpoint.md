# GMLisp v0.1 Pre-Freeze Checkpoint (2026-04-09)

## 1. Candidate Info

1. Candidate ID: pre-freeze-2026-04-09
2. Date: 2026-04-09
3. Reviewer(s): okamura
4. Compiler version: gmlisp-tools-0.1.0-draft

## 2. Scope Confirmation

1. Included documents:
   - docs/spec-v0.1-draft.md
   - docs/command-table-v0.1-draft.md
   - docs/ir-v0.1-draft.md
   - docs/gmb-format-v0.1-draft.md
   - docs/freeze-checklist-v0.1.md
   - docs/gmldrv-decoder-contract-v0.1-draft.md
2. Excluded items:
   - GMLDRV implementation
   - final opcode freeze
3. Intended freeze level: draft

## 3. Demo Validation

1. demo1-stage-loop.gml result: phrase expanded, runtime validation pending
2. demo2-event-recovery.gml result: phrase expanded, runtime validation pending
3. Loop/marker stability notes: expected event paths documented
4. base/delta recovery notes: expected delta behavior documented

## 4. IR Validation

1. Deterministic output check: pass via tools/check:ir-demos
2. Marker/jump resolution check: pass for current demo scenarios
3. Diagnostic quality check: partial (semantic diagnostics implemented for marker/loop/target)

## 5. GMB Validation

1. Header validity: pass for demo1/demo2 via tools/check:gmb-demos
2. Section directory validity: pass for demo1/demo2
3. Track/event offset validity: pass for demo1/demo2

## 6. Risks and Decisions

1. Accepted risk: opcode map is provisional
2. Deferred to v0.2: CSM and FM3 dedicated command behavior
3. Blocking issue (if any): opcode id table and arg packing are not frozen

## 7. Decision

1. Freeze accepted: no
2. Freeze accepted with conditions: no
3. Freeze rejected: yes (pre-freeze checkpoint only)

## 8. Action Items

1. Owner: okamura
2. Task: freeze opcode table and add decoder compatibility fixtures
3. Due: next checkpoint
