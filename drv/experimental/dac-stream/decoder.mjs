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
      // A first reading with more than one candidate fixes nothing: adopting
      // options[0] as the origin would make every later residual depend on a
      // coin flip (R5 §15.2 C).
      out.push({ n, phase: options.length > 1 ? null : full,
        phaseMin: Math.min(...options), phaseMax: Math.max(...options),
        residual: null, state: options.length > 1 ? "ambiguous" : "acquiring" });
      if (options.length === 1) prev = full;
      continue;
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
 * Decode a run.
 *
 * THREE THINGS ARE KEPT APART (R5 §15.2 B), because conflating them is how a
 * one-line stall disappeared from the scoring:
 *
 *   delta   — the displacement between two adjacent reads, MODULO ONE LINE.
 *             This is what H measures, and all it measures.
 *   offset  — the running sum of those deltas, which is the phase error
 *             against the output schedule and is therefore ALSO only known
 *             modulo one line. It is exact only while the sync claim below
 *             holds.
 *   sync    — whether the claim "no displacement since acquisition has been
 *             within a guard band of half a line" still stands. When it does
 *             not, the period number may have been lost and the offset is one
 *             of several values, not one.
 *
 * A displacement of exactly one line produces delta 0 and is INVISIBLE here.
 * That is a property of H, not a bug, and the sync state is what carries it:
 * the decoder can only promise the offset while displacements stay small, and
 * it cannot verify that promise from H alone.
 *
 * `spacing` is how far the schedule moves between read n-1 and n, in master
 * clocks, indexed by n modulo its length. It comes from the generated code.
 */
export function decode(readings, { table, steps, lineMaster = LINE_MASTER,
  threshold = 24, guard = 240, indices = null, uncertainty = 24 } = {}) {
  const out = [];
  let prev = null, prevIndex = null, offset = 0, sync = "acquiring";
  const half = lineMaster / 2;
  for (let n = 0; n < readings.length; n++) {
    const h = readings[n];
    const phase = table[h];
    // THE OBSERVATION NUMBER, not the array position. The pattern of spacings
    // repeats with the loop, so the step to use is chosen by where the read
    // sits in the schedule — and after a dropped reading the array position and
    // the schedule position are no longer the same thing (R6 §17.2 A).
    const index = indices ? indices[n] : n;
    if (prevIndex !== null && index <= prevIndex) {
      out.push({ n, index, h, phase: null, delta: null, offset: null,
        sync: "lost", event: "bad-index" });
      prev = null; prevIndex = null; sync = "acquiring"; continue;
    }
    if (phase < 0) {                       // never calibrated: say nothing
      out.push({ n, index, h, phase: null, delta: null, offset: null,
        sync: "lost", event: "unknown" });
      prev = null; prevIndex = null; sync = "acquiring"; continue;
    }
    // A read that did not happen breaks the chain: the schedule moved by an
    // amount this has no observation of.
    const gap = prevIndex === null ? 0 : index - prevIndex - 1;
    if (prev === null || gap > 0) {
      out.push({ n, index, h, phase, delta: null, offset: null,
        sync: prev === null ? "acquiring" : "lost",
        event: gap > 0 ? "gap" : "acquiring" });
      prev = phase; prevIndex = index; offset = 0; sync = "acquiring";
      continue;
    }
    const expected = (prev + steps[index % steps.length]) % lineMaster;
    const delta = wrap(phase - expected, lineMaster);
    offset = wrap(offset + delta, lineMaster);
    // Near half a line the sign of the displacement is not decidable, so the
    // period number may have been lost from here on.
    const undecidable = Math.abs(Math.abs(delta) - half) <= guard;
    if (undecidable) sync = "suspect";
    else if (sync === "acquiring") sync = "valid";
    // A POINT ESTIMATE IS NOT THE ANSWER (R6 §17.2 B). The table's own group
    // span and, in a quantised table, the rounding at BOTH ends of the
    // difference, put a width on every delta. It is carried, not implied.
    out.push({ n, index, h, phase, delta, offset, sync,
      deltaMin: delta - uncertainty, deltaMax: delta + uncertainty,
      // Near half a line the sign is not decidable from the reading, so the
      // two candidates are both named instead of one being chosen.
      candidates: undecidable ? [delta, delta - Math.sign(delta) * lineMaster] : null,
      event: Math.abs(delta) <= threshold ? "steady" : "moved" });
    prev = phase; prevIndex = index;
  }
  return out;
}

/**
 * The read spacing recovered from a run's timestamps.
 *
 * NOT FOR SCORING A RUN (R5 §15.2 C). A spacing learned from the same log it
 * then decodes can normalise a wrong nominal value away — the evaluation takes
 * the pattern from `generateObserver()`'s laid-out slots instead, and requires
 * the measurement to agree with it. This stays for synthetic fixtures, where
 * there is no generated schedule to ask.
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
 * HERE and only here.
 *
 * Three scores, because there are three claims (R5 §15.2 B):
 *
 *   inLine   — how well the decoder measured the displacement WITHIN a line.
 *              This is the small number; it says nothing about displacements
 *              bigger than a line.
 *   visible  — how many real displacements the decoder could see AT ALL,
 *              counted from the truth BEFORE the modulus. A displacement of a
 *              whole line leaves H unchanged, so it is invisible, and it is
 *              counted here rather than quietly scoring as a true negative.
 *   offset   — whether the running phase error the decoder claims matches the
 *              real one, counted only over reads where it claimed valid sync,
 *              and reported next to how many reads that was.
 */
export function scoreDecode(rows, times, spacing, { lineMaster = LINE_MASTER,
  tolerance = 24, disturbed = 24, guard = 240 } = {}) {
  // `spacing` is arrival-indexed by the OBSERVATION number, the same as the
  // decoder's steps.
  const half = lineMaster / 2;
  const events = {}, sync = {};
  let scored = 0, worstInLine = 0, withinTolerance = 0;
  let realShifts = 0, seen = 0, invisible = 0, nearHalf = 0, beyondHalf = 0;
  let falseMoved = 0, signWrong = 0, covered = 0;
  let offsetChecked = 0, offsetAgreed = 0, worstOffset = 0, trueOffset = 0;
  // The real offset WITHOUT the modulus, so the reader can see whether the
  // decoder's mod-line claim means anything on this run.
  let trueUnwrapped = 0, worstUnwrapped = 0;
  const examples = { invisible: [], inLine: [], offset: [] };
  for (const r of rows) {
    events[r.event] = (events[r.event] ?? 0) + 1;
    sync[r.sync] = (sync[r.sync] ?? 0) + 1;
    if (r.delta === null) { trueOffset = 0; trueUnwrapped = 0; continue; }
    const raw = (times[r.n] - times[r.n - 1]) - spacing[(r.index ?? r.n) % spacing.length];
    const wrapped = wrap(raw, lineMaster);
    trueOffset = wrap(trueOffset + raw, lineMaster);
    trueUnwrapped += raw;
    worstUnwrapped = Math.max(worstUnwrapped, Math.abs(trueUnwrapped));
    scored++;
    // Both values live on a circle: two readings near opposite ends of the
    // line differ by a little, not by a line (R6 §17.2 B).
    const err = Math.abs(wrap(r.delta - wrapped, lineMaster));
    worstInLine = Math.max(worstInLine, err);
    if (err <= tolerance) withinTolerance++;
    else if (examples.inLine.length < 3) examples.inLine.push({ n: r.n, delta: r.delta, wrapped });
    if (Math.abs(raw) > disturbed) {
      realShifts++;
      if (r.event === "moved") {
        seen++;
        if (Math.sign(r.delta) !== Math.sign(wrapped)) signWrong++;
      } else {
        invisible++;
        if (examples.invisible.length < 3) examples.invisible.push({ n: r.n, raw, delta: r.delta });
      }
    } else if (r.event === "moved") falseMoved++;   // said it moved; it did not
    // Does the interval the decoder offered actually contain the truth?
    if (r.deltaMin !== undefined && wrapped >= r.deltaMin && wrapped <= r.deltaMax) covered++;
    // Past half a line the magnitude is not recoverable: the decoder reports
    // the short way round. Counted apart from the ones it cannot see at all.
    if (Math.abs(raw) > half) beyondHalf++;
    if (Math.abs(Math.abs(wrapped) - half) <= guard) nearHalf++;
    if (r.sync === "valid") {
      offsetChecked++;
      const d = Math.abs(wrap(r.offset - trueOffset, lineMaster));
      worstOffset = Math.max(worstOffset, d);
      if (d <= tolerance) offsetAgreed++;
      else if (examples.offset.length < 3) examples.offset.push({ n: r.n, claimed: r.offset, real: trueOffset });
    }
  }
  return { rows: rows.length, scored, events, sync,
    inLine: { worstMaster: worstInLine, withinTolerance, of: scored, covered },
    visible: { realShifts, seen, invisible, falseMoved, signWrong,
      beyondHalfLine: beyondHalf, nearHalfLine: nearHalf },
    offset: { checked: offsetChecked, agreed: offsetAgreed, worstMaster: worstOffset,
      trueUnwrappedMaxMaster: worstUnwrapped },
    examples };
}

/**
 * The criteria a run has to meet, by role (R6 §17.2 B). They live here rather
 * than inside the harness so that a decoder that always says "steady", always
 * says "moved", or always says "unknown" can be shown to fail them.
 *
 *   quiet    — nothing disturbed it; the decoder must not invent displacement
 *   contract — displacements inside half a line; the decoder must MEASURE them
 */
export function contractProblems(s, { kind = "contract", minShifts = 100,
  minOffsetChecks = 100, tolerance = 24 } = {}) {
  const bad = [];
  if (s.scored < 500) bad.push(`only ${s.scored} reads scored`);
  if (s.events.unknown) bad.push(`${s.events.unknown} readings had no calibration`);
  if (s.inLine.worstMaster > 40) bad.push(`in-line error ${s.inLine.worstMaster} master`);
  if (s.inLine.withinTolerance !== s.inLine.of)
    bad.push(`${s.inLine.of - s.inLine.withinTolerance} in-line estimates outside tolerance`);
  if (s.inLine.covered !== s.inLine.of)
    bad.push(`the reported interval missed the truth on ${s.inLine.of - s.inLine.covered} reads`);
  if (s.visible.invisible) bad.push(`${s.visible.invisible} displacements were invisible`);
  if (s.visible.beyondHalfLine) bad.push(`${s.visible.beyondHalfLine} displacements passed half a line`);
  if (s.visible.falseMoved) bad.push(`${s.visible.falseMoved} reads reported a displacement that did not happen`);
  if (s.visible.signWrong) bad.push(`${s.visible.signWrong} displacements came back with the wrong sign`);
  if (s.offset.checked < minOffsetChecks)
    bad.push(`the offset claim was checked on only ${s.offset.checked} reads`);
  if (s.offset.agreed !== s.offset.checked)
    bad.push(`the offset claim was wrong on ${s.offset.checked - s.offset.agreed} reads`);
  if (kind === "contract" && s.visible.realShifts < minShifts)
    bad.push(`only ${s.visible.realShifts} displacements to measure`);
  if (kind === "quiet" && s.visible.realShifts)
    bad.push(`${s.visible.realShifts} displacements in a run that should be quiet`);
  return bad;
}

/**
 * The byte table the Z80 would carry, and the integer steps that go with it.
 *
 * The unit has to divide the line so that the wrap is exact: 20 master gives
 * 171 units a line. THE STEPS ARE NOT ROUNDED INDEPENDENTLY (R6 §17.3). A 2ch
 * read spacing of 26,745 master is not a multiple of 20, and rounding each
 * step on its own would accumulate. Instead the CUMULATIVE phase is rounded at
 * every position and the steps are its differences, so the error never exceeds
 * half a unit anywhere and is zero again at the loop boundary — the loop's own
 * length is a whole number of units by construction.
 */
export function quantise(table, spacingMaster, { unit = 20, lineMaster = LINE_MASTER,
  unknown = 0xff } = {}) {
  if (lineMaster % unit) throw new Error(`unit ${unit} does not divide the line`);
  const units = lineMaster / unit;
  if (units > unknown) throw new Error(`unit ${unit} needs ${units} values, which collides with ${unknown}`);
  const bytes = new Uint8Array(256).fill(unknown);
  for (let h = 0; h < 256; h++)
    if (table[h] >= 0) bytes[h] = Math.round(table[h] / unit) % units;
  const total = spacingMaster.reduce((a, b) => a + b, 0);
  if (total % lineMaster % unit) throw new Error(`the loop advances ${total % lineMaster} master, not a whole number of units`);
  let cum = 0, prevRounded = 0;
  const steps = spacingMaster.map((sp) => {
    cum += sp;
    const rounded = Math.round((cum % lineMaster) / unit);
    const step = ((rounded - prevRounded) % units + units) % units;
    prevRounded = rounded % units;
    return step;
  });
  return { bytes, steps, unit, units, unknown, spacingMaster };
}
