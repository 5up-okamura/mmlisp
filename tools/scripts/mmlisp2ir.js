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
      const pcm8 = quantizeMonoToSignedPcm8(decoded.mono, sample.bitDepth);
      const effectiveRate =
        Number(sample.rate) > 0 ? Number(sample.rate) : decoded.sampleRate;

      sample.rate = effectiveRate;
      sample.compiled = {
        format: "pcm_s8",
        sourceSampleRate: decoded.sampleRate,
        channels: decoded.channels,
        frames: decoded.mono.length,
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
