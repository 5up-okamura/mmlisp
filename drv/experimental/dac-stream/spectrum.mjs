// Does the CLOCK distort the tone? (§6.3: "正弦波の実時刻による再構成と、同じ
// バイト列を等間隔に置いた再構成を比較する … 値の歪みと時計による歪みを分ける")
//
// Two reconstructions of the same bytes:
//
//   UNIFORM — every sample at i x T. This is what the byte stream sounds like
//            if the clock were perfect, so its spectrum is the VALUE's own.
//   REAL    — every sample at the cycle it was actually written, resampled
//            onto a uniform grid. The difference between the two spectra is
//            the CLOCK, and nothing else.
//
// This does not replace the time gate (§6.3 says so explicitly) — a spectrum
// averages, and one hole in ten seconds hides in it. It answers the other
// question: whether what survives the time gate is audible.
const TWO_PI = Math.PI * 2;

/** Sample-and-hold reconstruction on a uniform grid of `n` points. */
function resampleHold(times, values, t0, dt, n) {
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    while (j + 1 < times.length && times[j + 1] <= t) j++;
    out[i] = values[j] - 128;   // the DAC is unsigned; centre it
  }
  return out;
}

/** Naive DFT of a windowed real signal — n is small on purpose (§6.3 fixes
 *  the window and the interval, so this stays a comparison and not a search). */
function spectrum(x) {
  const n = x.length;
  // Hann, so a tone that is not exactly on a bin does not smear across all of
  // them and get mistaken for a sideband.
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = x[i] * 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = (TWO_PI * k * i) / n;
      re += w[i] * Math.cos(a);
      im -= w[i] * Math.sin(a);
    }
    mag[k] = Math.hypot(re, im) / n;
  }
  return mag;
}

const db = (a, b) => 20 * Math.log10(Math.max(a, 1e-12) / Math.max(b, 1e-12));

/**
 * @param trace   the machine's trace
 * @param cfg     the configuration (nominal period, rate)
 * @param n       DFT length — fixed by the caller, per §6.3
 */
export function compareClock(trace, cfg, { n = 4096, skip = 64 } = {}) {
  const times = trace.dacCycle.slice(skip, skip + n * 2);
  const values = trace.dacValue.slice(skip, skip + n * 2);
  if (times.length < n) return null;
  const T = cfg.periodCycles;

  // A DAC is a zero-order hold in CONTINUOUS time, so the hold is built on an
  // oversampled grid and box-decimated back. Sampling the hold directly at T
  // makes a write that lands 0.6 cycles early look like a whole duplicated
  // sample — an artefact of the measurement worth ~16 dB of imaginary
  // sidebands, which is larger than anything being measured.
  const OS = 8;
  const hold = (t) => {
    const fine = resampleHold(t, values, times[0], T / OS, n * OS);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < OS; j++) acc += fine[i * OS + j];
      out[i] = acc / OS;
    }
    return out;
  };
  const uniform = hold(Float64Array.from({ length: times.length }, (_, i) => times[0] + i * T));
  const real = hold(times);

  const su = spectrum(uniform);
  const sr = spectrum(real);
  // The tone is whatever the uniform reconstruction says it is.
  let peak = 1;
  for (let k = 2; k < su.length; k++) if (su[k] > su[peak]) peak = k;
  const binHz = cfg.rateHz / n;

  // The worst bin that is NOT the tone, in each reconstruction, relative to the
  // tone. Both are dBc, so the DIFFERENCE between them is what the clock added
  // and nothing has to be divided by a bin that is numerically zero — an
  // "added 144 dB" reading is a floor artefact, not a finding.
  const worstOf = (sp) => {
    let k = 0, m = 0;
    for (let i = 2; i < sp.length; i++) {
      if (Math.abs(i - peak) <= 2) continue;
      if (sp[i] > m) { m = sp[i]; k = i; }
    }
    return { k, mag: m };
  };
  const wu = worstOf(su);
  const wr = worstOf(sr);
  return {
    n, binHz: +binHz.toFixed(2),
    toneHz: +(peak * binHz).toFixed(1),
    uniformWorstHz: +(wu.k * binHz).toFixed(1),
    uniformWorstDbc: +db(wu.mag, su[peak]).toFixed(1),
    realWorstHz: +(wr.k * binHz).toFixed(1),
    realWorstDbc: +db(wr.mag, su[peak]).toFixed(1),
    clockAddedDb: +(db(wr.mag, su[peak]) - db(wu.mag, su[peak])).toFixed(1),
  };
}
