// The MSX: its PSG, an AY-3-8910. No driver: the score is delivered as VGM.
import { ay8910 } from "../chips/ay8910.js";
import { ssgTone, ssgNoise } from "../chips/ssg.js";

const on = (part, voice) => ({ chip: "psg", part, voice });

// A Mega Drive noise mode, read on the SSG as on the PC-8801 (targets/pc88.js):
// white0-2 as the nearest noise period (the SN76489's 13,983 / 6,991 / 3,496
// Hz against the AY's 111,861 Hz / rate).
const periodic = { none: "the SSG makes no periodic noise; set :noise-rate 1-31" };
const NOISE_MODES = {
  white0: { write: ["NOISE_RATE", 8], as: ":noise-rate 8" },
  white1: { write: ["NOISE_RATE", 16], as: ":noise-rate 16" },
  white2: { write: ["NOISE_RATE", 31], as: ":noise-rate 31" },
  white3: { none: "the noise is sqr3 itself; set :noise-rate 1-31" },
  periodic0: periodic, periodic1: periodic, periodic2: periodic, periodic3: periodic,
};

export default {
  name: "msx",
  system: "MSX",
  driver: null,
  chips: { psg: ay8910 },
  channels: {
    sqr1: on(ssgTone, 0), sqr2: on(ssgTone, 1), sqr3: on(ssgTone, 2),
    noise: on(ssgNoise, 2), // sqr3 with its mixer on noise
  },
  readsAs: { modes: { "ssg-noise": NOISE_MODES } },
  hints: { NOISE_MODE: "the noise is :noise-rate 1-31, song-wide" },
};
