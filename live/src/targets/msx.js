// The MSX: its PSG, an AY-3-8910, the SCC cartridge's five wave channels
// (a score that names none has no SCC) and the FM-PAC's YM2413, whose
// channels are not in the table yet (chips/ym2413.js). No driver: the score
// is delivered as VGM.
import { ay8910 } from "../chips/ay8910.js";
import { k051649, sccWave } from "../chips/k051649.js";
import { ym2413 } from "../chips/ym2413.js";
import { ssgTone, ssgNoise } from "../chips/ssg.js";

const on = (part, voice) => ({ chip: "psg", part, voice });
const wave = (voice) => ({ chip: "scc", part: sccWave, voice });

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
  chips: { psg: ay8910, scc: k051649, opll: ym2413 },
  channels: {
    sqr1: on(ssgTone, 0), sqr2: on(ssgTone, 1), sqr3: on(ssgTone, 2),
    noise: on(ssgNoise, 2), // sqr3 with its mixer on noise
    wave1: wave(0), wave2: wave(1), wave3: wave(2), wave4: wave(3), wave5: wave(4),
  },
  readsAs: { modes: { "ssg-noise": NOISE_MODES } },
  hints: { NOISE_MODE: "the noise is :noise-rate 1-31, song-wide" },
};
