#!/usr/bin/env node
// File > Export > MIDI (live/src/midi/midi-plan.js), held three ways:
//
//   the corpus  every test score (drv/tests, examples, tools/tests/<target>)
//               exports, the file reads back (import-midi.js parseMidi) as
//               the notes the exporter says it wrote, each key on goes off,
//               and the notes start where the IR's do: each NOTE_ON /
//               PCM_NOTE_ON of a track's first pass is a note on at its
//               tick, but a slur onto the key it holds, and a note on is
//               a note's or a :keyon's retrigger
//   one score   written here, every row of the mapping read off the file:
//               a gm voice's program, a fader's CC7, a pan's CC10, a glide's
//               bend and its range, a slur, a hold, a kit role on channel 10,
//               :snap, a loop to its marks, a tempo change; a role's and a
//               ROM voice's name as its GM program, on md, msx and fc
//   the cases   a loop point's writes, a voice after a jump, a label in a
//               counted loop, a vol macro over its fader, a :keyon under a
//               tick, a voice change not called a loss
//   the import  the file read by the MIDI importer: its tempo, its lanes
//
// and GM_PROGRAMS is the gm preset set's voices in their order, a role the
// gm voice presets/fm-roles copied, and every ROM voice a GM program.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileScoreFile } from "../../drv/tools/mmb-build.mjs";
import { compileMMLisp } from "../../live/src/lang/mmlisp2ir.js";
import { exportMidi } from "../../live/src/export/export-midi.js";
import { midiPlan } from "../../live/src/midi/midi-plan.js";
import { GM_PROGRAMS, GM_DRUM_NOTE, NAMED_VOICES, programOf } from "../../live/src/machine/chips/gm-names.js";
import { OPLL_ROM_NAMES } from "../../live/src/machine/chips/ym2413.js";
import { VRC7_ROM_NAMES } from "../../live/src/machine/chips/vrc7.js";
import { parseMidi, analyzeMidi } from "../../live/src/import/import-midi.js";
import { expandLoops } from "../../live/src/ir/timing.js";
import { pitchToMidi } from "../../live/src/ir/pitch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);

// GM's 128 are the gm set's def-fm voices, in order.
const gmSet = [...readFileSync("live/presets/gm/set.mmlisp", "utf8").matchAll(/\(def-fm (gm-[a-z0-9-]+)/g)].map((m) => m[1]);
assert.deepEqual(GM_PROGRAMS, gmSet, "GM_PROGRAMS is presets/gm's order");
// A role is the gm voice presets/fm-roles copied (its "; gm-…" line); every
// ROM voice's name, the OPLL's and the VRC7's, is a GM program.
const roles = [...readFileSync("live/presets/fm-roles/set.mmlisp", "utf8").matchAll(/^; (gm-[a-z0-9-]+)\n\(def-fm ([a-z0-9-]+)/gm)];
assert.equal(roles.length, 15, "fm-roles' fifteen");
for (const [, gm, role] of roles) assert.equal(NAMED_VOICES[role], gm, `${role} is ${gm}`);
for (const name of [...OPLL_ROM_NAMES, ...VRC7_ROM_NAMES]) assert.ok(programOf(name) != null, `${name} has a program`);
for (const gm of Object.values(NAMED_VOICES)) assert.ok(GM_PROGRAMS.includes(gm), `${gm} is a gm voice`);

// The notes a parsed track holds: an on to the off of its key.
function notesOf(events) {
  const open = new Map(), out = [];
  for (const e of events) {
    const k = `${e.ch}:${e.a}`;
    if (e.kind === "off" && open.has(k)) {
      const n = open.get(k);
      open.delete(k);
      out.push({ ...n, off: e.tick });
    } else if (e.kind === "on") {
      assert.ok(!open.has(k), `key ${e.a} on twice at ${e.tick}`);
      open.set(k, { on: e.tick, key: e.a, velocity: e.b });
    }
  }
  assert.equal(open.size, 0, "every key on goes off");
  return out.sort((a, b) => a.on - b.on || a.key - b.key);
}

// The IR's onsets in a track's first pass (to its backward JUMP).
function irOnsets(track) {
  const ev = expandLoops(track.events ?? []).sort((a, b) => a.tick - b.tick);
  const markers = new Map(ev.filter((e) => e.cmd === "MARKER").map((e) => [e.args.id, e.tick]));
  const jump = ev.filter((e) => e.cmd === "JUMP" && (markers.get(e.args.to) ?? Infinity) <= e.tick).map((e) => e.tick);
  const end = jump.length ? Math.max(...jump) : Infinity;
  return { end, notes: ev.filter((e) => (e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON") && e.tick < end) };
}

// ── The corpus ──────────────────────────────────────────────────────────
const dir = (d) => readdirSync(d).filter((f) => f.endsWith(".mmlisp")).sort().map((f) => join(d, f));
const corpus = [
  ...dir("drv/tests"), ...dir("examples"),
  ...readdirSync("tools/tests", { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => dir(join("tools/tests", d.name))),
];
let scores = 0, checked = 0;
for (const file of corpus) {
  const { ir, diagnostics } = compileScoreFile(file, { voiceStamps: true, voiceHoist: false });
  if (diagnostics.some((d) => d.severity === "error")) continue; // a score of errors, on purpose
  const out = exportMidi(ir);
  const parsed = parseMidi(out.bytes);
  assert.equal(parsed.format, 1, file);
  assert.equal(parsed.division, 96, file);
  assert.equal(parsed.tracks.length, out.tracks.length + 1, `${file}: a conductor and a track each`);
  const songTracks = ir.tracks.filter((t) => !t.se);
  for (const [i, t] of out.tracks.entries()) {
    const read = notesOf(parsed.tracks[i + 1]);
    const said = [...t.notes].sort((a, b) => a.on - b.on || a.key - b.key);
    assert.deepEqual(read, said, `${file} ${t.name}: the file holds the notes the export wrote`);
    for (const e of parsed.tracks[i + 1]) if (e.ch != null) assert.equal(e.ch + 1, t.channel, `${file} ${t.name}: one channel`);
    if (t.drums) assert.equal(t.channel, 10, `${file} ${t.name}: drums on 10`);

    const track = songTracks.find((s) => (s.scoreChannel ?? s.channel) === t.name);
    const { end, notes } = irOnsets(track);
    const retrigs = notes.some((n) => n.args?.keyon);
    const onsets = new Set(read.map((n) => n.on));
    let prevKey = null, prevEnd = null;
    for (const n of notes) {
      const key = n.cmd === "PCM_NOTE_ON" && t.drums ? GM_DRUM_NOTE[n.args.sample] : null;
      const sameKeySlur = n.args?.legato && prevEnd === n.tick && prevKey === pitchToMidi(n.args.pitch);
      if (!sameKeySlur) assert.ok(onsets.has(n.tick) || (t.drums && key == null), `${file} ${t.name}: a note on at ${n.tick}`);
      prevKey = n.args?.pitch ? pitchToMidi(n.args.pitch) : null;
      prevEnd = n.tick + (n.args?.length ?? 0);
      checked++;
    }
    if (!retrigs) {
      const irTicks = new Set(notes.map((n) => n.tick));
      for (const n of read) if (n.on < end) assert.ok(irTicks.has(n.on), `${file} ${t.name}: the note on at ${n.on} is a note's`);
    }
  }
  scores++;
}

// ── One score, every row ──────────────────────────────────────────────────
const SRC = `
(import "presets/gm/set.mmlisp")
(def-pcm kick :file "kick.wav")
(def-pcm snare :file "snare.wav")
(fm1 :tempo 120 gm-piano :len 4 c ~ e g :vol 24 #top gm-flute c :pan left d (go top))
(fm2 gm-organ-drawbar :len 2 c :pitch (linear 0..700 :len 12f) c :pitch 0 :gate 0 e)
(fm3 :len 4 :snap [0 4 7] c+ d+ f+ a+ :tempo 60 c)
(pcm1 :len 4 kick c snare c kick c snare c)
`;
const imports = new Map([["presets/gm/set.mmlisp", readFileSync("live/presets/gm/set.mmlisp", "utf8")]]);
const { ir, diagnostics } = compileMMLisp(SRC, "midi-test.mmlisp", { imports, voiceStamps: true, voiceHoist: false });
const errors = diagnostics.filter((d) => d.severity === "error");
assert.equal(errors.length, 0, errors.map((d) => d.message).join("; "));
const out = exportMidi(ir);
const parsed = parseMidi(out.bytes);
const track = (name) => parsed.tracks[out.tracks.findIndex((t) => t.name === name) + 1];
const of = (name, kind, a) => track(name).filter((e) => e.kind === kind && (a == null || e.a === a));

// fm1: a piano's program, a slur, a fader, a flute, a pan, the loop.
assert.deepEqual(of("fm1", "pc").map((e) => [e.tick, e.a]), [[0, 0], [288, 73]], "gm-piano, then gm-flute");
const fm1 = notesOf(track("fm1"));
assert.deepEqual(fm1.slice(0, 3).map((n) => [n.on, n.off, n.key]), [[0, 96, 60], [96, 192, 64], [192, 288, 67]], "a slur: e on before c off");
const slur = track("fm1").filter((e) => e.tick === 96 && (e.kind === "on" || e.kind === "off")).map((e) => e.kind);
assert.deepEqual(slur, ["on", "off"], "the slur's on goes first");
assert.deepEqual(of("fm1", "cc", 7).map((e) => [e.tick, e.b]), [[0, 127], [288, 57]], ":vol 24 is -14 dB");
// The loop point (576) is fm1's :pan left of its second pass: written though
// it repeats, for a player that loops comes back to it from the right.
assert.deepEqual(of("fm1", "cc", 10).map((e) => [e.tick, e.b]), [[0, 64], [384, 0], [576, 0]], ":pan left");
const marks = parsed.tracks[0].filter((e) => e.kind === "marker").map((e) => [e.tick, e.text]);
// The one-shot tracks end at 576 (fm2's hold); fm1's loop is 192 long.
assert.deepEqual(marks, [[576, "loopStart"], [768, "loopEnd"]], "the loop, as the VGM's");
assert.ok(of("fm1", "marker").some((e) => e.tick === 288 && e.text === "top"), "#top is a marker");

// fm2: a glide's bend under RPN 0 at 12, a hold to the song's end.
const rpn = of("fm2", "cc").filter((e) => e.tick === 0 && [101, 100, 6].includes(e.a)).map((e) => [e.a, e.b]);
assert.deepEqual(rpn.slice(0, 3), [[101, 0], [100, 0], [6, 12]], "bend range 12 for 7 semitones");
const bends = of("fm2", "bend");
assert.equal(Math.max(...bends.map((e) => e.value)), Math.round((7 / 12) * 8192), "the glide ends 7 semitones up");
assert.equal(bends.at(-1).value, 0, "and :pitch 0 brings it back");
const fm2 = notesOf(track("fm2"));
assert.equal(fm2.at(-1).off, Math.max(...out.tracks.flatMap((t) => t.notes.map((n) => n.off))), "a :gate 0 hold to the end");

// fm3: :snap moves each note down onto C, E, G; the tempo halves.
assert.deepEqual(notesOf(track("fm3")).map((n) => n.key), [60, 60, 64, 67, 60], ":snap");
const tempos = parsed.tracks[0].filter((e) => e.kind === "tempo").map((e) => [e.tick, e.value]);
assert.deepEqual(tempos, [[0, 500000], [384, 1000000]], ":tempo 120, then 60");

// pcm1: kit roles on 10 at their GM notes.
const drums = out.tracks.find((t) => t.name === "pcm1");
assert.equal(drums.channel, 10);
assert.deepEqual(drums.notes.map((n) => n.key), [36, 38, 36, 38], "kick 36, snare 38");

// ── A role and a ROM voice are programs ──────────────────────────────────
const programs = (src, opts = {}) => {
  const { ir, diagnostics } = compileMMLisp(src, "roles.mmlisp", { voiceStamps: true, voiceHoist: false, ...opts });
  const errs = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errs.length, 0, errs.map((d) => d.message).join("; "));
  const p = parseMidi(exportMidi(ir).bytes);
  return p.tracks.slice(1).map((t) => t.filter((e) => e.kind === "pc").map((e) => e.a));
};
// The Mega Drive: a ROM name read as 4-op, and fm-roles' own voice.
assert.deepEqual(programs("(fm1 :len 4 piano c flute d)"), [[0, 73]], "md: ROM names as 4-op");
assert.deepEqual(programs('(import "presets/fm-roles/set.mmlisp")\n(fm1 :len 4 organ c synth-bass d)',
  { imports: new Map([["presets/fm-roles/set.mmlisp", readFileSync("live/presets/fm-roles/set.mmlisp", "utf8")]]) }),
[[16, 38]], "md: fm-roles' voices");
// The FM-PAC's ROM, and the VRC7's.
assert.deepEqual(programs("(def-score :target msx)\n(fm1 :len 4 violin c horn d)"), [[40, 60]], "msx: the FM-PAC's ROM");
assert.deepEqual(programs("(def-score :target fc)\n(vrc7-fm1 :len 4 wurly c fretless d sweep e)"), [[4, 35, 95]], "fc: the VRC7's ROM");

// ── Loops, voices, levels, retriggers ─────────────────────────────────────
const exported = (src) => {
  const { ir, diagnostics } = compileMMLisp(src, "case.mmlisp", { voiceStamps: true, voiceHoist: false, imports });
  const errs = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errs.length, 0, errs.map((d) => d.message).join("; "));
  const out = exportMidi(ir);
  return { out, parsed: parseMidi(out.bytes) };
};
{ // A write at the loop point is written though it repeats the value: a
  // player looping between the marks comes back to it from :vol 20, 90 bpm.
  const { parsed: p } = exported("(fm1 :tempo 120 :len 4 :vol 31 c #top :vol 31 :tempo 120 d :vol 20 :tempo 90 e (go top))");
  const marks = p.tracks[0].filter((e) => e.kind === "marker").map((e) => e.tick);
  assert.deepEqual(marks, [96, 288]);
  assert.deepEqual(p.tracks[1].filter((e) => e.kind === "cc" && e.a === 7).map((e) => [e.tick, e.b]), [[0, 127], [96, 127], [192, 36]], "CC7 again at the loop");
  assert.deepEqual(p.tracks[0].filter((e) => e.kind === "tempo").map((e) => [e.tick, e.value]), [[0, 500000], [96, 500000], [192, 666667]], "the tempo again at the loop");
}
{ // The voice a note plays is the channel's as it plays: after the jump, d is
  // the flute's, as the chip plays it, not the piano the compiler had at d.
  const { parsed: p } = exported(`(import "presets/gm/set.mmlisp")
(fm1 gm-piano :len 4 c #top d gm-flute e (go top))
(fm2 :len 4 #top c c c (go top))`);
  assert.deepEqual(p.tracks[1].filter((e) => e.kind === "pc").map((e) => [e.tick, e.a]), [[0, 0], [192, 73]], "one flute, kept");
}
{ // A label inside (x 2 …): the loop is from its last copy.
  const { out: o } = exported("(fm1 :len 4 (x 2 #top c) d (go top))\n(fm2 :len 4 c c c #y c (go y))");
  assert.deepEqual(o.tracks[0].notes.map((n) => [n.on, n.key]), [[0, 60], [96, 60], [192, 62], [288, 60], [384, 62]]);
}
{ // A vol macro takes the fader's place: louder than :vol 16, it is CC7.
  const { parsed: p } = exported("(fm1 :len 4 :vol 16 (macro :vol [31 28 24]) c d)");
  const cc7 = p.tracks[1].filter((e) => e.kind === "cc" && e.a === 7);
  assert.equal(cc7[0].b, 127, "the macro's 31");
  assert.ok(!p.tracks[1].some((e) => e.kind === "cc" && e.a === 11), "no CC11 for a vol macro");
}
{ // A :keyon faster than a tick (15 bpm): whole ticks, every on goes off.
  const { parsed: p } = exported("(fm1 :tempo 15 :len 4 (macro :keyon 1) c)");
  notesOf(p.tracks[1]);
}
{ // No voice hoist: a voice change on the Mega Drive leaves the note before
  // it its whole gate, and the fader written with it its tick.
  const { out: o, parsed: p } = exported("(fm1 :tempo 120 :len 4 piano c d :vol 20 flute e f)");
  assert.deepEqual(o.tracks[0].notes.map((n) => [n.on, n.off]), [[0, 96], [96, 192], [192, 288], [288, 384]]);
  assert.deepEqual(p.tracks[1].filter((e) => e.kind === "cc" && e.a === 7).map((e) => e.tick), [0, 192]);
}
{ // A voice change is a program, not a machine's write left out; a voice
  // named for no instrument is said.
  const { out: o } = exported('(import "presets/gm/set.mmlisp")\n(def-fm lead :alg 4)\n(fm1 :len 4 gm-piano c lead d)');
  assert.ok(!o.notes.some((n) => /left out/.test(n)), o.notes.join(" | "));
  assert.ok(o.notes.some((n) => /no GM program for lead/.test(n)), o.notes.join(" | "));
}

{ // A sample that is no kit role: on the drums at its written note, said;
  // a track of none is melodic, said.
  const { out: o } = exported('(def-pcm kick :file "k.wav")\n(def-pcm clap-x :file "c.wav")\n(pcm1 :len 4 kick c clap-x d)\n(pcm2 :len 4 clap-x c clap-x e)');
  assert.deepEqual(o.tracks.map((t) => [t.name, t.drums, t.notes.map((n) => n.key)]), [["pcm1", true, [36, 62]], ["pcm2", false, [60, 64]]]);
  assert.ok(o.notes.some((n) => /^pcm1: clap-x: no kit role/.test(n)), o.notes.join(" | "));
  assert.ok(o.notes.some((n) => /^pcm2: clap-x: no kit role, so the hits are notes/.test(n)), o.notes.join(" | "));
}

// ── :target midi: the channels it names, its own words ────────────────────
{
  const planOf = (file) => midiPlan(compileScoreFile(file, { voiceStamps: true, voiceHoist: false }).ir);
  const ctl = (t, status) => t.events.filter((e) => (e.bytes[0] & 0xf0) === status).map((e) => [Math.round(e.tick), ...e.bytes.slice(1)]);
  const p = planOf("tools/tests/midi/channels.mmlisp");
  const tr = Object.fromEntries(p.tracks.map((t) => [t.name, t]));
  assert.deepEqual(p.tracks.map((t) => [t.name, t.channel]), [["ch1", 0], ["ch2", 1], ["ch3", 2], ["ch16", 15]], "a track is the channel it names");
  assert.deepEqual(p.notes, [], "nothing left out: every word is MIDI's");
  assert.deepEqual(ctl(tr.ch1, 0xc0), [[0, 0], [384, 73]], "gm-piano, then flute, by name");
  assert.deepEqual(ctl(tr.ch2, 0xc0), [[0, 81]], ":prog 81 in a def");
  assert.ok(ctl(tr.ch2, 0xb0).filter(([, c]) => c === 74).length > 8, "a :cc74 macro, a value a step");
  assert.deepEqual(ctl(tr.ch2, 0xd0).map(([, v]) => v), [64], ":pressure 64");
  const ch3 = tr.ch3.events.filter((e) => e.tick === 0 && e.bytes[0] < 0xf0).map((e) => [e.bytes[0] & 0xf0, ...e.bytes.slice(1)].join(","));
  assert.ok(ch3.indexOf("176,0,1") >= 0 && ch3.indexOf("176,0,1") < ch3.indexOf("192,48"), ":bank 128 (CC0 1, CC32 0) ahead of :prog 48");
  assert.ok(ch3.includes("176,6,12"), ":bend-range 12 is RPN 0");
  assert.deepEqual(ctl(tr.ch16, 0xc0), [[0, 38]], "a role: synth-bass is the gm bass-syn1");
  const d = planOf("tools/tests/midi/drums.mmlisp");
  const keys = (n) => [...new Set(d.tracks.find((t) => t.name === n).notes.map((x) => x.key))].sort((a, b) => a - b);
  assert.deepEqual(d.tracks.filter((t) => /^drum\d$/.test(t.name)).map((t) => [t.name, t.channel]), [["drum1", 9], ["drum2", 9], ["drum3", 9], ["drum8", 9]], "the drums' tracks, all channel 10");
  assert.deepEqual([keys("drum1"), keys("drum2"), keys("drum3"), keys("drum8")], [[36, 38], [42, 46], [49], [51]], "kick snare / hat hat-open / crash / ride at their GM keys");
  // The drums share channel 10's one CC10: a drum track's :pan is refused.
  const pan = compileMMLisp("(def-score :target midi)\n(drum1 :pan -1 kick c)", "pan.mmlisp").diagnostics;
  assert.ok(pan.some((x) => x.severity === "error" && /:pan .*drum1/.test(x.message)), "no :pan on the drums");
  // A controller a word writes is the word's: :cc7 names :vol; the mode
  // messages are any controller's.
  const cc = (src) => compileMMLisp(`(def-score :target midi)\n${src}`, "cc.mmlisp").diagnostics.filter((x) => x.severity === "error").map((x) => x.message);
  assert.deepEqual(cc("(ch1 :cc7 3 c)"), [":cc7 is :vol's: CC7 is written by it (language.md §19)"]);
  assert.ok(/:cc11 is a :vel macro's/.test(cc("(ch1 (macro :cc11 [1 2]) c)")[0]), "a macro's :cc11 too");
  assert.deepEqual(cc("(ch1 :cc74 3 :cc123 0 c)"), [], ":cc74 and a mode message are written");
}

// ── The import reads it back ──────────────────────────────────────────────
const a = analyzeMidi(parsed);
assert.equal(60e6 / a.tempos[0].usPerQ, 120, "the importer's tempo");
assert.ok(a.lanes.some((l) => l.drums), "the importer's drum lane");

console.log(`check:export-midi ok — ${scores} scores, ${checked} notes against the IR, one score row by row`);
