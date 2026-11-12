// The playhead in the source: each track's token and the step sequences
// sounding, resolved against the document the IR was built from and mapped
// through the edits since.

import { StateEffect, StateField, layer, RectangleMarker, EditorSelection } from "../../vendor/codemirror.js";

// Resolve a 1-based source span { line, column, endLine, endColumn } to a
// [from, to) document offset range, clamped to the document.
export function srcToRange(doc, src) {
  const lineObj = doc.line(src.line);
  const from = lineObj.from + (src.column - 1);
  const endLineObj = (src.endLine ?? src.line) === src.line
    ? lineObj
    : doc.line(src.endLine);
  const to = endLineObj.from + ((src.endColumn ?? src.column + 1) - 1);
  return [
    Math.max(0, Math.min(doc.length, from)),
    Math.max(from + 1, Math.min(doc.length, to)),
  ];
}

// Playhead highlights (token per track + active step sequences). IR events
// carry source positions in the document the active IR was BUILT from, but
// editing during playback does not recompile — so positions are resolved
// against that build-time document once, then MAPPED through later edits so
// the highlight follows the text. Re-anchored on play / build.
//   setTrackLine: { trackIdx, src } — trackIdx=-1 clears all; src null removes one
//   setSeq:       { show, src } or { clear: true }  (ref-counted per [...] literal)
//   setPlayheadBase: re-anchor to the current doc (the active IR was just (re)built)
export const setTrackLine = StateEffect.define();
export const setSeq = StateEffect.define();
export const setPlayheadBase = StateEffect.define();

// Resolve a build-time src to current-document [from, to): resolve against the
// anchor doc, then map through edits accumulated since the anchor. Returns null
// if the source region was deleted or reflowed away (e.g. a full reformat),
// so the highlight is dropped instead of collapsing to a stray position.
export function resolvePlayhead(src, builtDoc, changes, curDoc) {
  let from, to;
  try { [from, to] = srcToRange(builtDoc ?? curDoc, src); }
  catch (_) { return null; }
  if (changes) {
    const f = changes.mapPos(from, 1), t = changes.mapPos(to, -1);
    if (t <= f) return null;
    from = f; to = t;
  }
  from = Math.max(0, Math.min(curDoc.length, from));
  to = Math.max(0, Math.min(curDoc.length, to));
  return to > from ? [from, to] : null;
}

export const playheadField = StateField.define({
  // toks: Map<trackIdx, {from,to,cls}>; seqs: Map<"line:col", {from,to,count,cls}>
  // builtDoc: anchor Text; changes: ChangeSet since anchor (null == identity)
  create: () => ({ toks: new Map(), seqs: new Map(), builtDoc: null, changes: null }),
  update(v, tr) {
    let { toks, seqs, builtDoc, changes } = v;
    let dirty = false;
    const own = () => { if (!dirty) { toks = new Map(toks); seqs = new Map(seqs); dirty = true; } };

    // Follow edits: map existing ranges; drop any whose region collapsed
    // (deleted or reflowed, e.g. by a whole-document reformat).
    if (tr.docChanged) {
      own();
      const remap = (m) => {
        for (const [k, r] of m) {
          const from = tr.changes.mapPos(r.from, 1);
          const to = tr.changes.mapPos(r.to, -1);
          if (to > from) m.set(k, { ...r, from, to });
          else m.delete(k);
        }
      };
      remap(toks); remap(seqs);
      changes = changes ? changes.compose(tr.changes) : tr.changes;
    }

    for (const e of tr.effects) {
      if (e.is(setPlayheadBase)) {
        // The document the build was compiled from, and the edits made
        // while it compiled (null: the current document, none).
        own(); toks.clear(); seqs.clear();
        builtDoc = e.value?.doc ?? tr.state.doc; changes = e.value?.changes ?? null;
      } else if (e.is(setTrackLine)) {
        own();
        const { trackIdx, src } = e.value;
        if (trackIdx === -1) toks.clear();
        else if (!src) toks.delete(trackIdx);
        else {
          const r = resolvePlayhead(src, builtDoc, changes, tr.state.doc);
          if (r) toks.set(trackIdx, { from: r[0], to: r[1], cls: `cm-playTok-${trackIdx % 4}` });
          else toks.delete(trackIdx);
        }
      } else if (e.is(setSeq)) {
        own();
        if (e.value.clear) { seqs.clear(); continue; }
        const { show, src } = e.value;
        const key = `${src.line}:${src.column}`;
        const cur = seqs.get(key);
        const count = (cur?.count ?? 0) + (show ? 1 : -1);
        if (count <= 0) seqs.delete(key);
        else if (cur) seqs.set(key, { ...cur, count });
        else {
          const r = resolvePlayhead(src, builtDoc, changes, tr.state.doc);
          if (r) seqs.set(key, { from: r[0], to: r[1], count, cls: 'cm-playSeq' });
        }
      }
    }

    return dirty ? { toks, seqs, builtDoc, changes } : v;
  },
});

// Draw playhead highlights as a layer of rectangles over the text rather than
// Decoration.mark spans. Marks split the text into inline boxes, which under
// lineWrapping can shift the soft-wrap point as highlights come and go; a
// layer never touches the text DOM, so the layout is unaffected.
//
// A span's rectangles are kept while only the playhead moves: measuring
// them (RectangleMarker.forRange's coordsAtPos and posAtCoords) reads the
// layout, every frame of a playing song, for the same few spans over and
// over. Any other update — an edit, a scroll, a resize, a mark that may
// move a soft wrap — lets them go.
const _playheadRects = new Map();
const playheadOnly = (update) => !update.viewportChanged && !update.geometryChanged
  && update.transactions.length > 0
  && update.transactions.every((tr) => !tr.docChanged && !tr.selection
    && tr.effects.every((e) => e.is(setTrackLine) || e.is(setSeq)));
export const playheadLayer = layer({
  above: true,
  class: 'cm-playheadLayer',
  update: (update) => {
    if (!playheadOnly(update) || _playheadRects.size > 4096) _playheadRects.clear();
    return update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.startState.field(playheadField) !== update.state.field(playheadField);
  },
  markers: (view) => {
    const len = view.state.doc.length;
    const v = view.state.field(playheadField);
    const markers = [];
    const add = (r) => {
      const from = Math.max(0, Math.min(len, r.from));
      const to = Math.max(0, Math.min(len, r.to));
      if (from >= to) return;
      const key = `${from}:${to}:${r.cls}`;
      let rects = _playheadRects.get(key);
      if (!rects) {
        try { rects = RectangleMarker.forRange(view, r.cls, EditorSelection.range(from, to)); }
        catch (_) { rects = []; }
        _playheadRects.set(key, rects);
      }
      for (const m of rects) markers.push(m);
    };
    for (const r of v.seqs.values()) add(r);
    for (const r of v.toks.values()) add(r);
    return markers;
  },
});
