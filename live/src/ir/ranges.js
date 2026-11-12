// The IR's value ranges and waves: what a word may hold (clamped, never
// rounded), a wave's steps as a chip takes them, a note snapped to a mask,
// a value as a slot holds it. The compiler, the player and the driver's
// export read the same table.

import { FM_CHANNEL_WORDS, FM_OP_WORDS } from "../machine/chips/fm-words.js";

// ---------------------------------------------------------------------------
// Macro target range table
// ---------------------------------------------------------------------------
// Valid value range per target. Used by the compiler (parseMacroSpec) and the
// player (macro write path) only to CLAMP — never to round.
//
// Quantization policy: macro/param values stay float through the whole
// pipeline; each parameter is quantized to its integer hardware register ONCE,
// at the write (e.g. _applyParam's set() / _snapMacroOutput / midiToFnumBlock /
// _carrierTl / _composePsgAtt / _psgSetPitch). So there is no per-target
// rounding flag here — every register is integer, and rounding lives at the
// single output point.
//
// Targets with a numeric suffix (FM_TL1–FM_TL4 etc.) fall back to the
// suffix-stripped key via clampForTarget().
export const MACRO_TARGET_RANGE = {
  // KEY-ON scoped
  NOTE_PITCH: { min: -32768, max: 32767 }, // cents
  NOTE_SEMI: { min: -48, max: 48 }, // semitone offsets (×100 cents at playback)
  SNAP: { min: 0, max: 0xfff }, // pitch-class mask, bit 0 = C; 0 = off
  KEYON: { min: 0, max: 1 }, // gate; thresholded at >= 0.5 at playback
  VEL: { min: 0, max: 15 },

  // Channel-level
  VOL: { min: 0, max: 31 },
  MASTER: { min: 0, max: 31 },

  // LFO: the OPN's rate; the OPM's frequency, depths and waveform
  LFO_RATE: { min: 0, max: 8 },
  LFO_FREQ: { min: 0, max: 255 },
  LFO_SYNC: { min: 0, max: 1 },
  LFO_PMD: { min: 0, max: 127 },
  LFO_AMD: { min: 0, max: 127 },
  LFO_WAVE: { min: 0, max: 3 },
  // fm8's :mode on the OPM: 0 tone, 1 noise (chips/ym2151.js)
  FM_NOISE: { min: 0, max: 1 },

  // The FM family's, channel and operator (chips/fm-words.js) — an operator
  // word's range is its base's: clampForTarget() strips the trailing digit.
  ...Object.fromEntries([...FM_CHANNEL_WORDS, ...FM_OP_WORDS].map((w) => [w.word, { min: w.min, max: w.max }])),

  // FM panning — bits 7-6 of B4
  PAN: { min: -1, max: 1 },

  // PSG noise mode (0-7 via `:mode` keyword on noise channel)
  NOISE_MODE: { min: 0, max: 7 },
  // The SSG (pc88, msx): the song's noise period, and a channel's mixer
  // (0 tone, 1 noise, 2 both, 3 neither: the envelope alone).
  NOISE_RATE: { min: 1, max: 31 },
  SSG_MIX: { min: 0, max: 3 },
  // A pulse's duty in sixteenths (the 2A03's: its encoder takes the nearest
  // of 2 / 4 / 8 / 12).
  DUTY: { min: 0, max: 16 },
  // Its hardware envelope: a channel's shape (R13; -1 none, the 4-bit level),
  // and the song's rate in Hz (0: the writing track's notes).
  SSG_ENV: { min: -1, max: 15 },
  ENV_RATE: { min: 0, max: 8000 },
  // A channel's moves on the period its notes or rates give: semitones,
  // and register steps added to it (+ lower).
  ENV_SEMI: { min: -48, max: 48 },
  ENV_DETUNE: { min: -1000, max: 1000 },

  // PCM points (:pcm-* the range, :loop-* the loop), in SECONDS — the IR's unit (the MMB exporter
  // turns them into the engine's byte offsets). The ceiling is what one 32 KB
  // bank can hold at the slowest image, 4.89 s at pcm3; rounded up.
  RANGE_START: { min: 0, max: 8 },
  RANGE_END: { min: 0, max: 8 },
  RANGE_LEN: { min: 0, max: 8 },
  LOOP_START: { min: 0, max: 8 },
  LOOP_END: { min: 0, max: 8 },
  LOOP_LEN: { min: 0, max: 8 },

  // A MIDI channel's (chips/midi.js): a controller CC0–CC127 (the suffix
  // stripped), its pressure, its program (PROG), its bank (14 bits: MSB and LSB) and
  // its bend's range in semitones.
  CC: { min: 0, max: 127 },
  PRESSURE: { min: 0, max: 127 },
  PROG: { min: 0, max: 127 },
  BANK: { min: 0, max: 16383 },
  BEND_RANGE: { min: 1, max: 24 },

  // Value slots (def-val) as write targets, VAL0–VAL15: an i16, like the slot.
  VAL: { min: -32768, max: 32767 },
};

// A def-wave's form (language.md §19, ir.md §2.3): its steps — 32, or 64
// (the FDS's memory; `lens`), a curve sampled at 32 — and their signed
// range, which a chip of fewer bits reads down.
export const WAVE = { len: 32, lens: [32, 64], min: -128, max: 127, bits: 8 };

// A wave expression (language.md §19), as the compiler folds it and the IR
// player runs what is left (ir.md, a WAVE's `expr`): a tree of { n } (a
// number), { data } (a wave's steps), { val } (a value slot's name) and
// { op: "+" | "-" | "*" | "/", args }, its ops taken step by step across a
// wave and a number alike. Its value, at the slots `valOf` reads: a number,
// or a wave's steps (unrounded).
export function waveEval(t, valOf) {
  if (t.n != null) return t.n;
  if (t.data) return t.data;
  if (t.val != null) return valOf(t.val);
  return waveCombine(t.op, t.args.map((a) => waveEval(a, valOf)));
}

/** The value slots a wave expression's tree reads. */
export function waveSlots(t, out = new Set()) {
  if (t.val != null) out.add(t.val);
  for (const a of t.args ?? []) waveSlots(a, out);
  return out;
}

/**
 * `op` over numbers and waves' steps, step by step: a wave if any is one, as
 * long as the longest — a shorter wave's steps each held (32 against 64,
 * each step twice), never interpolated.
 */
export function waveCombine(op, xs) {
  const len = Math.max(WAVE.len, ...xs.filter(Array.isArray).map((x) => x.length));
  const at = (x, i) => (Array.isArray(x) ? x[Math.floor((i * x.length) / len)] : x);
  const step = (i) => {
    let acc = at(xs[0], i);
    if (xs.length === 1) return op === "-" ? -acc : op === "/" ? 1 / acc : acc;
    for (let k = 1; k < xs.length; k++) {
      const v = at(xs[k], i);
      acc = op === "+" ? acc + v : op === "-" ? acc - v : op === "*" ? acc * v : acc / v;
    }
    return acc;
  };
  return xs.some(Array.isArray) ? Array.from({ length: len }, (_, i) => step(i)) : step(0);
}

/** A wave's steps as a chip takes them: whole, in range (a step that is not a number, 0). */
export function waveSteps(data) {
  return data.map((v) => (Number.isFinite(v) ? Math.max(WAVE.min, Math.min(WAVE.max, Math.round(v))) : v > 0 ? WAVE.max : v < 0 ? WAVE.min : 0));
}

/**
 * Clamp a macro output value to the hardware range for the given target.
 * Clamp only — never rounds (values stay float; the register write quantizes).
 * For targets with a numeric suffix (e.g. "FM_TL1"), strips the suffix and
 * looks up the base key (e.g. "FM_TL"). Returns v unchanged if no range entry.
 *
 * @param {string} target  - canonical target name (e.g. "FM_TL1", "VEL", "PAN")
 * @param {number} v       - raw value from macro interpolation
 * @returns {number}
 */
export function clampForTarget(target, v) {
  const range =
    MACRO_TARGET_RANGE[target] ??
    MACRO_TARGET_RANGE[target.replace(/\d+$/, "")];
  if (!range) return v;
  return Math.max(range.min, Math.min(range.max, v));
}

/**
 * `:snap` (language.md §5.3): the integer semitone a channel is about to
 * write, moved DOWN to the nearest pitch class whose bit is set in `mask`
 * (bit 0 = C). Mask 0 means off. Runs before the cent offset is added, so a
 * vibrato or glide rides the snapped note. Mirrors snap_note in mmlispseq.c.
 */
export function snapNote(note, mask) {
  const m = mask & 0xfff;
  if (!m) return note;
  for (let n = note, i = 0; i < 12; n--, i++) {
    if (m & (1 << (((n % 12) + 12) % 12))) return n;
  }
  return note;
}

/**
 * Coerce a host-written dynamic value (`def-val` slot) to what a driver slot
 * holds: a rounded i16. `def-val`'s `:from`/`:to` bound the live slider, not
 * the slot — a value is bounded where it is *used*, per target, by the clamps
 * both the preview and MMLispDRV apply. Returns `null` for a non-finite input,
 * which both players treat as "ignore this write".
 *
 * @param {number|string} value
 * @returns {number|null}
 */
export function toSlotValue(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}
