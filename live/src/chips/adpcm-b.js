// The YM2608's ADPCM-B: one sample voice from its own RAM, pitched in real
// time by Delta-N, repeating its whole range when it loops.
import { words } from "./parts.js";
import { applySampleEffects } from "../sample-fx.js";
import { encodeAdpcmB } from "../mucom-pcm.js";

export const adpcmB = {
  name: "adpcm-b",
  label: "ADPCM-B",
  kind: "sample",
  words: words(/^(?:RANGE|LOOP)_/, "PAN"),
  pointSweeps: false, // the range is its address registers, read at key-on
  checkNote({ sample, sampleName, head, mode, target, once }) {
    if (!sample.file)
      once(`file:${sampleName}`, `${sampleName} is the ROM rhythm sound ${sample.rhythm} here, with no :file; ${head} is the ADPCM-B, which plays a sample's :file — play it on ${target.headsOf("rhythm").join(" or ")}, or give it a :file`);
    else if (mode === "loop" && (sample.loopStartSec ?? 0) > (sample.startSec ?? 0))
      once(`loop:${sampleName}`, `the ADPCM-B repeats a sample's whole range; ${sampleName}'s loop starts after its range does — make the range the loop (:pcm-start at the loop's start)`);
  },
};

// --- the bake --------------------------------------------------------------
//
// The ADPCM-B plays a sample from its own RAM at any rate (Delta-N), so a
// sample is baked once, not per note as the Mega Drive's: its def's range and
// `:fx`, at a rate of at most BAKE_MAX_RATE, encoded (mucom-pcm.js) and laid
// out on the RAM's 4-byte address unit — the unit the chip reads with 1-bit
// DRAM ($01 bits 1-0 = 0), as mucom88 sets it (fmgen opna.cpp; MAME
// ymdeltat's portshift 5 less 3).

export const ADPCM_RAM_BYTES = 256 * 1024;
const UNIT = 4;
// An octave above C4 still reaches the chip's top rate (Delta-N 65535, 55.5
// kHz at 7.9872 MHz / 144), and 256 KB holds about 23 s.
const BAKE_MAX_RATE = 22050;

// A box-filtered resample to `to` Hz (to < from), enough for a downsample.
export function resample(data, from, to) {
  if (to >= from) return data;
  const ratio = from / to, n = Math.floor(data.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * ratio, b = Math.min(data.length, a + ratio);
    let sum = 0, w = 0;
    for (let k = Math.floor(a); k < b; k++) { const c = Math.min(k + 1, b) - Math.max(k, a); sum += data[k] * c; w += c; }
    out[i] = w ? sum / w : 0;
  }
  return out;
}

/**
 * The RAM image a score's ADPCM-B plays: the samples its ADPCM-B tracks name,
 * from their decoded blobs ({ name: { data, baseRate } }, as the Mega Drive's
 * bake takes them). Returns { image, entries: { name: { start, stop, rate } },
 * warnings }: start and stop are the address registers' values (stop the last
 * unit played), rate the Hz the sample plays C4 at.
 */
export function bakeAdpcmB(ir, blobs, target) {
  const heads = new Set(target.headsOf("adpcm-b"));
  const played = new Set();
  for (const t of ir.tracks ?? [])
    if (heads.has(t.scoreChannel ?? t.channel))
      for (const e of t.events ?? []) if (e.cmd === "PCM_NOTE_ON" && e.args?.sample) played.add(e.args.sample);
  const warnings = [];
  const parts = [];
  const entries = {};
  let at = 0;
  for (const s of ir.metadata?.samples ?? []) {
    if (!played.has(s.name)) continue;
    const blob = blobs?.[s.name];
    if (!blob?.data?.length) { warnings.push(`ADPCM-B: no audio for sample "${s.name}"; its notes are silent`); continue; }
    const srcRate = blob.baseRate ?? s.rate ?? 16000;
    let data = applySampleEffects(blob.data, srcRate, s.fx, (code, msg) => warnings.push(`sample "${s.name}": ${msg}`));
    // The def's range, in seconds of the sample (language.md §16).
    const a = Math.max(0, Math.round((s.startSec ?? 0) * srcRate));
    const b = s.endSec != null ? Math.min(data.length, Math.round(s.endSec * srcRate)) : data.length;
    data = data.subarray(a, Math.max(a, b));
    const rate = Math.min(srcRate, BAKE_MAX_RATE);
    const bytes = encodeAdpcmB(resample(data, srcRate, rate));
    const units = Math.max(1, Math.ceil(bytes.length / UNIT));
    if (at + units * UNIT > ADPCM_RAM_BYTES) {
      warnings.push(`ADPCM-B: sample "${s.name}" does not fit the ${ADPCM_RAM_BYTES / 1024} KB RAM; its notes are silent`);
      continue;
    }
    parts.push([at, bytes]);
    entries[s.name] = { start: at / UNIT, stop: at / UNIT + units - 1, rate };
    at += units * UNIT;
  }
  const image = new Uint8Array(at).fill(0x80); // a pad nibble pair that barely moves
  for (const [o, bytes] of parts) image.set(bytes, o);
  return { image, entries, warnings };
}
