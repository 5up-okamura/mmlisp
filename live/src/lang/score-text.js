// A score as text: each line's start for the parser's line / column, a form
// by its head, a track's forms by channel, and the defs nothing names taken
// out — what the editor, the imports and the machine conversion all do to a
// score's text.

import { parse } from "./mmlisp-parser.js";
import { ALL_CHANNEL_NAMES } from "../machine/targets.js";

const TRACKS = new Set(ALL_CHANNEL_NAMES); // every target's channel names

// 0-based offsets of each line start, for the parser's 1-based line/column.
// The last text's are kept: the panel asks again on every cursor move, and
// a long score is a long scan — so a caller only reads them.
let _startsText = null, _starts = null;
export function lineStarts(text) {
  if (text === _startsText) return _starts;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  _startsText = text;
  _starts = starts;
  return starts;
}

// A form `(head …)` (any head when none is given).
export const isList = (n, head) => n?.kind === "list" && n.bracket === "()" && (head == null || n.items[0]?.value === head);

/**
 * A score with the defs nothing names taken out — a macro, a voice, a wave,
 * a sample of a dropped track's, one a rule replaced, one only kept — and
 * then what only they named: { text, gone } (the names, in the score's order).
 */
export function pruneUnnamedDefs(text) {
  const gone = [];
  let out = text;
  for (let pass = 0; pass < 8; pass++) {
    let roots;
    try { roots = parse(out); } catch { break; }
    const named = new Map();
    const count = (n) => {
      if (n?.kind === "atom") for (const v of new Set([n.value, String(n.value).replace(/^[$']/, "")])) named.set(v, (named.get(v) ?? 0) + 1);
      if (n?.kind === "list") n.items.forEach(count);
    };
    roots.forEach(count);
    const inside = (n, name) => { let c = 0; const w = (m) => { if (m?.kind === "atom" && m.value === name) c++; if (m?.kind === "list") m.items.forEach(w); }; w(n); return c; };
    const defs = roots.filter((n) => ["def", "def-fm", "def-wave", "def-pcm"].some((h) => isList(n, h)) && n.items[1]?.kind === "atom"
      && named.get(n.items[1].value) - inside(n, n.items[1].value) === 0);
    if (!defs.length) break;
    const starts = lineStarts(out);
    const names = [];
    for (const n of defs.sort((a, b) => b.line - a.line || b.column - a.column)) {
      const from = starts[n.line - 1] + n.column - 1, to = starts[n.endLine - 1] + n.endColumn - 1;
      // Its line too where it stood alone on it, and a blank line after.
      const lineStart = out.lastIndexOf("\n", from - 1) + 1;
      const alone = /^[ \t]*$/.test(out.slice(lineStart, from)) && out[to] === "\n";
      const end = alone && out[to + 1] === "\n" && (lineStart === 0 || out[lineStart - 2] === "\n") ? to + 2 : alone ? to + 1 : to;
      out = out.slice(0, alone ? lineStart : from) + out.slice(end);
      names.unshift(n.items[1].value);
    }
    gone.push(...names);
  }
  return { text: out, gone };
}


// A node's [from, to) in the text. Lists carry their end; an atom ends after
// its value, a string after its quotes.
export function nodeSpan(node, starts) {
  const from = starts[node.line - 1] + node.column - 1;
  if (node.endLine != null) return { from, to: starts[node.endLine - 1] + node.endColumn - 1 };
  const len = node.kind === "string" ? String(node.value).length + 2 : String(node.value).length;
  return { from, to: from + len };
}

// The score's channel forms, in order: (fm1 …), (pcm2 …) — with each body
// item's span, so an edit can land between items and never inside one. Forms
// of one channel and one :prio append into one timeline, a layer; distinct
// :prio are parallel layers of the channel.
export function channelForms(text) {
  const starts = lineStarts(text);
  const forms = [];
  const roots = parse(text);
  // A def that holds channel forms — a section, a chord on fm3-1…fm3-4
  // (language.md §9) — has them as its items, after its name.
  const isDef = (node) => node?.kind === "list" && node.items[0]?.kind === "atom" && node.items[0].value === "def";
  for (const node of roots.flatMap((n) => (isDef(n) ? n.items.slice(2) : [n]))) {
    if (node?.kind !== "list" || node.bracket !== "()") continue;
    const head = node.items[0];
    if (head?.kind !== "atom" || !TRACKS.has(head.value)) continue;
    const span = nodeSpan(node, starts);
    // `:prio N` is the head option: it picks the form's layer (language.md
    // §1) and is not part of the body, so nothing is written before it.
    const hasPrio = node.items[1]?.value === ":prio";
    const body = node.items.slice(hasPrio ? 3 : 1);
    forms.push({
      channel: head.value,
      prio: hasPrio ? Number(node.items[2]?.value) : 8,
      from: span.from,
      to: span.to,
      head: nodeSpan(hasPrio && node.items[2] ? node.items[2] : head, starts),
      items: body.map((n) => ({ node: n, ...nodeSpan(n, starts) })),
    });
  }
  return forms;
}
