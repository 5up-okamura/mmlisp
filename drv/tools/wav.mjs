// WAV loading for the node toolchain: the file decoded to mono float (-1..1)
// at its own rate, the form the bank builder takes (export-mmb.js): it runs
// the def's `:fx` chain, bakes each note and quantizes to 8-bit once. The
// decoder is the browser's too (live/src/wav-decode.js), so both build the
// same bank.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWav } from "../../live/src/wav-decode.js";
import { bakeAdpcmB } from "../../live/src/chips/adpcm-b.js";
import { bakePcm8 } from "../../live/src/chips/msm6258.js";

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
// A sample of a file imported from the repository root (`presets/…`,
// language.md §9.2) resolves relative to it, not to the working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function loadWavCached(path) {
  let wav = wavCache.get(path);
  if (!wav) {
    const rooted = !existsSync(path) && !isAbsolute(path) ? resolve(REPO_ROOT, path) : null;
    wav = loadWav(rooted && existsSync(rooted) ? rooted : path);
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

/**
 * The sample images a VGM target's chips play from, baked as Live does for
 * Play and File > Export > VGM: the YM2608's ADPCM-B RAM (`adpcm`), or the
 * samples as frames (`frames`: PCM8's, the PC Engine's DDA). Each null where
 * the target has no such part or the score names no sample file.
 */
export function bakedChipSamples(ir, target) {
  const samples = (ir.metadata?.samples ?? []).filter((s) => s.file);
  if (!samples.length) return { adpcm: null, frames: null };
  const blobs = () => loadSamplesForIr({ ...ir, metadata: { ...ir.metadata, samples } });
  return {
    adpcm: target.hasPart("adpcm-b") ? bakeAdpcmB(ir, blobs(), target) : null,
    frames: target.parts.some((p) => p.frames) ? bakePcm8(ir, blobs()) : null,
  };
}
