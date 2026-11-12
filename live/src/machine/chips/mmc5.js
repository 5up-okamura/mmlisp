// The MMC5, Nintendo's mapper with sound (Just Breed, Metal Slader Glory):
// two pulses, the 2A03's without the sweep — a 4-bit level, the four
// duties, an 11-bit period whose top bits load a length counter — and a
// PCM channel the language leaves out (one game wrote it, a byte at a
// time). How the chip reads its registers is nesdev's MMC5 audio page,
// which NSFPlay and Mesen follow: a period under 8 sounds (the 2A03's is
// silent there), and its output is the 2A03 pulse's, inverted.
//
// Its registers are the worklet's port 5, $5000-$5015 as $00-$15: $00 /
// $04 a pulse's duty (7-6), length halt (5), constant volume (4) and
// volume (3-0); $02 / $06 its period's low byte; $03 / $07 its top three
// bits under the length counter's load (a write that starts the duty
// over, so it is written only when they change); $15 the pulses' enables.
// The encoder keeps the length counter halted and keys by the level, as
// the 2A03's does (chips/rp2a03.js).
//
// No VGM command writes the MMC5: its port is one VGM has none for (`null`),
// so a score's VGM leaves its channels out and says so (export-vgm.js).
import { words } from "./parts.js";
import { dutyCode } from "./rp2a03.js";
import { queuedToneEncoder } from "./queued-tone.js";

const CLOCK = 1789773; // the Famicom's CPU clock, the chip's
const PORT = 5;
const PERIOD_MAX = 0x7ff;
const LENGTH = 1 << 3; // the length counter's load, held by its halt bit
const DEFAULT_DUTY = 2; // 50 %

/** A port 5 address as the chip's register ($5000-$5015). */
export const mmc5Register = (addr) => 0x5000 + addr;

export const mmc5Pulse = {
  name: "mmc5-pulse",
  label: "MMC5 pulse",
  unit: "mmc5",
  kind: "tone",
  level: { scale: "linear", steps: 16 }, // the 4-bit volume, 15 loud .. 0 off
  words: words("DUTY"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "an MMC5 pulse has no :mode; its shape is :duty" },
  // After the VRC6's lanes (targets.js toneLaneOf): 15, 16.
  toneLane: (c) => 15 + c.voice,
};

// The pulses as the IR player's lanes (chips/queued-tone.js): $00 / $04 its
// duty and volume; a pulse is the clock / 16 / (period + 1).
const mmc5Encoder = () => queuedToneEncoder({
  port: PORT,
  channels: 2,
  pulses: 2,
  startDuty: DEFAULT_DUTY,
  top: () => 15,
  ctl: (ch) => 4 * ch,
  ctlByte: (_ch, duty, v) => (duty << 6) | 0x30 | v,
  lo: (ch) => 4 * ch + 2,
  hi: (ch) => 4 * ch + 3,
  hiByte: (bits) => LENGTH | bits,
  period: () => (hz) => Math.max(0, Math.min(PERIOD_MAX, Math.round(CLOCK / (16 * hz)) - 1)),
  duty: dutyCode,
});

export const mmc5 = {
  chip: "mmc5",
  clock: CLOCK,
  parts: [mmc5Pulse],
  encoder: true,
  emulator: true,
  // A cartridge: started at its first write, so a score that names neither
  // pulse has none (chips/k051649.js).
  optional: true,
  // Both pulses enabled, at volume 0 and 50 %, their length counters loaded.
  init: [
    [PORT, 0x15, 0x03],
    [PORT, 0x00, (DEFAULT_DUTY << 6) | 0x30], [PORT, 0x03, LENGTH],
    [PORT, 0x04, (DEFAULT_DUTY << 6) | 0x30], [PORT, 0x07, LENGTH],
  ],
  // No VGM block (the format has no MMC5): its port is claimed, with no
  // command — a VGM leaves its writes out.
  vgm: { ports: { [PORT]: null } },
  toneEncoder: mmc5Encoder,
};
