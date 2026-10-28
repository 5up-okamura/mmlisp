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
import { analyzeTracker, defaultTrackerOptions, trackerToMmlisp, readArp } from "../../live/src/import-tracker.js";

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
// A third instrument, "kick", is a fixed arpeggio (C-3, F#-2), no note
// plays it here.
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
  u8(3); // instruments
  pstr("lead"); u8(0); macro([15, 10, 5]); macro([]); u8(0); macro([2]); macro([]);
  pstr("hat"); u8(0); macro([15, 8]); macro([]); u8(0); macro([1]); macro([]);
  pstr("kick"); u8(0); macro([]); macro([36, 30]); u8(1); macro([]); macro([]);
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
  t.channels[4].patterns.set(0, [{ ...empty, note: 48, ins: 3 }, { ...empty, note: 63 }, { ...empty, note: "off" }, empty]);
  const b = analyzeTracker(t);
  const fc = trackerToMmlisp(t, { ...defaultTrackerOptions(b, "fc"), fileName: "t.fur" }, b);
  assert.match(fc.source, /\(def-pcm dpcm-kick :file "t-dpcm\.wav" :rate 4182 :offset 0 :frames 64\)/, "a def-pcm at the DMC's rate 0");
  assert.match(fc.source, /\(def-pcm dpcm-kick-2 :file "t-dpcm\.wav" :rate 33144 :offset 0 :frames 64\)/, "the same sample at rate 15");
  assert.match(fc.source, /\((?:def pcm1-p00|pcm1)\s+dpcm-kick :mode gate/, "pcm1 plays to the next note or the off");
  assert.equal(fc.pcm?.wavFile, "t-dpcm.wav", "the wav the defs read");
  assert.equal(fc.pcm.mono.length, 64, "each sample once in it");
  assert.deepEqual(bad(fc.source), [], "pcm1 beside sqr1 compiles clean (the DMC is its own channel)");
}

// Fixed arpeggios (Furnace's calcArp): a DMF's fixed mode is every step's,
// ending on a relative 0 without a loop; a .fur's own steps by bit 30 (on
// a positive value, off on a negative one). On the triangle at C-2 the
// kick's C-3 and F#-2 are a :semi of 12 and 6, then back on the note; at
// G-2 a :semi of 5 and −1 — an env for each note it plays.
{
  const t = await parseDmf(nesDmf());
  assert.deepEqual(t.instruments[2].arp, { values: [36, 30, 0], loop: null, fixed: [true, true, false] }, "a DMF's fixed arp");
  assert.deepEqual(readArp({ values: [0x40000000 | 24, 7, -3 & ~0x40000000, -2], loop: 1 }),
    { values: [24, 7, -3, -2], loop: 1, fixed: [true, false, true, false] }, "a .fur's fixed steps by bit 30");
  assert.deepEqual(readArp({ values: [3, -1], loop: null }).fixed, null, "no fixed step, no flags");
  const empty = { note: null, vol: -1, ins: -1, fx: [] };
  t.channels[2].patterns.set(0, [{ ...empty, note: 24, vol: 15, ins: 2 }, { ...empty, note: 31 }, { ...empty, note: 24 }, empty]);
  const a = analyzeTracker(t);
  const { source, warnings } = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "fc"), fileName: "t.dmf" }, a);
  assert.match(source, /\(def env-kick-c2-tri \(macro none\) \(macro :semi\+ \[12 6 0\]\)\)/, "C-2: the fixed notes as steps from it");
  assert.match(source, /\(def env-kick-g2-tri \(macro none\) \(macro :semi\+ \[5 -1 0\]\)\)/, "G-2: its own env");
  assert.equal(source.match(/\(def env-kick-c2-tri /g).length, 1, "one env a note, shared");
  assert.deepEqual(warnings, [], "nothing left out");
  assert.deepEqual(bad(source), [], "the fixed arps compile clean");
}

// An old DefleMask module (0x0d, Genesis), in its layout as Furnace's
// dmf.cpp reads it: the arpeggio's tick length after the order count, an FM
// instrument with a spare byte after each word and the OPL's operator words,
// 1-byte macro values, no arp mode; the PSG's notes stored an octave up and
// E5xx a quarter of today's range. One order of two rows: FM1 C-4 with E590,
// SQ1 C-4 (stored as octave 5).
function oldDmf() {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const s16 = (v) => b.push(v & 0xff, (v >> 8) & 0xff);
  const i32 = (v) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const pstr = (s) => { u8(s.length); for (const ch of s) u8(ch.charCodeAt(0)); };
  for (const ch of ".DelekDefleMask.") u8(ch.charCodeAt(0));
  u8(0x0d); u8(0x02); // version, system: Genesis
  pstr("old"); pstr("mmlisp");
  u8(4); u8(16); u8(0); u8(6); u8(6); u8(1); u8(0); for (const ch of "60\0") u8(ch.charCodeAt(0));
  u8(2); u8(1); u8(1); // pattern length, orders, arpeggio tick length
  for (let ch = 0; ch < 10; ch++) u8(0);
  u8(2); // instruments
  pstr("bell"); u8(1);
  u8(4); u8(0); u8(5); u8(0); u8(2); u8(0); u8(1); u8(1); // alg, fb, fms (+ spares, operator count), ams
  for (let j = 0; j < 4; j++) {
    u8(0); u8(31); u8(0); // am, ar, dam
    u8(10 + j); u8(0); u8(0); u8(0); u8(0); // dr, dvb, egt, ksl, ksr
    u8(j + 1); u8(7); u8(2); u8(0); // mul, rr, sl, sus
    u8(j === 3 ? 0 : 30); u8(0); u8(0); // tl, vib, ws
    u8(0); u8(3); u8(4); u8(0); // rs, dt, sr, ssg
  }
  pstr("sq"); u8(0); u8(2); u8(15); u8(8); u8(255); u8(0); u8(0); u8(0); // vol [15 8], no arp, duty, wave
  u8(0); // wavetables
  const empty = { note: 0, oct: 0, vol: -1, fx: [], ins: -1 };
  const rows = Array.from({ length: 10 }, () => Array.from({ length: 2 }, () => ({ ...empty })));
  rows[0][0] = { note: 12, oct: 3, vol: -1, fx: [[0xe5, 0x90]], ins: 0 };
  rows[6][0] = { note: 12, oct: 4, vol: 15, fx: [], ins: 1 };
  for (let ch = 0; ch < 10; ch++) {
    u8(1); // effect columns
    for (const r of rows[ch]) {
      s16(r.note); s16(r.oct); s16(r.vol);
      const [code, val] = r.fx[0] ?? [-1, -1]; s16(code); s16(val);
      s16(r.ins);
    }
  }
  u8(0); // samples
  return new Uint8Array(b);
}

{
  const t = await parseDmf(oldDmf());
  const fm = t.instruments[0].fm;
  assert.deepEqual([fm.alg, fm.fb, fm.fms, fm.ams], [4, 5, 2, 1], "the old FM words past their spares");
  assert.deepEqual(fm.ops.map((o) => [o.dr, o.mul, o.tl, o.dt, o.sr]), [[10, 1, 30, 3, 4], [11, 2, 30, 3, 4], [12, 3, 30, 3, 4], [13, 4, 0, 3, 4]],
    "the old operators past the OPL's words");
  assert.deepEqual(t.instruments[1].vol.values, [15, 8], "1-byte macro values");
  assert.equal(t.channels[6].patterns.get(0)[0].note, 48, "the PSG's C-4, stored an octave up");
  assert.deepEqual(t.channels[0].patterns.get(0)[0].fx, [[0xe5, 132]], "E590 as a quarter of today's range, E584");
  const a = analyzeTracker(t);
  const { source } = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "md"), fileName: "t.dmf" }, a);
  assert.deepEqual(bad(source), [], "the old module compiles clean");
}

// A DefleMask 0x18 Genesis module whose FM6 plays the DAC (Furnace's
// legacy sample mode): 1701 there, then C-4 and C#-4 play samples 0 and 1
// (12 × bank + the note's place); 1700, and D-4 is FM6's FM voice again.
// Three 8-bit samples: "kick" at 16 kHz (code 3), its amp 100 (2×), its
// pitch 4 (read every half step: twice as long).
function dacDmf() {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const s16 = (v) => b.push(v & 0xff, (v >> 8) & 0xff);
  const i32 = (v) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const pstr = (s) => { u8(s.length); for (const ch of s) u8(ch.charCodeAt(0)); };
  for (const ch of ".DelekDefleMask.") u8(ch.charCodeAt(0));
  u8(0x18); u8(0x02); // version, system: Genesis
  pstr("dac"); pstr("mmlisp");
  u8(4); u8(16); u8(0); u8(6); u8(6); u8(1); u8(0); for (const ch of "60\0") u8(ch.charCodeAt(0));
  i32(4); u8(1); // pattern length, orders
  for (let ch = 0; ch < 10; ch++) u8(0);
  u8(1); // instruments
  pstr("fm"); u8(1); u8(4); u8(0); u8(0); u8(0);
  for (let j = 0; j < 4; j++) { u8(0); u8(31); u8(5); u8(1); u8(7); u8(2); u8(j === 3 ? 0 : 30); u8(0); u8(0); u8(0); u8(0); u8(0); }
  u8(0); // wavetables
  const empty = { note: 0, oct: 0, vol: -1, fx: [], ins: -1 };
  const rows = Array.from({ length: 10 }, () => Array.from({ length: 4 }, () => ({ ...empty })));
  rows[5][0] = { note: 12, oct: 3, vol: -1, fx: [[0x17, 1]], ins: 0 };
  rows[5][1] = { note: 1, oct: 4, vol: -1, fx: [], ins: -1 };
  rows[5][2] = { note: 2, oct: 4, vol: -1, fx: [[0x17, 0]], ins: -1 };
  for (let ch = 0; ch < 10; ch++) {
    u8(1); // effect columns
    for (const r of rows[ch]) {
      s16(r.note); s16(r.oct); s16(r.vol);
      const [code, val] = r.fx[0] ?? [-1, -1]; s16(code); s16(val);
      s16(r.ins);
    }
  }
  u8(3); // samples
  for (const [name, amp, pitch] of [["kick.wav", 100, 4], ["snare", 50, 5], ["hat", 50, 5]]) {
    i32(4); pstr(name); u8(3); u8(pitch); u8(amp); u8(8);
    for (const v of [0x80, 0xa0, 0x60, 0x80]) s16(v);
  }
  return new Uint8Array(b);
}

{
  const t = await parseDmf(dacDmf());
  // The DAC note's row sets FM6's volume, which D-4 (FM) then plays at.
  t.channels[5].patterns.get(0)[0].vol = 120;
  assert.deepEqual([...t.samples[0].data], [0, 0, 0.5, 0.5, -0.5, -0.5, 0, 0], "amp 100 doubles, pitch 4 reads each word twice");
  assert.deepEqual([t.samples[1].rate, t.samples[1].data.length], [16000, 4], "rate code 3, pitch 5 as stored");
  const a = analyzeTracker(t);
  assert.equal(a.channels[5].sampleNotes, 2, "two notes on the DAC");
  // FM6 asked onto fm6, which is the DAC's while it plays.
  const opt = defaultTrackerOptions(a, "md");
  const { source, warnings, pcm } = trackerToMmlisp(t, { ...opt, dest: { ...opt.dest, 5: "fm6" }, fileName: "t.dmf" }, a);
  assert.match(source, /\(def-pcm dac-kick :file "t-dac\.wav" :rate 16000 :offset 0 :frames 8\)/, "the kick at its rate, its extension off its name");
  assert.match(source, /\(def-pcm dac-snare :file "t-dac\.wav" :rate 16000 :offset 8 :frames 4\)/, "the snare after it");
  assert.match(source, /\((?:def pcm1-p00|pcm1)\s+dac-kick :mode gate[^\n]*\n?\s*c dac-snare c/, "C-4 and C#-4: samples 0 and 1, on pcm1");
  assert.match(source, /\(def fm\d-p00\s+ins-fm[^)]*:vel 12[^)]*_ d \|\)/, "D-4 after 1700: FM6's FM note at the DAC row's volume, its rest where the DAC played");
  assert.deepEqual(warnings, ["FM6: fm6 is the DAC — its FM notes on fm1"], "17xx read, not skipped; FM6's FM notes off fm6");
  assert.equal(pcm?.wavFile, "t-dac.wav");
  assert.deepEqual(bad(source), [], "the DAC score compiles clean");
}

// The level under a sounding note: Pulse 1's C-4 at 15 drops to 8 a row
// on (no note there), and its D-4 slides down with 0A01, a quarter step a
// frame — 1.5 a row of six frames, 8 to 5 over two rows. Pulse 2's C-4 at
// 4 slides up with 0A40, a step a frame, to 15 five frames into its
// second row (where the slide stops); its D-4 starts there, and F903
// takes it to 12. On fc the line is a :vel macro, beside the lead's
// envelope on :vol — the linear column a curve in dB, a line a row; on md
// a :vol macro under the loudest the note gets, as its :vel, beside the
// envelope's :vel*.
{
  const t = await parseDmf(nesDmf());
  const e = { note: null, vol: -1, ins: -1, fx: [] };
  t.channels[0].patterns.set(0, [{ ...e, note: 48, vol: 15, ins: 0 }, { ...e, vol: 8 }, { ...e, note: 50, fx: [[0x0a, 0x01]] }, e]);
  t.channels[1].patterns.set(0, [{ ...e, note: 48, vol: 4, ins: 0, fx: [[0x0a, 0x40]] }, e, { ...e, note: 50 }, { ...e, fx: [[0xf9, 3]] }]);
  const a = analyzeTracker(t);
  const fc = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "fc"), fileName: "t.dmf" }, a);
  assert.match(fc.source, /\(macro :vel \[\(wait 24t\) \(linear 12\.25\.\.12\.25 :len 24t\)\]\)[^\n]*\n[^\n]* c /, "fc: a volume under the note, a step on its :vel");
  assert.match(fc.source, /\(macro :vel \[\(linear 12\.25\.\.11\.375 :len 24t\) \(linear 11\.375\.\.10\.25 :len 24t\)\]\) :vel 12\.25 d/, "fc: 0A01 down two rows");
  assert.match(fc.source, /\(macro :vel \[\(linear 9\.25\.\.13\.25 :len 24t\) \(linear 13\.25\.\.15 :len 20t\)\]\)/, "fc: 0A40 up, stopped at the top");
  assert.match(fc.source, /\(macro :vel \[\(wait 24t\) \(linear 14\.\.14 :len 24t\)\]\) :vel 15 d/, "fc: the next note from the top, then F903");
  const md = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "md"), fileName: "t.dmf" }, a);
  assert.match(md.source, /env-lead \(macro :vol \[\(wait 24t\) \(linear 24\.\.24 :len 24t\)\]\)/, "md: the step 7 :vel steps down, on :vol");
  assert.match(md.source, /\(macro :vol \[\(linear 31\.\.28 :len 48t\)\]\) :vel 8 d/, "md: 0A01 under the note's :vel, one line over its rows");
  assert.match(md.source, /env-lead \(macro :vol \[\(linear 20\.\.31 :len 44t\)\]\) :oct 5 :vel 15/, "md: 0A40 up to the note's :vel, its top");
  for (const { source, warnings } of [fc, md]) {
    assert.deepEqual(warnings, [], "nothing left out");
    assert.deepEqual(bad(source), [], "the level lines compile clean");
  }
}

// Volume slides as Furnace's playback.cpp stops and pairs them. Pulse 1:
// 0A02 down a row, an empty 0A (00) stops it; 04 46 under the note, then
// at D-4 0400 and 0501 — the 46 vibrato again, with a slide. Pulse 2: 0A02,
// stopped by a tremolo (0742, itself not imported); D-4 with 0310, G-4
// with 0601 — that portamento again, with a slide. On FM (Genesis): FA0F
// from 127 reaches 0 two and a half frames into D-4's row, which ends
// D-4 there — D-4 at 37, 67.5 dB down, is :vel's floor (30 dB) and :vol
// 12 (38 more); a note at volume 0 is silent (the carriers at TL 127) and
// left out. FM3's volume 100 after ED03 moves its note three frames into
// the row.
{
  const t = await parseDmf(nesDmf());
  const e = { note: null, vol: -1, ins: -1, fx: [] };
  t.channels[0].patterns.set(0, [{ ...e, note: 48, vol: 15, ins: 0, fx: [[0x0a, 0x02]] }, { ...e, fx: [[0x0a, -1]] }, { ...e, fx: [[0x04, 0x46]] }, { ...e, note: 50, fx: [[0x04, 0], [0x05, 0x01]] }]);
  t.channels[1].patterns.set(0, [{ ...e, note: 48, vol: 15, ins: 0, fx: [[0x0a, 0x02]] }, { ...e, fx: [[0x07, 0x42]] }, { ...e, note: 50, fx: [[0x03, 0x10]] }, { ...e, note: 55, fx: [[0x06, 0x01]] }]);
  const a = analyzeTracker(t);
  const { source, warnings } = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "fc"), phrases: false, fileName: "t.dmf" }, a);
  assert.match(source, /\(macro :vel \[\(linear 15\.\.14 :len 24t\)\]\)[^\n]*c8\. /, "an empty 0A stops the slide: one row of it");
  assert.match(source, /vib-46 \(macro :vel \[\(linear 14\.\.13\.5 :len 24t\)\]\) :vel 14 d/, "0501: the last vibrato and a slide");
  assert.match(source, /c8 \(macro :vel none\) env-lead-v12/, "the tremolo stops the slide; the line cleared ahead of the voice");
  assert.match(source, /\(glide 4f\)[^~\n]* ~ d /, "0310: a glide from the c, 200 cents at 50 a tick");
  assert.match(source, /\(glide 10f\) \(macro :vel \[\(linear 14\.\.13\.5 :len 24t\)\]\) ~ g/, "0601: the last portamento and a slide");
  assert.deepEqual(warnings, ["effect tremolo skipped (1×)"]);
  assert.deepEqual(bad(source), [], "the slides compile clean");
}
{
  const t = await parseDmf(oldDmf());
  const e = { note: null, vol: -1, ins: -1, fx: [] };
  t.channels[0].patterns.set(0, [{ ...e, note: 48, vol: 127, ins: 0, fx: [[0xfa, 0x0f]] }, { ...e, note: 50 }]);
  t.channels[1].patterns.set(0, [{ ...e, note: 48, vol: 0, ins: 0 }, { ...e, note: 50, vol: 100 }]);
  t.channels[2].patterns.set(0, [{ ...e, note: 48, vol: 127, ins: 0 }, { ...e, vol: 100, fx: [[0xed, 3]] }]);
  const a = analyzeTracker(t);
  const { source, warnings } = trackerToMmlisp(t, { ...defaultTrackerOptions(a, "md"), phrases: false, fileName: "t.dmf" }, a);
  assert.match(source, /\(macro :vol \[\(linear 12\.\.0 :len 10t\)\]\) :vel 0 d10t _14t/, "FAxx reaching 0 ends the FM note");
  assert.match(source, /\(fm2 [^\n]*\n\s+#top ins-bell :oct 4 :vel 5 _ d/, "an FM note at volume 0 left out");
  assert.match(source, /\(macro :vol \[\(wait 36t\) \(linear 21\.\.21 :len 12t\)\]\)/, "ED03: the volume three frames in");
  assert.deepEqual(warnings, []);
  assert.deepEqual(bad(source), [], "the FM lines compile clean");
}

console.log("Tracker import checks passed: a PC Engine module as pce and as md, an NES module as fc and as md, fixed arpeggios, an old DMF, a DMF's DAC, volume slides");
