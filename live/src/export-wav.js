// ---------------------------------------------------------------------------
// WAV export
//
// Renders the loaded IR to a 16-bit stereo WAV by replaying the captured
// YM2612 + PSG register log through the nuked cores offline (no audio graph).
// Reuses IRPlayer.captureRegisterLog() — the same time-ordered {sec,port,addr,
// data} log that feeds VGM export — so timing/loop detection is shared.
//
// Loop handling (per the user's spec): if the piece has an authored loop, play
// the intro + 2 full loop bodies, then begin a 4-second fadeout as the 3rd body
// starts, and stop. Total = loopStart + 2*P + fadeSec (P = loop period). A
// one-shot piece renders once with no fade.
//
// DAC/PCM is out of scope (FM + PSG only, mirroring VGM); captureRegisterLog
// reports skipped DAC events via pcmCount.
//
// The actual synthesis (FM resample, PSG decimate, mix, analog LPF) lives in
// the shared MegaDriveSynth core (synth-md.js) — the same DSP that drives live
// playback — so exports match what you hear by construction.
// ---------------------------------------------------------------------------

import { MegaDriveSynth } from "./synth-md.js";

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
export function buildTimeline(capture, sampleRate, fadeSec = DEFAULT_FADE_SEC) {
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
 * Render the timeline to stereo float buffers via the shared MegaDriveSynth
 * core. Writes are applied sample-accurately through the renderInto onFrame
 * callback (the offline path has no realtime constraint); the DAC stays off.
 *
 * @returns {Promise<{ L: Float32Array, R: Float32Array }>}
 */
export async function renderSamples(
  fmWrites,
  psgWrites,
  totalFrames,
  sampleRate,
  lpfOn,
) {
  const synth = await MegaDriveSynth.create(sampleRate);
  synth.setLpf(lpfOn);

  const L = new Float32Array(totalFrames);
  const R = new Float32Array(totalFrames);

  let fmI = 0;
  let psgI = 0;
  synth.renderInto(L, R, totalFrames, (frame) => {
    while (fmI < fmWrites.length && fmWrites[fmI].frame <= frame) {
      const op = fmWrites[fmI++];
      synth.writeYM(op.port, op.addr, op.data);
    }
    while (psgI < psgWrites.length && psgWrites[psgI].frame <= frame) {
      synth.writePSG(psgWrites[psgI++].data);
    }
  });

  return { L, R };
}

/** Linear gain ramp 1->0 across [fadeStartFrame, totalFrames). In place. */
export function applyFade(L, R, fadeStartFrame, totalFrames) {
  const fadeLen = totalFrames - fadeStartFrame;
  if (fadeLen <= 0) return;
  for (let i = fadeStartFrame; i < totalFrames; i++) {
    const g = 1 - (i - fadeStartFrame) / fadeLen;
    L[i] *= g;
    R[i] *= g;
  }
}

/** Encode stereo float buffers as a 16-bit PCM WAV (RIFF). */
export function encodeWav(L, R, sampleRate) {
  const numFrames = L.length;
  const channels = 2;
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
    const r = Math.max(-1, Math.min(1, R[i]));
    dv.setInt16(off, Math.round(l * 32767), true);
    dv.setInt16(off + 2, Math.round(r * 32767), true);
    off += 4;
  }
  return buf;
}

/**
 * Render the loaded IR to WAV bytes (capture -> tile/fade -> synth -> encode).
 *
 * @param {IRPlayer} player  player with IR already loaded
 * @param {{ sampleRate?:number, lpfOn?:boolean, fadeSec?:number }} [opts]
 * @returns {Promise<{ bytes:Uint8Array, pcmCount:number, durationSec:number }>}
 */
export async function renderWav(player, opts = {}) {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const fadeSec = opts.fadeSec ?? DEFAULT_FADE_SEC;
  const lpfOn = !!opts.lpfOn;

  const capture = player.captureRegisterLog();
  const tl = buildTimeline(capture, sampleRate, fadeSec);
  const { L, R } = await renderSamples(
    tl.fmWrites,
    tl.psgWrites,
    tl.totalFrames,
    sampleRate,
    lpfOn,
  );
  if (tl.fadeStartFrame != null) {
    applyFade(L, R, tl.fadeStartFrame, tl.totalFrames);
  }
  const bytes = encodeWav(L, R, sampleRate);
  return { bytes, pcmCount: capture.pcmCount, durationSec: tl.totalFrames / sampleRate };
}
