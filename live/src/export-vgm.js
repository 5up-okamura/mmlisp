import { bankedEngineImage } from "./engine-banked-images.js";
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
// PCM: the score's PCM events run through the driver's own voice model and
// engine (pcm-voices.js / pcm-model.js, as the browser worklet does), which
// yields the mixed DAC byte stream the Z80 would play, one byte per engine
// sample. That stream goes into one YM2612 PCM data block (0x67 0x66 0x00),
// is played with 0x8n (DAC write from the data bank, then wait n) and
// re-seeked with 0xE0 at the loop point. The stream is not compressible into
// per-sample DAC stream control (0x90-0x95): the engine mixes several voices
// in software, so only the mix is what the hardware hears.
// ---------------------------------------------------------------------------

// VGM timing is always referenced to a fixed 44100 Hz sample clock, regardless
// of the chip clocks below.
import { YM2612_MASTER_CLOCK, PSG_MASTER_CLOCK } from "./ir-utils.js";
import { PcmLiveEngine, PCM_SILENCE_BYTE, parsePcmBank } from "./pcm-model.js";
import { PcmIrVoices } from "./pcm-voices.js";
import { engineImage } from "./engine-images.js";

const VGM_SAMPLE_RATE = 44100;

// NTSC Mega Drive clocks (master 53.693175 MHz; YM2612 = /7, SN76489 = /15).
// SN76489 as wired in the Mega Drive: white-noise feedback taps 0x0009, 16-bit
// shift register.
const SN76489_FEEDBACK = 0x0009;
const SN76489_SHIFT_WIDTH = 16;

const VGM_VERSION = 0x00000150;
// A one-shot score with PCM ends once the engine has been silent this long
// after its last event (or at the cap).
const PCM_TAIL_SILENCE_SEC = 0.05;
const PCM_TAIL_MAX_SEC = 30;
const DATA_START = 0x40; // header is 0x40 bytes for version 1.50

/**
 * Encode a captured register log into a VGM byte stream.
 *
 * @param {{ writes: Array<{sec:number,port:number,addr:number,data:number}>,
 *           loopStartSec: number|null, endSec: number }} capture
 * @param {{ title?: string, author?: string, system?: string,
 *           notes?: string }} [meta]
 * @param {{ bytes: Uint8Array, rateHz: number, startSec: number }|null} [dac]
 *        the mixed DAC stream from renderPcmDac, or null for none
 * @returns {Uint8Array}
 */
export function encodeVgm(capture, meta = {}, dac = null) {
  const { writes, loopStartSec } = capture;
  const endSec = Math.max(capture.endSec, dac ? dac.startSec + dac.bytes.length / dac.rateHz : 0);
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
      if (d <= 16) data.push(0x70 | (d - 1)); // short wait, 1-16 samples
      else data.push(0x61, d & 0xff, (d >> 8) & 0xff);
      curSample += d;
    }
  };

  // The DAC stream's bytes, as timed events among the register writes: the
  // first claims the DAC (0x2B), every one is a 0x8n from the data bank.
  let events = writes;
  if (dac && dac.bytes.length) {
    events = writes.map((w) => ({ ...w, s: secToSample(w.sec) }));
    events.push({ s: secToSample(dac.startSec), port: 0, addr: 0x2b, data: 0x80, enable: true });
    for (let k = 0; k < dac.bytes.length; k++)
      events.push({ s: secToSample(dac.startSec + k / dac.rateHz), dacIndex: k });
    // Stable: a register write at the same sample goes before the DAC byte.
    events.sort((a, b) => a.s - b.s || (a.dacIndex != null) - (b.dacIndex != null));
    // The data block, ahead of every command (VGM 1.50: type 0x00 = YM2612 PCM).
    const n = dac.bytes.length;
    data.push(0x67, 0x66, 0x00, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
    for (let k = 0; k < n; k++) data.push(dac.bytes[k]);
    data.push(0xe0, 0, 0, 0, 0); // seek the data bank to its start
  }
  // The bank pointer each event leaves behind, for the seek at the loop point.
  let dacNext = 0;

  const emitWrite = (w) => {
    if (w.port === 2) {
      data.push(0x50, w.data & 0xff); // SN76489
    } else if (w.port === 1) {
      data.push(0x53, w.addr & 0xff, w.data & 0xff); // YM2612 port 1
    } else {
      data.push(0x52, w.addr & 0xff, w.data & 0xff); // YM2612 port 0
    }
  };

  const markLoop = () => {
    waitUntil(loopSample);
    loopOffsetInData = data.length;
    // The data bank's pointer does not jump with the loop: re-seek it to
    // where the stream stood at the loop point.
    if (dac && dac.bytes.length) {
      const p = dacNext;
      data.push(0xe0, p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff);
    }
  };

  for (let i = 0; i < events.length; i++) {
    const w = events[i];
    const sample = w.s ?? secToSample(w.sec);

    // Mark the loop point exactly at loopSample so [loop, end) is a seamless
    // period: advance to the loop boundary, record the offset, then continue
    // to this write's own time.
    if (loopSample != null && loopOffsetInData == null && sample >= loopSample) markLoop();

    waitUntil(sample);
    if (w.dacIndex != null) {
      // 0x8n writes the bank's next byte and waits n (0-15): fold the wait
      // up to the next event in, unless the loop point falls inside it.
      const next = events[i + 1];
      let n = next ? Math.min(15, ((next.s ?? secToSample(next.sec)) - curSample)) : 0;
      if (loopSample != null && loopOffsetInData == null && curSample + n > loopSample)
        n = Math.max(0, loopSample - curSample);
      data.push(0x80 | Math.max(0, n));
      curSample += Math.max(0, n);
      dacNext = w.dacIndex + 1;
    } else {
      emitWrite(w);
    }
  }

  // A loop point at or past the last write (rare) still needs to be marked.
  if (loopSample != null && loopOffsetInData == null) markLoop();

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

/**
 * The mixed DAC stream a score's PCM events make on the driver's engine:
 * the events in time order through PcmIrVoices (the worklet's voice model)
 * into PcmLiveEngine, one byte per engine sample, from the first note on.
 * A looping capture renders to its end; a one-shot one until the engine has
 * gone quiet after the last event.
 *
 * @param capture  captureRegisterLog's result (pcmEvents, loopStartSec, endSec)
 * @param pcm      {bank: Uint8Array, entryIds, pcmVoices} — encodeMmb's
 *                 sampleBank and pcmEntryIds, and the score's voice count
 * @returns {{ bytes: Uint8Array, rateHz: number, startSec: number }|null}
 */
export function renderPcmDac(capture, pcm) {
  const events = capture.pcmEvents
    .map((e, i) => ({ ...e, i }))
    .sort((x, y) => x.sec - y.sec || x.i - y.i);
  if (!pcm?.bank?.length || !events.length) return null;
  const parsed = parsePcmBank(pcm.bank);
  const img = parsed.multibank ? bankedEngineImage(pcm.pcmVoices,pcm.frameHz ?? 60) : engineImage(pcm.pcmVoices);
  const window = new Uint8Array(0x8000);
  window.set(pcm.bank.subarray(0, 0x8000));
  const engine = new PcmLiveEngine(img, parsed.multibank ? pcm.bank : window);
  const seq = new PcmIrVoices((c) => engine.apply(c), {
    entries: parsed.entries,
    multibank: parsed.multibank,
    entryIds: pcm.entryIds ?? {},
  });

  // The DAC is claimed by the first note that starts, as on the driver.
  let k = 0;
  let startSec = null;
  for (; k < events.length && startSec == null; k++) if (seq.apply(events[k])) startSec = events[k].sec;
  if (startSec == null) return null;

  const looping = capture.loopStartSec != null;
  const lastEventSec = events[events.length - 1].sec;
  const hardEnd = looping ? capture.endSec : Math.max(capture.endSec, lastEventSec) + PCM_TAIL_MAX_SEC;
  const quietSamples = Math.ceil(PCM_TAIL_SILENCE_SEC * img.rateHz);
  const out = [];
  let quiet = 0;
  for (let n = 0; ; n++) {
    const sec = startSec + n / img.rateHz;
    if (sec >= hardEnd) break;
    for (; k < events.length && events[k].sec <= sec; k++) seq.apply(events[k]);
    const b = engine.next();
    out.push(b);
    if (!looping && sec >= Math.max(capture.endSec, lastEventSec)) {
      quiet = b === PCM_SILENCE_BYTE ? quiet + 1 : 0;
      if (quiet >= quietSamples) break;
    }
  }
  return { bytes: Uint8Array.from(out), rateHz: img.rateHz, startSec };
}

/**
 * Build a VGM file from an IRPlayer with IR loaded (capture + encode).
 * `pcm` ({bank, entryIds, pcmVoices}, see renderPcmDac) adds the PCM; without
 * it the score's PCM events are skipped and counted in `pcmCount`.
 */
export function configurePcmRate(player, pcm) {
  if (!pcm?.bank) return;
  const parsed = parsePcmBank(pcm.bank);
  const img = parsed.multibank ? bankedEngineImage(pcm.pcmVoices,pcm.frameHz ?? 60) : engineImage(pcm.pcmVoices);
  player?.setPcmBankRate?.(img.rateHz);
}

export function renderVgm(player, meta = {}, pcm = null) {
  configurePcmRate(player, pcm);
  const capture = player.captureRegisterLog();
  const dac = pcm ? renderPcmDac(capture, pcm) : null;
  const bytes = encodeVgm(capture, meta, dac);
  return { bytes, pcmCount: dac ? 0 : capture.pcmCount, dacBytes: dac ? dac.bytes.length : 0 };
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
  u32(0x0c, PSG_MASTER_CLOCK);
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
  u32(0x2c, YM2612_MASTER_CLOCK);
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
