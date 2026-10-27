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
//
// The X68000's PCM8 is a software mix too (chips/msm6258.js): its stream of
// OKI ADPCM goes into one data block (type 0x04) that DAC stream control
// feeds to the MSM6258's data register two samples a byte; at the loop point
// the chip is stopped and started again (its decoder starts over, as the
// stream's body was encoded) and the stream re-started at the body.
// ---------------------------------------------------------------------------

import { targetProfile } from "./targets.js";
import { ADPCM_RAM_BYTES } from "./chips/adpcm-b.js";
import { PcmLiveEngine, PCM_SILENCE_BYTE, parsePcmBank } from "./pcm-model.js";
import { PcmIrVoices } from "./pcm-voices.js";
import { engineImage } from "./engine-images.js";
import { renderPcm8, MSM6258_CLOCK } from "./chips/msm6258.js";
import { bankedEngineImage } from "./engine-banked-images.js";

// VGM timing is always referenced to a fixed 44100 Hz sample clock, regardless
// of the chip clocks below.
const VGM_SAMPLE_RATE = 44100;

// The VGM version a score needs is its chips' newest (chips/ `vgm.version`);
// 1.50's header is 0x40 bytes, 1.51's 0x80, 1.61's 0xC0.
const VGM_VERSION = 0x00000150;
const vgmVersion = (chips) => Math.max(VGM_VERSION, ...chips.map((c) => c.vgm.version ?? 0));
// The target's chips a capture has: an optional one (a cartridge, the SCC)
// only when some write is its.
const chipsOf = (target, writes) => {
  const written = new Set(writes.map((w) => String(w.port)));
  return Object.values(target.chips).filter((c) => !c.optional || Object.keys(c.vgm.ports ?? {}).some((p) => written.has(p)));
};
const dataStartOf = (version) => (version >= 0x161 ? 0xc0 : version >= 0x151 ? 0x80 : 0x40);
// A one-shot score with PCM ends once the engine has been silent this long
// after its last event (or at the cap).
const PCM_TAIL_SILENCE_SEC = 0.05;
const PCM_TAIL_MAX_SEC = 30;

/**
 * Encode a captured register log into a VGM byte stream.
 *
 * @param {{ writes: Array<{sec:number,port:number,addr:number,data:number}>,
 *           loopStartSec: number|null, endSec: number }} capture
 * @param {{ title?: string, composer?: string, author?: string, system?: string,
 *           notes?: string }} [meta]
 * @param {{ bytes: Uint8Array, rateHz: number, startSec: number }|null} [dac]
 *        the mixed DAC stream from renderPcmDac, or null for none
 * @returns {Uint8Array}
 */
function encodeVgm(capture, meta = {}, dac = null, target = targetProfile(), adpcm = null, oki = null) {
  const { writes, loopStartSec } = capture;
  const endSec = Math.max(capture.endSec, dac ? dac.startSec + dac.bytes.length / dac.rateHz : 0,
    oki ? oki.startSec + (2 * oki.bytes.length) / oki.rateHz : 0);
  const secToSample = (sec) => Math.max(0, Math.round(sec * VGM_SAMPLE_RATE));

  const endSample = secToSample(endSec);
  const loopSample = loopStartSec == null ? null : secToSample(loopStartSec);

  const data = new ByteBuffer(0x80 + writes.length * 3 + (dac ? dac.bytes.length * 2 : 0));
  let curSample = 0;
  let loopOffsetInData = null; // byte position of the loop command within `data`

  const waitUntil = (target) => {
    while (target > curSample) {
      const d = Math.min(0xffff, target - curSample);
      if (d <= 0) break;
      if (d <= 16) data.push1(0x70 | (d - 1)); // short wait, 1-16 samples
      else data.push3(0x61, d & 0xff, (d >> 8) & 0xff);
      curSample += d;
    }
  };

  // The register writes in time order, each at its sample. With a DAC
  // stream, the first byte claims the DAC (0x2B) and every byte is a 0x8n
  // from the data bank, merged in: a register write at the same sample goes
  // before the DAC byte.
  const dacLen = dac ? dac.bytes.length : 0;
  // A chip's own sample RAM image, ahead of every command (VGM 1.51: block
  // type, then the RAM's size and where the image starts in it).
  if (adpcm?.image?.length) {
    const block = Object.values(target.chips).find((c) => c.adpcm)?.adpcm.vgmBlock ?? 0x81;
    const u32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    const size = 8 + adpcm.image.length;
    data.push3(0x67, 0x66, block);
    data.push4(...u32le(size));
    data.push4(...u32le(ADPCM_RAM_BYTES));
    data.push4(0, 0, 0, 0);
    data.pushBytes(adpcm.image);
  }
  let regs = writes;
  let regSample = writes.map((w) => secToSample(w.sec));
  // The MSM6258's stream: its block, the stream set up on the chip's data
  // register at a byte per two samples, and a start where the stream does.
  const u32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const okiStart = (offset) => {
    data.push3(0xb7, 0x00, 0x01); // stop: the next play starts the decoder over
    data.push3(0xb7, 0x00, 0x02); // play
    data.push3(0x93, 0x00, offset & 0xff);
    data.push4((offset >> 8) & 0xff, (offset >> 16) & 0xff, (offset >>> 24) & 0xff, 0x03); // to the end
    data.push4(0, 0, 0, 0);
  };
  if (oki?.bytes.length) {
    data.push3(0x67, 0x66, 0x04);
    data.push4(...u32le(oki.bytes.length));
    data.pushBytes(oki.bytes);
    data.push4(0x90, 0x00, 0x17, 0x00); data.push1(0x01); // stream 0 → OKIM6258, register 1
    data.push4(0x91, 0x00, 0x04, 0x01); data.push1(0x00); // from block type 4, a byte a step
    data.push2(0x92, 0x00); data.push4(...u32le(Math.round(MSM6258_CLOCK / 1024))); // bytes a second
    const timed = regs.map((w, i) => ({ w, s: regSample[i] }));
    timed.push({ w: { oki: 0 }, s: secToSample(oki.startSec) });
    timed.sort((a, b) => a.s - b.s);
    regs = timed.map((x) => x.w);
    regSample = timed.map((x) => x.s);
  }
  if (dacLen) {
    const timed = writes.map((w, i) => ({ w, s: regSample[i] }));
    timed.push({ w: { port: 0, addr: 0x2b, data: 0x80 }, s: secToSample(dac.startSec) });
    timed.sort((a, b) => a.s - b.s);
    regs = timed.map((x) => x.w);
    regSample = timed.map((x) => x.s);
    // The data block, ahead of every command (VGM 1.50: type 0x00 = YM2612 PCM).
    data.push3(0x67, 0x66, 0x00);
    data.push4(dacLen & 0xff, (dacLen >> 8) & 0xff, (dacLen >> 16) & 0xff, (dacLen >>> 24) & 0xff);
    data.pushBytes(dac.bytes);
    data.push1(0xe0);
    data.push4(0, 0, 0, 0); // seek the data bank to its start
  }
  const dacSample = (k) => (k < dacLen ? secToSample(dac.startSec + k / dac.rateHz) : Infinity);
  // The bank pointer each event leaves behind, for the seek at the loop point.
  let dacNext = 0;

  // Each worklet port's command, from the target's chips (chips/): the
  // SN76489's 0x50 takes a data byte, an FM chip's an address and a byte,
  // the SCC's 0xD2 a port of its own and an address in it (`sub`).
  const ports = Object.assign({}, ...Object.values(target.chips).map((c) => c.vgm.ports ?? {}));
  const emitWrite = (w) => {
    if (w.oki != null) return okiStart(w.oki);
    const p = ports[w.port];
    if (!p) throw new Error(`no VGM command for a write on port ${w.port}`);
    if (p.sub) data.push4(p.cmd, ...p.sub(w.addr & 0xff), w.data & 0xff);
    else if (p.addr) data.push3(p.cmd, w.addr & 0xff, w.data & 0xff);
    else data.push2(p.cmd, w.data & 0xff);
  };

  const markLoop = () => {
    waitUntil(loopSample);
    loopOffsetInData = data.length;
    // The data bank's pointer does not jump with the loop: re-seek it to
    // where the stream stood at the loop point.
    if (dacLen) {
      const p = dacNext;
      data.push1(0xe0);
      data.push4(p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff);
    }
    // The MSM6258's stream: the body, its decoder started over.
    if (oki?.loopByte != null) okiStart(oki.loopByte);
  };

  let r = 0; // the next register write
  let k = 0; // the next DAC byte
  let kSample = dacSample(0);
  while (r < regs.length || k < dacLen) {
    const isReg = r < regs.length && regSample[r] <= kSample;
    const sample = isReg ? regSample[r] : kSample;

    // Mark the loop point exactly at loopSample so [loop, end) is a seamless
    // period: advance to the loop boundary, record the offset, then continue
    // to this write's own time.
    if (loopSample != null && loopOffsetInData == null && sample >= loopSample) markLoop();

    waitUntil(sample);
    if (isReg) {
      emitWrite(regs[r++]);
      continue;
    }
    // 0x8n writes the bank's next byte and waits n (0-15): fold the wait
    // up to the next event in, unless the loop point falls inside it.
    dacNext = ++k;
    kSample = dacSample(k);
    const nextSample = Math.min(r < regs.length ? regSample[r] : Infinity, kSample);
    let n = nextSample === Infinity ? 0 : Math.min(15, nextSample - curSample);
    if (loopSample != null && loopOffsetInData == null && curSample + n > loopSample)
      n = Math.max(0, loopSample - curSample);
    data.push1(0x80 | Math.max(0, n));
    curSample += Math.max(0, n);
  }

  // A loop point at or past the last write (rare) still needs to be marked.
  if (loopSample != null && loopOffsetInData == null) markLoop();

  // Pad to the total length, then terminate. For looping pieces this makes the
  // loop period exact; for one-shots it lets the final release ring out.
  waitUntil(endSample);
  data.push1(0x66);

  const gd3 = buildGd3({ system: target.system, ...meta });
  return assembleVgm(data.bytes(), gd3, chipsOf(target, writes), {
    totalSamples: endSample,
    loopOffsetInData,
    loopSamples: loopSample == null ? 0 : endSample - loopSample,
  });
}

/** A byte array that grows as it is written. */
class ByteBuffer {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.length = 0;
  }
  room(n) {
    if (this.length + n <= this.buf.length) return;
    const grown = new Uint8Array(Math.max(this.length + n, this.buf.length * 2));
    grown.set(this.buf.subarray(0, this.length));
    this.buf = grown;
  }
  push1(a) { this.room(1); this.buf[this.length++] = a; }
  push2(a, b) { this.room(2); this.buf[this.length++] = a; this.buf[this.length++] = b; }
  push3(a, b, c) { this.room(3); this.buf[this.length++] = a; this.buf[this.length++] = b; this.buf[this.length++] = c; }
  push4(a, b, c, d) { this.room(4); this.push2(a, b); this.push2(c, d); }
  pushBytes(u8) { this.room(u8.length); this.buf.set(u8, this.length); this.length += u8.length; }
  bytes() { return this.buf.subarray(0, this.length); }
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
  const img = parsed.multibank ? bankedEngineImage(pcm.pcmVoices,pcm.frameHz ?? 60) : engineImage(pcm.pcmVoices, pcm.frameHz ?? 60);
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
  const out = new ByteBuffer(Math.ceil(Math.max(0, hardEnd - startSec) * img.rateHz) + 1);
  let quiet = 0;
  for (let n = 0; ; n++) {
    const sec = startSec + n / img.rateHz;
    if (sec >= hardEnd) break;
    for (; k < events.length && events[k].sec <= sec; k++) seq.apply(events[k]);
    const b = engine.next();
    out.push1(b);
    if (!looping && sec >= Math.max(capture.endSec, lastEventSec)) {
      quiet = b === PCM_SILENCE_BYTE ? quiet + 1 : 0;
      if (quiet >= quietSamples) break;
    }
  }
  return { bytes: out.bytes(), rateHz: img.rateHz, startSec };
}

/** Set the player's PCM bank rate to the engine image `pcm` plays on. */
export function configurePcmRate(player, pcm) {
  if (!pcm?.bank) return;
  const parsed = parsePcmBank(pcm.bank);
  const img = parsed.multibank ? bankedEngineImage(pcm.pcmVoices,pcm.frameHz ?? 60) : engineImage(pcm.pcmVoices, pcm.frameHz ?? 60);
  player?.setPcmBankRate?.(img.rateHz);
}

/**
 * Build a VGM file from an IRPlayer with IR loaded (capture + encode).
 * `pcm` ({bank, entryIds, pcmVoices}, see renderPcmDac) adds the PCM; without
 * it the score's PCM events are skipped and counted in `pcmCount`.
 */
export function renderVgm(player, meta = {}, pcm = null) {
  // The PC Engine's DDA: the samples as frames, which the player writes as
  // the chip's own register writes (the log carries them).
  if (pcm?.frames) {
    player.setFrameBank?.(pcm.frames);
    const capture = player.captureRegisterLog();
    return { bytes: encodeVgm(capture, meta, null, player._target ?? targetProfile()), pcmCount: 0, dacBytes: 0 };
  }
  // The X68000's PCM8: the mix, encoded, as the MSM6258's stream.
  if (pcm?.pcm8) {
    player.setFrameBank?.(pcm.pcm8);
    const capture = player.captureRegisterLog();
    const oki = renderPcm8(capture.pcm8Events, pcm.pcm8, capture);
    const bytes = encodeVgm(capture, meta, null, player._target ?? targetProfile(), null, oki);
    return { bytes, pcmCount: 0, dacBytes: oki ? oki.bytes.length : 0 };
  }
  // Another target's PCM is its chip's own RAM image (chips/: the YM2608's
  // ADPCM-B), not the Mega Drive's mixed DAC stream.
  if (pcm?.adpcm) {
    player.setAdpcmBank?.(pcm.adpcm);
    const capture = player.captureRegisterLog();
    const bytes = encodeVgm(capture, meta, null, player._target ?? targetProfile(), pcm.adpcm);
    return { bytes, pcmCount: 0, dacBytes: 0 };
  }
  configurePcmRate(player, pcm);
  const capture = player.captureRegisterLog();
  const dac = pcm ? renderPcmDac(capture, pcm) : null;
  const bytes = encodeVgm(capture, meta, dac, player._target ?? targetProfile());
  return { bytes, pcmCount: dac ? 0 : capture.pcmCount, dacBytes: dac ? dac.bytes.length : 0 };
}

function assembleVgm(data, gd3, chips, { totalSamples, loopOffsetInData, loopSamples }) {
  const version = vgmVersion(chips);
  const DATA_START = dataStartOf(version);
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
  u32(0x08, version);
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
  u32(0x30, 0); // YM2151 clock
  u32(0x34, DATA_START - 0x34); // VGM data offset (relative to 0x34)
  // Each chip's block (chips/): its clock and the fields it has. One past
  // this version's header needs a later VGM (docs/roadmap.md).
  for (const chip of chips) {
    const { clock, header = [] } = chip.vgm;
    for (const [at, size, value] of [[clock, 4, chip.clock], ...header]) {
      if (at + size > DATA_START) throw new Error(`the ${chip.chip}'s VGM block is past a ${version.toString(16)} header`);
      if (size === 4) u32(at, value);
      else if (size === 2) u16(at, value);
      else buf[at] = value;
    }
  }

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
    meta.system ?? "", // system name (English): the target's (targets.js)
    "", // system name (Japanese)
    meta.composer || meta.author || "", // author (English): GD3's one name, the composer first
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
