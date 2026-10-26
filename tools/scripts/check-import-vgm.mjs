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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function vgmOf(file) {
  const { ir } = compileMMLisp(fs.readFileSync(path.join(ROOT, file), "utf8"), { fileName: file });
  const v = renderVgm(new IRPlayer(() => {}).loadJSON(ir), {});
  return parseVgm(new Uint8Array(v.bytes ?? v));
}
function imported(parsed, target, structure = true) {
  const a = analyzeVgm(parsed);
  const { source } = vgmToMmlisp(parsed, { ...defaultVgmOptions(a, target), structure, fileName: "t.vgm" }, a);
  const bad = compileMMLisp(source, "t.mmlisp").diagnostics.filter((d) => d.severity === "error");
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

console.log("VGM import checks passed");
