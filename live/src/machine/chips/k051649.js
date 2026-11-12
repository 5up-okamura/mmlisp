// The SCC (Konami's K051649), the MSX cartridge's wavetable chip: five
// channels, each a 32-step wave of signed 8-bit values played at a 12-bit
// period, a 4-bit linear volume, and a key bit. Channels 4 and 5 share one
// wave memory. A score's waves are its def-waves (language.md §19, msx):
// the IR carries them in metadata.waves, and a track's PARAM_SET WAVE names
// the one its channel plays.
//
// Its registers, as the MSX maps them at $9800 (the worklet's port 3):
// $00-$7F the four wave memories, $80-$89 each channel's period (low byte,
// high nibble), $8A-$8E the volumes, $8F the key bits.
import { words } from "./parts.js";

// The clock as VGM gives a K051649's: half the MSX's 3.58 MHz the chip
// counts at, so a tone is this / 16 / (period + 1) — the PSG's pitch at the
// same period.
const CLOCK = Math.round(3579545 / 2);
const PORT = 3;
export const WAVE_LEN = 32;
export const WAVE_BITS = 8;
// A channel plays a square until its track names a def-wave.
export const DEFAULT_WAVE = Array.from({ length: WAVE_LEN }, (_, i) => (i < WAVE_LEN / 2 ? 127 : -128));
// The SCC stops a channel whose period is below 9.
const PERIOD_MIN = 9;

export const sccWave = {
  name: "scc",
  label: "SCC wave",
  kind: "wave",
  level: { scale: "linear", steps: 16 }, // the 4-bit volume, 15 loud .. 0 off
  words: words("WAVE"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "an SCC channel has no :mode; its sound is its def-wave" },
  // Channels 4 and 5 share the fourth wave memory.
  waveRam: (ch) => sccWaveRam(ch),
};

/** The wave memory channel `ch` (0-4) plays: channels 4 and 5 share the fourth. */
export function sccWaveRam(ch) {
  return Math.min(ch, 3);
}

// The SCC as the IR player's wave lanes: lane n is channel n.
function sccEncoder() {
  return {
    // A tone is the clock / 16 / (period + 1).
    period: (hz) => Math.max(PERIOD_MIN, Math.min(4095, Math.round(CLOCK / (16 * hz)) - 1)),
    // The player's attenuation, 0 loud .. 15 off, is the volume upside down.
    att: (ch, att) => [[PORT, 0x8a + ch, 15 - (att & 0x0f)]],
    tone: (ch, p) => [[PORT, 0x80 + 2 * ch, p & 0xff], [PORT, 0x81 + 2 * ch, (p >> 8) & 0x0f]],
    wave: (ch, data) => data.map((v, i) => [PORT, sccWaveRam(ch) * WAVE_LEN + i, v & 0xff]),
  };
}

export const k051649 = {
  chip: "k051649",
  clock: CLOCK,
  parts: [sccWave],
  encoder: true,
  emulator: true,
  // A cartridge: its start is written when a score (or a key) first plays
  // it, so a score with no SCC channel has no SCC in its VGM.
  optional: true,
  // Every channel silent and keyed (its volume is its gate), playing the
  // default wave.
  init: [
    ...[0, 1, 2, 3].flatMap((ram) => DEFAULT_WAVE.map((v, i) => [PORT, ram * WAVE_LEN + i, v & 0xff])),
    ...[0, 1, 2, 3, 4].map((ch) => [PORT, 0x8a + ch, 0]),
    [PORT, 0x8f, 0x1f],
  ],
  // VGM 1.61: the clock (bit 31 clear: the K051649, not the SCC+), and the
  // 0xD2 command, which splits the address into the chip's ports — 0 the
  // waves, 1 the periods, 2 the volumes, 3 the keys.
  vgm: {
    version: 0x161,
    clock: 0x9c,
    ports: {
      [PORT]: {
        cmd: 0xd2,
        sub: (addr) => (addr < 0x80 ? [0, addr] : addr < 0x8a ? [1, addr - 0x80] : addr < 0x8f ? [2, addr - 0x8a] : [3, 0]),
      },
    },
  },
  waveEncoder: sccEncoder,
};
