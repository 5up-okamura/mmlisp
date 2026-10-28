// ---------------------------------------------------------------------------
// MSX synth core (AY-3-8910 + the SCC + the FM-PAC's YM2413)
//
// The msx sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data) — port 0 the PSG, port 3 the SCC,
// port 4 the OPLL —
// setLpf / setDacEnabled / reset, renderInto(outL, outR, count, onFrame?,
// getDacByte?, scope?). The PSG is ymfm's SSG engine (../ymfm-ay8910.js,
// wasm/ay8910_adapter.cpp), which hands out each channel's own level at
// clock / 32, unipolar; the SCC (Scc below) runs at the same rate. Their
// channels are summed, DC-blocked, and linear-interpolated to the output
// rate as synth-md.js does the YM2612's. The scope gets each channel,
// DC-blocked alike: the PSG's at the page's lanes 6-8 (the noise is channel
// C's), the SCC's at 10-14 (targets.js scopeLane).
//
// The OPLL is ymfm's YM2413 (../ymfm-ym2413.js, wasm/ym2413_adapter.cpp), at
// its own rate, clock / 72, interpolated to the output rate on its own; it
// is rendered from its first write (a cartridge a score may not have) and
// gives the scope its channels 0-5 at lanes 0-5, 6-8 at 15-17.
// ---------------------------------------------------------------------------

import createAy8910Module from "../ymfm-ay8910.js";
import createYm2413Module from "../ymfm-ym2413.js";
import { ay8910 } from "./chips/ay8910.js";
import { k051649, WAVE_LEN, sccWaveRam } from "./chips/k051649.js";
import { ym2413, OPLL_PORT, OPLL_ROM_BYTES } from "./chips/ym2413.js";
import { pitchLatches, ssgPitch, sccPitch, opllPitch } from "./scope-pitch.js";

export const AY8910_NATIVE_SAMPLE_RATE = ay8910.clock / 32;
export const YM2413_NATIVE_SAMPLE_RATE = ym2413.clock / 72;

const SAMPLE_SCALE = 1 / 32768; // int16 chip output -> float
const DC_R = 0.9995; // one-pole DC blocker (~4 Hz at the native rate)
const MAX_RENDER = 4096; // the adapters' cap on one a8_render() / ol_render()
// One channel at full level plays as loud as one of the Mega Drive's PSG
// channels at attenuation 0 (−18 dB RMS), so a score moved between the
// targets keeps its level; three at once, each starting a full step above
// its DC-blocked middle, stay under full scale. Tunable by ear.
const MASTER_OUTPUT_GAIN = 0.5;

export const SCOPE_LANES = 18;
const PSG_LANE = 6; // the page's first PSG lane
const SCC_LANE = 10; // the page's first wave lane
const SCC_CHANNELS = 5;
const CHANNELS = 3 + SCC_CHANNELS; // the PSG's three, then the SCC's five
const SCC_PORT = 3;
// One SCC channel at full volume, as a square, against one PSG channel at
// full level: the same. Tunable by ear.
const SCC_GAIN = 0.27 / 128;
// The scope's taps, on the page's scale (index.html SCOPE_DISPLAY_GAIN): a
// channel at full level peaks about where one of the Mega Drive's FM
// channels does.
const SCOPE_SCALE = 0.3;
// The OPLL against the PSG and the SCC as an MSX mixes them: MSXplay's
// (libkss) balance, measured on an MGS song with all three (tools
// ab-mgsdrv.mjs's song, each chip alone): 8.5 dB under the level one
// channel at volume 0 peaking where a Mega Drive carrier does would give.
const OPLL_GAIN = 2.25 * 10 ** (-8.5 / 20);
const OPLL_LANES = 9;
const OPLL_LANE = [0, 1, 2, 3, 4, 5, 15, 16, 17]; // a channel's scope lane

// The K051649 (chips/k051649.js): each channel steps its 32-byte wave one
// sample every period + 1 of its clocks (the MSX's 3.58 MHz, twice the
// PSG's), the step times the 4-bit volume / 16 its output, silent while
// its key bit is clear or its period is below 9 (as MAME has it).
// `run(clocks, out)` averages each channel over that many clocks into
// out[0..4], so a high tone's steps do not alias at the rate it is read
// at.
class Scc {
  constructor() {
    this.reset();
  }

  reset() {
    this.wave = new Int8Array(4 * WAVE_LEN);
    this.period = new Uint16Array(SCC_CHANNELS);
    this.vol = new Uint8Array(SCC_CHANNELS);
    this.keys = 0;
    this.pos = new Uint8Array(SCC_CHANNELS);
    this.left = new Uint16Array(SCC_CHANNELS).fill(1); // clocks to the next step
  }

  write(addr, data) {
    if (addr < 0x80) this.wave[addr] = data << 24 >> 24;
    else if (addr < 0x8a) {
      const ch = (addr - 0x80) >> 1;
      const p = this.period[ch];
      this.period[ch] = addr & 1 ? (p & 0xff) | ((data & 15) << 8) : (p & 0xf00) | data;
      this.left[ch] = Math.min(this.left[ch], this.period[ch] + 1);
    } else if (addr < 0x8f) this.vol[addr - 0x8a] = data & 15;
    else if (addr === 0x8f) this.keys = data & 0x1f;
  }

  run(clocks, out) {
    for (let ch = 0; ch < SCC_CHANNELS; ch++) {
      const period = this.period[ch];
      if (!((this.keys >> ch) & 1) || period < 9) {
        out[ch] = 0;
        continue;
      }
      const base = sccWaveRam(ch) * WAVE_LEN;
      let pos = this.pos[ch];
      let left = this.left[ch];
      let acc = 0;
      for (let rem = clocks; rem > 0; ) {
        const n = Math.min(rem, left);
        acc += this.wave[base + pos] * n;
        rem -= n;
        left -= n;
        if (left === 0) {
          pos = (pos + 1) & (WAVE_LEN - 1);
          left = period + 1;
        }
      }
      this.pos[ch] = pos;
      this.left[ch] = left;
      out[ch] = ((acc / clocks) * this.vol[ch]) / 16;
    }
  }
}

export class MsxSynth {
  static async create(outputSR) {
    const [core, opll] = await Promise.all([createAy8910Module(), createYm2413Module()]);
    return new MsxSynth(core, opll, outputSR);
  }

  constructor(core, opll, outputSR) {
    this._core = core;
    this._opll = opll;
    this._outputSR = outputSR;
    this.pitch = pitchLatches(ssgPitch(ay8910.clock), sccPitch(k051649.clock), opllPitch(ym2413.clock));
    this._scc = new Scc();
    this._sccOut = new Float32Array(SCC_CHANNELS);
    this.bus = null; // no FM to hold
    core._a8_init();
    this._bufPtr = core._a8_get_buffer_ptr();
    this.scopeLanes = SCOPE_LANES;
    this._ratio = AY8910_NATIVE_SAMPLE_RATE / outputSR;
    opll._ol_init();
    // The chip's ROM voices, the table the encoder names them from.
    opll.HEAPU8.set(OPLL_ROM_BYTES, opll._ol_get_rom_ptr());
    opll._ol_set_rom();
    this._olBufPtr = opll._ol_get_buffer_ptr();
    this._olTapPtr = opll._ol_get_tap_ptr();
    this._olRatio = YM2413_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; the MSX has no PCM here
    this._resetResampleState();
  }

  _resetResampleState() {
    this._frac = 0;
    this._dcX = new Float32Array(CHANNELS);
    this._dcY = new Float32Array(CHANNELS);
    this._cur = new Float32Array(CHANNELS);
    this._next = new Float32Array(CHANNELS);
    this._batch = 0; // samples rendered into the core's buffer
    this._batchPos = 0;
    this._nativeOne();
    this._opllOn = false; // rendered from its first write
    this._olFrac = 0;
    this._olCur = new Float32Array(1 + OPLL_LANES); // the mix, then each channel
    this._olNext = new Float32Array(1 + OPLL_LANES);
    this._olBatch = 0;
    this._olBatchPos = 0;
  }

  reset() {
    this._core._a8_reset();
    this._opll._ol_reset();
    this._scc.reset();
    this._resetResampleState();
  }

  // The PSG's one address space is port 0; the SCC's, port 3; the OPLL's,
  // port 4.
  writeYM(port, addr, data) {
    if (port === SCC_PORT) this._scc.write(addr & 0xff, data & 0xff);
    else if (port === OPLL_PORT) {
      this._opll._ol_write_reg(addr & 0xff, data & 0xff);
      this._opllOn = true;
    } else this._core._a8_write_reg(addr & 0xff, data & 0xff);
  }

  // The Mega Drive's PSG, DAC and low-pass have no counterpart here.
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  // The next native sample's channels, DC-blocked, into _next (the previous
  // ones to _cur): the PSG's from the batch rendered ahead when there is one,
  // else rendered alone (a write may have just landed); the SCC's, its 32
  // clocks run now.
  _nativeOne() {
    if (this._batchPos >= this._batch) {
      this._core._a8_render(1);
      this._batch = 1;
      this._batchPos = 0;
    }
    const swap = this._cur;
    this._cur = this._next;
    this._next = swap;
    const heap = this._core.HEAP16;
    const k = (this._bufPtr >> 1) + 3 * this._batchPos++;
    this._scc.run(64, this._sccOut); // the SCC counts at twice the PSG's clock
    for (let c = 0; c < CHANNELS; c++) {
      const x = c < 3 ? heap[k + c] * SAMPLE_SCALE : this._sccOut[c - 3] * SCC_GAIN;
      const y = x - this._dcX[c] + DC_R * this._dcY[c];
      this._dcX[c] = x;
      this._dcY[c] = y;
      swap[c] = y;
    }
  }

  // The OPLL's next native sample, into _olNext (the previous one to
  // _olCur): the mix at 0, its channels after, on the output's scale.
  _opllOne() {
    if (this._olBatchPos >= this._olBatch) {
      this._opll._ol_render(1);
      this._olBatch = 1;
      this._olBatchPos = 0;
    }
    const swap = this._olCur;
    this._olCur = this._olNext;
    this._olNext = swap;
    const heap = this._opll.HEAP16;
    const g = SAMPLE_SCALE * OPLL_GAIN;
    swap[0] = heap[(this._olBufPtr >> 1) + this._olBatchPos] * g;
    const t = (this._olTapPtr >> 1) + OPLL_LANES * this._olBatchPos++;
    for (let c = 0; c < OPLL_LANES; c++) swap[1 + c] = heap[t + c] * g;
  }

  // `getDacByte` is the contract's and unused; `scope` (SCOPE_LANES arrays)
  // gets the PSG's channels at lanes 6-8, the SCC's at 10-14, the OPLL's at
  // 0-5 and 15-17, the others silence.
  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    // With every write of the block applied, its native samples render in
    // one call; with writes landing between samples, one at a time.
    if (!onFrame) {
      const need = Math.floor(this._frac + count * this._ratio);
      if (need > 0 && need <= MAX_RENDER) {
        this._core._a8_render(need);
        this._batch = need;
        this._batchPos = 0;
      }
      const olNeed = Math.floor(this._olFrac + count * this._olRatio);
      if (this._opllOn && olNeed > 0 && olNeed <= MAX_RENDER) {
        this._opll._ol_render(olNeed);
        this._olBatch = olNeed;
        this._olBatchPos = 0;
      }
    }
    if (scope) {
      for (let c = 0; c < PSG_LANE; c++) scope[c]?.fill(0, 0, count);
      scope[PSG_LANE + 3]?.fill(0, 0, count);
      for (let c = SCC_LANE + SCC_CHANNELS; c < SCOPE_LANES; c++) scope[c]?.fill(0, 0, count);
    }
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      let mix = 0;
      for (let c = 0; c < CHANNELS; c++) {
        const v = this._cur[c] * (1 - t) + this._next[c] * t;
        mix += v;
        const lane = c < 3 ? PSG_LANE + c : SCC_LANE + c - 3;
        if (scope?.[lane]) scope[lane][i] = v * SCOPE_SCALE;
      }
      this._frac += this._ratio;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._nativeOne();
      }
      mix *= MASTER_OUTPUT_GAIN;
      // A write this sample (onFrame) may have just started the OPLL.
      if (this._opllOn) {
        const u = this._olFrac;
        mix += this._olCur[0] * (1 - u) + this._olNext[0] * u;
        if (scope)
          for (let c = 0; c < OPLL_LANES; c++) {
            const lane = scope[OPLL_LANE[c]];
            if (lane) lane[i] = this._olCur[1 + c] * (1 - u) + this._olNext[1 + c] * u;
          }
        this._olFrac += this._olRatio;
        while (this._olFrac >= 1) {
          this._olFrac -= 1;
          this._opllOne();
        }
      }
      outL[i] = outR[i] = mix > 1 ? 1 : mix < -1 ? -1 : mix;
    }
    this._batch = 0;
    this._olBatch = 0;
  }
}
