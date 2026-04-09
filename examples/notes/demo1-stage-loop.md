# Demo Notes: demo1-stage-loop

## Goal

Validate loop and marker behavior with simple FM parameter modulation.

## Validation Plan

1. Confirm marker intro and jump resolve deterministically.
2. Confirm loop playback remains stable for at least 32 bars.
3. Confirm param-set and param-add produce expected target values.

## Artifacts

1. Source: examples/source/demo1-stage-loop.gml
2. Expected IR: examples/ir/demo1-stage-loop.ir.canonical.json

## Result Log

1. Date: 2026-04-09
2. Build: draft-manual
3. Outcome: phrase expanded and expected IR drafted
4. Follow-up: verify snapshot against real compiler output
