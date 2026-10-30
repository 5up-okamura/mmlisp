// The score's compile, off the page's thread: compileMMLisp is pure, and on a
// long score Build, Play and a value drag's hot-swap stalled the page for it.
//
//   in:  { id, src, name, imports }   (imports: Map path → source text)
//   out: { id, ir, diagnostics, sourceMap } or { id, error }
//
// The IR and the source map go back in one message, so the source positions
// they share stay shared objects on the page (the piano roll keys on them).
// With kind: 'logical', return source notes and channel spans instead. The
// persistent Logical Editor must not compile on the page after each edit.

import { compileMMLisp } from './mmlisp2ir.js';
import { layeredNotes, channelForms } from './edit-tools.js';

self.onmessage = (e) => {
  const { id, src, name, imports, kind } = e.data;
  try {
    if (kind === 'logical') {
      const notes = layeredNotes(src, { filename: name, imports });
      const forms = channelForms(src).map(({ channel, prio, from, to }) => ({ channel, prio, from, to }));
      self.postMessage({ id, notes, forms });
      return;
    }
    const { ir, diagnostics, sourceMap } = compileMMLisp(src, name, { imports });
    self.postMessage({ id, ir, diagnostics, sourceMap });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
