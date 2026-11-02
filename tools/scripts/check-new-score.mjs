// File > New (new-score.js): every machine's empty score compiles clean, writes
// each track it should, and imports only what the machine plays.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { TARGETS } from "../../live/src/targets.js";
import { newScoreSource } from "../../live/src/new-score.js";

const heads = (src) => [...src.matchAll(/^\(([^\s()]+)(?: [a-z0-9]+)?(?: :tempo \d+)?\n  #top\n  \(go top\)\n\)$/gm)].map((m) => m[1]);
const TRACKS = {
  md: ["fm1", "fm2", "fm3", "fm4", "fm5", "sqr1", "sqr2", "sqr3", "noise", "pcm1"],
  pc88: ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6", "sqr1", "sqr2", "sqr3", "pcm1", "rhythm1", "rhythm2", "rhythm3", "rhythm4", "rhythm5", "rhythm6"],
  x68k: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `fm${n}`).concat([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `pcm${n}`)),
  msx: ["sqr1", "sqr2", "sqr3", "wave1", "wave2", "wave3", "wave4", "wave5", "fm1", "fm2", "fm3", "fm4", "fm5", "fm6", "rhythm1", "rhythm2", "rhythm3", "rhythm4", "rhythm5"],
  pce: ["wave1", "wave2", "wave3", "wave4", "wave5", "wave6"],
  fc: ["sqr1", "sqr2", "tri", "noise", "pcm1"],
  gb: ["sqr1", "sqr2", "noise", "wave"],
};
const IMPORTS = { md: ["gm", "waveforms", "rx5"], x68k: ["gm", "waveforms", "rx5"], pc88: ["gm", "waveforms", "rx5"], msx: ["wavetable"], pce: ["wavetable"], fc: ["rx5"], gb: ["wavetable"] };

for (const name of Object.keys(TARGETS)) {
  const src = newScoreSource(name);
  const { diagnostics, ir } = compileMMLisp(src, "new.mmlisp", { imports: readImportSources("new.mmlisp", src) });
  assert.deepEqual(diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`), [], `${name}: nothing to say of an empty score`);
  assert.equal(ir.metadata?.target ?? "md", name, `${name}: its target`);
  assert.match(src, /:tempo 120/, `${name}: the tempo`);
  if (TRACKS[name]) assert.deepEqual(heads(src), TRACKS[name], `${name}: its tracks`);
  if (IMPORTS[name]) assert.deepEqual([...src.matchAll(/presets\/([^/]+)\/set/g)].map((m) => m[1]), IMPORTS[name], `${name}: its imports`);
  assert.doesNotMatch(src, /\(def(?!-score)/, `${name}: no defs`);
}
assert.match(newScoreSource("fc"), /; Cartridge[^\n]*vrc6-saw/, "fc: its cartridges listed");
assert.match(newScoreSource("md"), /; fm6 is the DAC[^\n]*pcm2 pcm3/, "md: fm6 and the DAC");
const sounds = (name) => [...newScoreSource(name).matchAll(/^\(rhythm\d (\S+)$/gm)].map((m) => m[1]);
assert.deepEqual(sounds("pc88"), ["kick", "snare", "ride", "hat", "tom4", "rim"], "pc88: a rhythm sound a track");
assert.deepEqual(sounds("msx"), ["kick", "snare", "tom4", "ride", "hat"], "msx: a rhythm sound a track");
// A kit's stand-ins hold every sound a track starts on.
for (const role of sounds("pc88"))
  assert.match(readFileSync("../presets/rx5/set.mmlisp", "utf8"), new RegExp(`^\\(def-pcm ${role}\\b`, "m"), `rx5: ${role}`);
for (const name of Object.keys(TARGETS))
  if (/presets\/rx5/.test(newScoreSource(name)))
    assert.ok(heads(newScoreSource(name)).some((h) => TARGETS[name].partOf(h).kind === "sample"), `${name}: a sample track for the kit it imports`);
console.log(`New score checks passed: ${Object.keys(TARGETS).length} machines`);
