#!/usr/bin/env node
// Every gate in one run: each `check:*` script of tools/package.json, then
// drv's `verify:all`. A refactor that must not change behaviour keeps all of
// it green. Prints one line a gate and the failures' output at the end.
//
//   node scripts/check-all.mjs              all of it
//   node scripts/check-all.mjs --no-drv     tools' checks only
//   node scripts/check-all.mjs snapshot …   only the checks whose name holds one of the words

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const drvDir = join(toolsDir, "..", "drv");
const argv = process.argv.slice(2);
const noDrv = argv.includes("--no-drv");
const words = argv.filter((a) => !a.startsWith("--"));

const scripts = JSON.parse(readFileSync(join(toolsDir, "package.json"), "utf8")).scripts;
const gates = Object.keys(scripts)
  .filter((k) => k.startsWith("check:") && k !== "check:all")
  .filter((k) => !words.length || words.some((w) => k.includes(w)))
  .map((k) => ({ name: k, cwd: toolsDir }));
if (!noDrv && !words.length) gates.push({ name: "verify:all", cwd: drvDir, label: "drv verify:all" });

function run({ name, cwd }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("npm", ["run", "--silent", name], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, secs: (Date.now() - t0) / 1000 }));
  });
}

const failed = [];
for (const g of gates) {
  const r = await run(g);
  const label = g.label ?? g.name;
  console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${label.padEnd(28)} ${r.secs.toFixed(1).padStart(6)}s`);
  if (r.code !== 0) failed.push({ label, out: r.out });
}
for (const f of failed) {
  console.log(`\n===== ${f.label} =====\n${f.out.trimEnd().split("\n").slice(-40).join("\n")}`);
}
console.log(`\n${gates.length - failed.length}/${gates.length} green`);
process.exit(failed.length ? 1 : 0);
