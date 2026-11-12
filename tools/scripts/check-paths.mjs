#!/usr/bin/env node
// Every path the code names by a literal resolves to a file: a module's
// relative imports (static and dynamic), a worker's, a worklet's and a
// `new URL(…, import.meta.url)`'s, the page's script, link and image
// references, and any "…live/src/….js" a tool spells out; every named import
// is an export of its module; live/src's directories import in no cycle. Moving a file
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

const NAMED = /\bimport\s*\{([^}]*)\}\s*from\s*["'](\.\.?\/[^"']+)["']/g;
const exportCache = new Map();
// A module's export names; null when it re-exports a whole module (`export *`).
function exportsOf(p) {
  if (exportCache.has(p)) return exportCache.get(p);
  const t = readFileSync(p, "utf8");
  let names = new Set();
  if (/^\s*export\s*\*/m.test(t)) names = null;
  else {
    for (const m of t.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    // `export const A = …, B = …;`: each declarator at the statement's top level.
    for (const m of t.matchAll(/^\s*export\s+(?:const|let|var)\s+(?=[A-Za-z_$])/gm)) {
      let depth = 0, at = m.index + m[0].length, start = at, q = null;
      for (; at < t.length; at++) {
        const c = t[at];
        if (q) { if (c === "\\") at++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === "`") q = c;
        else if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (depth === 0 && (c === "," || c === ";" || c === "\n" && /^\s*(export|const|let|function|import|\/\/)/.test(t.slice(at + 1)))) {
          const id = t.slice(start, at).match(/^\s*([A-Za-z_$][\w$]*)\s*=/);
          if (id) names.add(id[1]);
          if (c !== ",") break;
          start = at + 1;
        }
      }
      const id = t.slice(start, at).match(/^\s*([A-Za-z_$][\w$]*)\s*=/);
      if (id) names.add(id[1]);
    }
    for (const m of t.matchAll(/^\s*export\s+(?:const|let|var)\s*\{([^}]*)\}/gm))
      for (const n of m[1].split(",")) names.add(n.trim().split(/\s*:\s*/).pop());
    for (const m of t.matchAll(/^\s*export\s*\{([^}]*)\}/gm))
      for (const n of m[1].split(",")) { const s = n.trim().split(/\s+as\s+/); if (s[0]) names.add(s.pop()); }
    if (/^\s*export\s+default\b/m.test(t)) names.add("default");
  }
  exportCache.set(p, names);
  return names;
}

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
  // A named import the module does not export (a page's or a worker's fails
  // only in the browser, at load).
  for (const m of text.matchAll(NAMED)) {
    const p = resolve(dir, m[2]);
    if (!existsSync(p) || !/\.m?js$/.test(p) || /\/vendor\//.test(p)) continue; // vendored bundles are minified
    const ex = exportsOf(p);
    if (!ex) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name && !ex.has(name)) bad.push(`${f}:${lineOf(m.index)}: ${name} is not exported by ${m[2]}`);
    }
  }
}
// live/src's directories are layers: the imports between them form no cycle
// (CLAUDE.md's map lists them bottom to top).
const SRC = join(repo, "live/src");
const edges = new Map();
for (const f of files.filter((f) => f.startsWith("live/src/") && f.endsWith(".js"))) {
  const from = f.split("/")[2];
  if (!f.slice("live/src/".length).includes("/")) continue;
  for (const m of readFileSync(join(repo, f), "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)) {
    const to = resolve(dirname(join(repo, f)), m[1]);
    if (!to.startsWith(SRC + "/")) continue;
    const dir = to.slice(SRC.length + 1).split("/")[0];
    if (dir === from || !to.slice(SRC.length + 1).includes("/")) continue;
    if (!edges.has(from)) edges.set(from, new Map());
    if (!edges.get(from).has(dir)) edges.get(from).set(dir, `${f} → ${m[1]}`);
  }
}
const done = new Set();
const visit = (d, stack) => {
  if (done.has(d)) return;
  if (stack.includes(d)) {
    const loop = stack.slice(stack.indexOf(d)).concat(d);
    bad.push(`live/src's layers loop: ${loop.join(" → ")} (${loop.slice(0, -1).map((x, i) => edges.get(x).get(loop[i + 1])).join("; ")})`);
    return;
  }
  for (const to of edges.get(d)?.keys() ?? []) visit(to, stack.concat(d));
  done.add(d);
};
for (const d of edges.keys()) visit(d, []);

if (bad.length) {
  console.error(`check:paths: ${bad.length} problem(s) — a path or a name that names nothing, or a layer loop:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`check:paths ok (${files.length} files)`);
