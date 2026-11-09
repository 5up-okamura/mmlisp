#!/usr/bin/env node
// The MIDI importer on every target, on a file written here (no third-party
// music): a piano's chord, a bass, a lead with a bend, an organ, and a drum
// channel of two lanes. Each target's defaults must compile with no error,
// keep the file's parts on the channels it has, and read a program and a drum
// by the channel they land on.
import assert from "node:assert/strict";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { TARGETS } from "../../live/src/targets.js";
import { noiseNoteOfHz } from "../../live/src/chips/huc6280.js";
import { parseMidi, analyzeMidi, defaultMidiOptions, midiToMmlisp, midiDests } from "../../live/src/import-midi.js";

const vlq = (v) => { const b = [v & 127]; while ((v >>= 7)) b.unshift((v & 127) | 128); return b; };
function track(events) {
  const body = [];
  let at = 0;
  for (const [tick, ...bytes] of events.sort((a, b) => a[0] - b[0])) { body.push(...vlq(tick - at), ...bytes); at = tick; }
  body.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
}
const Q = 480;
const notes = (ch, keys, len = Q) => keys.flatMap((k, i) => [[i * len, 0x90 | ch, k, 100], [(i + 1) * len - 1, 0x80 | ch, k, 0]]);
const file = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 6, Q >> 8, Q & 255,
  ...track([[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [0, 0xff, 0x58, 4, 4, 2, 24, 8]]),
  ...track([[0, 0xc0, 0], ...[60, 64, 67].flatMap((k) => notes(0, [k, k, k, k], Q))]), // piano, three lanes
  ...track([[0, 0xc1, 33], ...notes(1, [36, 36, 43, 43])]), // a bass
  ...track([[0, 0xc2, 80], ...notes(2, [72, 74, 76, 79]), [Q / 4, 0xe2, 0, 0x60], [Q / 2, 0xe2, 0, 0x40]]), // a lead, bent
  ...track([[0, 0xc3, 16], ...notes(3, [48, 50, 52, 55])]), // an organ
  ...track([...notes(9, [36, 38, 36, 38]), ...notes(9, [42, 42, 42, 42])]), // kick and snare under a hat
]);

const parsed = parseMidi(file);
const a = analyzeMidi(parsed);
const opts = (target) => ({ ...defaultMidiOptions(a, target), structure: true, fileName: "test.mid" });
for (const target of Object.keys(TARGETS)) {
  const o = opts(target);
  const { source, warnings } = midiToMmlisp(parsed, o, a);
  // Compiled as Live compiles an import: its presets read from the repo.
  const diags = compileMMLisp(source, "t.mmlisp", { imports: readImportSources("t.mmlisp", source) }).diagnostics;
  const bad = diags.filter((d) => d.severity === "error");
  assert.deepEqual(bad.map((d) => `${d.code}: ${d.message}`), [], `${target}: compiles clean`);
  const dests = Object.values(o.dest).filter((d) => d !== "drop");
  assert.equal(new Set(dests).size, dests.length, `${target}: each channel once`);
  const { melodic, drums } = midiDests(target);
  for (const l of a.lanes) if (o.dest[l.key] !== "drop") assert.ok((l.drums ? drums : melodic).includes(o.dest[l.key]), `${target}: ${l.key} on a channel of its kind`);
  assert.ok(dests.length >= (target === "gb" ? 4 : target === "fc" ? 5 : target === "pce" ? 6 : 8), `${target}: keeps the parts it has room for (${dests})`);
  if (target !== "md") assert.match(source, new RegExp(`:target ${target}\\b`), `${target}: says so`);
  console.log(`${target}: ${dests.join(" ")} — ${warnings.length} warnings`);
}

// Every channel of every target takes a lane: a drum on each noise and sample,
// a program on each of the rest.
for (const target of Object.keys(TARGETS)) {
  const { melodic, drums } = midiDests(target);
  for (const d of [...melodic, ...drums]) {
    const lane = a.lanes.find((l) => l.drums === drums.includes(d));
    const { source } = midiToMmlisp(parsed, { ...opts(target), dest: { [lane.key]: d } }, a);
    const bad = compileMMLisp(source, "t.mmlisp", { imports: readImportSources("t.mmlisp", source) }).diagnostics.filter((x) => x.severity === "error");
    assert.deepEqual(bad.map((x) => x.message), [], `${target}: a lane on ${d}`);
  }
}

// The readings of a program and a drum.
const src = (t) => midiToMmlisp(parsed, opts(t), a).source;
assert.match(src("x68k"), /gm-piano/, "4-op FM: the gm voice");
assert.match(src("msx"), /\(fm\d[^)]*\bpiano\b/, "the OPLL: its ROM voice");
assert.doesNotMatch(src("msx"), /presets\/gm\//, "and no gm import");
assert.match(src("pce"), /wave-piano/, "a wave channel: the role's macro");
assert.match(src("md"), /env-|gm-/, "the Mega Drive as it was");
assert.match(src("pc88"), /\(rhythm\d[^)]*\bkick\b/, "the YM2608: the ROM rhythm's sounds");
assert.match(src("msx"), /\(rhythm1/, "the FM-PAC: its rhythm");
assert.doesNotMatch(src("msx"), /\(fm[789]\b/, "whose channels it takes");
assert.match(src("x68k"), /gm-drums/, "PCM8: the kit's samples");
assert.match(src("gb"), /\(noise[^)]*env-/, "a noise channel: an envelope a hit");
assert.match(src("fc"), /\(pcm1[^)]*\bkick\b/, "the 2A03's one sample keeps the kick");
assert.match(src("fc"), /\(noise[^)]*env-hat/, "and the noise the hat");
const dest = defaultMidiOptions(a, "fc").dest;
assert.equal(dest["1:0"], "tri", "the triangle takes the bass");
assert.equal(defaultMidiOptions(a, "gb").dest["9:1"], "noise", "one noise: the kick and snare's lane");
assert.match(src("pce"), /\(noise5[^)]*:oct 4[^)]*\bd\b/, "the HuC6280's noise: the hat at its rate (12 kHz, d4)");
assert.deepEqual([noiseNoteOfHz(500), noiseNoteOfHz(1804), noiseNoteOfHz(12000)], [36, 36, 62], "its rates: the floor at c2, each semitone a rate");
{
  const noise = (t) => midiToMmlisp(parsed, { ...opts(t), dest: { [a.lanes.find((l) => l.drums && l.lane === 1).key]: "noise" } }, a).source;
  assert.match(noise("md"), /:mode white2[\s\S]*:mode white1/, "the Mega Drive's noise: a mode a kind of hit");
  assert.match(noise("x68k"), /:noise-rate \d+/, "the OPM's: a rate");
  const o = { ...opts("fc"), dest: { ...opts("fc").dest, "0:0": "vrc7-fm1" } };
  const { source } = midiToMmlisp(parsed, o, a);
  assert.match(source, /\(vrc7-fm1[^)]*\bwurly\b/, "the VRC7's ROM: its own names");
  const bad = compileMMLisp(source, "t.mmlisp", { imports: readImportSources("t.mmlisp", source) }).diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(bad, [], "and compiles");
  const r = midiToMmlisp(parsed, { ...opts("md"), dest: { "0:0": "wave1", "1:0": "fm1" } }, a);
  assert.ok(r.warnings.some((w) => /wave1 is not the Mega Drive's/.test(w)), "a channel the machine lacks is dropped with a warning");
}
{
  // CC10 is each note's pan, as it is at the note-on: −1..1, the centre
  // 64, where the channel pans (an FM channel snaps it to its bits).
  const panned = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, Q >> 8, Q & 255,
    ...track([[0, 0xc0, 80], [0, 0xb0, 10, 0], ...notes(0, [60, 62, 64, 65]), [Q - 1, 0xb0, 10, 127], [2 * Q - 1, 0xb0, 10, 96], [3 * Q - 1, 0xb0, 10, 64]]),
  ]);
  const p = parseMidi(panned), pa = analyzeMidi(p);
  for (const [t, want] of [["midi", /:pan left[^)]*c :pan right d :pan 0\.51 e :pan center f/], ["md", /:pan left[^)]*c :pan right d :pan 0\.51 e :pan center f/]]) {
    const { source } = midiToMmlisp(p, { ...defaultMidiOptions(pa, t), structure: true, fileName: "pan.mid" }, pa);
    assert.match(source, want, `${t}: a pan a note:\n${source}`);
    const bad = compileMMLisp(source, "t.mmlisp", { imports: readImportSources("t.mmlisp", source) }).diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(bad, [], `${t}: compiles`);
  }
}
console.log("check-import-midi: ok");
