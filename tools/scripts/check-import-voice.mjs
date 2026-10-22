// The voice importer (live/src/import-voice.js) on a voice it can be checked
// against: a synthesized vowel — a pulse train through three resonators — and
// a hiss. The formants it finds must sit on the resonators, the hiss must land
// on the noise track, and both scores it writes must compile with every track
// the same length. No recording is kept in the repository.
import { analyzeVoice, voiceToMmlisp } from "../../live/src/import-voice.js";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";

const RATE = 16000;
const F = [700, 1200, 2500], BW = 80, PITCH = 120;
const x = new Float32Array(RATE * 1.6);
// 0.1–1.0 s: the vowel; 1.1–1.4 s: the hiss
const res = F.map((f) => ({ r: Math.exp((-Math.PI * BW) / RATE), c: 2 * Math.cos((2 * Math.PI * f) / RATE), y1: 0, y2: 0 }));
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
for (let i = 0; i < x.length; i++) {
  const t = i / RATE;
  let v = 0;
  if (t >= 0.1 && t < 1.0) v = i % Math.round(RATE / PITCH) === 0 ? 1 : 0;
  let s = 0;
  for (const k of res) { const y = v + k.r * k.c * k.y1 - k.r * k.r * k.y2; k.y2 = k.y1; k.y1 = y; s += y; }
  x[i] = s * 0.05;
  if (t >= 1.1 && t < 1.4) x[i] = rnd() * 0.3 * (1 - Math.abs(t - 1.25) / 0.15);
}

const a = analyzeVoice(x, RATE);
const fails = [];
const vowel = [];
for (let i = Math.round(0.2 * 60); i < Math.round(0.9 * 60); i++) vowel.push(i);
const med = (arr) => arr.slice().sort((p, q) => p - q)[arr.length >> 1];
F.forEach((f, s) => {
  const got = med(vowel.map((i) => a.tracks[s][i].f));
  if (Math.abs(got / f - 1) > 0.12) fails.push(`formant ${s + 1}: ${got.toFixed(0)} Hz for ${f} Hz`);
});
const voicedOk = vowel.every((i) => a.active[i] && !a.unvoiced[i]);
if (!voicedOk) fails.push("the vowel is not read as voiced throughout");
const hiss = [];
for (let i = Math.round(1.15 * 60); i < Math.round(1.35 * 60); i++) hiss.push(i);
if (hiss.filter((i) => a.unvoiced[i]).length < hiss.length * 0.8) fails.push("the hiss is not read as unvoiced");
if (Math.abs(a.pitchHz / PITCH - 1) > 0.05) fails.push(`pitch ${a.pitchHz.toFixed(1)} Hz for ${PITCH} Hz`);

for (const mode of ["csm", "sine"]) {
  const { source, warnings } = voiceToMmlisp(a, { mode }, "vowel.wav");
  const r = compileMMLisp(source, `vowel-${mode}.mmlisp`);
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) fails.push(`${mode}: ${errors.map((d) => d.code + " " + d.message).join("; ")}`);
  if (warnings.length) fails.push(`${mode}: ${warnings.join("; ")}`);
  const ends = new Set((r.ir?.tracks ?? []).filter((t) => t.events.some((e) => e.cmd === "NOTE_ON" || e.cmd === "REST"))
    .map((t) => Math.max(...t.events.map((e) => e.tick + (e.args?.length ?? 0)))));
  if (ends.size !== 1) fails.push(`${mode}: the tracks end at ${[...ends].join(", ")} ticks`);
  if (mode === "csm" && !/\(fm3-csm formant\)/.test(source)) fails.push("csm: no note-less fm3-csm track");
  if (mode === "csm" && !/\(fm3-csm-rate /.test(source)) fails.push("csm: no rate track");
}

if (fails.length) {
  console.error("Voice import checks FAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log(`Voice import checks passed: formants ${F.map((f, s) => med(vowel.map((i) => a.tracks[s][i].f)).toFixed(0)).join("/")} Hz for ${F.join("/")}, pitch ${a.pitchHz.toFixed(1)} Hz, csm and sine scores compile`);
