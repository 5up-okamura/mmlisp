// ---------------------------------------------------------------------------
// The oscilloscope's pitch latches: each chip's tone registers, read as the
// writes go by, into the Hz of the lane that channel draws on (targets.js
// scopeLane: FM channel n at n, the PSG's channel n at 6 + n). The trigger
// (scope-trigger.js) locks onto that pitch; 0 is unpitched.
//
// A synth (synth-*.js) holds its chips' latches as `pitch`, and the worklet
// passes every register write through `pitch.write(port, addr, data, freq)`
// — port 2 being the Mega Drive's PSG — so it needs no knowledge of a chip.
// ---------------------------------------------------------------------------

import { kcToHz } from "./chips/ym2151.js";

/** Several chips' latches as one. */
export function pitchLatches(...latches) {
  return { write: (port, addr, data, freq) => latches.forEach((l) => l.write(port, addr, data, freq)) };
}

/**
 * The OPN's (YM2612, YM2608) F-numbers: $A4+c holds block and the F-number's
 * high bits until $A0+c applies the pair, as the chip latches them. `rate`
 * is the chip's clock / 144.
 */
export function opnPitch(rate) {
  const hiLatch = new Uint8Array(6);
  return {
    write(port, addr, data, freq) {
      if (port > 1) return;
      if (addr >= 0xa4 && addr <= 0xa6) {
        hiLatch[(port ? 3 : 0) + (addr - 0xa4)] = data;
      } else if (addr >= 0xa0 && addr <= 0xa2) {
        const ch = (port ? 3 : 0) + (addr - 0xa0);
        const fnum = ((hiLatch[ch] & 7) << 8) | data;
        const block = (hiLatch[ch] >> 3) & 7;
        // freq = fnum * 2^(block-1) * (clock / 144) / 2^20
        freq[ch] = fnum ? (fnum * 2 ** (block - 1) * rate) / (1 << 20) : 0;
      }
    },
  };
}

/** The OPM's (YM2151) KC ($28+c) and KF ($30+c). */
export function opmPitch() {
  const kc = new Uint8Array(8);
  const kf = new Uint8Array(8);
  return {
    write(port, addr, data, freq) {
      if (port !== 0 || addr < 0x28 || addr >= 0x38) return;
      const ch = addr & 7;
      (addr < 0x30 ? kc : kf)[ch] = data;
      freq[ch] = kcToHz(kc[ch], kf[ch]);
    },
  };
}

/**
 * The SSG's (YM2608, AY-3-8910, the 5B's) 12-bit tone periods, $00-$05, on
 * `port`, onto the scope's lanes from `lane`; a tone is `clock` / 16 / period.
 */
export function ssgPitch(clock, port = 0, lane = 6) {
  const period = new Uint16Array(3);
  return {
    write(p0, addr, data, freq) {
      if (p0 !== port || addr >= 6) return;
      const ch = addr >> 1;
      const p = (period[ch] = addr & 1 ? (period[ch] & 0xff) | ((data & 15) << 8) : (period[ch] & 0xf00) | data);
      freq[lane + ch] = p ? clock / (16 * p) : 0;
    },
  };
}

/**
 * The SCC's (port 3, chips/k051649.js) 12-bit periods, $80-$89, onto the
 * wave lanes 10-14; a tone is `clock` / 16 / (period + 1) (chips/k051649.js).
 */
export function sccPitch(clock) {
  const period = new Uint16Array(5);
  return {
    write(port, addr, data, freq) {
      if (port !== 3 || addr < 0x80 || addr >= 0x8a) return;
      const ch = (addr - 0x80) >> 1;
      const p = (period[ch] = addr & 1 ? (period[ch] & 0xff) | ((data & 15) << 8) : (period[ch] & 0xf00) | data);
      freq[10 + ch] = clock / (16 * (p + 1));
    },
  };
}

/**
 * The HuC6280's (port 0, chips/huc6280.js) frequencies: $00 selects the
 * channel, $02 its low byte and $03 its high nibble; a channel's tone is
 * the clock / 32 / f. On the page's wave lanes 10-15.
 */
export function pcePitch(clock) {
  const freq = new Uint16Array(6);
  let sel = 0;
  return {
    write(port, addr, data, out) {
      if (port !== 0) return;
      if (addr === 0x00) { sel = data & 7; return; }
      if (sel > 5 || (addr !== 0x02 && addr !== 0x03)) return;
      const f = (freq[sel] = addr === 0x02 ? (freq[sel] & 0xf00) | data : (freq[sel] & 0xff) | ((data & 15) << 8));
      out[10 + sel] = clock / (32 * (f || 0x1000));
    },
  };
}

/**
 * The 2A03's (port 0, chips/rp2a03.js) periods: $4002/$4003 and
 * $4006/$4007 the pulses' (the clock / 16 / (p + 1)), $400A/$400B the
 * triangle's (/ 32), onto the PSG lanes 6-8; the noise is unpitched.
 */
export function fcPitch(clock) {
  const period = new Uint16Array(3);
  return {
    write(port, addr, data, out) {
      if (port !== 0 || addr < 0x02 || addr > 0x0b || (addr & 3) < 2) return;
      const ch = addr >> 2;
      const p = (period[ch] = addr & 1 ? (period[ch] & 0xff) | ((data & 7) << 8) : (period[ch] & 0x700) | data);
      out[6 + ch] = clock / ((ch === 2 ? 32 : 16) * (p + 1));
    },
  };
}

/**
 * The VRC6's (port 3, chips/vrc6.js) periods: $x001 the low byte, $x002's
 * low nibble the top; its pulses (clock / 16 / (period + 1)) and its saw
 * (clock / 14 / (period + 1)) on the scope's lanes 11-13 (synth-fc.js).
 */
export function vrc6Pitch(clock) {
  const period = new Uint16Array(3);
  return {
    write(port, addr, data, out) {
      const ch = addr >> 2, reg = addr & 3;
      if (port !== 3 || ch > 2 || (reg !== 1 && reg !== 2)) return;
      const p = (period[ch] = reg === 1 ? (period[ch] & 0xf00) | data : (period[ch] & 0xff) | ((data & 15) << 8));
      out[11 + ch] = clock / ((ch === 2 ? 14 : 16) * (p + 1));
    },
  };
}

/**
 * The FDS's (port 4, chips/fds.js) 12-bit pitch, $22 / $23 ($4082 / $4083):
 * a 64-step cycle is clock × p / 16 / 2^18, on the scope's lane 14
 * (synth-fc.js); the modulation's bend is not followed.
 */
export function fdsPitch(clock) {
  let p = 0;
  return {
    write(port, addr, data, out) {
      if (port !== 4 || (addr !== 0x22 && addr !== 0x23)) return;
      p = addr === 0x22 ? (p & 0xf00) | data : (p & 0xff) | ((data & 15) << 8);
      out[14] = (clock * p) / (16 * 2 ** 18);
    },
  };
}

/**
 * The MMC5's (port 5, chips/mmc5.js) 11-bit pulse periods, $02-$03 and
 * $06-$07, onto the scope's lanes 15-16 (synth-fc.js): clock / 16 / (p + 1).
 */
export function mmc5Pitch(clock) {
  const period = new Uint16Array(2);
  return {
    write(port, addr, data, out) {
      const ch = addr >> 2, reg = addr & 3;
      if (port !== 5 || ch > 1 || reg < 2) return;
      const p = (period[ch] = reg === 2 ? (period[ch] & 0x700) | data : (period[ch] & 0xff) | ((data & 7) << 8));
      out[15 + ch] = clock / (16 * (p + 1));
    },
  };
}

/**
 * The OPLL's (port 4, chips/ym2413.js; the VRC7's on `port` 7) F-numbers: $10+c the low 8 bits,
 * $20+c the top bit and the block, as the chip reads them each sample. Its
 * channels 0-5 draw on lanes 0-5, 6-8 on 15-17 (synth-msx.js); a tone is
 * fnum * 2^(block-1) * (clock / 72) / 2^18.
 */
export function opllPitch(clock, port = 4) {
  const lo = new Uint8Array(9);
  const hi = new Uint8Array(9);
  const rate = clock / 72;
  return {
    write(p, addr, data, freq) {
      if (p !== port || addr < 0x10 || addr >= 0x29 || (addr & 0x0f) > 8) return;
      const ch = addr & 0x0f;
      (addr < 0x20 ? lo : hi)[ch] = data;
      const fnum = ((hi[ch] & 1) << 8) | lo[ch];
      const block = (hi[ch] >> 1) & 7;
      freq[ch < 6 ? ch : 9 + ch] = fnum ? (fnum * 2 ** (block - 1) * rate) / (1 << 18) : 0;
    },
  };
}

/**
 * The SN76489's (port 2) latch/data bytes: a tone period's low nibble rides
 * the latch byte, a following data byte its upper six bits. A tone is
 * `clock` / 32 / period, period 0 counting as 0x400.
 */
export function snPitch(clock) {
  const tone = new Uint16Array(3);
  let latch = 0;
  return {
    write(port, _addr, data, freq) {
      if (port !== 2) return;
      if (data & 0x80) latch = data;
      const ch = (latch >> 5) & 3;
      if (latch & 0x10 || ch === 3) return;
      tone[ch] = data & 0x80 ? (tone[ch] & 0x3f0) | (data & 0x0f) : (tone[ch] & 0x00f) | ((data & 0x3f) << 4);
      freq[6 + ch] = clock / (32 * (tone[ch] || 0x400));
    },
  };
}
