/**
 * mucom88 PCM bank (`*pcm.bin`) reader.
 *
 * Layout: a directory of 32 x 32-byte entries at 0x0000, then the sample body
 * from 0x0400 (samples concatenated, 4-byte aligned, with padding between).
 *
 * mucom targets the PC-8801 / YM2608 (OPNA), whose ADPCM-B (Delta-T) unit plays
 * the body directly. The YM2612 has no ADPCM unit, so everything here decodes to
 * linear PCM: the importer emits one WAV of the whole bank and each sample def
 * slices it (`:offset` / `:frames`).
 *
 * Kept out of import-mucom.js on purpose — that file is pure MML text -> text,
 * while this is binary decode with no MML knowledge, and the decoder needs to be
 * exercisable standalone (it is the risky part to calibrate).
 */

import { encodeWav } from "./export-wav.js";
import { PCM_MIX_RATE } from "./mmb.js";

const DIR_ENTRIES = 32;
const DIR_ENTRY_SIZE = 32;
const BODY_START = 0x400;

/** mucom resamples every source wav to 16 kHz when it converts to ADPCM. */
export const MUCOM_ADPCM_RATE = 16000;

/**
 * What the bank is resampled to. The driver's soft-mix writes the DAC
 * PCM_MIX_RATE times per 60 Hz frame, so ~10.5 kHz is all it can ever emit —
 * keeping mucom's native 16 kHz would store ~1.5x the bytes only to have the
 * driver throw them away again (and resample twice). Other MD drivers store at
 * their playback rate for the same reason (XGM 14 kHz, MDSDRV ~17.5 kHz).
 * Derived, not hardcoded: this follows PCM_MIX_RATE if the budget moves.
 */
export const MUCOM_PCM_RATE = PCM_MIX_RATE * 60;

/**
 * Resample mono float by nearest-neighbour — the same thing the driver's mix
 * does, so doing it here just moves the loss earlier and buys the size back.
 */
function resampleMono(src, fromRate, toRate) {
  if (fromRate === toRate || src.length === 0) return src;
  const out = new Float32Array(Math.max(1, Math.round((src.length * toRate) / fromRate)));
  const step = fromRate / toRate;
  for (let i = 0; i < out.length; i++) {
    out[i] = src[Math.min(src.length - 1, Math.round(i * step))];
  }
  return out;
}

/** YM2608 ADPCM-B step-size table, indexed by the nibble magnitude (0-7). */
const STEP_TABLE = [57, 57, 57, 57, 77, 102, 128, 153];
const STEP_MIN = 127;
const STEP_MAX = 24576;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Read the 32-entry directory. An entry is present iff its first name byte is
 * non-zero. `adrl`/`adrh` (0x10/0x12) are legacy fields the Windows loader
 * ignores — real banks disagree with them — so they are not read.
 *
 * @param {Uint8Array} bytes whole `*pcm.bin`
 * @returns {{ entries: Array<{index:number,name:string,defaultVol:number,start:number,length:number}> }}
 *   `start` is an absolute byte offset into `bytes`; `length` is in bytes.
 */
export function parseMucomPcmBank(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  for (let i = 0; i < DIR_ENTRIES; i++) {
    const o = i * DIR_ENTRY_SIZE;
    if (o + DIR_ENTRY_SIZE > bytes.length) break;
    if (bytes[o] === 0) continue; // empty slot

    let name = "";
    for (let k = 0; k < 16; k++) name += String.fromCharCode(bytes[o + k]);
    name = name.replace(/[\0\x20]+$/, ""); // padded with NUL or spaces

    const defaultVol = dv.getUint16(o + 0x1a, true); // pcmopt
    const start = BODY_START + dv.getUint16(o + 0x1c, true) * 4; // pcmstart: 4-byte units
    // whl is in BYTES. Edited banks exist whose runs overlap the next entry or
    // run past EOF; mucom's loader reads start+whl regardless, so only the file
    // end is enforced (clamp rather than drop — the song still references it).
    const length = Math.min(dv.getUint16(o + 0x1e, true), bytes.length - start);
    if (start >= bytes.length || length <= 0) continue;

    entries.push({ index: i + 1, name, defaultVol, start, length }); // @n is 1-based
  }
  return { entries };
}

/**
 * Decode one YM2608 ADPCM-B run to mono float. 4-bit, HIGH nibble first, two
 * frames per byte. State (accumulator + step) starts fresh for every sample —
 * a bank must NOT be decoded as one linear pass.
 *
 * @param {Uint8Array} bytes
 * @param {number} start absolute byte offset
 * @param {number} length bytes to consume
 * @returns {Float32Array} length * 2 frames, normalized to [-1, 1)
 */
export function decodeAdpcmB(bytes, start, length) {
  const out = new Float32Array(length * 2);
  let acc = 0;
  let step = STEP_MIN;
  let o = 0;

  for (let i = 0; i < length; i++) {
    const byte = bytes[start + i];
    for (let half = 0; half < 2; half++) {
      const nibble = half === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
      const mag = nibble & 7;
      const delta = (step * (mag * 2 + 1)) >> 3;
      acc = clamp(nibble & 8 ? acc - delta : acc + delta, -32768, 32767);
      step = clamp(Math.floor((step * STEP_TABLE[mag]) / 64), STEP_MIN, STEP_MAX);
      out[o++] = acc / 32768;
    }
  }
  return out;
}

/**
 * Decode a whole bank into one contiguous mono buffer.
 *
 * Each entry is decoded independently and the *outputs* are concatenated, so an
 * entry's `offset` is a running frame count — it is not derived from the body
 * layout (the body has alignment padding between samples, and the codec state
 * resets per sample).
 *
 * @param {Uint8Array} bytes whole `*pcm.bin`
 * @returns {{ pcm: Float32Array, sampleRate: number,
 *   entries: Array<{index:number,name:string,defaultVol:number,offset:number,frames:number}> }}
 */
export function decodeMucomPcmBank(bytes) {
  const { entries } = parseMucomPcmBank(bytes);
  // Decode at the source rate, then drop to the driver's DAC grid. Each entry is
  // resampled on its own so `offset` stays an exact frame count in the output.
  const decoded = entries.map((e) =>
    resampleMono(decodeAdpcmB(bytes, e.start, e.length), MUCOM_ADPCM_RATE, MUCOM_PCM_RATE),
  );

  const total = decoded.reduce((n, d) => n + d.length, 0);
  const pcm = new Float32Array(total);
  const out = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    pcm.set(decoded[i], offset);
    out.push({
      index: entries[i].index,
      name: entries[i].name,
      defaultVol: entries[i].defaultVol,
      offset,
      frames: decoded[i].length,
    });
    offset += decoded[i].length;
  }
  return { pcm, sampleRate: MUCOM_PCM_RATE, entries: out };
}

/**
 * Decode a bank and encode it as one 16-bit mono WAV — the file the emitted
 * sample defs slice with `:offset` / `:frames`.
 *
 * @param {Uint8Array} bytes whole `*pcm.bin`
 * @returns {{ bytes: Uint8Array, sampleRate: number, entries: Array<object> }}
 */
export function mucomPcmBankToWav(bytes) {
  const { pcm, sampleRate, entries } = decodeMucomPcmBank(bytes);
  return { bytes: encodeWav(pcm, null, sampleRate), sampleRate, entries };
}
