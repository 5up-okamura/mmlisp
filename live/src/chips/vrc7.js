// The VRC7, Konami's Famicom cartridge chip with FM (Lagrange Point): a
// YM2413 cut down to six channels, its fifteen ROM voices its own (Nuked-
// OPLL's patch_ds1001), no rhythm. How it reads its registers is the
// YM2413's ($9010 selects one, $9030 writes it: nesdev's VRC7 audio page).
//
// In the language it is the OPLL (language.md §19, msx): 2-op voices, the
// carrier's level the channel's 4-bit volume, `:sus`, one user voice the
// chip shares, and the ROM voices built in by the names nesdev gives them.
// Its registers are the worklet's port 7, the chip's own $00-$35.
//
// VGM writes it as a YM2413 whose clock has bit 31 set (the VRC7's ROM).
import { opllFm, opllEncoder, VRC7_ROM } from "./ym2413.js";

const CLOCK = 3579545; // its own 3.58 MHz oscillator
const PORT = 7;

// The ROM voices' built-in names (nesdev's), in the ROM's order.
export const VRC7_ROM_NAMES = [
  "buzzy-bell", "guitar", "wurly", "flute", "clarinet", "synth", "trumpet", "organ", "bells",
  "vibes", "vibraphone", "tutti", "fretless", "synth-bass", "sweep",
];

export const vrc7Fm = {
  ...opllFm,
  name: "vrc7-fm",
  label: "VRC7 FM",
  rom: VRC7_ROM,
  romNames: VRC7_ROM_NAMES,
};

export const vrc7 = {
  chip: "vrc7",
  clock: CLOCK,
  parts: [vrc7Fm],
  encoder: true,
  emulator: true,
  // A cartridge: the encoder writes nothing before a key (chips/ym2413.js),
  // so a score with no VRC7 track has none.
  optional: true,
  init: [],
  // VGM 1.00: the YM2413's clock at 0x10, bit 31 set for the VRC7, and its
  // 0x51 command.
  vgm: { clock: 0x10, header: [[0x10, 4, (CLOCK | 0x80000000) >>> 0]], ports: { [PORT]: { cmd: 0x51, addr: true } } },
  fmEncoder: () => opllEncoder({ rom: VRC7_ROM, channels: 6, port: PORT }),
};
