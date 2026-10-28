// The Famicom Disk System's sound (the RP2C33's): one wavetable channel — 64
// steps of 6 bits, a 12-bit pitch, a gain of 0-32 (the register takes 63;
// the output stops at 32) — and its modulation unit, which bends the
// channel's pitch: a 32-entry table of steps (0, ±1, ±2, ±4, or back to 0)
// added up in a 7-bit signed counter, the counter times a depth of 0-63
// scaling the pitch, the table run through at its own 12-bit rate — slow,
// a vibrato; near the pitch, a bright, clangy FM. How the chip reads its
// registers is nesdev's FDS audio page, which NSFPlay and Mesen follow.
//
// The language (language.md §19, fc): `wave1` plays def-waves — a 32-step
// one with each step held twice (64 slots, the same wave; never
// interpolated) — at the level `:vel` / `:vol` compose onto the gain; the
// song's `:lfo-freq` (0-4095) is the modulation's rate, `:lfo-pmd` (0-63)
// its depth and `:lfo-wave` its table, 32 of the chip's steps (0, ±1, ±2,
// ±4, `reset`). Its volume and modulation envelopes are not the language's:
// the encoder writes the gains itself.
//
// Its registers are the worklet's port 4 at VGM's own 0xB4 numbering:
// $20-$3E $4080-$409E, $3F $4023, $40-$7F the wave memory ($4040-$407F):
// $20 the gain (bit 7: direct, no envelope), $22 / $23 the pitch's low byte
// and top nibble, $24 the modulation's depth (bit 7 direct), $25 its
// counter, $26 / $27 its rate (bit 7 of $27 halts it and opens the table
// to $28, each write the next entry), $29 the wave memory's write enable
// (bit 7, holding the output while it is set) and the master volume (bits
// 1-0: 0 full), $2A the envelopes' speed (0: off).
import { words } from "./parts.js";

const CLOCK = 1789773; // the Famicom's CPU clock, the chip's
const PORT = 4;
export const FDS_WAVE_LEN = 64;
const PITCH_MAX = 0xfff;
// A register's port address: $4080-$409E as $20-$3E, $4023 as $3F, the
// wave memory as $40-$7F (VGM 0xB4's numbering).
export const fdsAddr = (reg) => (reg === 0x4023 ? 0x3f : reg >= 0x4080 ? 0x20 + (reg - 0x4080) : reg - 0x4000);
/** A port 4 address as the chip's register. */
export const fdsRegister = (addr) => (addr === 0x3f ? 0x4023 : addr >= 0x40 ? 0x4000 + addr : 0x4080 + (addr - 0x20));
// The modulation table's steps as the language writes them, and the chip's
// 3-bit codes for them ($4088).
export const FDS_MOD_STEPS = { 0: 0, 1: 1, 2: 2, 4: 3, reset: 4, "-4": 5, "-2": 6, "-1": 7 };
export const FDS_MOD_LEN = 32;

export const fdsWave = {
  name: "fds",
  label: "FDS wave",
  kind: "wave",
  level: { scale: "linear", steps: 33 }, // the gain: 32 loud .. 0 off
  words: words("WAVE"),
  songWords: words("LFO_FREQ", "LFO_PMD", "LFO_WAVE"),
  // `:lfo-wave` is a table of the modulation's steps here, not the OPM's
  // waveforms (mmlisp2ir.js).
  lfoTable: true,
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the FDS has no :mode; its sound is its def-wave" },
};

// The FDS as the IR player's wave lane (chips/k051649.js's shape): lane 0 is
// its one channel; its LFO writes are the song's (`lfoFreq`, `lfoPmd`,
// `lfoTable`).
function fdsEncoder() {
  let modHi = 0; // $4087's top nibble as written
  const at = (reg, v) => [PORT, fdsAddr(reg), v & 0xff];
  return {
    // A 64-step cycle is the clock × p / 16 / 2^18.
    period: (hz) => Math.max(0, Math.min(PITCH_MAX, Math.round((hz * 16 * 2 ** 18) / CLOCK))),
    // The player's attenuation, 0 loud .. 32 off, is the gain upside down.
    att: (_ch, att) => [at(0x4080, 0x80 | (32 - Math.max(0, Math.min(32, att | 0))))],
    tone: (_ch, p) => [at(0x4082, p & 0xff), at(0x4083, (p >> 8) & 0x0f)],
    // The memory written with the output held: the steps as 6-bit levels,
    // a 32-step wave each step twice.
    wave: (_ch, data) => {
      const rep = FDS_WAVE_LEN / data.length;
      const steps = Array.from({ length: FDS_WAVE_LEN }, (_, i) => (data[Math.floor(i / rep)] + 128) >> 2);
      return [at(0x4089, 0x80), ...steps.map((v, i) => at(0x4040 + i, v)), at(0x4089, 0x00)];
    },
    lfoFreq: (v) => {
      const f = Math.max(0, Math.min(PITCH_MAX, Math.round(Number(v) || 0)));
      modHi = f >> 8;
      return [at(0x4086, f & 0xff), at(0x4087, modHi)];
    },
    lfoPmd: (v) => [at(0x4084, 0x80 | Math.max(0, Math.min(63, Math.round(Number(v) || 0))))],
    // The table: the unit halted (its table open), the 32 codes, the
    // counter back to 0, and the unit running again.
    lfoTable: (steps) => [
      at(0x4087, 0x80 | modHi),
      ...steps.map((v) => at(0x4088, FDS_MOD_STEPS[String(v)] ?? 0)),
      at(0x4085, 0x00),
      at(0x4087, modHi),
    ],
  };
}

export const fds = {
  chip: "fds",
  clock: CLOCK,
  parts: [fdsWave],
  encoder: true,
  emulator: true,
  // A cartridge (the Disk System's RAM adapter): started at its first write,
  // so a score that does not name wave1 has none (chips/k051649.js).
  optional: true,
  // Sound on ($4023), the gains direct and 0, the envelopes off, the
  // modulation still (rate 0, depth 0, an empty table), the master volume
  // full, and the wave a square until a track names a def-wave.
  init: [
    [PORT, fdsAddr(0x4023), 0x83],
    [PORT, fdsAddr(0x408a), 0x00],
    [PORT, fdsAddr(0x4080), 0x80],
    [PORT, fdsAddr(0x4084), 0x80],
    [PORT, fdsAddr(0x4087), 0x80], ...Array.from({ length: FDS_MOD_LEN }, () => [PORT, fdsAddr(0x4088), 0]),
    [PORT, fdsAddr(0x4085), 0x00], [PORT, fdsAddr(0x4086), 0x00], [PORT, fdsAddr(0x4087), 0x00],
    [PORT, fdsAddr(0x4089), 0x80],
    ...Array.from({ length: FDS_WAVE_LEN }, (_, i) => [PORT, fdsAddr(0x4040 + i), i < 32 ? 63 : 0]),
    [PORT, fdsAddr(0x4089), 0x00],
  ],
  // VGM 1.61: the 2A03's 0xB4, its registers $20-$7F; the FDS is bit 31 of
  // the 2A03's clock (written after the 2A03's own, so it stands).
  vgm: {
    version: 0x161,
    clock: 0x84,
    header: [[0x84, 4, (CLOCK | 0x80000000) >>> 0]],
    ports: { [PORT]: { cmd: 0xb4, addr: true } },
  },
  waveEncoder: fdsEncoder,
};
