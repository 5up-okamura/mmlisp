// THE BROWSER'S IR PREVIEW AGAINST THE DRIVER, FOR PCM (D0: the preview must
// sound like the driver — docs/driver.md §14.3).
//
//   node tools/pcm-ab-gate.mjs [score.mmlisp …]
//
// Two independent routes from one score to the engine's command stream:
//
//   A  IRPlayer (live/src/ir-player.js) dispatches the IR and sends the worklet
//      its PCM events; they are applied here, in time order, through
//      PcmIrVoices — the class the worklet itself runs — against the bank the
//      exporter bakes.
//   B  the MMB through DrvPlayer, the reference driver the C sequencer is
//      byte-identical to (c-gate): the PCM commands of every slot.
//
// Each command is a byte string (START / VOL / RETARGET / MASTER); the two
// streams have to carry the same commands, in the same order, each within a
// frame of the other (IRPlayer runs a continuous clock, the driver a frame
// one — the A/B gate's band). Then both are rendered through the same engine
// model, which is what the ear gets.
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { IRPlayer } from "../../live/src/ir-player.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot } from "../../live/src/slot-builder.js";
import { parsePcmBank } from "../../live/src/pcm-model.js";
import { PcmIrVoices } from "../../live/src/pcm-voices.js";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const SKEW = 1;   // frames
const HORIZON = 240;
let scores = process.argv.slice(2).filter((a) => a.endsWith(".mmlisp"));
if (!scores.length) scores = ["m2-pcm", "m2-pcmloop", "m3-pcm-vol", "m3-pcm-volmix", "m3-pcm-master",
  "m3-pcm-softmix", "m3-pcm-slice", "m3-pcm-sync", "m4-pcm-loop", "m4-pcm-2v-master", "m4-pcm-3v",
  "m4-pcm-loop-curve", "m4-pcm-loop-mode"].map((n) => join(drv, "tests", `${n}.mmlisp`));

const hex = (c) => c.map((b) => b.toString(16).padStart(2, "0")).join(" ");
let failed = 0;
for (const path of scores) {
  const name = basename(path, ".mmlisp");
  const { bytes, sampleBank, pcmEntryIds, ir } = buildMmb(path);
  const bank = { ...parsePcmBank(sampleBank), entryIds: pcmEntryIds ?? {} };

  // A: the IR route.
  const irp = new IRPlayer(() => {});
  irp.loadJSON(ir);
  const cap = irp.captureRegisterLog({ maxSec: 8 });
  const events = cap.pcmEvents
    .map((e, i) => ({ ...e, i }))
    .sort((x, y) => x.sec - y.sec || x.i - y.i);
  const A = [];
  let at = 0;
  const seq = new PcmIrVoices((c) => A.push({ frame: at, c: [...c] }), bank);
  for (const e of events) { at = Math.max(0, Math.round(e.sec * 60)); seq.apply(e); }
  // Four seconds: a PCM-only score has almost no register writes, so the
  // capture's own end (the last FM/PSG write) says nothing about its length.
  const horizon = HORIZON;

  // B: the driver route.
  const player = new DrvPlayer();
  player.loadMMB(bytes, sampleBank);
  const slots = player.captureSlotLog({ maxFrames: horizon + SKEW + 1, builder: new SlotBuilder() }).slots;
  const B = [];
  slots.forEach((s, f) => { for (const c of decodeSlot(s).pcm) B.push({ frame: f, c: [...c] }); });

  const a = A.filter((x) => x.frame <= horizon), b = B.filter((x) => x.frame <= horizon);
  const problems = [];
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n && problems.length < 3; k++) {
    if (hex(a[k].c) !== hex(b[k].c))
      problems.push(`command ${k}: IR [${hex(a[k].c)}] @f${a[k].frame}, driver [${hex(b[k].c)}] @f${b[k].frame}`);
    else if (Math.abs(a[k].frame - b[k].frame) > SKEW)
      problems.push(`command ${k} [${hex(a[k].c)}]: IR frame ${a[k].frame}, driver frame ${b[k].frame}`);
  }
  if (a.length !== b.length && problems.length < 3)
    problems.push(`IR sent ${a.length} commands, the driver ${b.length}`
      + (a.length > n ? `; first extra IR [${hex(a[n].c)}] @f${a[n].frame}` : `; first extra driver [${hex(b[n].c)}] @f${b[n].frame}`));
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "ok  "}  ${name.padEnd(20)} ${a.length} PCM commands over ${horizon} frames`);
  for (const p of problems) console.log(`      ${p}`);
}
console.log(failed ? `\nFAIL: ${failed} of ${scores.length} scores` : `\n${scores.length} scores: the IR preview sends the driver's PCM commands`);
process.exit(failed ? 1 : 0);
