// The YM2608 (OPNA): six FM channels, the SSG at the clock / 4, the six ROM
// rhythm sounds and one ADPCM-B voice. The FM is the OPN family's, written by
// the IR player as the YM2612's is; this file encodes the rest. ymfm's
// YM2608 plays them (synth-pc88.js).
import { opnFm, opnFmEncoder } from "./opn-fm.js";
import { ssgTone, ssgNoise, ssgEncoder } from "./ssg.js";
import { rhythmRom } from "./rhythm-rom.js";
import { adpcmB } from "./adpcm-b.js";
import { panSide } from "../ir-utils.js";

const CLOCK = 7987200;
const SSG_CLOCK = CLOCK / 4; // its tone and noise divide this by 16
const NOISE_RATE_START = 9; // the nearest to the Mega Drive's white0

// The rhythm sounds' bits in $10 (key, and dump with bit 7) and their level
// registers $18 + bit: pan in bits 7-6 (L, R), the level IL in bits 4-0.
export const RHYTHM_BIT = { bd: 0, sd: 1, top: 2, hh: 3, tom: 4, rim: 5 };
const PAN_BITS = { [-1]: 0x80, 0: 0xc0, 1: 0x40 };

export const ym2608 = {
  chip: "ym2608",
  clock: CLOCK,
  fnumRate: CLOCK / 144,
  parts: [opnFm, ssgTone, ssgNoise, rhythmRom, adpcmB],
  encoder: true,
  emulator: true,
  fmEncoder() {
    return opnFmEncoder(this.fnumRate, this.clock);
  },
  ssg: { clock: SSG_CLOCK, noiseRate: NOISE_RATE_START },
  // Written once before anything else. $29 bit 7 (SCH) opens fm4-fm6, which
  // the chip starts without (its OPN-compatible mode); the rhythm's total
  // level RTL stays at its top (each hit's level is its IL); the SSG starts
  // with every channel on tone and the song's noise period at its start.
  init: [[0, 0x29, 0x80], [0, 0x11, 0x3f], [0, 0x07, 0x38], [0, 0x06, NOISE_RATE_START]],
  vgm: { version: 0x151, clock: 0x48, ports: { 0: { cmd: 0x56, addr: true }, 1: { cmd: 0x57, addr: true } } },

  // The SSG as the IR player's PSG (chips/ssg.js).
  psgEncoder() {
    return ssgEncoder(SSG_CLOCK);
  },

  // The ADPCM-B (port 1), in the order mucom88 writes a note: level and pan
  // off, a reset ($00 bit 0, bit 5 the external RAM), the flags cleared, the
  // range (address units, chips/adpcm-b.js), Delta-N, start (bit 7, bit 4 to
  // repeat the range), then the level ($0B, linear) and the pan ($01 bits
  // 7-6; bits 1-0 = 0, the 1-bit DRAM mucom88's RAM is read as).
  adpcm: {
    // Delta-N for a rate in Hz: the chip plays ΔN / 65536 of its clock / 144.
    deltaN: (hz) => Math.max(256, Math.min(65535, Math.round((hz * 65536) / (CLOCK / 144)))),
    note: ({ start, stop }, deltaN, level, pan, repeat) => [
      [1, 0x0b, 0], [1, 0x01, 0], [1, 0x00, 0x21], [1, 0x10, 0x08], [1, 0x10, 0x80],
      [1, 0x02, start & 0xff], [1, 0x03, (start >> 8) & 0xff], [1, 0x04, stop & 0xff], [1, 0x05, (stop >> 8) & 0xff],
      [1, 0x09, deltaN & 0xff], [1, 0x0a, (deltaN >> 8) & 0xff],
      [1, 0x00, 0xa0 | (repeat ? 0x10 : 0)], [1, 0x0b, Math.max(0, Math.min(255, level))], [1, 0x01, PAN_BITS[panSide(pan)]],
    ],
    stop: () => [[1, 0x0b, 0], [1, 0x01, 0], [1, 0x00, 0x21]],
    // A sounding note's level moving (linear, 0-255), and its pitch.
    level: (level) => [[1, 0x0b, Math.max(0, Math.min(255, level))]],
    pitch: (deltaN) => [[1, 0x09, deltaN & 0xff], [1, 0x0a, (deltaN >> 8) & 0xff]],
    // VGM's data block type for the RAM image (VGM 1.51: YM2608 DELTA-T).
    vgmBlock: 0x81,
  },

  rhythm: {
    // A hit: its level and pan, then its key.
    hit: (sound, il, pan) => [...ym2608.rhythm.level(sound, il, pan), [0, 0x10, 1 << RHYTHM_BIT[sound]]],
    // A sound's level IL (and its pan, the same register), sounding or not.
    level: (sound, il, pan) => [
      [0, 0x18 + RHYTHM_BIT[sound], PAN_BITS[panSide(pan)] | Math.max(0, Math.min(31, il))],
    ],
    // `:mode gate`'s end: the dump bit stops the sound.
    dump: (sound) => [[0, 0x10, 0x80 | (1 << RHYTHM_BIT[sound])]],
  },
};
