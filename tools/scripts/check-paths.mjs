#!/usr/bin/env node
// Every path the code names by a literal resolves to a file: a module's
// relative imports (static and dynamic), a worker's, a worklet's and a
// `new URL(…, import.meta.url)`'s, the page's script, link and image
// references, and any "…live/src/….js" a tool spells out. Moving a file
// breaks one of these silently in a page or a worker nobody runs in node.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repo, encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(m?js|html)$/.test(f) && !/(^|\/)(node_modules|vendor|third_party|out)\//.test(f))
  // The WASM cores' generated glue (live/nuked-opn2.js …) names its own files.
  .filter((f) => !/^live\/(nuked|ymfm)-[a-z0-9-]+\.js$/.test(f));

const RELATIVE = [
  /\bfrom\s*["'](\.\.?\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g,
  /^\s*import\s+["'](\.\.?\/[^"']+)["']/gm,
  /\bnew\s+Worker\(\s*["'](\.\.?\/[^"']+)["']/g,
  /addModule\(\s*["'](\.\.?\/[^"']+)["']/g,
  // A module or an asset; a score's name there is only a base for its :file.
  /\bnew\s+URL\(\s*["'](\.\.?\/[^"']+\.(?:m?js|wasm|sf[23]|json|css))["']\s*,\s*import\.meta\.url/g,
];
const PAGE = /\b(?:src|href)="(\.?\.?\/?[^":#?]+\.(?:js|css|png|svg|webmanifest|json))"/g;
const SPELLED = /["'`]((?:\.\.\/)*live\/src\/[A-Za-z0-9_/.-]+\.js)["'`]/g;

const bad = [];
for (const f of files) {
  const text = readFileSync(join(repo, f), "utf8");
  const dir = dirname(join(repo, f));
  const check = (spec, base, line) => {
    const p = resolve(base, spec.split(/[?#]/)[0]);
    if (!existsSync(p)) bad.push(`${f}:${line}: ${spec}`);
  };
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  for (const re of RELATIVE) for (const m of text.matchAll(re)) check(m[1], dir, lineOf(m.index));
  if (f.endsWith(".html")) for (const m of text.matchAll(PAGE)) if (!/^https?:/.test(m[1])) check(m[1], dir, lineOf(m.index));
  for (const m of text.matchAll(SPELLED)) {
    // Relative to the file when it climbs, else to the repo root.
    check(m[1], m[1].startsWith("../") ? dir : repo, lineOf(m.index));
  }
}
if (bad.length) {
  console.error(`check:paths: ${bad.length} path(s) that name no file:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`check:paths ok (${files.length} files)`);
