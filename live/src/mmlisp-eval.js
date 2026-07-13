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

// ── Builtin registry ───────────────────────────────────────────────────────
// One entry per evaluable head. `arity` is [min, max] (max null = variadic).
// `fn` receives already-evaluated scalar operands. This Map is the single
// source of truth for both dispatch and the reserved-name check in collectDefs.
const BUILTINS = new Map();

function defBuiltin(name, arity, fn) {
  BUILTINS.set(name, { arity, fn });
}

const need = (name, args, want) => {
  if (args.length !== want) {
    throw new EvalError(
      "E_EVAL_ARITY",
      `(${name} …) takes ${want} argument${want === 1 ? "" : "s"}, got ${args.length}`,
    );
  }
};

defBuiltin("+", [0, null], (a) => a.reduce((x, y) => x + y, 0));
defBuiltin("*", [0, null], (a) => a.reduce((x, y) => x * y, 1));
defBuiltin("-", [1, null], (a) =>
  a.length === 1 ? -a[0] : a.reduce((x, y) => x - y),
);
defBuiltin("/", [1, null], (a) => {
  const divide = (x, y) => {
    if (y === 0) throw new EvalError("E_EVAL_DIV_ZERO", "division by zero");
    return x / y;
  };
  return a.length === 1 ? divide(1, a[0]) : a.reduce(divide);
});
defBuiltin("min", [1, null], (a) => Math.min(...a));
defBuiltin("max", [1, null], (a) => Math.max(...a));
defBuiltin("abs", [1, 1], (a, name) => (need(name, a, 1), Math.abs(a[0])));
defBuiltin("round", [1, 1], (a, name) => (need(name, a, 1), Math.round(a[0])));
defBuiltin("floor", [1, 1], (a, name) => (need(name, a, 1), Math.floor(a[0])));

/** True when `name` is a reserved eval builtin head (used for dispatch and the
 *  `E_DEF_RESERVED` check). */
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
// Returns a scalar (JS double). Floats are legal throughout; integerization
// happens only at the binding site (design §2.1). Throws EvalError on failure.
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
    // step 1 has no runtime path, so fail explicitly rather than mis-fold.
    if (v.startsWith("$")) {
      throw new EvalError(
        "E_EVAL_NOT_LOWERABLE",
        `runtime value ${v} cannot be used in a compile-time expression yet`,
      );
    }
    // Bound name (let, step 4) — env is empty in step 1.
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
    return builtin.fn(args, head);
  }

  throw new EvalError("E_EVAL_OPERAND", "unrecognized node");
}

/**
 * Value-position entry point. `node` is a `()` form already known to be an eval
 * builtin (the caller checks `isEvalHead`). Returns the scalar result, or null
 * after pushing one diagnostic on failure.
 *
 * @param {object} node   the `()` form
 * @param {object} env    lexical environment (makeEnv chain)
 * @param {{ pushDiag, diagnostics, trackName, src }} ctx  diagnostic sink + location
 */
export function evalScalarValue(node, env, ctx) {
  try {
    return evalNode(node, env ?? makeEnv(null), { ...ctx, depth: 0 });
  } catch (e) {
    if (e instanceof EvalError) {
      ctx.pushDiag(ctx.diagnostics, "error", e.code, e.message, ctx.src, ctx.trackName);
      return null;
    }
    throw e;
  }
}
