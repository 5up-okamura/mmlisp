// Float samples → a 16-bit PCM WAV (RIFF), mono or stereo: the WAV export's
// file, and every import's sample bank (wav-decode.js reads them back).

/** Encode float buffers as a 16-bit PCM WAV (RIFF). `R` null = mono. */
export function encodeWav(L, R, sampleRate) {
  const numFrames = L.length;
  const channels = R ? 2 : 1;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buf = new Uint8Array(44 + dataSize);
  const dv = new DataView(buf.buffer);
  const ascii = (off, str) => {
    for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
  };

  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true); // byte rate
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  ascii(36, "data");
  dv.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    dv.setInt16(off, Math.round(l * 32767), true);
    off += 2;
    if (R) {
      const r = Math.max(-1, Math.min(1, R[i]));
      dv.setInt16(off, Math.round(r * 32767), true);
      off += 2;
    }
  }
  return buf;
}
