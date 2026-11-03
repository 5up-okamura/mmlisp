#!/usr/bin/env node
// The tutorial (tutorial/lessons.json, live/src/lessons.js): every step's
// file is there and compiles clean, its exercise is not done before the
// learner starts, and the step's answer compiles clean and does it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { parseStep, passes } from "../../live/src/lessons.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lessons = JSON.parse(fs.readFileSync(path.join(root, "tutorial/lessons.json"), "utf8"));
const fails = [];
let n = 0;
const compile = (src, name) => {
  const r = compileMMLisp(src, name, { imports: readImportSources(path.join(root, name), src) });
  return { src, ir: r.ir, diagnostics: r.diagnostics };
};
for (const lesson of lessons) {
  for (const step of lesson.steps) {
    const name = `tutorial/${lesson.id}/${step.file}.mmlisp`;
    const file = path.join(root, name);
    if (!fs.existsSync(file)) { fails.push(`${name}: missing`); continue; }
    const { about, task, code } = parseStep(fs.readFileSync(file, "utf8"));
    if (!about) fails.push(`${name}: no text`);
    if (!step.title) fails.push(`${name}: no title`);
    const start = compile(code, name);
    if (start.diagnostics.length) fails.push(`${name}: ${start.diagnostics.map((d) => d.code).join(", ")}`);
    if (task || step.check) {
      if (!task || !step.check || !step.answer) { fails.push(`${name}: a Try needs a check and an answer, and they a Try`); continue; }
      if (passes(step.check, start)) fails.push(`${name}: the exercise is done before it starts`);
      const done = compile(step.answer, name);
      if (done.diagnostics.length) fails.push(`${name}: the answer: ${done.diagnostics.map((d) => d.code).join(", ")}`);
      if (!passes(step.check, done)) fails.push(`${name}: the answer does not pass its check`);
    }
    n++;
  }
}
const files = fs.readdirSync(path.join(root, "tutorial"), { recursive: true }).filter((f) => f.endsWith(".mmlisp"));
const listed = new Set(lessons.flatMap((l) => l.steps.map((s) => `${l.id}/${s.file}.mmlisp`)));
for (const f of files) if (!listed.has(f.split(path.sep).join("/"))) fails.push(`tutorial/${f}: not in lessons.json`);
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
console.log(`Lessons ok: ${lessons.length} lesson(s), ${n} steps`);
