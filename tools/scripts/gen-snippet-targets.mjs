// The machines each snippet plays on (snippet-port.js): every snippet ported
// to every target and compiled; it plays where that compiles without an
// error. Writes snippets/targets.json, which the Library marks by; --check
// holds the file to what the snippets and the compiler say now.
import { readFileSync, writeFileSync } from "node:fs";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { TARGETS } from "../../live/src/targets.js";
import { portSnippet, portMode, fmVoiceNames } from "../../live/src/snippet-port.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const OUT = `${ROOT}snippets/targets.json`;
const check = process.argv.includes("--check");
const verbose = process.argv.includes("--verbose");

process.chdir(ROOT);
const paths = JSON.parse(readFileSync("snippets/index.json", "utf8"));
const table = {};
const why = [];
for (const path of paths) {
  const text = readFileSync(path, "utf8");
  const name = path.split("/").pop();
  const imports = readImportSources(name, text);
  const voices = fmVoiceNames([text, ...imports.values()]);
  table[path] = [];
  for (const target of Object.keys(TARGETS)) {
    const port = portSnippet(text, target, portMode(path), voices, imports);
    if (port.error) { why.push(`${path} ${target}: ${port.error}`); continue; }
    const src = /\(def-score[^)]*:target/.test(port.text) ? port.text : `(def-score :target ${target})\n${port.text}`;
    const { diagnostics } = compileMMLisp(src, name, { imports: readImportSources(name, src) });
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length) { why.push(`${path} ${target}: ${errors.slice(0, 2).map((d) => `${d.code} ${d.message}`).join(" | ")}`); continue; }
    table[path].push(target);
  }
}
const json = JSON.stringify(table, null, 1) + "\n";
if (verbose) console.log(why.join("\n"));
if (check) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error("snippets/targets.json is stale: run npm run gen:snippet-targets");
    process.exit(1);
  }
  console.log(`Snippet targets match: ${paths.length} snippets`);
} else {
  writeFileSync(OUT, json);
  const count = (t) => paths.filter((p) => table[p].includes(t)).length;
  console.log(Object.keys(TARGETS).map((t) => `${t} ${count(t)}/${paths.length}`).join("  "));
}
