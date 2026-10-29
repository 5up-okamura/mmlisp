// Source-edit regressions: notation, target sound names and actual edit extent.
import assert from 'node:assert/strict';
import { compileMMLisp } from '../../live/src/mmlisp2ir.js';
import { layeredNotes, matchNotes, applyLogical, logicalAffected, logicalInputError } from '../../live/src/edit-tools.js';

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
  assert.ok(result.skipped.tied > 0);
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
check('analysis never changes or leaks into public IR', () => {
  const text = '(fm1 :len 8 c d (x 2 e f))';
  const normal = compileMMLisp(text);
  const analysed = compileMMLisp(text, undefined, { noteAnalysis: new WeakMap() });
  assert.deepEqual(analysed, normal);
  assert.ok(!JSON.stringify(analysed).includes('_edit'));
});
console.log(`Logical Editor checks passed: ${count}`);
