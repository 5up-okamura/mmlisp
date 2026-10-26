// The Sharp X68000: one YM2151, and PCM8's eight voices mixed into the
// MSM6258's ADPCM stream. No driver: the score is delivered as VGM.
import { ym2151, opmFm, opmNoise } from "../chips/ym2151.js";
import { msm6258, pcm8 } from "../chips/msm6258.js";

const fm = (voice) => ({ chip: "opm", part: opmFm, voice });
// PCM8's voices: the synth's scope lanes 8-15, each voice's part of the mix.
const pcm = (voice) => ({ chip: "adpcm", part: pcm8, voice, scope: 8 + voice });

export default {
  name: "x68k",
  system: "Sharp X68000",
  driver: null,
  chips: { opm: ym2151, adpcm: msm6258 },
  channels: {
    fm1: fm(0), fm2: fm(1), fm3: fm(2), fm4: fm(3),
    fm5: fm(4), fm6: fm(5), fm7: fm(6), fm8: fm(7),
    noise: { chip: "opm", part: opmNoise, voice: 7, scope: 7 }, // fm8's fourth operator, fm8's lane
    pcm1: pcm(0), pcm2: pcm(1), pcm3: pcm(2), pcm4: pcm(3),
    pcm5: pcm(4), pcm6: pcm(5), pcm7: pcm(6), pcm8: pcm(7),
  },
  hints: { NOISE_MODE: "its noise is :noise-rate 1-31, song-wide" },
};
