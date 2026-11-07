#!/usr/bin/env node
// The GM output (live/src/gm-output.js, gm-worklet.js): a SoundFont played
// in the page by spessasynth_core (live/vendor/spessasynth.js) on the bundled
// FluidR3Mono (live/soundfonts/).
//
//   planVoices   a plan's banks and programs, by channel, with their keys'
//                range — what the worklet decodes ahead — and each resolves
//                to its GM preset in the bank
//   the worklet  its processor run here on stand-ins for the AudioWorklet's
//                globals: the bank loads, a message sounds from the quantum
//                its audio time falls in and not before, a clear drops what
//                is not yet due, an off leaves no voice, a preload
//                decodes a plan's voices
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { midiPlan } from "../../live/src/export-midi.js";
import { planVoices } from "../../live/src/gm-output.js";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const bankBytes = () => { const b = readFileSync("live/soundfonts/FluidR3Mono_GM.sf3"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// ── planVoices ──────────────────────────────────────────────────────────
const SRC = `(def-score :target midi)
(ch1 gm-piano :tempo 120 :len 4 c e g > c)
(ch2 :bank 1 :prog 33 :oct 2 :len 2 c g)
(ch3 :prog 48 :oct 5 :len 1 c :prog 49 d)
(drum1 :len 4 kick c snare c)
(drum2 :len 8 hat c c c c c c c c)`;
const { ir, diagnostics } = compileMMLisp(SRC, "gm.mmlisp", { voiceStamps: true, voiceHoist: false });
assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
const plan = midiPlan(ir);
const voices = planVoices(plan);
const v = (program, drums = false, msb = 0) => voices.find((x) => x.program === program && x.drums === drums && x.bankMSB === msb);
assert.deepEqual([v(0).lo, v(0).hi], [60, 72], "the piano's keys, c4 to c5");
assert.ok(voices.some((x) => x.program === 33 && x.bankLSB === 1 && x.bankMSB === 0), ":bank 1 is CC0 0, CC32 1");
assert.ok(v(48) && v(49), "a program change between notes: both decoded");
const kit = voices.filter((x) => x.drums);
assert.equal(kit.length, 1, "the drums are one kit, every drum track's keys");
assert.deepEqual([kit[0].lo, kit[0].hi], [36, 42], "kick 36 to hat 42");

// ── The worklet, on stand-ins for its globals ──────────────────────────
const posted = [];
let Processor = null;
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } };
globalThis.registerProcessor = (name, C) => { assert.equal(name, "mmlisp-gm"); Processor = C; };
await import("../../live/src/gm-worklet.js");
const gm = new Processor();
const tell = (data) => gm.port.onmessage({ data });
const replied = async (type) => { for (let i = 0; i < 200 && !posted.some((m) => m.type === type || m.type === "error"); i++) await new Promise((r) => setTimeout(r, 10)); const m = posted.find((x) => x.type === type || x.type === "error"); posted.length = 0; return m; };
tell({ type: "bank", bytes: bankBytes() });
const ready = await replied("ready");
assert.equal(ready?.type, "ready", ready?.message);
assert.ok(ready.presets > 128, "every GM program and the kits");
for (const x of voices) assert.ok(gm.bank.getPreset({ program: x.program, bankMSB: x.bankMSB, bankLSB: x.bankLSB, isGMGSDrum: x.drums }, "gs"), `a preset for ${JSON.stringify(x)}`);
tell({ type: "preload", voices });
const pre = await replied("preloaded");
assert.equal(pre?.type, "preloaded");

const Q = 128;
const L = new Float32Array(Q), R = new Float32Array(Q);
// Render `sec` seconds; the loudest sample of each quantum.
const render = (sec) => {
  const peaks = [];
  for (let n = Math.round((sec * sampleRate) / Q); n > 0; n--) {
    L.fill(0); R.fill(0);
    gm.process([], [[L, R]]);
    globalThis.currentTime += Q / sampleRate;
    peaks.push(Math.max(...L.map(Math.abs), ...R.map(Math.abs)));
  }
  return peaks;
};
const at = (sec) => Math.round((sec * sampleRate) / Q); // the quantum a time falls in
render(0.05);
const t0 = currentTime;
tell({ type: "midi", events: [[[0xc0, 0], t0 + 0.1], [[0x90, 60, 110], t0 + 0.1], [[0x80, 60, 0], t0 + 0.4]] });
let peaks = render(0.6);
assert.ok(Math.max(...peaks.slice(0, at(0.1) - 1)) < 1e-4, "silent before the note is due");
assert.ok(Math.max(...peaks.slice(at(0.1) + 1, at(0.35))) > 0.05, `the piano sounds from its time: ${Math.max(...peaks).toFixed(3)}`);
// A clear drops what is not yet due; what is due already plays.
const t1 = currentTime;
tell({ type: "midi", events: [[[0x90, 64, 110], t1 + 0.3]] });
tell({ type: "clear" });
peaks = render(0.6);
assert.ok(Math.max(...peaks.slice(at(0.35))) < 0.02, `a cleared note never sounds: ${Math.max(...peaks.slice(at(0.35))).toFixed(3)}`);
// An off silences every voice, held or not.
tell({ type: "midi", events: [[[0x91, 33, 0], currentTime], [[0xc1, 48], currentTime], [[0x91, 60, 110], currentTime]] });
peaks = render(0.3);
assert.ok(Math.max(...peaks.slice(at(0.05))) > 0.02, "the strings sound");
tell({ type: "off" });
peaks = render(0.3);
// No voice is left; what is heard is the reverb's tail, near −60 dB.
assert.equal(gm.synth.voiceCount, 0, "an off leaves no voice");
assert.ok(Math.max(...peaks.slice(at(0.05))) < 5e-3, `an off silences them: ${Math.max(...peaks.slice(at(0.05))).toFixed(4)}`);

console.log(`check:gm-output ok — ${voices.length} voices from the plan, ${ready.presets} presets, timing, clear and off in the worklet (preload ${pre.ms} ms)`);
