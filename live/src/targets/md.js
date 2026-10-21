// The Sega Mega Drive: the YM2612 and the SN76489, PCM soft-mixed into fm6's
// DAC, and a driver of its own (MMLispDRV) — the MMB, sound effects, the
// game's key-off.
import { ym2612 } from "../chips/ym2612.js";
import { opnFm } from "../chips/opn-fm.js";
import { dacMix } from "../chips/dac-mix.js";
import { sn76489, snSqr, snNoise } from "../chips/sn76489.js";

const fm = (voice) => ({ chip: "opn", part: opnFm, voice });

export default {
  name: "md",
  system: "Sega Mega Drive",
  driver: "mmlispdrv",
  chips: { opn: ym2612, psg: sn76489 },
  // Score channel → its chip, part and physical voice. Names on one voice
  // with one part are one channel's views (FM3's tracks, the mixed PCM).
  channels: {
    fm1: fm("ch1"), fm2: fm("ch2"), fm3: fm("ch3"),
    "fm3-1": fm("ch3"), "fm3-2": fm("ch3"), "fm3-3": fm("ch3"), "fm3-4": fm("ch3"),
    "fm3-csm": fm("ch3"), "fm3-csm-rate": fm("ch3"),
    fm4: fm("ch4"), fm5: fm("ch5"), fm6: fm("ch6"),
    sqr1: { chip: "psg", part: snSqr, voice: "tone0" },
    sqr2: { chip: "psg", part: snSqr, voice: "tone1" },
    sqr3: { chip: "psg", part: snSqr, voice: "tone2" },
    noise: { chip: "psg", part: snNoise, voice: "noise" },
    pcm1: { chip: "opn", part: dacMix, voice: "dac" },
    pcm2: { chip: "opn", part: dacMix, voice: "dac" },
    pcm3: { chip: "opn", part: dacMix, voice: "dac" },
  },
  // What to write instead of a word the machine lacks.
  hints: { NOISE_RATE: "its noise takes :mode white0-3 / periodic0-3" },
};
