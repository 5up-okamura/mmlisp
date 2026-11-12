// A VGM's (and an NSF's) chip writes read per chip: each chip's registers
// as notes, levels and sweeps on its channels — the OPN family, the OPM,
// the SN76489, the AY, the OPLL, the OPL, the PC Engine, the Game Boy, the
// SCC, the YM2608's rhythm and the PCM chips — on the clock they share.

import { RATE } from "./import-song.js";
import { VEL_DB_PER_STEP } from "../ir/levels.js";
import { noiseHz as gbNoiseHz, noiseNoteOfHz as gbNoiseNote } from "../machine/chips/lr35902.js";
import { DUTIES } from "../machine/chips/rp2a03.js";
import { envCycle } from "../machine/chips/ssg.js";
import { VRC7_ROM, OPLL_ROM } from "../machine/chips/ym2413.js";
import { Apu as GbApu } from "../synth/synth-gb.js";

export const CARRIERS = [[3], [3], [3], [3], [2, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]]; // by ALG, in slot order

export const pitchOf = (hz) => (hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null);
export const TONE_MAX_HZ = 20000; // a tone above it is heard as none
// A driver's writes for one note land within this of each other (samples).
export const SETUP_T = 0.002 * RATE;
// A chip PCM hit keyed on silent takes the level a driver's next tick gives it, this soon (samples).
const LATE_T = 0.02 * RATE;
// A duty moved this soon after a note's start is its attack (samples).
export const DUTY_ATTACK_T = (4 * RATE) / 60;

// ── Chips ─────────────────────────────────────────────────────────────────
// Each chip model keeps its registers and calls `ev(channelKey, event)`:
//   {t, kind: "on", pitch, vel?, voice?, pan?, mode?} | {t, kind: "off"}
//   | {t, kind: "pitch", pitch} | {t, kind: "vel", vel} (a PSG's level)
//   | {t, kind: "tl", tl} (an FM channel's loudest carrier TL, while keyed)

// A YM2203's prescaler, as $2D-$2F set it (MAME fm.c): its FM divisor and the
// SSG's clock divider, by the select bits. It starts at 2, the 72 of a score.
const OPN_PRES = [24, 24, 72, 36], SSG_PRES = [0.5, 0.5, 2, 1];

export function opnChip(name, clock, divisor, { ssgDiv, channels = 6, ev, prescaled = false }) {
  let select = 2;
  let fm6On = null; // FM6's last key-on event (the DAC taking it, write)
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
      // The DAC turned on takes fm6 (language.md §16): a note sounding there
      // ends, as the score's next PCM note will take it from fm6's — and one
      // keyed less than a frame before is no note (a driver's key-on as it
      // hands fm6 to the DAC).
      if (port === 0 && a === 0x2b) {
        dac = !!(d & 0x80);
        if (dac && channels > 5 && keyed[5]) {
          if (fm6On && t - fm6On.t < RATE / 60) fm6On.kind = "unheard";
          else ev(key(5), { t, kind: "off" });
          keyed[5] = false;
        }
        return;
      }
      if (prescaled && a >= 0x2d && a <= 0x2f) {
        select = a === 0x2f ? 0 : select | (a === 0x2d ? 2 : 1);
        divisor = OPN_PRES[select];
        ssg?.setClock(clock / SSG_PRES[select]);
        return;
      }
      if (port === 0 && a === 0x28) {
        const lo = d & 7;
        const c = lo >= 4 ? lo - 1 : lo;
        if (lo === 3 || lo === 7 || c >= channels) return;
        const on = (d & 0xf0) !== 0;
        if (c === 5 && dac) return;
        if (on && !keyed[c]) {
          const v = voice(c);
          const e = { t, kind: "on", pitch: pitchOf(hz(c)), voice: v, pan: v.pan, kindOf: "fm" };
          ev(key(c), e);
          if (c === 5) fm6On = e;
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

export function opmChip(clock, { ev }) {
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
        sr: r[0xc0 + o] & 31, dt2: r[0xc0 + o] >> 6, sl: r[0xe0 + o] >> 4, rr: r[0xe0 + o] & 15, ssg: 0,
      });
    }
    const rl = r[0x20 + c] >> 6;
    return {
      alg: r[0x20 + c] & 7, fb: (r[0x20 + c] >> 3) & 7, ams: r[0x38 + c] & 3, fms: (r[0x38 + c] >> 4) & 7,
      ops, pan: rl === 1 ? "left" : rl === 2 ? "right" : "center",
    };
  };
  const key = (c) => `YM2151 FM${c + 1}`;
  // Channel 8 with the noise on (NE, $0F bit 7) and its fourth operator keyed
  // is the chip's noise, read two ways. As a noise note: its frequency from
  // NFRQ (clock / 32 / (32 − NFRQ) Hz), its level that operator's TL — taken
  // linearly, as the noise is — ending at the operator's key-off or where
  // the noise is turned off; a target whose noise is a channel of its own
  // (md's) plays that. And as FM8's note, the voice whole, flagged with the
  // noise's frequency: a target whose fm8 turns the noise on (x68k's :mode
  // noise) plays that, as the chip did.
  const NOISE = "YM2151 noise";
  let noiseOn = false;
  const noiseHz = () => clock / 32 / (32 - (r[0x0f] & 31));
  const noiseVel = () => {
    const g = Math.max(1e-3, (1023 - 8 * (r[0x60 + 24 + 7] & 127)) / 1023);
    return Math.max(0, Math.min(15, Math.round(15 + (20 * Math.log10(g)) / 2)));
  };
  return {
    name: "YM2151",
    write(a, d, t) {
      if (a === 0x0f && noiseOn && !(d & 0x80)) { ev(NOISE, { t, kind: "off" }); noiseOn = false; }
      if (a === 0x08 && (d & 7) === 7 && ((r[0x0f] & 0x80) || noiseOn)) {
        const on = (d & 0x40) !== 0 && (r[0x0f] & 0x80) !== 0; // C2, the fourth operator
        if (on && !noiseOn) ev(NOISE, { t, kind: "on", pitch: 60, vel: noiseVel(), noiseHz: noiseHz(), kindOf: "noise" });
        else if (!on && noiseOn) ev(NOISE, { t, kind: "off" });
        noiseOn = on;
      }
      if (a === 0x7f && noiseOn) ev(NOISE, { t, kind: "vel", vel: (r[a] = d, noiseVel()) });
      if (a === 0x08) {
        const c = d & 7;
        const on = (d & 0x78) !== 0;
        if (on && !keyed[c]) {
          const v = voice(c);
          const noise = c === 7 && (r[0x0f] & 0x80) ? noiseHz() : null;
          ev(key(c), { t, kind: "on", pitch: pitch(c), voice: v, pan: v.pan, kindOf: "opm", ...(noise ? { noiseHz: noise } : {}) });
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

export function snChip(clock, { ev }) {
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
// A channel sounds while its level is up and its mixer passes tone, noise,
// or — on the hardware envelope (the level's M bit) — neither, where what is
// heard is the envelope itself at its rate (a buzzer, pitched by R11-R12).
// A note carries the mixer and the envelope it starts with (`ssg`); a write
// to R13 starts the envelope over, which on a channel on it is a new note.
// Every note is its channel's; one on the noise alone is the shared noise
// row's too (`SSG noise`), for a target whose noise is a channel of its own
// (vgmChannels picks one of the two).
export function ayChip(name, clock, { ev, prefix = name }) {
  const r = new Uint8Array(16);
  const on = [false, false, false];
  const ssgAt = ["", "", ""]; // the mixer / shape a sounding note started with
  const ampAt = [-1, -1, -1];
  const tpAt = [-1, -1, -1];
  const key = (c) => `${prefix} SSG${String.fromCharCode(65 + c)}`;
  const noiseKey = `${prefix} SSG noise`;
  const hz = (c) => {
    const tp = r[2 * c] | ((r[2 * c + 1] & 15) << 8);
    return tp > 0 ? clock / (16 * tp) : 0;
  };
  const onEnv = (c) => !!(r[8 + c] & 16);
  const amp = (c) => (onEnv(c) ? 15 : r[8 + c] & 15);
  const setClock = (c) => { clock = c; };
  // A level as a note's :vel: the SSG's steps are 3 dB, :vel's 2 dB (in
  // eighths), so a decay keeps its depth; the quietest levels, under :vel's
  // 30 dB, sit at its floor.
  const velAt = (c) => { const l = amp(c); return l <= 0 ? 0 : Math.max(1 / 8, Math.round((15 - ((15 - l) * 3) / VEL_DB_PER_STEP) * 8) / 8); };
  // A tone above hearing (a period of 0 to 5) is none: a driver sets one
  // to hear the envelope alone (Metal Gear 2's kick, a click).
  const tone = (c) => !(r[7] & (1 << c)) && hz(c) > 0 && hz(c) <= TONE_MAX_HZ;
  const noise = (c) => !(r[7] & (8 << c));
  const ep = () => r[11] | (r[12] << 8);
  // A cycle of the envelope's shape (a triangle's is two ramps), as
  // chips/ssg.js reads :env-rate.
  const shape = () => r[13] & 15;
  const envHz = () => (ep() > 0 ? clock / (envCycle(shape()) * ep()) : 0);
  const noiseHz = () => clock / (16 * Math.max(1, r[6] & 31));
  const mixOf = (c) => (tone(c) && noise(c) ? "both" : tone(c) ? "tone" : noise(c) ? "noise" : "env");
  const ssgOf = (c) => ({ mix: mixOf(c), env: onEnv(c) ? shape() : null, envHz: onEnv(c) ? envHz() : null });
  // What makes a note another: its mixer and shape (a rate is its start's).
  const sig = (c) => `${mixOf(c)}/${onEnv(c) ? shape() : ""}`;
  // A note's pitch: the tone's, a buzzer's the envelope's; one on the noise
  // alone has none to read (its tone period may be anything), so c4.
  const pitchNow = (c) => (mixOf(c) === "noise" ? 60 : pitchOf(mixOf(c) === "env" ? envHz() : hz(c)));
  // To the channel, and — a note on the noise alone — to the noise row.
  const wasNoise = [false, false, false]; // the channel's note is the noise row's too
  // A driver sets a note up in a burst — the level, the mixer, then the
  // envelope's shape and period: writes within SETUP of a note's start are
  // its own (its event amended), not a new note. `fresh`: the envelope
  // started over with it (an R13 write), as an MMLisp key-on starts it.
  const SETUP = SETUP_T;
  const last = [null, null, null]; // each channel's last note event
  const lastNoise = [null, null, null]; // and its noise row's
  let r13At = -Infinity, r6At = -Infinity;
  // A note on the noise alone struck again: its level and a new noise period
  // written together (in either order) — the rate is the note's, as the
  // 2A03's. (A period moved alone is another channel's sweep, or one under
  // the note: not followed.) In the note's setup burst, the note's own.
  const noiseStrike = (c, t) => {
    if (last[c] && t - last[c].t <= SETUP) {
      last[c].noiseHz = noiseHz();
      if (lastNoise[c]) lastNoise[c].noiseHz = noiseHz();
    } else start(c, t, "retrig");
  };
  const amend = (c, t, fresh) => {
    const e = last[c];
    if (!e || t - e.t > SETUP) return false;
    e.ssg = ssgOf(c);
    // (Its pitch as the mixer now has it: a note keyed on the envelope
    // alone and given its tone a moment later is the tone's — Metal Gear 2's
    // kick — not the envelope's rate.)
    e.pitch = pitchNow(c);
    if (fresh) e.fresh = true;
    ssgAt[c] = sig(c);
    return true;
  };
  const send = (c, e) => {
    ev(key(c), e);
    if (wasNoise[c]) ev(noiseKey, e);
  };
  const start = (c, t, kind) => {
    const g = ssgOf(c);
    // From the noise to another mixer: the noise row's note ends.
    if (wasNoise[c] && g.mix !== "noise") ev(noiseKey, { t, kind: "off" });
    ssgAt[c] = sig(c);
    const noisy = g.mix === "noise" || g.mix === "both";
    ev(key(c), (last[c] = { t, kind, pitch: pitchNow(c), vel: velAt(c), ssg: g, ...(noisy ? { noiseHz: noiseHz() } : {}),
      ...(g.env != null && t - r13At <= SETUP ? { fresh: true } : {}), kindOf: "psg" }));
    if (g.mix === "noise")
      ev(noiseKey, (lastNoise[c] = { t, kind: wasNoise[c] ? kind : "on", pitch: 60, vel: velAt(c), noiseHz: noiseHz(), ssg: g, kindOf: "noise" }));
    wasNoise[c] = g.mix === "noise";
  };
  const update = (c, t) => {
    const audible = amp(c) > 0 && (tone(c) || noise(c) || onEnv(c));
    if (audible && !on[c]) start(c, t, "on");
    else if (!audible && on[c]) { send(c, { t, kind: "off" }); wasNoise[c] = false; }
    // The mixer or shape changed under it: a new note, but in its setup
    // burst (and not to or from the noise row) the note's own.
    else if (audible && sig(c) !== ssgAt[c]) {
      if (mixOf(c) === "noise" || wasNoise[c] || !amend(c, t, false)) start(c, t, "retrig");
    }
    on[c] = audible;
  };
  return {
    name,
    setClock,
    write(a, d, t) {
      if (a > 15) return;
      const prev = a >= 8 && a <= 10 ? amp(a - 8) : 0;
      const was6 = r[6] & 31;
      r[a] = d;
      if (a === 6 && (d & 31) !== was6) {
        // (Written unchanged, as a driver writing every register each frame
        // does, it is nothing.)
        r6At = t;
        for (let c = 0; c < 3; c++) if (on[c] && mixOf(c) === "noise" && t - ampAt[c] <= SETUP) noiseStrike(c, t);
      } else if (a < 6) {
        const c = a >> 1;
        tpAt[c] = t;
        if (on[c] && (mixOf(c) === "tone" || mixOf(c) === "both"))
          ev(key(c), ampAt[c] === t ? { t, kind: "retrig", pitch: pitchNow(c), vel: velAt(c), ssg: ssgOf(c) } : { t, kind: "pitch", pitch: pitchNow(c) });
      } else if (a === 7) {
        for (let c = 0; c < 3; c++) update(c, t);
      } else if (a >= 8 && a <= 10) {
        const c = a - 8;
        ampAt[c] = t;
        if (on[c] && amp(c) > 0 && sig(c) !== ssgAt[c]) update(c, t);
        else if (on[c] && amp(c) > 0 && mixOf(c) === "noise" && t - r6At <= SETUP) noiseStrike(c, t);
        else if (on[c] && mixOf(c) !== "noise" && tpAt[c] === t && amp(c) > 0) start(c, t, "retrig");
        else if (on[c] && amp(c) > prev + 2) send(c, { t, kind: "retrig", vel: velAt(c) });
        else if (on[c] && amp(c) > 0) send(c, { t, kind: "vel", vel: velAt(c) });
        update(c, t);
      } else if (a === 11 || a === 12) {
        // The period: a buzzer's pitch; a rate a tone note keeps from its start.
        for (let c = 0; c < 3; c++) {
          if (!on[c] || !onEnv(c) || amend(c, t, false)) continue;
          if (mixOf(c) === "env") ev(key(c), { t, kind: "pitch", pitch: pitchNow(c) });
        }
      } else if (a === 13) {
        // A write starts the envelope over: each channel on it strikes again.
        r13At = t;
        for (let c = 0; c < 3; c++) {
          if (!on[c] || !onEnv(c) || amend(c, t, true)) continue;
          start(c, t, "retrig"); // fresh: r13At is now
        }
      }
    },
  };
}

// A channel's voice at its key-on (`opll`): its number ($3x's top four
// bits) and its registers — the ROM's (the YM2413's, or the VRC7's) or the
// user voice as it stands.
// The rhythm mode ($0E bit 5) gives channels 7-9 to the five ROM sounds:
// a sound's key bit rising is a hit — {t, k, db, pan, semi}, `k` the
// YM2608's sound of its kit role (BD SD TOP HH TOM), `db` its 4-bit volume's
// 3 dB steps, `semi` its channel's F-number against the datasheet's tuning
// (chips/ym2413.js), the pitch the FM-PAC's rhythm tracks play it at, and
// `moves` the channel's tunings after it, [t, semitones], till the next hit
// on that channel (a drum's bend), and `off` where its key bit falls.
const OPLL_RHYTHM = [ // [$0E bit, k, channel, volume register, shift]
  [0x10, 0, 6, 0x36, 0], [0x08, 1, 7, 0x37, 0], [0x02, 2, 8, 0x38, 0], [0x01, 3, 7, 0x37, 4], [0x04, 4, 8, 0x38, 4],
];
const OPLL_RHYTHM_C4 = { 6: 0x120 * 4, 7: 0x150 * 4, 8: 0x1c0 }; // F-number · 2^block
export function opllChip(clock, { ev, vrc7 = false, hits = [] }) {
  const name = vrc7 ? "VRC7" : "YM2413";
  const r = new Uint8Array(64);
  const voiceOf = (c) => {
    const inst = r[0x30 + c] >> 4;
    return { inst, vrc7, bytes: inst ? (vrc7 ? VRC7_ROM : OPLL_ROM)[inst - 1] : [...r.subarray(0, 8)] };
  };
  const keyed = new Array(9).fill(false);
  const hz = (c) => {
    const fnum = r[0x10 + c] | ((r[0x20 + c] & 1) << 8);
    const block = (r[0x20 + c] >> 1) & 7;
    return (fnum * clock) / 72 / 2 ** (19 - block);
  };
  const key = (c) => `${name} FM${c + 1}`;
  const rhythmOn = () => !vrc7 && !!(r[0x0e] & 0x20);
  const semiOf = (ch) => 12 * Math.log2(Math.max(1, (r[0x10 + ch] | ((r[0x20 + ch] & 1) << 8)) * 2 ** ((r[0x20 + ch] >> 1) & 7)) / OPLL_RHYTHM_C4[ch]);
  const ringing = {}; // channel → its latest hit (the pairs share one)
  const held = {}; // key bit → its hit, while the bit is set
  return {
    name,
    write(a, d, t) {
      if (a > 0x3f) return;
      const was = r[a];
      r[a] = d;
      if (a === 0x0e) {
        for (const [bit, , ch] of OPLL_RHYTHM) {
          const h = held[bit];
          if (h && (!rhythmOn() || !(d & bit))) { h.off = t; delete held[bit]; }
          // The mode turned off as it was hit — a driver taking channels 7-9
          // back as tones (Tetris's intro) — sounds nothing: no hit.
          if (h && !rhythmOn() && t - h.t < FRAME / 2) {
            hits.splice(hits.indexOf(h), 1);
            if (ringing[ch] === h) delete ringing[ch];
          }
        }
        if (!rhythmOn()) return;
        // Channels 7-9 keyed as tones stop where the drums take them.
        for (let c = 6; c < 9; c++) if (keyed[c]) { ev(key(c), { t, kind: "off" }); keyed[c] = false; }
        const rising = d & ~(was & 0x20 ? was : 0) & 31;
        for (const [bit, k, ch, vr, shift] of OPLL_RHYTHM) {
          if (!(rising & bit)) continue;
          const h = { t, k, db: 3 * ((r[vr] >> shift) & 15), pan: "center", semi: Math.round(semiOf(ch)), moves: [[t, semiOf(ch)]] };
          // (The tuning written for this hit, just before it, is not the
          // last one's bend.)
          const last = ringing[ch];
          if (last) last.moves = last.moves.filter(([mt], i) => !i || mt < t - FRAME / 2);
          hits.push(h);
          ringing[ch] = h;
          if (held[bit]) held[bit].off = t;
          held[bit] = h;
        }
        return;
      }
      const c = a & 15;
      if (c > 5 && rhythmOn()) {
        const h = ringing[c];
        if (c < 9 && (a >> 4 === 1 || a >> 4 === 2) && h && semiOf(c) !== h.moves[h.moves.length - 1][1]) h.moves.push([t, semiOf(c)]);
        return;
      }
      if (c > 8) return;
      if ((a & 0xf0) === 0x20) {
        const on = !!(d & 0x10);
        if (on && !keyed[c]) ev(key(c), { t, kind: "on", pitch: pitchOf(hz(c)), vel: Math.max(0, 15 - Math.round((r[0x30 + c] & 15) * 1.5)), kindOf: "opll", opll: voiceOf(c) });
        else if (!on && keyed[c]) ev(key(c), { t, kind: "off" });
        else if (on) ev(key(c), { t, kind: "pitch", pitch: pitchOf(hz(c)) });
        keyed[c] = on;
      } else if ((a & 0xf0) === 0x10 && keyed[c]) ev(key(c), { t, kind: "pitch", pitch: pitchOf(hz(c)) });
    },
  };
}

export function oplChip(name, clock, divisor, { ev }) {
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

// ── Wavetable chips ───────────────────────────────────────────────────────

// A level as :vel: a 5-bit volume at 1.5 dB a step (the HuC6280's), or a
// 4-bit linear one (the SCC's), against 2 dB a :vel step.
export const velOfDb = (db) => Math.max(0, Math.min(15, Math.round((15 + db / VEL_DB_PER_STEP) * 8) / 8));
export const waveOf = (steps, top) => steps.map((v) => Math.max(-128, Math.min(127, Math.round((v * 255) / top) - 128)));

// The HuC6280 (chips/huc6280.js): $00 selects a channel, whose $02/$03 is
// its frequency (the clock / 32 / f), $04 its on bit, DDA bit and 5-bit
// volume, $05 its left / right levels, $06 its wave (a step a write, from
// step 0 after the DDA bit drops), $07 — on channels 5 and 6 — its noise.
// A note is the channel on at a volume; on the noise, its row's (the rate
// as the note: c2 the slowest). The LFO — $08 its divider, $09 its mode,
// channel 2 swaying channel 1 — is channel 1's notes' `lfo`, as the FDS's
// modulation is: its mode the depth (wave1's :fms), its speed the song's
// :lfo-freq, 256 less the divider. Its reset (bit 7) is not followed.
export function pceChip(clock, { ev, skip }) {
  let sel = 0;
  let lfoDiv = 0, lfoMode = 0;
  const lfo = () => (lfoMode ? { freq: (256 - lfoDiv) & 255, depth: lfoMode } : null);
  const N = 6;
  const freq = new Uint16Array(N), ctrl = new Uint8Array(N), bal = new Uint8Array(N).fill(0xff);
  const ram = Array.from({ length: N }, () => new Uint8Array(32)), index = new Uint8Array(N), noise = new Uint8Array(N);
  const sounding = new Array(N).fill(null); // the row a channel's note is on
  const key = (c) => `HuC6280 CH${c + 1}`;
  const vol = (c) => (ctrl[c] & 0x80 && !(ctrl[c] & 0x40) ? ctrl[c] & 31 : 0);
  const vel = (c) => velOfDb(-(31 - vol(c)) * 1.5);
  const hz = (c) => clock / (32 * (freq[c] || 0x1000));
  const onNoise = (c) => c >= 4 && !!(noise[c] & 0x80);
  // The levels as a place between the sides: the louder full, the other as far down.
  const pan = (c) => { const p = ((bal[c] & 15) - (bal[c] >> 4)) / 15; return p ? String(+p.toFixed(2)) : "center"; };
  const strike = (c, t) => {
    const nz = onNoise(c);
    const row = nz ? `${key(c)} noise` : key(c);
    sounding[c] = row;
    const rate = noise[c] & 31;
    ev(row, nz
      ? { t, kind: "on", pitch: 36 + rate, vel: vel(c), pan: pan(c), noiseHz: clock / (64 * Math.max(0.5, 31 - rate)), kindOf: "noise" }
      : { t, kind: "on", pitch: pitchOf(hz(c)), vel: vel(c), pan: pan(c), wave: waveOf([...ram[c]], 31), kindOf: "wave", ...(c === 0 ? { lfo: lfo() } : {}) });
  };
  const release = (c, t) => { if (sounding[c]) ev(sounding[c], { t, kind: "off" }); sounding[c] = null; };
  return {
    name: "HuC6280",
    write(a, d, t) {
      if (a === 0x00) { sel = d & 7; return; }
      const c = sel;
      if (c >= N) return;
      if (a === 0x02 || a === 0x03) {
        freq[c] = a === 0x02 ? (freq[c] & 0xf00) | d : (freq[c] & 0xff) | ((d & 15) << 8);
        if (sounding[c] && !onNoise(c)) ev(sounding[c], { t, kind: "pitch", pitch: pitchOf(hz(c)) });
      } else if (a === 0x04) {
        if (ctrl[c] & 0x40 && !(d & 0x40)) index[c] = 0;
        if (d & 0x40 && d & 0x80) skip("HuC6280 DDA");
        const was = vol(c);
        ctrl[c] = d;
        const now = vol(c);
        if (!was && now) strike(c, t);
        else if (was && !now) release(c, t);
        else if (now !== was && sounding[c]) ev(sounding[c], { t, kind: "vel", vel: vel(c) });
      } else if (a === 0x05) {
        bal[c] = d;
        if (sounding[c]) ev(sounding[c], { t, kind: "pan", pan: pan(c) });
      }
      else if (a === 0x06) {
        if (ctrl[c] & 0x40) return; // DDA: a sample, not a wave
        ram[c][index[c]] = d & 31;
        if (!(ctrl[c] & 0x80)) index[c] = (index[c] + 1) & 31;
      } else if (a === 0x07 && c >= 4) {
        const changed = (d & 0x80) !== (noise[c] & 0x80);
        noise[c] = d;
        // A channel turned to or from its noise while it sounds: another note.
        if (changed && vol(c)) { release(c, t); strike(c, t); }
        else if (onNoise(c) && sounding[c]) ev(sounding[c], { t, kind: "retrig", pitch: 36 + (d & 31), pan: pan(c) });
      } else if (a === 0x08 || a === 0x09) {
        if (a === 0x08) lfoDiv = d;
        else { if (d & 0x80) skip("HuC6280 LFO reset"); lfoMode = d & 3; }
        // Moved under channel 1's note: that note's, from there.
        if (sounding[0] === key(0)) ev(key(0), { t, kind: "lfo", lfo: lfo() });
      }
    },
  };
}

// The Game Boy's APU (chips/lr35902.js), VGM 0xB3: the chip itself is run
// (synth-gb.js's Apu, its frame sequencer stepped between writes), so a note
// ends where its length counter or envelope did, an envelope is a level
// envelope, a sweep a pitch moving under the note, and zombie-mode writes are
// level moves. A trigger is a new note, and what sounds is whatever has a DAC, a
// level and a side. NR50 scales the level (a fade), the louder side's.
const GB_WAVE_LEVEL = [0, 15, 7.5, 3.75]; // NR32's codes on the 4-bit scale
export function gbChip(clock, { ev }) {
  const apu = new GbApu();
  const r = apu.r;
  const STEP = (RATE * 8192) / clock; // the frame sequencer's
  const KEY = ["GB SQ1", "GB SQ2", "GB WAVE", "GB noise"];
  const TRIGGER = { 0x04: 0, 0x09: 1, 0x0e: 2, 0x13: 3 };
  // The registers that speak for one channel; the others ($14-$16) for all.
  const channelOf = (a) => (a < 0x05 ? 0 : a < 0x0a ? 1 : a < 0x0f ? 2 : 3);
  const ch = KEY.map(() => ({ on: false, level: 0, pitch: null, duty: null, pan: null, rate: null }));
  let next = STEP;
  const level = (c) => {
    const v = c === 2 ? GB_WAVE_LEVEL[(r[0x0c] >> 5) & 3] : apu.env[c].volume;
    return (v * (Math.max((r[0x14] >> 4) & 7, r[0x14] & 7) + 1)) / 8;
  };
  const velOf = (v) => (v > 0 ? velOfDb(20 * Math.log10(v / 15)) : 0);
  const hz = (c) => clock / ((c === 2 ? 64 : 32) * (2048 - apu.period(c)));
  const panOf = (c) => {
    const left = r[0x15] & (0x10 << c), right = r[0x15] & (1 << c);
    return left && right ? "center" : left ? "left" : right ? "right" : null;
  };
  const sounding = (c) => apu.on[c] && apu.dac(c) && level(c) > 0 && !!panOf(c);
  const waveNow = () => waveOf(Array.from({ length: 32 }, (_, i) => (i & 1 ? r[0x20 + (i >> 1)] & 15 : r[0x20 + (i >> 1)] >> 4)), 15);
  const note = (c, t, kind) => {
    const st = ch[c];
    st.level = level(c);
    st.pan = panOf(c);
    const base = { t, kind, vel: velOf(st.level), pan: st.pan };
    if (c === 3) {
      st.rate = r[0x12];
      const noiseHz = gbNoiseHz(st.rate);
      st.pitch = gbNoiseNote(noiseHz);
      return { ...base, pitch: st.pitch, mode: st.rate & 8 ? "periodic" : "white", noiseHz, kindOf: "noise" };
    }
    st.pitch = pitchOf(hz(c));
    if (c === 2) return { ...base, pitch: st.pitch, wave: waveNow(), kindOf: "wave" };
    st.duty = DUTIES[r[c === 0 ? 0x01 : 0x06] >> 6];
    return { ...base, pitch: st.pitch, duty: st.duty, kindOf: "psg" };
  };
  // What the chip's state says changed on channel `c`.
  const sync = (c, t, strike = false) => {
    const st = ch[c], was = st.on, now = sounding(c);
    st.on = now;
    if (!was && now) ev(KEY[c], note(c, t, "on"));
    else if (was && !now) ev(KEY[c], { t, kind: "off" });
    else if (was && strike) ev(KEY[c], note(c, t, "retrig"));
    else if (was) {
      if (c === 3 && r[0x12] !== st.rate) { ev(KEY[c], note(c, t, "retrig")); return; }
      const v = level(c);
      if (v !== st.level) { st.level = v; ev(KEY[c], { t, kind: "vel", vel: velOf(v) }); }
      if (panOf(c) !== st.pan) { st.pan = panOf(c); ev(KEY[c], { t, kind: "pan", pan: st.pan }); }
      if (c === 3) return;
      const p = pitchOf(hz(c));
      if (p !== st.pitch) { st.pitch = p; ev(KEY[c], { t, kind: "pitch", pitch: p }); }
      if (c < 2) {
        const d = DUTIES[r[c === 0 ? 0x01 : 0x06] >> 6];
        if (d !== st.duty) { st.duty = d; ev(KEY[c], { t, kind: "duty", duty: d }); }
      }
    }
  };
  // A burst of writes is read as what it leaves (a zombie move runs the
  // level through every step on its way): each channel it touched, and
  // whether it triggered, are settled at the burst's first write.
  const burst = { t: 0, touched: new Map() };
  const settle = () => {
    for (const [c, strike] of burst.touched) sync(c, burst.t, strike);
    burst.touched.clear();
  };
  const touch = (c, strike) => burst.touched.set(c, strike || !!burst.touched.get(c));
  const advance = (t) => {
    for (; next <= t; next += STEP) {
      settle();
      apu.clockSequencer();
      for (let c = 0; c < 4; c++) sync(c, next);
    }
  };
  return {
    name: "GB DMG",
    write(a, d, t) {
      if (t - burst.t > SETUP_T) settle();
      advance(t);
      apu.write(a, d);
      if (a >= 0x20 || a === 0x00) return;
      if (!burst.touched.size) burst.t = t;
      if (a >= 0x14) for (let c = 0; c < 4; c++) touch(c, false);
      else touch(channelOf(a), TRIGGER[a] !== undefined && !!(d & 0x80));
    },
    end: (t) => { settle(); advance(t); },
  };
}

// The K051649, the SCC (chips/k051649.js), as VGM 0xD2 splits it: port 0
// the four wave memories (channels 4 and 5 share the fourth), 1 the periods
// (the clock / 16 / (p + 1): VGM's clock is half the one the chip counts
// at), 2 the 4-bit volumes, 3 the key bits.
export function sccChip(clock, { ev, plus = false, note = () => {} }) {
  const N = 5;
  // Channels 4 and 5 share a wave memory; the SCC+ (K052539, bit 31 of the
  // header's clock) gives each its own, and reads a fifth bank of it.
  const memory = (c) => (plus ? c : Math.min(c, 3));
  const ram = Array.from({ length: N }, () => new Int8Array(32)), period = new Uint16Array(N), volume = new Uint8Array(N);
  let keys = 0;
  const on = new Array(N).fill(false);
  const key = (c) => `K051649 CH${c + 1}`;
  const audible = (c) => !!((keys >> c) & 1) && volume[c] > 0 && period[c] >= 9;
  const vel = (c) => velOfDb(volume[c] ? 20 * Math.log10(volume[c] / 15) : -96);
  const hz = (c) => clock / (16 * (period[c] + 1));
  const wave = (c) => [...ram[memory(c)]];
  // A key let go and taken again within a driver's setup burst is no new
  // note: with no envelope to restart, the SCC plays on (Metal Gear 2's
  // driver drops every channel's key for a moment whenever one starts).
  const offEv = new Array(N).fill(null);
  let warned = false;
  const clashed = () => {
    if (!warned) note("the SCC+ gives channels 4 and 5 a wave each; msx's wave4 and wave5 share one, so one's timbre goes");
    warned = true;
  };
  const check = (c, t) => {
    const now = audible(c);
    if (now && !on[c]) {
      if (plus && c >= 3 && on[7 - c] && ram[3].some((v, i) => v !== ram[4][i])) clashed();
      if (offEv[c] && t - offEv[c].t <= SETUP_T) offEv[c].kind = "held"; // (read by nothing: the note goes on)
      else ev(key(c), { t, kind: "on", pitch: pitchOf(hz(c)), vel: vel(c), wave: wave(c), kindOf: "wave" });
      offEv[c] = null;
    } else if (!now && on[c]) ev(key(c), (offEv[c] = { t, kind: "off" }));
    on[c] = now;
  };
  return {
    name: "K051649",
    write(port, a, d, t) {
      // Port 4 is the waves again, as an SCC+'s log writes them (VGMPlay).
      if ((port === 0 || port === 4) && a < (plus ? 0xa0 : 0x80)) {
        ram[a >> 5][a & 31] = (d << 24) >> 24;
        if (plus && on[3] && on[4] && ram[3].some((v, i) => v !== ram[4][i])) clashed();
        // A wave rewritten under a sounding note: its timbre moving (a
        // driver's frame of a noisier wave for a strike on the channel) —
        // a note's still where its key is down for a moment (offEv).
        for (let c = 0; c < N; c++)
          if ((on[c] || offEv[c]) && memory(c) === a >> 5) ev(key(c), { t, kind: "wave", wave: wave(c) });
      }
      else if (port === 1 && a < 10) {
        const c = a >> 1;
        period[c] = a & 1 ? (period[c] & 0xff) | ((d & 15) << 8) : (period[c] & 0xf00) | d;
        if (on[c]) ev(key(c), { t, kind: "pitch", pitch: pitchOf(hz(c)) });
        else check(c, t);
      } else if (port === 2 && a < 5) {
        const was = volume[a];
        volume[a] = d & 15;
        // A level jumping up is a new strike (a driver's next note on a
        // channel it keeps keyed, as the SSG's); moving otherwise, the
        // note's own.
        if (on[a] && volume[a] > was + 2) ev(key(a), { t, kind: "retrig", pitch: pitchOf(hz(a)), vel: vel(a), wave: wave(a) });
        else if (on[a] && volume[a] && volume[a] !== was) ev(key(a), { t, kind: "vel", vel: vel(a) });
        check(a, t);
      } else if (port === 3) {
        keys = d & 31;
        for (let c = 0; c < N; c++) check(c, t);
      }
    },
  };
}

// The YM2608's rhythm: $10 keys the six ROM sounds (bits 0-5: BD SD TOP
// HH TOM RIM, rhythmRom.kit's order; bit 7 dumps them instead), $11 is the
// total level, $18-$1D each sound's pan (bits 7-6, L and R) and level. A
// hit is {t, k, db, pan}: its attenuation from full, 0.75 dB a step of each
// level, and its pan; one panned to neither side is silent and not a hit.
export function rhythmChip() {
  const r = new Uint8Array(0x20);
  const hits = [];
  return {
    hits,
    write(a, d, t) {
      r[a] = d;
      if (a !== 0x10 || d & 0x80) return;
      for (let k = 0; k < 6; k++) {
        if (!(d >> k & 1)) continue;
        const lr = r[0x18 + k] >> 6;
        if (!lr) continue;
        hits.push({ t, k, db: 0.75 * (63 - (r[0x11] & 63) + 31 - (r[0x18 + k] & 31)), pan: ["", "right", "left", "center"][lr] });
      }
    },
  };
}

// ── Envelopes ─────────────────────────────────────────────────────────────

export const FRAME = RATE / 60;

// ── PCM chips with a sample ROM of their own ──────────────────────────────

export const SEGA_ROM = 0x80, ADPCMB_RAM = 0x81, ADPCMA_ROM = 0x82, ADPCMB_ROM = 0x83, OKI6295_ROM = 0x8b;
const C140_ROM = 0x8d, K053260_ROM = 0x8e;
export const OWN_ROMS = new Set([OKI6295_ROM, C140_ROM, K053260_ROM]);
export const OPNA_RAM = 0x40000; // the YM2608's ADPCM RAM, 256 KB

const dbOf = (v, full) => (v > 0 ? 20 * Math.log10(v / full) : -96);

/**
 * SegaPCM, the YM2610's ADPCM-A / ADPCM-B, the OKIM6295, the K053260 and the C140, as far as an import needs
 * them: each key-on is a hit {t, src, ch, rom, start, end, loopStart, rate,
 * db, pan, off, levels} — `start`/`end` byte offsets into the ROM, `rate` the
 * frames a second it plays at, `db` its level (0 = full), `off` when it
 * stopped (a key-off, or the channel's next hit), `levels` the level moved
 * while it sounds. Pitch moved during a hit is not followed.
 */
export function pcmChips({ segaClock, segaIntf, opnbClock, opnaClock, okiClock, okiPin7, okiRom, k053260Clock, c140Clock, c140Banks, ramWrite }) {
  const hits = [];
  const sided = (lr) => lr === 1 || lr === 2; // L/R bits: one side alone is panned
  const open = new Map(); // `${src}/${ch}` → the hit it is playing
  const start = (h) => {
    const k = `${h.src}/${h.ch}`;
    const prev = open.get(k);
    if (prev && prev.off == null) prev.off = h.t;
    open.set(k, h);
    hits.push(h);
  };
  const stop = (src, ch, t) => { const h = open.get(`${src}/${ch}`); if (h && h.off == null) h.off = t; };
  // A level written to a sounding voice: right after its key, what it starts
  // at (a driver keys first, its level after); later, its fade (`levels`).
  const levelTo = (src, ch, t, db) => {
    const h = open.get(`${src}/${ch}`);
    if (!h || h.off != null) return;
    if (t - h.t <= LATE_T) h.db = db;
    else (h.levels ??= []).push([t, db]);
  };

  // SegaPCM: 16 channels of 8 registers. A channel plays while its flags'
  // bit 0 is clear, from a bank (the flags, shifted by the header's
  // interface register) plus a 16-bit address, to the end page, looping
  // back unless bit 1 is set; clock/128 frames a second, × step/256.
  const sram = new Uint8Array(256);
  const playing = new Array(16).fill(false), moved = new Array(16).fill(false);
  const bankShift = segaIntf & 0xff, bankMask = ((segaIntf >> 16) & 0xff) || 0x70;
  let segaUsed = false;
  const sega = (addr, d, t) => {
    segaUsed = true;
    if (addr > 0xff) return;
    const ch = (addr >> 3) & 15, reg = addr & 0x87;
    sram[addr] = d;
    if (reg === 2 || reg === 3) levelTo("SegaPCM", ch, t, dbOf(Math.max(sram[(ch << 3) | 2], sram[(ch << 3) | 3]), 127));
    if (reg === 0x84 || reg === 0x85) moved[ch] = true;
    if (reg !== 0x86) return;
    if (d & 1) { if (playing[ch]) stop("SegaPCM", ch, t); playing[ch] = false; return; }
    if (playing[ch] && !moved[ch]) return;
    playing[ch] = true;
    moved[ch] = false;
    const R = (k) => sram[(ch << 3) | k];
    if (!R(7)) return; // a step of 0 does not move
    const bank = (d & bankMask) << bankShift;
    start({ t, src: "SegaPCM", ch, rom: SEGA_ROM, start: bank + (R(0x84) | (R(0x85) << 8)), end: bank + ((R(6) + 1) << 8),
      loopStart: d & 2 ? null : bank + (R(4) | (R(5) << 8)), rate: (segaClock / 128) * (R(7) / 256),
      db: dbOf(Math.max(R(2), R(3)), 127), pan: R(2) !== R(3) });
  };

  // OKIM6295: four voices at clock/132 (pin 7 high) or /165, one level each.
  // A play is two bytes: bit 7 and the phrase, then the voices and their
  // attenuation; a phrase is 8 bytes of table at phrase × 8, an 18-bit start
  // and last byte, a play of a phrase that runs backwards doing nothing; bit 7
  // clear stops the voices in bits 3-6. A play on a voice still sounding is
  // ignored. Port 8-B the clock, C pin 7, F the bank. E turns on an NMK112's
  // banks, 10-13 pick them: four 64 KB windows on the ROM, and with E's bit 7
  // the table's four 256 bytes each in a bank of its own (VGMPlay). The banks
  // at a play are the sample's for all of it.
  const OKI_LEVEL = [0x20, 0x16, 0x10, 0x0b, 0x08, 0x06, 0x04, 0x03, 0x02];
  const okiClockBytes = [0, 8, 16, 24].map((shift) => (okiClock >>> shift) & 255), okiUntil = [-1, -1, -1, -1];
  const okiNmkBank = [0, 0, 0, 0];
  let okiPhrase = -1, okiBank = 0, okiNmk = 0, okiDivisor = okiPin7 ? 132 : 165;
  const okiAt = (a) => {
    if (!okiNmk) return okiBank + a;
    const table = a < 0x400 && okiNmk & 0x80;
    return (table ? a : a & 0xffff) + okiNmkBank[table ? a >> 8 : (a >> 16) & 3] * 0x10000;
  };
  const oki = (port, d, t) => {
    if (port >= 0x08 && port <= 0x0b) {
      okiClockBytes[port & 3] = port === 0x0b ? d & 0x7f : d; // bit 7: a logger's stray pin 7
      if (port === 0x0b) okiClock = okiClockBytes.reduce((v, b, i) => v + b * 256 ** i, 0);
    } else if (port === 0x0c) okiDivisor = d ? 132 : 165;
    else if (port === 0x0e) okiNmk = d;
    else if (port === 0x0f) okiBank = d * 0x40000;
    else if (port >= 0x10 && port <= 0x13) okiNmkBank[port & 3] = d;
    if (port !== 0) return;
    if (okiPhrase < 0) {
      if (d & 0x80) { okiPhrase = d & 0x7f; return; }
      for (let v = 0; v < 4; v++) if (d & (8 << v)) { stop("OKIM6295", v, t); okiUntil[v] = -1; }
      return;
    }
    const phrase = okiPhrase;
    okiPhrase = -1;
    const rom = okiRom();
    const entry = (i) => (rom?.[okiAt(phrase * 8 + i)] ?? 0);
    const read = rom && okiAt(phrase * 8 + 5) < rom.length; // else counted lost, in finish()
    const from = ((entry(0) << 16) | (entry(1) << 8) | entry(2)) & 0x3ffff;
    const last = ((entry(3) << 16) | (entry(4) << 8) | entry(5)) & 0x3ffff;
    const rate = okiClock / okiDivisor;
    if (!(rate > 0) || (read && from >= last)) return;
    const level = OKI_LEVEL[d & 15] ?? 0;
    for (let v = 0; v < 4; v++) {
      if (!(d & (16 << v)) || t < okiUntil[v]) continue;
      okiUntil[v] = t + ((last + 1 - from) * 2 * RATE) / rate;
      if (!level) continue;
      // A sample over two windows is two places in the ROM: its own bytes.
      const split = read && okiNmk && from >> 16 !== last >> 16;
      const bytes = split ? Uint8Array.from({ length: last + 1 - from }, (_, i) => rom[okiAt(from + i)] ?? 0) : undefined;
      start({ t, src: "OKIM6295", ch: v, rom: read ? OKI6295_ROM : null, start: split ? 0 : okiAt(from), end: split ? bytes.length : okiAt(from) + last + 1 - from,
        bytes, loopStart: null, rate, db: dbOf(level, 0x20), pan: false });
    }
  };

  // K053260: four voices of 8 registers from $08 (pitch, length, a 21-bit
  // start, level). $28's low bits key them on and off, $2A says which loop and
  // which are 4-bit KADPCM, $2C/$2D their pans. A voice steps every 4096 − pitch
  // clocks, and reads from the byte after its start (MAME k053260). A voice
  // played backwards ($28's high bits) or at pan 0, silent, makes no hit.
  const kr = new Uint8Array(0x30);
  const k053260 = (a, d, t) => {
    const was = kr[a];
    kr[a] = d;
    if (a >= 8 && a < 0x28 && (a & 7) === 7) levelTo("K053260", (a - 8) >> 3, t, dbOf(d & 0x7f, 127));
    if (a !== 0x28) return;
    for (let v = 0; v < 4; v++) {
      const bit = 1 << v;
      if (!(d & bit)) { stop("K053260", v, t); continue; }
      if (was & bit) continue;
      const r = 8 + v * 8;
      const from = (kr[r + 4] | (kr[r + 5] << 8) | ((kr[r + 6] & 0x1f) << 16)) + 1;
      const pitch = kr[r] | ((kr[r + 1] & 15) << 8);
      const pan = (kr[0x2c + (v >> 1)] >> (v & 1 ? 3 : 0)) & 7;
      if (!pan || d & (bit << 4)) continue;
      start({ t, src: "K053260", ch: v, rom: K053260_ROM, start: from, end: from + (kr[r + 2] | (kr[r + 3] << 8)),
        loopStart: kr[0x2a] & bit ? from : null, rate: k053260Clock / (4096 - pitch),
        kadpcm: !!(kr[0x2a] & (bit << 4)), db: dbOf(kr[r + 7] & 0x7f, 127), pan: pan !== 4 });
    }
  };

  // C140: 24 voices of 16 registers (levels, frequency, bank, mode, start,
  // end, loop); bit 7 of the mode keys a voice on, bit 4 loops, bit 3 is
  // mu-law. An address is the bank's 64 KB over the board's wiring (MAME c140:
  // System 2's, System 21's).
  const cr = new Uint8Array(0x200);
  const c140Address = (a) => (c140Banks === 1 ? ((a & 0x300000) >>> 1) + (a & 0x7ffff) : ((a & 0x200000) >>> 2) | (a & 0x7ffff));
  const c140 = (a, d, t) => {
    cr[a] = d;
    if (a < 0x180 && (a & 15) < 2) levelTo("C140", a >> 4, t, dbOf(Math.max(cr[a & ~1], cr[a | 1]), 255));
    if (a >= 0x180 || (a & 15) !== 5) return;
    const v = a >> 4;
    stop("C140", v, t);
    if (!(d & 0x80)) return;
    const R = (k) => cr[(v << 4) + k];
    const frequency = (R(2) << 8) | R(3), bank = R(4) << 16;
    const first = (R(6) << 8) | R(7), last = (R(8) << 8) | R(9), loop = (R(10) << 8) | R(11);
    if (!frequency || last <= first) return;
    const from = c140Address(bank + first);
    start({ t, src: "C140", ch: v, rom: C140_ROM, start: from, end: from + last - first,
      loopStart: d & 0x10 ? from + loop - first : null, rate: (frequency * c140Clock) / 288 / 65536, mulaw: !!(d & 8),
      db: dbOf(Math.max(R(0), R(1)), 255), pan: R(0) !== R(1) });
  };

  // YM2610: ADPCM-A (port 1, $00–$2D) — six channels at clock/432, a key-on
  // bit each in $00 ($80 set: those stop), the total level in $01 and each
  // channel's in $08+; ADPCM-B (port 0, $10–$1C) — one channel, $10 bit 7
  // starts it (bit 4 repeats), Δ-N in $19/$1A, its level in $1B. Addresses
  // are in 256-byte pages.
  const ar = new Uint8Array(0x30), br = new Uint8Array(0x20);
  const opnb = (port, a, d, t) => {
    if (port === 1) {
      ar[a] = d;
      if (a !== 0) return;
      for (let ch = 0; ch < 6; ch++) {
        if (!(d & (1 << ch))) continue;
        if (d & 0x80) { stop("ADPCM-A", ch, t); continue; }
        start({ t, src: "ADPCM-A", ch, rom: ADPCMA_ROM, start: ((ar[0x18 + ch] << 8) | ar[0x10 + ch]) << 8,
          end: (((ar[0x28 + ch] << 8) | ar[0x20 + ch]) << 8) + 256, loopStart: null, rate: opnbClock / 432,
          db: -0.75 * ((63 - (ar[0x01] & 63)) + (31 - (ar[0x08 + ch] & 31))), pan: sided(ar[0x08 + ch] >> 6) });
      }
      return;
    }
    br[a] = d;
    if (a !== 0x10) return;
    if (!(d & 0x80)) { stop("ADPCM-B", 0, t); return; }
    const dn = (br[0x1a] << 8) | br[0x19];
    if (!dn) return;
    const from = ((br[0x13] << 8) | br[0x12]) << 8;
    start({ t, src: "ADPCM-B", ch: 0, rom: ADPCMB_ROM, start: from, end: (((br[0x15] << 8) | br[0x14]) << 8) + 256,
      loopStart: d & 0x10 ? from : null, rate: (dn / 65536) * (opnbClock / 144), db: dbOf(br[0x1b], 255),
      pan: sided(br[0x11] >> 6) });
  };

  // YM2608: ADPCM-B (port 1, $00–$10) — the YM2610's, but at $00 up, its
  // pan in $01 bits 7-6, and its RAM addressed in 32-byte units (ROM or
  // 8-bit RAM, $01 bits 0-1) or 4-byte ones (1-bit RAM), the stop address's
  // unit included (ymfm address_shift). A driver loads the RAM through $08,
  // from the start address on, in record + external mode ($00 bits 6-5).
  const nr = new Uint8Array(0x11);
  let ramAt = null; // the next RAM byte $08 writes; -1 before the first
  let last = null; // the hit a key-on started, which its setup burst amends
  // A hit's rate, level and pan as the registers have them; one panned to
  // neither side is silent.
  const shiftNow = () => (nr[0x01] & 3 ? 5 : 2);
  const set = (h) => {
    const shift = shiftNow();
    const lr = nr[0x01] >> 6;
    h.start = ((nr[0x03] << 8) | nr[0x02]) << shift;
    h.end = (((nr[0x05] << 8) | nr[0x04]) + 1) << shift;
    h.loopStart = h.repeat ? h.start : null;
    h.rate = (((nr[0x0a] << 8) | nr[0x09]) / 65536) * (opnaClock / 144);
    h.db = lr ? dbOf(nr[0x0b], 255) : -96;
    h.pan = sided(lr);
    h.side = ["center", "right", "left", "center"][lr];
  };
  const opna = (a, d, t) => {
    if (a > 0x10) return;
    nr[a] = d;
    if (a === 0x08) {
      if (ramAt == null) return;
      if (ramAt < 0) ramAt = ((nr[0x03] << 8) | nr[0x02]) << shiftNow();
      ramWrite(ramAt++, d);
      return;
    }
    // A driver may key on first and then set the level, pan and Δ-N: what
    // it writes within SETUP_T of the key-on is the hit's. One keyed on
    // silent (level 0, or panned to neither side) takes the level and pan a
    // tick later still, within LATE_T (Misty Blue's driver, 10 ms on): only
    // its first moments were silent.
    if (a !== 0x00) {
      if (!last) return;
      if (t - last.t <= SETUP_T && (a === 0x01 || a === 0x09 || a === 0x0a || a === 0x0b)) set(last);
      else if (last.db <= -60 && t - last.t <= LATE_T && (a === 0x01 || a === 0x0b)) {
        const { start, end, loopStart, rate } = last;
        set(last);
        Object.assign(last, { start, end, loopStart, rate });
      }
      return;
    }
    ramAt = !(d & 0x80) && (d & 0x60) === 0x60 ? -1 : null;
    if (!(d & 0x80)) { stop("ADPCM-B", 1, t); last = null; return; }
    last = { t, src: "ADPCM-B", ch: 1, rom: ADPCMB_RAM, repeat: !!(d & 0x10) };
    set(last);
    start(last); // a Δ-N of 0 (one written later) is dropped in finish() if it stays so
  };

  return {
    sega, opnb, opna, oki, k053260, c140, start, stop,
    get segaUsed() { return segaUsed; },
    /** The hits that play from a ROM the file carries, each with `endT`: when it stops sounding. */
    /** Hits whose sample data the file does not carry, counted by source (after finish). */
    lost: new Map(),
    finish(endT, roms) {
      const out = [];
      for (const h of hits) {
        const rom = h.bytes ?? roms.get(h.rom);
        if (!rom || h.start >= rom.length) { this.lost.set(h.src, (this.lost.get(h.src) ?? 0) + 1); continue; }
        if (h.end <= h.start || !(h.rate > 0)) continue;
        h.end = Math.min(h.end, rom.length);
        if (h.loopStart != null && (h.loopStart < h.start || h.loopStart >= h.end)) h.loopStart = null;
        const frames = (h.end - h.start) * framesPerByte(h);
        const natural = h.loopStart != null ? Infinity : h.t + (frames / h.rate) * RATE;
        h.endT = Math.min(natural, h.off ?? Infinity, endT);
        // What a driver wrote after it ended is the next hit's.
        h.levels = h.levels?.filter(([t]) => t < h.endT);
        // Silent from its key to its end: a voice held, not a sound.
        if (h.db <= -60 && !h.levels?.some(([, db]) => db > -60)) continue;
        if (h.endT > h.t) out.push(h);
      }
      return out.sort((x, y) => x.t - y.t);
    },
  };
}

// A ROM byte's frames: SegaPCM's 8 bits one, the ADPCMs' two nibbles two, the DMC's eight bits eight.
export const framesPerByte = ({ src, kadpcm }) => (src === "DPCM" ? 8 : src === "SegaPCM" || src === "C140" || (src === "K053260" && !kadpcm) ? 1 : 2);
