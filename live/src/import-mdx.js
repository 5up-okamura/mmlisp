// ---------------------------------------------------------------------------
// MDX (.mdx, + its .pdx) → MMLisp, :target x68k
//
// MDX is MXDRV's compiled song for the X68000: eight FM tracks on the YM2151
// (A-H) and the ADPCM (track 9, or tracks 9-16 under PCM8), each a stream of
// notes and commands timed in clocks — 48 a quarter as MXDRV's MML has it,
// but a song is written on whatever grid its composer chose, and the import
// reads the quarter off the notes (analyzeMdx: 176-clock bars are 44 a
// quarter, so its notes are 8ths and 16ths, its tempo 48/44 faster); the
// timing is exact, no tempo is estimated. The tracks are played
// as MXDRV plays them (its 68000 code as portable_mdx ports it — where
// mdxmini's mdxmml_ym2151.c differs, MXDRV's is followed):
// repeats unrolled, each track up to its own loop (`L`, a jump back at its
// end) or its end, and then written by the shared back end (import-song.js),
// which folds the repeats again and keeps each track's own loop point.
//
// What maps:
//   @n                 the voice, a def-fm (DT2 kept) — with the track's MH
//                      PMS/AMS as its :fms / :ams
//   v / @v / ( )       :vel — v's table is a TL offset (2-42), @v the TL
//                      itself, 0.75 dB a step on the 2 dB ladder; on the
//                      ADPCM, PCM8's volume MXDRV picks for it (v8 the
//                      sample as it is, v15 +14 dB: the def's :fx gain)
//   p                  :pan (p0 mutes the track's notes)
//   q / @q, &, k       q as :gate* n/8, @q as :gate- n clocks, the note its
//                      full length; & legato (a tie, or a slur to another
//                      note), k a key-on n clocks late
//   D, _               :pitch (1/64 semitone a step), a portamento as a
//                      :pitch+ line over the note
//   MP / MA, MD        the software LFOs as :pitch+ / :vel+ curves (saw,
//                      square, triangle), MD their delay — restarted at each
//                      note, where MXDRV restarts them only with an MD
//   MH                 the OPM's LFO: :lfo-wave :lfo-freq :lfo-pmd :lfo-amd
//   w                  the noise (on track H, NE): its notes go to `noise`
//                      at :noise-rate 32 - NFRQ
//   @t, y$12           :tempo (Timer B: 4882.8125 / (256 - n) BPM); a track
//                      of no notes looping between two values is their average
//   y                  an operator's or the channel's registers as words
//   ADPCM              the PDX's samples, one wav, a def-pcm each; a note is
//                      its sample at c4, F its rate (3.9-15.6 kHz)
// Reported and left out: sync (tracks run free), the fade out, other
// registers.
//
//   parseMdx(bytes)                → the song: header, voices, tracks
//   analyzeMdx(mdx)                → what the import dialog shows
//   mdxToMmlisp(mdx, options, a)   → { source, warnings, pcm }
//     options: { pdx: Uint8Array | null, structure, fileName }
// ---------------------------------------------------------------------------

import { emitSong, emitStructured, barEnds, qstr, PPQN, stateChange, lenToken } from "./import-song.js";
import { fmVoiceDef } from "./import-fm-voices.js";
import { decodeOki } from "./import-vgm.js";
import { encodeWav } from "./export-wav.js";

// MXDRV's clock: 48 a quarter at Timer B's rate — the grid the file's
// timing is read against, unless its notes sit on another (analyzeMdx).
const CLOCKS_PER_QUARTER = 48;
// v0-v15 as TL added to the carriers (MXDRV's table).
const V_ATTEN = [42, 40, 37, 34, 32, 29, 26, 24, 21, 18, 16, 13, 10, 8, 5, 2];
const TL_DB = 0.75;
const VEL_DB = 2;
// An ADPCM note's level: MXDRV turns the TL offset into PCM8's volume
// (0-15), PCM8 scales the sample by its table's n/16 — 8 the sample as it is.
const PCM8_VOLUME = [
  15, 15, 15, 14, 14, 14, 13, 13, 13, 12, 12, 11, 11, 11, 10, 10, 10, 9, 9, 8, 8, 8,
  7, 7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0,
];
const PCM8_SCALE = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80];
const pcm8Gain = (atten) => PCM8_SCALE[PCM8_VOLUME[atten]] / 16;
// F0-F4: the ADPCM's rates (Hz), 15.6 kHz the one MXDRV starts at.
const PCM_RATES = [3906, 5208, 7812, 10417, 15625];
const NOTE_MIDI = 15; // note $80 is o0 d+ (KC 0 at the X68000's 4 MHz)
const MAX_CLOCKS = 48 * 4 * 4000; // a track that never ends is cut here
const LFO_WAVES = ["saw", "square", "triangle", "noise"];

const be16 = (u8, p) => (u8[p] << 8) | u8[p + 1];
const s16 = (u8, p) => { const v = be16(u8, p); return v >= 0x8000 ? v - 0x10000 : v; };
const sjis = (u8) => { try { return new TextDecoder("shift-jis").decode(u8); } catch { return String.fromCharCode(...u8); } };
const round2 = (x) => (Math.abs(x - Math.round(x)) < 0.005 ? Math.round(x) : +x.toFixed(2));
export const mdxBpm = (tb, quarter = CLOCKS_PER_QUARTER) =>
  round2((4882.8125 / (256 - Math.min(255, tb))) * (CLOCKS_PER_QUARTER / quarter));

// Bytes each command takes after its own (MDX command set, mdx.h).
function cmdLength(u8, p) {
  const c = u8[p];
  if (c <= 0x7f) return 1;
  if (c <= 0xdf) return 2;
  switch (c) {
    case 0xff: case 0xfd: case 0xfc: case 0xfb: case 0xf8: case 0xf0: case 0xef: case 0xed: case 0xe9: return 2;
    case 0xfe: case 0xf6: case 0xf5: case 0xf4: case 0xf3: case 0xf2: case 0xf1: return 3;
    case 0xfa: case 0xf9: case 0xf7: case 0xee: case 0xe8: return 1;
    case 0xec: case 0xeb: case 0xea: return u8[p + 1] === 0x80 || u8[p + 1] === 0x81 ? 2 : 6;
    case 0xe7: return u8[p + 1] === 0x00 ? 2 : 3;
    default: return 0; // undefined: MXDRV stops the track
  }
}

/** The file → { title, pdxName, voices: Map(num → voice), tracks: [{index, start}], pcm8 }. */
export function parseMdx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 0;
  while (p + 2 < u8.length && !(u8[p] === 0x0d && u8[p + 1] === 0x0a && u8[p + 2] === 0x1a)) p++;
  if (p + 2 >= u8.length) throw new Error("not an MDX file (no title terminator)");
  const title = sjis(u8.subarray(0, p)).trim();
  p += 3;
  const nameStart = p;
  while (p < u8.length && u8[p] !== 0) p++;
  let pdxName = String.fromCharCode(...u8.subarray(nameStart, p)).trim();
  if (pdxName && !/\.pdx$/i.test(pdxName)) pdxName += ".PDX";
  const base = p + 1;
  if (base + 4 > u8.length) throw new Error("not an MDX file (truncated header)");
  const voiceAt = base + be16(u8, base);
  const first = base + be16(u8, base + 2);
  const pcm8 = u8[first] === 0xe8;
  const count = pcm8 ? 16 : 9;
  const tracks = [];
  for (let i = 0; i < count; i++) {
    const at = base + be16(u8, base + 2 + i * 2);
    if (at >= u8.length) throw new Error(`MDX track ${i + 1} points past the file`);
    tracks.push({ index: i, start: at });
  }
  const voices = new Map();
  for (let q = voiceAt; q + 27 <= u8.length; q += 27) {
    const num = u8[q];
    const b = (k, i) => u8[q + 3 + k * 4 + i];
    const ops = [];
    for (let i = 0; i < 4; i++) {
      ops.push({
        dt: (b(0, i) >> 4) & 7, mul: b(0, i) & 15, tl: b(1, i) & 127,
        rs: b(2, i) >> 6, ar: b(2, i) & 31, am: b(3, i) >> 7, dr: b(3, i) & 31,
        dt2: b(4, i) >> 6, sr: b(4, i) & 31, sl: b(5, i) >> 4, rr: b(5, i) & 15, ssg: 0,
      });
    }
    voices.set(num, { num, alg: u8[q + 1] & 7, fb: (u8[q + 1] >> 3) & 7, slot: u8[q + 2], ops });
  }
  return { u8, title, pdxName, voices, tracks, pcm8 };
}

/**
 * A PDX bank → its samples, decoded: [{index, data: Float32Array}] (96 a
 * bank, the bank's table of 8-byte offset/size pairs first).
 */
export function parsePdx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = new Map();
  let dataTop = u8.length;
  for (let bank = 0; bank * 768 < dataTop && bank < 16; bank++) {
    for (let i = 0; i < 96; i++) {
      const q = bank * 768 + i * 8;
      if (q + 8 > dataTop) break;
      const at = ((u8[q] << 24) | (u8[q + 1] << 16) | (u8[q + 2] << 8) | u8[q + 3]) >>> 0;
      const size = ((u8[q + 4] << 24) | (u8[q + 5] << 16) | (u8[q + 6] << 8) | u8[q + 7]) >>> 0;
      if (!at || !size || at + size > u8.length) continue;
      if (at < dataTop) dataTop = at;
      out.set(bank * 96 + i, decodeOki(u8, at, size));
    }
  }
  return out;
}

// ── Playing a track ───────────────────────────────────────────────────────

function newState() {
  return {
    voice: 0, atten: V_ATTEN[8], normal: 8, lastNormal: true, pan: 3, q: 8, qMinus: 0,
    detune: 0, porta: 0, tie: false, keyDelay: 0,
    plfo: null, plfoOn: false, alfo: null, alfoOn: false, lfoDelay: 0,
    hlfo: null, hlfoOn: false, pmsAms: 0, noise: 0, pcmRate: 4, regs: [],
  };
}

/**
 * One track as MXDRV plays it, to its end or its loop: the notes it keys
 * ({clock, len, gate, midi, legato, st}, the state in force), the tempo
 * changes, where it loops ({loopClock}) and what was left out.
 *
 * Sync: `ef n` raises track n's flag ({to, clock} in `sends`); `ee` lowers
 * the track's own and goes on, or stops the track until the flag is raised
 * (MXDRV's L001498 / L0014b0 / L001192). `recv` is when this track's flag
 * goes up — the clocks the other tracks' `ef`s land at — or null while they
 * are not known yet: then an `ee` ends the track. A track that waits plays
 * on through its own loop for as long as it is woken, up to `until` (the
 * song's end: a track that waited once, in its intro, comes round no more).
 */
function playTrack(mdx, track, skipped, recv = null, until = Infinity) {
  const { u8 } = mdx;
  const st = newState();
  const notes = [];
  const tempos = [];
  const visits = new Map(); // ptr → clock, the first time at the top level
  const stack = []; // [{start, left}]
  let p = track.start;
  let clock = 0;
  let loopClock = null;
  let end = null;
  let steps = 0;
  const sends = [];
  let waits = false; // an `ee` seen: the track runs on its wake-ups, not its loop
  let lowered = -1; // the clock the flag was last lowered at
  const skip = (k) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  while (p < u8.length && clock < MAX_CLOCKS && ++steps < 2e6) {
    if (!stack.length && !visits.has(p)) visits.set(p, clock);
    const c = u8[p];
    const len = cmdLength(u8, p);
    if (!len) { skip(`command $${c.toString(16)} (the track stops there)`); end = clock; break; }
    const a1 = u8[p + 1], a2 = u8[p + 2];
    if (c <= 0x7f) {
      // A tied note sounds on through the rest after it, to its end (the
      // rest's own gate keys it off).
      const last = notes[notes.length - 1];
      if (last?.tieOn && last.held == null && last.clock + last.count === clock) last.held = c + 1;
      st.tie = false;
      clock += c + 1;
    } else if (c <= 0xdf) {
      const count = a1 + 1;
      notes.push({ clock, count, midi: c - 0x80, tieOn: st.tie, st: snapshot(st) });
      st.tie = false;
      st.porta = 0; // a portamento is the next note's alone
      clock += count;
    } else {
      switch (c) {
        case 0xff: if (a1 >= 2) tempos.push({ clock, tb: a1 }); break;
        case 0xfe:
          if (a1 === 0x12) tempos.push({ clock, tb: a2 });
          else st.regs = [...st.regs.filter((r) => r.reg !== a1), { reg: a1, val: a2 }];
          break;
        case 0xfd: st.voice = a1; st.regs = []; break;
        case 0xfc: st.pan = a1 & 3; break;
        case 0xfb:
          if (a1 < 16) { st.normal = a1; st.atten = V_ATTEN[a1]; st.lastNormal = true; }
          else if (a1 >= 0x80) { st.atten = a1 - 0x80; st.lastNormal = false; }
          break;
        case 0xfa: case 0xf9: {
          const d = c === 0xf9 ? 1 : -1; // ) louder, ( softer
          if (st.lastNormal) { st.normal = Math.max(0, Math.min(15, st.normal + d)); st.atten = V_ATTEN[st.normal]; }
          else st.atten = Math.max(0, Math.min(127, st.atten - d));
          break;
        }
        case 0xf8: if (a1 < 9) { st.q = a1; st.qMinus = 0; } else { st.q = 8; st.qMinus = 0x100 - a1; } break;
        case 0xf7: st.tie = true; break;
        case 0xf6: stack.push({ start: p + 3, left: a1 || 256 }); break;
        case 0xf5: {
          const top = stack[stack.length - 1];
          if (top && --top.left > 0) { p = top.start; continue; }
          stack.pop();
          break;
        }
        case 0xf4: {
          const top = stack[stack.length - 1];
          if (top && top.left === 1) {
            // The last pass leaves here: past the loop's end.
            stack.pop();
            p = loopEnd(u8, p + 3);
            continue;
          }
          break;
        }
        case 0xf3: st.detune = s16(u8, p + 1); break;
        case 0xf2: st.porta = s16(u8, p + 1); break;
        case 0xf1:
          if (a1 === 0) { end = clock; break; } // $F1 $00: the end (its second byte is not read)
          {
            const to = p + 3 + s16(u8, p + 1);
            // A track that waits goes round for as long as it is woken.
            if (waits && recv && clock < until) { p = to; visits.clear(); continue; }
            if (visits.has(to)) loopClock = visits.get(to);
            else skip("a loop point inside a repeat (the track is written to its end)");
          }
          end = clock;
          break;
        case 0xf0: st.keyDelay = a1; break;
        case 0xef: sends.push({ to: a1, clock }); break;
        case 0xee: {
          waits = true;
          const up = recv?.find((t) => t > lowered && t <= clock);
          if (up == null) {
            const next = recv?.find((t) => t > clock);
            if (next == null) { end = clock; break; } // never woken: it stops here
            clock = next;
          }
          lowered = clock;
          break;
        }
        case 0xed: if (track.index >= 8) st.pcmRate = a1; else st.noise = a1; break;
        case 0xec: lfoCmd(u8, p, st, "plfo"); break;
        case 0xeb: lfoCmd(u8, p, st, "alfo"); break;
        case 0xea:
          if (a1 === 0x80 || a1 === 0x81) st.hlfoOn = a1 === 0x81;
          else {
            // Both bytes go to $19: bit 7 says PMD, else AMD.
            const pm = [u8[p + 3], u8[p + 4]].filter((b) => b & 0x80).pop(), am = [u8[p + 3], u8[p + 4]].filter((b) => !(b & 0x80)).pop();
            st.hlfo = { wave: a1 & 3, sync: (a1 & 0x40) !== 0, freq: a2, pmd: (pm ?? 0) & 127, amd: am ?? 0 };
            st.pmsAms = u8[p + 5];
            st.hlfoOn = true;
          }
          break;
        case 0xe9: st.lfoDelay = a1; break;
        case 0xe8: break; // PCM8 mode: the track count
        case 0xe7: skip("fade out"); break;
      }
      if (end != null) break;
    }
    p += len;
  }
  if (end == null) {
    end = clock;
    if (clock >= MAX_CLOCKS) skip("a track that never reaches its end (cut)");
  }
  return { notes, tempos, loopClock, end, sends, waits };
}

// Past the F5 that closes the repeat a break at `p` is in.
function loopEnd(u8, p) {
  let depth = 0;
  while (p < u8.length) {
    const c = u8[p];
    const n = cmdLength(u8, p);
    if (!n) return p;
    if (c === 0xf6) depth++;
    else if (c === 0xf5) { if (depth === 0) return p + 3; depth--; }
    p += n;
  }
  return p;
}

function lfoCmd(u8, p, st, key) {
  const a1 = u8[p + 1];
  if (a1 === 0x80 || a1 === 0x81) { st[`${key}On`] = a1 === 0x81 && st[key] != null; return; }
  const clock = be16(u8, p + 2);
  let depth = s16(u8, p + 4);
  if (key === "plfo" && a1 >= 4) depth *= 256;
  st[key] = { form: a1 & 3, clock: Math.max(1, clock), depth };
  st[`${key}On`] = true;
}

const snapshot = (st) => ({ ...st, plfo: st.plfoOn ? st.plfo : null, alfo: st.alfoOn ? st.alfo : null,
  hlfo: st.hlfo, pmsAms: st.hlfoOn ? st.pmsAms : 0 });

/** A note's sounding length in clocks: its gate (q, @q, a tie). */
function gateOf(n) {
  if (n.tieOn) return n.count + (n.held ?? 0); // & : keyed on into what follows
  const q = n.st.qMinus ? n.count - n.st.qMinus : Math.floor((n.count * n.st.q) / 8);
  return Math.max(1, Math.min(n.count, q));
}

// ── Analysis ──────────────────────────────────────────────────────────────

const TRACK_NAMES = "ABCDEFGHPQRSTUVW";

// Every track as MXDRV plays it, the waiting ones on the others' `ef`s: a
// track's flag goes up at an `ef`'s clock, seen that tick by the tracks
// after the sender (MXDRV runs them in order) and the next by those before.
// A waiting track that sends wakes others in turn: replayed till it settles.
// Its loop is its waker's — it is woken from that track's loop, pass after
// pass, where the import plays one.
function playAll(mdx, skipped) {
  let res = mdx.tracks.map((t) => playTrack(mdx, t, new Map()));
  const until = Math.max(0, ...res.filter((r) => !r.waits).map((r) => r.end));
  for (let round = 0; round < 4 && res.some((r) => r.waits); round++) {
    const recv = mdx.tracks.map((t) =>
      res.flatMap((r, s) => r.sends.filter((x) => x.to === t.index).map((x) => x.clock + (s < t.index ? 0 : 1))).sort((x, y) => x - y));
    res = mdx.tracks.map((t, i) => (res[i].waits ? playTrack(mdx, t, new Map(), recv[i], until) : res[i]));
  }
  // Once more, counting what is left out once.
  const final = mdx.tracks.map((t, i) => {
    if (!res[i].waits) return playTrack(mdx, t, skipped);
    const recv = res.flatMap((r, s) => r.sends.filter((x) => x.to === t.index).map((x) => ({ at: x.clock + (s < t.index ? 0 : 1), s })));
    const r = playTrack(mdx, t, skipped, recv.map((x) => x.at).sort((x, y) => x - y), until);
    const waker = res[recv.at(-1)?.s];
    return waker ? { ...r, loopClock: waker.loopClock, end: Math.max(r.end, waker.end) } : r;
  });
  return final;
}

export function analyzeMdx(mdx) {
  const skipped = new Map();
  const played = playAll(mdx, skipped);
  const tracks = mdx.tracks.map((t, i) => {
    const r = played[i];
    const pcm = t.index >= 8;
    const name = pcm ? (mdx.pcm8 ? `PCM ${t.index - 7}` : "ADPCM") : `FM ${TRACK_NAMES[t.index]}`;
    return { ...t, ...r, pcm, name, label: `${name} · ${r.notes.length} notes${r.loopClock != null ? ", loops" : ""}` };
  });
  const quarter = quarterOf(tracks);
  // At clock 0 the tracks run in order: the last track's tempo is the one in force.
  const tempo = tracks.flatMap((t) => t.tempos).filter((t) => t.clock === 0).pop();
  return { tracks, skipped, quarter, bpm: mdxBpm(tempo ? tempo.tb : 200, quarter) };
}

// The quarter note in clocks: the coarsest grid nine notes in ten sit on
// (onset and length — a run of 7- and 9-clock notes, a grace, a `k`, are
// the tenth), times 2^k · 3^j where that lands nearest MXDRV's 48 — so a
// song on MXDRV's own grid (a 16th 12 clocks, a triplet 8) reads as 48,
// and one its composer wrote on 22-clock 8ths (176-clock bars) as 44.
function quarterOf(tracks) {
  const vals = tracks.flatMap((t) => t.notes.flatMap((n) => [n.clock, n.count]));
  let g = 1;
  for (let u = CLOCKS_PER_QUARTER; u > 2; u--) {
    if (vals.filter((v) => v % u === 0).length >= vals.length * 0.9) { g = u; break; }
  }
  if (g === 1) return CLOCKS_PER_QUARTER;
  let best = CLOCKS_PER_QUARTER, err = Infinity;
  for (const j of [1, 3])
    for (let q = g * j; q < CLOCKS_PER_QUARTER * 2; q *= 2) {
      const e = Math.abs(Math.log(q / CLOCKS_PER_QUARTER));
      if (e < err) { err = e; best = q; }
    }
  return best;
}

// ── Writing ───────────────────────────────────────────────────────────────

const panWord = (p) => (p === 1 ? "left" : p === 2 ? "right" : "center");
// v as :vel: v15 (TL +2) at 15, 0.75 dB a TL step on the 2 dB ladder.
const velOf = (atten) => Math.max(0, Math.min(15, 15 - Math.round(((atten - 2) * TL_DB) / VEL_DB)));
const cents = (kf) => Math.round((kf * 100) / 64);

// The software LFOs, MXDRV's shapes: the pitch LFO (MP; a step a clock of
// depth/256 in 1/64 semitone) bipolar — a saw rising from 0 over its period,
// a square ±depth, a triangle a period of 2P rising first — as a :pitch+
// curve; the volume LFO (MA; depth/256 TL a clock) only ever quieter, from 0,
// as a :vel+ one. Its random shape (3) is left out.
function pitchLfoCurve({ form, clock: P, depth }, tick) {
  const t2 = (n) => `${tick(n)}t`;
  const u = (x) => Math.round((x * 100) / 64 / 256); // cents
  if (form === 0) { const a = u((depth * P) / 2); return a ? `(saw ${-a}..${a} :len ${t2(P)} :phase 128)` : null; }
  if (form === 1) { const a = u(depth); return a ? `(square ${a}..${-a} :len ${t2(P * 2)})` : null; }
  if (form === 2) { const a = u((depth * P) / 2); return a ? `(triangle ${-a}..${a} :len ${t2(P * 2)} :phase 64)` : null; }
  return null;
}
function volLfoCurve({ form, clock: P, depth }, tick) {
  const t2 = (n) => `${tick(n)}t`;
  const v = (tl) => -Math.round(((Math.abs(tl) / 256) * TL_DB * 100) / VEL_DB) / 100; // :vel steps, quieter
  if (form === 0) { const a = v(depth * P); return a ? `(saw 0..${a} :len ${t2(P)})` : null; }
  if (form === 1) { const a = v(depth); return a ? `(square 0..${a} :len ${t2(P * 2)})` : null; }
  if (form === 2) { const a = v(depth * P); return a ? `(triangle 0..${a} :len ${t2(P * 2)})` : null; }
  return null;
}

const OP_OF_SLOT = [1, 3, 2, 4]; // register order M1 M2 C1 C2 → op1-op4
const DT_WORD = [0, 1, 2, 3, 0, -1, -2, -3];

// A `y` on the track's own channel as words, or null.
function regWords(reg, val, ch) {
  if (reg >= 0x40 && (reg & 7) === ch) {
    const n = OP_OF_SLOT[(reg >> 3) & 3];
    switch (reg & 0xe0) {
      case 0x40: return `:dt${n} ${DT_WORD[(val >> 4) & 7]} :ml${n} ${val & 15}`;
      case 0x60: return `:tl${n} ${val & 127}`;
      case 0x80: return `:ks${n} ${val >> 6} :ar${n} ${val & 31}`;
      case 0xa0: return `:am${n} ${val >> 7} :dr${n} ${val & 31}`;
      case 0xc0: return `:dt2-${n} ${val >> 6} :sr${n} ${val & 31}`;
      case 0xe0: return `:sl${n} ${val >> 4} :rr${n} ${val & 15}`;
    }
  }
  if (reg === 0x20 + ch) return `:fb ${(val >> 3) & 7} :alg ${val & 7}`;
  return null;
}

/**
 * @param options { pdx?: Uint8Array, structure?: boolean, fileName? }
 */
export function mdxToMmlisp(mdx, options = {}, a = analyzeMdx(mdx)) {
  const warnings = [];
  const skipped = new Map(a.skipped);
  const skip = (k) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  const defs = [];
  const usedNames = new Set();
  const uniq = (base) => { let n = base; for (let k = 2; usedNames.has(n); k++) n = `${base}-${k}`; usedNames.add(n); return n; };

  // Voices: one def per voice and LFO sensitivity it plays with.
  const voiceDefs = new Map();
  const voiceName = (num, pmsAms) => {
    const key = `${num}:${pmsAms}`;
    if (!voiceDefs.has(key)) {
      const v = mdx.voices.get(num);
      if (!v) { voiceDefs.set(key, null); warnings.push(`voice @${num} is not in the file — its notes play the voice before`); return null; }
      const fms = (pmsAms >> 4) & 7, ams = pmsAms & 3;
      const name = uniq(`voice-${String(num).padStart(2, "0")}${pmsAms ? `-p${fms}a${ams}` : ""}`);
      defs.push(fmVoiceDef(name, { alg: v.alg, fb: v.fb, ams, fms, ops: v.ops }, { dt2: true }));
      if ((v.slot & 15) !== 15) warnings.push(`voice @${num} keys only some operators (slot mask ${v.slot & 15}): it is written whole`);
      voiceDefs.set(key, name);
    }
    return voiceDefs.get(key);
  };

  // The PDX's samples: those the song plays, in one wav.
  const pdx = options.pdx ? parsePdx(options.pdx) : null;
  const pcmTracks = a.tracks.filter((t) => t.pcm && t.notes.length);
  if (pcmTracks.length && !pdx)
    warnings.push(`the ADPCM tracks need ${mdx.pdxName || "the song's PDX"} — pick it with the MDX; they are left out`);
  const samples = new Map(); // index → {name, data, rates}
  const sampleOf = (n) => {
    // D moves the sample index (1/64 a step, +5); the bank is PCM8's.
    const index = (mdx.pcm8 ? n.st.voice * 96 : 0) + ((n.midi * 64 + 5 + n.st.detune) >> 6);
    if (!pdx?.has(index)) return null;
    if (!samples.has(index)) samples.set(index, { index, name: `pdx-${String(index).padStart(3, "0")}`, data: pdx.get(index), rates: new Map() });
    const sm = samples.get(index);
    const r = PCM_RATES[Math.min(4, n.st.pcmRate)];
    sm.rates.set(r, (sm.rates.get(r) ?? 0) + 1);
    return sm;
  };

  // Track H's noise: its notes go to `noise` when most are played with NE on.
  const trackH = a.tracks[7];
  const noisy = trackH ? trackH.notes.filter((n) => n.st.noise & 0x80).length : 0;
  const hToNoise = trackH && noisy > trackH.notes.length / 2;
  if (trackH && noisy && !hToNoise) warnings.push(`FM H: ${noisy} notes played with the noise on are played as FM (fm8)`);
  if (hToNoise && noisy < trackH.notes.length) warnings.push(`FM H: ${trackH.notes.length - noisy} notes played without the noise are left out (the noise is fm8's fourth operator)`);

  const songOut = [];
  let endMax = 0;
  for (const tr of a.tracks) {
    if (!tr.notes.length) continue;
    let channel;
    if (tr.pcm) {
      if (!pdx) continue;
      channel = `pcm${tr.index - 7}`;
    } else channel = tr.index === 7 && hToNoise ? "noise" : `fm${tr.index + 1}`;
    const isNoise = channel === "noise";
    const tick = (c) => Math.round((c * PPQN) / a.quarter);
    const notes = [];
    let prev = null; // the note before, as played
    let detuned = false; // a D seen: from then on every note states its :pitch, 0 too
    let head = null; // the note a tie continues: the one keyed, or slurred to
    let keyedAt = 0; // the tick of the last key-on
    let gated = false; // a q or @q seen: from then on every note states its gate
    let gateInForce = ":gate* 1";
    tr.notes.forEach((n) => {
      const st = n.st;
      if (isNoise && !(st.noise & 0x80)) return;
      if (!tr.pcm && st.pan === 0) return; // p0: not keyed
      const delay = Math.min(st.keyDelay, n.count - 1);
      const gate = gateOf(n);
      // The note keeps its whole slot (a tie into a rest, the rest too) and
      // q / @q are its gate, as the MML has them: q n/8 of it, @q n short.
      // A gate the slot can't hold (@q past a short note, the ADPCM's
      // shots) is the note's own length instead.
      const span = n.tieOn ? gate : n.count;
      let len = Math.max(1, span - delay);
      let gateTok = null;
      if (!tr.pcm && gate < span) {
        if (gate - delay >= 1 && (st.qMinus ? st.qMinus < len : true)) gateTok = st.qMinus ? `:gate- ${lenToken(tick(st.qMinus))}` : `:gate* ${st.q / 8}`;
        else len = Math.max(1, gate - delay);
      }
      if (gateTok) gated = true;
      const legato = !!prev && prev.tieOn && prev.clock + prev.count === n.clock;
      prev = n;
      // MD's delay runs from the key-on: a note played legato is into it.
      const at = tick(n.clock + delay);
      if (!legato || tr.pcm) keyedAt = at;
      const lfoWait = Math.max(0, tick(st.lfoDelay) - (at - keyedAt));
      const waited = (c) => (lfoWait ? c.replace(/\)$/, ` :wait ${lfoWait}t)`) : c);
      const state = [];
      let midi = n.midi + NOTE_MIDI;
      let vel = velOf(st.atten);
      if (tr.pcm && st.atten >= 0x2b) { skip("an ADPCM note too quiet for PCM8 (muted)"); return; }
      if (tr.pcm) {
        const sm = sampleOf(n);
        if (!sm) { skip("an ADPCM note with no sample in the PDX"); return; }
        state.push(sm.name);
        midi = { sm, rate: PCM_RATES[Math.min(4, st.pcmRate)] }; // a pitch once the sample's rate is known
        vel = { sm, gain: pcm8Gain(st.atten) }; // a :vel once the sample's loudest is known
        sm.gain = Math.max(sm.gain ?? 0, vel.gain);
      } else if (isNoise) {
        const v = mdx.voices.get(st.voice);
        vel = velOf(st.atten + (v ? v.ops[3].tl : 0));
        state.push(`:noise-rate ${Math.max(1, Math.min(31, 32 - (st.noise & 31)))}`);
        midi = 60;
      } else {
        const name = voiceName(st.voice, st.pmsAms);
        if (name) state.push(name);
        for (const r of st.regs) {
          const w = regWords(r.reg, r.val, tr.index);
          if (w) state.push(w);
          else skip(`y$${r.reg.toString(16)} (a register outside the track's channel)`);
        }
        state.push(`:pan ${panWord(st.pan)}`);
        if (st.hlfo) state.push(`:lfo-wave ${LFO_WAVES[st.hlfo.wave]} :lfo-freq ${st.hlfo.freq} :lfo-pmd ${st.hlfo.pmd} :lfo-amd ${st.hlfo.amd}`);
        if (st.hlfo?.sync) skip("MH's LFO sync (the LFO is not reset at each note)");
        if (st.detune) detuned = true;
        if (detuned) state.push(`:pitch ${cents(st.detune)}`);
      }
      // The note's own moves: a portamento, the LFOs.
      const pitch = [];
      if (!tr.pcm && !isNoise) {
        if (st.porta) {
          // It bends on past the key-off, to the next note.
          const total = cents((st.porta * n.count) / 256);
          if (total) pitch.push(`(linear 0..${total} :len ${tick(n.count)}t)`);
        }
        if (st.plfo) {
          const c = pitchLfoCurve(st.plfo, tick);
          if (c) pitch.push(waited(c));
        }
      }
      if (pitch.length > 1) skip("a portamento under the pitch LFO (the LFO is dropped for that note)");
      state.push(pitch.length ? `(macro :pitch+ ${pitch[0]})` : "(macro :pitch none)");
      if (!tr.pcm && st.alfo) {
        const c = volLfoCurve(st.alfo, tick);
        state.push(c ? `(macro :vel+ ${waited(c)})` : "(macro :vel none)");
      } else if (!tr.pcm) state.push("(macro :vel none)");
      // A note keyed on into the next (&) sounds its whole slot whatever its
      // gate: it keeps the one in force, so none is written for it. One held
      // on through a rest is that long, at a full gate.
      if (gated && !tr.pcm) state.push((gateInForce = n.tieOn && n.held == null ? gateInForce : gateTok ?? ":gate* 1"));
      const note = { tick: at, len: Math.max(1, tick(n.clock + delay + len) - at), midi, vel, state, tieIn: legato && !tr.pcm };
      notes.push(note);
      // A tie's gate is the chain's head's, over the whole tied length; MXDRV
      // cuts the last note by its own q: the head takes that cut, exact.
      if (gated && note.tieIn && head && head.midi === note.midi) {
        const cut = n.count - gate;
        const tok = cut > 0 ? `:gate- ${lenToken(tick(n.clock + n.count) - tick(n.clock + gate))}` : ":gate* 1";
        const g = head.state.findIndex((t) => t.startsWith(":gate"));
        if (g >= 0) head.state[g] = tok;
        else head.state.push(tok);
        state[state.length - 1] = gateInForce = tok;
      }
      // A tie starts nothing — its moves are read at the note it continues —
      // so a portamento on a tied note starts there, :wait'ed to its place.
      if (note.tieIn && head && head.midi === note.midi) {
        if (st.porta && pitch.length) {
          const slot = head.state.indexOf("(macro :pitch none)");
          if (slot >= 0) {
            head.state[slot] = `(macro :pitch+ ${pitch[0].replace(/\)$/, ` :wait ${note.tick - head.tick}t)`)})`;
            // The tied note restates it, so nothing is written there.
            state[state.indexOf(`(macro :pitch+ ${pitch[0]})`)] = head.state[slot];
          } else skip("a portamento on a tied note under the first note's own pitch move (left out)");
        }
        // Nor does it restart the LFOs: its macros are the head's, unwritten.
        for (let i = 0; i < state.length; i++) {
          const kind = state[i].match(/^\(macro :(pitch|vel)\b/)?.[1];
          const h = kind && head.state.find((t) => t.startsWith(`(macro :${kind}`));
          if (h) state[i] = h;
        }
      } else head = note;
    });
    if (!notes.length) continue;
    const marks = [];
    for (const tm of tr.tempos) marks.push({ tick: tick(tm.clock), tokens: [`:tempo ${mdxBpm(tm.tb, a.quarter)}`] });
    const endTick = tick(tr.end);
    const loopTick = tr.loopClock != null ? tick(tr.loopClock) : null;
    // The tempo in force where the track loops is restated there.
    if (loopTick != null && marks.length && !marks.some((m) => m.tick === loopTick)) {
      const inForce = marks.filter((m) => m.tick < loopTick).pop();
      if (inForce) marks.push({ tick: loopTick, tokens: inForce.tokens });
      marks.sort((x, y) => x.tick - y.tick);
    }
    songOut.push({ channel, notes: dropIdleNones(notes), marks, endTick, loopTick, tr });
    endMax = Math.max(endMax, endTick);
  }
  // A track written out of the score (no notes — one that only sets the
  // tempo — or ADPCM without its PDX) still sets it: its changes go on the
  // first track. A loop of them (MXDRV's way to a tempo between two Timer B
  // values: a few clocks of each, over and over) is its average, once.
  const host = songOut[0];
  if (host) {
    const written = new Set(songOut.map((t) => t.tr));
    const add = [];
    for (const tr of a.tracks) {
      if (written.has(tr) || !tr.tempos.length) continue;
      const looped = tr.loopClock != null && tr.end > tr.loopClock;
      for (const tm of tr.tempos) if (!looped || tm.clock < tr.loopClock) add.push(tm);
      if (looped) {
        // Clocks are Timer B periods of 256 - tb: the body's time over its clocks.
        let inForce = tr.tempos.filter((tm) => tm.clock <= tr.loopClock).pop();
        let span = 0, at = tr.loopClock;
        for (const tm of [...tr.tempos.filter((t) => t.clock > tr.loopClock), { clock: tr.end }]) {
          span += (tm.clock - at) * (256 - (inForce?.tb ?? 200));
          at = tm.clock;
          if (tm.tb != null) inForce = tm;
        }
        add.push({ clock: tr.loopClock, tb: 256 - span / (tr.end - tr.loopClock) });
      }
    }
    if (add.length) {
      // A track's marks are its tempos: the host's are written again, all of
      // them, one a tick, and the one in force restated at its loop.
      const tick = (c) => Math.round((c * PPQN) / a.quarter);
      const at = new Map();
      for (const tm of [...host.tr.tempos, ...add].sort((x, y) => x.clock - y.clock)) at.set(tick(tm.clock), tm.tb);
      if (host.loopTick != null && !at.has(host.loopTick)) {
        const before = [...at].filter(([t]) => t < host.loopTick).pop();
        if (before) at.set(host.loopTick, before[1]);
      }
      host.marks = [...at].sort((x, y) => x[0] - y[0]).map(([t, tb]) => ({ tick: t, tokens: [`:tempo ${mdxBpm(tb, a.quarter)}`] }));
    }
  }
  if (songOut.length && !songOut.some((t) => t.marks.some((m) => m.tick === 0)))
    songOut[0].marks.unshift({ tick: 0, tokens: [`:tempo ${mdxBpm(200, a.quarter)}`] });

  // The samples' wav, at the chip's own scale. A note at another rate than
  // its sample's is that many semitones off c4; a sample PCM8 plays louder
  // than it is gets that as its def's gain, its notes' :vel under it.
  let pcm = null;
  if (samples.size) {
    const list = [...samples.values()].sort((x, y) => x.index - y.index);
    let offset = 0;
    for (const sm of list) {
      let frames = sm.data.length;
      while (frames > 1 && Math.abs(sm.data[frames - 1]) < 1 / 256) frames--;
      sm.frames = frames;
      sm.offset = offset;
      offset += frames;
      sm.rate = [...sm.rates].reduce((x, y) => (y[1] > x[1] ? y : x))[0];
    }
    const mono = new Float32Array(offset);
    for (const sm of list) mono.set(sm.data.subarray(0, sm.frames), sm.offset);
    const base = String(options.fileName || mdx.pdxName || "mdx").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
    const wavFile = `${base}-pdx.wav`;
    const wavRate = list[0].rate;
    const db = (g) => Math.round(20 * Math.log10(g) * 10) / 10;
    for (const sm of list) {
      const fx = sm.gain > 1 ? ` :fx [(gain ${db(sm.gain)})]` : "";
      defs.push(`(def-pcm ${sm.name} :file ${qstr(wavFile)} :rate ${sm.rate} :offset ${sm.offset} :frames ${sm.frames}${fx})`);
    }
    for (const t of songOut)
      for (const nn of t.notes) {
        if (typeof nn.midi === "object") nn.midi = 60 + Math.round(12 * Math.log2(nn.midi.rate / nn.midi.sm.rate));
        if (typeof nn.vel === "object") {
          const under = 20 * Math.log10(nn.vel.gain / Math.max(1, nn.vel.sm.gain));
          nn.vel = Math.max(0, 15 + Math.round(under / VEL_DB));
        }
      }
    pcm = { wavFile, rate: wavRate, mono, wav: encodeWav(mono, null, wavRate),
      entries: list.map((sm) => ({ name: sm.name, offset: sm.offset, frames: sm.frames, rate: sm.rate })), tag: "MDX" };
  }

  for (const [k, n] of skipped) warnings.push(`${k} (${n}×)`);
  if (!songOut.length) warnings.push("no notes to import");

  const header = [`; Imported from ${options.fileName ?? "an MDX file"} (MDX${mdx.pcm8 ? ", PCM8" : ""}${mdx.pdxName ? `, ${mdx.pdxName}` : ""})`];
  const score = [":target x68k", mdx.title && `:title ${qstr(mdx.title)}`].filter(Boolean);
  header.push(`(def-score ${score.join(" ")})`);
  for (const d of defs) header.push("", d);

  const bars = barEnds([], Math.max(1, endMax));
  const song = {
    header, bars, endTick: endMax, loopTick: null,
    tracks: songOut.map((t) => ({ channel: t.channel, head: [], notes: t.notes, marks: t.marks, endTick: t.endTick, loopTick: t.loopTick })),
  };
  const source = options.structure === false ? emitSong(withPre(song)) : emitStructured(song);
  return { source, warnings, pcm };
}

// For the plain writer: each note's switches that changed, as `pre`.
export function withPre(song) {
  return {
    ...song,
    tracks: song.tracks.map((tr) => {
      let cur = tr.notes[0]?.state ?? [];
      const notes = tr.notes.map((n, i) => {
        const pre = i ? stateChange(cur, n.state) : undefined;
        cur = n.state;
        return { ...n, pre };
      });
      return { ...tr, head: tr.notes[0]?.state ?? [], notes };
    }),
  };
}

// A macro target no note of the track sets needs no `none` either. A def
// names its target by its prefix (import-song.js switchKind).
const DEF_TARGET = { vol: "vol", env: "vel", bend: "pitch", vib: "pitch" };
const macroTarget = (x) => (x.startsWith("(macro :") ? (x.endsWith(" none)") ? null : /^\(macro :([a-z]+)/.exec(x)[1])
  : DEF_TARGET[/^([a-z]+)-/.exec(x)?.[1]] ?? null);
export function dropIdleNones(notes) {
  const idle = ["pitch", "vel", "vol"].filter((t) => !notes.some((n) => n.state.some((x) => macroTarget(x) === t)));
  if (!idle.length) return notes;
  const nones = new Set(idle.map((t) => `(macro :${t} none)`));
  return notes.map((n) => ({ ...n, state: n.state.filter((x) => !nones.has(x)) }));
}
