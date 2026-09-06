// Read a trace and answer §6's questions — VALUE, TIME and BUS, kept apart
// (docs/dac-engine-implementation.md §6.1, §6.2).
//
// The separation is the point. A delivered COUNT is not a sample clock, a
// correct byte stream says nothing about when the bytes left, and a hole that
// overlaps the 68000's bus grab is a different fault from one that does not.
// Every number below says which of the three it belongs to, and no single
// number is allowed to stand in for the others (§7).
import { YM } from "./config.mjs";

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

/** §6.1 — are these the right bytes, in the right order, with none lost? */
export function analyzeValue(trace, reference, { warmup = 0 } = {}) {
  const got = trace.dacValue.slice(warmup);
  const problems = [];
  let firstBad = -1;
  for (let i = 0; i < got.length; i++) {
    const want = reference(i + warmup);
    if (got[i] !== want) { firstBad = i + warmup; break; }
  }
  if (firstBad >= 0)
    problems.push(`sample ${firstBad}: DAC wrote ${trace.dacValue[firstBad]},`
      + ` the reference says ${reference(firstBad)}`);
  if (trace.stray.length)
    problems.push(`${trace.stray.length} write(s) landed outside every device`
      + ` — first at cycle ${trace.stray[0][0]}, $${trace.stray[0][1].toString(16)}`);
  return { samples: got.length, problems, firstBad };
}

/** §6.2 — when did each byte actually leave? */
export function analyzeTime(trace, cfg, { warmup = 0 } = {}) {
  const T = cfg.periodCycles;
  const t = trace.dacCycle.slice(warmup);
  if (t.length < 2) return { n: t.length, problems: ["fewer than two samples"] };

  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const span = t[t.length - 1] - t[0];
  const meanRate = ((t.length - 1) / span) * cfg.z80Hz;
  const rateErrPct = ((meanRate - cfg.rateHz) / cfg.rateHz) * 100;

  const inBand = (lo, hi) => gaps.filter((g) => g >= T * lo && g <= T * hi).length / gaps.length;
  // A hole is a stretch with NO write in it — the DAC repeating its last byte
  // — and it is reported as its own fault, attributed to a bus grab where one
  // overlaps (§4/5 of the 2026-09-04 note: the 68000 was falsified as the
  // cause once already, so the attribution is measured, not assumed).
  const holes = [];
  for (let i = 1; i < t.length; i++) {
    const g = t[i] - t[i - 1];
    if (g <= T * 1.5) continue;
    const overlap = trace.grabs.some(([a, b]) => b > t[i - 1] && a < t[i]);
    holes.push({ at: t[i - 1], cycles: g, periods: +(g / T).toFixed(2), inBusGrab: overlap });
  }

  // Phase: e[i] = t[i] - (t[0] + iT). Long-term drift and the worst excursion
  // are different questions and the total sample count answers neither.
  let maxAbsPhase = 0;
  for (let i = 0; i < t.length; i++) {
    const e = t[i] - (t[0] + i * T);
    if (Math.abs(e) > Math.abs(maxAbsPhase)) maxAbsPhase = e;
  }
  const drift = t[t.length - 1] - (t[0] + (t.length - 1) * T);

  return {
    n: t.length,
    seconds: +(span / cfg.z80Hz).toFixed(3),
    meanRateHz: +meanRate.toFixed(3),
    rateErrPct: +rateErrPct.toFixed(4),
    gapMin: sorted[0], gapMax: sorted[sorted.length - 1],
    gapP50: q(sorted, 0.5), gapP99: q(sorted, 0.99),
    within5pct: +(100 * inBand(0.95, 1.05)).toFixed(4),
    within10pct: +(100 * inBand(0.90, 1.10)).toFixed(4),
    holes, maxAbsPhase: +maxAbsPhase.toFixed(2),
    maxAbsPhasePct: +((100 * Math.abs(maxAbsPhase)) / T).toFixed(3),
    drift: +drift.toFixed(2),
  };
}

/** BUS — what the 68000 took, and what it cost the stream. */
export function analyzeBus(trace, cfg) {
  const held = trace.grabs.reduce((s, [a, b]) => s + (b - a), 0);
  return {
    grabs: trace.grabs.length,
    heldCycles: held,
    heldPeriods: +(held / cfg.periodCycles).toFixed(2),
    longest: trace.grabs.reduce((m, [a, b]) => Math.max(m, b - a), 0),
  };
}

// ── The chip's settling table, checked rather than polled ──────────────────
const rangeOf = (reg) => {
  if (reg === YM.R_KEY) return "0x28";
  if (reg >= 0x21 && reg <= 0x2f) return "0x21-0x2f";
  if (reg >= 0x30 && reg <= 0x9e) return "0x30-0x9e";
  if (reg >= 0xa0 && reg <= 0xb6) return "0xa0-0xb6";
  return "other";
};

/**
 * Does the generated schedule respect the YM2612's settling times
 * (docs/driver.md §5.1)? This replaces a BUSY poll: the poll costs cycles for
 * an answer the table gives for free, and it is what starved the slot writer
 * when the DAC's own writes kept the chip busy.
 */
export function analyzeWrites(trace, cfg) {
  const writes = [];
  for (let i = 0; i < trace.dacCycle.length; i++)
    writes.push({ cycle: trace.dacCycle[i], port: 0, reg: YM.R_DAC, kind: "data" });
  for (const [cycle, port, reg] of trace.ym) writes.push({ cycle, port, reg, kind: "data" });
  for (const [cycle, port, reg] of trace.ymAddr) writes.push({ cycle, port, reg, kind: "addr" });
  writes.sort((a, b) => a.cycle - b.cycle || (a.kind === "addr" ? -1 : 1));

  const problems = [];
  const lastData = new Map();   // range -> cycle
  const lastAddr = [null, null];
  for (const w of writes) {
    if (w.kind === "addr") { lastAddr[w.port] = w; continue; }
    const a = lastAddr[w.port];
    if (!a || a.reg !== w.reg) {
      problems.push(`cycle ${w.cycle}: data for $${w.reg.toString(16)} with`
        + ` $${a ? a.reg.toString(16) : "??"} latched — the address was lost`);
    } else if (w.cycle - a.cycle < YM.wait.addrToOwnData) {
      problems.push(`cycle ${w.cycle}: only ${w.cycle - a.cycle} cycles after its own`
        + ` address write (needs ${YM.wait.addrToOwnData})`);
    }
    const r = rangeOf(w.reg);
    const need = YM.wait[r] ?? 0;
    const prev = lastData.get(r);
    if (prev !== undefined && need && w.cycle - prev < need)
      problems.push(`cycle ${w.cycle}: ${w.cycle - prev} cycles since the last ${r}`
        + ` write (needs ${need})`);
    lastData.set(r, w.cycle);
  }
  return { writes: writes.length, problems };
}

/**
 * Timer B as a PHASE REFERENCE (§3.2). For each status read: how long after
 * the chip's real overflow did the engine look, and did it see the flag? The
 * delay is the phase error a synchroniser would have to live with, and it is
 * measured rather than assumed to be zero.
 */
export function analyzeTimerPhase(trace, cfg) {
  const overB = trace.overflow.filter(([, n]) => n === "B").map(([c]) => c);
  if (!overB.length || !trace.statusRead.length) return null;
  const delays = [];
  let seen = 0, j = 0;
  for (const [cycle, val] of trace.statusRead) {
    while (j + 1 < overB.length && overB[j + 1] <= cycle) j++;
    if (overB[j] <= cycle) delays.push(cycle - overB[j]);
    if (val & YM.ST_FLAG_B) seen++;
  }
  const sorted = [...delays].sort((a, b) => a - b);
  return {
    reads: trace.statusRead.length,
    overflows: overB.length,
    flagSeen: seen,
    flagSeenPct: +((100 * seen) / trace.statusRead.length).toFixed(1),
    delayP50: q(sorted, 0.5), delayMax: sorted[sorted.length - 1],
    periodCycles: +cfg.timerBcycles.toFixed(1),
  };
}

/** The DAC-enable ($2B) intervals — §6.2 measures inside them, not across. */
export function analyzeDacEnable(trace, cfg, totalCycles) {
  const out = [];
  let on = null;
  for (const [cycle, v] of trace.dacEnable) {
    if (v && on === null) on = cycle;
    if (!v && on !== null) { out.push([on, cycle]); on = null; }
  }
  if (on !== null) out.push([on, totalCycles]);
  return out;
}
