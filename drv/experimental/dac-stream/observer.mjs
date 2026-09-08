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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./gen-stream.mjs";
import { op } from "./schedule.mjs";

// The calibrated tables, as a fixed artifact. The Z80 carries the quantised
// byte table; nothing here re-derives it (R6 §17.2 C).
export const PHASE_TABLE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "phase-table.json"), "utf8"));

// Where the decoder's table and state live in P1's RAM. The table is page
// aligned so the lookup is `ld l,h_value : ld h,page`.
export const DECODE = { table: 0x1e00, state: 0x1f00 };
export const STATE = { expect: 0, delta: 1, status: 2, countLo: 3, countHi: 4 };

/**
 * The decode, as the Z80 runs it (R6 §17.4 step 2).
 *
 * MINIMAL STATE, per §17.1: the quantised phase it expected next, the last
 * displacement, whether the reading was one the table knows, and how many
 * observations have gone by. No 16-bit accumulated offset — that belongs to a
 * corrector, and this prototype has none.
 *
 * EVERY PATH IS THE SAME LENGTH. The two reductions are written as a balanced
 * pair (`jr cc,x / jr y / x: op`) so both outcomes cost 19 and 26 cycles, and
 * the 16-bit observation counter is incremented branch-free. The declared cost
 * below is checked against an emulator over every input, not trusted.
 *
 * `step` is this schedule's quantised advance for the read, distributed within
 * the loop so the rounding does not accumulate.
 */
/**
 * This schedule's quantised advance for the read arriving at slot `i`, taken
 * from the same distributed rounding the evaluation uses so the two cannot
 * drift apart. P1 has one read a group and one step; a schedule with several
 * needs one constant per position and the generator would have to emit them.
 */
function quantStep(cfg, i) {
  const unit = PHASE_TABLE.quantised.unit, units = PHASE_TABLE.quantised.units;
  const group = cfg.slotCycles.reduce((a, b) => a + b, 0) * cfg.machine.z80Div;
  const step = (group % PHASE_TABLE.mode.lineMaster) / unit;
  if (!Number.isInteger(step))
    throw new Error(`this schedule's read advance is ${step} units — it needs the distributed steps`);
  return step % units;
}

export function decodeOps(step, { units = 171, half = 86, tag = "" } = {}) {
  const S = DECODE.state;
  return [
    op("exx", 4, { what: "decode: borrow the shadow set" }),
    op(`ld   l,a`, 4),
    op(`ld   h,$${(DECODE.table >> 8).toString(16)}`, 7),
    op("ld   c,(hl)", 7, { what: "quantised phase, $ff = not in the table" }),
    op(`ld   hl,$${S.toString(16)}`, 10),
    op("ld   a,c", 4),
    op("sub  (hl)", 7, { what: "phase - expected" }),
    // …into 0..170, both outcomes 19 cycles
    op([`jr   c,dec_neg${tag}`, `jr   dec_p1${tag}`, `dec_neg${tag}:`, `add  a,${units}`, `dec_p1${tag}:`], 19,
      { what: "reduce into 0..170" }),
    // …into -85..85, both outcomes 26 cycles
    op(["cp   " + half, `jr   nc,dec_big${tag}`, `jr   dec_p2${tag}`, `dec_big${tag}:`, `sub  ${units}`, `dec_p2${tag}:`], 26,
      { what: "signed displacement" }),
    op("inc  l", 4),
    op("ld   (hl),a", 7, { what: "publish the displacement" }),
    op("ld   a,c", 4),
    op("cp   255", 7),
    op("sbc  a,a", 4, { what: "$ff known / $00 unknown, branch-free" }),
    op("inc  l", 4),
    op("ld   (hl),a", 7),
    // the observation number, 16-bit and branch-free
    op("inc  l", 4),
    op("ld   a,(hl)", 7),
    op("add  a,1", 7),
    op("ld   (hl),a", 7),
    op("inc  l", 4),
    op("ld   a,(hl)", 7),
    op("adc  a,0", 7),
    op("ld   (hl),a", 7),
    // the phase expected at the next read
    op("ld   a,c", 4),
    op(`add  a,${step}`, 7),
    op("ld   b,a", 4),
    op("sbc  a,a", 4),
    op(`and  ${256 % units}`, 7, { what: "carry folds back mod 171" }),
    op("add  a,b", 4),
    op(["cp   " + units, `jr   nc,dec_over${tag}`, `jr   dec_p3${tag}`, `dec_over${tag}:`, `sub  ${units}`, `dec_p3${tag}:`], 26),
    op(`ld   l,${S & 0xff}`, 7),
    op("ld   (hl),a", 7),
    op("exx", 4),
  ];
}


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
export function generateObserver(cfg, { reads = ["h"], store = false, at = 0, every = 1,
  decode = false, publish = false } = {}) {
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
  if (decode && reads.join() !== "h") throw new Error("the Z80 decoder reads H only");
  if (decode && cfg.voices) throw new Error("the decoder prototype is P1: the shadow set is the mixer's in P2");
  let observed = 0;
  const gen = generate(cfg, (i) => {
    if (i % cfg.groupSlots !== at || Math.floor(i / cfg.groupSlots) % every !== 0) return [];
    observed++;
    return [
      ...reads.map((r) => op(`ld   a,($${PORTS[r].toString(16)})`, VDP.readCycles,
        { clobbers: ["a"], what: `HV ${r.toUpperCase()} read` })),
      ...(store && !decode ? [op(`ld   ($${store_at.toString(16)}),a`, 13, { what: "keep the reading" })] : []),
      ...(decode ? decodeOps(quantStep(cfg, i), { tag: `_${i}` }) : []),
      // A diagnostic copy of the displacement into 68k work RAM, so the
      // instrument can read what the Z80 decided. A different rom from the one
      // whose cost is being reported.
      ...(publish ? [
        op(`ld   a,($${(DECODE.state + STATE.delta).toString(16)})`, 13, { what: "publish: the displacement" }),
        op("ld   ($8000),a", 16, { what: "publish: through the bank window" }),
      ] : []),
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
  // The table travels in the image, page-aligned past the waveform.
  if (decode) {
    const text = gen.text.replace(/\n\s*ds\s+\$1c00-\$, 0.*$/m, (m) => m);
    const lines = [text.trimEnd(), "",
      `        ds   $${DECODE.table.toString(16)}-$, 0     ; the calibrated phase table`];
    const b = PHASE_TABLE.quantised.bytes;
    for (let i = 0; i < 256; i += 16) lines.push(`        db   ${b.slice(i, i + 16).join(",")}`);
    gen.text = lines.join("\n") + "\n";
  }
  return { ...gen,
    observer: { reads, store, at, every, decode, publish, observedSlots: observed,
      decodeCycles: decode ? decodeOps(0).reduce((t, o) => t + o.cycles, 0) : 0,
      readCycles: VDP.readCycles, workPerSlot: reads.length * VDP.readCycles + (store ? 13 : 0),
      worstSlotPct: gen.placement.worst.workPct,
      loopCycles, readOffsetCycles: at_cycles, spacingCycles,
      spacingMaster: spacingCycles.map((c) => c * cfg.machine.z80Div) } };
}
