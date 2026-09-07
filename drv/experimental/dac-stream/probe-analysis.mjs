// Instrument-only clocks. None of these records is available to either CPU.
import { COOP, windowBand } from "./cooperative.mjs";

export const KIND = { DAC: 1, GRAB: 2, RELEASE: 3, VINT: 4, DACEN: 5,
  DACBUS: 7, STOP: 8, RESUME: 9, NOTIFY: 10, COPY: 11, POLL: 12, COMMIT: 13,
  HINT: 14, MARK: 15 };
export const Z80_DIV = 15;

export function readProbe(buf) {
  if (buf.length % 8) throw new Error("truncated probe record");
  const events = [];
  for (let i = 0; i < buf.length; i += 8)
    events.push({ kind: buf[i], value: buf.readUInt16LE(i + 2), time: buf.readUInt32LE(i + 4) });
  const of = (kind) => events.filter((e) => e.kind === kind);
  // Events from distinct emulated CPUs need not be in timestamp order.
  // Runs are restricted to < 70 seconds until per-source epoch handling exists.
  const pair = (begin, end) => {
    const pairs = []; let open;
    for (const e of events) {
      if (e.kind === begin) open ??= e.time;
      if (e.kind === end && open !== undefined) {
        pairs.push([open, e.time]); open = undefined;
      }
    }
    return pairs;
  };
  return { events, dac: of(KIND.DACBUS), ym: of(KIND.DAC),
    grabs: pair(KIND.GRAB, KIND.RELEASE), stops: pair(KIND.STOP, KIND.RESUME),
    notifications: of(KIND.NOTIFY), copies: of(KIND.COPY), polls: of(KIND.POLL),
    commits: of(KIND.COMMIT), hints: of(KIND.HINT), marks: of(KIND.MARK) };
}

/**
 * The windows, as generations, from the notifications that bracket them.
 *
 * The Z80 writes the notification through the bank window immediately before
 * the nop run and immediately after it, so the two events bracket
 *   (13 - lambda) + bankWait + window + 4 + lambda
 * where lambda is where inside `ld (nn),a` the write is timestamped. The SPAN
 * does not contain lambda, so it yields the bank cost; lambda itself stays
 * unknown and bounded by 13 cycles, and every boundary below is therefore a
 * BAND, not an instant. Nothing here narrows it by assumption.
 */
export function windowGenerations(log, { windowCycles = COOP.windowCycles } = {}) {
  const raw = [];
  for (let i = 0; i < log.notifications.length; i++) {
    const e = log.notifications[i], next = log.notifications[i + 1];
    if (e.value !== 1 || !next || next.value !== 0) continue;
    // THE Z80 IS STOPPED FOR PART OF THE WINDOW IT IS SERVING, and that stall
    // is wall time inside the bracket. A window with a grab in it measures
    // 84 + hold, not 84. The instruction span is read off the windows where
    // NOTHING happened; using the median of all of them would have priced the
    // stall into the geometry and put every stop outside its own window.
    let stall = 0;
    for (const [a, b] of log.stops)
      if (b > e.time && a < next.time) stall += Math.min(b, next.time) - Math.max(a, e.time);
    raw.push({ open: e, close: next, stalled: stall > 0,
      span: (next.time - e.time - stall) / Z80_DIV });
  }
  // Every generation contributes: the stall inside the bracket is subtracted,
  // so a run where the host takes EVERY window still yields the geometry. The
  // unstalled ones are counted separately because they need no correction at
  // all, and the two agreeing is the check that the correction is right.
  const spans = raw.map((r) => r.span).sort((a, b) => a - b);
  const quiet = raw.filter((r) => !r.stalled).map((r) => r.span).sort((a, b) => a - b);
  if (!spans.length) return { gens: [], span: NaN, band: null, quiet: 0 };
  const span = spans[Math.floor(spans.length / 2)];
  if (quiet.length && quiet[Math.floor(quiet.length / 2)] !== span)
    return { gens: [], span, band: null, quiet: quiet.length, disagree: true };
  const band = windowBand(span, windowCycles);
  // The bank write cannot cost less than nothing, and a span this far from the
  // instruction total means the window is not the code this thinks it is.
  if (band.bankWait < 0 || band.bankWait > 32)
    return { gens: [], span, band: null, quiet: quiet.length, impossible: true };
  const gens = raw.map((r, index) => ({ index, notify1: r.open.time, notify0: r.close.time,
    stalled: r.stalled,
    openMin: r.open.time + band.openMin * Z80_DIV,
    openMax: r.open.time + band.openMax * Z80_DIV,
    // The LAST instant a grant can still land on a nop, in executed time: the
    // window is `windowCycles` of Z80 execution from the opening, and a stall
    // that has already begun cannot be inside it twice.
    grantMax: r.open.time + (band.openMax + windowCycles) * Z80_DIV,
    grantMin: r.open.time + (band.openMin + windowCycles) * Z80_DIV,
    // When the Z80 reads the commit byte: after `xor a` and the closing
    // notification write, so between 0 and 26 cycles past that write plus
    // the bank cost it also pays.
    readLo: r.close.time + band.bankWait * Z80_DIV,
    readHi: r.close.time + (band.bankWait + 26) * Z80_DIV }));
  return { gens, span, band, quiet: quiet.length,
    spanSpread: spans.at(-1) - spans[0] };
}

// Which generation a time belongs to, by the observed notification bracket —
// the one thing here that needs no model at all.
const find = (gens, t) => {
  let lo = 0, hi = gens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, g = gens[mid];
    if (t < g.notify1) hi = mid - 1;
    else if (t > g.notify0) lo = mid + 1;
    else return g;
  }
  return null;
};

/**
 * Payload, order, count, commit and window occupancy — for EVERY transfer
 * mode (§12.2 B). What differs between modes is which of these is an
 * acceptance criterion, not which of them is checked.
 *
 * `source` null means the payload's content is not predictable from here (the
 * diagnostic payload is the handler's own state); order and count still are.
 */
export function analyzeTransfers(log, grabs, { bytes, cooperative, hint, fault }, source,
  { windows = null } = {}) {
  const errors = [], delays = [], polling = [], landing = [];
  const gens = windows?.gens ?? [];
  let copyIndex=0, noteIndex=0, stopIndex=0, commitIndex=0, pollIndex=0;
  let inside = 0, insideLoose = 0, outside = 0;
  for (const [a,b] of grabs) {
    while (copyIndex < log.copies.length && log.copies[copyIndex].time < a) copyIndex++;
    let count=0;
    while (copyIndex < log.copies.length && log.copies[copyIndex].time <= b) {
      const e = log.copies[copyIndex++];
      if (e.value >>> 8 !== count) errors.push("transferred payload order");
      else if (source && (e.value & 255) !== source[count]) errors.push("transferred payload");
      count++;
    }
    if (count !== bytes) errors.push("transferred byte count");
    if (!cooperative && !hint) continue;
    // The commit: present, inside the grab, and written AFTER the last byte.
    while (commitIndex < log.commits.length && log.commits[commitIndex].time < a) commitIndex++;
    const commit = log.commits[commitIndex];
    if (!commit || commit.time > b || commit.value !== 1 || commit.time < log.copies[copyIndex-1]?.time)
      errors.push("missing or premature transfer commit");
    // Where the STOP actually landed. Strictly inside means inside for every
    // value of the unknown timestamp offset; loosely inside means inside for
    // some. Both are reported; neither is asserted from the notification's
    // lifetime, which is 20 cycles longer than the window at both ends.
    while (stopIndex < log.stops.length && log.stops[stopIndex][1] < a) stopIndex++;
    const stop = log.stops[stopIndex];
    if (gens.length && stop) {
      const g = find(gens, stop[0]) ?? find(gens, a);

      if (g) {
        landing.push({ gen: g.index, request: (a - g.openMin) / Z80_DIV,
          stop: (stop[0] - g.openMin) / Z80_DIV, held: (stop[1] - stop[0]) / Z80_DIV });
        // Inside means the GRANT landed on the nop run. Where the release
        // falls is the hold's business, and the hold is bounded separately.
        if (stop[0] >= g.openMax && stop[0] <= g.grantMin) inside++;
        else if (stop[0] >= g.openMin && stop[0] <= g.grantMax) insideLoose++;
        else outside++;
      } else outside++;
    }
    if (cooperative) {
      while (noteIndex+1 < log.notifications.length && log.notifications[noteIndex+1].time <= a) noteIndex++;
      const ready = log.notifications[noteIndex], close = log.notifications[noteIndex+1];
      const delay = (a - (ready?.time ?? NaN))/Z80_DIV;
      delays.push(delay);
      // Contract for this isolated, masked polling loop; hardware is unmeasured.
      if (ready?.value !== 1 || close?.value !== 0 || !(delay >= 0 && delay <= 40)) errors.push("late/stale cooperative request");
      if (!stop) errors.push("no modeled stop for a grab");
      else if (stop[0] < a || stop[1] > close?.time) errors.push("stop/resume outside cooperative window");
      // Fixed maximum hold is checked independently of the mean-rate compensation.
      if (stop && (stop[1]-stop[0])/Z80_DIV > (bytes <= 4 ? 48 : 72)) errors.push("cooperative hold bound");
      while (pollIndex+1 < log.polls.length && log.polls[pollIndex+1].time <= a) pollIndex++;
      const poll = log.polls[pollIndex];
      if (!poll || poll.time > a) errors.push("missing cooperative poll timestamp");
      else polling.push(a-poll.time);
    }
  }
  // COMMIT CARRY-OVER (§12.2 B). Every commit is read by exactly one window —
  // the first whose read point follows it. If that is not the window the
  // commit was written inside, a slot repays a stall that never happened in
  // it. This is the failure a fixed compensation cannot survive, and until now
  // nothing looked for it.
  let carried = 0, ambiguous = 0;
  if (gens.length) for (const c of log.commits) {
    if (c.value !== 1) continue;
    const writtenIn = find(gens, c.time);
    const readBy = gens.find((g) => g.readLo > c.time);
    if (!readBy) continue;
    if (c.time >= readBy.readLo && c.time <= readBy.readHi) { ambiguous++; continue; }
    if (!writtenIn || writtenIn.index !== readBy.index) carried++;
  }
  if (carried) errors.push("commit adopted by a window it was not written in");
  return { errors: [...new Set(errors)], delays, polling, landing,
    inside, insideLoose, outside, carried, ambiguous };
}

/**
 * The 68000's own timeline (§12.2 A/D): when the VDP raised each horizontal
 * interrupt, when the handler actually got there, and what the load cost.
 * Marks are bus writes with a real price, so this only ever describes a ROM
 * that was BUILT with them.
 */
export function analyzeHost(log, { marks = false, calibrate = false } = {}) {
  const out = { entryDelay: null, missedHints: 0, hints: log.hints.length, cal: null };
  if (marks) {
    // Ticks are CONSUMED in order: each entry services the oldest tick still
    // outstanding, and every tick raised before that one and never serviced is
    // lost. Pairing an entry with the nearest preceding tick instead would
    // report a one-cycle latency for a handler that is running late.
    const entries = log.marks.filter((e) => e.value === 1);
    const delays = [];
    // A tick raised less than the exception's own cost before the mark cannot
    // be the tick that caused it — it arrived while this handler was already
    // being entered. 60 cycles is the 68000's own exception sequence plus most
    // of the mark write, and below the shortest entry measured here (65). It is
    // a PAIRING FLOOR: in a run where ticks pile up behind a masked stretch,
    // a reported minimum equal to this floor is the instrument's limit and not
    // a latency the machine achieved.
    const MIN_ENTRY = 60 * 7;
    let h = 0, missed = 0, prevEntry = -Infinity, ambiguous = 0;
    for (const e of entries) {
      const cutoff = e.time - MIN_ENTRY;
      while (h + 1 < log.hints.length && log.hints[h + 1].time <= cutoff) { missed++; h++; }
      if (h < log.hints.length && log.hints[h].time <= cutoff) {
        // Only a tick raised AFTER the previous handler had already stamped its
        // entry has an unambiguous latency; one raised while the machine was
        // still inside the previous handler could have been serviced by either
        // pass, and is counted apart rather than folded into the distribution.
        if (log.hints[h].time > prevEntry) delays.push((e.time - log.hints[h].time) / 7);
        else ambiguous++;
        h++;
      }
      prevEntry = e.time;
    }
    out.ambiguousEntries = ambiguous;
    delays.sort((a, b) => a - b);
    if (delays.length) out.entryDelay = { min: delays[0], p50: delays[Math.floor(delays.length/2)],
      max: delays.at(-1), n: delays.length };
    out.missedHints = missed;
    out.serviced = delays.length;
  }
  if (calibrate) {
    const at = (v) => log.marks.find((e) => e.value === v)?.time;
    const span = (v) => { const a = at(v), b = at(v + 1); return a === undefined || b === undefined ? null : b - a; };
    const markCost = span(0x1a);
    const per = (v, n) => { const s = span(v); return s === null || markCost === null ? null : (s - markCost) / n / 7; };
    out.cal = { markCycles: markCost === null ? null : markCost / 7,
      nop: per(0x10, 256), divu: per(0x12, 32), divuOverflow: per(0x14, 32), divuBig: per(0x16, 32) };
  }
  return out;
}

export function analyzeProbe(log, cfg, expected) {
  const all = log.dac;
  const startTime = (all[0]?.time ?? 0) + cfg.machine.masterHz * 0.25;
  const start = all.findIndex((e) => e.time >= startTime);
  const samples = start < 0 ? [] : all.slice(start);
  const errors = [];
  if (samples.length < 100) errors.push("fewer than 100 measured DAC bus writes; check core/probe version");
  const intervals = samples.slice(1).map((e, i) => ({
    from: samples[i].time, to: e.time, length: e.time - samples[i].time, index: start + i + 1,
  }));
  const T = cfg.periodNum;
  const span = samples.at(-1)?.time - samples[0]?.time;
  const rate = intervals.length * cfg.machine.masterHz / span;
  const errorPct = (rate / cfg.rateHz - 1) * 100;
  const within = (lo, hi) => intervals.filter((g) => g.length >= lo*T && g.length <= hi*T).length / intervals.length;
  const sorted = intervals.map((g) => g.length).sort((a, b) => a - b);
  const holes = intervals.filter((g) => g.length > 1.5*T);
  const overlapping = holes.filter((g) => log.grabs.some(([a, b]) => b > g.from && a < g.to));
  if (!Number.isFinite(errorPct) || Math.abs(errorPct) > 0.1) errors.push("mean rate");
  if (!(within(0.95, 1.05) >= 0.999)) errors.push("99.9% interval band");
  if (sorted[0] < 0.9*T || sorted.at(-1) > 1.1*T) errors.push("hard interval band");
  if (holes.length) errors.push("holes");
  if (all.some((e, i) => i && e.time <= all[i-1].time)) errors.push("non-monotonic DAC clock / wrap");
  // Check startup as well as the measurement window, including both endpoints.
  const firstBad = all.findIndex((e, i) => e.value !== expected(i));
  if (firstBad >= 0) errors.push(`value at sample ${firstBad}: ${all[firstBad].value}, expected ${expected(firstBad)}`);
  if (log.ym.length !== all.length || log.ym.some((e, i) => e.value !== all[i]?.value))
    errors.push("YM/bus value stream mismatch");
  return { errors, startTime, samples, intervals, sorted, rate, errorPct, span,
    inside5: within(0.95, 1.05), inside10: within(0.9, 1.1), holes, overlapping, firstBad };
}

// Errors that describe WHERE something landed in time. An exploratory case is
// allowed to fail these and still be reported; everything else — a wrong byte,
// a missing commit, an out-of-order payload, a commit adopted by the wrong
// window — is a protocol failure and is fatal in every case (§12.2 B).
export const TIMING_ERRORS = ["mean rate", "99.9% interval band", "hard interval band",
  "holes", "window landing"];   // "window geometry" is NOT here: it is the
                                // instrument failing to describe the run.

export function summarizeResults(results) {
  if (!results.length) return { exitCode: 1, text: "FAIL: no matching cases" };
  const fatal = results.filter((r) => r.errors.length && (!r.informational || r.errors.some((e) =>
    !TIMING_ERRORS.includes(e))));
  const required = results.filter((r) => !r.informational);
  const info = results.filter((r) => r.informational);
  return { exitCode: fatal.length ? 1 : 0,
    text: `required ${required.filter((r) => !r.errors.length).length}/${required.length} pass; `
      + `informational ${info.length}, ${info.filter((r) => r.errors.length).length} fail criteria; fatal ${fatal.length}` };
}
