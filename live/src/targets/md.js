// The Sega Mega Drive: the YM2612 and the SN76489, PCM soft-mixed into fm6's
// DAC, and a driver of its own (MMLispDRV) — the MMB, sound effects, the
// game's key-off.
import { ym2612 } from "../chips/ym2612.js";
import { opnFm } from "../chips/opn-fm.js";
import { dacMix } from "../chips/dac-mix.js";
import { sn76489, snSqr, snNoise } from "../chips/sn76489.js";

const fm = (voice) => ({ chip: "opn", part: opnFm, voice });
const psg = (part, voice) => ({ chip: "psg", part, voice });
const dac = (voice) => ({ chip: "opn", part: dacMix, voice });

export default {
  name: "md",
  system: "Sega Mega Drive",
  driver: "mmlispdrv",
  // The Model 1's analog low-pass on the output (synth-md.js), which Live
  // plays through when Analog LPF is on.
  analogLpf: true,
  chips: { opn: ym2612, psg: sn76489 },
  // Score channel → its chip, part and voice (the index in the part's unit:
  // the FM channel, the PSG channel, the soft-mix slot). Names on one voice
  // with one part are one channel's views (FM3's tracks).
  channels: {
    fm1: fm(0), fm2: fm(1), fm3: fm(2),
    "fm3-1": fm(2), "fm3-2": fm(2), "fm3-3": fm(2), "fm3-4": fm(2),
    "fm3-csm": fm(2), "fm3-csm-rate": fm(2),
    fm4: fm(3), fm5: fm(4), fm6: fm(5),
    sqr1: psg(snSqr, 0), sqr2: psg(snSqr, 1), sqr3: psg(snSqr, 2), noise: psg(snNoise, 3),
    pcm1: dac(0), pcm2: dac(1), pcm3: dac(2),
  },
  // What to write instead of a word the machine lacks.
  hints: { NOISE_RATE: "its noise takes :mode white0-3 / periodic0-3" },
};
