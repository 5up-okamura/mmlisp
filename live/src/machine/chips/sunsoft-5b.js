// The Sunsoft 5B, Sunsoft's mapper with sound (Gimmick!): a YM2149 inside
// a cartridge — the SSG's three channels, their mixers, one noise period,
// the hardware envelope — run from the CPU's clock with the YM2149's
// divider pin low, so its tones and noise are an AY-3-8910's at half that
// clock. Its DAC is the YM2149's, 32 steps of 1.5 dB, the 4-bit level on
// every other one (nesdev's Sunsoft 5B audio page). ymfm's SSG engine plays
// it, as the MSX's AY (synth-fc.js).
//
// In the language it is the SSG (language.md §19, pc88 and msx): `5b-sqr1`
// - `5b-sqr3` with `:mode tone | noise | both | env`, the song's
// `:noise-rate` and `:env-rate`; `5b-noise` is 5b-sqr3 with its mixer on
// noise.
//
// Its registers are the worklet's port 6, the chip's own 0-15 ($C000
// selects one, $E000 writes it).
import { ssgTone, ssgNoise, ssgEncoder } from "./ssg.js";

const CPU_CLOCK = 1789773; // the Famicom's
const CLOCK = Math.round(CPU_CLOCK / 2); // an AY-3-8910's clock playing as it does
const PORT = 6;
const NOISE_RATE_START = 8; // as msx's (chips/ay8910.js)

export const s5bTone = {
  ...ssgTone,
  name: "5b-ssg",
  label: "5B tone",
  unit: "5b",
  // After the MMC5's lanes (targets.js toneLaneOf): 17-19.
  toneLane: (c) => 17 + c.voice,
};

export const s5bNoise = {
  ...ssgNoise,
  name: "5b-noise",
  label: "5B noise",
  unit: "5b",
  toneLane: () => 20,
};

// The SSG's encoder on the 5B's port: its lanes the channels (the noise
// track is channel 3's mixer, the encoder's own lane 3), one for the chip.
function s5bEncoder() {
  const enc = ssgEncoder(CLOCK, 0, PORT);
  return { ...enc, lanes: [enc, enc, enc] };
}

export const sunsoft5b = {
  chip: "5b",
  clock: CLOCK,
  parts: [s5bTone, s5bNoise],
  encoder: true,
  emulator: true,
  // A cartridge: started at its first write, so a score that names none of
  // its channels has none (chips/k051649.js).
  optional: true,
  // Every channel on tone, the noise period at its start.
  init: [[PORT, 0x07, 0x38], [PORT, 0x06, NOISE_RATE_START]],
  // VGM 1.51: the AY-3-8910's block — the clock it plays at, the chip type
  // the YM2149 (0x10), the legacy output (flags bit 0).
  vgm: { version: 0x151, clock: 0x74, header: [[0x78, 1, 0x10], [0x79, 1, 0x01]], ports: { [PORT]: { cmd: 0xa0, addr: true } } },
  toneEncoder: s5bEncoder,
};
