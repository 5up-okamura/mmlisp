// The NEC PC-8801 with Sound Board II: one YM2608 (PC-98's 86 board has no
// ADPCM RAM). No driver: the score is delivered as VGM.
import { ym2608 } from "../chips/ym2608.js";
import { opnFm } from "../chips/opn-fm.js";
import { ssgTone, ssgNoise } from "../chips/ssg.js";
import { rhythmRom } from "../chips/rhythm-rom.js";
import { adpcmB } from "../chips/adpcm-b.js";

const fm = (voice) => ({ chip: "opna", part: opnFm, voice });
const on = (part, voice) => ({ chip: "opna", part, voice });

// A Mega Drive noise mode, read on the SSG: white0-2 as the nearest noise
// period (the SN76489's 13,983 / 6,991 / 3,496 Hz against the SSG's
// 124,800 Hz / rate); white3 follows sqr3's tone and the periodic modes are
// a sound the SSG does not make.
const periodic = { none: "the SSG makes no periodic noise; set :noise-rate 1-31" };
const NOISE_MODES = {
  white0: { write: ["NOISE_RATE", 9], as: ":noise-rate 9" },
  white1: { write: ["NOISE_RATE", 18], as: ":noise-rate 18" },
  white2: { write: ["NOISE_RATE", 31], as: ":noise-rate 31" },
  white3: { none: "the noise is sqr3 itself; set :noise-rate 1-31" },
  periodic0: periodic, periodic1: periodic, periodic2: periodic, periodic3: periodic,
};

export default {
  name: "pc88",
  system: "NEC PC-8801",
  driver: null,
  chips: { opna: ym2608 },
  channels: {
    fm1: fm(0), fm2: fm(1), fm3: fm(2),
    "fm3-1": fm(2), "fm3-2": fm(2), "fm3-3": fm(2), "fm3-4": fm(2),
    "fm3-csm": fm(2), "fm3-csm-rate": fm(2),
    fm4: fm(3), fm5: fm(4), fm6: fm(5),
    sqr1: on(ssgTone, 0), sqr2: on(ssgTone, 1), sqr3: on(ssgTone, 2),
    noise: on(ssgNoise, 2), // sqr3 with its mixer on noise
    pcm1: on(adpcmB, 0),
    pcm2: on(rhythmRom, 0), pcm3: on(rhythmRom, 0), // two tracks on the one kit
  },
  readsAs: { modes: { "ssg-noise": NOISE_MODES } },
  hints: { NOISE_MODE: "the noise is :noise-rate 1-31, song-wide" },
};
