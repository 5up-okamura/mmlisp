// The Sharp X68000: one YM2151 (and the MSM6258's ADPCM, not yet a part
// here). No driver: the score is delivered as VGM.
import { ym2151, opmFm, opmNoise } from "../chips/ym2151.js";

const fm = (voice) => ({ chip: "opm", part: opmFm, voice });

export default {
  name: "x68k",
  system: "Sharp X68000",
  driver: null,
  chips: { opm: ym2151 },
  channels: {
    fm1: fm(0), fm2: fm(1), fm3: fm(2), fm4: fm(3),
    fm5: fm(4), fm6: fm(5), fm7: fm(6), fm8: fm(7),
    noise: { chip: "opm", part: opmNoise, voice: 7 }, // fm8's fourth operator
  },
  hints: { NOISE_MODE: "its noise is :noise-rate 1-31, song-wide" },
};
