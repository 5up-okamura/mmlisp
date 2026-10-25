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
// What maps:
//   PSG 1-3         sqr1-sqr3; `/` (and an envelope's mode) the mixer as
//                   :mode tone | noise | both, `n` the song's :noise-rate
//   SCC 4-8         wave1-wave5; `@n` the @s wave, a def-wave
//   FM 9-17         fm1-fm9 (fm1-fm6 in #opll_mode 1); `@n` an @v voice,
//                   a def-fm on the OPLL's words, else ROM voice n
//                   (violin …); so / sf :sus
//   v, v+ / v-      :vol — the SSG's and the OPLL's 3 dB steps, the SCC's
//                   linear volume
//   @e / @r, @n     the level envelope (PSG: `@n` selects it) as a :vol
//                   macro scaled by v, frame by frame; @r's RR its release
//   q, &            the note's length (q n/8 of it), & legato
//   \ / @\          :pitch — a period offset, in cents at each note
//   h, ho / hf      the software LFO as a :pitch+ triangle
//   _               a portamento: a :pitch+ line from the base note
//   t, #tempo       :tempo (BPM)
//   FM rhythm       (track 15 in #opll_mode 1) rhythm1-rhythm5, a track a
//                   sound — b s m c h as kick snare tom4 ride hat — each hit
//                   at c4 until the sound's next; vb vs vm vc vh its :vol
// Not yet: the PSG's hardware envelope (s, m) waits for its word; it, and
// whatever else the file holds, is counted and reported.
//
// MGSDRV's own behavior is read from the format and its demos, not held to
// the driver: envelopes scale v (v × level / 15), an @e step is a frame,
// `n:c` slides to n over c frames, `q` is eighths.
//
//   parseMgs(bytes)               → the song: header, definitions, tracks
//   analyzeMgs(mgs)               → what the import dialog shows
//   mgsToMmlisp(mgs, options, a)  → { source, warnings }
// ---------------------------------------------------------------------------

import { emitSong, emitStructured, barEnds, qstr, PPQN } from "./import-song.js";
import { withPre, dropIdleNones } from "./import-mdx.js";
import { OPLL_ROM_NAMES } from "./chips/ym2413.js";

const TICKS_PER_STEP = PPQN / 48;
const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
const MAX_STEPS = 48 * 4 * 4000; // a track that never ends is cut here
const PSG_CLOCK = 1789772.5;

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
  const envs = new Map(), waves = new Map(), voices = new Map();
  const notes = [];
  while (p < u8.length) {
    const c = u8[p++];
    if (c === 0xff) break;
    if (c === 0x00) { voices.set(u8[p] & 31, [...u8.subarray(p + 1, p + 9)]); p += 9; }
    else if (c === 0x01) p += 2;
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
  return { envs, waves, voices, notes };
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
  let defs = { envs: new Map(), waves: new Map(), voices: new Map(), notes: [] };
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
const OPLL_CLOCK = 3579545;

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
    oct: 4, len: 48, q: 8, k: 0, vol: 15, voice: null, env: null, mode: 1, nfreq: null, detune: 0,
    lfo: null, lfoOn: false, porta: null, tie: false, sus: 0, kind,
    rvol: [15, 15, 15, 15, 15], // the rhythm's levels: BD SD TOM CYM HH
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
  const skip = (k) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  const note = (n, count) => {
    const base = st.porta;
    st.porta = null;
    if (n >= 12) { st.tie = false; step += count; return; } // a rest
    notes.push({ step, count, midi: 12 * (st.oct + 1) + n, base, tieOn: st.tie, st: { ...st } });
    st.tie = false;
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
      counts(u8, p + 1).forEach((n, i, all) => { if (i < all.length - 1) st.tie = true; note(c, n); });
      p += len;
      continue;
    } else if ((c >= 0x10 && c <= 0x1c) || (c >= 0x30 && c <= 0x3c)) { note(c & 15, st.len); p += len; continue; }
    else if (c >= 0x20 && c <= 0x2c) { note(c & 15, a1 || 256); p += len; continue; }
    if (c >= 0x80 && c <= 0x9f) {
      // @n: the PSG's envelope, the SCC's wave, the FM's voice.
      if (kind === "psg") st.env = c & 31; else st.voice = c & 31;
    } else if (c >= 0xc0 && c <= 0xcf) st.vol = c & 15;
    else if (c >= 0xd0 && c <= 0xdf) st.oct = (c & 7) + 1;
    else if (c >= 0xe0 && c <= 0xef) st.mode = c & 3;
    else switch (c) {
      case 0x40: st.tie = true; break;
      case 0x41: tempos.push({ step, bpm: u16(u8, p + 1) }); break;
      case 0x42: st.len = a1 || 256; break;
      case 0x43: st.len = u16(u8, p + 1); break;
      case 0x44: st.q = a1 & 15; break;
      case 0x45: if ((a1 >> 5) < 5) st.rvol[a1 >> 5] = a1 & 15; break;
      case 0x47: if ((a1 >> 5) < 5) st.rvol[a1 >> 5] = Math.max(0, Math.min(15, st.rvol[a1 >> 5] + ((a1 & 0x1f) >= 16 ? (a1 & 0x1f) - 32 : a1 & 0x1f))); break;
      case 0x46: st.vol = Math.max(0, Math.min(15, st.vol + s8(a1))); break;
      case 0x48: st.k = a1; break;
      case 0x49: st.env = a1 & 31; break;
      case 0x4a: break; // an FM key-off
      case 0x4b: case 0x4c: skip("the PSG's hardware envelope (s, m)"); break;
      case 0x4d: st.nfreq = a1 & 31; break;
      case 0x4e: st.oct = Math.min(8, st.oct + 1); break;
      case 0x4f: st.oct = Math.max(1, st.oct - 1); break;
      case 0x50: st.detune = s8(a1); break;
      case 0x51: st.detune = s16(u8, p + 1); break;
      case 0x52: break; // the bend speed: a portamento spans its note
      case 0x53: st.porta = { n: a1 & 15, oct: st.oct }; break;
      case 0x54: st.lfo = { delay: a1 - 1, speed: u8[p + 2], mode: u8[p + 3] - 1, depth: s8(u8[p + 4]) }; st.lfoOn = true; break;
      case 0x55: skip("@p"); break;
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
      case 0x5a: if (!rhythm) st.lfoOn = a1 !== 0; else skip("the rhythm's ko / kf"); break;
      case 0x5b: st.sus = a1 ? 1 : 0; break;
      case 0x5c: skip("y (a register write)"); break;
      case 0x5d: if (!stack.length) dollar = { step }; else skip("a `$` inside a repeat"); break;
      case 0x5f: skip("@\\ on FM"); break;
      case 0x60: break; // @m: a message
      case 0x61: skip("@o"); break;
      case 0x63: skip("@f"); break;
      case 0x64: break; // hi
    }
    if (end != null) break;
    p += len;
  }
  if (end == null) { end = step; if (step >= MAX_STEPS) skip("a track that never reaches its end (cut)"); }
  return { notes, tempos, loopStep, end };
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
  const bpm = tracks.flatMap((t) => t.tempos).find((x) => x.step === 0)?.bpm ?? mgs.tempo;
  return { tracks, skipped, bpm };
}

// ── Writing ───────────────────────────────────────────────────────────────

// A register level as :vol — the SSG's 3 dB steps, the SCC's linear 4 bits —
// on the fader's 2 dB ones; 0 is the fader's mute.
const ssgVol = (r) => (r <= 0 ? 0 : 31 - Math.round(1.5 * (15 - Math.min(15, r))));
const sccVol = (r) => (r <= 0 ? 0 : Math.max(1, Math.min(31, 31 + Math.round((20 * Math.log10(Math.min(15, r) / 15)) / 2))));
const MODES = [null, "tone", "noise", "both"];

// A note's period on the PSG (o4a = 440 Hz) or the SCC, and a period offset
// as cents there.
function detuneCents(kind, midi, d) {
  const hz = 440 * 2 ** ((midi - 69) / 12);
  if (kind === "fm") {
    // An F-number offset, at the block that holds the note in 256-511.
    let f = (hz * 72 * 2 ** 19) / OPLL_CLOCK;
    while (f >= 512) f /= 2;
    return Math.round(1200 * Math.log2(Math.max(1, f + d) / f));
  }
  const p = kind === "psg" ? PSG_CLOCK / 16 / hz : PSG_CLOCK / 32 / hz - 1;
  const q = Math.max(1, Math.min(4095, p + d)); // the 12-bit period
  return Math.round(1200 * Math.log2((kind === "psg" ? p : p + 1) / (kind === "psg" ? q : q + 1)));
}

const ENV_MAX_FRAMES = 600;

/**
 * An @e envelope frame by frame: the level and the pitch offset (its `\`
 * steps add up, + up — the track's `\` MGSC stores as a period offset, but
 * an envelope is any channel's) of each, where its `[` loops from, and the
 * mixer, noise and wave its steps set before the first level.
 */
function expandEnv(env) {
  const levels = [], offsets = [];
  let level = 15, off = 0, sus = null, i = 0;
  let mode = env.mode || null, nfreq = env.mode & 2 ? env.nfreq : null, wave = null, moves = 0;
  const d = env.data;
  const frame = (n) => { for (let k = 0; k < n && levels.length < ENV_MAX_FRAMES; k++) { levels.push(level); offsets.push(off); } };
  while (i < d.length && levels.length < ENV_MAX_FRAMES) {
    const c = d[i++];
    const first = !levels.length;
    if (c < 0x10) { level = c; frame(1); }
    else if (c === 0x10) { const w = d[i++] & 31; if (first) wave = w; else moves++; }
    else if (c === 0x11) i += 2;
    else if (c === 0x12) off += s8(d[i++]);
    else if (c >= 0x20 && c <= 0x2f) { level = c & 15; frame(d[i++] || 256); }
    else if (c === 0x40) sus ??= levels.length;
    else if (c === 0x60) break;
    else if (c >= 0x80 && c <= 0x9f) { if (first) nfreq = c & 31; }
    else if (c >= 0xa0 && c <= 0xaf) { if (first) mode = c & 3 || mode; }
    else if (c >= 0xe0 && c <= 0xef) {
      // `n:c`: from the level there to n over c frames.
      const to = c & 15, n = d[i++] || 256, from = level;
      for (let k = 1; k <= n; k++) { level = Math.round(from + ((to - from) * k) / n); frame(1); }
    } else break;
  }
  if (!levels.length) frame(1);
  if (sus != null && sus >= levels.length) sus = null;
  return { levels, offsets, sus, mode, nfreq, wave, moves };
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

/** An envelope at a level `v` as a :vol macro spec. */
function envelopeSpec(env, v, volOf) {
  if (env.type === "r") {
    const E = (x) => volOf(Math.round((v * x) / 255));
    const st = [];
    const peak = env.ar > 0 ? 255 : env.al;
    if (env.ar > 0 && env.al < 255) st.push(`(linear ${E(env.al)}..${E(255)} :len ${Math.ceil((255 - env.al) / env.ar)}f)`);
    let held = peak;
    if (env.dr > 0 && env.sl < peak) { st.push(`(linear ${E(peak)}..${E(env.sl)} :len ${Math.ceil((peak - env.sl) / env.dr)}f)`); held = env.sl; }
    if (env.sr > 0 && held > 0) { st.push(`(linear ${E(held)}..0 :len ${Math.ceil(held / env.sr)}f)`); held = 0; }
    if (!st.length) st.push(String(E(held)));
    if (env.rr > 0 && held > 0) st.push("#rel", `(linear :len ${Math.max(1, Math.ceil(held / env.rr))}f)`);
    return `[${st.join(" ")}]`;
  }
  const x = expandEnv(env);
  return frameVector(x.levels.map((lv) => volOf(Math.round((v * lv) / 15))), x.sus);
}

// The rhythm track's hits → rhythm1-rhythm5, a track a sound, in the key-on
// bits' order (b s m c h). A sound rings until its next hit, which keys it
// again; its level is its own `vb`… at the hit.
const RHYTHM_SOUNDS = [[0x10, "kick", 0], [0x08, "snare", 1], [0x04, "tom4", 2], [0x02, "ride", 3], [0x01, "hat", 4]];
function rhythmTracks(tr, tick) {
  const out = [];
  RHYTHM_SOUNDS.forEach(([bit, role, lv]) => {
    const hits = tr.notes.filter((n) => n.rhythm & bit);
    if (!hits.length) return;
    const endTick = tick(tr.end);
    const notes = hits.map((n, k) => {
      const next = hits[k + 1]?.step ?? tr.end;
      return { tick: tick(n.step), len: Math.max(1, tick(next - n.step)), midi: 60, vel: 15, state: [role, `:vol ${ssgVol(n.st.rvol[lv])}`] };
    });
    const marks = !out.length ? tr.tempos.map((tm) => ({ tick: tick(tm.step), tokens: [`:tempo ${tm.bpm}`] })) : [];
    out.push({ channel: `rhythm${out.length + 1}`, notes, marks, endTick, loopTick: tr.loopStep != null ? tick(tr.loopStep) : null });
  });
  return out;
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
  const envName = (num, v, kind) => {
    const key = `${num}:${v}:${kind === "scc" ? "scc" : "ssg"}`;
    if (!envDefs.has(key)) {
      const env = mgs.defs.envs.get(num);
      if (!env) { envDefs.set(key, null); warnings.push(`@e${num} is not in the file — its notes play without an envelope`); }
      else {
        const spec = envelopeSpec(env, v, kind === "scc" ? sccVol : ssgVol);
        // One level held: the note's :vol, no macro.
        const flat = /^\[(\d+)\]$/.exec(spec);
        if (flat) envDefs.set(key, { vol: Number(flat[1]) });
        else {
          const name = `vol-${env.type}${num}-v${v}${kind === "scc" ? "-scc" : ""}`; // the PSG's and the OPLL's are one ladder
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
      const cents = x.offsets.map((o) => (o ? Math.round(detuneCents(kind, midi, -o) / 5) * 5 : 0));
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
      const x = env?.type === "e" ? expandEnv(env) : env ? { mode: env.mode || null, nfreq: env.mode & 2 ? env.nfreq : null, wave: null, moves: 0, offsets: [] } : null;
      if (x?.moves) warnings.push(`@e${num} changes the wave ${x.moves} time${x.moves > 1 ? "s" : ""} as it runs: its notes keep the first`);
      expanded.set(num, x);
    }
    return expanded.get(num);
  };

  // An @v voice as a def-fm on the OPLL's words; @1-@15 without one, the ROM's.
  const voiceDefs = new Map();
  const fmVoice = (n) => {
    if (!voiceDefs.has(n)) {
      const d = mgs.defs.voices.get(n);
      if (d) {
        const name = `mgs-v${String(n).padStart(2, "0")}`;
        const op = (k, b0, ar, sl, ksl, ws, tl) => [`:am${k} ${b0 >> 7}`, `:vib${k} ${(b0 >> 6) & 1}`, `:eg${k} ${(b0 >> 5) & 1}`,
          `:ks${k} ${(b0 >> 4) & 1}`, `:ml${k} ${b0 & 15}`, `:ksl${k} ${ksl}`, ...(tl != null ? [`:tl${k} ${tl}`] : []),
          `:ws${k} ${ws}`, `:ar${k} ${ar >> 4}`, `:dr${k} ${ar & 15}`, `:sl${k} ${sl >> 4}`, `:rr${k} ${sl & 15}`].join(" ");
        defs.push(`(def-fm ${name} :fb ${d[3] & 7}\n  ${op(1, d[0], d[4], d[6], d[2] >> 6, (d[3] >> 3) & 1, d[2] & 63)}\n  ${op(2, d[1], d[5], d[7], d[3] >> 6, (d[3] >> 4) & 1, null)})`);
        voiceDefs.set(n, name);
      } else if (n >= 1 && n <= 15) voiceDefs.set(n, OPLL_ROM_NAMES[n - 1]);
      else { voiceDefs.set(n, null); warnings.push(`FM @${n} has no @v definition — its notes play the voice before`); }
    }
    return voiceDefs.get(n);
  };

  const songOut = [];
  let endMax = 0;
  for (const tr of a.tracks) {
    if (!tr.notes.length || (mgs.opllMode === 1 && tr.index >= 16)) continue;
    if (mgs.opllMode === 1 && tr.index === 15) {
      for (const t of rhythmTracks(tr, tick)) { songOut.push(t); endMax = Math.max(endMax, t.endTick); }
      continue;
    }
    const isPsg = tr.kind === "psg", isFm = tr.kind === "fm";
    const channel = isPsg ? `sqr${tr.index}` : isFm ? `fm${tr.index - 8}` : `wave${tr.index - 3}`;
    const volOf = tr.kind === "scc" ? sccVol : ssgVol; // the OPLL's volume steps 3 dB as the SSG's
    const notes = [];
    let prev = null;
    for (const n of tr.notes) {
      const st = n.st;
      const x = st.env != null ? envX(st.env) : null;
      const state = [];
      const wave = x?.wave ?? st.voice;
      if (isFm) { const v = st.voice != null ? fmVoice(st.voice) : null; if (v) state.push(v); state.push(`:sus ${st.sus}`); }
      else if (!isPsg && wave != null) { const w = waveName(wave); if (w) state.push(w); }
      if (isPsg) {
        const mix = x ?? { mode: null, nfreq: null };
        const mode = mix.mode ?? st.mode;
        if (!MODES[mode]) { skip("a PSG note with its mixer off (silent)"); prev = n; continue; }
        state.push(`:mode ${MODES[mode]}`);
        if (mode & 2) state.push(`:noise-rate ${Math.max(1, mix.nfreq ?? st.nfreq ?? 8)}`);
      }
      const e = st.env != null ? envName(st.env, st.vol, tr.kind) : null;
      state.push(`:vol ${e?.vol ?? volOf(st.vol)}`);
      state.push(e?.name ?? "(macro :vol none)");
      if (st.detune) state.push(`:pitch ${detuneCents(tr.kind, n.midi, st.detune)}`);
      else state.push(":pitch 0");
      // The note's own pitch move: the envelope's, a portamento, the LFO.
      let pitch = null;
      const bend = x?.offsets.some(Boolean) ? envBend(st.env, n.midi, tr.kind, x) : null;
      if (bend) pitch = bend;
      else if (n.base) {
        const from = 12 * (n.base.oct + 1) + n.base.n;
        if (from !== n.midi) pitch = `(macro :pitch+ (linear ${(from - n.midi) * 100}..0 :len ${tick(n.count)}t))`;
      } else if (st.lfoOn && st.lfo && st.lfo.depth && st.lfo.speed > 0) {
        // h delay, speed, mode, depth: a triangle `depth` periods wide, a
        // quarter of it `speed` frames.
        const { delay, speed, depth } = st.lfo;
        const amp = Math.round(Math.abs(detuneCents(tr.kind, n.midi, depth)) / 10) * 10; // to 10 cents, so notes share it
        if (amp) pitch = `(macro :pitch+ (triangle ${-amp}..${amp} :len ${4 * speed}f :phase ${depth > 0 ? 192 : 64}${delay > 0 ? ` :wait ${delay}f` : ""}))`;
      }
      if (pitch && !pitch.startsWith("(")) state.push(pitch);
      else state.push(pitch ?? "(macro :pitch none)");
      // q eighths of the note, k steps short of that.
      const q = st.q >= 1 && st.q <= 8 ? st.q : 8;
      const gate = n.tieOn ? n.count : Math.max(1, Math.floor((n.count * q) / 8) - st.k);
      const legato = !!prev && prev.tieOn && prev.step + prev.count === n.step;
      notes.push({ tick: tick(n.step), len: tick(gate), midi: n.midi, vel: 15, state, tieIn: legato });
      prev = n;
    }
    if (!notes.length) continue;
    // A track whose notes never move the pitch needs no `:pitch 0`.
    const clean = notes.every((n) => n.state.includes(":pitch 0")) ? notes.map((n) => ({ ...n, state: n.state.filter((x) => x !== ":pitch 0") })) : notes;
    const marks = tr.tempos.map((tm) => ({ tick: tick(tm.step), tokens: [`:tempo ${tm.bpm}`] }));
    const endTick = tick(tr.end);
    const loopTick = tr.loopStep != null ? tick(tr.loopStep) : null;
    if (loopTick != null && marks.length && !marks.some((m) => m.tick === loopTick)) {
      const inForce = marks.filter((m) => m.tick < loopTick).pop();
      if (inForce) { marks.push({ tick: loopTick, tokens: inForce.tokens }); marks.sort((x, y) => x.tick - y.tick); }
    }
    songOut.push({ channel, notes: dropIdleNones(clean), marks, endTick, loopTick });
    endMax = Math.max(endMax, endTick);
  }
  // The song's tempo: #tempo, where no track sets one at its start.
  if (songOut.length && !songOut.some((t) => t.marks.some((m) => m.tick === 0)))
    songOut[0].marks.unshift({ tick: 0, tokens: [`:tempo ${mgs.tempo}`] });

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
