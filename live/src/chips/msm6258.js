// The X68000's PCM: PCM8's eight voices mixed in software into the one
// MSM6258 (OKI ADPCM) stream the chip plays at 15.6 kHz. PCM8 is a driver's
// mix, not a chip, so the toolchain does its job: the mix runs here — in the
// worklet for Play, over the captured events for the VGM and the WAV — and
// each one encodes it to the chip's 4-bit ADPCM and plays that back, so all
// three are the same stream.
import { words } from "./parts.js";
import { applySampleEffects } from "../sample-fx.js";

// The VGM's DAC stream control sends bytes at a whole number of Hz, and a
// byte is two of the chip's samples: the clock is the X68000's 8 MHz brought
// to 7812 bytes a second at its ÷512 (15,624 Hz, 0.1 cent under 15,625).
export const MSM6258_CLOCK = 7812 * 1024;
export const PCM8_RATE = MSM6258_CLOCK / 512; // the mix, one chip sample each
export const PCM8_VOICES = 8;

export const pcm8 = {
  name: "pcm8",
  label: "X68000 PCM8",
  kind: "sample",
  // One ADPCM stream, one pan: a voice has none.
  words: words(/^(?:RANGE|LOOP)_/),
  pointSweeps: false, // a note's points are read at its key-on
  pitch: true, // the mix steps a voice at its pitch, frame by frame
};

export const msm6258 = {
  chip: "msm6258",
  clock: MSM6258_CLOCK,
  parts: [pcm8],
  encoder: true,
  emulator: true, // the mix and the codec below, in JS
  // VGM 1.61: the clock, and the flags — ÷512 (2), 4-bit ADPCM, 10-bit out.
  vgm: { version: 0x161, clock: 0x90, header: [[0x94, 1, 0x02]] },
};

// --- OKI ADPCM -------------------------------------------------------------
//
// 4 bits a sample over a 12-bit signal that saturates, low nibble first; the
// step moves by the nibble's magnitude. A play command starts both over
// (MAME okim6258), which is how a loop restarts the decoder where the
// encoder started its body.

export const OKI_DIFF = (() => {
  const t = new Int16Array(49 * 16);
  for (let step = 0; step < 49; step++) {
    const v = Math.floor(16 * Math.pow(11 / 10, step));
    for (let nib = 0; nib < 16; nib++)
      t[step * 16 + nib] = (nib & 8 ? -1 : 1) * ((nib & 4 ? v : 0) + (nib & 2 ? v >> 1 : 0) + (nib & 1 ? v >> 2 : 0) + (v >> 3));
  }
  return t;
})();
export const OKI_INC = [-1, -1, -1, -1, 2, 4, 6, 8];
const OKI_START = { signal: -2, step: 0 };

/** The chip's decoder: a nibble → the 12-bit signal, -2048..2047. */
export class OkiDecoder {
  constructor() { this.reset(); }
  reset() { this.signal = OKI_START.signal; this.step = OKI_START.step; }
  next(nib) {
    this.signal = Math.max(-2048, Math.min(2047, this.signal + OKI_DIFF[this.step * 16 + nib]));
    this.step = Math.max(0, Math.min(48, this.step + OKI_INC[nib & 7]));
    return this.signal;
  }
}

/** The encoder: the nibble whose decode lands nearest the target (-2048..2047). */
export class OkiEncoder {
  constructor() { this.dec = new OkiDecoder(); }
  reset() { this.dec.reset(); }
  next(target) {
    const { signal, step } = this.dec;
    const want = Math.max(-2048, Math.min(2047, Math.round(target)));
    let best = 0, err = Infinity;
    for (let nib = 0; nib < 16; nib++) {
      const e = Math.abs(Math.max(-2048, Math.min(2047, signal + OKI_DIFF[step * 16 + nib])) - want);
      if (e < err) { err = e; best = nib; }
    }
    this.dec.next(best);
    return best;
  }
}

// The X68000 hears the chip through its 10-bit DAC: the signal's top 10 bits.
export const okiOut = (signal) => (signal & ~3) / 2048;

// --- the bake --------------------------------------------------------------

/**
 * The samples a score's PCM8 tracks play: each def's `:fx` and range, at its
 * own rate (the mix resamples). `blobs` are the decoded files ({ name: { data,
 * baseRate } }, as the other bakes take them); `names`, the samples to bake
 * where not the ones the score plays (an audition's). Returns { entries:
 * { name: { data, rate, loopStart, loopEnd } }, warnings } — rate the Hz it
 * plays C4 at, the loop in frames of `data`.
 */
export function bakePcm8(ir, blobs, names = null) {
  const played = new Set(names ?? []);
  if (!names)
    for (const t of ir.tracks ?? [])
      for (const e of t.events ?? []) if (e.cmd === "PCM_NOTE_ON" && e.args?.sample) played.add(e.args.sample);
  const warnings = [];
  const entries = {};
  for (const s of ir.metadata?.samples ?? []) {
    if (!played.has(s.name)) continue;
    const blob = blobs?.[s.name];
    if (!blob?.data?.length) { warnings.push(`PCM8: no audio for sample "${s.name}"; its notes are silent`); continue; }
    const rate = blob.baseRate ?? s.rate ?? 16000;
    const fxd = applySampleEffects(blob.data, rate, s.fx, (code, msg) => warnings.push(`sample "${s.name}": ${msg}`));
    const a = Math.max(0, Math.round((s.startSec ?? 0) * rate));
    const b = s.endSec != null ? Math.min(fxd.length, Math.round(s.endSec * rate)) : fxd.length;
    const data = fxd.subarray(a, Math.max(a, b));
    const at = (sec, dflt) => (sec == null ? dflt : Math.max(0, Math.min(data.length, Math.round(sec * rate) - a)));
    entries[s.name] = { data, rate, loopStart: at(s.loopStartSec, 0), loopEnd: at(s.loopEndSec, data.length) };
  }
  return { entries, warnings };
}

// --- the mix ---------------------------------------------------------------
//
// The IR player sends a voice's life as events (`type: "pcm8"`): `on` (the
// sample, its pitch's step, its range and loop, its mode), `gain` and `step`
// where they move a frame at a time, `off` (a loop's gate: it plays out),
// `cut` (silent now). A voice is read linearly between its frames; the sum
// saturates at the chip's 12 bits.

export class Pcm8Mixer {
  constructor(bank) {
    this.bank = bank;
    this.voices = Array.from({ length: PCM8_VOICES }, () => null);
  }

  apply(e) {
    const v = e.voice;
    if (v == null || v < 0 || v >= PCM8_VOICES) return;
    if (e.kind === "on") {
      const s = this.bank?.entries?.[e.sample];
      if (!s) { this.voices[v] = null; return; }
      const start = Math.max(0, Math.min(s.data.length, e.start ?? 0));
      const end = Math.max(start, Math.min(s.data.length, e.end ?? s.data.length));
      this.voices[v] = {
        data: s.data, pos: start, end, gain: e.gain ?? 0, step: e.step ?? 1,
        loop: e.mode === "loop", loopStart: Math.max(start, Math.min(end, e.loopStart ?? s.loopStart)),
        loopEnd: Math.max(start, Math.min(end, e.loopEnd ?? Math.min(end, s.loopEnd))),
      };
    } else if (e.kind === "gain") {
      if (this.voices[v]) this.voices[v].gain = e.value;
    } else if (e.kind === "step") {
      if (this.voices[v]) this.voices[v].step = e.value;
    } else if (e.kind === "off") {
      if (this.voices[v]) this.voices[v].loop = false; // the rest of the range plays out
    } else if (e.kind === "cut") {
      this.voices[v] = null;
    }
  }

  /** One sample of the mix, -2048..2047 (what the encoder takes). */
  next() {
    let sum = 0;
    for (let k = 0; k < PCM8_VOICES; k++) {
      const v = this.voices[k];
      if (!v) continue;
      if (v.loop && v.loopEnd > v.loopStart && v.pos >= v.loopEnd) v.pos = v.loopStart + ((v.pos - v.loopStart) % (v.loopEnd - v.loopStart));
      if (v.pos >= v.end - 1) { this.voices[k] = null; continue; }
      const i = Math.floor(v.pos), f = v.pos - i;
      sum += (v.data[i] * (1 - f) + v.data[i + 1] * f) * v.gain;
      v.pos += v.step;
    }
    return Math.max(-2048, Math.min(2047, Math.round(sum * 2048)));
  }

  get sounding() { return this.voices.some(Boolean); }
}

/**
 * The stream the chip plays for a captured run's PCM8 events ({ sec, … } in
 * time order): the mix, encoded, from `startSec`. With a loop, the body from
 * the loop point is encoded from the encoder's start, as the chip's decoder
 * starts over there (the VGM restarts it). A one-shot runs on past `endSec`
 * while an event is still to come or a voice still sounds (to TAIL_MAX_SEC). Returns { bytes (two nibbles
 * each, low first), startSec, rateHz, loopByte } or null when nothing plays.
 */
const TAIL_MAX_SEC = 30;

export function renderPcm8(events, bank, { endSec, loopStartSec = null }) {
  if (!events?.length || !bank) return null;
  // A looping stream starts by the loop point at the latest: the VGM plays
  // the body again from the byte the loop point is.
  const startSec = loopStartSec == null ? events[0].sec : Math.min(events[0].sec, loopStartSec);
  const total = Math.max(0, Math.ceil((endSec - startSec) * PCM8_RATE));
  const loopAt = loopStartSec == null ? null : Math.round((loopStartSec - startSec) * PCM8_RATE) & ~1;
  const cap = loopAt == null ? total + TAIL_MAX_SEC * PCM8_RATE : total;
  const mix = new Pcm8Mixer(bank);
  const enc = new OkiEncoder();
  const nibs = [];
  let e = 0;
  for (let i = 0; i < cap && (i < total || e < events.length || mix.sounding || i & 1); i++) {
    const t = startSec + i / PCM8_RATE;
    while (e < events.length && events[e].sec <= t + 1e-9) mix.apply(events[e++]);
    if (i === loopAt) enc.reset();
    nibs.push(enc.next(mix.next()));
  }
  if (nibs.length & 1) nibs.push(enc.next(0));
  const bytes = new Uint8Array(nibs.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = nibs[2 * i] | (nibs[2 * i + 1] << 4);
  return { bytes, startSec, rateHz: PCM8_RATE, loopByte: loopAt == null ? null : loopAt >> 1 };
}

/** A stream's bytes as the X68000 hears them, one float a chip sample. */
export function decodePcm8(bytes, loopByte = null) {
  const dec = new OkiDecoder();
  const out = new Float32Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    if (i === loopByte) dec.reset();
    out[2 * i] = okiOut(dec.next(bytes[i] & 15));
    out[2 * i + 1] = okiOut(dec.next(bytes[i] >> 4));
  }
  return out;
}
