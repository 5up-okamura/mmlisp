// The YM2608 (OPNA): six FM channels, the SSG at the clock / 4, the six ROM
// rhythm sounds and one ADPCM-B voice. The FM is the OPN family's, written by
// the IR player as the YM2612's is; this file encodes the rest. No emulator
// yet (docs/roadmap.md), and the ADPCM-B waits for its bake.
import { opnFm } from "./opn-fm.js";
import { ssgTone, ssgNoise } from "./ssg.js";
import { rhythmRom } from "./rhythm-rom.js";
import { adpcmB } from "./adpcm-b.js";

const CLOCK = 7987200;
const SSG_CLOCK = CLOCK / 4; // its tone and noise divide this by 16
const NOISE_RATE_START = 9; // the nearest to the Mega Drive's white0

// The rhythm sounds' bits in $10 (key, and dump with bit 7) and their level
// registers $18 + bit: pan in bits 7-6 (L, R), the level IL in bits 4-0.
const RHYTHM_BIT = { bd: 0, sd: 1, top: 2, hh: 3, tom: 4, rim: 5 };
const PAN_BITS = { [-1]: 0x80, 0: 0xc0, 1: 0x40 };

export const ym2608 = {
  chip: "ym2608",
  clock: CLOCK,
  fnumRate: CLOCK / 144,
  parts: [opnFm, ssgTone, ssgNoise, rhythmRom, adpcmB],
  encoder: true, // FM, SSG, rhythm (the ADPCM-B's notes write nothing yet)
  emulator: false,
  ssg: { clock: SSG_CLOCK, noiseRate: NOISE_RATE_START },
  // Written once before anything else. $29 bit 7 (SCH) opens fm4-fm6, which
  // the chip starts without (its OPN-compatible mode); the rhythm's total
  // level RTL stays at its top (each hit's level is its IL); the SSG starts
  // with every channel on tone and the song's noise period at its start.
  init: [[0, 0x29, 0x80], [0, 0x11, 0x3f], [0, 0x07, 0x38], [0, 0x06, NOISE_RATE_START]],
  vgm: { version: 0x151, clock: 0x48, ports: { 0: { cmd: 0x56, addr: true }, 1: { cmd: 0x57, addr: true } } },

  // The SSG as the IR player's PSG: lanes 0-2 are the tone channels, lane 3
  // the noise track, which is channel 3's (index 2) mixer on noise. One per
  // player: it keeps the mixer register the channels share.
  psgEncoder() {
    let mixer = 0x38; // bits 0-2 tone off, 3-5 noise off, per channel
    const phys = (lane) => (lane === 3 ? 2 : lane);
    return {
      // The 12-bit period divides the SSG's clock by 16.
      period: (hz) => Math.max(1, Math.min(4095, Math.round(SSG_CLOCK / (16 * hz)))),
      // The player's attenuation, 0 loud .. 15 off, is the level upside down.
      att: (lane, att) => [[0, 0x08 + phys(lane), 15 - (att & 0x0f)]],
      tone: (lane, p) => [[0, 2 * lane, p & 0xff], [0, 2 * lane + 1, (p >> 8) & 0x0f]],
      // A noise note: its channel's mixer on noise alone (the SSG's noise
      // has no mode; its period is the song's NOISE_RATE).
      noise: () => mix(3, 1),
      mix: (lane, mode) => mix(lane, mode),
      noiseRate: (rate) => [[0, 0x06, Math.max(1, Math.min(31, Math.round(rate)))]],
    };
    function mix(lane, mode) { // SSG_MIX: 0 tone, 1 noise, 2 both
      const c = phys(lane);
      mixer &= ~((1 << c) | (8 << c));
      if (mode === 0) mixer |= 8 << c;
      else if (mode === 1) mixer |= 1 << c;
      return [[0, 0x07, mixer]];
    }
  },

  rhythm: {
    // A hit: its level and pan, then its key.
    hit: (sound, il, pan) => [
      [0, 0x18 + RHYTHM_BIT[sound], (PAN_BITS[pan] ?? 0xc0) | Math.max(0, Math.min(31, il))],
      [0, 0x10, 1 << RHYTHM_BIT[sound]],
    ],
    // `:mode gate`'s end: the dump bit stops the sound.
    dump: (sound) => [[0, 0x10, 0x80 | (1 << RHYTHM_BIT[sound])]],
  },
};
