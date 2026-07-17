#!/usr/bin/env node
"use strict";

// Thin CLI wrapper — all compilation logic lives in live/src/mmlisp2ir.js.
const fs = require("node:fs");
const path = require("node:path");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseWavFile(buffer) {
  if (buffer.length < 44) {
    throw new Error("WAV header is too short");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("WAV missing RIFF header");
  }
  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV missing WAVE signature");
  }

  let pos = 12;
  let fmt = null;
  let data = null;

  while (pos + 8 <= buffer.length) {
    const id = buffer.toString("ascii", pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const bodyStart = pos + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buffer.length) break;

    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV fmt chunk is too short");
      fmt = {
        audioFormat: buffer.readUInt16LE(bodyStart + 0),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        byteRate: buffer.readUInt32LE(bodyStart + 8),
        blockAlign: buffer.readUInt16LE(bodyStart + 12),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(bodyStart, bodyEnd);
    }

    pos = bodyEnd + (size & 1); // chunk alignment to 2 bytes
  }

  if (!fmt) throw new Error("WAV fmt chunk not found");
  if (!data) throw new Error("WAV data chunk not found");
  if (fmt.audioFormat !== 1) {
    throw new Error(`WAV audio format ${fmt.audioFormat} is not PCM`);
  }
  if (fmt.channels < 1) {
    throw new Error("WAV channel count is invalid");
  }
  if (fmt.sampleRate < 1) {
    throw new Error("WAV sample rate is invalid");
  }
  if (fmt.bitsPerSample !== 8 && fmt.bitsPerSample !== 16) {
    throw new Error(`WAV bitsPerSample ${fmt.bitsPerSample} is not supported`);
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameSize = bytesPerSample * fmt.channels;
  if (frameSize <= 0) throw new Error("WAV frame size is invalid");

  const frameCount = Math.floor(data.length / frameSize);
  const out = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    let mix = 0;
    const frameBase = i * frameSize;
    for (let ch = 0; ch < fmt.channels; ch += 1) {
      const samplePos = frameBase + ch * bytesPerSample;
      let v;
      if (fmt.bitsPerSample === 8) {
        // PCM 8-bit WAV is unsigned.
        v = (data.readUInt8(samplePos) - 128) / 128;
      } else {
        v = data.readInt16LE(samplePos) / 32768;
      }
      mix += v;
    }
    out[i] = clamp(mix / fmt.channels, -1, 1);
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    mono: out,
  };
}

// `:offset` / `:frames` (in frames) cut one sample out of a file holding many —
// an instrument bank. Both are optional: no :offset starts at 0, no :frames
// runs to the end. Overruns are clamped with a warning rather than failing, so
// a slightly-off bank still plays.
function sliceMono(mono, sample, diagnostics, name) {
  const total = mono.length;
  const offset = Number.isFinite(sample.offset) ? Math.max(0, sample.offset) : 0;
  const want = Number.isFinite(sample.frames) ? Math.max(0, sample.frames) : total - offset;
  if (offset === 0 && want >= total) return mono;
  if (offset >= total || want === 0) {
    diagnostics.push({
      severity: "error",
      code: "E_SAMPLE_SLICE",
      message: `sample "${name}": :offset ${offset} is past the end of the file (${total} frames)`,
      src: sample.src ?? null,
      track: null,
    });
    return mono.slice(0, 0);
  }
  if (offset + want > total) {
    diagnostics.push({
      severity: "warning",
      code: "W_SAMPLE_SLICE_CLAMPED",
      message: `sample "${name}": :offset ${offset} + :frames ${want} exceeds ${total} frames — clamped`,
      src: sample.src ?? null,
      track: null,
    });
  }
  return mono.slice(offset, Math.min(total, offset + want));
}

function quantizeMonoToSignedPcm8(mono, bitDepth = 8) {
  const depth = clamp(Number(bitDepth) || 8, 1, 8);
  const peak = Math.pow(2, depth - 1) - 1;
  const out = Buffer.alloc(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const s = clamp(mono[i], -1, 1);
    const q = Math.round((Math.round(s * peak) / peak) * 127);
    out.writeInt8(clamp(q, -128, 127), i);
  }
  return out;
}

function applyGainToMono(mono, gain) {
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    out[i] = clamp(mono[i] * gain, -1, 1);
  }
  return out;
}

function applyVolumeEffect(mono, volumeSpec, diagnostics, sampleName) {
  if (volumeSpec == null) return mono;
  const n = Number(volumeSpec);
  if (!Number.isFinite(n)) {
    diagnostics.push({
      severity: "warning",
      code: "W_SAMPLE_EFFECT_IGNORED",
      message: `unsupported :volume value for sample ${sampleName}: ${String(volumeSpec)}`,
      line: 1,
      column: 1,
      track: null,
    });
    return mono;
  }
  if (n === 0) return applyGainToMono(mono, 0);

  // Heuristic: small positive values are linear gain; otherwise dB.
  const gain = n > 0 && n <= 4 ? n : Math.pow(10, n / 20);
  return applyGainToMono(mono, gain);
}

function applyCompressorEffect(mono, compressSpec, diagnostics, sampleName) {
  if (compressSpec == null) return mono;
  const raw = String(compressSpec).trim().toLowerCase();

  let threshold = 0.5;
  let ratio = 2.5;
  if (raw === "lofi") {
    threshold = 0.35;
    ratio = 4.0;
  } else {
    const n = Number(compressSpec);
    if (!(Number.isFinite(n) && n > 1)) {
      diagnostics.push({
        severity: "warning",
        code: "W_SAMPLE_EFFECT_IGNORED",
        message: `unsupported :compress value for sample ${sampleName}: ${String(compressSpec)}`,
        line: 1,
        column: 1,
        track: null,
      });
      return mono;
    }
    ratio = n;
  }

  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const s = mono[i];
    const a = Math.abs(s);
    if (a <= threshold) {
      out[i] = s;
      continue;
    }
    const excess = a - threshold;
    const c = threshold + excess / ratio;
    out[i] = clamp(Math.sign(s) * c, -1, 1);
  }
  return out;
}

function applyReverbEffect(
  mono,
  reverbSpec,
  sampleRate,
  diagnostics,
  sampleName,
) {
  if (reverbSpec == null) return mono;
  const raw = String(reverbSpec).trim().toLowerCase();

  let delayMs;
  let decay;
  let mix;
  if (raw === "room") {
    delayMs = 45;
    decay = 0.4;
    mix = 0.22;
  } else {
    const n = Number(reverbSpec);
    if (!Number.isFinite(n)) {
      diagnostics.push({
        severity: "warning",
        code: "W_SAMPLE_EFFECT_IGNORED",
        message: `unsupported :reverb value for sample ${sampleName}: ${String(reverbSpec)}`,
        line: 1,
        column: 1,
        track: null,
      });
      return mono;
    }
    delayMs = 50;
    decay = 0.35;
    mix = clamp(n, 0, 1);
  }

  const delay = Math.max(1, Math.floor((sampleRate * delayMs) / 1000));
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const dry = mono[i];
    const fb = i >= delay ? out[i - delay] * decay : 0;
    out[i] = clamp(dry * (1 - mix) + (dry + fb) * mix, -1, 1);
  }
  return out;
}

function normalizePathForFs(repoRoot, samplePath) {
  const p = String(samplePath || "").replace(/\\/g, "/");
  if (!p) return "";
  if (path.isAbsolute(p)) return p;
  return path.resolve(repoRoot, p);
}

function compileSamplesIntoIr(ir, diagnostics, repoRoot) {
  const samples = ir?.metadata?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return;

  for (const sample of samples) {
    const name = String(sample?.name || "");
    const rel = sample?.resolvedFile || sample?.file;
    if (!name || !rel) continue;

    const absPath = normalizePathForFs(repoRoot, rel);
    if (!absPath || !fs.existsSync(absPath)) {
      diagnostics.push({
        severity: "error",
        code: "E_SAMPLE_FILE_IO",
        message: `sample file not found: ${rel}`,
        line: 1,
        column: 1,
        track: null,
      });
      continue;
    }

    try {
      const wavBuf = fs.readFileSync(absPath);
      const decoded = parseWavFile(wavBuf);
      // `:offset` / `:frames` slice one file into many samples (a bank). Cut
      // before the effects so a reverb tail cannot bleed in from the
      // neighbouring sample, and so :volume/:compress see only this slice.
      let processed = sliceMono(decoded.mono, sample, diagnostics, name);
      processed = applyVolumeEffect(
        processed,
        sample.volume,
        diagnostics,
        name,
      );
      processed = applyCompressorEffect(
        processed,
        sample.compress,
        diagnostics,
        name,
      );
      processed = applyReverbEffect(
        processed,
        sample.reverb,
        decoded.sampleRate,
        diagnostics,
        name,
      );

      const pcm8 = quantizeMonoToSignedPcm8(processed, sample.bitDepth);
      const effectiveRate =
        Number(sample.rate) > 0 ? Number(sample.rate) : decoded.sampleRate;

      sample.rate = effectiveRate;
      sample.compiled = {
        format: "pcm_s8",
        sourceSampleRate: decoded.sampleRate,
        channels: decoded.channels,
        frames: processed.length, // the slice, not the whole file
        dataBase64: pcm8.toString("base64"),
      };
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "E_SAMPLE_FILE_IO",
        message: `failed to compile sample ${name}: ${String(err?.message ?? err)}`,
        line: 1,
        column: 1,
        track: null,
      });
    }
  }
}

function usage() {
  console.error(
    "Usage: node scripts/mmlisp2ir.js <input.mmlisp> [--out <file>] [--diag-out <file>] [--strict] [--pretty]",
  );
}

async function main() {
  const { compileMMLisp } = await import("../../live/src/mmlisp2ir.js");

  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const input = args[0];
  let outPath = null;
  let diagOutPath = null;
  let strict = false;

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") {
      outPath = args[++i];
      continue;
    }
    if (args[i] === "--diag-out") {
      diagOutPath = args[++i];
      continue;
    }
    if (args[i] === "--strict") {
      strict = true;
      continue;
    }
    // --pretty: accepted for compatibility, JSON output is always indented
  }

  const repoRoot = path.resolve(__dirname, "..", "..");
  const sourceRel = path
    .relative(repoRoot, path.resolve(input))
    .replace(/\\/g, "/");

  const src = fs.readFileSync(input, "utf8");
  const { ir, diagnostics } = compileMMLisp(src, sourceRel);
  compileSamplesIntoIr(ir, diagnostics, repoRoot);

  const json = JSON.stringify(ir, null, 2) + "\n";
  const hasError = diagnostics.some((d) => d.severity === "error");

  if (diagOutPath) {
    fs.mkdirSync(path.dirname(diagOutPath), { recursive: true });
    fs.writeFileSync(
      diagOutPath,
      JSON.stringify(diagnostics, null, 2) + "\n",
      "utf8",
    );
  }

  for (const d of diagnostics) {
    console.error(
      `[${d.severity}] ${d.code} ${d.track || "global"}:${d.line}:${d.column} ${d.message}`,
    );
  }

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, "utf8");
    if (strict && hasError) process.exit(1);
    return;
  }

  process.stdout.write(json);
  if (strict && hasError) process.exit(1);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
