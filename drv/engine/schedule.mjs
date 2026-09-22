// The placement engine (docs/driver.md §5.1).
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

// How many BYTES a filler costs. Only the pad solver's own forms are here,
// which is all that is needed: what the byte question is about is padding, and
// padding is the one thing whose size changes when a slot may not touch BC
// (R8 §23.3). `ld b,k`/`djnz $` is four bytes for any length; the same wait in
// `jr $+2` is one byte per six cycles.
const FILL_BYTES = { "nop": 1, "inc bc": 1, "ld a,0": 2, "jp $+3": 3, "jr $+2": 2,
  "djnz $": 2, "push af": 1, "pop  af": 1, "dec  iyl": 2, "jr   nz,$-2": 2,
  // The A counter (R22 §52.3): `dec a` is ONE byte where `dec iyl` is two, and
  // its `jr` reaches one byte further back.
  "dec  a": 1, "jr   nz,$-1": 2 };
export const fillBytes = (ops) => ops.reduce((t, o) => t + o.asm.reduce((u, l) => {
  const n = FILL_BYTES[l] ?? (/^ld b,\d+$/.test(l) ? 2
    : /^ld   iyl,\d+$/.test(l) ? 3
    : /^ld   a,\d+$/.test(l) ? 2 : null);
  if (n === null) throw new Error(`fillBytes: ${l} is not a filler`);
  return u + n;
}, 0), 0);

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
  // 21 cycles in TWO bytes, against `jr $+2`'s 12 — the densest wait there is,
  // and it destroys NOTHING: `pop af` puts back the A and the flags `push af`
  // saved, and the pair is balanced, so all it costs is two bytes of stack
  // while it runs. It exists for the slots that must carry a value in BC and
  // therefore cannot use `ld b,k`/`djnz $` (R8 §23.3). Off unless a caller asks
  // for it: a pad is otherwise pure straight-line code that touches no memory
  // at all, and that property is worth keeping by default.
  { asm: ["push af", "pop  af"], cycles: 21, clobbers: [], stack: 2 },
];

// Exactly which totals a straight-line fill can hit, from {4,6,7,10,12}:
// 0, 4, 6, 7, 8, and every n >= 10. 5 and 9 are NOT representable, which is
// why padTo() may spend one djnz iteration to move a residual out of the way.
const straightPlan = (n, allow, stack = false) => {
  const set = FILL.filter((f) => f.clobbers.every((c) => allow.has(c)) && (stack || !f.stack));
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
export function padTo(n, { dead = ["a", "b", "bc"], nopsOnly = false, stack = false } = {}) {
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
  const mk = (f) => op(f.asm, f.cycles, { clobbers: f.clobbers, stack: f.stack });
  const plans = [];
  const straight = straightPlan(n, allow, stack);
  if (straight) plans.push(straight.map(mk));
  // TWO LOOPS, and the shorter plan wins on BYTES.
  //
  // `ld b,k` / `djnz $` is four bytes for any wait, and it is what most slots
  // use. A slot that has to carry a value in BC cannot have it, and used to
  // fall back on `push af`/`pop af` — two bytes for 21 cycles, the densest
  // straight line there is, but still two bytes every 21 cycles.
  //
  // IYL is the third counter (R19 §46.3): `ld iyl,k` / `dec iyl` / `jr nz` is
  // 20k + 6 cycles in FIVE bytes whatever k is. It is the mixer's register and
  // it is live strictly INSIDE `mix_one` — set from A and read back two
  // instructions later — so it is dead in every pad in the image. The caller
  // has to say so, which is why it is in `dead` and not assumed here.
  //
  // What this buys is BYTES, not cycles. The reserved padding a `complete`
  // build executes is provisional — the real feature replaces it — and paying
  // for it in image is what pushed the 15-level engine with CSM, the corrector,
  // the protocol and the consumer past its region.
  const loop = (setup, per, base, name) => {
    const kMax = Math.min(255, Math.floor((n - base) / per));
    for (let k = kMax; k >= 1; k--) {
      const tail = straightPlan(n - (per * k + base), allow, stack);
      if (!tail) continue;
      return [...setup(k), ...tail.map(mk)];
    }
    return null;
  };
  // A IS THE CHEAPEST COUNTER OF THE THREE (R22 §52.3). `ld a,k` / `dec a` /
  // `jr nz` is FIVE bytes for any wait against IYL's seven, because `dec a` is
  // one byte and `dec iyl` is two with its IY prefix. Both destroy the flags,
  // and both are only offered where the caller has said the register is dead —
  // which for A is everywhere a pad runs, since the one value that crosses a
  // slot boundary in flags does so in AF' (R17 §43.4).
  //
  // It matters because moving the counter to the head of the decode (R22
  // §52.2) left nine more slots carrying a value in BC through their pad, and
  // at seven bytes each that was thirteen bytes past the 2,560 B region.
  if (allow.has("a")) {
    const p = loop((k) => [op(`ld   a,${k}`, 7, { clobbers: ["a"] }),
      op(["dec  a", "jr   nz,$-1"], 16 * k - 5, { clobbers: ["a"] })], 16, 2);
    if (p) plans.push(p);
  }
  if (allow.has("iy")) {
    const p = loop((k) => [op(`ld   iyl,${k}`, 11, { clobbers: ["iy"] }),
      op(["dec  iyl", "jr   nz,$-2"], 20 * k - 5, { clobbers: ["iy"] })], 20, 6);
    if (p) plans.push(p);
  }
  if (allow.has("b")) {
    const p = loop((k) => [op(`ld b,${k}`, 7, { clobbers: ["b", "bc"] }),
      op("djnz $", 13 * k - 5, { clobbers: ["b", "bc"] })], 13, 2);
    if (p) plans.push(p);
  }
  if (plans.length) {
    plans.sort((x, y) => fillBytes(x) - fillBytes(y) || x.length - y.length);
    return plans[0];
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
export function laySlot({ index, cycles, dacWrite, work = [], tail = [], dead, fill }) {
  // `tail` runs AFTER the pad — the loop-back jump is the only thing that
  // belongs there, and it belongs there because a jump placed before the pad
  // would jump over it. It is still charged to this slot.
  const used = cost([dacWrite, ...work, ...tail]);
  let pad;
  try {
    pad = padTo(cycles - used, fill ?? { dead });
  } catch (e) {
    // Name the slot and everything in it. "slot overrun by 38 cycles" with no
    // context is a puzzle; "slot 22 wants 396 of 358, carrying the mix, a CSM
    // write and the timer reset" is the answer.
    throw new Error(`slot ${index}: ${e.message}\n`
      + `  wants ${used} of ${cycles} cycles, carrying:\n`
      + [dacWrite, ...work, ...tail]
        .map((o) => `    ${String(o.cycles).padStart(4)}  ${o.what ?? o.asm[0]}`).join("\n"));
  }
  // A CORRECTION LADDER IS PART WORK, PART PAD (R10 §29.5). Its `jp` is a fixed
  // cost the ceiling has to hold; the `nop`s it lands in are the timing itself
  // — the same cycles the pad solver would otherwise have emitted — so charging
  // the whole neutral run as work would put 16 cycles of pure padding into
  // every ladder slot's work column. The slot's LENGTH is unaffected either
  // way: only the accounting moves.
  const asPad = [...work, ...tail]
    .reduce((t, o) => t + (o.ladderWork === undefined ? 0 : o.cycles - o.ladderWork), 0);
  const charged = used - asPad;
  return {
    index, cycles, ops: [dacWrite, ...work, ...pad, ...tail], pad,
    row: {
      slot: index, cycles, work: charged, pad: cycles - charged,
      workPct: +((100 * charged) / cycles).toFixed(1),
      ladderPad: asPad || undefined,
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
