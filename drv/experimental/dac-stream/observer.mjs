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
import { GLOB } from "./config.mjs";
import { generate } from "./gen-stream.mjs";
import { op } from "./schedule.mjs";

// The calibrated tables, as a fixed artifact. The Z80 carries the quantised
// byte table; nothing here re-derives it (R6 §17.2 C).
export const PHASE_TABLE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "phase-table.json"), "utf8"));

// ── the decoder's state, and where it lives ────────────────────────────────
// SIX BYTES, and every one of them is named in the RAM map (R7 §20.2 B). The
// addresses used to be constants here — $1e00 for the table and $1f00 for the
// state — and $1f00 is G_STATUS, G_CSMHI, G_CSMLO. The decoder was writing on
// top of the CSM frequency the loop reloads every group. Nothing detected it,
// because neither address was a region anything checked.
export const STATE = { known: 0, valid: 1, expect: 2, delta: 3, countLo: 4, countHi: 5 };
export const STATE_SIZE = 6;

// What a completed decision consists of, in the order it is published. EXPECT
// is not in it: it is the decoder's own carry, not a result, and the
// instrument re-derives it to check the ones that are.
export const PUBLISH = ["known", "valid", "delta", "countLo", "countHi"];

/** The decoder's two homes in a given RAM map, checked rather than assumed. */
export function decodeMap(cfg) {
  const phase = cfg.ram.phase;
  if (!phase) throw new Error("this RAM map reserves no page for the phase table");
  if (phase[0] & 0xff) throw new Error("the phase table must be page aligned");
  if (phase[1] - phase[0] < 256) throw new Error("the phase table needs a whole 256 B page");
  const state = cfg.ram.glob[0] + GLOB.decode;
  if (state + STATE_SIZE > cfg.ram.glob[1])
    throw new Error("the decoder state does not fit in the globals");
  if ((state & 0xff) + STATE_SIZE > 0x100)
    throw new Error("the decoder state straddles a page — the decode indexes it with `inc l`");
  // The live globals this build also uses. A byte can be shared only by
  // features that cannot be built together, and that has to be checked, not
  // remembered.
  const live = [[GLOB.status, 1], [GLOB.csmHi, 1], [GLOB.csmLo, 1],
    ...(cfg.voices ? [[GLOB.v0page, 1], [GLOB.v1page, 1], [GLOB.mpage, 1]] : []),
    [GLOB.observe, 1]];
  for (const [off, len] of live)
    if (off < GLOB.decode + STATE_SIZE && GLOB.decode < off + len)
      throw new Error(`the decoder state overlaps the global at +$${off.toString(16)}`);
  return { table: phase[0], state };
}

/** Boot code for the state. Not timed; it runs before the first sample. */
export function decodeInitOps({ state }) {
  return [
    `ld   hl,$${state.toString(16)}`,
    `ld   b,${STATE_SIZE}`,
    "decinit:",
    "ld   (hl),0",
    "inc  l",
    "djnz decinit",
  ];
}

/**
 * The decode, as JavaScript runs it — the ONE reference the emulator check and
 * the BlastEm evaluation both score against.
 *
 * The state machine R7 §20.2 A asks for, and the reason it exists: the first
 * version published a difference from the very first reading and ran an
 * unknown reading through the same arithmetic, so the next good reading
 * differed from a number made out of $ff. Three positions, not two:
 *
 *   known = 0            this reading was not in the table. The chain breaks.
 *   known = $ff, valid 0 a reading to measure the next one FROM. No difference.
 *   known = $ff, valid $ff  two consecutive known readings: DELTA is real.
 */
export function refDecode(prev, reading, step,
  { units = PHASE_TABLE.quantised.units, unknown = PHASE_TABLE.quantised.unknown,
    table = PHASE_TABLE.quantised.bytes } = {}) {
  const phase = table[reading];
  const known = phase === unknown ? 0 : 0xff;
  const valid = known & prev.known;
  let d = (phase - prev.expect) % units;
  if (d < 0) d += units;
  if (d >= (units + 1) >> 1) d -= units;
  const delta = valid ? d & 0xff : 0;
  const count = (prev.count + 1) & 0xffff;
  const expect = known ? (phase + step) % units : 0;
  return { known, valid, delta, count, expect };
}

export const INITIAL_STATE = { known: 0, valid: 0, delta: 0, count: 0, expect: 0 };

/**
 * The decode, as the Z80 runs it (R6 §17.4 step 2, rebuilt for R7 §20.2 A).
 *
 * EVERY PATH IS THE SAME LENGTH. The three reductions are written as balanced
 * pairs (`jr cc,x / jr y / x: op`) so both outcomes cost the same, and both the
 * acquisition gate and the 16-bit counter are branch-free — the gate is an AND
 * of two masks, not a test. The declared cost below is checked against an
 * emulator over every input and every state, not trusted.
 *
 * `step` is this schedule's quantised advance for the read, distributed within
 * the loop so the rounding does not accumulate.
 */
export function decodeOps(step, { table, state, units = PHASE_TABLE.quantised.units,
  unknown = PHASE_TABLE.quantised.unknown, tag = "" } = {}) {
  if (table === undefined || state === undefined)
    throw new Error("decodeOps needs the addresses from decodeMap(cfg)");
  const half = (units + 1) >> 1;
  const lo = (k) => `$${((state + k) & 0xff).toString(16)}`;
  return [
    op("exx", 4, { what: "decode: borrow the shadow set" }),
    op("ld   l,a", 4),
    op(`ld   h,$${(table >> 8).toString(16)}`, 7),
    op("ld   c,(hl)", 7, { what: `quantised phase, $${unknown.toString(16)} = not in the table` }),
    op(`ld   hl,$${state.toString(16)}`, 10, { what: "-> KNOWN" }),
    op("ld   a,c", 4),
    op(`cp   ${unknown}`, 7, { what: "carry: this reading IS in the table" }),
    op("sbc  a,a", 4, { what: "$ff known / $00 unknown, branch-free" }),
    op("ld   e,a", 4),
    op("and  (hl)", 7, { what: "…and so was the last one: the difference is between two readings" }),
    op("ld   (hl),e", 7, { what: "KNOWN := this reading, for the next observation to gate on" }),
    op("ld   d,a", 4, { what: "d = the valid mask" }),
    op("inc  l", 4),
    op("ld   (hl),a", 7, { what: "VALID" }),
    op("inc  l", 4),
    op("ld   a,c", 4),
    op("sub  (hl)", 7, { what: "phase - expected" }),
    // …into 0..170, both outcomes 19 cycles
    op([`jr   c,dec_neg${tag}`, `jr   dec_p1${tag}`, `dec_neg${tag}:`, `add  a,${units}`, `dec_p1${tag}:`], 19,
      { what: `reduce into 0..${units - 1}` }),
    // …into -85..85, both outcomes 26 cycles
    op([`cp   ${half}`, `jr   nc,dec_big${tag}`, `jr   dec_p2${tag}`, `dec_big${tag}:`, `sub  ${units}`, `dec_p2${tag}:`], 26,
      { what: "signed displacement" }),
    op("and  d", 4, { what: "…zero unless two consecutive readings were known" }),
    op("inc  l", 4),
    op("ld   (hl),a", 7, { what: "DELTA" }),
    // the observation number, 16-bit and branch-free. `inc l` leaves carry
    // alone, which is what lets the high byte follow the low one directly.
    op("inc  l", 4),
    op("ld   a,(hl)", 7),
    op("add  a,1", 7),
    op("ld   (hl),a", 7),
    op("inc  l", 4),
    op("ld   a,(hl)", 7),
    op("adc  a,0", 7),
    op("ld   (hl),a", 7, { what: "COUNT" }),
    // the phase expected at the next read
    op("ld   a,c", 4),
    op(`add  a,${step}`, 7),
    op("ld   b,a", 4),
    op("sbc  a,a", 4),
    op(`and  ${256 % units}`, 7, { what: `carry folds back mod ${units}` }),
    op("add  a,b", 4),
    op([`cp   ${units}`, `jr   nc,dec_over${tag}`, `jr   dec_p3${tag}`, `dec_over${tag}:`, `sub  ${units}`, `dec_p3${tag}:`], 26),
    op("and  e", 4, { what: "an unknown reading leaves EXPECT at a defined 0" }),
    op(`ld   l,${lo(STATE.expect)}`, 7),
    op("ld   (hl),a", 7),
    op("exx", 4),
  ];
}


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
// Ways to break the RECORD without breaking the decode, so the check that the
// instrument makes on it can be shown to fail (R7 §20.2 B). A checker that has
// never rejected anything is a checker whose passing means nothing.
export const PUBLISH_FAULTS = {
  "drop-field": "the displacement is never published, so the record never completes",
  "double-field": "one field is published twice, so the record has one too many",
  "carry-publish": "the last field is published after the NEXT read, one observation late",
};

export function generateObserver(cfg, { reads = ["h"], store = false, at = 0, every = 1,
  decode = false, publish = false, publishFault = null } = {}) {
  if (!reads.every((r) => r in PORTS)) throw new Error(`reads must be from ${Object.keys(PORTS)}`);
  if (!Number.isInteger(every) || every < 1) throw new Error("every must be a positive group count");
  // Thinning only works if the generated loop actually covers `every` groups.
  // It does not on P1, whose loop IS one group, so `every: 2` there produced a
  // rom that still read every group while the budget was computed for half.
  const groups = cfg.cycleSlots / cfg.groupSlots;
  if (every > 1 && groups % every)
    throw new Error(`every=${every} does not divide this schedule's ${groups} groups`);
  if (!Number.isInteger(at) || at < 0 || at >= cfg.groupSlots) throw new Error("at must be a slot of the group");
  const store_at = cfg.ram.glob[0] + GLOB.observe;
  if (decode && reads.join() !== "h") throw new Error("the Z80 decoder reads H only");
  if (decode && cfg.voices) throw new Error("the decoder prototype is P1: the shadow set is the mixer's in P2");
  // A schedule that skips groups gives the decoder a different advance for the
  // observation after the gap, and it has one constant. R7 §20.2 A lets the
  // single-slot P1 build REFUSE that rather than carry an untested missing-
  // observation path: the contract arrives with the configuration that needs it.
  if (decode && every !== 1)
    throw new Error("the decoder has one advance per read: a thinned schedule needs the missed-observation contract first");
  if (publish && !decode) throw new Error("there is nothing to publish without the decoder");
  const map = decode ? decodeMap(cfg) : null;
  // WHERE THE RECORD IS PUBLISHED. Not in the slot that decoded it: five bytes
  // out through the bank window is 145 cycles, and the read slot is the fullest
  // one in the group. Each field goes to its OWN address in the window, so the
  // instrument sees which field arrived rather than counting writes and hoping
  // (R7 §20.2 B), and the record closes before the next read.
  //
  // Offsets 1..5, not 0..4: $FF0000 is the cooperative window's notification
  // and the analyzer reads pairs of them as a window's open and close.
  const spare = cfg.groupSlots - 1;
  const pubSlot = PUBLISH.map((_, k) => at + 1 + Math.floor((k * spare) / PUBLISH.length));
  if (publish && pubSlot.some((x) => x >= cfg.groupSlots))
    throw new Error("the publish does not fit after the read in this group");
  if (publishFault && !PUBLISH_FAULTS[publishFault])
    throw new Error(`unknown publish fault ${publishFault}`);
  if (publishFault && !publish) throw new Error("a publish fault needs a publishing build");
  // `carry-publish` moves the last field into the READ slot, where it lands
  // after the next observation's read rather than before it.
  if (publishFault === "carry-publish") pubSlot[PUBLISH.length - 1] = at;
  let observed = 0;
  const gen = generate(cfg, (i) => {
    const inGroup = i % cfg.groupSlots, observes = Math.floor(i / cfg.groupSlots) % every === 0;
    if (!observes) return [];
    const publishHere = !publish ? [] : PUBLISH.flatMap((f, k) => {
      if (pubSlot[k] !== inGroup) return [];
      if (publishFault === "drop-field" && f === "delta") return [];
      const one = [
        op(`ld   a,($${(map.state + STATE[f]).toString(16)})`, 13, { what: `publish: ${f}` }),
        op(`ld   ($${(0x8001 + k).toString(16)}),a`, 16, { what: `publish: ${f} through the bank window` }),
      ];
      return publishFault === "double-field" && f === "known" ? [...one, ...one] : one;
    });
    if (inGroup !== at) return publishHere;
    observed++;
    return [
      ...reads.map((r) => op(`ld   a,($${PORTS[r].toString(16)})`, VDP.readCycles,
        { clobbers: ["a"], what: `HV ${r.toUpperCase()} read` })),
      ...(store && !decode ? [op(`ld   ($${store_at.toString(16)}),a`, 13, { what: "keep the reading" })] : []),
      ...(decode ? decodeOps(quantStep(cfg, i), { ...map, tag: `_${i}` }) : []),
      ...publishHere,
    ];
  }, decode ? decodeInitOps(map) : null);
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
    const lines = [gen.text.trimEnd(), "",
      `        ds   $${map.table.toString(16)}-$, 0     ; the calibrated phase table`];
    const b = PHASE_TABLE.quantised.bytes;
    for (let i = 0; i < 256; i += 16) lines.push(`        db   ${b.slice(i, i + 16).join(",")}`);
    gen.text = lines.join("\n") + "\n";
  }
  const decodeCycles = decode
    ? decodeOps(0, map).reduce((t, o) => t + o.cycles, 0) : 0;
  return { ...gen,
    observer: { reads, store, at, every, decode, publish, observedSlots: observed,
      decodeCycles, decodeState: map?.state, decodeTable: map?.table,
      publishSlots: publish ? pubSlot : null, publishFault,
      publishCycles: publish ? PUBLISH.length * 29 : 0,
      readCycles: VDP.readCycles, workPerSlot: reads.length * VDP.readCycles + (store ? 13 : 0),
      worstSlotPct: gen.placement.worst.workPct,
      loopCycles, readOffsetCycles: at_cycles, spacingCycles,
      spacingMaster: spacingCycles.map((c) => c * cfg.machine.z80Div) } };
}
