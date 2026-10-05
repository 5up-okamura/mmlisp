// WAV loading for the node toolchain: the file decoded to mono float (-1..1)
// at its own rate, the form the bank builder takes (export-mmb.js): it runs
// the def's `:fx` chain, bakes each note and quantizes to 8-bit once. The
// decoder is the browser's too (live/src/wav-decode.js), so both build the
// same bank.
import { readFileSync } from "node:fs";
import { decodeWav } from "../../live/src/wav-decode.js";

// Returns { data: Float32Array (mono, -1..1), sampleRate }.
export function loadWav(path) {
  try {
    return decodeWav(readFileSync(path));
  } catch (e) {
    throw new Error(`${path}: ${e.message}`);
  }
}

// One decode per file, shared by every def that slices it: an imported
// instrument bank is one WAV that a dozen defs cut up, and re-reading it per
// def is both slow and pointless.
const wavCache = new Map();
function loadWavCached(path) {
  let wav = wavCache.get(path);
  if (!wav) {
    wav = loadWav(path);
    wavCache.set(path, wav);
  }
  return wav;
}

// Build the encodeMmb `opts.samples` map from an IR's metadata.samples list.
// `diagnostics`, when given, collects {severity, message} the caller prints.
export function loadSamplesForIr(ir, diagnostics = null) {
  const warn = (message) => {
    if (diagnostics) diagnostics.push({ severity: "warning", message });
    else console.warn(`wav: ${message}`);
  };
  const samples = {};
  for (const s of ir.metadata?.samples ?? []) {
    const { data, sampleRate } = loadWavCached(s.resolvedFile);
    // A def may slice one file into many samples (`:offset` / `:frames`, in
    // frames — mirrors sliceDecodedSample in the browser host). Without this a
    // banked import embeds the whole bank once per def and every sample plays
    // from the bank's start. The loop points are the exporter's, off the IR.
    const total = data.length;
    const offset = Number.isFinite(s.offset) ? Math.max(0, s.offset) : 0;
    const want = Number.isFinite(s.frames) ? Math.max(0, s.frames) : total - offset;
    if (offset >= total || want === 0) {
      warn(
        `sample "${s.name}": :offset ${offset} is past the end of ` +
          `${s.file} (${total} frames) — empty, skipped`,
      );
      continue;
    }
    const end = Math.min(total, offset + want);
    if (offset + want > total) {
      warn(
        `sample "${s.name}": :offset ${offset} + :frames ${want} exceeds ` +
          `${total} frames — clamped to ${end - offset}`,
      );
    }
    const slice = offset === 0 && end === total ? data : data.subarray(offset, end);
    samples[s.name] = {
      data: slice,
      baseRate: s.rate ?? sampleRate,
    };
  }
  return samples;
}
