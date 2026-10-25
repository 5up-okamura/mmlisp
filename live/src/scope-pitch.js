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

/** The SSG's (YM2608, AY-3-8910) 12-bit tone periods, $00-$05; a tone is `clock` / 16 / period. */
export function ssgPitch(clock) {
  const period = new Uint16Array(3);
  return {
    write(port, addr, data, freq) {
      if (port !== 0 || addr >= 6) return;
      const ch = addr >> 1;
      const p = (period[ch] = addr & 1 ? (period[ch] & 0xff) | ((data & 15) << 8) : (period[ch] & 0xf00) | data);
      freq[6 + ch] = p ? clock / (16 * p) : 0;
    },
  };
}

/**
 * The SCC's (port 3, chips/k051649.js) 12-bit periods, $80-$89, onto the
 * wave lanes 10-14; a tone is `clock` / 32 / (period + 1).
 */
export function sccPitch(clock) {
  const period = new Uint16Array(5);
  return {
    write(port, addr, data, freq) {
      if (port !== 3 || addr < 0x80 || addr >= 0x8a) return;
      const ch = (addr - 0x80) >> 1;
      const p = (period[ch] = addr & 1 ? (period[ch] & 0xff) | ((data & 15) << 8) : (period[ch] & 0xf00) | data);
      freq[10 + ch] = clock / (32 * (p + 1));
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
