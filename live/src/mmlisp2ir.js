/**
 * MMLisp → IR compiler — ES module port of tools/scripts/mmlisp2ir.js (v0.3)
 * No Node.js dependencies; input is a MMLisp source string.
 *
 * API:
 *   compileMMLisp(src: string, filename?: string)
 *     → { ir: object, diagnostics: array, sourceMap: array }
 *
 * Errors in diagnostics have: { severity, code, message, line, column, track }
 */

import { parse } from "./mmlisp-parser.js";
import { clampForTarget } from "./macro-ranges.js";

const PPQN = 48;
const WHOLE_TICKS = PPQN * 4;
const SUPPORTED_TARGETS = new Set([
  "NOTE_PITCH",
  "VOL",
  "MASTER",
  "FM_ALG",
  "FM_FB",
  "FM_AMS",
  "FM_FMS",
  "LFO_RATE",
  "PAN",
  "NOISE_MODE",
  ...[1, 2, 3, 4].flatMap((op) => [
    `FM_AR${op}`,
    `FM_DR${op}`,
    `FM_SR${op}`,
    `FM_RR${op}`,
    `FM_SL${op}`,
    `FM_TL${op}`,
    `FM_KS${op}`,
    `FM_ML${op}`,
    `FM_DT${op}`,
    `FM_SSG${op}`,
    `FM_AMEN${op}`,
  ]),
]);

const TRACK_OPTION_KEYS = new Set([
  ":ch",
  ":role",
  ":oct",
  ":len",
  ":gate",
  ":vel",
  ":carry",
  ":shuffle",
  ":shuffle-base",
  ":write",
]);

// Curve function names recognized in inline curve specs (PARAM_SWEEP authoring)
const CURVE_NAMES = new Set([
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "sin",
  "triangle",
  "square",
  "saw",
  "ramp",
]);

// Loop waveforms produce PARAM_SWEEP with loop:true; easing/linear produce loop:false
const LOOP_CURVE_NAMES = new Set(["sin", "triangle", "square", "saw", "ramp"]);

// PSG noise mode symbols — white0-3 and periodic0-3 map to FB + NF bits
// white:    FB=1, NF varies: 00/01/10/11 → white0/1/2/3
// periodic: FB=0, NF varies: 00/01/10/11 → periodic0/1/2/3
const NOISE_MODE_MAP = {
  white0: 0b1_00, // 4
  white1: 0b1_01, // 5
  white2: 0b1_10, // 6
  white3: 0b1_11, // 7
  periodic0: 0b0_00, // 0
  periodic1: 0b0_01, // 1
  periodic2: 0b0_10, // 2
  periodic3: 0b0_11, // 3
};

function atomValue(node) {
  if (!node) return null;
  if (node.kind === "atom" || node.kind === "string") return node.value;
  return null;
}

function isAtom(node, value) {
  return node && node.kind === "atom" && node.value === value;
}

function parseIntLike(value) {
  if (typeof value !== "string") return null;
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function parseLengthToken(value, inheritedTicks) {
  if (!value) return inheritedTicks;
  // Tick count: "14t" — exact tick value
  if (/^\d+t$/.test(value)) {
    return parseInt(value, 10);
  }
  // Frame count: "16f" — 60 Hz update intervals used in macro :len context.
  // Returns the raw frame count; the player schedules one step per 1/60 s.
  // Not valid for note/rest lengths where BPM-based tick conversion would be required.
  if (/^\d+f$/.test(value)) {
    return parseInt(value, 10);
  }
  // Fraction: "1/2", "3/4"
  if (/^\d+\/\d+$/.test(value)) {
    const [n, d] = value.split("/").map((v) => parseInt(v, 10));
    return Math.round((WHOLE_TICKS * n) / d);
  }
  // Dotted integer: "4." = 1.5 × quarter, "8." = 1.5 × eighth, etc.
  if (/^\d+\.$/.test(value)) {
    const d = parseInt(value, 10);
    return Math.round((WHOLE_TICKS * 3) / (d * 2));
  }
  // Plain integer note-length denominator: "4" = quarter, "8" = eighth, etc.
  if (/^\d+$/.test(value)) {
    return Math.round(WHOLE_TICKS / parseInt(value, 10));
  }
  return inheritedTicks;
}

// Returns true if val is a rest token: "_", "_4", "_4.", "_14t", "_16f"
function isRestAtom(val) {
  return typeof val === "string" && /^_(\d+[ft]?\.?)?$/.test(val);
}

// Parse the length of a rest token; the leading "_" is stripped before parsing.
function parseRestLength(val, inheritedTicks) {
  const suffix = val.slice(1);
  if (suffix === "") return inheritedTicks;
  return parseLengthToken(suffix, inheritedTicks);
}

function parseGateSpec(val) {
  if (typeof val !== "string") return null;
  if (val.includes(".")) {
    const f = parseFloat(val);
    if (isNaN(f) || f < 0 || f > 1) return null;
    if (f >= 1.0) return null;
    return { type: "ratio", value: f };
  }
  const ticks = parseLengthToken(val, null);
  if (ticks === null || ticks <= 0) return null;
  return { type: "ticks", value: ticks };
}

function resolveGateTicks(gateSpec, lengthTicks) {
  if (!gateSpec) return lengthTicks;
  if (gateSpec.type === "ratio")
    return Math.round(lengthTicks * gateSpec.value);
  return gateSpec.value;
}

function makeNoteArgs(pitch, lengthTicks, gateSpec, vel, activeMacros) {
  const gateTicks = resolveGateTicks(gateSpec, lengthTicks);
  const args = { pitch, length: lengthTicks };
  if (gateTicks < lengthTicks) args.gate = gateTicks;
  // v0.4: vel is KEY-ON scoped; only emit when non-default (15)
  if (vel !== undefined && vel !== 15) args.vel = vel;
  // v0.4: embed all active macros
  if (activeMacros && Object.keys(activeMacros).length > 0) {
    for (const [target, spec] of Object.entries(activeMacros)) {
      // Legacy naming: NOTE_PITCH → pitchMacro, VEL → velMacro
      // New targets: FM_TL1 → fm_tl1, etc. (snake_case)
      if (target === "NOTE_PITCH") args.pitchMacro = { ...spec };
      else if (target === "VEL") args.velMacro = { ...spec };
      else {
        // Convert UPPER_CASE target to snake_case for IR embedding
        const key = target.toLowerCase();
        args[key] = { ...spec };
      }
    }
  }
  return args;
}

/**
 * v0.4: Emit glide PARAM_SWEEP before NOTE_ON if glide is active.
 * Inserts a portamento slide from lastNotePitch to newPitch over glideFrames.
 * Resets glideFrom after emission (one-shot override).
 */
function emitGlideIfNeeded(trackState, newPitch, events, glideFrames, nodeSrc) {
  if (glideFrames <= 0 || !trackState.lastNotePitch) return; // No glide or first note

  const fromPitch = trackState.glideFrom || trackState.lastNotePitch;
  trackState.glideFrom = null; // One-shot reset

  events.push({
    tick: trackState.tick,
    cmd: "PARAM_SWEEP",
    args: {
      target: "NOTE_PITCH",
      from: fromPitch,
      to: newPitch,
      curve: "linear",
      frames: glideFrames,
      loop: false,
    },
    src: nodeSrc,
  });
}

/**
 * v0.4: Update lastNotePitch after emitting NOTE_ON.
 */
function updateLastNotePitch(trackState, pitch) {
  trackState.lastNotePitch = pitch;
}

/**
 * Parse a :macro spec node for any target.
 * Accepts both step-vector [...] and curve (...) forms.
 * Steps are clamped with clampForTarget(target, n) — works for any target.
 * Returns { type: "steps", steps, loopIndex, releaseIndex }
 *      or { type: "curve", ...curveSpec }
 *      or { type: "stages", stages: [...] }  (multi-stage sequential)
 * or null if the node cannot be parsed.
 */
function parseMacroSpec(node, target) {
  if (!node) return null;
  // Step-vector or multi-stage form: [...]
  if (node.kind === "list" && node.bracket === "[]") {
    const items = node.items.filter((n) => n.kind !== "comment");

    // If all items are () expressions, treat as multi-stage sequential
    const allExprs =
      items.length > 0 &&
      items.every((it) => it.kind === "list" && it.bracket === "(");
    if (allExprs) {
      const stages = [];
      for (const stageNode of items) {
        const head = atomValue(stageNode.items?.[0]);
        if (head === "wait") {
          // (wait key-off) or (wait N) or (wait Nf)
          const arg = atomValue(stageNode.items?.[1]);
          if (arg === "key-off") {
            stages.push({ waitKeyOff: true });
          } else {
            const f = parseIntLike(arg);
            stages.push({ waitFrames: f ?? 1 });
          }
          continue;
        }
        const curveSpec = parseCurveSpec(stageNode);
        if (curveSpec) stages.push(curveSpec);
      }
      return { type: "stages", stages };
    }

    // Step-vector form: [15 :loop 14 13 :release 11 9 7 5 3 0 _ ...]
    // For MODE target, also accept noise mode symbols (white0-3, periodic0-3)
    const steps = [];
    let loopIndex = null;
    let releaseIndex = null;
    for (const item of items) {
      const val = atomValue(item);
      if (val === ":loop") {
        loopIndex = steps.length;
        continue;
      }
      if (val === ":release") {
        releaseIndex = steps.length;
        continue;
      }
      let n = parseIntLike(val);
      if (n === null && target === "NOISE_MODE" && val in NOISE_MODE_MAP) {
        n = NOISE_MODE_MAP[val];
      }
      if (n !== null) {
        steps.push(clampForTarget(target, n));
      } else if (val === "_") {
        steps.push(null); // hold: advance 1 frame, no write
      }
    }
    return { type: "steps", steps, loopIndex, releaseIndex };
  }
  // Curve form: (ease-out :from 15 :to 0 :len 1)
  if (node.kind === "list" && node.bracket === "()") {
    const curveSpec = parseCurveSpec(node);
    if (curveSpec) return { type: "curve", ...curveSpec };
  }
  return null;
}

function resolveShuffleTicks(nominalTicks, trackState) {
  if (
    trackState.shuffleRatio === 0 ||
    nominalTicks !== trackState.shuffleBase
  ) {
    return nominalTicks;
  }
  const pair = 2 * trackState.shuffleBase;
  const beat1 = Math.round((pair * trackState.shuffleRatio) / 100);
  const beat2 = pair - beat1;
  const ticks = trackState.subBeatParity === 0 ? beat1 : beat2;
  trackState.subBeatParity ^= 1;
  return ticks;
}

function isNoteAtom(val) {
  return typeof val === "string" && /^[a-g][+\-]?$/.test(val);
}

// Volume shift atom: "v+", "v-", "v+8", "v-16" etc.
function isVolShiftAtom(val) {
  return typeof val === "string" && /^v[+\-]\d*$/.test(val);
}

// Per-note length atom: "c4", "e8", "f+4.", "b-2" etc.
// Trailing number is the length denominator (+ optional dot), NOT octave.
function isPerNoteLengthAtom(val) {
  return typeof val === "string" && /^[a-g][+\-]?\d+\.?$/.test(val);
}

function parsePerNoteLength(val) {
  const m = val.match(/^([a-g][+\-]?)(\d+\.?)$/);
  if (!m) return null;
  return { noteName: m[1], lengthStr: m[2] };
}

/**
 * Parse an inline curve spec node, e.g. (ease-out :from 28 :to 20 :len 8).
 * Returns a PARAM_SWEEP args object or null if the node is not a curve form.
 */
function parseCurveSpec(node) {
  if (!node || node.kind !== "list" || !node.items || node.items.length === 0)
    return null;
  const head = atomValue(node.items[0]);
  if (!CURVE_NAMES.has(head)) return null;

  let from;
  let to;
  let frames;
  for (let j = 1; j < node.items.length; j++) {
    const k = atomValue(node.items[j]);
    if (k && k.startsWith(":") && j + 1 < node.items.length) {
      const v = atomValue(node.items[j + 1]);
      switch (k) {
        case ":from":
          from = parseIntLike(v);
          break;
        case ":to":
          to = parseIntLike(v);
          break;
        case ":len":
          frames = parseLengthToken(v, null);
          break;
      }
      j++;
    }
  }

  const spec = {
    curve: head,
    to: to ?? 0,
    loop: LOOP_CURVE_NAMES.has(head),
  };
  if (from !== null && from !== undefined) spec.from = from;
  if (frames !== null && frames !== undefined) spec.frames = frames;
  return spec;
}

function canonicalTarget(symbol) {
  const map = {
    // Sequencer / level
    ":vol": "VOL",
    ":master": "MASTER",
    ":tempo-scale": "TEMPO_SCALE",
    ":pitch": "NOTE_PITCH",
    // LFO
    ":lfo-rate": "LFO_RATE",
    // FM channel-level
    ":alg": "FM_ALG",
    ":fb": "FM_FB",
    ":ams": "FM_AMS",
    ":fms": "FM_FMS",
    ":pan": "PAN",
    ":mode": "NOISE_MODE",
    // FM operator params — :tl1–:tl4, :ar1–:ar4, etc.
    ...[1, 2, 3, 4].reduce((acc, op) => {
      acc[`:tl${op}`] = `FM_TL${op}`;
      acc[`:ar${op}`] = `FM_AR${op}`;
      acc[`:dr${op}`] = `FM_DR${op}`;
      acc[`:sr${op}`] = `FM_SR${op}`;
      acc[`:rr${op}`] = `FM_RR${op}`;
      acc[`:sl${op}`] = `FM_SL${op}`;
      acc[`:ml${op}`] = `FM_ML${op}`;
      acc[`:dt${op}`] = `FM_DT${op}`;
      acc[`:ks${op}`] = `FM_KS${op}`;
      acc[`:am${op}`] = `FM_AMEN${op}`;
      return acc;
    }, {}),
  };
  return (
    map[symbol] || symbol.replace(/^:/, "").toUpperCase().replace(/-/g, "_")
  );
}

const FM_OP_PARAMS = [
  "AR",
  "DR",
  "SR",
  "RR",
  "SL",
  "TL",
  "KS",
  "ML",
  "DT",
  "SSG",
  "AMEN",
];

function getVecInts(vecNode) {
  if (!vecNode || vecNode.kind !== "list") return [];
  return vecNode.items.map((item) => parseIntLike(atomValue(item)) ?? 0);
}

function emitVoice(td, tick, events, src) {
  if (td.tag === "fm") {
    emitFmPatch(td, tick, events, src);
    return true;
  }
  if (
    td.tag === "psg" &&
    td.envelope.subtype !== "hard" &&
    td.envelope.subtype !== "fn"
  ) {
    events.push({
      tick,
      cmd: "PSG_VOICE",
      args: { envelope: td.envelope },
      src,
    });
    return true;
  }
  return false;
}

function emitFmPatch(td, tick, events, src) {
  const chVals = getVecInts(td.algFb);
  const [alg, fb] = chVals;
  if (alg !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_ALG", value: alg },
      src,
    });
  if (fb !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_FB", value: fb },
      src,
    });
  if (chVals[2] !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_AMS", value: chVals[2] },
      src,
    });
  if (chVals[3] !== undefined)
    events.push({
      tick,
      cmd: "PARAM_SET",
      args: { target: "FM_FMS", value: chVals[3] },
      src,
    });
  for (let op = 0; op < 4; op++) {
    const vals = getVecInts(td.ops[op]);
    FM_OP_PARAMS.forEach((pname, pi) => {
      if (vals[pi] !== undefined)
        events.push({
          tick,
          cmd: "PARAM_SET",
          args: { target: `FM_${pname}${op + 1}`, value: vals[pi] },
          src,
        });
    });
  }
}

function pushDiag(diagnostics, severity, code, message, src, track) {
  diagnostics.push({
    severity,
    code,
    message,
    line: src?.line ?? 1,
    column: src?.column ?? 1,
    track,
  });
}

function getKeywordMap(items, startIndex) {
  const map = new Map();
  let i = startIndex;
  while (i < items.length) {
    const key = items[i];
    if (!(key && key.kind === "atom" && key.value.startsWith(":"))) {
      i += 1;
      continue;
    }
    const value = items[i + 1];
    if (!value) break;
    map.set(key.value, value);
    i += 2;
  }
  return map;
}

function nodeSrc(node) {
  return { line: node.line, column: node.column };
}

function parseSingleChannel(channelNode) {
  if (!channelNode) return "fm1";
  const val = atomValue(channelNode);
  return val ? val.replace(/^:/, "").toLowerCase() : "fm1";
}

const VALID_ROLES = new Set(["bgm", "se", "modulator", "chaos"]);
const VALID_WRITE_SCOPE = new Set(["notes", "fm-params", "ctrl", "reg", "any"]);

function parseTrackRole(options, diagnostics, trackName) {
  const roleNode = options.get(":role");
  if (!roleNode) return "bgm";
  const role = atomValue(roleNode)?.replace(/^:/, "");
  if (!role || !VALID_ROLES.has(role)) {
    pushDiag(
      diagnostics,
      "error",
      "E_TRACK_ROLE_INVALID",
      `Track role must be one of: ${[...VALID_ROLES].join(", ")}`,
      nodeSrc(roleNode),
      trackName,
    );
    return "bgm";
  }
  return role;
}

function parseWriteScope(options, diagnostics, trackName) {
  const scopeNode = options.get(":write");
  if (!scopeNode) return ["any"];
  const candidates = [];
  if (scopeNode.kind === "list") {
    for (const item of scopeNode.items) {
      const v = atomValue(item);
      if (v) candidates.push(v.replace(/^:/, ""));
    }
  } else {
    const v = atomValue(scopeNode);
    if (v) candidates.push(v.replace(/^:/, ""));
  }
  const valid = candidates.filter((s) => VALID_WRITE_SCOPE.has(s));
  const invalid = candidates.filter((s) => !VALID_WRITE_SCOPE.has(s));
  if (invalid.length > 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_WRITE_SCOPE_INVALID",
      `Unknown write scope values: ${invalid.join(", ")}`,
      nodeSrc(scopeNode),
      trackName,
    );
  }
  return valid.length > 0 ? valid : ["any"];
}

function parseTrackHead(items) {
  const options = new Map();
  let i = 1;
  while (i < items.length) {
    const item = items[i];
    const val = atomValue(item);
    if (
      val &&
      item.kind === "atom" &&
      TRACK_OPTION_KEYS.has(val) &&
      i + 1 < items.length
    ) {
      options.set(val, items[i + 1]);
      i += 2;
    } else {
      break;
    }
  }
  return { options, bodyStart: i };
}

/**
 * Unified v0.4 channel body compiler.
 * Processes notes, rests, inline modifiers, and structural forms directly
 * from an indexed item list. All state (oct, len, gate, vol) is sticky:
 * modifications persist in trackState across items and across channel forms.
 */
function compileChannelBody(
  items,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
  loopCounter,
) {
  let i = 0;
  while (i < items.length) {
    const node = items[i];
    if (!node) {
      i++;
      continue;
    }

    // Skip comments
    if (node.kind === "comment") {
      i++;
      continue;
    }

    // ── Atom items ───────────────────────────────────────────────────────
    if (node.kind === "atom") {
      const val = node.value;

      // Label marker: #name
      if (val.startsWith("#")) {
        const id = val.slice(1);
        if (!id) {
          pushDiag(
            diagnostics,
            "error",
            "E_LABEL_EMPTY",
            "label name must not be empty",
            nodeSrc(node),
            trackName,
          );
        } else {
          events.push({
            tick: trackState.tick,
            cmd: "MARKER",
            args: { id },
            src: nodeSrc(node),
          });
        }
        i++;
        continue;
      }

      // Inline keyword modifier: :oct N, :len N, :gate N, :vol N, :tl1 30, etc.
      if (val.startsWith(":")) {
        i++;
        if (i < items.length) {
          const rawVal = atomValue(items[i]);
          switch (val) {
            case ":oct": {
              const v = parseIntLike(rawVal);
              if (v !== null)
                trackState.defaultOct = Math.max(0, Math.min(8, v));
              break;
            }
            case ":len":
              trackState.defaultLength = parseLengthToken(
                rawVal,
                trackState.defaultLength,
              );
              break;
            case ":gate": {
              const g = parseGateSpec(rawVal);
              if (g !== null) trackState.defaultGate = g;
              break;
            }
            case ":vol": {
              const valueNode = items[i];
              const curveSpec = parseCurveSpec(valueNode);
              if (curveSpec) {
                events.push({
                  tick: trackState.tick,
                  cmd: "PARAM_SWEEP",
                  args: { target: "VOL", ...curveSpec },
                  src: nodeSrc(node),
                });
              } else {
                const v = parseIntLike(rawVal);
                if (v !== null) {
                  // v0.4: :vol range is 0-31 (was 0-15)
                  trackState.defaultVol = Math.max(0, Math.min(31, v));
                  events.push({
                    tick: trackState.tick,
                    cmd: "PARAM_SET",
                    args: { target: "VOL", value: trackState.defaultVol },
                    src: nodeSrc(node),
                  });
                }
              }
              break;
            }
            case ":vel": {
              // per-note velocity, KEY-ON scoped; stored as sticky state
              const v = parseIntLike(rawVal);
              if (v !== null)
                trackState.defaultVel = Math.max(0, Math.min(15, v));
              break;
            }
            case ":master": {
              const valueNode = items[i];
              const curveSpec = parseCurveSpec(valueNode);
              if (curveSpec) {
                events.push({
                  tick: trackState.tick,
                  cmd: "PARAM_SWEEP",
                  args: { target: "MASTER", ...curveSpec },
                  src: nodeSrc(node),
                });
              } else {
                // global master level, score-wide
                const v = parseIntLike(rawVal);
                if (v !== null) {
                  events.push({
                    tick: trackState.tick,
                    cmd: "PARAM_SET",
                    args: {
                      target: "MASTER",
                      value: Math.max(0, Math.min(31, v)),
                    },
                    src: nodeSrc(node),
                  });
                }
              }
              break;
            }
            case ":glide": {
              const v = parseIntLike(rawVal);
              if (v !== null) trackState.glide = Math.max(0, v);
              break;
            }
            case ":glide-from": {
              // override start pitch for next note only
              trackState.glideFrom = rawVal;
              break;
            }
            case ":macro":
              {
                // Three forms:
                // 1) :macro def-name          — single named def reference
                // 2) :macro :target spec       — single inline pair
                // 3) :macro [...]              — list of defs/inline pairs (Task 14)
                const macroNode = items[i]; // the node following :macro

                const applyMacroEntry = (irTarget, spec) => {
                  if (!spec || !SUPPORTED_TARGETS.has(irTarget)) return;
                  trackState.activeMacros[irTarget] = spec;
                  if (irTarget === "NOTE_PITCH") trackState.activePitchMacro = spec;
                  else if (irTarget === "VEL") trackState.activeVelMacro = spec;
                };

                if (
                  macroNode?.kind === "list" &&
                  macroNode.bracket === "[]"
                ) {
                  // Form 3: [list] — iterate entries, last write wins per target
                  const listItems = macroNode.items.filter(
                    (n) => n.kind !== "comment",
                  );
                  let j = 0;
                  while (j < listItems.length) {
                    const entryVal = atomValue(listItems[j]);
                    if (entryVal?.startsWith(":")) {
                      // inline :target spec pair
                      if (j + 1 < listItems.length) {
                        const irTarget = canonicalTarget(entryVal);
                        const spec = parseMacroSpec(listItems[j + 1], irTarget);
                        applyMacroEntry(irTarget, spec);
                        j += 2;
                      } else {
                        j++;
                      }
                    } else if (entryVal && typedDefs?.has(entryVal)) {
                      // named def reference
                      const td = typedDefs.get(entryVal);
                      if (td?.tag === "macro")
                        applyMacroEntry(td.target, td.spec);
                      j++;
                    } else {
                      j++;
                    }
                  }
                } else if (rawVal?.startsWith(":")) {
                  // Form 2: inline :target spec
                  if (i + 1 < items.length) {
                    const irTarget = canonicalTarget(rawVal);
                    const spec = parseMacroSpec(items[i + 1], irTarget);
                    applyMacroEntry(irTarget, spec);
                    i++;
                  }
                } else if (rawVal && typedDefs?.has(rawVal)) {
                  // Form 1: single named def
                  const td = typedDefs.get(rawVal);
                  if (td?.tag === "macro")
                    applyMacroEntry(td.target, td.spec);
                }
                break;
              }
              // :break inside (x N ...) — emit LOOP_BREAK linked to current loop
              // Note: :break as atom (not keyword pair) is handled separately;
              // here it appears as ":break" key with a dummy value consumed
              i--; // back up — :break has no value argument
              if (trackState.currentLoopId) {
                events.push({
                  tick: trackState.tick,
                  cmd: "LOOP_BREAK",
                  args: { id: trackState.currentLoopId },
                  src: nodeSrc(node),
                });
              }
              break;
            default: {
              // Inline hardware param write: :tl1 30, :ar1 28, etc.
              // Value may be a plain integer (PARAM_SET) or a curve form (PARAM_SWEEP).
              const target = canonicalTarget(val);
              if (!SUPPORTED_TARGETS.has(target)) break;
              const valueNode = items[i];
              const curveSpec = parseCurveSpec(valueNode);
              if (curveSpec) {
                events.push({
                  tick: trackState.tick,
                  cmd: "PARAM_SWEEP",
                  args: { target, ...curveSpec },
                  src: nodeSrc(node),
                });
              } else {
                const value = parseIntLike(rawVal) ?? 0;
                events.push({
                  tick: trackState.tick,
                  cmd: "PARAM_SET",
                  args: { target, value },
                  src: nodeSrc(node),
                });
              }
              break;
            }
          }
          i++;
        }
        continue;
      }

      // Octave shift
      if (val === ">") {
        trackState.defaultOct = Math.min(8, trackState.defaultOct + 1);
        i++;
        continue;
      }
      if (val === "<") {
        trackState.defaultOct = Math.max(0, trackState.defaultOct - 1);
        i++;
        continue;
      }

      // :break as standalone atom — emits LOOP_BREAK for current loop
      if (val === ":break") {
        if (trackState.currentLoopId) {
          events.push({
            tick: trackState.tick,
            cmd: "LOOP_BREAK",
            args: { id: trackState.currentLoopId },
            src: nodeSrc(node),
          });
        }
        i++;
        continue;
      }

      // Tie: ~ [optional-length]
      if (val === "~") {
        i++;
        let tieTicks = trackState.defaultLength;
        if (i < items.length) {
          const parsed = parseLengthToken(atomValue(items[i]), null);
          if (parsed !== null) {
            tieTicks = parsed;
            i++;
          }
        }
        events.push({
          tick: trackState.tick,
          cmd: "TIE",
          args: { length: tieTicks },
          src: nodeSrc(node),
        });
        trackState.tick += tieTicks;
        continue;
      }

      // Rest atom: "_", "_4", "_4.", "_14t", "_16f"
      if (isRestAtom(val)) {
        const ticks = resolveShuffleTicks(
          parseRestLength(val, trackState.defaultLength),
          trackState,
        );
        events.push({
          tick: trackState.tick,
          cmd: "REST",
          args: { length: ticks },
          src: nodeSrc(node),
        });
        trackState.tick += ticks;
        i++;
        continue;
      }

      // Volume shift: v+, v-, v+8, v-16
      if (isVolShiftAtom(val)) {
        const sign = val[1] === "+" ? 1 : -1;
        const delta = val.length > 2 ? parseInt(val.slice(2), 10) : 1;
        trackState.defaultVol = Math.max(
          0,
          Math.min(31, trackState.defaultVol + sign * delta),
        );
        events.push({
          tick: trackState.tick,
          cmd: "PARAM_SET",
          args: { target: "VOL", value: trackState.defaultVol },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Per-note length atom: c4, e8., f+4., b-2 (note name + explicit length)
      if (isPerNoteLengthAtom(val)) {
        const { noteName, lengthStr } = parsePerNoteLength(val);
        const perNoteTicks = parseLengthToken(
          lengthStr,
          trackState.defaultLength,
        );
        const fullPitch = noteName + trackState.defaultOct;
        // v0.4: emit glide PARAM_SWEEP before NOTE_ON if needed
        emitGlideIfNeeded(
          trackState,
          fullPitch,
          events,
          trackState.glide,
          nodeSrc(node),
        );
        events.push({
          tick: trackState.tick,
          cmd: "NOTE_ON",
          args: makeNoteArgs(
            fullPitch,
            perNoteTicks,
            trackState.defaultGate,
            trackState.defaultVel,
            trackState.activeMacros,
          ),
          src: nodeSrc(node),
        });
        trackState.tick += perNoteTicks;
        updateLastNotePitch(trackState, fullPitch);
        i++;
        continue;
      }

      // Bare note: c, d, e, f, g, a, b (with optional + or -)
      if (isNoteAtom(val)) {
        const ticks = resolveShuffleTicks(trackState.defaultLength, trackState);
        const fullPitch = val + trackState.defaultOct;
        // v0.4: emit glide PARAM_SWEEP before NOTE_ON if needed
        emitGlideIfNeeded(
          trackState,
          fullPitch,
          events,
          trackState.glide,
          nodeSrc(node),
        );
        events.push({
          tick: trackState.tick,
          cmd: "NOTE_ON",
          args: makeNoteArgs(
            fullPitch,
            ticks,
            trackState.defaultGate,
            trackState.defaultVel,
            trackState.activeMacros,
          ),
          src: nodeSrc(node),
        });
        trackState.tick += ticks;
        updateLastNotePitch(trackState, fullPitch);
        i++;
        continue;
      }

      // Bare identifier: typed def reference (voice/patch switch)
      if (typedDefs?.has(val)) {
        const td = typedDefs.get(val);
        if (td?.tag === "macro") {
          // bare identifier expands single-target def
          trackState.activeMacros[td.target] = td.spec;
          if (td.target === "NOTE_PITCH") trackState.activePitchMacro = td.spec;
          else if (td.target === "VEL") trackState.activeVelMacro = td.spec;
        } else {
          emitVoice(td, trackState.tick, events, nodeSrc(node));
        }
        i++;
        continue;
      }

      // Unknown atom — skip silently
      i++;
      continue;
    }

    // ── List items ───────────────────────────────────────────────────────
    if (node.kind === "list" && node.items.length > 0) {
      const head = atomValue(node.items[0]);
      if (!head) {
        i++;
        continue;
      }

      // Subgroup / tuplet: list starting with a note or per-note-length atom.
      // Tick duration is distributed among all elements using Bresenham method.
      if (isNoteAtom(head) || isPerNoteLengthAtom(head)) {
        const elems = node.items;
        const n = elems.length;
        const totalTicks = trackState.defaultLength;
        let acc = 0;
        for (let j = 0; j < n; j++) {
          acc += totalTicks;
          const slotTicks = Math.floor(acc / n);
          acc -= slotTicks * n;
          const ev = elems[j];
          const evVal = atomValue(ev);
          if (evVal === "_") {
            events.push({
              tick: trackState.tick,
              cmd: "REST",
              args: { length: slotTicks },
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
          } else if (isPerNoteLengthAtom(evVal)) {
            const { noteName } = parsePerNoteLength(evVal);
            const fullPitch = noteName + trackState.defaultOct;
            // v0.4: emit glide if needed
            emitGlideIfNeeded(
              trackState,
              fullPitch,
              events,
              trackState.glide,
              nodeSrc(ev),
            );
            events.push({
              tick: trackState.tick,
              cmd: "NOTE_ON",
              args: makeNoteArgs(
                fullPitch,
                slotTicks,
                trackState.defaultGate,
                trackState.defaultVel,
                trackState.activeMacros,
              ),
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
            updateLastNotePitch(trackState, fullPitch);
          } else if (isNoteAtom(evVal)) {
            const fullPitch = evVal + trackState.defaultOct;
            // v0.4: emit glide if needed
            emitGlideIfNeeded(
              trackState,
              fullPitch,
              events,
              trackState.glide,
              nodeSrc(ev),
            );
            events.push({
              tick: trackState.tick,
              cmd: "NOTE_ON",
              args: makeNoteArgs(
                fullPitch,
                slotTicks,
                trackState.defaultGate,
                trackState.defaultVel,
                trackState.activeMacros,
              ),
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
            updateLastNotePitch(trackState, fullPitch);
          }
        }
        i++;
        continue;
      }

      // Repeat loop: (x N ...) counts N times; (x ...) loops forever
      // :break inside the body emits LOOP_BREAK linked to this loop's id
      if (head === "x") {
        const maybeCount = parseIntLike(atomValue(node.items[1]));
        const bodyStart = maybeCount !== null ? 2 : 1;
        const loopId = `_x${loopCounter.count++}`;
        const savedLoopId = trackState.currentLoopId;
        trackState.currentLoopId = maybeCount !== null ? loopId : null; // only counted loops support :break
        if (maybeCount !== null) {
          events.push({
            tick: trackState.tick,
            cmd: "LOOP_BEGIN",
            args: { id: loopId },
            src: nodeSrc(node.items[0]),
          });
          compileChannelBody(
            node.items.slice(bodyStart),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
          );
          events.push({
            tick: trackState.tick,
            cmd: "LOOP_END",
            args: { id: loopId, repeat: maybeCount },
            src: nodeSrc(node.items[0]),
          });
          trackState.currentLoopId = savedLoopId;
        } else {
          events.push({
            tick: trackState.tick,
            cmd: "MARKER",
            args: { id: loopId },
            src: nodeSrc(node.items[0]),
          });
          compileChannelBody(
            node.items.slice(bodyStart),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
          );
          trackState.currentLoopId = savedLoopId;
          events.push({
            tick: trackState.tick,
            cmd: "JUMP",
            args: { to: loopId },
            src: nodeSrc(node.items[0]),
          });
        }
        i++;
        continue;
      }

      // Goto / counted goto: (goto label) or (goto label N)
      if (head === "goto") {
        const label = atomValue(node.items[1]);
        if (!label) {
          pushDiag(
            diagnostics,
            "error",
            "E_GOTO_NO_LABEL",
            "goto requires a label",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        const count = node.items[2]
          ? parseIntLike(atomValue(node.items[2]))
          : null;
        if (count !== null) {
          let markerIdx = -1;
          for (let mi = events.length - 1; mi >= 0; mi--) {
            if (events[mi].cmd === "MARKER" && events[mi].args.id === label) {
              markerIdx = mi;
              break;
            }
          }
          if (markerIdx >= 0) {
            events[markerIdx] = { ...events[markerIdx], cmd: "LOOP_BEGIN" };
          } else {
            pushDiag(
              diagnostics,
              "error",
              "E_GOTO_LABEL_NOT_FOUND",
              `goto: label '#${label}' not found before this point`,
              nodeSrc(node.items[0]),
              trackName,
            );
          }
          events.push({
            tick: trackState.tick,
            cmd: "LOOP_END",
            args: { id: label, repeat: count },
            src: nodeSrc(node.items[0]),
          });
        } else {
          events.push({
            tick: trackState.tick,
            cmd: "JUMP",
            args: { to: label },
            src: nodeSrc(node.items[0]),
          });
        }
        i++;
        continue;
      }

      // Explicit rest: (rest N) — kept for convenience
      if (head === "rest") {
        const length = parseLengthToken(
          atomValue(node.items[1]),
          trackState.defaultLength,
        );
        events.push({
          tick: trackState.tick,
          cmd: "REST",
          args: { length },
          src: nodeSrc(node.items[0]),
        });
        trackState.tick += length;
        i++;
        continue;
      }

      // Explicit tie: (tie N)
      if (head === "tie") {
        const length = parseLengthToken(
          atomValue(node.items[1]),
          trackState.defaultLength,
        );
        events.push({
          tick: trackState.tick,
          cmd: "TIE",
          args: { length },
          src: nodeSrc(node.items[0]),
        });
        trackState.tick += length;
        i++;
        continue;
      }

      // Param set: (param-set :target value ...)
      if (head === "param-set") {
        let j = 1;
        while (j + 1 < node.items.length) {
          const targetNode = node.items[j];
          const valueNode = node.items[j + 1];
          const target = canonicalTarget(atomValue(targetNode));
          const value = parseIntLike(atomValue(valueNode)) ?? 0;
          if (!SUPPORTED_TARGETS.has(target)) {
            pushDiag(
              diagnostics,
              "error",
              "E_UNSUPPORTED_TARGET",
              `Unsupported param-set target: ${target}`,
              nodeSrc(targetNode),
              trackName,
            );
          }
          events.push({
            tick: trackState.tick,
            cmd: "PARAM_SET",
            args: { target, value },
            src: nodeSrc(targetNode),
          });
          j += 2;
        }
        i++;
        continue;
      }
    }

    i++;
  }
}

// ── Legacy compileSeq (v0.3 compatibility) ───────────────────────────────────
function compileSeq(
  seqNode,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
) {
  let currentOct = trackState.defaultOct;
  let currentLen = trackState.defaultLength;
  let currentGate = trackState.defaultGate;
  let currentVol = trackState.defaultVol;

  let i = 1;
  while (i < seqNode.items.length) {
    const item = seqNode.items[i];
    const val = atomValue(item);

    // ── Subgroup: (e g a) → equal division of currentLen ───────────────
    if (item.kind === "list") {
      const elems = item.items ?? [];
      const n = elems.length;
      if (n > 0) {
        const totalTicks = currentLen;
        const base = Math.floor(totalTicks / n);
        let remainder = totalTicks - base * n;
        const savedLen = currentLen;
        for (let j = 0; j < n; j++) {
          const slotTicks = base + (j < remainder ? 1 : 0);
          currentLen = slotTicks;
          const ev = elems[j];
          const evVal = atomValue(ev);
          if (evVal === "_") {
            events.push({
              tick: trackState.tick,
              cmd: "REST",
              args: { length: slotTicks },
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
          } else if (isPerNoteLengthAtom(evVal)) {
            // Per-note length in subgroup: ignore the length suffix, use slot ticks
            const { noteName } = parsePerNoteLength(evVal);
            const fullPitch = noteName + currentOct;
            // v0.4: emit glide if trackState has glide active
            emitGlideIfNeeded(
              trackState,
              fullPitch,
              events,
              trackState.glide,
              nodeSrc(ev),
            );
            events.push({
              tick: trackState.tick,
              cmd: "NOTE_ON",
              args: makeNoteArgs(
                fullPitch,
                slotTicks,
                currentGate,
                trackState.defaultVel,
                trackState.activeMacros,
              ),
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
            updateLastNotePitch(trackState, fullPitch);
          } else if (isNoteAtom(evVal)) {
            const fullPitch = evVal + currentOct;
            // v0.4: emit glide if trackState has glide active
            emitGlideIfNeeded(
              trackState,
              fullPitch,
              events,
              trackState.glide,
              nodeSrc(ev),
            );
            events.push({
              tick: trackState.tick,
              cmd: "NOTE_ON",
              args: makeNoteArgs(
                fullPitch,
                slotTicks,
                currentGate,
                trackState.defaultVel,
                trackState.activeMacros,
              ),
              src: nodeSrc(ev),
            });
            trackState.tick += slotTicks;
            updateLastNotePitch(trackState, fullPitch);
          }
        }
        currentLen = savedLen;
      }
      i += 1;
      continue;
    }

    if (val === null || val === undefined) {
      i += 1;
      continue;
    }

    if (val === ":oct") {
      i += 1;
      if (i < seqNode.items.length) {
        const n = parseIntLike(atomValue(seqNode.items[i]));
        if (n !== null) currentOct = Math.max(0, Math.min(8, n));
        i += 1;
      }
      continue;
    }
    if (val === ":len") {
      i += 1;
      if (i < seqNode.items.length) {
        currentLen = parseLengthToken(atomValue(seqNode.items[i]), currentLen);
        i += 1;
      }
      continue;
    }
    if (val === ":gate") {
      i += 1;
      if (i < seqNode.items.length) {
        currentGate = parseGateSpec(atomValue(seqNode.items[i]));
        i += 1;
      }
      continue;
    }

    if (val === ">") {
      currentOct = Math.min(8, currentOct + 1);
      i += 1;
      continue;
    }
    if (val === "<") {
      currentOct = Math.max(0, currentOct - 1);
      i += 1;
      continue;
    }

    if (isVolShiftAtom(val)) {
      const sign = val[1] === "+" ? 1 : -1;
      const delta = val.length > 2 ? parseInt(val.slice(2), 10) : 1;
      currentVol = Math.max(0, Math.min(15, currentVol + sign * delta));
      events.push({
        tick: trackState.tick,
        cmd: "PARAM_SET",
        args: { target: "VOL", value: currentVol },
        src: nodeSrc(item),
      });
      i += 1;
      continue;
    }

    if (val === "~") {
      i += 1;
      let tieTicks = currentLen;
      if (i < seqNode.items.length) {
        const nextVal = atomValue(seqNode.items[i]);
        const parsed = parseLengthToken(nextVal, null);
        if (parsed !== null) {
          tieTicks = parsed;
          i += 1;
        }
      }
      events.push({
        tick: trackState.tick,
        cmd: "TIE",
        args: { length: tieTicks },
        src: nodeSrc(item),
      });
      trackState.tick += tieTicks;
      continue;
    }

    if (val === "_") {
      const ticks = resolveShuffleTicks(currentLen, trackState);
      events.push({
        tick: trackState.tick,
        cmd: "REST",
        args: { length: ticks },
        src: nodeSrc(item),
      });
      trackState.tick += ticks;
      i += 1;
      continue;
    }

    // ── Per-note length atom: c4, e8., f+4 etc. ────────────────────
    if (isPerNoteLengthAtom(val)) {
      const { noteName, lengthStr } = parsePerNoteLength(val);
      const perNoteTicks = parseLengthToken(lengthStr, currentLen);
      events.push({
        tick: trackState.tick,
        cmd: "NOTE_ON",
        args: makeNoteArgs(noteName + currentOct, perNoteTicks, currentGate),
        src: nodeSrc(item),
      });
      trackState.tick += perNoteTicks;
      i += 1;
      continue;
    }

    // ── @voice — inline voice switch ──────────────────────────────────
    if (val && val.startsWith("@")) {
      const voiceName = val.slice(1);
      if (voiceName && typedDefs?.has(voiceName)) {
        emitVoice(
          typedDefs.get(voiceName),
          trackState.tick,
          events,
          nodeSrc(item),
        );
      } else if (voiceName) {
        pushDiag(
          diagnostics,
          "warning",
          "W_VOICE_UNKNOWN",
          `seq @${voiceName}: unknown voice name`,
          nodeSrc(item),
          trackName,
        );
      }
      i += 1;
      continue;
    }

    // ── Bare note name: c, d, e, f, g, a, b (+ optional + or -) ──────
    if (isNoteAtom(val)) {
      const pitch = val + currentOct;
      const ticks = resolveShuffleTicks(currentLen, trackState);
      events.push({
        tick: trackState.tick,
        cmd: "NOTE_ON",
        args: makeNoteArgs(pitch, ticks, currentGate),
        src: nodeSrc(item),
      });
      trackState.tick += ticks;
      i += 1;
      continue;
    }

    i += 1;
  }
}

function compileTrackBodyItems(
  items,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
  loopCounter,
) {
  for (const node of items) {
    if (node && node.kind === "atom") {
      const val = node.value;
      if (val.startsWith("#")) {
        const id = val.slice(1);
        if (!id) {
          pushDiag(
            diagnostics,
            "error",
            "E_LABEL_EMPTY",
            "label name must not be empty",
            nodeSrc(node),
            trackName,
          );
        } else {
          events.push({
            tick: trackState.tick,
            cmd: "MARKER",
            args: { id },
            src: nodeSrc(node),
          });
        }
      } else if (val.startsWith("@")) {
        const voiceName = val.slice(1);
        if (voiceName && typedDefs?.has(voiceName)) {
          emitVoice(
            typedDefs.get(voiceName),
            trackState.tick,
            events,
            nodeSrc(node),
          );
        } else if (voiceName) {
          pushDiag(
            diagnostics,
            "warning",
            "W_VOICE_UNKNOWN",
            `@${voiceName}: unknown voice name`,
            nodeSrc(node),
            trackName,
          );
        }
      }
      continue;
    }

    if (!node || node.kind !== "list" || node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (!head) continue;

    if (head === "seq") {
      compileSeq(node, trackState, events, diagnostics, trackName, typedDefs);
      continue;
    }

    if (head === "x") {
      const maybeCount = parseIntLike(atomValue(node.items[1]));
      const bodyStart = maybeCount !== null ? 2 : 1;
      const loopId = `_x${loopCounter.count++}`;
      if (maybeCount !== null) {
        events.push({
          tick: trackState.tick,
          cmd: "LOOP_BEGIN",
          args: { id: loopId },
          src: nodeSrc(node.items[0]),
        });
        compileTrackBodyItems(
          node.items.slice(bodyStart),
          trackState,
          events,
          diagnostics,
          trackName,
          typedDefs,
          loopCounter,
        );
        events.push({
          tick: trackState.tick,
          cmd: "LOOP_END",
          args: { id: loopId, repeat: maybeCount },
          src: nodeSrc(node.items[0]),
        });
      } else {
        events.push({
          tick: trackState.tick,
          cmd: "MARKER",
          args: { id: loopId },
          src: nodeSrc(node.items[0]),
        });
        compileTrackBodyItems(
          node.items.slice(bodyStart),
          trackState,
          events,
          diagnostics,
          trackName,
          typedDefs,
          loopCounter,
        );
        events.push({
          tick: trackState.tick,
          cmd: "JUMP",
          args: { to: loopId },
          src: nodeSrc(node.items[0]),
        });
      }
      continue;
    }

    if (head === "goto") {
      const label = atomValue(node.items[1]);
      if (!label) {
        pushDiag(
          diagnostics,
          "error",
          "E_GOTO_NO_LABEL",
          "goto requires a label",
          nodeSrc(node.items[0]),
          trackName,
        );
        continue;
      }
      const count = node.items[2]
        ? parseIntLike(atomValue(node.items[2]))
        : null;
      if (count !== null) {
        let markerIdx = -1;
        for (let mi = events.length - 1; mi >= 0; mi--) {
          if (events[mi].cmd === "MARKER" && events[mi].args.id === label) {
            markerIdx = mi;
            break;
          }
        }
        if (markerIdx >= 0) {
          events[markerIdx] = { ...events[markerIdx], cmd: "LOOP_BEGIN" };
        } else {
          pushDiag(
            diagnostics,
            "error",
            "E_GOTO_LABEL_NOT_FOUND",
            `goto: label '#${label}' not found before this point`,
            nodeSrc(node.items[0]),
            trackName,
          );
        }
        events.push({
          tick: trackState.tick,
          cmd: "LOOP_END",
          args: { id: label, repeat: count },
          src: nodeSrc(node.items[0]),
        });
      } else {
        events.push({
          tick: trackState.tick,
          cmd: "JUMP",
          args: { to: label },
          src: nodeSrc(node.items[0]),
        });
      }
      continue;
    }

    if (head === "rest") {
      const length = parseLengthToken(
        atomValue(node.items[1]),
        trackState.defaultLength,
      );
      events.push({
        tick: trackState.tick,
        cmd: "REST",
        args: { length },
        src: nodeSrc(node.items[0]),
      });
      trackState.tick += length;
      continue;
    }

    if (head === "tie") {
      const length = parseLengthToken(
        atomValue(node.items[1]),
        trackState.defaultLength,
      );
      events.push({
        tick: trackState.tick,
        cmd: "TIE",
        args: { length },
        src: nodeSrc(node.items[0]),
      });
      trackState.tick += length;
      continue;
    }

    if (head === "default") {
      // (default :oct N :len val :gate val :vol N) — overwrite trackState defaults
      let j = 1;
      while (j < node.items.length) {
        const key = atomValue(node.items[j]);
        if (!key || !key.startsWith(":") || j + 1 >= node.items.length) {
          j += 1;
          continue;
        }
        const rawVal = atomValue(node.items[j + 1]);
        if (key === ":oct") {
          const v = parseIntLike(rawVal);
          if (v !== null) trackState.defaultOct = Math.max(0, Math.min(8, v));
        } else if (key === ":len") {
          trackState.defaultLength = parseLengthToken(
            rawVal,
            trackState.defaultLength,
          );
        } else if (key === ":gate") {
          const g = parseGateSpec(rawVal);
          if (g !== null) trackState.defaultGate = g;
        } else if (key === ":vol") {
          const v = parseIntLike(rawVal);
          if (v !== null) trackState.defaultVol = Math.max(0, Math.min(31, v));
        }
        j += 2;
      }
      continue;
    }

    if (head === "param-set") {
      let j = 1;
      while (j + 1 < node.items.length) {
        const targetNode = node.items[j];
        const valueNode = node.items[j + 1];
        const target = canonicalTarget(atomValue(targetNode));
        const value = parseIntLike(atomValue(valueNode)) ?? 0;
        if (!SUPPORTED_TARGETS.has(target)) {
          pushDiag(
            diagnostics,
            "error",
            "E_UNSUPPORTED_TARGET",
            `Unsupported param-set target: ${target}`,
            nodeSrc(targetNode),
            trackName,
          );
        }
        events.push({
          tick: trackState.tick,
          cmd: "PARAM_SET",
          args: { target, value },
          src: nodeSrc(targetNode),
        });
        j += 2;
      }
      continue;
    }
  }
}

function validateTrack(track, diagnostics) {
  const markers = new Map();
  const pendingJumps = [];

  for (const e of track.events) {
    if (e.cmd === "MARKER") {
      const id = e.args?.id;
      if (markers.has(id)) {
        pushDiag(
          diagnostics,
          "error",
          "E_MARKER_DUP",
          `Duplicate marker id: ${id}`,
          e.src,
          track.name,
        );
      } else {
        markers.set(id, true);
      }
    }
    if (e.cmd === "JUMP") {
      pendingJumps.push(e);
    }
  }

  for (const j of pendingJumps) {
    if (!markers.has(j.args.to)) {
      pushDiag(
        diagnostics,
        "error",
        "E_JUMP_UNRESOLVED",
        `Jump target marker not found: ${j.args.to}`,
        j.src,
        track.name,
      );
    }
  }
}

function buildSourceMap(tracks) {
  const lineToTick = new Map();
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      const line = ev.src?.line;
      if (line == null) continue;
      const cur = lineToTick.get(line);
      if (cur === undefined || ev.tick < cur) lineToTick.set(line, ev.tick);
    }
  }
  return [...lineToTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, tick]) => ({ line, tick }));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortObject(value[key]);
    return out;
  }
  return value;
}

function parsePsgVector(vecNode, name, diagnostics, src) {
  if (!vecNode || vecNode.kind !== "list" || vecNode.items.length === 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_PSG_VECTOR_EMPTY",
      `def :psg '${name}': envelope vector is missing or empty`,
      src,
      null,
    );
    return { subtype: "bare", steps: [], loopIndex: null, releaseRate: null };
  }
  const first = atomValue(vecNode.items[0]);

  if (first === ":fn") {
    pushDiag(
      diagnostics,
      "error",
      "E_FN_NOT_IMPL",
      `def :psg '${name}': :fn envelope is not implemented`,
      src,
      null,
    );
    return { subtype: "fn" };
  }
  if (first === ":hard") {
    pushDiag(
      diagnostics,
      "warning",
      "W_PSG_HARD_RESERVED",
      `def :psg '${name}': :hard envelope is reserved syntax — no IR generated`,
      src,
      null,
    );
    return { subtype: "hard" };
  }
  if (first === ":adsr") {
    const opts = getKeywordMap(vecNode.items, 1);
    return {
      subtype: "adsr",
      ar: parseIntLike(atomValue(opts.get(":ar"))) ?? 0,
      dr: parseIntLike(atomValue(opts.get(":dr"))) ?? 0,
      sl: parseIntLike(atomValue(opts.get(":sl"))) ?? 0,
      sr: parseIntLike(atomValue(opts.get(":sr"))) ?? 0,
      rr: parseIntLike(atomValue(opts.get(":rr"))) ?? 0,
    };
  }
  if (first === ":seq") {
    const steps = [];
    let loopIndex = null;
    let releaseRate = null;
    let i = 1;
    while (i < vecNode.items.length) {
      const val = atomValue(vecNode.items[i]);
      if (val === ":loop") {
        loopIndex = steps.length;
        i += 1;
        continue;
      }
      if (val === ":release") {
        i += 1;
        if (i < vecNode.items.length) {
          releaseRate = parseIntLike(atomValue(vecNode.items[i])) ?? 1;
          i += 1;
        }
        continue;
      }
      const n = parseIntLike(val);
      if (n !== null) steps.push(n);
      i += 1;
    }
    return { subtype: "seq", steps, loopIndex, releaseRate };
  }

  return {
    subtype: "bare",
    steps: vecNode.items.map((item) => parseIntLike(atomValue(item)) ?? 0),
    loopIndex: null,
    releaseRate: null,
  };
}

function collectDefs(roots, diagnostics) {
  const defs = new Map();
  const defns = new Map();
  const typedDefs = new Map();
  const remaining = [];

  for (const root of roots) {
    if (root.kind !== "list" || root.items.length < 2) {
      remaining.push(root);
      continue;
    }
    const head = atomValue(root.items[0]);

    if (head === "def") {
      const name = atomValue(root.items[1]);
      if (!name) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEF_NAME",
          "def name must be a symbol",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const maybeTag = atomValue(root.items[2]);
      if (maybeTag === ":fm") {
        const bodyItems = root.items.filter((n) => n.kind !== "comment");
        typedDefs.set(name, {
          tag: "fm",
          algFb: bodyItems[3],
          ops: [bodyItems[4], bodyItems[5], bodyItems[6], bodyItems[7]],
          src: nodeSrc(root),
        });
      } else if (maybeTag === ":psg") {
        const src = nodeSrc(root);
        const bodyItems = root.items.filter((n) => n.kind !== "comment");
        const parsed = parsePsgVector(bodyItems[3], name, diagnostics, src);
        typedDefs.set(name, { tag: "psg", envelope: parsed, src });
      } else if (maybeTag === ":macro") {
        const src = nodeSrc(root);
        const bodyItems = root.items.filter((n) => n.kind !== "comment");
        const macroTargetSym = atomValue(bodyItems[3]); // e.g. ":pitch" or ":vel"
        const irTarget = canonicalTarget(macroTargetSym);
        const spec = parseMacroSpec(bodyItems[4], irTarget);
        if (spec) {
          typedDefs.set(name, { tag: "macro", target: irTarget, spec, src });
        }
      } else {
        defs.set(
          name,
          root.items.slice(2).filter((n) => n.kind !== "comment"),
        );
      }
      continue;
    }

    if (head === "defn") {
      const name = atomValue(root.items[1]);
      if (!name) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEFN_NAME",
          "defn name must be a symbol",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const paramsNode = root.items.filter((n) => n.kind !== "comment")[2];
      if (
        !paramsNode ||
        paramsNode.kind !== "list" ||
        paramsNode.bracket !== "[]"
      ) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEFN_PARAMS",
          "defn params must be a [...] vector",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const params = paramsNode.items
        .map((item) => atomValue(item))
        .filter(Boolean);
      const body = root.items.slice(3);
      defns.set(name, { params, body, src: nodeSrc(root) });
      continue;
    }

    remaining.push(root);
  }

  return { defs, defns, typedDefs, remaining };
}

function substituteNode(node, bindings) {
  if (node.kind === "atom" && bindings.has(node.value)) {
    const replacement = bindings.get(node.value);
    return replacement ? { ...replacement } : node;
  }
  if (node.kind === "list") {
    return {
      ...node,
      items: node.items.map((item) => substituteNode(item, bindings)),
    };
  }
  return node;
}

function expandNode(node, defs, defns, depth) {
  if (depth > 16)
    throw new Error("Macro expansion depth exceeded (possible recursion)");
  if (node.kind === "atom" && defs.has(node.value))
    return defs.get(node.value).map((n) => ({ ...n }));
  if (node.kind !== "list") return [node];

  const head = atomValue(node.items[0]);
  if (head && defs.has(head) && node.items.length === 1)
    return defs.get(head).map((n) => ({ ...n }));
  if (head && defns.has(head)) {
    const { params, body } = defns.get(head);
    const args = node.items.slice(1);
    const bindings = new Map();
    for (let i = 0; i < params.length; i++)
      bindings.set(params[i], args[i] || null);
    const expanded = [];
    for (const bodyNode of body) {
      const substituted = substituteNode(bodyNode, bindings);
      expanded.push(...expandNode(substituted, defs, defns, depth + 1));
    }
    return expanded;
  }

  const newItems = [];
  for (const item of node.items)
    newItems.push(...expandNode(item, defs, defns, depth + 1));
  return [{ ...node, items: newItems }];
}

function expandRoots(roots, defs, defns) {
  const result = [];
  for (const root of roots) result.push(...expandNode(root, defs, defns, 0));
  return result;
}

/**
 * Compile MMLisp source string to IR.
 * @param {string} src - MMLisp source text
 * @param {string} [filename] - filename for metadata / source map
 * @returns {{ ir: object, diagnostics: array, sourceMap: array }}
 */
export function compileMMLisp(src, filename = "untitled.mmlisp") {
  const diagnostics = [];
  const parsed = parse(src);
  const { defs, defns, typedDefs, remaining } = collectDefs(
    parsed,
    diagnostics,
  );
  const roots = expandRoots(remaining, defs, defns);

  const score = roots.find(
    (node) =>
      node.kind === "list" &&
      node.items.length > 0 &&
      isAtom(node.items[0], "score"),
  );
  if (!score) throw new Error("No (score ...) form found");

  const scoreOptions = getKeywordMap(score.items, 1);
  const titleNode = scoreOptions.get(":title");
  const authorNode = scoreOptions.get(":author");
  const scoreTempoNode = scoreOptions.get(":tempo");
  const scoreLfoRateNode = scoreOptions.get(":lfo-rate");
  const scoreShuffleNode = scoreOptions.get(":shuffle");

  const rawScoreShuffle = parseIntLike(atomValue(scoreShuffleNode)) ?? 0;
  const scoreShuffleRatio =
    rawScoreShuffle >= 51 ? Math.min(90, rawScoreShuffle) : 0;

  // v0.4: Lists with a channel name as the form head are treated as tracks
  const CHANNEL_NAMES = [
    "fm1",
    "fm2",
    "fm3",
    "fm4",
    "fm5",
    "fm6",
    "sqr1",
    "sqr2",
    "sqr3",
    "noise",
  ];
  const trackByKey = new Map();
  const trackOrder = [];
  const loopCounter = { count: 0 };

  for (const node of score.items) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (!head || !CHANNEL_NAMES.includes(head)) continue;

    // v0.4: Use channel name as track key
    const trackKey = head;

    // Collect inline options (key-value pairs immediately after the channel name).
    // Only TRACK_OPTION_KEYS are consumed here; hardware param keys (:tl1, :ar1, etc.)
    // and other modifiers (:vel, :master, etc.) are left in the body for compileChannelBody.
    // Example: (fm1 :oct 4 :len 8 :vol 10  c d e f)
    //                ^^^^^^^^^^^^^^^^^^^^^^^^^^^ options
    let i = 1;
    const inlineOpts = {};
    while (i + 1 < node.items.length) {
      const key = atomValue(node.items[i]);
      if (!TRACK_OPTION_KEYS.has(key)) break;
      inlineOpts[key] = atomValue(node.items[i + 1]);
      i += 2;
    }
    // Body items start after the inline options
    const bodyItems = node.items.slice(i);

    if (!trackByKey.has(trackKey)) {
      // Initialize defaults; inline options on the first form set the initial state
      let defaultOct = 4;
      let defaultLength = Math.round(WHOLE_TICKS / 8);
      let defaultGate = null;
      let defaultVol = 31; // v0.4: default vol is 31 (no attenuation)
      let defaultVel = 15; // v0.4: default velocity 0-15
      let shuffleRatio = scoreShuffleRatio;
      let shuffleBase = Math.round(WHOLE_TICKS / 8);
      let carry = false;

      if (inlineOpts[":oct"] !== undefined) {
        const v = parseIntLike(inlineOpts[":oct"]);
        if (v !== null) defaultOct = Math.max(0, Math.min(8, v));
      }
      if (inlineOpts[":len"] !== undefined) {
        defaultLength = parseLengthToken(inlineOpts[":len"], defaultLength);
      }
      if (inlineOpts[":gate"] !== undefined) {
        const g = parseGateSpec(inlineOpts[":gate"]);
        if (g !== null) defaultGate = g;
      }
      if (inlineOpts[":vol"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vol"]);
        if (v !== null) defaultVol = Math.max(0, Math.min(31, v));
      }
      if (inlineOpts[":vel"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vel"]);
        if (v !== null) defaultVel = Math.max(0, Math.min(15, v));
      }
      if (inlineOpts[":shuffle"] !== undefined) {
        const rawTrackShuffle = parseIntLike(inlineOpts[":shuffle"]);
        if (rawTrackShuffle !== null) {
          shuffleRatio =
            rawTrackShuffle === 50
              ? 0
              : Math.max(51, Math.min(90, rawTrackShuffle));
        }
      }
      if (inlineOpts[":shuffle-base"] !== undefined) {
        shuffleBase = parseLengthToken(
          inlineOpts[":shuffle-base"],
          shuffleBase,
        );
      }
      if (inlineOpts[":carry"] !== undefined) {
        carry = inlineOpts[":carry"] === "true";
      }

      // All state is sticky and persists across consecutive forms of the same channel
      const trackState = {
        tick: 0,
        defaultLength,
        defaultOct,
        defaultGate,
        defaultVol,
        defaultVel, // v0.4: per-note velocity, KEY-ON scoped, 0-15
        activePitchMacro: null, // v0.4: KEY-ON scoped pitch macro attached to NOTE_ON (legacy)
        activeVelMacro: null, // v0.4: KEY-ON scoped vel macro attached to NOTE_ON (legacy)
        activeMacros: {}, // v0.4: unified macro map { target: spec, ... } for all targets
        glide: 0, // v0.4: glide duration in frames (0 = disabled)
        glideFrom: null, // v0.4: one-shot start pitch override for glide
        lastNotePitch: null, // v0.4: previous note's pitch for glide calculation
        shuffleRatio,
        shuffleBase,
        subBeatParity: 0,
        carry,
        currentLoopId: null, // id of innermost counted (x N ...) loop, for :break
      };

      const trackData = {
        id: trackOrder.length,
        channel: head,
        route_hint: {
          allocation_preference: "ordered_first_fit",
          carry,
          channel_candidates: [head],
          role: "bgm",
          write_scope: ["any"],
        },
        events: [],
      };

      // Emit initial VOL event if :vol was explicitly specified
      if (inlineOpts[":vol"] !== undefined) {
        trackData.events.push({
          tick: 0,
          cmd: "PARAM_SET",
          args: { target: "VOL", value: defaultVol },
          src: nodeSrc(node),
        });
      }

      trackByKey.set(trackKey, { trackData, trackState });
      trackOrder.push(trackKey);
    } else {
      // Update sticky state from inline options on subsequent forms of the same channel
      const { trackData, trackState } = trackByKey.get(trackKey);

      if (inlineOpts[":oct"] !== undefined) {
        const v = parseIntLike(inlineOpts[":oct"]);
        if (v !== null) trackState.defaultOct = Math.max(0, Math.min(8, v));
      }
      if (inlineOpts[":len"] !== undefined) {
        trackState.defaultLength = parseLengthToken(
          inlineOpts[":len"],
          trackState.defaultLength,
        );
      }
      if (inlineOpts[":gate"] !== undefined) {
        trackState.defaultGate = parseGateSpec(inlineOpts[":gate"]);
      }
      if (inlineOpts[":shuffle"] !== undefined) {
        const v = parseIntLike(inlineOpts[":shuffle"]);
        if (v !== null) {
          trackState.shuffleRatio =
            v === 50 ? 0 : Math.max(51, Math.min(90, v));
          trackState.subBeatParity = 0;
        }
      }
      if (inlineOpts[":vol"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vol"]);
        if (v !== null) {
          trackState.defaultVol = Math.max(0, Math.min(31, v));
          trackData.events.push({
            tick: trackState.tick,
            cmd: "PARAM_SET",
            args: { target: "VOL", value: trackState.defaultVol },
            src: nodeSrc(node),
          });
        }
      }
      if (inlineOpts[":vel"] !== undefined) {
        const v = parseIntLike(inlineOpts[":vel"]);
        if (v !== null) trackState.defaultVel = Math.max(0, Math.min(15, v));
      }
    }

    const { trackData, trackState } = trackByKey.get(trackKey);
    compileChannelBody(
      bodyItems,
      trackState,
      trackData.events,
      diagnostics,
      trackKey,
      typedDefs,
      loopCounter,
    );
  }

  const tracks = trackOrder.map((key) => trackByKey.get(key).trackData);

  for (const track of tracks) validateTrack(track, diagnostics);

  if (tracks.length > 0) {
    const initEvents = [];
    const scoreSrc = nodeSrc(score);
    const lfoRateVal = parseIntLike(atomValue(scoreLfoRateNode));
    if (lfoRateVal !== null) {
      initEvents.push({
        tick: 0,
        cmd: "PARAM_SET",
        args: { target: "LFO_RATE", value: lfoRateVal },
        src: scoreSrc,
      });
    }
    const scoreTempoVal = parseIntLike(atomValue(scoreTempoNode));
    if (scoreTempoVal !== null) {
      initEvents.push({
        tick: 0,
        cmd: "TEMPO_SET",
        args: { bpm: scoreTempoVal },
        src: scoreSrc,
      });
    }
    if (initEvents.length > 0) tracks[0].events.unshift(...initEvents);
  }

  const bgmChannels = new Set();
  for (const track of tracks) {
    if (track.route_hint.role === "bgm") {
      const ch = track.route_hint.channel_candidates[0];
      if (bgmChannels.has(ch)) {
        pushDiag(
          diagnostics,
          "warning",
          "W_SAME_CH_BGM",
          `Two bgm tracks share channel ${ch}`,
          { line: 1, column: 1 },
          ch,
        );
      } else {
        bgmChannels.add(ch);
      }
    }
  }

  const ir = sortObject({
    version: 1,
    ppqn: PPQN,
    metadata: {
      title: atomValue(titleNode) || filename,
      author: atomValue(authorNode) || "unknown",
      source: filename,
    },
    tracks,
  });

  return { ir, diagnostics, sourceMap: buildSourceMap(tracks) };
}
