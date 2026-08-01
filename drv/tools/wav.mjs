// Minimal WAV reader for the node toolchain: load a PCM WAV and downmix it to
// mono 8-bit signed PCM — the SAMPLE_BANK blob format (mmb.md §10). The exact
// float rounding here does not need to match the browser loader: both the JS
// reference driver and the asm read the *same* MMB SAMPLE_BANK bytes, so the
// trace gate is unaffected by how the blob was produced (PCM vs ir-player is a
// waived comparison anyway).
import { readFileSync } from "node:fs";

// Returns { data: Int8Array (mono 8-bit signed), sampleRate }.
export function loadWav(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a WAV file`);
  }
  let channels = 1;
  let sampleRate = 8000;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(p + 10);
      sampleRate = buf.readUInt32LE(p + 12);
      bits = buf.readUInt16LE(p + 22);
    } else if (id === "data") {
      dataOff = p + 8;
      dataLen = size;
    }
    p += 8 + size + (size & 1); // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error(`${path}: no data chunk`);

  const bytesPerSample = bits >> 3;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const out = new Int8Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataOff + i * frameBytes + c * bytesPerSample;
      let s;
      if (bits === 8) s = buf[off] - 128; // WAV 8-bit is unsigned
      else if (bits === 16) s = buf.readInt16LE(off) >> 8; // → 8-bit
      else if (bits === 24) s = buf.readIntLE(off, 3) >> 16;
      else if (bits === 32) s = buf.readInt32LE(off) >> 24;
      else throw new Error(`${path}: unsupported bit depth ${bits}`);
      acc += s;
    }
    out[i] = Math.max(-128, Math.min(127, Math.round(acc / channels)));
  }
  return { data: out, sampleRate };
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
    // from the bank's start. `:loop-start`/`:loop-end` stay relative to the slice.
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
      data: Uint8Array.from(slice, (v) => v & 0xff),
      baseRate: s.rate ?? sampleRate,
      loopStart: s.loopStart ?? null,
      loopEnd: s.loopEnd ?? null,
    };
  }
  return samples;
}
