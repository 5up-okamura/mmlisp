// The Mega Drive's PCM: up to three voices soft-mixed on the Z80 into fm6's
// DAC (driver.md §5). The song's voice count picks the engine image, and a
// score with PCM owns fm6 for the whole song — the engine writes $2B once
// and never gives the channel back.
import { words } from "./parts.js";

export const dacMix = {
  name: "dac",
  label: "Mega Drive DAC",
  kind: "sample",
  // A soft-mixed voice owns no FM channel, so it has no pan lane.
  words: words(/^(?:RANGE|LOOP)_/),
  settings: [":pcm-voices"],
  // The FM channel its voices sound on (fm6's DAC): busy while one plays.
  claims: { kind: "fm", voice: 5 },
  checkScore({ pcmUsed, pcmVoices, allHeads, push }) {
    if (pcmUsed > pcmVoices)
      push("error", "E_PCM_VOICES",
        `pcm${pcmUsed} needs (def-score :pcm-voices ${pcmUsed}); this score declares ${pcmVoices}`);
    if (pcmVoices > 0 && allHeads.has("fm6"))
      push("error", "E_FM6_DAC", "fm6 is the DAC while the score uses PCM; move the part to fm1-fm5");
  },
};
