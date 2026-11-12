// A word written: its value read in its context (a `$slot`, a runtime
// expression), a set, a :snap, a :vel sensitivity, an LFO table, a PCM
// point.

import { parseCurveSpec, requireCurveFrom, makeEvalCtx } from "./curves.js";
import { pushDiag, atomValue, parseNumberLike, nodeSrc } from "./diag.js";
import { targetDiag, canonicalTarget, TARGET_SYMBOLS, SET_ONLY_TARGETS, FRACTIONAL_TARGETS, opSuffix, velSensSixteenths } from "./keywords.js";
import { lengthTokenSeconds } from "./length.js";
import { lookupBound, evalValue, evalScalarValue } from "../mmlisp-eval.js";

// A PCM point (`:pcm-start` …, inline or in a (param-set …)) is a length
// everywhere: the literal, and both ends of a curve. The IR carries SECONDS;
// the exporter turns them into the engine's byte offsets at the image's rate
// (driver.md §5). Events go out through `push(cmd, args)`.
export function writePcmPoint(target, keyword, op, valueNode, trackState, push, diagnostics, src, trackName, env = null) {
  // A sample part's word, so it reaches here on a sample track (trackLacks).
  const t = trackState.target;
  if (trackState.part.points === false) {
    const takers = t.channelNames.filter((h) => t.partOf(h).kind === "sample" && t.partOf(h).points !== false);
    targetDiag(diagnostics, "error",
      `${keyword}: on ${t.name} ${trackState.head} plays the ${trackState.part.label} sounds, which have no range or loop${takers.length ? `; ${takers.join(" or ")} takes it` : ""}`,
      src, trackName);
    return;
  }
  if (op) {
    pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET",
      `${keyword} takes a length, so '${op}' has no meaning on it`, src, trackName);
    return;
  }
  // A part whose loop is its range (the 2A03's DMC, `loopIsRange`).
  if (trackState.part.loopIsRange && target.startsWith("LOOP_")) {
    targetDiag(diagnostics, "warning",
      `${keyword}: the ${trackState.part.label} loops a note's whole range, so it is left out — set :pcm-start / :pcm-end`,
      src, trackName);
    return;
  }
  const secOf = (tok) => lengthTokenSeconds(tok, trackState.currentTempo);
  const rangeCurve = parseCurveSpec(valueNode, diagnostics, src, trackName, true, secOf, env);
  requireCurveFrom(rangeCurve, diagnostics, trackName, "a PCM point", src);
  if (rangeCurve) {
    // A part that reads its range at key-on (the ADPCM-B's addresses) has no
    // moving point: the sweep's start is the point.
    if (trackState.part.pointSweeps === false) {
      targetDiag(diagnostics, "warning",
        `${keyword}: the ${trackState.part.label} reads its range at each note's key-on, so a curve is read as its start`,
        src, trackName);
      push("PARAM_SET", { target, value: rangeCurve.from });
      return;
    }
    push("PARAM_SWEEP", { target, ...rangeCurve });
    return;
  }
  const rawVal = atomValue(valueNode);
  const sec = secOf(rawVal);
  if (sec === null) {
    pushDiag(diagnostics, "error", "E_PCM_RANGE_LENGTH",
      `${keyword} needs a length (300ms, 16, 8., 6t, 3f): got ${rawVal}`, src, trackName);
    return;
  }
  push("PARAM_SET", { target, value: sec });
}

// Resolve a `$name` value/operand to a source id: "$time" (built-in) or a
// declared slot name. Diagnoses unknown names. Returns null if `raw` is not a
// `$` reference.
function resolveValRef(raw, vals, diagnostics, trackName, src) {
  if (typeof raw !== "string" || !raw.startsWith("$")) return null;
  const name = raw.slice(1);
  if (name === "time") return "$time";
  if (vals?.has(name)) return name;
  pushDiag(
    diagnostics,
    "error",
    "E_VAL_UNDEFINED",
    `undefined value: ${raw} (declare with (def-val ${name} …))`,
    src,
    trackName,
  );
  return name; // keep the IR well-formed; player treats a missing slot as 0
}

// The eval ctx of a value position that lowers a `$` reference: the evaluator
// keeps it symbolic as a param-opcode chain (mmlisp-eval.js Runtime), `$<param>`
// naming `target` reads the parameter itself, and a `$name` resolves (and is
// diagnosed) against the declared slots.
export function valueCtx(target, vals, diagnostics, trackName, src, typedDefs = null) {
  return {
    ...makeEvalCtx(diagnostics, trackName, src, typedDefs),
    i16: target === "NOTE_PITCH" || target === "SNAP",
    isSelf: (name) => target != null && (canonicalTarget(":" + name) === target ||
      (vals?.has(name) && `VAL${vals.get(name).slot}` === target)),
    resolveSlot: (raw) => resolveValRef(raw, vals, diagnostics, trackName, src),
  };
}

// Emit a runtime value's opcode chain on `target` (language.md §7.1.2): the
// seed, then each term, the parameter itself the accumulator.
function emitRuntime(steps, target, push, diagnostics, trackName, src) {
  const writes = steps.filter((s) => s.op !== "self").length;
  if (writes > 6)
    pushDiag(diagnostics, "warning", "W_EVAL_CHAIN_LONG",
      `expression lowers to ${writes} register writes (language.md §7.1.2)`, src, trackName);
  for (const s of steps) {
    if (s.op === "self") continue;
    if (s.op === "set") push("PARAM_SET", { target, value: Math.round(s.val) });
    else if (s.op === "fromval") push("PARAM_FROM_VAL", { target, src: s.ref });
    else if (s.op === "add") push("PARAM_ADD", { target, delta: Math.round(s.val) });
    else if (s.op === "addval") push("PARAM_ADD", { target, delta: { src: s.ref } });
    else if (s.op === "mul") push("PARAM_MUL", { target, factor: s.val });
    else if (s.op === "mulval") push("PARAM_MUL", { target, factor: { src: s.ref } });
  }
}

// Read a value-position node. Every parameter write reads its value here, so
// a literal, a let name, an expression, a curve and a `$` reference mean the
// same thing wherever a value goes. Returns
//   { kind: "none" }            — the word `none`
//   { kind: "scalar", value }   — a number (literal, let name, expression)
//   { kind: "signal", spec }    — a curve, or arithmetic on one
//   { kind: "runtime", steps }  — carries a `$` reference: the opcode chain
//                                 that computes it at run time (+ `node`)
//   { kind: "symbol", value }   — any other bare word, for the position to name
// or null after a diagnostic. `ctx` is a valueCtx where a `$` can lower.
export function readValue(node, env, ctx) {
  if (node?.kind === "atom") {
    const v = node.value;
    if (v === "none") return { kind: "none" };
    if (
      !(typeof v === "string" && v.startsWith("$")) &&
      parseNumberLike(v) === null && lookupBound(env, v) === undefined
    )
      return { kind: "symbol", value: v };
  }
  const r = evalValue(node, env, ctx);
  if (r?.kind === "runtime") r.node = node;
  return r;
}

const atomNode = (value) => ({ kind: "atom", value: String(value) });

// The FDS's `:lfo-wave` (chips/fds.js): its modulation table, 32 of the
// chip's steps — 0, ±1, ±2, ±4, or `reset` (the counter back to 0) — as a
// PARAM_SET carrying them (`table`). Elsewhere `:lfo-wave` is the OPM's
// waveform, and a table there is an error.
const LFO_TABLE_STEPS = new Set(["0", "1", "2", "4", "-1", "-2", "-4", "reset"]);
const LFO_TABLE_LEN = 32;
export function writeLfoTable(sym, op, node, machine, push, diagnostics, src, trackName) {
  const err = (msg, at = src) => pushDiag(diagnostics, "error", "E_PARAM_VALUE", msg, at, trackName);
  if (!machine.parts.some((p) => p.lfoTable))
    return err(`${sym} [steps] is the FDS's modulation table (:target fc, wave1); here ${sym} is saw | square | triangle | noise`);
  if (op) return err(`${sym} is a table; it has no '${op}' form`);
  if (node?.kind !== "list" || node.bracket !== "[]")
    return err(`the FDS's ${sym} is a table of ${LFO_TABLE_LEN} steps: 0, 1, 2, 4, -1, -2, -4 or reset`);
  const items = node.items.filter((n) => n.kind !== "comment");
  const table = [];
  for (const n of items) {
    const v = atomValue(n);
    if (!LFO_TABLE_STEPS.has(String(v))) return err(`a ${sym} step is 0, 1, 2, 4, -1, -2, -4 or reset, not ${v ?? "a list"}`, nodeSrc(n) ?? src);
    table.push(v === "reset" ? "reset" : Number(v));
  }
  if (table.length !== LFO_TABLE_LEN) return err(`the FDS's ${sym} takes ${LFO_TABLE_LEN} steps, not ${table.length}`, nodeSrc(node) ?? src);
  push("PARAM_SET", { target: "LFO_WAVE", table });
}

// Write a hardware parameter from a readValue result. An operator reads the
// parameter itself: `:tl1+ e` is `(+ $tl1 e)` and `:tl1* e` is `(* $tl1 e)`,
// lowered like any other runtime expression (PARAM_ADD / PARAM_MUL).
export function writeParam(target, op, sym, v, push, env, vals, diagnostics, trackName, src) {
  if (!v) return;
  const err = (code, msg) => pushDiag(diagnostics, "error", code, msg, src, trackName);
  if (v.kind === "none" && !op && TARGET_SYMBOLS[target]?.none !== undefined) {
    push("PARAM_SET", { target, value: TARGET_SYMBOLS[target].none });
    return;
  }
  if (v.kind === "none") {
    // Stop a running inline PARAM_SWEEP, freezing the value.
    if (op) err("E_PARAM_VALUE", `${sym} needs a number or a $value, not none`);
    else push("PARAM_SWEEP_STOP", { target });
    return;
  }
  if (v.kind === "symbol") {
    if (!op && v.value in (TARGET_SYMBOLS[target] ?? {}))
      push("PARAM_SET", { target, value: TARGET_SYMBOLS[target][v.value] });
    else
      err("E_PARAM_VALUE",
        `${sym} takes a number, a curve or a $value, not '${v.value}'`);
    return;
  }
  if ((v.kind === "signal" || op) && SET_ONLY_TARGETS.has(target)) {
    err("E_PARAM_VALUE", `${sym} takes a number or a $value, read at the write`);
    return;
  }
  if (v.kind === "signal") {
    if (op)
      err("E_EVAL_TYPE", `${sym} needs a number or a $value; a curve has no '${op}' form`);
    else if (v.spec.steps)
      // A materialized signal⊕signal step vector has no inline PARAM_SWEEP
      // form — it's a macro-only shape.
      err("E_EVAL_SIGNAL_SHAPE",
        `signal arithmetic ${sym} is only valid in a (macro …), not an inline sweep`);
    else push("PARAM_SWEEP", { target, ...v.spec });
    return;
  }
  if (!op && v.kind === "scalar") {
    push("PARAM_SET", { target, value: FRACTIONAL_TARGETS.has(target) ? v.value : Math.round(v.value) });
    return;
  }
  let steps = v.steps;
  if (op) {
    const operand = v.kind === "scalar" ? atomNode(v.value) : v.node;
    const expr = { kind: "list", bracket: "()", items: [atomNode(op), atomNode("$" + opSuffix(sym).stem.slice(1)), operand] };
    const r = evalValue(expr, env, valueCtx(target, vals, diagnostics, trackName, src));
    if (!r) return;
    steps = r.steps;
  }
  emitRuntime(steps, target, push, diagnostics, trackName, src);
}

// A level written on an SSG channel on its envelope (`:env`): the envelope
// is the level there, so a :vol or :vel only silences at 0 — and so on a
// part with no level at all (the 2A03's triangle, `noLevel`). Said once a
// track.
export function warnEnvLevel(trackState, sym, diagnostics, src, trackName) {
  const none = trackState.part?.noLevel;
  if (!(trackState.ssgEnv || none) || trackState.envLevelSaid) return;
  trackState.envLevelSaid = true;
  pushDiag(diagnostics, "warning", "W_TARGET",
    none
      ? `${sym} does not set the level of ${trackState.head}: the ${trackState.part.label} has none (it sounds or is halted; 0 still silences)`
      : `${sym} does not set the level of ${trackState.head} on :env (the envelope is its level; 0 still silences)`,
    src, trackName);
}

// `:snap` (language.md §5.3): a pitch-class mask the channel's pitch writes
// snap down to. Written as the classes `[0 4 7]` (each folded mod 12, so
// `(+ root n)` transposes), the mask itself, or a `$slot`; `none` is 0 = off.
// A mask is state, not a level: no curve, no `+`/`*`.
export function writeSnap(sym, op, valueNode, env, vals, push, diagnostics, src, trackName, typedDefs) {
  const err = (msg) => pushDiag(diagnostics, "error", "E_PARAM_VALUE", msg, src, trackName);
  if (op) return err(`${sym} is a mask; it has no '${op}' form`);
  if (valueNode?.kind === "list" && valueNode.bracket === "[]") {
    let mask = 0;
    for (const item of valueNode.items.filter((n) => n.kind !== "comment")) {
      const v = evalScalarValue(item, env, makeEvalCtx(diagnostics, trackName, src, typedDefs));
      if (v === null) return;
      if (!Number.isInteger(v)) return err(`:snap takes whole pitch classes, not ${v}`);
      mask |= 1 << (((v % 12) + 12) % 12);
    }
    push("PARAM_SET", { target: "SNAP", value: mask });
    return;
  }
  const v = readValue(valueNode, env, valueCtx("SNAP", vals, diagnostics, trackName, src, typedDefs));
  if (!v) return;
  if (v.kind === "none") push("PARAM_SET", { target: "SNAP", value: 0 });
  else if (v.kind === "scalar") push("PARAM_SET", { target: "SNAP", value: Math.round(v.value) });
  else if (v.kind === "runtime") emitRuntime(v.steps, "SNAP", push, diagnostics, trackName, src);
  else err(`:snap takes pitch classes [0 4 7], a mask, a $value or none, not a ${v.kind === "signal" ? "curve" : `'${v.value}'`}`);
}

// An inline `:vel2 0.5`: a ratio 0–1, fixed at compile time, on an FM track.
export function writeVelSens(target, sym, op, valueNode, env, vals, push, diagnostics, src, trackName, typedDefs) {
  const err = (code, msg) => pushDiag(diagnostics, "error", code, msg, src, trackName);
  const ch = String(trackName).split(":")[0];
  if (ch === "fm3-csm-rate") // a rate source, not a voice (a PSG or PCM track is its part's)
    return err("E_UNSUPPORTED_TARGET", `${sym} is an FM operator's; ${ch} has none`);
  if (op) return err("E_PARAM_VALUE", `${sym} is a ratio set as a whole; it has no '${op}' form`);
  const v = readValue(valueNode, env, valueCtx(target, vals, diagnostics, trackName, src, typedDefs));
  if (!v) return;
  const k16 = v.kind === "scalar" ? velSensSixteenths(v.value) : null;
  if (k16 === null) {
    const what = v.kind === "scalar" ? v.value : v.kind === "signal" ? "a curve"
      : v.kind === "runtime" ? "a $value" : `'${v.value ?? v.kind}'`;
    return err("E_PARAM_VALUE", `${sym} takes a ratio 0..1 of the velocity, fixed at compile time, not ${what}`);
  }
  push("PARAM_SET", { target, value: k16 });
}
