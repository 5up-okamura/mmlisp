// Instrument-only clocks. None of these records is available to either CPU.
import { COOP, windowBand } from "./cooperative.mjs";

export const KIND = { DAC: 1, GRAB: 2, RELEASE: 3, VINT: 4, DACEN: 5,
  DACBUS: 7, STOP: 8, RESUME: 9, NOTIFY: 10, COPY: 11, POLL: 12, COMMIT: 13,
  HINT: 14, MARK: 15, MARKW: 16, Z80VDP: 17, Z80RAM: 18 };
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
    // Offset 0 is the cooperative window's one-way notification; offsets 1..7
    // are the diagnostic record a decoding build publishes, one field an
    // address, so a missing or repeated field is visible as itself.
    notifications: of(KIND.NOTIFY).filter((e) => (e.value >>> 8) === 0),
    records: of(KIND.NOTIFY).filter((e) => (e.value >>> 8) !== 0)
      .map((e) => ({ time: e.time, field: (e.value >>> 8) - 1, value: e.value & 0xff })),
    // Every Z80 write to the watched globals page, with no cycle spent by the
    // engine to publish it: the instrument watches the RAM (R7 §20.2 B).
    ramWrites: of(KIND.Z80RAM).map((e) => ({ time: e.time,
      addr: (e.value >>> 8) & 0x7f, value: e.value & 0xff })),
    copies: of(KIND.COPY), polls: of(KIND.POLL),
    commits: of(KIND.COMMIT), hints: of(KIND.HINT), marks: of(KIND.MARK),
    hv: of(KIND.MARKW), z80vdp: of(KIND.Z80VDP) };
}

/**
 * How much of [a, b) the 68000 held the bus for (R9 §26.3).
 *
 * The engine is a static schedule: a stop does not slow it down, it MOVES it.
 * So an interval that contains a stop is not a wrong interval, it is the right
 * interval plus the stop — and subtracting the overlap is what turns a
 * disturbed run back into something the generated schedule can be checked
 * against. The alternative, which this replaces, was to skip every interval
 * containing a stop; with one read a loop and a stall every 3,000 master that
 * skipped all of them and checked nothing at all.
 *
 * BOUNDARIES: a stop is [start, end) and the window is [a, b). A stop that ends
 * exactly at `a`, or starts exactly at `b`, contributes nothing. Overlap is
 * min(end, b) - max(start, a) when positive. Stops are summed, so several in
 * one window are counted once each; they are assumed not to overlap each other,
 * which is what STOP/RESUME pairs from one CPU are.
 */
export function stoppedWithin(a, b, stops, from = 0) {
  let total = 0, i = from;
  while (i < stops.length && stops[i][1] <= a) i++;
  const first = i;
  for (; i < stops.length && stops[i][0] < b; i++) {
    const lo = Math.max(stops[i][0], a), hi = Math.min(stops[i][1], b);
    if (hi > lo) total += hi - lo;
  }
  return { stopped: total, next: first };
}

/**
 * The published records, cut at the reads they belong between (R7 §20.2 B).
 *
 * A record is complete only if all of its fields arrived, in order, AFTER the
 * read that produced them and BEFORE the next read. Everything else is named:
 * a field published before its own read, a record with a field missing, one
 * with a field too many, one whose fields arrived out of order. The earlier
 * check took the first publication after each read and asked nothing else, so
 * a record that never finished, or one that finished a whole observation late,
 * read as a pass.
 *
 * @param reads    [{time}], in order
 * @param records  [{time, field, value}], in order
 * @param names    the field names, index = field number
 */
export function recordsBetweenReads(reads, records, names) {
  const rows = [], problems = { late: 0, short: 0, extra: 0, outOfOrder: 0 };
  // Cut first, judge afterwards. The two are separate because the LAST read is
  // judged by a different rule, and the previous version decided that rule with
  // a subtraction: whatever the final row's fault turned out to be, it did
  // `problems.short--`. A run whose last record arrived out of order came back
  // with short = -1 and outOfOrder = 1, and the caller — which added the counts
  // up — saw zero. A broken record that arrived complete was excused as a
  // truncation (R8 §23.4).
  const cut = [];
  let ri = 0;
  for (let n = 0; n < reads.length; n++) {
    const from = reads[n].time, to = n + 1 < reads.length ? reads[n + 1].time : Infinity;
    while (ri < records.length && records[ri].time <= from) { problems.late++; ri++; }
    const fields = [];
    while (ri < records.length && records[ri].time < to) fields.push(records[ri++]);
    cut.push(fields);
  }
  // A correct PREFIX of a record, of any length including none at all: the
  // fields that did arrive are the right ones in the right order. That, and
  // only that, is what a measurement stopping mid-record looks like.
  const isPrefix = (f) => f.length < names.length && f.every((x, k) => x.field === k);
  // The one allowance: a finite measurement ends somewhere, and the last read
  // may not have got its record out before it did. NO OTHER incompleteness is
  // excused — not a gap in the middle, and not a final record that is complete
  // but wrong. An empty tail is the normal shape of it and used to be counted
  // as short, because the old rule asked for a publication after the last read
  // and a run that stops before the first one has none (R8 §23.4: the 60 s run).
  const tail = cut.length - 1;
  const excuse = cut.length && isPrefix(cut[tail]) ? tail : -1;
  let incompleteTail = 0;
  for (let n = 0; n < cut.length; n++) {
    const fields = cut[n];
    if (n === excuse) { incompleteTail = 1; continue; }         // dropped, not counted
    if (fields.length !== names.length) {
      if (fields.length < names.length) problems.short++; else problems.extra++;
      rows.push(null); continue;
    }
    if (fields.some((x, k) => x.field !== k)) { problems.outOfOrder++; rows.push(null); continue; }
    rows.push(Object.fromEntries(names.map((k, i) => [k, fields[i].value])));
  }
  // Never negative, so a caller cannot be told "nothing is wrong" by two faults
  // cancelling. `broken` is the count of KINDS that fired as well as the total.
  const broken = Object.values(problems).reduce((a, b) => a + b, 0);
  const kinds = Object.entries(problems).filter(([, v]) => v > 0).map(([k]) => k);
  return { rows, problems, incompleteTail, broken, kinds };
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
  const adoption = commitReaders(gens, log.commits);
  if (adoption.carried) errors.push("commit adopted by a window it was not written in");
  return { errors: [...new Set(errors)], delays, polling, landing,
    inside, insideLoose, outside, ...adoption };
}

/**
 * Which window reads each commit — decided by INTERVALS, not by a point.
 *
 * A commit is read by the first window whose read has not already happened.
 * The read itself is only known to a band [readLo, readHi], so for a commit
 * inside that band the time stamps alone cannot say whether this window reads
 * it or the next one does. The earlier version asked `t >= readBy.readLo`
 * AFTER selecting readBy as the first window with `readLo > t`, so that test
 * could never be true and every undecidable case was reported as a carry-over.
 * A commit at 120 against read bands [110,136] and [1110,1136] was called
 * carried; it is not decidable at all (§13.2.1).
 *
 * Boundaries are inclusive on both ends: a commit exactly at readLo or readHi
 * is undecidable, because the read may be at that instant.
 */
export function commitReaders(gens, commits) {
  const rows = [];
  let carried = 0, own = 0, undecided = 0, unread = 0;
  if (!gens.length) return { rows, carried, own, undecided, unread };
  // Commits come from one CPU, so they are in time order; sorting defensively
  // costs one pass and lets the scan below stay linear over a long run.
  const cs = commits.filter((c) => c.value === 1).sort((a, b) => a.time - b.time);
  let g = 0;
  for (const c of cs) {
    while (g < gens.length && c.time > gens[g].readHi) g++;
    const writtenIn = find(gens, c.time);
    if (g >= gens.length) { unread++; rows.push({ time: c.time, verdict: "unread" }); continue; }
    if (c.time < gens[g].readLo) {
      const verdict = writtenIn && writtenIn.index === gens[g].index ? "own" : "carried";
      if (verdict === "own") own++; else carried++;
      rows.push({ time: c.time, readBy: gens[g].index, writtenIn: writtenIn?.index ?? null, verdict });
    } else {
      undecided++;
      rows.push({ time: c.time, readBy: [gens[g].index, gens[g + 1]?.index ?? null],
        writtenIn: writtenIn?.index ?? null, verdict: "undecided" });
    }
  }
  return { rows, carried, own, undecided, unread };
}

/**
 * WHICH BRANCH THE Z80 ACTUALLY TOOK, measured rather than inferred.
 *
 * The served path generates its pad `compensation` cycles short and the absent
 * path does not, so the slot carrying the window is exactly that much shorter
 * when the commit was adopted. The DAC writes bound that slot and are already
 * logged to the master clock, so
 *   repaid = nominal + stall - measured
 * is 0 on the absent path and `compensation` on the served one, with nothing
 * estimated. That makes the fault directly observable instead of argued:
 * a window that repaid a stall WITHOUT having been stalled took a commit that
 * belongs to some other window.
 */
export function analyzeAdoption(log, windows, cfg, compensation, { tolerance = 8 } = {}) {
  const gens = windows?.gens ?? [];
  const nominal = cfg.slotCycles[0] * cfg.machine.z80Div;
  const rows = [];
  let served = 0, absent = 0, unclear = 0, repaidUnstalled = 0, stalledUnrepaid = 0;
  let d = 0;
  for (const g of gens) {
    while (d + 1 < log.dac.length && log.dac[d + 1].time <= g.notify1) d++;
    const a = log.dac[d], b = log.dac[d + 1];
    if (!a || !b || a.time > g.notify1) continue;
    let stall = 0;
    for (const [x, y] of log.stops)
      if (y > a.time && x < b.time) stall += Math.min(y, b.time) - Math.max(x, a.time);
    const repaid = (nominal + stall - (b.time - a.time)) / cfg.machine.z80Div;
    const isServed = Math.abs(repaid - compensation) <= tolerance;
    const isAbsent = Math.abs(repaid) <= tolerance;
    if (isServed) served++; else if (isAbsent) absent++; else unclear++;
    if (isServed && !stall) repaidUnstalled++;
    if (!isServed && stall) stalledUnrepaid++;
    rows.push({ index: g.index, repaid, stall: stall / cfg.machine.z80Div,
      verdict: isServed ? "served" : isAbsent ? "absent" : "unclear" });
  }
  return { rows, served, absent, unclear, repaidUnstalled, stalledUnrepaid };
}

/**
 * The 68000's own timeline (§12.2 A/D): when the VDP raised each horizontal
 * interrupt, when the handler actually got there, and what the load cost.
 * Marks are bus writes with a real price, so this only ever describes a ROM
 * that was BUILT with them.
 */
export const FAULT_MARK = 0x7f, LOAD_TICK_MARK = 6;

/** Did the 68000 take an exception? Checked on EVERY case, marks or not. */
export function faultMarks(log) {
  return (log.marks ?? []).filter((e) => e.value === FAULT_MARK);
}

export function analyzeHost(log, { marks = false, calibrate = false } = {}) {
  const out = { entryDelay: null, missedHints: 0, hints: log.hints.length, cal: null };
  // The foreground load, timed in the observer's OWN rom: one mark every 256
  // iterations, so the loop that is supposed to be running long divides can be
  // shown to be doing it.
  const ticks = (log.marks ?? []).filter((e) => e.value === LOAD_TICK_MARK);
  if (ticks.length > 2) {
    const gaps = [];
    for (let i = 1; i < ticks.length; i++) gaps.push((ticks[i].time - ticks[i - 1].time) / 7 / 256);
    gaps.sort((a, b) => a - b);
    out.load = { ticks: ticks.length, iterationCycles: gaps[Math.floor(gaps.length / 2)],
      min: gaps[0], max: gaps.at(-1) };
  }
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
  // THE SPREAD OF TIMES WITHIN ONE OBSERVED H VALUE — and that is all it is
  // (§13.2.2). It says that in the conditions measured, the H value carried
  // information about the position inside the line. It is NOT a decoder's
  // worst-case error: there is no decoder here, and this number contains
  // nothing about each group's centre, the fixed delay from the read to the
  // mark, H values that were never observed, or how a line or a frame would be
  // identified. Do not quote it as "+/- 69" or as a self-location accuracy,
  // and do not carry a figure measured on the 68000 over to a Z80 read.
  if (log.hv?.length > 1) {
    const LINE = 3420;
    const byH = new Map();
    for (const e of log.hv) {
      const h = e.value & 0xff;
      (byH.get(h) ?? byH.set(h, []).get(h)).push(e.time % LINE);
    }
    let worst = 0, counted = 0, values = 0;
    for (const [, phases] of byH) {
      if (phases.length < 2) continue;
      phases.sort((a, b) => a - b);
      // A group straddling the modulus is not a spread; rotate it if so.
      const direct = phases.at(-1) - phases[0];
      let best = direct;
      for (let i = 1; i < phases.length; i++)
        best = Math.min(best, LINE - (phases[i] - phases[i-1]));
      worst = Math.max(worst, best);
      counted += phases.length; values++;
    }
    out.hv = { readings: log.hv.length, distinctH: byH.size, values,
      counted, widestObservedSpreadMaster: worst };
  }
  return out;
}

/**
 * The compensation residual as a SERIES (§13.2.3).
 *
 * `r = hold - compensation` is what a served slot runs long by, and the
 * question is whether it accumulates. A standard deviation alone does not
 * answer that: it is the random-walk model that turns sd into a drift, and
 * that model needs the residuals to be independent, which is exactly what has
 * not been shown. So this keeps the series in order and reports the things
 * that would distinguish the models — the cumulative excursion, the
 * autocorrelation, and how the spread of a block sum grows with the block
 * length against the sqrt(L) a random walk predicts. It reports them; it does
 * not conclude from them.
 */
export function analyzeResidual(landing, compensation) {
  const r = landing.map((l) => l.held - compensation);
  const n = r.length;
  if (n < 2) return null;
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  let acc = 0, lo = 0, hi = 0;
  for (const v of r) { acc += v; lo = Math.min(lo, acc); hi = Math.max(hi, acc); }
  const auto = [1, 2, 3, 5, 10].map((lag) => {
    if (n <= lag + 1 || sd === 0) return { lag, rho: NaN };
    let c = 0;
    for (let i = 0; i + lag < n; i++) c += (r[i] - mean) * (r[i + lag] - mean);
    return { lag, rho: c / ((n - lag) * sd * sd) };
  });
  const blocks = [10, 100, 1000].filter((L) => n >= 4 * L).map((L) => {
    const sums = [];
    for (let i = 0; i + L <= n; i += L) sums.push(r.slice(i, i + L).reduce((a, b) => a + b, 0));
    const m = sums.reduce((a, b) => a + b, 0) / sums.length;
    const s = Math.sqrt(sums.reduce((a, b) => a + (b - m) ** 2, 0) / sums.length);
    return { length: L, blocks: sums.length, sd: s, randomWalkSd: sd * Math.sqrt(L) };
  });
  return { n, mean, sd, cumulative: { min: lo, max: hi, final: acc }, auto, blocks };
}

/**
 * WHAT THE Z80 GOT WHEN IT READ THE VDP (§13.3 step 2, R4).
 *
 * Three separate questions, kept separate:
 *
 *   1. Did the read cost what the schedule assumed? That is answered by the
 *      DAC gate, not here — if it cost more, the intervals stretch.
 *   2. Is a multi-byte reading COHERENT? V and H are two bus reads of a
 *      counter that is moving, so the gap between them is reported and so is
 *      how far the counter went in it.
 *   3. Does the value carry position information? Reported the same way as on
 *      the 68000 side, and with the same restriction: it is the spread of
 *      times observed within one value, not a decoder's error bound.
 */
export function analyzeZ80Hv(log, cfg, { lineMaster = 3420 } = {}) {
  const rs = log.z80vdp ?? [];
  if (!rs.length) return null;
  const port = (e) => e.value >>> 8, byte = (e) => e.value & 0xff;
  const out = { readings: rs.length, ports: {} };
  for (const p of new Set(rs.map(port))) {
    const es = rs.filter((e) => port(e) === p);
    const byValue = new Map();
    for (const e of es) {
      const v = byte(e);
      (byValue.get(v) ?? byValue.set(v, []).get(v)).push(e.time % lineMaster);
    }
    let worst = 0, groups = 0;
    for (const [, phases] of byValue) {
      if (phases.length < 2) continue;
      phases.sort((a, b) => a - b);
      let best = phases.at(-1) - phases[0];
      for (let i = 1; i < phases.length; i++)
        best = Math.min(best, lineMaster - (phases[i] - phases[i - 1]));
      worst = Math.max(worst, best); groups++;
    }
    out.ports[p] = { readings: es.length, distinct: byValue.size, groups,
      widestObservedSpreadMaster: groups ? worst : null };
  }
  // Consecutive readings inside one slot: the gap between them, and whether
  // the byte moved across it.
  const gaps = [], deltas = [];
  for (let i = 1; i < rs.length; i++) {
    const gap = rs[i].time - rs[i - 1].time;
    if (gap > lineMaster) continue;            // a new slot, not a pair
    gaps.push(gap / cfg.machine.z80Div);
    if (port(rs[i]) === port(rs[i - 1])) deltas.push(byte(rs[i]) - byte(rs[i - 1]));
  }
  gaps.sort((a, b) => a - b); deltas.sort((a, b) => a - b);
  // The extremes of a same-port delta are the counter's own discontinuities —
  // the jump inside the line and the wrap at its end — so the median is what
  // says how far it moved between two reads.
  if (gaps.length) out.pair = { n: gaps.length, gapMin: gaps[0], gapMax: gaps.at(-1),
    sameportDeltaMin: deltas[0] ?? null, sameportDeltaMax: deltas.at(-1) ?? null,
    sameportDeltaMedian: deltas.length ? deltas[Math.floor(deltas.length / 2)] : null };
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
