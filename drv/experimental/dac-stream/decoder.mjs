// THE PHASE DECODER (docs/dac-engine-implementation.md §13.3 step 3, R4).
//
// The observer reads the VDP's H counter; this turns a reading into a phase and
// says whether the schedule has moved. What it is allowed to use is fixed:
//
//   RUNTIME INPUTS — the byte the Z80 read, the read's index in the schedule,
//   and state the decoder itself kept. Nothing else. The instrument's absolute
//   clock is for SCORING this decoder, never for running it.
//
//   CALIBRATION — the H-to-phase table is a property of the VDP's counter, not
//   of any particular run: a shipped decoder would carry it as a constant from
//   the hardware's documented behaviour. It is derived here from a measured run
//   because that is the description of the counter available, and building it
//   that way is a step that has to be repeated on hardware before any of this
//   is a hardware claim.
//
// The decoder is DIFFERENTIAL. It does not need to know the boot phase: the
// schedule says how far apart two reads are, so the phase difference between
// them is known, and anything else is the schedule having moved.

export const LINE_MASTER = 3420;

/**
 * H value -> line phase, in master clocks, from (reading, time) pairs.
 * Returns the table plus what it does NOT cover, because a decoder that meets
 * an H value it has never seen must say so rather than interpolate.
 */
export function buildPhaseTable(pairs, { lineMaster = LINE_MASTER, origin = 0 } = {}) {
  const acc = new Map();
  for (const { h, time } of pairs) {
    const p = (((time - origin) % lineMaster) + lineMaster) % lineMaster;
    (acc.get(h) ?? acc.set(h, []).get(h)).push(p);
  }
  const table = new Int16Array(256).fill(-1);
  let widest = 0;
  for (const [h, ps] of acc) {
    ps.sort((a, b) => a - b);
    // A counter value observed on both sides of the line's wrap would have a
    // meaningless mean; rotate to the tightest arc first.
    let best = { span: ps.at(-1) - ps[0], rot: 0 };
    for (let i = 1; i < ps.length; i++) {
      const span = lineMaster - (ps[i] - ps[i - 1]);
      if (span < best.span) best = { span, rot: i };
    }
    const rotated = ps.slice(best.rot).concat(ps.slice(0, best.rot).map((v) => v + lineMaster));
    const mean = rotated.reduce((a, b) => a + b, 0) / rotated.length;
    table[h] = Math.round(mean) % lineMaster;
    widest = Math.max(widest, best.span);
  }
  return { table, covered: acc.size, widestGroupSpanMaster: widest };
}

export const FRAME_MASTER = 896040;   // 262 lines
export const FRAME_LINES = FRAME_MASTER / LINE_MASTER;

const wrap = (d, m) => { d %= m; if (d > m / 2) d -= m; if (d < -m / 2) d += m; return d; };

/**
 * Where the VDP's line actually begins, in master clocks — a chip constant,
 * not a property of a run. It is found by asking which origin makes V a
 * single-valued function of the line: with the wrong origin a V value straddles
 * two ordinals and nothing downstream can be right.
 */
export function findLineOrigin(vpairs, { lineMaster = LINE_MASTER,
  frameMaster = FRAME_MASTER, step = 15 } = {}) {
  let best = null;
  for (let o = 0; o < lineMaster; o += step) {
    const m = new Map();
    for (const { v, time } of vpairs) {
      const ord = Math.floor(((((time - o) % frameMaster) + frameMaster) % frameMaster) / lineMaster);
      (m.get(v) ?? m.set(v, new Set()).get(v)).add(ord);
    }
    let multi = 0;
    for (const [, s] of m) if (s.size > 1) multi++;
    if (!best || multi < best.multi) best = { origin: o, multi, values: m.size };
  }
  return best;
}

/**
 * V value -> which line of the frame it is, the same way the H table is built.
 * V is a line number already, but it is not a line INDEX: the counter jumps
 * across the vertical blank, so the ordinals have to be observed rather than
 * assumed.
 */
export function buildLineTable(pairs, { lineMaster = LINE_MASTER,
  frameMaster = FRAME_MASTER, origin = 0 } = {}) {
  const acc = new Map();
  for (const { v, time } of pairs) {
    const ordinal = Math.floor(((((time - origin) % frameMaster) + frameMaster) % frameMaster) / lineMaster);
    (acc.get(v) ?? acc.set(v, new Map()).get(v));
    const m = acc.get(v);
    m.set(ordinal, (m.get(ordinal) ?? 0) + 1);
  }
  const table = new Int16Array(256).fill(-1);
  // ONE V DOES NOT ALWAYS MEAN ONE LINE. The NTSC counter jumps backwards
  // across the vertical blank, so a handful of values occur twice in a frame,
  // six lines apart. A value like that is not decided by picking the popular
  // ordinal; the candidates are kept and the decode reports the range.
  const candidates = new Map();
  let ambiguous = 0;
  for (const [v, m] of acc) {
    const ords = [...m.keys()].sort((a, b) => a - b);
    table[v] = ords[0];
    candidates.set(v, ords);
    if (ords.length > 1) ambiguous++;
  }
  return { table, candidates, covered: acc.size, ambiguous };
}

/**
 * Decode V+H pairs into a phase within the FRAME, which is what lifts the
 * ambiguity from half a line to half a frame.
 *
 * The two bytes are two bus reads, so V is read `gapMaster` before H. If H
 * lands earlier in its line than that gap, the line advanced in between and
 * the V that was read belongs to the previous one. That correction assumes the
 * NOMINAL gap; a stall landing between the two reads breaks the assumption,
 * and the residual is what shows it — this does not pretend otherwise.
 */
export function decodeVH(pairs, { hTable, vTable, candidates = null, steps, gapMaster = 240,
  lineMaster = LINE_MASTER, frameMaster = FRAME_MASTER, threshold = 24 } = {}) {
  const out = [];
  let prev = null;
  for (let n = 0; n < pairs.length; n++) {
    const { v, h } = pairs[n];
    const phase = hTable[h], line = vTable[v];
    if (phase < 0 || line < 0) {
      out.push({ n, phase: null, residual: null, state: "unknown" });
      prev = null; continue;
    }
    const crossed = phase < gapMaster ? 1 : 0;
    const ords = candidates?.get(v) ?? [line];
    const options = ords.map((o) => ((o + crossed) % FRAME_LINES) * lineMaster + phase);
    const full = options[0];
    if (prev === null) {
      out.push({ n, phase: full, phaseMin: Math.min(...options), phaseMax: Math.max(...options),
        residual: null, state: "acquiring" });
      prev = full; continue;
    }
    const expected = (prev + steps[n % steps.length]) % frameMaster;
    if (options.length > 1) {
      // Two lines of the frame answer to this reading. Which one it is cannot
      // be had from the reading, so the decode says so and carries the
      // prediction forward rather than choosing.
      out.push({ n, phase: null, phaseMin: Math.min(...options), phaseMax: Math.max(...options),
        residual: null, state: "ambiguous",
        residuals: options.map((f) => wrap(f - expected, frameMaster)) });
      prev = expected;
      continue;
    }
    const residual = wrap(full - expected, frameMaster);
    out.push({ n, phase: full, phaseMin: full, phaseMax: full, residual,
      state: Math.abs(residual) <= threshold ? "locked" : "moved" });
    prev = full;
  }
  return out;
}

/**
 * Decode a run. `steps` is how far the schedule moves the phase between read
 * n-1 and read n, in master clocks, indexed by n modulo its own length — the
 * code knows this because it is the code.
 *
 * Output per read: the phase the decoder believes it is at, the residual
 * against what the schedule predicted, and whether it can speak at all.
 */
export function decode(readings, { table, steps, lineMaster = LINE_MASTER,
  threshold = 24 } = {}) {
  const out = [];
  let prev = null, cumulative = 0, synced = false;
  for (let n = 0; n < readings.length; n++) {
    const h = readings[n];
    const phase = table[h];
    if (phase < 0) {                       // never calibrated: say nothing
      out.push({ n, h, phase: null, residual: null, state: "unknown" });
      prev = null; synced = false; continue;
    }
    if (prev === null) {                   // the first reading fixes nothing
      out.push({ n, h, phase, residual: null, state: "acquiring" });
      prev = phase; synced = true; continue;
    }
    const expected = (prev + steps[n % steps.length]) % lineMaster;
    const residual = wrap(phase - expected, lineMaster);
    cumulative += residual;
    const state = Math.abs(residual) <= threshold ? "locked" : "moved";
    out.push({ n, h, phase, residual, cumulative, state });
    prev = phase;
    synced = state === "locked" && synced;
  }
  return out;
}

/**
 * The spacing the schedule itself produces between consecutive reads, in
 * master clocks, indexed by the read's position in the pattern. These are
 * constants of the generated code; taking the median of a clean run is how
 * they are recovered here, and the check that they are right is that the same
 * run then decodes with a zero residual.
 */
export function learnSpacing(times, period) {
  const acc = Array.from({ length: period }, () => []);
  for (let n = 1; n < times.length; n++) acc[n % period].push(times[n] - times[n - 1]);
  return acc.map((xs) => {
    if (!xs.length) return 0;
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  });
}

/**
 * Score a decoding against what really happened. The absolute times are used
 * HERE and only here: this is the evaluation, not the decoder.
 *
 * `truth` is the shift the schedule really took between two reads — the
 * measured gap less the gap the schedule was built to have — and the decoder's
 * residual is supposed to be that, wrapped into one line.
 */
export function scoreDecode(rows, times, spacing, { lineMaster = LINE_MASTER,
  tolerance = 24, disturbed = 24, modulus = null } = {}) {
  lineMaster = modulus ?? lineMaster;
  const counts = { locked: 0, moved: 0, unknown: 0, acquiring: 0, ambiguous: 0 };
  let worst = 0, within = 0, scored = 0, wrapped = 0, worstTruth = 0;
  let truePositive = 0, falsePositive = 0, falseNegative = 0, trueNegative = 0;
  const misses = [];
  for (const r of rows) {
    counts[r.state]++;
    if (r.residual === null) continue;
    // The shift that really happened, and the same shift as the decoder can
    // possibly see it. H repeats every line, so anything at or past half a line
    // is reported as the short way round and the difference is UNKNOWABLE from
    // H alone — counted, never quietly corrected.
    const raw = (times[r.n] - times[r.n - 1]) - spacing[r.n % spacing.length];
    const truth = wrap(raw, lineMaster);
    if (raw !== truth) wrapped++;
    worstTruth = Math.max(worstTruth, Math.abs(raw));
    const err = Math.abs(r.residual - truth);
    scored++; worst = Math.max(worst, err);
    if (err <= tolerance) within++; else misses.push({ n: r.n, residual: r.residual, truth });
    const real = Math.abs(truth) > disturbed, said = r.state === "moved";
    if (real && said) truePositive++;
    else if (real && !said) falseNegative++;
    else if (!real && said) falsePositive++;
    else trueNegative++;
  }
  return { ...counts, scored, worstErrorMaster: worst,
    withinToleranceFraction: scored ? within / scored : 0,
    truePositive, falsePositive, falseNegative, trueNegative,
    wrapped, worstTrueShiftMaster: worstTruth,
    misses: misses.slice(0, 5) };
}
