#!/usr/bin/env node
// docs/cheatsheet.md is read by people and handed to AI clients first, so its
// examples must stay valid: the whole song compiles clean, every other block
// parses (they are fragments — a macro list, a def with a wav that isn't here).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { compileMMLisp, collectImports } from "../../live/src/mmlisp2ir.js";
import { parse } from "../../live/src/mmlisp-parser.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const md = fs.readFileSync(root + "docs/cheatsheet.md", "utf8");
const blocks = [...md.matchAll(/```lisp\n([\s\S]*?)```/g)].map((m) => m[1]);
if (!blocks.length) throw new Error("no lisp blocks in docs/cheatsheet.md");

const [song, ...rest] = blocks;
const imports = new Map(collectImports(song).map((p) => [p, fs.readFileSync(root + p, "utf8")]));
const { diagnostics } = compileMMLisp(song, "cheatsheet.mmlisp", { imports });
if (diagnostics.length) {
  for (const d of diagnostics) console.error(`${d.code} ${d.line}:${d.column} ${d.message}`);
  throw new Error("the cheat sheet's song does not compile clean");
}
rest.forEach((b, i) => {
  try {
    parse(b);
  } catch (e) {
    throw new Error(`cheat sheet block ${i + 2} does not parse: ${e.message}`);
  }
});
console.log(`Cheat sheet checks passed: 1 song, ${rest.length} fragments`);
