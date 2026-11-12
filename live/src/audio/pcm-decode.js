// The sample chips' codecs read to float: the YM2610's ADPCM-A, the
// OKIM6258 / OKIM6295's ADPCM, the K053260's and the C140's, the 2A03's DMC;
// and a DC block for a decoded sample that drifts.

// ADPCM-A: 4-bit, a 12-bit accumulator that wraps, high nibble first; the
// state starts over at each sample (MAME ymadpcm's table).
const ADPCMA_STEPS = [16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552];
const ADPCMA_INC = [-1, -1, -1, -1, 2, 5, 7, 9];
export function decodeAdpcmA(rom, start, length) {
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

// OKI ADPCM: 4-bit, a 12-bit signal that saturates; a play command starts the
// state over. The OKIM6258's low nibble first (MAME okim6258), the OKIM6295's
// high nibble first from 0 (`high`, MAME okiadpcm).
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
export function decodeOki(rom, start, length, { high = false } = {}) {
  const out = new Float32Array(length * 2);
  let signal = high ? 0 : -2, step = 0, o = 0;
  for (let i = 0; i < length; i++) {
    const byte = rom[start + i];
    for (const nib of high ? [byte >> 4, byte & 15] : [byte & 15, byte >> 4]) {
      signal = Math.max(-2048, Math.min(2047, signal + OKI_DIFF[step * 16 + nib]));
      step = Math.max(0, Math.min(48, step + OKI_INC[nib & 7]));
      out[o++] = signal / 2048;
    }
  }
  return out;
}

// The K053260's samples: signed 8-bit, or KADPCM, 4-bit steps on an 8-bit value
// that wraps, low nibble first (MAME k053260).
const KADPCM = [0, 1, 2, 4, 8, 16, 32, 64, -128, -64, -32, -16, -8, -4, -2, -1];
export function decodeK053260(rom, start, length, kadpcm) {
  const out = new Float32Array(kadpcm ? length * 2 : length);
  if (!kadpcm) {
    for (let i = 0; i < length; i++) out[i] = ((rom[start + i] << 24) >> 24) / 128;
    return out;
  }
  let value = 0, o = 0;
  for (let i = 0; i < length; i++)
    for (const nib of [rom[start + i] & 15, rom[start + i] >> 4]) {
      value = ((value + KADPCM[nib]) << 24) >> 24;
      out[o++] = value / 128;
    }
  return out;
}

// The C140's samples: signed 8-bit, or its own 8-bit log: bits 0-2 the
// exponent, the rest sign and mantissa (MAME c140's table).
export function decodeC140(rom, start, length, mulaw) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const b = rom[start + i];
    if (!mulaw) { out[i] = ((b << 24) >> 24) / 128; continue; }
    const exp = b & 7, mant = Math.abs((b << 24) >> 27) & 0x1f;
    const v = ((0x80 << exp) & 0xff00) + (mant << (exp ? exp + 3 : 4));
    out[i] = (b & 0x80 ? -v : v) / 32768;
  }
  return out;
}

// The X68000's ADPCM without its DC: a 20 Hz high-pass, as an output's
// coupling would take it out (the cutoff is ours, not the machine's
// measured one). A song's driver keeps the chip playing from sample to
// sample, so its signal runs on and drifts (an encoder's bias, to the
// 12-bit rail); a sample decoded from the state a play starts in carries
// that drift as DC, a step where the next sample cuts in.
export function dcBlock(x, rate) {
  const r = Math.exp((-2 * Math.PI * 20) / rate);
  const out = new Float32Array(x.length);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) { py = x[i] - px + r * py; px = x[i]; out[i] = py; }
  return out;
}

// The DMC's 1-bit delta: each bit moves the 7-bit DAC two up or down (up
// below 126, down above 1) from where $4011 left it.
export function decodeDpcm(rom, start, length, dac) {
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
