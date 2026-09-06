// Instrument-only clocks. None of these records is available to either CPU.
export const KIND = { DAC: 1, GRAB: 2, RELEASE: 3, VINT: 4, DACEN: 5,
  DACBUS: 7, STOP: 8, RESUME: 9, NOTIFY: 10, COPY: 11, POLL: 12, COMMIT: 13 };

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
    notifications: of(KIND.NOTIFY), copies: of(KIND.COPY), polls: of(KIND.POLL), commits: of(KIND.COMMIT) };
}

export function analyzeTransfers(log, grabs, { bytes, cooperative }, source) {
  const errors = [], delays = [], polling = [];
  let copyIndex=0, noteIndex=0, stopIndex=0, commitIndex=0, pollIndex=0;
  for (const [a,b] of grabs) {
    while (copyIndex < log.copies.length && log.copies[copyIndex].time < a) copyIndex++;
    let count=0;
    while (copyIndex < log.copies.length && log.copies[copyIndex].time <= b) {
      const e = log.copies[copyIndex++];
      if (e.value >>> 8 !== count || (e.value & 255) !== source[count]) errors.push("transferred payload/order");
      count++;
    }
    if (count !== bytes) errors.push("transferred byte count");
    if (!cooperative) continue;
    while (noteIndex+1 < log.notifications.length && log.notifications[noteIndex+1].time <= a) noteIndex++;
    const ready = log.notifications[noteIndex], close = log.notifications[noteIndex+1];
    const delay = (a - (ready?.time ?? NaN))/15;
    delays.push(delay);
    // Contract for this isolated, masked polling loop; hardware is unmeasured.
    if (ready?.value !== 1 || close?.value !== 0 || !(delay >= 0 && delay <= 40)) errors.push("late/stale cooperative request");
    while (stopIndex < log.stops.length && log.stops[stopIndex][1] < a) stopIndex++;
    const stop = log.stops[stopIndex];
    if (!stop || stop[0] < a || stop[1] > close?.time) errors.push("stop/resume outside cooperative window");
    // Fixed maximum hold is checked independently of the mean-rate compensation.
    if (stop && (stop[1]-stop[0])/15 > (bytes <= 4 ? 48 : 72)) errors.push("cooperative hold bound");
    while (commitIndex < log.commits.length && log.commits[commitIndex].time < a) commitIndex++;
    const commit = log.commits[commitIndex];
    if (!commit || commit.time > b || commit.value !== 1 || commit.time < log.copies[copyIndex-1]?.time)
      errors.push("missing or premature transfer commit");
    while (pollIndex+1 < log.polls.length && log.polls[pollIndex+1].time <= a) pollIndex++;
    const poll = log.polls[pollIndex];
    if (!poll || poll.time > a) errors.push("missing cooperative poll timestamp");
    else polling.push(a-poll.time);
  }
  return { errors: [...new Set(errors)], delays, polling };
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

export function summarizeResults(results) {
  if (!results.length) return { exitCode: 1, text: "FAIL: no matching cases" };
  // Informational timing failures are reported, but value/instrument failures
  // must never be hidden by the informational flag.
  const fatal = results.filter((r) => r.errors.length && (!r.informational || r.errors.some((e) =>
    !["mean rate", "99.9% interval band", "hard interval band", "holes"].includes(e))));
  const required = results.filter((r) => !r.informational);
  const info = results.filter((r) => r.informational);
  return { exitCode: fatal.length ? 1 : 0,
    text: `required ${required.filter((r) => !r.errors.length).length}/${required.length} pass; `
      + `informational ${info.length}, ${info.filter((r) => r.errors.length).length} fail criteria; fatal ${fatal.length}` };
}
