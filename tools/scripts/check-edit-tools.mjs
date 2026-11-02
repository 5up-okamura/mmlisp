// Source-edit regressions: notation, target sound names and actual edit extent.
import assert from 'node:assert/strict';
import { compileMMLisp } from '../../live/src/mmlisp2ir.js';
import { parse } from '../../live/src/mmlisp-parser.js';
import { layeredNotes, matchNotes, applyLogical, logicalAffected, logicalInputError, excludedBy, sampleDefOf, writtenPoints, samplePoints, moveSamplePoint, samplePointEdit, trimSampleEdits, importFxChain, ownDefText } from '../../live/src/edit-tools.js';

let count = 0;
const check = (name, run) => { run(); count++; console.log(`ok ${name}`); };
const edit = (text, changes) => [...changes].sort((a, b) => b.from - a.from)
  .reduce((s, c) => s.slice(0, c.from) + c.insert + s.slice(c.to), text);
const pitches = (text) => compileMMLisp(text).ir.tracks.flatMap((t) => t.events.filter((e) => e.cmd === 'NOTE_ON').map((e) => e.args.pitch));
const query = (over = {}) => ({ scope: 'all', pitch: { kind: 'any' }, length: { op: 'any' }, ...over });

check(':key transpose moves the sounding pitch exactly once', () => {
  const text = '(def-fm lead init-fm :key 61) (fm1 lead c e)';
  const notes = layeredNotes(text);
  assert.deepEqual(notes.map((n) => n.pitch), ['c4', 'e4']);
  const result = applyLogical(text, notes, notes, { type: 'transpose', semitones: 1 });
  assert.deepEqual(pitches(edit(text, result.changes)), ['d4', 'f+4']);
});
check('reverse keeps written pitch through voice key changes and rests', () => {
  const text = '(def-fm lead init-fm :key 61) (def-fm brass init-fm :key 62) (fm1 > _ lead c brass e)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, notes, { type: 'reverse' });
  assert.ok(!result.error, result.error);
  const resultNotes = layeredNotes(edit(text, result.changes));
  assert.deepEqual(resultNotes.map((n) => n.pitch), ['e5', 'c5', null]);
});
check('reverse keeps enharmonic pitch and separate token ranges', () => {
  const text = '(fm1 b+ e c-)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, notes, { type: 'reverse' });
  assert.ok(!result.error, result.error);
  assert.deepEqual(layeredNotes(edit(text, result.changes)).map((n) => n.midi), notes.map((n) => n.midi).reverse());
  assert.ok(result.changes.every((c) => notes.some((n) => c.from === n.from && c.to === n.to)));
});
check('shuffle does not become the written length', () => {
  const text = '(fm1 :shuffle [2 1] :len 16 c d e f)';
  const notes = layeredNotes(text);
  assert.deepEqual(notes.map((n) => n.len), [24, 24, 24, 24]);
  const result = applyLogical(text, notes, notes, { type: 'len-mul', factor: 2 });
  assert.deepEqual(layeredNotes(edit(text, result.changes)).map((n) => n.len), [48, 48, 48, 48]);
});
check('compiler resolves sound switches inside snippets', () => {
  const text = '(def-fm lead init-fm) (def pick lead) (fm1 c pick d)';
  assert.deepEqual(layeredNotes(text).map((n) => n.voice), ['init-fm', 'lead']);
});
check('target ROM voices and imported voices are candidates', () => {
  const text = '(def-score :target msx) (import "voices") (fm1 piano c lead d)';
  const notes = layeredNotes(text, { imports: new Map([['voices', '(def-fm lead init-fm)']]) });
  assert.deepEqual(notes.map((n) => n.voice), ['piano', 'lead']);
});
check('named waves, wave expressions and macros remain distinct', () => {
  const def = '(def-wave saw :wave (saw -128..127))';
  const text = `(def-score :target msx) ${def} (wave1 saw c :wave (* saw 0.5) d saw (macro :wave [saw]) e (macro :wave none) f saw g)`;
  assert.deepEqual(layeredNotes(text).map((n) => n.voice), ['saw', null, null, null, 'saw']);
});
check('sample names follow the compiler too', () => {
  const text = '(def-pcm hit :file "hit.wav") (def choose hit) (pcm1 choose c d)';
  assert.deepEqual(layeredNotes(text).map((n) => n.voice), ['hit', 'hit']);
});
check('all priority layers remain editable', () => {
  const notes = layeredNotes('(fm1 :prio 2 c) (fm1 :prio 8 e)');
  assert.equal(notes.length, 2);
  assert.deepEqual(new Set(notes.map((n) => n.prio)), new Set([2, 8]));
});
check('empty selection and cursor outside a channel never widen scope', () => {
  const notes = layeredNotes('(fm1 c d)');
  assert.equal(matchNotes(notes, query({ scope: 'selection', from: 6, to: 6 })).length, 0);
  assert.equal(matchNotes(notes, query({ scope: 'channel', channel: null })).length, 0);
});
check('shared def edits are opt-in and transpose the source once', () => {
  const text = '(def riff c d) (fm1 riff riff)';
  const notes = layeredNotes(text);
  assert.ok(notes.every((n) => n.shared));
  assert.equal(applyLogical(text, notes, notes, { type: 'transpose', semitones: 1 }).changes.length, 0);
  const result = applyLogical(text, notes, notes, { type: 'transpose', semitones: 1, includeShared: true });
  assert.equal(result.done, 2);
  assert.match(edit(text, result.changes), /\(def riff c\+ d\+\)/);
});
check('reverse includes unmatched intervening notes and rests', () => {
  const text = '(fm1 c d _ c)';
  const notes = layeredNotes(text);
  const matches = matchNotes(notes, query({ pitch: { kind: 'name', name: 'c' } }));
  assert.equal(matches.length, 2);
  assert.equal(logicalAffected(notes, matches, { type: 'reverse' }).length, 4);
});
check('generated notes are excluded and block an unsafe reverse span', () => {
  const text = '(fm1 c (note 65) e)';
  const notes = layeredNotes(text);
  const matches = matchNotes(notes, query());
  assert.equal(matches.length, 2);
  assert.ok(applyLogical(text, notes, matches, { type: 'reverse' }).error);
});
check('ties are excluded, invalid and no-op edits do not apply', () => {
  const text = '(fm1 c ~ c d)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, matchNotes(notes, query()), { type: 'transpose', semitones: 0 });
  assert.equal(result.changes.length, 0);
  assert.ok(notes.some((n) => excludedBy(n, { type: 'transpose' }) === 'tied'));
  const sharp = '(fm1 b+)';
  const sharpNotes = layeredNotes(sharp);
  assert.equal(applyLogical(sharp, sharpNotes, sharpNotes, { type: 'transpose', semitones: 0 }).changes.length, 0);
  assert.ok(logicalInputError(query(), { type: 'len-set', ticks: Infinity }));
  assert.ok(logicalInputError(query(), { type: 'len-mul', factor: NaN }));
  assert.ok(logicalInputError(query({ pitch: { kind: 'name', name: '?' } }), { type: 'rest' }));
});
check('adjacent removals never overlap at a closing parenthesis', () => {
  const text = '(fm1 c d e)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, notes, { type: 'remove' });
  assert.equal(result.done, 3);
  for (let i = 1; i < result.changes.length; i++) assert.ok(result.changes[i - 1].to <= result.changes[i].from);
  assert.equal(edit(text, result.changes), '(fm1 )');
});
check('muting with def-mod does not turn source notes into rests', () => {
  const text = '(def-mod :keyon off) (fm1 c d)';
  assert.deepEqual(layeredNotes(text).map((n) => [n.kind, n.pitch]), [['note', 'c4'], ['note', 'd4']]);
});
check('generated delay echoes are not shared source notes', () => {
  const text = '(fm1 (delay 2 :vel+ -3 :time 16) c4 _4)';
  const notes = layeredNotes(text);
  assert.equal(notes.filter((n) => n.kind === 'note').length, 1);
  assert.ok(notes.every((n) => !n.shared));
});
check('source notes are analysed on every current target', () => {
  const scores = {
    md: '(fm1 c d)', pc88: '(fm1 c d)', x68k: '(fm1 c d)',
    msx: '(fm1 piano c d)', fc: '(sqr1 c d)',
    pce: '(def-wave saw :wave (saw -128..127)) (wave1 saw c d)',
  };
  for (const [target, body] of Object.entries(scores)) {
    const text = `(def-score :target ${target}) ${body}`;
    const notes = layeredNotes(text);
    assert.equal(notes.filter((n) => n.editable).length, 2, target);
    assert.deepEqual(compileMMLisp(text, undefined, { noteAnalysis: new WeakMap() }), compileMMLisp(text));
  }
});
check('reverse can move a sample note before its original sample selection', () => {
  const text = '(def-pcm hit :file "hit.wav") (pcm1 _ hit c d)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, notes, { type: 'reverse' });
  assert.ok(!result.error, result.error);
  assert.ok(!compileMMLisp(edit(text, result.changes)).diagnostics.some((d) => d.severity === 'error'));
});
check('shared inherited lengths cannot silently collapse to one context', () => {
  const text = '(def riff c) (fm1 :len 8 riff :len 16 riff)';
  const notes = layeredNotes(text);
  assert.ok(applyLogical(text, notes, notes, { type: 'len-add', ticks: 24, includeShared: true }).error);
  assert.ok(!applyLogical(text, notes, notes, { type: 'len-set', ticks: 48, includeShared: true }).error);
});
check('source ties remain excluded after a muting modifier', () => {
  const text = '(def-mod :keyon off) (fm1 c ~ c)';
  const notes = layeredNotes(text);
  assert.ok(notes.every((n) => n.tied));
  assert.equal(applyLogical(text, notes, matchNotes(notes, query()), { type: 'remove' }).changes.length, 0);
});
check('a generated tie protects the written note after muting', () => {
  const text = '(def-mod :keyon off) (fm1 c ~ (note 60))';
  const notes = layeredNotes(text);
  const matches = matchNotes(notes, query());
  assert.ok(matches.length > 0);
  assert.ok(matches.every((n) => n.tied));
  assert.equal(applyLogical(text, notes, matches, { type: 'remove' }).changes.length, 0);
});
check('a tied use protects a shared token even outside the matching channel', () => {
  for (const body of ['(fm1 riff ~ d) (fm2 riff e)', '(fm1 :prio 2 riff ~ d) (fm1 :prio 8 riff e)']) {
    const text = `(def riff c) ${body}`;
    const notes = layeredNotes(text);
    const shared = notes.filter((n) => n.token === 'c');
    assert.equal(shared.length, 2);
    assert.ok(shared.every((n) => n.tied));
    const matches = matchNotes(notes, query({ pitch: { kind: 'name', name: 'c' } }))
      .filter((n) => n === shared[1]); // only the otherwise untied use matches
    for (const op of [{ type: 'rest' }, { type: 'remove' }, { type: 'len-set', ticks: 48 }, { type: 'transpose', semitones: 1 }])
      assert.deepEqual(applyLogical(text, notes, matches, { ...op, includeShared: true }).changes, []);
    assert.equal(applyLogical(text, notes, matches, { type: 'select' }).done, 1);
  }
});
check('multiline generated notes block reverse without becoming editable', () => {
  const text = '(fm1 c (note\n 65) d e)';
  const notes = layeredNotes(text);
  const generated = notes.find((n) => n.token.includes('(note'));
  assert.ok(generated);
  assert.equal(generated.editable, false);
  const matches = matchNotes(notes, query());
  assert.deepEqual(matches.map((n) => n.token), ['c', 'd', 'e']);
  assert.ok(applyLogical(text, notes, matches, { type: 'reverse' }).error);
  assert.ok(logicalAffected(notes, matches, { type: 'reverse' }).includes(generated));
});
check('Select includes tied and shared tokens once without source changes', () => {
  const text = '(def riff c) (fm1 riff riff d ~ d)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, matchNotes(notes, query()), { type: 'select' });
  assert.equal(result.done, 3);
  assert.equal(result.selection.length, 3);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.selection.map((r) => text.slice(r.from, r.to)), ['c', 'd', 'd']);
  assert.equal(edit(text, result.changes), text);
});
check('Selection scope uses disjoint ranges without filling the gaps', () => {
  const text = '(fm1 c d e f)';
  const notes = layeredNotes(text);
  const ranges = [notes[0], notes[2]].map((n) => ({ from: n.from, to: n.to }));
  const matches = matchNotes(notes, query({ scope: 'selection', ranges }));
  assert.deepEqual(matches.map((n) => n.token), ['c', 'e']);
  assert.deepEqual(applyLogical(text, notes, [], { type: 'select' }).selection, []);
});
check('a tuplet transposes with its neighbours and keeps its slots', () => {
  const text = '(fm1 :len 4 c (t d e _ f) g)';
  const notes = layeredNotes(text);
  assert.deepEqual(notes.map((n) => n.token), ['c', 'd', 'e', '_', 'f', 'g']);
  assert.deepEqual(pitches(edit(text, applyLogical(text, notes, notes, { type: 'transpose', semitones: 12 }).changes)),
    ['c5', 'd5', 'e5', 'f5', 'g5']);
  const rest = applyLogical(text, notes, notes.filter((n) => n.token === 'e'), { type: 'rest' });
  assert.equal(edit(text, rest.changes), '(fm1 :len 4 c (t d _ _ f) g)');
  for (const op of [{ type: 'remove' }, { type: 'len-set', ticks: 96 }, { type: 'len-mul', factor: 2 }]) {
    const result = applyLogical(text, notes, notes.filter((n) => n.slot), op);
    assert.deepEqual(result.changes, []);
    assert.equal(notes.filter((n) => excludedBy(n, op) === 'tuplet').length, 4);
  }
});
check('a tuplet keeps its notes editable around what takes no time', () => {
  const text = '(fm1 :len 4 (t :vel 8 c ~ c :tl1 20 d) e)';
  const notes = layeredNotes(text);
  assert.deepEqual(notes.map((n) => [n.token, n.tied, n.slot]),
    [['c', true, true], ['c', true, true], ['d', false, true], ['e', false, false]]);
  const up = applyLogical(text, notes, notes, { type: 'transpose', semitones: 12 });
  assert.equal(edit(text, up.changes), '(fm1 :len 4 (t :vel 8 c ~ c :tl1 20 > d <) > e <)');
});
check('a def played in and out of a tuplet keeps its length everywhere', () => {
  const text = '(def riff c d) (fm1 :len 4 riff (t riff e))';
  const notes = layeredNotes(text);
  for (const op of [{ type: 'len-set', ticks: 48, includeShared: true }, { type: 'remove', includeShared: true }])
    assert.deepEqual(applyLogical(text, notes, notes, op).changes.filter((c) => c.from < text.indexOf('(fm1')), []);
});
check('a note is excluded for one reason', () => {
  const text = '(fm1 :len 4 c ~ (t c d) (x 2 (t e f)))';
  const notes = layeredNotes(text);
  assert.deepEqual(notes.map((n) => excludedBy(n, { type: 'remove' })).filter((w, i, all) => all.indexOf(w) === i), ['tied', 'tuplet', 'shared']);
});
check('reverse refuses a tuplet rather than skipping it', () => {
  const text = '(fm1 :len 4 c (t d e f) g a)';
  const notes = layeredNotes(text);
  assert.match(applyLogical(text, notes, notes, { type: 'reverse' }).error, /"d"/);
});
for (const mode of ['gate', 'loop']) check(`a ${mode} PCM tie keeps both tokens`, () => {
  const text = `(def-pcm hit :file "hit.wav") (pcm1 hit :mode ${mode} c ~ c d)`;
  assert.deepEqual(layeredNotes(text).map((n) => [n.token, n.tied, n.shared]),
    [['c', true, false], ['c', true, false], ['d', false, false]]);
});
check('a PCM gate that splits its tie stays one use of the token', () => {
  const text = '(def-pcm hit :file "hit.wav") (pcm1 :len 4 hit :mode gate :gate* 0.75 c ~ c d)';
  assert.ok(compileMMLisp(text).ir.tracks[0].events.filter((e) => e.cmd === 'TIE').length > 1);
  assert.ok(layeredNotes(text).every((n) => !n.shared));
});
check('a token shared with a PCM tie is protected at every use', () => {
  const text = '(def-pcm hit :file "hit.wav") (def tail c) (pcm1 hit :mode gate c ~ tail) (pcm2 hit :mode gate tail)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, notes, { type: 'transpose', semitones: 2, includeShared: true });
  assert.deepEqual(result.changes, []);
});
check('reverse refuses a def that plays inside its span', () => {
  const text = '(def riff e f) (fm1 c riff d)';
  const notes = layeredNotes(text);
  const own = notes.filter((n) => !n.shared);
  assert.match(applyLogical(text, notes, own, { type: 'reverse' }).error, /something else plays before "d"/);
});
check('neighbouring octave shifts share one wrap', () => {
  const text = '(fm1 c d e f g)';
  const notes = layeredNotes(text);
  const up = applyLogical(text, notes, notes.slice(0, 4), { type: 'transpose', semitones: 12 });
  assert.equal(edit(text, up.changes), '(fm1 > c d e f < g)');
  assert.equal(up.done, 4);
  const down = applyLogical(text, notes, notes, { type: 'transpose', semitones: -24 });
  assert.equal(edit(text, down.changes), '(fm1 < < c d e f g > >)');
  assert.ok(down.changes.every((c) => notes.some((n) => c.from === n.from && c.to === n.to)));
  assert.deepEqual(pitches(edit(text, up.changes)), ['c5', 'd5', 'e5', 'f5', 'g4']);
});
check('a wrap is not shared across anything but space', () => {
  const text = '(fm1 c :vel 3 d)';
  const notes = layeredNotes(text);
  const result = applyLogical(text, notes, notes, { type: 'transpose', semitones: 12 });
  assert.equal(edit(text, result.changes), '(fm1 > c < :vel 3 > d <)');
});
check('analysis never changes or leaks into public IR', () => {
  for (const text of ['(fm1 :len 8 c d (x 2 e f))', '(fm1 c ~ c (t d e _))',
    '(def-pcm hit :file "hit.wav") (pcm1 hit :mode gate c ~ c d)']) {
    const normal = compileMMLisp(text);
    const analysed = compileMMLisp(text, undefined, { noteAnalysis: new WeakMap() });
    assert.deepEqual(analysed, normal);
    assert.ok(!JSON.stringify(analysed).includes('_edit'));
  }
});

// The sample editor: what it writes is what the compiler reads.
const sampleIR = (text, name = 'hit') => compileMMLisp(text).ir.metadata.samples.find((d) => d.name === name);
const pointsOf = (text, dur, name = 'hit') => {
  const def = sampleDefOf(text, name);
  return { def, written: writtenPoints(def, sampleIR(text, name)), dur };
};
const drag = (text, handle, at, dur = 1000) => {
  const { def, written } = pointsOf(text, dur);
  const m = moveSamplePoint(written, handle, at, dur);
  return m && edit(text, samplePointEdit(def, m.key, m.ms));
};
const noErrors = (text) => assert.deepEqual(compileMMLisp(text).diagnostics.filter((d) => d.severity === 'error'), []);
const trim = (text, { rate = 1000, frames = 1000, dur = frames } = {}) => {
  const { def, written } = pointsOf(text, dur);
  return trimSampleEdits(text, def, written, { ir: sampleIR(text), rate, frames, dur });
};

check('a dragged point lands as the key it is, and compiles', () => {
  assert.equal(drag('(def-pcm hit :file "a.wav")', 'start', 120.4), '(def-pcm hit :file "a.wav" :pcm-start 120ms)');
  assert.equal(drag('(def-pcm hit :file "a.wav" :loop-start 300ms)', 'loopStart', 250), '(def-pcm hit :file "a.wav" :loop-start 250ms)');
  assert.equal(drag('(def-pcm hit :file "a.wav"\n  :loop-start 300ms)', 'end', 900), '(def-pcm hit :file "a.wav"\n  :loop-start 300ms\n  :pcm-end 900ms)');
});
check('a musical length stays until it is dragged, then it is ms', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-end 2 :loop-start 4) (fm1 :tempo 120 c)';
  assert.equal(pointsOf(text, 2000).written.end, 1000);
  assert.equal(pointsOf(text, 2000).written.loopStart, 500);
  assert.equal(drag(text, 'end', 900, 2000), '(def-pcm hit :file "a.wav" :pcm-end 900ms :loop-start 4) (fm1 :tempo 120 c)');
});
check('a -len stays one: the end handle writes the length', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-start 100ms :pcm-len 200ms :loop-start 100ms :loop-len 50ms)';
  assert.deepEqual(samplePoints(pointsOf(text, 1000).written, 1000), { start: 100, end: 300, loopStart: 100, loopEnd: 150 });
  assert.match(drag(text, 'end', 500), /:pcm-len 400ms/);
  assert.match(drag(text, 'loopEnd', 120), /:loop-len 20ms/);
});
check('the last of -end and -len is in force, as the compiler reads it', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-end 900ms :pcm-len 400ms)';
  const def = sampleDefOf(text, 'hit');
  assert.ok(!def.keys.has(':pcm-end'));
  assert.equal(samplePoints(writtenPoints(def, sampleIR(text)), 1000).end, 400);
  assert.equal(sampleIR(text).endSec, 0.4);
});
check('a handle stops at the order the compiler demands', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-start 100ms :loop-start 300ms :loop-end 600ms :pcm-end 900ms)';
  for (const [h, at, key] of [['start', 500, ':pcm-start 300ms'], ['loopStart', 800, ':loop-start 599ms'],
    ['loopStart', 0, ':loop-start 100ms'], ['loopEnd', 100, ':loop-end 301ms'], ['loopEnd', 950, ':loop-end 900ms'], ['end', 200, ':pcm-end 600ms']]) {
    const out = drag(text, h, at);
    assert.ok(out.includes(key), `${h} ${at}: ${out}`);
    noErrors(out);
  }
});
check('a start held by a loop that has no start of its own stops before its end', () => {
  const text = '(def-pcm hit :file "a.wav" :loop-end 200ms)';
  const out = drag(text, 'start', 500);
  assert.match(out, /:pcm-start 199ms/);
  noErrors(out);
});
check('a held length cannot push the range past the sample', () => {
  const out = drag('(def-pcm hit :file "a.wav" :pcm-start 100ms :pcm-len 300ms)', 'end', 5000);
  assert.match(out, /:pcm-len 900ms/);
});
check('a length off a start that is not whole ms is still whole ms', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-start 16 :pcm-len 100ms) (fm1 :tempo 133 c)';
  const out = drag(text, 'end', 400);
  assert.match(out, /:pcm-len \d+ms/);
  noErrors(out);
});
check('Trim moves a loop the def extends, too', () => {
  const text = '(def-pcm base :file "a.wav" :loop-start 200ms) (def-pcm hit base :pcm-start 200ms :pcm-end 500ms)';
  const out = edit(text, trim(text).changes);
  assert.equal(out, '(def-pcm base :file "a.wav" :loop-start 200ms) (def-pcm hit base :offset 200 :frames 300 :loop-start 0ms)');
  noErrors(out);
});
check('a child writes its own key over its base', () => {
  const text = '(def-pcm base :file "a.wav" :pcm-end 700ms) (def-pcm hit base)';
  assert.equal(pointsOf(text, 1000).written.end, 700);
  assert.equal(drag(text, 'end', 500), '(def-pcm base :file "a.wav" :pcm-end 700ms) (def-pcm hit base :pcm-end 500ms)');
});
check('Trim folds the range into the slice', () => {
  const out = edit('(def-pcm hit :file "a.wav" :pcm-start 100ms :pcm-end 600ms)', trim('(def-pcm hit :file "a.wav" :pcm-start 100ms :pcm-end 600ms)').changes);
  assert.equal(out, '(def-pcm hit :file "a.wav" :offset 100 :frames 500)');
  noErrors(out);
});
check('Trim counts on an existing slice and keeps the rate it is read at', () => {
  const text = '(def-pcm hit :file "a.wav" :rate 8000 :offset 40 :frames 800 :pcm-start 10ms :pcm-len 50ms)';
  const res = trim(text, { rate: 8000, frames: 800, dur: 100 });
  assert.equal(edit(text, res.changes), '(def-pcm hit :file "a.wav" :rate 8000 :offset 120 :frames 400)');
  assert.equal(res.cut, 400);
});
check('Trim of the head alone leaves the file to run out', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-start 100ms)';
  assert.equal(edit(text, trim(text).changes), '(def-pcm hit :file "a.wav" :offset 100)');
});
check('Trim moves the loop with the sample under it', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-start 100ms :loop-start 300ms :loop-end 600ms :pcm-end 900ms)';
  const out = edit(text, trim(text).changes);
  assert.equal(out, '(def-pcm hit :file "a.wav" :offset 100 :frames 800 :loop-start 200ms :loop-end 500ms)');
  noErrors(out);
  const both = '(def-pcm hit :file "a.wav" :pcm-start 100ms :loop-start 100ms :loop-end 900ms :pcm-end 900ms)';
  assert.equal(edit(both, trim(both).changes), '(def-pcm hit :file "a.wav" :offset 100 :frames 800)');
});
check('Trim leaves a -len loop its length', () => {
  const text = '(def-pcm hit :file "a.wav" :pcm-start 100ms :loop-start 300ms :loop-len 50ms)';
  assert.equal(edit(text, trim(text).changes), '(def-pcm hit :file "a.wav" :offset 100 :loop-start 200ms :loop-len 50ms)');
});
check('Trim takes a key off its own line, and keeps comments', () => {
  const text = '(def-pcm hit :file "a.wav" ; the take\n  :pcm-start 100ms\n  :pcm-end 900ms)';
  assert.equal(edit(text, trim(text).changes), '(def-pcm hit :file "a.wav" :offset 100 :frames 800 ; the take\n)');
  noErrors(edit(text, trim(text).changes));
  const next = '(def-pcm hit :file "a.wav"\n  :pcm-end 900ms\n  :fx [(gain 1)])';
  assert.equal(edit(next, trim(next).changes), '(def-pcm hit :file "a.wav" :frames 900\n  :fx [(gain 1)])');
});
check('Trim says when there is nothing it can do', () => {
  assert.match(trim('(def-pcm hit :file "a.wav")').error, /whole sample/);
  assert.match(trim('(def-pcm base :file "a.wav" :pcm-end 500ms) (def-pcm hit base)').error, /base/);
});

// Copy Def: the text, in the score, is the def it came from.
const sampleOf = (text, fileName, imports, name = 'hit') => compileMMLisp(text, fileName, { imports }).ir.metadata.samples.find((d) => d.name === name);
const copied = (score, fileName, imports, file, name = 'hit') => {
  const text = imports.get(file);
  const node = parse(text).find((n) => n.kind === 'list' && n.items[1]?.value === name);
  return ownDefText(text, node, file, { fileName, fx: importFxChain(score, imports, file, { fileName }) });
};
check('a copied sample sounds as the import did', () => {
  const imports = new Map([['presets/kit/set.mmlisp', '; a kit\n(def-pcm hit :file "wav/hit.wav" :fx [(gain 2)])\n(def-pcm tom :file "wav/tom.wav")']]);
  const score = '(import "presets/kit/set.mmlisp" :fx [(gain 1)])\n(pcm1 hit c)';
  const text = copied(score, 'a.mmlisp', imports, 'presets/kit/set.mmlisp');
  assert.equal(text, '(def-pcm hit :file "presets/kit/wav/hit.wav" :fx [(gain 1) (gain 2)])');
  const was = sampleOf(score, 'a.mmlisp', imports);
  const now = sampleOf(`${score}\n${text}`, 'a.mmlisp', imports);
  assert.deepEqual([now.resolvedFile, now.fx], [was.resolvedFile, was.fx]);
});
check('a chain goes on a sample with no :fx, through nested imports, outermost first', () => {
  const imports = new Map([['a.mmlisp', '(import "kit/b.mmlisp" :fx [(gain 3)])'], ['kit/b.mmlisp', '(def-pcm hit :file "hit.wav")']]);
  const score = '(import "a.mmlisp" :fx [(gain 1) (gain 2)])\n(pcm1 hit c)';
  assert.deepEqual(importFxChain(score, imports, 'kit/b.mmlisp'), ['(gain 1) (gain 2)', '(gain 3)']);
  const text = copied(score, 'a.mmlisp', imports, 'kit/b.mmlisp');
  assert.equal(text, '(def-pcm hit :file "kit/hit.wav" :fx [(gain 1) (gain 2) (gain 3)])');
  assert.deepEqual(sampleOf(`${score}\n${text}`, 'a.mmlisp', imports).fx, sampleOf(score, 'a.mmlisp', imports).fx);
});
check('a file is written from where the score is', () => {
  const imports = new Map([['presets/kit/set.mmlisp', '(def-pcm hit :file "wav/hit.wav")']]);
  const score = '(import "presets/kit/set.mmlisp")\n(pcm1 hit c)';
  const text = copied(score, 'songs/a.mmlisp', imports, 'presets/kit/set.mmlisp');
  assert.equal(text, '(def-pcm hit :file "../presets/kit/wav/hit.wav")');
  assert.equal(sampleOf(`${score}\n${text}`, 'songs/a.mmlisp', imports).resolvedFile.replace(/^songs\/\.\.\//, ''), 'presets/kit/wav/hit.wav');
});
check('a copied sample that extends a base keeps the base\'s chain, once', () => {
  const imports = new Map([['kit.mmlisp', '(def-pcm base :file "hit.wav")\n(def-pcm hit base :fx [(gain 2)])']]);
  const score = '(import "kit.mmlisp" :fx [(gain 1)])\n(pcm1 hit c)';
  const text = copied(score, 'a.mmlisp', imports, 'kit.mmlisp');
  assert.equal(text, '(def-pcm hit base :fx [(gain 2)])');
  assert.deepEqual(sampleOf(`${score}\n${text}`, 'a.mmlisp', imports).fx, sampleOf(score, 'a.mmlisp', imports).fx);
});
check('a def with nothing tied to its file is copied as it stands', () => {
  const text = '; keep\n(def-fm lead init-fm\n  :alg 4 ; bright\n  :fb 3)\n(def-wave saw :wave [1 2])';
  const [fm, wave] = parse(text).filter((n) => n.kind === 'list');
  assert.equal(ownDefText(text, fm, 'x/y.mmlisp'), '(def-fm lead init-fm\n  :alg 4 ; bright\n  :fb 3)');
  assert.equal(ownDefText(text, wave, 'x/y.mmlisp'), '(def-wave saw :wave [1 2])');
});

console.log(`Logical Editor checks passed: ${count}`);
