# Demo Notes: demo2-event-recovery

## Goal

Validate base/delta intervention and recovery behavior.

## Validation Plan

1. Confirm param-add on fm-tl1 is applied in event order.
2. Confirm tempo-scale deltas are reflected in timing output.
3. Confirm tie and loop interactions do not corrupt event stream.

## Artifacts

1. Source: examples/source/demo2-event-recovery.gml
2. Expected IR: examples/ir/demo2-event-recovery.ir.canonical.json

## Result Log

1. Date: 2026-04-09
2. Build: draft-manual
3. Outcome: phrase expanded and expected IR drafted
4. Follow-up: verify snapshot against real compiler output
