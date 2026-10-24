// The SSG (the YM2608's, the AY-3-8910's): three channels, each with a mixer
// that sends it tone, noise or both, one noise period the three share, and
// a 4-bit level. The `noise` track is a channel with its mixer on noise —
// on the YM2608 and the AY-3-8910 the third (targets/pc88.js,
// targets/msx.js).
import { NO_WORDS, words } from "./parts.js";

// The song's noise period; a channel's mixer (0 tone, 1 noise, 2 both).
const NOISE_RATE = words("NOISE_RATE");
const SSG_LEVEL = { stepDb: 3, steps: 16 }; // the 4-bit level, 15 loud .. 0 off

export const ssgTone = {
  name: "ssg",
  label: "SSG tone",
  unit: "ssg",
  kind: "tone",
  level: SSG_LEVEL,
  words: words("SSG_MIX"),
  songWords: NOISE_RATE,
  modes: { tone: ["SSG_MIX", 0], noise: ["SSG_MIX", 1], both: ["SSG_MIX", 2] },
  modeError: { code: "E_PARAM_VALUE", message: "sqr :mode must be tone, noise or both" },
};

export const ssgNoise = {
  name: "ssg-noise",
  label: "SSG noise",
  unit: "ssg",
  kind: "noise",
  level: SSG_LEVEL,
  words: NO_WORDS,
  songWords: NOISE_RATE,
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the SSG's noise has no :mode; its period is the song's :noise-rate 1-31" },
  // It is a tone channel's mixer on noise: the two names are one channel.
  shareHint: (other) => `give ${other} :mode both, or move its part`,
};

// The SSG as the IR player's PSG, on a chip whose SSG divides `clock` by 16
// for a tone: lanes 0-2 are the tone channels, lane 3 the noise track, which
// is channel 3's (index 2) mixer on noise. One per player: it keeps the mixer
// register the channels share. `io` is the mixer's bits 7-6, the I/O ports'
// directions, written with it on a chip that has them wired (the MSX's).
export function ssgEncoder(clock, io = 0) {
  let mixer = io | 0x38; // bits 0-2 tone off, 3-5 noise off, per channel
  const phys = (lane) => (lane === 3 ? 2 : lane);
  return {
    // The 12-bit period divides the clock by 16.
    period: (hz) => Math.max(1, Math.min(4095, Math.round(clock / (16 * hz)))),
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
}
