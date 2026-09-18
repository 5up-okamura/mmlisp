// THE LOOP A NOTE PLAYS — checked against what the score says, not against
// another implementation. pcm-ab and c-gate prove the IR preview, the JS
// driver and the C agree; they share pcm-voices.js's rules, so a wrong rule
// passes both. This gate derives each note's END/WRAP from the language
// (docs/language.md §16) and checks the driver's START commands carry them.
//
//   node tools/pcm-loop-gate.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot, PCM_START } from "../../live/src/slot-builder.js";
import { parsePcmBank, pcmLoopPoints, pcmShotPoints, PCM_WINDOW } from "../../live/src/pcm-model.js";
import { engineImage } from "../../live/src/engine-images.js";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "..", "tests", "m4-pcm-loop-mode.mmlisp");
const { bytes, sampleBank, pcmEntryIds } = buildMmb(path);
const { entries } = parsePcmBank(sampleBank);
const R = engineImage(1).rateHz;
const at = (sec) => Math.round(sec * R);     // a track's time → playback bytes
const entry = (name) => {
  const e = entries[pcmEntryIds[`${name}|60`]];
  return { ...e, src: PCM_WINDOW + (e.base & 0x7fff) };
};
const pad = entry("pad"), voice = entry("voice");
const loop = (e, ls, le) => pcmLoopPoints(e.src, e.len, ls, le);
const sixteenth = 60 / 120 / 4;

const want = [
  ["shot on a looping def plays once", pad, pcmShotPoints(pad.src, pad.len)],
  ["loop on a def with no loop: the whole sample", voice, loop(voice, 0, voice.loopEnd)],
  ["track loop written before the note", voice, loop(voice, at(0.1), at(0.1) + at(sixteenth))],
  ["…sticky for the next note", voice, loop(voice, at(0.1), at(0.1) + at(sixteenth))],
  [":loop-end pins the end, the start holds", voice, loop(voice, at(0.1), at(0.3))],
  [":mode shot turns the loop off", pad, pcmShotPoints(pad.src, pad.len)],
];

const player = new DrvPlayer();
player.loadMMB(bytes, sampleBank);
const starts = [];
for (const s of player.captureSlotLog({ maxFrames: 400, builder: new SlotBuilder() }).slots)
  for (const c of decodeSlot(s).pcm) if (c[0] === PCM_START) starts.push(c);

const w16 = (c, k) => c[k] | (c[k + 1] << 8);
let failed = 0;
want.forEach(([what, e, pts], i) => {
  const c = starts[i];
  const got = c && { src: w16(c, 3), end: w16(c, 5), wrap: w16(c, 7) };
  const ok = got && got.src === e.src && got.end === pts.end && got.wrap === pts.wrap;
  if (!ok) failed++;
  const hex = (x) => x?.toString(16);
  console.log(`${ok ? "ok  " : "FAIL"}  note ${i + 1}  ${what}`
    + (ok ? "" : `: want src ${hex(e.src)} end ${hex(pts.end)} wrap ${hex(pts.wrap)}, `
      + `got ${got ? `src ${hex(got.src)} end ${hex(got.end)} wrap ${hex(got.wrap)}` : "no START"}`));
});
if (starts.length !== want.length) {
  failed++;
  console.log(`FAIL  ${starts.length} STARTs, want ${want.length}`);
}
console.log(failed ? `\nFAIL: ${failed}` : `\n${want.length} notes play the loop the score says`);
process.exit(failed ? 1 : 0);
