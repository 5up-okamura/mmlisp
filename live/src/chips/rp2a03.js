// The 2A03's APU, the Famicom's sound: two pulses (a 4-bit level, four
// duties), a triangle with no level, a noise (a 4-bit level, 16 rates, a
// long or a 93-step loop), and the DMC: 1-bit delta samples from the CPU's
// memory, played at one of 16 rates onto a 7-bit DAC.
//
// Its registers, $4000-$4017, are the worklet's port 0 at $00-$17 (VGM's
// 0xB4 numbering): $4000/$4004 a pulse's duty (7-6), length halt (5),
// constant volume (4) and volume (3-0); $4001/$4005 its sweep; $4002/$4006
// its period's low byte; $4003/$4007 its high three bits under the length
// counter's load — a write that starts the duty over (a click), so it is
// written only when those bits change. $4008 the triangle's linear counter
// (bit 7 its control), $400A/$400B its period; $400C the noise's level,
// $400E its loop bit (7) and rate (3-0), $400F its length; $4010 the DMC's
// loop bit (6) and rate (3-0), $4011 its DAC, $4012 its sample's address
// ($C000 + 64 n), $4013 its length (16 n + 1 bytes); $4015 the channels'
// enables (bit 4 the DMC's: set, a sample starts; clear, it stops); $4017
// the frame counter. How the chip reads them is nesdev's APU pages (Pulse,
// Triangle, Noise, DMC, Mixer), which Mesen follows.
//
// The DMC's samples are in the CPU's memory, which the worklet's port 1
// writes (RAM_PORT): $00 / $01 an address's low and high byte, from $C000,
// then each $02 a byte there, the address moving on — VGM's 0xC2 block.
import { words } from "./parts.js";

const CLOCK = 1789773; // NTSC: the master 21.477 MHz / 12
const PORT = 0;
// A pulse's period under 8 is silent; the 11-bit period's top.
const PULSE_PERIOD_MIN = 8;
const PERIOD_MAX = 0x7ff;
// The triangle's period under 2 is ultrasonic (a pop as it settles).
const TRI_PERIOD_MIN = 2;
// The length counter's load with its halt set: any nonzero entry (index 1).
const LENGTH = 1 << 3;
// The duties a pulse has, in sixteenths: 12.5 / 25 / 50 / 75 % ($4000's 0-3).
export const DUTIES = [2, 4, 8, 12];
const DEFAULT_DUTY = 2; // 50 %
// A noise note's rate: c2 is the slowest of the 16 ($400E's 15, the LFSR
// clocked every 4068 CPU clocks), each semitone the next, up to d#3 — as
// pce's noise (chips/huc6280.js), since the rates are a clock, not a pitch.
export const NOISE_NOTE_BASE = 36;
export const NOISE_RATES = 16;
// The noise's periods (CPU clocks between LFSR steps, NTSC), $400E's 0-15.
export const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
/** The note (c2 the slowest) whose rate is the nearest to a noise clocked at `hz`. */
export function noiseNoteOfHz(hz) {
  let best = 0;
  for (let i = 1; i < NOISE_PERIODS.length; i++)
    if (Math.abs(Math.log(CLOCK / NOISE_PERIODS[i] / hz)) < Math.abs(Math.log(CLOCK / NOISE_PERIODS[best] / hz))) best = i;
  return NOISE_NOTE_BASE + 15 - best;
}

const LEVEL = { scale: "linear", steps: 16 }; // the 4-bit volume, 15 loud .. 0 off

// The DMC: its rates (CPU clocks a bit, NTSC), the most bytes a sample has
// ($4013 255: 4081), where the score's samples are put ($C000, $4012 0),
// and the DAC level a hit starts from (the middle of its 7 bits).
export const RAM_PORT = 1;
export const DMC_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
export const DMC_RATES = DMC_PERIODS.map((p) => CLOCK / p);
export const DMC_MAX_BYTES = 16 * 255 + 1;
export const DMC_BASE = 0xc000;
export const DMC_START = 64;

/** A duty in sixteenths (0-16) as $4000's bits 7-6: the nearest of DUTIES, the narrower at a tie. */
export function dutyCode(sixteenths) {
  const v = Number(sixteenths) || 0;
  let best = 0;
  for (let i = 1; i < DUTIES.length; i++)
    if (Math.abs(DUTIES[i] - v) < Math.abs(DUTIES[best] - v)) best = i;
  return best;
}

export const fcPulse = {
  name: "fc-pulse",
  label: "2A03 pulse",
  unit: "apu",
  kind: "tone",
  level: LEVEL,
  words: words("DUTY"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "a 2A03 pulse has no :mode; its shape is :duty" },
};

// No level: a note sounds at the one the chip has, a rest (or :vel / :vol
// 0) halts it — the language says so (W_TARGET) where a score writes one.
export const fcTriangle = {
  name: "fc-tri",
  label: "2A03 triangle",
  unit: "apu",
  kind: "tone",
  level: LEVEL,
  noLevel: true,
  words: () => false,
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the 2A03's triangle has no :mode" },
};

export const fcNoise = {
  name: "fc-noise",
  label: "2A03 noise",
  unit: "apu",
  kind: "noise",
  level: LEVEL,
  words: words("NOISE_MODE"),
  // The loop as NOISE_MODE's FB bit (chips/sn76489.js): 4 white, 0 periodic.
  modes: { white: ["NOISE_MODE", 0b1_00], periodic: ["NOISE_MODE", 0b0_00] },
  modeError: { code: "E_PARAM_VALUE", message: "the 2A03's noise :mode is white or periodic" },
  rateNote: true,
};

// pcm1: the DMC, one sample voice. A note's sample is baked at its pitch
// onto the 1-bit delta at its def-pcm's one rate (`dmcRate`), its level
// with it (:vel, :vol, the master, read at key-on); a loop is the whole
// range, as $4012 / $4013 are.
export const fcDpcm = {
  name: "fc-dpcm",
  label: "2A03 DPCM",
  unit: "apu",
  kind: "sample",
  level: { scale: "linear", steps: 64 }, // the DAC's swing about its middle
  words: words(/^(?:RANGE|LOOP)_/),
  pointSweeps: false, // a note's points are read at its key-on
  frames: true, // plays the samples' frames as bakePcm8 bakes them
  loopIsRange: true,
  checkNote({ sample, sampleName, mode, once }) {
    if (mode !== "loop") return;
    const loops = (sample.loopStartSec ?? sample.startSec ?? 0) !== (sample.startSec ?? 0) ||
      (sample.loopEndSec != null && sample.loopEndSec !== sample.endSec);
    if (loops)
      once(`loop:${sampleName}`, `the 2A03's DPCM loops a sample's whole range; ${sampleName}'s :loop-* points are left out — make the range the loop (:pcm-start / :pcm-end)`, "warning");
  },
};

/**
 * The highest of the DMC's rates at which `sec` seconds of sample fit its
 * 4081 bytes (the lowest, cut there, where none does): its index.
 */
export function dmcRate(sec) {
  for (let i = DMC_RATES.length - 1; i > 0; i--) if (Math.ceil((sec * DMC_RATES[i]) / 8) <= DMC_MAX_BYTES) return i;
  return 0;
}

/**
 * `bits` levels, −1..1 (the sample at the note's pitch and the DMC's rate,
 * its level in it), as the DMC's bytes from DMC_START: each bit moves the
 * DAC 2 up or down, toward the level, as the chip bounds it (up below 126,
 * down above 1). Padded to 16 n + 1 bytes — a loop with its own start
 * again, else an even run of ups and downs that holds the level.
 */
export function dmcEncode(levels, loop = false) {
  const n = Math.min(DMC_MAX_BYTES, Math.max(1, ((Math.ceil(levels.length / 8) - 1 + 15) >> 4 << 4) + 1));
  const bytes = new Uint8Array(n);
  let dac = DMC_START;
  for (let k = 0; k < n * 8; k++) {
    let up;
    if (k < levels.length || (loop && levels.length)) {
      const target = DMC_START + 63 * levels[k % levels.length];
      up = target > dac;
    } else up = k % 2 === 0;
    if (up) { if (dac <= 125) dac += 2; } else if (dac >= 2) dac -= 2;
    if (up) bytes[k >> 3] |= 1 << (k & 7);
  }
  return bytes;
}

// A hit: its bytes into the memory at DMC_BASE (on RAM_PORT), then the DMC
// set to them, the DAC to DMC_START, and started over ($4015's bit 4
// dropped and raised). `stop` drops it.
const dmc = {
  load: (bytes) => [[RAM_PORT, 0x00, DMC_BASE & 0xff], [RAM_PORT, 0x01, DMC_BASE >> 8], ...Array.from(bytes, (b) => [RAM_PORT, 0x02, b])],
  start: (bytes, rate, loop) => [
    [PORT, 0x10, (loop ? 0x40 : 0) | rate], [PORT, 0x11, DMC_START],
    [PORT, 0x12, ((DMC_BASE - 0xc000) >> 6) & 0xff], [PORT, 0x13, (bytes.length - 1) >> 4],
    [PORT, 0x15, 0x0f], [PORT, 0x15, 0x1f],
  ],
  stop: () => [[PORT, 0x15, 0x0f]],
};

// The APU as the IR player's PSG: lanes 0-1 the pulses, 2 the triangle, 3
// the noise, each a view (`lanes`) with its own period. One per player.
//
// A pulse's $4000 holds its volume and its duty, which the player sends
// out of time order (a note's level macro its whole length ahead, then its
// duty macro), and the period's high bits are written on a change only —
// so a write with a time is queued, and flush(horizon) (once every track is
// dispatched to it, as chips/ssg.js) applies them in time order, reading
// the state as it is then. A silence is written where it is asked for —
// a level 0 is silent at any duty — and queued too, for the state; one
// with no time (a key, a stop) is written now.
function apuEncoder() {
  let vol, duty, hi, noiseMode, noiseRate, last, queue;
  const reset = () => {
    vol = [0, 0, 0, 0];
    duty = [DEFAULT_DUTY, DEFAULT_DUTY];
    hi = [-1, -1, -1]; // the period's high bits as written; -1 none yet
    noiseMode = 0; // $400E bit 7: 0 white, 0x80 periodic
    noiseRate = 0; // $400E's 0-15 as written
    last = new Map(); // a level register's value as written, in time order
    queue = [];
  };
  reset();
  // A channel's level register and the byte its state makes.
  const ctlAddr = (ch) => (ch < 2 ? 4 * ch : ch === 2 ? 0x08 : 0x0c);
  const ctlByte = (ch, v) =>
    ch < 2 ? (duty[ch] << 6) | 0x30 | v : ch === 2 ? (v ? 0xff : 0x80) : 0x30 | v;
  const ctl = (ch) => {
    const addr = ctlAddr(ch), data = ctlByte(ch, vol[ch]);
    if (last.get(addr) === data) return [];
    last.set(addr, data);
    return [[PORT, addr, data]];
  };
  // One op on the state, in time order, and the writes it makes.
  const apply = (op) => {
    const { ch } = op;
    switch (op.kind) {
      case "vol":
        vol[ch] = op.v;
        // A silence already written (att): only its state, at its time.
        if (op.silent) {
          last.set(ctlAddr(ch), ctlByte(ch, 0));
          return [];
        }
        return ctl(ch);
      case "duty":
        duty[ch] = op.v;
        return ctl(ch);
      case "tone": {
        if (ch === 3) return [[PORT, 0x0e, noiseMode | (noiseRate = op.v)]];
        const base = 4 * ch;
        const out = [[PORT, base + 2, op.v & 0xff]];
        if (hi[ch] !== op.v >> 8) out.push([PORT, base + 3, LENGTH | (hi[ch] = op.v >> 8)]);
        return out;
      }
      case "mode":
        if (noiseMode === op.v) return [];
        noiseMode = op.v;
        return [[PORT, 0x0e, noiseMode | noiseRate]];
    }
    return [];
  };
  // A write with no time (a key, a stop) goes to the chip as it is now,
  // not as the queue leaves it at the horizon: its register is written
  // whatever `last` holds.
  const take = (op, when) => {
    if (when === undefined || when === null) {
      last.delete(ctlAddr(op.ch));
      return apply(op);
    }
    queue.push({ ...op, t: when });
    return [];
  };
  // A level: the player's attenuation, 0 loud .. 15 off, upside down; the
  // triangle on or halted. A silence at a time is written at once (a level
  // 0 is silent at any duty), its state queued at its time.
  const att = (ch, a, when) => {
    const v = 15 - Math.max(0, Math.min(15, a | 0));
    if (v || when === undefined || when === null) return take({ kind: "vol", ch, v }, when);
    queue.push({ kind: "vol", ch, v: 0, silent: true, t: when });
    return [[PORT, ctlAddr(ch), ctlByte(ch, 0)]];
  };
  const view = (ch, period) => ({
    period,
    att: (_l, a, when) => att(ch, a, when),
    tone: (_l, p, when) => take({ kind: "tone", ch, v: p }, when),
    duty: ch < 2 ? (_l, d, when) => take({ kind: "duty", ch, v: dutyCode(d) }, when) : undefined,
  });
  // A pulse is the clock / 16 / (period + 1), the triangle / 32.
  const pulsePeriod = (hz) => Math.max(PULSE_PERIOD_MIN, Math.min(PERIOD_MAX, Math.round(CLOCK / (16 * hz)) - 1));
  const triPeriod = (hz) => Math.max(TRI_PERIOD_MIN, Math.min(PERIOD_MAX, Math.round(CLOCK / (32 * hz)) - 1));
  // The noise note (the player hands its Hz): $400E's rate, slowest at c2.
  const noisePeriod = (hz) => 15 - Math.max(0, Math.min(15, Math.round(69 + 12 * Math.log2(hz / 440)) - NOISE_NOTE_BASE));
  return {
    lanes: [view(0, pulsePeriod), view(1, pulsePeriod), view(2, triPeriod), view(3, noisePeriod)],
    // NOISE_MODE: its FB bit (4) white, else the 93-step loop.
    noise: (mode, when) => take({ kind: "mode", ch: 3, v: mode & 0b1_00 ? 0 : 0x80 }, when),
    flush(horizon) {
      const due = queue.filter((op) => op.t <= horizon + 1e-9).sort((a, b) => a.t - b.t);
      if (!due.length) return [];
      queue = queue.filter((op) => op.t > horizon + 1e-9);
      return due.flatMap((op) => apply(op).map((w) => [...w, op.t]));
    },
    // A stop or a seek: what is queued does not play, and every channel has
    // been silenced.
    drop() {
      queue = [];
      for (let ch = 0; ch < 4; ch++) {
        vol[ch] = 0;
        last.set(ctlAddr(ch), ctlByte(ch, 0));
      }
    },
    reset,
  };
}

export const rp2a03 = {
  chip: "rp2a03",
  clock: CLOCK,
  parts: [fcPulse, fcTriangle, fcNoise, fcDpcm],
  encoder: true,
  emulator: true,
  // The four channels enabled, the frame counter's IRQ off; the pulses at
  // volume 0, their sweeps off with negate set (else a period under ~A2
  // is muted by the sweep's overflow check), the triangle halted, the
  // noise at volume 0 with its length counter loaded (held by the halt
  // bit; the pulses' and the triangle's are loaded with their first
  // period's high bits).
  init: [
    [PORT, 0x15, 0x0f], [PORT, 0x17, 0x40],
    [PORT, 0x00, (DEFAULT_DUTY << 6) | 0x30], [PORT, 0x01, 0x08],
    [PORT, 0x04, (DEFAULT_DUTY << 6) | 0x30], [PORT, 0x05, 0x08],
    [PORT, 0x08, 0x80], [PORT, 0x0c, 0x30], [PORT, 0x0e, 0x00], [PORT, 0x0f, LENGTH],
    [PORT, 0x11, DMC_START], // the DMC's DAC where every hit starts, so the first is no thump
  ],
  // VGM 1.61: the clock at $84, the 0xB4 command (register − $4000, data);
  // the memory's writes as 0xC2 blocks (the address, then the bytes).
  vgm: {
    version: 0x161, clock: 0x84,
    ports: { [PORT]: { cmd: 0xb4, addr: true }, [RAM_PORT]: { ramBlock: 0xc2 } },
  },
  psgEncoder: apuEncoder,
  dmc,
};
