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
import { importMucom, MUCOM_TARGETS } from "../../live/src/import-mucom.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderVgm } from "../../live/src/export-vgm.js";
import { parseVgm, analyzeVgm, defaultVgmOptions, vgmToMmlisp } from "../../live/src/import-vgm.js";
import { portScore, portRows, scoreTargetOf, PORT_TARGETS } from "../../live/src/score-port.js";
import { WAVEFORM_WORDS, waveformOf, carrierOctave, opnAs2op } from "../../live/src/voice-port.js";
import { shapeOf, envelopeOf } from "../../live/src/wave-port.js";
import { parse } from "../../live/src/mmlisp-parser.js";
import { canonicalTarget } from "../../live/src/mmlisp2ir.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compile = (src, file) => {
  const r = compileMMLisp(src, file, { imports: readImportSources(file, src) });
  const bad = r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
  return { ir: r.ir, bad };
};

// A channel's notes as the MIDI export plays them out (the loops unrolled,
// the voice hoist's moves taken back): on and key, a noise's or a sample's on.
// A loop is unrolled up to the song's longest track, which a dropped track
// may have been: the notes are compared up to `until`, the shorter song's end.
function notesOf(ir, channel, kind, until = Infinity, keyed = kind !== "noise" && kind !== "sample") {
  return midiPlan(ir).tracks.filter((t) => t.name === channel)
    .flatMap((t) => t.notes.filter((n) => n.on < until).map((n) => (keyed ? `${n.on}:${n.key}` : `${n.on}`))).sort();
}

let scores = 0;
let tracks = 0;
function check(file, src, to) {
  const from = scoreTargetOf(src);
  const imports = readImportSources(file, src);
  const r = portScore(src, to, { imports });
  assert.ok(!r.error, `${file} → ${to}: ${r.error}`);
  const before = compile(src, file);
  if (before.bad.length) return r; // a score of the language's errors (a diagnostics test): not converted clean
  const after = compile(r.text, file);
  assert.deepEqual(after.bad, [], `${file} → ${to} compiles clean`);
  const { rows } = portRows(src, to, { imports });
  for (const row of rows) {
    const dest = r.map[row.key];
    if (dest === "drop" || row.key.endsWith("/noise")) continue;
    // A split track's notes are on two channels, its tone and its noise
    // half: together they keep its onsets.
    const noise = r.map[`${row.head}/noise`];
    if (noise) {
      const until = Math.min(midiPlan(before.ir).endTick, midiPlan(after.ir).endTick);
      if (noise === "drop") continue;
      const both = [...notesOf(after.ir, dest, "noise", until, false), ...notesOf(after.ir, noise, "noise", until, false)].sort();
      assert.deepEqual(both, notesOf(before.ir, row.head, "noise", until, false), `${file} → ${to}: ${row.head} on ${dest} and ${noise} keeps its onsets`);
      tracks++;
      continue;
    }
    const kind = TARGETS[from].partOf(row.head).kind;
    // A sample on the ROM rhythm plays its role's ROM sound; a role played
    // on a sample channel, its kit's sample: the names are the roles both ways.
    const until = Math.min(midiPlan(before.ir).endTick, midiPlan(after.ir).endTick);
    // A voice across the FM families is a role's or a waveform's, whose
    // `:key` sounds it in its own register: the onsets are what is kept.
    const twoOp = (t, h) => !!TARGETS[t].partOf(h)?.romNames;
    // (And an FM voice onto a wave or a square is written at its sounding
    // octave: carrierOctave.)
    const keyed = kind !== "noise" && kind !== "sample" && !(kind === "fm" && (TARGETS[to].partOf(dest).kind !== "fm" || twoOp(from, row.head) !== twoOp(to, dest)));
    const was = notesOf(before.ir, row.head, kind, until, keyed);
    const now = notesOf(after.ir, dest, kind, until, keyed);
    // A channel the source machine shared between parts (the PC Engine's
    // wave5, noise5, pcm5) played only one of them where they met: on
    // channels of their own every note sounds — the source's among them.
    const sharedAtSource = rows.some((x) => x.head !== row.head && TARGETS[from].voiceKey(x.head) === TARGETS[from].voiceKey(row.head) && TARGETS[from].partOf(x.head) !== TARGETS[from].partOf(row.head));
    // Sample rows layered on one channel (:prio, the PC Engine's one DDA
    // stream): a lower layer's notes give way to a higher's (language.md §1),
    // so the channel is held to sound, its layers' order by the rules below.
    const layers = kind === "sample" ? rows.filter((x) => x.to === dest) : [];
    if (layers.length > 1) {
      assert.ok(now.length > 0, `${file} → ${to}: ${dest}, ${layers.map((x) => x.head).join(" + ")}'s layers, plays`);
    } else if (sharedAtSource) assert.ok(was.every((x) => now.includes(x)), `${file} → ${to}: ${row.head} on ${dest} keeps every note it played`);
    else assert.deepEqual(now, was, `${file} → ${to}: ${row.head} on ${dest} keeps its notes`);
    tracks++;
  }
  scores++;
  return r;
}

const dir = (d) => readdirSync(join(repo, d)).filter((f) => f.endsWith(".mmlisp")).map((f) => join(repo, d, f));
const files = [...dir("drv/tests"), ...["pc88", "x68k", "msx", "pce", "fc", "gb"].flatMap((t) => dir(`tools/tests/${t}`))];
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
  const file = join(repo, "tools/tests/t.mmlisp");
  const r = portScore(src, to, { rows, imports: readImportSources(file, src) });
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
  assert.ok(r.said.some((s) => /^rhythm3 \(2 notes\) is not converted/.test(s)), "past md's three, the one with the fewest notes dropped and said");
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

// ── Across the FM families and the PSGs (voice-port.js) ──
{
  // presets/waveforms' four as voice-port holds them.
  const set = new Map(parse(readFileSync(join(repo, "presets/waveforms/set.mmlisp"), "utf8"))
    .filter((n) => n.items?.[0]?.value === "def-fm").map((n) => {
      const w = new Map();
      for (let i = 2; i + 1 < n.items.length; i += 2) w.set(canonicalTarget(n.items[i].value), Number(n.items[i + 1].value));
      return [n.items[1].value, w];
    }));
  for (const [name, words] of WAVEFORM_WORDS)
    for (const [w, v] of words) assert.equal(set.get(name)?.get(w), v, `voice-port's ${name} ${w} is presets/waveforms'`);
  for (const name of WAVEFORM_WORDS.keys()) assert.equal(waveformOf(WAVEFORM_WORDS.get(name)), name, `${name} reads as itself`);

  // 4-op onto the FM-PAC: a role its ROM voice, a gm-* its role's, any other
  // voice its waveform's ROM voice; a 4-op def under a ROM name goes.
  const md = `(def-fm lead init-fm :alg 4 :fb 5 :tl1 20 :ml1 2 :tl2 0 :tl3 30 :tl4 0)
(def-fm organ init-fm :alg 7 :tl1 10)
(import "presets/gm/set.mmlisp")
(fm1 lead :len 4 c e :tl1 30 g)
(fm2 organ :len 4 c)
(fm3 gm-piano :len 4 c)`;
  const r = port(md, "msx");
  assert.match(r.text, /\(def-fm lead :fb 5 :tl1 \d+ :ar1 \d+ .*:eg1 \d\n  :ar2 /, "the score's own voice stays, read as two operators");
  assert.match(r.text, /\(fm1 lead :len 4 c e g\)/, "its op words gone");
  assert.match(r.text, /\(fm2 organ /);
  assert.doesNotMatch(r.text, /def-fm organ/, "the 4-op def that hid the ROM's organ goes");
  // The FM-PAC has one user voice for all its channels: the own voice that
  // plays the most notes keeps it; the others play the ROM's, their defs gone.
  const two4 = port(`(def-fm lead init-fm :alg 4 :fb 5 :tl1 20 :ml1 2 :tl2 0 :tl3 30 :tl4 0)
(def-fm bass init-fm :alg 0 :fb 6 :tl1 30 :tl2 20 :tl3 20 :tl4 0)
(def-fm spare init-fm :alg 7)
(fm1 lead :len 8 c d e f g a b > c)
(fm2 bass :len 4 c g)
(fm3 bass :len 4 e)`, "msx");
  assert.match(two4.text, /\(def-fm lead :fb 5 /, "the busier voice is the user voice, as two operators");
  assert.doesNotMatch(two4.text, /def-fm bass/, "the other's def goes");
  assert.match(two4.text, /\(fm2 (?!bass)[\w-]+ :len 4 c g\)/, "the other plays a ROM voice");
  assert.doesNotMatch(two4.text, /def-fm spare/, "a 4-op def no track names cannot play on the OPLL: it goes");
  // The converted score holds what it plays: a def nothing names goes, and
  // then what only it named; one a track plays stays.
  const kept = port(`(def env-a (macro :vel+ [0 -1]))
(def env-b (macro :vel+ [0 -2]))
(def-fm spare init-fm :alg 7)
(def-fm lead init-fm :alg 4 :tl1 20)
(def-fm uses-env lead)
(fm1 lead env-a :len 4 c)`, "x68k");
  assert.doesNotMatch(kept.text, /spare|env-b|uses-env/, `the unnamed go:\n${kept.text}`);
  assert.match(kept.text, /\(def-fm lead /);
  assert.match(kept.text, /\(def env-a /);
  assert.ok(kept.said.some((w) => /taken out: env-b spare uses-env/.test(w)), kept.said.join("\n"));
  assert.doesNotMatch(port("(def-fm spare init-fm :alg 7)\n(fm1 :len 4 c)", "pce").text, /def-fm/, "with no FM it goes");
  assert.ok(two4.said.some((w) => /one user voice: 'lead' \(8 notes\)/.test(w)), "the choice is said");
  // A 4-op voice's modulators and carrier chosen: alg 4's op3 → op4 chain
  // when op4 is the louder carrier; the detune and the other pair said.
  const two = opnAs2op("v", new Map([["FM_ALG", 4], ["FM_TL2", 10], ["FM_TL4", 0], ["FM_TL3", 40], ["FM_TL1", 20], ["FM_ML3", 3], ["FM_DT1", 1], ["FM_SR4", 6], ["FM_RR4", 9]]));
  assert.match(two.text, /:tl1 20 .*:ml1 3 .*\n  :ar2 .*:rr2 3 .*:eg2 0/);
  assert.deepEqual(two.without, ["operators 1, 2", "the detune"]);
  assert.match(r.text, /\(fm3 piano :len 4 c\)/, "gm-piano is the piano");
  // …and back: the ROM voices are presets/fm-roles' under the same names.
  const back = port(r.text, "md");
  assert.match(back.text, /\(import "presets\/fm-roles\/set\.mmlisp"\)/);
  assert.match(back.text, /\(fm2 organ /);
  // The VRC7's own ROM names are their roles on 4-op.
  const vrc7 = port("(def-score :target fc)\n(vrc7-fm1 wurly :len 4 c e)", "md", { "vrc7-fm1": "fm1" });
  assert.match(vrc7.text, /\(fm1 piano :len 4 c e\)/);
  // An FM-PAC user voice onto 4-op: the same voice, read as 4-op.
  const user = port("(def-score :target msx)\n(def-fm reed :fb 3 :tl1 30 :ar1 15 :ml1 2 :ar2 12 :eg2 1 :ws1 1)\n(fm1 reed :len 4 c)", "x68k");
  assert.match(user.text, /\(def-fm reed :alg 4 :fb 3\n\s+:ar1 30 /);
  assert.match(user.text, /:tl3 127 .*\n.*:tl4 127/s);
  assert.ok(user.said.some((x) => /'reed' plays without :ws/.test(x)), "the rectified sine said");
}
{
  // The noise by Hz: md's white1 (6991 Hz) on the 2A03 is the pitch nearest
  // it, and back the mode nearest the pitch's rate.
  const fc = port("(noise :len 8 :mode white1 c c :mode periodic0 c)", "fc");
  assert.match(fc.text, /\(noise :len 8 :mode white :oct \d [a-g]\+? [a-g]\+? :mode periodic :oct \d [a-g]\+?\)/);
  const md = port(fc.text, "md");
  assert.match(md.text, /\(noise :len 8 :mode white1 [a-g]\+? [a-g]\+? :mode periodic0 [a-g]\+?\)/, "and back: the same modes (the SN76489's noise has no pitch)");
  assert.equal(md.text.match(/^; Converted from/gm).length, 1, "a second conversion's line replaces the first's");
  // The SSG's rate on the Game Boy, its pitch.
  const gb = port("(def-score :target pc88)\n(noise :noise-rate 4 :len 8 c c)", "gb");
  assert.match(gb.text, /\(noise :len 8 :mode white :oct \d [a-g]\+? [a-g]\+?\)/);
}
{
  // The FM-PAC's vibrato and tremolo on 4-op: the channel's :fms / :ams, the
  // song's LFO on once.
  const r = port("(def-score :target msx)\n(def-fm reed :fb 3 :tl1 30 :ar1 15 :ar2 12 :eg2 1 :vib2 1 :am2 1)\n(fm1 reed :len 4 c :vib1 0 d (macro :vib2 [1 0]) e)", "md");
  assert.match(r.text, /\(def-fm reed :alg 4 :fb 3 :ams 2 :fms 4\n/);
  assert.match(r.text, /\(fm1 :lfo-rate 4 reed :len 4 c :fms 0 d \(macro :fms \[4 0\]\) e\)/);
}
{
  // An SSG square's noise notes (a PSG drum) onto a machine whose squares
  // have no noise: the noise's row, the tone notes rests there; the tempo
  // with the tone half. On the PC-8801's SSG it stays as written.
  const src = "(def-score :target msx)\n(sqr2 :tempo 140 :noise-rate 8 :len 8 :mode tone c :mode noise c c :mode both c :mode tone e)";
  const md = port(src, "md");
  assert.match(md.text, /\(sqr2 :tempo 140 :len 8 c _ _ _ e\)\n\(noise :mode white0 :len 8 _ c c c _\)/);
  const gb = port(src, "gb", { sqr2: "drop" });
  assert.match(gb.text, /\(noise :tempo 140 :len 8 _ :mode white :oct \d [a-g]\+? [a-g]\+? [a-g]\+? _\)/, "the tone half dropped: the tempo with the noise");
  assert.equal(portRows(src, "pc88").rows.length, 1, "pc88's SSG plays its modes");
}
{
  // A machine short of channels keeps the parts with the most notes.
  const r = port("(fm1 :len 8 c d e f g a b c)\n(fm2 :len 2 c c)\n(sqr1 :len 4 c e g e)\n(sqr2 :len 1 c)", "gb");
  // (gb's three: its two pulses to the squares, their own kind, its wave to
  // the busier FM row.)
  assert.deepEqual([r.map.fm1, r.map.fm2, r.map.sqr1, r.map.sqr2], ["wave", "drop", "sqr1", "sqr2"]);
}

// ── What a review found (2026-11-08) ──
{
  // A dropped track's opening tempo goes onto the first track kept.
  const r = port("(fm1 :tempo 90 :len 2 c e g e |)\n(fm2 :len 8 c e g e c e g e |)\n(fm4 :len 8 c e g e c e g e |)\n(sqr1 :len 8 c e g e c e g e |)", "gb");
  assert.equal(r.map.fm1, "drop");
  assert.match(r.text, /\((wave|sqr\d) :tempo 90 /);
  // FM3's tracks are one channel on pc88: nothing past room is dropped.
  const fm3 = "(fm3 init-fm)\n(fm3-1 :len 4 c)\n(fm3-2 :len 4 c)\n(fm3-3 :len 4 c)\n(fm3-4 :len 4 c)\n(fm1 c)\n(fm2 c)\n(fm4 c)\n(fm5 c)\n(fm6 c)\n(sqr1 c)\n(sqr2 c)\n(sqr3 c)";
  assert.ok(portRows(fm3, "pc88").rows.every((x) => x.to !== "drop"), "md's FM3 onto pc88: every row kept");
  // The FM-PAC's rhythm takes fm7-9: with a kit row, they are not offered by default.
  const kit = port('(def-score :target x68k)\n(import "presets/rx5/set.mmlisp")\n(fm1 c)\n(fm2 c)\n(fm3 c)\n(fm4 c)\n(fm5 c)\n(fm6 c)\n(fm7 c)\n(fm8 c)\n(pcm1 :len 4 kick c snare c)', "msx");
  assert.equal(kit.map.pcm1, "rhythm1");
  assert.ok(![kit.map.fm7, kit.map.fm8].some((h) => /^fm[789]$/.test(h)));
  // Between two pitched noises the rate goes by Hz, not by the note.
  assert.doesNotMatch(port("(def-score :target fc)\n(noise :oct 3 c c)", "gb").text, /\(noise :oct 3 c c\)/);
  // A layer's forms append: the noise's octave and a split's mode go on.
  assert.match(port("(def-score :target fc)\n(noise :oct 2 c c)\n(noise c c |)", "md").text, /\(noise :mode white2 c c \|\)/);
  assert.match(port("(def-score :target x68k)\n(fm8 :len 8 c :mode noise c)\n(fm8 c c :mode tone c |)", "md").text, /\(noise c c _ \|\)/);
  // A loop that moves the octave ends its passes' moves on; :oct+ moves it.
  assert.match(port("(noise :mode white0 c :oct+ 1 c)", "fc").text, /\(noise :mode white :oct \d [a-g]\+? [a-g]\+?\)/, ":oct+ read, not left");
  // A pruned voice's base goes too when nothing else names it.
  const prune = port('(import "presets/fm-roles/set.mmlisp")\n(def-fm mid piano :tl1 3)\n(def-fm lead mid :tl2 4)\n(fm1 lead :len 4 c e)', "fc");
  assert.doesNotMatch(prune.text, /def-fm (mid|lead)/);
}

// ── The wave memories (wave-port.js) ──
{
  // presets/wavetable's plain shapes read as themselves.
  const file = join(repo, "tools/tests/t.mmlisp");
  const shapes = ["sine", "triangle", "saw", "square", "pulse25", "pulse12"];
  const src = `(def-score :target pce)\n(import "presets/wavetable/set.mmlisp")\n${shapes.map((n) => `(wave1 ${n} c)`).join("\n")}`;
  for (const w of compileMMLisp(src, file, { imports: readImportSources(file, src) }).ir.metadata.waves)
    if (shapes.includes(w.name)) assert.equal(shapeOf(w.data), w.name, `presets/wavetable's ${w.name} reads as itself`);
  // A wave onto FM: its shape's voice; onto a pulse its width.
  const scc = readFileSync(join(repo, "tools/tests/msx/scc.mmlisp"), "utf8");
  assert.match(port(scc, "md").text, /\(fm1 :tempo 132 wave-saw /);
  assert.match(port(scc, "fc", { wave1: "tri", wave2: "sqr2" }).text, /\(sqr2 :duty 4 /, "the SCC's pulse a 25 % pulse");
  // A voice onto a wave channel: a role's wave and its macro; any other its
  // waveform's wave under its carrier's envelope; a square presets/wavetable's.
  const fm = port('(import "presets/gm/set.mmlisp")\n(def-fm pad init-fm :alg 7 :tl1 127 :tl2 127 :tl3 127 :ar4 12 :rr4 3)\n(fm1 gm-piano :len 4 c)\n(fm2 pad :len 2 c)\n(sqr1 :duty 2 :len 4 c)', "pce");
  assert.match(fm.text, /\(import "presets\/wavetable\/set\.mmlisp"\)/);
  assert.match(fm.text, /\(wave1 wave-piano :len 4 c\)/);
  assert.match(fm.text, /\(def pad-env \(macro :vel\+ \[-15 .*#sus 0 #rel/);
  assert.match(fm.text, /\(wave2 sine pad-env :len 2 c\)/);
  // The key scaling: a slow attack at KS 3 is quick on a high note (as the
  // chip plays it), the same at KS 0 is not.
  const slow = (ks) => new Map([["FM_ALG", 7], ["FM_AR4", 4], ["FM_KS4", ks], ["FM_TL1", 127], ["FM_TL2", 127], ["FM_TL3", 127]]);
  const firstLoud = (v) => { let f = 0; for (const m of v.matchAll(/(-?\d+)(?: \(wait (\d+)f\))?/g)) { if (Number(m[1]) > -4) return f; f += Number(m[2] ?? 1); } return Infinity; };
  assert.ok(firstLoud(envelopeOf(slow(3), 84)) < 10, `KS 3 at c6: ${envelopeOf(slow(3), 84).slice(0, 60)}`);
  assert.ok(firstLoud(envelopeOf(slow(0), 84)) > 30, `KS 0 at c6: ${envelopeOf(slow(0), 84).slice(0, 60)}`);
  // (a square, and the SSG-less md square's :duty there is pce's no-duty pulse)
  // The PC Engine's drivers stream samples on one channel: a score's drum
  // rows are :prio layers on it, the kick and snare over the hats, each
  // hit its own sample; the wave channels stay the melody's.
  const drums = port(`(def-score :target pc88)
(import "presets/rx5/set.mmlisp")
(fm1 :len 8 c d e f g a b > c)
(fm2 :len 4 c g)
(fm3 :len 4 e g)
(fm4 :len 4 g b)
(fm5 :len 4 b d)
(rhythm4 hat (x 8 :len 16 c c))
(rhythm1 kick :len 4 c _ c _)
(rhythm2 snare :len 4 _ c _ c)`, "pce");
  const heads = [...drums.text.matchAll(/^\((pcm\d) :prio (\d) (?:[^\n]*?)(hat|kick|snare)/gm)].map((m) => [m[1], m[3], Number(m[2])]);
  assert.equal(new Set(heads.map(([h]) => h)).size, 1, `one sample channel:\n${drums.text}`);
  const rank = Object.fromEntries(heads.map(([, d, p]) => [d, p]));
  assert.ok(rank.kick < rank.snare && rank.snare < rank.hat, `kick, snare, hat in that order: ${JSON.stringify(rank)}`);
  assert.equal(drums.text.match(/^\(wave\d/gm).length, 5, "five waves for the five FM parts");
  const dda = compile(drums.text, join(repo, "tools/tests/t.mmlisp")).ir.tracks.find((t) => /^pcm/.test(t.channel));
  assert.deepEqual([...new Set(dda.events.filter((e) => e.cmd === "PCM_NOTE_ON").map((e) => e.args.sample))].sort(), ["hat", "kick", "snare"], "each hit plays its own sample");
  assert.ok(drums.said.some((w) => /share pcm\d as :prio layers \(the PC Engine's drivers stream samples on one channel\)/.test(w)));
  // A channel has one loop: rows looping over other ticks cannot be its
  // layers — the group playing the most notes keeps it (the loops read at
  // the ticks they play, a counted loop written out), the other is said.
  const loops = port(`(def-score :target pc88)
(import "presets/rx5/set.mmlisp")
(fm1 :len 4 c e g c)
(rhythm1 kick #loop (x 4 :len 4 c c c c) (go loop))
(rhythm4 hat #loop (x 16 :len 16 c c c c) (go loop))
(pcm1 kick :len 4 _ #loop c c c (go loop))`, "pce");
  assert.equal((loops.text.match(/^\(pcm\d :prio/gm) ?? []).length, 2, `the two that loop alike layer:\n${loops.text}`);
  assert.doesNotMatch(loops.text, /\(pcm\d (?::prio \d+ )?(?::gate 1t )?kick :len 4 _/, "the one looping over other ticks goes");
  assert.ok(loops.said.some((w) => /pcm1 \(\d+ notes\) is not converted: .*a channel has one loop, and pcm1 loops over other ticks than rhythm1, rhythm4/.test(w)), loops.said.join("\n"));
  // The FDS's modulation is the PC Engine's LFO: wave2 at :vol 0, wave1 its :fms.
  const fds = port(readFileSync(join(repo, "tools/tests/fc/fds.mmlisp"), "utf8"), "pce");
  assert.equal(fds.map["fds-wave"], "wave1");
  assert.match(fds.text, /\(wave2 fds-lfo :lfo-freq \d+ :vol 0 :oct \d [a-g]\+?0\)/);
  assert.match(fds.text, /\(wave1 tri :lfo-freq \d+ .*:fms \d/);
  // …and the PC Engine's LFO the FDS's: wave2's triangle a table summing to it.
  const pce = port("(def-score :target pce)\n(def-wave tri :wave (triangle -128..127))\n(def-wave lead :wave (saw -128..127))\n(wave2 tri :vol 0 :oct 5 :len 1 c ~ c)\n(wave1 lead :lfo-freq 200 :fms 2 :len 4 c e g e)", "fc", { wave1: "fds-wave" });
  assert.match(pce.text, /\(fds-wave :lfo-wave \[(2 ){8}(-2 ){16}(2 ){7}2\] lead :lfo-freq \d+ :lfo-pmd \d+ /);
  // The FDS's 64 steps onto a 32-step chip: written at the 32 it plays.
  const w64 = port(readFileSync(join(repo, "tools/tests/fc/fds.mmlisp"), "utf8"), "msx", { "fds-wave": "wave1" });
  assert.match(w64.text, /\(def-wave sine64 :wave \[(-?\d+ ){31}-?\d+\]\)/);
}

// ── What a review of the wave memories found (2026-11-08) ──
{
  // presets/wavetable's role macro off a wave channel is its role: a voice, a square.
  const pce = '(def-score :target pce)\n(import "presets/wavetable/set.mmlisp")\n(wave3 wave-piano :len 4 g g g g)';
  assert.match(port(pce, "md").text, /\(fm\d piano :len 4 g g g g\)/);
  port(pce, "fc");
  // …and the converter's own: md's piano onto pce and back.
  port(port("(fm1 piano :len 4 c e)", "pce").text, "md");
  // The FDS's depth written on another track still sways wave1; the LFO's
  // rate rides on wave2, whichever track is dropped.
  const fds = "(def-score :target fc)\n(def vib [1 1 1 1 1 1 1 1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 1 1 1 1 1 1 1 1])\n(sqr1 :lfo-wave vib :lfo-freq 20 :lfo-pmd 8 :len 4 c c)\n(fds-wave :len 4 c e g e)";
  const r = port(fds, "pce", { sqr1: "drop" });
  assert.match(r.text, /\(wave1 :fms \d/);
  assert.match(r.text, /\(wave2 fds-lfo :lfo-freq \d+ /);
  assert.doesNotMatch(r.text, /\(def vib/);
  assert.ok(!portRows(fds, "pce").rows.find((x) => x.key === "sqr1").choices.includes("wave2"), "wave2 is the LFO: no row's");
  // A voice after a role's macro clears its waves.
  assert.match(port("(def-fm lead init-fm :alg 4 :tl1 20)\n(fm1 piano :len 4 c c lead c c)", "pce").text, /wave-piano :len 4 c c \(macro :wave none\) \w+ lead-env c c/);
  // The 2A03's triangle a triangle on a wave channel; a 75 % duty the 25 % pulse.
  assert.match(port("(def-score :target fc)\n(tri :len 4 c e)\n(sqr1 :duty 12 :len 4 c)", "pce").text, /\(wave\d triangle :len 4 c e\)[\s\S]*\(wave\d square pulse25 /);
  // A quiet saw reads as a saw; a silent wave is no pulse.
  assert.equal(shapeOf(Array.from({ length: 32 }, (_, i) => Math.round(-8 + i / 2))), "saw");
  assert.equal(shapeOf(Array(32).fill(0)), "sine");
  // Two kinds on one of pce's channels: said as one channel.
  assert.match(portScore("(fm1 c)\n(noise c)", "pce", { rows: { fm1: "wave5", noise: "noise5" } }).error, /fm1 \(to wave5\) and noise \(to noise5\) are one channel/);
}

// ── The remaining three (2026-11-08) ──
{
  // A track's own :wave (expr) off a wave channel: the wave it folds to, read.
  const src = "(def-score :target msx)\n(def-wave saw :wave (saw -128..127))\n(wave1 :wave (* saw 0.5) :len 4 c)";
  assert.match(port(src, "md").text, /\(fm1 wave-saw :len 4 c\)/);
  // The SCC's wave5 shares wave4's memory: taken last, and said when made to.
  const pce = readFileSync(join(repo, "tools/tests/pce/wave.mmlisp"), "utf8");
  assert.notEqual(portRows(pce, "msx").rows.find((x) => x.key === "wave5").to, "wave5");
  assert.ok(port(pce, "msx", { wave6: "wave5" }).said.some((x) => /share one wave memory/.test(x)));
  // A loop that moves the noise's octave, or a split's :mode, written out pass by pass.
  assert.match(port("(def-score :target fc)\n(noise :oct 2 (x 2 c d >) c)", "md").text, /\(noise :mode white2 c d > :mode white0 c d > c\)/);
  // A macro's #sus / #rel in the loop are no labels: it is written out too.
  assert.match(port("(def-score :target fc)\n(noise :oct 2 (x 2 (macro :vel [15 #sus 12 #rel 0]) c >) c)", "md").text, /\(noise \(macro :vel \[15 #sus 12 #rel 0\]\) :mode white2 c > \(macro/);
  // A (macro :wave …) off a wave channel with nothing else goes, and the waves only it named.
  const mac = port("(def-score :target msx)\n(def-wave saw :wave (saw -128..127))\n(wave1 (macro :wave [saw saw]) :len 4 c)", "fc").text;
  assert.doesNotMatch(mac, /\(macro\)|def-wave saw/);
  const split = port("(def-score :target x68k)\n(fm8 :len 8 (x 2 c :mode noise c) c)", "md").text;
  assert.match(split, /\(noise :len 8 _ c c c c\)/);
}

{
  // A loop that ends in the state its first noise note plays in writes it once.
  assert.match(port("(def-score :target fc)\n(noise :oct 2 (x 3 c c) d)", "md").text, /\(noise \(x 3 :mode white2 c c\) d\)/);
  // …one that does not writes it at its start, so each pass plays as it should.
  assert.match(port("(def-score :target fc)\n(noise :oct 2 c (x 2 c :oct 4 c :oct 2) c)", "md").text, /\(x 2 :mode white2 c :mode white0 c\) :mode white2 c\)/);
  // A def left empty goes, with every place it is named.
  const sec = port("(def chorus (fm7 c))\n(def-score :target x68k)\n(fm1 c chorus)\nchorus", "gb", { fm7: "drop" });
  assert.doesNotMatch(sec.text, /chorus/);
  const snip = port("(def-score :target msx)\n(def-wave saw :wave (saw -128..127))\n(def half :wave (* saw 0.5))\n(wave1 half :len 4 c)", "md");
  assert.doesNotMatch(snip.text, /half/);
}

// ── Every import onto every machine (2026-11-08) ──
{
  // mucom88: pc88 and md its own writers, any other machine the pc88 score converted.
  const muc = new TextEncoder().encode("#title test song\n\nA t120 o4 l8 cdefgab>c\nB o3 l4 c g c g\nD o5 l8 v13 eg>c<g eg>c<g\nE l16 P2 w5 v12 c c c c c c c c\nG l8 v15 @1c @8c @2c @8c\n");
  for (const target of MUCOM_TARGETS) {
    const r = importMucom(muc, null, null, { target });
    assert.deepEqual(compile(r.source, join(repo, "tools/tests/t.mmlisp")).bad, [], `mucom88 onto ${target} compiles clean`);
  }
  assert.deepEqual(MUCOM_TARGETS.slice().sort(), PORT_TARGETS.slice().sort(), "mucom88 offers every machine");
  // A VGM of each machine offers every machine, each written clean.
  for (const sf of ["drv/tests/ab-core.mmlisp", "tools/tests/x68k/fm.mmlisp", "tools/tests/msx/scc.mmlisp", "tools/tests/gb/apu.mmlisp"]) {
    const file = join(repo, sf);
    const vgm = renderVgm(new IRPlayer(() => {}).loadJSON(compile(readFileSync(file, "utf8"), file).ir), { title: "t" }).bytes;
    const parsed = await parseVgm(vgm);
    const a = analyzeVgm(parsed);
    assert.deepEqual(a.targets.slice().sort(), PORT_TARGETS.slice().sort(), `${sf}'s VGM offers every machine`);
    for (const t of a.targets) {
      const out = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, t), target: t, structure: true, fileName: "t.vgm" }, a);
      assert.deepEqual(compile(out.source, join(repo, "tools/tests/t.mmlisp")).bad, [], `${sf}'s VGM onto ${t} compiles clean`);
    }
  }
}

// ── A review of the whole area (2026-11-08) ──
{
  // A split's tone half keeps the layer's :mode across forms when its noise half is dropped.
  assert.match(port("(def-score :target msx)\n(sqr1 :len 8 :mode tone c d :mode noise c c)\n(sqr1 e f :mode tone g a)", "md", { "sqr1/noise": "drop" }).text, /\(sqr1 _ _ g a\)/);
  // A snippet's :mode the machine's squares have not goes.
  assert.match(port("(def-score :target pc88)\n(def drum :mode noise c c :mode tone)\n(sqr1 :len 8 drum c)", "md").text, /\(def drum c c\)/);
  // A sample track not all kit roles is not offered a ROM rhythm channel.
  assert.ok(portScore('(import "presets/rx5/set.mmlisp")\n(def-pcm mys :file "blip.wav")\n(pcm1 kick mys :len 8 c c)', "pc88", { rows: { pcm1: "rhythm1" } }).error);
  // A role's wave macro cleared at a voice in a later form.
  assert.match(port("(def-fm lead init-fm :alg 4 :tl1 20)\n(fm1 piano :len 4 c d)\n(fm1 lead e f)", "gb").text, /\(wave \(macro :wave none\) \w+ lead-env e f\)/);
  // The log calls :lfo-freq the rate, and a machine with no LFO so.
  assert.ok(port("(def-score :target x68k)\n(fm1 :lfo-freq 100 :len 4 c)", "gb").said.some((x) => /:lfo-freq: the Game Boy has no LFO/.test(x)));
}

// ── FM kept on FM; a voice's sounding octave on a wave or square (2026-11-08) ──
{
  // Short of channels, a row of the machine's own kind keeps its channel
  // before a stand-in, whatever their notes: md's 6 FM + 3 squares onto
  // x68k's 8 FM drop a square, not the quietest FM.
  const r = portRows("(fm1 c)\n(fm2 c)\n(fm3 c)\n(fm4 c)\n(fm5 c)\n(fm6 c)\n(sqr1 :len 8 c c c c c c c c)\n(sqr2 :len 8 c c c c c c c c)\n(sqr3 :len 8 c c c c c c c c)", "x68k").rows;
  assert.ok(r.filter((x) => /^fm/.test(x.key)).every((x) => /^fm/.test(x.to)), "every FM row on FM");
  assert.equal(r.filter((x) => x.to === "drop").length, 1);
  assert.match(r.find((x) => x.to === "drop").key, /^sqr/);
  // A voice whose carrier is at :ml 2 sounds an octave up: on a wave or a
  // square its track is written an octave up, its :oct writes and glides too.
  const bass = "(def-fm bass init-fm :alg 4 :tl1 30 :ml1 4 :tl2 0 :ml2 2 :tl3 127 :tl4 127)\n(def-fm lead init-fm :alg 7 :tl1 127 :tl2 127 :tl3 127 :tl4 0)\n(fm1 bass :oct 2 :len 4 c (glide c2 8) e :oct 3 g lead :oct 4 c)";
  assert.match(port(bass, "pce").text, /\(wave1 \w+ bass-env :oct\+ 1 :oct 3 :len 4 c \(glide c3 8\) e :oct 4 g \w+ lead-env :oct\+ -1 :oct 4 c\)/);
  assert.match(port(bass, "gb", { fm1: "sqr1" }).text, /\(sqr1 :oct\+ 1 :oct 3 :len 4 c \(glide c3 8\) e :oct 4 g :oct\+ -1 :oct 4 c\)/);
  assert.equal(carrierOctave(new Map([["FM_ALG", 7], ["FM_ML4", 3]])), 0, "a 12th is no octave");
}

// ── mucom88's FM3 operator mode (2026-11-08) ──
{
  // The voice written on fm3-1's forms is the four operators' patch: each
  // operator's channel takes it, at a later form's voice change too.
  const src = "(def-score :target pc88)\n(def-fm va init-fm :alg 4 :tl1 20)\n(def-fm vb init-fm :alg 7 :tl1 10)\n(fm3-1 va :oct 5 :len 4 c c)\n(fm3-2 :oct 4 :len 4 e e)\n(fm3-1 vb :len 4 g g)\n(fm3-2 :len 4 b b)";
  const r = port(src, "x68k");
  assert.match(r.text, /\(fm3 va-op1 :oct 5 :len 4 c c\)\n\(fm\d va-op2 :oct 4 :len 4 e e\)\n\(fm3 vb-op1 :len 4 g g\)\n\(fm\d vb-op2 :len 4 b b\)/);
  // A part commented out by the mucom88 md writer is commented on every line.
  const muc = new TextEncoder().encode("#title j\n\nA t120 o4 l8 cdef\nG l8 v15 @1c @8c @2c @8c\nJ o4 l8 [cdef]4 [gab>c<]4 [cdef]4 [gab>c<]4 [cdef]4 [gab>c<]4 [cdef]4 [gab>c<]4 [cdef]4\n");
  const j = importMucom(muc, null, null, { target: "md" });
  assert.ok(j.warnings.some((w) => /part J \(fm6\) is commented out/.test(w)));
  assert.deepEqual(compile(j.source, join(repo, "tools/tests/t.mmlisp")).bad, [], "mucom88 onto md with part J commented out compiles clean");
}

console.log(`check:score-port ok — ${scores} conversions compile clean with ${tracks} tracks' notes kept, an MDX onto md and pc88, the rules`);
