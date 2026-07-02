// ---------------------------------------------------------------------------
// Mega Drive synth core (YM2612 FM + SN76489 PSG)
//
// The single home for the Mega Drive chip-synthesis DSP — FM resample, PSG
// box-decimate + DC block, mix, and the optional Model-1 analog low-pass. Both
// the realtime worklet (live/worklet.js) and the offline WAV renderer
// (src/export-wav.js) drive this so the math lives in exactly one place.
//
// This is one system module; sibling systems (synth-nes.js, synth-pce.js,
// synth-msx.js, …) are expected to follow the same small contract:
//   create(outputSR) -> instance
//   writeYM/writePSG (or the system's register buses)
//   setLpf / setDacEnabled / reset
//   renderInto(outL, outR, count, onFrame?, getDacByte?, scope?)
//
// renderInto serves both timing models via onFrame:
//   - onFrame == null : writes were already applied for the whole block
//                       (the worklet's block-quantized path).
//   - onFrame(i)      : called before sample i so the caller can apply writes
//                       scheduled at that exact frame (sample-accurate; the
//                       offline renderer drains its event list here).
// getDacByte() supplies the 0-255 DAC value per FM native sample when the DAC
// is enabled (worklet PCM); the offline path passes null (FM + PSG only).
// ---------------------------------------------------------------------------

import createNukedModule from "../nuked-opn2.js";
import createPsgModule from "../nuked-psg.js";

// NTSC Mega Drive native rates (master 53.693175 MHz; YM2612 /144, PSG /16).
export const NUKED_NATIVE_SAMPLE_RATE = 7670454 / 144;
export const PSG_NATIVE_SAMPLE_RATE = 3579545 / 16;
// Mega Drive Model 1 analog output low-pass default cutoff (Hz).
export const MD_LPF_DEFAULT_CUTOFF = 3000;

// PSG is a unipolar sum of 4 channels; scale to match the FM:PSG balance of the
// reference emulators, and DC-block to remove the offset (and the thumps when
// notes change it). Calibrated so one max PSG square sits ~-6 dB below one max
// FM channel — the Genesis-Plus-GX default (fm_preamp 100 / psg_preamp 150 →
// PSG ~0.51x FM, -5.8 dB) and MAME's classic 2:1 route ratio. Measured through
// this full path (Nuked cores + decimation/DC block): a max FM channel peaks at
// ~0.066 and a max PSG square at ~0.278, so 0.5 left PSG ~+12 dB too hot; 0.06
// brings it to the ~-6 dB consensus.
const PSG_OUTPUT_GAIN = 0.06;
const PSG_DC_R = 0.9995; // one-pole DC blocker (~5 Hz high-pass at output rate)
const FM_SAMPLE_SCALE = 512; // int16 chip output -> float
const NOPN_MAX_RENDER = 4096; // nuked adapter caps _nopn_render() at this

// Oscilloscope taps: 10 per-channel streams at the output rate, scaled to each
// channel's contribution to the mix. FM: the chip time-multiplexes channels on
// its 9-bit DAC, so one channel's share of the 24-cycle-averaged output is
// ch_out / 4096 — measured against this path (least-squares fit of a solo
// full-scale channel vs the mix; the ~9% residual is the DAC ladder offsets
// from other channels' bus slots, which a clean per-channel tap excludes).
// PSG: one DC-blocked term of the 4-channel sum times PSG_OUTPUT_GAIN.
export const SCOPE_FM_CHANNELS = 6; // scope indices 0-5 (FM6 = DAC when on)
export const SCOPE_PSG_CHANNELS = 4; // scope indices 6-9 (tone 1-3, noise)
export const SCOPE_CHANNELS = SCOPE_FM_CHANNELS + SCOPE_PSG_CHANNELS;
const FM_CH_SCALE = 1 / 4096;

export class MegaDriveSynth {
  /** Instantiate both cores and return a ready synth. */
  static async create(outputSR) {
    const [ym, psg] = await Promise.all([
      createNukedModule(),
      createPsgModule(),
    ]);
    return new MegaDriveSynth(ym, psg, outputSR);
  }

  constructor(ym, psg, outputSR) {
    this._ym = ym;
    this._psg = psg;
    this._outputSR = outputSR;

    ym._nopn_init();
    psg._psg_init();
    this._ymBufferPtr = ym._nopn_get_buffer_ptr();
    this._psgBufferPtr = psg._psg_get_buffer_ptr();
    this._ymChPtr = ym._nopn_get_channel_buffer_ptr();
    this._psgChPtr = psg._psg_get_channel_buffer_ptr();

    // Scope tap state: FM current/next native samples per channel (mirrors the
    // stereo lerp window) + per-channel PSG DC blockers.
    this._ymChCur = new Float32Array(SCOPE_FM_CHANNELS);
    this._ymChNext = new Float32Array(SCOPE_FM_CHANNELS);
    this._psgChDcX = new Float32Array(SCOPE_PSG_CHANNELS);
    this._psgChDcY = new Float32Array(SCOPE_PSG_CHANNELS);
    this._resampleRatio = ym._nopn_get_native_sample_rate() / outputSR;
    this._psgRatio = psg._psg_get_native_sample_rate() / outputSR;

    this._dacEnabled = false;

    this._lpfOn = false;
    this._lpfCutoff = MD_LPF_DEFAULT_CUTOFF;
    this._lpfA = 0;
    this._lpfYL = 0;
    this._lpfYR = 0;
    this._updateLpfCoeff();

    this._resetResampleState();
  }

  // FM resample window + PSG decimation/DC state. Primes one FM native sample
  // (DAC off) so the first interpolation has a valid _ymNext, matching playback.
  _resetResampleState() {
    this._ymFrac = 0;
    this._ymCurrent = [0, 0];
    this._ymNext = this._renderYmOne(null);
    this._psgTickFrac = 0;
    this._psgDcX = 0;
    this._psgDcY = 0;
    this._ymChCur.fill(0);
    this._ymChNext.fill(0);
    this._psgChDcX.fill(0);
    this._psgChDcY.fill(0);
  }

  /** Reset both chips and all DSP state to silence. */
  reset() {
    this._ym._nopn_reset();
    this._psg._psg_reset();
    this.setDacEnabled(false);
    this._lpfYL = 0;
    this._lpfYR = 0;
    this._resetResampleState();
  }

  writeYM(port, addr, data) {
    this._ym._nopn_write_reg(port ?? 0, addr & 0xff, data & 0xff);
  }

  writePSG(byte) {
    this._psg._psg_write(byte & 0xff);
  }

  setDacEnabled(on) {
    const next = !!on;
    if (next === this._dacEnabled) return;
    this._dacEnabled = next;
    this._ym._nopn_set_dac_enabled(next ? 1 : 0);
  }

  setLpf(on, cutoffHz) {
    this._lpfOn = !!on;
    if (Number.isFinite(cutoffHz) && cutoffHz > 0) this._lpfCutoff = cutoffHz;
    this._updateLpfCoeff();
  }

  _updateLpfCoeff() {
    // One-pole low-pass: y += a * (x - y), a = 1 - exp(-2*pi*fc/fs).
    const a = 1 - Math.exp((-2 * Math.PI * this._lpfCutoff) / this._outputSR);
    this._lpfA = Math.max(0, Math.min(1, a));
  }

  // Render one FM native stereo sample. When the DAC is enabled, getDacByte()
  // supplies the 0-255 value streamed into register 0x2a first.
  _renderYmOne(getDacByte) {
    if (this._dacEnabled && getDacByte) {
      this._ym._nopn_set_dac_sample(getDacByte());
    }
    this._ym._nopn_render(1);
    const base = this._ymBufferPtr >> 1;
    const heap = this._ym.HEAP16;
    return [heap[base] / FM_SAMPLE_SCALE, heap[base + 1] / FM_SAMPLE_SCALE];
  }

  // Read the next FM native sample from a block pre-rendered by one
  // _nopn_render(N) call (see renderInto's batch path). Values are identical to
  // calling _renderYmOne() that many times — the chip clocks the same either
  // way — but with a single WASM crossing instead of one per native sample.
  _fmNextNative() {
    const base = this._ymBufferPtr >> 1;
    const heap = this._ym.HEAP16;
    const k = this._ymBatchPos++;
    return [
      heap[base + 2 * k] / FM_SAMPLE_SCALE,
      heap[base + 2 * k + 1] / FM_SAMPLE_SCALE,
    ];
  }

  // Read the FM per-channel taps for native sample k of the current render
  // buffer into dst, scaled to each channel's mix contribution.
  _readFmChTaps(k, dst) {
    const heap = this._ym.HEAP16;
    let p = (this._ymChPtr >> 1) + k * SCOPE_FM_CHANNELS;
    for (let c = 0; c < SCOPE_FM_CHANNELS; c++) {
      dst[c] = heap[p++] * FM_CH_SCALE;
    }
  }

  // One-pole DC blocker step (removes the PSG's unipolar offset + thumps).
  _dcBlock(s) {
    const y = s - this._psgDcX + PSG_DC_R * this._psgDcY;
    this._psgDcX = s;
    this._psgDcY = y;
    return y;
  }

  // Per-channel variant of _dcBlock for the PSG scope taps.
  _dcBlockCh(c, s) {
    const y = s - this._psgChDcX[c] + PSG_DC_R * this._psgChDcY[c];
    this._psgChDcX[c] = s;
    this._psgChDcY[c] = y;
    return y;
  }

  // Box-average + DC-block the per-channel PSG taps for the n native ticks
  // starting at tickOffset (within the block rendered by the last
  // _psg_render call), writing output sample i of the scope's PSG streams.
  _psgScopeTaps(scope, i, tickOffset, n) {
    const heap = this._psg.HEAPF32;
    let p = (this._psgChPtr >> 2) + tickOffset * SCOPE_PSG_CHANNELS;
    let a0 = 0,
      a1 = 0,
      a2 = 0,
      a3 = 0;
    for (let t = 0; t < n; t++) {
      a0 += heap[p];
      a1 += heap[p + 1];
      a2 += heap[p + 2];
      a3 += heap[p + 3];
      p += SCOPE_PSG_CHANNELS;
    }
    scope[6][i] = this._dcBlockCh(0, (a0 / n) * PSG_OUTPUT_GAIN);
    scope[7][i] = this._dcBlockCh(1, (a1 / n) * PSG_OUTPUT_GAIN);
    scope[8][i] = this._dcBlockCh(2, (a2 / n) * PSG_OUTPUT_GAIN);
    scope[9][i] = this._dcBlockCh(3, (a3 / n) * PSG_OUTPUT_GAIN);
  }

  // Render one PSG output sample: box-decimate this sample's native ticks, then
  // DC-block. Numerically identical to rendering the ticks in a single block;
  // used on the sample-accurate path where PSG writes land between samples.
  _renderPsgSample(scope, i) {
    let n = Math.round(this._psgTickFrac + this._psgRatio);
    if (n < 1) n = 1;
    this._psgTickFrac += this._psgRatio - n;
    this._psg._psg_render(n);
    const heap = this._psg.HEAPF32;
    const base = this._psgBufferPtr >> 2;
    let acc = 0;
    for (let t = 0; t < n; t++) acc += heap[base + t];
    if (scope) this._psgScopeTaps(scope, i, 0, n);
    return this._dcBlock((acc / n) * PSG_OUTPUT_GAIN);
  }

  // Render `count` PSG output samples with a single _psg_render(total) call.
  // Valid only when no PSG write occurs between samples (the worklet's
  // block-quantized path) — fewer WASM boundary crossings than per-sample.
  _renderPsgBlockInto(out, count, scope) {
    if (!this._psgCounts || this._psgCounts.length < count) {
      this._psgCounts = new Int32Array(count);
    }
    const counts = this._psgCounts;
    let frac = this._psgTickFrac;
    let total = 0;
    for (let i = 0; i < count; i++) {
      let ticks = Math.round(frac + this._psgRatio);
      if (ticks < 1) ticks = 1;
      frac += this._psgRatio - ticks;
      counts[i] = ticks;
      total += ticks;
    }
    this._psgTickFrac = frac;
    this._psg._psg_render(total);
    const heap = this._psg.HEAPF32;
    let k = this._psgBufferPtr >> 2;
    let tick = 0;
    for (let i = 0; i < count; i++) {
      const n = counts[i];
      let acc = 0;
      for (let t = 0; t < n; t++) acc += heap[k++];
      if (scope) this._psgScopeTaps(scope, i, tick, n);
      tick += n;
      out[i] = this._dcBlock((acc / n) * PSG_OUTPUT_GAIN);
    }
  }

  // scope: optional array of SCOPE_CHANNELS Float32Arrays (length >= count).
  // When given, per-channel waveforms land in scope[0..5] (FM 1-6) and
  // scope[6..9] (PSG tone 1-3, noise) on the same output-rate time axis as
  // the mix. Null-cost when omitted.
  renderInto(outL, outR, count, onFrame = null, getDacByte = null, scope = null) {
    // Block-quantized callers (onFrame == null) have already applied every PSG
    // write, so the whole PSG block can render in one call. Sample-accurate
    // callers render PSG per sample as writes interleave.
    let psgBlock = null;
    if (!onFrame) {
      if (!this._psgScratch || this._psgScratch.length < count) {
        this._psgScratch = new Float32Array(count);
      }
      psgBlock = this._psgScratch;
      this._renderPsgBlockInto(psgBlock, count, scope);
    }

    // FM batch path: with no interleaved writes (onFrame == null) and the DAC
    // off, this block's FM native samples can be generated in a single
    // _nopn_render(N) call instead of one call per native sample — the dominant
    // realtime cost. The block consumes exactly floor(frac + count*ratio)
    // native samples. With the DAC on, each native sample needs its own DAC
    // byte, so fall back to per-sample rendering.
    const fmNeed =
      !onFrame && !this._dacEnabled
        ? Math.floor(this._ymFrac + count * this._resampleRatio)
        : -1;
    const batchFM = fmNeed >= 0 && fmNeed <= NOPN_MAX_RENDER;
    if (batchFM) {
      this._ymBatchPos = 0;
      if (fmNeed > 0) this._ym._nopn_render(fmNeed);
    }

    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);

      const psgS = onFrame ? this._renderPsgSample(scope, i) : psgBlock[i];

      // FM: linear-interpolate between the current and next native samples.
      const t = this._ymFrac;
      let mixL = this._ymCurrent[0] * (1 - t) + this._ymNext[0] * t + psgS;
      let mixR = this._ymCurrent[1] * (1 - t) + this._ymNext[1] * t + psgS;
      if (scope) {
        // Same lerp window per channel, so taps stay aligned with the mix.
        const cur = this._ymChCur;
        const next = this._ymChNext;
        for (let c = 0; c < SCOPE_FM_CHANNELS; c++) {
          scope[c][i] = cur[c] * (1 - t) + next[c] * t;
        }
      }
      this._ymFrac += this._resampleRatio;
      while (this._ymFrac >= 1) {
        this._ymFrac -= 1;
        this._ymCurrent = this._ymNext;
        this._ymNext = batchFM
          ? this._fmNextNative()
          : this._renderYmOne(getDacByte);
        if (scope) {
          const tmp = this._ymChCur;
          this._ymChCur = this._ymChNext;
          this._ymChNext = tmp;
          this._readFmChTaps(batchFM ? this._ymBatchPos - 1 : 0, this._ymChNext);
        }
      }

      if (this._lpfOn) {
        this._lpfYL += this._lpfA * (mixL - this._lpfYL);
        this._lpfYR += this._lpfA * (mixR - this._lpfYR);
        mixL = this._lpfYL;
        mixR = this._lpfYR;
      }
      outL[i] = mixL;
      outR[i] = mixR;
    }
  }
}
