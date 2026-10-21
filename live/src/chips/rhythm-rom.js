// The YM2608's rhythm: six sounds in the chip's ROM, keyed by one register,
// each a voice of its own with its own level and pan. They are the kits'
// roles of the same name (guide.md, the kits), built in where a score
// defines none; a sound has no pitch, no loop and no range, and a def's :fx
// does not reach it.
import { pitchToMidi } from "../ir-utils.js";
import { words } from "./parts.js";

export const rhythmRom = {
  name: "rhythm",
  label: "ROM rhythm",
  kind: "sample",
  words: words("PAN"), // each hit's, with its level
  points: false,
  kit: { kick: "bd", snare: "sd", ride: "top", hat: "hh", tom4: "tom", rim: "rim" },
  // A hit sounds on its sound: the `:prio` layers of one track compete only
  // with the same sound's notes, and one track plays all six at once.
  voiceOf(ev, sampleDefs) {
    return ev.cmd === "PCM_NOTE_ON" ? sampleDefs.get(ev.args?.sample)?.rhythm ?? "" : "";
  },
  checkNote({ sample, sampleName, pitch, mode, target, once }) {
    const file = target.headsOf("adpcm-b")[0];
    const elsewhere = file ? `play its :file on ${file} (the ADPCM-B)` : "it has no sound here";
    if (!sample.rhythm) {
      once(`adpcm:${sampleName}`, `on ${target.name} ${target.headsOf("rhythm").join(" and ")} play the ROM rhythm sounds, ${Object.keys(this.kit).join(" ")}; ${sampleName} is not one — ${elsewhere}`);
      return;
    }
    const what = `the ROM rhythm sound ${sample.rhythm} (${sampleName})`;
    if (mode === "loop") once(`loop:${sampleName}`, `${what} plays once; it has no loop`);
    if (pitchToMidi(pitch) !== 60)
      once(`pitch:${sampleName}`, `${what} has no pitch: write it at c4${file ? `, or ${elsewhere}` : ""}`);
    if (sample.fxNode || sample.importFx?.length)
      once(`fx:${sampleName}`, `${sampleName}'s :fx shapes its :file; ${what} plays as the chip has it`, "warning");
  },
};
