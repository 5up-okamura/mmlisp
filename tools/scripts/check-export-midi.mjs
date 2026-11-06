#!/usr/bin/env node
// File > Export > MIDI (live/src/export-midi.js), held three ways:
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
//               :snap, a loop to its marks, a tempo change
//   the import  the file read by the MIDI importer: its tempo, its lanes
//
// and GM_PROGRAMS is the gm preset set's voices in their order.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileScoreFile } from "../../drv/tools/mmb-build.mjs";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { exportMidi, GM_PROGRAMS, GM_DRUM_NOTE } from "../../live/src/export-midi.js";
import { parseMidi, analyzeMidi } from "../../live/src/import-midi.js";
import { expandLoops, pitchToMidi } from "../../live/src/ir-utils.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);

// GM's 128 are the gm set's def-fm voices, in order.
const gmSet = [...readFileSync("live/presets/gm/set.mmlisp", "utf8").matchAll(/\(def-fm (gm-[a-z0-9-]+)/g)].map((m) => m[1]);
assert.deepEqual(GM_PROGRAMS, gmSet, "GM_PROGRAMS is presets/gm's order");

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
  const { ir, diagnostics } = compileScoreFile(file, { voiceStamps: true });
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
const { ir, diagnostics } = compileMMLisp(SRC, "midi-test.mmlisp", { imports, voiceStamps: true });
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
assert.deepEqual(of("fm1", "cc", 10).map((e) => [e.tick, e.b]), [[0, 64], [384, 0]], ":pan left");
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

// ── The import reads it back ──────────────────────────────────────────────
const a = analyzeMidi(parsed);
assert.equal(60e6 / a.tempos[0].usPerQ, 120, "the importer's tempo");
assert.ok(a.lanes.some((l) => l.drums), "the importer's drum lane");

console.log(`check:export-midi ok — ${scores} scores, ${checked} notes against the IR, one score row by row`);
