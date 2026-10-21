// The NEC PC-8801 with Sound Board II: one YM2608 (PC-98's 86 board has no
// ADPCM RAM). No driver: the score is delivered as VGM.
import { ym2608 } from "../chips/ym2608.js";
import { opnFm } from "../chips/opn-fm.js";
import { ssgTone, ssgNoise } from "../chips/ssg.js";
import { rhythmRom } from "../chips/rhythm-rom.js";
import { adpcmB } from "../chips/adpcm-b.js";

const fm = (voice) => ({ chip: "opna", part: opnFm, voice });

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
    fm1: fm("ch1"), fm2: fm("ch2"), fm3: fm("ch3"),
    "fm3-1": fm("ch3"), "fm3-2": fm("ch3"), "fm3-3": fm("ch3"), "fm3-4": fm("ch3"),
    "fm3-csm": fm("ch3"), "fm3-csm-rate": fm("ch3"),
    fm4: fm("ch4"), fm5: fm("ch5"), fm6: fm("ch6"),
    sqr1: { chip: "opna", part: ssgTone, voice: "ssg0" },
    sqr2: { chip: "opna", part: ssgTone, voice: "ssg1" },
    sqr3: { chip: "opna", part: ssgTone, voice: "ssg2" },
    noise: { chip: "opna", part: ssgNoise, voice: "ssg2" }, // sqr3 on noise
    pcm1: { chip: "opna", part: adpcmB, voice: "adpcm" },
    pcm2: { chip: "opna", part: rhythmRom, voice: "rhythm" },
    pcm3: { chip: "opna", part: rhythmRom, voice: "rhythm" },
  },
  readsAs: { modes: { "ssg-noise": NOISE_MODES } },
  hints: { NOISE_MODE: "the noise is :noise-rate 1-31, song-wide" },
};
