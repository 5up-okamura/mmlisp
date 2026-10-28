// The Famicom: its 2A03's APU — two pulses, the triangle, the noise and the
// DMC's samples (pcm1) — and a cartridge the score has when it names its
// channels: the VRC6's two pulses and its saw. No driver: the score is
// delivered as VGM (which has no VRC6: its channels are left out there).
import { rp2a03, fcPulse, fcTriangle, fcNoise, fcDpcm } from "../chips/rp2a03.js";
import { vrc6, vrc6Pulse, vrc6Saw } from "../chips/vrc6.js";

const on = (part, voice) => ({ chip: "apu", part, voice });
// The VRC6's scope lanes follow the DMC's (synth-fc.js): 11-13.
const cart = (part, voice) => ({ chip: "vrc6", part, voice, scope: 11 + voice });

// A Mega Drive noise mode has no 2A03 reading: the rate is the note.
const none = { none: "the 2A03's noise is :mode white or periodic, its rate the note's pitch" };
const NOISE_MODES = Object.fromEntries(
  ["white0", "white1", "white2", "white3", "periodic0", "periodic1", "periodic2", "periodic3"].map((m) => [m, none]));

export default {
  name: "fc",
  system: "Famicom",
  driver: null,
  // Its drivers run on the video frame's interrupt (60 Hz), as the MSX's do
  // (targets/msx.js): the chip hears a song a frame at a time.
  frameClock: true,
  chips: { apu: rp2a03, vrc6 },
  channels: {
    sqr1: on(fcPulse, 0), sqr2: on(fcPulse, 1), tri: on(fcTriangle, 2), noise: on(fcNoise, 3),
    pcm1: on(fcDpcm, 0), // on the scope's first sample lane, 10
    sqr3: cart(vrc6Pulse, 0), sqr4: cart(vrc6Pulse, 1), saw1: cart(vrc6Saw, 2),
  },
  readsAs: { modes: { "fc-noise": NOISE_MODES } },
  hints: {
    NOISE_RATE: "the noise's rate is its note's pitch, c2 the slowest",
    PAN: "the Famicom is mono",
  },
};
