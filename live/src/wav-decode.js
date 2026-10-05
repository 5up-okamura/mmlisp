// ---------------------------------------------------------------------------
// WAV → mono float at the file's own rate
//
// The one decoder for samples, in the browser and in the node toolchain
// (drv/tools/wav.mjs), so both hand the bank builder (export-mmb.js) the same
// data. Not the browser's decodeAudioData: that resamples to the
// AudioContext's rate, and a def's `:offset` / `:frames` count frames of the
// file itself — an imported bank sliced on a 48 kHz copy of a 16 kHz wav plays
// the wrong stretch of it.
// ---------------------------------------------------------------------------

/**
 * @param {ArrayBuffer|Uint8Array} bytes  a RIFF WAVE file: PCM 8/16/24/32-bit
 *        or 32/64-bit float, any channel count (downmixed)
 * @returns {{ data: Float32Array, sampleRate: number }}
 */
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (u8.length < 12 || str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") throw new Error("not a WAV file");
  let format = 1;
  let channels = 1;
  let sampleRate = 8000;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  for (let p = 12; p + 8 <= u8.length; ) {
    const id = str(p, 4);
    const size = dv.getUint32(p + 4, true);
    if (id === "fmt ") {
      format = dv.getUint16(p + 8, true);
      channels = dv.getUint16(p + 10, true);
      sampleRate = dv.getUint32(p + 12, true);
      bits = dv.getUint16(p + 22, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the subformat GUID's first word.
      if (format === 0xfffe && size >= 26) format = dv.getUint16(p + 32, true);
    } else if (id === "data") {
      dataOff = p + 8;
      dataLen = Math.min(size, u8.length - dataOff);
    }
    p += 8 + size + (size & 1); // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error("WAV has no data chunk");
  if (format !== 1 && format !== 3) throw new Error(`WAV format ${format} is not PCM or float`);

  const bytesPerSample = bits >> 3;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const read = format === 3
    ? bits === 32 ? (o) => dv.getFloat32(o, true)
      : bits === 64 ? (o) => dv.getFloat64(o, true) : null
    : bits === 8 ? (o) => (u8[o] - 128) / 128 // 8-bit WAV is unsigned
      : bits === 16 ? (o) => dv.getInt16(o, true) / 32768
        : bits === 24 ? (o) => (((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) << 8) >> 8) / 8388608
          : bits === 32 ? (o) => dv.getInt32(o, true) / 2147483648 : null;
  if (!read) throw new Error(`unsupported WAV bit depth ${bits}`);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += read(dataOff + i * frameBytes + c * bytesPerSample);
    out[i] = acc / channels;
  }
  return { data: out, sampleRate };
}
