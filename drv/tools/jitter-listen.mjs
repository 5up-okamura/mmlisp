// IS BOUNDED DAC JITTER AUDIBLE? A listening set for the Z80-only PCM scheme
// (.claude/memory/plan-z80-only.md): the same 8-bit PCM at the same mean rate,
// written to the DAC on a perfect clock and with each write late by up to N
// Z80 cycles.
//
//   node tools/jitter-listen.mjs [--out DIR] [--rate-period 249] [--seed 1]
//
// The model, and what it leaves out:
// - Sample i is due at i × period Z80 cycles and written at due + delay, never
//   before the previous write (a late poll writes overdue samples back to
//   back; two landing inside one YM output tick means the first is never heard,
//   as on the chip).
// - The YM2612 does not play a DAC write when it lands: it reads the DAC
//   register once per output sample, 7,670,453 / 144 = 53,267 Hz, i.e. every
//   67.2 Z80 cycles. So the chip itself already places each write up to one
//   tick late, deterministically — jitter well under 67 cycles mostly vanishes
//   into that grid. The render reads the DAC value on that grid, then
//   resamples 53,267 → 48,000 Hz with a windowed sinc (a cutoff at 22 kHz) so
//   every player plays the files as they are.
// - No analog output filter. A Mega Drive's is a low-pass whose corner varies
//   by model; it would soften the high-frequency part of the jitter noise, so
//   these files are the stricter test.
//
// Two shapes of delay:
// - `rand`:  every sample late by U(0, N).
// - `frame`: late by U(0, N) only while the sequencer runs — the first 35% of
//   each 60 Hz frame (demo1's mean on the archived Z80 sequencer) — and on
//   time for the rest. The jitter then comes and goes 60 times a second, which
//   is how a poll-point driver would actually behave.
//
// Content, 14 s, the same in every file: a 440 Hz sine (the most revealing),
// a pad held at three pitches, then an 808 kick/snare/hat groove over the pad.
// It is mixed in float at the DAC rate and quantized to 8 bits once, so the
// only difference between two files is when each byte reached the chip.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWav } from "./wav.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg("out", join(here, "..", "out", "jitter"));
const PERIOD = Number(arg("rate-period", 249));      // Z80 cycles a sample (pcm1's)
const SEED = Number(arg("seed", 1));

const Z80 = 3579545;
const YM_RATE = 7670453 / 144;
const YM_TICK = Z80 / YM_RATE;                        // 67.2 Z80 cycles
const FRAME = Z80 / 60;
const DAC_RATE = Z80 / PERIOD;
const OUT_RATE = 48000;
const SECONDS = 14;
const LEVELS = [0, 30, 100, 300, 600];
const BUSY = 0.35;

// ── the content, at the DAC rate ─────────────────────────────────────────
function resampleLinear(data, from, to) {
  const n = Math.floor(data.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * from / to, j = Math.floor(x), f = x - j;
    out[i] = (data[j] ?? 0) * (1 - f) + (data[j + 1] ?? 0) * f;
  }
  return out;
}
function sampleAt(path, semis = 0) {
  const w = loadWav(join(root, path));
  return resampleLinear(w.data, w.sampleRate * 2 ** (semis / 12), DAC_RATE);
}
function content() {
  const n = Math.floor(SECONDS * DAC_RATE);
  const buf = new Float32Array(n);
  const at = (sec) => Math.floor(sec * DAC_RATE);
  const add = (src, start, gain, len = src.length) => {
    for (let i = 0; i < len && start + i < n; i++) buf[start + i] += src[i % src.length] * gain;
  };
  // 0–3 s: sine
  for (let i = 0; i < at(3); i++) buf[i] = 0.7 * Math.sin(2 * Math.PI * 440 * i / DAC_RATE);
  // 3.5–7 s: the pad at three pitches, looped to length
  const padLen = at(1.1);
  [0, -5, 3].forEach((s, k) => add(sampleAt("drv/tests/pad.wav", s), at(3.5 + k * 1.15), 0.6, padLen));
  // 7.5–14 s: groove, 120 BPM sixteenths, over the pad
  const kick = sampleAt("presets/808/wav/036-bass-drum-1.wav");
  const snare = sampleAt("presets/808/wav/038-acoustic-snare.wav");
  const hat = sampleAt("presets/808/wav/042-closed-hi-hat.wav");
  const pad = sampleAt("drv/tests/pad.wav", -12);
  const step = 0.125;
  for (let s = 0; s < 52; s++) {
    const t = at(7.5 + s * step), b = s % 16;
    if (b === 0 || b === 6 || b === 10) add(kick, t, 0.55);
    if (b === 4 || b === 12) add(snare, t, 0.45);
    add(hat, t, b % 2 ? 0.15 : 0.25);
  }
  add(pad, at(7.5), 0.25, at(6.5));
  // quantize once: the 8-bit DAC byte
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const q = new Uint8Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.max(0, Math.min(255, Math.round(128 + 127 * buf[i] / peak)));
  return q;
}

// ── write times, then what the chip plays ────────────────────────────────
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
}
function writeTimes(n, N, shape) {
  const r = rng(SEED);
  const t = new Float64Array(n);
  let prev = -Infinity, late = 0, maxLate = 0;
  for (let i = 0; i < n; i++) {
    const due = i * PERIOD;
    const busy = shape === "rand" || (due % FRAME) < BUSY * FRAME;
    let w = due + (busy ? r() * N : 0);
    if (w < prev) w = prev;                      // never out of order
    t[i] = prev = w;
    late += w - due;
    maxLate = Math.max(maxLate, w - due);
  }
  return { t, meanLate: late / n, maxLate };
}
function ymRender(bytes, t) {
  const n = Math.floor(SECONDS * YM_RATE);
  const out = new Float32Array(n);
  let j = -1, lost = 0;
  for (let k = 0; k < n; k++) {
    const now = k * YM_TICK;
    const before = j;
    while (j + 1 < bytes.length && t[j + 1] <= now) j++;
    if (j - before > 1) lost += j - before - 1;   // overwritten before the chip read them
    out[k] = j < 0 ? 0 : (bytes[j] - 128) / 128;
  }
  return { out, lost };
}
function sincResampleWide(x, from, to) { return sincResample(x, from, to, 256); }
function sincResample(x, from, to, W = 32) {
  const n = Math.floor(x.length * to / from);
  const fc = Math.min(22000, to / 2 * 0.92) / from;  // cutoff, cycles per input sample
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * from / to, j0 = Math.floor(c);
    let acc = 0, norm = 0;
    for (let j = j0 - W + 1; j <= j0 + W; j++) {
      const d = j - c;
      const s = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
      const w = 0.42 + 0.5 * Math.cos(Math.PI * d / W) + 0.08 * Math.cos(2 * Math.PI * d / W);
      const k = s * (Math.abs(d) < W ? w : 0);
      acc += (x[j] ?? 0) * k;
      norm += k;
    }
    y[i] = acc / norm;
  }
  return y;
}
function wav16(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * 0.8)) * 32767), 44 + i * 2);
  return b;
}

// ── the set ──────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const bytes = content();
console.log(`DAC ${DAC_RATE.toFixed(2)} Hz (period ${PERIOD} Z80 cycles), YM tick ${YM_TICK.toFixed(1)} cycles, ${SECONDS} s`);
{
  // Baseline: the chip's own grid. The on-time writes rendered at 1/8 of a YM
  // tick (a near-ideal hold) against the same writes read on the 53 kHz grid.
  const OS = 8, n = Math.floor(SECONDS * YM_RATE * OS);
  const fine = new Float32Array(n);
  for (let k = 0, j = -1; k < n; k++) {
    while (j + 1 < bytes.length && (j + 1) * PERIOD <= k * YM_TICK / OS) j++;
    fine[k] = j < 0 ? 0 : (bytes[j] - 128) / 128;
  }
  const ideal = sincResampleWide(fine, YM_RATE * OS, OUT_RATE);
  const grid = sincResample(ymRender(bytes, Float64Array.from({ length: bytes.length }, (_, i) => i * PERIOD)).out, YM_RATE, OUT_RATE);
  let e = 0, p = 0;
  for (let k = 0; k < Math.min(ideal.length, grid.length); k++) { e += (grid[k] - ideal[k]) ** 2; p += ideal[k] ** 2; }
  console.log(`the YM's own 67-cycle grid, on-time writes vs an ideal hold: ${(10 * Math.log10(p / e)).toFixed(1)} dB below signal`);
}
const cases =[["rand", 0], ...LEVELS.slice(1).flatMap((N) => [["rand", N], ["frame", N]])];
console.log("file                     mean late  max late  lost  error vs N=0 (dB below signal)");
for (const [shape, N] of cases) {
  const { t, meanLate, maxLate } = writeTimes(bytes.length, N, shape);
  const { out, lost } = ymRender(bytes, t);
  // Compare against a render every write of which is late by the same mean
  // amount, so a constant delay is not counted as error — only the jitter is.
  // Measured on the 48 kHz output, i.e. what reaches the ear below 22 kHz.
  let err = "—";
  const heard = sincResample(out, YM_RATE, OUT_RATE);
  if (N > 0) {
    const steady = Float64Array.from({ length: bytes.length }, (_, i) => i * PERIOD + meanLate);
    const r = sincResample(ymRender(bytes, steady).out, YM_RATE, OUT_RATE);
    let e = 0, p = 0;
    for (let k = 0; k < r.length; k++) { e += (heard[k] - r[k]) ** 2; p += r[k] ** 2; }
    err = (10 * Math.log10(p / e)).toFixed(1);
  }
  const name = N === 0 ? "jitter-0-reference.wav" : `jitter-${String(N).padStart(3, "0")}-${shape}.wav`;
  writeFileSync(join(OUT, name), wav16(heard, OUT_RATE));
  console.log(name.padEnd(24), meanLate.toFixed(0).padStart(9), maxLate.toFixed(0).padStart(9), String(lost).padStart(5), err.padStart(10));
}
console.log(`→ ${OUT}`);
