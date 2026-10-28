// ---------------------------------------------------------------------------
// Tracker songs (DefleMask .dmf, Furnace .fur) → MMLisp
//
// Both readers produce one model:
//   { format, system, title, author, hz, rowsPerBeat, rowsPerBar,
//     speeds: [frames a row, even rows / odd rows], patLen,
//     orders: [[pattern index per channel] per order],
//     channels: [{kind, name, patterns: Map(index → rows)}],
//       rows: [{note: semitone (C-0 = 0) | "off" | null, vol: -1 | n,
//               (a tracker's C-0 is MIDI 12 on FM and the AY's SSG, as
//               Furnace plays them — its A-4 the song's tuning, 440 Hz
//               unless it says — MIDI 24, an octave up, on the other PSGs
//               and wavetables, whose periods it reckons at half the
//               chip's divider, and MIDI 36 on the SN76489: held to the
//               VGMs it writes, DefleMask's modules too; C0_MIDI)
//               ins: -1 | n, fx: [[code, value], …]}]
//     instruments: [{name, kind: "fm", fm: {alg, fb, fms, ams, ops}}
//                 | {name, kind: "std", vol: {values, loop}, arp: {values, loop}}],
//     fmVolMax, psgVolMax }
// and this turns it into a score. The order list plays as the tracker plays
// it (0Bxx jumps, 0Dxx breaks, the song looping where it jumps back to, or
// to the start); a row is a fixed number of ticks, the speeds' average the
// tempo, and their turns (a swing, a groove) each track's `:shuffle`. By default each pattern of each channel becomes a phrase `(def …)`
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
//
// A module of the MSX's, the X68000's or the PC-88's chips can be that
// machine's score (TARGET_CHIPS): the SSG's mixer, noise period and
// hardware envelope as :mode, :noise-rate and :env / :env-rate (Furnace's
// ay.cpp), the SCC's wavetables as the PC Engine's, the YM2413's voices as
// its ROM's or a 2-op def-fm and its drums on the rhythm tracks, the
// YM2608's rhythm on pc88's, the YM2151's DT2 and channel 8's noise on
// x68k's fm8. Each chip's column in its own steps (3 dB, the SCC's linear).
// ---------------------------------------------------------------------------

import { PPQN, emitSong, emitPhrased, qstr, octOf, PITCH_NONE, FM_DESTS, PSG_DESTS, destsFor } from "./import-song.js";
import { targetProfile } from "./targets.js";
import { OPLL_ROM_NAMES } from "./chips/ym2413.js";
import { envCycle } from "./chips/ssg.js";
import { RHYTHM_KIT } from "./import-mucom.js";
import { VEL_DB_PER_STEP, VOL_STEP_DB, VOL_UNITY } from "./ir-utils.js";
import { fmVoiceDef, dtRegFromFurnace } from "./import-fm-voices.js";
import { DMC_RATES } from "./chips/rp2a03.js";
import { encodeWav } from "./export-wav.js";

// What each source channel kind is, for the defaults and the voice: an FM
// channel whose instruments are OPN voices; OPM / OPLL / wavetable channels
// play their notes on a stand-in voice.
const CHANNEL_KINDS = {
  fm: "FM", fm3op: "FM operator", opm: "OPM FM", opll: "OPLL FM", opl: "OPL FM",
  psg: "square", wave: "wavetable", noise: "noise", pcm: "sample", rhythm: "rhythm",
};
// The chip families (the readers' `chip`) each target plays as its own. A
// module offers the targets whose chips play its notes, the one playing the
// most first (a tie: this order), and md always.
const TARGET_CHIPS = {
  pce: ["pce"], fc: ["nes", "vrc6"], msx: ["ssg", "scc", "opll", "opll-rhythm"], x68k: ["opm"],
  pc88: ["opn", "ssg", "opna-rhythm"], md: ["ym2612", "sn76489"],
};
// A target's channels by what they take (import-song.js destsFor), its
// rhythm tracks apart from its samples.
const targetDests = (name) => {
  const tp = targetProfile(name);
  const d = destsFor(tp);
  const rhythm = d.pcm.filter((h) => /rhythm/.test(tp.partOf(h).name));
  return { ...d, pcm: d.pcm.filter((h) => !rhythm.includes(h)), rhythm };
};
const STAND_IN = { psg: "wave-square", wave: "wave-triangle", noise: "wave-square", opll: "wave-saw", opl: "wave-sine", pcm: "wave-saw", fm3op: "wave-sine" };
// The volume column's top, where it is not the model's FM / PSG one.
const VOL_MAX = { opl: 63 };

// The chips whose new note stops a 00xy arpeggio (Furnace's
// keyOffAffectsArp: the PSGs and the wave chips, not FM, the OPLL or the SCC).
const ARP_STOPS_AT_NOTE = new Set(["nes", "vrc6", "pce", "sn76489", "ssg"]);

// A row's C-0 as MIDI by its channel (the model, above).
const C0_MIDI = (chn) => (chn.chip === "sn76489" ? 36
  : ["fm", "fm3op", "opm", "opll", "opl"].includes(chn.kind) || chn.chip === "ssg" ? 12 : 24);

// The effects whose empty value Furnace reads as 00 (a stop, for a slide).
const EMPTY_IS_00 = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0a, 0xe1, 0xe2, 0xe5, 0xf3, 0xf4, 0xfa]);

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
// The VRC6's on fc: its pulses and its saw, in Furnace's channel order.
const VRC6_DESTS = ["sqr3", "sqr4", "saw1"];
const FC_NOISE_UP = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4], FC_NOISE_TOP = [3, 2, 1, 0, 11, 10, 9, 8, 7, 6, 5, 4];
const FC_NOISE_TABLE = [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 4,
  ...FC_NOISE_UP, ...FC_NOISE_UP, ...FC_NOISE_TOP, ...FC_NOISE_UP, ...FC_NOISE_TOP, ...FC_NOISE_UP, ...FC_NOISE_TOP]; // then 15
const fcNoiseRate = (note, proper) => (proper ? 15 - (note & 15) : FC_NOISE_TABLE[Math.max(0, Math.min(252, note))] ?? 15);
const FC_NOISE_BASE = 36; // chips/rp2a03.js NOISE_NOTE_BASE: c2 is the slowest (register 15)
// A def name's note (an env for a fixed arp at one played note).
const FIX_NAMES = ["c", "cs", "d", "ds", "e", "f", "fs", "g", "gs", "a", "as", "b"];
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
// The SSG's mixer (Furnace's bits: 1 tone, 2 noise, 4 the envelope) as its
// `:mode`: the envelope alone is `env`, the buzzer.
const ssgModeName = (m) => (m & 2 ? (m & 1 ? "both" : "noise") : m & 1 ? "tone" : m & 4 ? "env" : "tone");

const FX_NAMES = {
  0x01: "pitch slide up", 0x02: "pitch slide down", 0x03: "portamento", 0x04: "vibrato",
  0x07: "tremolo", 0x10: "LFO", 0x11: "feedback", 0x12: "TL op1", 0x13: "TL op2",
  0x14: "TL op3", 0x15: "TL op4", 0x16: "multiplier", 0x17: "DAC", 0x18: "ext. CH3",
  0x19: "attack", 0x20: "noise mode", 0xe1: "note slide up", 0xe2: "note slide down",
  0xe5: "fine tune", 0xe0: "arpeggio speed",
};

/**
 * An arpeggio macro as the readers hand it on: `fixed[k]` marks a step that
 * is a note of its own (C-0 = 0, as a row's), not a step from the played
 * note. Furnace's (engine.cpp calcArp): bit 30 set on a positive value, or
 * clear on a negative one. A whole-macro fixed mode (DefleMask, .fur before
 * 112) is every step's; without a loop it ends on a relative 0, back on the
 * played note (Furnace's loaders append that step).
 */
export function readArp({ values, loop }, allFixed = false) {
  if (allFixed) {
    const v = loop == null ? [...values, 0] : values;
    return { values: v, loop, fixed: v.map((_, k) => k < values.length) };
  }
  const fixed = values.map((v) => (v < 0 ? !(v & 0x40000000) : !!(v & 0x40000000)));
  if (!fixed.some(Boolean)) return { values, loop, fixed: null };
  return { values: values.map((v, k) => (!fixed[k] ? v : v < 0 ? v | 0x40000000 : v & ~0x40000000)), loop, fixed };
}

/** A sample instrument: Furnace's generic sample type (4), or one a module's legacy mode made. */
const isSampleIns = (it) => it?.type === 4;

/**
 * The legacy sample mode, as Furnace converts it on a DMF and a .fur before
 * 239 (legacySample.cpp): on a channel marked `legacy` — "toggle" where 17xx
 * turns it on and off (the YM2612's DAC), "always" where it is on from the
 * start (the NES's DPCM) — a note plays sample 12 × bank + its place in the
 * octave (EBxx the bank) at the sample's own rate, until an instrument of
 * the chip's own samples takes over. Such a note's row gets `legacy`: a
 * bank instrument (type 4) whose map says so, appended to the module's.
 * Each pattern once, in the order list's order, as Furnace walks them. (Its
 * row's own instrument stays, so a later note without one is the FM
 * voice's again, as DefleMask plays it.)
 */
export function convertLegacySamples(t) {
  const banks = new Map();
  const bankIns = (bank) => {
    if (!banks.has(bank)) {
      const noteMap = Array.from({ length: 180 }, (_, k) => ({ freq: 108, sample: 12 * bank + (k % 12), dpcmFreq: -1, dpcmDelta: -1 }));
      banks.set(bank, t.instruments.length);
      t.instruments.push({ name: `legacy-${bank}`, kind: "std", type: 4, sampleMap: { init: 0, noteMap },
        vol: { values: [], loop: null }, arp: { values: [], loop: null, fixed: null }, wave: { values: [], loop: null }, duty: { values: [], loop: null } });
    }
    return banks.get(bank);
  };
  t.channels.forEach((chn, c) => {
    if (!chn.legacy) return;
    let mode = chn.legacy === "always" ? 1 : 0, bank = 0;
    const done = new Set();
    for (const ord of t.orders) {
      if (done.has(ord[c])) continue;
      done.add(ord[c]);
      for (const row of chn.patterns.get(ord[c]) ?? []) {
        if (!row) continue;
        row.fx = row.fx.filter(([code, v]) => {
          if (code === 0x17 && chn.legacy === "toggle") { mode = v > 0 ? 1 : 0; return false; }
          if (code === 0xeb) { bank = Math.max(0, v); return false; }
          return true;
        });
        const it = row.ins >= 0 ? t.instruments[row.ins] : null;
        if (isSampleIns(it) || (chn.chip === "nes" && it?.type === 34)) mode = 2;
        if (typeof row.note === "number" && mode === 1) row.legacy = bankIns(bank);
      }
    }
  });
}

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
  // (The speeds a row each in turn: their average.)
  const framesPerRow = t.speeds.reduce((s, x) => s + x, 0) / t.speeds.length || 6;
  const bpm = (60 * t.hz) / (framesPerRow * rowsPerBeat);
  const channels = t.channels.map((chn, c) => {
    let notes = 0, noiseNotes = 0, sampleNotes = 0, noise = false, ins = -1;
    for (const { order, rows } of seq) {
      const pat = chn.patterns.get(t.orders[order][c]) ?? [];
      for (let r = 0; r < rows; r++) {
        for (const [code, v] of pat[r]?.fx ?? []) if (chn.chip === "pce" && code === 0x11 && v >= 0) noise = v > 0;
        if (pat[r]?.ins >= 0) ins = pat[r].ins;
        if (typeof pat[r]?.note !== "number") continue;
        if (chn.chip === "pce") noise = dutyNoise(t.instruments[ins]) ?? noise;
        notes++;
        if (noise) noiseNotes++;
        if (chn.legacy && (pat[r].legacy != null || isSampleIns(t.instruments[ins]))) sampleNotes++;
      }
    }
    // (An FM channel's sample notes: the DAC's, md's pcm1.)
    const dac = sampleNotes > 0 && chn.kind !== "pcm" ? ` (${sampleNotes} on the DAC)` : "";
    return { index: c, kind: chn.kind, name: chn.name, chip: chn.chip, notes, noiseNotes, sampleNotes,
      label: `${chn.name} · ${noiseNotes > notes / 2 ? "noise" : CHANNEL_KINDS[chn.kind]} · ${notes} notes${dac}` };
  });
  // A module may be the score of its chips' machine — an MSX one msx, an
  // NES one the Famicom's (an expansion's channels, VRC6, FDS …, left out
  // as md would leave them) — or the Mega Drive's.
  const own = Object.keys(TARGET_CHIPS).map((tg) => ({ tg, n: channels.filter((c) => TARGET_CHIPS[tg].includes(c.chip)).reduce((s, c) => s + c.notes, 0) }))
    .filter((x) => x.n > 0).sort((x, y) => y.n - x.n).map((x) => x.tg);
  const targets = own.includes("md") ? own : [...own, "md"];
  return { seq, loopIndex, rowsPerBeat, framesPerRow, bpm, channels, targets, target: targets[0] };
}

/** The channels a `target` score offers a module's rows. */
export function trackerDests(target = "md") {
  if (target === "fc") return [...FC_DESTS, ...VRC6_DESTS, "pcm1"];
  if (target === "pce") return [...PCE_WAVES, ...Object.values(PCE_NOISE)];
  if (target === "md") return [...FM_DESTS, ...PSG_DESTS, "noise"];
  const d = targetDests(target);
  return [...d.fm, ...d.psg, ...(d.noise ? [d.noise] : []), ...d.wave, ...d.rhythm];
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
  // An NES module on fc: the 2A03's channels in their places, the DPCM on
  // pcm1, the VRC6's on sqr3, sqr4 and saw1; another expansion's are not
  // the target's.
  if (target === "fc") {
    const dest = {};
    for (const ch of a.channels) {
      const i = a.channels.filter((c) => c.chip === ch.chip && c.index < ch.index).length;
      dest[ch.index] = !(ch.notes > 0) ? "drop" : ch.chip === "vrc6" ? VRC6_DESTS[i] ?? "drop"
        : ch.chip !== "nes" ? "drop" : ch.kind === "pcm" ? "pcm1" : FC_DESTS[i] ?? "drop";
    }
    return { dest, phrases: true, bpm: null, target };
  }
  // Another machine (msx, x68k, pc88): its own chips' channels in their
  // kinds' places — FM on FM, the SSG on sqr1-3, the SCC on wave1-5, a
  // rhythm sound on a rhythm track — and the rest where room is left.
  if (target !== "md") {
    const tp = targetProfile(target);
    const d = targetDests(target);
    const own = TARGET_CHIPS[target] ?? [];
    // The FM-PAC's rhythm takes its channels 7-9.
    const rhythmOn = a.channels.some((c) => c.kind === "rhythm" && c.notes > 0 && own.includes(c.chip));
    const fm = d.fm.filter((f) => !(rhythmOn && tp.partOf(f).name === "opll-fm" && /^fm[789]$/.test(f)));
    const sqr = [...d.psg], waves = [...d.wave], rhythm = [...d.rhythm];
    const order = ["fm", "opm", "opll", "psg", "wave", "rhythm", "noise", "fm3op", "opl"];
    const dest = {};
    for (const ch of [...a.channels].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind))) {
      let x = "drop";
      if (ch.notes === 0 || ch.kind === "pcm") x = "drop";
      else if (ch.kind === "rhythm") x = own.includes(ch.chip) ? rhythm.shift() ?? "drop" : "drop";
      else if (ch.kind === "fm" || ch.kind === "opm" || ch.kind === "opll") x = fm.shift() ?? "drop";
      else if (ch.kind === "psg") x = sqr.shift() ?? fm.shift() ?? "drop";
      else if (ch.kind === "wave") x = waves.shift() ?? fm.shift() ?? sqr.shift() ?? "drop";
      else if (ch.kind === "noise" && d.noise) {
        // (The channel the noise is — the SSG's sqr3, x68k's fm8 — only
        // while no other part has it.)
        const host = [...d.psg, ...d.fm].find((h) => tp.voiceKey(h) === tp.voiceKey(d.noise));
        const free = host ? (sqr.includes(host) ? sqr : fm.includes(host) ? fm : null) : null;
        if (!host || free) { x = d.noise; free?.splice(free.indexOf(host), 1); }
      } else if (ch.kind !== "noise") x = fm.shift() ?? sqr.shift() ?? "drop";
      dest[ch.index] = x;
    }
    return { dest, phrases: true, bpm: null, target };
  }
  // The channel playing the DAC takes fm6, the DAC's (its FM notes move to
  // a free fm1-fm5, trackerToMmlisp); no other channel is given it.
  const dacCh = a.channels.find((c) => c.sampleNotes > 0 && c.kind !== "pcm");
  const fm = FM_DESTS.filter((f) => !(dacCh && f === "fm6"));
  const sqr = [...PSG_DESTS];
  let noise = "noise";
  const dest = {};
  for (const ch of a.channels) {
    let d = "drop";
    if (ch === dacCh) d = "fm6";
    else if (ch.notes === 0 || ch.kind === "pcm") d = "drop";
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
 *                 bpm?: number | null, target?: "md" | "pce" | "fc" | "msx" | "x68k" | "pc88", fileName?}
 */
export function trackerToMmlisp(t, options, a = analyzeTracker(t)) {
  const warnings = [];
  const tg = options.target ?? "md";
  const tp = targetProfile(tg);
  const onMd = tg === "md";
  const onPce = tg === "pce";
  const onFc = tg === "fc";
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
  // While the DAC plays (md's pcm1), fm6 is the DAC's: a part bound there
  // moves to an fm1-fm5 no channel asked for, else its FM notes are left out.
  const dacOn = onMd && a.channels.some((c) => c.sampleNotes > 0 && c.kind !== "pcm" && (dest[c.index] ?? "drop") !== "drop");
  const freeFm = () => FM_DESTS.filter((f) => f !== "fm6").find((f) => !taken.has(f) && !Object.values(dest).includes(f));
  for (const ch of a.channels) {
    let d = dest[ch.index] ?? "drop";
    if (d === "drop") continue;
    const fmNotes = ch.notes - (ch.sampleNotes ?? 0);
    if (dacOn && d === "fm6" && fmNotes > 0) {
      d = freeFm() ?? null;
      if (d) warnings.push(`${ch.name}: fm6 is the DAC — its FM notes on ${d}`);
      else warnings.push(`${ch.name}: fm6 is the DAC and fm1-fm5 are taken — its ${fmNotes} FM notes are left out`);
    }
    if (!d && !(ch.sampleNotes > 0)) continue;
    if (d && taken.has(d)) { warnings.push(`${ch.name}: ${d} is already taken — dropped`); continue; }
    taken.add(d);
    // A PC Engine channel playing both its wave and its noise: each kind's
    // notes on its own name — one channel, the noise over the wave where
    // they meet (the :prio layering across its names).
    // The YM2612's FM6 playing samples (the DAC): those notes on pcm1, the
    // rest on its FM channel.
    if (onMd && ch.sampleNotes > 0 && ch.kind !== "pcm") {
      if (fmNotes > 0 && d) { taken.add(d); used.push({ ...ch, dest: d }); }
      if (!taken.has("pcm1")) { taken.add("pcm1"); used.push({ ...ch, dest: "pcm1", samples: true }); }
      continue;
    }
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
      defs.set(key, { name, text: fmVoiceDef(name, raw, { dt2: tp.hasWord("FM_DT2_1") }) });
    }
    return defs.get(key).name;
  };
  // An OPLL instrument on the FM-PAC: a ROM voice by its name, else the
  // user voice as a def-fm of the chip's words (op1 the modulator), where
  // Furnace keeps them (opll.cpp): the EG type in an operator's SSG-EG bit
  // 3, the rectified sines in AMS (op1) and FMS (op2), the sustain in ALG.
  // The drums' preset (16) is no voice.
  // (Its wave macro switches the patch: the one it settles on, its loop's
  // step or its last, is the note's.)
  const patchMoves = new Set();
  const opllVoice = (i) => {
    const { fm: f, wave: wm } = t.instruments[i];
    const preset = wm?.values.length ? wm.values[wm.loop ?? wm.values.length - 1] : f.opllPreset;
    if (wm?.values.some((x) => x !== preset)) patchMoves.add(i);
    if (preset >= 1 && preset <= 15) return OPLL_ROM_NAMES[preset - 1];
    if (preset) return null;
    const key = `opll:${i}`;
    if (!defs.has(key)) {
      const name = uniq(`ins-${slug(t.instruments[i].name) || i}`);
      const op = (o, n) => [["ar", o.ar & 15], ["dr", o.dr & 15], ["sl", o.sl & 15], ["rr", o.rr & 15], ["ml", o.mul & 15],
        ["ks", o.ksr & 1], ["am", o.am & 1], ["ws", (n === 1 ? f.ams : f.fms) & 1], ["eg", (o.ssg >> 3) & 1], ["ksl", o.ksl & 3], ["vib", o.vib & 1],
        ...(n === 1 ? [["tl", o.tl & 63]] : [])].map(([w, v]) => `:${w}${n} ${v ?? 0}`).join(" ");
      defs.set(key, { name, text: `(def-fm ${name} :fb ${f.fb & 7}${f.alg ? " :sus 1" : ""}\n  ${op(f.ops[0], 1)}\n  ${op(f.ops[1], 2)}\n)` });
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
  // `note`: the row's note, for an arp with fixed steps (each step's :semi
  // is its note less this one); `pceNoise`: a PC Engine noise note.
  // `vm`: how the volume macro meets the column on the target's own chip —
  // "log": its steps added to the column's, 3 dB each (the OPLL's), "log31"
  // 0.75 dB each of 31 (the YM2608's rhythm); "ssg" as "log", and its wave
  // macro the mixer, its duty macro the noise period, as `:mode` and
  // `:noise-rate` macros; "lin": a ratio of it (the SCC's), "lin63" of 63
  // (the VRC6's saw), "vrc6" as "lin" with its duty macro as `:duty`.
  const env = (i, nz = null, onWave = false, fc = null, col = null, note = null, pceNoise = false, vm = null) => {
    const am = t.instruments[i]?.arp;
    const moves = !!am?.fixed || !!am?.values.some((x) => x !== 0);
    if (!moves) nz = null;
    if (!am?.fixed) note = null;
    // The column a macro's steps add to (no newVolumeScaling): its own def.
    // Where the chip's level is the column and the step put together in
    // whole steps (Furnace's VOL_SCALE_*: the 2A03's, the SCC's, the
    // VRC6's, an older song's OPLL), a def for each column level it plays at.
    const linVm = vm === "lin" || vm === "vrc6" || vm === "lin63";
    const perCol = (fc && fc !== "tri") || linVm || (vm === "log" && t.newVolumeScaling === false);
    if (!perCol || !t.instruments[i]?.vol?.values.length) col = null;
    const wm = t.instruments[i]?.wave;
    const waveNames = onWave && wm?.values.some((x) => x !== wm.values[0]) ? wm.values.map(waveDef) : null;
    if (waveNames?.includes(null)) waveMacroSteps++;
    const waves = waveNames?.every((n) => n) ? waveNames : null;
    const key = `env:${i}${nz == null ? "" : `:nz${nz}`}${note == null ? "" : `:n${note}`}${waves ? ":w" : ""}${fc ? `:${fc}` : ""}${col == null ? "" : `:v${col}`}${vm ? `:${vm}` : ""}`;
    if (!defs.has(key)) {
      const ins = t.instruments[i];
      const parts = [];
      // A macro's loop as `#sus`, its release point (Furnace's: held there
      // until the note is let go, then on) as `#rel` after that step.
      const arr = (m, map) => {
        const v = m.values.map((x, k) => map(x, k));
        const marks = [[m.loop, "#sus"], [m.rel != null && m.rel < v.length - 1 ? m.rel + 1 : null, "#rel"]]
          .filter(([at]) => at != null).sort((x, y) => y[0] - x[0]);
        for (const [at, mark] of marks) v.splice(at, 0, mark);
        return `[${v.join(" ")}]`;
      };
      const volMax = t.psgVolMax;
      // The PC Engine's volume is 5 bits at 1.5 dB a step, its 0 silent, and
      // its macro's attenuation adds to the volume column's (Furnace): a :vol
      // macro, the fader beside the column's :vel — 2 dB a step, 0 a mute.
      // Elsewhere a ratio of the column's level.
      if (ins.vol?.values.length && fc === "tri")
        parts.push(`:vol ${arr(ins.vol, (x) => (x > 0 ? 31 : 0))}`);
      else if (ins.vol?.values.length && col != null) {
        // The level Furnace writes: VOL_SCALE_LINEAR, the column times the
        // step over the top, rounded down (newVolumeScaling's on the 2A03,
        // always on the SCC and the VRC6, the OPLL's without it), else
        // VOL_SCALE_LOG, the two added less the top. As dB on the chip's
        // own scale (linear, or the OPLL's 3 dB steps), a fader under the
        // column's :vel.
        const top = vm === "lin63" ? 63 : 15;
        const linear = linVm || (fc ? t.newVolumeScaling !== false : true);
        const out = (x) => (linear ? Math.floor((col * Math.min(top, x)) / top) : Math.max(0, Math.min(top, col + Math.min(top, x) - top)));
        const db = (v) => (vm === "log" ? 3 * (v - top) : 20 * Math.log10(v / top));
        parts.push(`:vol ${arr(ins.vol, (x) => (out(x) <= 0 ? 0 : Math.max(1, Math.round(31 + (db(out(x)) - db(col)) / 2))))}`);
      } else if (ins.vol?.values.length && fc)
        parts.push(`:vol ${arr(ins.vol, (x) => (x <= 0 ? 0 : Math.max(1, Math.round(31 + linDb(x) / 2))))}`);
      else if (ins.vol?.values.length && (vm === "lin" || vm === "vrc6" || vm === "lin63")) {
        const top = vm === "lin63" ? 63 : 15;
        parts.push(`:vol ${arr(ins.vol, (x) => (x <= 0 ? 0 : Math.max(1, Math.round(31 + (20 * Math.log10(Math.min(top, x) / top)) / 2))))}`);
      }
      else if (ins.vol?.values.length && (vm === "log" || vm === "ssg" || vm === "log31")) {
        const [top, stepDb] = vm === "log31" ? [31, 0.75] : [15, 3];
        parts.push(`:vol ${arr(ins.vol, (x) => (x <= 0 ? 0 : Math.max(1, Math.round(31 - ((top - Math.min(top, x)) * stepDb) / 2))))}`);
      }
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
      // A fixed step: the chip's place for that note against the played
      // note's — a noise's rate (its layout as the note's), else semitones.
      const fixedSemi = (f) => (fc === "noise"
        ? (t.properNoiseLayout ? (f & 15) - (note & 15) : fcNoiseRate(note, false) - fcNoiseRate(f, false))
        : pceNoise ? (t.properNoiseLayout ? (f & 31) - (note & 31) : rate(f) - rate(note))
        : f - note);
      const semi = (x, k) => (note != null && ins.arp.fixed[k] ? fixedSemi(x) : nz == null ? x : step(x));
      if (moves && ins.arp.values.some((x, k) => semi(x, k) !== 0))
        parts.push(`:semi+ ${arr(ins.arp, semi)}`);
      if (fc === "pulse" && ins.duty?.values.length)
        parts.push(`:duty ${arr(ins.duty, (x) => FC_DUTIES[x & 3])}`);
      if (vm === "vrc6" && ins.duty?.values.length > 1) parts.push(`:duty ${arr(ins.duty, (x) => (x & 7) + 1)}`);
      if (waves) parts.push(`:wave ${arr(wm, (_, k) => waves[k])}`);
      if (vm === "ssg" && ins.wave?.values.some((x) => ssgModeName(x) !== ssgModeName(ins.wave.values[0])))
        parts.push(`:mode ${arr(ins.wave, ssgModeName)}`);
      if (vm === "ssg" && ins.duty?.values.some((x) => x !== ins.duty.values[0]))
        parts.push(`:noise-rate ${arr(ins.duty, (x) => Math.max(1, 31 - (x & 31)))}`);
      const name = uniq(`env-${slug(ins.name) || i}${note == null ? (nz == null ? "" : `-nz${nz}`) : `-${FIX_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12)}`}${fc && fc !== "pulse" ? `-${fc}` : ""}${col == null ? "" : `-v${col}`}`);
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
  let waveMacroSteps = 0, dutyMoves = 0, noiseDropped = 0, waveDropped = 0, noisePitch = 0, dutyUnderNote = 0, vrc6PcmNotes = 0;

  // Pitch effects → one `:pitch` macro a note. A tracker tick is a frame at
  // the song's rate; a slide moves `speed × pitchSlideSpeed` 128ths of a
  // semitone a tick (Furnace's linear pitch, as it plays a DMF too); a
  // vibrato runs a 64-step sine `x` steps a tick, `y` 16ths of a semitone deep.
  const pss = t.pitchSlideSpeed ?? 4;
  const tuneCents = Math.round(1200 * Math.log2((t.tuning || 440) / 440));
  if (t.linearPitch === false && used.length)
    warnings.push("the song's pitch is not linear: slides and portamento are approximated");
  const frames = (scoreTicks) => Math.max(1, Math.round((scoreTicks / ticksPerFrame) * 60 / t.hz));
  const slideCents = (speed) => (speed * pss * 100) / 128; // a tracker tick
  // The pitch effects are `:pitch+` macros, from the note's own pitch: they
  // ride the channel's `:pitch` — the song's tuning and the fine tune,
  // written as the channel's offset — and an arpeggio's `:semi+` rides it
  // too, as Furnace adds them all up (a plain macro would write over it).
  let vibUnderSlide = 0;
  const vibPhase = (x) => (64 + 4 * x) & 255;
  const vibDef = ({ x, y }) => {
    const depth = Math.round((y * 127 * 100) / (16 * 128));
    const period = Math.max(1, Math.round((64 / x) * 60 / t.hz));
    const key = `vib:${x}:${y}`;
    if (!defs.has(key)) {
      const name = uniq(`vib-${x.toString(16)}${y.toString(16)}`);
      // (Furnace's sine starts at the middle, rising — a quarter turn in —
      // and its first tick has already stepped it: `x` 64ths more.)
      defs.set(key, { name, text: `(def ${name} (macro :pitch+ (sin ${-depth}..${depth} :len ${period}f :phase ${vibPhase(x)})))` });
    }
    return defs.get(key).name;
  };
  // An instrument's pitch macro as a def of the note's pitch a frame at a
  // time, in cents (a step 1/128 semitone): its delay, each step held its
  // speed, a relative macro's steps added up; a loop runs on to two
  // seconds, or until it has gone four octaves.
  const insPitchDef = (i) => {
    const m = t.instruments[i]?.pitch;
    if (!m?.values.length || !m.values.some(Boolean)) return null;
    const key = `ipitch:${i}`;
    if (!defs.has(key)) {
      const out = new Array(m.delay ?? 0).fill(0);
      const cap = Math.round(2 * t.hz); // two seconds of ticks
      let acc = 0;
      for (let k = 0; k < m.values.length && out.length < cap;) {
        acc = m.relative ? acc + m.values[k] : m.values[k];
        const c = Math.round((acc * 100) / 128);
        for (let s = 0; s < (m.speed ?? 1); s++) out.push(c);
        if (Math.abs(c) > 4800) break;
        k++;
        if (k === m.values.length && m.loop != null && (m.relative ? m.values.slice(m.loop).some(Boolean) : m.loop < m.values.length - 1)) k = m.loop;
      }
      const name = uniq(`pitch-${slug(t.instruments[i].name) || i}`);
      defs.set(key, { name, text: `(def ${name} (macro :pitch+ [${out.join(" ")}]))` });
    }
    return defs.get(key).name;
  };
  let insPitchUnder = 0;
  const pitchToken = (n) => {
    const p = n.p;
    if (!p) return null;
    // The instrument's pitch macro: the note's, unless a slide, a
    // portamento or a vibrato of its row takes the one pitch macro a note has.
    if (n.insPitch != null) {
      if (!p.porta && !p.slides.length && !p.vib && !p.vibLater) return insPitchDef(n.insPitch);
      insPitchUnder++;
    }
    // (A wait in the song's ticks as played, `waitF`, where the note knows it.)
    const waitOf = (scoreTicks, ticks) => (ticks != null ? Math.max(0, Math.round((ticks * 60) / t.hz)) : frames(scoreTicks));
    const line = (from, to, scoreTicks, wait, waitF) =>
      `(macro :pitch+ (linear ${from}..${to} :len ${frames(scoreTicks)}f${wait ? ` :wait ${waitOf(wait, waitF)}f` : ""}))`;
    if (p.porta) {
      const D = (p.porta.from - n.midi) * 100;
      return line(D, 0, (Math.abs(D) / slideCents(p.porta.speed)) * ticksPerFrame);
    }
    const sl = p.slides[0];
    if (sl) {
      if (p.vib || p.vibLater) vibUnderSlide++;
      if (sl.semis) {
        const C = sl.dir * sl.semis * 100;
        return line(0, C, (Math.abs(C) / slideCents(sl.speed)) * ticksPerFrame, sl.off, sl.offF);
      }
      const span = Math.max(1, (sl.end ?? n.len) - sl.off);
      const C = Math.round(sl.dir * slideCents(sl.speed) * (span / ticksPerFrame));
      return line(0, C, span, sl.off, sl.offF);
    }
    if (p.vib) return vibDef(p.vib);
    if (p.vibLater) {
      const { x, y, off, offF } = p.vibLater;
      const depth = Math.round((y * 127 * 100) / (16 * 128));
      const period = Math.max(1, Math.round((64 / x) * 60 / t.hz));
      return `(macro :pitch+ (sin ${-depth}..${depth} :len ${period}f :phase ${vibPhase(x)} :wait ${waitOf(off, offF)}f))`;
    }
    return null;
  };

  // The song's speed: a 09xx / 0Fxx on any channel is the song's (Furnace
  // plays them so), its rows' tempo the speeds' average from there. The
  // speeds take turns a row each (a swing, a groove); 09xx picks a groove
  // where the song has them (from its first speed), else sets speed 1, as
  // 0Fxx sets speed 2 of two (playback.cpp). Under DefleMask's speed select
  // the two go by the row's parity instead, the other way round in an odd
  // order of an odd pattern length. Each row's frames, as played, are
  // `rowFrames`; the turns are each track's `:shuffle` over a row's
  // `:shuffle-base`, restated where the speeds or their turn change.
  const speedMarks = [];
  const shuffleMarks = [];
  const rowFrames = [];
  {
    let sp = [...t.speeds];
    let cur = 0;
    let written = null; // the :shuffle in force: {steps, from (a row)}
    const grooves = t.grooves ?? [];
    const base = `:shuffle-base ${4 * a.rowsPerBeat}`;
    let baseSet = false;
    const rot = (xs, k) => xs.map((_, i) => xs[(i + k) % xs.length]);
    a.seq.forEach(({ order, rows }, si) => {
      for (let r = 0; r < rows; r++) {
        let changed = false;
        t.channels.forEach((chn, c) => {
          for (const [code, val] of chn.patterns.get(t.orders[order][c])?.[r]?.fx ?? []) {
            if (code === 0x09 && grooves.length) { if (val >= 0 && val < grooves.length) { sp = [...grooves[val]]; cur = 0; changed = true; } }
            else if (code === 0x09 && val > 0) { sp[0] = val; changed = true; }
            else if (code === 0x0f && val > 0) { sp[sp.length === 2 && !grooves.length ? 1 : 0] = val; changed = true; }
          }
        });
        const tick = segStart[si] + r * rowTicks;
        // (One set on the first row is the song's from the start.)
        if (changed) speedMarks.push({ tick, tempo: true, tokens: [tempoOf(sp.reduce((s, x) => s + x, 0) / sp.length)] });
        let turn = sp;
        let at;
        if (t.brokenSpeedSel) {
          turn = [sp[0], sp[1] ?? sp[0]];
          at = (r + (t.patLen & 1 && order & 1 ? 1 : 0)) & 1;
        } else {
          at = cur;
          cur = (cur + 1) % sp.length;
        }
        const g = rowFrames.length;
        rowFrames.push(turn[at]);
        // The warp this row should be on: the speeds from its own.
        const straight = turn.every((x) => x === turn[0]);
        const want = straight ? null : rot(turn, at);
        const on = written && !straight &&
          rot(written.steps, (g - written.from) % written.steps.length).join(" ") === want.join(" ");
        if (straight ? written : !on) {
          const tokens = [];
          if (want && !baseSet) { tokens.push(base); baseSet = true; }
          tokens.push(want ? `:shuffle [${want.join(" ")}]` : ":shuffle none");
          shuffleMarks.push({ tick, tokens });
          written = want && { steps: want, from: g };
        }
      }
    });
  }
  // A row's start and `frames` in, in the score's written ticks: the warp
  // stretches each row evenly, so a row's frame is its share of the row.
  const ticksIn = (tick, frames) => {
    let g = Math.round(tick / rowTicks);
    let n = 0;
    while (g < rowFrames.length - 1 && frames >= rowFrames[g]) { frames -= rowFrames[g]; n += rowTicks; g++; }
    return n + Math.round((frames * rowTicks) / (rowFrames[g] || a.framesPerRow));
  };
  // The NES's DPCM channel on fc's pcm1: a note plays its instrument's
  // sample (its note map's, or its one), at the DMC rate the note picks — an
  // NES instrument's map or the note's low four bits, else the sample's
  // rate at the note (C-4 its own) nearest a DMC rate — until the next note
  // or a note off. A def-pcm for each sample and rate, its :rate the rate
  // (c4 plays it), all in one wav; the 1-bit samples decoded as Furnace
  // renders them.
  // (On md the same for the YM2612's DAC: FM6's sample notes on pcm1, each
  // sample at its rate.)
  const dpcm = { defs: new Map(), offsets: new Map(), parts: [], frames: 0, missing: 0, loopPart: 0, rate: 0 };
  const pcmWord = onFc ? "dpcm" : "dac";
  const wavFile = `${String(options.fileName || "module").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "")}-${pcmWord}.wav`;
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
      dpcm.rate = Math.max(dpcm.rate, Math.round(hz));
      const name = uniq(`${pcmWord}-${slug(String(sm.name ?? "").replace(/\.(wav|raw|pcm|bin)$/i, "")) || si}`);
      defs.set(`dpcm:${key}`, { name, text: `(def-pcm ${name} :file ${qstr(wavFile)} :rate ${Math.round(hz)} :offset ${dpcm.offsets.get(si)} :frames ${sm.data.length})` });
      dpcm.defs.set(key, { name, loop: !!sm.loop });
    }
    return dpcm.defs.get(key);
  };
  const dpcmTrack = (ch, chn) => {
    const notes = [];
    // The DMC mode: the song's, set by an NES instrument's note (Furnace
    // switches to it there) and by 18xx.
    let ins = -1, sounding = null, lastRate = 0, prev = null, dmcMode = onFc && t.dpcmMode;
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
          if (code === 0xed && val > 0) delay = val;
          else if (code === 0xec && val >= 0) cut = val;
          else if (code === 0x18 && val >= 0 && onFc) dmcMode = val > 0;
          else if (code === 0x09 || code === 0x0f || code === 0x0b || code === 0x0d) { /* the song's speed, the order walk */ }
          else if (code >= 0 && !ch.samples) { // (FM6's: the FM pass counts them)
            const k = FC_FX[code] ?? FX_NAMES[code] ?? `${code.toString(16).toUpperCase().padStart(2, "0")}xx`;
            fxSkipped.set(k, (fxSkipped.get(k) ?? 0) + 1);
          }
        }
        // EDxx / ECxx count frames — of this row's speed, so they land on
        // the frames Furnace plays under the shuffle — the cut's from the
        // delayed start.
        if (cut != null) cut = ticksIn(at, delay + cut) - ticksIn(at, delay);
        if (delay) delay = ticksIn(at, delay);
        if (row.ins >= 0) ins = row.ins;
        // FM6's FM note: the DAC stops (the FM pass plays it).
        const fmNote = ch.samples && typeof row.note === "number" && row.legacy == null && !isSampleIns(t.instruments[ins]);
        if (row.note === "off" || fmNote) {
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, at);
          sounding = null;
        } else if (typeof row.note === "number") {
          const start = at + Math.min(delay, rowTicks - 1);
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, start);
          sounding = null;
          const hit = hitOf(t.instruments[row.legacy ?? ins], row.note);
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
    const rate = onFc ? Math.round(DMC_RATES[15]) : dpcm.rate;
    return { wavFile, rate, mono, wav: encodeWav(mono, null, rate), entries: [...dpcm.defs.values()], tag: t.format };
  };

  const tracks = [];
  let tempoTrack = true;
  for (const ch of used) {
    const chn = t.channels[ch.index];
    if ((onFc && chn.chip === "nes" && ch.kind === "pcm") || ch.samples) {
      const tr = dpcmTrack(ch, chn);
      if (!tr) continue;
      tracks.push(tr);
      if (tempoTrack) { tr.marks.push(...speedMarks); tempoTrack = false; }
      tr.marks.push(...shuffleMarks);
      continue;
    }
    const onFm = ch.dest.startsWith("fm");
    const fmVol = ["fm", "opm", "fm3op"].includes(ch.kind);
    const volMax = VOL_MAX[ch.kind] ?? (fmVol ? t.fmVolMax : t.psgVolMax);
    // On pce the volume column is the chip's 5-bit volume, 1.5 dB a step.
    const pceVol = onPce && chn.chip === "pce";
    // A channel on its own chip's part of the target: the SSG (its mixer,
    // the song's noise period), the SCC (its wavetables), the OPLL (its
    // voices), a rhythm sound.
    const own = !!TARGET_CHIPS[tg]?.includes(chn.chip);
    const part = tp.partOf(ch.dest);
    const ssgCh = own && chn.chip === "ssg" && part?.name === "ssg";
    const sccCh = own && chn.chip === "scc" && part?.kind === "wave";
    const opllCh = own && chn.chip === "opll" && part?.name === "opll-fm";
    const rhythmCh = /^rhythm/.test(ch.dest);
    const waveCh = pceVol || sccCh; // a channel that plays the module's wavetables
    // The VRC6 on fc: a pulse (its eight duties) or the saw, each column
    // linear (the saw's to 63) and its volume macro a ratio of it.
    const vrc6Ch = onFc && chn.chip === "vrc6" && VRC6_DESTS.includes(ch.dest) ? (ch.dest === "saw1" ? "saw" : "pulse") : null;
    // A column in log steps of this many dB (the PC Engine's 1.5, the SSG's
    // and the OPLL's 3, the YM2608 rhythm's 0.75); the SCC's is linear.
    const logStep = pceVol ? 1.5 : ssgCh || opllCh || (rhythmCh && chn.chip === "opll-rhythm") ? 3
      : rhythmCh && chn.chip === "opna-rhythm" ? 0.75 : 0;
    // (A rhythm sound's: the OPLL's 3 dB steps, the YM2608's 0.75.)
    const vm = ssgCh ? "ssg" : opllCh || (rhythmCh && chn.chip === "opll-rhythm") ? "log"
      : rhythmCh && chn.chip === "opna-rhythm" ? "log31" : sccCh ? "lin"
      : vrc6Ch === "pulse" ? "vrc6" : vrc6Ch === "saw" ? "lin63" : null;
    const linCh = sccCh || !!vrc6Ch; // a linear column (the SCC's, the VRC6's)
    const fmPan = onFm && !!part?.words("PAN");
    const toNoise = onPce && ch.dest.startsWith("noise");
    // A 2A03 channel on fc: which of its kinds (env's `fc`).
    const fcCh = onFc && chn.chip === "nes" ? (ch.dest === "tri" ? "tri" : ch.dest === "noise" ? "noise" : "pulse") : null;
    const noiseRow = toNoise || fcCh === "noise" || rhythmCh; // a note is a rate (a sound): no pitch effects
    // The column's top, and a level of it as a velocity, before the clamp
    // to 0-15 (in eighths where the chip's steps are finer than :vel's).
    const colMax = logStep || linCh ? chn.volMax ?? volMax : volMax;
    const velRaw = (v) => (fcCh ? 15 + linDb(v) / VEL_DB_PER_STEP
      : linCh ? (v > 0 ? 15 + (20 * Math.log10(Math.min(colMax, v) / colMax)) / VEL_DB_PER_STEP : -Infinity)
      : fmVol ? 15 - ((volMax - v) * 0.75) / 2
      : logStep ? 15 - (colMax - v) * logStep / VEL_DB_PER_STEP
      : (v * 15) / volMax);
    const velOf = (v) => {
      if (v < 0) return 15;
      if ((fcCh || linCh) && v <= 0) return 0;
      const x = velRaw(v);
      return Math.max(0, Math.min(15, fcCh || linCh || logStep ? Math.round(x * 8) / 8 : Math.round(x)));
    };
    const standIn = STAND_IN[ch.kind] ?? "wave-square";
    // Sticky state: the voice (instrument), the pan, the arpeggio. A channel
    // that ever pans or arpeggiates states both from its first note, so a
    // phrase reads the same wherever the order list plays it.
    const uses = (code) => a.seq.some(({ order, rows }) =>
      (chn.patterns.get(t.orders[order][ch.index]) ?? []).slice(0, rows).some((r) => r?.fx.some(([c]) => c === code)));
    let ins = -1;
    let vol = -1;
    // The volume slide in force (0Axy, its kin), in column steps a frame,
    // and the column it has slid to (Furnace keeps the fraction; the next
    // note starts from its whole part).
    let slide = 0;
    let colF = -1;
    // 0Axy: a quarter step a frame, x up or else y down.
    const volSlide = (val) => (val & 15 ? -(val & 15) : val >> 4) / 4;
    // The last vibrato and portamento, for 05xy and 06xy.
    let lastVib = 0;
    let lastPorta = 0;
    let pan = (fmPan || pceVol) && (uses(0x08) || (fmPan && uses(0x80))) ? "center" : null;
    let wave = -1; // the wavetable the channel plays (pce, the SCC)
    // The SSG's mixer (Furnace's: 1 tone, 2 noise, 4 the envelope; 20xx
    // and the wave macro) and the noise period (21xx, the duty macro: the
    // register 31 less it). `:mode` is said where the channel ever leaves tone.
    let psgMode = 1, noiseFreq = null, vrc6Pcm = false;
    // The hardware envelope (Furnace's AY): its shape (22xy, the ex2
    // macro), its period (23xx / 24xx, ex5) and the auto-envelope's ratio
    // to the tone's (29xy, ex3 : alg), which sets the period from the note.
    let envShape = 0, envPeriod = 0, autoNum = 0, autoDen = 0;
    const ssgChip = ssgCh ? tp.chipOf(ch.dest) : null;
    const ssgClock = ssgChip?.ssg?.clock ?? ssgChip?.clock ?? 1789773;
    // The YM2151's channel 8 on x68k's fm8, whose :mode noise its fourth
    // operator is (10xx, the duty macro: 0 off, else the period 33 less it).
    const opmNoiseCh = own && chn.chip === "opm" && /FM8$/.test(chn.name) && !!tp.channels?.[ch.dest]?.modes?.noise;
    let opmNoise = 0;
    const opmNoiseSaid = opmNoiseCh && (uses(0x10) || t.instruments.some((it) => it?.duty?.values.some((x) => x > 0)));
    const modeSaid = ssgCh && (uses(0x20) || t.instruments.some((it) => it?.kind === "std" && it.wave?.values.some((x) => (x & 3) !== 1)));
    let noise = false; // channel 5 or 6 on its noise (pce, 11xx)
    // The 2A03's duty (12xx, the duty macro: Furnace's 0-3, 0 at the start)
    // — a pulse's shape, the noise's mode.
    let duty = 0;
    let arp = 0;
    const arpStopsAtNote = ARP_STOPS_AT_NOTE.has(chn.chip);
    // The 00xy arpeggio's phase, as Furnace runs it (playback.cpp): while
    // the arpeggio is on, its stage (the note, +x, +y) steps every
    // `arpSpeed` ticks, playing on across notes — a new note starts it over
    // only under resetArpPhaseOnNewNote, a row under rowResetsArpPos.
    let arpStage = -1, arpTicks = 1, arpSpeed = t.arpSpeed || 1, prevFrames = 0;
    let curFrame = 0; // the row's first tick, counted in the song's ticks
    const arpRun = (frames) => {
      for (let f = 0; f < frames && arp; f++)
        if (--arpTicks < 1) { arpTicks = arpSpeed; arpStage = (arpStage + 1) % 3; }
    };
    let usedMacro = false;
    const voiceTokens = (nz = null, onWave = false, note = null) => {
      const it = t.instruments[ins];
      if (rhythmCh) {
        if (!chn.drum) return [];
        // Its instrument's volume macro, as the sound's :vol.
        if (vm && it?.kind === "std" && it.vol?.values.length) { usedMacro = true; return [chn.drum, env(ins, null, false, null, vol < 0 ? colMax : vol, null, false, vm)]; }
        return usedMacro ? [chn.drum, "(macro none)"] : [chn.drum];
      }
      if (opllCh) {
        const v = it?.fm ? opllVoice(ins) : null;
        if (it?.kind === "std") { usedMacro = true; return [...(v ? [v] : []), env(ins, null, false, null, vol < 0 ? colMax : vol, note, false, vm)]; }
        return usedMacro ? [...(v ? [v] : []), "(macro none)"] : v ? [v] : [];
      }
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
      const e = env(ins, nz, onWave, fcCh, vol < 0 ? colMax : vol, note, toNoise, vm);
      if (onFm) { standIns.add(standIn); return [standIn, e]; }
      return [e];
    };
    // A note's arpeggio: the stages from its first frame on, a cycle of them.
    const arpToken = () => {
      if (!arp) return "(macro :semi none)";
      let st = arpStage, tk = arpTicks;
      const steps = [];
      for (let f = 0; f < 3 * arpSpeed; f++) {
        if (--tk < 1) { tk = arpSpeed; st = (st + 1) % 3; }
        steps.push(st === 1 ? arp >> 4 : st === 2 ? arp & 15 : 0);
      }
      return `(macro :semi+ [#sus ${steps.join(" ")}])`;
    };
    let usedArp = uses(0x00);
    let cur = { voice: voiceTokens(), pan: null, arp: null, duty: null, mode: modeSaid || opmNoiseSaid ? ":mode tone" : null, rate: null };
    const dutyToken = () => (fcCh === "pulse" ? `:duty ${FC_DUTIES[duty & 3]}` : fcCh === "noise" ? `:mode ${duty & 1 ? "periodic" : "white"}`
      : vrc6Ch === "pulse" ? `:duty ${(duty & 7) + 1}` : null); // (the VRC6's: sixteenths less one)
    // Pitch effects: the vibrato and fine tune in force, and each note's
    // own (worked into a `:pitch` macro once its length is known).
    let vib = null;
    // (From the song's tuning: its A-4 against 440 Hz, in cents.)
    let detune = tuneCents;
    // The channel's offset — the tuning and the fine tune — stated where it
    // ever is one.
    const tuneSaid = !noiseRow && (tuneCents !== 0 || uses(0xe5));
    let lastMidi = null;
    const flat = (st) => [...st.voice, ...(st.arp ? [st.arp] : []), ...(st.pan ? [st.pan] : []), ...(st.duty ? [st.duty] : []),
      ...(st.mode ? [st.mode] : []), ...(st.rate ? [st.rate] : []), ...(st.tune ? [st.tune] : []),
      ...(st.env && st.env !== ":env none" ? [st.env, st.envRate, st.envSemi].filter(Boolean) : [])];
    // The envelope a note is on: its shape, and its period — the
    // auto-envelope's the note's own (`:env-rate note`, num/den of its
    // pitch; a triangle's cycle, which MMLisp halves to the note, an octave
    // under it), else the period register's rate on the target's clock.
    const ssgEnvTokens = () => {
      if (!ssgCh || !(psgMode & 4)) return { env: cur.env && ":env none", envRate: cur.envRate, envSemi: cur.envSemi };
      const tri = envCycle(envShape) === 512;
      if (autoNum > 0 && autoDen > 0) {
        const semi = Math.max(-48, Math.min(48, Math.round(12 * Math.log2(autoNum / autoDen)) - (tri ? 12 : 0)));
        return { env: `:env ${envShape}`, envRate: ":env-rate note", envSemi: `:env-semi ${semi}` };
      }
      const hz = ssgClock / (envCycle(envShape) * Math.max(1, envPeriod));
      return { env: `:env ${envShape}`, envRate: `:env-rate ${+hz.toPrecision(4)}`, envSemi: cur.envSemi };
    };

    const notes = [];
    const marks = [];
    let sounding = null;
    // The column a sounding note moves through under it: points (tick from
    // its start, column), a line from each to the next.
    const levelTo = (n, tick, v) => (n.lv ??= [{ off: 0, v: n.col }]).push({ off: Math.max(0, tick - n.tick), v });
    // The slide through the row, until the column's top or 0 stops it
    // (0 silences a note — on FM too, its carriers at TL 127).
    const slideRow = (at) => {
      if (!slide) return;
      const c0 = colF < 0 ? colMax : colF;
      let c1 = c0 + slide * a.framesPerRow;
      let end = at + rowTicks;
      if (c1 >= colMax || c1 <= 0) {
        const lim = c1 >= colMax ? colMax : 0;
        end = at + Math.max(0, Math.round(((lim - c0) / slide) * ticksPerFrame));
        c1 = lim;
        slide = 0;
      }
      if (sounding && c1 !== c0 && fcCh !== "tri") {
        levelTo(sounding, at, c0);
        levelTo(sounding, end, c1);
        if (c1 === 0) { sounding.end = Math.min(sounding.end ?? Infinity, end); sounding = null; }
      }
      colF = c1;
      vol = Math.floor(c1);
    };
    // A note's level line as a macro: on :vol, a fader below the note's
    // :vel, which is the loudest the line reaches; on :vel, the level
    // itself. Its stages run in score ticks, a hold the last value.
    const levelToken = (n) => {
      if (!n.lv) return null;
      const pts = [];
      for (const p of n.lv) {
        if (p.off > n.len) {
          const q = pts[pts.length - 1];
          if (q && q.off < n.len) pts.push({ off: n.len, v: q.v + ((p.v - q.v) * (n.len - q.off)) / (p.off - q.off) });
          break;
        }
        const q = pts[pts.length - 1];
        if (!q || q.off !== p.off || q.v !== p.v) pts.push(p);
      }
      if (pts[pts.length - 1].off < n.len) pts.push({ off: n.len, v: pts[pts.length - 1].v });
      const top = Math.max(...pts.map((p) => p.v));
      const onVel = n.lineOn === "vel";
      if (!onVel) n.vel = velOf(top);
      // The level in the line's units, before rounding.
      // (On :vol, from the :vel the note is written at: the line reaches
      // below :vel's floor where the column does.)
      const level = (v) => (onVel ? (fcCh && v <= 0 ? 0 : velRaw(v)) : VOL_UNITY + ((velRaw(v) - n.vel) * VEL_DB_PER_STEP) / VOL_STEP_DB);
      const unit = (v) => (onVel ? velOf(v) : Math.max(0, Math.min(VOL_UNITY, Math.round(level(v)))));
      // A slide over many rows is one line: drop a point on the line
      // through its neighbors (in level: a linear column is not one in dB).
      for (let i = pts.length - 2; i > 0; i--) {
        const [p, q, r] = [pts[i - 1], pts[i], pts[i + 1]];
        const [lp, lq, lr] = [level(p.v), level(q.v), level(r.v)];
        if (q.off > p.off && r.off > q.off && Math.abs((lq - lp) * (r.off - q.off) - (lr - lq) * (q.off - p.off)) < 1e-6) pts.splice(i, 1);
      }
      const stages = [];
      // The note starts at its :vel, or :vol's top: a hold there waits.
      let now = onVel ? n.vel : VOL_UNITY;
      let hold = 0;
      for (let i = 1; i < pts.length; i++) {
        const len = pts[i].off - pts[i - 1].off;
        const a = unit(pts[i - 1].v);
        const b = unit(pts[i].v);
        if (!len) continue;
        if (a === b && a === now) { hold += len; continue; }
        if (hold) stages.push(`(wait ${hold}t)`);
        hold = 0;
        stages.push(`(linear ${a}..${b} :len ${len}t)`);
        now = b;
      }
      if (!stages.length) return null;
      return `(macro :${n.lineOn} [${stages.join(" ")}])`;
    };
    a.seq.forEach(({ order, rows }, si) => {
      const pat = chn.patterns.get(t.orders[order][ch.index]) ?? [];
      for (let r = 0; r < rows; r++) {
        const row = pat[r] ?? { note: null, vol: -1, ins: -1, fx: [] };
        const at = segStart[si] + r * rowTicks;
        let delay = 0;
        let cut = null;
        let jump = null; // F8xx / F9xx
        const rp = {}; // this row's pitch effects
        // The arpeggio steps through the row before (its frames, with the
        // arpeggio it had), then this row's first tick.
        arpRun(prevFrames);
        curFrame += prevFrames;
        prevFrames = rowFrames[Math.round(segStart[si] / rowTicks) + r] ?? a.framesPerRow;
        if (t.rowResetsArpPos) arpStage = -1;
        if (t.resetArpPhaseOnNewNote && typeof row.note === "number") arpStage = -1;
        // A new note stops the arpeggio on the PSGs and wavetables (Furnace's
        // keyOffAffectsArp): its row's 00xy starts it again.
        if (arpStopsAtNote && typeof row.note === "number") arp = 0;
        for (const [code, v] of row.fx) {
          // An effect with no value is 00 (Furnace reads it so).
          const val = v < 0 && EMPTY_IS_00.has(code) ? 0 : v;
          if ((code === 0x04 || code === 0x05) && val >= 0) {
            // 05xy: the last 04xy's vibrato again (0500 none), with a
            // volume slide.
            if (code === 0x04 && val) lastVib = val;
            const vv = code === 0x04 ? val : val ? lastVib : 0;
            vib = vv >> 4 && vv & 15 ? { x: vv >> 4, y: vv & 15 } : null;
            rp.vib = true;
            if (code === 0x05) slide = volSlide(val);
          } else if ((code === 0x01 || code === 0x02) && val >= 0) {
            rp.slide = val ? { dir: code === 0x01 ? 1 : -1, speed: val } : { stop: true };
          } else if ((code === 0xe1 || code === 0xe2) && val >= 0) {
            if (val & 15 && val >> 4) rp.slide = { dir: code === 0xe1 ? 1 : -1, speed: (val >> 4) * 4, semis: val & 15 };
          } else if (code === 0x03 && val >= 0) { if (val) rp.porta = lastPorta = val; }
          // 06xy: the last 03xx's portamento again, with a volume slide.
          else if (code === 0x06 && val >= 0) { if (val && lastPorta) rp.porta = lastPorta; slide = volSlide(val); }
          // Fine tune, to 10 cents (a song tuned note by note — a VGM
          // conversion — would otherwise name an offset on every note).
          else if (code === 0xe5 && val >= 0) detune = tuneCents + (v < 0 ? 0 : Math.round((val - 0x80) * 100 / 128 / 10) * 10 || 0);
          // 80xx: Furnace's linear pan, a side off only at its end (00 left,
          // FF right), as its FM channels key their sides.
          else if (code === 0x80 && fmPan && val >= 0) pan = val === 0 ? "left" : val === 0xff ? "right" : "center";
          else if (code === 0x08 && fmPan && val >= 0) {
            pan = (val >> 4) && (val & 15) ? "center" : val >> 4 ? "left" : val & 15 ? "right" : "center";
          } else if (code === 0x08 && pceVol && val >= 0) {
            // The channel's left and right levels: the louder side full, the
            // other as far down as their difference (chips/huc6280.js panLevels).
            const p = ((val & 15) - (val >> 4)) / 15;
            pan = p === 0 ? "center" : String(+p.toFixed(2));
          } else if (code === 0x10 && waveCh && val >= 0) wave = val;
          else if (code === 0x10 && opmNoiseCh && val >= 0) opmNoise = val;
          else if (code === 0x20 && ssgCh && val >= 0) psgMode = (val + 1) & 7;
          else if (code === 0x21 && ssgCh && val >= 0) noiseFreq = 31 - (val & 31);
          else if (code === 0x22 && ssgCh && val >= 0) { envShape = val >> 4; psgMode = val & 15 ? psgMode | 4 : psgMode & ~4; }
          else if (code === 0x23 && ssgCh && val >= 0) { envPeriod = (envPeriod & 0xff00) | val; autoNum = autoDen = 0; }
          else if (code === 0x24 && ssgCh && val >= 0) { envPeriod = (envPeriod & 0xff) | (val << 8); autoNum = autoDen = 0; }
          else if (code === 0x29 && ssgCh && val >= 0) { autoNum = val >> 4; autoDen = val & 15; }
          else if (code === 0x11 && pceVol && val >= 0) noise = val > 0;
          else if (code === 0x17 && vrc6Ch && val >= 0) vrc6Pcm = val > 0;
          else if (code === 0x12 && ((fcCh && fcCh !== "tri") || vrc6Ch === "pulse") && val >= 0) {
            duty = val;
            // Under a sounding note Furnace writes it at once; here it is
            // the next note's.
            if (typeof row.note !== "number" && sounding) dutyUnderNote++;
          }
          else if (code === 0x00 && val >= 0) { arp = val; usedArp = true; }
          else if (code === 0xe0 && val > 0) arpSpeed = val;
          // Volume slides (Furnace's playback.cpp): 0Axy (05xy and 06xy
          // above), FAxy four times as fast, F3xx / F4xx xx/256 of a step a
          // frame, F8xx / F9xx a jump that stops the slide.
          else if (code === 0x0a && val >= 0) slide = volSlide(val);
          else if (code === 0xfa && val >= 0) slide = volSlide(val) * 4;
          else if ((code === 0xf3 || code === 0xf4) && val >= 0) slide = (code === 0xf3 ? val : -val) / 256;
          else if ((code === 0xf8 || code === 0xf9) && val >= 0) { slide = 0; jump = code === 0xf8 ? val : -val; }
          else if (code === 0xed && val > 0) delay = val;
          else if (code === 0xec && val >= 0) cut = val;
          else if (code === 0x09 || code === 0x0f) { /* the song's speed: speedMarks */ }
          else if (code === 0x0b || code === 0x0d) { /* the order walk */ }
          else if (code >= 0) {
            // A tremolo stops a volume slide (the two do not run at once).
            if (code === 0x07 && val & 15) slide = 0;
            const k = (pceVol ? PCE_FX[code] : fcCh ? FC_FX[code] : null) ?? FX_NAMES[code] ?? `${code.toString(16).toUpperCase().padStart(2, "0")}xx`;
            fxSkipped.set(k, (fxSkipped.get(k) ?? 0) + 1);
          }
        }
        // EDxx / ECxx count frames — of this row's speed, so they land on
        // the frames Furnace plays under the shuffle — the cut's from the
        // delayed start.
        if (cut != null) cut = ticksIn(at, delay + cut) - ticksIn(at, delay);
        if (delay) delay = ticksIn(at, delay);
        if (row.ins >= 0 && t.instruments[row.ins]) ins = row.ins;
        // The instrument's macros start over at each of its notes: its wave
        // macro sets the wave (its first step; one that moves is the note's
        // :wave macro, env), its duty macro the noise switch (its first step).
        if (waveCh && typeof row.note === "number" && t.instruments[ins]) {
          const { wave: wm, duty } = t.instruments[ins];
          if (wm?.values.length) wave = wm.values[0];
          if (pceVol) {
            if (duty?.values.some((x) => (x > 0) !== (duty.values[0] > 0))) dutyMoves++;
            noise = dutyNoise(t.instruments[ins]) ?? noise;
          }
        }
        if (opmNoiseCh && typeof row.note === "number" && t.instruments[ins]?.duty?.values.length) opmNoise = t.instruments[ins].duty.values[0];
        // The SCC plays its first wavetable until one is named (Furnace).
        if (sccCh && typeof row.note === "number" && wave < 0 && t.waves?.length) wave = 0;
        // The SSG's macros start over at each note: the mixer and the noise
        // period are their first steps.
        if (ssgCh && typeof row.note === "number" && t.instruments[ins]?.kind === "std") {
          const { wave: wm, duty, ex2, ex3, alg, ex5 } = t.instruments[ins];
          // (One that moves is the note's macro too: env. The envelope is
          // on as the mixer settles — its loop's step, else its last.)
          if (wm?.values.length) {
            psgMode = wm.values[0] & 3;
            if (wm.values[wm.loop ?? wm.values.length - 1] & 4) psgMode |= 4;
          }
          if (duty?.values.length) noiseFreq = 31 - (duty.values[0] & 31);
          if (ex2?.values.length) envShape = ex2.values[0] & 15;
          if (ex5?.values.length) { envPeriod = ex5.values[0]; autoNum = autoDen = 0; }
          if (ex3?.values.length || alg?.values.length) {
            autoNum = ex3?.values.length ? ex3.values[0] : 1;
            autoDen = alg?.values.length ? alg.values[0] : 1;
          }
        }
        // The 2A03's duty macro starts over at each note: the noise's mode
        // is its first step (Furnace: properNoiseLayout keeps bit 0, else
        // anything over 1 is 1); a pulse's runs as the note's :duty macro,
        // its first step the note's duty.
        // (The VRC6's pulse alike, its eight duties.)
        const dm = (fcCh || vrc6Ch === "pulse") && typeof row.note === "number" ? t.instruments[ins]?.duty : null;
        const dutyOf = (x) => (fcCh === "noise" ? (t.properNoiseLayout ? x & 1 : Math.min(1, x)) : vrc6Ch ? x & 7 : x & 3);
        if (dm?.values.length && fcCh !== "tri") {
          duty = dutyOf(dm.values[0]);
          if (fcCh === "noise" && dm.values.some((y) => dutyOf(y) !== duty)) dutyMoves++;
        }
        if (row.vol >= 0 || jump != null) {
          const cur = colF < 0 ? colMax : colF;
          const nv = Math.max(0, Math.min(colMax, (row.vol >= 0 ? row.vol : Math.floor(cur)) + (jump ?? 0)));
          // A volume written under a sounding note (no note on the row): 0
          // silences it (FM's carriers at TL 127, a wave or a PSG channel
          // off); another moves it there.
          if (typeof row.note !== "number" && sounding && nv !== cur) {
            // (The triangle has no level: only a 0 its volume macro reads stops it.)
            const triLevel = fcCh !== "tri" || !!t.instruments[ins]?.vol?.values.length;
            // (After an EDxx delay: Furnace runs the whole row then.)
            const when = at + Math.min(delay, rowTicks - 1);
            if (nv === 0 && triLevel) { sounding.end = Math.min(sounding.end ?? Infinity, when); sounding = null; }
            else if (fcCh !== "tri") { levelTo(sounding, when, cur); levelTo(sounding, when, nv); }
          }
          vol = colF = nv;
        }
        // A sample note (the DAC's, on pcm1): FM6's note ends there. (Its
        // row's volume stays the channel's, for the FM notes after it.)
        if (typeof row.note === "number" && chn.legacy && (row.legacy != null || isSampleIns(t.instruments[ins]))) {
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, at);
          sounding = null;
          slideRow(at);
          continue;
        }
        // The VRC6 in its PCM mode (a sample instrument's note, 17xx) plays
        // no tone: left out.
        if (vrc6Ch && typeof row.note === "number") vrc6Pcm = isSampleIns(t.instruments[ins]) || (vrc6Pcm && row.ins < 0);
        if (vrc6Ch && typeof row.note === "number" && vrc6Pcm) {
          vrc6PcmNotes++;
          if (sounding) sounding.end = Math.min(sounding.end ?? Infinity, at);
          sounding = null;
          slideRow(at);
          continue;
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
          // The SSG's mixer: tone, noise or both (the envelope's bit read
          // as the tone; nothing on, silent).
          const ssgTone = psgMode & 1 || psgMode & 4, ssgNoise = psgMode & 2;
          if (vol === 0 && !triOn || (ssgCh && !ssgTone && !ssgNoise)) { sounding = null; slideRow(at); continue; }
          const waveName = waveCh && !toNoise && wave >= 0 ? waveDef(wave) : null;
          const st = {
            voice: waveName ? [waveName, ...voiceTokens(null, true, row.note)]
              : voiceTokens(toNoise && !t.properNoiseLayout ? ((row.note % 12) + 12) % 12
                : fcCh === "noise" ? (t.properNoiseLayout ? row.note & 15 : Math.max(0, Math.min(252, row.note))) : null, false, row.note),
            pan: pan ? `:pan ${pan}` : null,
            arp: usedArp ? arpToken() : null,
            duty: noteDuty,
            mode: modeSaid ? `:mode ${ssgModeName(psgMode)}` : opmNoiseSaid ? `:mode ${opmNoise > 0 ? "noise" : "tone"}` : null,
            rate: ssgCh && ssgNoise && noiseFreq != null ? `:noise-rate ${Math.max(1, noiseFreq)}`
              : opmNoiseCh && opmNoise > 0 ? `:noise-rate ${Math.max(1, Math.min(31, 33 - opmNoise))}` : cur.rate,
            ...ssgEnvTokens(),
            tune: tuneSaid ? `:pitch ${detune}` : null,
          };
          const pre = [];
          const voiceChanged = st.voice.join(" ") !== cur.voice.join(" ");
          if (voiceChanged) pre.push(...st.voice);
          // A voice switch clears the macros: the arpeggio goes again.
          if (st.arp && (st.arp !== cur.arp || (voiceChanged && arp))) pre.push(st.arp);
          if (st.pan && st.pan !== cur.pan) pre.push(st.pan);
          if (st.duty && st.duty !== cur.duty) pre.push(st.duty);
          if (st.mode && st.mode !== cur.mode) pre.push(st.mode);
          if (st.rate && st.rate !== cur.rate) pre.push(st.rate);
          if (st.tune && st.tune !== cur.tune) pre.push(st.tune);
          for (const k of ["env", "envRate", "envSemi"]) if (st[k] && st[k] !== cur[k] && (k === "env" || st.env !== ":env none")) pre.push(st[k]);
          cur = st;
          // A noise note is its rate: c2 the slowest (chips/huc6280.js,
          // chips/rp2a03.js — the 2A03's register counts down).
          const midi = fcCh === "noise" ? FC_NOISE_BASE + 15 - fcNoiseRate(row.note, t.properNoiseLayout)
            : toNoise ? PCE_NOISE_BASE + (t.properNoiseLayout ? row.note & 31 : PCE_NOISE_TABLE[((row.note % 12) + 12) % 12])
            : rhythmCh ? 60 // a rhythm sound at its own tuning (c4)
            : row.note + C0_MIDI(chn);
          if (noiseRow && !rhythmCh && (rp.slide || rp.porta || vib)) noisePitch++;
          const v = velOf(vol);
          // The level line's target: the one the instrument's envelope
          // leaves free (env's volume macro is a :vol on fc and pce).
          const insVol = t.instruments[ins]?.kind !== "fm" && !!t.instruments[ins]?.vol?.values.length;
          sounding = { tick: start, frame0: curFrame + delay, end: cut != null ? start + Math.max(1, cut) : null, midi, vel: v, pre, state: flat(st),
            voiceChanged, col: vol < 0 ? colMax : vol, lineOn: insVol && (!!fcCh || pceSong || !!vm) && !rhythmCh ? "vel" : "vol",
            insPitch: !noiseRow && t.instruments[ins]?.kind === "std" && t.instruments[ins].pitch?.values.some(Boolean) ? ins : null,
            p: noiseRow ? null : { vib: vib && { ...vib }, porta: legatoFrom != null ? { from: legatoFrom, speed: rp.porta } : null,
              slides: rp.slide && !rp.slide.stop ? [{ ...rp.slide, off: 0 }] : [], vibLater: null } };
          if (legatoFrom != null && !noiseRow) sounding.tieIn = true;
          notes.push(sounding);
          lastMidi = midi;
        } else {
          if (cut != null && sounding) sounding.end = Math.min(sounding.end ?? Infinity, at + Math.max(1, cut));
          // Pitch effects inside a note: from where they start in it.
          if (sounding?.p) {
            const off = at - sounding.tick;
            // (And in the song's ticks as played: a groove's rows are not
            // all one length.)
            const offF = curFrame - sounding.frame0;
            const ps = sounding.p;
            if (rp.vib && !ps.vib && !ps.vibLater && vib) ps.vibLater = { ...vib, off, offF };
            if (rp.slide?.stop) { const sl = ps.slides[ps.slides.length - 1]; if (sl && sl.end == null) sl.end = off; }
            else if (rp.slide) ps.slides.push({ ...rp.slide, off, offF });
          }
        }
        slideRow(at);
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
    // The level lines, stated as the pitch macros are: `(macro :vol none)`
    // (or :vel) after one.
    const lvToks = notes.map((n) => levelToken(n));
    if (lvToks.some(Boolean)) {
      let curL = null;
      let curOn = null; // the target the line in force is on
      notes.forEach((n, i) => {
        const tok = lvToks[i];
        // The line before is cleared ahead of the voice, so the clear never
        // takes an envelope's own target (a :vol line before an fc
        // instrument whose volume macro is :vol).
        if (curL && (!tok || curOn !== n.lineOn)) n.pre.unshift(`(macro :${curOn} none)`);
        if (tok) {
          if (tok !== curL || n.voiceChanged) n.pre.push(tok);
          n.state = [...n.state, tok];
        } else n.state = [...n.state, `(macro :${n.lineOn} none)`];
        curL = tok;
        curOn = n.lineOn;
      });
    }
    tracks.push({ ch, notes, marks, noVel: fcCh === "tri" });
    if (tempoTrack) { marks.push(...speedMarks); tempoTrack = false; }
    marks.push(...shuffleMarks);
  }

  // The tempo the song starts with; the loop restates its own.
  if (tracks.length) {
    const m = tracks[0].marks;
    if (!m.some((x) => x.tempo && x.tick === 0)) m.unshift({ tick: 0, tempo: true, tokens: [tempoOf(a.framesPerRow)] });
  }
  if (a.loopIndex > 0 && tracks[0]?.marks.filter((x) => x.tempo).length > 1) {
    const lt = segStart[loopIndex];
    const inForce = tracks[0].marks.filter((x) => x.tempo && x.tick <= lt).pop();
    if (inForce && inForce.tick !== lt) tracks[0].marks.push({ tick: lt, tempo: true, tokens: inForce.tokens });
    tracks[0].marks.sort((x, y) => x.tick - y.tick);
  }

  for (const [k, n] of fxSkipped) warnings.push(`effect ${k} skipped (${n}×)`);
  if (insPitchUnder) warnings.push(`an instrument's pitch macro under a row's slide or vibrato gives way to it (${insPitchUnder}×)`);
  if (vibUnderSlide) warnings.push(`a vibrato under a slide is dropped for that note (${vibUnderSlide}×)`);
  if (!tracks.length) warnings.push("no notes to import");
  if (a.channels.some((c) => c.kind === "pcm" && c.notes > 0) && !(onFc && used.some((c) => c.kind === "pcm" && t.channels[c.index].chip === "nes")))
    warnings.push("sample channels are not imported");
  const PCM = pcmWord.toUpperCase();
  if (dpcm.missing) warnings.push(`a ${PCM} note with no sample (or one of a depth not read) is left out (${dpcm.missing}×)`);
  if (dpcm.loopPart) warnings.push(`a ${PCM} sample looping a part of itself loops whole (${dpcm.loopPart}×)`);
  if (onFc && a.channels.some((c) => c.notes > 0 && !["nes", "vrc6"].includes(t.channels[c.index].chip)))
    warnings.push("an expansion chip's channels have no fc part — left out");
  if (waveMacroSteps) warnings.push(`a wave macro naming a wavetable the module lacks is left out (${waveMacroSteps}×)`);
  if (dutyUnderNote) warnings.push(`a 12xx under a sounding note takes effect at the next note (${dutyUnderNote}×)`);
  if (dutyMoves) warnings.push(`a duty macro switching ${onFc ? "the noise's mode" : "noise and wave"} under a note keeps its first step (${dutyMoves}×)`);
  if (waveResampled) warnings.push(`${waveResampled} wavetable(s) not 32 steps wide are read at 32 points`);
  if (noiseDropped) warnings.push(`noise notes on a channel imported as its wave are dropped (${noiseDropped}×)`);
  if (waveDropped) warnings.push(`wave notes on a channel imported as noise are dropped (${waveDropped}×)`);
  if (patchMoves.size) warnings.push(`an OPLL patch macro plays the patch it settles on (${patchMoves.size}×)`);
  if (vrc6PcmNotes) warnings.push(`a VRC6 pulse's PCM notes are left out (${vrc6PcmNotes}×)`);
  if (noisePitch) warnings.push(`a slide or vibrato on a noise note is dropped: its pitch is its rate (${noisePitch}×)`);

  const header = [`; Imported from ${options.fileName ?? "a tracker module"} (${t.format}, ${t.system})`];
  const score = [!onMd && `:target ${tg}`, t.title && `:title ${qstr(t.title)}`, t.author && `:author ${qstr(t.author)}`].filter(Boolean);
  if (score.length) header.push(`(def-score ${score.join(" ")})`);
  if (standIns.size) header.push('(import "presets/waveforms/set.mmlisp")');
  // The YM2608's rhythm: the RX5 kit stands in for a ROM the user has not
  // loaded (as the VGM and mucom imports have it).
  if (tracks.some(({ ch }) => tp.partOf(ch.dest)?.name === "rhythm"))
    header.push(`(import ${qstr(RHYTHM_KIT)})  ; the rhythm's sounds without a rhythm ROM (File > Import > YM2608 Rhythm ROM…)`);
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
