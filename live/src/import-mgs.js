// ---------------------------------------------------------------------------
// MGS (.mgs) → MMLisp, :target msx
//
// MGS is MGSDRV's compiled song for the MSX (v3.xx, as MGSC writes it, or
// MGSARC's compressed form): eighteen tracks — 0 the definitions (@e / @r
// envelopes, @s SCC waves, @v OPLL voices), 1-3 the PSG, 4-8 the SCC, 9-17
// the FM-PAC (15 the rhythm in #opll_mode 1). Notes are timed in steps, 48 a
// quarter (a frame each at t75, the legacy MGS's lengths), so a step is two
// MMLisp ticks and the import is exact. The tracks are played as MGSDRV
// plays them (the format: digital-sound-antiques/mgsc, mgs-format.md; the
// decompiler mgsrc-js) — repeats unrolled, each to its own loop (`$`, or a
// `[ … ]0`) or its end — and written by the shared back end
// (import-song.js), which folds the repeats again.
//
// What maps (MGSC 1.11's MML reference, MGSC111.TXT, for what each command
// means):
//   PSG 1-3         sqr1-sqr3; `/` (and the mode an @ sets) the mixer as
//                   :mode tone | noise | both, `n` the song's :noise-rate;
//                   `s` the hardware envelope's shape, :env, which `v`
//                   turns off (as MGSC's reference has it; not yet held to
//                   MGSDRV), `m` its period, the song's :env-rate
//   SCC 4-8         wave1-wave5; `@n` the @s wave, a def-wave
//   FM 9-17         fm1-fm9 (fm1-fm6 in #opll_mode 1); `@n` ROM voice n + 1
//                   for @0-@14 (as @# assigns them), else the @v voice, a
//                   def-fm on the OPLL's words; so / sf :sus; `/` and q0
//                   key off and hold
//   v, v+ / v-      :vol — the SSG's and the OPLL's 3 dB steps, the SCC's
//                   linear volume; 0 to start
//   @n, @e / @r     a tone's envelope (the @e or @r of its number; @e<n>
//                   puts another in), a :vol macro frame by frame: `n` a
//                   level a count, `n:c` held c counts, `n=c` moved to over
//                   c counts, `[ ]` the sustain loop, `\` pitch steps; @r's
//                   RR, or k on the PSG and the SCC, its release
//   q, &            q as :gate* n/8, the note its full length; & legato
//   \ / @\          :pitch — on the PSG and the SCC an offset on the
//                   octave-1 period (+ up; 128 about a semitone), on FM on
//                   MGSDRV's F-numbers (@\ 255 a semitone)
//   h, ho / hf, @p  the software LFO as a :pitch+ triangle
//   _, p            a portamento from the base note, p's fall: :pitch+ lines
//   t, #tempo       :tempo (BPM)
//   FM rhythm       (track 15 in #opll_mode 1) rhythm1-rhythm5, a track a
//                   sound — b s m c h as kick snare tom4 ride hat — each hit
//                   ringing to the sound's next (kf: keyed off, :mode gate,
//                   at the next of any); v and vb … vh its :vol
//   y               on FM the user voice's registers ($00-$07) as the
//                   OPLL's words after the @v voice; on the PSG the mixer
//                   ($07) and the noise ($06); on the rhythm its levels
//                   ($36-$38) and tunings ($16-$18, $26-$28, a hit's note,
//                   c4 the datasheet's); any other is reported
// Not yet: whatever else the file holds is counted and reported.
//
// Where the reference leaves the numbers open, they were measured on MGSDRV
// itself (libkss-js runs it; tools/scripts/ab-mgsdrv.mjs compares an import
// with it frame by frame): the SCC and FM an octave below the PSG for one
// `o`; a whole note floor(14400 / t) frames; an @e's levels added to v (15
// is v) and `n=c` stopping a step short; @r's level (E × (v + 1)) >> 8; k a
// level step every k frames; `\` on the period the octave plays, @\ and @p
// on the octave-1 one; FM's F-numbers kept in 172-344 by ±173 and a block;
// p's fall; h's shape; q0 holding FM's key into the next note; the
// rhythm's keys ($0E: ko adds a hit, kf keys the others off, the end all),
// levels and tunings; y.
//
//   parseMgs(bytes)               → the song: header, definitions, tracks
//   analyzeMgs(mgs)               → what the import dialog shows
//   mgsToMmlisp(mgs, options, a)  → { source, warnings }
// ---------------------------------------------------------------------------

import { emitSong, emitStructured, barEnds, qstr, PPQN, lenToken } from "./import-song.js";
import { withPre, dropIdleNones } from "./import-mdx.js";
import { OPLL_ROM_NAMES } from "./chips/ym2413.js";

const TICKS_PER_STEP = PPQN / 48;
const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
const MAX_STEPS = 48 * 4 * 4000; // a track that never ends is cut here
const PSG_CLOCK = 1789772.5;

// MGSDRV's tempo: a whole note is a whole number of frames, 14400 / t
// rounded down (MGSC's own shortest-length formula; held to the driver on
// libkss), so t170 plays at 171.43 BPM.
export const mgsBpm = (t) => { const bpm = 14400 / Math.floor(14400 / Math.max(57, t)); return Math.abs(bpm - Math.round(bpm)) < 0.005 ? Math.round(bpm) : +bpm.toFixed(2); };

const u16 = (u8, p) => u8[p] | (u8[p + 1] << 8);
const s16 = (u8, p) => { const v = u16(u8, p); return v >= 0x8000 ? v - 0x10000 : v; };
const s8 = (v) => (v >= 0x80 ? v - 0x100 : v);
const sjis = (u8) => { try { return new TextDecoder("shift-jis").decode(u8); } catch { return String.fromCharCode(...u8); } };

// ── The file ──────────────────────────────────────────────────────────────

// MGSARC's compression: LZ, little-endian lze (as mgsrc-js's uncompress).
function uncompress(inp, head) {
  const out = new Uint8Array(0x10000);
  out.set(inp.subarray(0, head + 2));
  out[3] = 0x33; // "A13" → "313"
  out[head + 1] &= 0x7f;
  let rp = head + 4, wp = head + 2;
  let bits = 1, cur = 0;
  const bit = () => {
    const b = cur & 0x80 ? 1 : 0;
    cur = (cur << 1) & 0xff;
    if (--bits === 0) { bits = 8; cur = inp[rp++]; }
    return b;
  };
  bit();
  for (;;) {
    if (rp > inp.length + 4) throw new Error("MGS: the compressed data runs past the file");
    if (bit()) { out[wp++] = inp[rp++]; continue; }
    let size, offset;
    if (bit()) {
      const lo = inp[rp++], hi = inp[rp++];
      size = hi >> 5;
      if (!size && !(size = inp[rp++])) break;
      offset = ((hi << 8) | lo | 0xe000) - 0x10000;
    } else {
      size = (bit() << 1) | bit();
      offset = (0xff00 | inp[rp++]) - 0x10000;
    }
    for (let i = 0; i < size + 2; i++, wp++) out[wp] = out[wp + offset];
  }
  return out.subarray(0, wp);
}

/** The definitions track: envelopes, SCC waves, OPLL voices, tunings. */
function parseDefs(u8, p) {
  const envs = new Map(), waves = new Map(), voices = new Map(), roms = new Map();
  const notes = [];
  while (p < u8.length) {
    const c = u8[p++];
    if (c === 0xff) break;
    if (c === 0x00) { voices.set(u8[p] & 31, [...u8.subarray(p + 1, p + 9)]); p += 9; }
    else if (c === 0x01) { roms.set(u8[p] & 31, u8[p + 1] & 15); p += 2; } // @#
    else if (c === 0x02) {
      const num = u8[p] & 31, m = u8[p + 1];
      const env = { num, mode: (m >> 5) & 3, nfreq: m & 31 };
      if (m & 0x80) {
        Object.assign(env, { type: "r", al: u8[p + 2], ar: u8[p + 3], dr: u8[p + 4], sl: u8[p + 5], sr: u8[p + 6], rr: u8[p + 7] });
        p += 8;
      } else {
        const len = u8[p + 2];
        Object.assign(env, { type: "e", data: u8.subarray(p + 3, p + 3 + len) });
        p += 3 + len;
      }
      envs.set(num, env);
    } else if (c === 0x03) { waves.set(u8[p] & 31, [...u8.subarray(p + 1, p + 33)].map(s8)); p += 33; }
    else if (c === 0x04 || c === 0x05) { notes.push(c === 0x04 ? "#psg_tune" : "#opll_tune"); p += 24; }
    else if (c === 0x06) { p++; while (p < u8.length && u8[p++] !== 0); }
    else throw new Error(`MGS: unknown definition $${c.toString(16)}`);
  }
  return { envs, waves, voices, roms, notes };
}

/** The file → { title, version, opllMode, tempo, defs, tracks: [{index, start}] }. */
export function parseMgs(bytes) {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (String.fromCharCode(u8[0], u8[1], u8[2]) !== "MGS") throw new Error("not an MGS file");
  let head = 0;
  while (head < u8.length && u8[head] !== 0) head++;
  if (head >= u8.length - 2) throw new Error("not an MGS file (no header)");
  if (u8[head + 1] & 0x80) u8 = uncompress(u8, head);
  const version = String.fromCharCode(u8[3], u8[4], u8[5]);
  let t = 8;
  while (t < head && u8[t] !== 0x0d && u8[t] !== 0x1a) t++;
  const title = sjis(u8.subarray(8, t)).replace(/\t/g, " ").trim();
  const flags = u8[head + 1];
  const tempo = u16(u8, head + 2) || 75;
  const tracks = [];
  let defs = { envs: new Map(), waves: new Map(), voices: new Map(), roms: new Map(), notes: [] };
  for (let i = 0; i < 18; i++) {
    const off = u16(u8, head + 4 + i * 2);
    if (!off) continue;
    if (i === 0) defs = parseDefs(u8, head + off);
    else tracks.push({ index: i, start: head + off });
  }
  return { u8, version, title, opllMode: flags & 1, tempo, defs, tracks };
}

// ── Playing a track ───────────────────────────────────────────────────────

const kindOf = (i) => (i <= 3 ? "psg" : i <= 8 ? "scc" : "fm");
// MGSDRV's OPLL F-numbers, c to b: what `\` and `h` move on FM.
const FM_FNUM = [172, 182, 193, 205, 217, 230, 244, 258, 274, 290, 307, 326];
// o4a is 440 Hz on the PSG; MGSDRV's SCC and FM tables are an octave below
// (held to the driver on libkss).
const midiOf = (kind, oct, n) => 12 * (oct + (kind === "psg" ? 1 : 0)) + n;

// Bytes a command takes, its own included (0: the track ends or is unknown).
function cmdLength(u8, p, rhythm) {
  const c = u8[p];
  const counted = () => { let q = p + 1; while (q < u8.length && u8[q] === 0xff) q++; return q + 1 - p; };
  if (rhythm) {
    if (c <= 0x1f) return counted();
    if (c <= 0x3f) return 2;
    if ((c & 0xe0) === 0xa0) return 1;
  } else {
    if (c <= 0x0c) return counted();
    if (c >= 0x10 && c <= 0x1c) return 1;
    if (c >= 0x20 && c <= 0x2f) return 2;
    if (c >= 0x30 && c <= 0x3f) return 1;
  }
  if (c >= 0x80 && c <= 0x9f) return 1;
  if (c >= 0xc0 && c <= 0xef) return 1;
  const LEN = {
    0x40: 1, 0x41: 51, 0x42: 2, 0x43: 3, 0x44: 2, 0x45: 2, 0x46: 2, 0x47: 2, 0x48: 2, 0x49: 2, 0x4a: 1,
    0x4b: 2, 0x4c: 3, 0x4d: 2, 0x4e: 1, 0x4f: 1, 0x50: 2, 0x51: 3, 0x52: 2, 0x53: 2, 0x54: 5, 0x55: 3,
    0x57: 4, 0x58: 3, 0x59: 4, 0x5a: 2, 0x5b: 2, 0x5c: 3, 0x5d: 1, 0x5f: 2, 0x60: 2, 0x61: 2, 0x63: 1, 0x64: 1,
  };
  return LEN[c] ?? 0;
}

// The lengths a legacy note carries: a byte, and another while it is $FF.
function counts(u8, p) {
  const out = [];
  for (;;) { const n = u8[p++]; out.push(n); if (n !== 0xff) return out; }
}

function newState(kind) {
  return {
    oct: 4, len: 48, q: 8, k: 0, vol: 0, voice: null, env: null, mode: 1, nfreq: null, detune: 0, atDetune: 0, fmFine: 0,
    lfo: null, lfoOn: false, porta: null, fall: 0, sus: 0, kind,
    henv: null, hperiod: null, // s and m: the hardware envelope's shape (null: off) and period
    rvol: [0, 0, 0, 0, 0], kf: false, // the rhythm's levels (BD SD TOM CYM HH), and kf
    // y: the user voice's registers this track has written since its @, and
    // the rhythm's tuning (F-number and block of channels 7-9, the
    // datasheet's to start: MGSDRV writes them once)
    voiceRegs: {}, rtune: [[0x120, 2], [0x150, 2], [0x1c0, 0]],
  };
}

/**
 * One track as MGSDRV plays it: its notes ({step, count, midi, tieOn, st}),
 * tempo changes, its loop ({loopStep}) and end.
 */
function playTrack(mgs, track, skipped) {
  const { u8 } = mgs;
  const rhythm = mgs.opllMode === 1 && track.index === 15;
  const kind = kindOf(track.index);
  const st = newState(kind);
  const notes = [];
  const tempos = [];
  const stack = []; // [{start, left, infinite}]
  let p = track.start, step = 0, loopStep = null, end = null, guard = 0;
  let dollar = null; // where `$` marks the loop
  let rhythmY = null; // a y14 that turns the rhythm on: { step, held }
  const skip = (k) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  // A tone's envelope; on the PSG its mode and noise are set here, once.
  const setEnv = (n, psg) => {
    const env = mgs.defs.envs.get(n);
    st.env = env ? n : null;
    if (psg && env?.mode) { st.mode = env.mode; if (env.mode & 2) st.nfreq = env.nfreq; }
  };
  const tieLast = () => { const last = notes[notes.length - 1]; if (last && last.step + last.count === step) last.tieOn = true; };
  // y r,d: what MGSDRV leaves standing (held to it on libkss) — the user
  // voice's registers 0-7 on FM, until the next @; the noise (6) and the
  // mixer (7) on the PSG; the rhythm's tuning (16-18, 26-28) and levels
  // (36-38). Anything else the next note writes over, and is skipped.
  const yWrite = (r, d) => {
    if (kind === "fm" && !rhythm && r <= 7) { st.voiceRegs = { ...st.voiceRegs, [r]: d }; return; }
    // $0E's rhythm bit outside #opll_mode 1: from here FM 7-9 key the
    // rhythm (mgsToMmlisp), and the keys it holds standing never retrigger.
    if (kind === "fm" && r === 0x0e && (d & 0x20) && !rhythmY) { rhythmY = { step, held: d & 0x1f }; return; }
    if (kind === "psg" && r === 6) { st.nfreq = d & 31; return; }
    if (kind === "psg" && r === 7) {
      const ch = track.index - 1, tone = !((d >> ch) & 1), noise = !((d >> (ch + 3)) & 1);
      st.mode = (tone ? 1 : 0) | (noise ? 2 : 0);
      return;
    }
    if (rhythm && ((r >= 0x16 && r <= 0x18) || (r >= 0x26 && r <= 0x28))) {
      const ch = (r & 15) - 6;
      const [f, b] = st.rtune[ch];
      st.rtune = st.rtune.map((t, i) => (i !== ch ? t : r < 0x20 ? [(f & 0x100) | d, b] : [(f & 0xff) | ((d & 1) << 8), (d >> 1) & 7]));
      return;
    }
    if (rhythm && r >= 0x36 && r <= 0x38) {
      // BD in $36's low nibble; HH and SD in $37's high and low; TOM and
      // CYM in $38's (attenuation: 15 - level).
      const lv = { 0x36: [[0, 0]], 0x37: [[4, 4], [1, 0]], 0x38: [[2, 4], [3, 0]] }[r];
      st.rvol = st.rvol.slice();
      for (const [i, sh] of lv) st.rvol[i] = 15 - ((d >> sh) & 15);
      return;
    }
    skip(`y${r},${d} on ${rhythm ? "the rhythm" : kind === "fm" ? "FM" : kind === "psg" ? "the PSG" : "the SCC"} (rewritten by the next note, or not read)`);
  };
  const note = (n, count) => {
    const base = st.porta;
    st.porta = null;
    if (n >= 12) {
      // FM at q0 is not keyed off: the note sounds on through the rest.
      const last = notes[notes.length - 1];
      if (kind === "fm" && last && last.st.q === 0 && last.cut == null && last.step + last.count + (last.held ?? 0) === step) last.held = (last.held ?? 0) + count;
      step += count; return;
    }
    // FM at q0 keeps the key on into the next note (held to MGSDRV on libkss).
    const last = notes[notes.length - 1];
    if (kind === "fm" && last && last.st.q === 0 && last.cut == null && last.step + last.count + (last.held ?? 0) === step) last.tieOn = true;
    notes.push({ step, count, midi: midiOf(kind, st.oct, n), base, tieOn: false, st: { ...st } });
    step += count;
  };
  while (p < u8.length && step < MAX_STEPS && ++guard < 2e6) {
    const c = u8[p];
    if (c === 0xff) {
      if (dollar) loopStep = dollar.step;
      end = step;
      break;
    }
    const len = cmdLength(u8, p, rhythm);
    if (!len) { skip(`command $${c.toString(16)} (the track stops there)`); end = step; break; }
    const a1 = u8[p + 1];
    if (rhythm) {
      if (c <= 0x3f || (c & 0xe0) === 0xa0) {
        const n = c <= 0x1f ? counts(u8, p + 1).reduce((x, y) => x + y, 0) : c <= 0x3f ? a1 || 256 : st.len;
        if (c & 0x1f) notes.push({ step, count: n, midi: 60, rhythm: c & 0x1f, tieOn: false, st: { ...st, rvol: [...st.rvol] } });
        step += n;
        p += len;
        continue;
      }
    } else if (c <= 0x0c) {
      // A legacy length past 255 goes on in another byte: one note, tied.
      counts(u8, p + 1).forEach((n, i) => { if (i) tieLast(); note(c, n); });
      p += len;
      continue;
    } else if ((c >= 0x10 && c <= 0x1c) || (c >= 0x30 && c <= 0x3c)) { note(c & 15, st.len); p += len; continue; }
    else if (c >= 0x20 && c <= 0x2c) { note(c & 15, a1 || 256); p += len; continue; }
    if (c >= 0x80 && c <= 0x9f) {
      // @n: tone n — the SCC's wave or the FM's voice, and on every channel
      // the envelope of its number, whose mode and noise the PSG takes now.
      if (kind !== "psg") { st.voice = c & 31; st.voiceRegs = {}; }
      setEnv(c & 31, kind === "psg");
    } else if (c >= 0xc0 && c <= 0xcf) {
      st.vol = c & 15;
      st.henv = null; // v on the PSG: the hardware envelope off
      if (rhythm) st.rvol.fill(c & 15); // v on the rhythm: every sound's
    }
    else if (c >= 0xd0 && c <= 0xdf) st.oct = (c & 7) + 1;
    else if (c >= 0xe0 && c <= 0xef) st.mode = c & 3;
    else switch (c) {
      case 0x40: tieLast(); break; // &: the note before slurs (or ties) into the next
      case 0x41: tempos.push({ step, bpm: u16(u8, p + 1) }); break;
      case 0x42: st.len = a1 || 256; break;
      case 0x43: st.len = u16(u8, p + 1); break;
      case 0x44: st.q = a1 & 15; break;
      case 0x45: if ((a1 >> 5) < 5) st.rvol[a1 >> 5] = a1 & 15; break;
      case 0x47: if ((a1 >> 5) < 5) st.rvol[a1 >> 5] = Math.max(0, Math.min(15, st.rvol[a1 >> 5] + ((a1 & 0x1f) >= 16 ? (a1 & 0x1f) - 32 : a1 & 0x1f))); break;
      case 0x46:
        st.vol = Math.max(0, Math.min(15, st.vol + s8(a1)));
        if (rhythm) st.rvol = st.rvol.map((v) => Math.max(0, Math.min(15, v + s8(a1))));
        break;
      case 0x48: st.k = a1; break;
      case 0x49: setEnv(a1 & 31, kind === "psg"); break; // @e<n> / @r<n>: the tone's envelope
      case 0x4a: {
        // FM: a key-off now (the note before, held by q0 or not).
        const last = notes[notes.length - 1];
        if (kind === "fm" && last) last.cut = step - last.step;
        break;
      }
      case 0x4b: if (kind === "psg") st.henv = a1 & 15; break; // s: the envelope's shape, on
      case 0x4c: if (kind === "psg") st.hperiod = Math.max(1, u16(u8, p + 1)); break; // m: its period
      case 0x4d: st.nfreq = a1 & 31; break;
      case 0x4e: st.oct = Math.min(8, st.oct + 1); break;
      case 0x4f: st.oct = Math.max(1, st.oct - 1); break;
      // As MGSDRV plays them (held to it on libkss): \ adds to the period the
      // octave plays (+ lower; MGSC stores the MML's negated) or to FM's
      // F-number (+ higher); @\ to the octave-1 period, so its share halves
      // with each octave (+ lower); FM's @\ is a fine offset of its own, 255
      // a semitone up. Each holds beside the others.
      case 0x50: st.detune = s8(a1); break;
      case 0x51: if (kind !== "fm") st.atDetune = s16(u8, p + 1); break;
      case 0x5f: st.fmFine = a1; break;
      case 0x52: st.fall = a1; break;
      case 0x53: st.porta = { n: a1 & 15, oct: st.oct }; break;
      // h delay, depth, speed, coarseness (MGSC stores delay + 1, speed + 1,
      // and on the PSG and the SCC the coarseness negated).
      case 0x54: st.lfo = { delay: a1, count: u8[p + 2], speed: u8[p + 3], depth: s8(u8[p + 4]) }; st.lfoOn = true; break;
      case 0x55: if (st.lfo) st.lfo = { ...st.lfo, fine: s16(u8, p + 1) }; break; // @p: the coarseness on the octave-1 period
      case 0x57: stack.push({ start: p + len, left: a1, infinite: a1 === 0, step }); break;
      case 0x58: {
        const top = stack[stack.length - 1];
        if (top && !top.infinite && top.left === 1) { stack.pop(); p = loopEnd(u8, p + len, rhythm); continue; }
        break;
      }
      case 0x59: {
        const top = stack[stack.length - 1];
        if (top?.infinite) {
          // `[ … ]0`: the song's loop.
          if (stack.length === 1) loopStep = top.step;
          else skip("a `[ … ]0` inside a repeat (the track is written to its end)");
          end = step;
          break;
        }
        if (top && --top.left > 0) { p = top.start; continue; }
        stack.pop();
        break;
      }
      case 0x5a: if (!rhythm) st.lfoOn = a1 !== 0; else st.kf = a1 !== 0; break; // ho / hf; ko / kf
      case 0x5b: st.sus = a1 ? 1 : 0; break;
      case 0x5c: yWrite(a1, u8[p + 2]); break;
      case 0x5d: if (!stack.length) dollar = { step }; else skip("a `$` inside a repeat"); break;
      case 0x60: break; // @m: a message
      case 0x61: skip("@o"); break;
      case 0x63: skip("@f"); break;
      case 0x64: break; // hi
    }
    if (end != null) break;
    p += len;
  }
  if (end == null) { end = step; if (step >= MAX_STEPS) skip("a track that never reaches its end (cut)"); }
  return { notes, tempos, loopStep, end, rhythmY };
}

// Past the `]` that closes the repeat a `|` at `p` is in.
function loopEnd(u8, p, rhythm) {
  let depth = 0;
  while (p < u8.length && u8[p] !== 0xff) {
    const c = u8[p];
    const n = cmdLength(u8, p, rhythm);
    if (!n) return p;
    if (c === 0x57) depth++;
    else if (c === 0x59) { if (depth === 0) return p + n; depth--; }
    p += n;
  }
  return p;
}

// ── Analysis ──────────────────────────────────────────────────────────────

const TRACK_NAME = (i) => (i <= 3 ? `PSG ${i}` : i <= 8 ? `SCC ${i - 3}` : `FM ${i - 8}`);

export function analyzeMgs(mgs) {
  const skipped = new Map();
  const tracks = mgs.tracks.map((t) => {
    const kind = kindOf(t.index);
    const r = playTrack(mgs, t, skipped);
    const name = mgs.opllMode === 1 && t.index === 15 ? "FM rhythm" : TRACK_NAME(t.index);
    return { ...t, ...r, kind, name, label: `${name} · ${r.notes.length} notes${r.loopStep != null ? ", loops" : ""}` };
  });
  const bpm = mgsBpm(tracks.flatMap((t) => t.tempos).find((x) => x.step === 0)?.bpm ?? mgs.tempo);
  // The rhythm a y14 turns on (#opll_mode 0): the song's, as the target's is.
  const rhythmY = mgs.opllMode === 1 ? null : tracks.map((t) => t.rhythmY).find(Boolean) ?? null;
  return { tracks, skipped, bpm, rhythmY };
}

// ── Writing ───────────────────────────────────────────────────────────────

// A register level as :vol — the SSG's 3 dB steps, the SCC's linear 4 bits —
// on the fader's 2 dB ones; 0 is the fader's mute.
const ssgVol = (r) => (r <= 0 ? 0 : 31 - Math.round(1.5 * (15 - Math.min(15, r))));
const sccVol = (r) => (r <= 0 ? 0 : Math.max(1, Math.min(31, 31 + Math.round((20 * Math.log10(Math.min(15, r) / 15)) / 2))));
const MODES = [null, "tone", "noise", "both"];

// A note's period on the PSG's table, which the SCC plays too (an octave
// below: its period counts 32 clocks, the PSG's 16), and its octave there.
const periodOf = (kind, midi) => PSG_CLOCK / 16 / (440 * 2 ** ((midi + (kind === "scc" ? 12 : 0) - 69) / 12));
const octaveOf = (kind, midi) => Math.floor(midi / 12) - (kind === "psg" ? 1 : 0);
// An F-number offset on FM as MGSDRV keeps it in 172-344: under, 173 more
// and a block down; over, 173 less and a block up — not an octave but at c
// (held to it on libkss), so a wide detune lands per pitch class.
function fmCents(midi, d) {
  const f0 = FM_FNUM[((midi % 12) + 12) % 12];
  let f = Math.round(f0 + d), b = 0;
  while (f < 172) { f += 173; b--; }
  while (f > 344) { f -= 173; b++; }
  return Math.round(1200 * Math.log2((f * 2 ** b) / f0));
}
// A period offset (+ lower) as cents at a note on the PSG or the SCC; an
// F-number offset (+ higher) on FM.
function offsetCents(kind, midi, d) {
  if (kind === "fm") return fmCents(midi, d);
  const p = periodOf(kind, midi);
  return Math.round(1200 * Math.log2(p / Math.max(1, Math.min(4095, p + d))));
}
// \ and @\ together on a note, as cents.
function detuneOf(kind, midi, st) {
  if (kind === "fm") {
    const f = FM_FNUM[((midi % 12) + 12) % 12] + st.detune;
    return fmCents(midi, st.detune + (f * st.fmFine) / 4352);
  }
  return offsetCents(kind, midi, st.detune + st.atDetune / 2 ** (octaveOf(kind, midi) - 1));
}

const ENV_MAX_FRAMES = 600;

/**
 * An @e envelope frame by frame (a count a frame): the level and the pitch
 * offset (its `\` steps add up, + up, in MML's `\` units) of each, where its
 * `[` loops from, and the mixer, noise and wave its steps set before the
 * first level (the mode and noise the @ sets are the track's).
 */
function expandEnv(env) {
  const levels = [], offsets = [], nfreqs = [], modes = [];
  let level = 15, off = 0, sus = null, i = 0;
  let mode = null, nfreq = null, wave = null, moves = 0;
  let curN = null, curM = null; // the noise and the mixer as the steps set them (null: the note's)
  const d = env.data;
  const frame = (n) => { for (let k = 0; k < n && levels.length < ENV_MAX_FRAMES; k++) { levels.push(level); offsets.push(off); nfreqs.push(curN); modes.push(curM); } };
  while (i < d.length && levels.length < ENV_MAX_FRAMES) {
    const c = d[i++];
    const first = !levels.length;
    if (c < 0x10) { level = c; frame(1); }
    else if (c === 0x10) { const w = d[i++] & 31; if (first) wave = w; else moves++; }
    else if (c === 0x11) i += 2;
    else if (c === 0x12) off += s8(d[i++]);
    else if (c >= 0x20 && c <= 0x2f) {
      // `n=c`: from the level there toward n over c counts — a step short of
      // it, as MGSDRV steps.
      const to = c & 15, n = d[i++] || 256, from = level;
      for (let k = 0; k < n; k++) { level = from + Math.trunc(((to - from) * k) / n); frame(1); }
    }
    else if (c === 0x40) sus ??= levels.length;
    else if (c === 0x60) break;
    else if (c >= 0x80 && c <= 0x9f) { curN = c & 31; if (first) nfreq = c & 31; }
    else if (c >= 0xa0 && c <= 0xaf) { if (c & 3) curM = c & 3; if (first) mode = c & 3 || mode; }
    else if (c >= 0xe0 && c <= 0xef) { level = c & 15; frame(d[i++] || 256); } // `n:c`: n for c counts
    else break;
  }
  if (!levels.length) frame(1);
  if (sus != null && sus >= levels.length) sus = null;
  return { levels, offsets, nfreqs, modes, sus, mode, nfreq, wave, moves };
}

// Frame values as a macro vector: a run of one value is the value and a wait.
function frameVector(values, sus) {
  const items = [];
  for (let k = 0; k < values.length; ) {
    if (k === sus) items.push("#sus");
    let n = 1;
    while (k + n < values.length && values[k + n] === values[k] && k + n !== sus) n++;
    items.push(String(values[k]));
    // The last value holds: a wait at the end only keeps a loop's length.
    if (n > 1 && (k + n < values.length || sus != null)) items.push(`(wait ${n - 1}f)`);
    k += n;
  }
  return `[${items.join(" ")}]`;
}

/**
 * An envelope at a level `v` as a :vol macro spec; `k` (an @e's, or none's)
 * the release after the key-off, a level step every k frames from the key-off's
 * own (held to MGSDRV on libkss) — written as its steps, which a line on :vol
 * is not on the SCC's linear volume.
 */
function kRelease(k, v, volOf) {
  if (!(k > 0 && v > 0)) return "";
  const steps = [];
  for (let lv = v - 1; lv >= 0; lv--) for (let i = 0; i < k; i++) steps.push(volOf(lv));
  return ` #rel ${frameVector(steps, null).slice(1, -1)}`;
}
function envelopeSpec(env, v, volOf, k = 0) {
  if (env.type === "r") {
    // MGSDRV's ADSR, frame by frame (held to it on libkss): E starts at
    // AL + AR, climbs by AR to 255, falls by DR to SL (stopping on it), then
    // by SR to 0; the level is (E × (v + 1)) >> 8. The release falls by RR
    // from where it is.
    const out = [];
    let E = env.al, phase = env.ar > 0 ? 0 : 1;
    for (let f = 0; f < ENV_MAX_FRAMES; f++) {
      if (phase === 0) { E += env.ar; if (E >= 255) { E = 255; phase = 1; } }
      else if (phase === 1) { E -= env.dr; if (E <= env.sl) { E = env.sl; phase = 2; } }
      else E = Math.max(0, E - env.sr);
      out.push(volOf((E * (v + 1)) >> 8));
      if ((phase === 2 && (!env.sr || E === 0)) || (phase === 1 && !env.dr)) break;
    }
    // The release as its steps: a line on :vol is not one on E, a linear level.
    const steps = [];
    if (env.rr > 0) for (let e = E - env.rr; ; e -= env.rr) { steps.push(volOf((Math.max(0, e) * (v + 1)) >> 8)); if (e <= 0) break; }
    const rel = steps.length && E > 0 ? ` #rel ${frameVector(steps, null).slice(1, -1)}` : "";
    return frameVector(out, null).replace(/\]$/, rel + "]");
  }
  const x = expandEnv(env);
  // An @e's level is relative to v: 15 is v itself, each step below one
  // step quieter.
  const levels = x.levels.map((lv) => Math.max(0, v + lv - 15));
  return frameVector(levels.map(volOf), x.sus).replace(/\]$/, kRelease(k, levels[levels.length - 1], volOf) + "]");
}

// The rhythm track's hits → rhythm1-rhythm5, a track a sound, in the key-on
// bits' order (b s m c h). A sound rings until its next hit, which keys it
// again; its level is its own `vb`… at the hit.
const RHYTHM_SOUNDS = [[0x10, "kick", 0, 0], [0x08, "snare", 1, 1], [0x04, "tom4", 2, 2], [0x02, "ride", 3, 2], [0x01, "hat", 4, 1]];
// A rhythm channel's tuning as the note that plays it: c4 is the datasheet's,
// a semitone a step (the target tunes a hit by its note).
const RHYTHM_C4 = [[0x120, 2], [0x150, 2], [0x1c0, 0]];
const rhythmNote = (ch, [f, b]) => 60 + Math.round(12 * Math.log2(((f || 1) * 2 ** b) / (RHYTHM_C4[ch][0] * 2 ** RHYTHM_C4[ch][1])));
function rhythmTracks(tr, tick) {
  const out = [];
  RHYTHM_SOUNDS.forEach(([bit, role, lv, ch]) => {
    const hits = tr.notes.filter((n) => n.rhythm & bit);
    if (!hits.length) return;
    const endTick = tick(tr.end);
    // ko: a sound rings to its own next hit; kf: is keyed off at the next
    // hit of any. A hit under kf keys off every other sound, and the
    // driver keys all off at the track's end: those notes end as `:mode
    // gate`, the others ring on.
    const cut = (n) => (n.st.kf ? tr.notes.find((m) => m.step > n.step) : tr.notes.find((m) => m.step > n.step && m.st.kf))?.step ?? (tr.loopStep == null ? tr.end : Infinity);
    const ends = hits.map((n, k) => { const own = hits[k + 1]?.step ?? tr.end, c = cut(n); return c < own || (c === own && !hits[k + 1]) ? [c, true] : [own, false]; });
    const gated = ends.some(([, g]) => g);
    const notes = hits.map((n, k) => {
      const [next, gate] = ends[k];
      const state = [role, `:vol ${ssgVol(n.st.rvol[lv])}`];
      if (gated) state.push(`:mode ${gate ? "gate" : "shot"}`);
      return { tick: tick(n.step), len: Math.max(1, tick(next - n.step)), midi: rhythmNote(ch, n.st.rtune[ch]), vel: 15, state };
    });
    const marks = !out.length ? tr.tempos.map((tm) => ({ tick: tick(tm.step), tokens: [`:tempo ${mgsBpm(tm.bpm)}`] })) : [];
    out.push({ channel: `rhythm${out.length + 1}`, notes, marks, endTick, loopTick: tr.loopStep != null ? tick(tr.loopStep) : null });
  });
  return out;
}

// FM 7-9 under a y14's rhythm (#opll_mode 0): channel `ch`'s key-ons key
// its sounds — BD on 7, SD and HH on 8, TOM and CYM on 9 — but those $0E
// holds standing, which a channel key never retriggers. A hit is the
// note's pitch on the channel (c4 the datasheet's tuning), keyed off at its
// gate, its pitch moves the channel's; its level is the channel's volume (BD, SD, CYM: the track's v and
// envelope) or its instrument nibble (HH, TOM: 15 - the voice's number).
const RHYTHM_OF_CH = [[0x10], [0x08, 0x01], [0x04, 0x02]];
const RHYTHM_INST = new Set([0x01, 0x04]);
const fbMidi = ([f, b]) => 69 + 12 * Math.log2((f * 3579545) / 72 / 2 ** (19 - b) / 440);
function rhythmOfFm(ch, notes, rhythmY) {
  const inst = (voice) => (voice == null || voice > 14 ? 0 : voice + 1);
  return RHYTHM_OF_CH[ch].filter((bit) => !(rhythmY.held & bit)).map((bit) => {
    const [, role] = RHYTHM_SOUNDS.find(([b]) => b === bit);
    return {
      notes: notes.filter((n) => n.tick >= rhythmY.step * TICKS_PER_STEP).map((n) => {
        const level = RHYTHM_INST.has(bit)
          ? [`:vol ${ssgVol(15 - inst(n.voice))}`, "(macro :vol none)"]
          : n.state.filter((t) => t.startsWith(":vol") || t.startsWith("(macro :vol") || /^vol-/.test(t));
        const rest = n.state.filter((t) => t.startsWith(":gate") || t.startsWith(":pitch") || t.startsWith("(macro :pitch") || /^(vib|bend)-/.test(t));
        return { ...n, midi: 60 + Math.round(n.midi - fbMidi(RHYTHM_C4[ch])), state: [role, ...level, ":mode gate", ...rest] };
      }),
    };
  });
}

// One of the user voice's registers ($00-$07) as the words that set it.
function opllRegWords(r, d) {
  if (r <= 1) { const k = r + 1; return `:am${k} ${d >> 7} :vib${k} ${(d >> 6) & 1} :eg${k} ${(d >> 5) & 1} :ks${k} ${(d >> 4) & 1} :ml${k} ${d & 15}`; }
  if (r === 2) return `:ksl1 ${d >> 6} :tl1 ${d & 63}`;
  if (r === 3) return `:ksl2 ${d >> 6} :ws2 ${(d >> 4) & 1} :ws1 ${(d >> 3) & 1} :fb ${d & 7}`;
  const k = (r & 1) + 1;
  return r <= 5 ? `:ar${k} ${d >> 4} :dr${k} ${d & 15}` : `:sl${k} ${d >> 4} :rr${k} ${d & 15}`;
}

/**
 * @param options { structure?: boolean, fileName? }
 */
export function mgsToMmlisp(mgs, options = {}, a = analyzeMgs(mgs)) {
  const warnings = [];
  const skipped = new Map(a.skipped);
  const skip = (k) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  const defs = [];
  const tick = (s) => s * TICKS_PER_STEP;
  // The song's tempo at a step: #tempo, then any track's t.
  const tempoLine = a.tracks.flatMap((t) => t.tempos).sort((x, y) => x.step - y.step);
  const tempoAt = (step) => { let bpm = mgs.tempo; for (const t of tempoLine) { if (t.step > step) break; bpm = t.bpm; } return mgsBpm(bpm); };

  const waveDefs = new Map();
  const waveName = (n) => {
    if (!waveDefs.has(n)) {
      const w = mgs.defs.waves.get(n);
      if (!w) { waveDefs.set(n, null); warnings.push(`@s${n} is not in the file — its notes play the wave before`); }
      else {
        const name = `scc-${String(n).padStart(2, "0")}`;
        defs.push(`(def-wave ${name} :wave [${w.join(" ")}])`);
        waveDefs.set(n, name);
      }
    }
    return waveDefs.get(n);
  };
  const envDefs = new Map();
  const envName = (num, v, kind, k) => {
    const key = `${num}:${v}:${kind === "scc" ? "scc" : "ssg"}:${k}`;
    if (!envDefs.has(key)) {
      const env = mgs.defs.envs.get(num);
      if (!env) { envDefs.set(key, null); warnings.push(`@e${num} is not in the file — its notes play without an envelope`); }
      else {
        const spec = envelopeSpec(env, v, kind === "scc" ? sccVol : ssgVol, k);
        // One level held: the note's :vol, no macro.
        const flat = /^\[(\d+)\]$/.exec(spec);
        if (flat) envDefs.set(key, { vol: Number(flat[1]) });
        else {
          const name = `vol-${env.type}${num}-v${v}${k ? `-k${k}` : ""}${kind === "scc" ? "-scc" : ""}`; // the PSG's and the OPLL's are one ladder
          defs.push(`(def ${name} (macro :vol ${spec}))`);
          envDefs.set(key, { name });
        }
      }
    }
    return envDefs.get(key);
  };
  // An @e's pitch steps on one note, as a :pitch+ macro (a def a note).
  const bendDefs = new Map();
  const envBend = (num, midi, kind, x) => {
    const key = `${num}:${midi}:${kind}`;
    if (!bendDefs.has(key)) {
      // + up: the period less, FM's F-number more.
      const cents = x.offsets.map((o) => (o ? Math.round(offsetCents(kind, midi, kind === "fm" ? o : -o) / 5) * 5 : 0));
      let name = null;
      if (cents.some(Boolean)) {
        name = `bend-e${num}-${NOTE_NAMES[midi % 12].replace("+", "s")}${Math.floor(midi / 12) - 1}${kind === "psg" ? "" : `-${kind}`}`;
        defs.push(`(def ${name} (macro :pitch+ ${frameVector(cents, x.sus)}))`);
      }
      bendDefs.set(key, name);
    }
    return bendDefs.get(key);
  };
  const expanded = new Map();
  const envX = (num) => {
    if (!expanded.has(num)) {
      const env = mgs.defs.envs.get(num);
      const x = env?.type === "e" ? expandEnv(env) : env ? { mode: null, nfreq: null, wave: null, moves: 0, offsets: [] } : null;
      if (x?.moves) warnings.push(`@e${num} changes the wave ${x.moves} time${x.moves > 1 ? "s" : ""} as it runs: its notes keep the first`);
      expanded.set(num, x);
    }
    return expanded.get(num);
  };

  // Tone n: the ROM voice @# gives it (@0-@14 are ROM voices 1-15 to
  // start), else (ROM 0, the original) its @v as a def-fm on the OPLL's words.
  const voiceDefs = new Map();
  const fmVoice = (n) => {
    if (!voiceDefs.has(n)) {
      const rom = mgs.defs.roms.get(n) ?? (n <= 14 ? n + 1 : 0);
      const d = mgs.defs.voices.get(n);
      if (rom) voiceDefs.set(n, OPLL_ROM_NAMES[rom - 1]);
      else if (d) {
        const name = `mgs-v${String(n).padStart(2, "0")}`;
        const op = (k, b0, ar, sl, ksl, ws, tl) => [`:am${k} ${b0 >> 7}`, `:vib${k} ${(b0 >> 6) & 1}`, `:eg${k} ${(b0 >> 5) & 1}`,
          `:ks${k} ${(b0 >> 4) & 1}`, `:ml${k} ${b0 & 15}`, `:ksl${k} ${ksl}`, ...(tl != null ? [`:tl${k} ${tl}`] : []),
          `:ws${k} ${ws}`, `:ar${k} ${ar >> 4}`, `:dr${k} ${ar & 15}`, `:sl${k} ${sl >> 4}`, `:rr${k} ${sl & 15}`].join(" ");
        defs.push(`(def-fm ${name} :fb ${d[3] & 7}\n  ${op(1, d[0], d[4], d[6], d[2] >> 6, (d[3] >> 3) & 1, d[2] & 63)}\n  ${op(2, d[1], d[5], d[7], d[3] >> 6, (d[3] >> 4) & 1, null)})`);
        voiceDefs.set(n, name);
      } else { voiceDefs.set(n, null); warnings.push(`FM @${n} has no @v definition — its notes play the voice before`); }
    }
    return voiceDefs.get(n);
  };

  const songOut = [];
  let endMax = 0;
  let rhythmN = 0; // the rhythm tracks written
  if (a.rhythmY?.held) skip(`y14's held keys (${RHYTHM_SOUNDS.filter(([bit]) => a.rhythmY.held & bit).map(([, r]) => r).join(", ")}): they sound once, at the y, and are left out`);
  for (const tr of a.tracks) {
    if (!tr.notes.length || (mgs.opllMode === 1 && tr.index >= 16)) continue;
    if (mgs.opllMode === 1 && tr.index === 15) {
      for (const t of rhythmTracks(tr, tick)) { songOut.push(t); endMax = Math.max(endMax, t.endTick); }
      continue;
    }
    const isPsg = tr.kind === "psg", isFm = tr.kind === "fm";
    const channel = isPsg ? `sqr${tr.index}` : isFm ? `fm${tr.index - 8}` : `wave${tr.index - 3}`;
    // Under a y14's rhythm FM 7-9 are the rhythm's channels: their notes
    // key its sounds (rhythmOfFm), their own voice and pitch moves aside.
    const rhythmCh = a.rhythmY && isFm && tr.index >= 15 ? tr.index - 15 : null;
    const volOf = tr.kind === "scc" ? sccVol : ssgVol; // the OPLL's volume steps 3 dB as the SSG's
    const notes = [];
    let prev = null;
    let head = null; // the note a tie continues: the one keyed, or slurred to
    let gated = false; // a q below 8 seen: from then on every note states its gate
    let gateInForce = ":gate* 1";
    // s on any note: every note says whether it is on the envelope.
    const henv = isPsg && tr.notes.some((n) => n.st.henv != null);
    // An @e moving the noise or the mixer on any note: every note says its own.
    const moving = (x) => !!x && [x.nfreqs, x.modes].some((v) => v && new Set(v.filter((n) => n != null)).size + (v.includes(null) ? 1 : 0) > 1);
    const envMoves = isPsg && tr.notes.some((n) => n.st.env != null && moving(envX(n.st.env)));
    for (const n of tr.notes) {
      const st = n.st;
      const x = st.env != null ? envX(st.env) : null;
      const state = [];
      const wave = x?.wave ?? st.voice;
      // An envelope's leading @n sets the tone's voice or wave at the key-on.
      if (isFm && rhythmCh == null) {
        const vn = x?.wave ?? st.voice; const v = vn != null ? fmVoice(vn) : null;
        if (v) state.push(v);
        const regs = Object.entries(st.voiceRegs);
        if (regs.length && v && OPLL_ROM_NAMES.includes(v)) skip("y on the user voice while the track plays a ROM voice");
        else for (const [r, d] of regs) state.push(opllRegWords(Number(r), d));
        state.push(`:sus ${st.sus}`);
      }
      else if (!isPsg && wave != null) { const w = waveName(wave); if (w) state.push(w); }
      if (isPsg) {
        const mix = x ?? { mode: null, nfreq: null };
        const mode = mix.mode ?? st.mode;
        if (!MODES[mode]) { skip("a PSG note with its mixer off (silent)"); prev = n; continue; }
        state.push(`:mode ${MODES[mode]}`);
        if (mode & 2) state.push(`:noise-rate ${Math.max(1, mix.nfreq ?? st.nfreq ?? 8)}`);
        // An @e that moves the noise or the mixer as it runs: those steps as
        // the note's :noise-rate and :mode macros (held to MGSDRV on libkss).
        if (envMoves) {
          const steps = (vals, start) => { let v = start; return vals.map((x) => (v = x ?? v)); };
          const ns = x?.nfreqs ? steps(x.nfreqs, Math.max(1, mix.nfreq ?? st.nfreq ?? 8)) : [];
          const ms = x?.modes ? steps(x.modes, mode) : [];
          state.push(new Set(ns).size > 1 ? `(macro :noise-rate ${frameVector(ns, x.sus)})` : "(macro :noise-rate none)");
          state.push(new Set(ms).size > 1 ? `(macro :mode ${frameVector(ms.map((m) => MODES[m]), x.sus)})` : "(macro :mode none)");
        }
        if (henv) state.push(`:env ${st.henv ?? "none"}`);
        // m's period as a cycle's Hz on the shape (a triangle's cycle is two).
        if (st.henv != null && st.hperiod)
          state.push(`:env-rate ${+(PSG_CLOCK / ((st.henv === 10 || st.henv === 14 ? 512 : 256) * st.hperiod)).toPrecision(6)}`);
      }
      // k: the release, on the PSG and the SCC, under an @e or none (an @r
      // has its RR).
      const env = st.env != null ? mgs.defs.envs.get(st.env) : null;
      const k = !isFm && env?.type !== "r" ? st.k : 0;
      const e = env ? envName(st.env, st.vol, tr.kind, k) : null;
      const rel = !env && kRelease(k, st.vol, volOf);
      // On the hardware envelope the level is the envelope's: s drops the
      // software envelope, and k does nothing.
      if (st.henv != null) state.push("(macro :vol none)");
      else {
        state.push(`:vol ${e?.vol ?? volOf(st.vol)}`);
        state.push(e?.name ?? (rel ? `(macro :vol [${volOf(st.vol)}${rel}])` : "(macro :vol none)"));
      }
      const detune = detuneOf(tr.kind, n.midi, st);
      state.push(`:pitch ${detune}`);
      // The note's own pitch move: the envelope's, a portamento, the LFO.
      let pitch = null;
      const bend = x?.offsets.some(Boolean) ? envBend(st.env, n.midi, tr.kind, x) : null;
      if (bend) pitch = bend;
      else if (n.base) {
        // A portamento over the note's frames, a line on the PSG's and the
        // SCC's period and on FM's F-number, so a line on the frequency
        // (held to MGSDRV on libkss): each frame's cents.
        const from = midiOf(tr.kind, n.base.oct, n.base.n);
        if (from !== n.midi) {
          const frames = Math.max(1, Math.round((n.count * 75) / tempoAt(n.step)));
          const r = 2 ** ((from - n.midi) / 12); // the start's frequency over the note's
          const cents = Array.from({ length: frames + 1 }, (_, f) => {
            const k = f / frames;
            return Math.round(1200 * Math.log2(isFm ? r + (1 - r) * k : 1 / (1 / r + (1 - 1 / r) * k)));
          });
          pitch = `(macro :pitch+ ${frameVector(cents, null)})`;
        }
      } else if (st.fall && !isFm) {
        // p: the period grows each frame — 2p on the octave-1 period below
        // 128, (p - 128) × (9 - octave) on the octave's own from 128 (held
        // to MGSDRV on libkss) — drawn as four lines over the note.
        const frames = Math.max(1, Math.round((n.count * 75) / tempoAt(n.step)));
        const oct = octaveOf(tr.kind, n.midi);
        const base = st.detune + st.atDetune / 2 ** (oct - 1);
        const rate = st.fall < 128 ? (2 * st.fall) / 2 ** (oct - 1) : (st.fall - 128) * (9 - oct);
        const at = (q) => offsetCents(tr.kind, n.midi, base + (rate * frames * q) / 4) - detune;
        const pts = [0, 1, 2, 3, 4].map(at);
        if (pts[4] !== pts[0]) pitch = `(macro :pitch+ [${[0, 1, 2, 3].map((q) => `(linear ${pts[q]}..${pts[q + 1]} :len ${Math.max(1, Math.round(frames / 4))}f)`).join(" ")}])`;
      } else if (st.lfoOn && st.lfo && st.lfo.depth && st.lfo.speed > 0) {
        // h (stored delay + 1, depth, speed + 1, coarseness): after delay +
        // speed frames, a coarseness step each `speed` frames, (depth + 1)
        // steps a half cycle — ±(depth + 1) / 2 steps, up first when the
        // coarseness is (on the PSG and the SCC, negated by MGSC; held to
        // MGSDRV on libkss).
        const { delay, count, speed } = st.lfo;
        const depth = st.lfo.fine != null && !isFm ? st.lfo.fine / 2 ** (octaveOf(tr.kind, n.midi) - 1) : st.lfo.depth;
        const swing = ((count + 1) / 2) * Math.abs(depth);
        const amp = Math.round(Math.abs(offsetCents(tr.kind, n.midi, isFm ? swing : -swing)) / 10) * 10; // to 10 cents, so notes share it
        const up = isFm ? depth > 0 : depth < 0;
        if (amp) pitch = `(macro :pitch+ (triangle ${-amp}..${amp} :len ${2 * (count + 1) * speed}f :phase ${up ? 64 : 192} :wait ${delay + speed - 1}f))`;
      }
      if (pitch && !pitch.startsWith("(")) state.push(pitch);
      else state.push(pitch ?? "(macro :pitch none)");
      // q eighths of the note as its gate, the note its whole slot; q0 (FM)
      // holds it through the rests after it, to a `/` — which keys a note
      // off where it falls: that note is that long.
      const q = st.q >= 1 && st.q <= 8 ? st.q : 8;
      const hold = n.tieOn || (isFm && st.q === 0);
      const span = hold ? n.count + (n.held ?? 0) : n.count;
      const gate = hold ? span : Math.max(1, Math.floor((n.count * q) / 8));
      let len = span, gateTok = null;
      if (n.cut != null && n.cut < span) len = Math.max(1, Math.min(gate, n.cut));
      else if (gate < span) gateTok = `:gate* ${q / 8}`;
      if (gateTok) gated = true;
      const legato = !!prev && prev.tieOn && prev.step + prev.count + (prev.held ?? 0) === n.step;
      // A note keyed on into the next sounds its whole slot whatever its
      // gate: it keeps the one in force, so none is written for it.
      if (gated) state.push((gateInForce = n.tieOn && n.held == null ? gateInForce : gateTok ?? ":gate* 1"));
      const note = { tick: tick(n.step), len: tick(len), midi: n.midi, vel: 15, state, tieIn: legato, voice: st.voice };
      notes.push(note);
      // A tie's gate is its head's, over the whole tied length; MGSDRV cuts
      // the last note by its own q: the head takes that cut, exact.
      if (legato && head && head.midi === n.midi) {
        if (gated) {
          const tok = gate < span ? `:gate- ${lenToken(tick(span - gate))}` : ":gate* 1";
          const g = head.state.findIndex((t) => t.startsWith(":gate"));
          if (g >= 0) head.state[g] = tok;
          else head.state.push(tok);
          state[state.length - 1] = gateInForce = tok;
        }
      } else head = note;
      prev = n;
    }
    if (!notes.length) continue;
    // A track whose notes never move the pitch needs no `:pitch 0`.
    const clean = notes.every((n) => n.state.includes(":pitch 0")) ? notes.map((n) => ({ ...n, state: n.state.filter((x) => x !== ":pitch 0") })) : notes;
    const marks = tr.tempos.map((tm) => ({ tick: tick(tm.step), tokens: [`:tempo ${mgsBpm(tm.bpm)}`] }));
    const endTick = tick(tr.end);
    const loopTick = tr.loopStep != null ? tick(tr.loopStep) : null;
    if (loopTick != null && marks.length && !marks.some((m) => m.tick === loopTick)) {
      const inForce = marks.filter((m) => m.tick < loopTick).pop();
      if (inForce) { marks.push({ tick: loopTick, tokens: inForce.tokens }); marks.sort((x, y) => x.tick - y.tick); }
    }
    if (rhythmCh != null) {
      for (const t of rhythmOfFm(rhythmCh, clean, a.rhythmY)) songOut.push({ ...t, channel: `rhythm${++rhythmN}`, marks: rhythmN === 1 ? marks : [], endTick, loopTick });
      endMax = Math.max(endMax, endTick);
      continue;
    }
    songOut.push({ channel, notes: dropIdleNones(clean), marks, endTick, loopTick });
    endMax = Math.max(endMax, endTick);
  }
  // The song's tempo: #tempo, where no track sets one at its start.
  if (songOut.length && !songOut.some((t) => t.marks.some((m) => m.tick === 0)))
    songOut[0].marks.unshift({ tick: 0, tokens: [`:tempo ${mgsBpm(mgs.tempo)}`] });

  if (mgs.defs.notes.length) warnings.push(`${[...new Set(mgs.defs.notes)].join(", ")}: the tuning tables are not read (equal temperament, o4a = 440 Hz)`);
  for (const [k, n] of skipped) warnings.push(`${k} (${n}×)`);
  if (!songOut.length) warnings.push("no notes to import");

  const header = [`; Imported from ${options.fileName ?? "an MGS file"} (MGS${mgs.version}${mgs.opllMode ? ", #opll_mode 1" : ""})`];
  const score = [":target msx", mgs.title && `:title ${qstr(mgs.title)}`].filter(Boolean);
  header.push(`(def-score ${score.join(" ")})`);
  for (const d of defs) header.push("", d);

  const song = {
    header, bars: barEnds([], Math.max(1, endMax)), endTick: endMax, loopTick: null,
    tracks: songOut.map((t) => ({ channel: t.channel, head: [], notes: t.notes, marks: t.marks, endTick: t.endTick, loopTick: t.loopTick })),
  };
  const source = options.structure === false ? emitSong(withPre(song)) : emitStructured(song);
  return { source, warnings };
}
