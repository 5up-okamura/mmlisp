// The Game Boy: its LR35902's APU — two pulses, the wave and the noise. No
// driver: the score is delivered as VGM.
import { lr35902, gbPulse, gbWave, gbNoise } from "../chips/lr35902.js";

const on = (part, voice) => ({ chip: "apu", part, voice });

// A Mega Drive noise mode has no reading here: the rate is the note.
const none = { none: "the Game Boy's noise is :mode white or periodic, its rate the note's pitch" };
const NOISE_MODES = Object.fromEntries(
  ["white0", "white1", "white2", "white3", "periodic0", "periodic1", "periodic2", "periodic3"].map((m) => [m, none]));

export default {
  name: "gb",
  system: "Game Boy",
  driver: null,
  // Its drivers run on the video frame's interrupt, as the MSX's do
  // (targets/msx.js): the chip hears a song a frame at a time.
  frameClock: true,
  chips: { apu: lr35902 },
  channels: {
    sqr1: on(gbPulse, 0), sqr2: on(gbPulse, 1), noise: on(gbNoise, 3), wave: on(gbWave, 0),
  },
  readsAs: { modes: { "gb-noise": NOISE_MODES } },
  hints: {
    NOISE_RATE: "the Game Boy noise's rate is its note's pitch, c2 the slowest",
  },
};
