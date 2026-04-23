#!/usr/bin/env node
"use strict";

// Thin CLI wrapper — all compilation logic lives in live/src/mmlisp2ir.js.
const fs   = require("node:fs");
const path = require("node:path");

function usage() {
  console.error(
    "Usage: node scripts/mmlisp2ir.js <input.mmlisp> [--out <file>] [--diag-out <file>] [--strict] [--pretty]",
  );
}

async function main() {
  const { compileMMLisp } = await import("../../live/src/mmlisp2ir.js");

  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const input = args[0];
  let outPath = null;
  let diagOutPath = null;
  let strict = false;

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out")       { outPath     = args[++i]; continue; }
    if (args[i] === "--diag-out")  { diagOutPath = args[++i]; continue; }
    if (args[i] === "--strict")    { strict = true; continue; }
    // --pretty: accepted for compatibility, JSON output is always indented
  }

  const repoRoot  = path.resolve(__dirname, "..", "..");
  const sourceRel = path.relative(repoRoot, path.resolve(input)).replace(/\\/g, "/");

  const src = fs.readFileSync(input, "utf8");
  const { ir, diagnostics } = compileMMLisp(src, sourceRel);

  const json     = JSON.stringify(ir, null, 2) + "\n";
  const hasError = diagnostics.some((d) => d.severity === "error");

  if (diagOutPath) {
    fs.mkdirSync(path.dirname(diagOutPath), { recursive: true });
    fs.writeFileSync(diagOutPath, JSON.stringify(diagnostics, null, 2) + "\n", "utf8");
  }

  for (const d of diagnostics) {
    console.error(`[${d.severity}] ${d.code} ${d.track || "global"}:${d.line}:${d.column} ${d.message}`);
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

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
