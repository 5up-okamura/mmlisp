// MMLisp > Lessons: the tutorial's steps, read from tutorial/ — one score per
// step, its leading comment the text the lesson shows and the rest the code
// the lesson's working copy starts from, as a snippet is read
// (snippets/README.md). A step's "Try:" is an exercise, and its check
// (tutorial/lessons.json) says when the code does it:
//
//   { "notesMin": 7 }      the score plays at least 7 notes
//   { "match": "re" }      the code (comments left out) matches the pattern
//   { "tempoMin": 91 }     a tempo at least that fast
//
// A score that does not compile passes nothing. Testable in node
// (tools `npm run check:lessons`).

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

/** The leading comment as the Library and i18n read it: about and task in one. */
export function stepText(text) {
  const { about, task } = parseStep(text);
  return task ? `${about} Try: ${task}` : about;
}

// The code without its comments: a pattern looks at what plays.
const codeOnly = (src) => String(src).replace(/;[^\n]*/g, "");

/**
 * Whether a compile does what the step's check asks.
 * @param {object|null} check
 * @param {{src: string, ir: object|null, diagnostics: object[]}} compiled
 */
export function passes(check, { src, ir, diagnostics }) {
  if (!check || !ir) return false;
  if ((diagnostics ?? []).some((d) => d.severity === "error")) return false;
  const events = (ir.tracks ?? []).flatMap((t) => t.events ?? []);
  if (check.notesMin != null && events.filter((e) => e.cmd === "NOTE_ON").length < check.notesMin) return false;
  if (check.match != null && !new RegExp(check.match).test(codeOnly(src))) return false;
  if (check.tempoMin != null && !events.some((e) => e.cmd === "TEMPO_SET" && e.args?.bpm >= check.tempoMin)) return false;
  return true;
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
