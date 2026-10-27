// The PC Engine: its HuC6280's six wave channels, the fifth and sixth as
// noise and any as DDA (pcm1-pcm6) when a score names them so. No driver:
// the score is delivered as VGM.
import { huc6280, pceWave, pceWaveLfo, pceNoise, pceDda, NOISE_CHANNELS } from "../chips/huc6280.js";

// Channel 1 is the one that takes the LFO (:fms).
const wave = (voice) => ({ chip: "psg", part: voice === 0 ? pceWaveLfo : pceWave, voice });
// A noise channel draws on its wave channel's lane (the one channel).
const noise = (voice) => ({ chip: "psg", part: pceNoise, voice, scope: 10 + voice });
// pcm1-pcm6: channel N as DDA, on its wave channel's lane.
const dda = (voice) => ({ chip: "psg", part: pceDda, voice, scope: 10 + voice });

export default {
  name: "pce",
  system: "PC Engine",
  driver: null,
  // Its drivers run on the video frame's interrupt, as the MSX's do
  // (targets/msx.js): the chip hears a song a frame at a time.
  frameClock: true,
  chips: { psg: huc6280 },
  channels: {
    wave1: wave(0), wave2: wave(1), wave3: wave(2), wave4: wave(3), wave5: wave(4), wave6: wave(5),
    noise5: noise(NOISE_CHANNELS[0]), noise6: noise(NOISE_CHANNELS[1]),
    pcm1: dda(0), pcm2: dda(1), pcm3: dda(2), pcm4: dda(3), pcm5: dda(4), pcm6: dda(5),
  },
  hints: {
    FM_FMS: "on the PC Engine only wave1 takes the LFO (:fms 0-3), wave2 its source",
    NOISE_MODE: "the noise is noise5 / noise6, its rate the note's pitch",
    NOISE_RATE: "the noise is noise5 / noise6, its rate the note's pitch",
  },
};
