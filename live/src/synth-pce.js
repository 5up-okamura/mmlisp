// ---------------------------------------------------------------------------
// PC Engine synth core (the HuC6280's PSG)
//
// The pce sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data) — port 0 the PSG —
// setLpf / setDacEnabled / reset, renderInto(outL, outR, count, onFrame?,
// getDacByte?, scope?). The chip is the toolchain's own (Pce below), written
// from MAME's c6280.cpp and Mednafen's pce_psg.cpp: each channel steps its
// 32-step wave every `frequency` chip clocks, the noise channels clock an
// 18-bit LFSR every (31 − rate) × 64 — at rate 31 every 32, as Mednafen has
// it (MAME's every clock is the one place the two part) — a channel's level
// is its 5-bit volume (1.5 dB a step) with its 4-bit left and right levels
// and the chip's main ones added (3 dB a step), capped at the table's 48
// dB. The channels run at the clock / 32, each averaged over those 32
// clocks so a high tone does not alias, and are linear-interpolated to the
// output rate as synth-md.js does the YM2612's. The scope gets each channel,
// DC-blocked, at the page's wave lanes 10-15 (targets.js scopeLane).
// ---------------------------------------------------------------------------

import { huc6280, WAVE_LEN, CHANNELS } from "./chips/huc6280.js";
import { pitchLatches, pcePitch } from "./scope-pitch.js";

const CLOCK = huc6280.clock;
const CLOCKS_PER_SAMPLE = 32;
export const PCE_NATIVE_SAMPLE_RATE = CLOCK / CLOCKS_PER_SAMPLE;

const DC_R = 0.9995; // one-pole DC blocker (~4 Hz at the native rate)
// One channel at full volume, as a square, peaks where one of the MSX's
// SCC channels does (synth-msx.js SCC_GAIN): a score moved between the
// wave machines keeps its level. Tunable by ear.
const CHANNEL_GAIN = 0.25 / 16;
const MASTER_OUTPUT_GAIN = 0.5;
// The scope's taps, on the page's scale (index.html SCOPE_DISPLAY_GAIN).
const SCOPE_SCALE = 0.3;

export const SCOPE_LANES = 16;
const WAVE_LANE = 10; // the page's first wave lane

// The 4-bit main and channel balances as 5-bit attenuations (MAME's
// scale_tab), and the 32-step level table: 1.5 dB a step, the last silent.
const SCALE_TAB = [0x00, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0d, 0x0f, 0x10, 0x13, 0x15, 0x17, 0x19, 0x1b, 0x1d, 0x1f];
const LEVEL = Array.from({ length: 32 }, (_, i) => (i === 31 ? 0 : 10 ** ((-1.5 * i) / 20)));

// The HuC6280's six channels (chips/huc6280.js). `run(clocks, outL, outR)`
// averages each channel over that many clocks into outL[ch] / outR[ch].
class Pce {
  constructor() {
    this.reset();
  }

  reset() {
    this.sel = 0;
    this.balance = 0xff;
    this.ctrl = new Uint8Array(CHANNELS);
    this.freq = new Uint16Array(CHANNELS);
    this.bal = new Uint8Array(CHANNELS).fill(0xff);
    this.wave = new Uint8Array(CHANNELS * WAVE_LEN);
    this.index = new Uint8Array(CHANNELS);
    this.tick = new Int32Array(CHANNELS).fill(1);
    this.dda = new Uint8Array(CHANNELS);
    this.noiseCtl = new Uint8Array(CHANNELS);
    this.noiseCount = new Int32Array(CHANNELS).fill(1);
    this.lfsr = new Uint32Array(CHANNELS).fill(1);
  }

  write(addr, data) {
    const ch = this.sel;
    switch (addr) {
      case 0x00: this.sel = data & 7; break;
      case 0x01: this.balance = data; break;
      case 0x02: if (ch < CHANNELS) this.freq[ch] = (this.freq[ch] & 0x0f00) | data; break;
      case 0x03: if (ch < CHANNELS) this.freq[ch] = (this.freq[ch] & 0x00ff) | ((data << 8) & 0x0f00); break;
      case 0x04:
        if (ch >= CHANNELS) break;
        // The DDA bit dropped puts the wave's step at 0; the channel turned
        // on starts its period over.
        if (this.ctrl[ch] & 0x40 && !(data & 0x40)) this.index[ch] = 0;
        if (!(this.ctrl[ch] & 0x80) && data & 0x80) this.tick[ch] = this.freq[ch] || 0x1000;
        this.ctrl[ch] = data;
        break;
      case 0x05: if (ch < CHANNELS) this.bal[ch] = data; break;
      case 0x06:
        if (ch >= CHANNELS) break;
        if (this.ctrl[ch] & 0x40) this.dda[ch] = data & 0x1f;
        else {
          this.wave[ch * WAVE_LEN + this.index[ch]] = data & 0x1f;
          if (!(this.ctrl[ch] & 0x80)) this.index[ch] = (this.index[ch] + 1) & 0x1f;
        }
        break;
      case 0x07: if (ch >= 4 && ch < CHANNELS) this.noiseCtl[ch] = data; break;
      default: break; // $08/$09, the LFO: not here yet
    }
  }

  // A channel's left and right gains: its volume, its balance and the main
  // one summed as attenuations, capped where the table ends.
  _gains(ch, out) {
    const al = 0x1f - (this.ctrl[ch] & 0x1f);
    const l = Math.min(31, (0x1f - SCALE_TAB[(this.balance >> 4) & 0x0f]) + al + (0x1f - SCALE_TAB[(this.bal[ch] >> 4) & 0x0f]));
    const r = Math.min(31, (0x1f - SCALE_TAB[this.balance & 0x0f]) + al + (0x1f - SCALE_TAB[this.bal[ch] & 0x0f]));
    out[0] = LEVEL[l];
    out[1] = LEVEL[r];
  }

  run(clocks, outL, outR) {
    const g = this._g ?? (this._g = new Float32Array(2));
    for (let ch = 0; ch < CHANNELS; ch++) {
      const ctrl = this.ctrl[ch];
      if (!(ctrl & 0x80)) {
        outL[ch] = outR[ch] = 0;
        continue;
      }
      let acc = 0;
      if (ctrl & 0x40) {
        acc = (this.dda[ch] - 16) * clocks;
      } else if (this.noiseCtl[ch] & 0x80) {
        // The LFSR, clocked every (31 − rate) × 64 clocks (rate 31: every 32).
        const reload = ((this.noiseCtl[ch] & 0x1f) ^ 0x1f) << 6 || 32;
        let count = this.noiseCount[ch], seed = this.lfsr[ch];
        for (let rem = clocks; rem > 0; ) {
          const n = Math.max(1, Math.min(rem, count));
          acc += ((seed & 1 ? 0x1f : 0) - 16) * n;
          rem -= n;
          count -= n;
          if (count <= 0) {
            seed = ((seed >>> 1) | ((((seed & 1) ^ ((seed >> 1) & 1) ^ ((seed >> 11) & 1) ^ ((seed >> 12) & 1) ^ ((seed >> 17) & 1)) << 17))) >>> 0;
            count = reload;
          }
        }
        this.noiseCount[ch] = count;
        this.lfsr[ch] = seed;
      } else {
        const step = this.freq[ch] || 0x1000;
        const base = ch * WAVE_LEN;
        let index = this.index[ch], tick = this.tick[ch];
        for (let rem = clocks; rem > 0; ) {
          const n = Math.min(rem, tick);
          acc += (this.wave[base + index] - 16) * n;
          rem -= n;
          tick -= n;
          if (tick <= 0) {
            index = (index + 1) & 0x1f;
            tick = step;
          }
        }
        this.index[ch] = index;
        this.tick[ch] = tick;
      }
      this._gains(ch, g);
      const v = acc / clocks;
      outL[ch] = v * g[0];
      outR[ch] = v * g[1];
    }
  }
}

export class PceSynth {
  static async create(outputSR) {
    return new PceSynth(outputSR);
  }

  constructor(outputSR) {
    this._outputSR = outputSR;
    this.pitch = pitchLatches(pcePitch(CLOCK));
    this._pce = new Pce();
    this._outL = new Float32Array(CHANNELS);
    this._outR = new Float32Array(CHANNELS);
    this.bus = null; // no FM to hold
    this.scopeLanes = SCOPE_LANES;
    this._ratio = PCE_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; the PC Engine has no PCM here
    this._resetResampleState();
  }

  _resetResampleState() {
    this._frac = 0;
    this._dcX = new Float32Array(2 * CHANNELS);
    this._dcY = new Float32Array(2 * CHANNELS);
    this._cur = new Float32Array(2 * CHANNELS);
    this._next = new Float32Array(2 * CHANNELS);
    this._nativeOne();
  }

  reset() {
    this._pce.reset();
    this._resetResampleState();
  }

  // The PSG's one address space is port 0.
  writeYM(port, addr, data) {
    if (port === 0) this._pce.write(addr & 0xff, data & 0xff);
  }

  // The Mega Drive's PSG, DAC and low-pass have no counterpart here.
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  // The next native sample's channels, left then right, DC-blocked, into
  // _next (the previous ones to _cur).
  _nativeOne() {
    const swap = this._cur;
    this._cur = this._next;
    this._next = swap;
    this._pce.run(CLOCKS_PER_SAMPLE, this._outL, this._outR);
    for (let c = 0; c < 2 * CHANNELS; c++) {
      const x = (c < CHANNELS ? this._outL[c] : this._outR[c - CHANNELS]) * CHANNEL_GAIN;
      const y = x - this._dcX[c] + DC_R * this._dcY[c];
      this._dcX[c] = x;
      this._dcY[c] = y;
      swap[c] = y;
    }
  }

  // `getDacByte` is the contract's and unused; `scope` (SCOPE_LANES arrays)
  // gets the channels at lanes 10-15, the others silence.
  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    if (scope) for (let c = 0; c < WAVE_LANE; c++) scope[c]?.fill(0, 0, count);
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      let l = 0, r = 0;
      for (let c = 0; c < CHANNELS; c++) {
        const vl = this._cur[c] * (1 - t) + this._next[c] * t;
        const vr = this._cur[CHANNELS + c] * (1 - t) + this._next[CHANNELS + c] * t;
        l += vl;
        r += vr;
        const lane = scope?.[WAVE_LANE + c];
        if (lane) lane[i] = (vl + vr) * 0.5 * SCOPE_SCALE;
      }
      this._frac += this._ratio;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._nativeOne();
      }
      l *= MASTER_OUTPUT_GAIN;
      r *= MASTER_OUTPUT_GAIN;
      outL[i] = l > 1 ? 1 : l < -1 ? -1 : l;
      outR[i] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
  }
}
