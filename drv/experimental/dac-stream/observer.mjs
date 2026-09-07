// THE PHASE OBSERVER, step one: can the Z80 read a clock at all?
// (docs/dac-engine-implementation.md §13.3 step 2, R4.)
//
// R4 orders §3.2's bounded phase correction as its own P1 prototype, and its
// first deliverable is an observer WITH NO CORRECTION — judged on what it can
// actually see. The first candidate to observe is the VDP's HV counter, which
// the 68000 already reads for free and which the Z80 can reach at $7F08 through
// the same window it uses for the 68k bus.
//
// Nothing here is assumed about that read. In the core in use it charges the
// Z80 three cycles and the 68000 eight of its own, and that core's own comment
// says the 68000-side figure is an estimate wanting a fresh logic-analyzer
// capture. So this generates the read, the gate says whether the schedule
// still holds with it in, and the probe records what came back and when. What
// the hardware does is a separate column and is not filled in.
//
// This engine does not correct anything and has no transfer. It is the P1
// output-only schedule with reads placed in one slot of each group.
import { generate } from "./gen-stream.mjs";
import { op } from "./schedule.mjs";

// The Z80's window on the VDP. $7F08/$7F09 are the HV counter: V in the even
// byte, H in the odd one. They are two SEPARATE bus reads of a counter that is
// moving, which is one of the things this is here to measure.
export const VDP = { base: 0x7f00, hvV: 0x7f08, hvH: 0x7f09,
  // 13 for `ld a,(nn)` plus the three cycles the core charges for reaching the
  // 68k bus — the same penalty the bank window pays. If that is wrong, the
  // slot overruns and the DAC intervals say so.
  readCycles: 16 };

const PORTS = { v: VDP.hvV, h: VDP.hvH };

/**
 * The observer rides the REAL schedule: it is generated as extra work inside
 * gen-stream's own slots, so it gets the real mixer, the real CSM traffic and
 * the real pad arithmetic, and a reading that does not fit is a slot overrun
 * at generation time rather than a second copy of the loop that happens to
 * have room.
 *
 * @param reads  which HV bytes to read, in order, e.g. ["v","h"] or ["h","h"]
 * @param store  keep the last byte in RAM (13 cycles), as a real observer must
 * @param at     which slot of the group carries the read
 * @param every  place it in every `every`-th group
 */
export function generateObserver(cfg, { reads = ["h"], store = false, at = 0, every = 1 } = {}) {
  if (!reads.every((r) => r in PORTS)) throw new Error(`reads must be from ${Object.keys(PORTS)}`);
  if (!Number.isInteger(every) || every < 1) throw new Error("every must be a positive group count");
  // Thinning only works if the generated loop actually covers `every` groups.
  // It does not on P1, whose loop IS one group, so `every: 2` there produced a
  // rom that still read every group while the budget was computed for half.
  const groups = cfg.cycleSlots / cfg.groupSlots;
  if (every > 1 && groups % every)
    throw new Error(`every=${every} does not divide this schedule's ${groups} groups`);
  if (!Number.isInteger(at) || at < 0 || at >= cfg.groupSlots) throw new Error("at must be a slot of the group");
  const store_at = cfg.ram.glob[0];
  let observed = 0;
  const gen = generate(cfg, (i) => {
    if (i % cfg.groupSlots !== at || Math.floor(i / cfg.groupSlots) % every !== 0) return [];
    observed++;
    return [
      ...reads.map((r) => op(`ld   a,($${PORTS[r].toString(16)})`, VDP.readCycles,
        { clobbers: ["a"], what: `HV ${r.toUpperCase()} read` })),
      ...(store ? [op(`ld   ($${store_at.toString(16)}),a`, 13, { what: "keep the reading" })] : []),
    ];
  });
  // WHERE THE READS ACTUALLY FALL, from the laid-out slots rather than from a
  // measurement (R5 §15.2 C). A read sits after whatever work its slot already
  // carried, and that work is not the same in every slot — a block-edge slot
  // pushes it later — so the spacing between reads is a pattern, not a
  // constant. The decoder needs this pattern, and taking it from the
  // instrument's own timestamps would let a wrong nominal spacing normalise
  // itself away.
  const first = reads[0] ? `HV ${reads[0].toUpperCase()} read` : null;
  const at_cycles = [];
  let elapsed = 0;
  for (const slot of gen.slots) {
    let inSlot = 0;
    for (const o of slot.ops) {
      if (o.what === first) { at_cycles.push(elapsed + inSlot); break; }
      inSlot += o.cycles;
    }
    elapsed += slot.cycles;
  }
  const loopCycles = elapsed;
  // ARRIVAL-INDEXED, and that convention is now the only one in the code
  // (R5/R6 §17.2 A): spacing[i] is the time from read i-1 to read i, so a
  // decoder holding observation number n looks up steps[n % steps.length].
  // The departure-indexed version read correctly on P1, where every interval
  // is the same, and was wrong on 13,714 of 19,947 intervals in the 2ch
  // schedule, by up to 585 master.
  const spacingCycles = at_cycles.map((t, i) =>
    i === 0 ? t + loopCycles - at_cycles.at(-1) : t - at_cycles[i - 1]);
  return { ...gen,
    observer: { reads, store, at, every, observedSlots: observed,
      readCycles: VDP.readCycles, workPerSlot: reads.length * VDP.readCycles + (store ? 13 : 0),
      worstSlotPct: gen.placement.worst.workPct,
      loopCycles, readOffsetCycles: at_cycles, spacingCycles,
      spacingMaster: spacingCycles.map((c) => c * cfg.machine.z80Div) } };
}
