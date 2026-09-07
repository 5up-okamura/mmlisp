// The placement engine (docs/dac-engine-implementation.md §3.1, §4).
//
// A slot is an OUTPUT INTERVAL: it begins with the `$2A` data write and lasts
// exactly the number of cycles the profile's Bresenham says it should. Work is
// placed inside it and the remainder is filled with an instruction sequence
// whose cost is EXACT, not approximate. There is no per-song coefficient and
// no "pad fraction": the pad is what the arithmetic leaves.
//
// Two rules make the whole structure provable:
//
//   1. THE SLOT BOUNDARY IS THE DAC WRITE. It is the first instruction of the
//      slot, so the interval between two writes is the slot's length by
//      construction, whatever work the slot carries. Work delays only the pad.
//   2. NOTHING IS EMITTED THAT CANNOT BE COSTED. Every op carries its exact
//      documented cycle count; padTo() refuses to approximate, and a slot that
//      overruns is an assembly-time error rather than a sample that arrives
//      late on hardware.
//
// The pad is honest dead time here, and the placement table says so. In P2 it
// is what the mixer's block work is placed into.

/** An op: exact cycles, the registers it destroys, and what it writes. */
export const op = (asm, cycles, { clobbers = [], writes = [], ...rest } = {}) =>
  ({ asm: Array.isArray(asm) ? asm : [asm], cycles, clobbers, writes, ...rest });

export const cost = (ops) => ops.reduce((t, o) => t + o.cycles, 0);

// ── Filler ─────────────────────────────────────────────────────────────────
// Straight-line fillers, by exact documented cost. `a` is the only register a
// filler may destroy and only where the caller says it is dead; everything
// else here touches nothing at all.
const FILL = [
  { asm: "nop", cycles: 4, clobbers: [] },
  { asm: "inc bc", cycles: 6, clobbers: ["bc"] },
  { asm: "ld a,0", cycles: 7, clobbers: ["a"] },
  { asm: "jp $+3", cycles: 10, clobbers: [] },
  { asm: "jr $+2", cycles: 12, clobbers: [] },
];

// Exactly which totals a straight-line fill can hit, from {4,6,7,10,12}:
// 0, 4, 6, 7, 8, and every n >= 10. 5 and 9 are NOT representable, which is
// why padTo() may spend one djnz iteration to move a residual out of the way.
const straightPlan = (n, allow) => {
  const set = FILL.filter((f) => f.clobbers.every((c) => allow.has(c)));
  const best = new Array(n + 1).fill(null);
  best[0] = [];
  for (let i = 1; i <= n; i++)
    for (const f of set) {
      if (i - f.cycles < 0 || !best[i - f.cycles]) continue;
      const cand = [...best[i - f.cycles], f];
      if (!best[i] || cand.length < best[i].length) best[i] = cand;
    }
  return best[n];
};

/**
 * An instruction sequence costing EXACTLY `n` cycles.
 *
 * Long pads go through `ld b,k : djnz $` (13k + 2 cycles, four bytes) because a
 * 340-cycle pad in nops is 85 of them, and the static schedule is 80 slots
 * long once blocks are in it. `dead` names the registers the caller says are
 * free; b is required for the djnz form.
 */
export function padTo(n, { dead = ["a", "b", "bc"], nopsOnly = false } = {}) {
  if (n < 0) throw new Error(`slot overrun by ${-n} cycles`);
  const allow = new Set(dead);
  if (n === 0) return [];
  // A stretch the 68000 is EXPECTED to take the bus inside is filled with the
  // shortest instruction there is, so that the boundaries the grant can land
  // on form a UNIFORM 4-cycle lattice. BUSREQ is sampled at the end of the
  // machine cycle in flight (Zilog Z80 CPU User Manual, bus request/acknowledge)
  // — not at the end of the instruction, so a branch-taken `djnz` is not 13
  // cycles of blindness; it is 5/4/4, and the spread comes from the boundaries
  // being unevenly spaced rather than from the instruction's length. What the
  // measurement shows is the narrowing: 53..65 cycles of modelled stop under a
  // `djnz` window against 62.8..68.3 under nops. Bytes are the price — one a
  // cycle-quartet — and it is paid only where a stall is planned.
  if (nopsOnly) {
    if (n % 4) throw new Error(`a nop-only pad must be a multiple of 4 cycles, not ${n}`);
    return Array.from({ length: n / 4 }, () => op("nop", 4));
  }
  const straight = n <= 24 || !allow.has("b") ? straightPlan(n, allow) : null;
  if (straight) return straight.map((f) => op(f.asm, f.cycles, { clobbers: f.clobbers }));
  if (!allow.has("b")) throw new Error(`cannot pad ${n} cycles without b`);
  // 13k + 2 for the loop, the rest straight. Walk k down until the residual is
  // representable — one step is always enough (13 cycles moves a residual of
  // 5 or 9 to 18 or 22, and everything from 10 up is reachable).
  const kMax = Math.min(255, Math.floor((n - 2) / 13));
  for (let k = kMax; k >= 1; k--) {
    const tail = n - (13 * k + 2);
    const plan = straightPlan(tail, allow);
    if (plan) {
      return [
        op(`ld b,${k}`, 7, { clobbers: ["b", "bc"] }),
        op("djnz $", 13 * k - 5, { clobbers: ["b", "bc"] }),
        ...plan.map((f) => op(f.asm, f.cycles, { clobbers: f.clobbers })),
      ];
    }
  }
  // 1, 2, 3, 5 and 9 are the only residuals no combination reaches — the Z80
  // has no 5- or 9-cycle instruction that destroys nothing. A slot that lands
  // on one has to move an op to a neighbouring slot; it is never fixed by
  // rounding, which is the whole point of the exception.
  throw new Error(`no exact fill for ${n} cycles`
    + ` (1, 2, 3, 5 and 9 are unreachable: move an op to a neighbouring slot)`);
}

/**
 * Lay one slot out: the DAC write, then work, then an exact pad.
 * Returns the ops and the placement-table row.
 */
export function laySlot({ index, cycles, dacWrite, work = [], tail = [], dead }) {
  // `tail` runs AFTER the pad — the loop-back jump is the only thing that
  // belongs there, and it belongs there because a jump placed before the pad
  // would jump over it. It is still charged to this slot.
  const used = cost([dacWrite, ...work, ...tail]);
  let pad;
  try {
    pad = padTo(cycles - used, { dead });
  } catch (e) {
    // Name the slot and everything in it. "slot overrun by 38 cycles" with no
    // context is a puzzle; "slot 22 wants 396 of 358, carrying the mix, a CSM
    // write and the timer reset" is the answer.
    throw new Error(`slot ${index}: ${e.message}\n`
      + `  wants ${used} of ${cycles} cycles, carrying:\n`
      + [dacWrite, ...work, ...tail]
        .map((o) => `    ${String(o.cycles).padStart(4)}  ${o.what ?? o.asm[0]}`).join("\n"));
  }
  return {
    index, cycles, ops: [dacWrite, ...work, ...pad, ...tail],
    row: {
      slot: index, cycles, work: used, pad: cycles - used,
      workPct: +((100 * used) / cycles).toFixed(1),
      what: [...work, ...tail].length
        ? [...work, ...tail].map((o) => o.what ?? o.asm[0]).join(" + ") : "—",
    },
  };
}

/** The §4 "出力配置表" — what each interval runs, and where the room is. */
export function placementTable(slots, period) {
  const rows = slots.map((s) => s.row);
  const worst = rows.reduce((m, r) => (r.workPct > m.workPct ? r : m), rows[0]);
  return {
    rows, worst,
    meanWorkPct: +(rows.reduce((t, r) => t + r.workPct, 0) / rows.length).toFixed(1),
    period,
  };
}
