// The AY-3-8910 (the MSX's PSG): the SSG alone, at the MSX's 1.79 MHz. Its
// two I/O ports are the machine's joystick and kana lamp, so every mixer
// write keeps their directions as the BIOS sets them (bit 7 out, bit 6 in);
// the other way round the two ports drive each other. ymfm's SSG plays it
// (synth-msx.js).
import { ssgTone, ssgNoise, ssgEncoder } from "./ssg.js";

const CLOCK = Math.round(3579545 / 2); // the MSX's 3.58 MHz / 2
const NOISE_RATE_START = 8; // the nearest to the Mega Drive's white0 (targets/msx.js)
const IO = 0x80; // R7 bits 7-6: port B out, port A in

export const ay8910 = {
  chip: "ay8910",
  clock: CLOCK,
  parts: [ssgTone, ssgNoise],
  encoder: true,
  emulator: true,
  // Every channel on tone, the noise period at its start.
  init: [[0, 0x07, IO | 0x38], [0, 0x06, NOISE_RATE_START]],
  // VGM 1.51: the clock, the chip type (0 the AY-3-8910) and its flags
  // (bit 0, the legacy output), and the command a port-0 write becomes.
  vgm: { version: 0x151, clock: 0x74, header: [[0x78, 1, 0x00], [0x79, 1, 0x01]], ports: { 0: { cmd: 0xa0, addr: true } } },
  psgEncoder() {
    return ssgEncoder(CLOCK, IO);
  },
};
