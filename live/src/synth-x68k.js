// ---------------------------------------------------------------------------
// X68000 synth core (YM2151: FM, its noise)
//
// The x68k sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data), setLpf / setDacEnabled / reset,
// renderInto(outL, outR, count, onFrame?, getDacByte?, scope?). The core is
// ymfm's YM2151 (../ymfm-ym2151.js, wasm/ym2151_adapter.cpp), which hands
// out samples at the chip's rate, clock / 64, linear-interpolated to the
// output rate as synth-md.js does the YM2612's. The MSM6258's ADPCM joins
// it at the chip's rate (chips/msm6258.js), held between its samples as the
// chip's DAC holds them, from `pcm8` — a source whose tick() is the next
// sample: the worklet's live mix (Pcm8Live), or a rendered stream for the
// WAV (Pcm8Stream). The scope gets each FM channel's own part, lanes 0-7,
// and each PCM8 voice's part of the mix, lanes 8-15 (Pcm8Live's; the WAV's
// stream has none).
// ---------------------------------------------------------------------------

import createYm2151Module from "../ymfm-ym2151.js";
import { ym2151, opmHoldBus } from "./chips/ym2151.js";
import { opmPitch } from "./scope-pitch.js";
import { PCM8_RATE, PCM8_VOICES, Pcm8Mixer, OkiEncoder, OkiDecoder, okiOut } from "./chips/msm6258.js";

export const YM2151_NATIVE_SAMPLE_RATE = ym2151.clock / 64;

const SAMPLE_SCALE = 1 / 32768; // int16 chip output -> float
const MAX_RENDER = 4096; // the adapter's cap on one y5_render()
// The mix as X68Sound (MXDRV's own players) makes it, measured there: one
// carrier at TL 0 peaks at 3660 of 32768 (about −19 dBFS), PCM8 at volume 8
// on a full-scale sample at 26886 (about −2 dBFS), 17 dB above it. ymfm's
// carrier is ±8192, a quarter of full scale; the ADPCM comes in at ±1.
const MASTER_OUTPUT_GAIN = 3660 / 8192;
const PCM8_GAIN = 26886 / 3660 / 4;

const FM_LANES = 8;
export const SCOPE_LANES = FM_LANES + PCM8_VOICES;

/** PCM8 played live: the mix, encoded and decoded as the chip hears it. */
export class Pcm8Live {
  constructor(bank) {
    this.mix = new Pcm8Mixer(bank);
    this.enc = new OkiEncoder();
    this.dec = new OkiDecoder();
  }
  apply(e) { this.mix.apply(e); }
  tick() { return okiOut(this.dec.next(this.enc.next(this.mix.next()))); }
  get taps() { return this.mix.taps; }
}

/** A rendered stream's decoded samples, from `startSec` (chips/msm6258.js decodePcm8). */
export class Pcm8Stream {
  constructor(samples, startSec) {
    this.samples = samples;
    this.i = -Math.round(startSec * PCM8_RATE);
  }
  tick() {
    const k = this.i++;
    return k >= 0 && k < this.samples.length ? this.samples[k] : 0;
  }
  get taps() { return null; }
}

export class X68kSynth {
  static async create(outputSR) {
    return new X68kSynth(await createYm2151Module(), outputSR);
  }

  constructor(core, outputSR) {
    this._core = core;
    this._outputSR = outputSR;
    this.pitch = opmPitch();
    this.bus = opmHoldBus;
    core._y5_init();
    this._bufPtr = core._y5_get_buffer_ptr();
    this._tapPtr = core._y5_get_tap_ptr();
    this.scopeLanes = SCOPE_LANES;
    this._tapCur = new Float32Array(SCOPE_LANES);
    this._tapNext = new Float32Array(SCOPE_LANES);
    this._ratio = YM2151_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; PCM8 is its own lane
    this.pcm8 = null; // Pcm8Live | Pcm8Stream
    this._resetResampleState();
  }

  _resetResampleState() {
    this._frac = 0;
    this._cur = [0, 0];
    this._tapCur?.fill(0);
    this._tapNext?.fill(0);
    this._batch = 0; // samples rendered into the core's buffer
    this._batchPos = 0;
    this._pcmAcc = 0; // the ADPCM's clock against the native one
    this._pcmVal = 0;
    this._next = this._nativeOne();
  }

  reset() {
    this._core._y5_reset();
    this._resetResampleState();
  }

  // The OPM has one address space: every write is port 0's.
  writeYM(_port, addr, data) {
    this._core._y5_write_reg(addr & 0xff, data & 0xff);
  }

  // The Mega Drive's PSG, DAC and low-pass have no counterpart here.
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  // The next native sample, [L, R]: from the batch rendered ahead when there
  // is one, else rendered alone (a write may have just landed). With `taps`,
  // its scope lanes go to _tapNext (the previous ones to _tapCur).
  _nativeOne(taps = false) {
    if (this._batchPos >= this._batch) {
      this._core._y5_render(1);
      this._batch = 1;
      this._batchPos = 0;
    }
    const heap = this._core.HEAP16;
    if (taps && this._tapNext) {
      const swap = this._tapCur;
      this._tapCur = this._tapNext;
      this._tapNext = swap;
      const t = (this._tapPtr >> 1) + FM_LANES * this._batchPos;
      for (let c = 0; c < FM_LANES; c++) swap[c] = heap[t + c] * SAMPLE_SCALE;
    }
    // The ADPCM's next sample when its clock comes round.
    this._pcmAcc += PCM8_RATE;
    if (this._pcmAcc >= YM2151_NATIVE_SAMPLE_RATE) {
      this._pcmAcc -= YM2151_NATIVE_SAMPLE_RATE;
      this._pcmVal = this.pcm8 ? this.pcm8.tick() : 0;
    }
    // The voices' lanes, on the chip's own scale as the FM's are.
    if (taps && this._tapNext) {
      const v = this.pcm8?.taps;
      for (let c = 0; c < PCM8_VOICES; c++) this._tapNext[FM_LANES + c] = v ? v[c] : 0;
    }
    const pcm = this._pcmVal * PCM8_GAIN;
    const k = (this._bufPtr >> 1) + 2 * this._batchPos++;
    return [heap[k] * SAMPLE_SCALE + pcm, heap[k + 1] * SAMPLE_SCALE + pcm];
  }

  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    // With every write of the block applied, its native samples render in
    // one call; with writes landing between samples, one at a time.
    if (!onFrame) {
      const need = Math.floor(this._frac + count * this._ratio);
      if (need > 0 && need <= MAX_RENDER) {
        this._core._y5_render(need);
        this._batch = need;
        this._batchPos = 0;
      }
    }
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      let mixL = this._cur[0] * (1 - t) + this._next[0] * t;
      let mixR = this._cur[1] * (1 - t) + this._next[1] * t;
      if (scope)
        for (let c = 0; c < SCOPE_LANES; c++) {
          const lane = scope[c];
          if (lane) lane[i] = this._tapCur[c] * (1 - t) + this._tapNext[c] * t;
        }
      this._frac += this._ratio;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._cur = this._next;
        this._next = this._nativeOne(!!scope);
      }
      mixL *= MASTER_OUTPUT_GAIN;
      mixR *= MASTER_OUTPUT_GAIN;
      outL[i] = mixL > 1 ? 1 : mixL < -1 ? -1 : mixL;
      outR[i] = mixR > 1 ? 1 : mixR < -1 ? -1 : mixR;
    }
    this._batch = 0;
  }
}
