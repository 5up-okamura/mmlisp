// The SSG (the YM2608's, the AY-3-8910's): three channels, each with a mixer
// that sends it tone, noise or both, one noise period the three share, and
// a 4-bit level. The `noise` track is a channel with its mixer on noise —
// on the YM2608 the third (targets/pc88.js).
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
