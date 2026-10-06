import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildMultibankImage } from "./build-multibank.mjs";
import { buildMultibankScore } from "./multibank-score.mjs";
import { runMultibank } from "./multibank-run.mjs";

const args = process.argv.slice(2);
const opt = (name, value) => args.includes(name) ? args[args.indexOf(name) + 1] : value;
const file = args.find((s) => s.endsWith(".mmlisp"));
if (!file) throw new Error("usage: node drv/tools/multibank-render.mjs score.mmlisp [--seconds 8] [--out drv/out/multibank]");
const seconds = Number(opt("--seconds", 8));
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("seconds must be positive");
const out = resolve(opt("--out", "drv/out/multibank"));
const image = buildMultibankImage();
const score = buildMultibankScore(file, { frames: Math.ceil(seconds * 60), idleAfterGen: image.gen.idleAfterGen,
  separateBanks: args.includes("--separate-banks") });
// Let commands emitted at the requested end drain through the finite FIFO.
const run = runMultibank(image, score.rom, score.items, { seconds: seconds + 1 });
if (run.fail.length) throw new Error(run.fail.join("\n"));
const pcm = Buffer.from(run.machine.trace.dacValue);
const hdr = Buffer.alloc(44), rate = Math.round(image.cfg.rateHz);
hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate, 28); hdr.writeUInt16LE(1, 32); hdr.writeUInt16LE(8, 34);
hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "pcm.wav"), Buffer.concat([hdr, pcm]));
writeFileSync(join(out, "engine.bin"), image.bytes);
writeFileSync(join(out, "engine.z80"), image.gen.text);
writeFileSync(join(out, "samples.rom"), score.rom);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ experimental: true, voices: 2,
  sourceVoices: score.sourceVoices, separateBanks: score.separateBanks,
  rateHz: image.cfg.rateHz, usedBytes: score.usedBytes, banks: score.banks,
  entries: score.entries, entryIds: score.entryIds, time: run.time, pairs: run.pairs,
  codeBytes: image.symbols.get("code_end"), idleAfterGen: image.gen.idleAfterGen }, null, 2) + "\n");
console.log(`${out}: ${score.usedBytes} B PCM in ${score.banks} data banks, `
  + `${image.cfg.rateHz.toFixed(3)} Hz, every DAC byte matches, gap ${run.time.gapMin}..${run.time.gapMax}`);
console.log("Experimental Z80 PCM WAV; FM/PSG audio is not included. Not a production .smp or driver installation.");
