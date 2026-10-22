// The SN76489 (the Mega Drive's PSG): three square tones and a noise, one
// write port, a byte stream.
import { NO_WORDS, words } from "./parts.js";

// noise :mode → its control bits FB | NF (bits 2-0): white = FB 1, periodic
// FB 0; NF 0-2 a fixed shift rate, 3 tracking sqr3's tone.
export const NOISE_MODE_MAP = {
  white0: 0b1_00, // 4
  white1: 0b1_01, // 5
  white2: 0b1_10, // 6
  white3: 0b1_11, // 7
  periodic0: 0b0_00, // 0
  periodic1: 0b0_01, // 1
  periodic2: 0b0_10, // 2
  periodic3: 0b0_11, // 3
};

const PSG_LEVEL = { stepDb: 2, steps: 16 }; // the attenuator, 0 loud .. 15 off

export const snSqr = { name: "sqr", label: "SN76489 tone", unit: "psg", kind: "tone", level: PSG_LEVEL, words: NO_WORDS };

export const snNoise = {
  name: "noise",
  label: "SN76489 noise",
  unit: "psg", // the PSG's fourth channel
  kind: "noise",
  level: PSG_LEVEL,
  words: words("NOISE_MODE"),
  modes: Object.fromEntries(Object.entries(NOISE_MODE_MAP).map(([k, v]) => [k, ["NOISE_MODE", v]])),
  modeError: { code: "E_NOISE_MODE_INVALID", message: "noise :mode must be white0-3 or periodic0-3" },
  // Nothing in the score wrote it, so it has no src (a src would light the
  // track form up as the playhead).
  init: [{ target: "NOISE_MODE", value: NOISE_MODE_MAP.white0 }],
};

// A write is [port, addr, data]; port 2 is the PSG in the worklet protocol.
export const sn76489 = {
  chip: "sn76489",
  clock: 3579545, // NTSC: the master / 15
  parts: [snSqr, snNoise],
  preview: true,
  // VGM: the header's clock offset and the chip as the Mega Drive wires it
  // (white-noise feedback taps 0x0009, a 16-bit shift register, no flags);
  // the command a write on the worklet's port 2 becomes, one data byte.
  vgm: { clock: 0x0c, header: [[0x28, 2, 0x0009], [0x2a, 1, 16], [0x2b, 1, 0]], ports: { 2: { cmd: 0x50, addr: false } } },
  // The tone counter divides the clock by 32 per period step; 1..1023.
  period(hz) {
    return Math.max(1, Math.min(1023, Math.round(this.clock / (32 * hz))));
  },
  // Attenuation 0 (loud) .. 15 (silent): latch | ch | r=1 | att.
  att(ch, att) {
    return [[2, 0, 0x80 | ((ch & 0x03) << 5) | 0x10 | (att & 0x0f)]];
  },
  // Tone period: the latch byte carries its low 4 bits, the data byte the
  // high 6.
  tone(ch, period) {
    return [
      [2, 0, 0x80 | ((ch & 0x03) << 5) | (period & 0x0f)],
      [2, 0, (period >> 4) & 0x3f],
    ];
  },
  // Noise control (channel 3): FB + NF, the 0–7 NOISE_MODE value.
  noise(mode) {
    return [[2, 0, 0x80 | (0x03 << 5) | (mode & 0x07)]];
  },
};
