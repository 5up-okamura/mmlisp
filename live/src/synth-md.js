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
//   renderInto(outL, outR, count, onFrame?, getDacByte?)
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

// PSG is a unipolar sum of 4 channels; scale toward a single-channel level and
// DC-block to remove the offset (and the thumps when notes change it).
const PSG_OUTPUT_GAIN = 0.5;
const PSG_DC_R = 0.9995; // one-pole DC blocker (~5 Hz high-pass at output rate)
const FM_SAMPLE_SCALE = 512; // int16 chip output -> float
const NOPN_MAX_RENDER = 4096; // nuked adapter caps _nopn_render() at this

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

  // One-pole DC blocker step (removes the PSG's unipolar offset + thumps).
  _dcBlock(s) {
    const y = s - this._psgDcX + PSG_DC_R * this._psgDcY;
    this._psgDcX = s;
    this._psgDcY = y;
    return y;
  }

  // Render one PSG output sample: box-decimate this sample's native ticks, then
  // DC-block. Numerically identical to rendering the ticks in a single block;
  // used on the sample-accurate path where PSG writes land between samples.
  _renderPsgSample() {
    let n = Math.round(this._psgTickFrac + this._psgRatio);
    if (n < 1) n = 1;
    this._psgTickFrac += this._psgRatio - n;
    this._psg._psg_render(n);
    const heap = this._psg.HEAPF32;
    const base = this._psgBufferPtr >> 2;
    let acc = 0;
    for (let t = 0; t < n; t++) acc += heap[base + t];
    return this._dcBlock((acc / n) * PSG_OUTPUT_GAIN);
  }

  // Render `count` PSG output samples with a single _psg_render(total) call.
  // Valid only when no PSG write occurs between samples (the worklet's
  // block-quantized path) — fewer WASM boundary crossings than per-sample.
  _renderPsgBlockInto(out, count) {
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
    for (let i = 0; i < count; i++) {
      const n = counts[i];
      let acc = 0;
      for (let t = 0; t < n; t++) acc += heap[k++];
      out[i] = this._dcBlock((acc / n) * PSG_OUTPUT_GAIN);
    }
  }

  renderInto(outL, outR, count, onFrame = null, getDacByte = null) {
    // Block-quantized callers (onFrame == null) have already applied every PSG
    // write, so the whole PSG block can render in one call. Sample-accurate
    // callers render PSG per sample as writes interleave.
    let psgBlock = null;
    if (!onFrame) {
      if (!this._psgScratch || this._psgScratch.length < count) {
        this._psgScratch = new Float32Array(count);
      }
      psgBlock = this._psgScratch;
      this._renderPsgBlockInto(psgBlock, count);
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

      const psgS = onFrame ? this._renderPsgSample() : psgBlock[i];

      // FM: linear-interpolate between the current and next native samples.
      const t = this._ymFrac;
      let mixL = this._ymCurrent[0] * (1 - t) + this._ymNext[0] * t + psgS;
      let mixR = this._ymCurrent[1] * (1 - t) + this._ymNext[1] * t + psgS;
      this._ymFrac += this._resampleRatio;
      while (this._ymFrac >= 1) {
        this._ymFrac -= 1;
        this._ymCurrent = this._ymNext;
        this._ymNext = batchFM
          ? this._fmNextNative()
          : this._renderYmOne(getDacByte);
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
