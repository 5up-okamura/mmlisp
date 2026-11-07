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
//                decodes a plan's voices, a close ends the processor, a
//                quantum that runs four times its time is reported ('late')
//   preload      a plan preloaded again sends nothing; a key past what was
//                decoded sends that voice alone, its range widened; two in
//                flight are answered in order
//   the pitches  a lane's frequency is its key under its wheel and bend
//                range, the drums' none
//   a render     `:target midi`'s WAV (export-wav.js → gm-render.js): a loop
//                twice and the fade, a one-shot to its release's end, a solo
//                its track alone, GM Reverb's level, and none without a
//                SoundFont
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { midiPlan } from "../../live/src/export-midi.js";
import { planVoices, GmOutput } from "../../live/src/gm-output.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { GmSynth } from "../../live/src/gm-synth.js";
import { renderWavSamples } from "../../live/src/export-wav.js";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a.toFixed(3)} vs ${b}`);
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
for (const x of voices) assert.ok(gm.gm.bank.getPreset({ program: x.program, bankMSB: x.bankMSB, bankLSB: x.bankLSB, isGMGSDrum: x.drums }, "gs"), `a preset for ${JSON.stringify(x)}`);
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
assert.equal(gm.gm.synth.voiceCount, 0, "an off leaves no voice");
assert.ok(Math.max(...peaks.slice(at(0.05))) < 5e-3, `an off silences them: ${Math.max(...peaks.slice(at(0.05))).toFixed(4)}`);

// A close lets the bank go and ends the processor (process() false), so a
// node switched away from is collected, not kept playing silence.
tell({ type: "close" });
assert.equal(gm.process([], [[L, R]]), false, "a closed processor ends");
assert.equal(gm.gm.bank, null, "and holds no bank");

// A run late: one quantum four times its time is said ('late', after its
// window), none at all is not.
{
  const late = new Processor();
  let slow = false;
  late.gm.render = () => { if (!slow) return; const t = performance.now(); while (performance.now() - t < 12); };
  posted.length = 0;
  const step = (n, slowAt = -1) => { for (let i = 0; i < n; i++) { slow = i === slowAt; late.process([], [[L, R]]); globalThis.currentTime += Q / sampleRate; } };
  step(Math.ceil((2.2 * sampleRate) / Q));
  assert.ok(!posted.some((m) => m.type === "late"), "nothing late, nothing said");
  step(Math.ceil((2.2 * sampleRate) / Q), 10);
  const said = posted.find((m) => m.type === "late");
  assert.ok(said && said.worst >= 12, `a quantum 12 ms long is said: ${JSON.stringify(said)}`);
}

// ── GmOutput.preload: only what no plan before asked for ───────────────
{
  const sent = [];
  const out = new GmOutput({ loadBank: null });
  out.node = { port: { postMessage: (m) => { sent.push(m); queueMicrotask(() => out.pending.get("preloaded")?.shift()?.({ type: "preloaded", ms: 0 })); } } };
  await out.preload(plan);
  await out.preload(plan); // a slider's replan: nothing again
  assert.equal(sent.length, 1, "a plan preloaded again sends nothing");
  const wider = midiPlan(compileMMLisp(SRC.replace("(ch1 gm-piano :tempo 120 :len 4 c e g > c)", "(ch1 gm-piano :tempo 120 :len 4 c e g > c > c)"), "gm.mmlisp", { voiceStamps: true, voiceHoist: false }).ir);
  await out.preload(wider);
  assert.equal(sent.length, 2, "a key past the range preloads again");
  assert.deepEqual(sent[1].voices.map((x) => [x.program, x.lo, x.hi]), [[0, 60, 84]], "only that voice, its range widened");
  // Two preloads in flight are answered in order, neither left hanging.
  const two = new GmOutput({ loadBank: null });
  const replies = [];
  two.node = { port: { postMessage: (m) => { if (m.type === "preload") replies.push(m.voices.length); } } };
  const a1 = two.preload(plan), a2 = two.preload(wider);
  assert.equal(replies.length, 2, "both asked before either is answered");
  two.pending.get("preloaded").shift()({ type: "preloaded", ms: 1 });
  two.pending.get("preloaded").shift()({ type: "preloaded", ms: 2 });
  assert.deepEqual(await Promise.all([a1, a2]), [1, 2], "each resolves with its own answer");
}

// ── The pitch each lane reports: the key under its bend, the drums none ──
{
  const gm = new GmSynth(48000);
  gm.follow([0x90, 69, 100]);
  gm.follow([0x99, 36, 100]);
  const f = gm.freqs();
  near(f[0], 440, 0.01, "a4 on ch1");
  assert.equal(f[9], 0, "the drums' channel is unpitched");
  gm.follow([0xb0, 101, 0]); gm.follow([0xb0, 100, 0]); gm.follow([0xb0, 6, 12]); // bend range 12
  gm.follow([0xe0, 0, 0x60]); // wheel +4096 of 8192: half the range, +6 semitones
  near(gm.freqs()[0], 440 * 2 ** 0.5, 0.01, "a4 bent up a tritone");
  gm.follow([0x80, 69, 0]);
  assert.equal(gm.freqs()[0], 0, "let go, none");
}

// ── A render (export-wav.js → gm-render.js): the WAV export's length ──
{
  const render = async (src, solo = null) => {
    const r = compileMMLisp(src, "render.mmlisp");
    const player = new IRPlayer(() => {}).loadJSON(r.ir);
    if (solo != null) player.soloTrack(solo, true);
    return renderWavSamples(player, { gmBank: bankBytes() });
  };
  const peak = (x, a, b) => { let m = 0; for (let i = Math.floor(a); i < Math.min(x.length, b); i++) m = Math.max(m, Math.abs(x[i])); return m; };
  // 120 BPM: a bar is 2 s. A loop of one bar: intro (none) + 2 passes + the 4 s fade.
  const loop = await render("(def-score :target midi)\n(ch1 gm-piano :tempo 120 :len 4 #top c e g e (go top))");
  near(loop.durationSec, 2 + 2 + 4, 0.01, "a looping score: its loop twice and the fade");
  assert.ok(peak(loop.L, 2.05 * 48000, 3.9 * 48000) > 0.05, "the second pass sounds");
  assert.ok(peak(loop.L, loop.L.length - 480, loop.L.length) < 0.01, "and fades out");
  // A one-shot: to where its last voice has faded, past its last note.
  const once = await render("(def-score :target midi)\n(ch1 gm-piano :tempo 120 :len 4 c e g > c)");
  assert.ok(once.durationSec > 2 && once.durationSec < 2 + 8, `a one-shot ends after its release: ${once.durationSec.toFixed(2)} s`);
  // A solo (a stem's strip): only its track sounds. ch1 the first bar, drum1 the second.
  const two = "(def-score :target midi)\n(ch1 gm-piano :tempo 120 :len 4 c e g e _1)\n(drum1 :len 1 _ :len 4 kick c c c c)";
  const piano = await render(two, 0), drums = await render(two, 1);
  assert.ok(peak(piano.L, 0, 1.9 * 48000) > 0.05 && peak(piano.L, 3 * 48000, 3.9 * 48000) < 0.01, "ch1 soloed: the piano, not the kick");
  assert.ok(peak(drums.L, 0, 1.9 * 48000) < 0.01 && peak(drums.L, 2.05 * 48000, 3.9 * 48000) > 0.05, "drum1 soloed: the kick, not the piano");
  // GM Reverb: Off leaves a note's tail dry; Full rings on after it.
  const stab = "(def-score :target midi)\n(ch1 gm-piano :tempo 120 :len 16 c _2.)";
  const wet = await renderWavSamples(new IRPlayer(() => {}).loadJSON(compileMMLisp(stab, "r.mmlisp").ir), { gmBank: bankBytes(), gmReverb: 1 });
  const dry = await renderWavSamples(new IRPlayer(() => {}).loadJSON(compileMMLisp(stab, "r.mmlisp").ir), { gmBank: bankBytes(), gmReverb: 0 });
  const tail = (x) => peak(x.L, 0.9 * 48000, Math.min(x.L.length, 1.2 * 48000));
  assert.ok(tail(wet) > 3 * tail(dry), `reverb Full rings past the note, Off does not: ${tail(wet).toExponential(1)} vs ${tail(dry).toExponential(1)}`);
  // No SoundFont, no render: it says why.
  await assert.rejects(renderWavSamples(new IRPlayer(() => {}).loadJSON(compileMMLisp("(def-score :target midi)\n(ch1 c)", "x.mmlisp").ir), {}), /needs a SoundFont/);
}

console.log(`check:gm-output ok — ${voices.length} voices from the plan, ${ready.presets} presets, the worklet's timing, clear, off and close, the render's length and solo (preload ${pre.ms} ms)`);
