// ---------------------------------------------------------------------------
// X68000 synth core (YM2151: FM, its noise)
//
// The x68k sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data), setLpf / setDacEnabled / reset,
// renderInto(outL, outR, count, onFrame?, getDacByte?, scope?). The core is
// ymfm's YM2151 (../ymfm-ym2151.js, wasm/ym2151_adapter.cpp), which hands
// out samples at the chip's rate, clock / 64, linear-interpolated to the
// output rate as synth-md.js does the YM2612's. The scope gets each FM
// channel's own part, lanes 0-7.
// ---------------------------------------------------------------------------

import createYm2151Module from "../ymfm-ym2151.js";
import { ym2151 } from "./chips/ym2151.js";

export const YM2151_NATIVE_SAMPLE_RATE = ym2151.clock / 64;

const SAMPLE_SCALE = 1 / 32768; // int16 chip output -> float
const MAX_RENDER = 4096; // the adapter's cap on one y5_render()
// One carrier at TL 0 through ymfm's OPM (±8192) peaks where the Mega
// Drive's does through Nuked at its gain (about −12 dBFS), so a score moved
// between the targets keeps its level. Tunable by ear.
const MASTER_OUTPUT_GAIN = 1.0;

export const SCOPE_LANES = 8;

export class X68kSynth {
  static async create(outputSR) {
    return new X68kSynth(await createYm2151Module(), outputSR);
  }

  constructor(core, outputSR) {
    this._core = core;
    this._outputSR = outputSR;
    core._y5_init();
    this._bufPtr = core._y5_get_buffer_ptr();
    this._tapPtr = core._y5_get_tap_ptr();
    this.scopeLanes = SCOPE_LANES;
    this._tapCur = new Float32Array(SCOPE_LANES);
    this._tapNext = new Float32Array(SCOPE_LANES);
    this._ratio = YM2151_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; this chip has no PCM yet
    this._resetResampleState();
  }

  _resetResampleState() {
    this._frac = 0;
    this._cur = [0, 0];
    this._tapCur?.fill(0);
    this._tapNext?.fill(0);
    this._batch = 0; // samples rendered into the core's buffer
    this._batchPos = 0;
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
      const t = (this._tapPtr >> 1) + SCOPE_LANES * this._batchPos;
      for (let c = 0; c < SCOPE_LANES; c++) swap[c] = heap[t + c] * SAMPLE_SCALE;
    }
    const k = (this._bufPtr >> 1) + 2 * this._batchPos++;
    return [heap[k] * SAMPLE_SCALE, heap[k + 1] * SAMPLE_SCALE];
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
