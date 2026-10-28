// The Famicom: its 2A03's APU — two pulses, the triangle, the noise and the
// DMC's samples (pcm1) — and the expansions a score has when it names their
// channels: the VRC6 cartridge's two pulses and its saw, the Disk System's
// wavetable, the MMC5's two pulses, the Sunsoft 5B's SSG, the VRC7's FM and
// the N163's wavetables. No driver: the score is delivered as VGM (which has
// no VRC6, MMC5 or N163: their channels are left out there).
//
// An expansion's channels are named by their chip (`vrc6-sqr1`, `fds-wave`):
// the Famicom has pulses on several chips and waves on two, so a number
// alone would say nothing of which. `label` is the channel strip's.
import { rp2a03, fcPulse, fcTriangle, fcNoise, fcDpcm } from "../chips/rp2a03.js";
import { vrc6, vrc6Pulse, vrc6Saw } from "../chips/vrc6.js";
import { fds, fdsWave } from "../chips/fds.js";
import { mmc5, mmc5Pulse } from "../chips/mmc5.js";
import { sunsoft5b, s5bTone, s5bNoise } from "../chips/sunsoft-5b.js";
import { vrc7, vrc7Fm } from "../chips/vrc7.js";
import { n163, n163Wave } from "../chips/n163.js";

const on = (part, voice) => ({ chip: "apu", part, voice });
// The VRC6's scope lanes follow the DMC's (synth-fc.js): 11-13.
const cart = (part, voice, label) => ({ chip: "vrc6", part, voice, scope: 11 + voice, label });
const s5b = (part, voice, label) => ({ chip: "5b", part, voice, scope: 17 + voice, label });

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
  chips: { apu: rp2a03, vrc6, fds, mmc5, "5b": sunsoft5b, vrc7, n163 },
  channels: {
    sqr1: on(fcPulse, 0), sqr2: on(fcPulse, 1), tri: on(fcTriangle, 2), noise: on(fcNoise, 3),
    pcm1: on(fcDpcm, 0), // on the scope's first sample lane, 10
    "vrc6-sqr1": cart(vrc6Pulse, 0, "V1"), "vrc6-sqr2": cart(vrc6Pulse, 1, "V2"), "vrc6-saw": cart(vrc6Saw, 2, "VS"),
    // The Disk System's one channel, on the scope's lane after the VRC6's.
    "fds-wave": { chip: "fds", part: fdsWave, voice: 0, scope: 14, label: "FDS" },
    // The MMC5's pulses, on the scope's lanes after the FDS's.
    "mmc5-sqr1": { chip: "mmc5", part: mmc5Pulse, voice: 0, scope: 15, label: "M1" },
    "mmc5-sqr2": { chip: "mmc5", part: mmc5Pulse, voice: 1, scope: 16, label: "M2" },
    // The 5B's SSG, its noise 5b-sqr3's mixer on noise (as msx's), on the
    // scope's lanes after the MMC5's.
    "5b-sqr1": s5b(s5bTone, 0, "B1"), "5b-sqr2": s5b(s5bTone, 1, "B2"), "5b-sqr3": s5b(s5bTone, 2, "B3"),
    "5b-noise": s5b(s5bNoise, 2, "BN"),
    // The VRC7's FM, on the scope's FM lanes (0-5).
    ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((v) => [`vrc7-fm${v + 1}`, { chip: "vrc7", part: vrc7Fm, voice: v, label: `F${v + 1}` }])),
    // The N163's eight, wave1 its channel 8, on the scope's lanes after the 5B's.
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((v) => [`n163-wave${v + 1}`, { chip: "n163", part: n163Wave, voice: v, scope: 20 + v, label: `W${v + 1}` }])),
  },
  readsAs: { modes: { "fc-noise": NOISE_MODES } },
  hints: {
    NOISE_RATE: "the 2A03 noise's rate is its note's pitch, c2 the slowest",
    PAN: "the Famicom is mono",
  },
};
