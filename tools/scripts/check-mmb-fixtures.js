#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const fixturesDir = path.join(repoRoot, "examples", "gmb", "fixtures");
  const manifestPath = path.join(fixturesDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error("Fixture manifest not found. Run build:gmb-fixtures first.");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let failed = 0;

  for (const c of manifest.cases || []) {
    const file = path.join(fixturesDir, c.file);
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "verify-mmb.js"), file],
      { encoding: "utf8" },
    );

    const ok = c.valid ? run.status === 0 : run.status !== 0;
    const marker = ok ? "PASS" : "FAIL";
    const mode = c.valid ? "expected-valid" : "expected-invalid";
    console.log(`${marker} ${mode} ${c.file}`);

    if (!ok) {
      failed += 1;
      if (run.stdout) {
        process.stdout.write(run.stdout);
      }
      if (run.stderr) {
        process.stderr.write(run.stderr);
      }
    }
  }

  if (failed > 0) {
    console.error(`Fixture check failed: ${failed} case(s)`);
    process.exit(1);
  }

  console.log("Fixture check passed: all cases matched expected validity");
}

if (require.main === module) {
  main();
}
