// ---------------------------------------------------------------------------
// PC-8801 synth core (YM2608: FM, SSG, rhythm, ADPCM-B)
//
// The pc88 sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data), setLpf / setDacEnabled / reset,
// renderInto(outL, outR, count, onFrame?, getDacByte?, scope?). The core is
// ymfm's YM2608 (../ymfm-ym2608.js, wasm/ym2608_adapter.cpp), which hands
// out samples at the chip's FM rate, clock / 144: FM with the rhythm and the
// ADPCM-B mixed in by the chip, and the SSG apart. Here the SSG is DC-blocked
// and mixed in at SSG_GAIN, and the sum linear-interpolated to the output
// rate as synth-md.js does the YM2612's.
//
// The chip reads two memories through the host: the rhythm ROM (setRhythmRom;
// Yamaha's, which the user brings — without it the rhythm is not keyed) and the
// ADPCM-B's RAM (setAdpcmRam, chips/adpcm-b.js bakeAdpcmB's image).
//
// The scope gets each sound's own part (SCOPE_LANES): the core keeps every
// channel's output beside the mix, and they are interpolated on the same time
// axis, scaled to their share of it — the SSG's DC-blocked as its mix is.
// ---------------------------------------------------------------------------

import createYm2608Module from "../ymfm-ym2608.js";
import { ym2608 } from "./chips/ym2608.js";

export const YM2608_NATIVE_SAMPLE_RATE = ym2608.clock / 144;
export const RHYTHM_ROM_BYTES = 0x2000;

const SAMPLE_SCALE = 1 / 32768; // int16 chip output -> float
// The levels are mucom88 1.7's (fmgen, its SSG at -3 dB), measured on one
// note each, the same registers through both: an FM voice at full level plays
// 6 dB louder there than ymfm's 1 / 32768, and one SSG channel at full level
// sits 8 dB lower beside it than ymfm's own sum (its VGM renderer adds the
// SSG at unity). The ADPCM-B stays as ymfm mixes it into the FM, ~3 dB above
// mucom88's. Tunable by ear.
const SSG_GAIN = 0.4;
const SSG_DC_R = 0.9995; // one-pole DC blocker (~4 Hz at the native rate)
const MAX_RENDER = 4096; // the adapter's cap on one y8_render()
const MASTER_OUTPUT_GAIN = 2.0;

// The scope's lanes (the page's SCOPE_CH, the Mega Drive's numbering where
// they share a kind): FM 1-6 at 0-5, SSG A-C at 6-8, the ADPCM-B at 10, the
// rhythm's BD SD TOP HH TOM RIM at 11-16. The core's sixteen taps come in that
// order without the gap at 9.
export const SCOPE_LANES = 17;
const TAPS = 16;
const TAP_LANE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16];
const SSG_TAP_SCALE = (2 / 3) * SSG_GAIN * SAMPLE_SCALE; // the core sums the three × 2/3

export class Pc88Synth {
  static async create(outputSR) {
    return new Pc88Synth(await createYm2608Module(), outputSR);
  }

  constructor(core, outputSR) {
    this._core = core;
    this._outputSR = outputSR;
    core._y8_init();
    this._bufPtr = core._y8_get_buffer_ptr();
    this._tapPtr = core._y8_get_tap_ptr();
    this.scopeLanes = SCOPE_LANES;
    this._tapCur = new Float32Array(TAPS);
    this._tapNext = new Float32Array(TAPS);
    this._tapDcX = new Float32Array(3);
    this._tapDcY = new Float32Array(3);
    this._ratio = YM2608_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; this chip's PCM is its own
    this._resetResampleState();
  }

  _resetResampleState() {
    this._frac = 0;
    this._dcX = 0;
    this._dcY = 0;
    this._cur = [0, 0];
    this._tapCur?.fill(0);
    this._tapNext?.fill(0);
    this._tapDcX?.fill(0);
    this._tapDcY?.fill(0);
    this._batch = 0; // samples rendered into the core's buffer
    this._batchPos = 0;
    this._next = this._nativeOne();
  }

  reset() {
    this._core._y8_reset();
    this._resetResampleState();
  }

  writeYM(port, addr, data) {
    this._core._y8_write_reg(port & 1, addr & 0xff, data & 0xff);
  }

  /** The rhythm ROM (8 KB), or null for none: the rhythm then plays silence. */
  setRhythmRom(bytes) {
    const p = this._core._y8_get_rom_ptr();
    if (bytes?.length) this._core.HEAPU8.set(bytes.subarray(0, RHYTHM_ROM_BYTES), p);
    this._core._y8_set_rom_loaded(bytes?.length ? 1 : 0);
  }

  /** The ADPCM-B's RAM image (from address 0), or null for none. */
  setAdpcmRam(bytes) {
    const p = this._core._y8_get_ram_ptr();
    if (bytes?.length) this._core.HEAPU8.set(bytes.subarray(0, 256 * 1024), p);
  }

  // The SN76489, the YM2612's DAC and the Mega Drive Model 1's analog
  // low-pass have no counterpart here: a Mega Drive score's writes that
  // reach this synth (one still running to its next bar) go nowhere.
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  // The next native sample, [L, R]: from the batch rendered ahead when there
  // is one, else rendered alone (a write may have just landed). With `taps`,
  // its scope lanes go to _tapNext (the previous ones to _tapCur).
  _nativeOne(taps = false) {
    if (this._batchPos >= this._batch) {
      this._core._y8_render(1);
      this._batch = 1;
      this._batchPos = 0;
    }
    const heap = this._core.HEAP16;
    if (taps && this._tapNext) {
      const swap = this._tapCur;
      this._tapCur = this._tapNext;
      this._tapNext = swap;
      const t = (this._tapPtr >> 1) + TAPS * this._batchPos;
      for (let c = 0; c < TAPS; c++) {
        const v = heap[t + c];
        if (c >= 6 && c < 9) {
          const j = c - 6, y = v - this._tapDcX[j] + SSG_DC_R * this._tapDcY[j];
          this._tapDcX[j] = v;
          this._tapDcY[j] = y;
          swap[c] = y * SSG_TAP_SCALE;
        } else swap[c] = v * SAMPLE_SCALE;
      }
    }
    const k = (this._bufPtr >> 1) + 3 * this._batchPos++;
    const s = heap[k + 2];
    const ssg = s - this._dcX + SSG_DC_R * this._dcY;
    this._dcX = s;
    this._dcY = ssg;
    return [(heap[k] + ssg * SSG_GAIN) * SAMPLE_SCALE, (heap[k + 1] + ssg * SSG_GAIN) * SAMPLE_SCALE];
  }

  // `getDacByte` is the contract's and unused; `scope` (SCOPE_LANES arrays)
  // gets each sound's lane, lane 9 silence.
  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    // With every write of the block applied, its native samples render in
    // one call; with writes landing between samples, one at a time.
    if (!onFrame) {
      const need = Math.floor(this._frac + count * this._ratio);
      if (need > 0 && need <= MAX_RENDER) {
        this._core._y8_render(need);
        this._batch = need;
        this._batchPos = 0;
      }
    }
    if (scope) scope[9]?.fill(0, 0, count);
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      let mixL = this._cur[0] * (1 - t) + this._next[0] * t;
      let mixR = this._cur[1] * (1 - t) + this._next[1] * t;
      if (scope)
        for (let c = 0; c < TAPS; c++) {
          const lane = scope[TAP_LANE[c]];
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
