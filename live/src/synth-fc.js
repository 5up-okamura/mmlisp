// ---------------------------------------------------------------------------
// Famicom synth core (the 2A03's APU)
//
// The fc sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data) — port 0 the APU, $4000 + addr —
// setLpf / setDacEnabled / reset, renderInto(outL, outR, count, onFrame?,
// getDacByte?, scope?). The chip is the toolchain's own (Apu below), written
// from nesdev's APU pages, which Mesen follows: the pulses step their 8-step
// duty every 2 × (period + 1) CPU clocks, silent under a period of 8 or a
// sweep target over $7FF; the triangle steps its 32 steps every period + 1
// while its linear and length counters are both nonzero (else it holds its
// output); the noise clocks a 15-bit LFSR (feedback bit 0 ^ bit 1, or ^ bit
// 6 in its loop mode) at its rate's period, silent while bit 0 is set. The
// frame counter's quarter and half frames (4- or 5-step) clock the
// envelopes, the linear counter, the length counters and the sweeps. The
// mix is nesdev's nonlinear one (pulse_out + tnd_out), with $4011's DAC
// level in it (DPCM's playback is the next stage). The channels run at the
// CPU clock / 32, each averaged over those 32 clocks so a high tone does not
// alias, and are linear-interpolated to the output rate as synth-pce.js
// does; the Famicom's 37 Hz high-pass is the DC blocker. Mono: both sides
// the same. The scope gets each channel alone through the mixer, DC-blocked,
// at the page's PSG lanes 6-9 (targets.js scopeLane).
// ---------------------------------------------------------------------------

import { rp2a03 } from "./chips/rp2a03.js";
import { pitchLatches, fcPitch } from "./scope-pitch.js";

const CLOCK = rp2a03.clock;
const CLOCKS_PER_SAMPLE = 32;
export const FC_NATIVE_SAMPLE_RATE = CLOCK / CLOCKS_PER_SAMPLE;

const DC_R = Math.exp((-2 * Math.PI * 37) / FC_NATIVE_SAMPLE_RATE); // the Famicom's 37 Hz high-pass
// One pulse at volume 15 peaks where one PC Engine channel at full volume
// does (synth-pce.js): a score moved between the machines keeps its level.
// Tunable by ear.
const MASTER_OUTPUT_GAIN = 1.6;
// The scope's taps, on the page's scale (index.html SCOPE_DISPLAY_GAIN).
const SCOPE_SCALE = 0.6;

export const SCOPE_LANES = 10;
const PSG_LANE = 6; // the page's first PSG lane

const LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 0, 0],
];
const TRI = Array.from({ length: 32 }, (_, i) => (i < 16 ? 15 - i : i - 16));
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
// The frame counter's quarter frames, in CPU clocks; a half frame on the
// second and the last (4-step: every 29830, 5-step: 37282, the fourth step
// silent).
const STEPS4 = [7457, 14913, 22371, 29829];
const STEPS5 = [7457, 14913, 22371, 37281];

// nesdev's mixer: the pulses' sum, and the triangle, noise and DAC.
const pulseOut = (n) => (n > 0 ? 95.88 / (8128 / n + 100) : 0);
const tndOut = (t, n, d) => {
  const s = t / 8227 + n / 12241 + d / 22638;
  return s > 0 ? 159.79 / (1 / s + 100) : 0;
};

// An envelope (a pulse's, the noise's): its start flag, divider and decay.
const envelope = () => ({ start: false, divider: 0, decay: 0 });
function clockEnvelope(e, ctl) {
  if (e.start) {
    e.start = false;
    e.decay = 15;
    e.divider = ctl & 15;
  } else if (e.divider === 0) {
    e.divider = ctl & 15;
    if (e.decay) e.decay--;
    else if (ctl & 0x20) e.decay = 15;
  } else e.divider--;
}
const envVolume = (e, ctl) => (ctl & 0x10 ? ctl & 15 : e.decay);

class Apu {
  constructor() {
    this.reset();
  }

  reset() {
    this.pulse = [0, 1].map((n) => ({
      n, ctl: 0, sweep: 0, period: 0, length: 0, seq: 0, timer: 2,
      env: envelope(), sweepDivider: 0, sweepReload: false,
    }));
    this.tri = { ctl: 0, period: 0, length: 0, seq: 0, timer: 1, linear: 0, reload: false };
    this.noise = { ctl: 0, mode: 0, period: NOISE_PERIODS[0], length: 0, timer: NOISE_PERIODS[0], lfsr: 1, env: envelope() };
    this.dac = 0;
    this.enable = 0;
    this.frameMode = 0;
    this.frameClock = 0;
    this.frameStep = 0;
  }

  write(addr, data) {
    if (addr < 0x08) {
      const p = this.pulse[addr >> 2];
      switch (addr & 3) {
        case 0: p.ctl = data; break;
        case 1: p.sweep = data; p.sweepReload = true; break;
        case 2: p.period = (p.period & 0x700) | data; break;
        case 3:
          p.period = (p.period & 0xff) | ((data & 7) << 8);
          if (this.enable & (1 << p.n)) p.length = LENGTHS[data >> 3];
          p.seq = 0;
          p.env.start = true;
          break;
      }
      return;
    }
    const t = this.tri, nz = this.noise;
    switch (addr) {
      case 0x08: t.ctl = data; break;
      case 0x0a: t.period = (t.period & 0x700) | data; break;
      case 0x0b:
        t.period = (t.period & 0xff) | ((data & 7) << 8);
        if (this.enable & 4) t.length = LENGTHS[data >> 3];
        t.reload = true;
        break;
      case 0x0c: nz.ctl = data; break;
      case 0x0e: nz.mode = data & 0x80; nz.period = NOISE_PERIODS[data & 15]; break;
      case 0x0f:
        if (this.enable & 8) nz.length = LENGTHS[data >> 3];
        nz.env.start = true;
        break;
      case 0x11: this.dac = data & 0x7f; break;
      case 0x15:
        this.enable = data & 0x1f;
        if (!(data & 1)) this.pulse[0].length = 0;
        if (!(data & 2)) this.pulse[1].length = 0;
        if (!(data & 4)) t.length = 0;
        if (!(data & 8)) nz.length = 0;
        break;
      case 0x17:
        // 5-step mode clocks a quarter and a half frame at once.
        this.frameMode = data & 0x80;
        this.frameClock = 0;
        this.frameStep = 0;
        if (this.frameMode) { this._quarter(); this._half(); }
        break;
      default: break;
    }
  }

  // A sweep's target period: pulse 1 negates by ones' complement, pulse 2 by two's.
  _sweepTarget(p) {
    const c = p.period >> (p.sweep & 7);
    return p.sweep & 8 ? p.period - c - (p.n === 0 ? 1 : 0) : p.period + c;
  }

  _pulseMuted(p) {
    return p.period < 8 || (!(p.sweep & 8) && this._sweepTarget(p) > 0x7ff);
  }

  _quarter() {
    for (const p of this.pulse) clockEnvelope(p.env, p.ctl);
    clockEnvelope(this.noise.env, this.noise.ctl);
    const t = this.tri;
    if (t.reload) t.linear = t.ctl & 0x7f;
    else if (t.linear) t.linear--;
    if (!(t.ctl & 0x80)) t.reload = false;
  }

  _half() {
    for (const p of this.pulse) {
      if (p.length && !(p.ctl & 0x20)) p.length--;
      if (p.sweepDivider === 0 && p.sweep & 0x80 && p.sweep & 7 && !this._pulseMuted(p)) p.period = Math.max(0, this._sweepTarget(p));
      if (p.sweepDivider === 0 || p.sweepReload) {
        p.sweepDivider = (p.sweep >> 4) & 7;
        p.sweepReload = false;
      } else p.sweepDivider--;
    }
    if (this.tri.length && !(this.tri.ctl & 0x80)) this.tri.length--;
    if (this.noise.length && !(this.noise.ctl & 0x20)) this.noise.length--;
  }

  // The frame counter, advanced a block of `clocks`.
  _frame(clocks) {
    const steps = this.frameMode ? STEPS5 : STEPS4;
    this.frameClock += clocks;
    while (this.frameClock >= steps[this.frameStep]) {
      const s = this.frameStep;
      this._quarter();
      if (s === 1 || s === 3) this._half();
      if (s === 3) {
        this.frameClock -= steps[3] + 1;
        this.frameStep = 0;
      } else this.frameStep++;
    }
  }

  // Each channel's level, 0-15, averaged over `clocks`, into out[0..3].
  run(clocks, out) {
    this._frame(clocks);
    for (const p of this.pulse) {
      const v = p.length && !this._pulseMuted(p) ? envVolume(p.env, p.ctl) : 0;
      const duty = DUTY[p.ctl >> 6];
      const step = 2 * (p.period + 1);
      let acc = 0, timer = p.timer, seq = p.seq;
      for (let rem = clocks; rem > 0; ) {
        const n = Math.min(rem, timer);
        acc += duty[seq] * n;
        rem -= n;
        timer -= n;
        if (timer <= 0) {
          seq = (seq - 1) & 7;
          timer = step;
        }
      }
      p.timer = timer;
      p.seq = seq;
      out[p.n] = (acc / clocks) * v;
    }
    const t = this.tri;
    if (t.linear && t.length) {
      const step = t.period + 1;
      let acc = 0, timer = t.timer, seq = t.seq;
      for (let rem = clocks; rem > 0; ) {
        const n = Math.min(rem, timer);
        acc += TRI[seq] * n;
        rem -= n;
        timer -= n;
        if (timer <= 0) {
          seq = (seq + 1) & 31;
          timer = step;
        }
      }
      t.timer = timer;
      t.seq = seq;
      out[2] = acc / clocks;
    } else out[2] = TRI[t.seq]; // halted: it holds its output
    const nz = this.noise;
    {
      const v = nz.length ? envVolume(nz.env, nz.ctl) : 0;
      const tap = nz.mode ? 6 : 1;
      let acc = 0, timer = nz.timer, lfsr = nz.lfsr;
      for (let rem = clocks; rem > 0; ) {
        const n = Math.min(rem, timer);
        if (!(lfsr & 1)) acc += n;
        rem -= n;
        timer -= n;
        if (timer <= 0) {
          lfsr = (lfsr >> 1) | (((lfsr ^ (lfsr >> tap)) & 1) << 14);
          timer = nz.period;
        }
      }
      nz.timer = timer;
      nz.lfsr = lfsr;
      out[3] = (acc / clocks) * v;
    }
  }
}

export class FcSynth {
  static async create(outputSR) {
    return new FcSynth(outputSR);
  }

  constructor(outputSR) {
    this._outputSR = outputSR;
    this.pitch = pitchLatches(fcPitch(CLOCK));
    this._apu = new Apu();
    this._lv = new Float32Array(4);
    this._x = new Float32Array(5);
    this.bus = null; // no FM to hold
    this.scopeLanes = SCOPE_LANES;
    this._ratio = FC_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; DPCM is the next stage
    this._resetResampleState();
  }

  // Index 0 the mix, 1-4 each channel alone (the scope's).
  _resetResampleState() {
    this._frac = 0;
    this._dcX = new Float32Array(5);
    this._dcY = new Float32Array(5);
    this._cur = new Float32Array(5);
    this._next = new Float32Array(5);
    // The blocker starts settled on the chip's idle level (the halted
    // triangle holds its step's), so a run starts with no thump.
    this._mix();
    this._dcX.set(this._x);
    this._nativeOne();
  }

  reset() {
    this._apu.reset();
    this._resetResampleState();
  }

  // The APU's registers are port 0, $4000 + addr.
  writeYM(port, addr, data) {
    if (port === 0) this._apu.write(addr & 0xff, data & 0xff);
  }

  // The Mega Drive's PSG, DAC and low-pass have no counterpart here.
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  _nativeOne() {
    const swap = this._cur;
    this._cur = this._next;
    this._next = swap;
    const x = this._mix(CLOCKS_PER_SAMPLE);
    for (let c = 0; c < 5; c++) {
      const y = x[c] - this._dcX[c] + DC_R * this._dcY[c];
      this._dcX[c] = x[c];
      this._dcY[c] = y;
      swap[c] = y;
    }
  }

  // The chip run `clocks` (0: its levels as they stand) and mixed, into
  // _x: the mix, then each channel alone.
  _mix(clocks = 0) {
    const lv = this._lv;
    if (clocks) this._apu.run(clocks, lv);
    else lv.set([0, 0, TRI[this._apu.tri.seq], 0]); // idle: the triangle's held step
    const d = this._apu.dac;
    const x = this._x;
    x[0] = pulseOut(lv[0] + lv[1]) + tndOut(lv[2], lv[3], d);
    x[1] = pulseOut(lv[0]);
    x[2] = pulseOut(lv[1]);
    x[3] = tndOut(lv[2], 0, 0);
    x[4] = tndOut(0, lv[3], 0);
    return x;
  }

  // `getDacByte` is the contract's and unused; `scope` (SCOPE_LANES arrays)
  // gets the channels at lanes 6-9, the others silence.
  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    if (scope) for (let c = 0; c < PSG_LANE; c++) scope[c]?.fill(0, 0, count);
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      if (scope)
        for (let c = 0; c < 4; c++) {
          const lane = scope[PSG_LANE + c];
          if (lane) lane[i] = (this._cur[c + 1] * (1 - t) + this._next[c + 1] * t) * SCOPE_SCALE;
        }
      let v = (this._cur[0] * (1 - t) + this._next[0] * t) * MASTER_OUTPUT_GAIN;
      this._frac += this._ratio;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._nativeOne();
      }
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      outL[i] = v;
      outR[i] = v;
    }
  }
}
