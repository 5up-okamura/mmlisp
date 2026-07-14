// ---------------------------------------------------------------------------
// Compile-time evaluator (v0.6 Phase 3, step 1 — scalar core)
//
// The channel body is an implicit quasiquote: bare atoms are literal note/
// directive data, and a `()` form whose head is an eval builtin is *computed*
// at compile time. This module is that computation. It is invoked in-walk from
// compileChannelBody (mmlisp2ir.js) at value positions, so it sees track state
// and the lexical `let` environment.
//
// Step 1 covers scalar arithmetic only: `+ - * /`, `min max abs round floor`.
// Later steps add curve builtins (signals), `let`/`note`/`ticks`/`frames`, and
// the runtime value machine ($slot lowering). The seams designed here — the
// env chain and the builtin registry — are what those steps extend; see
// .claude/memory/design-eval.md §1-2, §7.
// ---------------------------------------------------------------------------

import { sampleCurveUnit } from "./ir-utils.js";

const MAX_DEPTH = 32; // eval nesting guard, independent of def-expansion depth

// A thrown evaluation failure. Caught at the value-position boundary
// (evalScalarValue) and turned into one diagnostic; keeps evalNode recursion
// free of result-plumbing.
class EvalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Lexical environment: a scope chain of name → value bindings. `let` (step 4)
// pushes child scopes; step 1 only ever holds the empty root, but the wiring is
// in place so binding lookup Just Works when `let` lands.
export function makeEnv(parent = null) {
  return { bindings: new Map(), parent };
}

function envLookup(env, name) {
  for (let e = env; e; e = e.parent) {
    if (e.bindings.has(name)) return e.bindings.get(name);
  }
  return undefined;
}

// ── Value model ──────────────────────────────────────────────────────────
// An eval value is a scalar (JS double) or a signal (a curve/stages/steps spec
// object — the very object parseCurveSpec produces, kept symbolic so LUTs stay
// byte-identical; design §2.2). Signals are opaque here except through the
// ctx.mapMacroValues callback (owned by mmlisp2ir.js).
const isSignal = (v) => v !== null && typeof v === "object";

// ── Affine arithmetic (scalar ⊕ signal stays symbolic; design §2.3) ──────────
// A running accumulator is either a scalar (spec === null → value = k) or an
// affine transform of one signal (value = coeff·sample + offset). Only the four
// affine operators reach here; `min`/`max`/etc. reject signals.
function affineStart(v) {
  return isSignal(v) ? { spec: v, coeff: 1, offset: 0 } : { spec: null, offset: v, coeff: 0 };
}

// ── Signal ⊕ signal materialization (design §2.3) ────────────────────────────
// Two signals combined by `+ - * /` cannot stay symbolic, so they are sampled
// pointwise (mirroring the export-mmb.js curve sampling) into a float `steps`
// spec. MVP scope: curve⊕curve, frame-based `:len` (Nf), a common frame `:step`;
// each harder case is a specific error. Round/clamp is deferred to the binding
// site (values stay float here).
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function lcm(a, b) { return (a / gcd(a, b)) * b; }

function combineOp(op, va, vb) {
  if (op === "+") return va + vb;
  if (op === "-") return va - vb;
  if (op === "*") return va * vb;
  if (vb === 0) throw new EvalError("E_EVAL_DIV_ZERO", "division by zero in signal arithmetic");
  return va / vb;
}

// Sample one signal into { values: float[], loop, period }. Curve-only in MVP.
function sampleSignal(spec, stepFrames) {
  if (spec.steps) {
    throw new EvalError(
      "E_EVAL_SIGNAL_SHAPE",
      "step-vector operands in signal arithmetic are not supported yet",
    );
  }
  if (!spec.lenFrames) {
    throw new EvalError(
      "E_EVAL_NOT_LOWERABLE",
      "signal arithmetic needs a frame-based :len (e.g. :len 8f)",
    );
  }
  if (spec.waitFrames || spec.waitKeyOff) {
    throw new EvalError(
      "E_EVAL_SIGNAL_HOLD",
      ":wait prefixes are not supported in signal arithmetic",
    );
  }
  const from = Number(spec.from ?? 0);
  const to = Number(spec.to ?? 0);
  const baseFrames = Math.max(1, Math.round(Number(spec.frames ?? 1)));
  const at = (phase) => from + (to - from) * sampleCurveUnit(spec.curve, phase, spec.params);
  if (spec.loop) {
    const period = Math.max(1, Math.round(baseFrames / stepFrames));
    const values = Array.from({ length: period }, (_, i) => at((i * stepFrames) / baseFrames));
    return { values, loop: true, period };
  }
  const n = Math.max(1, Math.ceil(baseFrames / stepFrames));
  const values = Array.from({ length: n }, (_, i) =>
    at(baseFrames <= 1 ? 1 : Math.min(1, (i * stepFrames) / (baseFrames - 1))),
  );
  return { values, loop: false };
}

function materializeSignals(op, aSpec, bSpec, ctx) {
  const stepFrames = ctx.stepFrames;
  if (!(stepFrames > 0)) {
    throw new EvalError(
      "E_EVAL_SIGNAL_STEP",
      "signal arithmetic needs a frame :step (a tick :step is not lowered yet)",
    );
  }
  const a = sampleSignal(aSpec, stepFrames);
  const b = sampleSignal(bSpec, stepFrames);
  if (a.loop !== b.loop) {
    throw new EvalError(
      "E_EVAL_SIGNAL_SHAPE",
      "cannot combine a looping and a one-shot signal (MVP)",
    );
  }
  let steps;
  let loopIndex = null;
  if (a.loop) {
    const period = lcm(a.period, b.period);
    if (period > 255) {
      throw new EvalError("E_EVAL_SIGNAL_LEN", `combined loop period ${period} exceeds 255 steps`);
    }
    steps = Array.from({ length: period }, (_, i) =>
      combineOp(op, a.values[i % a.period], b.values[i % b.period]),
    );
    loopIndex = 0;
  } else {
    const len = Math.max(a.values.length, b.values.length);
    const last = (v) => v[v.length - 1];
    steps = Array.from({ length: len }, (_, i) =>
      combineOp(
        op,
        i < a.values.length ? a.values[i] : last(a.values),
        i < b.values.length ? b.values[i] : last(b.values),
      ),
    );
  }
  return { steps, loopIndex, releaseIndex: null };
}

function affineCombine(op, acc, x, ctx) {
  const accScalar = acc.spec === null;
  const xSignal = isSignal(x);
  if (accScalar && !xSignal) {
    // scalar ⊕ scalar
    let k;
    if (op === "+") k = acc.offset + x;
    else if (op === "-") k = acc.offset - x;
    else if (op === "*") k = acc.offset * x;
    else {
      if (x === 0) throw new EvalError("E_EVAL_DIV_ZERO", "division by zero");
      k = acc.offset / x;
    }
    return { spec: null, offset: k, coeff: 0 };
  }
  if (!accScalar && !xSignal) {
    // signal ⊕ scalar — affine
    if (op === "+") return { ...acc, offset: acc.offset + x };
    if (op === "-") return { ...acc, offset: acc.offset - x };
    if (op === "*") return { spec: acc.spec, coeff: acc.coeff * x, offset: acc.offset * x };
    if (x === 0) throw new EvalError("E_EVAL_DIV_ZERO", "division by zero");
    return { spec: acc.spec, coeff: acc.coeff / x, offset: acc.offset / x };
  }
  if (accScalar && xSignal) {
    // scalar ⊕ signal
    if (op === "+") return { spec: x, coeff: 1, offset: acc.offset };
    if (op === "-") return { spec: x, coeff: -1, offset: acc.offset }; // k − sample
    if (op === "*") return { spec: x, coeff: acc.offset, offset: 0 };
    throw new EvalError(
      "E_EVAL_SIGNAL_NONAFFINE",
      "cannot divide by a signal (result is non-affine)",
    );
  }
  // signal ⊕ signal — finalize acc's affine into a concrete curve, then
  // materialize the two signals pointwise into a float `steps` signal (§2.3).
  const aSpec =
    acc.coeff === 1 && acc.offset === 0
      ? acc.spec
      : ctx.foldSignal(acc.spec, (v) => acc.coeff * v + acc.offset);
  const materialized = materializeSignals(op, aSpec, x, ctx);
  return { spec: materialized, coeff: 1, offset: 0 };
}

function affineFinish(acc, ctx) {
  if (acc.spec === null) return acc.offset; // pure scalar
  if (acc.coeff === 1 && acc.offset === 0) return acc.spec; // untouched — byte-identical
  // Fold the affine transform into the signal's value axis. ctx.foldSignal
  // leaves the time axis (rate/len/step) alone and does not clamp — clamping
  // happens once at the binding site (design §2.2-2.3).
  return ctx.foldSignal(acc.spec, (v) => acc.coeff * v + acc.offset);
}

// ── Builtin registry ───────────────────────────────────────────────────────
// One entry per evaluable head. `arity` is [min, max] (max null = variadic).
// `apply(args, ctx)` receives already-evaluated operands (scalar or signal) and
// returns a value. This Map is the single source of truth for both dispatch and
// the reserved-name check in collectDefs.
const BUILTINS = new Map();

const scalarsOnly = (name, args) => {
  for (const a of args) {
    if (isSignal(a)) {
      throw new EvalError(
        "E_EVAL_SIGNAL_NONAFFINE",
        `(${name} …) is not defined on a signal`,
      );
    }
  }
  return args;
};

// Affine operators: fold a left-to-right chain, tracking one signal affinely
// (or materializing when two signals meet — affineCombine handles both).
const affineOp = (op, seed) => (args, ctx) => {
  let acc = seed !== undefined ? affineStart(seed) : affineStart(args[0]);
  const rest = seed !== undefined ? args : args.slice(1);
  for (const x of rest) acc = affineCombine(op, acc, x, ctx);
  return affineFinish(acc, ctx);
};

BUILTINS.set("+", { arity: [0, null], apply: affineOp("+", 0) });
BUILTINS.set("*", { arity: [0, null], apply: affineOp("*", 1) });
BUILTINS.set("-", {
  arity: [1, null],
  apply: (args, ctx) =>
    args.length === 1
      ? affineFinish(affineCombine("-", affineStart(0), args[0], ctx), ctx) // negate
      : affineOp("-")(args, ctx),
});
BUILTINS.set("/", {
  arity: [1, null],
  apply: (args, ctx) =>
    args.length === 1
      ? affineFinish(affineCombine("/", affineStart(1), args[0], ctx), ctx) // reciprocal
      : affineOp("/")(args, ctx),
});
BUILTINS.set("min", { arity: [1, null], apply: (a, _c, n) => Math.min(...scalarsOnly(n, a)) });
BUILTINS.set("max", { arity: [1, null], apply: (a, _c, n) => Math.max(...scalarsOnly(n, a)) });
BUILTINS.set("abs", { arity: [1, 1], apply: (a, _c, n) => Math.abs(scalarsOnly(n, a)[0]) });
BUILTINS.set("round", { arity: [1, 1], apply: (a, _c, n) => Math.round(scalarsOnly(n, a)[0]) });
BUILTINS.set("floor", { arity: [1, 1], apply: (a, _c, n) => Math.floor(scalarsOnly(n, a)[0]) });

// Value-producing heads that dispatch to the evaluator in value positions:
// the arithmetic/math builtins plus the `let` special form (§7).
const VALUE_HEADS = new Set([...BUILTINS.keys(), "let"]);

// Heads that also read as eval forms elsewhere (item/length positions) —
// reserved so a def cannot shadow them. `note` is item-only (§2.5);
// `ticks`/`frames` are length-only bridges (§2.4); they are handled in
// mmlisp2ir.js, but naming a def after them is still `E_DEF_RESERVED`.
const RESERVED_HEADS = new Set([...VALUE_HEADS, "note", "ticks", "frames"]);

/** True when `name` dispatches to the evaluator in a value position (arithmetic
 *  builtins + `let`). Curve names are handled separately (via ctx). */
export function isEvalHead(name) {
  return typeof name === "string" && VALUE_HEADS.has(name);
}

/** True when `name` is any reserved eval head (for the `E_DEF_RESERVED` check). */
export function isReservedHead(name) {
  return typeof name === "string" && RESERVED_HEADS.has(name);
}

/** The reserved eval-head names, for diagnostics that want to list them. */
export const EVAL_BUILTIN_NAMES = Object.freeze([...RESERVED_HEADS]);

const atomVal = (n) =>
  n && (n.kind === "atom" || n.kind === "string") ? n.value : null;

// Bind a `let` form's `((name expr) …)` list sequentially (let*) into a fresh
// child env. Names must be symbols that are not note-stream tokens
// (ctx.isNoteStreamToken → E_LET_NAME) and not def/paramDef names
// (ctx.isDefName → E_LET_SHADOWS_DEF). Values evaluate in the growing env and
// may be scalars or signals. Throws EvalError on any problem.
function bindLet(items, env, ctx) {
  const bindingList = items[1];
  if (!bindingList || bindingList.kind !== "list") {
    throw new EvalError("E_LET_BINDING", "let needs a ((name expr) …) list");
  }
  const child = makeEnv(env);
  for (const b of bindingList.items.filter((n) => n.kind !== "comment")) {
    const pair = b?.kind === "list" ? b.items.filter((n) => n.kind !== "comment") : null;
    if (!pair || pair.length !== 2) {
      throw new EvalError("E_LET_BINDING", "each let binding is (name expr)");
    }
    const name = atomVal(pair[0]);
    if (!name || pair[0].kind !== "atom") {
      throw new EvalError("E_LET_NAME", "let binding name must be a symbol");
    }
    if (ctx.isNoteStreamToken && ctx.isNoteStreamToken(name)) {
      throw new EvalError(
        "E_LET_NAME",
        `let name '${name}' collides with a note/length token`,
      );
    }
    if (ctx.isDefName && ctx.isDefName(name)) {
      throw new EvalError(
        "E_LET_SHADOWS_DEF",
        `let name '${name}' shadows a def`,
      );
    }
    const value = evalNode(pair[1], child, { ...ctx, depth: ctx.depth + 1 });
    child.bindings.set(name, value);
  }
  return child;
}

/**
 * Item-position `let`: bind the form's declarations and return the extended env
 * for the body walk, or null after pushing a diagnostic. (The body is compiled
 * in place by the caller — mmlisp2ir.js.)
 */
export function evalLet(node, env, ctx) {
  const items = (node.items || []).filter((n) => n.kind !== "comment");
  try {
    return bindLet(items, env ?? makeEnv(null), { ...ctx, depth: 0 });
  } catch (e) {
    if (e instanceof EvalError) {
      ctx.pushDiag(ctx.diagnostics, "error", e.code, e.message, ctx.src, ctx.trackName);
      return null;
    }
    throw e;
  }
}

// A length-grammar smell test: reject note/length/rest atoms as arithmetic
// operands (no implicit note→number coercion — design §1.1, §2.4). The
// authoritative note-stream predicates live in mmlisp2ir.js and reach the
// evaluator via ctx.isNoteStreamToken for `let` name validation.
function looksLikeMusicToken(s) {
  return /^[_<>]|^[a-g][+-]?(\d|\/|\.|t$|f$)|^[ov][+-]/.test(s);
}

// ── The evaluator ────────────────────────────────────────────────────────
// Returns a scalar (JS double) or a signal (spec object). Floats are legal
// throughout; integerization happens only at the binding site (design §2.1).
// Curve heads (design §3) are resolved through ctx.parseCurve — the evaluator
// stays free of curve internals. Throws EvalError on failure.
function evalNode(node, env, ctx) {
  if (ctx.depth > MAX_DEPTH) {
    throw new EvalError("E_EVAL_DEPTH", "eval nesting too deep");
  }

  if (!node) throw new EvalError("E_EVAL_OPERAND", "missing operand");

  if (node.kind === "atom" || node.kind === "string") {
    const v = node.value;
    if (node.kind === "string") {
      throw new EvalError("E_EVAL_OPERAND", `string is not a number: "${v}"`);
    }
    // Numeric literal.
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) return Number(v);
    // Runtime value reference — the value machine (a later step) lowers these;
    // there is no runtime path yet, so fail explicitly rather than mis-fold.
    if (v.startsWith("$")) {
      throw new EvalError(
        "E_EVAL_NOT_LOWERABLE",
        `runtime value ${v} cannot be used in a compile-time expression yet`,
      );
    }
    // Bound name (let, step 4) — env is empty until then.
    const bound = envLookup(env, v);
    if (bound !== undefined) return bound;
    if (looksLikeMusicToken(v)) {
      throw new EvalError(
        "E_EVAL_OPERAND",
        `note/length token '${v}' is not a number`,
      );
    }
    throw new EvalError("E_EVAL_OPERAND", `unbound name '${v}'`);
  }

  if (node.kind === "list") {
    const items = node.items.filter((n) => n.kind !== "comment");
    const head = items[0] && items[0].kind === "atom" ? items[0].value : null;

    // `let` in a value/expression position: bind, then evaluate a single body
    // expression in the extended env (§7).
    if (head === "let") {
      const child = bindLet(items, env, ctx);
      const body = items.slice(2);
      if (body.length !== 1) {
        throw new EvalError(
          "E_EVAL_ARITY",
          "let in a value position takes exactly one body expression",
        );
      }
      return evalNode(body[0], child, { ...ctx, depth: ctx.depth + 1 });
    }

    // Curve head → a symbolic signal (delegated to parseCurveSpec via ctx).
    if (head && ctx.curveNames && ctx.curveNames.has(head)) {
      const spec = ctx.parseCurve(node);
      if (!spec) {
        throw new EvalError("E_EVAL_UNKNOWN_HEAD", `bad curve '${head}'`);
      }
      return spec;
    }

    const builtin = head && BUILTINS.get(head);
    if (!builtin) {
      throw new EvalError(
        "E_EVAL_UNKNOWN_HEAD",
        `unknown expression head '${head ?? ""}'`,
      );
    }
    const operands = items.slice(1);
    const [amin, amax] = builtin.arity;
    if (operands.length < amin || (amax !== null && operands.length > amax)) {
      throw new EvalError(
        "E_EVAL_ARITY",
        `(${head} …) arity: expected ${amax === null ? `≥ ${amin}` : amin === amax ? amin : `${amin}..${amax}`}, got ${operands.length}`,
      );
    }
    const args = operands.map((n) =>
      evalNode(n, env, { ...ctx, depth: ctx.depth + 1 }),
    );
    return builtin.apply(args, ctx, head);
  }

  throw new EvalError("E_EVAL_OPERAND", "unrecognized node");
}

/**
 * Value-position entry point. `node` is a `()` form already known to be an eval
 * builtin (the caller checks `isEvalHead`). Returns a discriminated result —
 * `{kind:"scalar", value}` or `{kind:"signal", spec}` — or null after pushing
 * one diagnostic on failure.
 *
 * @param {object} node   the `()` form
 * @param {object} env    lexical environment (makeEnv chain)
 * @param {{ pushDiag, diagnostics, trackName, src, parseCurve, curveNames,
 *           foldSignal }} ctx
 */
export function evalValue(node, env, ctx) {
  try {
    const r = evalNode(node, env ?? makeEnv(null), { ...ctx, depth: 0 });
    return isSignal(r) ? { kind: "signal", spec: r } : { kind: "scalar", value: r };
  } catch (e) {
    if (e instanceof EvalError) {
      ctx.pushDiag(ctx.diagnostics, "error", e.code, e.message, ctx.src, ctx.trackName);
      return null;
    }
    throw e;
  }
}

/**
 * Scalar-only value position (e.g. `param-set`, length bridges). Returns the
 * number, or null after a diagnostic — a signal result is `E_EVAL_TYPE`.
 */
export function evalScalarValue(node, env, ctx) {
  const r = evalValue(node, env, ctx);
  if (r === null) return null;
  if (r.kind === "signal") {
    ctx.pushDiag(
      ctx.diagnostics,
      "error",
      "E_EVAL_TYPE",
      "expected a number here, got a signal (curve)",
      ctx.src,
      ctx.trackName,
    );
    return null;
  }
  return r.value;
}

/** Look up a `let`-bound name in a value position (bare atom). Returns the
 *  bound value (scalar or signal) or undefined. */
export function lookupBound(env, name) {
  return env ? envLookup(env, name) : undefined;
}

/**
 * Length-position bridge (§2.4): resolve `(ticks expr)` / `(frames expr)` to a
 * unit-tagged non-negative integer. Returns `{unit:"tick"|"frame", value}` for
 * those heads, or null for any other node (the caller then uses the normal
 * length-token parser). Diagnostics: a non-scalar or unknown head errors.
 */
export function evalLengthValue(node, env, ctx) {
  if (!node || node.kind !== "list" || node.bracket !== "()") return null;
  const items = node.items.filter((n) => n.kind !== "comment");
  const head = atomVal(items[0]);
  if (head !== "ticks" && head !== "frames") return null;
  try {
    if (items.length !== 2) {
      throw new EvalError("E_EVAL_ARITY", `(${head} expr) takes one argument`);
    }
    const v = evalNode(items[1], env ?? makeEnv(null), { ...ctx, depth: 0 });
    if (isSignal(v)) {
      throw new EvalError("E_EVAL_TYPE", `(${head} …) needs a number, got a signal`);
    }
    return { unit: head === "frames" ? "frame" : "tick", value: Math.max(0, Math.round(v)) };
  } catch (e) {
    if (e instanceof EvalError) {
      ctx.pushDiag(ctx.diagnostics, "error", e.code, e.message, ctx.src, ctx.trackName);
      return { unit: "error", value: 0 };
    }
    throw e;
  }
}
