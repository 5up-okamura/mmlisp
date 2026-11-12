// The VRC6, Konami's Famicom cartridge chip (Akumajou Densetsu, Madara,
// Esper Dream 2): two pulses (a 4-bit level, eight duties) and a sawtooth
// (a 6-bit rate). How the chip reads its registers is nesdev's VRC6 audio
// page, which NSFPlay and Mesen follow.
//
// Its registers are the worklet's port 3, $9000-$B002 as (high nibble − 9)
// × 4 + the low two bits: $00-$02 pulse 1, $03 the frequency control, $04-
// $06 pulse 2, $08-$0A the saw. A pulse's $x000 holds its duty (6-4: step
// ≤ D of a 16-step counter sounds, 1/16-8/16) and volume (3-0), bit 7 a
// 100 % duty; $x001 its 12-bit period's low byte; $x002 its enable (7) and
// the period's top four bits. The saw's $B000 is its rate A (5-0): A is
// added to an 8-bit accumulator on every other step, which starts over each
// 14 steps; its top five bits are the output — so a rate over 42 wraps (a
// harsher sound, not a louder one: the language says nothing of it, the
// reference says where it starts). Clearing a channel's enable silences it
// and starts its duty / accumulator over; the encoder keeps them enabled
// and keys by the level, as the 2A03's does (chips/rp2a03.js).
//
// No VGM command writes the VRC6: its port is one VGM has none for (`null`),
// so a score's VGM leaves its channels out and says so (export-vgm.js); the
// preview and the WAV play them (synth-fc.js).
import { words } from "./parts.js";
import { queuedToneEncoder } from "./queued-tone.js";

const CLOCK = 1789773; // the Famicom's CPU clock, the chip's
const PORT = 3; // a cartridge's, as the MSX's SCC (2 is the worklet's PSG)
const PERIOD_MAX = 0xfff;
// The registers of each channel: its control, period low, period high.
const BASE = [0x00, 0x04, 0x08];
export const VRC6_FREQ_CTL = 0x03;

/** A port 3 address as the chip's register ($9000-$B002). */
export const vrc6Register = (addr) => 0x9000 + ((addr >> 2) << 12) + (addr & 3);

/** A duty in sixteenths (0-16) as $x000's bits 6-4: the nearest of 1-8, a wider one its mirror (16 − d sounds the same). */
export function vrc6DutyCode(sixteenths) {
  const v = Number(sixteenths) || 0;
  const m = v > 8 ? 16 - v : v;
  return Math.max(1, Math.min(8, Math.round(m))) - 1;
}

export const vrc6Pulse = {
  name: "vrc6-pulse",
  label: "VRC6 pulse",
  unit: "vrc6",
  kind: "tone",
  level: { scale: "linear", steps: 16 }, // the 4-bit volume, 15 loud .. 0 off
  words: words("DUTY"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "a VRC6 pulse has no :mode; its shape is :duty" },
  // After the PC Engine's lanes (targets.js toneLaneOf): 12, 13.
  toneLane: (c) => 12 + c.voice,
};

export const vrc6Saw = {
  name: "vrc6-saw",
  label: "VRC6 saw",
  unit: "vrc6",
  kind: "tone",
  level: { scale: "linear", steps: 64 }, // the rate: 63 loud .. 0 off, over 42 wrapping
  words: () => false,
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the VRC6's saw has no :mode" },
  toneLane: () => 14,
};

// The VRC6 as the IR player's lanes (chips/queued-tone.js): a pulse's
// $x000 holds its volume and its duty; the saw's its rate. A pulse is the
// clock / 16 / (period + 1), the saw / 14.
const period = (div) => (hz) => Math.max(0, Math.min(PERIOD_MAX, Math.round(CLOCK / (div * hz)) - 1));
const vrc6Encoder = () => queuedToneEncoder({
  port: PORT,
  channels: 3,
  pulses: 2,
  startDuty: 7, // 50 %
  top: (ch) => (ch < 2 ? 15 : 63), // the pulses' 15 steps, the saw's 63
  ctl: (ch) => BASE[ch],
  ctlByte: (ch, duty, v) => (ch < 2 ? (duty << 4) | v : v),
  lo: (ch) => BASE[ch] + 1,
  hi: (ch) => BASE[ch] + 2,
  hiByte: (bits) => 0x80 | bits, // enabled: a channel is keyed by its level
  period: (ch) => period(ch < 2 ? 16 : 14),
  duty: vrc6DutyCode,
});

export const vrc6 = {
  chip: "vrc6",
  clock: CLOCK,
  parts: [vrc6Pulse, vrc6Saw],
  encoder: true,
  emulator: true,
  // A cartridge: started at its first write, so a score that names none of
  // its channels has none (chips/k051649.js).
  optional: true,
  // The frequency control at 0 (no halt, no 16× / 256×: nesdev — write it
  // once and leave it), each channel enabled and silent, the pulses at 50 %.
  init: [
    [PORT, VRC6_FREQ_CTL, 0x00],
    ...BASE.flatMap((b, ch) => [[PORT, b, ch < 2 ? 7 << 4 : 0], [PORT, b + 2, 0x80]]),
  ],
  // No VGM block (the format has no VRC6): its port is claimed, with no
  // command — a VGM leaves its writes out.
  vgm: { ports: { [PORT]: null } },
  toneEncoder: vrc6Encoder,
};
