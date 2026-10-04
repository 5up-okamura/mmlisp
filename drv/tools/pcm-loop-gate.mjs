// WHAT A NOTE PLAYS OF ITS FOUR POINTS — the range, and the loop inside it —
// checked against what the score says, not against another implementation.
// pcm-ab and c-gate prove the IR preview, the JS driver and the C agree; they
// share pcm-voices.js's rules, so a wrong rule passes both. This gate derives
// each note's START/END/WRAP from the language (docs/language.md §16) and
// checks the driver's START commands carry them, and the RETARGET a loop
// note's release sends.
//
//   node tools/pcm-loop-gate.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot, PCM_START, PCM_RETARGET } from "../../live/src/slot-builder.js";
import { parsePcmBank, pcmLoopPoints, pcmRangePoints, PCM_WINDOW, PCM_BLOCK, PCM_SILENCE_ADDR } from "../../live/src/pcm-model.js";
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
const pad = entry("pad"), voice = entry("voice"), strings = entry("strings");
// A shot plays the range once; a held loop note starts at the range's start
// and repeats the loop; a released one plays on to the range's end.
const once = (e, rs, re) => pcmRangePoints(e.src, e.len, rs, re);
const loop = (e, rs, ls, le) => {
  const lp = pcmLoopPoints(e.src, e.len, ls, le);
  return { start: e.src + Math.min(Math.floor(rs / PCM_BLOCK) * PCM_BLOCK, lp.loopStart),
    end: lp.end, wrap: lp.wrap };
};
const sixteenth = 60 / 120 / 4;
// The defs' points, as the bank carries them: the def's times at the blob's rate.
const S = strings;

const want = [
  ["shot on a def with a range plays it once", once(pad, pad.rangeStart, pad.rangeEnd)],
  ["shot on a def with no points: the whole sample", once(voice, 0, voice.len)],
  ["loop on a def with no points: the whole sample", loop(voice, 0, 0, voice.len)],
  ["loop on a def with all four: from :pcm-start into its loop",
    loop(S, S.rangeStart, S.loopStart, S.loopEnd)],
  ["shot on that def plays the range, not the loop", once(S, S.rangeStart, S.rangeEnd)],
  ["track loop written before the note", loop(voice, 0, at(0.1), at(0.1) + at(sixteenth))],
  ["…sticky for the next note", loop(voice, 0, at(0.1), at(0.1) + at(sixteenth))],
  [":loop-end pins the loop's end, its start holds", loop(voice, 0, at(0.1), at(0.3))],
  [":pcm-start moves where the note starts; the loop stays", loop(voice, at(0.05), at(0.1), at(0.3))],
  [":mode shot plays the track's range once", once(voice, at(0.05), voice.len)],
];
// Note 4's note-off: END moves to the range's end, WRAP to silence.
const wantRelease = { end: once(S, S.rangeStart, S.rangeEnd).end, wrap: PCM_SILENCE_ADDR };

const player = new DrvPlayer();
player.loadMMB(bytes, sampleBank);
const starts = [];
let release = null;
for (const slot of player.captureSlotLog({ maxFrames: 400, builder: new SlotBuilder() }).slots)
  for (const c of decodeSlot(slot).pcm) {
    if (c[0] === PCM_START) starts.push(c);
    else if (c[0] === PCM_RETARGET && starts.length === 4 && !release) release = c;
  }

const w16 = (c, k) => c[k] | (c[k + 1] << 8);
let failed = 0;
want.forEach(([what, pts], i) => {
  const c = starts[i];
  const got = c && { src: w16(c, 3), end: w16(c, 5), wrap: w16(c, 7) };
  const ok = got && got.src === pts.start && got.end === pts.end && got.wrap === pts.wrap;
  if (!ok) failed++;
  const hex = (x) => x?.toString(16);
  console.log(`${ok ? "ok  " : "FAIL"}  note ${i + 1}  ${what}`
    + (ok ? "" : `: want src ${hex(pts.start)} end ${hex(pts.end)} wrap ${hex(pts.wrap)}, `
      + `got ${got ? `src ${hex(got.src)} end ${hex(got.end)} wrap ${hex(got.wrap)}` : "no START"}`));
});
{
  const got = release && { end: w16(release, 2), wrap: w16(release, 4) };
  const ok = got && got.end === wantRelease.end && got.wrap === wantRelease.wrap;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  note 4's release plays on to :pcm-end`
    + (ok ? "" : `: want end ${wantRelease.end.toString(16)} wrap ${wantRelease.wrap.toString(16)}, `
      + `got ${got ? `end ${got.end.toString(16)} wrap ${got.wrap.toString(16)}` : "no RETARGET"}`));
}
if (starts.length !== want.length) {
  failed++;
  console.log(`FAIL  ${starts.length} STARTs, want ${want.length}`);
}
console.log(failed ? `\nFAIL: ${failed}` : `\n${want.length} notes play the points the score says`);
process.exit(failed ? 1 : 0);
