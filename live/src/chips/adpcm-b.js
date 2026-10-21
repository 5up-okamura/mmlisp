// The YM2608's ADPCM-B: one sample voice from its own RAM, pitched in real
// time by Delta-N, repeating its whole range when it loops.
import { words } from "./parts.js";

export const adpcmB = {
  name: "adpcm-b",
  label: "ADPCM-B",
  kind: "sample",
  words: words(/^(?:RANGE|LOOP)_/, "PAN"),
  checkNote({ sample, sampleName, head, mode, target, once }) {
    if (!sample.file)
      once(`file:${sampleName}`, `${sampleName} is the ROM rhythm sound ${sample.rhythm} here, with no :file; ${head} is the ADPCM-B, which plays a sample's :file — play it on ${target.headsOf("rhythm").join(" or ")}, or give it a :file`);
    else if (mode === "loop" && (sample.loopStartSec ?? 0) > (sample.startSec ?? 0))
      once(`loop:${sampleName}`, `the ADPCM-B repeats a sample's whole range; ${sampleName}'s loop starts after its range does — make the range the loop (:pcm-start at the loop's start)`);
  },
};
