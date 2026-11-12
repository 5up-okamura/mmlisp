// Macros: a macro spec parsed and its step, a macro's entry on a track's
// state, its values mapped / scaled / offset, a :mod's velocity, and the
// inline sweeps a stochastic curve or a wait may not take.

import { sampleCurveUnit } from "../../ir/curves.js";
import { VEL_FINE } from "../../ir/levels.js";
import { clampForTarget } from "../../ir/ranges.js";
import { readConstNumber, curveParamToken, requireCurveFrom, makeEvalCtx, macroStepFramesForEval } from "./curves.js";
import { pushDiag, atomValue, nodeSrc, describeNodeToken, parseNumberLike } from "./diag.js";
import { MACRO_TARGETS, PCM_PITCH_TARGETS, pcmRejectsPitch, PCM_PITCH_KEYWORD, PCM_MACRO_TARGETS, pcmTakesPitch, OP_BASE_TARGETS, OP_ADD_TARGETS, FRACTIONAL_TARGETS, PAN_MAP, TARGET_SYMBOLS } from "./keywords.js";
import { parseStepToken, isFrameToken, parseLengthToken } from "./length.js";
import { lookupBound, evalValue, makeEnv } from "../mmlisp-eval.js";
import { NOISE_MODE_MAP } from "../../machine/chips/sn76489.js";

export function applyMacroEntryToState(trackState, irTarget, spec, ctx) {
  if (!spec || !MACRO_TARGETS.has(irTarget)) return;
  if (
    PCM_PITCH_TARGETS.has(irTarget) &&
    pcmRejectsPitch(
      trackState,
      `(macro ${PCM_PITCH_KEYWORD[irTarget]} …)`,
      ctx?.diagnostics,
      ctx?.src,
      ctx?.trackName,
      irTarget,
    )
  )
    return;
  if (trackState?.isPcmTrack && !PCM_MACRO_TARGETS.has(irTarget) && !(PCM_PITCH_TARGETS.has(irTarget) && pcmTakesPitch(trackState, irTarget))) {
    pushDiag(
      ctx?.diagnostics ?? [],
      "error",
      "E_PCM_MACRO_TARGET",
      `(macro ${ctx?.keyword ?? irTarget} …) has no effect on a pcm track: ` +
        "a PCM voice takes :keyon, :vel and :vol",
      ctx?.src ?? { line: 1, column: 1 },
      ctx?.trackName,
    );
    return;
  }
  if (irTarget === "WAVE") trackState.editWaveName = null;
  trackState.activeMacros[irTarget] = spec;
}

// `(macro :target none)` clears one active macro; `(macro none)` clears all.
export function clearMacroTarget(trackState, irTarget) {
  if (irTarget && MACRO_TARGETS.has(irTarget))
    delete trackState.activeMacros[irTarget];
}

// Resolve a (delay …) spec into concrete per-tap velocities, RELATIVE to
// the source note's vel. `param` = a regular ramp from `:by` (additive on :vel /
// geometric on :vel*); `list` = explicit per-tap deltas/ratios; `curve` = a
// relative envelope whose tap count is :len ÷ spacing. mode "add"|"mul".
export function resolveDelayVels(spec, delayTicks, srcVel) {
  if (!spec || !(delayTicks > 0)) return null;
  const mul = spec.mode === "mul";
  const apply = (rel) => clampForTarget("VEL", mul ? srcVel * rel : srcVel + rel);
  if (spec.type === "param") {
    const by = spec.by ?? 0;
    const out = [];
    for (let k = 1; k <= spec.count; k++) out.push(apply(mul ? Math.pow(by, k) : by * k));
    return out.length ? out : null;
  }
  if (spec.type === "list") {
    return spec.list.length ? spec.list.map(apply) : null;
  }
  if (spec.type === "curve") {
    const { from = 0, to = 0, frames = 0, curve = "linear", params } = spec;
    const count = Math.floor(frames / delayTicks);
    if (count < 1) return null;
    const out = [];
    for (let k = 1; k <= count; k++)
      out.push(apply(from + (to - from) * sampleCurveUnit(curve, k / count, params)));
    return out;
  }
  return null;
}

// Largest numeric value in a :vel macro — the reference peak for echo scaling.
export function velMacroPeak(spec) {
  if (!spec) return 0;
  if (spec.type === "steps") {
    return (spec.steps || []).reduce(
      (m, v) => (v !== null && v !== undefined ? Math.max(m, v) : m),
      0,
    );
  }
  if (spec.type === "curve") {
    return Math.max(spec.from ?? 0, spec.to ?? 0);
  }
  if (spec.type === "stages") {
    return (spec.stages || []).reduce(
      (m, st) =>
        st && st.from !== undefined ? Math.max(m, st.from, st.to ?? 0) : st?.fromNow ? Math.max(m, st.to ?? 0) : m,
      0,
    );
  }
  return 0;
}

// Apply fn to every scalar value a macro spec carries (step values / curve
// from&to / stage from&to), preserving nulls. Shared by scale and add.
function mapMacroValues(spec, fn) {
  if (!spec) return spec;
  const s = (v) => (v === null || v === undefined ? v : fn(v));
  if (spec.type === "steps") {
    return { ...spec, steps: (spec.steps || []).map(s) };
  }
  if (spec.type === "curve") {
    return { ...spec, from: s(spec.from ?? 0), to: s(spec.to ?? 0) };
  }
  if (spec.type === "stages") {
    return {
      ...spec,
      stages: (spec.stages || []).map((st) =>
        st && st.from !== undefined
          ? { ...st, from: s(st.from), to: s(st.to ?? 0) }
          : st?.fromNow // a release from where the level is: its end alone
            ? { ...st, to: s(st.to ?? 0) }
            : st,
      ),
    };
  }
  return spec;
}

// Scale a macro spec's values by `factor`, clamped to `target`'s range (kept
// float, quantized at playback), preserving type, markers, and per-macro step.
// Shared by the `*` multiplicative modifier (factor = the note's static base)
// and :delay echoes (factor = the echo's vel ratio).
export function scaleMacroValues(spec, factor, target) {
  return mapMacroValues(spec, (v) => clampForTarget(target, v * factor));
}

export function addMacroValues(spec, offset, target) {
  return mapMacroValues(spec, (v) => clampForTarget(target, v + offset));
}

// Target group: a [] vector of macro keywords in target position, e.g.
// (macro [:tl1 :tl2 :tl3 :tl4] spec) — one spec applied to every target.
// Returns the keyword strings, or null if node is not an all-keyword vector.
// Unambiguous: spec vectors only ever appear in the value position.
export function macroTargetGroup(node) {
  if (node?.kind !== "list" || node.bracket !== "[]") return null;
  const items = node.items.filter((n) => n.kind !== "comment");
  if (items.length === 0) return null;
  const syms = items.map((n) => atomValue(n));
  return syms.every((s) => typeof s === "string" && s.startsWith(":"))
    ? syms
    : null;
}

// Validate a `+`/`*` operator against its target; pushes a diagnostic and
// returns false when the target has no base value to add to / scale.
export function macroOpOk(target, op, sym, diagnostics, trackName) {
  if (OP_BASE_TARGETS.has(target)) return true; // VEL: + and * both bake a base
  if (op === "+" && OP_ADD_TARGETS.has(target)) return true; // additive offset
  const msg = OP_ADD_TARGETS.has(target)
    ? `'${sym}' — offset targets (pitch/semi) accept + only, not *`
    : `'${sym}' has no base value to combine with; +/* apply only to ${[...OP_BASE_TARGETS].join(", ").toLowerCase()}`;
  pushDiag(diagnostics, "error", "E_MACRO_OP_NO_BASE", msg, null, trackName);
  return false;
}

// (def-mod [:ch c|[c…]] [:voice v|[v…]] action…) — a score-wide rewrite of
// the notes it selects (language.md §9.4): `:keyon off` turns them into rests,
// `:vel` / `:vel+` / `:vel*` move their velocity (clamped to 0–15). Read after
// the defs are expanded, so a def can name a list of targets.
const MOD_VEL_OPS = { ":vel": "=", ":vel+": "+", ":vel*": "*" };
export function parseModDef(root, channelNames, typedDefs, sampleDefs, diagnostics) {
  const items = root.items.filter((n) => n.kind !== "comment");
  const src = nodeSrc(root);
  const err = (code, msg, at = src) => pushDiag(diagnostics, "error", code, `def-mod: ${msg}`, at, "global");
  const mod = { ch: null, voice: null, keyonOff: false, vel: [] };
  let ok = true;
  for (let k = 1; k < items.length; k += 2) {
    const key = atomValue(items[k]);
    const valueNode = items[k + 1];
    if (!valueNode) {
      err("E_MOD_OPTION", `${key ?? "a value"} needs a value`, nodeSrc(items[k]));
      ok = false;
      break;
    }
    if (key === ":ch" || key === ":voice") {
      const names = valueNode.kind === "list" && valueNode.bracket === "[]"
        ? valueNode.items.filter((n) => n.kind !== "comment")
        : [valueNode];
      const set = (key === ":ch" ? mod.ch : mod.voice) ?? new Set();
      for (const n of names) {
        const name = n.kind === "atom" ? n.value : null;
        const known = key === ":ch"
          ? channelNames.includes(name)
          : typedDefs.get(name)?.tag === "voice" || sampleDefs.has(name);
        if (!known) {
          err("E_MOD_TARGET", key === ":ch"
            ? `${name ?? "a list"} is not a channel name`
            : `${name ?? "a list"} is not a def-fm voice or a def-pcm sample`, nodeSrc(n));
          ok = false;
          continue;
        }
        set.add(name);
      }
      if (key === ":ch") mod.ch = set;
      else mod.voice = set;
    } else if (key === ":keyon") {
      if (atomValue(valueNode) === "off") mod.keyonOff = true;
      else {
        err("E_MOD_OPTION", `:keyon takes off, not ${atomValue(valueNode) ?? "a list"}`, nodeSrc(valueNode));
        ok = false;
      }
    } else if (MOD_VEL_OPS[key]) {
      const value = readConstNumber(valueNode, null, diagnostics, "global", nodeSrc(valueNode));
      if (value === undefined) ok = false;
      else if (value === null) {
        err("E_MOD_OPTION", `${key} takes a number, not ${atomValue(valueNode) ?? "a list"}`, nodeSrc(valueNode));
        ok = false;
      } else mod.vel.push({ op: MOD_VEL_OPS[key], value });
    } else {
      err("E_MOD_OPTION", `unknown option ${key ?? describeNodeToken(items[k])} (takes :ch :voice :keyon :vel :vel+ :vel*)`,
        nodeSrc(items[k]));
      ok = false;
    }
  }
  if (ok && !mod.keyonOff && mod.vel.length === 0) {
    err("E_MOD_OPTION", "nothing to do: give :keyon off or :vel / :vel+ / :vel*");
    ok = false;
  }
  return ok ? mod : null;
}

// A note's velocity — `vel` and every value of its vel macro — through a
// mod's ops in written order, each clamped. `:vel V` sets the note's vel and
// moves its envelope by the same step, so the shape survives.
function applyModVel(args, ops) {
  let v = args.vel ?? 15;
  let macro = args.velMacro;
  for (const { op, value } of ops) {
    const next = op === "+" ? v + value : op === "*" ? v * value : value;
    if (macro)
      macro = mapMacroValues(macro, (x) =>
        clampForTarget("VEL", op === "*" ? x * value : x + (op === "+" ? value : value - v)));
    v = clampForTarget("VEL", next);
  }
  if (v === 15) delete args.vel;
  else args.vel = v;
  if (macro) args.velMacro = macro;
}

// Apply the score's def-mods to one layer's events (head = its channel name).
// Runs after the delay expansion, so echoes are notes like any other, and
// before the :prio merge, so a removed note leaves its time to a lower layer.
export function applyMods(events, head, mods) {
  const mine = mods.filter((m) => !m.ch || m.ch.has(head));
  if (mine.length === 0) return events;
  const voiceOf = (ev) => (ev.cmd.startsWith("PCM_") ? ev.args.sample : ev._voice ?? null);
  const hits = (ev) => mine.filter((m) => !m.voice || m.voice.has(voiceOf(ev)));
  const out = [];
  let dropped = false; // the last note was removed: its ties go with it
  for (const ev of events) {
    if (ev.cmd === "NOTE_ON" || ev.cmd === "PCM_NOTE_ON") {
      const ms = hits(ev);
      if (ms.some((m) => m.keyonOff)) {
        out.push({ tick: ev.tick, cmd: "REST", args: { length: ev.args.length }, src: ev.src,
          ...(ev._edit ? { _edit: ev._edit } : {}) });
        dropped = true;
        continue;
      }
      // A slur from a removed note has nothing to slur from.
      if (dropped) delete ev.args.legato;
      dropped = false;
      for (const m of ms) if (m.vel.length) applyModVel(ev.args, m.vel);
    } else if (ev.cmd === "TIE" && dropped) {
      out.push({ tick: ev.tick, cmd: "REST", args: { length: ev.args.length }, src: ev.src,
        ...(ev._edit ? { _edit: ev._edit } : {}) });
      continue;
    } else if (ev.cmd === "PCM_NOTE_OFF" && hits(ev).some((m) => m.keyonOff)) {
      continue;
    }
    out.push(ev);
  }
  return out;
}

// Pull the single `:step` clock out of a macro's items (position-free). Returns
// the parsed step or null; pushes E_MACRO_STEP_DUP when more than one appears.
export function extractMacroStep(items, diagnostics, trackName) {
  let step = null;
  let count = 0;
  for (let k = 0; k < items.length; k++) {
    if (atomValue(items[k]) !== ":step") continue;
    count++;
    if (count !== 1) continue;
    const tok = k + 1 < items.length ? atomValue(items[k + 1]) : null;
    step = parseStepToken(tok);
    // A :step that is not a length > 0 would leave the macro on its 1f
    // default without a word — a typo heard as the wrong rate.
    if (step === null && diagnostics)
      pushDiag(diagnostics, "warning", "W_MACRO_STEP_INVALID",
        `:step takes a length > 0 (16, 24t, 2f, 30ms), not ${tok ?? "nothing"}; ` +
          "the macro steps at the default 1f",
        nodeSrc(items[k + 1] ?? items[k]), trackName);
  }
  if (count > 1) {
    pushDiag(
      diagnostics,
      "error",
      "E_MACRO_STEP_DUP",
      "a macro takes at most one :step; use separate (macro …) forms for multiple clocks",
      null,
      trackName,
    );
  }
  return step;
}

/**
 * Parse a (macro …) spec node for any target.
 * Accepts both step-vector [...] and curve (...) forms.
 * Steps are clamped with clampForTarget(target, n) — works for any target.
 * Returns { type: "steps", steps, loopIndex, releaseIndex }
 *      or { type: "curve", ...curveSpec }
 *      or { type: "stages", stages: [...] }  (multi-stage sequential)
 * or null if the node cannot be parsed.
 */
export function parseMacroSpec(
  node,
  target,
  diagnostics = null,
  trackName = null,
  clamp = true,
  env = null, // body eval env, so `(let …)` bindings reach macro values
  step = null, // the macro's :step, for signal⊕signal materialization resolution
  ratio = false, // a `*` macro: its values are multipliers, kept unrounded
  modes = null, // the track's part's :mode symbols (chips/parts.js), for a :mode macro
  waves = null, // the score's def-waves, for a :wave macro
) {
  if (!node) return null;
  // A :wave macro steps def-wave names, one a step: a step vector alone.
  if (target === "WAVE" && !(node.kind === "list" && node.bracket === "[]" &&
      node.items.every((n) => n.kind === "comment" || n.kind === "atom"))) {
    if (diagnostics) pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID",
      "a :wave macro is a vector of def-wave names, [saw saw #sus soft]", nodeSrc(node), trackName);
    return null;
  }
  // Relative (+/*) macros carry signed offsets / ratios; leave them unclamped
  // here and clamp only after combining with the base (add/scaleMacroValues).
  const clampVal = (v) => (clamp ? clampForTarget(target, v) : v);
  // A velocity keeps eighths of a step, as the driver holds it (§6).
  const roundVal = (n) => (ratio || FRACTIONAL_TARGETS.has(target) ? n
    : target === "VEL" ? Math.round(n * VEL_FINE) / VEL_FINE : Math.round(n));
  // One macro value: a number (rounded where it binds, like every value) or
  // the target's own symbol (`white2`, `left`), in a vector and as a scalar.
  const tokenValue = (val) => {
    if (typeof val !== "string") return null;
    if (target === "WAVE") return waves?.index.get(val) ?? null;
    if (modes?.[val]?.[0] === target) return modes[val][1];
    if (target === "NOISE_MODE" && val in NOISE_MODE_MAP) return NOISE_MODE_MAP[val];
    if (target === "PAN" && val in PAN_MAP) return PAN_MAP[val];
    if (target === "SSG_MIX" && val in TARGET_SYMBOLS.SSG_MIX) return TARGET_SYMBOLS.SSG_MIX[val];
    const n = parseNumberLike(val);
    return n === null ? null : roundVal(n);
  };
  // Step-vector or multi-stage form: [...]
  if (node.kind === "list" && node.bracket === "[]") {
    const items = node.items.filter((n) => n.kind !== "comment");

    // A `let` name stands for its value: a number is a step, a curve a stage.
    const boundOf = (it) =>
      it.kind === "atom" && env ? lookupBound(env, atomValue(it)) : undefined;
    const isStage = (it) =>
      (it.kind === "list" && it.bracket === "()") ||
      (boundOf(it) !== undefined && typeof boundOf(it) === "object");
    // A :wave macro's steps are def-waves: a let name standing for a curve
    // would step between them.
    if (target === "WAVE" && items.some(isStage)) {
      if (diagnostics) pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID",
        "a :wave macro is a vector of def-wave names, [saw saw #sus soft]", nodeSrc(node), trackName);
      return null;
    }

    // One grammar (language.md §10): a vector holding any stage is a stage
    // list, and in it a number is a one-:step stage, `_` waits one step,
    // `#rel` is where the release starts ((wait key-off)) and `#sus` makes the
    // stage after it loop until key-off. A vector of values alone stays the
    // step vector below.
    if (items.some(isStage)) {
      const oneStep = step ?? { unit: "frame", value: 1 };
      const stepWait = () =>
        oneStep.unit === "tick" ? { waitTicks: oneStep.value } : { waitFrames: oneStep.value };
      const stepStage = (v) => ({
        curve: "linear",
        from: v,
        to: v,
        frames: oneStep.value,
        ...(oneStep.unit === "tick" ? {} : { lenFrames: true }),
        loop: false,
      });
      const bad = (it, msg) =>
        diagnostics && pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID", msg, nodeSrc(it), trackName);
      const stages = [];
      let sus = null; // the #sus waiting for its stage
      // The stage right after (wait key-off) may leave out its :from: the
      // release then starts from where the macro is at the key-off (the
      // driver reads its last value). It must be the whole release.
      let atRelease = false, fromNow = null;
      for (const it of items) {
        const val = atomValue(it);
        if (fromNow && val !== "_") bad(it, "a release without its :from starts where the level is and is the whole release; nothing may follow it");
        if (val === "#sus") { sus = it; continue; }
        if (val === "#rel") { stages.push({ waitKeyOff: true }); atRelease = true; continue; }
        if (val === "_") { stages.push(stepWait()); atRelease = false; continue; }
        if (it.kind === "list" && atomValue(it.items?.[0]) === "wait") {
          // (wait key-off) or (wait N) or (wait Nf), N a length as a curve's
          // :wait reads it — a let name or an expression too.
          const arg = curveParamToken(it.items?.[1], env, "length", "(wait …)", "a stage",
            false, diagnostics, nodeSrc(it), trackName);
          if (arg === undefined) {
            stages.push({ waitTicks: 1 });
          } else if (arg === "key-off") {
            stages.push({ waitKeyOff: true });
            atRelease = true;
            continue;
          } else if (isFrameToken(arg)) {
            // Nf / Nms is a wall-clock frame count; carry the unit so the
            // player's frame branch schedules it directly (a stage wait is a
            // local sampler delay, not a timeline advance — tempo-independent).
            stages.push({ waitFrames: parseLengthToken(arg, null) });
          } else {
            const t = parseLengthToken(arg, null);
            if (t === null && diagnostics)
              pushDiag(diagnostics, "warning", "W_WAIT_INVALID",
                `(wait …) takes a length or key-off, not ${arg ?? "nothing"}; it waits 1 tick`,
                nodeSrc(it), trackName);
            stages.push({ waitTicks: t ?? 1 });
          }
          continue;
        }
        let spec = null;
        if (isStage(it)) {
          // A curve — a literal, a let name or arithmetic on one — or an
          // expression that folds to a number (then one step).
          const r = evalMacroNode(it);
          if (r?.kind === "signal" && !r.spec.steps) spec = r.spec;
          else if (r?.kind === "scalar") spec = stepStage(clampVal(r.value));
          else if (r) bad(it, "a stage is a curve, a number or (wait …)");
        } else {
          const b = boundOf(it);
          const n = typeof b === "number" ? roundVal(b) : tokenValue(val);
          if (n !== null) spec = stepStage(clampVal(n));
          else bad(it, `${val ?? "(…)"} is not a value for this macro`);
        }
        if (!spec) { atRelease = false; continue; }
        if (atRelease && spec.from === undefined && !spec.steps && !spec.stages && !sus) {
          // fromNow: the driver's share steps — 128 of the way, 32768 on the
          // i16 :pitch (mmb.md §15) — which the preview follows.
          spec = { ...spec, fromNow: target === "NOTE_PITCH" ? 32768 : 128 };
          fromNow = it;
        } else requireCurveFrom(spec, diagnostics, trackName, "a macro");
        atRelease = false;
        if (sus) {
          spec = { ...spec, loop: true };
          sus = null;
        }
        stages.push(spec);
      }
      if (sus) bad(sus, "#sus needs a stage after it to loop");
      return { type: "stages", stages, src: nodeSrc(node) };
    }

    // Step-vector form: [15 #sus 14 13 #rel 11 9 7 5 3 0 _ ...]
    // For MODE target, also accept noise mode symbols (white0-3, periodic0-3).
    // For PAN target, also accept pan symbols (left, center, right).
    const steps = [];
    let loopIndex = null;
    let releaseIndex = null;
    for (const item of items) {
      const val = atomValue(item);
      if (val === "#sus") {
        loopIndex = steps.length;
        continue;
      }
      if (val === "#rel") {
        releaseIndex = steps.length;
        continue;
      }
      const b = boundOf(item);
      const n = typeof b === "number" && target !== "WAVE" ? roundVal(b) : tokenValue(val);
      if (n !== null) {
        steps.push(clampVal(n));
      } else if (val === "_") {
        steps.push(null); // hold: advance 1 frame, no write
      } else if (diagnostics) {
        // Skipping it would shift every later step: say so instead.
        pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID",
          `${val ?? "(…)"} is not a value for this macro`, nodeSrc(item), trackName);
      }
    }
    // src spans the whole `[...]` literal so the player can highlight the
    // sounding step sequence during playback (a curve's and a stage vector's
    // span theirs, for the panel's vector editor: IRPlayer.setOnPosition).
    return { type: "steps", steps, loopIndex, releaseIndex, src: nodeSrc(node) };
  }
  // A curve, an expression or a `let` name (§7.2) evaluates to a signal or a
  // number. Scaled macro (§7.0): `(* <signal> $slot)` evaluates to
  // the signal carrying `scale`, the slot it rides as a per-frame depth knob —
  // the driver writes `(sample × slot) >> 8` each frame (exporter → MMB flags
  // bit2 + a slot byte). A macro reads no other `$`.
  const bound =
    node.kind === "atom" && env && lookupBound(env, atomValue(node)) !== undefined;
  if (bound || (node.kind === "list" && node.bracket === "()")) {
    const r = evalMacroNode(node);
    if (!r) return null;
    if (r.kind === "runtime") {
      pushDiag(diagnostics, "error", "E_EVAL_NOT_LOWERABLE",
        "a macro reads a $value only as a scaled macro (* signal $slot)", nodeSrc(node), trackName);
      return null;
    }
    return macroSpecOf(r);
  }
  // Scalar constant: e.g. `:keyon 1`. A constant signal equivalent to
  // `[#sus N]` (single value, looped). Mainly for :keyon (1 = fire every
  // :step, 0 = never).
  const scalar = tokenValue(atomValue(node));
  if (scalar !== null) {
    return {
      type: "steps",
      steps: [clampVal(scalar)],
      loopIndex: 0,
      releaseIndex: null,
    };
  }
  return null;

  function evalMacroNode(n) {
    return evalValue(n, env ?? makeEnv(null), {
      ...makeEvalCtx(diagnostics, trackName, nodeSrc(n), null, macroStepFramesForEval(step)),
      // A slot's name, in its FROM_VAL form; an unknown one degrades the
      // scaled macro to a plain one at export.
      macro: true,
      resolveSlot: (raw) => (raw === "$time" ? "$time" : raw.slice(1)),
    });
  }

  // An eval result as a macro spec. A materialized signal⊕signal result is a
  // float step vector; a symbolic (affine-folded) curve stays a curve; a number
  // is a constant, held.
  function macroSpecOf(r) {
    if (r.kind === "signal") requireCurveFrom(r.spec, diagnostics, trackName, "a macro");
    if (r.kind === "scalar")
      return { type: "steps", steps: [clampVal(r.value)], loopIndex: 0, releaseIndex: null };
    return r.spec.steps
      ? {
          type: "steps",
          steps: r.spec.steps,
          loopIndex: r.spec.loopIndex ?? null,
          releaseIndex: r.spec.releaseIndex ?? null,
          ...(r.spec.scale ? { scale: r.spec.scale } : {}),
        }
      : { type: "curve", ...r.spec, ...(node.kind === "list" ? { src: nodeSrc(node) } : {}) };
  }
}

// A stochastic curve is data, not a formula: a macro samples it into the
// table the driver steps, but an inline sweep carries only a curve id, and the
// driver has no random source to evaluate one with — it would play a straight
// ramp while the preview plays noise (opcodes.md §8.1). So the stochastic
// curves are macro-only, and an inline one is an error rather than a sound
// that changes on export.
const STOCHASTIC_CURVE_NAMES = new Set(["noise", "pink", "perlin", "brown"]);
const INLINE_SWEEP_CMDS = new Set(["PARAM_SWEEP", "TEMPO_SWEEP", "CSM_RATE"]);
export function rejectInlineStochasticSweeps(tracks, diagnostics) {
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      if (!INLINE_SWEEP_CMDS.has(ev.cmd)) continue;
      const curve = ev.args?.curve;
      if (!STOCHASTIC_CURVE_NAMES.has(curve)) continue;
      delete ev.args.holdLen; // a :hold in units only a macro's note resolves
      pushDiag(
        diagnostics,
        "error",
        "E_CURVE_MACRO_ONLY",
        `${curve} is macro-only: an inline sweep cannot carry its values, so the driver ` +
          `would play a straight ramp. Use it in a (macro …).`,
        ev.src,
        track.scoreChannel ?? track.channel,
      );
    }
  }
}

// `:wait` delays a macro's curve or a stage (§11); an inline sweep starts
// where it is written, and both players start it there whatever its :wait
// says. Warned once per written sweep (a repeat copies its events).
export function warnInlineSweepWaits(tracks, diagnostics) {
  const seen = new Set();
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      if (!INLINE_SWEEP_CMDS.has(ev.cmd)) continue;
      const a = ev.args ?? {};
      if (a.waitTicks == null && a.waitFrames == null && !a.waitKeyOff) continue;
      const key = `${ev.src?.file ?? ""}:${ev.src?.line}:${ev.src?.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushDiag(diagnostics, "warning", "W_SWEEP_WAIT",
        "an inline sweep starts where it is written: its :wait is ignored " +
          "(:wait delays a curve in a (macro …) or a stage, language.md §11)",
        ev.src, track.scoreChannel ?? track.channel);
    }
  }
}
