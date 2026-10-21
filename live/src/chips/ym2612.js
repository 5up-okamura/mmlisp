// The YM2612 (OPN2): six FM channels, the sixth also the DAC the Mega
// Drive's PCM is mixed into.
import { opnFm } from "./opn-fm.js";
import { dacMix } from "./dac-mix.js";

export const ym2612 = {
  chip: "ym2612",
  clock: 7670454, // NTSC: the 53.693175 MHz master / 7
  // The F-number formula's clock / 144, as the driver's pitch tables are
  // generated from it (rounded: 53,267 Hz).
  fnumRate: 53267,
  parts: [opnFm, dacMix],
  preview: true,
  vgm: { clock: 0x2c },
};
