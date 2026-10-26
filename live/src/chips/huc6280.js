// The HuC6280's PSG, the PC Engine's sound: six channels, each a 32-step
// wave of 5-bit values played at a 12-bit frequency, a 5-bit volume (1.5 dB
// a step) and a 4-bit level a side; channels 5 and 6 can turn to noise
// instead, each at its own 5-bit rate. A score's waves are its def-waves
// (language.md §19, pce), their −128..127 steps written at the chip's 5 bits.
// Not here yet: DDA (a channel as a 5-bit DAC), the ch2 → ch1 LFO, :pan.
//
// Its registers, as the CPU maps them at $0800 (the worklet's port 0): $00
// the channel select, $01 the main level (L high, R low), then the selected
// channel's $02/$03 frequency (low byte, high nibble), $04 its on bit (7),
// DDA bit (6) and volume (4-0), $05 its L/R levels, $06 its wave, one step
// a write — written with the channel off, from step 0, which a DDA bit
// dropped (1 → 0) puts the step at — and $07, on channels 5 and 6, the
// noise: bit 7 on, bits 4-0 its rate. How the chip reads them (the tone's
// step, the volume's 1.5 dB, the noise's clock, the wave's centre at 16) is
// MAME's c6280.cpp and Mednafen's pce_psg.cpp, which agree but for the
// noise at rate 31 (Mednafen's taken: synth-pce.js).
import { NO_WORDS, words } from "./parts.js";

const CLOCK = 3579545; // the CPU's 7.16 MHz / 2
const PORT = 0;
export const WAVE_LEN = 32;
export const CHANNELS = 6;
export const NOISE_CHANNELS = [4, 5];
const PERIOD_MIN = 1;
// A wave is loaded with the channel off, so a switch under a note cuts it:
// the player holds a `:wave` written under a note to the next key-on.
const LEVEL = { stepDb: 1.5, steps: 32 }; // the 5-bit volume, 31 loud .. 0
// Channels 5 and 6 as noise: the page's tone lanes after the six waves.
const NOISE_LANE = (c) => 4 + CHANNELS + (c.voice - NOISE_CHANNELS[0]);
// A noise note's rate: c2 is the slowest of the 32 (the LFSR clocked every
// 31 × 64 chip clocks, 1.8 kHz), each semitone the next, up to g4 — as a
// tracker reads a noise note, since the rates are a clock, not a pitch.
export const NOISE_NOTE_BASE = 36;

export const pceWave = {
  name: "pce",
  label: "PC Engine wave",
  unit: "pce",
  kind: "wave",
  level: LEVEL,
  words: words("WAVE"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "a PC Engine channel has no :mode; its sound is its def-wave, or noise5 / noise6" },
  waveAtKeyOn: true,
};

export const pceNoise = {
  name: "pce-noise",
  label: "PC Engine noise",
  unit: "pce",
  kind: "noise",
  level: LEVEL,
  words: NO_WORDS,
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the PC Engine's noise has no :mode; its rate is the note, c2 to g4" },
  toneLane: NOISE_LANE,
  // It is a wave channel turned to noise: the two names are one channel.
  shareHint: (other) => `a channel plays its wave or the noise; move ${other} to another channel`,
};

// The default wave a channel plays until its track names one: a square.
export const DEFAULT_WAVE = Array.from({ length: WAVE_LEN }, (_, i) => (i < WAVE_LEN / 2 ? 127 : -128));

/** A −128..127 step as the chip's 5-bit value, 0..31. */
export const waveStep = (v) => Math.max(0, Math.min(31, (Math.round(v) + 128) >> 3));

// The HuC6280 as the IR player's wave lanes, with channels 5 and 6 as
// noise lanes too. One encoder a player: it keeps each channel's volume
// and noise state, which the on/off register and the wave load rewrite.
function pceEncoder() {
  const vol = new Uint8Array(CHANNELS); // 0..31, as written (0 while off)
  const on = new Uint8Array(CHANNELS);
  const noise = new Uint8Array(CHANNELS); // $07 as written
  const sel = (ch) => [PORT, 0x00, ch];
  const ctl = (ch) => [PORT, 0x04, on[ch] ? 0x80 | vol[ch] : 0x00];
  // The player's attenuation, 0 loud .. 31 off: off is the channel off.
  const level = (ch, att) => {
    on[ch] = att < LEVEL.steps - 1 ? 1 : 0;
    vol[ch] = on[ch] ? LEVEL.steps - 1 - att : 0;
    return [sel(ch), ctl(ch)];
  };
  // A 12-bit frequency: the tone is the clock / 32 / f.
  const freqOf = (hz) => Math.max(PERIOD_MIN, Math.min(4095, Math.round(CLOCK / (WAVE_LEN * hz))));
  const enc = {
    period: freqOf,
    att: level,
    tone: (ch, f) => [sel(ch), [PORT, 0x02, f & 0xff], [PORT, 0x03, (f >> 8) & 0x0f]],
    // The wave, 32 steps with the channel off: the DDA bit raised and dropped
    // puts the step at 0, each write then takes the next; then on again as
    // it was (silent while it loads: a switch under a note is held to its
    // key-on by the player).
    wave: (ch, data) => [
      sel(ch), [PORT, 0x04, 0x40], [PORT, 0x04, 0x00],
      ...data.map((v) => [PORT, 0x06, waveStep(v)]),
      ctl(ch),
    ],
  };
  // Channels 5 and 6 as noise: the note (the player hands its Hz) is one of
  // the 32 rates from NOISE_NOTE_BASE, its level the channel's.
  const noiseRate = (hz) => Math.max(0, Math.min(31, Math.round(69 + 12 * Math.log2(hz / 440)) - NOISE_NOTE_BASE));
  enc.noise = {
    period: noiseRate,
    att: (ch, att) => [...level(ch, att), [PORT, 0x07, noise[ch] = (on[ch] ? 0x80 : 0) | (noise[ch] & 0x1f)]],
    tone: (ch, n) => [sel(ch), [PORT, 0x07, noise[ch] = 0x80 | (n & 0x1f)]],
  };
  return enc;
}

export const huc6280 = {
  chip: "huc6280",
  clock: CLOCK,
  parts: [pceWave, pceNoise],
  encoder: true,
  emulator: true,
  // Every channel off at full L/R level, the main level full, playing the
  // default wave; the noise off.
  init: [
    [PORT, 0x01, 0xff],
    ...Array.from({ length: CHANNELS }, (_, ch) => [
      [PORT, 0x00, ch], [PORT, 0x04, 0x40], [PORT, 0x04, 0x00], [PORT, 0x05, 0xff], [PORT, 0x07, 0x00],
      ...DEFAULT_WAVE.map((v) => [PORT, 0x06, waveStep(v)]),
    ]).flat(),
  ],
  // VGM 1.61: the clock at $A4, the 0xB9 command.
  vgm: { version: 0x161, clock: 0xa4, ports: { [PORT]: { cmd: 0xb9, addr: true } } },
  waveEncoder: pceEncoder,
};
