// ---------------------------------------------------------------------------
// VGM (.vgm / .vgz) → MMLisp
//
// A VGM is a timed register-write log, so the notes are rebuilt from what
// the chips were told: a key-on starts a note, a key-off ends it, the pitch
// is the frequency in force, and on an OPN / OPM chip the voice is every
// register of the channel at key-on. What maps:
//
//   YM2612, YM2203, YM2608, YM2610   voices and notes (FM), SSG → PSG;
//                                    the YM2608's rhythm as the ROM's
//                                    tracks (pc88) or the RX5 kit's
//                                    (rhythmTracks), its ADPCM-B a PCM
//                                    chip's (pc88's pcm1, or pcm1–3)
//   YM2151 (OPM)                     voices and notes — DT2 kept when the
//                                    score is the X68000's (:target x68k),
//                                    dropped on the Mega Drive; channel 8's
//                                    noise (NE) as noise notes
//   SN76489, AY-3-8910               notes (square, noise); the SSG's mixer
//                                    and hardware envelope on a PC-8801 or
//                                    MSX score (:target pc88 / msx)
//   2A03 (the Famicom's APU)         the pulses (their duty, their envelope
//                                    as a level envelope, their length
//                                    counter), the triangle, the noise (its
//                                    rate the note, its mode), the DMC's
//                                    samples from the file's RAM blocks;
//                                    the FDS on a wave channel (its gain's
//                                    envelope a level envelope, its
//                                    modulation the song's LFO words on fc)
//   YM2413 (and VRC7)                 notes on their voices, read on four
//                                    operators (chips/ym2413.js)
//   YM3812/3526/Y8950, YMF262 notes, on a stand-in voice
//
// Carrier TL is how most drivers set a channel's level, so a voice's
// carriers are taken relative to their loudest use and the rest becomes
// `:vel`, a level moving during a note a `:vel+` envelope. Pitch moved
// during a note: a jump it stays at becomes a slur to a new note, a vibrato
// or a bend a `:pitch` macro (pitchShape). The YM2612's DAC, played from a
// data bank (seeks + 8n, or DAC stream control), is a PCM track over one wav
// of the bank (dacTrack). SegaPCM, the YM2610's ADPCM-A / ADPCM-B and the
// X68000's OKIM6258 (streamed) play from sample data the file carries: each
// hit becomes a note on pcm1–3
// (chipPcmTracks), the oldest sound giving way when more ring at once than
// the score has voices; other chips' PCM is reported, not imported.
//
// Time is kept, not read as beats: the score runs at 150 BPM, a tick
// 1/240 s, and each note sits where the driver wrote it — the import is a
// faithful performance to listen to and take voices and pitches from, not
// a score rebuilt (a groove, a swing, a driver's own timer would not
// survive a beat grid).
//
//   parseVgm(bytes)                  → the file's chips and channels' events
//   analyzeVgm(parsed)               → what the import dialog shows, and the
//                                      targets it can write (md; x68k for a
//                                      YM2151's file, pc88 for a YM2608's or
//                                      YM2203's, msx for an AY-3-8910's or an
//                                      SCC's, pce for a HuC6280's)
//
// A wavetable chip's note (the SCC's, the HuC6280's, the FDS's) carries the
// wave in its channel's memory as it starts (`wave`, 32 steps −128..127, the
// FDS's 64): on a target
// with wave channels each distinct wave is a def-wave, named where a
// track's wave changes. The HuC6280's channels 5 and 6 on their noise are
// rows of their own (`HuC6280 CH5 noise`), their notes the rate (c2 the
// slowest, chips/huc6280.js).
//   vgmChannels(analysis, target)    → its rows on that target
//   defaultVgmOptions(analysis, target) → its defaults on that target
//   vgmToMmlisp(parsed, options, analysis) → { source, warnings }
// ---------------------------------------------------------------------------

import { emitSong, emitStructured, qstr, barEnds, RATE, PPQN,
  assignBends, PITCH_NONE, gcd, destsFor } from "./import-song.js";
import { targetProfile } from "./targets.js";
import { envCycle } from "./chips/ssg.js";
import { DUTIES, NOISE_PERIODS, NOISE_NOTE_BASE, DMC_PERIODS, DMC_RATES, noiseNoteOfHz } from "./chips/rp2a03.js";
import { rhythmRom } from "./chips/rhythm-rom.js";
import { RHYTHM_SOUNDS, RHYTHM_KIT, ringGate } from "./import-mucom.js";
import { fmVoiceDef } from "./import-fm-voices.js";
import { encodeWav } from "./export-wav.js";
import { decodeAdpcmB } from "./mucom-pcm.js";
import { OPLL_ROM, OPLL_ROM_NAMES, VRC7_ROM, opllVoiceDef, opllVoiceDef2op } from "./chips/ym2413.js";
import { VEL_DB_PER_STEP } from "./ir-utils.js";
import { engineImage } from "./engine-images.js";
import { bankedEngineImage } from "./engine-banked-images.js";

const CARRIERS = [[3], [3], [3], [3], [2, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]]; // by ALG, in slot order
const STAND_IN = { psg: "wave-square", noise: "wave-square", opl: "wave-sine", opll: "wave-saw" };
// The SN76489's white noises (Hz on the Mega Drive) and the noise rates
// that come nearest them where a noise is a rate (125 kHz / rate).
const WHITE_HZ = [13983, 6991, 3496];
const NOISE_RATE_OF = { white0: 9, white1: 18, white2: 31 };
const nearestWhite = (hz) => WHITE_HZ.reduce((b, w, i) => (Math.abs(Math.log(w / hz)) < Math.abs(Math.log(WHITE_HZ[b] / hz)) ? i : b), 0);

/** gzip (.vgz) → bytes */
async function gunzip(u8) {
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;
  const ds = new DecompressionStream("gzip");
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

const pitchOf = (hz) => (hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null);
const TONE_MAX_HZ = 20000; // a tone above it is heard as none
// A driver's writes for one note land within this of each other (samples).
const SETUP_T = 0.002 * RATE;
// A chip PCM hit keyed on silent takes the level a driver's next tick gives it, this soon (samples).
const LATE_T = 0.02 * RATE;
// A duty moved this soon after a note's start is its attack (samples).
const DUTY_ATTACK_T = (4 * RATE) / 60;

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
// A channel sounds while its level is up and its mixer passes tone, noise,
// or — on the hardware envelope (the level's M bit) — neither, where what is
// heard is the envelope itself at its rate (a buzzer, pitched by R11-R12).
// A note carries the mixer and the envelope it starts with (`ssg`); a write
// to R13 starts the envelope over, which on a channel on it is a new note.
// Every note is its channel's; one on the noise alone is the shared noise
// row's too (`SSG noise`), for a target whose noise is a channel of its own
// (vgmChannels picks one of the two).
function ayChip(name, clock, { ev, prefix = name }) {
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
function opllChip(clock, { ev, vrc7 = false }) {
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
  return {
    name,
    write(a, d, t) {
      if (a > 0x3f) return;
      r[a] = d;
      const c = a & 15;
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

// ── Wavetable chips ───────────────────────────────────────────────────────

// A level as :vel: a 5-bit volume at 1.5 dB a step (the HuC6280's), or a
// 4-bit linear one (the SCC's), against 2 dB a :vel step.
const velOfDb = (db) => Math.max(0, Math.min(15, Math.round((15 + db / VEL_DB_PER_STEP) * 8) / 8));
const waveOf = (steps, top) => steps.map((v) => Math.max(-128, Math.min(127, Math.round((v * 255) / top) - 128)));

// The HuC6280 (chips/huc6280.js): $00 selects a channel, whose $02/$03 is
// its frequency (the clock / 32 / f), $04 its on bit, DDA bit and 5-bit
// volume, $05 its left / right levels, $06 its wave (a step a write, from
// step 0 after the DDA bit drops), $07 — on channels 5 and 6 — its noise.
// A note is the channel on at a volume; on the noise, its row's (the rate
// as the note: c2 the slowest).
function pceChip(clock, { ev, skip }) {
  let sel = 0;
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
      : { t, kind: "on", pitch: pitchOf(hz(c)), vel: vel(c), pan: pan(c), wave: waveOf([...ram[c]], 31), kindOf: "wave" });
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
      } else if (a === 0x08 || a === 0x09) skip("HuC6280 LFO");
    },
  };
}

// The 2A03's APU (chips/rp2a03.js), VGM 0xB4: $00-$03 / $04-$07 the pulses
// (duty, length halt, constant volume, volume; the sweep; the period; its
// high bits under the length load, a write that restarts the envelope and
// the phase), $08-$0B the triangle (its linear counter's control and
// reload; the period under the length load), $0C-$0F the noise (level,
// mode and rate, length), $10-$13 the DMC (rate and loop, the DAC, the
// sample's address and length), $15 the enables (the DMC's bit starts and
// stops a sample). A channel sounds while enabled, its length counter
// running (LENGTHS, a half frame a step, halted by its halt bit), its
// level up — the volume, or the envelope decaying from 15 a step every
// (volume + 1) quarter frames, looping on the halt bit — and, the
// triangle, its linear counter up. The counters run between writes, so
// each write first lets the time pass (`advance`): a note ends where its
// counter ran out, its level steps where the envelope stepped. The frame
// counter's mode ($4017) sets the quarter frame's length, 4-step or 5-step,
// on the average, the sweep on its half frames (a pitch moving under the
// note) and its mute. Not followed: a halt cleared under a held counter
// (the counter stays held).
const APU_LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const NES_RAM = 0xc2; // VGM's RAM-write block for the NES's memory
function apuChip(clock, { ev, skip, pcm, ram }) {
  // Samples a quarter frame: 4-step mode's 29830 clocks over four (~240 Hz),
  // 5-step's 37282 over four.
  let QUARTER = (RATE * 29830) / (4 * clock);
  let lastT = -Infinity; // the previous write's time: nothing is emitted before it
  const r = new Uint8Array(0x18);
  const KEY = ["2A03 SQ1", "2A03 SQ2", "2A03 TRI", "2A03 noise"];
  // The counters start at 0 (silent until a load).
  const ch = [0, 1, 2, 3].map(() => ({ on: false, lenEnd: -Infinity, linEnd: -Infinity, env: null, vel: 0, pitch: null, duty: null, mode: null, velAt: -1, pitchAt: -1 }));
  // The channels start enabled: an NSF player sets $4015 before the song
  // starts, and a rip of it often does not log that write.
  let enable = 0x0f;
  const dmc = { playing: false, end: Infinity, dac: 0, dacAt: -Infinity };
  const ctlOf = (c) => r[c === 3 ? 0x0c : 4 * c];
  const haltOf = (c) => (c === 2 ? r[0x08] & 0x80 : ctlOf(c) & 0x20);
  const period = (c) => (c === 2 ? ((r[0x0b] & 7) << 8) | r[0x0a] : ((r[4 * c + 3] & 7) << 8) | r[4 * c + 2]);
  const hz = (c) => clock / ((c === 2 ? 32 : 16) * (period(c) + 1));
  const rate = () => r[0x0e] & 15;
  const mode = () => (r[0x0e] & 0x80 ? "periodic" : "white");
  // A channel's level at `t`: its volume, or its envelope's step.
  const level = (c, t) => {
    if (c === 2) return 15;
    const ctl = ctlOf(c);
    if (ctl & 0x10) return ctl & 15;
    const e = ch[c].env;
    if (!e) return 0;
    const steps = Math.floor((t - e.t0) / (e.div * QUARTER));
    return ctl & 0x20 ? 15 - (steps % 16) : Math.max(0, 15 - steps);
  };
  // The 4-bit volume is linear: its :vel on the 2 dB ladder.
  const velOf = (v) => (v > 0 ? velOfDb(20 * Math.log10(v / 15)) : 0);
  const endAt = (c) => Math.min(ch[c].lenEnd, c === 2 ? ch[c].linEnd : Infinity);
  // A looping envelope passes 0 for a step and starts over: it stays on.
  const loopEnv = (c) => c !== 2 && !!ch[c].env && (ctlOf(c) & 0x30) === 0x20;
  const sounding = (c, t) => !!(enable & (1 << c)) && endAt(c) > t && (level(c, t) > 0 || loopEnv(c)) && !sweepMuted(c) && (c === 3 || period(c) >= (c === 2 ? 2 : 8));
  // The pitch a write burst started from (`burstPitch`), and the way the
  // last burst moved it under the note (`glide`): what the triangle's
  // $400B compares.
  const pitchMoved = (st, t) => {
    if (t - st.pitchAt > SETUP_T) { st.burstPitch = st.pitch; st.lastGlide = st.glide; st.glide = null; }
    st.pitchAt = t;
  };
  const onEvent = (c, t, kind) => {
    const st = ch[c];
    st.vel = level(c, t);
    pitchMoved(st, t);
    st.velAt = t;
    if (c === 3) {
      st.pitch = NOISE_NOTE_BASE + 15 - rate();
      st.mode = mode();
      return { t, kind, pitch: st.pitch, vel: velOf(st.vel), mode: st.mode, noiseHz: clock / NOISE_PERIODS[rate()], kindOf: "noise" };
    }
    st.pitch = pitchOf(hz(c));
    st.duty = c < 2 ? DUTIES[ctlOf(c) >> 6] : null;
    return { t, kind, pitch: st.pitch, vel: velOf(st.vel), kindOf: "psg", ...(c < 2 ? { duty: st.duty } : {}) };
  };
  // What a write changed: a note started, ended, struck again, or moved.
  const sync = (c, t, strike = false) => {
    const st = ch[c], was = st.on, now = sounding(c, t);
    st.on = now;
    if (!was && now) ev(KEY[c], onEvent(c, t, "on"));
    else if (was && !now) ev(KEY[c], { t, kind: "off" });
    else if (was && strike) ev(KEY[c], onEvent(c, t, "retrig"));
    else if (was) {
      const v = level(c, t), vCh = v !== st.vel;
      const p = c === 3 ? null : pitchOf(hz(c)), pCh = c !== 3 && p !== st.pitch;
      // A driver strikes a note by writing its period and its level
      // together (no key-off between): a new note, as on the SN76489 — where
      // the level came up, or the pitch jumped a semitone or more (a level
      // envelope under a vibrato, written each frame, is one note).
      // (Together: within a driver's setup burst of each other.)
      const jump = c !== 3 && Math.abs(p - st.pitch) >= 0.5;
      const struck = (vCh && t - st.pitchAt <= SETUP_T && (v > st.vel || jump)) ||
        (pCh && t - st.velAt <= SETUP_T && (v > st.vel || jump));
      if (struck && !st.pendingB) { ev(KEY[c], onEvent(c, t, "retrig")); return; }
      if (vCh) { st.vel = v; st.velAt = t; ev(KEY[c], { t, kind: "vel", vel: velOf(v) }); }
      if (c === 3) {
        if (rate() !== NOISE_NOTE_BASE + 15 - st.pitch || mode() !== st.mode)
          ev(KEY[c], onEvent(c, t, "retrig"));
      } else {
        if (pCh) {
          pitchMoved(st, t);
          st.glide = { t, way: Math.sign(p - st.burstPitch) };
          st.pitch = p;
          ev(KEY[c], { t, kind: "pitch", pitch: p });
        }
        const d = c < 2 ? DUTIES[ctlOf(c) >> 6] : null;
        if (d !== st.duty) { st.duty = d; ev(KEY[c], { t, kind: "duty", duty: d }); }
      }
    }
  };
  // The sweep (a pulse's $4001): its target period, whether it mutes the
  // channel (a period under 8, or a target over $7FF when it adds), and its
  // divider, stepped every half frame (sweepHalf).
  const sweep = [{ div: 0, reload: false }, { div: 0, reload: false }];
  const sweepTarget = (c) => {
    const p = period(c), d = p >> (r[4 * c + 1] & 7);
    return r[4 * c + 1] & 8 ? p - d - (c === 0 ? 1 : 0) : p + d;
  };
  const sweepMuted = (c) => c < 2 && (period(c) < 8 || (!(r[4 * c + 1] & 8) && sweepTarget(c) > 0x7ff));
  const sweeping = (c) => c < 2 && ch[c].on && r[4 * c + 1] & 0x80 && r[4 * c + 1] & 7;
  const sweepHalf = (c, at) => {
    const sw = sweep[c], reg = r[4 * c + 1];
    if (sw.div === 0 && reg & 0x80 && reg & 7 && !sweepMuted(c)) {
      const p = Math.max(0, sweepTarget(c));
      r[4 * c + 2] = p & 0xff;
      r[4 * c + 3] = (r[4 * c + 3] & 0xf8) | ((p >> 8) & 7);
      sync(c, at);
    }
    if (sw.div === 0 || sw.reload) { sw.div = (reg >> 4) & 7; sw.reload = false; } else sw.div--;
  };
  // The frame counter's half frames, from its last $4017 write.
  let fcT0 = 0, nextHalf = null;
  const halfAfter = (t) => fcT0 + (Math.floor((t - fcT0) / (2 * QUARTER)) + 1) * 2 * QUARTER;
  // The time between writes, in order: the envelopes' steps, the sweeps'
  // half frames, the counters' ends.
  const advance = (t) => {
    for (;;) {
      let at = Infinity, what = null, cc = -1;
      for (let c = 0; c < 4; c++) {
        const st = ch[c];
        if (!st.on) continue;
        const e = c !== 2 && !(ctlOf(c) & 0x10) ? st.env : null;
        const step = e ? e.t0 + (e.next + 1) * e.div * QUARTER : Infinity;
        if (step < at) { at = step; what = "env"; cc = c; }
        if (endAt(c) < at) { at = endAt(c); what = "end"; cc = c; }
      }
      if (sweeping(0) || sweeping(1)) {
        if (nextHalf == null || nextHalf <= lastT) nextHalf = halfAfter(Math.max(lastT, fcT0));
        if (nextHalf < at) { at = nextHalf; what = "half"; }
      } else nextHalf = null;
      if (at > t) break;
      if (what === "end") { ch[cc].on = false; ev(KEY[cc], { t: at, kind: "off" }); continue; }
      if (what === "half") { for (const c of [0, 1]) if (sweeping(c)) sweepHalf(c, at); nextHalf = at + 2 * QUARTER; continue; }
      const st = ch[cc], e = st.env;
      e.next++;
      if (at < lastT) continue; // stepped while the level was the volume's: nothing to say
      const v = level(cc, at);
      if (v === 0 && !loopEnv(cc)) { st.on = false; ev(KEY[cc], { t: at, kind: "off" }); }
      else if (v !== st.vel) { st.vel = v; ev(KEY[cc], { t: at, kind: "vel", vel: velOf(v) }); }
    }
    if (dmc.playing && dmc.end <= t) dmc.playing = false;
  };
  // The triangle's linear counter reloaded at `at` from $4008: held (the
  // control bit) at its value — on, or 0 silent — else counting down.
  const triReload = (at) => {
    const v = r[0x08] & 0x7f;
    ch[2].linEnd = r[0x08] & 0x80 ? (v ? Infinity : -Infinity) : v ? at + v * QUARTER : -Infinity;
  };
  const resolveB = (t) => {
    const st = ch[2], pb = st.pendingB;
    st.pendingB = null;
    if (!st.on) return;
    const step = st.pitch - pb.from, g = pb.glide;
    const gliding = g && pb.t - g.t <= 1.5 * FRAME && Math.sign(step) === g.way && Math.abs(step) < 3;
    if (!gliding) ev(KEY[2], onEvent(2, t, "retrig"));
  };
  const load = (c, t) => {
    ch[c].lenEnd = haltOf(c) ? Infinity : t + APU_LENGTHS[r[c === 2 ? 0x0b : c === 3 ? 0x0f : 4 * c + 3] >> 3] * 2 * QUARTER;
  };
  return {
    name: "2A03",
    write(a, d, t) {
      if (a > 0x17) return;
      if (ch[2].pendingB && t - ch[2].pendingB.t > SETUP_T) resolveB(ch[2].pendingB.t);
      advance(t);
      lastT = t;
      r[a] = d;
      if (a === 0x17) { QUARTER = (RATE * (d & 0x80 ? 37282 : 29830)) / (4 * clock); fcT0 = t; nextHalf = null; return; }
      if (a < 0x10) {
        const c = a >> 2, reg = a & 3;
        // The sweep: its divider reloaded at the next half frame; its mute now.
        if (c < 2 && reg === 1) { sweep[c].reload = true; sync(c, t); return; }
        if (c === 2 && reg === 0) {
          // The linear counter. With its control bit set the reload flag
          // stays set, so the counter is the reload value every quarter
          // frame: up while it is nonzero, silent at 0. The bit cleared, it
          // counts the reload down from there. A $400B's reload is taken at
          // the next quarter frame, from $4008 as it is then: a $4008 written
          // just after it (a driver's order) is the one read.
          if (t - (ch[2].reloadAt ?? -Infinity) < QUARTER) triReload(ch[2].reloadAt);
          else if (d & 0x80) ch[2].linEnd = d & 0x7f ? Infinity : -Infinity;
          else if (!Number.isFinite(ch[2].linEnd)) ch[2].linEnd = t + (d & 0x7f) * QUARTER; // the flag still set: reloaded
          if (Number.isFinite(ch[2].lenEnd) && d & 0x80) ch[2].lenEnd = Infinity;
          sync(2, t);
          return;
        }
        if (reg === 0 && c !== 2) {
          // A halt set holds the length counter where it is. An envelope
          // not yet stepped takes the divider from here (a driver writing
          // $4003 before $4000).
          if (d & 0x20 && Number.isFinite(ch[c].lenEnd)) ch[c].lenEnd = Infinity;
          if (ch[c].env && ch[c].env.next === 0) ch[c].env.div = (d & 15) + 1;
          sync(c, t);
          return;
        }
        if (reg === 3) {
          // The length load: the envelope started over, the pulse's phase
          // too — a new note.
          if (enable & (1 << c)) load(c, t);
          if (c !== 2) { ch[c].env = { t0: t, div: (ctlOf(c) & 15) + 1, next: 0 }; sync(c, t, true); return; }
          // The triangle's phase runs on through it: a new note, but not
          // in a glide — a pitch moved the frame before, going on the same
          // way a step (a drum's fall crossing a high byte).
          // Decided on the pitch the burst settles on: a driver may write
          // the low byte after it (resolveB).
          ch[2].reloadAt = t;
          triReload(t);
          const st = ch[2];
          if (!st.on) { sync(2, t, true); return; }
          const lowFirst = t - st.pitchAt <= SETUP_T;
          st.pendingB = { t, from: lowFirst ? st.burstPitch ?? st.pitch : st.pitch, glide: lowFirst ? st.lastGlide : st.glide };
          sync(2, t);
          if (lowFirst) resolveB(t);
          return;
        }
        sync(c, t);
        if (c === 2 && reg === 2 && ch[2].pendingB) resolveB(t);
        return;
      }
      if (a === 0x15) {
        enable = d & 0x1f;
        for (let c = 0; c < 4; c++) { if (!(d & (1 << c))) ch[c].lenEnd = -Infinity; sync(c, t); }
        if (!(d & 0x10)) { if (dmc.playing) pcm.stop("DPCM", 0, t); dmc.playing = false; }
        else if (!dmc.playing) {
          // The sample is the memory as it stands now (a later block may
          // rewrite it: a bank switched), from $C000 up, wrapping to $8000.
          const start = 0xc000 + r[0x12] * 64, len = r[0x13] * 16 + 1, idx = r[0x10] & 15, loop = !!(r[0x10] & 0x40);
          const bytes = ram(start, len); // none before the first block: a hit with no sample
          pcm.start({ t, src: "DPCM", ch: 0, rom: bytes ? NES_RAM : null, start: 0, end: len, bytes, loopStart: loop ? 0 : null,
            rate: DMC_RATES[idx], db: 0, pan: false, dac0: dmc.dac });
          dmc.playing = true;
          dmc.end = loop ? Infinity : t + (RATE * len * 8 * DMC_PERIODS[idx]) / clock;
        }
        return;
      }
      if (a === 0x11) {
        // The DAC written directly: a level ahead of a sample, or, written
        // on and on, a PCM the CPU plays itself (not imported).
        if ((d & 0x7f) !== dmc.dac && t - dmc.dacAt < 0.002 * RATE) skip("2A03 $4011 PCM");
        dmc.dac = d & 0x7f;
        dmc.dacAt = t;
      }
    },
    end: (t) => advance(t),
  };
}

// The Famicom Disk System's channel (chips/fds.js), VGM 0xB4 $20-$7F (the
// 2A03's clock with bit 31): $20 the gain (bit 7 direct, else its envelope's
// speed and way), $22 / $23 the 12-bit pitch (bit 7 halts the wave, bit 6
// the envelopes), $24 the modulation's depth (the same), $26 / $27 its rate
// (bit 7 halts it, opening its table to $28), $29 the wave memory's write
// enable and the master volume, $2A the envelopes' speed, $3F ($4023) the
// sound's enable, $40-$7F the memory. A note sounds while the wave runs at
// a pitch, its gain up. The envelopes step every 8 × (speed + 1) × $2A
// clocks between writes (synth-fc.js Fds), a level envelope on the note. The
// wave is read where the memory closes; the modulation as the note starts
// (its table, rate and depth: the song's :lfo-wave, :lfo-freq, :lfo-pmd),
// its pitch the wave's own — the bend it makes is left to the chip. A $25
// of 0 in the burst (the counter back to 0, as a driver starts each note's
// vibrato alike) is the note's `reset`: its :lfo-wave written again, which
// starts the counter over (chips/fds.js); another value is not the
// language's (skipped).
const FDS_MOD_OF = [0, 1, 2, 4, "reset", -4, -2, -1]; // $28's codes as :lfo-wave's steps
const FDS_MASTER_DB = [1, 2 / 3, 2 / 4, 2 / 5].map((v) => 20 * Math.log10(v));
function fdsChip(clock, { ev, skip }) {
  const KEY = "FDS";
  const wave = new Uint8Array(64), table = new Array(32).fill(0);
  let pitch = 0, waveHalt = false, envHalt = false, waveOpen = false, master = 0, envMaster = 0xe8, io = true;
  let modFreq = 0, modHalt = true, modPos = 0, resetAt = -Infinity;
  // The volume envelope [0] and the modulation's [1]: its gain, speed, way,
  // whether direct, and the time of its last step.
  const env = [0, 1].map(() => ({ gain: 0, speed: 0, up: false, off: true, at: 0 }));
  let on = false, gainNow = 0, pitchNow = null, velAt = -Infinity, pitchAt = -Infinity, modAt = -Infinity, burstFrom = null, waveNow = null;
  const level = () => (io && !waveHalt && pitch > 0 ? Math.min(32, env[0].gain) : 0);
  const vel = (g) => velOfDb(20 * Math.log10(g / 32) + FDS_MASTER_DB[master]);
  const pitchOfNow = () => pitchOf((clock * pitch) / 2 ** 22);
  const steps = () => waveOf([...wave], 63);
  const lfo = (t) => (!modHalt && modFreq && env[1].gain
    ? { table: table.map((c) => FDS_MOD_OF[c]), freq: modFreq, depth: Math.min(63, env[1].gain), reset: t - resetAt <= SETUP_T } : null);
  const strike = (t, kind) => {
    on = true;
    gainNow = level();
    pitchNow = burstFrom = pitchOfNow();
    waveNow = steps();
    ev(KEY, { t, kind, pitch: pitchNow, vel: vel(gainNow), wave: waveNow, lfo: lfo(t), kindOf: "wave" });
  };
  const running = (e) => !e.off && !envHalt && !waveHalt && envMaster > 0;
  // The envelopes' steps up to `t`, each a level the note moves to.
  const advance = (t) => {
    for (const e of env) {
      if (!running(e)) { e.at = t; continue; }
      const period = (RATE * 8 * (e.speed + 1) * envMaster) / clock;
      while (e.at + period <= t) {
        e.at += period;
        if (e.up ? e.gain >= 32 : e.gain <= 0) { e.at = t; break; }
        e.gain += e.up ? 1 : -1;
        if (e === env[0]) sync(e.at, true);
      }
    }
  };
  // What a change did to the note: started, ended, struck again, or moved.
  // A driver strikes a note by writing its pitch and its gain together, in
  // either order: the gain up, or the pitch a semitone or more from where
  // the burst found it — or the gain alone jumping up (a note on the same
  // pitch), or that jump with the modulation set (a note of its own).
  const sync = (t, stepped = false) => {
    const g = level();
    if (!on) { if (g > 0) strike(t, "on"); return; }
    if (g === 0) { on = false; ev(KEY, { t, kind: "off" }); return; }
    const p = pitchOfNow(), pCh = p !== pitchNow, gCh = g !== gainNow;
    if (pCh && t - pitchAt > SETUP_T) burstFrom = pitchNow;
    if (pCh) pitchAt = t;
    const jump = t - pitchAt <= SETUP_T && Math.abs(p - burstFrom) >= 0.5;
    const struck = !stepped && ((gCh && (g > gainNow + 4 || (t - pitchAt <= SETUP_T && (g > gainNow || jump)))) ||
      (pCh && t - velAt <= SETUP_T && (g > gainNow || jump)) || (pCh && jump && t - modAt <= SETUP_T));
    if (gCh && !stepped) velAt = t;
    if (struck) { strike(t, "retrig"); return; }
    if (gCh) { gainNow = g; ev(KEY, { t, kind: "vel", vel: vel(g) }); }
    if (pCh) { pitchNow = p; ev(KEY, { t, kind: "pitch", pitch: p }); }
  };
  return {
    name: "FDS",
    write(a, d, t) {
      advance(t);
      if (a >= 0x40) { if (waveOpen) wave[a - 0x40] = d & 63; return; }
      const envWrite = (e) => {
        e.speed = d & 63; e.up = !!(d & 0x40); e.off = !!(d & 0x80); e.at = t;
        if (e.off) e.gain = d & 63;
      };
      if (a === 0x20) { envWrite(env[0]); sync(t); }
      else if (a === 0x22) { pitch = (pitch & 0xf00) | d; sync(t); }
      else if (a === 0x23) {
        pitch = (pitch & 0xff) | ((d & 15) << 8);
        waveHalt = !!(d & 0x80);
        envHalt = !!(d & 0x40);
        sync(t);
      } else if (a === 0x24) envWrite(env[1]);
      else if (a === 0x25) { if (d & 0x7f) skip("FDS modulation counter set to a value but 0 (its phase)"); else resetAt = t; }
      else if (a === 0x26) modFreq = (modFreq & 0xf00) | d;
      else if (a === 0x27) { modFreq = (modFreq & 0xff) | ((d & 15) << 8); modHalt = !!(d & 0x80); }
      else if (a === 0x28 && modHalt) { table[modPos] = d & 7; modPos = (modPos + 1) & 31; }
      else if (a === 0x29) {
        const closed = waveOpen && !(d & 0x80);
        waveOpen = !!(d & 0x80);
        if (master !== (d & 3)) { master = d & 3; if (on) ev(KEY, { t, kind: "vel", vel: vel(gainNow) }); }
        // The memory rewritten under a sounding note: its timbre moving.
        if (closed && on) {
          const w = steps();
          if (w.join() !== waveNow.join()) { waveNow = w; ev(KEY, { t, kind: "wave", wave: w }); }
        }
      } else if (a === 0x2a) { envMaster = d; for (const e of env) e.at = t; } // the timers start over (synth-fc.js)
      else if (a === 0x3f) { io = !!(d & 2); sync(t); }
      // The modulation moved under a note (read where it starts): after a
      // pitch's jump in the same burst, that note's.
      if (a >= 0x24 && a <= 0x28) {
        modAt = t;
        if (on && t - pitchAt <= SETUP_T && Math.abs(pitchNow - burstFrom) >= 0.5) strike(t, "retrig");
        else if (on) ev(KEY, { t, kind: "lfo", lfo: lfo(t) });
      }
    },
    end: (t) => advance(t),
  };
}

// The K051649, the SCC (chips/k051649.js), as VGM 0xD2 splits it: port 0
// the four wave memories (channels 4 and 5 share the fourth), 1 the periods
// (the clock / 16 / (p + 1): VGM's clock is half the one the chip counts
// at), 2 the 4-bit volumes, 3 the key bits.
function sccChip(clock, { ev }) {
  const N = 5;
  const ram = Array.from({ length: 4 }, () => new Int8Array(32)), period = new Uint16Array(N), volume = new Uint8Array(N);
  let keys = 0;
  const on = new Array(N).fill(false);
  const key = (c) => `K051649 CH${c + 1}`;
  const audible = (c) => !!((keys >> c) & 1) && volume[c] > 0 && period[c] >= 9;
  const vel = (c) => velOfDb(volume[c] ? 20 * Math.log10(volume[c] / 15) : -96);
  const hz = (c) => clock / (16 * (period[c] + 1));
  const wave = (c) => [...ram[Math.min(c, 3)]];
  // A key let go and taken again within a driver's setup burst is no new
  // note: with no envelope to restart, the SCC plays on (Metal Gear 2's
  // driver drops every channel's key for a moment whenever one starts).
  const offEv = new Array(N).fill(null);
  const check = (c, t) => {
    const now = audible(c);
    if (now && !on[c]) {
      if (offEv[c] && t - offEv[c].t <= SETUP_T) offEv[c].kind = "held"; // (read by nothing: the note goes on)
      else ev(key(c), { t, kind: "on", pitch: pitchOf(hz(c)), vel: vel(c), wave: wave(c), kindOf: "wave" });
      offEv[c] = null;
    } else if (!now && on[c]) ev(key(c), (offEv[c] = { t, kind: "off" }));
    on[c] = now;
  };
  return {
    name: "K051649",
    write(port, a, d, t) {
      if (port === 0 && a < 0x80) {
        ram[a >> 5][a & 31] = (d << 24) >> 24;
        // A wave rewritten under a sounding note: its timbre moving (a
        // driver's frame of a noisier wave for a strike on the channel) —
        // a note's still where its key is down for a moment (offEv).
        for (let c = 0; c < N; c++)
          if ((on[c] || offEv[c]) && Math.min(c, 3) === a >> 5) ev(key(c), { t, kind: "wave", wave: wave(c) });
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
function rhythmChip() {
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

// ── The file ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ chips: string[], skipped: Map<string, number>, events: Map<key, ev[]>,
 *   kinds: Map<key, kind>, totalSamples, loopSample, title, author, game, system, dac: boolean,
 *   dacBank: Uint8Array, dacHits: [{t, offset, bytes, rate}],
 *   pcmRoms: Map<blockType, Uint8Array>, pcmHits: [{t, src, ch, rom, start, end, loopStart, rate, db, pan, endT}] }>}
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
  const ayFlags = 0x79 < dataStart ? u8[0x79] : 0;
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
    opll: [0x10, 3579545, (c) => opllChip(c, { ev, vrc7: hdr(0x10) >>> 31 === 1 })], // bit 31: the VRC7
    opn2: [0x2c, 7670453, (c) => opnChip("YM2612", c, 144, { ev })],
    opm: [0x30, 3579545, (c) => opmChip(c, { ev })],
    opn: [0x44, 3993600, (c) => opnChip("YM2203", c, 72, { ssgDiv: 2, channels: 3, ev })],
    opna: [0x48, 7987200, (c) => opnChip("YM2608", c, 144, { ssgDiv: 4, ev })],
    opnb: [0x4c, 8000000, (c) => opnChip("YM2610", c, 144, { ssgDiv: 4, ev })],
    opl2: [0x50, 3579545, (c) => oplChip("YM3812", c, 72, { ev })],
    opl1: [0x54, 3579545, (c) => oplChip("YM3526", c, 72, { ev })],
    y8950: [0x58, 3579545, (c) => oplChip("Y8950", c, 72, { ev })],
    opl3: [0x5c, 14318180, (c) => oplChip("YMF262", c, 288, { ev })],
    // With a 2A03 in the file the AY is the Famicom's Sunsoft 5B. A YM2149
    // with its divider pin low (flags bit 4) counts at half the clock.
    ay: [0x74, 1789773, (c) => ayChip(hdr(0x84) ? "5B" : "AY-3-8910", ayFlags & 0x10 ? c / 2 : c, { ev })],
    scc: [0x9c, 1789773, (c) => sccChip(c, { ev })],
    pce: [0xa4, 3579545, (c) => pceChip(c, { ev, skip })],
    apu: [0x84, 1789773, (c) => apuChip(c & 0x7fffffff, { ev, skip, pcm, ram: nesRam })],
    fds: [0x84, 1789773, (c) => fdsChip(c & 0x7fffffff, { ev, skip })], // the 2A03's clock (bit 31: the FDS)
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
  // A second chip (dual-chip bit in its clock) is not imported: its
  // commands are counted under its name.
  const SECOND = {
    0x30: "SN76489", 0x3f: "SN76489", 0xa1: "YM2413", 0xa2: "YM2612", 0xa3: "YM2612", 0xa4: "YM2151",
    0xa5: "YM2203", 0xa6: "YM2608", 0xa7: "YM2608", 0xa8: "YM2610", 0xa9: "YM2610", 0xaa: "YM3812",
    0xab: "YM3526", 0xac: "Y8950", 0xae: "YMF262", 0xaf: "YMF262",
  };

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
  let lastDirect = -Infinity, burst = null;
  const closeHit = () => {
    if (hit && hit.bytes > 1 && hit.last > hit.t)
      hits.push({ t: hit.t, offset: hit.offset, bytes: hit.bytes, rate: (RATE * (hit.bytes - 1)) / (hit.last - hit.t) });
    hit = null;
  };
  const streams = new Map(); // id → {dac, chip, bankType, freq, hit}
  const stream = (id) => { if (!streams.has(id)) streams.set(id, { dac: false, chip: 0, bankType: 0, freq: 0, hit: null }); return streams.get(id); };
  const OKIM6258 = 0x17; // a stream's chip type
  const endStream = (st, at) => {
    const h = st.hit;
    if (!h) return;
    const bytes = Math.min(h.bytes, Math.floor(((at - h.t) * h.rate) / RATE));
    if (bytes > 0) hits.push({ ...h, bytes });
    st.hit = null;
  };
  // Sample ROMs (data blocks 0x80 SegaPCM, 0x82 ADPCM-A, 0x83 ADPCM-B) and
  // the chips that play from them (pcmChips).
  const roms = new Map();
  const romWrite = (type, size, start, data) => {
    let rom = roms.get(type);
    const need = Math.max(size, start + data.length);
    if (!rom || rom.length < need) { const grown = new Uint8Array(need); if (rom) grown.set(rom); rom = grown; roms.set(type, rom); }
    rom.set(data, start);
  };
  // The NES's memory for the DMC (the 0xC2 blocks), `len` bytes from
  // `start`, past $FFFF on from $8000; null until a block has written it.
  const nesRam = (start, len) => {
    const rom = roms.get(NES_RAM);
    if (!rom) return null;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { const a = start + i; out[i] = rom[a > 0xffff ? 0x8000 + ((a - 0x10000) & 0x7fff) : a]; }
    return out;
  };
  const rhythm = rhythmChip();
  const pcm = pcmChips({ segaClock: clk(0x38) || 4000000, segaIntf: hdr(0x3c), opnbClock: clk(0x4c) || 8000000,
    opnaClock: clk(0x48) || 7987200,
    // The YM2608's RAM, as a driver loads it a byte at a time.
    ramWrite: (addr, d) => {
      if (addr >= OPNA_RAM) return;
      // (A RAM image the file carries may be shorter: the whole RAM then.)
      if ((roms.get(ADPCMB_RAM)?.length ?? 0) < OPNA_RAM) romWrite(ADPCMB_RAM, OPNA_RAM, 0, new Uint8Array(0));
      roms.get(ADPCMB_RAM)[addr] = d;
    } });
  const typed = new Map(); // stream data blocks of a type other than 0: type → {parts, len, blocks}
  let okiUsed = false;
  const LEN = { 0x30: 2, 0x3f: 2, 0x4f: 2, 0x50: 2, 0x94: 2 };
  while (p < u8.length) {
    if (p === loopOffset) loopSample = t;
    const c = u8[p];
    if (c === 0x66) break;
    if (c === 0x61) { t += u8[p + 1] | (u8[p + 2] << 8); p += 3; continue; }
    if (c === 0x62) { t += 735; p++; continue; }
    if (c === 0x63) { t += 882; p++; continue; }
    if ((c & 0xf0) === 0x70) { t += (c & 15) + 1; p++; continue; }
    // A new hit with no seek, the stream playing on from the bank (Revenge
    // of Shinobi's driver, its samples laid end to end): the driver turning
    // the DAC on again (2B), or a burst of bytes written straight to 2A — a
    // head the file's packer found in no sample. The hit starts there (if
    // the stream follows within 5 ms).
    if (c === 0x52 && u8[p + 1] === 0x2b && u8[p + 2] & 0x80) { closeHit(); burst = t; }
    if (c === 0x52 && u8[p + 1] === 0x2a) {
      if (t - lastDirect > 0.005 * RATE) { closeHit(); burst = t; }
      lastDirect = t;
    }
    if ((c & 0xf0) === 0x80) {
      if (pos != null && pos < bankLen) {
        if (!hit || t - hit.last > 2 * 735) {
          closeHit();
          hit = { t: burst != null && t - burst < 0.005 * RATE ? burst : t, offset: pos, bytes: 0, last: t };
        }
        burst = null;
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
      } else if (type < 0x40) {
        // Another chip's stream data (0x04: the OKIM6258's ADPCM), appended.
        if (!typed.has(type)) typed.set(type, { parts: [], len: 0, blocks: [] });
        const tb = typed.get(type);
        tb.blocks.push([tb.len, size]);
        tb.parts.push(u8.subarray(p + 7, p + 7 + size));
        tb.len += size;
      } else if (type === 0x80 || type === 0x81 || type === 0x82 || type === 0x83) {
        romWrite(type, u32(p + 7), u32(p + 11), u8.subarray(p + 15, p + 7 + size));
      } else if (type === NES_RAM) {
        // The NES's memory (the DMC's samples): the address, then the bytes.
        romWrite(NES_RAM, 0x10000, u8[p + 7] | (u8[p + 8] << 8), u8.subarray(p + 9, p + 7 + size));
      }
      p += 7 + size; continue;
    }
    // DAC stream control onto the YM2612's DAC (register 2A).
    if (c === 0x90) {
      const st = stream(u8[p + 1]);
      st.chip = u8[p + 2] & 0x7f;
      st.dac = st.chip === 0x02 && u8[p + 4] === 0x2a;
      p += 5; continue;
    }
    if (c === 0x91) { stream(u8[p + 1]).bankType = u8[p + 2]; p += 5; continue; }
    if (c === 0x92) { stream(u8[p + 1]).freq = u32(p + 2); p += 6; continue; }
    if (c === 0x93 || c === 0x95) {
      const st = stream(u8[p + 1]);
      endStream(st, t);
      const tb = st.bankType ? typed.get(st.bankType) ?? { len: 0, blocks: [] } : { len: bankLen, blocks };
      let offset, bytes, loops = false;
      if (c === 0x93) {
        offset = u32(p + 2);
        const mode = u8[p + 6] & 0x0f, len = u32(p + 7);
        bytes = mode === 1 ? len : mode === 2 ? Math.round((len * st.freq) / 1000) : tb.len - offset;
        loops = !!(u8[p + 6] & 0x80);
        p += 11;
      } else {
        const b = tb.blocks[u8[p + 2] | (u8[p + 3] << 8)];
        [offset, bytes] = b ?? [0, 0];
        loops = !!(u8[p + 4] & 1);
        p += 5;
      }
      // The OKIM6258 (X68000): a byte holds two 4-bit samples, so it plays at
      // twice the stream's byte rate.
      if (st.chip === OKIM6258 && st.bankType && st.freq > 0 && bytes > 0) {
        pcm.start({ t, src: "OKIM6258", ch: 0, rom: st.bankType, start: offset, end: offset + bytes,
          loopStart: loops ? offset : null, rate: 2 * st.freq, db: 0, pan: false });
        continue;
      }
      if (st.dac && st.freq > 0 && offset < bankLen && bytes > 0) {
        st.hit = { t, offset, bytes: Math.min(bytes, bankLen - offset), rate: st.freq };
        dac = true;
      }
      continue;
    }
    if (c === 0x94) {
      const ids = u8[p + 1] === 0xff ? [...streams.keys()] : [u8[p + 1]];
      for (const id of ids) {
        const st = stream(id);
        if (st.chip === OKIM6258) pcm.stop("OKIM6258", 0, t);
        else endStream(st, t);
      }
      p += 2; continue;
    }
    // The OKIM6258's own registers: start/stop, pan and clock follow the
    // stream, which is what the import reads.
    if (c === 0xb7) { if (!okiUsed) { okiUsed = true; chips.push("OKIM6258"); } p += 3; continue; }
    if (c === 0x68) { p += 12; continue; }
    if (c === 0xd2) {
      if (!(u8[p + 1] & 0x80)) chip("scc").write(u8[p + 1] & 0x7f, u8[p + 2], u8[p + 3], t);
      else skip("second K051649");
      p += 4; continue;
    }
    if (c === 0xb9) {
      if (!(u8[p + 1] & 0x80)) chip("pce").write(u8[p + 1], u8[p + 2], t);
      else skip("second HuC6280");
      p += 3; continue;
    }
    if (c === 0xb4) {
      if (!(u8[p + 1] & 0x80)) chip(u8[p + 1] >= 0x20 ? "fds" : "apu").write(u8[p + 1], u8[p + 2], t);
      else skip("second 2A03");
      p += 3; continue;
    }
    if (c === 0x50) { chip("sn").write(u8[p + 1], t); p += 2; continue; }
    if (c === 0x51) { chip("opll").write(u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x52 || c === 0x53) {
      chip("opn2").write(c - 0x52, u8[p + 1], u8[p + 2], t);
      p += 3; continue;
    }
    if (c === 0x54) { chip("opm").write(u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x55) { chip("opn").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x56 || c === 0x57) {
      const port = c - 0x56, a = u8[p + 1];
      // The YM2608's rhythm (port 0 $10–$1D) and ADPCM-B (port 1 $00–$10).
      if (port === 0 && a >= 0x10 && a <= 0x1d) { chip("opna"); rhythm.write(a, u8[p + 2], t); }
      else if (port === 1 && a <= 0x10) { chip("opna"); pcm.opna(a, u8[p + 2], t); }
      else chip("opna").write(port, a, u8[p + 2], t);
      p += 3; continue;
    }
    if (c === 0x58 || c === 0x59) {
      const port = c - 0x58, a = u8[p + 1];
      if (port === 1 ? a < 0x30 : a >= 0x10 && a < 0x1d) { chip("opnb"); pcm.opnb(port, a, u8[p + 2], t); }
      else chip("opnb").write(port, a, u8[p + 2], t);
      p += 3; continue;
    }
    if (c === 0xc0) {
      if (!pcm.segaUsed) chips.push("SegaPCM");
      pcm.sega(u8[p + 1] | (u8[p + 2] << 8), u8[p + 3], t);
      p += 4; continue;
    }
    if (c === 0x5a) { chip("opl2").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5b) { chip("opl1").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5c) { chip("y8950").write(0, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0x5e || c === 0x5f) { chip("opl3").write(c - 0x5e, u8[p + 1], u8[p + 2], t); p += 3; continue; }
    if (c === 0xa0) {
      if (!(u8[p + 1] & 0x80)) chip("ay").write(u8[p + 1], u8[p + 2], t);
      else skip("second AY-3-8910");
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
    if (SECOND[c]) skip(`second ${SECOND[c]}`);
    else if (c !== 0x4f) skip(`command 0x${c.toString(16)}`);
    p += n;
  }
  const end = Math.max(t, totalSamples);
  for (const m of made.values()) m.end?.(end); // a counter still running: its note ends here
  closeHit();
  for (const st of streams.values()) endStream(st, end);
  hits.sort((a, b) => a.t - b.t);
  // A hit cut off within 10 ms by the next (a driver starting one sample and
  // at once another) is not one.
  {
    const kept = hits.slice(-1);
    for (let i = hits.length - 2; i >= 0; i--) {
      const next = kept[kept.length - 1];
      if (!(next.t - hits[i].t < 0.01 * RATE && (hits[i].bytes / hits[i].rate) < 0.01)) kept.push(hits[i]);
    }
    kept.reverse();
    hits.length = kept.length;
    for (let i = 0; i < kept.length; i++) hits[i] = kept[i];
  }
  const bank = new Uint8Array(bankLen);
  { let o = 0; for (const part of bankParts) { bank.set(part, o); o += part.length; } }
  if (made.get("opn2")?.dacUsed) dac = true;
  for (const [type, tb] of typed) {
    const bank = new Uint8Array(tb.len);
    let o = 0;
    for (const part of tb.parts) { bank.set(part, o); o += part.length; }
    roms.set(type, bank);
  }

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
  const pcmHits = pcm.finish(end, roms);
  for (const [src, n] of pcm.lost) skipped.set(`${src} (the file carries no sample data for it)`, n);
  return { chips, skipped, clockNotes, events, kinds, totalSamples: end, loopSample, title, author, game, system, dac,
    dacBank: bank, dacHits: hits, pcmRoms: roms, pcmHits, rhythmHits: rhythm.hits };
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
function notesOf(events, followPitch, endT) {
  const out = [];
  let cur = null;
  const close = (t) => { if (cur) { cur.end = t; out.push(cur); cur = null; } };
  // The note going on at `t` as a new one, slurred into, with `change`.
  const slurTo = (t, change) => {
    const base = cur, lv = base.levels.length ? base.levels[base.levels.length - 1][1] : base.lv0 ?? base.vel;
    const last = (xs, x) => (xs.length ? xs[xs.length - 1][1] : x);
    close(t);
    cur = { ...base, t, ...change, levels: [], pitches: [], waves: [], lfos: [], slur: true, vel: lv, lv0: lv,
      pitch: last(base.pitches, base.pitch), wave: last(base.waves, base.wave), lfo: last(base.lfos, base.lfo) };
  };
  for (const e of events) {
    if (e.kind === "on" || (e.kind === "retrig" && cur)) {
      const base = cur ?? {};
      close(e.t);
      // A strike that does not say its pitch has the one in force: the last
      // the note before moved to.
      const held = base.pitches?.length ? base.pitches[base.pitches.length - 1][1] : base.pitch;
      cur = { t: e.t, pitch: e.pitch ?? held, vel: e.vel ?? base.vel ?? 15, voice: e.voice ?? base.voice,
        pan: e.pan ?? base.pan, mode: e.mode ?? base.mode, noiseHz: e.noiseHz ?? base.noiseHz, ssg: e.ssg ?? base.ssg, fresh: !!e.fresh,
        wave: e.wave ?? base.wave, duty: e.duty ?? base.duty, opll: e.opll ?? base.opll, lfo: "lfo" in e ? e.lfo : base.lfo,
        levels: [], pitches: [], waves: [], lfos: [] };
      if (!cur.voice) cur.lv0 = cur.vel;
    } else if (e.kind === "off") close(e.t);
    else if (!cur) continue;
    // A pitch set in the note's setup burst (a driver keying on, then
    // writing the period a byte at a time) is the note's own.
    // A note keyed on before it has one (a period of 0) takes the first.
    else if (e.kind === "pitch" && e.pitch != null && (e.t - cur.t <= SETUP_T || cur.pitch == null)) cur.pitch = e.pitch;
    else if (e.kind === "pitch" && e.pitch != null) cur.pitches.push([e.t, e.pitch]);
    else if (e.kind === "vel" || e.kind === "tl") cur.levels.push([e.t, e.vel ?? e.tl]);
    // A wave written in the note's setup burst is the note's; later, its
    // timbre moving (a :wave macro).
    else if (e.kind === "wave" && e.t - cur.t <= SETUP_T) cur.wave = e.wave;
    else if (e.kind === "wave") cur.waves.push([e.t, e.wave]);
    // The FDS's modulation set in the setup burst is the note's; its depth
    // moved later, where it moved (`lfos`: a driver's delayed vibrato; its
    // rate or table moved alone, a sweep, is not followed). The last set at
    // one time stands (a table rewritten halts the unit for a moment).
    else if (e.kind === "lfo" && e.t - cur.t <= SETUP_T) cur.lfo = e.lfo;
    else if (e.kind === "lfo") {
      const ls = cur.lfos;
      if (ls.length && ls[ls.length - 1][0] === e.t) ls.pop();
      const was = ls.length ? ls[ls.length - 1][1] : cur.lfo;
      if ((e.lfo?.depth ?? 0) !== (was?.depth ?? 0)) ls.push([e.t, e.lfo]);
    }
    // A pan written in the note's setup burst (after its key-on) is the note's.
    else if (e.kind === "pan" && e.t - cur.t <= SETUP_T) cur.pan = e.pan;
    else if (e.kind === "mode") cur.mode = e.mode;
    // A pulse's duty moved under the note: through its attack (a timbre
    // macro's first steps) the note's — the one it settles on; later, a
    // note starting over on it.
    else if (e.kind === "duty" && e.t - cur.t <= DUTY_ATTACK_T) cur.duty = e.duty;
    else if (e.kind === "duty") slurTo(e.t, { duty: e.duty });
  }
  if (cur) { cur.end = Infinity; out.push(cur); }
  const notes = out.filter((n) => n.end > n.t && n.pitch != null && n.pitch > 0 && n.pitch < 128);
  return followPitch ? notes.flatMap((n) => pitchShape(n, endT)) : notes;
}

// A channel's notes, worked out once per file and setting (the dialog's
// analysis and every import from it read the same): kept on `parsed`.
const notesCache = new WeakMap(); // parsed → Map(`${followPitch}/${key}` → notes)
function channelNotes(parsed, key, followPitch) {
  let c = notesCache.get(parsed);
  if (!c) notesCache.set(parsed, (c = new Map()));
  const k = `${followPitch}/${key}`;
  if (!c.has(k)) c.set(k, notesOf(parsed.events.get(key), followPitch, parsed.totalSamples));
  return c.get(k);
}

// ── Pitch ─────────────────────────────────────────────────────────────────
// What a driver does to a note's pitch while it sounds, read back frame by
// frame (cents from the struck pitch). Structure over exactness: a jump the
// pitch then stays at (four frames or more) is a new note, slurred; a wobble
// around a level is a vibrato — a sine, its depth to 20 cents, its period and
// wait to the frame pair, so notes share one def; anything else is a few
// straight lines. A note is the semitone it spends the most frames at. A
// pitch moved in a note's last two frames (a driver resetting it as it lets
// go) is not kept.

const STAY = 4; // frames at a level that make a jump a new note
const MAX_SHAPE = 3600; // frames of a note its pitch is followed through (a minute)

function pitchShape(n, endT) {
  const end = n.end === Infinity ? endT : n.end;
  const F = Math.min(MAX_SHAPE, Math.max(1, Math.round((end - n.t) / FRAME)));
  // (One that goes on the way it was going — a sweep's fall to the note's
  // end — is the note's.)
  // (A burst's writes are its last: a period written a byte at a time
  // passes through a pitch it never plays.)
  const settled = n.pitches.filter(([t], i) => !(n.pitches[i + 1]?.[0] - t <= SETUP_T));
  const early = settled.filter(([t]) => t < end - 2 * FRAME);
  const way = early.length ? Math.sign(early[early.length - 1][1] - n.pitch) : 0;
  const moves = [...early];
  for (const m of settled.slice(early.length)) {
    if (!way || Math.sign(m[1] - moves[moves.length - 1][1]) !== way) break;
    moves.push(m);
  }
  if (!moves.length) return [n];
  // The pitch a frame, in cents from the struck one.
  const p = [];
  for (let f = 0, k = 0, v = n.pitch; f < F; f++) {
    const at = n.t + (f + 0.5) * FRAME;
    while (k < moves.length && moves[k][0] <= at) v = moves[k++][1];
    p.push(Math.round((v - n.pitch) * 100));
  }
  // A wobble of 30 cents or less is none: the note is the pitch it spends
  // its frames at (a driver's tuning step after the strike, kept as :pitch).
  if (Math.max(...p) - Math.min(...p) <= 30) return [{ ...n, pitch: n.pitch + [...p].sort((x, y) => x - y)[p.length >> 1] / 100 }];
  // Jumps it stays at: cut there.
  const cuts = [0];
  for (let f = 1; f + STAY <= F; f++) {
    if (Math.abs(p[f] - p[f - 1]) < 50) continue;
    let stays = true;
    for (let g = f + 1; g < f + STAY; g++) if (Math.abs(p[g] - p[f]) > 25) { stays = false; break; }
    if (stays) cuts.push(f);
  }
  // Under a deep vibrato the pitch never stays: its centre (a mean over a
  // vibrato's cycle) moving three quarters of a semitone or more off the
  // note's and holding there is a new note too, cut at the frame nearby the
  // pitch jumps most. (Three quarters: a centre near the middle of two
  // semitones wanders across it.) Held twice as long: a slow glide, a
  // semitone every few frames, stays one note.
  const W = 4, HOLD = 2 * STAY;
  const centre = p.map((_, f) => {
    let s = 0, k = 0;
    for (let g = Math.max(0, f - W); g <= Math.min(F - 1, f + W); g++) { s += p[g]; k++; }
    return s / k;
  });
  for (let f = 1, held = Math.round(centre[0] / 100) * 100; f + HOLD <= F; f++) {
    const off = (c) => Math.abs(c - held) >= 75;
    if (!off(centre[f])) continue;
    const to = Math.round(centre[f] / 100) * 100;
    let stays = true;
    for (let g = f + 1; g < f + HOLD; g++) if (!off(centre[g]) || Math.abs(centre[g] - to) > 50) { stays = false; break; }
    if (!stays) continue;
    held = to;
    let at = f;
    for (let g = Math.max(1, f - W); g <= Math.min(F - 1, f + W); g++)
      if (Math.abs(p[g] - p[g - 1]) > Math.abs(p[at] - p[at - 1])) at = g;
    if (!cuts.some((c) => Math.abs(c - at) < STAY)) cuts.push(at);
  }
  cuts.sort((a, b) => a - b);
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
    // A wobble of 30 cents or less is no bend.
    const moving = Math.max(...rel) - Math.min(...rel) > 30;
    // (Its pitch keeps its cents off the semitone, its own frames' middle
    // one: the note's :pitch.)
    const mid = rel.map((c) => c + off).sort((x, y) => x - y)[rel.length >> 1];
    const seg = { ...n, t: t0, end: t1, pitch: midi + (Math.abs(mid) < 50 ? mid : 0) / 100, slur: i > 0 || n.slur,
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
// The score's time: 150 BPM, a tick 1/240 s (a frame four ticks).
const BPM = 150;
const TICK = (60 * RATE) / (BPM * PPQN);
const MAX_ENV = 256; // frames an envelope follows; a level held after it is held on
const ENV_NONE = "(macro :vel none)";
const WAVE_NONE = "(macro :wave none)";
const ENV_KEY = 4; // frames assignEnvelopes indexes its shapes by

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
    // A note that stops dead (its level to 0, then a rest) takes no shape
    // with a release: that would sound on after it.
    if (c.rel && n.silentAfter) return false;
    return n.env.every((v, f) => v === (f < c.head.length ? c.head[f] : c.sus));
  };
  // A fit plays the shape's first ENV_KEY frames exactly, so a note that
  // long is tried only on the shapes that start so; a shorter one, on all.
  const keyOf = (env) => env.join(",");
  const startOf = (c) => {
    const a = [];
    for (let f = 0; f < ENV_KEY; f++) a.push(f < c.head.length ? c.head[f] : c.sus);
    return keyOf(a);
  };
  const noteKey = (n) => (n.shape.rel ? startOf(n.shape) : n.env.length >= ENV_KEY ? keyOf(n.env.slice(0, ENV_KEY)) : null);
  const indexed = (list) => {
    const by = new Map();
    for (const c of list) {
      const k = startOf(c);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(c);
    }
    return (n) => { const k = noteKey(n); return k == null ? list : by.get(k) ?? []; };
  };
  const shapes = [];
  const by = new Map();
  // Whole shapes first, longest first: a shorter note may be the start of one.
  const order = [...moving].sort((x, y) => (y.shape.rel ? 1 : 0) - (x.shape.rel ? 1 : 0) || y.env.length - x.env.length);
  for (const n of order) {
    const k = noteKey(n);
    let c = (k == null ? shapes : by.get(k) ?? []).find((sh) => fits(n, sh));
    if (!c) {
      shapes.push((c = { ...n.shape, uses: 0 }));
      const sk = startOf(c);
      if (!by.has(sk)) by.set(sk, []);
      by.get(sk).push(c);
    }
    c.uses++;
  }
  shapes.sort((x, y) => y.uses - x.uses || x.head.length - y.head.length);
  const near = indexed(shapes);
  const named = new Map();
  for (const n of moving) {
    const c = near(n).find((sh) => fits(n, sh));
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
  const step = parts.flat().reduce((g, [, k]) => gcd(g, k), 0) || 1;
  const vals = (r) => r.flatMap(([v, k]) => new Array(k / step).fill(v));
  const body = [...vals(parts[0]), "#sus", sus, ...(rel ? ["#rel", ...vals(parts[1])] : [])];
  return `(def ${name} (macro${step > 1 ? ` :step ${step}f` : ""} :vel+ [${body.join(" ")}]))`;
}

// ── What is in it ────────────────────────────────────────────────────────

export function analyzeVgm(parsed, { followPitch = true } = {}) {
  const channels = [];
  for (const key of parsed.events.keys()) {
    const notes = channelNotes(parsed, key, followPitch);
    if (!notes.length) continue;
    const kind = parsed.kinds.get(key) ?? "psg";
    const noisy = kind === "opm" ? notes.filter((n) => n.noiseHz).length : 0;
    // An SSG channel's notes on the noise alone (the noise row's too).
    const ssgNoise = kind === "psg" ? notes.filter((n) => n.ssg?.mix === "noise").length : 0;
    channels.push({ key, kind, notes: notes.length, noisy, ssgNoise, label: `${key} · ${notes.length} notes${noisy ? `, ${noisy} with the noise` : ""}` });
  }
  // The YM2608's rhythm: a row per ROM sound it keys.
  for (let k = 0; k < 6; k++) {
    const hs = (parsed.rhythmHits ?? []).filter((h) => h.k === k);
    if (!hs.length) continue;
    const key = `${RHYTHM_KEY} ${RHYTHM_ROM[k]}`;
    channels.push({ key, kind: "rhythm", k, notes: hs.length, label: `${key} · ${hs.length} hits` });
  }
  // The DAC: one channel of sample hits.
  if (parsed.dacHits?.length) {
    channels.push({ key: DAC_KEY, kind: "pcm", notes: parsed.dacHits.length,
      label: `${DAC_KEY} · ${parsed.dacHits.length} hits, ${new Set(parsed.dacHits.map((h) => h.offset)).size} samples` });
  }
  // PCM chips: a row per channel that plays; how many ring at once sets the
  // voices the score asks for.
  const byKey = new Map();
  for (const h of parsed.pcmHits ?? []) {
    const k = pcmKey(h);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(h);
  }
  for (const [key, hs] of byKey) {
    channels.push({ key, kind: "chip-pcm", notes: hs.length,
      label: `${key} · ${hs.length} hits, ${plural(new Set(hs.map((h) => h.start)).size, "sample")}` });
  }
  const pcmPoly = pcmPolyphony(parsed.pcmHits ?? []);
  // A file without a loop point says it does not loop (a jingle).
  const fileLoop = parsed.loopSample != null && parsed.loopSample < parsed.totalSamples;
  // The machines it can be written for: the Mega Drive, and the machine of
  // its own chip — the X68000 for a YM2151's, the PC-8801 for a YM2608's or
  // YM2203's, the MSX for an AY-3-8910's — by default when that chip plays
  // every channel.
  const tones = channels.filter((c) => c.kind !== "chip-pcm");
  const own = [["x68k", /^YM2151/], ["pc88", /^YM2(608|203)/], ["msx", /^(AY-3-8910|K051649)/], ["pce", /^HuC6280/], ["fc", /^(2A03|DPCM|FDS|5B|VRC7)/]]
    .filter(([, re]) => tones.some((c) => re.test(c.key)) || (!tones.length && parsed.chips.some((n) => re.test(n))));
  const targets = [...own.map(([t]) => t), "md"];
  // (A file of PCM alone — a YM2608's ADPCM-B — is its chip's machine's.)
  const target = own.find(([, re]) => (tones.length ? tones.every((c) => re.test(c.key)) : parsed.chips.some((n) => re.test(n))))?.[0] ?? "md";
  return { channels, followPitch, fileLoop, pcmPoly, targets, target };
}

/**
 * The channels `target`'s score offers an imported VGM's rows (import-song.js
 * destsFor). Not the FM-PAC's: its voices are its ROM's and one of the
 * user's, and an imported voice is a four-operator one.
 */
export function vgmDests(targetName = "md") {
  const t = targetProfile(targetName);
  const d = destsFor(t);
  // Where the SSG's channels mix the noise, `noise` is one of them: not a row's.
  // The ROM rhythm's tracks (pc88's rhythm1-rhythm6) are its sounds', not a sample row's.
  const romRhythm = (h) => t.partOf(h).name === "rhythm";
  // The RX5 kit stands in for it where the PCM is the DAC's mix of voices
  // (md): its first, the sounds layered on it. Not on another sample part —
  // msx's are the FM-PAC's rhythm, pce's the DDA its wave1 shares.
  // (Nor the FM-PAC's rhythm: its ROM drums play no sample.)
  const pcm = d.pcm.filter((h) => !romRhythm(h) && t.partOf(h).name !== "opll-rhythm");
  // (fc's 5b-noise is 5b-sqr3's mixer; its noise is the 2A03's.)
  const mixer = (h) => d.psg.some((p) => t.partOf(p).modes?.noise && t.voiceKey(p) === t.voiceKey(h));
  const noises = d.noises.filter((h) => !mixer(h));
  return { fm: d.fm.filter((h) => t.partOf(h).name !== "opll-fm"), psg: d.psg, noise: noises[0] ?? null,
    pcm, rhythm: d.pcm.filter(romRhythm), kit: t.hasPart("dac") ? pcm[0] ?? null : null,
    wave: d.wave, noises };
}

// A Famicom expansion's channel on its own name, where the target has it
// (fc): the FDS on fds-wave, the VRC7's FM2 on vrc7-fm2, the 5B's SSGB on
// 5b-sqr2.
const expansion = (key) => {
  const m = key.match(/^(?:(FDS)|VRC7 FM(\d)|5B SSG([ABC]))$/);
  return !m ? null : m[1] ? "fds-wave" : m[2] ? `vrc7-fm${m[2]}` : `5b-sqr${" ABC".indexOf(m[3])}`;
};

// Whether the target's tone channels play a chip's noise themselves (the
// SSG's mixer — msx's, pc88's, fc's 5B on its own channels): there a
// channel's noise notes are its own track's, `:mode noise`, and the chip's
// SSG noise row is not offered; elsewhere they are that row's. `chip` is the
// rows' prefix (`5B`, `AY-3-8910`).
const mixesNoise = (target, chip = "") => {
  const own = expansion(`${chip} SSGA`);
  const d = own && target.channels[own] ? own : destsFor(target).psg[0];
  return !!(d && target.partOf(d).modes?.noise);
};

/** The rows `target`'s score offers: every channel, but an SSG's noise row where its channels keep it. */
export function vgmChannels(a, targetName = a.target ?? "md") {
  const t = targetProfile(targetName);
  return a.channels.filter((c) => !(/ SSG noise$/.test(c.key) && mixesNoise(t, c.key.replace(/ SSG noise$/, ""))));
}

// The tone clock of the target's SSG (f = clock / 16 / period), or null.
function ssgClockOf(target) {
  for (const chip of Object.values(target.chips)) {
    if (chip.ssg?.clock) return chip.ssg.clock;
    if (chip.parts?.some((p) => /(^|-)ssg$/.test(p.name))) return chip.clock;
  }
  return null;
}

export function defaultVgmOptions(a, targetName = a.target ?? "md") {
  const dests = vgmDests(targetName);
  // With PCM in the song, fm6 is the DAC: FM is offered fm1–fm5.
  // (The rhythm on the kit is PCM too.) Only the Mega Drive's: elsewhere
  // the PCM has a part of its own.
  const pcmToo = targetProfile(targetName).hasPart("dac") && dests.pcm.length > 0 && a.channels.some((c) => c.kind === "pcm" || c.kind === "chip-pcm" ||
    (c.kind === "rhythm" && !dests.rhythm.length && dests.kit));
  const fm = dests.fm.filter((d) => !(pcmToo && d === "fm6"));
  const sqr = [...dests.psg];
  const waves = [...dests.wave];
  let noise = dests.noise;
  const dest = {};
  const order = ["fm", "opm", "psg", "wave", "noise", "pcm", "opl", "opll"];
  // The busiest channels first — but a YM2151 whose eight all fit (an x68k
  // score's fm1–fm8) keeps its own order, FM1 on fm1.
  const opmFits = a.channels.filter((c) => c.kind === "opm").length <= fm.length;
  const sorted = vgmChannels(a, targetName).sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) ||
    (x.kind === "opm" && opmFits ? x.key.localeCompare(y.key, "en", { numeric: true }) : y.notes - x.notes));
  // A YM2151 channel that only plays the noise is the noise channel's where
  // the target's fm8 cannot turn it on.
  const target = targetProfile(targetName);
  const fmNoise = dests.fm.some((d) => target.channels[d]?.modes?.noise);
  const pools = [fm, sqr, waves];
  for (const ch of sorted) {
    let d = "drop";
    // A YM2151 that fits keeps its channels' own numbers: FM8 on fm8, which
    // is where x68k's noise is.
    const own = ch.kind === "opm" && opmFits ? `fm${ch.key.match(/\d+$/)?.[0]}` : expansion(ch.key);
    const pool = own && pools.find((l) => l.includes(own));
    if (ch.kind === "opm" && !fmNoise && ch.noisy === ch.notes) d = "drop";
    else if (pool) { d = own; pool.splice(pool.indexOf(own), 1); }
    else if (ch.kind === "fm" || ch.kind === "opm") d = fm.shift() ?? "drop";
    // An SSG channel that only plays the noise is the noise row's alone
    // where the target's channels do not mix it.
    else if (ch.kind === "psg" && !mixesNoise(target, ch.key.replace(/ SSG[ABC]$/, "")) && ch.ssgNoise === ch.notes) d = "drop";
    // The 2A03's triangle, where the target's channels are not the 2A03's
    // and it has FM: an FM channel's (a triangle wave, its whole range — a
    // PSG's floor, the SN76489's 109 Hz, stops a drum's fall).
    else if (ch.key === "2A03 TRI" && targetName !== "fc" && fm.length) d = fm.shift();
    // The 2A03's pulses and triangle keep their places: SQ1 on sqr1, the
    // triangle on the third tone channel (fc's tri). A tone channel past the
    // target's own plays on FM where it is free.
    else if (ch.kind === "psg") {
      const own = ch.key.match(/^2A03 (?:SQ(\d)|(TRI))$/);
      const name = own ? dests.psg[own[2] ? 2 : own[1] - 1] : null;
      if (name && sqr.includes(name)) { d = name; sqr.splice(sqr.indexOf(name), 1); } else d = sqr.shift() ?? fm.shift() ?? "drop";
    }
    // A wavetable chip's channel on a target with wave channels: its own
    // number where it has one (the HuC6280's CH3 on wave3), else the next.
    else if (ch.kind === "wave" && waves.length) {
      const own = `wave${ch.key.match(/CH(\d+)$/)?.[1]}`;
      d = waves.includes(own) ? own : waves[0];
      waves.splice(waves.indexOf(d), 1);
    }
    // The HuC6280's noise rows on a target with a noise per channel: CH5's
    // on noise5 (another chip's noise row — the 2A03's on fc, beside the
    // 5B's — takes the target's noise below).
    else if (ch.kind === "noise" && dests.noises.length > 1 && / CH\d+ noise$/.test(ch.key)) {
      const own = `noise${ch.key.match(/CH(\d+) noise$/)?.[1]}`;
      d = dests.noises.includes(own) ? own : "drop";
    }
    else if (ch.kind === "noise") { d = noise ?? "drop"; noise = null; }
    else if (ch.kind === "pcm") d = dests.pcm.length ? "pcm1" : "drop";
    else if (ch.kind === "chip-pcm") d = dests.pcm.length ? "pcm" : "drop";
    // The ROM rhythm: each sound its own track, or the kit's, layered on pcm1.
    else if (ch.kind === "rhythm") d = dests.rhythm[ch.k] ?? dests.kit ?? "drop";
    else d = fm.shift() ?? sqr.shift() ?? "drop";
    dest[ch.key] = d;
  }
  // Two names on one physical channel (x68k's noise is fm8's fourth
  // operator): the FM channel keeps it, the noise is dropped.
  const fmVoices = new Set(Object.values(dest).filter((d) => dests.fm.includes(d)).map((d) => target.voiceKey(d)));
  for (const [k, d] of Object.entries(dest))
    if (d === dests.noise && fmVoices.has(target.voiceKey(d))) dest[k] = "drop";
  // A wave channel and its noise (the HuC6280's CH5 and CH5 noise): the
  // row with more notes keeps the channel.
  const count = new Map(a.channels.map((c) => [c.key, c.notes]));
  const byVoice = new Map();
  for (const [k, d] of Object.entries(dest)) {
    if (d === "drop" || !dests.noises.includes(d)) continue;
    const rival = Object.entries(dest).find(([k2, d2]) => k2 !== k && d2 !== "drop" && target.voiceKey(d2) === target.voiceKey(d));
    if (rival) byVoice.set(k, rival[0]);
  }
  for (const [k, r] of byVoice) if (dest[k] !== "drop" && dest[r] !== "drop") dest[(count.get(k) ?? 0) >= (count.get(r) ?? 0) ? r : k] = "drop";
  return { target: targetName, dest, followPitch: a.followPitch, loop: a.fileLoop,
    pcmVoices: Math.max(1, Math.min(3, a.pcmPoly ?? 1)) };
}

/**
 * @param options {dest: {channelKey: channel | "pcm" | "drop"}, followPitch,
 *                 loop, pcmVoices?, fileName?}
 */
export function vgmToMmlisp(parsed, options, a = analyzeVgm(parsed)) {
  const warnings = [];
  const target = targetProfile(options.target ?? "md");
  const dests = vgmDests(target.name);
  const keepDt2 = target.hasWord("FM_DT2_1");
  // A noise note as the target's noise says it: the SN76489's :mode, or the
  // song's :noise-rate (the SSG's, the OPM's — 125 kHz / rate on both). A
  // noise's frequency reads as the nearest of either, and a white mode as
  // the nearest rate (the readings a pc88 score gives a Mega Drive mode,
  // targets/pc88.js).
  const noisePart = dests.noise ? target.partOf(dests.noise) : null;
  const noiseRate = (base, hz) => `:noise-rate ${Math.max(1, Math.min(31, Math.round(base / hz)))}`;
  const noiseWord = (n) => {
    // A noise pitched by its notes (the PC Engine's) has no word to say.
    if (!noisePart || (!Object.keys(noisePart.modes ?? {}).length && !target.hasWord("NOISE_RATE"))) return null;
    if (Object.keys(noisePart.modes ?? {}).length) {
      // The chip's own mode where the part has it (white2 on md, white on
      // fc), else its kind at the nearest rate (the 2A03's periodic on md),
      // or its kind alone (md's white2 on fc).
      const kind = n.mode ? n.mode.replace(/\d+$/, "") : "white";
      const near = n.noiseHz ? nearestWhite(n.noiseHz) : 0;
      const mode = [n.mode, `${kind}${near}`, kind].find((m) => m && Object.hasOwn(noisePart.modes, m));
      return mode ? `:mode ${mode}` : null;
    }
    return n.noiseHz ? noiseRate(125000, n.noiseHz) : `:noise-rate ${NOISE_RATE_OF[n.mode] ?? 9}`;
  };
  // The SSG's: its noise rates divide its clock / 16, its hardware envelope
  // a target's with an SSG has.
  const ssgClock = ssgClockOf(target);
  const hasEnv = target.hasWord("SSG_ENV");
  const followPitch = options.followPitch ?? true;

  // Time, not beats: a tick is 1/240 s (150 BPM), a frame four. Notes sit
  // where the driver wrote them — a groove, a swing, a tempo of its own
  // timer kept as it plays, to 2 ms on a timer not of the frame — and are
  // as long as they sounded; the bars are marks a 4/4 bar apart.
  const tickOf = (t) => Math.max(0, Math.round(t / TICK));

  const dest = options.dest ?? {};
  const taken = new Set();
  // The file's loop, or (asked for, the file marking none) the whole song.
  const fileLoop = a.fileLoop;
  const loop = !!options.loop;
  const endTick0 = tickOf(parsed.totalSamples);
  const bars = barEnds([], Math.max(1, endTick0));
  const endTick = bars[bars.length - 1];
  // A driver marks its loop as it goes back, a moment off the notes the
  // loop starts with: the loop starts at the first of them within a frame
  // (else, a tick apart, the note before it strikes again at the top).
  const loopAt = () => {
    const near = (t) => t >= parsed.loopSample - FRAME / 2 && t <= parsed.loopSample + FRAME;
    const times = [
      ...[...parsed.events.values()].flatMap((evs) => evs.filter((e) => (e.kind === "on" || e.kind === "retrig") && near(e.t)).map((e) => e.t)),
      ...[parsed.rhythmHits, parsed.dacHits, parsed.pcmHits].flatMap((hs) => (hs ?? []).filter((h) => near(h.t)).map((h) => h.t)),
    ];
    return tickOf(times.length ? Math.min(...times) : parsed.loopSample);
  };
  const loopTick = !loop ? null : fileLoop ? loopAt() : 0;

  // Voices: a key per register set with the carriers relative to their loudest.
  const voices = new Map(); // key → {name, raw, base}
  let vn = 0;
  const voiceKey = (v) => {
    const car = CARRIERS[v.alg];
    const minTl = Math.min(...car.map((s) => v.ops[s].tl));
    const ops = v.ops.map((o, s) => ({ ...o, tl: car.includes(s) ? o.tl - minTl : o.tl, dt2: keepDt2 ? o.dt2 ?? 0 : 0 }));
    return { key: JSON.stringify({ alg: v.alg, fb: v.fb, ams: v.ams, fms: v.fms, ops }), minTl, ops };
  };
  // The SSG's mixer and hardware envelope on its tracks (`ssg`, from
  // ayChip), where the target has them: a note's :mode — tone, both, or env,
  // the buzzer — and its :env shape, the level the envelope's (the :vel of
  // the note before, so none is written under it). The rate is `:env-rate
  // note` where it follows the notes — a buzzer's own pitch, or a track
  // whose tone sets it from its period (four notes in five a whole number of
  // semitones off, a step at most: :env-semi, :env-detune) — else its cycle
  // in Hz. Elsewhere, what a target without it cannot play is said.
  const ssgState = (tracks) => {
    const shaped = tracks.filter((tr) => tr.notes.some((n) => n.ssg?.env != null));
    if (!hasEnv) {
      const lost = shaped.reduce((k, tr) => k + tr.notes.filter((n) => n.ssg?.env != null && n.ssg.mix !== "env").length, 0);
      return lost ? `the SSG's hardware envelope has no ${target.system} sound: ${lost} notes on it play at their level` : null;
    }
    const ep = (hz, shape) => Math.round(ssgClock / (envCycle(shape) * hz));
    const etHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
    const offNote = (n, semi = Math.round(12 * Math.log2(n.ssg.envHz / etHz(n.midi)))) =>
      ({ semi, detune: ep(n.ssg.envHz, n.ssg.env) - ep(etHz(n.midi) * 2 ** (semi / 12), n.ssg.env) });
    for (const tr of tracks) {
      const notes = tr.notes.filter((n) => n.ssg);
      // Only on an SSG channel: a row routed elsewhere (an FM one) keeps its notes plain.
      if (!notes.length || !target.partOf(tr.d)?.words?.("SSG_ENV")) continue;
      const modes = target.partOf(tr.d)?.modes ?? {};
      const anyMix = notes.some((n) => n.ssg.mix !== "tone");
      const anyEnv = notes.some((n) => n.ssg.env != null);
      // The tone notes' rate, read off their pitch where four in five agree.
      const toned = tr.d === dests.noise ? [] : notes.filter((n) => n.ssg.env != null && n.ssg.mix !== "env" && n.ssg.envHz > 0);
      let follow = null;
      if (toned.length >= 2 && new Set(toned.map((n) => ep(n.ssg.envHz, n.ssg.env))).size > 1) {
        const by = new Map();
        for (const o of toned.map((n) => offNote(n))) if (Math.abs(o.detune) <= 1 && Math.abs(o.semi) <= 48) by.set(o.semi, (by.get(o.semi) ?? 0) + 1);
        const [semi, k] = [...by].sort((x, y) => y[1] - x[1])[0] ?? [];
        if (k >= 0.8 * toned.length) follow = semi;
      }
      let vel = 15;
      for (const n of tr.notes) {
        const g = n.ssg;
        if (!g) continue;
        if (modes[g.mix] && anyMix) n.mode = `:mode ${g.mix}`;
        if (anyEnv) n.henv = g.env != null ? `:env ${g.env}` : ":env none";
        if (g.env == null) { vel = n.vel; continue; }
        n.vel = vel;
        if (!(g.envHz > 0)) continue;
        // A buzzer below the notes (C0) is a level moving, not a pitch: its Hz.
        const semi = g.mix === "env" ? (g.envHz >= 16.35 ? 0 : null) : follow;
        if (semi != null && tr.d !== dests.noise) {
          const o = offNote(n, semi);
          n.envRate = ":env-rate note";
          n.envSemi = `:env-semi ${o.semi}`;
          n.envDetune = `:env-detune ${o.detune}`;
        } else n.envRate = `:env-rate ${+g.envHz.toPrecision(4)}`;
      }
      // A rate the track writes moves by its :env-semi and :env-detune: where
      // its notes set them, its Hz notes put them back.
      if (tr.notes.some((n) => n.envSemi))
        for (const n of tr.notes) if (n.envRate && !n.envSemi) { n.envSemi = ":env-semi 0"; n.envDetune = ":env-detune 0"; }
    }
    return null;
  };
  // The song-wide values a note wants — the SSG's envelope rate and noise
  // period — as marks where due: in time order, a note writes one only
  // where the song's is not already what it wants (a track's `:env-rate
  // note` stays its own until another track writes a rate). Of notes on one
  // tick, the one the file set it for last (the score would take the later
  // track's). Not the tracks' state, which a block or a track's head
  // restates.
  const songWrites = (tracks, key) => {
    const due = tracks.flatMap((tr) => tr.notes.filter((n) => n[key]).map((n) => ({ n, tr })))
      .sort((x, y) => x.n.tick - y.n.tick || x.n.srcT - y.n.srcT);
    let song = null;
    let looped = loopTick == null;
    due.forEach(({ n, tr }, i) => {
      if (due[i + 1]?.n.tick === n.tick) return;
      // `(go top)` comes back with the end's value: the first due after the
      // loop point writes its own again.
      if (!looped && n.tick >= loopTick) { looped = true; song = null; }
      const want = n[key] === ":env-rate note" ? `note/${tr.d}` : n[key];
      if (want !== song) (tr.marks ??= []).push({ tick: n.tick, tokens: [n[key]] });
      song = want;
    });
  };
  const standIns = new Set();
  // The waves the wave channels play: one def-wave each, by its steps.
  const waveDefs = new Map(); // steps → name
  const waveName = (steps) => {
    const k = steps.join(" ");
    if (!waveDefs.has(k)) waveDefs.set(k, `wave-${String(waveDefs.size + 1).padStart(2, "0")}`);
    return waveDefs.get(k);
  };
  // The FDS's modulation tables: one def each, by its steps.
  const lfoDefs = new Map(); // steps → name
  const lfoName = (steps) => {
    const k = steps.join(" ");
    if (!lfoDefs.has(k)) lfoDefs.set(k, `lfo-${String(lfoDefs.size + 1).padStart(2, "0")}`);
    return lfoDefs.get(k);
  };
  // A wave moving under a note: a :wave macro of its frames, one def each.
  const waveMacs = new Map(); // steps → name
  const waveMacName = (steps) => {
    const k = steps.join(" ");
    if (!waveMacs.has(k)) waveMacs.set(k, `wmac-${String(waveMacs.size + 1).padStart(2, "0")}`);
    return waveMacs.get(k);
  };
  // A YM2413's voice on FM: its ROM voice by its built-in name, the VRC7's
  // ROM voices and a user voice as defs (chips/ym2413.js's 4-op reading).
  // On an OPLL part of the same ROM (fc's vrc7-fm for the VRC7) a ROM voice
  // is the part's own name, any other a 2-op def in the chip's words.
  const opllDefs = new Map(); // `${2op}/${bytes}` → {name, user, text}
  const opllVoice = ({ inst, vrc7, bytes }, part) => {
    const twoOp = !!part?.romNames;
    if (inst && twoOp && part.rom === (vrc7 ? VRC7_ROM : OPLL_ROM)) return part.romNames[inst - 1];
    if (inst && !twoOp && !vrc7) return OPLL_ROM_NAMES[inst - 1];
    const key = `${twoOp}/${bytes.join(",")}`;
    if (!opllDefs.has(key)) {
      const users = [...opllDefs.values()].filter((d) => d.user).length;
      const name = inst && !twoOp ? `vrc7-${inst}` : `opll-user-${String(users + 1).padStart(2, "0")}`;
      opllDefs.set(key, { name, user: name.startsWith("opll-user"), text: (twoOp ? opllVoiceDef2op : opllVoiceDef)(name, bytes) });
    }
    return opllDefs.get(key).name;
  };
  const tracks = [];
  for (const ch of vgmChannels(a, target.name)) {
    const d = dest[ch.key] ?? "drop";
    if (d === "drop" || ch.kind === "pcm" || ch.kind === "chip-pcm" || ch.kind === "rhythm") continue; // PCM, rhythm: below
    // One physical channel takes one row (x68k's noise is fm8's).
    const voice = target.voiceKey(d) ?? d;
    if (taken.has(voice)) { warnings.push(`${ch.key}: ${d} is already taken — dropped`); continue; }
    taken.add(voice);
    const onFm = d.startsWith("fm") || dests.fm.includes(d);
    // An SSG channel's notes on the noise alone: its own where the target's
    // channel mixes the noise, else the noise row's (not here).
    const ownNoise = !!target.partOf(d)?.modes?.noise;
    const envHere = !!target.partOf(d)?.words?.("SSG_ENV");
    const raw = channelNotes(parsed, ch.key, followPitch).filter((n) => ownNoise || ch.kind !== "psg" || n.ssg?.mix !== "noise");
    // A YM2151's FM8 noise: fm8's :mode noise where the target has it, else
    // the noise channel's (its notes dropped here).
    const opm = ch.kind === "opm";
    const fmNoise = opm && onFm && target.channels[d]?.modes?.noise;
    const noisy = opm && raw.some((n) => n.noiseHz);
    const notes = [];
    for (const n of raw) {
      if (opm && n.noiseHz && !fmNoise) continue;
      let tick = tickOf(n.t);
      const end = n.end === Infinity ? endTick : Math.min(endTick, tickOf(n.end));
      if (tick >= endTick) break;
      // On a machine whose driver plays a frame at a time (fc, msx, pce) a
      // note shorter than a frame — a length counter's blip — keys off in
      // the frame it keys on: it sounds its one frame.
      const minLen = target.frameClock ? Math.round(FRAME / TICK) : 1;
      const note = { tick, len: Math.max(minLen, end - tick),
        midi: Math.round(n.pitch), vel: n.vel,
        // Its cents off the semitone, to 5: the pitch it played (a chip's
        // tuning, a driver's table), as :pitch — not on a noise row.
        detune: d === dests.noise || dests.noises.includes(d) ? 0 : Math.round(((n.pitch - Math.round(n.pitch)) * 100) / 5) * 5, tieIn: n.slur, bend: n.bend, ssg: n.voice ? null : n.ssg ?? null, srcT: n.t };
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
      if (onFm && !n.voice && n.opll) voice = opllVoice(n.opll, target.partOf(d));
      else if (onFm && !n.voice) {
        voice = ch.key === "2A03 TRI" ? "wave-triangle" : STAND_IN[ch.kind] ?? "wave-square";
        standIns.add(voice);
      }
      note.stand = voice;
      // A wave channel's note names the wave it starts with; one rewritten
      // under it steps a frame at a time as a :wave macro (each frame the
      // wave mid-frame, to its last change).
      // (A 64-step wave, the FDS's, every other step on a 32-step chip, and
      // 32 steps where each is held twice.)
      if (dests.wave.includes(d) && n.wave) {
        const len = target.partOf(d)?.waveLen ?? 32;
        const fit = (w) => {
          while (w.length > 32 && (w.length > len || w.every((v, i) => i % 2 === 0 || v === w[i - 1]))) w = w.filter((_, i) => i % 2 === 0);
          return w;
        };
        const waveAt = (t) => { let w = n.wave; for (const [at, x] of n.waves) if (at <= t) w = x; return fit(w); };
        note.stand = waveName(waveAt(n.t));
        note.ownWave = true;
        const frames = Math.min(MAX_ENV, Math.max(1, Math.round((endT - n.t) / FRAME)));
        const steps = Array.from({ length: frames }, (_, f) => waveName(waveAt(n.t + (f + 0.5) * FRAME)));
        let last = 0;
        for (let f = 1; f < frames; f++) if (steps[f] !== steps[f - 1]) last = f;
        if (last > 0) {
          note.waveSteps = steps.slice(0, last + 1);
          note.waveMac = waveMacName(note.waveSteps);
        }
      }
      note.pan = (onFm || target.partOf(d)?.words?.("PAN")) && n.pan ? n.pan : null;
      note.mode = d === dests.noise ? noiseWord(n) : fmNoise && noisy ? `:mode ${n.noiseHz ? "noise" : "tone"}` : null;
      // The FDS's modulation, where the channel has its table (fc's wave1).
      // (A slur's part of the note: the depth in force where it starts.)
      if (target.partOf(d)?.lfoTable) {
        note.lfo = n.lfo;
        for (const [t, lfo] of n.lfos) if (t <= n.t) note.lfo = lfo;
        note.lfos = n.lfos.filter(([t]) => t > n.t && t < n.end);
      }
      // A pulse's duty, where the channel has one (fc's sqr1 / sqr2).
      note.duty = n.duty != null && target.partOf(d)?.words?.("DUTY") ? `:duty ${n.duty}` : null;
      // A noise whose note is its rate (fc's): another chip's noise at the
      // nearest of its rates.
      if (d === dests.noise && target.partOf(d)?.rateNote && n.noiseHz && !/^2A03/.test(ch.key)) note.midi = noiseNoteOfHz(n.noiseHz);
      note.rate = fmNoise && n.noiseHz ? noiseRate(125000, n.noiseHz) : null;
      // The SSG's noise period: the song's, written where due (songWrites).
      if (ownNoise && n.noiseHz && (n.ssg?.mix === "noise" || n.ssg?.mix === "both"))
        note.noiseRate = noiseRate(ssgClock / 16, n.noiseHz);
      // Two notes quantized onto one start: the later wins; an overlap is cut.
      const prev = notes[notes.length - 1];
      // On the hardware envelope a note the driver did not start it over for
      // (no R13 write) runs it on: a slur, where it follows on the shape
      // (the lengths pass keeps it one only where it runs into it).
      if (envHere && n.ssg?.env != null && !n.fresh && prev?.ssg?.env === n.ssg.env && prev.tick < tick) note.tieIn = true;
      // (Two within a tick: the one it replaces was the attack — its slur,
      // or none, is this one's.)
      if (prev && prev.tick >= tick) { note.tieIn = prev.tieIn; notes.pop(); }
      else if (prev && prev.tick + prev.len > tick) prev.len = tick - prev.tick;
      notes.push(note);
    }
    if (!notes.length) continue;
    // Pan only where it is ever off centre.
    if (notes.every((n) => !n.pan || n.pan === "center")) for (const n of notes) n.pan = null;
    tracks.push({ ch, d, notes });
  }

  const envWarn = ssgState(tracks);
  if (envWarn) warnings.push(envWarn);

  // A note slurred on into the next keeps its whole envelope; one a rest
  // follows is heard to its end (`silentAfter`).
  for (const tr of tracks)
    tr.notes.forEach((n, i) => {
      if (tr.notes[i + 1]?.tieIn) n.canRelease = false;
      n.silentAfter = !tr.notes[i + 1] || tr.notes[i + 1].tick > n.tick + n.len;
    });
  const envs = assignEnvelopes(tracks.flatMap((tr) => tr.notes));
  const bends = assignBends(tracks.flatMap((tr) => tr.notes));
  // A released note is keyed off where its release starts, to a quarter of
  // a step (its #rel plays on through the rest after it).
  for (const tr of tracks)
    for (const n of tr.notes) if (n.relFrame != null) n.len = Math.min(n.len, Math.max(1, Math.round((n.relFrame * FRAME) / TICK)));

  // Slurs first: one only stays one when its note runs into it.
  for (const tr of tracks) {
    for (let i = 0; i < tr.notes.length; i++) {
      const n = tr.notes[i];
      const next = i + 1 < tr.notes.length ? tr.notes[i + 1].tick : endTick;
      // (A note slurred on into the next runs into it.)
      if (next - (n.tick + n.len) > 0 && tr.notes[i + 1]?.tieIn) n.len = next - n.tick;
      if (n.tieIn && (i === 0 || tr.notes[i - 1].tick + tr.notes[i - 1].len !== n.tick)) n.tieIn = false;
    }
  }
  // The FDS's modulation depth moved under a note: the note tied on (`~`)
  // where it moved, the depth written there — its envelope one macro through
  // the tie, as the chip's.
  for (const tr of tracks) {
    tr.notes = tr.notes.flatMap((n) => {
      const out = [n];
      for (const [t, lfo] of n.lfos ?? []) {
        const prev = out[out.length - 1], k = tickOf(t), end = prev.tick + prev.len;
        // (Two moves within a tick: the later stands. One past the key-off,
        // in the release, is not written.)
        if (k <= prev.tick) { prev.lfo = lfo; continue; }
        if (k >= end || (lfo?.depth ?? 0) === (prev.lfo?.depth ?? 0)) continue;
        prev.len = k - prev.tick;
        out.push({ ...prev, tick: k, len: end - k, tieIn: true, lfoTie: true, lfo });
      }
      return out;
    });
  }
  // The DAC, to a PCM track: the data bank one wav, each sample a def that
  // slices it — so with DAC on, FM6 is not there to play.
  const dacDest = dest[DAC_KEY] ?? "drop";
  const dacOut = dests.pcm.length > 0 && dacDest !== "drop" && parsed.dacHits?.length ? dacTrack(parsed, dacDest, tickOf, endTick, options.fileName) : null;
  // The rhythm asked onto the kit: a voice more for the engine.
  const kitAsked = !!dests.kit && a.channels.some((c) => c.kind === "rhythm" && dest[c.key] === dests.kit);
  // SegaPCM / ADPCM: the channels kept, on as many voices as asked.
  const chipKeys = a.channels.filter((c) => c.kind === "chip-pcm" && (dest[c.key] ?? "drop") !== "drop").map((c) => c.key);
  // The Mega Drive's voices are its engine's 1-3; the X68000's PCM8 has eight.
  const dacMix = target.hasPart("dac");
  const maxVoices = dacMix ? 3 : dests.pcm.length;
  const pcmVoices = Math.max(1, Math.min(maxVoices, dacMix ? options.pcmVoices ?? Math.min(3, a.pcmPoly ?? 1) : a.pcmPoly ?? 1));
  const chipOut = dests.pcm.length > 0 && !dacOut && chipKeys.length
    ? chipPcmTracks(parsed, chipKeys, pcmVoices, tickOf, endTick, options.fileName,
      { bankFit: dacMix, pan: !!target.partOf(dests.pcm[0])?.words?.("PAN"), more: kitAsked ? 1 : 0,
        // A part whose level is the chip's own register (pc88's ADPCM-B, $0B):
        // the hit's level as :vol — not a mix's gain (the DAC's, PCM8's).
        absolute: !!target.partOf(dests.pcm[0])?.level?.steps }) : null;
  if (!dests.pcm.length && a.channels.some((c) => c.kind === "pcm" || c.kind === "chip-pcm"))
    warnings.push(`the ${target.system} has no PCM part yet — the PCM is left out`);
  if (dacOut && chipKeys.length) warnings.push("the YM2612 DAC takes the PCM channels — the other chips' PCM is left out");
  if (chipOut) warnings.push(...chipOut.warnings);
  // The YM2608's rhythm: the ROM's tracks, or the kit on a PCM track.
  // A ROM track takes one sound (a second row on it is dropped, as any
  // channel taken twice); the kit's sounds share its one track as layers,
  // which the DAC's or a PCM chip's tracks would play over.
  // With the DAC or a chip's PCM on the first voices, the kit takes the next
  // (as a mucom88 song's part G beside its K), while there is one.
  const pcmUsed = dacOut ? 1 : chipOut?.voices ?? 0;
  const kitVoice = dests.kit && pcmUsed < maxVoices ? `pcm${pcmUsed + 1}` : null;
  const rhythmRows = [];
  for (const c of a.channels) {
    const d = c.kind === "rhythm" ? dest[c.key] ?? "drop" : "drop";
    if (d === "drop") continue;
    const onRom = dests.rhythm.includes(d);
    if (!onRom && d !== dests.kit) { warnings.push(`${c.key}: ${d} cannot play it — dropped`); continue; }
    if (onRom && rhythmRows.some((r) => r.d === d)) { warnings.push(`${c.key}: ${d} is already taken — dropped`); continue; }
    if (!onRom && !kitVoice) { warnings.push(`${c.key}: the PCM takes every voice — the rhythm is left out`); continue; }
    rhythmRows.push({ k: c.k, d: onRom ? d : kitVoice });
  }
  const rhythmOut = rhythmRows.length ? rhythmTracks(parsed, rhythmRows, target, tickOf, endTick) : [];
  const kitRhythm = rhythmOut.length > 0 && !dests.rhythm.length;
  if (dacMix && (dacOut || chipOut || kitRhythm)) {
    const fm6 = tracks.findIndex((tr) => tr.d === "fm6");
    if (fm6 >= 0) { warnings.push(`${tracks[fm6].ch.key}: fm6 is the DAC in a score with PCM — dropped`); tracks.splice(fm6, 1); }
  }

  songWrites(tracks, "envRate");
  songWrites(tracks, "noiseRate");
  // Then levels and state, now that every voice's base is known. A slur
  // keeps the voice it slides on.
  // A track with any envelope states one for every note — `(macro :vel
  // none)` where there is none, since a macro stays until cleared.
  for (const tr of tracks) {
    let cur = { voice: null, wave: null, env: null, pitch: null, detune: null, pan: null, mode: null, rate: null,
      henv: null, envSemi: null, envDetune: null, duty: null, lfoWave: null, lfoFreq: null, lfoPmd: null };
    const anyDetune = tr.notes.some((n) => n.detune);
    const anyEnv = tr.notes.some((n) => n.envName);
    const anyWave = tr.notes.some((n) => n.waveMac);
    const anyBend = tr.notes.some((n) => n.bendName);
    const anyLfo = tr.notes.some((n) => n.lfo);
    for (const n of tr.notes) {
      if (n.voiceRec) n.vel = Math.max(0, Math.min(15, Math.round(15 - ((n.minTl - n.voiceRec.base) * 0.75) / 2)));
      const lfoSt = {
        lfoWave: n.lfo ? `:lfo-wave ${lfoName(n.lfo.table)}` : cur.lfoWave,
        lfoFreq: n.lfo ? `:lfo-freq ${n.lfo.freq}` : cur.lfoFreq,
        lfoPmd: anyLfo ? `:lfo-pmd ${n.lfo?.depth ?? 0}` : null,
      };
      // (A tie the modulation moved at says its depth, nothing else.)
      const st = n.lfoTie ? { ...cur, ...lfoSt } : {
        // (A wave channel's slur names the wave it goes on with.)
        voice: n.tieIn && cur.voice && !n.ownWave ? cur.voice : n.voiceRec ? n.voiceRec.name : n.stand,
        wave: n.waveMac ?? (anyWave ? WAVE_NONE : null),
        env: n.envName ?? (anyEnv ? ENV_NONE : null),
        pitch: n.bendName ?? (anyBend ? PITCH_NONE : null),
        // (After the bend: a bend's macro writes the offset itself, the
        // detune within it.)
        detune: anyDetune ? `:pitch ${n.detune}` : null,
        pan: n.pan ? `:pan ${n.pan}` : null,
        mode: n.mode,
        // fm8's noise period, the one in force on its tone notes too.
        rate: n.rate ?? cur.rate,
        // The SSG's hardware envelope: its shape and the track's moves on the
        // rate. The rate is the song's, written where ssgState says — not a
        // track's state for a block to restate.
        henv: n.henv ?? cur.henv,
        envSemi: n.envSemi ?? cur.envSemi,
        envDetune: n.envDetune ?? cur.envDetune,
        duty: n.duty ?? cur.duty,
        // The FDS's modulation: its table and rate where it runs, its depth
        // 0 where it does not.
        ...lfoSt,
      };
      n.pre = [];
      for (const k of ["voice", "wave", "env", "pitch", "detune", "pan", "mode", "rate", "henv", "envSemi", "envDetune", "duty", "lfoWave", "lfoFreq", "lfoPmd"])
        // (The FDS's table again where the note starts its counter over.)
        if (st[k] && (st[k] !== cur[k] || (k === "lfoWave" && n.lfo?.reset))) n.pre.push(st[k]);
      if (n.lfo?.reset && st.lfoWave) n.again = [st.lfoWave];
      // Nothing to clear before the first envelope, wave macro or bend, nor to move.
      if (cur.env == null && st.env === ENV_NONE) n.pre = n.pre.filter((t) => t !== ENV_NONE);
      if (cur.wave == null && st.wave === WAVE_NONE) n.pre = n.pre.filter((t) => t !== WAVE_NONE);
      if (cur.henv == null && st.henv === ":env none") n.pre = n.pre.filter((t) => t !== ":env none");
      for (const z of [":env-semi 0", ":env-detune 0"])
        if (n.pre.includes(z) && cur[z.startsWith(":env-semi") ? "envSemi" : "envDetune"] == null) n.pre = n.pre.filter((t) => t !== z);
      if (cur.pitch == null && st.pitch === PITCH_NONE) n.pre = n.pre.filter((t) => t !== PITCH_NONE);
      if (cur.detune == null && st.detune === ":pitch 0") n.pre = n.pre.filter((t) => t !== ":pitch 0");
      n.state = [st.voice, st.wave, st.env, st.pitch, st.detune, st.pan, st.mode, st.rate, st.henv, st.envSemi, st.envDetune, st.duty,
        st.lfoWave, st.lfoFreq, st.lfoPmd].filter(Boolean);
      // (A wave macro leaves the channel on its last step, a bend the offset
      // on its last: the next note names its own again.)
      cur = { ...st, ...(n.waveSteps ? { voice: n.waveSteps[n.waveSteps.length - 1] } : {}), ...(n.bendName ? { detune: "" } : {}) };
    }
  }

  const order = [...dests.fm, ...dests.psg, ...dests.wave, ...dests.noises, dests.noise];
  tracks.sort((x, y) => order.indexOf(x.d) - order.indexOf(y.d));
  const out = tracks.map((tr) => {
    const { d, notes } = tr;
    const head = notes[0].pre;
    notes[0] = { ...notes[0], pre: undefined };
    // A channel with no level (fc's triangle, `noLevel`): its notes say no :vel.
    return { channel: d, head, notes, marks: tr.marks ?? [], noVel: !!target.partOf(d)?.noLevel };
  });
  if (dacOut) out.push(dacOut.track);
  if (chipOut) out.push(...chipOut.tracks);
  out.push(...rhythmOut);
  if (out.length) out[0].marks.push({ tick: 0, tokens: [`:tempo ${BPM}`] });
  else warnings.push("no notes to import");

  if (parsed.dac && !parsed.dacHits?.length) warnings.push("YM2612 DAC written directly (not from a data bank) is not imported");
  warnings.push(...parsed.clockNotes);
  for (const [k, n] of parsed.skipped) warnings.push(`${k} skipped (${n}×)`);

  const header = [`; Imported from ${options.fileName ?? "a VGM file"} (VGM: ${parsed.chips.join(", ")})`];
  const title = [parsed.title, parsed.game && parsed.title ? `(${parsed.game})` : parsed.game].filter(Boolean).join(" ");
  const score = [target.name !== "md" && `:target ${target.name}`, title && `:title ${qstr(title)}`, parsed.author && `:composer ${qstr(parsed.author)}`,
    dacMix && (dacOut || chipOut || kitRhythm) && `:pcm-voices ${pcmUsed + (kitRhythm ? 1 : 0)}`].filter(Boolean);
  if (score.length) header.push(`(def-score ${score.join(" ")})`);
  if (standIns.size) header.push('(import "presets/waveforms/set.mmlisp")');
  if (opllDefs.size) header.push("", ...[...opllDefs.values()].map((d) => d.text));
  // The rhythm's kit: its samples on md; on pc88 the stand-in for a ROM the
  // user has not loaded (language.md §19).
  if (rhythmOut.length)
    header.push(`(import ${qstr(RHYTHM_KIT)})  ; ${kitRhythm ? "the YM2608 rhythm on the RX5 kit" : "the rhythm's sounds without a rhythm ROM (File > Import > YM2608 Rhythm ROM…)"}`);
  if (waveDefs.size) header.push("", ...[...waveDefs].map(([steps, name]) => `(def-wave ${name} :wave [${steps}])`));
  if (waveMacs.size) header.push("", ...[...waveMacs].map(([steps, name]) => `(def ${name} (macro :wave [${steps}]))`));
  if (lfoDefs.size) header.push("", ...[...lfoDefs].map(([steps, name]) => `(def ${name} [${steps}])`));
  if (envs.length) header.push("", ...envs);
  if (bends.length) header.push("", ...bends);
  if (dacOut) header.push("", ...dacOut.defs);
  if (chipOut) header.push("", ...chipOut.defs);
  for (const rec of voices.values()) {
    const car = CARRIERS[rec.v.alg];
    const ops = rec.ops.map((o, s) => (car.includes(s) ? { ...o, tl: Math.min(127, o.tl + rec.base) } : o));
    header.push("", fmVoiceDef(rec.name, { alg: rec.v.alg, fb: rec.v.fb, ams: rec.v.ams, fms: rec.v.fms, ops }, { dt2: keepDt2 }));
  }
  const song = { header, bars, endTick, loopTick, tracks: out };
  const pcm = dacOut?.pcm ?? chipOut?.pcm ?? null;
  if (options.structure === false) return { source: emitSong(song), warnings, pcm };
  return { source: emitStructured(song), warnings, pcm };
}

// ── The YM2608's rhythm ───────────────────────────────────────────────────

const RHYTHM_KEY = "YM2608 rhythm";
const RHYTHM_ROM = Object.values(rhythmRom.kit).map((s) => s.toUpperCase()); // BD SD TOP HH TOM RIM, the key bits' order

/**
 * The rhythm's rows → tracks, each sound under its kit role (rhythmRom.kit,
 * in key-bit order). On a target with the ROM rhythm (pc88) a sound is a
 * rhythm track of its own, its level absolute — the IL takes vel + vol +
 * master, as the chip's total and own level did — and its pan the hit's.
 * Elsewhere the sounds are the RX5 kit's samples on one PCM track, as the
 * mucom importer plays part G (RHYTHM_SOUNDS): :prio layers, a hit dropped
 * while a higher one rings (its :gate), levels against the loudest hit.
 * `rows`: [{k, d}].
 */
function rhythmTracks(parsed, rows, target, tickOf, endTick) {
  const roles = Object.keys(rhythmRom.kit);
  const rom = target.hasPart("rhythm");
  const keyed = new Set(rows.map((r) => r.k));
  const hits = parsed.rhythmHits.filter((h) => keyed.has(h.k));
  const loudest = hits.reduce((m, h) => Math.min(m, h.db), Infinity);
  const tracks = [];
  for (const { k, d } of rows) {
    const s = RHYTHM_SOUNDS[k];
    const notes = [];
    for (const h of hits) {
      if (h.k !== k) continue;
      const tick = tickOf(h.t);
      if (tick >= endTick) break;
      const vel = Math.max(rom ? 0 : 1, Math.min(15, Math.round(15 - (rom ? h.db : h.db - loudest) / VEL_DB_PER_STEP)));
      const prev = notes[notes.length - 1];
      if (prev && prev.tick >= tick) notes.pop(); // two on one step: the later
      notes.push({ tick, len: 1, midi: 60, vel, pan: h.pan });
    }
    if (!notes.length) continue;
    // A hit plays out whatever its length: each lasts to the next.
    notes.forEach((n, i) => { n.len = Math.max(1, (notes[i + 1]?.tick ?? endTick) - n.tick); });
    const panned = rom && notes.some((n) => n.pan !== "center");
    const gate = rom ? null : ringGate(s, BPM);
    const state = (n) => [roles[k], gate, panned && `:pan ${n.pan}`].filter(Boolean);
    let cur = null;
    for (const n of notes) {
      n.state = state(n);
      n.pre = n.state.filter((t, i) => cur?.[i] !== t);
      cur = n.state;
    }
    const head = notes[0].pre;
    notes[0] = { ...notes[0], pre: undefined };
    tracks.push({ channel: d, open: rom ? [] : [`:prio ${s.prio}`], head, notes, marks: [] });
  }
  return tracks;
}

// ── The DAC ───────────────────────────────────────────────────────────────

const DAC_KEY = "YM2612 DAC";
const DAC_SAME = 64; // bytes: seeks this close start one sample (8 ms at 8 kHz)

/**
 * The DAC's hits → a PCM track. The data bank (8-bit unsigned) becomes one
 * wav; each place a hit starts from is a sample — `(def-pcm dac-NN :offset
 * … :frames …)`, running to where the next one starts or as far as it is
 * played (trailing silence cut), at the rate most of its hits go: its
 * `:rate`, the C4 the notes play from. A hit at another rate is that many
 * semitones off it (under half of one is none).
 */
function dacTrack(parsed, channel, tickOf, endTick, fileName) {
  const { dacBank: bank, dacHits: hitsIn } = parsed;
  // A hit seeking a few bytes into a sample (a driver a byte late, Aa
  // Harimanada's) is that sample's, not a sample of its own — which would
  // cut the one before it to those few bytes.
  const near = new Map();
  for (const o of [...new Set(hitsIn.map((h) => h.offset))].sort((a, b) => a - b)) {
    const prev = [...near.values()].pop();
    near.set(o, prev != null && o - prev < DAC_SAME ? prev : o);
  }
  const hits = hitsIn.map((h) => (near.get(h.offset) === h.offset ? h : { ...h, offset: near.get(h.offset) }));
  const starts = [...new Set(hits.map((h) => h.offset))].sort((a, b) => a - b);
  const base = String(fileName || "vgm").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const wavFile = `${base}-dac.wav`;
  const samples = new Map();
  const byOffset = new Map();
  for (const h of hits) {
    if (!byOffset.has(h.offset)) byOffset.set(h.offset, []);
    byOffset.get(h.offset).push(h);
  }
  starts.forEach((offset, i) => {
    const mine = byOffset.get(offset);
    const limit = (starts[i + 1] ?? bank.length) - offset;
    let frames = Math.min(limit, Math.max(...mine.map((h) => h.bytes)));
    while (frames > 1 && Math.abs(bank[offset + frames - 1] - 128) <= 2) frames--;
    // The rate most of its hits go, to a percent.
    const count = new Map();
    for (const h of mine) { const r = Math.round(h.rate / 50) * 50; count.set(r, (count.get(r) ?? 0) + 1); }
    const rate = [...count].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const name = `dac-${String(i + 1).padStart(2, "0")}`;
    samples.set(offset, { name, offset, frames, rate });
  });
  const notes = [];
  for (const h of hits) {
    const sm = samples.get(h.offset);
    const tick = tickOf(h.t);
    if (tick >= endTick) break;
    const end = Math.min(endTick, tickOf(h.t + (Math.min(h.bytes, sm.frames) / h.rate) * RATE));
    const semis = Math.round(12 * Math.log2(h.rate / sm.rate));
    const note = { tick, len: Math.max(1, end - tick), midi: 60 + semis, vel: 15, state: [sm.name] };
    // One DAC: a hit cuts the one before; two on one tick, the later wins.
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

// ── PCM chips with a sample ROM of their own ──────────────────────────────

const SEGA_ROM = 0x80, ADPCMB_RAM = 0x81, ADPCMA_ROM = 0x82, ADPCMB_ROM = 0x83;
const OPNA_RAM = 0x40000; // the YM2608's ADPCM RAM, 256 KB
const BLOB_MAX = 32512; // a baked blob's bytes, below a bank's silence page (pcm-multibank.md)
const dbOf = (v, full) => (v > 0 ? 20 * Math.log10(v / full) : -96);

/**
 * SegaPCM and the YM2610's ADPCM-A / ADPCM-B, as far as an import needs
 * them: each key-on is a hit {t, src, ch, rom, start, end, loopStart, rate,
 * db, pan, off} — `start`/`end` byte offsets into the ROM, `rate` the
 * frames a second it plays at, `db` its level (0 = full), `off` when it
 * stopped (a key-off, or the channel's next hit). Levels and pitch moved
 * during a hit are not followed.
 */
function pcmChips({ segaClock, segaIntf, opnbClock, opnaClock, ramWrite }) {
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
    sega, opnb, opna, start, stop,
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
        const frames = (h.end - h.start) * framesPerByte(h.src);
        const natural = h.loopStart != null ? Infinity : h.t + (frames / h.rate) * RATE;
        h.endT = Math.min(natural, h.off ?? Infinity, endT);
        if (h.endT > h.t) out.push(h);
      }
      return out.sort((x, y) => x.t - y.t);
    },
  };
}

// ADPCM-A: 4-bit, a 12-bit accumulator that wraps, high nibble first; the
// state starts over at each sample (MAME ymadpcm's table).
const ADPCMA_STEPS = [16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552];
const ADPCMA_INC = [-1, -1, -1, -1, 2, 5, 7, 9];
function decodeAdpcmA(rom, start, length) {
  const out = new Float32Array(length * 2);
  let acc = 0, step = 0, o = 0;
  for (let i = 0; i < length; i++) {
    const byte = rom[start + i];
    for (const nib of [byte >> 4, byte & 15]) {
      const mag = (((nib & 7) * 2 + 1) * ADPCMA_STEPS[step]) >> 3;
      acc = (acc + (nib & 8 ? -mag : mag)) & 0xfff;
      step = Math.max(0, Math.min(48, step + ADPCMA_INC[nib & 7]));
      out[o++] = (acc & 0x800 ? acc - 0x1000 : acc) / 2048;
    }
  }
  return out;
}

// OKI ADPCM (the OKIM6258's): 4-bit, a 12-bit signal that saturates, low
// nibble first; a play command starts the state over (MAME okim6258).
const OKI_DIFF = (() => {
  const t = new Int16Array(49 * 16);
  for (let step = 0; step < 49; step++) {
    const v = Math.floor(16 * Math.pow(11 / 10, step));
    for (let nib = 0; nib < 16; nib++)
      t[step * 16 + nib] = (nib & 8 ? -1 : 1) * ((nib & 4 ? v : 0) + (nib & 2 ? v >> 1 : 0) + (nib & 1 ? v >> 2 : 0) + (v >> 3));
  }
  return t;
})();
const OKI_INC = [-1, -1, -1, -1, 2, 4, 6, 8];
export function decodeOki(rom, start, length) {
  const out = new Float32Array(length * 2);
  let signal = -2, step = 0, o = 0;
  for (let i = 0; i < length; i++) {
    const byte = rom[start + i];
    for (const nib of [byte & 15, byte >> 4]) {
      signal = Math.max(-2048, Math.min(2047, signal + OKI_DIFF[step * 16 + nib]));
      step = Math.max(0, Math.min(48, step + OKI_INC[nib & 7]));
      out[o++] = signal / 2048;
    }
  }
  return out;
}

// The X68000's ADPCM without its DC: a 20 Hz high-pass, as an output's
// coupling would take it out (the cutoff is ours, not the machine's
// measured one). A song's driver keeps the chip playing from sample to
// sample, so its signal runs on and drifts (an encoder's bias, to the
// 12-bit rail); a sample decoded from the state a play starts in carries
// that drift as DC, a step where the next sample cuts in.
function dcBlock(x, rate) {
  const r = Math.exp((-2 * Math.PI * 20) / rate);
  const out = new Float32Array(x.length);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) { py = x[i] - px + r * py; px = x[i]; out[i] = py; }
  return out;
}

const PCM_SOURCES = { SegaPCM: "sega", "ADPCM-A": "pcma", "ADPCM-B": "pcmb", OKIM6258: "oki", DPCM: "dpcm" };
// A ROM byte's frames: SegaPCM's 8 bits one, the ADPCMs' two nibbles two, the DMC's eight bits eight.
const framesPerByte = (src) => (src === "SegaPCM" ? 1 : src === "DPCM" ? 8 : 2);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pcmKey = (h) => (h.src === "ADPCM-B" || h.src === "OKIM6258" || h.src === "DPCM" ? h.src : `${h.src} ${h.ch + 1}`);

// The DMC's 1-bit delta: each bit moves the 7-bit DAC two up or down (up
// below 126, down above 1) from where $4011 left it.
function decodeDpcm(rom, start, length, dac) {
  const out = new Float32Array(length * 8);
  let o = 0;
  for (let i = 0; i < length; i++) {
    const byte = rom[start + i];
    for (let b = 0; b < 8; b++) {
      if ((byte >> b) & 1) { if (dac <= 125) dac += 2; } else if (dac >= 2) dac -= 2;
      out[o++] = (dac - 64) / 64;
    }
  }
  return out;
}

/** The most hits sounding at once. */
function pcmPolyphony(hits) {
  const edges = hits.flatMap((h) => [[h.t, 1], [h.endT, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, most = 0;
  for (const [, d] of edges) { n += d; most = Math.max(most, n); }
  return most;
}

/**
 * The chip PCM hits of the channels kept → tracks on pcm1..pcmN. Each place
 * a hit starts from is a sample, decoded into one wav (`(def-pcm …
 * :offset … :frames …)`) at the rate most of its hits go; a hit at another
 * rate is that many semitones off it. With as many voices as channels kept,
 * a channel is a track; with fewer, each hit takes a free voice (the one its
 * channel last used, if free) or the voice whose sound began longest ago —
 * never an ADPCM-B note, the one melodic part — and a hit with nothing to
 * take is dropped. Levels are the song's own, the loudest hit :vel 15.
 */
function chipPcmTracks(parsed, keys, voices, tickOf, endTick, fileName, { bankFit = true, pan = false, more = 0, absolute = false } = {}) {
  const warnings = [];
  const kept = new Set(keys);
  const hits = parsed.pcmHits.filter((h) => kept.has(pcmKey(h)) && tickOf(h.t) < endTick);
  if (!hits.length) return null;

  // Samples: one per ROM range played, decoded once.
  const samples = new Map();
  const count = { sega: 0, pcma: 0, pcmb: 0, oki: 0, dpcm: 0 };
  // A hit that carries its bytes (the DMC's, the memory as it stood) is the
  // sample those bytes are.
  const hashOf = (u8) => { let h = 2166136261; for (const b of u8) h = Math.imul(h ^ b, 16777619); return (h >>> 0).toString(16); };
  for (const h of hits) {
    const id = h.bytes ? `${h.src}:${hashOf(h.bytes)}:${h.end}:${h.loopStart ?? ""}` : `${h.rom}:${h.start}:${h.end}:${h.loopStart ?? ""}`;
    if (!samples.has(id)) {
      const prefix = PCM_SOURCES[h.src];
      samples.set(id, { name: `${prefix}-${String(++count[prefix]).padStart(2, "0")}`, h, rates: new Map() });
    }
    const sm = samples.get(id);
    const r = Math.round(h.rate);
    sm.rates.set(r, (sm.rates.get(r) ?? 0) + 1);
    h.sample = sm;
  }
  const chunks = [];
  let offset = 0;
  for (const sm of samples.values()) {
    const { h } = sm;
    const rom = h.bytes ?? parsed.pcmRoms.get(h.rom);
    let data = h.src === "SegaPCM" ? Float32Array.from(rom.subarray(h.start, h.end), (v) => (v - 128) / 128)
      : h.src === "DPCM" ? decodeDpcm(rom, h.start, h.end - h.start, h.dac0 ?? 64)
      : h.src === "ADPCM-A" ? decodeAdpcmA(rom, h.start, h.end - h.start)
      : h.src === "OKIM6258" ? dcBlock(decodeOki(rom, h.start, h.end - h.start), h.rate) : decodeAdpcmB(rom, h.start, h.end - h.start);
    let frames = data.length;
    if (h.loopStart == null) while (frames > 1 && Math.abs(data[frames - 1]) < 1 / 256) frames--;
    data = data.subarray(0, frames);
    sm.rate = [...sm.rates].reduce((x, y) => (y[1] > x[1] ? y : x))[0];
    sm.offset = offset;
    sm.frames = frames;
    sm.loopMs = h.loopStart == null ? null : Math.round(((h.loopStart - h.start) * framesPerByte(h.src) * 1000) / sm.rate);
    chunks.push(data);
    offset += frames;
  }

  // Levels: the loudest hit is :vel 15, the rest keep their distance on the
  // 2 dB ladder.
  // On a chip's own ADPCM-B the level is the register's — :vel 15 and the
  // fader, :vol's 2 dB steps, as the mucom importer writes part K's.
  const top = hits.reduce((m, h) => Math.max(m, h.db), -Infinity);
  // (The DMC has no level register: its hits are all at full, no :vol to say.)
  if (hits.every((h) => h.src === "DPCM")) absolute = false;
  const velOf = (h) => (absolute ? 15 : Math.max(0, Math.min(15, 15 + Math.round((h.db - top) / VEL_DB_PER_STEP))));
  const volOf = (h) => (h.db <= -60 ? 0 : Math.max(1, Math.min(31, 31 + Math.round(h.db / 2))));

  // Voices.
  const fixed = keys.length <= voices ? new Map(keys.map((k, i) => [k, i])) : null;
  const state = Array.from({ length: voices }, () => ({ until: -1, from: -1, melodic: false, key: null }));
  const lanes = Array.from({ length: voices }, () => []);
  let stolen = 0, dropped = 0;
  for (const h of hits) {
    const tick = tickOf(h.t);
    const key = pcmKey(h);
    const until = Math.max(tick + 1, h.endT === Infinity ? endTick : tickOf(h.endT));
    let v;
    if (fixed) v = fixed.get(key);
    else if ((v = state.findIndex((s) => s.key === key && s.from === tick)) >= 0) {
      // its channel's hit on the same step: the later wins
    } else {
      const free = state.map((s, i) => i).filter((i) => state[i].until <= tick);
      v = free.find((i) => state[i].key === key) ?? free[0];
      if (v == null) {
        const takeable = state.map((s, i) => i).filter((i) => !state[i].melodic);
        if (!takeable.length) { dropped++; continue; }
        v = takeable.reduce((x, y) => (state[y].from < state[x].from ? y : x));
        stolen++;
      }
    }
    const lane = lanes[v];
    const prev = lane[lane.length - 1];
    if (prev && prev.tick >= tick) lane.pop(); // two on one step: the later wins
    const sm = h.sample;
    const loop = h.loopStart != null;
    lane.push({ tick, len: until - tick, loop, midi: 60 + Math.round(12 * Math.log2(h.rate / sm.rate)), vel: velOf(h),
      side: h.side ?? "center", state: [sm.name, ...(loop ? [":mode loop"] : []), ...(absolute ? [`:vol ${volOf(h)}`] : [])] });
    Object.assign(state[v], { until, from: tick, melodic: h.src === "ADPCM-B", key });
  }
  if (stolen) warnings.push(`PCM: ${plural(stolen, "hit")} cut an earlier sound short — more rang at once than the score's ${plural(voices, "voice")}`);
  if (dropped) warnings.push(`PCM: ${plural(dropped, "hit")} dropped — every voice held a note that is not cut`);
  // A part with a pan (pc88's ADPCM-B) takes each hit's; the DAC is one channel.
  const panned = pan && hits.some((h) => h.side && h.side !== "center");
  if (!pan && hits.some((h) => h.pan)) warnings.push("PCM: pan is not imported — the DAC is one channel");

  const tracks = [];
  lanes.forEach((notes, i) => {
    if (!notes.length) return;
    const anyLoop = notes.some((n) => n.loop);
    // A shot plays out whatever its length, so it lasts to the next note on
    // its voice and the track reads in steps; a loop is held as long as it
    // rang.
    notes.forEach((n, k) => {
      const next = notes[k + 1]?.tick ?? endTick;
      n.len = Math.max(1, n.loop ? Math.min(n.len, next - n.tick) : next - n.tick);
      if (anyLoop && !n.loop) n.state = [...n.state, ":mode shot"];
      if (panned) n.state = [...n.state, `:pan ${n.side}`];
    });
    let cur = null;
    for (const n of notes) {
      const st = n.state.join(" ");
      if (st !== cur) n.pre = n.state;
      cur = st;
    }
    const head = notes[0].pre ?? [];
    notes[0] = { ...notes[0], pre: undefined };
    tracks.push({ channel: `pcm${i + 1}`, head, notes, marks: [] });
  });

  // A note bakes one blob at the engine's rate, and a blob must fit one
  // 32 KB bank: a sample longer than that at the lowest pitch it plays is
  // cut to fit. (Not on the X68000: its PCM8 plays the sample as it is.)
  const V = tracks.length ? Math.max(...tracks.map((t) => +t.channel.slice(3))) : voices;
  if (bankFit) {
    // (`more`: voices the score plays beside these — the rhythm's kit.)
    const engineVoices = Math.min(3, V + more);
    const engineHz = Math.max(engineImage(engineVoices).rateHz, bankedEngineImage(engineVoices, 60).rateHz);
    const lowest = new Map();
    for (const h of hits) lowest.set(h.sample, Math.min(lowest.get(h.sample) ?? Infinity, h.rate));
    const cut = [];
    for (const sm of samples.values()) {
      const most = Math.floor(((BLOB_MAX - 16) * lowest.get(sm)) / engineHz);
      if (sm.frames > most) { sm.frames = most; cut.push(sm.name); }
      if (sm.loopMs != null && (sm.loopMs * sm.rate) / 1000 >= sm.frames) sm.loopMs = null;
    }
    if (cut.length) warnings.push(`PCM: ${cut.join(", ")} cut to fit a 32 KB bank at ${plural(engineVoices, "voice")}`);
  }

  const base = String(fileName || "vgm").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const wavFile = `${base}-pcm.wav`;
  // One gain for the song: its loudest sample reaches full scale (an OKI's
  // 12-bit signal rarely nears it), and the samples keep their balance.
  const mono = new Float32Array(offset);
  { let o = 0; for (const c of chunks) { mono.set(c, o); o += c.length; } }
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  if (peak > 0 && peak < 0.99) { const gain = 1 / peak; for (let i = 0; i < mono.length; i++) mono[i] *= gain; }
  const list = [...samples.values()];
  const wavRate = list[0]?.rate ?? 8000;
  const defs = list.map((sm) => `(def-pcm ${sm.name} :file ${qstr(wavFile)} :rate ${sm.rate} :offset ${sm.offset} :frames ${sm.frames}` +
    (sm.loopMs != null ? ` :loop-start ${sm.loopMs}ms` : "") + ")");
  return {
    tracks, defs, voices: V, warnings,
    pcm: { wavFile, rate: wavRate, mono, wav: encodeWav(mono, null, wavRate),
      entries: list.map((sm) => ({ name: sm.name, offset: sm.offset, frames: sm.frames, rate: sm.rate })), tag: "VGM" },
  };
}
