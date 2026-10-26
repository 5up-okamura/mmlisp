// The OPN family's 4-operator FM channel (YM2612, YM2608): the operator
// registers, the algorithm and feedback, the chip's one LFO, and FM3's
// independent-operator and CSM tracks.
import { words } from "./parts.js";
import { fmWords } from "./fm-words.js";
import { OP_ADDR_OFFSET, encodeB0, encodeB4, encode30, encode60, encode80, midiToFnumBlock } from "../ir-utils.js";

export const opnFm = {
  name: "fm",
  label: "OPN FM",
  kind: "fm",
  level: { stepDb: 0.75, steps: 128 },
  words: fmWords({
    channel: ["FM_ALG", "FM_FB", "FM_AMS", "FM_FMS"],
    op: ["FM_AR", "FM_DR", "FM_SR", "FM_RR", "FM_SL", "FM_TL", "FM_KS", "FM_ML", "FM_DT", "FM_SSG", "FM_AMEN", "FM_VEL"],
    more: ["PAN"],
  }),
  songWords: words("LFO_RATE"),
};

// The OPN's FM as the IR player's FM: each operation as [port, addr, data]
// writes. Six channels, three per port; a channel's operator registers are
// its base + the operator's slot offset + the channel within the port. FM3's
// independent operators, CSM and Timer A are CH3's own modes (`csm`): the IR
// player keeps their state (driver.md §9, §13.4), their registers are here.
export function opnFmEncoder(fnumRate, clock) {
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
      const r = OP_REG[reg];
      return r ? [[port, r[0] + OP_ADDR_OFFSET[opIdx] + off, r[1](o)]] : []; // another family's register
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
    // $27: CH3's mode (bit 6 FM3 special, bit 7 CSM) and the timers' control.
    mode: (reg27) => [[0, 0x27, reg27]],
    // Timer A's value for a rate: hz = clock / (144 · (1024 − TA)).
    timerAOf: (hz) => Math.max(0, Math.min(1023, Math.round(1024 - clock / (144 * Math.max(1, Number(hz) || 1))))),
    timerA: (ta) => [[0, 0x24, (ta >> 2) & 0xff], [0, 0x25, ta & 0x03]],
    // CH3's operator `opIdx` (0-3) TL — under CSM its key (driver.md §9).
    ch3Tl: (opIdx, tl) => [[0, 0x40 + OP_ADDR_OFFSET[opIdx] + 2, tl]],
    // An FM3 operator's own pitch (op 1-4), high byte first: op4 reads the
    // channel's ($A6/$A2), op1-3 their own, which are NOT in order — on the
    // chip (Nuked-OPN2's fnum_3ch decode) OP1 reads $AD/$A9, OP2 $AE/$AA and
    // OP3 $AC/$A8.
    ch3OpPitch(op, midi) {
      const { fnum, block } = midiToFnumBlock(midi, fnumRate);
      const high = ((block & 0x07) << 3) | ((fnum >> 8) & 0x07), low = fnum & 0xff;
      if (op === 4) return [[0, 0xa6, high], [0, 0xa2, low]];
      const idx = [1, 2, 0][op - 1];
      return idx == null ? [] : [[0, 0xac + idx, high], [0, 0xa8 + idx, low]];
    },
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
