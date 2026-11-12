// The LR35902's APU, the Game Boy's sound: two pulses (a 4-bit level, four
// duties; the first's sweep is not the language's), a 32-step wave of 4-bit
// values at a level of 100 / 50 / 25 %, and a noise (a 4-bit level, a clock
// divider and shift, a 15- or 7-bit LFSR).
//
// Its registers are the worklet's port 0 at VGM's 0xB3 numbering, $FF10 − $FF10:
// $00 NR10 the sweep; $01-$04 NR11-NR14 the first pulse, $06-$09 NR21-NR24
// the second: NRx1 the duty (7-6) and length, NRx2 the level (7-4), the
// envelope's direction (3) and pace (2-0), NRx3 / NRx4 the period's low byte
// and top three bits, under the trigger (7) and length enable (6). $0A NR30
// the wave's DAC (7), $0C NR32 its level (6-5), $0D / $0E its period and
// trigger; $20-$2F the wave memory. $10-$13 NR41-NR44 the noise, NR43 its
// shift (7-4), width (3) and divider (2-0). $14 NR50 the master levels, $15
// NR51 the channels' sides (0-3 right, 4-7 left), $16 NR52 the power (7). How
// the chip reads them is Pan Docs' Audio Registers page and SameBoy's apu.c.
//
// A level under a note. NRx2 is read at a trigger, and a trigger starts a note
// over (it clears the noise's LFSR), so a level that moves is written the way
// LSDJ and Furnace do ("zombie mode"): with the envelope's pace at 0 and its
// direction up, each write of a value with its low nibble 8 steps the volume up
// one, wrapping at 16 (SameBoy's nrx2_glitch; it calls these the deterministic
// ones on DMG). Those writes carry the target in the high nibble, which the
// glitch does not read: a player that takes NRx2's level at once (MAME's core,
// libvgm's gb_mame.c) lands on the same level, and one that ignores the write
// keeps the key-on's. A fall of one step costs 15 writes. The DAC stays on
// throughout, since dropping it pops (Pan Docs): a key-off is $08 and a trigger.
//
// The wave is the other way about: NR32 is read at once, and a trigger while
// it plays corrupts the DMG's wave memory, so a note does not trigger it and
// only a wave load does — the load stops the channel (the memory is not
// reliably writable while it plays: Pan Docs), a click a load, so the same
// steps are not loaded twice.
import { words } from "./parts.js";
import { panSide } from "./opn-regs.js";
import { dutyCode } from "./rp2a03.js";

const CLOCK = 4194304;
const PORT = 0;
export const WAVE_LEN = 32;
const PERIOD_MAX = 0x7ff;
const DEFAULT_DUTY = 2; // 50 %
const NR = { 0: 0x01, 1: 0x06, 3: 0x10 }; // a channel's NRx1 ($10 the noise's)
const NR30 = 0x0a, NR32 = 0x0c, NR33 = 0x0d, NR34 = 0x0e, NR43 = 0x12, NR51 = 0x15;
const WAVE_RAM = 0x20;
const TRIGGER = 0x80;
const WAVE_LANE = 4;

// A noise note's rate: c2 is the slowest with a clock (shift 13, divider 7;
// shifts 14 and 15 get none), each semitone the next of the 60, as Furnace's
// noiseTable lays them out: the shift down, the dividers 7-4 within it.
export const NOISE_NOTE_BASE = 36;
export const NOISE_TABLE = [
  ...Array.from({ length: 14 }, (_, i) => [7, 6, 5, 4].map((d) => ((13 - i) << 4) | d)).flat(),
  3, 2, 1, 0,
];
/** The LFSR's clock of an NR43 value, Hz (Pan Docs: 262144 / (r · 2^s), r 0 as 0.5). */
export const noiseHz = (nr43) => 262144 / ((nr43 & 7 || 0.5) * 2 ** (nr43 >> 4));
/** The note whose rate is the nearest to a noise clocked at `hz`. */
export function noiseNoteOfHz(hz) {
  let best = 0;
  for (let i = 1; i < NOISE_TABLE.length; i++)
    if (Math.abs(Math.log(noiseHz(NOISE_TABLE[i]) / hz)) < Math.abs(Math.log(noiseHz(NOISE_TABLE[best]) / hz))) best = i;
  return NOISE_NOTE_BASE + best;
}

/** The clock (Hz) of the noise a note plays at: noiseNoteOfHz's other way. */
export const noiseHzOfNote = (note) => noiseHz(NOISE_TABLE[Math.max(0, Math.min(NOISE_TABLE.length - 1, Math.round(note) - NOISE_NOTE_BASE))]);

// A −128..127 step as the wave memory's 4-bit value.
const waveNibble = (v) => Math.max(0, Math.min(15, (Math.round(v) + 128) >> 4));
// The steps as the 16 bytes of the memory, high nibble first.
const waveBytes = (data) => Array.from({ length: WAVE_LEN / 2 }, (_, i) => (waveNibble(data[2 * i]) << 4) | waveNibble(data[2 * i + 1]));
// The wave a channel plays until its track names one: a square.
const DEFAULT_WAVE = Array.from({ length: WAVE_LEN }, (_, i) => (i < WAVE_LEN / 2 ? 127 : -128));

const LEVEL = { scale: "linear", steps: 16 }; // the 4-bit volume, 15 loud .. 0 off
const WAVE_LEVEL = { scale: "linear", steps: 256 }; // NR32's three, at the encoder
// NR32's codes by the gain: the nearest in dB, the edges −3 and −9 dB.
const waveCode = (gain) => (gain <= 0 ? 0 : gain >= 0.708 ? 1 : gain >= 0.355 ? 2 : 3);

export const gbPulse = {
  name: "gb-pulse",
  label: "Game Boy pulse",
  unit: "apu",
  kind: "tone",
  level: LEVEL,
  words: words("DUTY", "PAN"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "a Game Boy pulse has no :mode; its shape is :duty" },
};

export const gbWave = {
  name: "gb-wave",
  label: "Game Boy wave",
  kind: "wave",
  bass: true, // the Game Boy's bass channel: a conversion's bass part goes here
  level: WAVE_LEVEL,
  words: words("WAVE", "PAN"),
  modes: {},
  modeError: { code: "E_PARAM_VALUE", message: "the Game Boy's wave has no :mode; its sound is its def-wave" },
};

export const gbNoise = {
  name: "gb-noise",
  label: "Game Boy noise",
  unit: "apu",
  kind: "noise",
  level: LEVEL,
  words: words("NOISE_MODE", "PAN"),
  // The LFSR's width as NOISE_MODE's FB bit (chips/sn76489.js): 4 white, the
  // 15-bit one; 0 periodic, the 7-bit one.
  modes: { white: ["NOISE_MODE", 0b1_00], periodic: ["NOISE_MODE", 0b0_00] },
  modeError: { code: "E_PARAM_VALUE", message: "the Game Boy's noise :mode is white or periodic" },
  rateNote: true,
  noteOfHz: noiseNoteOfHz,
};

// The APU as the IR player's PSG: lanes 0-1 the pulses, 3 the noise, 4 the
// wave, each a view (`lanes`) with its own period; lane 2 has no channel.
// One per player. The player sends a note's writes out of time order (its
// level macro its whole length ahead, then its pitch), and a level is written
// as a count from the one before, so what has a time is queued and flush(horizon)
// (once every track is dispatched to it, as chips/ssg.js) applies it in time
// order, all of a time at once: a key-on's trigger takes that time's level
// and pitch whichever came first. What has no time (a key, a stop) goes now,
// and a silence is written where it is asked for, its state queued at its time:
// a stop's or a hot swap's queue is thrown away, and a note must not outlive it.
function apuEncoder() {
  let want, cur, sounding, duties, periods, written, sides, noiseWidth, keyed, waveNew, restart, queue, loaded;
  const reset = () => {
    want = [0, 0, 0, 0, 0]; // each channel's level at the queue's time (the wave's its code)
    cur = [0, 0, 0, 0, 0]; // the level the chip is at
    sounding = [false, false, false, false, false]; // asked to sound since the last silence
    duties = [DEFAULT_DUTY, DEFAULT_DUTY];
    periods = [0, 0, 0, NOISE_TABLE[0], 0]; // each lane's, the noise's its NR43
    written = new Map(); // a period / duty / NR43 register's value as written
    sides = 0xff;
    noiseWidth = 0;
    keyed = new Set(); // the channels to trigger
    waveNew = null; // the steps to load
    restart = false;
    queue = [];
    loaded = null; // a hot swap's encoder cannot know what the memory holds
  };
  reset();
  const nr = (ch, x) => NR[ch] + x - 1; // NRxy of a channel: nr(ch, 2) its NRx2
  const change = (addr, data) => {
    if (written.get(addr) === data) return [];
    written.set(addr, data);
    return [[PORT, addr, data]];
  };
  // A channel's writes for the state the time's ops left.
  const pulseOrNoise = (ch) => {
    const out = [];
    if (ch < 2) {
      out.push(...change(nr(ch, 1), duties[ch] << 6));
      out.push(...change(nr(ch, 3), periods[ch] & 0xff));
    } else out.push(...change(NR43, periods[3] | noiseWidth));
    const hi = ch < 2 ? periods[ch] >> 8 : 0;
    const level = (want[ch] << 4) | 8;
    // A silence is a key-off, so a note can never rise out of a stale level.
    if (keyed.has(ch) || (want[ch] === 0 && cur[ch] !== 0)) {
      out.push([PORT, nr(ch, 2), level], [PORT, nr(ch, 4), TRIGGER | hi]);
      written.set(nr(ch, 4), hi);
      cur[ch] = want[ch];
      return out;
    }
    for (let n = (want[ch] - cur[ch]) & 15; n > 0; n--) out.push([PORT, nr(ch, 2), level]);
    cur[ch] = want[ch];
    if (ch < 2) out.push(...change(nr(ch, 4), hi));
    return out;
  };
  const wave = () => {
    const out = [];
    if (waveNew) {
      const bytes = waveBytes(waveNew);
      if (bytes.join() !== loaded) {
        loaded = bytes.join();
        restart = true;
        out.push([PORT, NR30, 0x00], ...bytes.map((b, i) => [PORT, WAVE_RAM + i, b]), [PORT, NR30, 0x80]);
      }
      waveNew = null;
    }
    const p = periods[WAVE_LANE];
    out.push(...change(NR33, p & 0xff));
    if (restart) {
      out.push([PORT, NR34, TRIGGER | (p >> 8)]);
      written.set(NR34, p >> 8);
      restart = false;
    } else out.push(...change(NR34, p >> 8));
    if (want[4] !== cur[4]) out.push([PORT, NR32, (cur[4] = want[4]) << 5]);
    return out;
  };
  // One op on the wanted state.
  const apply = (op) => {
    const { ch } = op;
    switch (op.kind) {
      case "key": keyed.add(ch); break;
      case "vol":
        want[ch] = op.v;
        // Already written (att): the state, and NRx4's period bits are unsure.
        if (op.silent) {
          cur[ch] = 0;
          if (ch !== WAVE_LANE) written.delete(nr(ch, 4));
          return true;
        }
        break;
      case "duty": duties[ch] = op.v; break;
      case "tone": periods[ch] = op.v; break;
      case "wave": waveNew = op.data; break;
      case "mode":
        // A width changed under a note can lock the LFSR up until a trigger (Pan Docs).
        if (noiseWidth !== op.v) keyed.add(3);
        noiseWidth = op.v;
        break;
      case "pan": {
        const bits = (op.v <= 0 ? 0x10 : 0) | (op.v >= 0 ? 0x01 : 0);
        sides = (sides & ~(0x11 << ch)) | (bits << ch);
        return true;
      }
    }
    return false;
  };
  // All of one time's ops: the writes they make.
  const writesOf = (ops) => {
    let pan = false;
    const chs = new Set();
    for (const op of ops) {
      if (apply(op)) pan ||= op.kind === "pan";
      else chs.add(op.ch);
    }
    const out = [];
    for (const ch of chs) out.push(...(ch === WAVE_LANE ? wave() : pulseOrNoise(ch)));
    keyed.clear();
    if (pan) out.push(...change(NR51, sides));
    return out;
  };
  const take = (op, when) => {
    if (op.kind === "key" || (op.kind === "vol" && op.v)) sounding[op.ch] = true;
    if (when === undefined || when === null) return writesOf([op]);
    queue.push({ ...op, t: when });
    return [];
  };
  // A silence's writes, whatever the state says: a stop's flush has run it on
  // to the queue's end, where the note may already be at 0.
  const silenceWrites = (ch) => (ch === WAVE_LANE ? [[PORT, NR32, 0]]
    : [[PORT, nr(ch, 2), 0x08], [PORT, nr(ch, 4), TRIGGER | (ch < 2 ? periods[ch] >> 8 : 0)]]);
  const level = (ch, v, when) => {
    if (v) return take({ kind: "vol", ch, v }, when);
    const was = sounding[ch];
    sounding[ch] = false;
    if (when === undefined || when === null) {
      want[ch] = cur[ch] = 0;
      return silenceWrites(ch);
    }
    if (!was) return [];
    // A key-off at the time of a write still queued (a note shorter than the
    // frame it lands in): queued after it, so it comes after.
    if (queue.some((op) => op.ch === ch && op.t >= when - 1e-9)) return take({ kind: "vol", ch, v: 0 }, when);
    queue.push({ kind: "vol", ch, v: 0, silent: true, t: when });
    return silenceWrites(ch);
  };
  const view = (ch, period, extra = {}) => ({
    period,
    // The player's attenuation, 0 loud .. 15 off, upside down.
    att: (_l, a, when) => level(ch, 15 - Math.max(0, Math.min(15, a | 0)), when),
    tone: (_l, p, when) => take({ kind: "tone", ch, v: p }, when),
    pan: (_l, p, when) => take({ kind: "pan", ch: ch === WAVE_LANE ? 2 : ch, v: panSide(p) }, when),
    keyOn: (_l, when, legato) => (legato ? [] : take({ kind: "key", ch }, when)),
    ...extra,
  });
  // A pulse is the clock / 32 / (2048 − x), the wave / 64.
  const pulsePeriod = (hz) => Math.max(0, Math.min(PERIOD_MAX, 2048 - Math.round(CLOCK / (32 * hz))));
  const wavePeriod = (hz) => Math.max(0, Math.min(PERIOD_MAX, 2048 - Math.round(CLOCK / (64 * hz))));
  // The noise note (the player hands its Hz): NR43's shift and divider.
  const noisePeriod = (hz) => NOISE_TABLE[Math.max(0, Math.min(NOISE_TABLE.length - 1, Math.round(69 + 12 * Math.log2(hz / 440)) - NOISE_NOTE_BASE))];
  const pulse = (ch) => view(ch, pulsePeriod, { duty: (_l, d, when) => take({ kind: "duty", ch, v: dutyCode(d) }, when) });
  return {
    lanes: [
      pulse(0), pulse(1),
      { period: () => 0, att: () => [], tone: () => [] },
      view(3, noisePeriod),
      view(WAVE_LANE, wavePeriod, {
        // The player's attenuation, 0 loud .. 255 off: the gain, upside down.
        att: (_l, a, when) => level(WAVE_LANE, waveCode(1 - Math.max(0, Math.min(255, a | 0)) / 255), when),
        keyOn: () => [],
        wave: (_l, data, when) => take({ kind: "wave", ch: WAVE_LANE, data }, when),
      }),
    ],
    // NOISE_MODE: its FB bit (4) the 15-bit LFSR, else NR43's width bit.
    noise: (mode, when) => take({ kind: "mode", ch: 3, v: mode & 0b1_00 ? 0 : 0x08 }, when),
    flush(horizon) {
      const due = queue.filter((op) => op.t <= horizon + 1e-9).sort((a, b) => a.t - b.t);
      if (!due.length) return [];
      queue = queue.filter((op) => op.t > horizon + 1e-9);
      const out = [];
      for (let i = 0; i < due.length; ) {
        let j = i;
        while (j < due.length && due[j].t - due[i].t < 1e-9) j++;
        for (const w of writesOf(due.slice(i, j))) out.push([...w, due[i].t]);
        i = j;
      }
      return out;
    },
    // A stop or a seek: what is queued does not play, and every channel has
    // been silenced.
    drop() {
      queue = [];
      want.fill(0);
      cur.fill(0);
      sounding.fill(false);
    },
    reset,
  };
}

export const lr35902 = {
  chip: "lr35902",
  clock: CLOCK,
  parts: [gbPulse, gbWave, gbNoise],
  encoder: true,
  emulator: true,
  // The power on, the master levels full, every channel on both sides, its
  // DAC on at level 0 and triggered, so a level written from here is the
  // zombie's count from 0; the wave at level 0, a square in its memory.
  init: [
    [PORT, 0x16, 0x80], [PORT, 0x14, 0x77], [PORT, NR51, 0xff],
    [PORT, 0x00, 0x00],
    [PORT, 0x01, DEFAULT_DUTY << 6], [PORT, 0x02, 0x08], [PORT, 0x04, TRIGGER],
    [PORT, 0x06, DEFAULT_DUTY << 6], [PORT, 0x07, 0x08], [PORT, 0x09, TRIGGER],
    [PORT, 0x10, 0x00], [PORT, 0x11, 0x08], [PORT, NR43, NOISE_TABLE[0]], [PORT, 0x13, TRIGGER],
    [PORT, NR30, 0x00], ...waveBytes(DEFAULT_WAVE).map((b, i) => [PORT, WAVE_RAM + i, b]), [PORT, NR30, 0x80],
    [PORT, NR32, 0x00], [PORT, NR34, TRIGGER],
  ],
  // VGM 1.61: the clock at $80, the 0xB3 command (register − $FF10, data).
  vgm: { version: 0x161, clock: 0x80, ports: { [PORT]: { cmd: 0xb3, addr: true } } },
  psgEncoder: apuEncoder,
};
