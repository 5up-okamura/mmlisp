#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("./mmlisp_parser");

const PPQN = 120;
const WHOLE_TICKS = PPQN * 4;
const SUPPORTED_TARGETS = new Set([
  "NOTE_PITCH",
  "NOTE_VOLUME",
  "TEMPO_SCALE",
  "VOL",
  "FM_ALG",
  "FM_FB",
  "FM_AMS",
  "FM_FMS",
  "LFO_RATE",
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

// Track-level option keywords (whitelist for option vs body discrimination)
const TRACK_OPTION_KEYS = new Set([
  ":ch",
  ":role",
  ":oct",
  ":len",
  ":gate",
  ":carry",
  ":shuffle",
  ":shuffle-base",
  ":write",
]);

// Block-level option keywords
const BLOCK_OPTION_KEYS = new Set([":oct", ":len", ":gate"]);

function usage() {
  console.error(
    "Usage: node scripts/mmlisp2ir.js <input.mmlisp> [--out <file>] [--diag-out <file>] [--strict] [--pretty]",
  );
}

function atomValue(node) {
  if (!node) {
    return null;
  }
  if (node.kind === "atom" || node.kind === "string") {
    return node.value;
  }
  return null;
}

function isAtom(node, value) {
  return node && node.kind === "atom" && node.value === value;
}

function parseIntLike(value) {
  if (typeof value !== "string") {
    return null;
  }
  if (/^[+-]?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function parseLengthToken(value, inheritedTicks) {
  if (!value) {
    return inheritedTicks;
  }
  if (/^\d+\/\d+$/.test(value)) {
    const [n, d] = value.split("/").map((v) => Number.parseInt(v, 10));
    return Math.round((WHOLE_TICKS * n) / d);
  }
  if (/^\d+$/.test(value)) {
    return Math.round((WHOLE_TICKS * 1) / Number.parseInt(value, 10));
  }
  return inheritedTicks;
}

/**
 * Parse a gate specification.
 * Returns { type: 'ratio', value: 0.0-1.0 } or { type: 'ticks', value: N } or null.
 * null means full gate (1.0 / legato) — no NOTE_OFF, no gate field in IR.
 */
function parseGateSpec(val) {
  if (typeof val !== "string") return null;
  if (val.includes(".")) {
    const f = parseFloat(val);
    if (isNaN(f) || f < 0 || f > 1) return null;
    if (f >= 1.0) return null;
    return { type: "ratio", value: f };
  }
  const n = parseIntLike(val);
  if (n === null || n < 0) return null;
  return { type: "ticks", value: n };
}

function resolveGateTicks(gateSpec, lengthTicks) {
  if (!gateSpec) return lengthTicks;
  if (gateSpec.type === "ratio")
    return Math.round(lengthTicks * gateSpec.value);
  return gateSpec.value;
}

function makeNoteArgs(pitch, lengthTicks, gateSpec) {
  const gateTicks = resolveGateTicks(gateSpec, lengthTicks);
  const args = { pitch, length: lengthTicks };
  if (gateTicks < lengthTicks) {
    args.gate = gateTicks;
  }
  return args;
}

/**
 * Resolve a step length with shuffle applied.
 * Modifies trackState.subBeatParity in-place when shuffle is active.
 */
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

/** Returns true if the atom value is a bare note name (c, d#, bb, etc.) */
function isNoteAtom(val) {
  return typeof val === "string" && /^[a-g][#b]?$/.test(val);
}

/** Returns true if the atom value is an absolute pitch keyword (:c4, :d#3, :bb5) */
function isAbsPitchAtom(val) {
  return typeof val === "string" && /^:[a-g][#b]?\d$/.test(val);
}

// ---------------------------------------------------------------------------
// Canonical target mapping
// ---------------------------------------------------------------------------

function canonicalTarget(symbol) {
  const map = {
    ":vol": "VOL",
    ":fm-alg": "FM_ALG",
    ":fm-fb": "FM_FB",
    ":fm-tl1": "FM_TL1",
    ":fm-tl2": "FM_TL2",
    ":fm-tl3": "FM_TL3",
    ":fm-tl4": "FM_TL4",
    ":fm-ar1": "FM_AR1",
    ":fm-ar2": "FM_AR2",
    ":fm-ar3": "FM_AR3",
    ":fm-ar4": "FM_AR4",
    ":fm-dr1": "FM_DR1",
    ":fm-dr2": "FM_DR2",
    ":fm-dr3": "FM_DR3",
    ":fm-dr4": "FM_DR4",
    ":fm-sr1": "FM_SR1",
    ":fm-sr2": "FM_SR2",
    ":fm-sr3": "FM_SR3",
    ":fm-sr4": "FM_SR4",
    ":fm-rr1": "FM_RR1",
    ":fm-rr2": "FM_RR2",
    ":fm-rr3": "FM_RR3",
    ":fm-rr4": "FM_RR4",
    ":fm-sl1": "FM_SL1",
    ":fm-sl2": "FM_SL2",
    ":fm-sl3": "FM_SL3",
    ":fm-sl4": "FM_SL4",
    ":fm-ml1": "FM_ML1",
    ":fm-ml2": "FM_ML2",
    ":fm-ml3": "FM_ML3",
    ":fm-ml4": "FM_ML4",
    ":fm-dt1": "FM_DT1",
    ":fm-dt2": "FM_DT2",
    ":fm-dt3": "FM_DT3",
    ":fm-dt4": "FM_DT4",
    ":fm-ssg1": "FM_SSG1",
    ":fm-ssg2": "FM_SSG2",
    ":fm-ssg3": "FM_SSG3",
    ":fm-ssg4": "FM_SSG4",
    ":fm-amen1": "FM_AMEN1",
    ":fm-amen2": "FM_AMEN2",
    ":fm-amen3": "FM_AMEN3",
    ":fm-amen4": "FM_AMEN4",
    ":fm-ams": "FM_AMS",
    ":fm-fms": "FM_FMS",
    ":lfo-rate": "LFO_RATE",
    ":tempo-scale": "TEMPO_SCALE",
    ":note-pitch": "NOTE_PITCH",
    ":note-volume": "NOTE_VOLUME",
  };
  return (
    map[symbol] || symbol.replace(/^:/, "").toUpperCase().replace(/-/g, "_")
  );
}

// FM_OP_PARAMS: order must match spec 1.2 vector layout [AR DR SR RR SL TL KS ML DT (SSG) (AMEN)]
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

/** Emit PARAM_SET events for a :fm typed def at the current tick. */
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

// ---------------------------------------------------------------------------
// Diagnostics / utility
// ---------------------------------------------------------------------------

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
    if (!value) {
      break;
    }
    map.set(key.value, value);
    i += 2;
  }
  return map;
}

function nodeSrc(node) {
  return { line: node.line, column: node.column };
}

// ---------------------------------------------------------------------------
// Channel / role / write-scope parsing
// ---------------------------------------------------------------------------

/** Parse a single channel name (v0.3: array syntax removed). */
function parseSingleChannel(channelNode, diagnostics, trackName) {
  if (!channelNode) return "fm1";
  if (channelNode.kind === "list") {
    pushDiag(
      diagnostics,
      "error",
      "E_CH_ARRAY_REMOVED",
      "Multi-channel :ch array syntax is removed in v0.3; use a single channel name",
      nodeSrc(channelNode),
      trackName,
    );
    const first = atomValue(channelNode.items[0]);
    return first ? first.replace(/^:/, "").toLowerCase() : "fm1";
  }
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

// ---------------------------------------------------------------------------
// Track head parser: options + body start index
// ---------------------------------------------------------------------------

/**
 * Parse track options from items[2..].
 * Consumes known TRACK_OPTION_KEYS as key-value pairs until a non-option is seen.
 * Returns { options: Map, bodyStart: number }.
 */
function parseTrackHead(items) {
  const options = new Map();
  let i = 2;
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

// ---------------------------------------------------------------------------
// seq compiler
// ---------------------------------------------------------------------------

/**
 * Compile a (seq ...) form.
 * Modifies trackState.tick in-place.
 */
function compileSeq(seqNode, trackState, events, diagnostics, trackName) {
  // Local seq state starts from track defaults
  let currentOct = trackState.defaultOct;
  let currentLen = trackState.defaultLength;
  let currentGate = trackState.defaultGate;

  let i = 1; // skip "seq"
  while (i < seqNode.items.length) {
    const item = seqNode.items[i];
    const val = atomValue(item);

    if (val === null || val === undefined) {
      i += 1;
      continue;
    }

    // ── State modifiers ────────────────────────────────────────────────
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

    // ── Octave shift (persistent) ──────────────────────────────────────
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

    // ── Tie ────────────────────────────────────────────────────────────
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

    // ── Rest ───────────────────────────────────────────────────────────
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

    // ── Absolute pitch: :c4, :d#3, :bb5, etc. ─────────────────────────
    if (isAbsPitchAtom(val)) {
      const pitch = val.slice(1); // strip ':'
      const octChar = pitch.match(/\d$/);
      if (octChar) currentOct = parseInt(octChar[0], 10);
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

    // ── Bare note name: c, d, e, f, g, a, b (+ optional # or b) ──────
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

// ---------------------------------------------------------------------------
// Track body item compiler
// ---------------------------------------------------------------------------

/**
 * Compile a list of track body items.
 * Mutates trackState.tick and appends to events.
 */
function compileTrackBodyItems(
  items,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
  blocks,
  loopCounter,
) {
  for (const node of items) {
    // ── Atom: block reference (:blockname) ──────────────────────────
    if (node && node.kind === "atom") {
      const val = node.value;
      if (val.startsWith(":")) {
        compileBlockRef(
          val.slice(1),
          node,
          trackState,
          events,
          diagnostics,
          trackName,
          typedDefs,
          blocks,
          loopCounter,
        );
      }
      continue;
    }

    if (!node || node.kind !== "list" || node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (!head) continue;

    // ── Removed forms ────────────────────────────────────────────────
    if (head === "phrase") {
      pushDiag(
        diagnostics,
        "error",
        "E_PHRASE_REMOVED",
        "`phrase` is removed in v0.3; write note commands directly in the track body",
        nodeSrc(node.items[0]),
        trackName,
      );
      continue;
    }

    if (head === "note" || head === "notes") {
      pushDiag(
        diagnostics,
        "error",
        "E_NOTE_REMOVED",
        `\`${head}\` is removed in v0.3; use \`seq\` with bare note names`,
        nodeSrc(node.items[0]),
        trackName,
      );
      continue;
    }

    // ── seq ──────────────────────────────────────────────────────────
    if (head === "seq") {
      compileSeq(node, trackState, events, diagnostics, trackName);
      continue;
    }

    // ── x N body... (compact loop) ───────────────────────────────────
    if (head === "x") {
      const count = parseIntLike(atomValue(node.items[1])) ?? 2;
      const loopId = `_x${loopCounter.count++}`;
      events.push({
        tick: trackState.tick,
        cmd: "LOOP_BEGIN",
        args: { id: loopId },
        src: nodeSrc(node.items[0]),
      });
      compileTrackBodyItems(
        node.items.slice(2),
        trackState,
        events,
        diagnostics,
        trackName,
        typedDefs,
        blocks,
        loopCounter,
      );
      events.push({
        tick: trackState.tick,
        cmd: "LOOP_END",
        args: { id: loopId, repeat: count },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    // ── tempo N (inline tempo change) ────────────────────────────────
    if (head === "tempo") {
      const bpm = parseIntLike(atomValue(node.items[1]));
      if (bpm !== null) {
        events.push({
          tick: trackState.tick,
          cmd: "TEMPO_SET",
          args: { bpm },
          src: nodeSrc(node.items[0]),
        });
      }
      continue;
    }

    // ── rest N ───────────────────────────────────────────────────────
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

    // ── tie N ────────────────────────────────────────────────────────
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

    // ── marker :id ───────────────────────────────────────────────────
    if (head === "marker") {
      const id = atomValue(node.items[1]);
      events.push({
        tick: trackState.tick,
        cmd: "MARKER",
        args: { id: id ? id.replace(/^:/, "") : "unknown" },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    // ── jump :target ─────────────────────────────────────────────────
    if (head === "jump") {
      const target = atomValue(node.items[1]);
      events.push({
        tick: trackState.tick,
        cmd: "JUMP",
        args: { to: target ? target.replace(/^:/, "") : "unknown" },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    // ── param-set :target value ... ──────────────────────────────────
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

    // ── param-add :target delta ... ──────────────────────────────────
    if (head === "param-add") {
      let j = 1;
      while (j + 1 < node.items.length) {
        const targetNode = node.items[j];
        const deltaNode = node.items[j + 1];
        const target = canonicalTarget(atomValue(targetNode));
        const delta = parseIntLike(atomValue(deltaNode)) ?? 0;
        if (!SUPPORTED_TARGETS.has(target)) {
          pushDiag(
            diagnostics,
            "error",
            "E_UNSUPPORTED_TARGET",
            `Unsupported param-add target: ${target}`,
            nodeSrc(targetNode),
            trackName,
          );
        }
        events.push({
          tick: trackState.tick,
          cmd: "PARAM_ADD",
          args: { target, delta },
          src: nodeSrc(targetNode),
        });
        j += 2;
      }
      continue;
    }

    // ── loop-begin :id ───────────────────────────────────────────────
    if (head === "loop-begin") {
      const id = atomValue(node.items[1]);
      events.push({
        tick: trackState.tick,
        cmd: "LOOP_BEGIN",
        args: { id: id ? id.replace(/^:/, "") : "loop" },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    // ── loop-end :id N ───────────────────────────────────────────────
    if (head === "loop-end") {
      const id = atomValue(node.items[1]);
      const repeat = parseIntLike(atomValue(node.items[2])) ?? 2;
      events.push({
        tick: trackState.tick,
        cmd: "LOOP_END",
        args: { id: id ? id.replace(/^:/, "") : "loop", repeat },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    // ── ins voiceName ────────────────────────────────────────────────
    if (head === "ins") {
      const voiceName = atomValue(node.items[1])?.replace(/^:/, "");
      if (voiceName && typedDefs?.has(voiceName)) {
        const td = typedDefs.get(voiceName);
        if (td.tag === "fm") {
          emitFmPatch(td, trackState.tick, events, nodeSrc(node.items[0]));
        } else if (
          td.tag === "psg" &&
          td.envelope.subtype !== "hard" &&
          td.envelope.subtype !== "fn"
        ) {
          events.push({
            tick: trackState.tick,
            cmd: "PSG_VOICE",
            args: { envelope: td.envelope },
            src: nodeSrc(node.items[0]),
          });
        }
      } else if (voiceName) {
        pushDiag(
          diagnostics,
          "warning",
          "W_INS_UNKNOWN",
          `ins: unknown voice name '${voiceName}'`,
          nodeSrc(node.items[0]),
          trackName,
        );
      }
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Block reference expansion
// ---------------------------------------------------------------------------

/**
 * Expand a block reference inside a track body.
 * Block's declared opts override trackState defaults for the duration;
 * tick advances normally and is NOT restored after the block.
 */
function compileBlockRef(
  blockName,
  refNode,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
  blocks,
  loopCounter,
) {
  const block = blocks.get(blockName);
  if (!block) {
    pushDiag(
      diagnostics,
      "error",
      "E_BLOCK_UNKNOWN",
      `Unknown block: '${blockName}'`,
      nodeSrc(refNode),
      trackName,
    );
    return;
  }

  // Save track defaults
  const savedOct = trackState.defaultOct;
  const savedLen = trackState.defaultLength;
  const savedGate = trackState.defaultGate;

  // Apply block's declared overrides (§2.4 hybrid: declared overrides, undeclared inherits)
  if (block.declaredOpts.has(":oct")) {
    const v = parseIntLike(atomValue(block.declaredOpts.get(":oct")));
    if (v !== null) trackState.defaultOct = Math.max(0, Math.min(8, v));
  }
  if (block.declaredOpts.has(":len")) {
    trackState.defaultLength = parseLengthToken(
      atomValue(block.declaredOpts.get(":len")),
      trackState.defaultLength,
    );
  }
  if (block.declaredOpts.has(":gate")) {
    trackState.defaultGate = parseGateSpec(
      atomValue(block.declaredOpts.get(":gate")),
    );
  }

  compileTrackBodyItems(
    block.bodyItems,
    trackState,
    events,
    diagnostics,
    trackName,
    typedDefs,
    blocks,
    loopCounter,
  );

  // Restore defaults (tick and subBeatParity are NOT restored)
  trackState.defaultOct = savedOct;
  trackState.defaultLength = savedLen;
  trackState.defaultGate = savedGate;
}

// ---------------------------------------------------------------------------
// Track validation
// ---------------------------------------------------------------------------

function validateTrack(track, diagnostics) {
  const markers = new Map();
  const pendingJumps = [];
  const loopStack = [];

  for (const e of track.events) {
    if (e.cmd === "MARKER") {
      const id = e.args?.id;
      if (!id || id === "unknown") {
        pushDiag(
          diagnostics,
          "error",
          "E_MARKER_ID",
          "Marker id is missing or invalid",
          e.src,
          track.name,
        );
      } else if (markers.has(id)) {
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
      const to = e.args?.to;
      if (!to || to === "unknown") {
        pushDiag(
          diagnostics,
          "error",
          "E_JUMP_TARGET",
          "Jump target is missing or invalid",
          e.src,
          track.name,
        );
      } else {
        pendingJumps.push(e);
      }
    }

    if (e.cmd === "LOOP_BEGIN") {
      const id = e.args?.id;
      if (!id) {
        pushDiag(
          diagnostics,
          "error",
          "E_LOOP_ID",
          "Loop begin id is missing or invalid",
          e.src,
          track.name,
        );
      }
      loopStack.push({ id, src: e.src });
    }

    if (e.cmd === "LOOP_END") {
      const id = e.args?.id;
      if (loopStack.length === 0) {
        pushDiag(
          diagnostics,
          "error",
          "E_LOOP_END_ORPHAN",
          `Loop end has no matching begin: ${id || "unknown"}`,
          e.src,
          track.name,
        );
      } else {
        const begin = loopStack.pop();
        if (begin.id !== id) {
          pushDiag(
            diagnostics,
            "error",
            "E_LOOP_MISMATCH",
            `Loop end id ${id || "unknown"} does not match begin id ${begin.id || "unknown"}`,
            e.src,
            track.name,
          );
        }
      }
    }
  }

  while (loopStack.length > 0) {
    const begin = loopStack.pop();
    pushDiag(
      diagnostics,
      "error",
      "E_LOOP_UNCLOSED",
      `Loop begin is not closed: ${begin.id || "unknown"}`,
      begin.src,
      track.name,
    );
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

// ---------------------------------------------------------------------------
// Source map + utilities
// ---------------------------------------------------------------------------

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
    for (const key of Object.keys(value).sort()) {
      out[key] = sortObject(value[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// PSG vector parser
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// collectDefs — gather def / defn / block forms
// ---------------------------------------------------------------------------

function collectDefs(roots, diagnostics) {
  const defs = new Map();
  const defns = new Map();
  const typedDefs = new Map();
  const blocks = new Map();
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
        typedDefs.set(name, {
          tag: "fm",
          algFb: root.items[3],
          ops: [root.items[4], root.items[5], root.items[6], root.items[7]],
          src: nodeSrc(root),
        });
      } else if (maybeTag === ":psg") {
        const src = nodeSrc(root);
        const parsed = parsePsgVector(root.items[3], name, diagnostics, src);
        typedDefs.set(name, { tag: "psg", envelope: parsed, src });
      } else {
        defs.set(name, root.items[2]);
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
      const paramsNode = root.items[2];
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

    if (head === "block") {
      // (block :name :opt val ... body-items...)
      const nameNode = root.items[1];
      const rawName = atomValue(nameNode);
      if (!rawName) {
        pushDiag(
          diagnostics,
          "error",
          "E_BLOCK_NAME",
          "block name must be a :keyword symbol",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const blockName = rawName.replace(/^:/, "");
      const declaredOpts = new Map();
      let i = 2;
      while (i < root.items.length) {
        const item = root.items[i];
        const val = atomValue(item);
        if (
          val &&
          item.kind === "atom" &&
          BLOCK_OPTION_KEYS.has(val) &&
          i + 1 < root.items.length
        ) {
          declaredOpts.set(val, root.items[i + 1]);
          i += 2;
        } else {
          break;
        }
      }
      blocks.set(blockName, {
        declaredOpts,
        bodyItems: root.items.slice(i),
        src: nodeSrc(root),
      });
      continue;
    }

    remaining.push(root);
  }

  return { defs, defns, typedDefs, blocks, remaining };
}

// ---------------------------------------------------------------------------
// Macro expansion
// ---------------------------------------------------------------------------

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
  if (depth > 16) {
    throw new Error("Macro expansion depth exceeded (possible recursion)");
  }
  if (node.kind === "atom" && defs.has(node.value)) {
    return [{ ...defs.get(node.value) }];
  }
  if (node.kind !== "list") return [node];

  const head = atomValue(node.items[0]);
  if (head && defns.has(head)) {
    const { params, body } = defns.get(head);
    const args = node.items.slice(1);
    const bindings = new Map();
    for (let i = 0; i < params.length; i += 1) {
      bindings.set(params[i], args[i] || null);
    }
    const expanded = [];
    for (const bodyNode of body) {
      const substituted = substituteNode(bodyNode, bindings);
      expanded.push(...expandNode(substituted, defs, defns, depth + 1));
    }
    return expanded;
  }

  const newItems = [];
  for (const item of node.items) {
    newItems.push(...expandNode(item, defs, defns, depth + 1));
  }
  return [{ ...node, items: newItems }];
}

function expandRoots(roots, defs, defns) {
  const result = [];
  for (const root of roots) {
    result.push(...expandNode(root, defs, defns, 0));
  }
  return result;
}

// ---------------------------------------------------------------------------
// compileDetailed — main entry point
// ---------------------------------------------------------------------------

function compileDetailed(inputPath) {
  const diagnostics = [];
  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = parse(raw);
  const { defs, defns, typedDefs, blocks, remaining } = collectDefs(
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

  // Score-level shuffle (50 = straight = off)
  const rawScoreShuffle = parseIntLike(atomValue(scoreShuffleNode)) ?? 0;
  const scoreShuffleRatio =
    rawScoreShuffle >= 51 ? Math.min(90, rawScoreShuffle) : 0;

  // Track append state: name → { trackData, trackState }
  const trackByName = new Map();
  const trackOrder = [];
  const loopCounter = { count: 0 };

  for (const node of score.items) {
    if (
      !node ||
      node.kind !== "list" ||
      node.items.length === 0 ||
      !isAtom(node.items[0], "track")
    )
      continue;

    const nameNode = node.items[1];
    const rawName = atomValue(nameNode);
    const trackName = rawName ? rawName.replace(/^:/, "") : null;

    if (!trackName) {
      pushDiag(
        diagnostics,
        "error",
        "E_TRACK_NAME",
        "track must have a name as its first argument",
        nodeSrc(node),
        null,
      );
      continue;
    }

    const { options, bodyStart } = parseTrackHead(node.items);
    const bodyItems = node.items.slice(bodyStart);

    if (!trackByName.has(trackName)) {
      // ── First occurrence: initialize track ──────────────────────────
      const channelNode = options.get(":ch");
      const channel = parseSingleChannel(channelNode, diagnostics, trackName);
      const role = parseTrackRole(options, diagnostics, trackName);
      const writeScope = parseWriteScope(options, diagnostics, trackName);

      const carryNode = options.get(":carry");
      const carry = carryNode ? atomValue(carryNode) === "true" : false;

      const octNode = options.get(":oct");
      const defaultOct = parseIntLike(atomValue(octNode)) ?? 4;

      const lenNode = options.get(":len");
      const defaultLength = parseLengthToken(
        atomValue(lenNode),
        Math.round(WHOLE_TICKS / 8),
      );

      const gateNode = options.get(":gate");
      const defaultGate = gateNode ? parseGateSpec(atomValue(gateNode)) : null;

      const shuffleNode = options.get(":shuffle");
      const rawTrackShuffle = parseIntLike(atomValue(shuffleNode));
      let shuffleRatio;
      if (rawTrackShuffle !== null) {
        shuffleRatio =
          rawTrackShuffle === 50
            ? 0
            : Math.max(51, Math.min(90, rawTrackShuffle));
      } else {
        shuffleRatio = scoreShuffleRatio;
      }

      const shuffleBaseNode = options.get(":shuffle-base");
      const shuffleBase = parseLengthToken(
        atomValue(shuffleBaseNode),
        Math.round(WHOLE_TICKS / 8),
      );

      const trackState = {
        tick: 0,
        defaultLength,
        defaultOct,
        defaultGate,
        shuffleRatio,
        shuffleBase,
        subBeatParity: 0,
        carry,
      };

      const trackData = {
        id: trackOrder.length,
        name: trackName,
        channel,
        route_hint: {
          allocation_preference: "ordered_first_fit",
          carry,
          channel_candidates: [channel],
          role,
          write_scope: writeScope,
        },
        events: [],
      };

      if (carryNode) {
        trackData.events.push({
          tick: 0,
          cmd: "CARRY_SET",
          args: { carry },
          src: nodeSrc(node),
        });
      }

      trackByName.set(trackName, { trackData, trackState });
      trackOrder.push(trackName);
    } else {
      // ── Append occurrence: validate and update state ─────────────────
      const { trackState } = trackByName.get(trackName);

      if (options.has(":ch")) {
        pushDiag(
          diagnostics,
          "error",
          "E_TRACK_CH_REDEF",
          `Track '${trackName}': :ch cannot be re-specified on an appended track`,
          nodeSrc(options.get(":ch")),
          trackName,
        );
      }
      if (options.has(":oct")) {
        const v = parseIntLike(atomValue(options.get(":oct")));
        if (v !== null) trackState.defaultOct = Math.max(0, Math.min(8, v));
      }
      if (options.has(":len")) {
        trackState.defaultLength = parseLengthToken(
          atomValue(options.get(":len")),
          trackState.defaultLength,
        );
      }
      if (options.has(":gate")) {
        trackState.defaultGate = parseGateSpec(atomValue(options.get(":gate")));
      }
      if (options.has(":shuffle")) {
        const v = parseIntLike(atomValue(options.get(":shuffle")));
        if (v !== null) {
          trackState.shuffleRatio =
            v === 50 ? 0 : Math.max(51, Math.min(90, v));
          trackState.subBeatParity = 0;
        }
      }
    }

    const { trackData, trackState } = trackByName.get(trackName);
    compileTrackBodyItems(
      bodyItems,
      trackState,
      trackData.events,
      diagnostics,
      trackName,
      typedDefs,
      blocks,
      loopCounter,
    );
  }

  const tracks = trackOrder.map((name) => trackByName.get(name).trackData);

  for (const track of tracks) {
    validateTrack(track, diagnostics);
  }

  // Prepend score-level initial events (tick 0) to the first track
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
    if (initEvents.length > 0) {
      tracks[0].events.unshift(...initEvents);
    }
  }

  // Same-ch bgm collision diagnostic
  const bgmChannels = new Map();
  for (const track of tracks) {
    if (track.route_hint.role === "bgm") {
      const ch = track.route_hint.channel_candidates[0];
      if (bgmChannels.has(ch)) {
        pushDiag(
          diagnostics,
          "warning",
          "W_SAME_CH_BGM",
          `Two bgm tracks share channel ${ch}: '${bgmChannels.get(ch)}' and '${track.name}'`,
          { line: 1, column: 1 },
          track.name,
        );
      } else {
        bgmChannels.set(ch, track.name);
      }
    }
  }

  const repoRoot = path.resolve(__dirname, "..", "..");
  const sourceRel = path
    .relative(repoRoot, path.resolve(inputPath))
    .replace(/\\/g, "/");

  const ir = {
    version: 1,
    ppqn: PPQN,
    metadata: {
      title: atomValue(titleNode) || path.basename(inputPath),
      author: atomValue(authorNode) || "unknown",
      source: sourceRel,
    },
    tracks,
  };

  return {
    ir: sortObject(ir),
    diagnostics: sortObject(diagnostics),
    sourceMap: buildSourceMap(tracks),
  };
}

function compile(inputPath) {
  return compileDetailed(inputPath).ir;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const input = args[0];
  let outPath = null;
  let diagOutPath = null;
  let strict = false;
  let pretty = false;

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") {
      outPath = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--diag-out") {
      diagOutPath = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--strict") {
      strict = true;
      continue;
    }
    if (args[i] === "--pretty") {
      pretty = true;
    }
  }

  const { ir, diagnostics } = compileDetailed(input);
  const json = JSON.stringify(ir, null, 2) + "\n";
  const hasError = diagnostics.some((d) => d.severity === "error");

  if (diagOutPath) {
    fs.mkdirSync(path.dirname(diagOutPath), { recursive: true });
    fs.writeFileSync(
      diagOutPath,
      JSON.stringify(diagnostics, null, 2) + "\n",
      "utf8",
    );
  }

  if (diagnostics.length > 0) {
    for (const d of diagnostics) {
      console.error(
        `[${d.severity}] ${d.code} ${d.track || "global"}:${d.line}:${d.column} ${d.message}`,
      );
    }
  }

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, "utf8");
    if (strict && hasError) process.exit(1);
    return;
  }

  process.stdout.write(json);
  if (strict && hasError) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = { compileDetailed, compile };
