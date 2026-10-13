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
// item's span, so an edit can land between items and never inside one. Forms
// of one channel and one :prio append into one timeline, a layer; distinct
// :prio are parallel layers of the channel.
export function channelForms(text) {
  const starts = lineStarts(text);
  const forms = [];
  for (const node of parse(text)) {
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
 * whole items, so a selection never splits a note or a form) — `#top` when
 * they are the whole channel. A selection
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
  // A layer is one channel at one :prio; a loop lives in a layer.
  const key = (f) => `${f.channel}/${f.prio}`;
  const layers = [...new Map(touched.map((f) => [key(f), f])).values()];
  const layerForms = (f) => forms.filter((g) => key(g) === key(f));
  const channelLabels = (ch) => labelsIn(forms.filter((g) => g.channel === ch));
  const layered = (ch) => new Set(forms.filter((g) => g.channel === ch).map((g) => g.prio)).size > 1;
  const name = (f) => (layered(f.channel) ? `${f.channel} (prio ${f.prio})` : f.channel);

  if (!empty && layers.length === 1) {
    // One layer: the selected items, snapped out to whole body items.
    const layer = layers[0];
    const items = touched.flatMap((f) => f.items);
    const first = items.find((it) => it.to > selFrom);
    const last = [...items].reverse().find((it) => it.from < selTo);
    if (!first || !last || first.from > last.from)
      return { error: "nothing to loop: the selection holds no notes of the channel" };
    const all = layerForms(layer).flatMap((f) => f.items);
    const deadAfter = all.some((it) => it.from >= last.to);
    // A selection that spans the whole layer loops it whole: `#top`.
    const whole = first === all[0] && !deadAfter;
    const label = freeLabel(whole ? "top" : "loop", channelLabels(layer.channel));
    return {
      mode: "range",
      channels: [layer.channel],
      layers: [name(layer)],
      skipped: [],
      deadAfter,
      changes: [
        { from: first.from, to: first.from, insert: `#${label} ` },
        { from: last.to, to: last.to, insert: ` (go ${label})` },
      ],
    };
  }

  // Whole layers: one loop each, from its first form's head to its last
  // form's end. A layer already ending in an infinite go is left alone. Layers
  // of one channel that loop must start and end together (E_PRIO_LAYER_LOOP).
  const changes = [];
  const done = [];
  const skipped = [];
  for (const layer of layers) {
    const fs = layerForms(layer);
    const firstForm = fs[0];
    const lastForm = fs[fs.length - 1];
    if (isInfiniteGo(lastForm.items[lastForm.items.length - 1])) {
      skipped.push(name(layer));
      continue;
    }
    const taken = channelLabels(layer.channel);
    for (const c of changes) if (c.label && c.channel === layer.channel) taken.add(c.label);
    const label = freeLabel("top", taken);
    const at = firstForm.items[0]?.from ?? firstForm.head.to;
    changes.push({ from: at, to: at, insert: firstForm.items[0] ? `#${label} ` : ` #${label}`, label, channel: layer.channel });
    changes.push({ from: lastForm.to - 1, to: lastForm.to - 1, insert: ` (go ${label})` });
    done.push(layer);
  }
  if (done.length === 0) return { error: `already looping: ${skipped.join(", ")}` };
  changes.sort((a, b) => a.from - b.from);
  return {
    mode: "whole",
    channels: [...new Set(done.map((f) => f.channel))],
    layers: done.map(name),
    skipped,
    deadAfter: false,
    changes: changes.map(({ from, to, insert }) => ({ from, to, insert })),
  };
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

// ── Edit > Logical Editor ────────────────────────────────────────────────
// Find the notes (and rests) that meet a condition, then act on their text.
// The compiled IR says what each note IS — its pitch, length, sample and the
// token that wrote it (src) — so matching never re-implements the compiler;
// the edits rewrite those tokens in place.

const WHOLE = 384; // ticks in a whole note (PPQN 96)
const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// MIDI number of a pitch name with or without an octave ("e+5", "b-", "c").
export function pitchMidi(name, octave = 4) {
  const m = /^([a-g])([+\-#]*)(-?\d+)?$/i.exec(String(name).trim());
  if (!m) return null;
  let n = STEP[m[1].toLowerCase()];
  for (const ch of m[2]) n += ch === "-" ? -1 : 1;
  const oct = m[3] != null ? Number(m[3]) : octave;
  return n + (oct + 1) * 12;
}

// A length as the score writes it — `8`, `4.`, `96t`, `1/3` — in ticks.
export function lengthTicks(str) {
  const s = String(str).trim();
  let m;
  if ((m = /^(\d+)t$/.exec(s))) return Number(m[1]);
  if ((m = /^(\d+)\/(\d+)$/.exec(s))) return (WHOLE * Number(m[1])) / Number(m[2]);
  if ((m = /^(\d+)(\.*)$/.exec(s))) {
    let t = WHOLE / Number(m[1]);
    let add = t / 2;
    for (let i = 0; i < m[2].length; i++, add /= 2) t += add;
    return t;
  }
  return null;
}

// The shortest suffix the score reads back as `ticks`.
export function lengthSuffix(ticks) {
  for (const n of [1, 2, 4, 8, 16, 32, 64, 3, 6, 12, 24, 48, 96]) {
    if (WHOLE / n === ticks) return String(n);
    if ((WHOLE / n) * 1.5 === ticks) return `${n}.`;
  }
  return `${Math.max(1, Math.round(ticks))}t`;
}

// A note token split into its pitch part and its length suffix: "d4." → d / 4.
function splitToken(tok) {
  const m = /^([a-g][+\-#]*|_)(.*)$/i.exec(tok);
  return m ? { head: m[1], suffix: m[2] } : null;
}

// Every note and rest the IR plays, tied back to its token. `shared` marks a
// token that sounds more than once or outside its channel — inside a counted
// loop, or in a def — where one edit changes every pass; `tied` one joined by
// ~ to its neighbour, whose length is not its own to change.
export function scoreNotes(text, ir, voiceNames = new Set()) {
  const starts = lineStarts(text);
  const forms = channelForms(text);
  const out = [];
  const seen = new Map();
  for (const track of ir?.tracks ?? []) {
    const channel = track.scoreChannel ?? track.channel;
    let depth = 0;
    const evs = track.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.cmd === "LOOP_BEGIN") depth++;
      else if (e.cmd === "LOOP_END") depth = Math.max(0, depth - 1);
      const isNote = e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON";
      if (!isNote && e.cmd !== "REST") continue;
      const src = e.src;
      if (!src || src.file || src.line == null || src.endLine !== src.line) continue;
      const from = starts[src.line - 1] + src.column - 1;
      const to = starts[src.line - 1] + src.endColumn - 1;
      const token = text.slice(from, to);
      if (!splitToken(token)) continue; // a (note n) form or the like: not a plain token
      const form = forms.find((f) => f.channel === channel && from >= f.from && to <= f.to);
      const next = evs.slice(i + 1).find((x) => x.cmd !== "PARAM_SET");
      const n = {
        from, to, token, channel, tick: e.tick, len: e.args?.length ?? 0,
        kind: isNote ? "note" : "rest",
        pitch: isNote ? e.args.pitch : null,
        midi: isNote ? pitchMidi(e.args.pitch) : null,
        sample: e.args?.sample ?? null,
        voice: e.args?.sample ?? (form ? voiceAt(form, forms, from, voiceNames) : null),
        prio: form?.prio ?? null,
        direct: !!form?.items.some((it) => it.from === from),
        shared: depth > 0 || !form,
        tied: !!(e.args?.legato || next?.cmd === "TIE" || next?.args?.legato),
      };
      out.push(n);
      seen.set(from, (seen.get(from) ?? 0) + 1);
    }
  }
  for (const n of out) if (seen.get(n.from) > 1) n.shared = true;
  return out.sort((a, b) => a.from - b.from);
}

// scoreNotes for every layer, the notes a higher layer hides included. The
// compiler merges a channel's :prio layers into one stream and drops what a
// higher layer covers, so each layer of a layered channel is compiled alone —
// the channel's other layers blanked out, space for space, so every offset
// stays where it is. `compile(text)` returns the IR (with the score's imports).
export function layeredNotes(text, compile, voiceNames = new Set()) {
  const forms = channelForms(text);
  const prios = new Map();
  for (const f of forms) prios.set(f.channel, (prios.get(f.channel) ?? new Set()).add(f.prio));
  const layered = new Set([...prios].filter(([, ps]) => ps.size > 1).map(([ch]) => ch));
  const notes = scoreNotes(text, compile(text), voiceNames).filter((n) => !layered.has(n.channel));
  for (const ch of layered) {
    for (const p of prios.get(ch)) {
      let alone = text;
      for (const f of forms)
        if (f.channel === ch && f.prio !== p)
          alone = alone.slice(0, f.from) + alone.slice(f.from, f.to).replace(/[^\n]/g, " ") + alone.slice(f.to);
      notes.push(...scoreNotes(alone, compile(alone), voiceNames).filter((n) => n.channel === ch));
    }
  }
  return notes.sort((a, b) => a.from - b.from);
}

// The voice (a def-fm / def-pcm name) in force at `offset` in a channel: the
// last one named before it across the channel's forms, top level.
function voiceAt(form, forms, offset, voiceNames) {
  let voice = null;
  for (const f of forms) {
    if (f.channel !== form.channel || f.prio !== form.prio || f.from > offset) continue;
    for (const it of f.items) {
      if (it.from >= offset) break;
      if (it.node.kind === "atom" && voiceNames.has(it.node.value)) voice = it.node.value;
    }
  }
  return voice;
}

/**
 * The notes meeting a condition.
 * @param {object} q  {scope: 'selection'|'layer'|'channel'|'all', from, to, channel, prio,
 *   pitch: {kind: 'any'|'rest'|'name'|'range', name, low, high},
 *   length: {op: 'any'|'eq'|'gt'|'lt', ticks}, voice: '' | name}
 */
export function matchNotes(notes, q) {
  const channel = q.scope === "channel" || q.scope === "layer" ? q.channel ?? null : null;
  const pc = q.pitch?.kind === "name" ? pitchMidi(q.pitch.name) : null;
  const lo = q.pitch?.kind === "range" ? pitchMidi(q.pitch.low) : null;
  const hi = q.pitch?.kind === "range" ? pitchMidi(q.pitch.high) : null;
  return notes.filter((n) => {
    if (q.scope === "selection" && !(n.from < q.to && n.to > q.from)) return false;
    if (q.scope === "channel" && n.channel !== channel) return false;
    if (q.scope === "layer" && (n.channel !== channel || n.prio !== q.prio)) return false;
    const p = q.pitch?.kind ?? "any";
    if (p === "rest" ? n.kind !== "rest" : n.kind !== "note") return false;
    if (p === "name" && (pc == null || (((n.midi - pc) % 12) + 12) % 12 !== 0)) return false;
    if (p === "range" && (lo == null || hi == null || n.midi < Math.min(lo, hi) || n.midi > Math.max(lo, hi))) return false;
    const L = q.length ?? { op: "any" };
    if (L.op === "eq" && n.len !== L.ticks) return false;
    if (L.op === "gt" && !(n.len > L.ticks)) return false;
    if (L.op === "lt" && !(n.len < L.ticks)) return false;
    if (q.voice && n.voice !== q.voice) return false;
    return true;
  });
}

/**
 * Act on matched notes. op: {type: 'rest'|'remove'|'len-set'|'len-add'|
 * 'len-mul'|'reverse', ticks, factor, includeShared}.
 * @returns {{changes, done: number, skipped: {shared, tied}} | {error}}
 */
export function applyLogical(text, notes, matches, op) {
  const skipped = { shared: 0, tied: 0 };
  if (op.type === "reverse") return reverseRuns(text, notes, matches);
  const changes = [];
  const done = new Set();
  for (const n of matches) {
    if (n.tied) { skipped.tied++; continue; }
    if (n.shared && !op.includeShared) { skipped.shared++; continue; }
    if (done.has(n.from)) continue;
    done.add(n.from);
    const { head, suffix } = splitToken(n.token);
    if (op.type === "rest") {
      if (n.kind !== "rest") changes.push({ from: n.from, to: n.to, insert: `_${suffix}` });
    } else if (op.type === "remove") {
      // Take the token and the space after it (or before it, at a form's end).
      let from = n.from;
      let to = n.to;
      if (/[ \t]/.test(text[to] ?? "")) to++;
      else if (/[ \t]/.test(text[from - 1] ?? "")) from--;
      changes.push({ from, to, insert: "" });
    } else {
      const ticks = op.type === "len-set" ? op.ticks
        : op.type === "len-add" ? n.len + op.ticks
        : n.len * op.factor;
      if (!(ticks >= 1)) return { error: `a length would fall to ${ticks} ticks` };
      changes.push({ from: n.from, to: n.to, insert: `${head}${lengthSuffix(Math.round(ticks))}` });
    }
  }
  return { changes, done: done.size, skipped };
}

// Reverse, per channel, the run from the first matched note to the last:
// every note and rest between them trades places, so the rhythm reverses
// too. The tokens keep their places; each takes the content of its mirror,
// written out in full — its own length, and the octave (and sample) it needs
// against the context there, restored after — so nothing around it changes.
function reverseRuns(text, notes, matches) {
  const changes = [];
  let done = 0;
  const forms = channelForms(text);
  const key = (n) => `${n.channel}/${n.prio}`;
  for (const layer of [...new Set(matches.map(key))]) {
    // The run is set by the layer's own notes; one in a def or a loop is a
    // token many places share, not a place in this layer's timeline.
    const ms = matches.filter((m) => key(m) === layer && !m.shared).sort((a, b) => a.from - b.from);
    if (ms.length === 0) continue;
    const first = ms[0];
    const last = ms[ms.length - 1];
    const name = first.prio != null && first.prio !== 8 ? `${first.channel} (prio ${first.prio})` : first.channel;
    // Forms of one layer append into one timeline, so a run may cross them.
    const lforms = forms.filter((f) => `${f.channel}/${f.prio}` === layer && f.to > first.from && f.from < last.to);
    const run = notes.filter((n) => key(n) === layer && n.from >= first.from && n.to <= last.to);
    const bad = run.find((n) => n.shared || n.tied || !n.direct);
    if (bad) return { error: `${name}: reverse needs plain notes and rests — "${bad.token}" sits in a loop, a def, a nested form or a tie` };
    if (run.length < 2) continue;
    // The octave and sample in force at each element, walking the run's items.
    const at = new Map();
    let oct = Math.floor(run[0].midi / 12) - 1;
    let sample = run[0].sample;
    const items = lforms.flatMap((f) => f.items).filter((it) => it.from >= first.from && it.to <= last.to);
    const sampleNames = new Set(run.map((n) => n.sample).filter(Boolean));
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const n = run.find((x) => x.from === it.from);
      if (n) {
        at.set(n.from, { oct, sample });
        if (n.kind === "note") { oct = Math.floor(n.midi / 12) - 1; sample = n.sample ?? sample; }
        continue;
      }
      const v = it.node.kind === "atom" ? it.node.value : null;
      if (v === ">") oct++;
      else if (v === "<") oct--;
      else if (v === ":oct") oct = Number(items[k + 1]?.node.value ?? oct);
      else if (v && sampleNames.has(v)) sample = v;
    }
    const rev = [...run].reverse();
    const slots = run.map((slot, i) => {
      const src = rev[i];
      const ctx = at.get(slot.from);
      let insert;
      if (src.kind === "rest") insert = `_${lengthSuffix(src.len)}`;
      else {
        const pname = /^([a-g][+\-#]*)/i.exec(src.pitch)[1];
        const d = Math.floor(src.midi / 12) - 1 - ctx.oct;
        const up = d > 0 ? "> ".repeat(d) : "< ".repeat(-d);
        const down = d > 0 ? " <".repeat(d) : " >".repeat(-d);
        insert = `${up}${pname}${lengthSuffix(src.len)}${down}`;
        if (src.sample && ctx.sample && src.sample !== ctx.sample) insert = `${src.sample} ${insert} ${ctx.sample}`;
      }
      return { from: slot.from, to: slot.to, insert };
    });
    // One change per form the run crosses, with the octave marks that now
    // cancel — a `>` written right before a `<` — taken out. Only the pair
    // goes; the spacing around it is the writer's.
    for (const f of lforms) {
      const from = Math.max(f.from, first.from);
      const to = Math.min(f.to, last.to);
      const local = slots.filter((c) => c.from >= from && c.to <= to).map((c) => ({ ...c, from: c.from - from, to: c.to - from }));
      if (local.length === 0) continue;
      let span = applyChanges(text.slice(from, to), local);
      for (let prev = null; prev !== span; ) {
        prev = span;
        span = span.replace(/[ \t](?:> <|< >)(?=[ \t]|$)/g, "").replace(/^(?:> <|< >)(?:[ \t]|$)/, "");
      }
      if (span !== text.slice(from, to)) changes.push({ from, to, insert: span });
    }
    done += run.length;
  }
  return { changes, done, skipped: { shared: 0, tied: 0 } };
}

// The voice and sample names the texts define (def-fm / def-pcm), for the
// Logical Editor's voice condition: a score's own and its imports'.
export function voiceDefNames(texts) {
  const names = new Set();
  for (const t of texts) {
    let roots;
    try { roots = parse(t); } catch { continue; }
    for (const n of roots) {
      if (n?.kind !== "list") continue;
      const head = n.items[0]?.value;
      const name = n.items[1]?.value;
      if ((head === "def-fm" || head === "def-pcm") && typeof name === "string") names.add(name);
    }
  }
  return names;
}
