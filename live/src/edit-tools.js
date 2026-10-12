// Edit > Loop Selection: text edits the editor applies to the score, kept
// apart from the page so they can be run (and checked) in node. Every function
// here takes source text and offsets and returns CodeMirror-style changes
// ({from, to, insert}); nothing touches the editor.

import { parse } from "./mmlisp-parser.js";
import { AC_TRACKS } from "./completion-names.js";

const TRACKS = new Set(AC_TRACKS);

// 0-based offsets of each line start, for the parser's 1-based line/column.
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

// A node's [from, to) in the text. Lists carry their end; an atom ends after
// its value, a string after its quotes.
function nodeSpan(node, starts) {
  const from = starts[node.line - 1] + node.column - 1;
  if (node.endLine != null) return { from, to: starts[node.endLine - 1] + node.endColumn - 1 };
  const len = node.kind === "string" ? String(node.value).length + 2 : String(node.value).length;
  return { from, to: from + len };
}

// The score's channel forms, in order: (fm1 …), (pcm2 …) — with each body
// item's span, so an edit can land between items and never inside one.
export function channelForms(text) {
  const starts = lineStarts(text);
  const forms = [];
  for (const node of parse(text)) {
    if (node?.kind !== "list" || node.bracket !== "()") continue;
    const head = node.items[0];
    if (head?.kind !== "atom" || !TRACKS.has(head.value)) continue;
    const span = nodeSpan(node, starts);
    forms.push({
      channel: head.value,
      from: span.from,
      to: span.to,
      head: nodeSpan(head, starts),
      items: node.items.slice(1).map((n) => ({ node: n, ...nodeSpan(n, starts) })),
    });
  }
  return forms;
}

// Labels written in a channel's forms, anywhere in them (#name atoms).
function labelsIn(forms) {
  const names = new Set();
  const walk = (n) => {
    if (n?.kind === "atom" && n.value.startsWith("#") && n.value.length > 1) names.add(n.value.slice(1));
    if (n?.kind === "list") n.items.forEach(walk);
  };
  for (const f of forms) f.items.forEach((it) => walk(it.node));
  return names;
}

function freeLabel(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(base + i)) return base + i;
}

// An infinite `(go label)` — the form already loops back from its end.
function isInfiniteGo(item) {
  const n = item?.node;
  return n?.kind === "list" && n.items[0]?.value === "go" && n.items.length === 2;
}

/**
 * Loop the selection. Inside one channel the selected items become the loop:
 * `#loop` before the first, `(go loop)` after the last (snapped outward to
 * whole items, so a selection never splits a note or a form). A selection
 * across channels — or a bare cursor — loops each channel it touches whole:
 * `#top` at the head of its first form, `(go top)` at the end of its last.
 * @returns {{changes: {from:number,to:number,insert:string}[], channels: string[],
 *            mode: 'range'|'whole', skipped: string[], deadAfter: boolean} | {error: string}}
 */
export function loopSelection(text, selFrom, selTo) {
  let forms;
  try {
    forms = channelForms(text);
  } catch (e) {
    return { error: `the score does not parse: ${e.message}` };
  }
  const empty = selFrom === selTo;
  const touched = forms.filter((f) =>
    empty ? selFrom >= f.from && selFrom <= f.to : selFrom < f.to && selTo > f.from);
  if (touched.length === 0) return { error: "the selection is not inside a channel form" };
  const channels = [...new Set(touched.map((f) => f.channel))];
  const formsOf = (ch) => forms.filter((f) => f.channel === ch);

  if (!empty && channels.length === 1) {
    // One channel: the selected items, snapped out to whole body items.
    const ch = channels[0];
    const items = touched.flatMap((f) => f.items);
    const first = items.find((it) => it.to > selFrom);
    const last = [...items].reverse().find((it) => it.from < selTo);
    if (!first || !last || first.from > last.from)
      return { error: "nothing to loop: the selection holds no notes of the channel" };
    const label = freeLabel("loop", labelsIn(formsOf(ch)));
    const all = formsOf(ch).flatMap((f) => f.items);
    const deadAfter = all.some((it) => it.from >= last.to);
    return {
      mode: "range",
      channels,
      skipped: [],
      deadAfter,
      changes: [
        { from: first.from, to: first.from, insert: `#${label} ` },
        { from: last.to, to: last.to, insert: ` (go ${label})` },
      ],
    };
  }

  // Whole channels: one loop each, from its first form's head to its last
  // form's end. A channel already ending in an infinite go is left alone.
  const changes = [];
  const done = [];
  const skipped = [];
  for (const ch of channels) {
    const fs = formsOf(ch);
    const firstForm = fs[0];
    const lastForm = fs[fs.length - 1];
    if (isInfiniteGo(lastForm.items[lastForm.items.length - 1])) {
      skipped.push(ch);
      continue;
    }
    const label = freeLabel("top", labelsIn(fs));
    const at = firstForm.items[0]?.from ?? firstForm.head.to;
    const sep = firstForm.items[0] ? " " : "";
    changes.push({ from: at, to: at, insert: firstForm.items[0] ? `#${label}${sep}` : ` #${label}` });
    changes.push({ from: lastForm.to - 1, to: lastForm.to - 1, insert: ` (go ${label})` });
    done.push(ch);
  }
  if (done.length === 0) return { error: `already looping: ${skipped.join(", ")}` };
  changes.sort((a, b) => a.from - b.from);
  return { mode: "whole", channels: done, skipped, deadAfter: false, changes };
}

// Apply changes (sorted, non-overlapping) to text — for node checks; the
// editor dispatches them itself.
export function applyChanges(text, changes) {
  let out = "";
  let at = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

// Each looping channel's loop length in ticks, from compiled IR: an infinite
// JUMP back to its MARKER. `{channel: ticks}`.
export function loopLengths(ir) {
  const out = {};
  for (const t of ir?.tracks ?? []) {
    const marks = new Map();
    for (const e of t.events) if (e.cmd === "MARKER") marks.set(e.args?.id, e.tick);
    for (const e of t.events) {
      if (e.cmd !== "JUMP" || !marks.has(e.args?.to)) continue;
      const len = e.tick - marks.get(e.args.to);
      if (len > 0) out[t.scoreChannel ?? t.channel] = len;
    }
  }
  return out;
}
