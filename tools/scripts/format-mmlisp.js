#!/usr/bin/env node
"use strict";

/**
 * MMLisp formatter CLI.
 * Formatting logic lives in live/src/mmlisp-formatter.js (shared with browser).
 */

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const files = [];
  let check = false;
  let stdout = false;

  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--stdout") {
      stdout = true;
      continue;
    }
    files.push(arg);
  }

  if (files.length === 0) {
    throw new Error(
      "Usage: node scripts/format-mmlisp.js [--check|--stdout] <file...>",
    );
  }

  return { files, check, stdout };
}

async function main() {
  const { parse } = await import("../../live/src/mmlisp-parser.js");
  const { formatMMLisp } = await import("../../live/src/mmlisp-formatter.js");
  const { files, check, stdout } = parseArgs(process.argv.slice(2));
  let changed = false;

  for (const target of files) {
    const filePath = path.resolve(process.cwd(), target);
    const input = fs.readFileSync(filePath, "utf8");
    const output = formatMMLisp(input, parse);

    if (stdout) {
      process.stdout.write(output);
      continue;
    }

    if (input !== output) {
      changed = true;
      if (!check) {
        fs.writeFileSync(filePath, output, "utf8");
        process.stdout.write(`formatted ${target}\n`);
      }
    }
  }

  if (check && changed) {
    process.stderr.write("Some MMLisp files are not formatted.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
