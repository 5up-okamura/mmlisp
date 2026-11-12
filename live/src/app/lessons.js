// Tools > Guide: the tutorial's steps, read from tutorial/ — one score per
// step, its leading comment the text the lesson shows and the rest the code
// the lesson's working copy starts from, as a snippet is read
// (snippets/README.md). A step's "Try:" is an exercise, and its check
// (tutorial/lessons.json) says when the code does it:
//
//   { "notesMin": 7 }      the score plays at least 7 notes
//   { "match": "re" }      the code (comments left out) matches the pattern
//   { "tempoMin": 91 }     a tempo at least that fast
//   { "tracksMin": 3 }     at least 3 tracks play notes
//   { "velsMin": 2 }       the notes are struck at 2 velocities or more
//   { "sameLength": true } every track that plays notes takes as long, its
//                          repeats counted out (ir/timing.js playedTicks)
//
// A score that does not compile passes nothing.
//
// Everything here is the lessons' logic without the page: the keys a step's
// texts are found and translated under, which step comes next, what a
// compile says of a Try. live/index.html draws from it; tools
// `npm run check:lessons` and i18n-sync.mjs read it too.
import { playedTicks } from "../ir/timing.js";

/** A step's file: { about, task, code }. */
export function parseStep(text) {
  const lines = String(text).split("\n");
  const lead = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*;+\s?(.*)$/.exec(lines[i]);
    if (!m) break;
    lead.push(m[1]);
  }
  const join = (ls) => ls.join(" ").replace(/\s+/g, " ").trim();
  const at = lead.findIndex((l) => /^Try:/.test(l));
  const about = join(at < 0 ? lead : lead.slice(0, at));
  const task = at < 0 ? "" : join(lead.slice(at)).replace(/^Try:\s*/, "");
  return { about, task, code: lines.slice(i).join("\n").trim() + "\n" };
}

/** A step's key, "01-sound/01-notes": its file under tutorial/ and its progress. */
export const stepKey = (lesson, step) => `${lesson.id}/${step.file}`;

/** The keys a step's texts are translated under (i18n.js lessonText, i18n-sync.mjs). */
export const textKeys = (key) => ({ title: key, about: `${key}.mmlisp`, task: `${key}.mmlisp#try` });

// --- the walk ---------------------------------------------------------------
// The lessons are walked in order, one into the next; a group's lesson (a
// machine's tour) stands alone, picked from the list. A place is [li, si].

/** The first step of the lessons (not the tours) not yet done, or null. */
export function firstUndone(lessons, done) {
  for (const [li, l] of lessons.entries()) {
    if (l.group) continue;
    const si = l.steps.findIndex((st) => !done.has(stepKey(l, st)));
    if (si >= 0) return [li, si];
  }
  return null;
}

/** The step Back (dir -1) or Next (+1) goes to from [li, si], or null. */
export function neighbor(lessons, li, si, dir) {
  const lesson = lessons[li];
  const at = si + dir;
  if (at >= 0 && at < lesson.steps.length) return [li, at];
  const other = lessons[li + dir];
  if (!other || lesson.group || other.group) return null;
  return [li + dir, dir < 0 ? other.steps.length - 1 : 0];
}

// The code without its comments: a pattern looks at what plays.
const codeOnly = (src) => String(src).replace(/;[^\n]*/g, "");

/**
 * What a compile says of the step's check: `ok`, and when not, `why` — what
 * the learner can act on (the error, the count so far), or "" for a pattern.
 * @param {object|null} check
 * @param {{src: string, ir: object|null, diagnostics: object[]}} compiled
 */
export function verdict(check, { src, ir, diagnostics }) {
  const error = (diagnostics ?? []).find((d) => d.severity === "error");
  if (error || !ir) return { ok: false, why: `the score has an error: ${error?.message ?? "it does not compile"}` };
  if (!check) return { ok: false, why: "" };
  const events = (ir.tracks ?? []).flatMap((t) => t.events ?? []);
  if (check.notesMin != null) {
    const n = events.filter((e) => e.cmd === "NOTE_ON").length;
    if (n < check.notesMin) return { ok: false, why: `${n} notes so far; it needs ${check.notesMin}` };
  }
  if (check.match != null && !new RegExp(check.match).test(codeOnly(src))) return { ok: false, why: "" };
  const playing = (ir.tracks ?? []).filter((t) => (t.events ?? []).some((e) => e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON"));
  if (check.tracksMin != null && playing.length < check.tracksMin)
    return { ok: false, why: `${playing.length} tracks play; it needs ${check.tracksMin}` };
  if (check.sameLength) {
    const lens = playing.map((t) => [t.scoreChannel ?? t.channel, playedTicks(t.events)]);
    if (new Set(lens.map(([, n]) => n)).size > 1) {
      const bars = (n) => `${+(n / 384).toFixed(2)} bar${n === 384 ? "" : "s"}`;
      return { ok: false, why: lens.map(([c, n]) => `${c} ${bars(n)}`).join(", ") };
    }
  }
  if (check.velsMin != null) {
    const vels = new Set(events.filter((e) => e.cmd === "NOTE_ON").map((e) => e.args?.vel ?? 15));
    if (vels.size < check.velsMin) return { ok: false, why: `every note is struck at ${[...vels].join(", ") || "15"}` };
  }
  if (check.tempoMin != null) {
    const set = events.filter((e) => e.cmd === "TEMPO_SET").map((e) => e.args?.bpm ?? 0);
    const bpm = set.length ? Math.max(...set) : 120; // 120 unless the score says
    if (bpm < check.tempoMin) return { ok: false, why: `the tempo is ${bpm}; it needs ${check.tempoMin} or more` };
  }
  return { ok: true, why: "" };
}

/** Whether a compile does what the step's check asks. */
export const passes = (check, compiled) => verdict(check, compiled).ok;

/**
 * Where a compile leaves the step's Try: `state` is "fresh" (its own code,
 * untouched: not a wrong answer yet), "answer" (the one Show Answer put in:
 * not the learner's, so it ticks nothing), "correct" or "notyet"; `why` says
 * what is missing.
 */
export function stepState({ check, code, answer, shown }, compiled) {
  const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
  const { ok, why } = verdict(check, compiled);
  const state = shown && same(compiled.src, answer) ? "answer"
    : ok ? "correct"
    : same(compiled.src, code) ? "fresh" : "notyet";
  return { state, why };
}

/** What the Try box says in each state (the app's words, in English). */
export function statusText({ state, why }, doneBefore) {
  return {
    fresh: doneBefore ? "✓ Done before. Checked as you type." : "Checked as you type.",
    notyet: `Not yet${why ? " — " + why : ""}.`,
    correct: "✓ Correct! On to Next.",
    answer: "This is one answer. Start Over to try it yourself.",
  }[state];
}

// Progress: the steps passed, by "lesson/step", in this browser.
const STORE_KEY = "mmlisp.lessons";

export function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    return { done: new Set(p?.done ?? []) };
  } catch (_) {
    return { done: new Set() };
  }
}

export function saveProgress({ done }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ done: [...done] }));
  } catch (_) { /* no storage: progress lasts the page */ }
}
