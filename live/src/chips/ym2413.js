// The YM2413 (OPLL), the FM-PAC cartridge's FM: nine 2-op channels, each
// playing one of fifteen ROM voices or the one user voice ($00-$07), or six
// channels and the five rhythm sounds on the last three. ymfm's YM2413
// plays it (synth-msx.js); its ROM voices are ymfm's, the copyright-free
// set of David Viens and Hubert Lamontagne.
//
// Its registers, as the worklet's port 4: $00-$07 the user voice, $0E the
// rhythm, $10-$18 each channel's F-number (low 8 bits), $20-$28 its sustain,
// key, block and the F-number's top bit, $30-$38 its voice and volume.
//
// The channels' parts — the words, the voices, the rhythm — are not built
// yet (.claude/memory/targets.md): the chip is the bus, the emulator and the
// VGM block.

const CLOCK = 3579545; // the MSX's 3.58 MHz
export const OPLL_PORT = 4;

export const ym2413 = {
  chip: "ym2413",
  clock: CLOCK,
  parts: [],
  encoder: true,
  emulator: true,
  // A cartridge, as the SCC: a score with no OPLL write has no OPLL in its
  // VGM.
  optional: true,
  init: [],
  // VGM 1.00: the clock at 0x10, and the 0x51 command (an address and a byte).
  vgm: { clock: 0x10, ports: { [OPLL_PORT]: { cmd: 0x51, addr: true } } },
};
