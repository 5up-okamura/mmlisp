// Curves and the evaluation context: a curve spec parsed, its values
// folded, the compile's seeded draw streams, a constant read at compile
// time, a tempo sweep from a curve, a macro's curve as steps.

import { sampleCurveUnit } from "../../ir/curves.js";
import { parseNumberLike, atomValue, pushDiag, parseIntLike, nodeSrc } from "./diag.js";
import { parseRangeToken, parseLengthToken, isFrameToken, resolveCurveHold, isNoteStreamToken, framesToTicks, parseStepToken, resolveMacroLen } from "./length.js";
import { lookupBound, isEvalHead, evalScalarValue, evalLengthValue, evalValue } from "../mmlisp-eval.js";

// Curve function names recognized in inline curve specs (PARAM_SWEEP authoring)
export const CURVE_NAMES = new Set([
  "linear",
  "ease-in",
  "ease-out",
  "ease-inout",
  "ease-in-sine",
  "ease-out-sine",
  "ease-inout-sine",
  "ease-in-quad",
  "ease-out-quad",
  "ease-inout-quad",
  "ease-in-cubic",
  "ease-out-cubic",
  "ease-inout-cubic",
  "ease-in-quart",
  "ease-out-quart",
  "ease-inout-quart",
  "ease-in-quint",
  "ease-out-quint",
  "ease-inout-quint",
  "ease-in-expo",
  "ease-out-expo",
  "ease-inout-expo",
  "ease-in-circ",
  "ease-out-circ",
  "ease-inout-circ",
  "ease-in-back",
  "ease-out-back",
  "ease-inout-back",
  "ease-in-elastic",
  "ease-out-elastic",
  "ease-inout-elastic",
  "ease-in-bounce",
  "ease-out-bounce",
  "ease-inout-bounce",
  "sin",
  "triangle",
  "square",
  "saw",
  "ramp",
  "noise",
  "pink",
  "perlin",
  "brown",
]);

// Loop waveforms produce PARAM_SWEEP with loop:true; easing/linear produce loop:false
export const LOOP_CURVE_NAMES = new Set([
  "sin",
  "triangle",
  "square",
  "saw",
  "ramp",
  "noise",
  "pink",
  "perlin",
  "brown",
]);

// A compile-time number in a value position (language.md §7.1): a literal, a
// `let` name, or an expression — `(+ 1 2)`, `(midi c4)`, a `noise` draw. The
// one reader for every count, id, option, ratio and level that resolves at
// compile time, so no position takes literals only. isConstNumberNode says
// whether a node is one (an optional positional asks first); readConstNumber
// returns the number, null when the node is not one (the caller says what the
// position takes), or undefined when an expression failed (the evaluator has
// said why).
export function isConstNumberNode(node, env) {
  if (!node) return false;
  if (node.kind === "atom")
    return parseNumberLike(node.value) !== null || typeof lookupBound(env, node.value) === "number";
  const head = atomValue(node.items?.[0]);
  return node.kind === "list" && node.bracket === "()" && (isEvalHead(head) || head === "noise");
}
export function readConstNumber(node, env, diagnostics, trackName, src, typedDefs = null) {
  if (!isConstNumberNode(node, env)) return null;
  if (node.kind === "atom") {
    const n = parseNumberLike(node.value);
    return n !== null ? n : lookupBound(env, node.value);
  }
  return evalScalarValue(node, env, makeEvalCtx(diagnostics, trackName, src, typedDefs)) ?? undefined;
}

// `:oct` / `:vel` resolve at compile time (§8): a number, a let-bound name or
// an expression. A `$slot` or a curve cannot be one — both are errors rather
// than the silent no-op they used to be.
// `fraction`: a value that keeps a fraction (:vel's eighths) — else a whole
// number, but for a `*` ratio.
export function compileTimeScalar(node, raw, op, evalEnv, keyword, diagnostics, trackName, src, typedDefs, fraction = false) {
  if (node?.kind === "list") {
    const head = atomValue(node.items?.[0]);
    if (isConstNumberNode(node, evalEnv)) {
      return evalScalarValue(node, evalEnv, makeEvalCtx(diagnostics, trackName, src, typedDefs));
    }
    pushDiag(diagnostics, "error", "E_VALUE_COMPILE_TIME",
      `${keyword} takes a number or an expression, not (${head ?? ""} …) — use a (macro …) for motion`,
      src, trackName);
    return null;
  }
  const bound = lookupBound(evalEnv, raw);
  if (typeof bound === "number") return bound;
  const v = op === "*" || fraction ? parseNumberLike(raw) : parseIntLike(raw);
  if (v !== null && !Number.isNaN(v)) return v;
  pushDiag(diagnostics, "error", "E_VALUE_COMPILE_TIME",
    typeof raw === "string" && raw.startsWith("$")
      ? `${keyword} resolves at compile time and cannot read ${raw}`
      : `${keyword} takes a number, not ${raw}`,
    src, trackName);
  return null;
}

export function exprHasValRef(node) {
  if (node?.kind === "atom")
    return typeof node.value === "string" && node.value.startsWith("$");
  if (node?.kind === "list") return node.items.some(exprHasValRef);
  return false;
}

// A curve that is not an inline sweep has no current value to start from —
// a macro's table is baked per note, a delay's envelope and a PCM point
// are lengths laid out at compile time — so its :from must be written (§11).
export function requireCurveFrom(spec, diagnostics, trackName, where, src = null) {
  if (spec && !spec.steps && !spec.stages && spec.from === undefined && diagnostics)
    pushDiag(diagnostics, "error", "E_CURVE_FROM",
      `a curve in ${where} needs its :from (only an inline sweep starts from the current value)`,
      src, trackName);
}

// How each curve param reads a number (curveParamToken); `:from` / `:to` are
// numbers, or lengths on a PCM point. The keys a bare `$slot` feeds (§8).
const CURVE_PARAM_KIND = {
  ":len": "length", ":hold": "length", ":wait": "length",
  ":phase": "int", ":duty": "int", ":skew": "int", ":octaves": "int", ":seed": "int",
  ":rate": "number", ":jitter": "number", ":beta": "number", ":lacunarity": "number",
  ":persistence": "number", ":leak": "number",
};
const CURVE_DYN_KEYS = new Set([":from", ":to", ":len", ":rate"]);

// A curve parameter's value (language.md §11) as the token its reader takes.
// An atom is itself — a literal, or a bare `$slot` the caller records as a
// dynamic source — unless it is a `let` name; a `let` name or an expression is
// evaluated at compile time and its number written back as the token the same
// bare number would be. `kind` is how the param reads a number: "int" and
// "length" round it (a length's number is a note denominator, §7.4, and a
// `(ticks …)` / `(frames …)` bridge becomes an `Nt` / `Nf` token); "number"
// keeps it. A `$` inside an expression is an error: the driver reads one slot
// as-is, so a curve param takes a bare `$slot` or a compile-time value.
// Returns the token (null when there is none), or undefined after a diagnostic.
export function curveParamToken(node, env, kind, key, head, dynOk, diagnostics, src, trackName) {
  if (!node) return null;
  if (node.kind === "atom" && !(env && lookupBound(env, node.value) !== undefined))
    return node.value;
  if (node.kind === "atom" || (node.kind === "list" && node.bracket === "()")) {
    const err = (code, msg) => {
      if (diagnostics) pushDiag(diagnostics, "error", code, msg, src, trackName);
    };
    const runtime = () =>
      err("E_CURVE_PARAM_RUNTIME",
        `curve param ${key} on ${head} takes ${dynOk ? "one bare slot ($v) or " : ""}a compile-time value, ` +
        `not an expression with a $ — the driver reads ${dynOk ? "one slot as-is" : "no slot here"}`);
    if (exprHasValRef(node)) return runtime();
    const ctx = {
      ...makeEvalCtx(diagnostics ?? [], trackName, src),
      resolveSlot: (raw) => raw.slice(1), // a let name bound to a `$` expression
    };
    if (kind === "length") {
      const lv = evalLengthValue(node, env, ctx);
      if (lv) return lv.unit === "error" ? undefined : `${lv.value}${lv.unit === "frame" ? "f" : "t"}`;
    }
    const r = evalValue(node, env, ctx);
    if (!r) return undefined;
    if (r.kind === "runtime") return runtime();
    if (r.kind === "signal")
      return err("E_EVAL_TYPE", `curve param ${key} on ${head} takes a number, not a curve`);
    return String(kind === "number" ? r.value : Math.round(r.value));
  }
  return null;
}

/**
 * Parse an inline curve spec node, e.g. (ease-out :from 28 :to 20 :len 8).
 * Returns a PARAM_SWEEP args object or null if the node is not a curve form.
 */
export function parseCurveSpec(
  node,
  diagnostics = null,
  src = null,
  trackName = null,
  requireCurve = false,
  // How a value in `:from` / `:to` is read. The PCM range points pass a
  // length-token reader here, so `(linear :from 16 :to 64)` sweeps a 16th
  // note down to a 64th instead of the bare numbers 16 and 64.
  scalar = null,
  // The lexical `let` env, so a param can name a binding (§7.2).
  env = null,
) {
  const readScalar = scalar ?? parseNumberLike;
  if (!node || node.kind !== "list" || !node.items || node.items.length === 0)
    return null;
  const head = atomValue(node.items[0]);
  if (!CURVE_NAMES.has(head)) {
    // A `(...)` in a value position must be a curve; an unknown head is a typo
    // (e.g. the literal word `curve`, or a misspelled easing name) — flag it
    // instead of silently falling through to a literal/zero. `[...]` step
    // vectors and non-list values are left to their own parsers.
    if (requireCurve && node.bracket === "()" && diagnostics) {
      pushDiag(
        diagnostics,
        "error",
        "E_EVAL_UNKNOWN_HEAD",
        `unknown function '${head ?? ""}' (not a curve or an expression)`,
        src ?? nodeSrc(node),
        trackName,
      );
    }
    return null;
  }

  let from;
  let to;
  let frames;
  let lenFrames = false; // :len given as Nf (frames) vs ticks (note-length / Nt)
  let waitTicks = null;
  let waitFrames = null;
  let waitKeyOff = false;
  let loopMode = null; // :mode loop / shot; null = the curve's own (§11)
  let holdLen = null; // :hold as written: { n, frames }
  const params = {};
  let hasParams = false;
  // Dynamic curve params: $name in :from/:to/:rate/:len records a runtime
  // slot source here (with a placeholder static value); the player resolves
  // it at note-on — a `:len` by the slot's def-val :unit.
  const dyn = {};
  let hasDyn = false;
  const dynSrc = (v) =>
    typeof v === "string" && v.startsWith("$") ? v.slice(1) : null;

  const COMMON_PARAM_KEYS = new Set([":phase", ":rate", ":wait"]);
  const LOOP_WAVE_PARAM_KEYS = new Set([":duty", ":skew"]);
  const STOCHASTIC_PARAM_KEYS = new Set([
    ":hold",
    ":jitter",
    ":beta",
    ":octaves",
    ":lacunarity",
    ":persistence",
    ":leak",
    ":seed",
  ]);
  const STOCHASTIC_CURVES = new Set(["noise", "pink", "perlin", "brown"]);
  const LOOP_WAVE_CURVES = new Set([
    "sin",
    "triangle",
    "square",
    "saw",
    "ramp",
  ]);

  const supportsParamKey = (curveName, key) => {
    if (COMMON_PARAM_KEYS.has(key)) return true;
    if (LOOP_WAVE_PARAM_KEYS.has(key)) return LOOP_WAVE_CURVES.has(curveName);
    if (!STOCHASTIC_PARAM_KEYS.has(key)) return false;
    if (!STOCHASTIC_CURVES.has(curveName)) return false;
    if (key === ":seed") return true; // all four stochastic curves
    if (key === ":beta") return curveName === "pink";
    if (key === ":octaves" || key === ":lacunarity" || key === ":persistence") {
      return curveName === "perlin";
    }
    if (key === ":leak") return curveName === "brown";
    return true;
  };

  const clampNum = (n, min, max) => Math.max(min, Math.min(max, n));
  const clampWithWarning = (n, min, max, key) => {
    const clamped = clampNum(n, min, max);
    if (
      diagnostics &&
      Number.isFinite(n) &&
      Number.isFinite(clamped) &&
      clamped !== n
    ) {
      pushDiag(
        diagnostics,
        "warning",
        "W_CURVE_PARAM_CLAMPED",
        `curve param ${key} out of range (${min}..${max}); clamped: ${n} -> ${clamped}`,
        src ?? nodeSrc(node),
        trackName,
      );
    }
    return clamped;
  };
  // A value that does not read is dropped, as before — but said, so a typo
  // in a curve param is not silent.
  const badParam = (key, v) => {
    if (diagnostics)
      pushDiag(diagnostics, "warning", "W_CURVE_PARAM_INVALID",
        `curve param ${key} on ${head} does not read as a number: ${v ?? "nothing"}; ignored`,
        src ?? nodeSrc(node), trackName);
  };
  const setParam = (key, value) => {
    params[key] = value;
    hasParams = true;
  };

  let rangeUsed = false; // positional `A..B` seen (conflicts with :from/:to)
  const items = node.items.filter((n) => n.kind !== "comment"); // not elements
  for (let j = 1; j < items.length; j++) {
    const k = atomValue(items[j]);
    // Positional range sugar: `(sin -1..1 :rate 6 :len 4)` sets from/to.
    const range = parseRangeToken(k);
    if (range && scalar) {
      if (diagnostics) {
        pushDiag(
          diagnostics,
          "error",
          "E_CURVE_RANGE_MALFORMED",
          `${k}: this curve's ends are lengths — write :from and :to`,
          src ?? nodeSrc(node),
          trackName,
        );
      }
      continue;
    }
    if (range) {
      if (rangeUsed || from !== undefined || to !== undefined) {
        if (diagnostics) {
          pushDiag(
            diagnostics,
            "error",
            "E_CURVE_RANGE_CONFLICT",
            `curve range ${k} conflicts with another range or :from/:to`,
            src ?? nodeSrc(node),
            trackName,
          );
        }
      } else {
        from = range.from;
        to = range.to;
        rangeUsed = true;
      }
      continue;
    }
    // A `..`-bearing token that is not a clean range is a range typo (no other
    // token contains `..`); flag it instead of silently ignoring it.
    if (typeof k === "string" && k.includes("..")) {
      if (diagnostics) {
        pushDiag(
          diagnostics,
          "error",
          "E_CURVE_RANGE_MALFORMED",
          `malformed range '${k}' (expected A..B, two numbers; a name or an expression goes in :from / :to)`,
          src ?? nodeSrc(node),
          trackName,
        );
      }
      continue;
    }
    if (k === ":mode") {
      // `:mode loop` cycles any curve (forward) — an easing curve as a
      // cycling sustain stage; `:mode shot` plays a loop wave once.
      const m = atomValue(items[j + 1]);
      if (m === "loop" || m === "shot") loopMode = m === "loop";
      else if (diagnostics)
        pushDiag(diagnostics, "error", "E_CURVE_MODE",
          `curve :mode takes loop or shot, not ${m ?? "nothing"}`,
          src ?? nodeSrc(node), trackName);
      j++;
      continue;
    }
    if (k && k.startsWith(":") && j + 1 >= items.length) {
      // Every curve param takes a value; a trailing keyword has none.
      if (diagnostics)
        pushDiag(diagnostics, "error", "E_CURVE_PARAM_UNKNOWN",
          `curve param ${k} on ${head} has no value`, src ?? nodeSrc(node), trackName);
      continue;
    }
    if (k && k.startsWith(":") && j + 1 < items.length) {
      if ((k === ":from" || k === ":to") && rangeUsed) {
        if (diagnostics) {
          pushDiag(
            diagnostics,
            "error",
            "E_CURVE_RANGE_CONFLICT",
            `${k} conflicts with the positional range on curve ${head}`,
            src ?? nodeSrc(node),
            trackName,
          );
        }
        j++;
        continue;
      }
      if (
        !supportsParamKey(head, k) &&
        k !== ":from" &&
        k !== ":to" &&
        k !== ":len"
      ) {
        if (diagnostics) {
          pushDiag(
            diagnostics,
            "error",
            "E_CURVE_PARAM_UNKNOWN",
            `unknown curve param ${k} for curve ${head}`,
            src ?? nodeSrc(node),
            trackName,
          );
        }
        j++;
        continue;
      }
      const v = curveParamToken(
        items[j + 1], env, CURVE_PARAM_KIND[k] ?? (scalar ? "length" : "number"), k, head,
        CURVE_DYN_KEYS.has(k), diagnostics, src ?? nodeSrc(node), trackName);
      if (v === undefined) {
        j++;
        continue;
      }
      switch (k) {
        case ":from": {
          const s = dynSrc(v);
          if (s) {
            from = 0;
            dyn.from = s;
            hasDyn = true;
          } else {
            from = readScalar(v);
            if (from === null) badParam(k, v);
          }
          break;
        }
        case ":to": {
          const s = dynSrc(v);
          if (s) {
            to = 0;
            dyn.to = s;
            hasDyn = true;
          } else {
            to = readScalar(v);
            if (to === null) badParam(k, v);
          }
          break;
        }
        case ":len": {
          const s = dynSrc(v);
          if (s) {
            // Dynamic length: unit comes from the slot's def-val :unit; the
            // player resolves the frame/tick interpretation at note-on.
            frames = 1;
            dyn.len = s;
            hasDyn = true;
          } else {
            frames = parseLengthToken(v, null);
            lenFrames = isFrameToken(v); // Nf / Nms is an absolute frame count, not ticks
            if (frames === null) badParam(k, v);
          }
          break;
        }
        case ":wait":
          if (v === "key-off") {
            waitKeyOff = true;
          } else if (isFrameToken(v)) {
            // Nf / Nms is a wall-clock frame count, as a stage `(wait Nf)` is.
            waitFrames = parseLengthToken(v, null);
          } else {
            const t = parseLengthToken(v, null);
            if (t !== null) waitTicks = t;
            else if (diagnostics)
              pushDiag(diagnostics, "warning", "W_WAIT_INVALID",
                `:wait takes a length or key-off, not ${v ?? "nothing"}; the curve does not wait`,
                src ?? nodeSrc(node), trackName);
          }
          break;
        case ":phase": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("phase", clampWithWarning(n, 0, 255, ":phase"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":rate": {
          const s = dynSrc(v);
          if (s) {
            setParam("rate", 1);
            dyn.rate = s;
            hasDyn = true;
            break;
          }
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "rate",
              // 0 = freeze (no phase advance); matches the player's rate >= 0.
              clampWithWarning(n, 0, Number.MAX_VALUE, ":rate"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":duty": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("duty", clampWithWarning(n, 1, 255, ":duty"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":skew": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("skew", clampWithWarning(n, -127, 127, ":skew"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":hold": {
          // A length (§4): `Nf` / `Nms` frames, else ticks. Becomes a share
          // of :len (resolveCurveHold) once both are known in one unit.
          const isFrames = isFrameToken(v);
          const n = parseLengthToken(v, null);
          if (n > 0) holdLen = { n, frames: isFrames };
          else if (diagnostics)
            pushDiag(diagnostics, "error", "E_CURVE_HOLD",
              `:hold takes a length (8, 16., 3f, 40ms): got ${v}`, src ?? nodeSrc(node), trackName);
          break;
        }
        case ":jitter": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam("jitter", clampWithWarning(n, 0, 1, ":jitter"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":beta": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "beta",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":beta"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":octaves": {
          const n = parseIntLike(v);
          if (n !== null)
            setParam("octaves", clampWithWarning(n, 1, 8, ":octaves"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":lacunarity": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "lacunarity",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":lacunarity"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":persistence": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam(
              "persistence",
              clampWithWarning(n, 0.0001, Number.MAX_VALUE, ":persistence"),
            );
          if (n === null) badParam(k, v);
          break;
        }
        case ":leak": {
          const n = parseNumberLike(v);
          if (n !== null)
            setParam("leak", clampWithWarning(n, 0, 0.9999, ":leak"));
          if (n === null) badParam(k, v);
          break;
        }
        case ":seed": {
          // u32 seed for stochastic LUT regeneration (compile-time; default
          // 0xDEAD keeps seedless sources byte-identical). Independent
          // statistical sequence, unlike :phase (a shift of the same table).
          const n = parseIntLike(v);
          if (n !== null) setParam("seed", n >>> 0);
          if (n === null) badParam(k, v);
          break;
        }
      }
      j++;
      continue;
    }
    // Every other element of a curve form reads as nothing: the ends are a
    // range or :from/:to, and every option is written as `:key value`, so a
    // bare token here is a param written without its keyword — the seed of
    // `(noise -12..12 3)` would never apply. Say so rather than drop it.
    if (diagnostics)
      pushDiag(diagnostics, "error", "E_CURVE_STRAY_VALUE",
        `curve ${head}: ${k ?? "a value"} is not a param — the ends are A..B (or :from / :to), and every option is written :key value, e.g. ${STOCHASTIC_CURVES.has(head) ? ":seed 3" : ":len 4"}`,
        src ?? nodeSrc(node), trackName);
  }

  const spec = {
    curve: head,
    to: to ?? 0,
    loop: loopMode ?? LOOP_CURVE_NAMES.has(head),
  };
  if (from !== null && from !== undefined) spec.from = from;
  if (frames !== null && frames !== undefined) spec.frames = frames;
  if (lenFrames) spec.lenFrames = true;
  if (waitTicks !== null) spec.waitTicks = waitTicks;
  if (waitFrames !== null) spec.waitFrames = waitFrames;
  if (waitKeyOff) spec.waitKeyOff = true;
  if (hasParams) spec.params = params;
  if (hasDyn) spec.dyn = dyn;
  if (holdLen) {
    // The hold is a share of :len, so it needs a literal one (§11).
    if (!(spec.frames > 0) || dyn.len) {
      if (diagnostics)
        pushDiag(diagnostics, "error", "E_CURVE_HOLD",
          dyn.len ? ":hold needs a literal :len, not a $slot" : ":hold needs a :len",
          src ?? nodeSrc(node), trackName);
    } else {
      spec.holdLen = holdLen;
      resolveCurveHold(spec, null);
    }
  }
  return spec;
}

// Build the context the compile-time evaluator needs (mmlisp-eval.js): the
// diagnostic sink, and callbacks that keep curve internals inside this module —
// `parseCurve` (a curve head → symbolic signal) and `mapMacroValues` (affine
// value-axis fold). Curve names are the set the evaluator dispatches signals on.
// Affine value-axis fold for the evaluator's symbolic signals. Unlike
// `mapMacroValues` (which keys on `spec.type`), a parseCurveSpec output is
// *type-less* (`{curve, from, to, …}`), so detect the shape by its fields. The
// curve branch mirrors mapMacroValues exactly (`from ?? 0`, `to ?? 0`) so a
// folded curve is byte-identical to the equivalent shifted literal.
function foldCurveValues(spec, fn) {
  if (Array.isArray(spec.steps)) {
    return { ...spec, steps: spec.steps.map((v) => (v == null ? v : fn(v))) };
  }
  if (Array.isArray(spec.stages)) {
    return {
      ...spec,
      stages: spec.stages.map((st) =>
        st && st.from !== undefined
          ? { ...st, from: fn(st.from), to: fn(st.to ?? 0) }
          : st?.fromNow // a release from where the level is: its end alone
            ? { ...st, to: fn(st.to ?? 0) }
            : st,
      ),
    };
  }
  return { ...spec, from: fn(spec.from ?? 0), to: fn(spec.to ?? 0) };
}

// The compile's `noise` draw streams, one per seed (mmlisp-eval drawNoise):
// a score always draws the same, from the top.
let drawStreams = new Map();
export function resetDrawStreams() {
  drawStreams = new Map();
}
export function makeEvalCtx(diagnostics, trackName, src, typedDefs = null, stepFrames = 1) {
  return {
    pushDiag,
    diagnostics,
    drawStreams,
    trackName,
    src,
    curveNames: CURVE_NAMES,
    parseCurve: (n, env) => parseCurveSpec(n, diagnostics, nodeSrc(n), trackName, false, null, env),
    foldSignal: foldCurveValues,
    isNoteStreamToken,
    // A voice or a sample (the samples ride on the voice map, set once the
    // defs are merged); snippet names are caught at expansion (expandNode).
    isDefName: (n) => !!typedDefs && (typedDefs.has(n) || !!typedDefs.sampleNames?.has(n) || !!typedDefs.waveNames?.has(n)),
    stepFrames, // frame :step for signal⊕signal materialization (0 = tick, unsupported)
  };
}

// Frame count of a macro :step for materialization; a frame step passes through,
// a tick step is not lowerable yet (0 → E_EVAL_SIGNAL_STEP), default is 1f.
export function macroStepFramesForEval(step) {
  if (step?.unit === "frame") return step.value;
  if (step?.unit === "tick") return 0;
  return 1;
}

// Build a tick-0-or-mid-track TEMPO_SWEEP event from a `(curve …)` value node,
// shared by inline `:tempo` and score-level `:tempo`. `fallbackFromBpm` is the
// sweep start when the curve omits `:from` (the current tempo). Returns
// `{ event, toBpm }` on success, or null (a diagnostic is pushed for a
// malformed curve; a non-curve node returns null silently for the caller to
// handle). `src`/`trackName` locate diagnostics.
export function buildTempoSweepFromCurve(
  valueNode,
  tick,
  fallbackFromBpm,
  diagnostics,
  src,
  trackName,
  env = null,
) {
  if (
    !(
      valueNode?.kind === "list" &&
      valueNode.bracket === "()" &&
      valueNode.items?.length > 0
    )
  ) {
    return null;
  }
  const curveSpec = parseCurveSpec(valueNode, diagnostics, src, trackName, true, null, env);
  if (!curveSpec) return null;

  const from = parseNumberLike(String(curveSpec.from ?? ""));
  const to = parseNumberLike(String(curveSpec.to ?? ""));
  const fromBpm = from ?? fallbackFromBpm;
  const toBpm = to;
  // TEMPO_SWEEP's `len` is ticks, which the player and the exporter turn into
  // frames at the sweep's average tempo — so an `Nf` / `Nms` length converts
  // to ticks at that same tempo, and keeps its frame count.
  const len =
    Number.isFinite(Number(curveSpec.frames)) && Number(curveSpec.frames) > 0
      ? curveSpec.lenFrames && fromBpm > 0 && toBpm > 0
        ? framesToTicks(Number(curveSpec.frames), (fromBpm + toBpm) / 2)
        : Number(curveSpec.frames)
      : null;
  if (
    fromBpm !== null &&
    Number.isFinite(fromBpm) &&
    fromBpm > 0 &&
    toBpm !== null &&
    Number.isFinite(toBpm) &&
    toBpm > 0 &&
    len !== null &&
    len > 0
  ) {
    return {
      event: {
        tick,
        cmd: "TEMPO_SWEEP",
        args: {
          from: fromBpm,
          to: toBpm,
          len,
          curve: curveSpec.curve,
          params: curveSpec.params,
        },
        src,
      },
      toBpm,
    };
  }
  pushDiag(
    diagnostics,
    "error",
    "E_TEMPO_INVALID",
    "invalid :tempo curve; expected (<curve> :from N :to M :len L)",
    src,
    trackName,
  );
  return null;
}

/**
 * A macro's curve as the steps it plays (the vector editor's view of it,
 * edit-tools.js vectorAt): `node` a curve form, `step` its macro's :step token
 * (1f when unwritten), `bpm` the tempo its lengths are read at. One value per
 * step, unrounded — a loop curve's one cycle — or null when the curve is not
 * one the steps stand for (no :from, a $value, a :wait, no length). `from`
 * stands in for a :from the curve leaves out.
 */
export function macroCurveSteps(node, { step = null, bpm = 120, from = null } = {}) {
  // Read alone, a param that names a def or a let (`:to top`) has no value:
  // any word the curve could not read means its steps are not these.
  const said = [];
  const spec = parseCurveSpec(node, said);
  // A release stage may leave :from out: it starts where the macro is
  // (`from`, the stage before it's last value).
  if (spec && spec.from == null && from != null) spec.from = from;
  if (!spec || said.length || spec.from == null || spec.dyn || spec.waitTicks != null || spec.waitFrames != null || spec.waitKeyOff)
    return null;
  const clock = (step != null ? parseStepToken(step) : null) ?? { unit: "frame", value: 1 };
  const lens = resolveMacroLen({ type: "curve", ...spec, step: clock }, bpm);
  const base = lens.frames;
  if (!(base > 0) || !(clock.value > 0)) return null;
  const at = (phase) => spec.from + (spec.to - spec.from) * sampleCurveUnit(spec.curve, phase, spec.params);
  if (![spec.from, spec.to].every(Number.isFinite)) return null;
  if (spec.loop) {
    const period = Math.max(1, Math.round(base / clock.value));
    return { values: Array.from({ length: period }, (_, i) => at((i * clock.value) / base)), loop: true };
  }
  const n = Math.max(1, Math.ceil(base / clock.value));
  return { values: Array.from({ length: n }, (_, i) => at(base <= 1 ? 1 : Math.min(1, (i * clock.value) / (base - 1)))), loop: false };
}
