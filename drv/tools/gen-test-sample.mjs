#!/usr/bin/env node
// Writes drv/tests/pcmbank.wav — the PCM fixture the loop gates play.
//
// The fixture is synthesized here rather than sampled from a recording, so the
// repository owns every byte of it. Ten 150 ms segments alternate a decaying
// tone and a decaying pseudo-noise burst, each at its own pitch, so a loop
// whose start or length moves across the sample lands on audibly different
// material at every offset the gates ask for. Deterministic: same bytes on
// every run.
//
//   node drv/tools/gen-test-sample.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 10000; // Hz, the rate the loop tests quote their offsets in
const SEG_MS = 150;
const SEGMENTS = 10; // → 1,500 ms
const SEG_FRAMES = Math.round((RATE * SEG_MS) / 1000);

// Tone pitches, one per segment, walking a scale so each region is distinct.
const HZ = [220, 277, 330, 415, 494, 587, 659, 831, 988, 147];

// A 16-bit LCG stands in for noise: no Math.random, so the file is reproducible.
let seed = 0x2f6e;
const noise = () => {
  seed = (seed * 25173 + 13849) & 0xffff;
  return seed / 32768 - 1;
};

const frames = SEG_FRAMES * SEGMENTS;
const pcm = Buffer.alloc(frames * 2);
for (let s = 0; s < SEGMENTS; s++) {
  const tone = s % 2 === 0; // even: tone, odd: noise burst
  const hz = HZ[s];
  for (let i = 0; i < SEG_FRAMES; i++) {
    const t = i / RATE;
    const env = Math.exp(-t * (tone ? 9 : 26)); // percussive decay
    const v = tone ? Math.sin(2 * Math.PI * hz * t) : noise();
    const sample = Math.max(-1, Math.min(1, v * env * 0.85));
    pcm.writeInt16LE(Math.round(sample * 32767), (s * SEG_FRAMES + i) * 2);
  }
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // format: PCM
header.writeUInt16LE(1, 22); // channels
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "pcmbank.wav");
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`wrote ${out} — ${frames} frames, ${(frames / RATE) * 1000} ms at ${RATE} Hz`);
