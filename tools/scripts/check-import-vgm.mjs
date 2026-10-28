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
import { parseVgm, analyzeVgm, defaultVgmOptions, vgmToMmlisp } from "../../live/src/import-vgm.js";
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
  // Where the PCM is not the DAC's mix there is no kit to fall back on.
  for (const t of ["msx", "pce"]) {
    const o = defaultVgmOptions(a, t);
    assert.equal(o.dest["YM2608 rhythm SD"], "drop", `${t}: the rhythm has no channel`);
    imported(parsed, t);
  }
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

// The YM2413 on md: each key-on's voice — a ROM voice by its built-in name
// (piano, guitar), the user voice as a def-fm of its registers (the 4-op
// reading, chips/ym2413.js) — not a stand-in.
{
  const parsed = await vgmOf("tools/tests/msx/fm-pac.mmlisp");
  const { source } = imported(parsed, "md");
  assert.match(source, /\(fm1[^)]*\bpiano\b/, "md: the ROM's piano by name");
  assert.match(source, /\bguitar g g opll-user-01\b/, "md: a ROM voice, then the user voice");
  assert.match(source, /\(def-fm opll-user-01 :alg 4 /, "md: the user voice as a def-fm");
  assert.doesNotMatch(source, /wave-saw/, "md: no stand-in");
}

console.log("VGM import checks passed");
