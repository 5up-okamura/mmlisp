# Curve range sugar: `A..B` (deferred, approved to implement later)

Status: **design agreed 2026-07 (this session); implementation deferred.** An
independent ergonomics feature, orthogonal to the Phase 3 eval steps — schedule
it as its own small commit whenever convenient (after any eval step is fine).

## What

Positional range literal for curve endpoints: `(sin -1..1 :rate 6 :len 4)` ≡
`(sin :from -1 :to 1 :rate 6 :len 4)`. Reads well and pairs naturally with the
step-2 curve arithmetic, e.g. a normalized unit shape scaled to taste:
`(* (sin -1..1 :rate 6 :len 8) 40)` (folds byte-identically to `(sin -40..40)`).

## Decisions (settled)

- **Positional only** — a bare `A..B` token in a curve form sets `from`/`to`.
  `:from`/`:to` stay valid and coexist as the explicit form.
- **Curve-position only.** Not a general eval value (a range as an arithmetic
  operand stays `E_EVAL_OPERAND`). A first-class range *value* for Phase 4
  `for i 0..7` is a bigger, separate design — but reuse the same
  `parseRangeToken` when it comes.
- **Endpoints**: signed decimals; `40..0` is a valid descending range (from>to).
- **Conflict**: a range plus an explicit `:from`/`:to` (either order), or two
  ranges → `E_CURVE_RANGE_CONFLICT`.
- **Malformed**: a token containing `..` that is not a clean `A..B` (`1...2`,
  `1..`, `1..2..3`) → `E_CURVE_RANGE_MALFORMED` (no other token contains `..`,
  so this is safe and catches typos instead of silently ignoring them).

## Implementation sketch (difficulty: LOW, ~30 lines, no IR/driver change)

- **Tokenizer: no change** — verified that `-1..1`, `-1.5..2.5`, `40..0` already
  tokenize as single atoms.
- New helper `parseRangeToken(s)`:
  `/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/` → `{from, to}` | null.
- In `parseCurveSpec` (live/src/mmlisp2ir.js), at the top of the kwarg loop
  (guarded `!isConst`): a clean range sets from/to (with a `rangeUsed` flag for
  conflict detection, checked again in the `:from`/`:to` cases); a `..`-bearing
  non-range → `E_CURVE_RANGE_MALFORMED`.
- Because step-2 eval delegates curves to `parseCurveSpec` via `ctx.parseCurve`,
  arithmetic-wrapped ranges (`(+ (sin -1..1) 10)`) and score-`:tempo`
  ranges (`(linear 120..80 :len 4)`) work for free — same code path.

## Verify

- `(sin -40..40 …)` produces the same PARAM_SWEEP as `(sin :from -40 :to 40 …)`;
  `(* (sin -1..1) 40)` LUT == `(sin -40..40)` LUT.
- Conflict/malformed cases raise their codes.
- Corpus 0-diff (no `..` in any score) + `verify:all` unchanged (no IR change).
- Docs: language.md §11 (curves) gains the `A..B` sugar line.

(A working prototype of exactly this was written and validated in-session, then
reverted to keep it a separate commit — re-deriving from the sketch above is
straightforward.)
