// ---------------------------------------------------------------------------
// Game Boy synth core (the LR35902's APU)
//
// The gb sibling of synth-md.js, on its contract: create(outputSR), the
// register bus writeYM(port, addr, data) — port 0 the APU, $FF10 + addr —
// setLpf / setDacEnabled / reset, renderInto(outL, outR, count, onFrame?,
// getDacByte?, scope?). The chip is the toolchain's own (Apu below), written
// from Pan Docs' Audio pages and SameBoy's apu.c. The frame sequencer, 512 Hz,
// clocks the length counters at 256 Hz, the sweep at 128, the envelopes at 64.
// A pulse steps its 8-step duty every 4 × (2048 − x) clocks; a trigger does
// not move the step. The wave reads its 32 steps every 2 × (2048 − x) clocks,
// from 0 at a trigger. The noise clocks an LFSR, cleared at a trigger, that
// feeds bit 0 XNOR bit 1 into bit 14 (and bit 6 when narrow), bit 0 its
// output. A write to NRx2 on a playing pulse or noise is SameBoy's
// nrx2_glitch (DMG's two-step reading, zombie mode: chips/lr35902.js) with no
// envelope clock in progress, which 32-clock steps cannot resolve.
//
// Each DAC turns 0..15 into +1..−1, and off is 0, so turning one off is a step
// (a pop) and a channel's volume is DC: the mix's high-pass, the console's
// capacitor (0.999958 a clock, the figure for the DMG), takes it out. The
// channels run at the clock / 32, each averaged over those 32 clocks so a high tone does not
// alias, and are linear-interpolated to the output rate as synth-pce.js does.
// The scope gets each channel DC-blocked at the PSG lanes 6, 7, 9 and the wave
// lane 10 (targets.js scopeLane).
// ---------------------------------------------------------------------------

import { lr35902 } from "../machine/chips/lr35902.js";
import { pitchLatches, gbPitch } from "./scope-pitch.js";

const CLOCK = lr35902.clock;
const CLOCKS_PER_SAMPLE = 32;
const NATIVE_SAMPLE_RATE = CLOCK / CLOCKS_PER_SAMPLE;
const FRAME_SEQ_CLOCKS = 8192; // 512 Hz
const HPF = 0.999958 ** CLOCKS_PER_SAMPLE;
const DC_R = 0.9995; // the scope's one-pole DC blocker
// One pulse at full and 50 % has the RMS of a 2A03 pulse at full through
// synth-fc.js's mix. Tunable by ear.
const MASTER_OUTPUT_GAIN = 0.12;
// The scope's taps, on the page's scale (index.html SCOPE_DISPLAY_GAIN).
const SCOPE_SCALE = 0.3;

export const SCOPE_LANES = 11;
const SCOPE_OF = [6, 7, 10, 9]; // the channels' lanes: pulses, wave, noise
const DUTY = [0x80, 0x81, 0xe1, 0x7e]; // each step a bit, SameBoy's table
const WAVE_SHIFT = [4, 0, 1, 2]; // NR32's code as a right shift
const CHANNELS = 4;

// A pulse or the noise: what NRx2 and the length counter govern.
class Envelope {
  constructor() {
    this.volume = 0;
    this.count = 0;
    this.locked = false;
  }
  trigger(nrx2) {
    this.volume = nrx2 >> 4;
    this.count = nrx2 & 7;
    this.locked = false;
  }
  // The 64 Hz clock.
  tick(nrx2) {
    const pace = nrx2 & 7;
    if (this.locked || !pace) return;
    if (--this.count > 0) return;
    this.count = pace;
    if (nrx2 & 8) {
      if (this.volume < 15) this.volume++;
      if (this.volume === 15) this.locked = true;
    } else {
      if (this.volume > 0) this.volume--;
      if (this.volume === 0) this.locked = true;
    }
  }
  // SameBoy's _nrx2_glitch.
  _glitch(value, old) {
    let tick = !!(value & 7) && !(old & 7) && !this.locked;
    if ((value & 15) === 8 && (old & 15) === 8 && !this.locked) tick = true;
    if ((value & 8) !== (old & 8)) {
      if (value & 8) {
        this.volume = !(old & 7) && !this.locked ? this.volume ^ 15 : (14 - this.volume) & 15;
        tick = false;
      } else this.volume = (16 - this.volume) & 15;
    }
    if (tick) this.volume = (this.volume + (value & 8 ? 1 : -1)) & 15;
  }
  // A write on a playing channel, as the DMG takes it (nrx2_glitch).
  write(value, old) {
    this._glitch(0xff, old);
    this._glitch(value, 0xff);
  }
}

export class Apu {
  constructor() {
    this.reset();
  }

  reset() {
    this.r = new Uint8Array(0x30);
    // A rip need not write NR52 or NR50 / NR51: the boot ROM's values.
    this.power = true;
    this.r[0x14] = 0x77;
    this.r[0x15] = 0xf3;
    this.charge = false; // the power just came on (GbSynth's capacitor)
    this.seqCount = FRAME_SEQ_CLOCKS;
    this.seqStep = 0;
    this.on = [false, false, false, false];
    this.length = [0, 0, 0, 0];
    this.env = [new Envelope(), new Envelope(), null, new Envelope()];
    this.timer = [1, 1, 1, 1];
    this.duty = [0, 0];
    this.wavePos = 0;
    this.lfsr = 0;
    this.sweep = { shadow: 0, timer: 0, enabled: false, negated: false };
    this.out = new Float32Array(CHANNELS);
  }

  _nrx2(ch) { return this.r[ch === 3 ? 0x11 : 2 + 5 * ch]; }
  dac(ch) { return ch === 2 ? !!(this.r[0x0a] & 0x80) : (this._nrx2(ch) & 0xf8) !== 0; }
  _base(ch) { return [0x01, 0x06, 0x0b, 0x10][ch]; } // NRx1
  period(ch) { const b = this._base(ch); return this.r[b + 2] | ((this.r[b + 3] & 7) << 8); }

  // The clocks a channel's unit takes a step.
  _reload(ch) {
    if (ch === 3) {
      const n = this.r[0x12];
      return ((n & 7 || 0.5) * 16) << (n >> 4);
    }
    return (2048 - this.period(ch)) * (ch === 2 ? 2 : 4);
  }

  _trigger(ch) {
    if (this.dac(ch)) this.on[ch] = true;
    if (!this.length[ch]) this.length[ch] = ch === 2 ? 256 : 64;
    this.timer[ch] = this._reload(ch);
    if (ch === 2) this.wavePos = 0;
    else this.env[ch].trigger(this._nrx2(ch));
    if (ch === 3) this.lfsr = 0;
    if (ch === 0) this._sweepStart();
  }

  // The sweep's new period, and the channel off past $7FF.
  _sweepNext() {
    const s = this.sweep, nr10 = this.r[0];
    const delta = s.shadow >> (nr10 & 7);
    s.negated = !!(nr10 & 8);
    const next = s.negated ? s.shadow - delta : s.shadow + delta;
    if (next > 0x7ff) this.on[0] = false;
    return next;
  }

  _sweepStart() {
    const s = this.sweep, nr10 = this.r[0];
    s.shadow = this.period(0);
    s.timer = (nr10 >> 4) & 7 || 8;
    s.enabled = !!(nr10 & 0x77);
    s.negated = false;
    if (nr10 & 7) this._sweepNext();
  }

  _sweepTick() {
    const s = this.sweep, nr10 = this.r[0];
    if (--s.timer > 0) return;
    s.timer = (nr10 >> 4) & 7 || 8;
    if (!s.enabled || !((nr10 >> 4) & 7)) return;
    const next = this._sweepNext();
    if (next <= 0x7ff && nr10 & 7) {
      s.shadow = next;
      this.r[3] = next & 0xff;
      this.r[4] = (this.r[4] & 0xf8) | (next >> 8);
      this._sweepNext();
    }
  }

  write(a, d) {
    if (a >= 0x20 && a < 0x30) { this.r[a] = d; return; }
    if (a === 0x16) {
      const was = this.power;
      this.power = !!(d & 0x80);
      if (was && !this.power) {
        this.r.fill(0, 0, 0x16);
        this.on.fill(false);
      } else if (!was && this.power) this.seqStep = 0;
      this.charge = this.power;
      this.r[a] = d & 0x80;
      return;
    }
    if (a > 0x16 || !this.power) return;
    const old = this.r[a];
    this.r[a] = d;
    switch (a) {
      case 0x00:
        // Negate taken away after a negated calculation turns the channel off.
        if (this.sweep.negated && !(d & 8)) this.on[0] = false;
        break;
      case 0x01: case 0x06: case 0x10:
        this.length[(a - 1) / 5 | 0] = 64 - (d & 63);
        break;
      case 0x0b: this.length[2] = 256 - d; break;
      case 0x02: case 0x07: case 0x11: {
        const ch = a === 0x11 ? 3 : (a - 2) / 5;
        if (!(d & 0xf8)) this.on[ch] = false;
        else if (this.on[ch]) this.env[ch].write(d, old);
        break;
      }
      case 0x0a: if (!(d & 0x80)) this.on[2] = false; break;
      case 0x04: case 0x09: case 0x0e: case 0x13:
        if (d & 0x80) this._trigger((a - 4) / 5);
        break;
      default: break;
    }
  }

  clockSequencer() {
    const step = this.seqStep;
    this.seqStep = (step + 1) & 7;
    if (!(step & 1)) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        const nrx4 = this.r[this._base(ch) + 3];
        if (nrx4 & 0x40 && this.length[ch] && --this.length[ch] === 0) this.on[ch] = false;
      }
    }
    if (step === 2 || step === 6) this._sweepTick();
    if (step === 7) for (const ch of [0, 1, 3]) this.env[ch].tick(this._nrx2(ch));
  }

  // A pulse's or the wave's channel over `clocks`: the digital sum.
  _tone(ch, clocks) {
    const reload = this._reload(ch);
    let timer = this.timer[ch], acc = 0;
    if (ch === 2) {
      const shift = WAVE_SHIFT[(this.r[0x0c] >> 5) & 3];
      let pos = this.wavePos;
      for (let rem = clocks; rem > 0; ) {
        const n = Math.min(rem, timer);
        const b = this.r[0x20 + (pos >> 1)];
        acc += ((pos & 1 ? b & 15 : b >> 4) >> shift) * n;
        rem -= n;
        timer -= n;
        if (timer <= 0) { pos = (pos + 1) & 31; timer = reload; }
      }
      this.wavePos = pos;
    } else {
      const mask = DUTY[this.r[this._base(ch)] >> 6], volume = this.env[ch].volume;
      let pos = this.duty[ch];
      for (let rem = clocks; rem > 0; ) {
        const n = Math.min(rem, timer);
        if ((mask >> pos) & 1) acc += volume * n;
        rem -= n;
        timer -= n;
        if (timer <= 0) { pos = (pos + 1) & 7; timer = reload; }
      }
      this.duty[ch] = pos;
    }
    this.timer[ch] = timer;
    return acc;
  }

  _noise(clocks) {
    const reload = this._reload(3), narrow = this.r[0x12] & 8, volume = this.env[3].volume;
    let timer = this.timer[3], lfsr = this.lfsr, acc = 0;
    for (let rem = clocks; rem > 0; ) {
      const n = Math.min(rem, timer);
      if (lfsr & 1) acc += volume * n;
      rem -= n;
      timer -= n;
      if (timer <= 0) {
        const bit = (lfsr ^ (lfsr >> 1) ^ 1) & 1;
        lfsr >>= 1;
        if (bit) lfsr |= narrow ? 0x4040 : 0x4000;
        else if (narrow) lfsr &= ~0x40;
        timer = reload;
      }
    }
    this.lfsr = lfsr;
    this.timer[3] = timer;
    return acc;
  }

  // Each channel's analog output, averaged over `clocks`, into `out`.
  run(clocks) {
    this.seqCount -= clocks;
    if (this.seqCount <= 0) {
      this.seqCount += FRAME_SEQ_CLOCKS;
      if (this.power) this.clockSequencer();
    }
    for (let ch = 0; ch < CHANNELS; ch++) {
      if (!this.power || !this.dac(ch)) { this.out[ch] = 0; continue; }
      const sum = !this.on[ch] ? 0 : ch === 3 ? this._noise(clocks) : this._tone(ch, clocks);
      this.out[ch] = 1 - sum / (7.5 * clocks);
    }
  }
}

export class GbSynth {
  static async create(outputSR) {
    return new GbSynth(outputSR);
  }

  constructor(outputSR) {
    this.pitch = pitchLatches(gbPitch(CLOCK));
    this._apu = new Apu();
    this.bus = null; // no FM to hold
    this.scopeLanes = SCOPE_LANES;
    this._ratio = NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; the Game Boy has no PCM here
    this._resetResampleState();
  }

  _resetResampleState() {
    this._frac = 0;
    this._capL = 0;
    this._capR = 0;
    this._dcX = new Float32Array(CHANNELS);
    this._dcY = new Float32Array(CHANNELS);
    this._cur = new Float32Array(2 + CHANNELS);
    this._next = new Float32Array(2 + CHANNELS);
    this._nativeOne();
  }

  reset() {
    this._apu.reset();
    this._resetResampleState();
  }

  writeYM(port, addr, data) {
    if (port === 0) this._apu.write(addr & 0xff, data & 0xff);
  }

  // The Mega Drive's PSG, DAC and low-pass have no counterpart here.
  writePSG() {}
  setDacEnabled() {}
  setDacSample() {}
  setLpf() {}

  // The next native sample: left, right, then each channel, into _next (the
  // previous ones to _cur).
  _nativeOne() {
    const swap = this._cur;
    this._cur = this._next;
    this._next = swap;
    const apu = this._apu;
    apu.run(CLOCKS_PER_SAMPLE);
    const sides = apu.r[0x15], nr50 = apu.r[0x14];
    let l = 0, r = 0;
    for (let c = 0; c < CHANNELS; c++) {
      const x = apu.out[c];
      if (sides & (0x10 << c)) l += x;
      if (sides & (1 << c)) r += x;
      const y = x - this._dcX[c] + DC_R * this._dcY[c];
      this._dcX[c] = x;
      this._dcY[c] = y;
      swap[2 + c] = y;
    }
    l *= (((nr50 >> 4) & 7) + 1) / 8;
    r *= ((nr50 & 7) + 1) / 8;
    // A song turns its DACs on as it starts, a step of up to the four
    // channels' +1 that would be a thump: the capacitor starts charged to it.
    if (apu.charge) {
      this._capL = l;
      this._capR = r;
      apu.charge = false;
    }
    const yl = l - this._capL, yr = r - this._capR;
    this._capL = l - yl * HPF;
    this._capR = r - yr * HPF;
    swap[0] = yl;
    swap[1] = yr;
  }

  // `getDacByte` is the contract's and unused; `scope` (SCOPE_LANES arrays)
  // gets the channels at their lanes, the others silence.
  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    if (scope) for (let c = 0; c < 6; c++) scope[c]?.fill(0, 0, count);
    scope?.[8]?.fill(0, 0, count);
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      const l = (this._cur[0] * (1 - t) + this._next[0] * t) * MASTER_OUTPUT_GAIN;
      const r = (this._cur[1] * (1 - t) + this._next[1] * t) * MASTER_OUTPUT_GAIN;
      if (scope)
        for (let c = 0; c < CHANNELS; c++) {
          const lane = scope[SCOPE_OF[c]];
          if (lane) lane[i] = (this._cur[2 + c] * (1 - t) + this._next[2 + c] * t) * SCOPE_SCALE;
        }
      this._frac += this._ratio;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._nativeOne();
      }
      outL[i] = l > 1 ? 1 : l < -1 ? -1 : l;
      outR[i] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
  }
}
