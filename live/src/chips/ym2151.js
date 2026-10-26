// The YM2151 (OPM): eight 4-operator FM channels on one address space, the
// eighth's fourth operator also the chip's noise, and an LFO with its own
// frequency, depths and waveform. ymfm's YM2151 plays it (synth-x68k.js).
//
// The FM is the OPN's language: the same operator words, DT2 beside DT1
// (`:dt2-1`…`:dt2-4`) and no SSG-EG. The IR player writes it through
// fmEncoder as it writes the OPN's.
//
// The noise is $0F: NE turns fm8's fourth operator into noise, NFRQ its
// period. fm8 turns it on as its `:mode noise` (targets/x68k.js) — the voice
// whole, its envelope and its other operators, as MXDRV plays a noise — and
// the `noise` channel plays it alone on that operator; both encoders keep
// the one $0F (noiseReg).
import { NO_WORDS, words } from "./parts.js";
import { fmWords } from "./fm-words.js";
import { encode30, encode80, panSide } from "../ir-utils.js";

const CLOCK = 4000000; // the X68000's
// The KC table is the chip's at 3.579545 MHz, where KC $4A is A4 = 440 Hz;
// another clock moves every note by the ratio.
const KC_CLOCK = 3579545;

export const opmFm = {
  name: "opm-fm",
  label: "OPM FM",
  unit: "opm", // the noise is the eighth channel's
  kind: "fm",
  level: { stepDb: 0.75, steps: 128 },
  words: fmWords({
    channel: ["FM_ALG", "FM_FB", "FM_AMS", "FM_FMS"],
    op: ["FM_AR", "FM_DR", "FM_SR", "FM_RR", "FM_SL", "FM_TL", "FM_KS", "FM_ML", "FM_DT", "FM_DT2_", "FM_AMEN", "FM_VEL"],
    more: ["PAN"],
  }), // no SSG-EG, the OPN's; DT2 its own
  songWords: words("LFO_RATE", "LFO_FREQ", "LFO_PMD", "LFO_AMD", "LFO_WAVE"),
};

export const opmNoise = {
  name: "opm-noise",
  label: "OPM noise",
  unit: "opm",
  kind: "noise",
  // Its level is the eighth channel's fourth operator's TL, quantized to the
  // PSG level model's 2 dB steps.
  level: { stepDb: 2, steps: 16 },
  words: NO_WORDS,
  songWords: words("NOISE_RATE"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the OPM's noise has no :mode; its period is the song's :noise-rate 1-31 (fm8's :mode noise plays it with a voice)" },
  shareHint: (other) => `the noise is fm8's fourth operator; move ${other} to another channel`,
};

// The OPN's LFO rates 1-8 (Hz, the YM2612's at its clock), which :lfo-rate
// names: on the OPM the nearest LFRQ.
const OPN_LFO_HZ = [3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2];
// The LFO's frequency for an LFRQ: a 4.4 float step, (16 + low) << high, added
// once a sample (clock / 64) to a counter whose top 8 of 30 bits are its phase.
const lfoHz = (lfrq) => ((CLOCK / 64) * ((16 + (lfrq & 15)) << (lfrq >> 4))) / 2 ** 30;
const nearestLfrq = (hz) => {
  let best = 0;
  for (let l = 1; l < 256; l++)
    if (Math.abs(Math.log(lfoHz(l) / hz)) < Math.abs(Math.log(lfoHz(best) / hz))) best = l;
  return best;
};
const OPN_LFRQ = OPN_LFO_HZ.map(nearestLfrq);

// op1-op4 (the OPN's chain order: M1, C1, M2, C2) → their register slot.
const SLOT = [0, 16, 8, 24];
const PAN_BITS = { [-1]: 0x40, 0: 0xc0, 1: 0x80 }; // $20 bit 6 L, bit 7 R
const NOISE_CH = 7;
const NOISE_RATE_START = 9;

/** A KC and KF (the registers' bytes) as Hz, at this chip's clock. */
export function kcToHz(kc, kfReg) {
  const code = kc & 15;
  const note = code - (code >> 2); // every fourth code is unused
  const midi = 61 + ((kc >> 4) - 4) * 12 + note + (kfReg >> 2) / 64 + 12 * Math.log2(CLOCK / KC_CLOCK);
  return 440 * 2 ** ((midi - 69) / 12);
}

// The OPM's FM in Live's worklet, for a channel the keys hold (chips/opn-fm.js
// opnHoldBus): $08 keys it, $20-$FF are its own; written back operators,
// $20/$38, then KC and KF.
export const opmHoldBus = {
  channelOf: (_p, a, d) => (a === 0x08 ? d & 7 : a >= 0x20 ? a & 7 : -1),
  isKey: (a) => a === 0x08,
  keyOn: (d) => (d & 0x78) !== 0,
  replay(ch) {
    const list = [];
    for (let a = 0x40 + ch; a < 0x100; a += 8) list.push([0, a]);
    list.push([0, 0x20 + ch], [0, 0x38 + ch], [0, 0x28 + ch], [0, 0x30 + ch]);
    return list;
  },
};

export const ym2151 = {
  chip: "ym2151",
  clock: CLOCK,
  parts: [opmFm, opmNoise],
  encoder: true,
  emulator: true,
  vgm: { clock: 0x30, ports: { 0: { cmd: 0x54, addr: true } } },
  // A run starts the chip-wide registers over: the noise off (fm8's fourth
  // operator a sine again), the LFO stopped at no depth on the saw — the
  // chip's reset, where a song before this one may have left them.
  init: [[0, 0x0f, 0x00], [0, 0x18, 0x00], [0, 0x19, 0x00], [0, 0x19, 0x80], [0, 0x1b, 0x00]],

  // The FM as the IR player writes it (chips/opn-fm.js has the contract).
  // One per player: it keeps $20, where the pan and the algorithm meet.
  fmEncoder() {
    const r20 = new Array(8).fill(0xc0);
    // $0F, which the PSG encoder shares (psgEncoder(fm)): NE and NFRQ.
    const noiseReg = { ne: false, nfrq: 32 - NOISE_RATE_START };
    const r0f = () => [[0, 0x0f, (noiseReg.ne ? 0x80 : 0) | noiseReg.nfrq]];
    const semis = 12 * Math.log2(CLOCK / KC_CLOCK);
    const OP_REG = {
      "dt-ml": [0x40, encode30],
      tl: [0x60, (o) => o.tl],
      "ks-ar": [0x80, (o) => (o.rs << 6) | o.ar],
      "am-dr": [0xa0, (o) => ((o.amen & 1) << 7) | (o.dr & 0x1f)],
      sr: [0xc0, (o) => ((o.dt2 & 3) << 6) | (o.d2r & 0x1f)],
      "sl-rr": [0xe0, encode80],
    };
    return {
      channels: 8,
      csm: false,
      noiseReg,
      // A run starts with the noise off (the chip's init writes $0F 0).
      reset() { noiseReg.ne = false; noiseReg.nfrq = 32 - NOISE_RATE_START; },
      // fm8's :mode: noise turns its fourth operator into the noise, tone
      // back into a sine.
      noise(on) { noiseReg.ne = !!on; return r0f(); },
      op(ch, opIdx, reg, o) {
        const r = OP_REG[reg];
        return r ? [[0, r[0] + SLOT[opIdx] + ch, r[1](o)]] : []; // no SSG-EG
      },
      alg(ch, regs) {
        r20[ch] = (r20[ch] & 0xc0) | ((regs.feedback & 7) << 3) | (regs.algorithm & 7);
        return [[0, 0x20 + ch, r20[ch]]];
      },
      pan(ch, regs) {
        r20[ch] = (r20[ch] & 0x3f) | PAN_BITS[panSide(regs.pan)];
        return [[0, 0x20 + ch, r20[ch]], [0, 0x38 + ch, ((regs.fms & 7) << 4) | (regs.ams & 3)]];
      },
      // KC: octave (3 bits) and note (4, C# D D# _ E F F# _ G G# A _ A# B C _
      // — every fourth code unused), KC $40 the C# above middle C; KF the
      // 64ths of a semitone above it.
      pitch(ch, midi) {
        const s = midi - semis - 61;
        let oct = 4 + Math.floor(s / 12);
        let within = s - 12 * Math.floor(s / 12);
        let note = Math.floor(within);
        let kf = Math.round((within - note) * 64);
        if (kf === 64) { kf = 0; note++; }
        if (note === 12) { note = 0; oct++; }
        if (oct < 0) [oct, note, kf] = [0, 0, 0];
        if (oct > 7) [oct, note, kf] = [7, 11, 63];
        return [[0, 0x28 + ch, (oct << 4) | (note + Math.floor(note / 3))], [0, 0x30 + ch, kf << 2]];
      },
      // $08: the operators' bits 6-3 (op4 … op1), the channel in 2-0.
      key: (ch, mask) => [[0, 0x08, (((mask >> 4) & 0x0f) << 3) | (ch & 7)]],
      isKeyOn: (port, addr, data) => port === 0 && addr === 0x08 && (data & 0x78) !== 0,
      // :lfo-rate, the OPN's word: 0 the LFO off (both depths 0), 1-8 the
      // nearest LFRQ at full depth, so the channels' :ams / :fms set how much
      // as they do on the OPN.
      lfo: (rate) => rate === 0
        ? [[0, 0x19, 0x00], [0, 0x19, 0x80]]
        : [[0, 0x18, OPN_LFRQ[rate - 1]], [0, 0x19, 0x7f], [0, 0x19, 0xff]],
      // What :lfo-rate reads as, in the OPM's own LFO words (the panel's).
      lfoReading: (rate) => (rate === 0 ? { pmd: 0, amd: 0 } : { freq: OPN_LFRQ[rate - 1], pmd: 127, amd: 127 }),
      lfoFreq: (v) => [[0, 0x18, v & 0xff]],
      lfoPmd: (v) => [[0, 0x19, 0x80 | (v & 0x7f)]],
      lfoAmd: (v) => [[0, 0x19, v & 0x7f]],
      lfoWave: (v) => [[0, 0x1b, v & 3]],
    };
  },

  // The noise as the IR player's PSG: lane 3 is fm8's fourth operator with
  // the chip's noise on it (the default voice leaves it AR 31, RR 15); the
  // tone lanes are none. One per player: it keeps whether the noise channel
  // has played — which a score using fm8 for FM never makes it, so its
  // silences then leave fm8 alone — and whether the operator is keyed. $0F
  // is the FM encoder's (`fm`), so :noise-rate keeps fm8's :mode noise on.
  psgEncoder(fm = null) {
    let on = false;
    let keyed = false;
    const reg = fm?.noiseReg ?? { ne: false, nfrq: 32 - NOISE_RATE_START };
    const ne = () => [[0, 0x0f, (reg.ne ? 0x80 : 0) | reg.nfrq]];
    const key = (k) => { keyed = k; return [[0, 0x08, (k ? 0x08 << 3 : 0) | NOISE_CH]]; };
    return {
      period: () => 0,
      // The 0 loud .. 15 off attenuation, 2 dB a step. The noise's level is
      // its operator's attenuation taken linearly (not through the log table
      // a sine's goes through), the TL its top 7 of 10 bits: the step's gain
      // g is an attenuation of 1023 · (1 − g). 15 is no level at all, so
      // there the operator is keyed off.
      att(lane, att) {
        if (lane !== 3 || !on) return [];
        if (att >= 15) return [[0, 0x60 + SLOT[3] + NOISE_CH, 127], ...key(false)];
        const tl = Math.min(127, Math.round((1023 * (1 - 10 ** (-att / 10))) / 8));
        return [[0, 0x60 + SLOT[3] + NOISE_CH, tl], ...(keyed ? [] : key(true))];
      },
      tone: () => [],
      mix: () => [],
      // A noise note: the noise on, the operator re-keyed by its level.
      noise() {
        on = reg.ne = true;
        keyed = false;
        return [...ne(), ...key(false)];
      },
      // :noise-rate n is NFRQ 32 − n: the noise at clock / 32 / n, 125 kHz / n
      // here, as the PC-8801's SSG has it at 124.8 kHz / n — a rate reads
      // the same on both.
      noiseRate(rate) {
        reg.nfrq = 32 - Math.max(1, Math.min(31, Math.round(rate)));
        return ne();
      },
    };
  },
};
