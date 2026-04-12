#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("./gml_parser");

const PPQN = 120;
const WHOLE_TICKS = PPQN * 4;
const SUPPORTED_TARGETS = new Set([
  "NOTE_PITCH",
  "NOTE_VOLUME",
  "TEMPO_SCALE",
  "FM_FB",
  "FM_TL1",
  "FM_TL2",
  "FM_TL3",
  "FM_TL4",
]);

function usage() {
  console.error(
    "Usage: node scripts/gml2ir.js <input.gml> [--out <file>] [--diag-out <file>] [--strict] [--pretty]",
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

function canonicalTarget(symbol) {
  const map = {
    ":fm-fb": "FM_FB",
    ":fm-tl1": "FM_TL1",
    ":fm-tl2": "FM_TL2",
    ":fm-tl3": "FM_TL3",
    ":fm-tl4": "FM_TL4",
    ":tempo-scale": "TEMPO_SCALE",
    ":note-pitch": "NOTE_PITCH",
    ":note-volume": "NOTE_VOLUME",
  };
  return (
    map[symbol] || symbol.replace(/^:/, "").toUpperCase().replace(/-/g, "_")
  );
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
    if (!value) {
      break;
    }
    map.set(key.value, value);
    i += 2;
  }
  return map;
}

function nodeSrc(node) {
  return {
    line: node.line,
    column: node.column,
  };
}

function parseChannelCandidates(channelNode) {
  const candidates = [];

  if (channelNode && channelNode.kind === "list") {
    for (const item of channelNode.items) {
      const value = atomValue(item);
      if (!value) {
        continue;
      }
      candidates.push(value.replace(/^:/, "").toLowerCase());
    }
  } else {
    const single = atomValue(channelNode);
    if (single) {
      candidates.push(single.replace(/^:/, "").toLowerCase());
    }
  }

  const unique = [];
  const seen = new Set();
  for (const name of candidates) {
    if (seen.has(name)) {
      continue;
    }
    unique.push(name);
    seen.add(name);
  }

  if (unique.length === 0) {
    unique.push("fm1");
  }

  return unique;
}

const VALID_ROLES = new Set(["bgm", "se", "modulator", "chaos"]);
const VALID_WRITE_SCOPE = new Set(["notes", "fm-params", "ctrl", "reg", "any"]);

function parseTrackRole(options, diagnostics, trackName) {
  const roleNode = options.get(":role");
  if (!roleNode) {
    return "bgm";
  }
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
  if (!scopeNode) {
    return ["any"];
  }
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

function compilePhrase(phraseNode, state, events, diagnostics, trackName) {
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

    if (!node || node.kind !== "list" || node.items.length === 0) {
      continue;
    }

    const head = atomValue(node.items[0]);
    if (!head) {
      continue;
    }

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
      const lenToken = atomValue(node.items[1]);
      const length = parseLengthToken(lenToken, phraseDefaultLen);
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
      const lenToken = atomValue(node.items[1]);
      const length = parseLengthToken(lenToken, phraseDefaultLen);
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
      const notesLenNode = notesOpts.get(":len");
      const notesLen = parseLengthToken(
        atomValue(notesLenNode),
        phraseDefaultLen,
      );
      for (let j = 1; j < node.items.length; j += 1) {
        const elem = node.items[j];
        const val = atomValue(elem);
        if (!val || val.startsWith(":len")) {
          continue;
        }
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
        const pitch = val.replace(/^:/, "");
        events.push({
          tick: state.tick,
          cmd: "NOTE_ON",
          args: { pitch, length: notesLen },
          src: nodeSrc(elem),
        });
        state.tick += notesLen;
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

function compileTrack(trackNode, id, diagnostics) {
  const items = trackNode.items;
  const options = getKeywordMap(items, 2);
  const nameNode = items[1];
  const name = atomValue(nameNode)
    ? atomValue(nameNode).replace(/^:/, "")
    : `track${id}`;

  const channelNode = options.get(":ch");
  const channelCandidates = parseChannelCandidates(channelNode);
  const channel = channelCandidates[0];
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
      compilePhrase(node, state, events, diagnostics, name);
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
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortObject(value[key]);
    }
    return out;
  }
  return value;
}

function collectDefs(roots, diagnostics) {
  const defs = new Map();
  const defns = new Map();
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
      defs.set(name, root.items[2]);
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

  return { defs, defns, remaining };
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
  if (depth > 16) {
    throw new Error("Macro expansion depth exceeded (possible recursion)");
  }

  if (node.kind === "atom" && defs.has(node.value)) {
    return [{ ...defs.get(node.value) }];
  }

  if (node.kind !== "list") {
    return [node];
  }

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

function compileDetailed(inputPath) {
  const diagnostics = [];
  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = parse(raw);
  const { defs, defns, remaining } = collectDefs(parsed, diagnostics);
  const roots = expandRoots(remaining, defs, defns);
  const score = roots.find(
    (node) =>
      node.kind === "list" &&
      node.items.length > 0 &&
      isAtom(node.items[0], "score"),
  );

  if (!score) {
    throw new Error("No (score ...) form found");
  }

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
      tracks.push(compileTrack(node, tracks.length, diagnostics));
    }
  }

  for (const track of tracks) {
    validateTrack(track, diagnostics);
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
  };
}

function compile(inputPath) {
  return compileDetailed(inputPath).ir;
}

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
  const json = JSON.stringify(ir, null, pretty ? 2 : 2) + "\n";
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
    if (strict && hasError) {
      process.exit(1);
    }
    return;
  }

  process.stdout.write(json);
  if (strict && hasError) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = {
  compileDetailed,
  compile,
};
