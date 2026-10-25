// The YM2413 (OPLL), the FM-PAC cartridge's FM: nine 2-op channels, each
// playing one of fifteen ROM voices or the one user voice ($00-$07), or six
// channels and the five rhythm sounds on the last three. ymfm's YM2413
// plays it (synth-msx.js), with the ROM below.
//
// Its registers, as the worklet's port 4: $00-$07 the user voice, $0E the
// rhythm, $10-$18 each channel's F-number (low 8 bits), $20-$28 its sustain,
// key, block and the F-number's top bit, $30-$38 its voice and volume.
//
// The FM is the OPN's language on two operators (language.md §19, msx): op1
// the modulator, op2 the carrier, whose level is the channel's 4-bit volume.
// A voice is one of the ROM's when its registers are, and the user voice
// otherwise — one for the chip, the last written winning.
import { fmWords } from "./fm-words.js";

const CLOCK = 3579545; // the MSX's 3.58 MHz
export const OPLL_PORT = 4;
const RATE = CLOCK / 72; // the sample rate, which the F-number counts in
const CHANNELS = 9;

// The ROM, as the chip's die has it (Nuked-OPLL's patch_ym2413), in the user
// voice's $00-$07 layout: the fifteen voices, then the three rhythm patches
// (BD; HH and SD; TOM and CYM), which the emulator takes whole.
const ROM = [
  [0x71, 0x61, 0x1e, 0x17, 0xd0, 0x78, 0x00, 0x17], // violin
  [0x13, 0x41, 0x1a, 0x0d, 0xd8, 0xf7, 0x23, 0x13], // guitar
  [0x13, 0x01, 0x99, 0x00, 0xf2, 0xc4, 0x11, 0x23], // piano
  [0x31, 0x61, 0x0e, 0x07, 0xa8, 0x64, 0x70, 0x27], // flute
  [0x32, 0x21, 0x1e, 0x06, 0xe0, 0x76, 0x00, 0x28], // clarinet
  [0x31, 0x22, 0x16, 0x05, 0xe0, 0x71, 0x00, 0x18], // oboe
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x10, 0x07], // trumpet
  [0x23, 0x21, 0x2d, 0x14, 0xa2, 0x72, 0x00, 0x07], // organ
  [0x61, 0x61, 0x1b, 0x06, 0x64, 0x65, 0x10, 0x17], // horn
  [0x41, 0x61, 0x0b, 0x18, 0x85, 0xf7, 0x71, 0x07], // synthesizer
  [0x13, 0x01, 0x83, 0x11, 0xfa, 0xe4, 0x10, 0x04], // harpsichord
  [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12], // vibraphone
  [0x61, 0x50, 0x0c, 0x05, 0xc2, 0xf5, 0x20, 0x42], // synthesizer bass
  [0x01, 0x01, 0x55, 0x03, 0xc9, 0x95, 0x03, 0x02], // acoustic bass
  [0x61, 0x41, 0x89, 0x03, 0xf1, 0xe4, 0x40, 0x13], // electric guitar
];
const ROM_RHYTHM = [
  [0x01, 0x01, 0x18, 0x0f, 0xdf, 0xf8, 0x6a, 0x6d],
  [0x01, 0x01, 0x00, 0x00, 0xc8, 0xd8, 0xa7, 0x48],
  [0x05, 0x01, 0x00, 0x00, 0xf8, 0xaa, 0x59, 0x55],
];
/** The ROM as the emulator takes it (ymfm's instrument data): 18 × 8 bytes. */
export const OPLL_ROM_BYTES = Uint8Array.from([...ROM, ...ROM_RHYTHM].flat());

// The ROM voices' built-in names (language.md §19, msx), in the ROM's order.
export const OPLL_ROM_NAMES = [
  "violin", "guitar", "piano", "flute", "clarinet", "oboe", "trumpet", "organ", "horn",
  "synth", "harpsichord", "vibraphone", "synth-bass", "acoustic-bass", "electric-guitar",
].map((n) => `opll-${n}`);

// An operator's fields as the user voice packs them, with their ranges:
// [word, field (the IR player's shadow), bits]. op1's TL and both KSLs and
// waveforms live in $02/$03, the rest in the operator's own bytes.
const OP_FIELDS = [
  ["FM_AMEN", "amen", 1], ["FM_VIB", "vib", 1], ["FM_EG", "eg", 1], ["FM_KS", "rs", 1], ["FM_ML", "mul", 4],
  ["FM_KSL", "ksl", 2], ["FM_WS", "ws", 1], ["FM_AR", "ar", 4], ["FM_DR", "dr", 4], ["FM_SL", "sl", 4], ["FM_RR", "rr", 4],
];
const fit = (v, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(v ?? 0)));

/**
 * A voice's eight bytes from `get(word)` — a word's value (FM_AR1 …), or
 * undefined for 0 — each field kept to its register's bits.
 */
function voiceBytes(get) {
  const op = (n) => Object.fromEntries(OP_FIELDS.map(([w, , bits]) => [w, fit(get(`${w}${n}`), bits)]));
  const m = op(1), c = op(2);
  const b01 = (o) => (o.FM_AMEN << 7) | (o.FM_VIB << 6) | (o.FM_EG << 5) | (o.FM_KS << 4) | o.FM_ML;
  return [
    b01(m), b01(c),
    (m.FM_KSL << 6) | fit(get("FM_TL1"), 6),
    (c.FM_KSL << 6) | (c.FM_WS << 4) | (m.FM_WS << 3) | fit(get("FM_FB"), 3),
    (m.FM_AR << 4) | m.FM_DR, (c.FM_AR << 4) | c.FM_DR,
    (m.FM_SL << 4) | m.FM_RR, (c.FM_SL << 4) | c.FM_RR,
  ];
}

// A voice's bytes as its words (the inverse): what a ROM voice's name holds.
function voiceWords(b) {
  const out = new Map([["FM_FB", b[3] & 7], ["FM_TL1", b[2] & 0x3f]]);
  for (const n of [1, 2]) {
    const o = n - 1;
    const set = (w, v) => out.set(`${w}${n}`, v);
    set("FM_AMEN", b[o] >> 7); set("FM_VIB", (b[o] >> 6) & 1); set("FM_EG", (b[o] >> 5) & 1);
    set("FM_KS", (b[o] >> 4) & 1); set("FM_ML", b[o] & 15);
    set("FM_KSL", b[2 + o] >> 6); set("FM_WS", (b[3] >> (n === 1 ? 3 : 4)) & 1);
    set("FM_AR", b[4 + o] >> 4); set("FM_DR", b[4 + o] & 15);
    set("FM_SL", b[6 + o] >> 4); set("FM_RR", b[6 + o] & 15);
  }
  return out;
}

// A ROM voice on a 4-op chip (the OPN's, the OPM's): op1 into op2 on
// algorithm 4, op3 and op4 silent. Rates are on the 4-op's 5-bit scale (AR
// and DR twice the OPLL's, RR the same), a percussive envelope decays at
// its RR through SR, KSR 1 is KS 2, the OPLL's multiples 11, 13 and 14 are
// 10, 12 and 15; the KSL, the rectified sine and the vibrato have no 4-op
// register and are left out.
const OPLL_ML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
function voiceAs4op(b) {
  const w = voiceWords(b);
  const out = new Map([["FM_ALG", 4], ["FM_FB", w.get("FM_FB")], ["FM_AMS", 0], ["FM_FMS", 0]]);
  for (const n of [1, 2]) {
    const g = (k) => w.get(`${k}${n}`);
    const set = (k, v) => out.set(`${k}${n}`, v);
    set("FM_AR", 2 * g("FM_AR")); set("FM_DR", 2 * g("FM_DR"));
    set("FM_SR", g("FM_EG") ? 0 : 2 * g("FM_RR")); set("FM_RR", g("FM_RR")); set("FM_SL", g("FM_SL"));
    set("FM_TL", n === 1 ? w.get("FM_TL1") : 0); set("FM_KS", 2 * g("FM_KS")); set("FM_ML", OPLL_ML[g("FM_ML")]);
    set("FM_DT", 0); set("FM_SSG", 0); set("FM_AMEN", g("FM_AMEN"));
  }
  for (const n of [3, 4])
    for (const [k, v] of [["FM_AR", 31], ["FM_DR", 0], ["FM_SR", 0], ["FM_RR", 15], ["FM_SL", 0], ["FM_TL", 127],
      ["FM_KS", 0], ["FM_ML", 1], ["FM_DT", 0], ["FM_SSG", 0], ["FM_AMEN", 0]]) out.set(`${k}${n}`, v);
  return out;
}

/**
 * The ROM voices as built-in def-fm voices (language.md §19): name → its
 * words, the OPLL's own where `part` is the OPLL's, else the 4-op reading.
 */
export function opllRomVoices(part) {
  return new Map(ROM.map((b, i) => [OPLL_ROM_NAMES[i], part === opllFm ? voiceWords(b) : voiceAs4op(b)]));
}

/** The ROM voice (1-15) whose registers `bytes` are, or 0: the user voice. */
function romIndex(bytes) {
  const i = ROM.findIndex((r) => r.every((x, k) => x === bytes[k]));
  return i + 1;
}

const OP_WORDS = ["FM_AR", "FM_DR", "FM_SL", "FM_RR", "FM_KS", "FM_ML", "FM_AMEN", "FM_WS", "FM_EG", "FM_KSL", "FM_VIB", "FM_VEL"];

export const opllFm = {
  name: "opll-fm",
  label: "OPLL FM",
  kind: "fm",
  // The carrier's level is the channel's volume, 3 dB a step; a modulator a
  // voice makes velocity-sensitive moves op1's TL, 0.75 dB in 64.
  level: { stepDb: 3, steps: 16 },
  modLevel: { stepDb: 0.75, steps: 64 },
  words: fmWords({
    channel: ["FM_FB", "FM_SUS"],
    ops: 2,
    op: (n) => (n === 1 ? [...OP_WORDS, "FM_TL"] : OP_WORDS),
  }),
  // The registers narrower than the family's (chips/fm-words.js).
  ranges: { FM_AR: [0, 15], FM_DR: [0, 15], FM_TL: [0, 63], FM_KS: [0, 1] },
  voiceAtKey: true, // the encoder settles a voice at the key-on
  // The chip has one user voice: two a score plays on its channels are one
  // register set, which the last written has.
  checkVoices({ uses, push }) {
    const user = [...new Set(uses.filter((u) => !romIndex(voiceBytes((w) => u.kwMap.get(w)))).map((u) => u.name))];
    if (user.length > 1)
      push("warning", "W_TARGET",
        `the OPLL has one user voice, and ${user.map((n) => `'${n}'`).join(", ")} each need it — the last written wins; a ROM voice (opll-piano …) needs none`);
  },
};

// The OPLL as the IR player's FM (chips/opn-fm.js has the contract). One per
// player: it keeps each channel's voice, volume, pitch and sustain, and the
// span its latest note is keyed for. Nothing is written until a channel
// first keys on — a cartridge a score with no FM track does not have.
//
// A channel's voice is settled at its key-on: the ROM's when its registers
// are one, else the user voice, written there (another channel may have
// written its own since). A voice change while a note is keyed moves the
// note at once; one between notes waits for the next key-on, so a voice
// switch's run of writes never leaves the user voice half-written.
//
// The player sends a note's key-off as the note starts, ahead of the writes
// inside the note, so whether a write's time is inside a note is read from
// that span, not from the order the writes come in.
function opllEncoder() {
  let started, ops, fb, vol, inst, fnum, block, sus, span;
  const reset = () => {
    started = false;
    ops = Array.from({ length: CHANNELS }, () => [{}, {}]);
    fb = new Array(CHANNELS).fill(0);
    vol = new Array(CHANNELS).fill(0);
    inst = new Array(CHANNELS).fill(0);
    fnum = new Array(CHANNELS).fill(0);
    block = new Array(CHANNELS).fill(0);
    sus = new Array(CHANNELS).fill(0);
    span = Array.from({ length: CHANNELS }, () => ({ on: Infinity, off: Infinity }));
  };
  reset();
  const at = (when) => when ?? -Infinity; // a write with no time is the run's start
  const keyedAt = (ch, when) => at(when) >= span[ch].on - 1e-9 && at(when) < span[ch].off - 1e-9;
  const w = (a, d) => [OPLL_PORT, a, d];
  const r2x = (ch, keyed) => (sus[ch] << 5) | (keyed ? 0x10 : 0) | (block[ch] << 1) | (fnum[ch] >> 8);
  const opWord = (ch, word) => {
    if (word === "FM_FB") return fb[ch];
    const n = Number(word.slice(-1));
    const field = word === "FM_TL1" ? "tl" : OP_FIELDS.find(([x]) => `${x}${n}` === word)?.[1];
    return ops[ch][n - 1][field];
  };
  // The channel's voice into the chip: the user voice's bytes when it is no
  // ROM voice, and $30's voice and volume.
  const settle = (ch) => {
    const b = voiceBytes((word) => opWord(ch, word));
    inst[ch] = romIndex(b);
    return [...(inst[ch] ? [] : b.map((d, a) => w(a, d))), w(0x30 + ch, (inst[ch] << 4) | vol[ch])];
  };
  const voiceMoved = (ch, when) => (started && keyedAt(ch, when) ? settle(ch) : []);
  return {
    channels: CHANNELS,
    csm: false,
    carriers: [1], // op2
    reset,
    op(ch, opIdx, reg, o, when) {
      if (opIdx > 1) return [];
      if (opIdx === 1 && reg === "tl") {
        vol[ch] = fit(o.tl, 4);
        return started ? [w(0x30 + ch, (inst[ch] << 4) | vol[ch])] : [];
      }
      Object.assign(ops[ch][opIdx], o);
      return voiceMoved(ch, when);
    },
    alg(ch, regs, when) {
      fb[ch] = fit(regs.feedback, 3);
      return voiceMoved(ch, when);
    },
    pan: () => [], // mono
    // A (fractional) MIDI note: the lowest block whose F-number fits 9 bits.
    pitch(ch, midi, when) {
      const hz = 440 * 2 ** ((midi - 69) / 12);
      let b = 0;
      let f = Math.round((hz * 2 ** 19) / (RATE * 2 ** b));
      while (f > 511 && b < 7) f = Math.round((hz * 2 ** 19) / (RATE * 2 ** ++b));
      fnum[ch] = Math.max(0, Math.min(511, f));
      block[ch] = b;
      return started ? [w(0x10 + ch, fnum[ch] & 0xff), w(0x20 + ch, r2x(ch, keyedAt(ch, when)))] : [];
    },
    // The key: both operators at once, on any mask but 0.
    key(ch, mask, when) {
      if (!mask) {
        if (at(when) >= span[ch].on) span[ch].off = at(when);
        return started ? [w(0x20 + ch, r2x(ch, false))] : [];
      }
      started = true;
      span[ch] = { on: at(when), off: Infinity };
      return [...settle(ch), w(0x10 + ch, fnum[ch] & 0xff), w(0x20 + ch, r2x(ch, true))];
    },
    // :sus, $2x bit 5.
    sus(ch, v, when) {
      sus[ch] = v ? 1 : 0;
      return started ? [w(0x20 + ch, r2x(ch, keyedAt(ch, when)))] : [];
    },
    isKeyOn: (port, addr, data) => port === OPLL_PORT && addr >= 0x20 && addr <= 0x28 && (data & 0x10) !== 0,
    lfo: () => [], // the OPLL's LFO is fixed
  };
}

export const ym2413 = {
  chip: "ym2413",
  clock: CLOCK,
  parts: [opllFm],
  encoder: true,
  emulator: true,
  // A cartridge, as the SCC: a score with no OPLL write has no OPLL in its
  // VGM (the encoder writes nothing before a key).
  optional: true,
  init: [],
  // VGM 1.00: the clock at 0x10, and the 0x51 command (an address and a byte).
  vgm: { clock: 0x10, ports: { [OPLL_PORT]: { cmd: 0x51, addr: true } } },
  fmEncoder: opllEncoder,
};
