#!/usr/bin/env node
// The tutorial (tutorial/lessons.json, live/src/lessons.js): every step's
// file is there and compiles clean, its exercise is not done before the
// learner starts, and the step's answer compiles without an error and does it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { parseStep, passes, stepKey, firstUndone, neighbor, stepState } from "../../live/src/lessons.js";
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
      // An answer may draw a warning the step is about (the N163's shared memory).
      const errs = done.diagnostics.filter((d) => d.severity === "error");
      if (errs.length) fails.push(`${name}: the answer: ${errs.map((d) => d.code).join(", ")}`);
      if (!passes(step.check, done)) fails.push(`${name}: the answer does not pass its check`);
    }
    n++;
  }
}
// The walk: Next runs on from one lesson into the next, never into or out of
// a tour; Start Lesson begins at the first lesson step not done.
const lastPlain = lessons.findLastIndex((l) => !l.group);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!eq(neighbor(lessons, 0, lessons[0].steps.length - 1, 1), [1, 0])) fails.push("neighbor: Next does not run into the next lesson");
if (!eq(neighbor(lessons, 1, 0, -1), [0, lessons[0].steps.length - 1])) fails.push("neighbor: Back does not run into the lesson before");
if (neighbor(lessons, lastPlain, lessons[lastPlain].steps.length - 1, 1) !== null) fails.push("neighbor: Next runs into a tour");
const tour = lessons.findIndex((l) => l.group);
if (tour >= 0 && neighbor(lessons, tour, 0, -1) !== null) fails.push("neighbor: Back runs out of a tour");
if (!eq(firstUndone(lessons, new Set()), [0, 0])) fails.push("firstUndone: not the first step when none is done");
const allPlain = new Set(lessons.filter((l) => !l.group).flatMap((l) => l.steps.map((s) => stepKey(l, s))));
if (firstUndone(lessons, allPlain) !== null) fails.push("firstUndone: a tour counts as a lesson to continue");
// The Try's states: the step's own code is fresh, a shown answer is the answer's.
{
  const l = lessons[0], st = l.steps[0];
  const name = `tutorial/${stepKey(l, st)}.mmlisp`;
  const { code } = parseStep(fs.readFileSync(path.join(root, name), "utf8"));
  const state = (src, shown) => stepState({ check: st.check, code, answer: st.answer, shown }, compile(src, name)).state;
  if (state(code, false) !== "fresh") fails.push("stepState: the step's own code is not fresh");
  if (state(st.answer, true) !== "answer") fails.push("stepState: a shown answer is not the answer");
  if (state(st.answer, false) !== "correct") fails.push("stepState: the answer typed is not correct");
  if (state("(fm1 c)", false) !== "notyet") fails.push("stepState: a wrong edit is not 'not yet'");
}

const files = fs.readdirSync(path.join(root, "tutorial"), { recursive: true }).filter((f) => f.endsWith(".mmlisp"));
const listed = new Set(lessons.flatMap((l) => l.steps.map((s) => `${l.id}/${s.file}.mmlisp`)));
for (const f of files) if (!listed.has(f.split(path.sep).join("/"))) fails.push(`tutorial/${f}: not in lessons.json`);
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
console.log(`Lessons ok: ${lessons.length} lesson(s), ${n} steps`);
