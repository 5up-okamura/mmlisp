#!/usr/bin/env node
// The tracker importer's PC Engine path on a DefleMask module written here,
// byte by byte (no third-party music): its wavetables come back as
// def-waves, an instrument's wave macro and 10xx as the wave a channel
// plays, 08xy as a pan between the sides, 11xx's noise on noise5 at
// DefleMask's rates — and the score compiles clean as pce, and as md.
import assert from "node:assert/strict";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { parseDmf } from "../../live/src/import-dmf.js";
import { analyzeTracker, defaultTrackerOptions, trackerToMmlisp } from "../../live/src/import-tracker.js";

// A DefleMask 0x17 module for the PC Engine (system 0x05): one order of four
// rows. CH1 plays C-4 with instrument 0 (its wave macro: wave 0), panned
// left of centre (08F8), then E-4 with 1001 (wave 1); CH5 turns its noise on
// (1101) and plays C-2 and D-2.
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
  u8(1); // instruments
  pstr("lead"); u8(0); macro([31, 20]); macro([]); u8(0); macro([]); macro([0]);
  u8(2); // wavetables
  i32(32); for (let i = 0; i < 32; i++) i32(i < 16 ? 31 : 0);
  i32(32); for (let i = 0; i < 32; i++) i32(i);
  const empty = { note: 0, oct: 0, vol: -1, fx: [], ins: -1 };
  const rows = Array.from({ length: 6 }, () => Array.from({ length: 4 }, () => ({ ...empty })));
  rows[0][0] = { note: 12, oct: 3, vol: 31, fx: [[0x08, 0xf8]], ins: 0 };
  rows[0][2] = { note: 4, oct: 4, vol: -1, fx: [[0x10, 1]], ins: -1 };
  rows[4][0] = { note: 12, oct: 1, vol: 31, fx: [[0x11, 1]], ins: -1 };
  rows[4][2] = { note: 2, oct: 2, vol: -1, fx: [], ins: -1 };
  for (let ch = 0; ch < 6; ch++) {
    u8(1); // effect columns
    for (const r of rows[ch]) {
      s16(r.note); s16(r.oct); s16(r.vol);
      const [code, val] = r.fx[0] ?? [-1, -1];
      s16(code); s16(val); s16(r.ins);
    }
  }
  return new Uint8Array(b);
}

const t = await parseDmf(pceDmf());
assert.equal(t.waves.length, 2, "both wavetables read");
assert.deepEqual(t.instruments[0].wave.values, [0], "the instrument's wave macro read");
const a = analyzeTracker(t);
assert.deepEqual(a.targets, ["pce", "md"], "a PC Engine module offers pce first");
const opt = defaultTrackerOptions(a, "pce");
assert.equal(opt.dest[0], "wave1");
assert.equal(opt.dest[4], "noise5", "a channel on its noise goes to the noise");

const { source, warnings } = trackerToMmlisp(t, { ...opt, fileName: "t.dmf" }, a);
assert.match(source, /\(def-score :target pce/, "a pce score");
assert.match(source, /\(def-wave wave-0 :wave \[127 127 /, "wave 0, its top 31 at 127");
assert.match(source, /\(def-wave wave-1 :wave \[-128 -120 /, "wave 1, a ramp from −128");
assert.match(source, /wave-0[^\n]*:pan -0\.47/, "the instrument's wave and 08F8 as a pan");
assert.match(source, /wave-1/, "10xx switches the wave");
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

console.log("Tracker import checks passed: a PC Engine module as pce and as md");
