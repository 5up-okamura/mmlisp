// ---------------------------------------------------------------------------
// WAV export
//
// Renders the loaded IR to a 16-bit stereo WAV by replaying the captured
// YM2612 + PSG register log through the nuked cores offline (no audio graph).
// Reuses IRPlayer.captureRegisterLog() — the same time-ordered {sec,port,addr,
// data} log that feeds VGM export — so timing/loop detection is shared.
//
// Loop handling: if the piece has an authored loop, play the intro + 2 full
// loop bodies, then begin a 4-second fadeout as the 3rd body starts, and stop.
// Total = loopStart + 2*P + fadeSec (P = loop period). A one-shot piece renders
// once with no fade.
//
// PCM, given the score's bank: the same mixed DAC stream VGM export embeds
// (export-vgm.js renderPcmDac), fed to the YM2612's DAC at the engine's rate
// and tiled with the loop like the register writes. Without a bank the PCM
// events are skipped and counted in pcmCount.
//
// The actual synthesis lives in the machine's synth core — synth-md.js for
// the Mega Drive, synth-pc88.js for the PC-8801, synth-x68k.js for the
// X68000 — the same DSP that drives live playback, so exports match what
// you hear by construction. A pc88
// score's PCM is the chip's own: the ADPCM-B's RAM image (`pcm.adpcm`, as
// the VGM export takes it) and the rhythm ROM the user brings (`rhythmRom`).
// ---------------------------------------------------------------------------

import { notYet } from "./targets.js";
import { MegaDriveSynth, NUKED_NATIVE_SAMPLE_RATE } from "./synth-md.js";
import { Pc88Synth } from "./synth-pc88.js";
import { X68kSynth } from "./synth-x68k.js";
import { renderPcmDac, configurePcmRate } from "./export-vgm.js";
import { RHYTHM_BIT } from "./chips/ym2608.js";
import { ROM_SOUND_SEC } from "./chips/rhythm-rom.js";

/** The synth core that plays `target`'s chips (its name: md, pc88, x68k). */
export const SYNTHS = { md: MegaDriveSynth, pc88: Pc88Synth, x68k: X68kSynth };

const DEFAULT_SAMPLE_RATE = 48000; // match live AudioContext (and the LPF coeff)
const DEFAULT_FADE_SEC = 4;

/**
 * Build the finite render timeline from a captured register log.
 *
 * @param {{writes:Array, loopStartSec:number|null, endSec:number}} capture
 * @param {number} sampleRate
 * @param {number} fadeSec
 * @returns {{ fmWrites:Array<{frame:number,port:number,addr:number,data:number}>,
 *             psgWrites:Array<{frame:number,data:number}>,
 *             totalFrames:number, fadeStartFrame:number|null }}
 */
function buildTimeline(capture, sampleRate, fadeSec = DEFAULT_FADE_SEC) {
  const { writes, loopStartSec, endSec } = capture;
  const looping = loopStartSec != null;
  const P = looping ? endSec - loopStartSec : 0;

  const totalSec = looping ? endSec + P + fadeSec : endSec;
  const fadeStartSec = looping ? endSec + P : null;
  const totalFrames = Math.max(1, Math.round(totalSec * sampleRate));

  // intro + body1 is the captured log as-is. Tile the loop body twice more
  // (+P = body2, +2P = body3); register writes are absolute state-sets, so
  // re-emitting the body's writes reproduces the loop with no chip reset.
  const events = writes.slice();
  if (looping) {
    const body = writes.filter(
      (w) => w.sec >= loopStartSec && w.sec < endSec,
    );
    for (let k = 1; k <= 2; k++) {
      for (const w of body) {
        const sec = w.sec + k * P;
        if (sec >= totalSec) continue; // body3 is cut where the fade ends
        events.push({ ...w, sec });
      }
    }
  }

  // Map to output frames, keep a stable order (by frame, then capture order).
  const fmWrites = [];
  const psgWrites = [];
  events.forEach((w, i) => {
    const frame = Math.round(w.sec * sampleRate);
    if (frame >= totalFrames) return;
    if (w.port === 2) {
      psgWrites.push({ frame, data: w.data & 0xff, _i: i });
    } else {
      fmWrites.push({
        frame,
        port: w.port | 0,
        addr: w.addr & 0xff,
        data: w.data & 0xff,
        _i: i,
      });
    }
  });
  const byFrame = (a, b) => a.frame - b.frame || a._i - b._i;
  fmWrites.sort(byFrame);
  psgWrites.sort(byFrame);

  return {
    fmWrites,
    psgWrites,
    totalFrames,
    fadeStartFrame: fadeStartSec == null ? null : Math.round(fadeStartSec * sampleRate),
  };
}

/**
 * Render the timeline to stereo float buffers through the machine's synth
 * core. Writes are applied sample-accurately through the renderInto onFrame
 * callback (the offline path has no realtime constraint). With `dac` (the
 * PCM stream, see renderWav) the DAC is claimed at its first byte and fed from
 * it; without, the DAC stays off. It renders in slices and yields between
 * them, so a page that runs it stays responsive; `onProgress(0..1)` follows.
 *
 * @returns {Promise<{ L: Float32Array, R: Float32Array }>}
 */
async function renderSamples(
  synth,
  fmWrites,
  psgWrites,
  totalFrames,
  sampleRate,
  dac = null,
  onProgress = null,
) {

  const L = new Float32Array(totalFrames);
  const R = new Float32Array(totalFrames);

  // The DAC stream (renderPcmDac), claimed at its first byte; past the
  // captured loop end its time folds back into the loop body.
  let getDacByte = null;
  const dacStartFrame = dac ? Math.round(dac.startSec * sampleRate) : Infinity;
  if (dac) {
    let native = 0;
    getDacByte = () => {
      let t = dac.startSec + native++ / NUKED_NATIVE_SAMPLE_RATE;
      if (dac.loopStartSec != null && t >= dac.endSec)
        t = dac.loopStartSec + ((t - dac.loopStartSec) % (dac.endSec - dac.loopStartSec));
      const k = Math.floor((t - dac.startSec) * dac.rateHz);
      return k >= 0 && k < dac.bytes.length ? dac.bytes[k] : 0x80;
    };
  }

  let fmI = 0;
  let psgI = 0;
  const onFrameAt = (frame) => {
    while (fmI < fmWrites.length && fmWrites[fmI].frame <= frame) {
      const op = fmWrites[fmI++];
      synth.writeYM(op.port, op.addr, op.data);
    }
    while (psgI < psgWrites.length && psgWrites[psgI].frame <= frame) {
      synth.writePSG(psgWrites[psgI++].data);
    }
    // After the frame's writes: the player's boot writes $2B = 0 at time 0,
    // which would turn a DAC claimed in the same frame back off.
    if (frame === dacStartFrame) synth.setDacEnabled(true);
  };
  const slice = Math.max(1, Math.round(sampleRate / 4));
  for (let at = 0; at < totalFrames; at += slice) {
    const n = Math.min(slice, totalFrames - at);
    synth.renderInto(L.subarray(at, at + n), R.subarray(at, at + n), n, (i) => onFrameAt(at + i), getDacByte);
    onProgress?.((at + n) / totalFrames);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { L, R };
}

// When a pc88 one-shot's last sounds end: an ADPCM-B shot plays its range
// out, a rhythm hit its ROM sound — both past their key-on write. 0 when the
// target has neither.
function pc88TailSec(capture, target) {
  const chip = target?.chipFor?.("rhythm") ?? target?.chipFor?.("adpcm-b");
  if (!chip?.rhythm && !chip?.adpcm) return 0;
  const regs = new Uint8Array(0x11); // the ADPCM-B's, as last written
  let tail = 0;
  for (const w of capture.writes) {
    if (w.port === 0 && w.addr === 0x10 && !(w.data & 0x80)) {
      for (const [sound, bit] of Object.entries(RHYTHM_BIT))
        if (w.data & (1 << bit)) tail = Math.max(tail, w.sec + ROM_SOUND_SEC[sound]);
    }
    if (w.port !== 1 || w.addr > 0x10) continue;
    regs[w.addr] = w.data;
    if (w.addr === 0 && (w.data & 0x80) && !(w.data & 0x10)) {
      const start = regs[2] | (regs[3] << 8), stop = regs[4] | (regs[5] << 8);
      const rate = (((regs[9] | (regs[10] << 8)) / 65536) * chip.clock) / 144;
      if (rate > 0) tail = Math.max(tail, w.sec + ((stop - start + 1) * 8) / rate);
    }
  }
  return tail;
}

/** Linear gain ramp 1->0 across [fadeStartFrame, totalFrames). In place. */
function applyFade(L, R, fadeStartFrame, totalFrames) {
  const fadeLen = totalFrames - fadeStartFrame;
  if (fadeLen <= 0) return;
  for (let i = fadeStartFrame; i < totalFrames; i++) {
    const g = 1 - (i - fadeStartFrame) / fadeLen;
    L[i] *= g;
    R[i] *= g;
  }
}

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

/**
 * Render the loaded IR to WAV bytes (capture -> tile/fade -> synth -> encode).
 *
 * @param {IRPlayer} player  player with IR already loaded
 * @param {{ sampleRate?:number, lpfOn?:boolean, fadeSec?:number,
 *           pcm?:{bank:Uint8Array, entryIds:object, pcmVoices:number}
 *               | {adpcm:{image:Uint8Array, entries:object}},
 *           rhythmRom?:Uint8Array,
 *           onProgress?:(fraction:number)=>void }} [opts]
 *        `pcm` is the score's bank (see export-vgm.js renderPcmDac) or a
 *        pc88 score's ADPCM-B image (chips/adpcm-b.js bakeAdpcmB);
 *        `rhythmRom` the YM2608's (without it the rhythm is silent)
 * @returns {Promise<{ bytes:Uint8Array, pcmCount:number, durationSec:number }>}
 */
export async function renderWav(player, opts = {}) {
  const why = notYet(player._target, "play"); // a register log with no core to play it
  if (why) throw new Error(why);
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const fadeSec = opts.fadeSec ?? DEFAULT_FADE_SEC;
  const target = player._target;
  const synth = await (SYNTHS[target?.name] ?? MegaDriveSynth).create(sampleRate);
  synth.setLpf(!!opts.lpfOn);

  const adpcm = opts.pcm?.adpcm ?? null;
  if (adpcm) {
    player.setAdpcmBank?.(adpcm);
    synth.setAdpcmRam(adpcm.image);
  }
  if (opts.rhythmRom) synth.setRhythmRom?.(opts.rhythmRom);
  if (!adpcm) configurePcmRate(player, opts.pcm);
  const capture = player.captureRegisterLog();
  const dac = opts.pcm?.bank ? renderPcmDac(capture, opts.pcm) : null;
  // A one-shot PCM tail can outlast the last register write.
  if (dac && capture.loopStartSec == null)
    capture.endSec = Math.max(capture.endSec, dac.startSec + dac.bytes.length / dac.rateHz);
  if (capture.loopStartSec == null)
    capture.endSec = Math.max(capture.endSec, pc88TailSec(capture, target) + 0.05);
  const tl = buildTimeline(capture, sampleRate, fadeSec);
  const { L, R } = await renderSamples(
    synth,
    tl.fmWrites,
    tl.psgWrites,
    tl.totalFrames,
    sampleRate,
    dac && { ...dac, loopStartSec: capture.loopStartSec, endSec: capture.endSec },
    opts.onProgress ?? null,
  );
  if (tl.fadeStartFrame != null) {
    applyFade(L, R, tl.fadeStartFrame, tl.totalFrames);
  }
  const bytes = encodeWav(L, R, sampleRate);
  return { bytes, pcmCount: dac ? 0 : capture.pcmCount, durationSec: tl.totalFrames / sampleRate };
}
