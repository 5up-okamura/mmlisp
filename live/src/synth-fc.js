// ---------------------------------------------------------------------------
// Famicom synth core (the 2A03's APU and its expansions)
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
// DMC reads its sample's bytes from the memory (port 1, chips/rp2a03.js
// RAM_PORT) a byte a time into its buffer, and every rate period its
// output unit moves the 7-bit DAC 2 up or down by the next bit (up below
// 126, down above 1), silent while its buffer was empty; at the sample's
// end it starts over (the loop bit) or stops. The mix is nesdev's nonlinear
// one (pulse_out + tnd_out), the DAC in it. The channels run at the
// CPU clock / 32, each averaged over those 32 clocks so a high tone does not
// alias, and are linear-interpolated to the output rate as synth-pce.js
// does; the Famicom's 37 Hz high-pass is the DC blocker. Mono: both sides
// the same. The scope gets each channel alone through the mixer, DC-blocked,
// at the page's PSG lanes 6-9 and the DMC at its first sample lane, 10
// (targets.js scopeLane).
//
// The VRC6 cartridge (port 3, chips/vrc6.js) beside it, from nesdev's VRC6
// audio page: each pulse steps a 16-step counter down every period + 1
// clocks and sounds its volume where the step is at most its duty D (or
// always, under its mode bit); the saw steps every period + 1 too, adding
// its rate to an 8-bit accumulator on every other step (wrapping, as
// NSFPlay's does) and clearing it each 14th, its top five bits out. The
// frequency control's halt stops them, its 16× / 256× shift their periods.
// Its DAC is linear, a pulse at full about a 2A03 pulse at full (nesdev),
// and inverted against the 2A03's; its channels go to the scope at 11-13.
//
// The Disk System's wavetable (port 4, chips/fds.js), from nesdev's FDS
// audio page: every 16 clocks its modulation unit adds its rate to a 12-bit
// accumulator and, on each carry, applies its table's next half-step (each
// of the 32 entries twice) to a 7-bit signed counter; the counter times the
// depth scales the pitch (nesdev's arithmetic, rounding and all), which the
// wave unit adds to a 24-bit accumulator whose top six bits are the step.
// The output is the step's level times the gain (stopping at 32) times the
// master volume, held while the memory is open to writes; at full it is
// 2.4 times a 2A03 pulse at full (nesdev), through its ~2 kHz low-pass, on
// the scope's lane 14. Its volume and modulation envelopes are not run: the
// toolchain writes the gains direct.
//
// The MMC5's two pulses (port 5, chips/mmc5.js), from nesdev's MMC5 audio
// page: the 2A03's pulses with no sweep (a period under 8 sounds), their
// envelopes and length counters clocked together every quarter frame
// (~240 Hz, the chip's own timer), their DAC linear and inverted, a pulse
// at full as loud as a 2A03 pulse at full; on the scope's lanes 15-16.
//
// The Sunsoft 5B (port 6, chips/sunsoft-5b.js) is ymfm's SSG engine
// (../ymfm-ay8910.js, wasm/ay8910_adapter.cpp: the YM2149's 32-step DAC),
// clocked as the 5B is, an AY at half the CPU's clock: one of its samples
// is 64 CPU clocks, two of the 2A03's, each held for both. It is rendered
// from its first write; a channel at full as loud as a 2A03 pulse at full
// (nesdev gives no measure: tunable by ear); on the scope's lanes 17-19.
// ---------------------------------------------------------------------------

import createAy8910Module from "../ymfm-ay8910.js";
import { rp2a03, RAM_PORT, DMC_PERIODS, NOISE_PERIODS } from "./chips/rp2a03.js";
import { sunsoft5b } from "./chips/sunsoft-5b.js";
import { pitchLatches, fcPitch, vrc6Pitch, fdsPitch, mmc5Pitch, ssgPitch } from "./scope-pitch.js";
import { fdsRegister } from "./chips/fds.js";

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

export const SCOPE_LANES = 20;
const PSG_LANE = 6; // the page's first PSG lane
// Pulse 1, pulse 2, the triangle, the noise, the DMC, the VRC6's pulses and
// saw, the FDS, the MMC5's pulses, the 5B's three.
const CHANNELS = 14;
const VRC6_PORT = 3;
const FDS_PORT = 4;
const MMC5_PORT = 5;
const S5B_PORT = 6;
// The 5B's sample (ymfm's, unipolar 0-16382 a channel) as a 2A03 pulse's
// 0-15, and the CPU clocks one of them lasts.
const S5B_LEVEL = 15 / 16382;
const S5B_CLOCKS = 64;
// The FDS at full (level 63, gain 32, master full) is 2.4 times a 2A03
// pulse at full (nesdev), its polarity the 2A03's; its ~2 kHz low-pass.
const FDS_STEP = (2.4 * 95.88) / (8128 / 15 + 100) / (63 * 32);
const FDS_LPF = 1 - Math.exp((-2 * Math.PI * 2000) / FC_NATIVE_SAMPLE_RATE);
const FDS_MASTER = [1, 2 / 3, 2 / 4, 2 / 5];
const FDS_MOD_DELTA = [0, 1, 2, 4, null, -4, -2, -1]; // null: the counter back to 0
// A cartridge's linear DAC (the VRC6's, the MMC5's), a step's share of the
// mix: a pulse at 15 where a 2A03 pulse at 15 is (nesdev), the VRC6 saw's
// five bits on the same scale.
const PULSE_STEP = 95.88 / (8128 / 15 + 100) / 15;
// The MMC5's quarter frame: its own timer, about 240 Hz.
const MMC5_FRAME = 7457;

const LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 0, 0],
];
const TRI = Array.from({ length: 32 }, (_, i) => (i < 16 ? 15 - i : i - 16));
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
    // The CPU's memory from $8000 (the DMC's address wraps there) and its
    // writer's address.
    this.mem = new Uint8Array(0x8000);
    this.ramAddr = 0;
    this.dmc = {
      ctl: 0, addr: 0xc000, len: 1, cur: 0xc000, remaining: 0, buffer: -1,
      shift: 0, bits: 8, silent: true, timer: DMC_PERIODS[0],
    };
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
      case 0x10: this.dmc.ctl = data; break;
      case 0x11: this.dac = data & 0x7f; break;
      case 0x12: this.dmc.addr = 0xc000 + data * 64; break;
      case 0x13: this.dmc.len = data * 16 + 1; break;
      case 0x15: {
        this.enable = data & 0x1f;
        if (!(data & 1)) this.pulse[0].length = 0;
        if (!(data & 2)) this.pulse[1].length = 0;
        if (!(data & 4)) t.length = 0;
        if (!(data & 8)) nz.length = 0;
        // The DMC: cleared, it stops; set with nothing left, it starts over.
        const m = this.dmc;
        if (!(data & 0x10)) m.remaining = 0;
        else if (!m.remaining) {
          m.cur = m.addr;
          m.remaining = m.len;
          if (m.buffer < 0) this._dmcFetch();
        }
        break;
      }
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

  // A write on the memory's port (chips/rp2a03.js RAM_PORT): the address's
  // low and high byte, then the bytes, the address moving on.
  writeRam(addr, data) {
    if (addr === 0x00) this.ramAddr = (this.ramAddr & 0xff00) | data;
    else if (addr === 0x01) this.ramAddr = (data << 8) | (this.ramAddr & 0xff);
    else if (addr === 0x02) {
      if (this.ramAddr >= 0x8000) this.mem[this.ramAddr - 0x8000] = data;
      this.ramAddr = (this.ramAddr + 1) & 0xffff;
    }
  }

  // The DMC's reader: the next byte into its buffer; at the sample's end it
  // starts over (the loop bit) or is done.
  _dmcFetch() {
    const m = this.dmc;
    if (!m.remaining) return;
    m.buffer = this.mem[m.cur - 0x8000];
    m.cur = m.cur === 0xffff ? 0x8000 : m.cur + 1;
    if (--m.remaining === 0 && m.ctl & 0x40) {
      m.cur = m.addr;
      m.remaining = m.len;
    }
  }

  // The DMC's output unit over `clocks`: the DAC's level averaged over them.
  _runDmc(clocks) {
    const m = this.dmc;
    const period = DMC_PERIODS[m.ctl & 15];
    let acc = 0;
    for (let rem = clocks; rem > 0; ) {
      const n = Math.min(rem, m.timer);
      acc += this.dac * n;
      rem -= n;
      m.timer -= n;
      if (m.timer > 0) continue;
      m.timer = period;
      if (!m.silent) {
        if (m.shift & 1) { if (this.dac <= 125) this.dac += 2; } else if (this.dac >= 2) this.dac -= 2;
      }
      m.shift >>= 1;
      if (--m.bits === 0) {
        m.bits = 8;
        if (m.buffer < 0) m.silent = true;
        else {
          m.silent = false;
          m.shift = m.buffer;
          m.buffer = -1;
          this._dmcFetch();
        }
      }
    }
    return acc / clocks;
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

  // Each channel's level, 0-15 (the DAC 0-127), averaged over `clocks`,
  // into out[0..4].
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
    out[4] = this._runDmc(clocks);
  }
}

// The VRC6 (port 3: $9000-$B002 as (high nibble − 9) × 4 + the low bits).
class Vrc6 {
  constructor() {
    this.reset();
  }

  reset() {
    this.pulse = [0, 1].map(() => ({ ctl: 0, period: 0, enable: false, step: 15, timer: 1 }));
    this.saw = { rate: 0, period: 0, enable: false, step: 0, acc: 0, timer: 1 };
    this.freqCtl = 0;
  }

  write(addr, data) {
    const ch = addr >> 2, reg = addr & 3;
    if (addr === 0x03) { this.freqCtl = data & 7; return; }
    const c = ch < 2 ? this.pulse[ch] : ch === 2 ? this.saw : null;
    if (!c) return;
    if (reg === 0) {
      if (ch < 2) c.ctl = data;
      else c.rate = data & 0x3f;
    } else if (reg === 1) c.period = (c.period & 0xf00) | data;
    else if (reg === 2) {
      c.period = (c.period & 0xff) | ((data & 15) << 8);
      c.enable = !!(data & 0x80);
      // Disabled, a pulse's counter and the saw's accumulator start over.
      if (!c.enable) {
        if (ch < 2) c.step = 15;
        else { c.acc = 0; c.step = 0; }
      }
    }
  }

  // Each channel's level (the pulses 0-15, the saw 0-31) averaged over
  // `clocks`, into out[k], out[k + 1], out[k + 2].
  run(clocks, out, k) {
    const halt = this.freqCtl & 1;
    const shift = this.freqCtl & 4 ? 8 : this.freqCtl & 2 ? 4 : 0;
    this.pulse.forEach((p, n) => {
      if (!p.enable) { out[k + n] = 0; return; }
      const vol = p.ctl & 15;
      const d = (p.ctl >> 4) & 7;
      const always = p.ctl & 0x80;
      if (halt) { out[k + n] = always || p.step <= d ? vol : 0; return; }
      const period = (p.period >> shift) + 1;
      let acc = 0, timer = p.timer, step = p.step;
      for (let rem = clocks; rem > 0; ) {
        const m = Math.min(rem, timer);
        if (always || step <= d) acc += m;
        rem -= m;
        timer -= m;
        if (timer <= 0) {
          step = (step - 1) & 15;
          timer = period;
        }
      }
      p.timer = timer;
      p.step = step;
      out[k + n] = (acc / clocks) * vol;
    });
    const s = this.saw;
    if (!s.enable) { out[k + 2] = 0; return; }
    if (halt) { out[k + 2] = s.acc >> 3; return; }
    const period = (s.period >> shift) + 1;
    let acc = 0, timer = s.timer;
    for (let rem = clocks; rem > 0; ) {
      const m = Math.min(rem, timer);
      acc += (s.acc >> 3) * m;
      rem -= m;
      timer -= m;
      if (timer <= 0) {
        timer = period;
        if (++s.step >= 14) { s.step = 0; s.acc = 0; }
        else if (!(s.step & 1)) s.acc = (s.acc + s.rate) & 0xff;
      }
    }
    s.timer = timer;
    out[k + 2] = acc / clocks;
  }
}

// The MMC5's pulses (port 5: $5000-$5015 as $00-$15, chips/mmc5.js).
class Mmc5 {
  constructor() {
    this.reset();
  }

  reset() {
    this.pulse = [0, 1].map((n) => ({ n, ctl: 0, period: 0, length: 0, seq: 0, timer: 2, env: envelope() }));
    this.enable = 0;
    this.frameClock = 0;
  }

  write(addr, data) {
    if (addr === 0x15) {
      this.enable = data & 3;
      for (const p of this.pulse) if (!(this.enable & (1 << p.n))) p.length = 0;
      return;
    }
    if (addr >= 0x08) return; // the PCM's ($10, $11): left out
    const p = this.pulse[addr >> 2];
    switch (addr & 3) {
      case 0: p.ctl = data; break;
      case 2: p.period = (p.period & 0x700) | data; break;
      case 3:
        p.period = (p.period & 0xff) | ((data & 7) << 8);
        if (this.enable & (1 << p.n)) p.length = LENGTHS[data >> 3];
        p.seq = 0;
        p.env.start = true;
        break;
      default: break; // $01 / $05: no sweep
    }
  }

  // Each pulse's level, 0-15, averaged over `clocks`, into out[k], out[k + 1].
  run(clocks, out, k) {
    for (this.frameClock += clocks; this.frameClock >= MMC5_FRAME; this.frameClock -= MMC5_FRAME)
      for (const p of this.pulse) {
        clockEnvelope(p.env, p.ctl);
        if (p.length && !(p.ctl & 0x20)) p.length--;
      }
    for (const p of this.pulse) {
      const v = p.length ? envVolume(p.env, p.ctl) : 0;
      const duty = DUTY[p.ctl >> 6];
      const step = 2 * (p.period + 1);
      let acc = 0, timer = p.timer, seq = p.seq;
      for (let rem = clocks; rem > 0; ) {
        const m = Math.min(rem, timer);
        acc += duty[seq] * m;
        rem -= m;
        timer -= m;
        if (timer <= 0) {
          seq = (seq - 1) & 7;
          timer = step;
        }
      }
      p.timer = timer;
      p.seq = seq;
      out[k + p.n] = (acc / clocks) * v;
    }
  }
}

// The Disk System's sound (port 4: VGM 0xB4's numbering, chips/fds.js).
// Its two envelopes — the volume's ($4080) and the modulation depth's
// ($4084) — step their gain by 1 toward 32 or 0 every 8 × (speed + 1) ×
// $408A CPU clocks (Mesen and NSFPlay agree on $408A, not nesdev's + 1; 0
// stops both), while the wave runs and $4083 bit 6 is clear; a gain written
// direct (bit 7) is the speed's six bits, over 32 heard as 32 and not raised.
class Fds {
  constructor() {
    this.reset();
  }

  reset() {
    this.wave = new Uint8Array(64);
    this.gain = 0;
    this.pitch = 0;
    this.waveHalt = false;
    this.waveAcc = 0;
    this.waveOpen = false; // $4089 bit 7: the memory writable, the output held
    this.master = 0;
    this.held = 0;
    this.modGain = 0;
    this.modCounter = 0;
    this.modFreq = 0;
    this.modHalt = false;
    this.modAcc = 0;
    this.modPos = 0; // the half-step, 0-63 (each entry twice)
    this.modTable = new Uint8Array(32);
    // The envelopes, volume [0] and modulation [1]: speed, rising, off
    // (direct), the clocks into the next step.
    this.env = [0, 1].map(() => ({ speed: 0, up: false, off: false, timer: 0 }));
    this.envHalt = false;
    this.envMaster = 0xe8; // the BIOS's
    this.tick = 0; // CPU clocks into the next 16
  }

  // $4080 / $4084: the speed and direction always, the gain only when direct.
  _envWrite(i, data) {
    const e = this.env[i];
    e.speed = data & 63;
    e.up = !!(data & 0x40);
    e.off = !!(data & 0x80);
    e.timer = 0;
    if (e.off) {
      if (i === 0) this.gain = e.speed;
      else this.modGain = e.speed;
    }
  }

  // `clocks` CPU clocks of the envelopes.
  _envRun(clocks) {
    if (this.envHalt || this.waveHalt || !this.envMaster) return;
    for (let i = 0; i < 2; i++) {
      const e = this.env[i];
      if (e.off) continue;
      const period = 8 * (e.speed + 1) * this.envMaster;
      for (e.timer += clocks; e.timer >= period; e.timer -= period) {
        const g = i === 0 ? this.gain : this.modGain;
        const next = e.up ? (g < 32 ? g + 1 : g) : g > 0 ? g - 1 : g;
        if (i === 0) this.gain = next;
        else this.modGain = next;
      }
    }
  }

  _envReset() {
    for (const e of this.env) e.timer = 0;
  }

  write(addr, data) {
    const reg = fdsRegister(addr);
    if (reg >= 0x4040 && reg < 0x4080) {
      if (this.waveOpen) this.wave[reg - 0x4040] = data & 63;
      return;
    }
    switch (reg) {
      case 0x4080: this._envWrite(0, data); break;
      case 0x4082: this.pitch = (this.pitch & 0xf00) | data; break;
      case 0x4083:
        this.pitch = (this.pitch & 0xff) | ((data & 15) << 8);
        this.waveHalt = !!(data & 0x80);
        if (this.waveHalt) this.waveAcc = 0;
        this.envHalt = !!(data & 0x40);
        if (this.envHalt) this._envReset();
        break;
      case 0x4084: this._envWrite(1, data); break;
      case 0x4085: this.modCounter = ((data & 0x7f) << 25) >> 25; break;
      case 0x4086: this.modFreq = (this.modFreq & 0xf00) | data; break;
      case 0x4087:
        this.modFreq = (this.modFreq & 0xff) | ((data & 15) << 8);
        this.modHalt = !!(data & 0x80);
        if (this.modHalt) this.modAcc = 0;
        break;
      case 0x4088:
        // Open while the unit is halted: the entry at the position, which moves on.
        if (this.modHalt) {
          this.modTable[this.modPos >> 1] = data & 7;
          this.modPos = (this.modPos + 2) & 63;
        }
        break;
      case 0x4089:
        this.waveOpen = !!(data & 0x80);
        this.master = data & 3;
        break;
      case 0x408a:
        this.envMaster = data;
        this._envReset(); // a sudden slower speed floods no steps (NSFPlay)
        break;
      default: break;
    }
  }

  // The pitch the wave unit adds, the modulation's counter × depth applied
  // (nesdev's arithmetic).
  _wavePitch() {
    let t = this.modCounter * this.modGain;
    if (t & 0x0f && !(t & 0x800)) t += 0x20;
    t += 0x400;
    t = (t >> 4) & 0xff;
    return (this.pitch * t) & 0xfffff;
  }

  // The level (0 .. 63 × 32) averaged over `clocks`.
  run(clocks) {
    let acc = 0, n = 0;
    this.tick += clocks;
    while (this.tick >= 16) {
      this.tick -= 16;
      this._envRun(16);
      if (!this.modHalt && this.modFreq) {
        this.modAcc += this.modFreq;
        if (this.modAcc >= 0x1000) {
          this.modAcc &= 0xfff;
          const d = FDS_MOD_DELTA[this.modTable[this.modPos >> 1]];
          this.modCounter = d === null ? 0 : (((this.modCounter + d) & 0x7f) << 25) >> 25;
          this.modPos = (this.modPos + 1) & 63;
        }
      }
      if (!this.waveHalt && !this.waveOpen) this.waveAcc = (this.waveAcc + this._wavePitch()) & 0xffffff;
      if (!this.waveOpen) this.held = this.wave[this.waveAcc >>> 18] * Math.min(32, this.gain) * FDS_MASTER[this.master];
      acc += this.held;
      n++;
    }
    return n ? acc / n : this.held;
  }
}

export class FcSynth {
  static async create(outputSR) {
    return new FcSynth(await createAy8910Module(), outputSR);
  }

  constructor(ay, outputSR) {
    this._outputSR = outputSR;
    this.pitch = pitchLatches(fcPitch(CLOCK), vrc6Pitch(CLOCK), fdsPitch(CLOCK), mmc5Pitch(CLOCK),
      ssgPitch(sunsoft5b.clock, S5B_PORT, 17));
    this._ay = ay;
    ay._a8_init();
    this._ayBufPtr = ay._a8_get_buffer_ptr();
    this._ayOn = false; // rendered from its first write
    this._ayClocks = 0; // CPU clocks into its next sample
    this._ayOut = new Float32Array(3);
    this._apu = new Apu();
    this._vrc6 = new Vrc6();
    this._fds = new Fds();
    this._mmc5 = new Mmc5();
    this._fdsY = 0; // the FDS's low-pass
    this._lv = new Float32Array(CHANNELS);
    this._x = new Float32Array(CHANNELS + 1);
    this.bus = null; // no FM to hold
    this.scopeLanes = SCOPE_LANES;
    this._ratio = FC_NATIVE_SAMPLE_RATE / outputSR;
    this.pcmTaps = null; // the contract's; the DMC is a register-written voice here
    this._resetResampleState();
  }

  // Index 0 the mix, 1-9 each channel alone (the scope's).
  _resetResampleState() {
    this._frac = 0;
    this._dcX = new Float32Array(CHANNELS + 1);
    this._dcY = new Float32Array(CHANNELS + 1);
    this._cur = new Float32Array(CHANNELS + 1);
    this._next = new Float32Array(CHANNELS + 1);
    // The blocker starts settled on the chip's idle level (the halted
    // triangle holds its step's), so a run starts with no thump.
    this._mix();
    this._dcX.set(this._x);
    this._nativeOne();
  }

  reset() {
    this._apu.reset();
    this._vrc6.reset();
    this._fds.reset();
    this._mmc5.reset();
    this._ay._a8_reset();
    this._ayOn = false;
    this._ayClocks = 0;
    this._ayOut.fill(0);
    this._fdsY = 0;
    this._resetResampleState();
  }

  // The APU's registers are port 0, $4000 + addr; the memory port 1; the
  // VRC6's port 3; the FDS's port 4; the MMC5's port 5; the 5B's port 6.
  writeYM(port, addr, data) {
    if (port === 0) this._apu.write(addr & 0xff, data & 0xff);
    else if (port === RAM_PORT) this._apu.writeRam(addr & 0xff, data & 0xff);
    else if (port === VRC6_PORT) this._vrc6.write(addr & 0xff, data & 0xff);
    else if (port === FDS_PORT) this._fds.write(addr & 0xff, data & 0xff);
    else if (port === MMC5_PORT) this._mmc5.write(addr & 0xff, data & 0xff);
    else if (port === S5B_PORT) {
      this._ayOn = true;
      this._ay._a8_write_reg(addr & 0xff, data & 0xff);
    }
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
    for (let c = 0; c <= CHANNELS; c++) {
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
    if (clocks) {
      this._apu.run(clocks, lv);
      this._vrc6.run(clocks, lv, 5);
      this._fdsY += FDS_LPF * (this._fds.run(clocks) - this._fdsY);
      lv[8] = this._fdsY;
      this._mmc5.run(clocks, lv, 9);
      this._runAy(clocks);
      lv.set(this._ayOut, 11);
    } else lv.set([0, 0, TRI[this._apu.tri.seq], 0, this._apu.dac, 0, 0, 0, this._fdsY, 0, 0, 0, 0, 0]); // idle: the triangle's held step, the DAC
    const x = this._x;
    x[1] = pulseOut(lv[0]);
    x[2] = pulseOut(lv[1]);
    x[3] = tndOut(lv[2], 0, 0);
    x[4] = tndOut(0, lv[3], 0);
    x[5] = tndOut(0, 0, lv[4]);
    for (let c = 5; c < 8; c++) x[c + 1] = -lv[c] * PULSE_STEP; // the VRC6's DAC, inverted
    x[9] = lv[8] * FDS_STEP;
    for (let c = 9; c < 11; c++) x[c + 1] = -lv[c] * PULSE_STEP; // the MMC5's, inverted
    for (let c = 11; c < 14; c++) x[c + 1] = lv[c] * PULSE_STEP; // the 5B's
    x[0] = pulseOut(lv[0] + lv[1]) + tndOut(lv[2], lv[3], lv[4]);
    for (let c = 6; c <= CHANNELS; c++) x[0] += x[c];
    return x;
  }

  // The 5B over `clocks`: a sample of it each 64 CPU clocks, held between.
  _runAy(clocks) {
    if (!this._ayOn) return;
    for (this._ayClocks -= clocks; this._ayClocks <= 0; this._ayClocks += S5B_CLOCKS) {
      this._ay._a8_render(1);
      const heap = this._ay.HEAP16, at = this._ayBufPtr >> 1;
      for (let c = 0; c < 3; c++) this._ayOut[c] = heap[at + c] * S5B_LEVEL;
    }
  }

  // `getDacByte` is the contract's and unused; `scope` (SCOPE_LANES arrays)
  // gets the channels at lanes 6-19, the others silence.
  renderInto(outL, outR, count, onFrame = null, _getDacByte = null, scope = null) {
    if (scope) for (let c = 0; c < PSG_LANE; c++) scope[c]?.fill(0, 0, count);
    for (let i = 0; i < count; i++) {
      if (onFrame) onFrame(i);
      const t = this._frac;
      if (scope)
        for (let c = 0; c < CHANNELS; c++) {
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
