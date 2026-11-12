// The Mega Drive's PCM: up to three voices soft-mixed on the Z80 into fm6's
// DAC (driver.md §5). The song's voice count picks the engine image, and a
// score with PCM owns fm6 for the whole song — the engine writes $2B once
// and never gives the channel back.
import { words } from "./parts.js";

export const dacMix = {
  name: "dac",
  label: "Mega Drive DAC",
  kind: "sample",
  // The voices are one stream on fm6's DAC, which comes out on fm6's L / R
  // bits: a pcm track's :pan is that one pan — fm6's own, every voice's
  // (language.md §16).
  words: words(/^(?:RANGE|LOOP)_/, "PAN"),
  settings: [":pcm-voices"],
  bank: "mmb",
  // The FM channel its voices sound on (fm6's DAC): busy while one plays.
  // fm6 plays beside them in turn: a PCM note takes the DAC, an fm6 note
  // gives the channel back to FM (mmlisp2ir warnSharedChannels).
  claims: { kind: "fm", voice: 5 },
  sharesTaken: true,
  checkScore({ pcmUsed, pcmVoices, push }) {
    if (pcmUsed > pcmVoices)
      push("error", "E_PCM_VOICES",
        `pcm${pcmUsed} needs (def-score :pcm-voices ${pcmUsed}); this score declares ${pcmVoices}`);
  },
};
