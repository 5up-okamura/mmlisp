// The OPN family's 4-operator FM channel (YM2612, YM2608): the operator
// registers, the algorithm and feedback, the chip's one LFO, and FM3's
// independent-operator and CSM tracks.
import { words } from "./parts.js";
import { OP_ADDR_OFFSET, encodeB0, encodeB4, encode30, encode60, encode80, midiToFnumBlock } from "../ir-utils.js";

export const opnFm = {
  name: "fm",
  label: "OPN FM",
  kind: "fm",
  level: { stepDb: 0.75, steps: 128 },
  words: words(/^FM_(?!DT2_)/, "PAN"), // DT2 is the OPM's
  songWords: words("LFO_RATE"),
};

// The OPN's FM as the IR player's FM: each operation as [port, addr, data]
// writes. Six channels, three per port; a channel's operator registers are
// its base + the operator's slot offset + the channel within the port. FM3's
// independent operators, CSM and Timer A stay the IR player's own: only an
// OPN target has the tracks that reach them (`csm`).
export function opnFmEncoder(fnumRate) {
  const at = (ch) => [ch >= 3 ? 1 : 0, ch % 3];
  const OP_REG = {
    "dt-ml": [0x30, encode30],
    tl: [0x40, (o) => o.tl],
    "ks-ar": [0x50, (o) => (o.rs << 6) | o.ar],
    "am-dr": [0x60, encode60],
    sr: [0x70, (o) => o.d2r & 0x1f],
    "sl-rr": [0x80, encode80],
    "ssg-eg": [0x90, (o) => o.ssg & 0x0f],
  };
  return {
    channels: 6,
    csm: true,
    // One operator register, from the operator's shadow state `o`.
    op(ch, opIdx, reg, o) {
      const [port, off] = at(ch);
      const [base, encode] = OP_REG[reg];
      return [[port, base + OP_ADDR_OFFSET[opIdx] + off, encode(o)]];
    },
    // The algorithm and feedback.
    alg(ch, regs) {
      const [port, off] = at(ch);
      return [[port, 0xb0 + off, encodeB0(regs)]];
    },
    // The pan and the LFO sensitivities: one register on the OPN.
    pan(ch, regs) {
      const [port, off] = at(ch);
      return [[port, 0xb4 + off, encodeB4(regs)]];
    },
    // A (fractional) MIDI note: the block and F-number, high byte first.
    pitch(ch, midi) {
      const [port, off] = at(ch);
      const { fnum, block } = midiToFnumBlock(midi, fnumRate);
      return [[port, 0xa4 + off, ((block & 0x07) << 3) | ((fnum >> 8) & 0x07)], [port, 0xa0 + off, fnum & 0xff]];
    },
    // The key: `mask` the operators' bits 0x10 (op1) … 0x80 (op4), 0 off.
    key(ch, mask) {
      const [port, off] = at(ch);
      return [[0, 0x28, (mask & 0xf0) | (port << 2) | off]];
    },
    isKeyOn: (port, addr, data) => port === 0 && addr === 0x28 && (data & 0xf0) !== 0,
    // :lfo-rate: 0 off, 1-8 on at that rate.
    lfo: (rate) => [[0, 0x22, rate === 0 ? 0x00 : 0x08 | ((rate - 1) & 0x07)]],
  };
}

// The OPN's FM in Live's worklet, for a channel the keys hold over the song:
// which channel a write is (-1 a global; CH3's operator F-numbers $A8-$AE are
// CH3's), which write is the key and keys on, and the channel's registers in
// the order they are written back when the song takes it again.
export const opnHoldBus = {
  channelOf(port, addr, data) {
    if (addr === 0x28) {
      const c = data & 3;
      return c === 3 ? -1 : c + (data & 4 ? 3 : 0);
    }
    if ((addr >= 0x30 && addr < 0xa8) || (addr >= 0xb0 && addr < 0xb8)) {
      const c = addr & 3;
      return c === 3 ? -1 : c + (port ? 3 : 0);
    }
    if (port === 0 && addr >= 0xa8 && addr < 0xb0) return 2;
    return -1;
  },
  isKey: (a) => a === 0x28,
  keyOn: (d) => (d & 0xf0) !== 0,
  // Operators, $B0/$B4, then the F-numbers high byte first (CH3's operator
  // ones too).
  replay(ch) {
    const p = ch >= 3 ? 1 : 0, c = ch % 3, list = [];
    for (let a = 0x30 + c; a < 0xa0; a += 4) list.push([p, a]);
    list.push([p, 0xb0 + c], [p, 0xb4 + c], [p, 0xa4 + c], [p, 0xa0 + c]);
    if (ch === 2) for (const a of [0xac, 0xa8, 0xad, 0xa9, 0xae, 0xaa]) list.push([0, a]);
    return list;
  },
};
