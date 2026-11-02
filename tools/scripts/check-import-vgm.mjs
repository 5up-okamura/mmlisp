#!/usr/bin/env node
// The VGM importer on files the toolchain writes itself (File > Export > VGM
// of a test score): what it reads comes back where it should, and every
// score it writes compiles clean for its target.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderVgm } from "../../live/src/export-vgm.js";
import { parseVgm, analyzeVgm, decodeOki, decodeK053260, decodeC140, defaultVgmOptions, vgmToMmlisp } from "../../live/src/import-vgm.js";
import { assignBends } from "../../live/src/import-song.js";
import { readImportSources, compileScoreFile } from "../../drv/tools/mmb-build.mjs";
import { bakedChipSamples } from "../../drv/tools/wav.mjs";
import { targetProfile } from "../../live/src/targets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function vgmOf(file) {
  const { ir } = compileMMLisp(fs.readFileSync(path.join(ROOT, file), "utf8"), { fileName: file });
  const v = renderVgm(new IRPlayer(() => {}).loadJSON(ir), {});
  return parseVgm(new Uint8Array(v.bytes ?? v));
}
// A pc88 score with its ADPCM-B samples baked into the RAM image, as
// File > Export > VGM writes it (check-snapshot.mjs).
async function vgmOfAdpcm(file) {
  const { ir } = compileScoreFile(path.join(ROOT, file), {});
  const { adpcm } = bakedChipSamples(ir, targetProfile("pc88"));
  const v = renderVgm(new IRPlayer(() => {}).loadJSON(ir), {}, { adpcm });
  return parseVgm(new Uint8Array(v.bytes ?? v));
}
function imported(parsed, target, structure = true) {
  const a = analyzeVgm(parsed);
  const { source } = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, target), structure, fileName: "t.vgm" }, a);
  // Compiled as Live compiles an import: a stand-in voice's presets read from the repo.
  const bad = compileMMLisp(source, "t.mmlisp", { imports: readImportSources("t.mmlisp", source) }).diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(bad.map((d) => d.code), [], `${target}: the imported score compiles clean`);
  return { a, source };
}

// The YM2151's noise: fm8 with NE on, the voice whole. On x68k it comes back
// as fm8's :mode noise (FM8 on fm8, the noise channel dropped), its period
// as :noise-rate; on md the noise goes to `noise` and FM8 keeps its tone.
{
  const parsed = await vgmOf("tools/tests/x68k/fm8-noise.mmlisp");
  const { a } = imported(parsed, "x68k");
  const opt = defaultVgmOptions(a, "x68k");
  assert.equal(opt.dest["YM2151 FM8"], "fm8");
  assert.equal(opt.dest["YM2151 noise"], "drop");
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "x68k", structure);
    assert.match(source, /\(fm8[\s\S]*:mode noise :noise-rate 17[\s\S]*:noise-rate 4[\s\S]*:mode tone/, "x68k: fm8's noise, its rates, back to tone");
  }
  const md = imported(parsed, "md").source;
  assert.match(md, /\(noise /, "md: the noise on noise");
  assert.ok(!/:mode tone|:mode noise/.test(md.replace(/\(noise[\s\S]*?\n\)/, "")), "md: no fm :mode");
}

// The SSG's hardware envelope, read back on the machine of its chip. A saw
// buzzer comes back as :mode env with its rate following the notes, a fixed
// rate as Hz on the shapes the channels share, and a channel off the
// envelope as :env none; the AY-3-8910's file is the MSX's by default, and
// on md the envelope is said lost.
{
  const parsed = await vgmOf("tools/tests/msx/env.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["msx", ["msx", "md"]]);
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "msx", structure);
    assert.match(source, /\(sqr1[\s\S]*:mode env[\s\S]*:env 8[\s\S]*:env-rate note/, "msx: the buzzer, its rate the notes'");
    assert.match(source, /\(sqr2[\s\S]*:env 0[\s\S]*:env-rate 19\.9\d[\s\S]*:env none/, "msx: a fixed rate, then the channel's own level");
  }
  const md = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, "md"), fileName: "t.vgm" }, a);
  assert.ok(!/:env/.test(md.source), "md: no :env");
  assert.ok(md.warnings.some((w) => /hardware envelope/.test(w)), "md: the envelope said lost");
}

// The SSG's mixer: a YM2608's file is the PC-8801's by default; there a
// channel's noise stays on its own track (:mode noise, the song's
// :noise-rate) and the shared noise row is not offered; on md that row
// takes the noise and the channel that only played it is dropped.
{
  const parsed = await vgmOf("tools/tests/pc88/ssg.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["pc88", ["pc88", "md"]]);
  const opt = defaultVgmOptions(a, "pc88");
  assert.ok(!("YM2608 SSG noise" in opt.dest), "pc88: no noise row");
  const { source } = imported(parsed, "pc88");
  assert.match(source, /\(sqr2[\s\S]*:mode both[\s\S]*:noise-rate \d/, "pc88: tone and noise, the period");
  assert.match(source, /\(sqr3[\s\S]*:mode noise[\s\S]*:noise-rate 6/, "pc88: the noise on its channel");
  const mdOpt = defaultVgmOptions(a, "md");
  assert.equal(mdOpt.dest["YM2608 SSG noise"], "noise");
  assert.equal(mdOpt.dest["YM2608 SSGC"], "drop");
  assert.match(imported(parsed, "md").source, /\(noise /, "md: the noise on noise");
}

// A wavetable chip: each distinct wave a def-wave the track names where it
// changes. The HuC6280's file is the PC Engine's by default: each channel on
// its own wave channel, a channel on its noise a row of its own on noise5 /
// noise6 at the rate it played (the original's $07 writes again), its pan as
// a place between the sides; on md the waves are stand-ins and the noise
// goes to noise.
const writesOf = (source, addr) => {
  const { ir } = compileMMLisp(source, "t.mmlisp");
  let sel = -1;
  const out = new Set();
  for (const w of new IRPlayer(() => {}).loadJSON(ir).captureRegisterLog().writes) {
    if (w.addr === 0) sel = w.data;
    else if (w.addr === addr && (addr !== 7 || w.data & 0x80)) out.add(`${sel}:${w.data}`);
  }
  return [...out].sort().join(" ");
};
{
  const parsed = await vgmOf("tools/tests/pce/wave.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["pce", ["pce", "md"]]);
  assert.equal(defaultVgmOptions(a, "pce").dest["HuC6280 CH3"], "wave3", "pce: a channel keeps its number");
  const { source } = imported(parsed, "pce");
  assert.match(source, /\(def-wave wave-01 :wave \[-128 -120 /, "pce: the saw, at the chip's 5 bits");
  assert.match(source, /\(wave1[\s\S]*wave-0\d[\s\S]*wave-0\d/, "pce: wave1 switches its wave");
  imported(parsed, "md");
}
{
  const src = fs.readFileSync(path.join(ROOT, "tools/tests/pce/noise.mmlisp"), "utf8");
  const parsed = await vgmOf("tools/tests/pce/noise.mmlisp");
  const a = analyzeVgm(parsed);
  const opt = defaultVgmOptions(a, "pce");
  assert.equal(opt.dest["HuC6280 CH5 noise"], "noise5");
  assert.equal(opt.dest["HuC6280 CH6 noise"], "noise6");
  const { source } = imported(parsed, "pce", false);
  assert.equal(writesOf(source, 7), writesOf(src, 7), "pce: the noise at the rates it played");
  // (CH5's seven notes against CH6's four.)
  assert.equal(defaultVgmOptions(a, "md").dest["HuC6280 CH5 noise"], "noise", "md: the busier noise on noise");
  imported(parsed, "md");
}
{
  const src = fs.readFileSync(path.join(ROOT, "tools/tests/pce/pan.mmlisp"), "utf8");
  const parsed = await vgmOf("tools/tests/pce/pan.mmlisp");
  const { source } = imported(parsed, "pce", false);
  assert.match(source, /\(wave2 wave-01 :pan -1 /, "pce: a hard pan");
  assert.match(source, /:pan 0\.53/, "pce: 0.5 as the levels hold it (7 of 15)");
  // A pan written with a note comes back with it (noise5's −0.3: its right
  // side 10 of 15); one moving under a note (a sweep, a macro) does not.
  for (const pan of ["0:127", "1:240", "4:15", "4:250"]) assert.ok(writesOf(source, 5).split(" ").includes(pan), `pce: the pan ${pan}`);
}
// The SCC: an msx score's wave channels come back as msx's.
{
  const parsed = await vgmOf("tools/tests/msx/scc.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["msx", ["msx", "md"]]);
  const opt = defaultVgmOptions(a, "msx");
  for (let c = 1; c <= 5; c++) assert.equal(opt.dest[`K051649 CH${c}`], `wave${c}`);
  const { source } = imported(parsed, "msx");
  assert.match(source, /\(def-wave wave-01 :wave \[-128 -120 -112 -104 /, "msx: the saw at the SCC's 8 bits");
  imported(parsed, "md");
}

// The YM2608's rhythm: on pc88 each ROM sound keyed comes back on its own
// rhythm track under its kit role, its pan the hit's; on md the sounds are
// the RX5 kit's on pcm1, :prio layers as the mucom importer plays part G.
{
  const parsed = await vgmOf("tools/tests/pc88/rhythm.mmlisp");
  const a = analyzeVgm(parsed);
  assert.equal(a.target, "pc88");
  const opt = defaultVgmOptions(a, "pc88");
  assert.equal(opt.dest["YM2608 rhythm BD"], "rhythm1");
  assert.equal(opt.dest["YM2608 rhythm RIM"], "rhythm6");
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "pc88", structure);
    for (const [ch, role] of [["rhythm1", "kick"], ["rhythm2", "snare"], ["rhythm4", "hat"], ["rhythm5", "tom4"], ["rhythm6", "rim"]])
      assert.match(source, new RegExp(`\\(${ch} [^(]*\\b${role}\\b`), `pc88: ${role} on ${ch}`);
    assert.match(source, /\(rhythm6 (?:(?!\n\()[\s\S])*:pan right/, "pc88: the rim's pan, the one hit panned");
    assert.doesNotMatch(source, /\(rhythm2 (?:(?!\n\()[\s\S])*:pan/, "pc88: the snare centred, as it played");
  }
  const md = imported(parsed, "md").source;
  assert.equal(defaultVgmOptions(a, "md").dest["YM2608 rhythm SD"], "pcm1");
  assert.match(md, /\(import "presets\/rx5\/set\.mmlisp"\)/, "md: the kit");
  assert.match(md, /\(pcm1 :prio 1 [^(]*snare :gate \d+t/, "md: the snare's layer, its ring");
  // On msx the FM-PAC's rhythm plays the sounds it has (no rim). Where the
  // PCM is not the DAC's mix there is no kit to fall back on.
  const msx = defaultVgmOptions(a, "msx");
  assert.deepEqual([msx.dest["YM2608 rhythm SD"], msx.dest["YM2608 rhythm RIM"]], ["rhythm2", "drop"], "msx: the FM-PAC's rhythm");
  assert.match(imported(parsed, "msx").source, /\(rhythm2 [^(]*\bsnare\b/, "msx: the snare on rhythm2");
  assert.equal(defaultVgmOptions(a, "pce").dest["YM2608 rhythm SD"], "drop", "pce: the rhythm has no channel");
  imported(parsed, "pce");
}

// The 2A03: its pulses keep their numbers on fc with their :duty, the
// triangle goes to tri with no :vel (it has none), the noise's notes are
// its rates with :mode white / periodic; on md the triangle is fm1's (a
// triangle wave, below the SN76489's floor too) and the noise's modes read
// as the nearest white / periodic. The DMC: a hit's
// sample is the memory as it stood at the hit (a 0xC2 block), one wav, a
// loop a loop.
{
  const parsed = await vgmOf("tools/tests/fc/apu.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["fc", ["fc", "md"]]);
  const opt = defaultVgmOptions(a, "fc");
  assert.deepEqual([opt.dest["2A03 SQ1"], opt.dest["2A03 SQ2"], opt.dest["2A03 TRI"], opt.dest["2A03 noise"]], ["sqr1", "sqr2", "tri", "noise"]);
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "fc", structure);
    assert.match(source, /\(sqr1[\s\S]*:duty 8[\s\S]*:duty 2/, "fc: sqr1's duty, 50 % then 12.5 %");
    assert.match(source, /\(sqr2[\s\S]*:duty 12/, "fc: sqr2's 75 %");
    assert.doesNotMatch(source.slice(source.indexOf("(tri"), source.indexOf("(noise")), /:vel/, "fc: the triangle says no :vel");
    assert.match(source, /\(tri[^)]*\bc _/, "fc: the triangle's rest (its linear counter at 0)");
    assert.match(source, /\(noise[\s\S]*:mode white (?::gate\* 1 )?:oct 2 [^|]*c c\+[\s\S]*:mode periodic[\s\S]*:mode white/, "fc: the noise's rates as notes, its modes");
  }
  const md = imported(parsed, "md").source;
  assert.equal(defaultVgmOptions(a, "md").dest["2A03 TRI"], "fm1");
  assert.match(md, /\(fm1[^)]*\s+wave-triangle/, "md: the triangle on a triangle wave");
  assert.match(md, /\(noise[\s\S]*:mode white\d[\s\S]*:mode periodic\d/, "md: the modes at the nearest rate");
  assert.doesNotMatch(md, /:duty/, "md: no duty");
}
// A Game Boy file (0xB3) is gb's: our own score comes back on its channels,
// zombie-mode level moves as a level under the note, the width as :mode.
{
  const parsed = await vgmOf("tools/tests/gb/apu.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["gb", ["gb", "md"]]);
  const opt = defaultVgmOptions(a, "gb");
  assert.deepEqual([opt.dest["GB SQ1"], opt.dest["GB SQ2"], opt.dest["GB noise"]], ["sqr1", "sqr2", "noise"]);
  const { source } = imported(parsed, "gb");
  assert.match(source, /:duty 8[\s\S]*:duty 2/, "gb: the duties");
  assert.match(source, /\(noise[\s\S]*:mode periodic[\s\S]*:mode white/, "gb: the LFSR's widths");
  assert.match(source, /:vel\+? \[/, "gb: a level moved by zombie writes is a level under the note");
}
// What a game's driver writes and our encoder does not: a hardware envelope
// and a length counter run between the writes, and a channel taken off both
// sides by NR51 is silent (Pokemon's wave).
{
  const v = [];
  const w = (a, d) => v.push(0xb3, a, d), wait = (n) => v.push(0x61, n & 0xff, n >> 8);
  const hdr = new Uint8Array(0x100);
  const dv = new DataView(hdr.buffer);
  hdr.set([0x56, 0x67, 0x6d, 0x20]);
  dv.setUint32(8, 0x161, true); dv.setUint32(0x34, 0x100 - 0x34, true); dv.setUint32(0x80, 4194304, true);
  w(0x16, 0x80); w(0x15, 0xff); w(0x14, 0x77);
  w(0x01, 0x80); w(0x02, 0xf1); w(0x03, 0x00); w(0x04, 0x87); wait(22050); // decays at 1/64 s a step
  w(0x06, 0xbf); w(0x07, 0xf0); w(0x08, 0x00); w(0x09, 0xc7); wait(22050); // (64 − 63) / 256 s long
  w(0x0a, 0x80); for (let i = 0; i < 16; i++) w(0x20 + i, i & 1 ? 0xff : 0x00);
  w(0x0c, 0x20); w(0x0d, 0x00); w(0x0e, 0x87); wait(11025); w(0x15, 0xbb); wait(11025);
  v.push(0x66);
  const bytes = new Uint8Array(0x100 + v.length);
  bytes.set(hdr); bytes.set(v, 0x100);
  new DataView(bytes.buffer).setUint32(0x18, 66150, true);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 4, true);
  const parsed = await parseVgm(bytes);
  const a = analyzeVgm(parsed);
  assert.equal(a.channels.find((c) => c.key === "GB SQ1").notes, 1, "gb: an envelope's fall is one note");
  const { source } = imported(parsed, "gb", false);
  assert.match(source, /:vel\+? \[/, "gb: the envelope as a level under the note");
  assert.equal(a.channels.find((c) => c.key === "GB SQ2").notes, 1, "gb: a length counter's note");
  assert.equal(a.channels.find((c) => c.key === "GB WAVE").notes, 1, "gb: NR51 ends the wave's note");
}
// The FDS (0xB4 $20-$7F): fds-wave on fc — the 32-step wave held twice
// back at 32 steps, the 64-step one whole, the gain as :vel, the
// modulation's table, rate and depth as the song's LFO words where a note
// starts with them (a sweep under a note is not followed), the wave moving
// under a held note, its depth moved there a tie with the depth; on msx
// every other step of the 64.
{
  const parsed = await vgmOf("tools/tests/fc/fds.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["fc", ["fc", "md"]]);
  assert.equal(defaultVgmOptions(a, "fc").dest.FDS, "fds-wave");
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "fc", structure);
    assert.match(source, /\(def-wave wave-01 :wave \[-128 -112 (?:-?\d+ ){29}-112\]\)/, "fc: the triangle at 32 steps");
    assert.match(source, /\(def-wave wave-02 :wave \[(?:-?\d+ ){63}-11\]\)/, "fc: the sine at 64");
    assert.match(source, /\(def lfo-01 \[1 1 1 1 1 1 1 1 -1 (?:-?1 ){22}1\]\)/, "fc: the modulation's table");
    const fds = source.slice(source.indexOf("(fds-wave"));
    assert.match(fds, /:vel 10 e/, "fc: the gain");
    assert.match(fds, /:lfo-wave lfo-01 :lfo-freq 20 :lfo-pmd 8 g [^|]*:lfo-pmd 30 c/, "fc: the vibrato, then deeper");
    assert.match(fds, /:lfo-pmd 0 ~ c (?:\S+ )*~ e/, "fc: no modulation from the held c on, tied where it stops");
    assert.match(fds, /wmac-01/, "fc: the wave rewritten under a note");
  }
  const msx = imported(parsed, "msx").source;
  assert.match(msx, /\(def-wave wave-02 :wave \[(?:-?\d+ ){31}-27\]\)/, "msx: the sine at the SCC's 32 steps");
  assert.doesNotMatch(msx, /:lfo-/, "msx: no modulation");
  imported(parsed, "md");
}
// The VRC7 (a YM2413 with its clock's bit 31): its channels on fc's
// vrc7-fm1-6 by number, a ROM voice by the VRC7's own name, the user voice a
// 2-op def-fm in the chip's words; on md the 4-op reading.
{
  const parsed = await vgmOf("tools/tests/fc/vrc7.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["fc", ["fc", "md"]]);
  const opt = defaultVgmOptions(a, "fc");
  for (let c = 1; c <= 3; c++) assert.equal(opt.dest[`VRC7 FM${c}`], `vrc7-fm${c}`);
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "fc", structure);
    assert.match(source, /\(vrc7-fm1[^)]*\bwurly\b/, "fc: the ROM's wurly by name");
    assert.match(source, /\(vrc7-fm2[^)]*\bsynth-bass\b/, "fc: the ROM's synth-bass");
    assert.match(source, /\(def-fm opll-user-01 :fb 5 :tl1 30\n {2}:ar1 15 :dr1 4 :sl1 3 :rr1 7 /, "fc: the user voice in 2-op words");
  }
  assert.match(imported(parsed, "md").source, /\(def-fm vrc7-3 :alg 4 /, "md: a ROM voice in the 4-op reading");
}
// The Sunsoft 5B (an AY beside a 2A03; a YM2149 with its divider pin low at
// half its clock): SSGA-C on 5b-sqr1-3 at their pitch, the hardware
// envelope as the SSG's words.
{
  const parsed = await vgmOf("tools/tests/fc/5b.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["fc", ["fc", "md"]]);
  const opt = defaultVgmOptions(a, "fc");
  for (const [k, d] of [["A", 1], ["B", 2], ["C", 3]]) assert.equal(opt.dest[`5B SSG${k}`], `5b-sqr${d}`);
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "fc", structure);
    assert.match(source, /\(5b-sqr1[^)]*:oct 4 [^)]*e[\d\s]/, "fc: 5b-sqr1's e4, at the 5B's clock");
    assert.match(source, /\(5b-sqr2[^)]*:mode env :env 14 /, "fc: the buzzer");
  }
  imported(parsed, "md");
  // An MSX's AY on fc is no 5B: its channels on the 2A03's, which mix no
  // noise, so its noise row stays and goes to the 2A03's noise.
  const msx = await vgmOf("tools/tests/msx/noise.mmlisp");
  assert.equal(defaultVgmOptions(analyzeVgm(msx), "fc").dest["AY-3-8910 SSG noise"], "noise");
  assert.match(imported(msx, "fc").source, /\(noise [^)]*:mode white/, "fc: an MSX AY's noise on noise");
}
{
  const { ir } = compileScoreFile(path.join(ROOT, "tools/tests/fc/dpcm.mmlisp"), {});
  const { frames } = bakedChipSamples(ir, targetProfile("fc"));
  const v = renderVgm(new IRPlayer(() => {}).loadJSON(ir), {}, { frames });
  const parsed = await parseVgm(new Uint8Array(v.bytes ?? v));
  const a = analyzeVgm(parsed);
  assert.equal(a.target, "fc");
  assert.equal(defaultVgmOptions(a, "fc").dest.DPCM, "pcm");
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "fc", structure);
    assert.match(source, /\(def-pcm dpcm-01 :file "t-pcm\.wav" :rate 33144 :offset 0 :frames 6664\)/, "fc: the first hit's sample, 833 bytes at rate 15");
    assert.match(source, /:loop-start 0ms/, "fc: the looped hit's sample");
    assert.match(source, /\(pcm1[\s\S]*dpcm-0\d :mode loop/, "fc: the loop on pcm1");
  }
  imported(parsed, "md");
}

// The YM2608's ADPCM-B: its RAM image (data block 0x81) decoded into one
// wav, a note per key-on at its Δ-N's pitch. On pc88 it is pcm1's again,
// its level the register's as :vol, its pan the hit's, a repeat a loop.
{
  const parsed = await vgmOfAdpcm("tools/tests/pc88/adpcm.mmlisp");
  const a = analyzeVgm(parsed);
  assert.equal(a.target, "pc88");
  assert.equal(defaultVgmOptions(a, "pc88").dest["ADPCM-B"], "pcm");
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "pc88", structure);
    assert.match(source, /\(def-pcm pcmb-01 :file "t-pcm\.wav"/, "pc88: the RAM's sample");
    const pcm1 = source.slice(source.indexOf("(pcm1"));
    for (const tok of [":pan left", ":pan right", ":mode loop", /:vol \d+/, /\se(?=[\d\s])/, /\sg(?=[\d\s])/])
      assert.match(pcm1, typeof tok === "string" ? new RegExp(tok) : tok, `pc88: ${tok} on pcm1`);
  }
  imported(parsed, "md");
}

// The YM2413 (the FM-PAC): an msx score's, its channels on fm1-fm9 by
// number, a ROM voice by its name, the user voice a 2-op def-fm. On md
// each key-on's voice — a ROM voice by its built-in name (piano, guitar),
// the user voice as a def-fm of its registers (the 4-op reading,
// chips/ym2413.js) — not a stand-in.
{
  const parsed = await vgmOf("tools/tests/msx/fm-pac.mmlisp");
  const a = analyzeVgm(parsed);
  assert.deepEqual([a.target, a.targets], ["msx", ["msx", "md"]]);
  const opt = defaultVgmOptions(a, "msx");
  for (const c of [1, 2, 3, 4, 5, 7, 8, 9]) assert.equal(opt.dest[`YM2413 FM${c}`], `fm${c}`);
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "msx", structure);
    assert.match(source, /\(def-score :target msx/, "msx: the FM-PAC's score");
    assert.match(source, /\(fm1[^)]*\bpiano\b/, "msx: the ROM's piano by name");
    assert.match(source, /\bguitar g g opll-user-01\b/, "msx: a ROM voice, then the user voice");
    assert.match(source, /\(def-fm opll-user-01 :fb \d+ :tl1 /, "msx: the user voice in 2-op words");
  }
  const { source } = imported(parsed, "md");
  assert.match(source, /\(fm1[^)]*\bpiano\b/, "md: the ROM's piano by name");
  assert.match(source, /\bguitar g g opll-user-01\b/, "md: a ROM voice, then the user voice");
  assert.match(source, /\(def-fm opll-user-01 :alg 4 /, "md: the user voice as a def-fm");
  assert.doesNotMatch(source, /wave-saw/, "md: no stand-in");
}

// The YM2413's rhythm mode ($0E): each sound's hits a row, on msx the
// FM-PAC's rhythm tracks at the channel's pitch — a bend while it rings,
// its key-off a gate — and fm7-fm9 no tones; on md the RX5 kit.
{
  const parsed = await vgmOf("tools/tests/msx/fm-pac-rhythm-pitch.mmlisp");
  const a = analyzeVgm(parsed);
  assert.equal(a.target, "msx");
  assert.ok(!a.channels.some((c) => /FM[789]$/.test(c.key)), "msx: no tones on the drums' channels");
  const opt = defaultVgmOptions(a, "msx");
  assert.deepEqual([opt.dest["YM2413 rhythm BD"], opt.dest["YM2413 rhythm SD"], opt.dest["YM2413 rhythm TOM"]], ["rhythm1", "rhythm2", "rhythm5"]);
  for (const structure of [true, false]) {
    const { source } = imported(parsed, "msx", structure);
    assert.match(source, /\(def bend-01 \(macro :pitch \(linear 0\.\.-1200 :len 12f\)\)\)/, "msx: the kick's fall");
    assert.match(source, /\(rhythm1[^)]*kick :mode gate :gate 12t bend-01 :oct 5 /, "msx: the kick a gate long, an octave up");
    assert.doesNotMatch(source, /rx5/, "msx: the FM-PAC's own sounds");
  }
  assert.match(imported(parsed, "md").source, /\(pcm\d[^)]*\bkick\b/, "md: the kit");
}

// The OKIM6295: a YM2151 and its sample ROM, a VGM written here as a CPS1's
// log reads, is an X68000 score on PCM8's voices. (No third-party ROM: the
// phrases are bytes of this test's.)
{
  const rom = new Uint8Array(0x40000 + 0x400);
  const phrase = (at, n, from, last) => rom.set([from >> 16, from >> 8, from, last >> 16, last >> 8, last], at + n * 8);
  phrase(0, 1, 0x100, 0x1ff);
  phrase(0, 2, 0x200, 0x2ff);
  phrase(0x40000, 1, 0x300, 0x33f); // bank 1, its addresses within the bank
  rom.fill(0x71, 0x100, 0x400);
  rom.fill(0x17, 0x40300, 0x40340);
  const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
  let out;
  const wait = (n) => out.push(0x61, n & 255, n >> 8);
  const oki = (port, d) => out.push(0xb8, port, d);
  const romBlock = () => {
    out.push(0x67, 0x66, 0x8b, ...u32(rom.length + 8), ...u32(rom.length), ...u32(0));
    for (const b of rom) out.push(b);
  };
  const file = (clock, ym2151) => {
    out.push(0x66);
    const head = new Uint8Array(0x100);
    const dv = new DataView(head.buffer);
    head.set([0x56, 0x67, 0x6d, 0x20]);
    dv.setUint32(0x04, 0x100 + out.length - 4, true);
    dv.setUint32(0x08, 0x161, true);
    dv.setUint32(0x18, 163350, true);
    if (ym2151) dv.setUint32(0x30, 3579545, true);
    dv.setUint32(0x34, 0x100 - 0x34, true);
    dv.setUint32(0x98, clock, true);
    return parseVgm(new Uint8Array([...head, ...out]));
  };
  const okiHits = (parsed) => parsed.pcmHits.filter((h) => h.src === "OKIM6295");
  out = [];
  romBlock();
  out.push(0x67, 0x66, 0x8b, ...u32((8 + 0x80000000) >>> 0), ...u32(0x40000), ...u32(0)); // the second chip's
  for (const [a, d] of [[0x20, 0xc7], [0x60, 0], [0x28, 0x4a], [0x08, 0x08]]) out.push(0x54, a, d);
  oki(0, 0x81); oki(0, 0x10); // phrase 1, voice 1, full: 512 frames at 7576 Hz, 2980 samples
  wait(100);
  oki(0, 0x82); oki(0, 0x10); // voice 1 still sounds: ignored
  oki(0, 0x82); oki(0, 0x22); // phrase 2, voice 2, attenuation 2 (0x10 of 0x20)
  oki(0x80, 0x81); // the second chip's
  wait(3000);
  oki(0, 0x82); oki(0, 0x10); // voice 1 is free again
  wait(200);
  oki(0, 0x08); // voice 1 stops
  wait(50);
  oki(0x0f, 1); oki(0, 0x81); oki(0, 0x40); // bank 1's phrase on voice 3
  for (let i = 0; i < 8; i++) wait(20000);
  const parsed = await file((1000000 + 0x80000000) >>> 0, true); // bit 31: pin 7 high, ÷132

  assert.ok(parsed.chips.includes("OKIM6295"));
  const hits = okiHits(parsed);
  assert.deepEqual(hits.map((h) => [h.ch, h.start, h.end]),
    [[0, 0x100, 0x200], [1, 0x200, 0x300], [0, 0x200, 0x300], [2, 0x40300, 0x40340]], "a busy voice ignores the play");
  assert.ok(hits.every((h) => Math.abs(h.rate - 1000000 / 132) < 1e-6), "pin 7: ÷132");
  assert.ok(Math.abs(hits[1].db + 6.02) < 0.01, "attenuation 2: -6 dB");
  assert.equal(hits[2].endT, hits[2].t + 200, "a stop ends the hit");

  const a = analyzeVgm(parsed);
  assert.equal(a.target, "x68k", "a YM2151 and an OKIM6295 are an X68000's");
  const opt = defaultVgmOptions(a, "x68k");
  assert.deepEqual([1, 2, 3].map((v) => opt.dest[`OKIM6295 ${v}`]), ["pcm", "pcm", "pcm"]);
  const { source } = imported(parsed, "x68k");
  assert.match(source, /\(def-pcm oki-01 /, "x68k: its samples");
  assert.equal(a.pcmPoly, 2, "two sound at once");
  for (const head of ["pcm1", "pcm2"]) assert.match(source, new RegExp(`\\(${head}\\b[\\s\\S]*?oki-`), `x68k: ${head}`);
  assert.equal(source.match(/\boki-\d+ (?!:file)/g).length, hits.length, "every hit a note");
  assert.match(source, /oki-03 :file "[^"]*" :rate 7576 :offset 1024 :frames 128/, "the bank's phrase, 2 frames a byte");
  assert.match(source, /:vel 12\b/, "-6 dB on the 2 dB ladder");

  // Alone it is still an X68000's; pin 7 low is ÷165, and the port's clock
  // and pin 7 replace the header's, the bytes written and only those.
  out = [];
  romBlock();
  oki(0, 0x81); oki(0, 0x10);
  wait(4000);
  oki(0x09, 0x84); oki(0x0b, 0); oki(0x0c, 1);
  oki(0, 0x81); oki(0, 0x10);
  for (let i = 0; i < 8; i++) wait(20000);
  const alone = await file(1000000, false);
  assert.equal(analyzeVgm(alone).target, "x68k", "an OKIM6295 alone is an X68000's");
  assert.deepEqual(okiHits(alone).map((h) => Math.round(h.rate)), [Math.round(1000000 / 165), Math.round(((1000000 & ~0xff00) | 0x8400) / 132)]);

  // What plays nothing: a phrase that runs backwards leaves a sounding voice
  // sounding, a full attenuation takes the voice and no note, and an NMK112's
  // bank reaches what the plain ROM read cannot.
  out = [];
  phrase(0, 3, 0x2ff, 0x200);
  romBlock();
  oki(0, 0x81); oki(0, 0x10);
  wait(10);
  oki(0, 0x83); oki(0, 0x10);
  wait(10);
  oki(0, 0x81); oki(0, 0x2a); // voice 2, attenuation 10: silent
  wait(10);
  oki(0, 0x82); oki(0, 0x20); // voice 2 is busy, silent or not
  wait(10);
  for (let i = 0; i < 8; i++) wait(20000);
  const silent = await file(1000000, false);
  assert.deepEqual(okiHits(silent).map((h) => [h.ch, h.start]), [[0, 0x100]]);
  assert.equal(okiHits(silent)[0].off, undefined, "the backwards phrase stopped nothing");

  // A play the file gives no sample for is counted lost, never a guess: the
  // ROM comes after it, or the bank is past its end. A header without a clock
  // says so.
  out = [];
  oki(0, 0x81); oki(0, 0x10);
  romBlock();
  oki(0x0f, 3); oki(0, 0x81); oki(0, 0x20);
  for (let i = 0; i < 8; i++) wait(20000);
  const lost = await file(0, false);
  assert.deepEqual(okiHits(lost), []);
  assert.ok([...lost.skipped ?? []].some(([name, n]) => /OKIM6295.*no sample data/.test(name) && n === 2), "both counted");
  assert.ok(lost.clockNotes?.some((n) => /no OKIM6295 clock/.test(n)), "the assumed clock said");

  // High nibble first, from 0: 7 at step 0 is +30; the OKIM6258's low nibble 0 is +2 from -2.
  assert.equal(decodeOki(new Uint8Array([0x70]), 0, 1, { high: true })[0], 30 / 2048);
  assert.equal(decodeOki(new Uint8Array([0x70]), 0, 1)[0], 0);
}

// A vibrato on the SSG, in a VGM written here: a strike, a level held, a slow
// fall, and another note after a rest.
const ssgVibrato = async ({ frames, gap, tp, vol }) => {
  const out = [];
  const ay = (r, d) => out.push(0xa0, r, d);
  ay(7, 0x3e);
  ay(1, 0);
  let lastTp = -1, lastVol = -1; // as a driver writes them: what changed
  for (let f = 0; f < frames; f++) {
    if (tp(f) !== lastTp) ay(0, (lastTp = tp(f)));
    if (vol(f) !== lastVol) ay(8, (lastVol = vol(f)));
    out.push(0x62);
  }
  ay(8, 0);
  for (let i = 0; i < gap; i++) out.push(0x62);
  ay(0, 213);
  ay(8, 13);
  for (let i = 0; i < 48; i++) out.push(0x62);
  ay(8, 0);
  out.push(0x62, 0x66);
  const head = new Uint8Array(0x100);
  const dv = new DataView(head.buffer);
  head.set([0x56, 0x67, 0x6d, 0x20]);
  dv.setUint32(0x04, 0x100 + out.length - 4, true);
  dv.setUint32(0x08, 0x161, true);
  dv.setUint32(0x18, (frames + gap + 49) * 735, true);
  dv.setUint32(0x34, 0x100 - 0x34, true);
  dv.setUint32(0x74, 1789773, true);
  return imported(await parseVgm(new Uint8Array([...head, ...out])), "msx").source;
};
const swing = [0, 1, 2, 1, 0, -1, -2, -1];
// It sounds from its centre, the way the chip went.
for (const [dir, phase] of [[-1, 64], [1, 192]]) {
  const source = await ssgVibrato({ frames: 96, gap: 24,
    tp: (f) => 240 + (f < 12 ? 0 : dir * 3 * swing[(f - 11) % 8]),
    vol: (f) => (f < 1 ? 14 : f < 5 ? 13 : f < 23 ? 12 : f < 40 ? 11 : f < 57 ? 10 : f < 74 ? 9 : 8) });
  assert.match(source, new RegExp(`\\(sin -\\d+\\.\\.\\d+ :len 8f :wait 1\\df :phase ${phase}\\)`), "the sine from its centre, its way");
}
// Its level falling after a held run reads as a release, but the note stays
// keyed to its end: a macro's loop ends at a key-off.
assert.ok(!/#rel/.test(await ssgVibrato({ frames: 72, gap: 8,
  tp: (f) => 240 + (f < 12 ? 0 : -3 * swing[Math.floor(((f - 11) * 8) / 10) % 8]),
  vol: (f) => (f < 1 ? 14 : f < 5 ? 13 : f < 23 ? 12 : Math.max(1, 11 - ((f - 23) >> 3))) })), "no release while it wobbles");

// A note that starts off its held pitch, a step or a scoop, before it holds
// still and wobbles: a vibrato still, the sine fitted to where it starts.
{
  const sine = Array.from({ length: 96 }, (_, f) => Math.round(45 * Math.sin((2 * Math.PI * f) / 12 + Math.PI / 2)));
  const hold = Array(17).fill(0);
  const [step] = assignBends([{ bend: [15, ...hold, ...sine] }]);
  assert.match(step, /\(sin -50\.\.50 :len 12f :wait 17f :phase 112\)/, `a tuning step, ${step}`);
  const [scoop] = assignBends([{ bend: [-605, -420, -225, -35, ...hold, ...sine] }]);
  assert.match(scoop, /\[\(linear -605\.\.0 :len 5f\) \(sin -50\.\.50 :len 12f :wait 15f :phase 112\)\]/, `a scoop, ${scoop}`);
}

// What only looks like a hold leaves the swings alone: a flat tail, a slow
// wobble crossing its centre. And two scoops are two defs.
{
  const peak = Array.from({ length: 48 }, (_, f) => Math.round(40 * Math.cos((2 * Math.PI * f) / 12)));
  const [tail] = assignBends([{ bend: [...peak, ...Array(10).fill(0)] }]);
  assert.match(tail, /\(sin -\d+\.\.\d+ :len 12f/, `a flat tail, ${tail}`);
  const slow = Array.from({ length: 160 }, (_, f) => Math.round(40 * Math.sin((2 * Math.PI * (f + 60)) / 80)));
  const [lfo] = assignBends([{ bend: slow }]);
  assert.match(lfo, /\(sin -\d+\.\.\d+ :len 80f/, `a slow wobble, ${lfo}`);
  const wobble = Array.from({ length: 96 }, (_, f) => Math.round(45 * Math.sin((2 * Math.PI * f) / 12)));
  const scooped = (end) => ({ bend: [-605, -420, -225, end, ...Array(17).fill(0), ...wobble] });
  const defs = assignBends([scooped(-40), scooped(-30), { bend: [-605, -420, -225, -225, -40, ...Array(16).fill(0), ...wobble] }]);
  const names = defs.map((d) => d.split(" ")[1]);
  assert.equal(new Set(names).size, names.length, `each its own name: ${names}`);
}

// Sample chips of VGMs written here, each beside a YM2151 note: a header's
// clock fields set, a ROM block, then what `play` writes.
const u32le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
const vgmBytes = (out, samples, fields) => {
  const head = new Uint8Array(0x100);
  const dv = new DataView(head.buffer);
  head.set([0x56, 0x67, 0x6d, 0x20]);
  dv.setUint32(0x04, 0x100 + out.length - 4, true);
  dv.setUint32(0x08, 0x161, true);
  dv.setUint32(0x18, samples, true);
  dv.setUint32(0x34, 0x100 - 0x34, true);
  for (const [at, v] of fields) dv.setUint32(at, v, true);
  return new Uint8Array([...head, ...out]);
};
const arcadeVgm = (fields, type, rom, play) => {
  const out = [0x67, 0x66, type, ...u32le(rom.length + 8), ...u32le(rom.length), ...u32le(0), ...rom];
  for (const [a, d] of [[0x20, 0xc7], [0x60, 0], [0x28, 0x4a], [0x08, 0x08]]) out.push(0x54, a, d);
  play(out);
  for (let i = 0; i < 8; i++) out.push(0x61, 0x20, 0x4e);
  out.push(0x66);
  return parseVgm(vgmBytes(out, 163350, [[0x30, 3579545], ...fields]));
};
{
  // K053260: voice 1 PCM, voice 2 KADPCM at half level.
  const rom = new Uint8Array(0x200).fill(0x10);
  const parsed = await arcadeVgm([[0xac, 3579545]], 0x8e, rom, (out) => {
    const k = (a, d) => out.push(0xba, a, d);
    for (const [a, d] of [[0x08, 0x00], [0x09, 0x00], [0x0a, 0xff], [0x0b, 0], [0x0c, 0x10], [0x0d, 0], [0x0e, 0], [0x0f, 0x7f],
      [0x10, 0x00], [0x11, 0x0f], [0x12, 0x7f], [0x13, 0], [0x14, 0x00], [0x15, 1], [0x16, 0], [0x17, 0x3f], [0x2a, 0x20], [0x2c, 0x24]]) k(a, d);
    k(0x28, 0x03);
    out.push(0x61, 0x10, 0x27);
    k(0x28, 0x02);
  });
  {
    // Pan 0 is silent, a reversed voice is reported, and neither makes a hit.
    const quiet = await arcadeVgm([[0xac, 3579545]], 0x8e, rom, (out) => {
      for (const [a, d] of [[0x0a, 0x10], [0x0f, 0x7f], [0x17, 0x7f], [0x12, 0x10], [0x2c, 0x20], [0x28, 0x01]]) out.push(0xba, a, d);
      for (const [a, d] of [[0x28, 0], [0x2c, 0x24], [0x28, 0x11]]) out.push(0xba, a, d);
    });
    assert.equal(quiet.pcmHits.length, 0);
    assert.ok([...quiet.skipped.keys()].some((k) => /reversed/.test(k)));
  }
  const hits = parsed.pcmHits.filter((h) => h.src === "K053260");
  assert.deepEqual(hits.map((h) => [h.ch, h.start, h.end, h.kadpcm]), [[0, 0x11, 0x110, false], [1, 0x101, 0x180, true]], "the byte after its start");
  assert.ok(Math.abs(hits[0].rate - 3579545 / 4096) < 1e-6, "4096 - pitch clocks a step");
  assert.equal(hits[0].endT, 10000, "a key off");
  assert.ok(Math.abs(hits[1].db + 6.02) < 0.1);
  assert.equal(analyzeVgm(parsed).target, "x68k");
  assert.match(imported(parsed, "x68k").source, /\(def-pcm k053-01 /);
  assert.deepEqual([...decodeK053260(new Uint8Array([0x7f, 0x80]), 0, 2, false)], [127 / 128, -1]);
  assert.deepEqual([...decodeK053260(new Uint8Array([0x32]), 0, 1, true)].map((v) => v * 128), [2, 6], "low nibble first");
}
{
  // C140: System 2's banks, an old log's clock, mu-law on a second voice.
  const rom = new Uint8Array(0x20000).fill(0x20);
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    for (const [a, d] of [[0, 0xff], [1, 0xff], [2, 0x80], [3, 0], [4, 1], [6, 0x01], [7, 0], [8, 0x02], [9, 0], [5, 0x80]]) c(a, d);
    for (const [a, d] of [[0x10, 0x40], [0x11, 0x40], [0x12, 0x40], [0x13, 0], [0x14, 0], [0x16, 0x10], [0x17, 0], [0x18, 0x11], [0x19, 0], [0x1a, 0x10], [0x1b, 0x80], [0x15, 0x98]]) c(a, d);
    out.push(0x61, 0x10, 0x27);
    c(5, 0);
  });
  const hits = parsed.pcmHits.filter((h) => h.src === "C140");
  assert.deepEqual(hits.map((h) => [h.ch, h.start, h.end, h.mulaw, h.loopStart]),
    [[0, 0x10100, 0x10200, false, null], [1, 0x1000, 0x1100, true, 0x1080]]);
  assert.ok(Math.abs(hits[0].rate - (0x8000 * 12288000) / 288 / 65536) < 1e-6, "21390 is 12.288 MHz");
  assert.equal(analyzeVgm(parsed).target, "x68k");
  assert.match(imported(parsed, "x68k").source, /\(def-pcm c140-01 /);
  assert.deepEqual([...decodeC140(new Uint8Array([0x7f, 0x80]), 0, 2, false)], [127 / 128, -1]);
  assert.equal(decodeC140(new Uint8Array([0x13]), 0, 1, true)[0], ((0x80 << 3) + (2 << 6)) / 32768, "its log");
}
// Voices mixed into PCM8's one stream leave room for what they sum to: four
// full hits at once come in at a quarter each.
{
  const rom = new Uint8Array(0x400);
  rom.set([0, 1, 0, 0, 3, 0xff], 8);
  rom.fill(0x77, 0x100); // a climb, to the rail
  const parsed = await arcadeVgm([[0x98, (1000000 + 0x80000000) >>> 0]], 0x8b, rom, (out) => {
    for (const d of [0x10, 0x20, 0x40, 0x80]) out.push(0xb8, 0, 0x81, 0xb8, 0, d, 0x62); // a frame apart: four sounds
  });
  const a = analyzeVgm(parsed);
  const { pcm } = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, "x68k"), structure: true, fileName: "t.vgm" }, a);
  const peak = pcm.mono.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak < 0.3, `a mix's headroom: ${peak}`);
}

// C140 beside a YM2151: a full hit at the chip's own balance, not PCM8's full
// scale; a hit stopped early is cut there; a stereo pair is one voice's.
{
  const rom = new Uint8Array(0x20000);
  for (let i = 0x100; i < 0x200; i++) rom[i] = i & 1 ? 0x7f : 0x80;
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    for (const v of [0, 1]) {
      const r = v << 4;
      for (const [a, d] of [[0, 0xff], [1, 0xff], [2, 0x01], [3, 0], [4, 0], [6, 0x01], [7, 0], [8, 0x02], [9, 0]]) c(r + a, d);
    }
    c(0x05, 0x80);
    c(0x15, 0x80);
    out.push(0x61, 0x10, 0x27);
    c(0x05, 0);
    c(0x15, 0);
    out.push(0x61, 0x10, 0x27, 0x61, 0x10, 0x27);
    c(0x05, 0x80);
  });
  const a = analyzeVgm(parsed);
  const { source, pcm } = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, "x68k"), structure: true, fileName: "t.vgm" }, a);
  const peak = pcm.mono.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 1 / (26886 / 3660)) < 0.01, `the chip's balance: ${peak}`);
  assert.match(source, /:mode gate/, "stopped short");
  assert.ok(!/\(pcm2\b/.test(source), "the pair is one voice");
}

// An NMK112 (a Raizing board's): the table's and the sample's banks are each
// the ports' own, and a sample over two windows is read from both.
{
  const rom = new Uint8Array(0x100000);
  rom.set([0, 0x10, 0, 0, 0x10, 0xff], 0x20000 + 8); // table bank 2, the phrase 1 of window 0
  rom.set([1, 0xff, 0, 2, 0x00, 0xff], 0x30000 + 0x100 + 8); // table bank 3, phrase 33 of window 1
  rom.fill(0x71, 0x51000, 0x51100); // window 0 on bank 5
  rom.fill(0x17, 0x3ff00, 0x40000); // window 1 on bank 3
  rom.fill(0x71, 0x70000, 0x70100); // window 2 on bank 7
  const out = [0x67, 0x66, 0x8b, ...u32le(rom.length + 8), ...u32le(rom.length), ...u32le(0), ...rom];
  for (const [a, d] of [[0x20, 0xc7], [0x60, 0], [0x28, 0x4a], [0x08, 0x08]]) out.push(0x54, a, d);
  for (const [port, d] of [[0x0e, 0x80], [0x10, 2], [0x11, 3], [0x12, 7]]) out.push(0xb8, port, d);
  out.push(0xb8, 0, 0x81, 0xb8, 0, 0x10);
  out.push(0x61, 0x10, 0x27);
  for (const [port, d] of [[0x10, 5], [0x11, 3]]) out.push(0xb8, port, d);
  out.push(0xb8, 0, 0x81, 0xb8, 0, 0x20); // the table moved: nothing at phrase 1 now
  out.push(0x61, 0x10, 0x27);
  for (const [port, d] of [[0x10, 2], [0x11, 3]]) out.push(0xb8, port, d);
  out.push(0xb8, 0, 0x80 | 33, 0xb8, 0, 0x40);
  for (let i = 0; i < 8; i++) out.push(0x61, 0x20, 0x4e);
  out.push(0x66);
  const parsed = await parseVgm(vgmBytes(out, 200000, [[0x30, 3579545], [0x98, 1000000]]));
  assert.ok(![...(parsed.skipped ?? [])].some(([name]) => /NMK112/.test(name)), "banks are read, not skipped");
  const hits = parsed.pcmHits.filter((h) => h.src === "OKIM6295");
  assert.equal(hits.length, 2, "a play of an empty table entry plays nothing");
  assert.deepEqual([hits[0].start, hits[0].end], [0x21000, 0x21100], "the sample's bank is window 0's at the play");
  assert.ok(hits[1].bytes, "over two windows: its own bytes");
  assert.equal(hits[1].bytes.length, 0x200);
  assert.deepEqual([hits[1].bytes[0], hits[1].bytes[0xff], hits[1].bytes[0x100], hits[1].bytes[0x1ff]], [0x17, 0x17, 0x71, 0x71]);
}

// A YM2203 beside an OKIM6295's voices: the PC-8801 has one for them, so the
// Mega Drive, where they all sound. Chosen, the PC-8801's plays them at the
// song's own levels, not its register's.
{
  const rom = new Uint8Array(0x1000);
  rom.set([0, 1, 0, 0, 2, 0], 8);
  rom.set([0, 3, 0, 0, 4, 0], 16);
  rom.fill(0x71, 0x100);
  const out = [0x67, 0x66, 0x8b, ...u32le(rom.length + 8), ...u32le(rom.length), ...u32le(0), ...rom];
  for (const [a, d] of [[0x28, 0xf0], [0xa4, 0x20], [0xa0, 0x80], [0x4c, 0], [0xb0, 7]]) out.push(0x55, a, d);
  out.push(0xb8, 0, 0x81, 0xb8, 0, 0x14, 0xb8, 0, 0x82, 0xb8, 0, 0x24);
  for (let i = 0; i < 8; i++) out.push(0x61, 0x20, 0x4e);
  out.push(0x66);
  const bytes = vgmBytes(out, 160000, [[0x44, 3993600], [0x98, 1000000]]);
  const parsed = await parseVgm(bytes);
  assert.equal(analyzeVgm(parsed).target, "md", "two voices at once");
  {
    const a = analyzeVgm(parsed);
    const { pcm } = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, "pc88"), structure: true, fileName: "t.vgm" }, a);
    assert.ok(pcm.mono.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.99, "one voice: nothing to sum");
  }
  const { source } = imported(parsed, "pc88");
  assert.ok(!/:vol /.test(source), "no register level on another chip's hits");
}

// A note over the loop point, the song's end on its pitch: one note both ways in.
{
  const out = [];
  const opm = (a, d) => out.push(0x54, a, d);
  const frames = (n) => { for (let i = 0; i < n; i++) out.push(0x62); };
  opm(0x20, 0xc7); opm(0x60, 0); opm(0x28, 0x4a); opm(0x08, 0x08);
  frames(120);
  const loopAt = 0x100 + out.length;
  frames(120);
  opm(0x08, 0x00); opm(0x28, 0x4c); opm(0x08, 0x08);
  frames(120);
  opm(0x08, 0x00); opm(0x28, 0x4a); opm(0x08, 0x08);
  frames(120);
  out.push(0x66);
  const bytes = vgmBytes(out, 480 * 735, [[0x1c, loopAt - 0x1c], [0x20, 360 * 735], [0x30, 3579545]]);
  const { source } = imported(await parseVgm(bytes), "x68k");
  assert.match(source, /#top[^|]*~/, `tied over the loop point: ${source}`);
}

// Two YM2203s: the second's channels are its own.
{
  const out = [];
  for (const c of [0x55, 0xa5])
    for (const [a, d] of [[0x28, 0xf0], [0xa4, 0x20], [0xa0, 0x80], [0x4c, 0], [0xb0, 7]]) out.push(c, a, d);
  for (let i = 0; i < 8; i++) out.push(0x61, 0x20, 0x4e);
  out.push(0x66);
  const bytes = vgmBytes(out, 160000, [[0x44, (3993600 + 0x40000000) >>> 0]]);
  const parsed = await parseVgm(bytes);
  assert.deepEqual(analyzeVgm(parsed).channels.map((c) => c.key).sort(), ["YM2203 FM1", "YM2203B FM1"]);
  assert.equal(parsed.skipped.size, 0);
  assert.match(imported(parsed, "pc88").source, /\(fm2\b/);
}

// Fades on samples that change, in the song's order. A level written after a
// hit ended is the next one's; a song converted twice comes out the same; alone,
// with no YM2151 to balance against, it reaches full scale.
{
  const rom = new Uint8Array(0x20000);
  for (let i = 0x100; i < 0x1000; i++) rom[i] = i & 1 ? 0x7f : 0x80;
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    const hit = (hi, lo, last) => {
      for (const [a, d] of [[0, lo], [1, lo], [2, 0x01], [3, 0], [4, 0], [6, hi], [7, 0], [8, last], [9, 0], [5, 0x80]]) c(a, d);
      out.push(0x61, 0x10, 0x27);
      c(0, lo >> 2); c(1, lo >> 2);
      out.push(0x61, 0x10, 0x27);
      c(5, 0);
      out.push(0x61, 0x10, 0x27);
    };
    hit(0x01, 0xff, 0x08);
    hit(0x08, 0xff, 0x0f);
    hit(0x01, 0xff, 0x08);
    hit(0x08, 0xff, 0x0f);
  });
  const { source } = imported(parsed, "x68k");
  const { ir } = compileMMLisp(source, "t.mmlisp", { imports: new Map() });
  const played = ir.tracks.find((t) => t.channel === "pcm1").events.filter((e) => e.cmd === "PCM_NOTE_ON").map((e) => e.args.sample);
  assert.deepEqual(played, ["c140-01", "c140-02", "c140-01", "c140-02"], "a fade does not hide a sample");
  assert.equal(imported(parsed, "x68k").source, source, "the same again");
}
{
  const rom = new Uint8Array(0x20000);
  for (let i = 0x100; i < 0x200; i++) rom[i] = i & 1 ? 0x7f : 0x80;
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    for (const [a, d] of [[0, 0x20], [1, 0x20], [2, 0x80], [3, 0], [4, 0], [6, 0x01], [7, 0], [8, 0x02], [9, 0], [5, 0x80]]) c(a, d);
    out.push(0x61, 0x10, 0x27);
    c(0, 0xff); c(1, 0xff); // it played out: the next hit's level
    out.push(0x61, 0x10, 0x27);
    c(5, 0x80);
  });
  const hit = parsed.pcmHits.find((h) => h.src === "C140");
  assert.ok(!hit.levels?.length, "no level after its end");
}
{
  const rom = new Uint8Array(0x20000);
  for (let i = 0x100; i < 0x200; i++) rom[i] = i & 1 ? 0x7f : 0x80;
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    for (const [a, d] of [[0, 0xff], [1, 0xff], [2, 0x80], [3, 0], [4, 0], [6, 0x01], [7, 0], [8, 0x02], [9, 0], [5, 0x80]]) c(a, d);
  });
  const a = analyzeVgm(parsed);
  const dest = { ...defaultVgmOptions(a, "x68k").dest };
  for (const k of Object.keys(dest)) if (/^YM2151/.test(k)) dest[k] = "drop";
  const { pcm } = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, "x68k"), dest, structure: true, fileName: "t.vgm" }, a);
  assert.ok(pcm.mono.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.99, "no carrier to balance against");
}

// A sound stopped short lasts as long as it rang, over the bars it crosses.
{
  const rom = new Uint8Array(0x20000);
  for (let i = 0x100; i < 0xff00; i++) rom[i] = i & 1 ? 0x70 : 0x90;
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    for (const [a, d] of [[0, 0xff], [1, 0xff], [2, 0x08], [3, 0], [4, 0], [6, 0x01], [7, 0], [8, 0xf0], [9, 0], [5, 0x80]]) c(a, d);
    for (let i = 0; i < 4; i++) out.push(0x61, 0x20, 0x4e); // 1.8 s
    c(5, 0);
  });
  const { source } = imported(parsed, "x68k");
  const { ir } = compileMMLisp(source, "t.mmlisp", { imports: new Map() });
  const ev = ir.tracks.find((t) => t.channel === "pcm1").events;
  const on = ev.find((e) => e.cmd === "PCM_NOTE_ON"), off = ev.find((e) => e.cmd === "PCM_NOTE_OFF");
  const heard = ((off.tick - on.tick) / 240);
  assert.ok(Math.abs(heard - (4 * 0x4e20) / 44100) < 0.05, `its length: ${heard}s`);
}

// A YM2203 set to its 1/3 prescaler sounds an octave up, its SSG too.
const unset = [];
for (const [pres, octave] of [[[], 0], [[0x2d, 0x2e], 12]]) {
  const out = [];
  for (const a of pres) out.push(0x55, a, 0);
  for (const [a, d] of [[0x07, 0x3e], [0x00, 0], [0x01, 1], [0x08, 12], [0xa4, 0x20], [0xa0, 0x80], [0x4c, 0], [0xb0, 7], [0x28, 0xf0]]) out.push(0x55, a, d);
  for (let i = 0; i < 8; i++) out.push(0x61, 0x20, 0x4e);
  out.push(0x66);
  const bytes = vgmBytes(out, 160000, [[0x44, 1500000]]);
  const parsed = await parseVgm(bytes);
  const pitches = ["YM2203 FM1", "YM2203 SSGA"].map((k) => parsed.events.get(k).find((e) => e.kind === "on").pitch);
  if (!octave) unset.push(...pitches);
  else for (const i of [0, 1]) assert.ok(Math.abs(pitches[i] - unset[i] - octave) < 0.01, "an octave up");
}

// A driver keys a voice first and sets its level after, and fades it by hand.
{
  const rom = new Uint8Array(0x20000);
  for (let i = 0x100; i < 0x8000; i++) rom[i] = i & 1 ? 0x70 : 0x90;
  const parsed = await arcadeVgm([[0xa8, 21390]], 0x8d, rom, (out) => {
    const c = (a, d) => out.push(0xd4, a >> 8, a & 255, d);
    for (const [a, d] of [[2, 0x10], [3, 0], [4, 0], [6, 0x01], [7, 0], [8, 0x70], [9, 0], [5, 0x80]]) c(a, d);
    c(0, 0xff); c(1, 0xff); // its level, a moment after its key
    out.push(0x61, 0x10, 0x27);
    for (const v of [0x80, 0x40, 0x20, 0x10]) { c(0, v); c(1, v); out.push(0x61, 0x10, 0x27); }
    c(5, 0);
  });
  const hit = parsed.pcmHits.find((h) => h.src === "C140");
  assert.equal(hit.db, 0, "its level, not the silence it was keyed at");
  const { source } = imported(parsed, "x68k");
  assert.match(source, /\(def pcm-fade-01 \(macro :vel\+ \[0 .*-\d/, `the fade: ${source.slice(0, 300)}`);
  assert.match(source, /\(pcm1[\s\S]*pcm-fade-01/);
}

// An SCC+ (bit 31 of the header's clock): its waves on port 4, a fifth of its own.
{
  const out = [];
  const scc = (port, a, d) => out.push(0xd2, port, a, d);
  for (let i = 0; i < 32; i++) { scc(4, i, i * 4); scc(4, 0x80 + i, 124 - i * 4); }
  for (let c = 0; c < 5; c++) { scc(1, c * 2, 200 + c * 20); scc(2, c, 12); }
  scc(3, 0, 0x11);
  for (let i = 0; i < 60; i++) out.push(0x62);
  scc(3, 0, 0);
  for (let i = 0; i < 12; i++) out.push(0x62);
  out.push(0x66);
  const bytes = vgmBytes(out, 72 * 735, [[0x9c, (1789773 + 0x80000000) >>> 0]]);
  const { source } = imported(await parseVgm(bytes), "msx");
  assert.match(source, /\(def-wave [\w-]+ :wave \[0 4 8 /, "channel 1's wave, from port 4");
  assert.match(source, /\(def-wave [\w-]+ :wave \[124 120 /, "channel 5's own");
}

// A note that starts in a swing, as a driver's free-running LFO leaves it,
// starts where in the sine it is, and reads its period past that swing.
for (const [start, phase] of [[1, 96], [2, 128], [5, 224], [6, null]]) {
  const note = { bend: Array.from({ length: 40 }, (_, f) => Math.round(50 * Math.sin((2 * Math.PI * (f + start)) / 8))) };
  const [def] = assignBends([note]);
  assert.ok(def.includes(":len 8f"), `start ${start}: its period, ${def}`);
  assert.ok(phase == null ? !def.includes(":phase") : def.includes(`:phase ${phase}`), `start ${start}: its place in the sine, ${def}`);
}

console.log("VGM import checks passed");
