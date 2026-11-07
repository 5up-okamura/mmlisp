#!/usr/bin/env node
// A score on another 4-operator FM machine (live/src/score-port.js), at the
// words' level:
//   - every md score (drv/tests) and every pc88 and x68k test score
//     (tools/tests) onto the other two compiles clean, and each track a
//     channel takes keeps its notes — the same ticks and pitches (a noise's
//     ticks, a sample track's ticks and samples), on the channel its row
//     names;
//   - an MDX (the fixture check-import-to-midi builds) read as x68k, onto md
//     and pc88, keeps every melodic note;
//   - the rules: the OPM's LFO frequency the OPN's nearest rate, fm8's noise
//     notes the noise, FM3's operator tracks free channels under
//     one-operator voices, the ROM rhythm presets/rx5's samples and back,
//     and what is dropped is said.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { pitchToMidi } from "../../live/src/ir-utils.js";
import { midiPlan } from "../../live/src/export-midi.js";
import { TARGETS } from "../../live/src/targets.js";
import { parseMdx, analyzeMdx, mdxToMmlisp } from "../../live/src/import-mdx.js";
import { portScore, portRows, scoreTargetOf, PORT_TARGETS } from "../../live/src/score-port.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compile = (src, file) => {
  const r = compileMMLisp(src, file, { imports: readImportSources(file, src) });
  const bad = r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  return { ir: r.ir, bad };
};

// A channel's notes as the MIDI export plays them out (the loops unrolled,
// the voice hoist's moves taken back): on and key, a noise's or a sample's on.
function notesOf(ir, channel, kind) {
  const keyed = kind !== "noise" && kind !== "sample";
  return midiPlan(ir).tracks.filter((t) => t.name === channel)
    .flatMap((t) => t.notes.map((n) => (keyed ? `${n.on}:${n.key}` : `${n.on}`))).sort();
}

let scores = 0;
let tracks = 0;
function check(file, src, to) {
  const from = scoreTargetOf(src);
  const imports = readImportSources(file, src);
  const r = portScore(src, to, { imports });
  assert.ok(!r.error, `${file} → ${to}: ${r.error}`);
  const before = compile(src, file);
  const after = compile(r.text, file);
  assert.deepEqual(after.bad, [], `${file} → ${to} compiles clean`);
  if (before.bad.length) return r; // a score of the language's errors: its notes are not the point
  const { rows } = portRows(src, to, { imports });
  for (const row of rows) {
    const dest = r.map[row.key];
    if (dest === "drop" || row.key === "fm8/noise" || row.head === "fm8" && rows.some((x) => x.key === "fm8/noise")) continue;
    const kind = TARGETS[from].partOf(row.head).kind;
    // A sample on the ROM rhythm plays its role's ROM sound; a role played
    // on a sample channel, its kit's sample: the names are the roles both ways.
    const was = notesOf(before.ir, row.head, kind);
    const now = notesOf(after.ir, dest, kind);
    assert.deepEqual(now, was, `${file} → ${to}: ${row.head} on ${dest} keeps its notes`);
    tracks++;
  }
  scores++;
  return r;
}

const dir = (d) => readdirSync(join(repo, d)).filter((f) => f.endsWith(".mmlisp")).map((f) => join(repo, d, f));
const files = [...dir("drv/tests"), ...dir("tools/tests/pc88"), ...dir("tools/tests/x68k")];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const to of PORT_TARGETS) if (to !== scoreTargetOf(src)) check(file, src, to);
}

// ── An MDX: read as x68k, then onto md and pc88 ──
{
  const be16 = (n) => [(n >> 8) & 255, n & 255];
  const buildMdx = ({ title, pdx, tracks, voices }) => {
    const head = [...Buffer.from(title, "latin1"), 0x0d, 0x0a, 0x1a, ...Buffer.from(pdx, "latin1"), 0];
    const table = 2 + tracks.length * 2;
    const body = [], offs = [];
    for (const tr of tracks) { offs.push(table + body.length); body.push(...tr); }
    const voiceAt = table + body.length;
    for (const v of voices) {
      body.push(v.num, (v.fb << 3) | v.con, 15);
      for (const f of [(o) => (o.dt << 4) | o.mul, (o) => o.tl, (o) => (o.ks << 6) | o.ar, (o) => (o.am << 7) | o.dr,
        (o) => (o.dt2 << 6) | o.sr, (o) => (o.sl << 4) | o.rr]) for (const o of v.ops) body.push(f(o));
    }
    return new Uint8Array([...head, ...be16(voiceAt), ...offs.flatMap(be16), ...body]);
  };
  const op = (o = {}) => ({ dt: 0, mul: 1, tl: 30, ks: 0, ar: 31, am: 0, dr: 10, dt2: 0, sr: 0, sl: 5, rr: 7, ...o });
  const N = (midi, clocks) => [0x80 + midi - 15, clocks - 1];
  const END = [0xf1, 0, 0];
  const A = [0xff, 200, 0xfd, 1, ...[60, 64, 67, 72, 67, 64].flatMap((k) => N(k, 24)), ...END];
  const B = [0xfd, 1, ...[36, 36, 43, 43, 41, 41].flatMap((k) => N(k, 24)), ...END];
  const G = [0xfd, 1, ...[72, 76, 79, 76].flatMap((k) => N(k, 36)), ...END]; // fm7: past the OPN's six
  const H = [0xfd, 2, ...[48, 55].flatMap((k) => N(k, 72)), ...END]; // fm8, on the DT2 voice
  const tracks = [A, B, END, END, END, END, G, H, END];
  const voices = [
    { num: 1, con: 4, fb: 5, ops: [op(), op({ tl: 0 }), op({ tl: 20 }), op({ tl: 0 })] },
    { num: 2, con: 7, fb: 0, ops: [op({ dt2: 1 }), op({ tl: 10 }), op({ tl: 10, dt2: 2 }), op({ tl: 10 })] },
  ];
  const mdx = parseMdx(buildMdx({ title: "MDX song", pdx: "", tracks, voices }));
  const chip = mdxToMmlisp(mdx, { structure: true, fileName: "t.mdx" }, analyzeMdx(mdx));
  const file = join(repo, "tools/tests/t.mmlisp");
  const melodic = (ir) => ir.tracks.filter((t) => /^(fm|sqr)/.test(t.channel))
    .map((t) => t.events.filter((e) => e.cmd === "NOTE_ON").map((e) => `${e.tick}:${Math.round(pitchToMidi(e.args.pitch))}`).join(","))
    .filter(Boolean).sort();
  const was = melodic(compile(chip.source, file).ir);
  assert.equal(was.length, 4, "the MDX: four melodic parts");
  for (const to of ["md", "pc88"]) {
    const r = portScore(chip.source, to);
    assert.ok(!r.error, r.error);
    const out = compile(r.text, file);
    assert.deepEqual(out.bad, [], `MDX → ${to} compiles clean`);
    assert.deepEqual(melodic(out.ir), was, `MDX → ${to}: every melodic note kept`);
    assert.match(r.text, /^; Converted from :target x68k\n/, "says where it came from");
    assert.ok(r.said.some((s) => /'voice-02' plays without :dt2-1 :dt2-2/.test(s)), `MDX → ${to}: DT2 said`);
    assert.deepEqual([r.map.fm7, r.map.fm8], ["fm3", "fm4"], "fm7 and fm8, past the OPN's six, on the FM channels the song leaves free");
  }
  // The log calls a part by the song's name for it.
  const named = portScore(chip.source, "md", { rows: { fm7: "drop" }, names: { fm7: "FM G" } });
  assert.ok(named.said.includes("FM G (4 notes) is not converted"), named.said.join("\n"));
}

// ── The rules ──
const port = (src, to, rows) => {
  const r = portScore(src, to, { rows });
  assert.ok(!r.error, r.error);
  assert.deepEqual(compile(r.text, join(repo, "tools/tests/t.mmlisp")).bad, [], `compiles clean:\n${r.text}`);
  return r;
};
{
  // The OPM's LFO: 200 is 5.72 Hz, the OPN's rate 2 (5.56 Hz); its depth and wave go.
  const r = port("(def-score :target x68k)\n(fm1 :lfo-freq 200 :lfo-pmd 40 :lfo-wave triangle :len 4 c)", "md");
  assert.match(r.text, /\(fm1 :lfo-rate 2 :len 4 c\)/);
  assert.ok(r.said.some((s) => /:lfo-pmd/.test(s)) && r.said.some((s) => /:lfo-wave/.test(s)));
}
{
  // fm8's noise notes the noise, its tone notes fm8's row's channel; the
  // rate the nearest white noise.
  const r = port(readFileSync(join(repo, "tools/tests/x68k/fm8-noise.mmlisp"), "utf8"), "md");
  assert.match(r.text, /\(noise :mode white1 :len 16 c c c c c c :mode white0 c c\n\s+:oct 5 :len 4 _ \|\)/);
  assert.match(r.text, /\(fm2 hat :len 16 _ _ _ _ _ _ _ _\n\s+:oct 5 :len 4 c \|\)/);
  const pc = port(readFileSync(join(repo, "tools/tests/x68k/fm8-noise.mmlisp"), "utf8"), "pc88");
  assert.match(pc.text, /\(noise :noise-rate 17 :len 16/, "the SSG's noise rate is the OPM's");
}
{
  // FM3's operators onto x68k: a channel each, under a one-operator voice.
  const r = port(readFileSync(join(repo, "drv/tests/m3-fm3op.mmlisp"), "utf8"), "x68k");
  assert.match(r.text, /\(def-fm kit-op2 kit :alg 7 :tl1 127 :tl3 127 :tl4 127\)/);
  assert.match(r.text, /\(fm3 :tempo 120 kit-op1 /, "the patch's tempo and voice on the first");
  assert.deepEqual([r.map["fm3-1"], r.map["fm3-2"], r.map["fm3-3"], r.map["fm3-4"]], ["fm3", "fm7", "fm8", "fm1"]);
}
{
  // md's squares onto x68k: free FM channels under the square stand-in,
  // after the noise has fm8; the noise's white noise a rate.
  const r = port("(def-fm lead init-fm)\n(fm1 lead :len 4 c)\n(sqr1 :len 4 e)\n(noise :mode white1 :len 8 c c)", "x68k");
  assert.match(r.text, /\(import "presets\/waveforms\/set\.mmlisp"\)/);
  assert.match(r.text, /\(fm7 wave-square :len 4 e\)/);
  assert.match(r.text, /\(noise :noise-rate 18 :len 8 c c\)/);
  // …and onto pc88 the noise is sqr3: md's sqr3 cannot sit beside it.
  const p = port("(fm1 :len 4 c)\n(sqr3 :len 4 e)\n(noise :len 8 c c)", "pc88");
  assert.equal(p.map.noise, "noise");
  assert.equal(p.map.sqr3, "sqr1");
  assert.ok(portScore("(sqr3 :len 4 e)\n(noise :len 8 c c)", "pc88", { rows: { sqr3: "sqr3" } }).error, "two of md's voices on pc88's one");
}
{
  // The ROM rhythm onto md: presets/rx5's samples under the roles' names,
  // its pan dropped; back onto pc88, a track of roles is the rhythm again.
  const r = port(readFileSync(join(repo, "tools/tests/pc88/rhythm.mmlisp"), "utf8"), "md");
  assert.match(r.text, /\(import "presets\/rx5\/set\.mmlisp"\)/);
  assert.match(r.text, /:pcm-voices 3/);
  assert.ok(r.said.some((s) => /^rhythm4 \(10 notes\) is not converted/.test(s)), "past md's three, said");
  const back = port(r.text, "pc88");
  assert.deepEqual([back.map.pcm1, back.map.pcm2, back.map.pcm3], ["rhythm1", "rhythm2", "rhythm3"]);
}
{
  // The ADPCM-B loops a sample's whole range: the loop is made the range.
  const r = port("(def-pcm pad :file \"pad.wav\" :loop-start 9ms :loop-end 36ms)\n(pcm1 :mode loop pad :len 2 c)", "pc88");
  assert.match(r.text, /\(def-pcm pad :file "pad\.wav" :pcm-start 9ms :pcm-end 36ms\)/);
}
{
  // A sound effect is the Mega Drive driver's.
  const r = port("(def-se jump (fm1 :len 16 c e g))\n(fm1 :len 4 c)", "x68k");
  assert.doesNotMatch(r.text, /def-se/);
  assert.ok(r.said.some((s) => /def-se jump/.test(s)));
}

console.log(`check:score-port ok — ${scores} conversions compile clean with ${tracks} tracks' notes kept, an MDX onto md and pc88, the rules`);
