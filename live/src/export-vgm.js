// ---------------------------------------------------------------------------
// VGM export
//
// Turns a flat register-write log (from IRPlayer.captureRegisterLog) into a
// VGM 1.50 byte stream for the Sega Mega Drive chip pair (YM2612 + SN76489).
// VGM is itself a timestamped register-write log, so the mapping is direct:
//
//   port 0 YM2612 write  -> 0x52 aa dd
//   port 1 YM2612 write  -> 0x53 aa dd
//   PSG (SN76489) write  -> 0x50 dd
//   wait n samples       -> 0x61 nn nn   (44100 Hz sample clock)
//   end of data          -> 0x66
//
// DAC/PCM is out of scope here (FM + PSG only); the capture reports any
// skipped PCM events so the caller can warn.
// ---------------------------------------------------------------------------

// VGM timing is always referenced to a fixed 44100 Hz sample clock, regardless
// of the chip clocks below.
const VGM_SAMPLE_RATE = 44100;

// NTSC Mega Drive clocks (master 53.693175 MHz; YM2612 = /7, SN76489 = /15).
const YM2612_CLOCK = 7670454;
const SN76489_CLOCK = 3579545;
// SN76489 as wired in the Mega Drive: white-noise feedback taps 0x0009, 16-bit
// shift register.
const SN76489_FEEDBACK = 0x0009;
const SN76489_SHIFT_WIDTH = 16;

const VGM_VERSION = 0x00000150;
const DATA_START = 0x40; // header is 0x40 bytes for version 1.50

/**
 * Encode a captured register log into a VGM byte stream.
 *
 * @param {{ writes: Array<{sec:number,port:number,addr:number,data:number}>,
 *           loopStartSec: number|null, endSec: number }} capture
 * @param {{ title?: string, author?: string, system?: string,
 *           notes?: string }} [meta]
 * @returns {Uint8Array}
 */
export function encodeVgm(capture, meta = {}) {
  const { writes, loopStartSec, endSec } = capture;
  const secToSample = (sec) => Math.max(0, Math.round(sec * VGM_SAMPLE_RATE));

  const endSample = secToSample(endSec);
  const loopSample = loopStartSec == null ? null : secToSample(loopStartSec);

  const data = [];
  let curSample = 0;
  let loopOffsetInData = null; // byte position of the loop command within `data`

  const waitUntil = (target) => {
    while (target > curSample) {
      const d = Math.min(0xffff, target - curSample);
      if (d <= 0) break;
      data.push(0x61, d & 0xff, (d >> 8) & 0xff);
      curSample += d;
    }
  };

  const emitWrite = (w) => {
    if (w.port === 2) {
      data.push(0x50, w.data & 0xff); // SN76489
    } else if (w.port === 1) {
      data.push(0x53, w.addr & 0xff, w.data & 0xff); // YM2612 port 1
    } else {
      data.push(0x52, w.addr & 0xff, w.data & 0xff); // YM2612 port 0
    }
  };

  for (const w of writes) {
    const sample = secToSample(w.sec);

    // Mark the loop point exactly at loopSample so [loop, end) is a seamless
    // period: advance to the loop boundary, record the offset, then continue
    // to this write's own time.
    if (loopSample != null && loopOffsetInData == null && sample >= loopSample) {
      waitUntil(loopSample);
      loopOffsetInData = data.length;
    }

    waitUntil(sample);
    emitWrite(w);
  }

  // A loop point at or past the last write (rare) still needs to be marked.
  if (loopSample != null && loopOffsetInData == null) {
    waitUntil(loopSample);
    loopOffsetInData = data.length;
  }

  // Pad to the total length, then terminate. For looping pieces this makes the
  // loop period exact; for one-shots it lets the final release ring out.
  waitUntil(endSample);
  data.push(0x66);

  const gd3 = buildGd3(meta);
  return assembleVgm(data, gd3, {
    totalSamples: endSample,
    loopOffsetInData,
    loopSamples: loopSample == null ? 0 : endSample - loopSample,
  });
}

/** Build a VGM file from an IRPlayer with IR loaded (capture + encode). */
export function renderVgm(player, meta = {}) {
  const capture = player.captureRegisterLog();
  const bytes = encodeVgm(capture, meta);
  return { bytes, pcmCount: capture.pcmCount };
}

function assembleVgm(data, gd3, { totalSamples, loopOffsetInData, loopSamples }) {
  const dataLen = data.length;
  const gd3Start = DATA_START + dataLen; // GD3 (if any) follows the data block
  const gd3Len = gd3 ? gd3.length : 0;
  const total = gd3Start + gd3Len;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  const u32 = (off, v) => dv.setUint32(off, v >>> 0, true);
  const u16 = (off, v) => dv.setUint16(off, v & 0xffff, true);

  // "Vgm "
  buf[0] = 0x56;
  buf[1] = 0x67;
  buf[2] = 0x6d;
  buf[3] = 0x20;
  u32(0x04, total - 0x04); // EOF offset (relative to 0x04)
  u32(0x08, VGM_VERSION);
  u32(0x0c, SN76489_CLOCK);
  u32(0x10, 0); // YM2413 clock
  u32(0x14, gd3 ? gd3Start - 0x14 : 0); // GD3 offset (relative to 0x14)
  u32(0x18, totalSamples);
  if (loopOffsetInData != null) {
    const loopAbs = DATA_START + loopOffsetInData;
    u32(0x1c, loopAbs - 0x1c); // loop offset (relative to 0x1c)
    u32(0x20, loopSamples);
  } else {
    u32(0x1c, 0);
    u32(0x20, 0);
  }
  u32(0x24, 60); // rate (informational)
  u16(0x28, SN76489_FEEDBACK);
  buf[0x2a] = SN76489_SHIFT_WIDTH;
  buf[0x2b] = 0; // SN76489 flags
  u32(0x2c, YM2612_CLOCK);
  u32(0x30, 0); // YM2151 clock
  u32(0x34, DATA_START - 0x34); // VGM data offset (relative to 0x34)

  buf.set(data, DATA_START);
  if (gd3) buf.set(gd3, gd3Start);
  return buf;
}

// GD3 1.00 tag: a run of UTF-16LE, null-terminated strings in a fixed order.
function buildGd3(meta) {
  const fields = [
    meta.title ?? "", // track name (English)
    "", // track name (Japanese)
    "", // game name (English)
    "", // game name (Japanese)
    meta.system ?? "Sega Mega Drive", // system name (English)
    "", // system name (Japanese)
    meta.author ?? "", // author (English)
    "", // author (Japanese)
    "", // release date
    "MMLisp", // VGM creator
    meta.notes ?? "", // notes
  ];

  const body = [];
  for (const s of fields) {
    for (const cp of String(s)) {
      const code = cp.codePointAt(0);
      // Stay within the BMP; non-BMP code points are dropped rather than
      // emitting raw surrogate halves.
      if (code <= 0xffff) body.push(code & 0xff, (code >> 8) & 0xff);
    }
    body.push(0x00, 0x00); // null terminator
  }

  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x47; // "Gd3 "
  out[1] = 0x64;
  out[2] = 0x33;
  out[3] = 0x20;
  dv.setUint32(0x04, 0x00000100, true); // version 1.00
  dv.setUint32(0x08, body.length, true); // length of the string data
  out.set(body, 12);
  return out;
}
