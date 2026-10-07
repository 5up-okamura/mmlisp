// ---------------------------------------------------------------------------
// VGM (.vgm / .vgz) → MMLisp
//
// A VGM is a timed register-write log, so the notes are rebuilt from what
// the chips were told: a key-on starts a note, a key-off ends it, the pitch
// is the frequency in force, and on an OPN / OPM chip the voice is every
// register of the channel at key-on. What maps:
//
//   YM2612, YM2203, YM2608, YM2610   voices and notes (FM), SSG → PSG
//   YM2151 (OPM)                     voices (DT2 dropped) and notes
//   SN76489, AY-3-8910               notes (square, noise)
//   YM2413, YM3812/3526/Y8950, YMF262 notes, on a stand-in voice
//
// Carrier TL is how most drivers set a channel's level, so a voice's
// carriers are taken relative to their loudest use and the rest becomes
// `:vel`, a level moving during a note a `:vel+` envelope. Pitch moved
// during a note: a jump it stays at becomes a slur to a new note, a vibrato
// or a bend a `:pitch` macro (pitchShape). The YM2612's DAC, played from a
// data bank (seeks + 8n, or DAC stream control), is a PCM track over one wav
// of the bank (dacTrack); other chips' PCM is reported, not imported.
//
// The tempo is estimated (estimateGrid): the onsets' common unit, read as a
// 16th (or whatever puts the tempo in a musical range), with a frame grid
// as the fallback when the onsets do not fit one.
//
//   parseVgm(bytes)                  → the file's chips and channels' events
//   analyzeVgm(parsed)               → what the import dialog shows
//   defaultVgmOptions(analysis)      → its defaults
//   vgmToMmlisp(parsed, options, analysis) → { source, warnings }
// ---------------------------------------------------------------------------

import { emitSong, emitStructured, bestBars, qstr, barEnds, estimateGrid, regrid, RATE,
  assignBends, PITCH_NONE } from "./import-song.js";
import { fmVoiceDef } from "./import-fm-voices.js";
import { encodeWav } from "./export-wav.js";
import { FM_DESTS, PSG_DESTS } from "./import-midi.js";

const CARRIERS = [[3], [3], [3], [3], [2, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]]; // by ALG, in slot order
const STAND_IN = { psg: "wave-square", noise: "wave-square", opl: "wave-sine", opll: "wave-saw" };

/** gzip (.vgz) → bytes */
async function gunzip(u8) {
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;
  const ds = new DecompressionStream("gzip");
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

const pitchOf = (hz) => (hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null);

// ── Chips ─────────────────────────────────────────────────────────────────
// Each chip model keeps its registers and calls `ev(channelKey, event)`:
//   {t, kind: "on", pitch, vel?, voice?, pan?, mode?} | {t, kind: "off"}
//   | {t, kind: "pitch", pitch} | {t, kind: "vel", vel} (a PSG's level)
//   | {t, kind: "tl", tl} (an FM channel's loudest carrier TL, while keyed)

function opnChip(name, clock, divisor, { ssgDiv, channels = 6, ev }) {
  const regs = [new Uint8Array(256), new Uint8Array(256)];
  const keyed = new Array(6).fill(false);
  let dac = false;
  const hiLatch = [new Uint8Array(3), new Uint8Array(3)];
  const ssg = ssgDiv ? ayChip(`${name} SSG`, clock / ssgDiv, { ev, prefix: name }) : null;
  const chOf = (c) => ({ port: c < 3 ? 0 : 1, i: c % 3 });
  const hz = (c) => {
    const { port, i } = chOf(c);
    const hi = regs[port][0xa4 + i];
    const fnum = ((hi & 7) << 8) | regs[port][0xa0 + i];
    const block = (hi >> 3) & 7;
    return (fnum * clock) / (divisor * 2 ** (21 - block));
  };
  const voice = (c) => {
    const { port, i } = chOf(c);
    const r = regs[port];
    const ops = [];
    for (let s = 0; s < 4; s++) {
      const o = 4 * s + i;
      ops.push({
        dt: (r[0x30 + o] >> 4) & 7, mul: r[0x30 + o] & 15, tl: r[0x40 + o] & 127,
        rs: r[0x50 + o] >> 6, ar: r[0x50 + o] & 31, am: r[0x60 + o] >> 7, dr: r[0x60 + o] & 31,
        sr: r[0x70 + o] & 31, sl: r[0x80 + o] >> 4, rr: r[0x80 + o] & 15,
        ssg: r[0x90 + o] & 8 ? r[0x90 + o] & 15 : 0,
      });
    }
    const b4 = r[0xb4 + i];
    return {
      alg: r[0xb0 + i] & 7, fb: (r[0xb0 + i] >> 3) & 7, ams: (b4 >> 4) & 3, fms: b4 & 7, ops,
      pan: (b4 >> 6) === 2 ? "left" : (b4 >> 6) === 1 ? "right" : "center",
    };
  };
  const carrierTl = (c) => {
    const { port, i } = chOf(c);
    const r = regs[port];
    return Math.min(...CARRIERS[r[0xb0 + i] & 7].map((s) => r[0x40 + 4 * s + i] & 127));
  };
  const key = (c) => `${name} FM${c + 1}`;
  return {
    name,
    kinds: { fm: true },
    write(port, a, d, t) {
      if (port === 0 && a < 0x10) return ssg?.write(a, d, t);
      if (port === 0 && a === 0x2b) { dac = !!(d & 0x80); return; }
      if (port === 0 && a === 0x28) {
        const lo = d & 7;
        const c = lo >= 4 ? lo - 1 : lo;
        if (lo === 3 || lo === 7 || c >= channels) return;
        const on = (d & 0xf0) !== 0;
        if (c === 5 && dac) return;
        if (on && !keyed[c]) {
          const v = voice(c);
          ev(key(c), { t, kind: "on", pitch: pitchOf(hz(c)), voice: v, pan: v.pan, kindOf: "fm" });
        } else if (!on && keyed[c]) ev(key(c), { t, kind: "off" });
        keyed[c] = on;
        return;
      }
      regs[port][a] = d;
      if (a >= 0x40 && a < 0x50 && (a & 3) !== 3) {
        const c = (a & 3) + port * 3;
        if (keyed[c]) ev(key(c), { t, kind: "tl", tl: carrierTl(c) });
      }
      if (a >= 0xa4 && a <= 0xa6) hiLatch[port][a - 0xa4] = d;
      if (a >= 0xa0 && a <= 0xa2) {
        regs[port][0xa4 + a - 0xa0] = hiLatch[port][a - 0xa0];
        const c = (a - 0xa0) + port * 3;
        if (keyed[c]) ev(key(c), { t, kind: "pitch", pitch: pitchOf(hz(c)) });
      }
      if (a >= 0xa4 && a <= 0xa6) regs[port][a] = d;
    },
    get dacUsed() { return dac; },
  };
}

function opmChip(clock, { ev }) {
  const r = new Uint8Array(256);
  const keyed = new Array(8).fill(false);
  const NOTE = [0, 1, 2, null, 3, 4, 5, null, 6, 7, 8, null, 9, 10, 11];
  const pitch = (c) => {
    const kc = r[0x28 + c];
    const n = NOTE[kc & 15];
    if (n == null) return null;
    return 12 * (((kc >> 4) & 7) + 1) + 1 + n + (r[0x30 + c] >> 2) / 64 + 12 * Math.log2(clock / 3579545);
  };
  const voice = (c) => {
    const ops = [];
    for (let s = 0; s < 4; s++) {
      const o = 8 * s + c;
      ops.push({
        dt: (r[0x40 + o] >> 4) & 7, mul: r[0x40 + o] & 15, tl: r[0x60 + o] & 127,
        rs: r[0x80 + o] >> 6, ar: r[0x80 + o] & 31, am: r[0xa0 + o] >> 7, dr: r[0xa0 + o] & 31,
        sr: r[0xc0 + o] & 31, sl: r[0xe0 + o] >> 4, rr: r[0xe0 + o] & 15, ssg: 0,
      });
    }
    const rl = r[0x20 + c] >> 6;
    return {
      alg: r[0x20 + c] & 7, fb: (r[0x20 + c] >> 3) & 7, ams: r[0x38 + c] & 3, fms: (r[0x38 + c] >> 4) & 7,
      ops, pan: rl === 1 ? "left" : rl === 2 ? "right" : "center",
    };
  };
  const key = (c) => `YM2151 FM${c + 1}`;
  return {
    name: "YM2151",
    write(a, d, t) {
      if (a === 0x08) {
        const c = d & 7;
        const on = (d & 0x78) !== 0;
        if (on && !keyed[c]) {
          const v = voice(c);
          ev(key(c), { t, kind: "on", pitch: pitch(c), voice: v, pan: v.pan, kindOf: "opm" });
        } else if (!on && keyed[c]) ev(key(c), { t, kind: "off" });
        keyed[c] = on;
        return;
      }
      r[a] = d;
      if (a >= 0x60 && a < 0x80 && keyed[a & 7]) {
        const c = a & 7;
        ev(key(c), { t, kind: "tl", tl: Math.min(...CARRIERS[r[0x20 + c] & 7].map((s) => r[0x60 + 8 * s + c] & 127)) });
      }
      if (a >= 0x28 && a < 0x38) {
        const c = a & 7;
        if (keyed[c]) ev(key(c), { t, kind: "pitch", pitch: pitch(c) });
      }
    },
  };
}

function snChip(clock, { ev }) {
  const period = [0, 0, 0];
  const att = [15, 15, 15, 15];
  // A driver strikes a note by writing its period and its level together; a
  // period written alone is a slide.
  const attAt = [-1, -1, -1, -1];
  const periodAt = [-1, -1, -1];
  let latch = 0;
  let noise = 0;
  const key = (c) => (c === 3 ? "SN76489 noise" : `SN76489 SQ${c + 1}`);
  const hz = (c) => (period[c] > 0 ? clock / (32 * period[c]) : 0);
  const noiseMode = () => `${noise & 4 ? "white" : "periodic"}${noise & 3}`;
  return {
    name: "SN76489",
    write(d, t) {
      if (d & 0x80) {
        latch = (d >> 4) & 7;
        const c = latch >> 1;
        if (latch & 1) setAtt(c, d & 15, t);
        else if (c < 3) setPeriod(c, (period[c] & 0x3f0) | (d & 15), t);
        else {
          // Writing the noise register restarts the noise: a new hit.
          noise = d & 7;
          if (att[3] < 15) ev(key(3), { t, kind: "retrig", pitch: 60, vel: 15 - att[3], mode: noiseMode() });
        }
      } else {
        const c = latch >> 1;
        if (latch & 1) setAtt(c, d & 15, t);
        else if (c < 3) setPeriod(c, (period[c] & 15) | ((d & 0x3f) << 4), t);
      }
    },
  };
  function setPeriod(c, p, t) {
    const changed = p !== period[c];
    period[c] = p;
    periodAt[c] = t;
    if (att[c] < 15 && changed)
      ev(key(c), { t, kind: attAt[c] === t ? "retrig" : "pitch", pitch: pitchOf(hz(c)), vel: 15 - att[c] });
  }
  function setAtt(c, a, t) {
    const was = att[c];
    att[c] = a;
    attAt[c] = t;
    if (c < 3 && was < 15 && a < 15 && periodAt[c] === t) {
      ev(key(c), { t, kind: "retrig", pitch: pitchOf(hz(c)), vel: 15 - a });
      return;
    }
    if (was === 15 && a < 15) {
      ev(key(c), c === 3
        ? { t, kind: "on", pitch: 60, vel: 15 - a, mode: noiseMode(), kindOf: "noise" }
        : { t, kind: "on", pitch: pitchOf(hz(c)), vel: 15 - a, kindOf: "psg" });
    } else if (was < 15 && a === 15) ev(key(c), { t, kind: "off" });
    else if (a < was - 2) ev(key(c), { t, kind: "retrig", vel: 15 - a });
    else if (a !== was) ev(key(c), { t, kind: "vel", vel: 15 - a });
  }
}

// AY-3-8910 and the OPN family's SSG: `clock` is the tone clock (f = clock / 16 / TP).
function ayChip(name, clock, { ev, prefix = name }) {
  const r = new Uint8Array(16);
  const on = [false, false, false];
  const asNoise = [false, false, false];
  const ampAt = [-1, -1, -1];
  const tpAt = [-1, -1, -1];
  const key = (c) => `${prefix} SSG${String.fromCharCode(65 + c)}`;
  const hz = (c) => {
    const tp = r[2 * c] | ((r[2 * c + 1] & 15) << 8);
    return tp > 0 ? clock / (16 * tp) : 0;
  };
  const amp = (c) => (r[8 + c] & 16 ? 15 : r[8 + c] & 15);
  const update = (c, t) => {
    const tone = !(r[7] & (1 << c));
    const noise = !(r[7] & (8 << c));
    const audible = amp(c) > 0 && (tone || noise);
    if (audible && !on[c]) {
      asNoise[c] = !tone;
      const k = asNoise[c] ? `${prefix} SSG noise` : key(c);
      ev(k, asNoise[c]
        ? { t, kind: "on", pitch: 60, vel: amp(c), mode: "white2", kindOf: "noise" }
        : { t, kind: "on", pitch: pitchOf(hz(c)), vel: amp(c), kindOf: "psg" });
    } else if (!audible && on[c]) {
      ev(asNoise[c] ? `${prefix} SSG noise` : key(c), { t, kind: "off" });
    }
    on[c] = audible;
  };
  return {
    name,
    write(a, d, t) {
      if (a > 15) return;
      const prev = a >= 8 && a <= 10 ? amp(a - 8) : 0;
      r[a] = d;
      if (a < 6) {
        const c = a >> 1;
        tpAt[c] = t;
        if (on[c] && !asNoise[c])
          ev(key(c), { t, kind: ampAt[c] === t ? "retrig" : "pitch", pitch: pitchOf(hz(c)), vel: amp(c) });
      } else if (a === 7) {
        for (let c = 0; c < 3; c++) update(c, t);
      } else if (a >= 8 && a <= 10) {
        const c = a - 8;
        ampAt[c] = t;
        if (on[c] && !asNoise[c] && tpAt[c] === t && amp(c) > 0)
          ev(key(c), { t, kind: "retrig", pitch: pitchOf(hz(c)), vel: amp(c) });
        else if (on[c] && amp(c) > prev + 2) ev(asNoise[c] ? `${prefix} SSG noise` : key(c), { t, kind: "retrig", vel: amp(c) });
        else if (on[c] && amp(c) > 0) ev(asNoise[c] ? `${prefix} SSG noise` : key(c), { t, kind: "vel", vel: amp(c) });
        update(c, t);
      }
    },
  };
}

function opllChip(clock, { ev }) {
  const r = new Uint8Array(64);
  const keyed = new Array(9).fill(false);
  const hz = (c) => {
    const fnum = r[0x10 + c] | ((r[0x20 + c] & 1) << 8);
    const block = (r[0x20 + c] >> 1) & 7;
    return (fnum * clock) / 72 / 2 ** (19 - block);
  };
  const key = (c) => `YM2413 FM${c + 1}`;
  return {
    name: "YM2413",
    write(a, d, t) {
      if (a > 0x3f) return;
      r[a] = d;
      const c = a & 15;
      if (c > 8) return;
      if ((a & 0xf0) === 0x20) {
        const on = !!(d & 0x10);
        if (on && !keyed[c]) ev(key(c), { t, kind: "on", pitch: pitchOf(hz(c)), vel: Math.max(0, 15 - Math.round((r[0x30 + c] & 15) * 1.5)), kindOf: "opll" });
        else if (!on && keyed[c]) ev(key(c), { t, kind: "off" });
        else if (on) ev(key(c), { t, kind: "pitch", pitch: pitchOf(hz(c)) });
        keyed[c] = on;
      } else if ((a & 0xf0) === 0x10 && keyed[c]) ev(key(c), { t, kind: "pitch", pitch: pitchOf(hz(c)) });
    },
  };
}

function oplChip(name, clock, divisor, { ev }) {
  const r = [new Uint8Array(256), new Uint8Array(256)];
  const keyed = new Array(18).fill(false);
  const hz = (p, c) => {
    const fnum = r[p][0xa0 + c] | ((r[p][0xb0 + c] & 3) << 8);
    const block = (r[p][0xb0 + c] >> 2) & 7;
    return (fnum * clock) / divisor / 2 ** (20 - block);
  };
  return {
    name,
    write(p, a, d, t) {
      r[p][a] = d;
      const c = a & 15;
      if (c > 8) return;
      const k = `${name} CH${p * 9 + c + 1}`;
      const i = p * 9 + c;
      if ((a & 0xf0) === 0xb0) {
        const on = !!(d & 0x20);
        if (on && !keyed[i]) ev(k, { t, kind: "on", pitch: pitchOf(hz(p, c)), kindOf: "opl" });
        else if (!on && keyed[i]) ev(k, { t, kind: "off" });
        else if (on) ev(k, { t, kind: "pitch", pitch: pitchOf(hz(p, c)) });
        keyed[i] = on;
      } else if ((a & 0xf0) === 0xa0 && keyed[i]) ev(k, { t, kind: "pitch", pitch: pitchOf(hz(p, c)) });
    },
  };
}

// ── The file ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ chips: string[], skipped: Map<string, number>, events: Map<key, ev[]>,
 *   kinds: Map<key, kind>, totalSamples, loopSample, title, author, game, system, dac: boolean,
 *   dacBank: Uint8Array, dacHits: [{t, offset, bytes, rate}] }>}
 */
export async function parseVgm(bytes) {
  const u8 = await gunzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "Vgm ") throw new Error("not a VGM file");
  const u32 = (o) => (o + 4 <= u8.length ? dv.getUint32(o, true) : 0);
  const version = u32(0x08);
  const dataStart = version >= 0x150 && u32(0x34) ? 0x34 + u32(0x34) : 0x40;
  const hdr = (o) => (o < dataStart ? u32(o) : 0);
  const clk = (o) => hdr(o) & 0x3fffffff;
  const dual = (o) => !!(hdr(o) & 0x40000000);
  const totalSamples = u32(0x18);
  const loopOffset = u32(0x1c) ? 0x1c + u32(0x1c) : null;

  const events = new Map();
  const kinds = new Map();
  const ev = (k, e) => {
    if (!events.has(k)) events.set(k, []);
    events.get(k).push(e);
    if (e.kindOf) kinds.set(k, e.kindOf);
  };
  const chips = [];
  const skipped = new Map();
  const skip = (name) => skipped.set(name, (skipped.get(name) ?? 0) + 1);
  // Each chip's model starts at its first command, on the header's clock —
  // before VGM 1.10 the YM2413 field clocks the YM2612 and YM2151 too — or,
  // when the header gives none (some arrangements leave it 0), the chip's
  // usual clock, said in a warning.
  const clockNotes = [];
  const made = new Map();
  const CHIPS = {
    sn: [0x0c, 3579545, (c) => snChip(c, { ev })],
    opll: [0x10, 3579545, (c) => opllChip(c, { ev })],
    opn2: [0x2c, 7670453, (c) => opnChip("YM2612", c, 144, { ev })],
    opm: [0x30, 3579545, (c) => opmChip(c, { ev })],
    opn: [0x44, 3993600, (c) => opnChip("YM2203", c, 72, { ssgDiv: 2, channels: 3, ev })],
    opna: [0x48, 7987200, (c) => opnChip("YM2608", c, 144, { ssgDiv: 4, ev })],
    opnb: [0x4c, 8000000, (c) => opnChip("YM2610", c, 144, { ssgDiv: 4, ev })],
    opl2: [0x50, 3579545, (c) => oplChip("YM3812", c, 72, { ev })],
    opl1: [0x54, 3579545, (c) => oplChip("YM3526", c, 72, { ev })],
    y8950: [0x58, 3579545, (c) => oplChip("Y8950", c, 72, { ev })],
    opl3: [0x5c, 14318180, (c) => oplChip("YMF262", c, 288, { ev })],
    ay: [0x74, 1789773, (c) => ayChip("AY-3-8910", c, { ev })],
  };
  const chip = (key) => {
    if (made.has(key)) return made.get(key);
    const [off, usual, make] = CHIPS[key];
    let c = clk(off);
    if (!c && version < 0x110 && (key === "opn2" || key === "opm")) c = clk(0x10);
    const m = make(c || usual);
    if (!c) clockNotes.push(`the header gives no ${m.name} clock — its usual ${usual} Hz is assumed`);
    made.set(key, m);
    chips.push(m.name);
    return m;
  };
  for (const [o, n] of [[0x0c, "SN76489"], [0x10, "YM2413"], [0x2c, "YM2612"], [0x30, "YM2151"], [0x44, "YM2203"],
    [0x48, "YM2608"], [0x4c, "YM2610"], [0x50, "YM3812"], [0x74, "AY-3-8910"]])
    if (dual(o)) skip(`second ${n}`);

  let p = dataStart;
  let t = 0;
  let loopSample = null;
  let dac = false;
  // The YM2612's DAC: the PCM data bank (data blocks of type 0, appended),
  // and each hit played from it — {t, offset, bytes, rate}. A hit is what a
  // seek (E0) or a stream start (0x93 / 0x95) begins; its rate is the pace
  // the bytes go out at.
  const bankParts = [];
  let bankLen = 0;
  const blocks = []; // type-0 blocks: [offset, size] (a stream's block id)
  const hits = [];
  let pos = null; // the 8n read position
  let hit = null; // the hit the 8n writes are playing
  // A hit's rate: its bytes over the time they took (a VGM waits whole
  // samples, so one gap alone reads 44100/k).
  const closeHit = () => {
    if (hit && hit.bytes > 1 && hit.last > hit.t)
      hits.push({ t: hit.t, offset: hit.offset, bytes: hit.bytes, rate: (RATE * (hit.bytes - 1)) / (hit.last - hit.t) });
    hit = null;
  };
  const streams = new Map(); // id → {dac, freq, hit}
  const stream = (id) => { if (!streams.has(id)) streams.set(id, { dac: false, freq: 0, hit: null }); return streams.get(id); };
  const endStream = (st, at) => {
    const h = st.hit;
    if (!h) return;
    const bytes = Math.min(h.bytes, Math.floor(((at - h.t) * h.rate) / RATE));
    if (bytes > 0) hits.push({ ...h, bytes });
    st.hit = null;
  };
  const LEN = { 0x30: 2, 0x3f: 2, 0x4f: 2, 0x50: 2, 0x94: 2 };
  while (p < u8.length) {
    if (p === loopOffset) loopSample = t;
    const c = u8[p];
    if (c === 0x66) break;
    if (c === 0x61) { t += u8[p + 1] | (u8[p + 2] << 8); p += 3; continue; }
    if (c === 0x62) { t += 735; p++; continue; }
    if (c === 0x63) { t += 882; p++; continue; }
    if ((c & 0xf0) === 0x70) { t += (c & 15) + 1; p++; continue; }
    if ((c & 0xf0) === 0x80) {
      if (pos != null && pos < bankLen) {
        if (!hit || t - hit.last > 2 * 735) { closeHit(); hit = { t, offset: pos, bytes: 0, last: t }; }
        hit.last = t;
        hit.bytes++;
        pos++;
      }
      t += c & 15; dac = true; p++; continue;
    }
    if (c === 0xe0) { closeHit(); pos = u32(p + 1); p += 5; continue; }
    if (c === 0x67) {
      const type = u8[p + 2];
      const size = u32(p + 3) & 0x7fffffff;
      if (type === 0) {
        blocks.push([bankLen, size]);
        bankParts.push(u8.subarray(p + 7, p + 7 + size));
        bankLen += size;
      }
      p += 7 + size; continue;
    }
    // DAC stream control onto the YM2612's DAC (register 2A).
    if (c === 0x90) { stream(u8[p + 1]).dac = u8[p + 2] === 0x02 && u8[p + 4] === 0x2a; p += 5; continue; }
    if (c === 0x91) { p += 5; continue; }
    if (c === 0x92) { stream(u8[p + 1]).freq = u32(p + 2); p += 6; continue; }
    if (c === 0x93 || c === 0x95) {
      const st = stream(u8[p + 1]);
      endStream(st, t);
      let offset, bytes;
      if (c === 0x93) {
        offset = u32(p + 2);
        const mode = u8[p + 6] & 0x0f, len = u32(p + 7);
        bytes = mode === 1 ? len : mode === 2 ? Math.round((len * st.freq) / 1000) : bankLen - offset;
        p += 11;
      } else {
        const b = blocks[u8[p + 2] | (u8[p + 3] << 8)];
        [offset, bytes] = b ?? [0, 0];
        p += 5;
      }
      if (st.dac && st.freq > 0 && offset < bankLen && bytes > 0) {
        st.hit = { t, offset, bytes: Math.min(bytes, bankLen - offset), rate: st.freq };
        dac = true;
      }
      continue;
    }
    if (c === 0x94) {
      if (u8[p + 1] === 0xff) for (const st of streams.values()) endStream(st, t);
      else endStream(stream(u8[p + 1]), t);
      p += 2; continue;
    }
    if (c === 0x68) { p += 12; continue; }
    if (c === 0x50) { chip("sn").write(u8[p + 1], t); p += 2; continue; }
    if (c === 0x51) { chip("opll").write(u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x52 || c === 0x53) {
      chip("opn2").write(c - 0x52, u8[p + 1], u8[p + 2], t);
      p += 3; continue;
    }
    if (c === 0x54) { chip("opm").write(u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x55) { chip("opn").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x56 || c === 0x57) { chip("opna").write(c - 0x56, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x58 || c === 0x59) { chip("opnb").write(c - 0x58, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5a) { chip("opl2").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5b) { chip("opl1").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5c) { chip("y8950").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5e || c === 0x5f) { chip("opl3").write(c - 0x5e, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0xa0) {
      if (!(u8[p + 1] & 0x80)) chip("ay").write(u8[p + 1], u8[p + 2], t);
      p += 3; continue;
    }
    // Everything else, by the command ranges' fixed lengths.
    let n;
    if (c >= 0x30 && c <= 0x3f) n = 2;
    else if (c >= 0x40 && c <= 0x4e) n = 3;
    else if (c >= 0xa1 && c <= 0xbf) n = 3;
    else if (c >= 0xc0 && c <= 0xdf) n = 4;
    else if (c >= 0xe1) n = 5;
    else n = LEN[c] ?? 1;
    if (c !== 0x4f) skip(`command 0x${c.toString(16)}`);
    p += n;
  }
  const end = Math.max(t, totalSamples);
  closeHit();
  for (const st of streams.values()) endStream(st, end);
  hits.sort((a, b) => a.t - b.t);
  // A hit cut off within 10 ms by the next (a driver starting one sample and
  // at once another) is not one.
  for (let i = hits.length - 2; i >= 0; i--)
    if (hits[i + 1].t - hits[i].t < 0.01 * RATE && (hits[i].bytes / hits[i].rate) < 0.01) hits.splice(i, 1);
  const bank = new Uint8Array(bankLen);
  { let o = 0; for (const part of bankParts) { bank.set(part, o); o += part.length; } }
  if (made.get("opn2")?.dacUsed) dac = true;

  // GD3: track, game, system, author (English, or Japanese when that is all).
  let title = null, author = null, game = null, system = null;
  const gd3 = u32(0x14) ? 0x14 + u32(0x14) : 0;
  if (gd3 && String.fromCharCode(...u8.subarray(gd3, gd3 + 4)) === "Gd3 ") {
    const s = [];
    let q = gd3 + 12;
    const stop = Math.min(u8.length, q + u32(gd3 + 8));
    let cur = "";
    while (q + 1 < stop && s.length < 11) {
      const code = u8[q] | (u8[q + 1] << 8);
      q += 2;
      if (code === 0) { s.push(cur); cur = ""; } else cur += String.fromCharCode(code);
    }
    title = s[0] || s[1] || null;
    game = s[2] || s[3] || null;
    system = s[4] || s[5] || null;
    author = s[6] || s[7] || null;
  }
  return { chips, skipped, clockNotes, events, kinds, totalSamples: end, loopSample, title, author, game, system, dac,
    dacBank: bank, dacHits: hits };
}

// ── Notes ─────────────────────────────────────────────────────────────────

/**
 * One channel's events → notes in samples: {t, end, pitch, vel, voice?, pan?,
 * mode?, slur?, bend?, levels}. `levels`: [t, level] — the PSG level or the
 * FM carrier TL as it moves during the note (`lv0`: where a slurred note
 * starts; an FM note's otherwise is its voice's). With `followPitch`, a
 * pitch moved during a note is shaped (pitchShape): a jump it stays at is a
 * slur to a new note, the rest a `bend` on the note.
 */
function notesOf(events, followPitch, endT, tune = 0) {
  if (tune) events = events.map((e) => (e.pitch != null ? { ...e, pitch: e.pitch - tune } : e));
  const out = [];
  let cur = null;
  const close = (t) => { if (cur) { cur.end = t; out.push(cur); cur = null; } };
  for (const e of events) {
    if (e.kind === "on" || (e.kind === "retrig" && cur)) {
      const base = cur ?? {};
      close(e.t);
      if (e.pitch == null && base.pitch == null) continue;
      cur = { t: e.t, pitch: e.pitch ?? base.pitch, vel: e.vel ?? base.vel ?? 15, voice: e.voice ?? base.voice,
        pan: e.pan ?? base.pan, mode: e.mode ?? base.mode, levels: [], pitches: [] };
      if (!cur.voice) cur.lv0 = cur.vel;
    } else if (e.kind === "off") close(e.t);
    else if (!cur) continue;
    else if (e.kind === "pitch" && e.pitch != null) cur.pitches.push([e.t, e.pitch]);
    else if (e.kind === "vel" || e.kind === "tl") cur.levels.push([e.t, e.vel ?? e.tl]);
    else if (e.kind === "mode") cur.mode = e.mode;
  }
  if (cur) { cur.end = Infinity; out.push(cur); }
  const notes = out.filter((n) => n.end > n.t && n.pitch != null && n.pitch > 0 && n.pitch < 128);
  return followPitch ? notes.flatMap((n) => pitchShape(n, endT)) : notes;
}

/**
 * A chip's tuning: how far off the equal-tempered grid its notes start, on
 * the whole (an arcade board's clock, a table a quarter-tone off A440) — per
 * part of the chip. In semitones, 0 when within 15 cents. Each part is taken
 * back onto the grid.
 */
function tuningOf(parsed) {
  const by = new Map();
  for (const [key, events] of parsed.events) {
    const chip = group(key);
    if (!by.has(chip)) by.set(chip, [0, 0]);
    const acc = by.get(chip);
    for (const e of events) if (e.kind === "on" && e.pitch != null && e.kindOf !== "noise") {
      const a = 2 * Math.PI * (e.pitch - Math.round(e.pitch));
      acc[0] += Math.cos(a); acc[1] += Math.sin(a);
    }
  }
  const tune = new Map();
  for (const [chip, [x, y]] of by) {
    const off = Math.atan2(y, x) / (2 * Math.PI);
    tune.set(chip, Math.abs(off) > 0.15 ? off : 0);
  }
  return (key) => tune.get(group(key)) ?? 0;
}
// A chip's part: its FM, its SSG, its squares (each tuned its own way).
const group = (key) => key.replace(/(\d+|[A-C])$/, "");

// ── Pitch ─────────────────────────────────────────────────────────────────
// What a driver does to a note's pitch while it sounds, read back frame by
// frame (cents from the struck pitch). Structure over exactness (user,
// 2026-10-07): a jump the pitch then stays at (four frames or more) is a new
// note, slurred; a wobble around a level is a vibrato — a sine, its depth to
// 20 cents, its period and wait to the frame pair, so notes share one def;
// anything else is a few straight lines. A note is the semitone it spends
// the most frames at. A pitch moved in a note's last two frames
// (a driver resetting it as it lets go) is not kept.

const STAY = 4; // frames at a level that make a jump a new note

function pitchShape(n, endT) {
  const end = n.end === Infinity ? endT : n.end;
  const F = Math.min(600, Math.max(1, Math.round((end - n.t) / FRAME)));
  const moves = n.pitches.filter(([t]) => t < end - 2 * FRAME);
  if (!moves.length) return [n];
  // The pitch a frame, in cents from the struck one.
  const p = [];
  for (let f = 0, k = 0, v = n.pitch; f < F; f++) {
    const at = n.t + (f + 0.5) * FRAME;
    while (k < moves.length && moves[k][0] <= at) v = moves[k++][1];
    p.push(Math.round((v - n.pitch) * 100));
  }
  if (Math.max(...p) - Math.min(...p) <= 30) return [n];
  // Jumps it stays at: cut there.
  const cuts = [0];
  for (let f = 1; f + STAY <= F; f++) {
    if (Math.abs(p[f] - p[f - 1]) < 50) continue;
    let stays = true;
    for (let g = f + 1; g < f + STAY; g++) if (Math.abs(p[g] - p[f]) > 25) { stays = false; break; }
    if (stays) cuts.push(f);
  }
  cuts.push(F);
  const segs = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const f0 = cuts[i], f1 = cuts[i + 1];
    const t0 = n.t + f0 * FRAME;
    const t1 = i + 2 < cuts.length ? n.t + f1 * FRAME : n.end;
    const rel = p.slice(f0, f1);
    // The note: the semitone it spends the most frames at (a vibrato's
    // centre, where a scoop lands, where a fall starts).
    const at = new Map();
    for (const c of rel) { const m = Math.round(n.pitch + c / 100); at.set(m, (at.get(m) ?? 0) + 1); }
    const midi = [...at].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const off = Math.round((n.pitch - midi) * 100);
    // A wobble of 30 cents or less is none (and the note's own detune with it).
    const moving = Math.max(...rel) - Math.min(...rel) > 30;
    const seg = { ...n, t: t0, end: t1, pitch: midi + 0.0, slur: i > 0 || n.slur,
      bend: moving ? rel.map((c) => Math.round((c + off) / 5) * 5) : null };
    if (i > 0) {
      // Its level carries on from the note before.
      const lv = n.levels.filter(([t]) => t <= t0);
      seg.lv0 = lv.length ? lv[lv.length - 1][1] : n.lv0;
      seg.levels = n.levels.filter(([t]) => t > t0 && t < t1);
    } else seg.levels = n.levels.filter(([t]) => t < t1);
    segs.push(seg);
  }
  return segs;
}


// ── Envelopes ─────────────────────────────────────────────────────────────

const FRAME = RATE / 60;
const MAX_ENV = 256; // frames an envelope follows; a level held after it is held on
const ENV_NONE = "(macro :vel none)";

/** A note's level frame by frame (sampled mid-frame), from `start`. */
function levelFrames(n, start, endT) {
  const frames = Math.max(1, Math.min(MAX_ENV, Math.round((endT - n.t) / FRAME)));
  const out = [];
  let v = start;
  let k = 0;
  for (let f = 0; f < frames; f++) {
    const at = n.t + (f + 0.5) * FRAME;
    while (k < n.levels.length && n.levels[k][0] <= at) v = n.levels[k++][1];
    out.push(v);
  }
  return out;
}

/**
 * The notes' envelopes (`env`: :vel+ offsets a frame) → shared defs. A
 * driver's envelope is a way in, a level it holds, and a way out once the
 * note is let go: a run held four frames or more is that level (`#sus`),
 * and on the PSG what comes after it is the release (`#rel`) — the note is
 * keyed off where it starts, so notes of any length share the shape. A note
 * cut short plays the start of a longer one's, so it names that: the most
 * used shape it is the start of. Sets `envName` (and `relFrame`, where the
 * note is let go) on the notes that move; returns the defs.
 */
function assignEnvelopes(notes) {
  const moving = notes.filter((n) => n.env?.some((v) => v !== 0));
  for (const n of moving) n.shape = shapeOf(n.env, n.canRelease);
  const fits = (n, c) => {
    if (n.shape.rel) return !!c.rel && same(n.shape.head, c.head) && n.shape.sus === c.sus && same(n.shape.rel, c.rel);
    return n.env.every((v, f) => v === (f < c.head.length ? c.head[f] : c.sus));
  };
  const shapes = [];
  // Whole shapes first, longest first: a shorter note may be the start of one.
  const order = [...moving].sort((x, y) => (y.shape.rel ? 1 : 0) - (x.shape.rel ? 1 : 0) || y.env.length - x.env.length);
  for (const n of order) {
    let c = shapes.find((sh) => fits(n, sh));
    if (!c) shapes.push((c = { ...n.shape, uses: 0 }));
    c.uses++;
  }
  shapes.sort((x, y) => y.uses - x.uses || x.head.length - y.head.length);
  const named = new Map();
  for (const n of moving) {
    const c = shapes.find((sh) => fits(n, sh));
    if (!named.has(c)) named.set(c, `env-${String(named.size + 1).padStart(2, "0")}`);
    n.envName = named.get(c);
    if (n.shape.rel) n.relFrame = n.shape.relAt;
  }
  return [...named].map(([c, name]) => envDef(name, c));
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** An envelope's way in, the level it holds, and (`release`) its way out. */
function shapeOf(env, release) {
  let best = null;
  for (let i = 0; i < env.length; ) {
    let j = i + 1;
    while (j < env.length && env[j] === env[i]) j++;
    if (j - i >= 4 && (!best || j - i > best.e - best.s)) best = { s: i, e: j };
    i = j;
  }
  if (best && release && best.e < env.length)
    return { head: env.slice(0, best.s), sus: env[best.s], rel: env.slice(best.e), relAt: best.e };
  // Held to the end: the run it ends on is the level.
  let L = env.length;
  while (L > 1 && env[L - 2] === env[L - 1]) L--;
  return { head: env.slice(0, L - 1), sus: env[L - 1], rel: null };
}

/**
 * `(def env-01 (macro :vel+ [0 -1 -2 #sus -3 #rel -5 -7]))`, on a coarser
 * `:step` when every change is.
 */
function envDef(name, { head, sus, rel }) {
  const runs = (a) => {
    const out = [];
    for (const v of a) {
      if (out.length && out[out.length - 1][0] === v) out[out.length - 1][1]++;
      else out.push([v, 1]);
    }
    return out;
  };
  const parts = [runs(head), runs(rel ?? [])];
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const step = parts.flat().reduce((g, [, k]) => gcd(g, k), 0) || 1;
  const vals = (r) => r.flatMap(([v, k]) => new Array(k / step).fill(v));
  const body = [...vals(parts[0]), "#sus", sus, ...(rel ? ["#rel", ...vals(parts[1])] : [])];
  return `(def ${name} (macro${step > 1 ? ` :step ${step}f` : ""} :vel+ [${body.join(" ")}]))`;
}

// ── What is in it ────────────────────────────────────────────────────────

export function analyzeVgm(parsed, { followPitch = true } = {}) {
  const tune = tuningOf(parsed);
  const channels = [];
  const onsets = [];
  for (const [key, events] of parsed.events) {
    const notes = notesOf(events, followPitch, parsed.totalSamples, tune(key));
    if (!notes.length) continue;
    const kind = parsed.kinds.get(key) ?? "psg";
    for (const n of notes) if (!n.slur) onsets.push(n.t);
    channels.push({ key, kind, notes: notes.length, label: `${key} · ${notes.length} notes` });
  }
  const frameRate = 60;
  const grid = estimateGrid(onsets, { frameRate });
  // The DAC: one channel of sample hits.
  if (parsed.dacHits?.length) {
    channels.push({ key: DAC_KEY, kind: "pcm", notes: parsed.dacHits.length,
      label: `${DAC_KEY} · ${parsed.dacHits.length} hits, ${new Set(parsed.dacHits.map((h) => h.offset)).size} samples` });
    for (const h of parsed.dacHits) onsets.push(h.t);
  }
  // A file without a loop point says it does not loop (a jingle).
  const fileLoop = parsed.loopSample != null && parsed.loopSample < parsed.totalSamples;
  return { channels, grid, frameRate, followPitch, fileLoop };
}

export function defaultVgmOptions(a) {
  const fm = [...FM_DESTS];
  const sqr = [...PSG_DESTS];
  let noise = "noise";
  const dest = {};
  const order = ["fm", "opm", "psg", "noise", "pcm", "opl", "opll"];
  const sorted = [...a.channels].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || y.notes - x.notes);
  for (const ch of sorted) {
    let d = "drop";
    if (ch.kind === "fm" || ch.kind === "opm") d = fm.shift() ?? "drop";
    else if (ch.kind === "psg") d = sqr.shift() ?? "drop";
    else if (ch.kind === "noise") { d = noise ?? "drop"; noise = null; }
    else if (ch.kind === "pcm") d = "pcm1";
    else d = fm.shift() ?? sqr.shift() ?? "drop";
    dest[ch.key] = d;
  }
  return { dest, bpm: null, grid: a.grid.frames ? "frames" : "beats", followPitch: a.followPitch, loop: a.fileLoop };
}

/**
 * @param options {dest: {channelKey: channel | "drop"}, bpm?: number|null,
 *                 grid: "beats" | "frames", followPitch, loop, fileName?}
 */
export function vgmToMmlisp(parsed, options, a = analyzeVgm(parsed)) {
  const warnings = [];
  const followPitch = options.followPitch ?? true;
  const tune = tuningOf(parsed);

  // The grid: the estimate, a tempo set by hand, or frames.
  let g = a.grid;
  if (options.grid === "frames") {
    const unit = RATE / a.frameRate;
    g = { unitTicks: 4, frames: true, bpm: (60 * a.frameRate) / 24, readings: [], units: (t) => Math.round(t / unit) };
  }
  if (options.bpm > 0 && Math.abs(options.bpm - g.bpm) > 1e-6) g = regrid(g, options.bpm);
  const tickOf = (t) => Math.max(0, g.units(t)) * g.unitTicks;
  if (!g.frames && a.grid.fit < 0.95)
    warnings.push(`the notes fit the ${g.bpm.toFixed(1)} BPM grid loosely (${Math.round(a.grid.fit * 100)}%) — try the frame grid if it sounds off`);
  if (g.frames) warnings.push("timed on the frame grid (1/60 s = 4 ticks) — no steady beat was found");

  const dest = options.dest ?? {};
  const taken = new Set();
  // The file's loop, or (asked for, the file marking none) the whole song.
  const fileLoop = a.fileLoop;
  const loop = !!options.loop;
  const endTick0 = tickOf(parsed.totalSamples);
  const bars = barEnds([], Math.max(1, endTick0));
  const endTick = bars[bars.length - 1];
  const loopTick = !loop ? null : fileLoop ? tickOf(parsed.loopSample) : 0;

  // Voices: a key per register set with the carriers relative to their loudest.
  const voices = new Map(); // key → {name, raw, base}
  let vn = 0;
  const voiceKey = (v) => {
    const car = CARRIERS[v.alg];
    const minTl = Math.min(...car.map((s) => v.ops[s].tl));
    const ops = v.ops.map((o, s) => (car.includes(s) ? { ...o, tl: o.tl - minTl } : o));
    return { key: JSON.stringify({ alg: v.alg, fb: v.fb, ams: v.ams, fms: v.fms, ops }), minTl, ops };
  };
  const standIns = new Set();
  const tracks = [];
  for (const ch of a.channels) {
    const d = dest[ch.key] ?? "drop";
    if (d === "drop" || ch.kind === "pcm") continue; // the DAC: below
    if (taken.has(d)) { warnings.push(`${ch.key}: ${d} is already taken — dropped`); continue; }
    taken.add(d);
    const onFm = d.startsWith("fm");
    const raw = notesOf(parsed.events.get(ch.key), followPitch, parsed.totalSamples, tune(ch.key));
    const notes = [];
    for (const n of raw) {
      const tick = tickOf(n.t);
      const end = n.end === Infinity ? endTick : Math.min(endTick, tickOf(n.end));
      if (tick >= endTick) break;
      const note = { tick, len: Math.max(1, end - tick), midi: Math.round(n.pitch), vel: n.vel, tieIn: n.slur,
        bend: n.bend };
      const endT = n.end === Infinity ? parsed.totalSamples : n.end;
      let voice = null;
      if (onFm && n.voice) {
        const vk = voiceKey(n.voice);
        // Its level: the loudest the carriers get, and the way there and
        // after as a `:vel+` envelope (0.75 dB a TL step, 2 dB a :vel step).
        const tls = levelFrames(n, n.lv0 ?? vk.minTl, endT);
        const peak = Math.min(...tls);
        note.env = tls.map((tl) => -Math.round(((tl - peak) * 0.75) / 2));
        if (!voices.has(vk.key)) voices.set(vk.key, { name: `voice-${String(++vn).padStart(2, "0")}`, ops: vk.ops, v: n.voice, base: peak });
        const rec = voices.get(vk.key);
        rec.base = Math.min(rec.base, peak);
        note.voiceRec = rec;
        note.minTl = peak;
      } else if (!n.voice && n.levels.length) {
        // A PSG note: its loudest level, and the envelope around it.
        const lv = levelFrames(n, n.lv0, endT);
        note.vel = Math.max(...lv);
        note.env = lv.map((v) => v - note.vel);
        note.t0 = n.t;
        note.canRelease = true;
      }
      if (onFm && !n.voice) {
        voice = STAND_IN[ch.kind] ?? "wave-square";
        standIns.add(voice);
      }
      note.stand = voice;
      note.pan = onFm && n.pan ? n.pan : null;
      note.mode = d === "noise" ? n.mode : null;
      // Two notes quantized onto one start: the later wins; an overlap is cut.
      const prev = notes[notes.length - 1];
      if (prev && prev.tick >= tick) notes.pop();
      else if (prev && prev.tick + prev.len > tick) prev.len = tick - prev.tick;
      notes.push(note);
    }
    if (!notes.length) continue;
    // Pan only where it is ever off centre.
    if (notes.every((n) => !n.pan || n.pan === "center")) for (const n of notes) n.pan = null;
    tracks.push({ ch, d, notes });
  }

  // A note slurred on into the next keeps its whole envelope.
  for (const tr of tracks)
    tr.notes.forEach((n, i) => { if (tr.notes[i + 1]?.tieIn) n.canRelease = false; });
  const envs = assignEnvelopes(tracks.flatMap((tr) => tr.notes));
  const bends = assignBends(tracks.flatMap((tr) => tr.notes));
  // A released note is keyed off where its release starts.
  for (const tr of tracks)
    for (const n of tr.notes) if (n.relFrame != null) n.len = Math.max(1, Math.min(n.len, tickOf(n.t0 + n.relFrame * FRAME) - n.tick));

  // Lengths and slurs first: a gap under half a unit is held through
  // (legato), and a slur only stays one when its note runs into it.
  for (const tr of tracks) {
    for (let i = 0; i < tr.notes.length; i++) {
      const n = tr.notes[i];
      const next = i + 1 < tr.notes.length ? tr.notes[i + 1].tick : endTick;
      if (next - (n.tick + n.len) > 0 && next - (n.tick + n.len) < g.unitTicks / 2) n.len = next - n.tick;
      if (n.tieIn && (i === 0 || tr.notes[i - 1].tick + tr.notes[i - 1].len !== n.tick)) n.tieIn = false;
    }
  }
  // Then levels and state, now that every voice's base is known. A slur
  // keeps the voice it slides on.
  // A track with any envelope states one for every note — `(macro :vel
  // none)` where there is none, since a macro stays until cleared.
  for (const tr of tracks) {
    let cur = { voice: null, env: null, pitch: null, pan: null, mode: null };
    const anyEnv = tr.notes.some((n) => n.envName);
    const anyBend = tr.notes.some((n) => n.bendName);
    for (const n of tr.notes) {
      if (n.voiceRec) n.vel = Math.max(0, Math.min(15, Math.round(15 - ((n.minTl - n.voiceRec.base) * 0.75) / 2)));
      const st = {
        voice: n.tieIn && cur.voice ? cur.voice : n.voiceRec ? n.voiceRec.name : n.stand,
        env: n.envName ?? (anyEnv ? ENV_NONE : null),
        pitch: n.bendName ?? (anyBend ? PITCH_NONE : null),
        pan: n.pan ? `:pan ${n.pan}` : null,
        mode: n.mode ? `:mode ${n.mode}` : null,
      };
      n.pre = [];
      for (const k of ["voice", "env", "pitch", "pan", "mode"]) if (st[k] && st[k] !== cur[k]) n.pre.push(st[k]);
      // Nothing to clear before the first envelope or bend.
      if (cur.env == null && st.env === ENV_NONE) n.pre = n.pre.filter((t) => t !== ENV_NONE);
      if (cur.pitch == null && st.pitch === PITCH_NONE) n.pre = n.pre.filter((t) => t !== PITCH_NONE);
      n.state = [st.voice, st.env, st.pitch, st.pan, st.mode].filter(Boolean);
      cur = st;
    }
  }

  // The DAC, to a PCM track: the data bank one wav, each sample a def that
  // slices it — so with DAC on, FM6 is not there to play.
  const dacDest = dest[DAC_KEY] ?? "drop";
  const dacOut = dacDest !== "drop" && parsed.dacHits?.length ? dacTrack(parsed, dacDest, tickOf, endTick, options.fileName) : null;
  if (dacOut) {
    const fm6 = tracks.findIndex((tr) => tr.d === "fm6");
    if (fm6 >= 0) { warnings.push(`${tracks[fm6].ch.key}: fm6 is the DAC in a score with PCM — dropped`); tracks.splice(fm6, 1); }
  }

  const order = [...FM_DESTS, ...PSG_DESTS, "noise"];
  tracks.sort((x, y) => order.indexOf(x.d) - order.indexOf(y.d));
  const out = tracks.map(({ d, notes }) => {
    const head = notes[0].pre;
    notes[0] = { ...notes[0], pre: undefined };
    return { channel: d, head, notes, marks: [] };
  });
  if (dacOut) out.push(dacOut.track);
  // Within a tenth of a whole tempo, the tempo is written whole (the grid
  // keeps the measured one).
  const bpm = Math.abs(g.bpm - Math.round(g.bpm)) < 0.1 ? Math.round(g.bpm) : +g.bpm.toFixed(2);
  if (out.length) out[0].marks.push({ tick: 0, tokens: [`:tempo ${bpm}`] });
  else warnings.push("no notes to import");

  if (parsed.dac && !parsed.dacHits?.length) warnings.push("YM2612 DAC written directly (not from a data bank) is not imported");
  warnings.push(...parsed.clockNotes);
  for (const [k, n] of parsed.skipped) warnings.push(`${k} skipped (${n}×)`);

  const header = [`; Imported from ${options.fileName ?? "a VGM file"} (VGM: ${parsed.chips.join(", ")})`];
  const title = [parsed.title, parsed.game && parsed.title ? `(${parsed.game})` : parsed.game].filter(Boolean).join(" ");
  if (title) header.push(`(def title ${qstr(title)})`);
  if (parsed.author) header.push(`(def author ${qstr(parsed.author)})`);
  if (standIns.size) header.push('(import "presets/waveforms/set.mmlisp")');
  if (envs.length) header.push("", ...envs);
  if (bends.length) header.push("", ...bends);
  if (dacOut) header.push("", "(def pcm-voices 1)", ...dacOut.defs);
  for (const rec of voices.values()) {
    const car = CARRIERS[rec.v.alg];
    const ops = rec.ops.map((o, s) => (car.includes(s) ? { ...o, tl: Math.min(127, o.tl + rec.base) } : o));
    header.push("", fmVoiceDef(rec.name, { alg: rec.v.alg, fb: rec.v.fb, ams: rec.v.ams, fms: rec.v.fms, ops }));
  }
  const song = { header, bars, endTick, loopTick, tracks: out };
  const pcm = dacOut?.pcm ?? null;
  if (options.structure === false) return { source: emitSong(song), warnings, pcm };
  return { source: emitStructured({ ...song, bars: bestBars(song) }), warnings, pcm };
}

// ── The DAC ───────────────────────────────────────────────────────────────

const DAC_KEY = "YM2612 DAC";

/**
 * The DAC's hits → a PCM track. The data bank (8-bit unsigned) becomes one
 * wav; each place a hit starts from is a sample — `(def-pcm dac-NN :offset
 * … :frames …)`, running to where the next one starts or as far as it is
 * played (trailing silence cut), at the rate most of its hits go: its
 * `:rate`, the C4 the notes play from. A hit at another rate is that many
 * semitones off it (under half of one is none).
 */
function dacTrack(parsed, channel, tickOf, endTick, fileName) {
  const { dacBank: bank, dacHits: hits } = parsed;
  const starts = [...new Set(hits.map((h) => h.offset))].sort((a, b) => a - b);
  const base = String(fileName || "vgm").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const wavFile = `${base}-dac.wav`;
  const samples = new Map();
  starts.forEach((offset, i) => {
    const mine = hits.filter((h) => h.offset === offset);
    const limit = (starts[i + 1] ?? bank.length) - offset;
    let frames = Math.min(limit, Math.max(...mine.map((h) => h.bytes)));
    while (frames > 1 && Math.abs(bank[offset + frames - 1] - 128) <= 2) frames--;
    // The rate most of its hits go, to a percent.
    const count = new Map();
    for (const h of mine) { const r = Math.round(h.rate / 50) * 50; count.set(r, (count.get(r) ?? 0) + 1); }
    const rate = [...count].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    samples.set(offset, { name: `dac-${String(i + 1).padStart(2, "0")}`, offset, frames, rate });
  });
  const notes = [];
  for (const h of hits) {
    const sm = samples.get(h.offset);
    const tick = tickOf(h.t);
    if (tick >= endTick) break;
    const end = Math.min(endTick, tickOf(h.t + (Math.min(h.bytes, sm.frames) / h.rate) * RATE));
    const semis = Math.round(12 * Math.log2(h.rate / sm.rate));
    const note = { tick, len: Math.max(1, end - tick), midi: 60 + semis, vel: 15, state: [sm.name] };
    // One DAC: a hit cuts the one before; two on one step, the later wins.
    const prev = notes[notes.length - 1];
    if (prev && prev.tick >= tick) notes.pop();
    else if (prev && prev.tick + prev.len > tick) prev.len = tick - prev.tick;
    notes.push(note);
  }
  // A shot plays out whatever its length: a hit lasts to the next one (the
  // last, its sample), so the track reads in steps, not in sample lengths.
  notes.forEach((n, i) => { if (i + 1 < notes.length) n.len = notes[i + 1].tick - n.tick; });
  let cur = null;
  for (const n of notes) { if (n.state[0] !== cur) n.pre = [n.state[0]]; cur = n.state[0]; }
  const head = notes[0]?.pre ?? [];
  if (notes[0]) notes[0] = { ...notes[0], pre: undefined };
  const mono = Float32Array.from(bank, (v) => (v - 128) / 128);
  const wavRate = [...samples.values()][0]?.rate ?? 8000;
  const defs = [...samples.values()].map((sm) =>
    `(def-pcm ${sm.name} :file ${qstr(wavFile)} :rate ${sm.rate} :offset ${sm.offset} :frames ${sm.frames})`);
  return {
    track: { channel, head, notes, marks: [] },
    defs,
    pcm: { wavFile, rate: wavRate, mono, wav: encodeWav(mono, null, wavRate), entries: [...samples.values()], tag: "VGM" },
  };
}
