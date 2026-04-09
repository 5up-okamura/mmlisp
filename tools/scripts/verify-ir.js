#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function usage() {
  console.error(
    "Usage: node scripts/verify-ir.js <expected.json> <actual.json>",
  );
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}

function firstDiff(a, b, path = "$") {
  if (typeof a !== typeof b) {
    return `${path}: type mismatch (${typeof a} vs ${typeof b})`;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return `${path}: array length mismatch (${a.length} vs ${b.length})`;
    }
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) {
        return d;
      }
    }
    return null;
  }

  if (a && typeof a === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.join("|") !== bKeys.join("|")) {
      return `${path}: object keys mismatch`;
    }
    for (const key of aKeys) {
      const d = firstDiff(a[key], b[key], `${path}.${key}`);
      if (d) {
        return d;
      }
    }
    return null;
  }

  if (a !== b) {
    return `${path}: value mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`;
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    usage();
    process.exit(1);
  }

  const expected = stable(JSON.parse(fs.readFileSync(args[0], "utf8")));
  const actual = stable(JSON.parse(fs.readFileSync(args[1], "utf8")));

  const diff = firstDiff(expected, actual);
  if (diff) {
    console.error(`IR mismatch: ${diff}`);
    process.exit(1);
  }

  console.log("IR match: OK");
}

if (require.main === module) {
  main();
}
