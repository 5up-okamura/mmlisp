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

console.log("VGM import checks passed");
