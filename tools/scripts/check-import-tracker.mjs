#!/usr/bin/env node
// The tracker importer's PC Engine and NES paths on DefleMask modules written
// here, byte by byte (no third-party music). PC Engine: its wavetables come back as
// def-waves, an instrument's wave macro and 10xx as the wave a channel
// plays, 08xy as a pan between the sides, 11xx's noise on noise5 at
// DefleMask's rates — and the score compiles clean as pce, and as md.
import assert from "node:assert/strict";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { parseDmf } from "../../live/src/import-dmf.js";
import { analyzeTracker, defaultTrackerOptions, trackerToMmlisp } from "../../live/src/import-tracker.js";

// A DefleMask 0x17 module for the PC Engine (system 0x05): one order of four
// rows. CH1 plays C-4 with instrument 0 (no wave macro) and 1000 (wave 0),
// panned left of centre (08F8), then E-4 with instrument 1, whose wave macro
// (wave 1) starts over at its note; CH5 turns its noise on (1101) and plays
// C-2 and D-2.
function pceDmf() {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const s16 = (v) => b.push(v & 0xff, (v >> 8) & 0xff);
  const i32 = (v) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const pstr = (s) => { u8(s.length); for (const ch of s) u8(ch.charCodeAt(0)); };
  const macro = (values, loop = 255) => { u8(values.length); for (const v of values) i32(v); if (values.length) u8(loop); };
  for (const ch of ".DelekDefleMask.") u8(ch.charCodeAt(0));
  u8(0x17); u8(0x05); // version, system: PC Engine
  pstr("pce test"); pstr("mmlisp");
  u8(4); u8(16); u8(0); u8(6); u8(6); u8(1); u8(0); for (const ch of "60\0") u8(ch.charCodeAt(0));
  u8(4); u8(1); // pattern length, orders
  for (let ch = 0; ch < 6; ch++) u8(0);
  u8(2); // instruments
  pstr("lead"); u8(0); macro([31, 20]); macro([]); u8(0); macro([]); macro([]);
  pstr("pad"); u8(0); macro([31]); macro([]); u8(0); macro([]); macro([1]);
  u8(2); // wavetables
  i32(32); for (let i = 0; i < 32; i++) i32(i < 16 ? 31 : 0);
  i32(32); for (let i = 0; i < 32; i++) i32(i);
  const empty = { note: 0, oct: 0, vol: -1, fx: [], ins: -1 };
  const rows = Array.from({ length: 6 }, () => Array.from({ length: 4 }, () => ({ ...empty })));
  rows[0][0] = { note: 12, oct: 3, vol: 31, fx: [[0x08, 0xf8], [0x10, 0]], ins: 0 };
  rows[0][2] = { note: 4, oct: 4, vol: -1, fx: [], ins: 1 };
  rows[4][0] = { note: 12, oct: 1, vol: 31, fx: [[0x11, 1]], ins: -1 };
  rows[4][2] = { note: 2, oct: 2, vol: -1, fx: [], ins: -1 };
  for (let ch = 0; ch < 6; ch++) {
    u8(2); // effect columns
    for (const r of rows[ch]) {
      s16(r.note); s16(r.oct); s16(r.vol);
      for (let k = 0; k < 2; k++) { const [code, val] = r.fx[k] ?? [-1, -1]; s16(code); s16(val); }
      s16(r.ins);
    }
  }
  return new Uint8Array(b);
}

const t = await parseDmf(pceDmf());
assert.equal(t.waves.length, 2, "both wavetables read");
assert.deepEqual(t.instruments[1].wave.values, [1], "the instrument's wave macro read");
const a = analyzeTracker(t);
assert.deepEqual(a.targets, ["pce", "md"], "a PC Engine module offers pce first");
const opt = defaultTrackerOptions(a, "pce");
assert.equal(opt.dest[0], "wave1");
assert.equal(opt.dest[4], "noise5", "a channel on its noise goes to the noise");

const { source, warnings } = trackerToMmlisp(t, { ...opt, fileName: "t.dmf" }, a);
assert.match(source, /\(def-score :target pce/, "a pce score");
assert.match(source, /\(def-wave wave-0 :wave \[127 127 /, "wave 0, its top 31 at 127");
assert.match(source, /\(def-wave wave-1 :wave \[-128 -120 /, "wave 1, a ramp from −128");
assert.match(source, /wave-0[^\n]*:pan -0\.47/, "10xx's wave and 08F8 as a pan");
assert.match(source, /wave-1 env-pad/, "the instrument's wave macro at its note");
assert.match(source, /\(def env-lead \(macro none\) \(macro :vol \[31 23\]\)\)/, "a PCE volume macro as :vol, 1.5 dB a step");
// C-2 and D-2 by DefleMask's table: rates 4 and 15, from c2 (rate 0).
assert.match(source, /\(def noise5-p00\s+:oct 2 [^\n]*\n\s+e > d\+ \|\)/, "the noise notes at their rates: e2, d+3");
// Compiled as Live compiles an import, its preset imports read from the repo.
const bad = (src) => compileMMLisp(src, "t.mmlisp", { imports: readImportSources("t.mmlisp", src) })
  .diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
assert.deepEqual(bad(source), [], "the pce score compiles clean");
assert.deepEqual(warnings, [], "nothing left out");

const md = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "md"), fileName: "t.dmf" }, a);
assert.doesNotMatch(md.source, /:target|def-wave/, "md: no wavetables");
assert.deepEqual(bad(md.source), [], "the md score compiles clean");

// A DefleMask 0x17 module for the NES (system 0x06): one order of four
// rows. Pulse 1 plays C-4 with "lead" (a volume and a duty macro: 50 %);
// Pulse 2 G-3 at volume 8 with 1201 (25 %) and no instrument; the
// triangle C-3, then a note-off; the noise
// C-2 and D-2 with "hat", whose duty macro's 1 is the short (periodic)
// mode, DefleMask's table taking the notes to rates 15 and 13 — c2, d2.
function nesDmf() {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const s16 = (v) => b.push(v & 0xff, (v >> 8) & 0xff);
  const i32 = (v) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const pstr = (s) => { u8(s.length); for (const ch of s) u8(ch.charCodeAt(0)); };
  const macro = (values, loop = 255) => { u8(values.length); for (const v of values) i32(v); if (values.length) u8(loop); };
  for (const ch of ".DelekDefleMask.") u8(ch.charCodeAt(0));
  u8(0x17); u8(0x06); // version, system: NES
  pstr("nes test"); pstr("mmlisp");
  u8(4); u8(16); u8(0); u8(6); u8(6); u8(1); u8(0); for (const ch of "60\0") u8(ch.charCodeAt(0));
  u8(4); u8(1); // pattern length, orders
  for (let ch = 0; ch < 5; ch++) u8(0);
  u8(2); // instruments
  pstr("lead"); u8(0); macro([15, 10, 5]); macro([]); u8(0); macro([2]); macro([]);
  pstr("hat"); u8(0); macro([15, 8]); macro([]); u8(0); macro([1]); macro([]);
  u8(0); // wavetables
  const empty = { note: 0, oct: 0, vol: -1, fx: [], ins: -1 };
  const rows = Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => ({ ...empty })));
  rows[0][0] = { note: 12, oct: 3, vol: 15, fx: [], ins: 0 };
  rows[1][0] = { note: 7, oct: 3, vol: 8, fx: [[0x12, 1]], ins: -1 };
  rows[2][0] = { note: 12, oct: 2, vol: 15, fx: [], ins: -1 };
  rows[2][2] = { note: 100, oct: 0, vol: -1, fx: [], ins: -1 };
  rows[3][0] = { note: 12, oct: 1, vol: 15, fx: [], ins: 1 };
  rows[3][2] = { note: 2, oct: 2, vol: -1, fx: [], ins: -1 };
  for (let ch = 0; ch < 5; ch++) {
    u8(2); // effect columns
    for (const r of rows[ch]) {
      s16(r.note); s16(r.oct); s16(r.vol);
      for (let k = 0; k < 2; k++) { const [code, val] = r.fx[k] ?? [-1, -1]; s16(code); s16(val); }
      s16(r.ins);
    }
  }
  return new Uint8Array(b);
}

{
  const t = await parseDmf(nesDmf());
  const a = analyzeTracker(t);
  assert.deepEqual(a.targets, ["fc", "md"], "an NES module offers fc first");
  const opt = defaultTrackerOptions(a, "fc");
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => opt.dest[i]), ["sqr1", "sqr2", "tri", "noise", "drop"]);
  for (const phrases of [true, false]) {
    const { source, warnings } = trackerToMmlisp(t, { ...opt, phrases, fileName: "t.dmf" }, a);
    assert.match(source, /\(def-score :target fc/, "an fc score");
    // A DMF adds the macro's steps to the column (no newVolumeScaling): at
    // column 15 the steps themselves, a def for that column.
    assert.match(source, /\(def env-lead-v15 \(macro none\) \(macro :vol \[31 29 26\] :duty \[8\]\)\)/, "the volume macro as :vol in dB, the duty macro as :duty");
    assert.match(source, /:duty 4[^\n]*:vel 12\.25/, "1201 as :duty 4, volume 8 as :vel in dB");
    assert.match(source, /env-lead-v15[^\n]*:duty 8|:duty 8[^\n]*env-lead-v15/, "the lead's duty macro's first step, 50 %");
    // The triangle's own lines: its phrase def or its track, to the noise's.
    const triAt = source.search(/\n\((?:def tri-|tri )/), noiseAt = source.search(/\n\((?:def noise-|noise )/);
    assert.ok(triAt >= 0 && noiseAt > triAt, "the triangle's lines found");
    assert.doesNotMatch(source.slice(triAt, noiseAt), /:vel/, "the triangle says no :vel");
    assert.match(source, /env-hat-noise[^\n]*:mode periodic|:mode periodic[^\n]*env-hat-noise/, "the hat's duty macro: the short mode");
    assert.match(source, /:mode periodic :oct 2[^\n]*\n?\s*c d\b/, "the noise notes at their rates: c2, d2");
    assert.deepEqual(bad(source), [], `the fc score compiles clean (phrases ${phrases})`);
    assert.deepEqual(warnings, [], "nothing left out");
  }
  const md = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "md"), fileName: "t.dmf" }, a);
  assert.doesNotMatch(md.source, /:target|:duty/, "md: no duty");
  assert.deepEqual(bad(md.source), [], "the md score compiles clean");

  // The DPCM as a .fur carries it (import-fur.js): a 1-bit sample and an
  // NES instrument without a note map, whose notes pick the DMC rate by
  // their low four bits — C-4 (48) rate 0, D#5 (63) rate 15 — the second
  // cut by a note off.
  t.samples = [{ name: "kick", rate: 33144, depth: 1, data: new Float32Array(64).fill(0.5), loop: null }];
  t.dpcmMode = true;
  t.instruments.push({ name: "dmc", kind: "std", type: 34, sampleMap: { init: 0, noteMap: null },
    vol: { values: [], loop: null }, arp: { values: [], loop: null }, wave: { values: [], loop: null }, duty: { values: [], loop: null } });
  const empty = { note: null, vol: -1, ins: -1, fx: [] };
  t.channels[4].patterns.set(0, [{ ...empty, note: 48, ins: 2 }, { ...empty, note: 63 }, { ...empty, note: "off" }, empty]);
  const b = analyzeTracker(t);
  const fc = trackerToMmlisp(t, { ...defaultTrackerOptions(b, "fc"), fileName: "t.fur" }, b);
  assert.match(fc.source, /\(def-pcm dpcm-kick :file "t-dpcm\.wav" :rate 4182 :offset 0 :frames 64\)/, "a def-pcm at the DMC's rate 0");
  assert.match(fc.source, /\(def-pcm dpcm-kick-2 :file "t-dpcm\.wav" :rate 33144 :offset 0 :frames 64\)/, "the same sample at rate 15");
  assert.match(fc.source, /\((?:def pcm1-p00|pcm1)\s+dpcm-kick :mode gate/, "pcm1 plays to the next note or the off");
  assert.equal(fc.pcm?.wavFile, "t-dpcm.wav", "the wav the defs read");
  assert.equal(fc.pcm.mono.length, 64, "each sample once in it");
  assert.deepEqual(bad(fc.source), [], "pcm1 beside sqr1 compiles clean (the DMC is its own channel)");
}

console.log("Tracker import checks passed: a PC Engine module as pce and as md, an NES module as fc and as md");
