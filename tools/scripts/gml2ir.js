#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("./gml_parser");

const PPQN = 120;
const WHOLE_TICKS = PPQN * 4;

function usage() {
  console.error(
    "Usage: node scripts/gml2ir.js <input.gml> [--out <file>] [--pretty]",
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

function compilePhrase(phraseNode, state, events) {
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
      const target = canonicalTarget(atomValue(node.items[1]));
      const value = parseIntLike(atomValue(node.items[2])) ?? 0;
      events.push({
        tick: state.tick,
        cmd: "PARAM_SET",
        args: { target, value },
        src: nodeSrc(node.items[0]),
      });
      continue;
    }

    if (head === "param-add") {
      const target = canonicalTarget(atomValue(node.items[1]));
      const delta = parseIntLike(atomValue(node.items[2])) ?? 0;
      events.push({
        tick: state.tick,
        cmd: "PARAM_ADD",
        args: { target, delta },
        src: nodeSrc(node.items[0]),
      });
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

function compilePart(partNode, id) {
  const items = partNode.items;
  const options = getKeywordMap(items, 2);
  const nameNode = items[1];
  const name = atomValue(nameNode)
    ? atomValue(nameNode).replace(/^:/, "")
    : `part${id}`;

  const channelNode = options.get(":ch");
  let channel = "fm1";
  if (
    channelNode &&
    channelNode.kind === "list" &&
    channelNode.items.length > 0
  ) {
    const first = atomValue(channelNode.items[0]);
    if (first) {
      channel = first.replace(/^:/, "");
    }
  }

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
      compilePhrase(node, state, events);
    }
  }

  return {
    id,
    name,
    channel,
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

function compile(inputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");
  const roots = parse(raw);
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
      isAtom(node.items[0], "part")
    ) {
      tracks.push(compilePart(node, tracks.length));
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

  return sortObject(ir);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const input = args[0];
  let outPath = null;
  let pretty = false;

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") {
      outPath = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--pretty") {
      pretty = true;
    }
  }

  const ir = compile(input);
  const json = JSON.stringify(ir, null, pretty ? 2 : 2) + "\n";

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, "utf8");
    return;
  }

  process.stdout.write(json);
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
  compile,
};
