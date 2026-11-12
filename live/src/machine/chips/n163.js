// The N163, Namco's Famicom cartridge chip (Megami Tensei II, King of
// Kings): up to eight wavetable channels in 128 bytes of RAM — 4-bit
// samples, two a byte, low nibble first — which the channels' registers
// share from the top: channel 8's at $78-$7F, each one before it 8 bytes
// lower. A channel's 8 bytes are its 18-bit frequency ($x0, $x2, $x4 bits
// 1-0), its 24-bit phase ($x1, $x3, $x5), its wave's length ($x4 bits 7-2:
// 256 − that many samples), its wave's start (a sample address, $x6) and
// its 4-bit volume ($x7); $7F's bits 6-4 are how many channels run, less
// one — channels 8 down. The chip does not mix: every 15 CPU clocks it
// steps the next running channel and outputs that one alone, so eight
// channels each sound an eighth of the time, and their switching (~15 kHz
// at eight) is heard. A tone is clock × f / (15 × 65536 × length × count).
// How the chip reads it is nesdev's Namco 163 audio page.
//
// In the language (language.md §19, fc): `n163-wave1`-`n163-wave8` play
// def-waves at the 4-bit volume. The score's channels set the count — the
// highest it names — and wave1 is the chip's channel 8. Each channel has a
// region of the RAM below the registers: a 32-step wave while the count is
// 5 or fewer, 16 steps (every other one) at 6 or more, which a warning
// says.
//
// Its RAM is the worklet's port 8, $00-$7F ($F800 selects a byte, $4800
// writes it). No VGM command writes the N163: its port is one VGM has none
// for (`null`), so a score's VGM leaves its channels out and says so.
import { words } from "./parts.js";

const CLOCK = 1789773; // the Famicom's CPU clock, the chip's
const PORT = 8;
const RAM = 128;
const REGS = 8; // a channel's registers
const FREQ_MAX = 0x3ffff;

/** How many 4-bit steps a channel's wave has at `count` channels: 32 while they fit the RAM, else 16. */
export const n163WaveSteps = (count) => (count * (REGS + 16) <= RAM ? 32 : 16);
/** Channel `voice`'s registers (wave1 is the chip's channel 8, at $78). */
export const n163Base = (voice) => RAM - REGS * (voice + 1);

export const n163Wave = {
  name: "n163",
  label: "N163 wave",
  kind: "wave",
  level: { scale: "linear", steps: 16 }, // the 4-bit volume, 15 loud .. 0 off
  words: words("WAVE"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "an N163 channel has no :mode; its sound is its def-wave" },
  // After the 5B's lanes (targets.js toneLaneOf): 21-28.
  toneLane: (c) => 21 + c.voice,
  // Six channels or more halve every wave: said once a score.
  checkScore({ target, allHeads, push }) {
    const heads = [...allHeads].filter((h) => target.partOf(h) === this);
    const count = Math.max(0, ...heads.map((h) => target.channels[h].voice + 1));
    if (n163WaveSteps(count) < 32)
      push("warning", "W_TARGET",
        `with ${count} N163 channels running (the highest named, n163-wave${count}) their waves share the chip's 128 bytes as 16 steps each: a def-wave plays every other step`);
  },
};

// The N163 as the IR player's wave lanes: lane n is n163-wave(n + 1), the
// chip laid out for the score's channels (`voices`, the IR player's
// _voicesOf): the count, each one's region and length, written at its start.
function n163Encoder(voices = new Set()) {
  const count = Math.max(1, ...[...voices].map((v) => v + 1));
  const steps = n163WaveSteps(count);
  const lenByte = 256 - steps; // $x4 bits 7-2
  const countBits = (count - 1) << 4; // $7F's, beside channel 8's volume
  const at = (voice, reg, v) => [PORT, n163Base(voice) + reg, v & 0xff];
  // A wave as the region's bytes: `steps` of its steps, 4 bits each.
  const waveBytes = (voice, data) => {
    const s = Array.from({ length: steps }, (_, i) => (data[Math.floor((i * data.length) / steps)] + 128) >> 4);
    return Array.from({ length: steps / 2 }, (_, i) => [PORT, (voice * steps) / 2 + i, s[2 * i] | (s[2 * i + 1] << 4)]);
  };
  const square = Array.from({ length: 32 }, (_, i) => (i < 16 ? 127 : -128));
  return {
    period: (hz) => Math.max(0, Math.min(FREQ_MAX, Math.round((hz * 15 * 65536 * steps * count) / CLOCK))),
    // The player's attenuation, 0 loud .. 15 off, is the volume upside down.
    att: (ch, att) => [at(ch, 7, (ch === 0 ? countBits : 0) | (15 - (att & 0x0f)))],
    tone: (ch, p) => [at(ch, 0, p), at(ch, 2, p >> 8), at(ch, 4, lenByte | ((p >> 16) & 3))],
    wave: (ch, data) => waveBytes(ch, data),
    // Each running channel silent at frequency 0, its region a square, its
    // length and start set; the count in $7F.
    start: () => Array.from({ length: count }, (_, v) => [
      ...waveBytes(v, square),
      ...[0, 1, 2, 3, 5].map((r) => at(v, r, 0)),
      at(v, 4, lenByte), at(v, 6, v * steps), at(v, 7, v === 0 ? countBits : 0),
    ]).flat(),
  };
}

export const n163 = {
  chip: "n163",
  clock: CLOCK,
  parts: [n163Wave],
  encoder: true,
  emulator: true,
  // A cartridge: started at its first write (the encoder's `start`), so a
  // score that names none of its channels has none.
  optional: true,
  init: [],
  // No VGM block (the format has no N163): its port is claimed, with no
  // command — a VGM leaves its writes out.
  vgm: { ports: { [PORT]: null } },
  waveEncoder: n163Encoder,
};
