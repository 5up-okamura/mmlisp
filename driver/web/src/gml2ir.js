/**
 * GML → IR compiler — ES module port of tools/scripts/gml2ir.js.
 * No Node.js dependencies; input is a GML source string.
 *
 * API:
 *   compileGML(src: string, filename?: string)
 *     → { ir: object, diagnostics: array }
 *
 * Errors in diagnostics have: { severity, code, message, line, column, track }
 */

import { parse } from "./gml-parser.js";

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
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function parseLengthToken(value, inheritedTicks) {
  if (!value) return inheritedTicks;
  if (/^\d+\/\d+$/.test(value)) {
    const [n, d] = value.split("/").map((v) => Number.parseInt(v, 10));
    return Math.round((WHOLE_TICKS * n) / d);
  }
  if (/^\d+$/.test(value)) {
    return Math.round((WHOLE_TICKS * 1) / Number.parseInt(value, 10));
  }
  return inheritedTicks;
}

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

// Emit PARAM_SET events for a :fm typed def at the current tick
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

function parseChannelCandidates(channelNode) {
  const candidates = [];
  if (channelNode && channelNode.kind === "list") {
    for (const item of channelNode.items) {
      const value = atomValue(item);
      if (value) candidates.push(value.replace(/^:/, "").toLowerCase());
    }
  } else {
    const single = atomValue(channelNode);
    if (single) candidates.push(single.replace(/^:/, "").toLowerCase());
  }
  const unique = [];
  const seen = new Set();
  for (const name of candidates) {
    if (!seen.has(name)) {
      unique.push(name);
      seen.add(name);
    }
  }
  if (unique.length === 0) unique.push("fm1");
  return unique;
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
  const candidates = parseChannelCandidates(scopeNode).map((s) =>
    s.replace(/^:/, ""),
  );
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

function compilePhrase(
  phraseNode,
  state,
  events,
  diagnostics,
  trackName,
  typedDefs,
) {
  const items = phraseNode.items;
  const options = getKeywordMap(items, 2);
  const tempoNode = options.get(":tempo");
  const lenNode = options.get(":len");

  const phraseDefaultLen = parseLengthToken(
    atomValue(lenNode),
    state.defaultLength,
  );
  if (tempoNode) {
    const tempoValue = parseIntLike(atomValue(tempoNode));
    if (tempoValue !== null) {
      events.push({
        tick: state.tick,
        cmd: "TEMPO_SET",
        args: { bpm: tempoValue },
        src: nodeSrc(tempoNode),
      });
    }
  }

  let i = 1;
  while (i < items.length) {
    const node = items[i];
    i += 1;
    if (!node || node.kind !== "list" || node.items.length === 0) continue;
    const head = atomValue(node.items[0]);
    if (!head) continue;

    if (head === "note") {
      const pitch = atomValue(node.items[1]);
      const lenToken = atomValue(node.items[2]);
      const length = parseLengthToken(lenToken, phraseDefaultLen);
      events.push({
        tick: state.tick,
        cmd: "NOTE_ON",
        args: { pitch: pitch ? pitch.replace(/^:/, "") : "c4", length },
        src: nodeSrc(node.items[0]),
      });
      state.tick += length;
      continue;
    }

    if (head === "rest") {
      const length = parseLengthToken(
        atomValue(node.items[1]),
        phraseDefaultLen,
      );
      events.push({
        tick: state.tick,
        cmd: "REST",
        args: { length },
        src: nodeSrc(node.items[0]),
      });
      state.tick += length;
      continue;
    }

    if (head === "tie") {
      const length = parseLengthToken(
        atomValue(node.items[1]),
        phraseDefaultLen,
      );
      events.push({
        tick: state.tick,
        cmd: "TIE",
        args: { length },
        src: nodeSrc(node.items[0]),
      });
      state.tick += length;
      continue;
    }

    if (head === "notes") {
      const notesOpts = getKeywordMap(node.items, 1);
      const notesLen = parseLengthToken(
        atomValue(notesOpts.get(":len")),
        phraseDefaultLen,
      );
      for (let j = 1; j < node.items.length; j += 1) {
        const elem = node.items[j];
        const val = atomValue(elem);
        if (!val || val.startsWith(":len")) continue;
        if (val === ":len") {
          j += 1;
          continue;
        }
        if (val === "_") {
          events.push({
            tick: state.tick,
            cmd: "REST",
            args: { length: notesLen },
            src: nodeSrc(elem),
          });
          state.tick += notesLen;
          continue;
        }
        events.push({
          tick: state.tick,
          cmd: "NOTE_ON",
          args: { pitch: val.replace(/^:/, ""), length: notesLen },
          src: nodeSrc(elem),
        });
        state.tick += notesLen;
      }
      continue;
    }

    if (head === "tuplet") {
      const totalTicks = parseLengthToken(
        atomValue(node.items[1]),
        phraseDefaultLen,
      );
      const elems = [];
      for (let j = 2; j < node.items.length; j += 1) {
        const elem = node.items[j];
        const val = atomValue(elem);
        if (val && (val.startsWith(":") || val === "_"))
          elems.push({ val, src: nodeSrc(elem) });
      }
      if (elems.length > 0) {
        const perTick = Math.floor(totalTicks / elems.length);
        const remainder = totalTicks - perTick * elems.length;
        for (let j = 0; j < elems.length; j += 1) {
          const { val, src } = elems[j];
          const length = perTick + (j === elems.length - 1 ? remainder : 0);
          if (val === "_") {
            events.push({
              tick: state.tick,
              cmd: "REST",
              args: { length },
              src,
            });
          } else {
            events.push({
              tick: state.tick,
              cmd: "NOTE_ON",
              args: { pitch: val.replace(/^:/, ""), length },
              src,
            });
          }
          state.tick += length;
        }
      }
      continue;
    }

    if (head === "marker") {
      const id = atomValue(node.items[1]);
      events.push({
        tick: state.tick,
        cmd: "MARKER",
        args: { id: id ? id.replace(/^:/, "") : "unknown" },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    if (head === "jump") {
      const target = atomValue(node.items[1]);
      events.push({
        tick: state.tick,
        cmd: "JUMP",
        args: { to: target ? target.replace(/^:/, "") : "unknown" },
        src: nodeSrc(node.items[0]),
      });
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
          tick: state.tick,
          cmd: "PARAM_SET",
          args: { target, value },
          src: nodeSrc(targetNode),
        });
        j += 2;
      }
      continue;
    }

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
          tick: state.tick,
          cmd: "PARAM_ADD",
          args: { target, delta },
          src: nodeSrc(targetNode),
        });
        j += 2;
      }
      continue;
    }

    if (head === "loop-begin") {
      const id = atomValue(node.items[1]);
      events.push({
        tick: state.tick,
        cmd: "LOOP_BEGIN",
        args: { id: id ? id.replace(/^:/, "") : "loop" },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    if (head === "loop-end") {
      const id = atomValue(node.items[1]);
      const repeat = parseIntLike(atomValue(node.items[2])) ?? 1;
      events.push({
        tick: state.tick,
        cmd: "LOOP_END",
        args: { id: id ? id.replace(/^:/, "") : "loop", repeat },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    if (head === "ins") {
      // (ins voice-name) — expand :fm typed def to PARAM_SET sequence at current tick
      const voiceName = atomValue(node.items[1])?.replace(/^:/, "");
      if (voiceName && typedDefs?.has(voiceName)) {
        const td = typedDefs.get(voiceName);
        if (td.tag === "fm") {
          emitFmPatch(td, state.tick, events, nodeSrc(node.items[0]));
        }
        // :psg envelope IR command TBD in future
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
      if (!id || id === "unknown") {
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

function compileTrack(trackNode, id, diagnostics, typedDefs) {
  const items = trackNode.items;
  const options = getKeywordMap(items, 2);
  const nameNode = items[1];
  const name = atomValue(nameNode)
    ? atomValue(nameNode).replace(/^:/, "")
    : `track${id}`;

  const channelNode = options.get(":ch");
  const channelCandidates = parseChannelCandidates(channelNode);
  const channel = channelCandidates[id] ?? channelCandidates[0];
  const role = parseTrackRole(options, diagnostics, name);
  const writeScope = parseWriteScope(options, diagnostics, name);

  const state = {
    tick: 0,
    defaultLength: parseLengthToken("1/8", Math.round(WHOLE_TICKS / 8)),
  };
  const events = [];

  for (let i = 0; i < items.length; i += 1) {
    const node = items[i];
    if (
      node &&
      node.kind === "list" &&
      node.items.length > 0 &&
      isAtom(node.items[0], "phrase")
    ) {
      compilePhrase(node, state, events, diagnostics, name, typedDefs);
    }
  }

  return {
    id,
    name,
    channel,
    route_hint: {
      allocation_preference: "ordered_first_fit",
      channel_candidates: channelCandidates,
      role,
      write_scope: writeScope,
    },
    events,
  };
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

/**
 * Parse a :psg vector node into a structured tagged-union object.
 * Sub-types: bare | seq | adsr | hard | fn
 */
function parsePsgVector(vecNode, name, diagnostics, src) {
  if (!vecNode || vecNode.kind !== "list" || vecNode.items.length === 0) {
    pushDiag(
      diagnostics, "error", "E_PSG_VECTOR_EMPTY",
      `def :psg '${name}': envelope vector is missing or empty`, src, null,
    );
    return { subtype: "bare", steps: [], loopIndex: null, releaseRate: null };
  }

  const first = atomValue(vecNode.items[0]);

  if (first === ":fn") {
    pushDiag(
      diagnostics, "error", "E_FN_NOT_IMPL",
      `def :psg '${name}': :fn envelope is not implemented in v0.2`, src, null,
    );
    return { subtype: "fn" };
  }

  if (first === ":hard") {
    pushDiag(
      diagnostics, "warning", "W_PSG_HARD_RESERVED",
      `def :psg '${name}': :hard envelope is reserved syntax — no IR generated`, src, null,
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
      if (val === ":loop") { loopIndex = steps.length; i += 1; continue; }
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

  // bare — first element is an integer
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
  const typedDefs = new Map(); // name → { tag: 'fm'|'psg', ... }
  const remaining = [];

  for (const root of roots) {
    if (root.kind !== "list" || root.items.length < 3) {
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
        // (def name :fm [ALG FB] [OP1...] [OP2...] [OP3...] [OP4...])
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
    return [{ ...defs.get(node.value) }];
  if (node.kind !== "list") return [node];

  const head = atomValue(node.items[0]);
  if (head && defns.has(head)) {
    const { params, body } = defns.get(head);
    const args = node.items.slice(1);
    const bindings = new Map();
    for (let i = 0; i < params.length; i += 1)
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
 * Compile a GML source string to IR.
 * @param {string} src  GML source text
 * @param {string} [filename]  Optional filename for metadata (default: "untitled.gml")
 * @returns {{ ir: object, diagnostics: array }}
 */
export function compileGML(src, filename = "untitled.gml") {
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

  const options = getKeywordMap(score.items, 1);
  const titleNode = options.get(":title");
  const authorNode = options.get(":author");

  const tracks = [];
  for (let i = 0; i < score.items.length; i += 1) {
    const node = score.items[i];
    if (
      node &&
      node.kind === "list" &&
      node.items.length > 0 &&
      isAtom(node.items[0], "track")
    ) {
      tracks.push(compileTrack(node, tracks.length, diagnostics, typedDefs));
    }
  }

  for (const track of tracks) validateTrack(track, diagnostics);

  // same-ch bgm collision diagnostic (warning)
  const bgmChannels = new Map(); // channel → track name
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

  return { ir, diagnostics };
}
