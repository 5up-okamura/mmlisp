// ---------------------------------------------------------------------------
// Tracker songs (DefleMask .dmf, Furnace .fur) → MMLisp
//
// Both readers produce one model:
//   { format, system, title, author, hz, rowsPerBeat, rowsPerBar,
//     speeds: [frames a row, even rows / odd rows], patLen,
//     orders: [[pattern index per channel] per order],
//     channels: [{kind, name, patterns: Map(index → rows)}],
//       rows: [{note: semitone (C-0 = 0) | "off" | null, vol: -1 | n,
//               (a tracker's C-0 is 32.70 Hz, MIDI 24: Furnace's octaves are
//               one under scientific pitch — its A-3 is 440 Hz — and it plays
//               DefleMask's modules so)
//               ins: -1 | n, fx: [[code, value], …]}]
//     instruments: [{name, kind: "fm", fm: {alg, fb, fms, ams, ops}}
//                 | {name, kind: "std", vol: {values, loop}, arp: {values, loop}}],
//     fmVolMax, psgVolMax }
// and this turns it into a score. The order list plays as the tracker plays
// it (0Bxx jumps, 0Dxx breaks, the song looping where it jumps back to, or
// to the start); a row is a fixed number of ticks and the speed becomes the
// tempo. By default each pattern of each channel becomes a phrase `(def …)`
// and the tracks lay them out in order (import-song.js emitPhrased).
//
// Kept: notes and note-offs, instruments (FM → def-fm, a volume/arpeggio
// macro → a `(macro …)` def), the volume column, speed (09xx/0Fxx), pan
// (08xy), arpeggio (00xy), note cut (ECxx) and delay (EDxx), and the pitch
// effects as `:pitch` macros — vibrato (04xy) a shared `(def vib-xy …)` of a
// sine, slides (01xx/02xx, E1xy/E2xy) and portamento (03xx, a slur) a line,
// fine tune (E5xx) an offset. Everything else is counted and reported.
//
// A PC Engine module can be a `pce` score (the default) or an md one. As
// pce, its wavetables are def-waves, an instrument's wave macro (its first
// step) and 10xx the wave a channel plays, 11xx channel 5 or 6 the noise
// (the channel's notes then on noise5 / noise6, the rate Furnace's: the
// note straight, or DefleMask's table), 08xy the channel's left and right
// levels as `:pan`, and the volume column the chip's 5-bit volume.
//
// An NES module can be an `fc` score (the default) or an md one. As fc
// (Furnace's nes.cpp, as it plays a DMF too): the pulses on sqr1 / sqr2,
// their duty macro and 12xx as `:duty`; the triangle on tri, on while its
// volume is not 0 (no :vel); the noise on noise, a note its rate — 15 −
// (note & 15) under properNoiseLayout, else its table — its duty macro's
// first step and 12xx the mode. The 4-bit volume column is linear, as
// :vel in dB; the volume macro scales it (newVolumeScaling, a :vol fader in
// dB) or adds its steps to it (a DMF, an older .fur: a :vol macro for each
// column level it plays at). The triangle stops at a volume macro's 0, and
// at a column of 0 only under one. A .fur's DPCM channel is pcm1 (dpcmTrack).
// ---------------------------------------------------------------------------

import { PPQN, emitSong, emitPhrased, qstr, octOf, PITCH_NONE, FM_DESTS, PSG_DESTS } from "./import-song.js";
import { VEL_DB_PER_STEP } from "./ir-utils.js";
import { fmVoiceDef, dtRegFromFurnace } from "./import-fm-voices.js";
import { DMC_RATES } from "./chips/rp2a03.js";
import { encodeWav } from "./export-wav.js";

// What each source channel kind is, for the defaults and the voice: an FM
// channel whose instruments are OPN voices; OPM / OPLL / wavetable channels
// play their notes on a stand-in voice.
const CHANNEL_KINDS = {
  fm: "FM", fm3op: "FM operator", opm: "OPM FM", opll: "OPLL FM", opl: "OPL FM",
  psg: "square", wave: "wavetable", noise: "noise", pcm: "sample",
};
const STAND_IN = { psg: "wave-square", wave: "wave-triangle", noise: "wave-square", opll: "wave-saw", opl: "wave-sine", pcm: "wave-saw", fm3op: "wave-sine" };
// The volume column's top, where it is not the model's FM / PSG one.
const VOL_MAX = { opl: 63 };

const PITCH_CODES = new Set([0x01, 0x02, 0x03, 0x04, 0xe1, 0xe2, 0xe5]);

// The PC Engine as a pce score: its channels' places, and its noise — on
// channels 5 and 6, switched by 11xx or an instrument's duty macro (its
// first step at each note, as Furnace runs it). The rate a noise note plays
// is the note itself (Furnace's properNoiseLayout) or, as DefleMask had it,
// one of twelve by the note's name.
const PCE_WAVES = ["wave1", "wave2", "wave3", "wave4", "wave5", "wave6"];
const PCE_NOISE = { 4: "noise5", 5: "noise6" };
const PCE_NOISE_TABLE = [4, 13, 15, 18, 21, 23, 25, 27, 29, 31, 0, 2];
const PCE_NOISE_BASE = 36; // chips/huc6280.js NOISE_NOTE_BASE: c2 is rate 0
const PCE_FX = { 0x10: "wave", 0x11: "noise", 0x12: "LFO mode", 0x13: "LFO speed", 0x17: "DDA" };
// The 2A03 as an fc score: its channels' places, and the noise's register
// rate (0 the fastest) for a note — Furnace's, which DefleMask's modules
// play by (nes.cpp noiseTable, properNoiseLayout off).
const FC_DESTS = ["sqr1", "sqr2", "tri", "noise"];
const FC_NOISE_UP = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4], FC_NOISE_TOP = [3, 2, 1, 0, 11, 10, 9, 8, 7, 6, 5, 4];
const FC_NOISE_TABLE = [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 4,
  ...FC_NOISE_UP, ...FC_NOISE_UP, ...FC_NOISE_TOP, ...FC_NOISE_UP, ...FC_NOISE_TOP, ...FC_NOISE_UP, ...FC_NOISE_TOP]; // then 15
const fcNoiseRate = (note, proper) => (proper ? 15 - (note & 15) : FC_NOISE_TABLE[Math.max(0, Math.min(252, note))] ?? 15);
const FC_NOISE_BASE = 36; // chips/rp2a03.js NOISE_NOTE_BASE: c2 is the slowest (register 15)
const FC_DUTIES = [2, 4, 8, 12]; // chips/rp2a03.js DUTIES: 12xx / the duty macro's 0-3
const FC_FX = { 0x11: "DMC counter", 0x13: "sweep up", 0x14: "sweep down", 0x15: "envelope mode", 0x16: "length counter",
  0x17: "frame counter mode", 0x18: "PCM mode", 0x19: "triangle linear counter", 0x20: "DPCM frequency" };
// Furnace's DMC rate for a sample's playback rate (nes.cpp calcDPCMRate).
const FC_DMC_STEPS = [4450, 5000, 5400, 5900, 6650, 7450, 8100, 8800, 10200, 11700, 13300, 15900, 18900, 23500, 29000];
const dmcRateOf = (hz) => { const i = FC_DMC_STEPS.findIndex((x) => hz < x); return i < 0 ? 15 : i; };
// A 4-bit linear level as dB below full.
const linDb = (x) => (x > 0 ? 20 * Math.log10(Math.min(15, x) / 15) : -Infinity);
// An instrument's duty macro at a note: the PC Engine's noise switch.
const dutyNoise = (ins) => (ins?.duty?.values.length ? ins.duty.values[0] > 0 : null);

const FX_NAMES = {
  0x01: "pitch slide up", 0x02: "pitch slide down", 0x03: "portamento", 0x04: "vibrato",
  0x05: "portamento + volume slide", 0x06: "vibrato + volume slide", 0x07: "tremolo",
  0x0a: "volume slide", 0x10: "LFO", 0x11: "feedback", 0x12: "TL op1", 0x13: "TL op2",
  0x14: "TL op3", 0x15: "TL op4", 0x16: "multiplier", 0x17: "DAC", 0x18: "ext. CH3",
  0x19: "attack", 0x20: "noise mode", 0xe1: "note slide up", 0xe2: "note slide down",
  0xe5: "fine tune", 0xe0: "arpeggio speed",
};

/** zlib → bytes, through the platform's DecompressionStream. */
export async function inflate(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(u8[0] === 0x78)) return u8; // not compressed
  const ds = new DecompressionStream("deflate");
  const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** The order list as played: [{order, rows}], and where it loops. */
function playOrder(t) {
  const seq = [];
  const seen = new Map(); // order → its index in seq
  let o = 0;
  let loopIndex = 0;
  while (o < t.orders.length) {
    if (seen.has(o)) { loopIndex = seen.get(o); break; }
    seen.set(o, seq.length);
    let rows = t.patLen;
    let jump = null;
    for (let r = 0; r < t.patLen && rows === t.patLen; r++) {
      t.channels.forEach((chn, c) => {
        const row = chn.patterns.get(t.orders[o][c])?.[r];
        for (const [code, val] of row?.fx ?? []) {
          if (code === 0x0b && val >= 0) { jump = val; rows = r + 1; }
          if (code === 0x0d) rows = r + 1;
        }
      });
    }
    seq.push({ order: o, rows });
    if (jump != null) {
      if (seen.has(jump)) { loopIndex = seen.get(jump); break; }
      o = jump;
      continue;
    }
    o++;
  }
  return { seq, loopIndex };
}

/**
 * What the dialog shows: the channels with their note counts, and the tempo.
 */
export function analyzeTracker(t) {
  const { seq, loopIndex } = playOrder(t);
  const rowsPerBeat = t.rowsPerBeat > 0 && PPQN % t.rowsPerBeat === 0 ? t.rowsPerBeat : 4;
  const framesPerRow = (t.speeds[0] + t.speeds[1]) / 2 || 6;
  const bpm = (60 * t.hz) / (framesPerRow * rowsPerBeat);
  const channels = t.channels.map((chn, c) => {
    let notes = 0, noiseNotes = 0, noise = false, ins = -1;
    for (const { order, rows } of seq) {
      const pat = chn.patterns.get(t.orders[order][c]) ?? [];
      for (let r = 0; r < rows; r++) {
        for (const [code, v] of pat[r]?.fx ?? []) if (chn.chip === "pce" && code === 0x11 && v >= 0) noise = v > 0;
        if (pat[r]?.ins >= 0) ins = pat[r].ins;
        if (typeof pat[r]?.note !== "number") continue;
        if (chn.chip === "pce") noise = dutyNoise(t.instruments[ins]) ?? noise;
        notes++;
        if (noise) noiseNotes++;
      }
    }
    return { index: c, kind: chn.kind, name: chn.name, chip: chn.chip, notes, noiseNotes,
      label: `${chn.name} · ${noiseNotes > notes / 2 ? "noise" : CHANNEL_KINDS[chn.kind]} · ${notes} notes` };
  });
  // A PC Engine module may be its own machine's score; an NES one the
  // Famicom's — an expansion's channels (VRC6, FDS …) left out, as md
  // would leave them.
  const pce = t.channels.length > 0 && t.channels.every((c) => c.chip === "pce");
  const nes = t.channels.some((c) => c.chip === "nes");
  const targets = pce ? ["pce", "md"] : nes ? ["fc", "md"] : ["md"];
  return { seq, loopIndex, rowsPerBeat, framesPerRow, bpm, channels, targets, target: targets[0] };
}

/** The channels a `target` score offers a module's rows. */
export function trackerDests(target = "md") {
  if (target === "fc") return [...FC_DESTS, "pcm1"];
  return target === "pce" ? [...PCE_WAVES, ...Object.values(PCE_NOISE)] : [...FM_DESTS, ...PSG_DESTS, "noise"];
}

/**
 * Defaults: FM channels on fm1-6, square channels on sqr1-3, noise on noise;
 * wavetable and OPLL channels take what is left; samples are dropped, as is
 * a channel with no notes.
 */
export function defaultTrackerOptions(a, target = a.target ?? "md") {
  // A PC Engine module on pce: each channel its own, channels 5 and 6 on
  // the noise where most of their notes are.
  if (target === "pce") {
    const dest = {};
    for (const ch of a.channels) {
      const noise = PCE_NOISE[ch.index] && ch.noiseNotes > ch.notes / 2;
      dest[ch.index] = ch.notes === 0 ? "drop" : noise ? PCE_NOISE[ch.index] : PCE_WAVES[ch.index] ?? "drop";
    }
    return { dest, phrases: true, bpm: null, target };
  }
  // An NES module on fc: the 2A03's channels in their places; the DPCM and
  // an expansion's are not the target's.
  if (target === "fc") {
    const dest = {};
    for (const ch of a.channels) {
      const i = a.channels.filter((c) => c.chip === "nes" && c.index < ch.index).length;
      dest[ch.index] = !(ch.notes > 0 && ch.chip === "nes") ? "drop" : ch.kind === "pcm" ? "pcm1" : FC_DESTS[i] ?? "drop";
    }
    return { dest, phrases: true, bpm: null, target };
  }
  const fm = [...FM_DESTS];
  const sqr = [...PSG_DESTS];
  let noise = "noise";
  const dest = {};
  for (const ch of a.channels) {
    let d = "drop";
    if (ch.notes === 0 || ch.kind === "pcm") d = "drop";
    else if (ch.kind === "fm" || ch.kind === "opm") d = fm.shift() ?? "drop";
    else if (ch.kind === "psg") d = sqr.shift() ?? fm.shift() ?? "drop";
    else if (ch.kind === "noise") { d = noise ?? "drop"; noise = null; }
    dest[ch.index] = d;
  }
  // A channel 3 split into operators: its first operator takes fm3's place.
  for (const ch of a.channels) {
    if (dest[ch.index] !== "drop" || ch.notes === 0) continue;
    if (ch.kind === "fm3op") dest[ch.index] = fm.shift() ?? "drop";
    else if (ch.kind === "wave" || ch.kind === "opll" || ch.kind === "opl") dest[ch.index] = fm.shift() ?? sqr.shift() ?? "drop";
  }
  return { dest, phrases: true, bpm: null, target };
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

/**
 * @param options {dest: {channelIndex: channel | "drop"}, phrases: bool,
 *                 bpm?: number | null, target?: "md" | "pce", fileName?}
 */
export function trackerToMmlisp(t, options, a = analyzeTracker(t)) {
  const warnings = [];
  const onPce = options.target === "pce";
  const onFc = options.target === "fc";
  // A PC Engine module (its volume macros in the chip's 1.5 dB steps).
  const pceSong = t.channels.length > 0 && t.channels.every((c) => c.chip === "pce");
  const fxSkipped = new Map();
  const rowTicks = PPQN / a.rowsPerBeat;
  const ticksPerFrame = rowTicks / a.framesPerRow;
  const scale = options.bpm ? options.bpm / a.bpm : 1;
  const tempoOf = (frames) => {
    const bpm = ((60 * t.hz) / (frames * a.rowsPerBeat)) * scale;
    return `:tempo ${Number.isInteger(bpm) ? bpm : +bpm.toFixed(2)}`;
  };
  const dest = options.dest ?? {};
  const taken = new Set();
  const used = [];
  for (const ch of a.channels) {
    const d = dest[ch.index] ?? "drop";
    if (d === "drop") continue;
    if (taken.has(d)) { warnings.push(`${ch.name}: ${d} is already taken — dropped`); continue; }
    taken.add(d);
    // A PC Engine channel playing both its wave and its noise: each kind's
    // notes on its own name — one channel, the noise over the wave where
    // they meet (the :prio layering across its names).
    const both = onPce && t.channels[ch.index].chip === "pce" && PCE_NOISE[ch.index]
      && ch.noiseNotes > 0 && ch.noiseNotes < ch.notes && (d === PCE_WAVES[ch.index] || d === PCE_NOISE[ch.index]);
    if (both) {
      for (const half of [PCE_WAVES[ch.index], PCE_NOISE[ch.index]]) {
        taken.add(half);
        used.push({ ...ch, dest: half, split: true });
      }
      continue;
    }
    used.push({ ...ch, dest: d });
  }
  if (t.speeds[0] !== t.speeds[1])
    warnings.push(`speeds ${t.speeds[0]}/${t.speeds[1]} alternate per row (a swing) — imported at their average`);

  // Segments in song ticks.
  const segStart = [];
  let tick = 0;
  for (const s of a.seq) { segStart.push(tick); tick += s.rows * rowTicks; }
  const endTick = tick;
  const loopIndex = a.loopIndex;

  // Instruments → defs, as each is first used where it lands.
  const defs = new Map(); // key → {name, text}
  const usedNames = new Set(["init-fm"]);
  const uniq = (base) => { let n = base; for (let k = 2; usedNames.has(n); k++) n = `${base}-${k}`; usedNames.add(n); return n; };
  const fmVoice = (i) => {
    const key = `fm:${i}`;
    if (!defs.has(key)) {
      const ins = t.instruments[i];
      const name = uniq(`ins-${slug(ins.name) || i}`);
      const raw = { ...ins.fm, ops: ins.fm.ops.map((o) => ({ ...o, dt: dtRegFromFurnace(o.dt) })) };
      defs.set(key, { name, text: fmVoiceDef(name, raw) });
    }
    return defs.get(key).name;
  };
  // `nz`: a PC Engine noise note's place in DefleMask's twelve-rate table
  // (no properNoiseLayout), where the arp macro moves the note through the
  // table, not by semitones: its :semi is the table's step from there.
  // `onWave`: a note on a PC Engine wave, which its wave macro steps
  // (:wave over the module's wavetables as def-waves).
  // `fc`: the 2A03 channel the note is on ("pulse", "tri", "noise"), whose
  // volume macro is a linear level (the triangle's on / off) and whose duty
  // macro a pulse's `:duty`; a noise's arp moves its note through Furnace's
  // table where the layout is not proper (`nz` its note there).
  const env = (i, nz = null, onWave = false, fc = null, col = null) => {
    if (!t.instruments[i]?.arp?.values.some((x) => x !== 0)) nz = null;
    // The column a macro's steps add to (no newVolumeScaling): its own def.
    if (!fc || fc === "tri" || t.newVolumeScaling !== false || !t.instruments[i]?.vol?.values.length) col = null;
    const wm = t.instruments[i]?.wave;
    const waveNames = onWave && wm?.values.some((x) => x !== wm.values[0]) ? wm.values.map(waveDef) : null;
    if (waveNames?.includes(null)) waveMacroSteps++;
    const waves = waveNames?.every((n) => n) ? waveNames : null;
    const key = `env:${i}${nz == null ? "" : `:nz${nz}`}${waves ? ":w" : ""}${fc ? `:${fc}` : ""}${col == null ? "" : `:v${col}`}`;
    if (!defs.has(key)) {
      const ins = t.instruments[i];
      const parts = [];
      const arr = (m, map) => {
        const v = m.values.map((x, k) => map(x, k));
        if (m.loop != null) v.splice(m.loop, 0, "#sus");
        return `[${v.join(" ")}]`;
      };
      const volMax = t.psgVolMax;
      // The PC Engine's volume is 5 bits at 1.5 dB a step, its 0 silent, and
      // its macro's attenuation adds to the volume column's (Furnace): a :vol
      // macro, the fader beside the column's :vel — 2 dB a step, 0 a mute.
      // Elsewhere a ratio of the column's level.
      if (ins.vol?.values.length && fc === "tri")
        parts.push(`:vol ${arr(ins.vol, (x) => (x > 0 ? 31 : 0))}`);
      else if (ins.vol?.values.length && fc && col != null) {
        // Furnace's VOL_SCALE_LOG: the column and the step added, less 15.
        const out = (x) => Math.max(0, Math.min(15, col + Math.min(15, x) - 15));
        parts.push(`:vol ${arr(ins.vol, (x) => (out(x) <= 0 ? 0 : Math.max(1, Math.round(31 + (linDb(out(x)) - linDb(col)) / 2))))}`);
      } else if (ins.vol?.values.length && fc)
        parts.push(`:vol ${arr(ins.vol, (x) => (x <= 0 ? 0 : Math.max(1, Math.round(31 + linDb(x) / 2))))}`);
      else if (ins.vol?.values.length && pceSong)
        parts.push(`:vol ${arr(ins.vol, (x) => (x <= 0 ? 0 : Math.max(1, Math.round(31 - ((31 - Math.min(31, x)) * 1.5) / 2))))}`);
      else if (ins.vol?.values.length)
        parts.push(`:vel* ${arr(ins.vol, (x) => Math.max(0, Math.min(1, Math.round((x * 100) / volMax) / 100)))}`);
      const rate = (k) => PCE_NOISE_TABLE[((k % 12) + 12) % 12];
      // (fc's table counts down: a rate's note is 15 − it; under
      // properNoiseLayout the note's low four bits, wrapping.)
      const step = (x) => (fc === "noise"
        ? (t.properNoiseLayout ? ((nz + x) & 15) - (nz & 15) : fcNoiseRate(nz, false) - fcNoiseRate(nz + x, false))
        : rate(nz + x) - rate(nz));
      if (ins.arp?.values.length && ins.arp.values.some((x) => x !== 0))
        parts.push(`:semi ${arr(ins.arp, (x) => (nz == null ? x : step(x)))}`);
      if (fc === "pulse" && ins.duty?.values.length)
        parts.push(`:duty ${arr(ins.duty, (x) => FC_DUTIES[x & 3])}`);
      if (waves) parts.push(`:wave ${arr(wm, (_, k) => waves[k])}`);
      if (ins.arpFixed && nz == null) warnings.push(`instrument "${ins.name}": a fixed-pitch arpeggio macro is not imported`);
      const name = uniq(`env-${slug(ins.name) || i}${nz == null ? "" : `-nz${nz}`}${fc && fc !== "pulse" ? `-${fc}` : ""}${col == null ? "" : `-v${col}`}`);
      defs.set(key, { name, text: `(def ${name} (macro none)${parts.length ? ` (macro ${parts.join(" ")})` : ""})` });
    }
    return defs.get(key).name;
  };
  const standIns = new Set();
  // A module wavetable as a def-wave: its steps 0..height onto −128..127,
  // 32 of them (a wider or narrower table read at 32 points).
  let waveResampled = 0;
  const waveDef = (i) => {
    const w = t.waves?.[i];
    if (!w || !w.values.length) return null;
    const key = `wave:${i}`;
    if (!defs.has(key)) {
      if (w.values.length !== 32) waveResampled++;
      const top = Math.max(1, w.height ?? 31);
      const steps = Array.from({ length: 32 }, (_, k) => {
        const v = w.values[Math.floor((k * w.values.length) / 32)] ?? 0;
        return Math.max(-128, Math.min(127, Math.round((Math.max(0, Math.min(top, v)) * 255) / top) - 128));
      });
      const name = uniq(`wave-${slug(w.name) || i}`);
      defs.set(key, { name, text: `(def-wave ${name} :wave [${steps.join(" ")}])` });
    }
    return defs.get(key).name;
  };
  let waveMacroSteps = 0, dutyMoves = 0, noiseDropped = 0, waveDropped = 0, noisePitch = 0, dutyUnderNote = 0;

  // Pitch effects → one `:pitch` macro a note. A tracker tick is a frame at
  // the song's rate; a slide moves `speed × pitchSlideSpeed` 128ths of a
  // semitone a tick (Furnace's linear pitch, as it plays a DMF too); a
  // vibrato runs a 64-step sine `x` steps a tick, `y` 16ths of a semitone deep.
  const pss = t.pitchSlideSpeed ?? 4;
  if (t.linearPitch === false && used.length)
    warnings.push("the song's pitch is not linear: slides and portamento are approximated");
  const frames = (scoreTicks) => Math.max(1, Math.round((scoreTicks / ticksPerFrame) * 60 / t.hz));
  const slideCents = (speed) => (speed * pss * 100) / 128; // a tracker tick
  let vibUnderSlide = 0;
  const vibDef = ({ x, y }, d) => {
    const depth = Math.round((y * 127 * 100) / (16 * 128));
    const period = Math.max(1, Math.round((64 / x) * 60 / t.hz));
    const key = `vib:${x}:${y}:${d}`;
    if (!defs.has(key)) {
      const name = uniq(`vib-${x.toString(16)}${y.toString(16)}${d ? (d > 0 ? `+${d}` : d) : ""}`);
      defs.set(key, { name, text: `(def ${name} (macro :pitch (sin ${d - depth}..${d + depth} :len ${period}f)))` });
    }
    return defs.get(key).name;
  };
  const pitchToken = (n) => {
    const p = n.p;
    if (!p) return null;
    const d = p.detune;
    const line = (from, to, scoreTicks, wait) =>
      `(macro :pitch (linear ${from}..${to} :len ${frames(scoreTicks)}f${wait ? ` :wait ${frames(wait)}f` : ""}))`;
    if (p.porta) {
      const D = (p.porta.from - n.midi) * 100;
      return line(D + d, d, (Math.abs(D) / slideCents(p.porta.speed)) * ticksPerFrame);
    }
    const sl = p.slides[0];
    if (sl) {
      if (p.vib || p.vibLater) vibUnderSlide++;
      if (sl.semis) {
        const C = sl.dir * sl.semis * 100;
        return line(d, d + C, (Math.abs(C) / slideCents(sl.speed)) * ticksPerFrame, sl.off);
      }
      const span = Math.max(1, (sl.end ?? n.len) - sl.off);
      const C = Math.round(sl.dir * slideCents(sl.speed) * (span / ticksPerFrame));
      return line(d, d + C, span, sl.off);
    }
    if (p.vib) return vibDef(p.vib, d);
    if (p.vibLater) {
      const { x, y, off } = p.vibLater;
      const depth = Math.round((y * 127 * 100) / (16 * 128));
      const period = Math.max(1, Math.round((64 / x) * 60 / t.hz));
      return `(macro :pitch (sin ${d - depth}..${d + depth} :len ${period}f :wait ${frames(off)}f))`;
    }
    return d ? `(macro :pitch ${d})` : null;
  };

  // The song's speed: a 09xx / 0Fxx on any channel is the song's (Furnace
  // plays them so), its rows' tempo the two speeds' average from there.
  const speedMarks = [];
  {
    const sp = [...t.speeds];
    a.seq.forEach(({ order, rows }, si) => {
      for (let r = 0; r < rows; r++) {
        let changed = false;
        t.channels.forEach((chn, c) => {
          for (const [code, val] of chn.patterns.get(t.orders[order][c])?.[r]?.fx ?? [])
            if ((code === 0x09 || code === 0x0f) && val > 0) { sp[code === 0x09 ? 0 : 1] = val; changed = true; }
        });
        if (changed) speedMarks.push({ tick: segStart[si] + r * rowTicks, tokens: [tempoOf((sp[0] + sp[1]) / 2)] });
      }
    });
  }
  // The NES's DPCM channel on fc's pcm1: a note plays its instrument's
  // sample (its note map's, or its one), at the DMC rate the note picks — an
  // NES instrument's map or the note's low four bits, else the sample's
  // rate at the note (C-4 its own) nearest a DMC rate — until the next note
  // or a note off. A def-pcm for each sample and rate, its :rate the rate
  // (c4 plays it), all in one wav; the 1-bit samples decoded as Furnace
  // renders them.
  const dpcm = { defs: new Map(), offsets: new Map(), parts: [], frames: 0, missing: 0, loopPart: 0 };
  const wavFile = `${String(options.fileName || "module").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "")}-dpcm.wav`;
  const dpcmDef = (si, hz) => {
    const sm = t.samples[si];
    const key = `${si}:${Math.round(hz)}`;
    if (!dpcm.defs.has(key)) {
      if (!dpcm.offsets.has(si)) {
        dpcm.offsets.set(si, dpcm.frames);
        dpcm.parts.push(sm.data);
        dpcm.frames += sm.data.length;
        if (sm.loop && (sm.loop.start > 0 || sm.loop.end < sm.data.length)) dpcm.loopPart++;
      }
      const name = uniq(`dpcm-${slug(sm.name) || si}`);
      defs.set(`dpcm:${key}`, { name, text: `(def-pcm ${name} :file ${qstr(wavFile)} :rate ${Math.round(hz)} :offset ${dpcm.offsets.get(si)} :frames ${sm.data.length})` });
      dpcm.defs.set(key, { name, loop: !!sm.loop });
    }
    return dpcm.defs.get(key);
  };
  const dpcmTrack = (ch, chn) => {
    const notes = [];
    // The DMC mode: the song's, set by an NES instrument's note (Furnace
    // switches to it there) and by 18xx.
    let ins = -1, sounding = null, lastRate = 0, prev = null, dmcMode = t.dpcmMode;
    const hitOf = (it, note) => {
      const map = it?.sampleMap?.noteMap;
      const e = map ? map[Math.max(0, Math.min(179, note + 60))] : null;
      const si = map ? e?.sample ?? -1 : it?.sampleMap?.init ?? -1;
      if (!t.samples?.[si]?.data) return null;
      let hz;
      if (it.type === 34) {
        dmcMode = true;
        // (A map's rate out of range is the last a map gave — Furnace's.)
        let r = note & 15;
        if (map) { r = e?.dpcmFreq ?? -1; if (r < 0 || r > 15) r = lastRate; lastRate = r; }
        hz = DMC_RATES[r];
      } else {
        hz = t.samples[si].rate * 2 ** (((map ? (e?.freq ?? note + 60) - 60 : note) - 48) / 12);
        if (dmcMode) hz = DMC_RATES[dmcRateOf(hz)];
      }
      return dpcmDef(si, hz);
    };
    a.seq.forEach(({ order, rows }, si) => {
      const pat = chn.patterns.get(t.orders[order][ch.index]) ?? [];
      for (let r = 0; r < rows; r++) {
        const row = pat[r];
        if (!row) continue;
        const at = segStart[si] + r * rowTicks;
        let delay = 0, cut = null;
        for (const [code, val] of row.fx) {
          if (code === 0xed && val > 0) delay = Math.round(val * ticksPerFrame);
          else if (code === 0xec && val >= 0) cut = Math.round(val * ticksPerFrame);
          else if (code === 0x18 && val >= 0) dmcMode = val > 0;
          else if (code === 0x09 || code === 0x0f || code === 0x0b || code === 0x0d) { /* the song's speed, the order walk */ }
          else if (code >= 0) {
            const k = FC_FX[code] ?? FX_NAMES[code] ?? `${code.toString(16).toUpperCase().padStart(2, "0")}xx`;
            fxSkipped.set(k, (fxSkipped.get(k) ?? 0) + 1);
          }
        }
        if (row.ins >= 0) ins = row.ins;
        if (row.note === "off") {
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, at);
          sounding = null;
        } else if (typeof row.note === "number") {
          const start = at + Math.min(delay, rowTicks - 1);
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, start);
          sounding = null;
          const hit = hitOf(t.instruments[ins], row.note);
          if (!hit) { dpcm.missing++; continue; }
          // Played until the next note or an off: a loop to there, else cut there.
          const state = [hit.name, hit.loop ? ":mode loop" : ":mode gate"];
          sounding = { tick: start, end: cut != null ? start + Math.max(1, cut) : null, midi: 60, vel: 15,
            pre: state.filter((x, k) => prev?.[k] !== x), state };
          prev = state;
          notes.push(sounding);
        } else if (cut != null && sounding) sounding.end = Math.min(sounding.end ?? Infinity, at + Math.max(1, cut));
      }
    });
    notes.forEach((n, i) => {
      const next = i + 1 < notes.length ? notes[i + 1].tick : endTick;
      n.len = Math.max(1, Math.min(n.end ?? next, next, endTick) - n.tick);
    });
    return notes.length ? { ch, notes, marks: [], noVel: true } : null;
  };

  // The wav the DPCM defs read (Save writes it beside the score).
  const dpcmPcm = () => {
    if (!dpcm.parts.length) return undefined;
    const mono = new Float32Array(dpcm.frames);
    let o = 0;
    for (const d of dpcm.parts) { mono.set(d, o); o += d.length; }
    const rate = Math.round(DMC_RATES[15]);
    return { wavFile, rate, mono, wav: encodeWav(mono, null, rate), entries: [...dpcm.defs.values()], tag: t.format };
  };

  let volUnderNote = 0;
  const tracks = [];
  let tempoTrack = true;
  for (const ch of used) {
    const chn = t.channels[ch.index];
    if (onFc && chn.chip === "nes" && ch.kind === "pcm") {
      const tr = dpcmTrack(ch, chn);
      if (!tr) continue;
      tracks.push(tr);
      if (tempoTrack) { tr.marks.push(...speedMarks); tempoTrack = false; }
      continue;
    }
    const onFm = ch.dest.startsWith("fm");
    const fmVol = ["fm", "opm", "fm3op"].includes(ch.kind);
    const volMax = VOL_MAX[ch.kind] ?? (fmVol ? t.fmVolMax : t.psgVolMax);
    // On pce the volume column is the chip's 5-bit volume, 1.5 dB a step.
    const pceVol = onPce && chn.chip === "pce";
    const toNoise = onPce && ch.dest.startsWith("noise");
    // A 2A03 channel on fc: which of its kinds (env's `fc`).
    const fcCh = onFc && chn.chip === "nes" ? (ch.dest === "tri" ? "tri" : ch.dest === "noise" ? "noise" : "pulse") : null;
    const noiseRow = toNoise || fcCh === "noise"; // a note is a rate: no pitch effects
    const velOf = (v) => {
      if (v < 0) return 15;
      if (fcCh) return v <= 0 ? 0 : Math.max(0, Math.min(15, Math.round((15 + linDb(v) / VEL_DB_PER_STEP) * 8) / 8));
      if (fmVol) return Math.max(0, Math.min(15, Math.round(15 - ((volMax - v) * 0.75) / 2)));
      if (pceVol) return Math.max(0, Math.min(15, Math.round((15 - ((chn.volMax ?? 31) - v) * 1.5 / VEL_DB_PER_STEP) * 8) / 8));
      return Math.max(0, Math.min(15, Math.round((v * 15) / volMax)));
    };
    const standIn = STAND_IN[ch.kind] ?? "wave-square";
    // Sticky state: the voice (instrument), the pan, the arpeggio. A channel
    // that ever pans or arpeggiates states both from its first note, so a
    // phrase reads the same wherever the order list plays it.
    const uses = (code) => a.seq.some(({ order, rows }) =>
      (chn.patterns.get(t.orders[order][ch.index]) ?? []).slice(0, rows).some((r) => r?.fx.some(([c]) => c === code)));
    let ins = -1;
    let vol = -1;
    let pan = (onFm || pceVol) && uses(0x08) ? "center" : null;
    let wave = -1; // the wavetable the channel plays (pce)
    let noise = false; // channel 5 or 6 on its noise (pce, 11xx)
    // The 2A03's duty (12xx, the duty macro: Furnace's 0-3, 0 at the start)
    // — a pulse's shape, the noise's mode.
    let duty = 0;
    let arp = 0;
    let usedMacro = false;
    const voiceTokens = (nz = null, onWave = false) => {
      const it = t.instruments[ins];
      if (!it) {
        if (onFm) { standIns.add(standIn); return usedMacro ? [standIn, "(macro none)"] : [standIn]; }
        return usedMacro ? ["(macro none)"] : [];
      }
      if (it.kind === "fm") {
        if (onFm && (ch.kind === "fm" || ch.kind === "opm" || ch.kind === "fm3op"))
          return usedMacro ? [fmVoice(ins), "(macro none)"] : [fmVoice(ins)];
        if (onFm) { standIns.add(standIn); return [standIn]; }
        return usedMacro ? ["(macro none)"] : [];
      }
      usedMacro = true;
      const e = env(ins, nz, onWave, fcCh, vol < 0 ? 15 : vol);
      if (onFm) { standIns.add(standIn); return [standIn, e]; }
      return [e];
    };
    const arpToken = () => (arp ? `(macro :semi [#sus 0 ${arp >> 4} ${arp & 15}])` : "(macro :semi none)");
    let usedArp = uses(0x00);
    let cur = { voice: voiceTokens(), pan: null, arp: null, duty: null };
    const dutyToken = () => (fcCh === "pulse" ? `:duty ${FC_DUTIES[duty & 3]}` : fcCh === "noise" ? `:mode ${duty & 1 ? "periodic" : "white"}` : null);
    // Pitch effects: the vibrato and fine tune in force, and each note's
    // own (worked into a `:pitch` macro once its length is known).
    let vib = null;
    let detune = 0;
    let lastMidi = null;
    const flat = (st) => [...st.voice, ...(st.arp ? [st.arp] : []), ...(st.pan ? [st.pan] : []), ...(st.duty ? [st.duty] : [])];

    const notes = [];
    const marks = [];
    let sounding = null;
    a.seq.forEach(({ order, rows }, si) => {
      const pat = chn.patterns.get(t.orders[order][ch.index]) ?? [];
      for (let r = 0; r < rows; r++) {
        const row = pat[r] ?? { note: null, vol: -1, ins: -1, fx: [] };
        const at = segStart[si] + r * rowTicks;
        let delay = 0;
        let cut = null;
        const rp = {}; // this row's pitch effects
        for (const [code, v] of row.fx) {
          // An effect with no value is 00 (Furnace reads it so).
          const val = v < 0 && PITCH_CODES.has(code) ? 0 : v;
          if (code === 0x04 && val >= 0) {
            vib = val >> 4 && val & 15 ? { x: val >> 4, y: val & 15 } : null;
            rp.vib = true;
          } else if ((code === 0x01 || code === 0x02) && val >= 0) {
            rp.slide = val ? { dir: code === 0x01 ? 1 : -1, speed: val } : { stop: true };
          } else if ((code === 0xe1 || code === 0xe2) && val >= 0) {
            if (val & 15 && val >> 4) rp.slide = { dir: code === 0xe1 ? 1 : -1, speed: (val >> 4) * 4, semis: val & 15 };
          } else if (code === 0x03 && val >= 0) { if (val) rp.porta = val; }
          // Fine tune, to 10 cents (a song tuned note by note — a VGM
          // conversion — would otherwise name an offset on every note).
          else if (code === 0xe5 && val >= 0) detune = v < 0 ? 0 : Math.round((val - 0x80) * 100 / 128 / 10) * 10 || 0;
          else if (code === 0x08 && onFm && val >= 0) {
            pan = (val >> 4) && (val & 15) ? "center" : val >> 4 ? "left" : val & 15 ? "right" : "center";
          } else if (code === 0x08 && pceVol && val >= 0) {
            // The channel's left and right levels: the louder side full, the
            // other as far down as their difference (chips/huc6280.js panLevels).
            const p = ((val & 15) - (val >> 4)) / 15;
            pan = p === 0 ? "center" : String(+p.toFixed(2));
          } else if (code === 0x10 && pceVol && val >= 0) wave = val;
          else if (code === 0x11 && pceVol && val >= 0) noise = val > 0;
          else if (code === 0x12 && fcCh && fcCh !== "tri" && val >= 0) {
            duty = val;
            // Under a sounding note Furnace writes it at once; here it is
            // the next note's.
            if (typeof row.note !== "number" && sounding) dutyUnderNote++;
          }
          else if (code === 0x00 && val >= 0) { arp = val; usedArp = true; }
          else if (code === 0xed && val > 0) delay = Math.round(val * ticksPerFrame);
          else if (code === 0xec && val >= 0) cut = Math.round(val * ticksPerFrame);
          else if ((code === 0x09 || code === 0x0f) && val > 0) { /* the song's speed: speedMarks */ }
          else if (code === 0x0b || code === 0x0d) { /* the order walk */ }
          else if (code >= 0) {
            const k = (pceVol ? PCE_FX[code] : fcCh ? FC_FX[code] : null) ?? FX_NAMES[code] ?? `${code.toString(16).toUpperCase().padStart(2, "0")}xx`;
            fxSkipped.set(k, (fxSkipped.get(k) ?? 0) + 1);
          }
        }
        if (row.ins >= 0 && t.instruments[row.ins]) ins = row.ins;
        // The instrument's macros start over at each of its notes: its wave
        // macro sets the wave (its first step; one that moves is the note's
        // :wave macro, env), its duty macro the noise switch (its first step).
        if (pceVol && typeof row.note === "number" && t.instruments[ins]) {
          const { wave: wm, duty } = t.instruments[ins];
          if (wm?.values.length) wave = wm.values[0];
          if (duty?.values.some((x) => (x > 0) !== (duty.values[0] > 0))) dutyMoves++;
          noise = dutyNoise(t.instruments[ins]) ?? noise;
        }
        // The 2A03's duty macro starts over at each note: the noise's mode
        // is its first step (Furnace: properNoiseLayout keeps bit 0, else
        // anything over 1 is 1); a pulse's runs as the note's :duty macro,
        // its first step the note's duty.
        const dm = fcCh && typeof row.note === "number" ? t.instruments[ins]?.duty : null;
        const dutyOf = (x) => (fcCh === "noise" ? (t.properNoiseLayout ? x & 1 : Math.min(1, x)) : x & 3);
        if (dm?.values.length && fcCh !== "tri") {
          duty = dutyOf(dm.values[0]);
          if (fcCh === "noise" && dm.values.some((y) => dutyOf(y) !== duty)) dutyMoves++;
        }
        if (row.vol >= 0) {
          // A volume written under a sounding note (no note on the row): 0
          // silences it (a wave or a PSG channel's volume 0 is off); another
          // moves it, which is not imported.
          if (typeof row.note !== "number" && sounding && !fmVol && row.vol !== vol) {
            // (The triangle has no level: only a 0 its volume macro reads stops it.)
            const triLevel = fcCh !== "tri" || !!t.instruments[ins]?.vol?.values.length;
            if (row.vol === 0 && triLevel) { sounding.end = Math.min(sounding.end ?? Infinity, at); sounding = null; }
            else if (fcCh !== "tri") volUnderNote++;
          }
          vol = row.vol;
        }
        if (row.note === "off") {
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, at);
          sounding = null;
        } else if (typeof row.note === "number" && pceVol && noise !== toNoise) {
          // Channel 5 or 6 playing the other of its wave and its noise: that
          // kind's own track takes it, or (one kind chosen) it is left out.
          if (!ch.split) { if (noise) noiseDropped++; else waveDropped++; }
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, at);
          sounding = null;
        } else if (typeof row.note === "number") {
          const start = at + Math.min(delay, rowTicks - 1);
          const legatoFrom = rp.porta && sounding && lastMidi != null ? lastMidi : null;
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, start);
          // A note at volume 0 is silent — and states nothing, so the next
          // note states what this one would have. (The 2A03's triangle
          // keeps sounding at a column of 0 where no volume macro reads it.)
          const triOn = fcCh === "tri" && !t.instruments[ins]?.vol?.values.length;
          // After a duty macro the duty stays at its last step (Furnace), a
          // silent note's too.
          const noteDuty = dutyToken();
          if (dm?.values.length && fcCh !== "tri") duty = dutyOf(dm.values[dm.values.length - 1]);
          if (!fmVol && vol === 0 && !triOn) { sounding = null; continue; }
          const waveName = pceVol && !toNoise && wave >= 0 ? waveDef(wave) : null;
          const st = {
            voice: waveName ? [waveName, ...voiceTokens(null, true)]
              : voiceTokens(toNoise && !t.properNoiseLayout ? ((row.note % 12) + 12) % 12
                : fcCh === "noise" ? (t.properNoiseLayout ? row.note & 15 : Math.max(0, Math.min(252, row.note))) : null),
            pan: pan ? `:pan ${pan}` : null,
            arp: usedArp ? arpToken() : null,
            duty: noteDuty,
          };
          const pre = [];
          const voiceChanged = st.voice.join(" ") !== cur.voice.join(" ");
          if (voiceChanged) pre.push(...st.voice);
          // A voice switch clears the macros: the arpeggio goes again.
          if (st.arp && (st.arp !== cur.arp || (voiceChanged && arp))) pre.push(st.arp);
          if (st.pan && st.pan !== cur.pan) pre.push(st.pan);
          if (st.duty && st.duty !== cur.duty) pre.push(st.duty);
          cur = st;
          // A noise note is its rate: c2 the slowest (chips/huc6280.js,
          // chips/rp2a03.js — the 2A03's register counts down).
          const midi = fcCh === "noise" ? FC_NOISE_BASE + 15 - fcNoiseRate(row.note, t.properNoiseLayout)
            : toNoise ? PCE_NOISE_BASE + (t.properNoiseLayout ? row.note & 31 : PCE_NOISE_TABLE[((row.note % 12) + 12) % 12])
            : row.note + 24;
          if (noiseRow && (rp.slide || rp.porta || vib)) noisePitch++;
          const v = velOf(vol);
          sounding = { tick: start, end: cut != null ? start + Math.max(1, cut) : null, midi, vel: v, pre, state: flat(st),
            voiceChanged,
            p: noiseRow ? null : { vib: vib && { ...vib }, detune, porta: legatoFrom != null ? { from: legatoFrom, speed: rp.porta } : null,
              slides: rp.slide && !rp.slide.stop ? [{ ...rp.slide, off: 0 }] : [], vibLater: null } };
          if (legatoFrom != null && !noiseRow) sounding.tieIn = true;
          notes.push(sounding);
          lastMidi = midi;
        } else {
          if (cut != null && sounding) sounding.end = Math.min(sounding.end ?? Infinity, at + Math.max(1, cut));
          // Pitch effects inside a note: from where they start in it.
          if (sounding?.p) {
            const off = at - sounding.tick;
            const ps = sounding.p;
            if (rp.vib && !ps.vib && !ps.vibLater && vib) ps.vibLater = { ...vib, off };
            if (rp.slide?.stop) { const sl = ps.slides[ps.slides.length - 1]; if (sl && sl.end == null) sl.end = off; }
            else if (rp.slide) ps.slides.push({ ...rp.slide, off });
          }
        }
      }
    });
    for (let i = 0; i < notes.length; i++) {
      const next = i + 1 < notes.length ? notes[i + 1].tick : endTick;
      notes[i].len = Math.max(1, Math.min(notes[i].end ?? next, next, endTick) - notes[i].tick);
      // A portamento only slurs from a note still sounding.
      if (notes[i].tieIn && !(i > 0 && notes[i - 1].tick + notes[i - 1].len === notes[i].tick)) notes[i].tieIn = false;
    }
    if (!notes.length) continue;
    // The pitch macros, stated as a switch: `(macro :pitch none)` after one.
    const toks = notes.map((n) => pitchToken(n));
    if (toks.some(Boolean)) {
      let curP = null;
      notes.forEach((n, i) => {
        const tok = toks[i] ?? PITCH_NONE;
        if ((tok !== curP && !(curP == null && tok === PITCH_NONE)) || (n.voiceChanged && tok !== PITCH_NONE)) n.pre.push(tok);
        n.state = [...n.state, tok];
        curP = tok;
      });
    }
    tracks.push({ ch, notes, marks, noVel: fcCh === "tri" });
    if (tempoTrack) { marks.push(...speedMarks); tempoTrack = false; }
  }

  // The tempo the song starts with; the loop restates its own.
  if (tracks.length) {
    const m = tracks[0].marks;
    if (!m.some((x) => x.tick === 0)) m.unshift({ tick: 0, tokens: [tempoOf(a.framesPerRow)] });
  }
  if (a.loopIndex > 0 && tracks[0]?.marks.length > 1) {
    const lt = segStart[loopIndex];
    const inForce = tracks[0].marks.filter((x) => x.tick <= lt).pop();
    if (inForce && inForce.tick !== lt) tracks[0].marks.push({ tick: lt, tokens: inForce.tokens });
    tracks[0].marks.sort((x, y) => x.tick - y.tick);
  }

  for (const [k, n] of fxSkipped) warnings.push(`effect ${k} skipped (${n}×)`);
  if (vibUnderSlide) warnings.push(`a vibrato under a slide is dropped for that note (${vibUnderSlide}×)`);
  if (volUnderNote) warnings.push(`a volume moved under a sounding note keeps the note's first (${volUnderNote}×)`);
  if (!tracks.length) warnings.push("no notes to import");
  if (a.channels.some((c) => c.kind === "pcm" && c.notes > 0) && !(onFc && used.some((c) => c.kind === "pcm" && t.channels[c.index].chip === "nes")))
    warnings.push("sample channels are not imported");
  if (dpcm.missing) warnings.push(t.samples ? `a DPCM note with no sample (or one of a depth not read) is left out (${dpcm.missing}×)`
    : "the DPCM channel's samples are not read from a DefleMask module");
  if (dpcm.loopPart) warnings.push(`a DPCM sample looping a part of itself loops whole (${dpcm.loopPart}×)`);
  if (onFc && a.channels.some((c) => c.notes > 0 && t.channels[c.index].chip !== "nes"))
    warnings.push("an expansion chip's channels have no fc part — left out");
  if (waveMacroSteps) warnings.push(`a wave macro naming a wavetable the module lacks is left out (${waveMacroSteps}×)`);
  if (dutyUnderNote) warnings.push(`a 12xx under a sounding note takes effect at the next note (${dutyUnderNote}×)`);
  if (dutyMoves) warnings.push(`a duty macro switching ${onFc ? "the noise's mode" : "noise and wave"} under a note keeps its first step (${dutyMoves}×)`);
  if (waveResampled) warnings.push(`${waveResampled} wavetable(s) not 32 steps wide are read at 32 points`);
  if (noiseDropped) warnings.push(`noise notes on a channel imported as its wave are dropped (${noiseDropped}×)`);
  if (waveDropped) warnings.push(`wave notes on a channel imported as noise are dropped (${waveDropped}×)`);
  if (noisePitch) warnings.push(`a slide or vibrato on a noise note is dropped: its pitch is its rate (${noisePitch}×)`);

  const header = [`; Imported from ${options.fileName ?? "a tracker module"} (${t.format}, ${t.system})`];
  const score = [onPce && ":target pce", onFc && ":target fc", t.title && `:title ${qstr(t.title)}`, t.author && `:author ${qstr(t.author)}`].filter(Boolean);
  if (score.length) header.push(`(def-score ${score.join(" ")})`);
  if (standIns.size) header.push('(import "presets/waveforms/set.mmlisp")');
  for (const d of defs.values()) header.push("", d.text);

  const barTicks = (t.rowsPerBar > 0 ? t.rowsPerBar : a.rowsPerBeat * 4) * rowTicks;
  const segBars = (len) => {
    const b = [];
    for (let x = barTicks; x < len; x += barTicks) b.push(x);
    b.push(len);
    return b;
  };

  if (!options.phrases) {
    const bars = [];
    a.seq.forEach((s, i) => { for (const x of segBars(s.rows * rowTicks)) bars.push(segStart[i] + x); });
    const source = emitSong({
      header, bars, endTick, loopTick: segStart[loopIndex],
      tracks: tracks.map(({ ch, notes, marks, noVel }) => {
        const head = notes[0].state ?? [];
        const ns = notes.map((n, i) => (i === 0 ? { ...n, pre: undefined } : n));
        return { channel: ch.dest, head, notes: ns, marks, noVel };
      }),
    });
    return { source, warnings, pcm: dpcmPcm() };
  }

  // Phrases: cut each track at the segment edges.
  const ptracks = tracks.map(({ ch, notes, marks, noVel }) => {
    const segments = a.seq.map((s, si) => {
      const s0 = segStart[si];
      const len = s.rows * rowTicks;
      const s1 = s0 + len;
      const inSeg = [];
      let state = null;
      for (const n of notes) {
        const e = n.tick + n.len;
        if (e <= s0 || n.tick >= s1) {
          if (n.tick < s0) state = n;
          continue;
        }
        if (n.tick < s0) {
          state = n;
          // Carried in from the previous phrase; at the loop it starts over.
          inSeg.push({ ...n, tick: 0, len: Math.min(e, s1) - s0, pre: undefined, tieIn: si !== loopIndex });
        } else {
          inSeg.push({ ...n, tick: n.tick - s0, len: Math.min(e, s1) - n.tick, pre: state ? n.pre : undefined });
          state = n;
        }
      }
      // The state a phrase restates: the first note's own, else the last one's.
      const first = inSeg[0];
      const src = first ?? state;
      const midi = first?.midi ?? state?.midi ?? 60;
      if (first) first.pre = undefined;
      const segMarks = marks.filter((m) => m.tick >= s0 && m.tick < s1).map((m) => ({ ...m, tick: m.tick - s0 }));
      return {
        label: `p${String(t.orders[s.order][ch.index]).padStart(2, "0")}`,
        len, bars: segBars(len), notes: inSeg, marks: segMarks,
        state: { pre: src?.state ?? [], vel: src?.vel ?? 15, oct: octOf(midi) },
      };
    });
    return { channel: ch.dest, head: [], loopIndex, segments, noVel };
  });
  return { source: emitPhrased({ header, tracks: ptracks }), warnings, pcm: dpcmPcm() };
}
