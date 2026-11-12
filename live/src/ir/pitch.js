// Pitch: a note name to MIDI, MIDI to Hz, and the driver's pitch rule
// (driver.md §8) on the Mega Drive's clocks — the YM2612's block / F-number,
// the SN76489's period, the CSM timer.

// ---------------------------------------------------------------------------
// Pitch → MIDI note
// ---------------------------------------------------------------------------
const NOTE_NAMES = [
  "c",
  "cs",
  "d",
  "ds",
  "e",
  "f",
  "fs",
  "g",
  "gs",
  "a",
  "as",
  "b",
];
// Aliases for accidentals used in MMLisp ("c+", "d-" etc.)
const NOTE_ALIASES = {
  "c+": "cs",
  "d-": "cs",
  "d+": "ds",
  "e-": "ds",
  "f+": "fs",
  "g-": "fs",
  "g+": "gs",
  "a-": "gs",
  "a+": "as",
  "b-": "as",
};

export function pitchToMidi(pitchStr) {
  // Format: "c4", "e4", "f+3", "b-5", "c10" etc.
  const m = pitchStr.toLowerCase().match(/^([a-g][+\-]?)(\d+)$/);
  if (!m) return 60; // fallback C4

  let name = m[1];
  const octave = parseInt(m[2], 10);

  name = NOTE_ALIASES[name] ?? name;
  const semitone = NOTE_NAMES.indexOf(name);
  if (semitone < 0) return 60;

  // MIDI: C4 = 60, C0 = 12
  return (octave + 1) * 12 + semitone;
}

// ---------------------------------------------------------------------------
// MIDI pitch → frequency, and the two chips' period/F-number encodings
// Calibrated for the NTSC Mega Drive master clocks below.
// ---------------------------------------------------------------------------

/** The YM2612's clock (NTSC Mega Drive). */
export const YM2612_MASTER_CLOCK = 7670454;

/**
 * Timer A's period for a rate in Hz, unrounded and unclamped, and back. The
 * driver sweeps a CSM rate linearly in this period, not in Hz.
 */
export function csmTimerPeriod(hz, clock = YM2612_MASTER_CLOCK) {
  return 1024 - clock / (144 * hz);
}
export function csmTimerHz(period, clock = YM2612_MASTER_CLOCK) {
  return clock / (144 * (1024 - period));
}

/**
 * Equal temperament around A4 = 440 Hz. Fractional `midiNote` is meaningful —
 * a cent is 1/100 of a note — so every pitch path (compiler, both players,
 * the exporters) goes through this one conversion.
 */
export function midiToHz(midiNote) {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * MIDI note → SN76489 tone period. The PSG divides its clock by 32 per period
 * step; 1 is the shortest period the counter holds and 1023 the longest.
 */
export function midiToPsgPeriod(midiNote) {
  const freq = midiToHz(midiNote);
  return Math.max(1, Math.min(1023, Math.round(PSG_MASTER_CLOCK / (32 * freq))));
}

// OPN frequency formula: fnum = freq * 2^(21-block) / (MASTER_CLOCK/144).
// `rate` is that MASTER_CLOCK/144 — the target profile's `fm.fnumRate`; the
// Mega Drive's ≈ 53267 Hz (7,670,454 Hz / 144) is the default.
// Supports fractional midiNote for cent-precision pitch.
const FM_CLOCK_DIV = 53267;

// ---- the driver's pitch rule (driver.md §8) ----
// A note's register value is its semitone's entry in a 128-note table, and a
// cent offset lies linearly between it and the next semitone's, rounded half
// up — integer arithmetic, as the 68000 does it. The IR preview and
// drv-player.js both use these, so a chip's pitch has one rule.

// Whole semitones folded out of the cents; cents 0..99 on note 0..126.
function foldCents(note, cents) {
  let n = note, c = cents | 0;
  n += Math.trunc(c / 100);
  c -= Math.trunc(c / 100) * 100;
  if (c < 0) { n -= 1; c += 100; }
  return [n < 0 ? 0 : n > 126 ? 126 : n, c];
}
const FNUM_TABLES = new Map(); // rate → note → (block << 11) | fnum
function fnumTable(rate) {
  let t = FNUM_TABLES.get(rate);
  if (!t) {
    t = new Uint16Array(128);
    for (let n = 0; n < 128; n++) {
      const { fnum, block } = midiToFnumBlock(n, rate);
      t[n] = ((block & 0x07) << 11) | (fnum & 0x7ff);
    }
    FNUM_TABLES.set(rate, t);
  }
  return t;
}
/** An OPN's (block << 11) | F-number for `note` + `cents`, by the driver's rule. */
export function fnumBlockOf(note, cents, rate = FM_CLOCK_DIV) {
  const table = fnumTable(rate);
  const [n, c] = foldCents(note, cents);
  if (c === 0) return table[n];
  const e0 = table[n], e1 = table[n + 1];
  const block0 = e0 >> 11, fnum0 = e0 & 0x7ff;
  const shift = Math.max(0, (e1 >> 11) - block0); // 0 or 1 for adjacent notes
  const v1 = (e1 & 0x7ff) << shift; // e1's F-number in block0 units
  let block = block0;
  let fnum = fnum0 + Math.floor(((v1 - fnum0) * c + 50) / 100); // round half up
  while (fnum > 1023 && block < 7) { block++; fnum >>= 1; }
  return ((block & 0x07) << 11) | (fnum & 0x7ff);
}
const PSG_TABLES = new Map(); // clock → note → period
/** An SN76489's tone period for `note` + `cents`, by the driver's rule. */
export function psgPeriodOf(note, cents, clock = PSG_MASTER_CLOCK) {
  let table = PSG_TABLES.get(clock);
  if (!table) {
    table = new Uint16Array(128);
    for (let n = 0; n < 128; n++) table[n] = Math.max(1, Math.min(1023, Math.round(clock / (32 * midiToHz(n)))));
    PSG_TABLES.set(clock, table);
  }
  const [n, c] = foldCents(note, cents);
  if (c === 0) return table[n];
  // Period decreases as pitch rises: subtract a non-negative step (round half up).
  const p0 = table[n];
  const p = p0 - Math.floor(((p0 - table[n + 1]) * c + 50) / 100);
  return p < 1 ? 1 : p > 1023 ? 1023 : p;
}
// A fractional MIDI note as the rule's note and cents.
export function noteCents(midi) {
  const n = Math.floor(midi + 1e-9);
  return [n, Math.round((midi - n) * 100)];
}

export function midiToFnumBlock(midiNote, rate = FM_CLOCK_DIV) {
  const freq = midiToHz(midiNote);
  let block = 4;
  let fnum = Math.round((freq * (1 << (21 - block))) / rate);
  while (fnum > 1023 && block < 7) {
    block++;
    fnum = Math.round((freq * (1 << (21 - block))) / rate);
  }
  while (fnum < 512 && block > 0) {
    block--;
    fnum = Math.round((freq * (1 << (21 - block))) / rate);
  }
  return {
    fnum: Math.max(0, Math.min(2047, fnum)),
    block: Math.max(0, Math.min(7, block)),
  };
}

// PSG MASTER_CLOCK (NTSC Mega Drive)
export const PSG_MASTER_CLOCK = 3579545;
