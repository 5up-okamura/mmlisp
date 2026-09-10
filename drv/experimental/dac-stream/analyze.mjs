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
  // A CASE WHOSE LEVELS MOVE HAS NO FIXED REFERENCE (R19 §46.3). The mailbox
  // exists to change the mixer's level pages while the stream runs, so the
  // fixed-level model below is not what the DAC should be carrying — and
  // pretending it is would make the feature working look like a failure. Those
  // cases pass `null` and are graded on the values the STAGED pages take, from
  // the same log, by `dac-stream:decoder`. Stray writes are still checked: they
  // are about ownership, not about levels.
  if (reference) for (let i = 0; i < got.length; i++) {
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
  return checkWriteStream(writes);
}

/**
 * THE RULES, applied to a write stream from wherever it came (R26 §59.4).
 *
 * The JS emulator produces one from its own trace and the machine produces one
 * from the instrument's record of every YM access the Z80 made — and the two
 * have to be judged by the same arithmetic, which is why the table walk lives
 * here on its own and not inside either reader.
 *
 * @param writes {cycle, port, reg, kind} in Z80 cycles, already in order
 */
export function checkWriteStream(writes) {
  const problems = [];
  const lastData = new Map();   // range -> cycle
  const lastAddr = [null, null];
  // THE FREQUENCY LATCH IS A SECOND, SEPARATE THING TO PROTECT (§3.5, R1).
  // Restoring the $2A address latch says nothing about it: $A4-$A6 and
  // $AC-$AE park an upper byte in a per-part holding register that the
  // matching lower write ($A0-$A2, $A8-$AA) commits. Splitting an FM
  // transaction across output intervals — which this engine does — leaves that
  // holding register live across other traffic, so a second upper write before
  // the commit silently loses the first. Checked on its own, and separately
  // from the address latch above.
  //
  // WHICH LATCH, FROM THE CHIP AND NOT FROM A GUESS (R28, step 2). Nuked-OPN2
  // (third_party/Nuked-OPN2/ym3438.c, from the die) keeps TWO holding
  // registers: `reg_a4` for $A4-$A6, committed by $A0-$A2, and `reg_ac` for
  // $AC-$AE, committed by $A8-$AA — and each is ONE register for both parts.
  // So a ch3 special-mode pair (the engine's CSM traffic) and a normal pitch
  // pair never share a latch, while an upper write on port 1 does clobber an
  // uncommitted upper on port 0. The earlier model here — one latch per port
  // covering both groups — was wrong both ways; it is what made R26 §60.7 read
  // CSM's $AC as a threat to a $A4 pair. BlastEm's ym2612.c latches per
  // channel, which is more lenient than the chip; this checks the chip.
  const COMMIT = { 0xa0: 0xa4, 0xa1: 0xa5, 0xa2: 0xa6, 0xa8: 0xac, 0xa9: 0xad, 0xaa: 0xae };
  const isUpper = (r) => (r >= 0xa4 && r <= 0xa6) || (r >= 0xac && r <= 0xae);
  const groupOf = (r) => (r >= 0xa8 && r <= 0xae ? 1 : 0);   // reg_ac : reg_a4
  const held = [null, null];    // latch group -> the upper register waiting to commit
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
    if (isUpper(w.reg)) {
      const g = groupOf(w.reg);
      if (held[g] !== null && (held[g].reg !== w.reg || held[g].port !== w.port))
        problems.push(`cycle ${w.cycle}: port ${w.port} $${w.reg.toString(16)} overwrote the frequency`
          + ` latch port ${held[g].port} $${held[g].reg.toString(16)} was holding, before its lower write`);
      held[g] = { reg: w.reg, port: w.port };
    } else if (COMMIT[w.reg] !== undefined) {
      const g = groupOf(w.reg);
      if (held[g] === null || held[g].reg !== COMMIT[w.reg] || held[g].port !== w.port)
        problems.push(`cycle ${w.cycle}: port ${w.port} $${w.reg.toString(16)} committed a frequency latch`
          + ` holding ${held[g] === null ? "nothing" : `port ${held[g].port} $${held[g].reg.toString(16)}`}`);
      held[g] = null;
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
 * What the Timer B traffic actually did — NOT a phase measurement.
 *
 * §3.2 (R1) withdraws the claim that this is a phase reference. The engine
 * reads one bit; it is set if ANY overflow happened since the last reset, so
 * the reset -> read window has to be SHORTER than one timer period for the
 * answer to constrain anything. It is not, at any cadence the prototype used
 * (P1: ~1,792 cycles between reset and read, P2: ~2,867, against a 1,075.2
 * cycle period), and the measured consequence is `flagSeenPct` = 100.
 *
 * `sinceOverflowP50` / `sinceOverflowMax` are the time from the chip's real
 * overflow to the engine's read. ONLY THE INSTRUMENT KNOWS THEM — the engine
 * has no access to the overflow instant — so they are not the DAC's phase
 * error `e[i]`, not an estimator's error, and not a bound on either.
 */
export function analyzeTimerTraffic(trace, cfg) {
  const overB = trace.overflow.filter(([, n]) => n === "B").map(([c]) => c);
  if (!overB.length || !trace.statusRead.length) return null;
  const delays = [];
  let seen = 0, j = 0;
  for (const [cycle, val] of trace.statusRead) {
    while (j + 1 < overB.length && overB[j + 1] <= cycle) j++;
    if (overB[j] <= cycle) delays.push(cycle - overB[j]);
    if (val & YM.ST_FLAG_B) seen++;
  }
  // The window the engine actually left between clearing the flag and looking
  // at it, measured from the trace rather than assumed from the slot numbers
  // (§3.2 R1: the window is set by where the instructions are, not by which
  // slots carry them).
  const resets = trace.ym.filter(([, port, reg, v]) =>
    port === 0 && reg === YM.R_TIMER_CTL && (v & YM.CTL_RESET_B)).map(([c]) => c);
  const windows = [];
  let r = 0;
  for (const [cycle] of trace.statusRead) {
    while (r + 1 < resets.length && resets[r + 1] <= cycle) r++;
    if (resets.length && resets[r] <= cycle) windows.push(cycle - resets[r]);
  }
  const sorted = [...delays].sort((a, b) => a - b);
  const w = [...windows].sort((a, b) => a - b);
  return {
    reads: trace.statusRead.length,
    overflows: overB.length,
    flagSeen: seen,
    flagSeenPct: +((100 * seen) / trace.statusRead.length).toFixed(1),
    sinceOverflowP50: q(sorted, 0.5), sinceOverflowMax: sorted[sorted.length - 1],
    resetToReadP50: w.length ? q(w, 0.5) : null,
    resetToReadMax: w.length ? w[w.length - 1] : null,
    periodCycles: +cfg.timerBcycles.toFixed(1),
    // The one thing this analysis can conclude: whether the window could have
    // carried information at all.
    informative: w.length ? w[w.length - 1] < cfg.timerBcycles : false,
  };
}

/**
 * §3.3 (R1) — the fixed-lead delay line's invariants, checked rather than
 * asserted in prose:
 *
 *   1. EVERY slot outputs exactly one sample and finishes exactly one. Not
 *      "on average": a slot that skipped a mix because a voice was silent, or
 *      produced two because a command arrived, breaks the whole structure.
 *   2. The distance between what is being finished and what is being played is
 *      CONSTANT, and survives the cursor wrapping the 256-byte page.
 *   3. Nothing reads a sample that is still being built.
 *
 * The check has to name its measurement points, because the cursors are not
 * level with each other at any instant: the play cursor's FETCH runs one
 * sample ahead of the DAC write it feeds (that is what makes `a` free across
 * the pad), so the distance seen between the mixer's store and the fetch in
 * the same slot is `lead - 1`, not `lead`. The invariant is that it never
 * moves, and the expected value is stated.
 */
export function analyzeLead(trace, cfg, mixRange) {
  if (!cfg.voices || !trace.ring.length) return null;
  const inMix = (pc) => pc >= mixRange[0] && pc < mixRange[1];
  const size = cfg.ram.ring[1] - cfg.ram.ring[0];
  const problems = [];
  // Partition the ring accesses by the slot they fall in — a slot being one
  // DAC-write interval.
  let k = 0;
  const dac = trace.dacCycle;
  const perSlot = dac.map(() => ({ fetch: [], store: [], readback: [] }));
  for (const [cycle, pc, addr, isWrite] of trace.ring) {
    while (k + 1 < dac.length && dac[k + 1] <= cycle) k++;
    if (cycle < dac[0]) continue;                 // boot's silence fill and prime
    const slot = perSlot[k];
    if (!inMix(pc)) { if (!isWrite) slot.fetch.push(addr); }
    else if (isWrite) slot.store.push(addr);
    else slot.readback.push(addr);
  }
  const dists = new Set();
  let badCount = 0, badRead = 0;
  // The last slot is cut off mid-flight by the end of the run.
  for (let i = 0; i < perSlot.length - 1; i++) {
    const s = perSlot[i];
    // ONE fetch and ONE store, whatever the voice count: partial sums live in
    // a register, so the only thing that ever reaches the ring is a finished
    // sample.
    if (s.fetch.length !== 1 || s.store.length !== 1) {
      if (badCount++ < 3)
        problems.push(`slot ${i}: ${s.fetch.length} fetches and ${s.store.length} stores,`
          + ` expected 1 and 1`);
      continue;
    }
    const built = s.store[0];
    dists.add(((built - s.fetch[0]) % size + size) % size);
    // Nothing may read the slot under construction except the mixer itself.
    if (s.readback.some((a) => a !== built) && badRead++ < 3)
      problems.push(`slot ${i}: the mixer read ${s.readback} while building ${built}`);
    if (s.fetch[0] === built && badRead++ < 3)
      problems.push(`slot ${i}: the play cursor read ${built}, the sample being built`);
  }
  if (badCount) problems.push(`${badCount} slot(s) did not do exactly one output and one store`);
  const want = cfg.lead - 1;
  if (dists.size !== 1)
    problems.push(`the build-to-play distance took ${dists.size} values (${[...dists].join(", ")})`
      + ` — the fixed lead is not fixed`);
  else if (![...dists][0] !== undefined && [...dists][0] !== want)
    problems.push(`the build-to-play distance is ${[...dists][0]}, expected ${want}`
      + ` (lead ${cfg.lead} less the one-sample fetch-ahead)`);
  return {
    slots: perSlot.length - 1,
    distance: [...dists][0],
    expected: want,
    wraps: Math.floor(perSlot.length / size),
    problems,
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
