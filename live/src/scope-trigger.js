// Correlation trigger for the live oscilloscope.
//
// A JavaScript port of corrscope's CorrelationTrigger, which is what makes a
// scope trace stand still: every frame it scores candidate trigger points by
// edge strength (a rising zero crossing) plus similarity to a history buffer
// of previously triggered waveforms, keeps only local maxima of that score,
// and never moves backwards in time.
//
// Ported from corrscope (https://github.com/corrscope/corrscope):
// corrscope/triggers.py, corrscope/utils/trigger_util.py,
// corrscope/utils/windows.py.
//
//   Copyright (c) 2018-2020+, nyanpasu64. All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//
//   1. Redistributions of source code must retain the above copyright notice,
//      this list of conditions and the following disclaimer.
//
//   2. Redistributions in binary form must reproduce the above copyright
//      notice, this list of conditions and the following disclaimer in the
//      documentation and/or other materials provided with the distribution.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
//   ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
//   LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
//   SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//   INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
//   CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
//   ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.
//
// Differences from upstream, all because this runs on a chip emulator rather
// than a wave file:
//
// - The wave period comes from the chip's own pitch registers (the worklet
//   latches fnum/block and the PSG tone period), so corrscope's
//   autocorrelation period estimator and its log-spectrum "pitch tracking"
//   are both unnecessary. A pitch change rescales the history buffer by the
//   exact frequency ratio.
// - Input is a ring buffer of the last ~340ms of one channel's output, read
//   at absolute sample positions, instead of a seekable wave file.
// - Only rising-edge triggering, and no DC removal: the taps are AC-centered
//   already.

// ---- tuning (corrscope's template defaults unless noted) ----
const TRIGGER_MS = 40;   // history/search window
const RENDER_MS = 40;    // longest drawn window, centered on the trigger
// corrscope draws a fixed 40ms in a 1920px frame. The live scope's panes are a
// few hundred pixels wide, where 40ms of a treble note is an unreadable comb,
// so the drawn window shrinks to this many cycles of the current pitch (the
// trigger window stays 40ms either way, which is what keeps the trace still).
const RENDER_PERIODS = 8;
export const TRIGGER_STRIDE = 4; // trigger subsampling (corrscope: 1)
const MAX_FREQ = 4000;          // period floor: ignore FM feedback hiss
const EDGE_STRENGTH = 1.0;
const BUFFER_STRENGTH = 1.0;
const RESPONSIVENESS = 0.5;     // how fast the buffer learns the new wave
const RESET_BELOW = 0.3;        // discard the buffer below this match quality
const SLOPE_WIDTH = 0.25;       // periods
const BUFFER_FALLOFF = 0.5;     // periods (std of the buffer's window)
const TRIGGER_DIAMETER = 0.5;   // of the trigger window
const TRIGGER_RADIUS_PERIODS = 1.5;
const RECALC_SEMITONES = 1;     // pitch move that rebuilds slope finder/buffer
const MIN_AMPLITUDE = 0.01;     // below this the channel counts as silent
// Post trigger: snap the result to the exact zero crossing at full rate.
// corrscope ships this off by default because its main trigger already runs at
// stride 1; ours runs at stride 4, and the drawn window zooms in on treble, so
// without it a high note shimmers by a couple of pixels every frame.
const POST_RADIUS = TRIGGER_STRIDE;

// ---- stateless helpers ----

// out[x] = sum_k data[x + k] * kernel[k], for x in [lo, hi).
//
// corrscope's signal.correlate_valid, restricted twice so the live scope can
// afford it on the UI thread (both restrictions are exact, not approximations):
//   - x only spans the candidate range the trigger radius allows anyway.
//   - k only spans the kernel's nonzero support. Both the slope finder and the
//     history buffer are Gaussian-windowed around the kernel center with a
//     width proportional to the wave period, so for anything but deep bass most
//     of the kernel is zero. An unpitched channel shrinks to a handful of taps.
function correlateValid(data, kernel, out, lo = 0, hi = out.length, kLo = 0, kHi = kernel.length) {
  const end = kLo + (((kHi - kLo) / 4) | 0) * 4;
  for (let x = lo; x < hi; x++) {
    let a = 0, b = 0, c = 0, d = 0;
    let k = kLo, i = x + kLo;
    for (; k < end; k += 4, i += 4) {
      a += data[i] * kernel[k];
      b += data[i + 1] * kernel[k + 1];
      c += data[i + 2] * kernel[k + 2];
      d += data[i + 3] * kernel[k + 3];
    }
    for (; k < kHi; k++, i++) a += data[i] * kernel[k];
    out[x] = a + b + c + d;
  }
  return out;
}

// Half-width (in samples) outside which a Gaussian of this std contributes
// nothing worth multiplying: exp(-8) is 3e-4 of the peak.
function support(std) {
  return Math.ceil(4 * Math.max(std, 1));
}

// scipy.signal.windows.gaussian(M, std, sym=True), or all zeros when std is 0
// (corrscope's gaussian_or_zero: an unknown period disables the buffer).
function gaussianWindow(M, std, out) {
  const w = out ?? new Float32Array(M);
  if (!(std > 0)) {
    w.fill(0);
    return w;
  }
  const mid = (M - 1) / 2;
  for (let i = 0; i < M; i++) {
    const n = (i - mid) / std;
    w[i] = Math.exp(-0.5 * n * n);
  }
  return w;
}

// A step from -edge to +edge at the window center, tapered by a Gaussian whose
// width follows the period: correlating it with the wave scores rising edges.
function slopeFinder(K, A, period, out) {
  const f = out ?? new Float32Array(K);
  const width = Math.min(Math.max(SLOPE_WIDTH * period, 1), A / 3);
  const half = EDGE_STRENGTH; // corrscope: (edge_strength * 2) / 2
  gaussianWindow(K, width, f);
  for (let i = 0; i < K; i++) f[i] *= i < A ? -half : half;
  return f;
}

// Resample buf to newLen (linear) and mid-pad/crop back to its own length,
// so the buffer keeps its shape when the pitch moves (corrscope rescales via
// the log-frequency spectrum; the chip tells us the exact ratio).
function rescaleBuffer(buf, newLen, scratch) {
  const N = buf.length;
  if (newLen === N || newLen < 2 || !Number.isFinite(newLen)) return buf;
  const M = Math.min(newLen, N * 4);
  const src = scratch && scratch.length >= M ? scratch.subarray(0, M) : new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const pos = (i * (N - 1)) / (M - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(N - 1, i0 + 1);
    const t = pos - i0;
    src[i] = buf[i0] * (1 - t) + buf[i1] * t;
  }
  // midpad: center src inside buf, zero-filling or cropping the edges.
  if (M >= N) {
    const off = (M - N) >> 1;
    for (let i = 0; i < N; i++) buf[i] = src[off + i];
  } else {
    const off = (N - M) >> 1;
    buf.fill(0);
    for (let i = 0; i < M; i++) buf[off + i] = src[i];
  }
  return buf;
}

function normalize(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const d = Math.max(peak, MIN_AMPLITUDE);
  for (let i = 0; i < buf.length; i++) buf[i] /= d;
}

/**
 * One trigger per scope channel. Holds the history buffer and the last
 * trigger position, so it must be reset when playback restarts.
 */
export class CorrelationTrigger {
  /**
   * @param {number} sampleRate  audio sample rate of the ring buffer
   * @param {number} gain        ring units → display units (see SCOPE_DISPLAY_GAIN)
   */
  constructor(sampleRate, gain = 1) {
    this.sampleRate = sampleRate;
    this.gain = gain;
    const stride = TRIGGER_STRIDE;
    this.stride = stride;
    // K = trigger window in subsamples (even, so A === B).
    const K = Math.max(8, Math.round((TRIGGER_MS / 1000) * sampleRate / stride) & ~1);
    this.K = K;
    this.A = this.B = K >> 1;
    this.D = Math.floor(K * TRIGGER_DIAMETER); // trigger diameter, inclusive
    this.renderSamp = Math.round((RENDER_MS / 1000) * sampleRate);
    // The newest trigger we can return renders up to `latest`, never past it.
    if (this.renderSamp > 2 * stride * this.B) this.renderSamp = 2 * stride * this.B;

    const N = this.D + 1;
    this._data = new Float32Array(this.A + this.D + this.B);
    this._corr = new Float32Array(N);
    this._quality = new Float32Array(N);
    this._peaks = new Float32Array(N);
    this._corrBuf = new Float32Array(K);
    this._prevWindow = new Float32Array(K);
    this._slope = new Float32Array(K);
    this._aligned = new Float32Array(K);
    this._scratch = new Float32Array(K);
    // Nonzero support of the history buffer, [kLo, kHi) — see correlateValid().
    this._kLo = 0;
    this._kHi = K;
    this._slopeSupport = this.A;
    this.reset();
  }

  reset() {
    this._corrBuf.fill(0);
    this._prevWindow.fill(0);
    this._slope.fill(0);
    this._kLo = 0;
    this._kHi = this.K;
    this._slopeSupport = this.A;
    this._prevPeriod = null;
    this._prevTrigger = -Infinity;
  }

  /**
   * Length in samples of the window to draw, centered on the trigger.
   * @param {number} freqHz  the same pitch passed to getTrigger()
   */
  renderLength(freqHz) {
    if (!(freqHz > 0)) return this.renderSamp;
    const win = Math.round((RENDER_PERIODS * this.sampleRate) / freqHz);
    return Math.max(64, Math.min(this.renderSamp, win));
  }

  /**
   * @param {Float32Array} ring    channel ring buffer, indexed modulo its length
   * @param {number} latest        absolute sample index one past the newest sample
   * @param {number} freqHz        latched pitch, 0 when unknown/unpitched
   * @returns {number} absolute sample index of the trigger point
   */
  getTrigger(ring, latest, freqHz) {
    const { stride, A, B, D, K, gain } = this;
    const R = ring.length;
    const data = this._data;
    const triggerBegin = latest - stride * (D + B);
    const dataBegin = triggerBegin - stride * A;

    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const idx = dataBegin + i * stride;
      const v = ring[((idx % R) + R) % R] * gain;
      data[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }

    // Silent channel: no edge to lock onto. Keep sliding forward so the pane
    // shows current (flat) audio, and never rewind.
    if (peak < MIN_AMPLITUDE) {
      const t = Math.max(this._prevTrigger, latest - (this.renderSamp >> 1));
      this._prevTrigger = t;
      return t;
    }

    // Only used by the buffer-quality check below; the taps are AC-centered,
    // so unlike corrscope we never subtract it from the data.
    let mean = 0;
    for (let i = 0; i < data.length; i++) mean += data[i];
    mean /= data.length;

    // Period in subsamples, straight from the chip's pitch registers.
    const subsmpPerS = this.sampleRate / stride;
    const period = freqHz > 0
      ? Math.round(Math.max(subsmpPerS / freqHz, subsmpPerS / MAX_FREQ))
      : 0;

    if (this._isWindowInvalid(period)) {
      slopeFinder(K, A, period, this._slope);
      if (this._prevPeriod > 0 && period > 0) {
        const ratio = period / this._prevPeriod;
        rescaleBuffer(this._corrBuf, Math.round(K * ratio), this._scratch);
        // The rescale moves the buffer's content in or out; widen conservatively.
        if (ratio > 1) {
          const w = Math.ceil((A - this._kLo) * ratio);
          this._kLo = Math.max(0, A - w);
          this._kHi = Math.min(K, A + w);
        }
      }
      this._prevPeriod = period;
      this._slopeSupport = support(Math.min(Math.max(SLOPE_WIDTH * period, 1), A / 3));
    }

    const kLo = this._kLo;
    const kHi = this._kHi;
    const N = D + 1;
    const quality = this._quality;
    const corr = this._corr;
    const peaks = this._peaks;
    let bufferOn = BUFFER_STRENGTH > 0 && RESPONSIVENESS > 0;

    // Candidate range: the trigger may not move more than TRIGGER_RADIUS_PERIODS
    // from the window center, so nothing outside it needs correlating.
    const mid = N >> 1;
    const radius = period > 0 ? Math.round(period * TRIGGER_RADIUS_PERIODS) : N;
    const lo = Math.max(mid - radius, 0);
    const hi = Math.min(mid + radius + 1, N);

    if (bufferOn) {
      correlateValid(data, this._corrBuf, quality, lo, hi, kLo, kHi);
      if (RESET_BELOW > 0) {
        let pi = lo;
        for (let i = lo + 1; i < hi; i++) if (quality[i] > quality[pi]) pi = i;
        // Quality of the buffer's match, relative to the wave matching itself
        // through the same window. Keep in sync with the buffer update below.
        const slice = this._scratch;
        for (let i = 0; i < K; i++) slice[i] = data[pi + i] - mean;
        normalize(slice);
        let self = 0;
        for (let i = 0; i < K; i++) self += data[pi + i] * slice[i] * this._prevWindow[i];
        if (quality[pi] / (self + 0.001) < RESET_BELOW) {
          quality.fill(0, lo, hi);
          this._corrBuf.fill(0);
          bufferOn = false;
        }
      }
    } else {
      quality.fill(0, lo, hi);
    }

    // corr = correlate(data, slope + buffer*strength) is linear, so correlate
    // against the slope finder alone (support ~1 period) and add the buffer
    // correlation already computed above (support ~2 periods) instead of
    // running a second full-width correlation.
    const sLo = Math.max(0, A - this._slopeSupport);
    const sHi = Math.min(K, A + this._slopeSupport);
    correlateValid(data, this._slope, corr, lo, hi, sLo, sHi);
    if (bufferOn) for (let i = lo; i < hi; i++) corr[i] += quality[i] * BUFFER_STRENGTH;

    // Candidate score: buffer match, plus "how much wave lies to the right",
    // which peaks exactly at a rising zero crossing.
    let cum = 0;
    for (let i = 0; i < lo; i++) cum += data[A - 1 + i];
    for (let i = lo; i < hi; i++) {
      cum += data[A - 1 + i];
      peaks[i] = quality[i] * BUFFER_STRENGTH - EDGE_STRENGTH * cum;
    }

    const idx = this._findPeak(corr, peaks, lo, hi, mid);
    // Never look past the newest sample, and never travel backwards.
    const newest = latest - (this.renderSamp >> 1);
    const snapped = Math.min(this._postTrigger(ring, triggerBegin + stride * idx), newest);
    const trigger = Math.max(snapped, this._prevTrigger);
    this._prevTrigger = trigger;

    if (bufferOn) this._updateBuffer(ring, trigger, period);
    return trigger;
  }

  // Walk to the nearest zero crossing, at most POST_RADIUS samples away
  // (corrscope's ZeroCrossingTrigger, used as a post trigger).
  _postTrigger(ring, index) {
    const R = ring.length;
    const at = (n) => ring[((n % R) + R) % R] * this.gain;
    const v = at(index);
    if (v === 0) return index + 1;
    const dir = v < 0 ? 1 : -1;
    for (let d = 1; d <= POST_RADIUS; d++) {
      const val = at(index + d * dir);
      if (dir > 0 ? val >= 0 : val <= 0) return index + d * dir + (val <= 0 ? 1 : 0);
    }
    return index + dir * POST_RADIUS;
  }

  // Only local maxima of `peaks` may win, which keeps the trigger on an actual
  // rising edge instead of the best-correlating point at the window's rim.
  _findPeak(corr, peaks, lo, hi, mid) {
    let min = Infinity;
    for (let i = lo; i < hi; i++) if (corr[i] < min) min = corr[i];
    let best = lo, bestV = -Infinity;
    for (let i = lo; i < hi; i++) {
      const isEdge = i === lo || i === hi - 1;
      const dropRight = i + 1 < hi && peaks[i] < peaks[i + 1];
      const dropLeft = i - 1 >= lo && peaks[i] < peaks[i - 1];
      const v = isEdge || dropRight || dropLeft ? min : corr[i];
      if (v > bestV) { bestV = v; best = i; }
    }
    return bestV === min ? mid : best;
  }

  // True when the pitch moved far enough that the slope finder and the buffer
  // have to be rebuilt for it.
  _isWindowInvalid(period) {
    const prev = this._prevPeriod;
    if (prev === null) return true;
    if (period === 0) return false;
    if (prev === 0) return true;
    const semitones = (-12 * Math.log(period / prev)) / Math.LN2;
    return Math.abs(semitones) > RECALC_SEMITONES;
  }

  // Blend the just-triggered waveform into the history buffer, windowed so it
  // tapers away from the trigger point.
  _updateBuffer(ring, trigger, period) {
    const { stride, K, gain } = this;
    const R = ring.length;
    const aligned = this._aligned;
    const begin = trigger - (K >> 1) * stride;
    let mean = 0;
    for (let i = 0; i < K; i++) {
      const idx = begin + i * stride;
      const v = ring[((idx % R) + R) % R] * gain;
      aligned[i] = v;
      mean += v;
    }
    mean /= K;
    for (let i = 0; i < K; i++) aligned[i] -= mean;
    normalize(aligned);
    const window = gaussianWindow(K, period > 0 ? BUFFER_FALLOFF * period : 0, this._prevWindow);
    for (let i = 0; i < K; i++) aligned[i] *= window[i];
    normalize(this._corrBuf);
    // Keep the buffer exactly zero outside the window's support, so the next
    // frame's correlation can skip those taps instead of multiplying by ~0.
    const w = period > 0 ? support(BUFFER_FALLOFF * period) : 0;
    const bufLo = Math.max(0, (K >> 1) - w);
    const bufHi = Math.min(K, (K >> 1) + w);
    this._corrBuf.fill(0, 0, bufLo);
    this._corrBuf.fill(0, bufHi, K);
    for (let i = bufLo; i < bufHi; i++) {
      this._corrBuf[i] = this._corrBuf[i] * (1 - RESPONSIVENESS) + aligned[i] * RESPONSIVENESS;
    }
    this._kLo = bufLo;
    this._kHi = bufHi;
  }
}
