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

function affineCombine(op, acc, x) {
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
  // signal ⊕ signal — pointwise materialization is a later step (design §2.3).
  throw new EvalError(
    "E_EVAL_NOT_LOWERABLE",
    "combining two signals requires materialization (a later step)",
  );
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

// Affine operators: fold a left-to-right chain, tracking one signal affinely.
const affineOp = (op, seed) => (args, ctx) => {
  let acc = seed !== undefined ? affineStart(seed) : affineStart(args[0]);
  const rest = seed !== undefined ? args : args.slice(1);
  for (const x of rest) acc = affineCombine(op, acc, x);
  return affineFinish(acc, ctx);
};

BUILTINS.set("+", { arity: [0, null], apply: affineOp("+", 0) });
BUILTINS.set("*", { arity: [0, null], apply: affineOp("*", 1) });
BUILTINS.set("-", {
  arity: [1, null],
  apply: (args, ctx) =>
    args.length === 1
      ? affineFinish(affineCombine("-", affineStart(0), args[0]), ctx) // negate
      : affineOp("-")(args, ctx),
});
BUILTINS.set("/", {
  arity: [1, null],
  apply: (args, ctx) =>
    args.length === 1
      ? affineFinish(affineCombine("/", affineStart(1), args[0]), ctx) // reciprocal
      : affineOp("/")(args, ctx),
});
BUILTINS.set("min", { arity: [1, null], apply: (a, _c, n) => Math.min(...scalarsOnly(n, a)) });
BUILTINS.set("max", { arity: [1, null], apply: (a, _c, n) => Math.max(...scalarsOnly(n, a)) });
BUILTINS.set("abs", { arity: [1, 1], apply: (a, _c, n) => Math.abs(scalarsOnly(n, a)[0]) });
BUILTINS.set("round", { arity: [1, 1], apply: (a, _c, n) => Math.round(scalarsOnly(n, a)[0]) });
BUILTINS.set("floor", { arity: [1, 1], apply: (a, _c, n) => Math.floor(scalarsOnly(n, a)[0]) });

/** True when `name` is a reserved eval builtin head (used for dispatch and the
 *  `E_DEF_RESERVED` check). Curve names are handled separately (via ctx), so
 *  they are not in this set. */
export function isEvalHead(name) {
  return typeof name === "string" && BUILTINS.has(name);
}

/** The reserved eval-builtin names, for diagnostics that want to list them. */
export const EVAL_BUILTIN_NAMES = Object.freeze([...BUILTINS.keys()]);

// A length-grammar smell test: reject note/length/rest atoms as arithmetic
// operands (no implicit note→number coercion — design §1.1, §2.4). Kept
// deliberately loose in step 1; the note-stream predicates in mmlisp2ir.js are
// the authority and will be shared in the `let`/`note` step.
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
