// The YM2608 (OPNA): six FM channels, the SSG at the clock / 4, the six ROM
// rhythm sounds and one ADPCM-B voice. No encoder or emulator yet, so no
// preview (docs/roadmap.md).
import { opnFm } from "./opn-fm.js";
import { ssgTone, ssgNoise } from "./ssg.js";
import { rhythmRom } from "./rhythm-rom.js";
import { adpcmB } from "./adpcm-b.js";

export const ym2608 = {
  chip: "ym2608",
  clock: 7987200,
  fnumRate: 7987200 / 144,
  parts: [opnFm, ssgTone, ssgNoise, rhythmRom, adpcmB],
  preview: false,
  // The SSG's period divides clock / 4 by 16; its noise starts at 9, the
  // nearest to the Mega Drive's white0.
  ssg: { clock: 7987200 / 4, noiseRate: 9 },
  vgm: { clock: 0x48 }, // VGM 1.51's header
};
