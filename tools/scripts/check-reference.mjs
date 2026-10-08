#!/usr/bin/env node
// live/src/reference.js is the Library panel's language reference: every
// example must compile clean and play something (▶ plays it), every insert
// must parse, every entry must sit in a known category, and every word the
// editor's completion offers (completion-names.js) must have an entry.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { compileMMLisp, collectImports } from "../../live/src/mmlisp2ir.js";
import { parse } from "../../live/src/mmlisp-parser.js";
import { REFERENCE, REFERENCE_CATEGORIES, referenceFor } from "../../live/src/reference.js";
import { AC_FORMS, AC_TRACKS, AC_PARAMS, AC_MODE_VALUES } from "../../live/src/completion-names.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cats = new Set(REFERENCE_CATEGORIES.map(([id]) => id));
const fields = ["name", "cat", "syntax", "summary", "insert", "example", "section"];
const failures = [];
const names = new Set();

for (const e of REFERENCE) {
  const fail = (msg) => failures.push(`${e.name ?? "(unnamed)"}: ${msg}`);
  for (const f of fields) if (typeof e[f] !== "string" || !e[f]) fail(`missing ${f}`);
  if (!cats.has(e.cat)) fail(`unknown category ${e.cat}`);
  if (names.has(e.name)) fail("duplicate name");
  names.add(e.name);
  if (e.tracks != null && !(Array.isArray(e.tracks) && e.tracks.every((t) => ["fm", "psg", "pcm"].includes(t))))
    fail(`tracks must be null or a list of fm / psg / pcm`);
  try { parse(e.insert); } catch (err) { fail(`insert does not parse: ${err.message}`); }
  let imports;
  try {
    imports = new Map(collectImports(e.example).map((p) => [p, fs.readFileSync(root + p, "utf8")]));
  } catch (err) { fail(`example import: ${err.message}`); continue; }
  const { ir, diagnostics } = compileMMLisp(e.example, "reference.mmlisp", { imports });
  for (const d of diagnostics) fail(`example ${d.severity} ${d.code} ${d.message}`);
  if (!ir.tracks.some((t) => t.events.some((ev) => /NOTE_ON$/.test(ev.cmd)))) fail("example plays no note");
}

// Every word the completion offers is one the reference explains.
for (const word of [...AC_FORMS, ...AC_TRACKS, ...AC_PARAMS, ...AC_MODE_VALUES])
  if (!referenceFor(word)) failures.push(`completion offers ${word}, which no entry covers (name, alias or prefix)`);

if (failures.length) {
  for (const f of failures) console.error(f);
  throw new Error(`${failures.length} reference problem(s)`);
}
console.log(`Reference checks passed: ${REFERENCE.length} entries in ${cats.size} categories`);
