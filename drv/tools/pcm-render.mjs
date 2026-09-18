// Render a score's PCM as the driver's DAC plays it — for listening.
//
//   npm run pcm-render -- <score.mmlisp> [--seconds N] [--out FILE.wav]
//
// The reference driver (drv-player.js) runs the score and its slots' PCM
// commands drive the engine model (pcm-model.js, gated against the images
// byte for byte by engine:gate) at the score's image rate. Each frame's
// commands land at that frame's first engine sample, on the NTSC video clock.
// The WAV is 8-bit at the image's own rate, so a player holds each byte for one
// engine sample exactly as the DAC does; FM and PSG are not in it.
import { writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot } from "../../live/src/slot-builder.js";
import { PcmLiveEngine } from "../../live/src/pcm-model.js";
import { engineImage } from "../../live/src/engine-images.js";
import { NTSC } from "../engine/config.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".mmlisp"));
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
if (!file) {
  console.error("usage: npm run pcm-render -- <score.mmlisp> [--seconds N] [--out FILE.wav]");
  process.exit(2);
}
const seconds = Number(opt("--seconds", 10));
const out = opt("--out", join(dirname(fileURLToPath(import.meta.url)), "..", "out", "pcm-render",
  `${basename(file, ".mmlisp")}.wav`));

const { bytes, sampleBank, diagnostics } = buildMmb(file);
for (const d of diagnostics ?? []) if (d.severity === "error") { console.error(d.message ?? d); process.exit(1); }
const player = new DrvPlayer();
player.loadMMB(bytes, sampleBank);
const image = engineImage(player._song.pcmVoices || 1);
const engine = new PcmLiveEngine(image, sampleBank);

const frameHz = NTSC.masterHz / NTSC.frameMaster;
const frames = Math.ceil(seconds * frameHz);
const slots = player.captureSlotLog({ maxFrames: frames, builder: new SlotBuilder() }).slots;

const total = Math.floor(seconds * image.rateHz);
const pcm = new Uint8Array(total);
let n = 0, commands = 0;
for (let f = 0; f < frames && n < total; f++) {
  if (slots[f]) for (const c of decodeSlot(slots[f]).pcm) { engine.apply(c); commands++; }
  const upTo = Math.min(total, Math.floor(((f + 1) * image.rateHz) / frameHz));
  while (n < upTo) pcm[n++] = engine.next();
}
while (n < total) pcm[n++] = engine.next();

// 8-bit PCM WAV is unsigned with 0x80 as silence — the engine's biased byte.
const rate = Math.round(image.rateHz);
const hdr = Buffer.alloc(44);
hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + total, 4); hdr.write("WAVE", 8);
hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate, 28); hdr.writeUInt16LE(1, 32); hdr.writeUInt16LE(8, 34);
hdr.write("data", 36); hdr.writeUInt32LE(total, 40);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([hdr, Buffer.from(pcm)]));
console.log(`${out} · pcm${image.voices} ${image.rateHz.toFixed(1)} Hz · ${seconds} s · ${commands} PCM commands`);
