#!/usr/bin/env node
// A song import onto :target midi (live/src/import-to-midi.js): a chip
// song read as its own machine's score, then through its MIDI. On a VGM
// written here (FM lead and bass, a square, the noise), a DefleMask module
// written here (its instruments named), and the preset kits' samples:
//   - the score compiles as midi, and every melodic note is kept (the keys
//     in order, track by track);
//   - each channel's GM voice: by an instrument's name, else by its kind and
//     range (a low FM a bass, a square the square lead);
//   - the noise is drums by pitch, a sample track's samples kit roles by
//     their sound — the main pieces of a real kit read right — and a stream
//     (a sample past 2 s) is left out.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderVgm } from "../../live/src/export-vgm.js";
import { midiPlan } from "../../live/src/export-midi.js";
import { parseVgm, analyzeVgm, defaultVgmOptions, vgmToMmlisp } from "../../live/src/import-vgm.js";
import { parseDmf } from "../../live/src/import-dmf.js";
import { analyzeTracker, defaultTrackerOptions, trackerToMmlisp } from "../../live/src/import-tracker.js";
import { decodeWav, resample } from "../../live/src/wav-decode.js";
import { parseMdx, analyzeMdx, mdxToMmlisp } from "../../live/src/import-mdx.js";
import { chipScoreToMidi, gmReading, programFor } from "../../live/src/import-to-midi.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compile = (src, opts = {}) => {
  const r = compileMMLisp(src, "t.mmlisp", { imports: readImportSources("t.mmlisp", src), ...opts });
  const bad = r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  assert.deepEqual(bad, [], "compiles clean");
  return r.ir;
};
// Each track's keys in order, melodic tracks only, sorted so the order of the
// tracks does not count.
// (A chip's noise and samples are melodic in its own MIDI: the drums here.)
const melodicKeys = (ir) => midiPlan(ir).tracks.filter((t) => !t.drums && !/^(noise|pcm|rhythm)/.test(t.name))
  .map((t) => t.notes.map((n) => n.key).join(",")).sort();
const voicesOf = (source) => [...source.matchAll(/\((ch\d+)[^\n]*\n\s*#top (gm-[a-z0-9-]+)/g)].map(([, ch, v]) => `${ch}:${v}`);

// ── A VGM ──
const song = `(def-fm lead :alg 4 :fb 5 :ar1 31 :dr1 5 :sl1 2 :rr1 6 :tl1 30 :ar2 31 :dr2 4 :rr2 6 :tl2 0 :ar3 31 :dr3 5 :rr3 6 :tl3 28 :ar4 31 :dr4 4 :rr4 6 :tl4 0)
(fm1 lead :tempo 140 :oct 4 :len 8 #top c e g > c < b g e g | a > c e c < a f a > c | (macro :pitch (sin -30..30 :len 8f)) :len 2 d c (macro :pitch none) (go top))
(fm2 lead :oct 2 :len 4 #top c c f f | a a g g | c c c c (go top))
(sqr1 :oct 5 :len 16 :vol 28 #top (x 8 c e g e) (x 4 a > c < a f) (x 4 g b > d < b) (go top))
(noise :len 8 #top (x 6 c c :vel 8 c :vel 15 c) (go top))`;
const vgm = renderVgm(new IRPlayer(() => {}).loadJSON(compile(song)), { title: "Test Song" }).bytes;
const parsed = await parseVgm(vgm);
const a = analyzeVgm(parsed);
const chip = vgmToMmlisp(parsed, { ...defaultVgmOptions(a), structure: true, fileName: "song.vgm" }, a);
const chipIr = compile(chip.source, { voiceStamps: true });
const out = chipScoreToMidi(chipIr, { source: chip.source, pcm: chip.pcm, fileName: "song.vgm", from: "VGM, read as md, then as MIDI" });
const midiIr = compile(out.source);
assert.match(out.source, /^; Imported from song\.vgm \(VGM, read as md, then as MIDI\)/, "says the road it came");
assert.match(out.source, /\(def-score :target midi :title "Test Song"\)/, "a midi score, the file's title kept");
assert.deepEqual(melodicKeys(midiIr), melodicKeys(chipIr), "every melodic note kept, in order");
assert.deepEqual(voicesOf(out.source).map((v) => v.split(":")[1]).sort(), ["gm-bass-finger", "gm-ep1", "gm-lead-square"], "a low FM the bass, the lead FM an EP, the square the square lead");
assert.match(out.source, /\(drum1 [^\n]*\n\s*#top hat\b/, "the noise ticking 8ths: a hat");
assert.match(out.source, /vib-30-8-p0/, "the vibrato kept as a pitch macro");
// A chip channel is one voice: a channel each, however fast its notes (a run
// closer than a 32nd is no chord), and the noise one drum track.
{
  const runs = compile("(def-score :target fc)\n(sqr1 :len 2f c d e f g a b > c)\n(tri :len 8 c e g e)\n(noise :len 2f c c c c c c c c)", { voiceStamps: true });
  const r = chipScoreToMidi(runs, { source: "", fileName: "runs.vgm", from: "VGM, read as fc, then as MIDI" });
  const heads = [...new Set((r.source.match(/^\((ch\d+|drum\d+)/gm) ?? []).map((x) => x.slice(1)))];
  assert.deepEqual(heads, ["ch1", "ch2", "drum1"], "three chip channels, three tracks");
}

// ── A DefleMask module (PC Engine): instruments named "lead" and "bass" ──
function pceDmf() {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const s16 = (v) => b.push(v & 0xff, (v >> 8) & 0xff);
  const i32 = (v) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const pstr = (s) => { u8(s.length); for (const ch of s) u8(ch.charCodeAt(0)); };
  const macro = (values, loop = 255) => { u8(values.length); for (const v of values) i32(v); if (values.length) u8(loop); };
  for (const ch of ".DelekDefleMask.") u8(ch.charCodeAt(0));
  u8(0x17); u8(0x05);
  pstr("named"); pstr("mmlisp");
  u8(4); u8(16); u8(0); u8(6); u8(6); u8(1); u8(0); for (const ch of "60\0") u8(ch.charCodeAt(0));
  u8(8); u8(1);
  for (let ch = 0; ch < 6; ch++) u8(0);
  u8(2);
  pstr("lead"); u8(0); macro([31]); macro([]); u8(0); macro([]); macro([]);
  pstr("bass"); u8(0); macro([31]); macro([]); u8(0); macro([]); macro([]);
  u8(1);
  i32(32); for (let i = 0; i < 32; i++) i32(i < 16 ? 31 : 0);
  const empty = { note: 0, oct: 0, vol: -1, fx: [], ins: -1 };
  const rows = Array.from({ length: 6 }, () => Array.from({ length: 8 }, () => ({ ...empty })));
  [0, 4, 7, 4, 0, 4, 7, 11].forEach((n, i) => { rows[0][i] = { note: n || 12, oct: n ? 4 : 3, vol: 31, fx: [], ins: i ? -1 : 0 }; });
  [0, 0, 5, 5, 7, 7, 0, 0].forEach((n, i) => { rows[1][i] = { note: n || 12, oct: n ? 2 : 1, vol: 31, fx: [], ins: i ? -1 : 1 }; });
  [0, 2, 4, 6].forEach((i) => { rows[4][i] = { note: 12, oct: 4, vol: 31, fx: i ? [] : [[0x11, 1]], ins: -1 }; });
  for (let ch = 0; ch < 6; ch++) {
    u8(1);
    for (const r of rows[ch]) {
      s16(r.note); s16(r.oct); s16(r.vol);
      const [code, val] = r.fx[0] ?? [-1, -1]; s16(code); s16(val);
      s16(r.ins);
    }
  }
  return new Uint8Array(b);
}
const t = await parseDmf(pceDmf());
const ta = analyzeTracker(t);
const tChip = trackerToMmlisp(t, { ...defaultTrackerOptions(ta, ta.target), fileName: "named.dmf" }, ta);
const tIr = compile(tChip.source, { voiceStamps: true });
const tOut = chipScoreToMidi(tIr, { source: tChip.source, pcm: tChip.pcm, fileName: "named.dmf", from: "DefleMask, read as pce, then as MIDI" });
compile(tOut.source);
assert.deepEqual(voicesOf(tOut.source).map((v) => v.split(":")[1]).sort(), ["gm-bass-finger", "gm-lead-saw"], "an instrument's name says its GM voice");
assert.match(tOut.source, /\(drum1/, "the noise is the drums");

// ── An MDX (X68000): an FM lead, an FM bass, ADPCM hits from its PDX ──
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
  const P = [...[15, 16, 15, 16, 15, 16].flatMap((k) => N(k, 24)), ...END]; // two ADPCM samples, by turns
  const tracks = [A, B, END, END, END, END, END, END, P];
  const voices = [{ num: 1, con: 4, fb: 5, ops: [op(), op({ tl: 0 }), op({ tl: 20 }), op({ tl: 0 })] }];
  // Two samples: a low thump and a bright hiss, as ADPCM nibbles.
  const pdx = new Uint8Array(768 + 2 * 2048);
  const put32 = (p, v) => { pdx[p] = v >>> 24; pdx[p + 1] = (v >> 16) & 255; pdx[p + 2] = (v >> 8) & 255; pdx[p + 3] = v & 255; };
  put32(0, 768); put32(4, 2048); put32(8, 768 + 2048); put32(12, 2048);
  for (let i = 0; i < 2048; i++) pdx[768 + i] = (Math.floor(i / 24) % 2 ? 0x99 : 0x11);
  let r = 1;
  for (let i = 0; i < 2048; i++) { r = (r * 1103515245 + 12345) >>> 0; pdx[768 + 2048 + i] = (r >>> 24) & 0xff; }
  const mdx = parseMdx(buildMdx({ title: "MDX song", pdx: "t", tracks, voices }));
  const ma = analyzeMdx(mdx);
  const mChip = mdxToMmlisp(mdx, { pdx, structure: true, fileName: "t.mdx" }, ma);
  const mIr = compile(mChip.source, { voiceStamps: true });
  const mOut = chipScoreToMidi(mIr, { source: mChip.source, pcm: mChip.pcm, fileName: "t.mdx", from: "MDX, read as x68k, then as MIDI" });
  const mMidi = compile(mOut.source);
  assert.deepEqual(melodicKeys(mMidi), melodicKeys(mIr), "MDX: every melodic note kept");
  assert.ok(voicesOf(mOut.source).some((v) => v.endsWith("gm-bass-finger")), "MDX: the low FM a bass");
  assert.match(mOut.source, /\(drum1/, "MDX: the ADPCM hits are the drums");
}

// ── Names ──
assert.equal(programFor("Slap Bass", { kind: "fm" }, []), "gm-bass-slap1");
assert.equal(programFor("STRINGS 2", { kind: "fm" }, []), "gm-strings1");
assert.equal(programFor("flute", { kind: "fm" }, []), "flute", "a role GM knows is kept");
assert.equal(programFor("voice-03", { kind: "fm" }, [{ key: 40, length: 0.2 }]), "gm-bass-finger", "a numbered voice says nothing: its range does");
assert.equal(programFor(null, { kind: "tone", name: "fc-tri" }, [{ key: 72, length: 0.2 }]), "gm-flute", "the 2A03's triangle up high a flute");

// ── A real kit's samples, as a chip holds them (10.1 kHz) ──
const KIT = { "036": "kick", "038": "snare", "042": "hat", "046": "hat-open", "049": "crash" };
for (const kit of ["tr808", "tr909", "rx5"]) {
  const parts = [], entries = [];
  let off = 0;
  for (const [n, role] of Object.entries(KIT)) {
    const file = readFileSync(join(repo, "live/presets", kit, "wav", (await import("node:fs")).readdirSync(join(repo, "live/presets", kit, "wav")).find((f) => f.startsWith(n))));
    const w = decodeWav(new Uint8Array(file));
    const x = resample(w.data, w.sampleRate, 10100);
    parts.push(x);
    entries.push({ name: `dac-${n}`, offset: off, frames: x.length, rate: 10100, role });
    off += x.length;
  }
  const mono = new Float32Array(off);
  let o = 0;
  for (const x of parts) { mono.set(x, o); o += x.length; }
  // The kick played most, then the hat, the snare.
  const uses = { "036": 8, "042": 6, "038": 4 };
  const events = entries.flatMap((e) => Array.from({ length: uses[e.name.slice(4)] ?? 1 }, (_, k) => ({ cmd: "PCM_NOTE_ON", tick: k * 48, args: { sample: e.name, pitch: "c4", length: 48 } })));
  const { ir } = gmReading({ ppqn: 96, metadata: { target: "md" }, tracks: [{ channel: "pcm1", events }] }, { pcm: { mono, rate: 10100, entries } });
  const got = Object.fromEntries(ir.tracks[0].events.map((e, k) => [events[k].args.sample, e.args.sample]));
  for (const e of entries) assert.equal(got[e.name], e.role, `${kit}: ${e.name.slice(4)} heard as the ${e.role}`);
}

// ── A stream on the DAC (a driver's mix, one sample of seconds) ──
{
  const mono = new Float32Array(10100 * 3).map((_, i) => Math.sin(i / 3));
  const events = [{ cmd: "PCM_NOTE_ON", tick: 0, args: { sample: "dac-01", pitch: "c4", length: 96 } }];
  const { ir, said } = gmReading({ ppqn: 96, metadata: { target: "md" }, tracks: [{ channel: "pcm1", events }] },
    { pcm: { mono, rate: 10100, entries: [{ name: "dac-01", offset: 0, frames: mono.length, rate: 10100 }] } });
  assert.equal(ir.tracks[0].events[0].cmd, "REST", "a stream is left out");
  assert.ok(said.some((s) => /stream/.test(s)), "and said");
}

console.log("check:import-to-midi ok — VGM, DefleMask and MDX read onto midi with every note, GM voices by name and range, the noise and three kits' samples as kit roles");
