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
// Which entries claim each name and alias. Several may claim one word, and
// the first then wins; but once one of them is read apart by `ctx` (`noise`:
// the PSG channel and the random curve), every claimant needs its own, or
// referenceFor's answer is arbitrary where it looks deliberate.
const claims = new Map();
const failures = [];
const names = new Set();

for (const e of REFERENCE) {
  const fail = (msg) => failures.push(`${e.name ?? "(unnamed)"}: ${msg}`);
  for (const f of fields) if (typeof e[f] !== "string" || !e[f]) fail(`missing ${f}`);
  if (!cats.has(e.cat)) fail(`unknown category ${e.cat}`);
  if (names.has(e.name)) fail("duplicate name");
  names.add(e.name);
  for (const n of [e.name, ...(e.aliases ?? [])]) {
    if (claims.has(n)) claims.get(n).push(e); else claims.set(n, [e]);
  }
  if (e.tracks != null && !(Array.isArray(e.tracks) && e.tracks.every((t) => ["fm", "psg", "pcm", "wave"].includes(t))))
    fail(`tracks must be null or a list of fm / psg / pcm / wave`);
  try { parse(e.insert); } catch (err) { fail(`insert does not parse: ${err.message}`); }
  let imports;
  try {
    imports = new Map(collectImports(e.example).map((p) => [p, fs.readFileSync(root + p, "utf8")]));
  } catch (err) { fail(`example import: ${err.message}`); continue; }
  const { ir, diagnostics } = compileMMLisp(e.example, "reference.mmlisp", { imports });
  for (const d of diagnostics) fail(`example ${d.severity} ${d.code} ${d.message}`);
  if (!ir.tracks.some((t) => t.events.some((ev) => /NOTE_ON$/.test(ev.cmd)))) fail("example plays no note");
}

for (const [word, es] of claims) {
  if (es.length < 2 || !es.some((e) => e.ctx)) continue;
  const ctxs = es.map((e) => e.ctx);
  if (ctxs.some((c) => !c) || new Set(ctxs).size !== ctxs.length)
    failures.push(`'${word}' is claimed by ${es.map((e) => e.name).join(", ")}: once one sets ctx, each needs its own`);
}

// Every word the completion offers is one the reference explains.
for (const word of [...AC_FORMS, ...AC_TRACKS, ...AC_PARAMS, ...AC_MODE_VALUES])
  if (!referenceFor(word)) failures.push(`completion offers ${word}, which no entry covers (name, alias or prefix)`);

if (failures.length) {
  for (const f of failures) console.error(f);
  throw new Error(`${failures.length} reference problem(s)`);
}
console.log(`Reference checks passed: ${REFERENCE.length} entries in ${cats.size} categories`);
