// Generate the P1 output-only stream engine (docs/dac-engine-implementation.md
// §5/P1: "既知の波形をZ80 RAMから出すだけの構成で、約10 kHzのサイクル配置を成立
// させる。次にTimer-Bの観測を加え、CSMを併用する").
//
// It generates rather than hand-places, because a hand-placed pad is a constant
// somebody has to re-derive every time the work changes, and that is the
// failure §7 asks not to repeat. The schedule is arithmetic: slot length from
// the profile's Bresenham, work from the job list, pad from what is left.
//
// THE ONE STRUCTURAL DECISION WORTH READING. There is no interrupt. The Z80
// runs with interrupts disabled for the whole session and never takes a
// vblank. §3.1 allows this and asks for the time-sync mechanism to be named,
// so:
//
//   * The DAC's clock is the Z80's own instruction stream — a group of 5 slots
//     is 1,792 cycles EXACTLY at 9,987.6 Hz, so the average carries no drift
//     and no correction is needed for it to stay put.
//   * THERE IS NO PHASE REFERENCE, and the earlier claim that Timer B was one
//     is withdrawn (§3.2, R1). Reading the overflow flag answers "did ANY
//     overflow happen since the reset", so the reset -> read window has to be
//     shorter than one timer period to constrain anything; it never was, and
//     the flag reads 1 every time. The traffic stays available as a YM load
//     case and is off in the normal profile. The engine has no wall-clock
//     phase information at all — only the instrument does.
//   * The logical clock for commands is the OUTPUT SAMPLE INDEX (§3.2), which
//     P2 maintains at block boundaries. P1 has no commands, so it has no
//     counter — the harness counts $2A writes.
//
// Taking the vblank instead would cost ~90 cycles landing at an arbitrary
// point inside a 358-cycle slot: a quarter of the period, four times the §6.2
// tolerance. Reserving it in EVERY slot to make it safe is 25% of the budget
// for an event that happens once every 167 samples. The interrupt is what the
// old engine's structure was built around and it is what this one drops.
import { stampLine, GLOB, YM, PCM1, PCM1_SILENCE, PCM1_READY_MARK, pcm1Base, expanderSites,
  PCMN, PCMN_L } from "./config.mjs";
import { buildLut, buildClamp, CLAMP_SIZE, lutPages, pageIsALevel, SILENCE, buildRungs } from "./lut.mjs";
import { op, cost, laySlot, placementTable, padTo, fillBytes } from "./schedule.mjs";

const hex = (n) => `$${n.toString(16)}`;

/**
 * A minimal but real CH3 voice, so CSM has something to key. Operator offsets
 * for channel 3 on port 0 are +2.
 *
 * IT IS TEST SCAFFOLDING, NOT THE ENGINE. A shipped driver receives a patch as
 * commands; this exists so the CSM traffic in the schedule has a voice under it.
 * Either the Z80 loads it from a table at boot (`csm: true`) or the 68000 writes
 * it while it still holds the bus (`csmHost: true`) — and in the second form the
 * engine's code region does not pay for it at all.
 */
/** The CH3 frequency the per-slot CSM writes send, as the globals hold it. */
export const CSM_TEST_FREQ = { hi: 0x22, lo: 0x69 };

export const CSM_TEST_VOICE = [
  [0x32, 0x01], [0x36, 0x01], [0x3a, 0x02], [0x3e, 0x01],   // DT/MUL
  [0x42, 0x1b], [0x46, 0x28], [0x4a, 0x28], [0x4e, 0x00],   // TL
  [0x52, 0x1f], [0x56, 0x1f], [0x5a, 0x1f], [0x5e, 0x1f],   // KS/AR
  [0x62, 0x0a], [0x66, 0x0a], [0x6a, 0x0a], [0x6e, 0x0a],   // AM/D1R
  [0x72, 0x00], [0x76, 0x00], [0x7a, 0x00], [0x7e, 0x00],   // D2R
  [0x82, 0x1f], [0x86, 0x1f], [0x8a, 0x1f], [0x8e, 0x1f],   // D1L/RR
  [0xb2, 0x3a], [0xb6, 0xc0],                               // ALG/FB, pan
  [0xac, 0x22], [0xa8, 0x69], [0xad, 0x22], [0xa9, 0x69],   // CH3 op freqs
  [0xae, 0x22], [0xaa, 0x69], [0xa6, 0x22], [0xa2, 0x69],
];

// ── Op builders ────────────────────────────────────────────────────────────
// Costs are documented Z80 T-states. `writes` is what the analyzer checks
// against the chip's settling table — the engine polls nothing.
const YM_ADDR = "YM_ADDR0";
const YM_DATA = "YM_DATA0";

const ymWrite = (reg, val, what) => {
  // A value read from RAM is `ld a,(nn)` at 13, not `ld a,n` at 7. Costing it
  // as the immediate put six cycles a write into every CSM slot and the clock
  // came out 0.67% slow — small enough to look like noise and large enough to
  // fail §6.2 outright, which is the argument for costing from the encoding
  // rather than from the shape of the source line.
  const mem = typeof val === "string" && val.startsWith("(");
  return [
    op(`ld a,${hex(reg)}`, 7, { clobbers: ["a"] }),
    op(`ld (${YM_ADDR}),a`, 13, { writes: [{ port: 0, kind: "addr", reg }] }),
    op(typeof val === "string" ? `ld a,${val}` : `ld a,${hex(val)}`, mem ? 13 : 7, { clobbers: ["a"] }),
    op(`ld (${YM_DATA}),a`, 13, { writes: [{ port: 0, kind: "data", reg }], what }),
  ];
};

// Every YM address write destroys the DAC's latch, so the slot that made one
// puts it back before it ends. This is the one irreducible cost of sharing the
// address port, and it is charged to the slot that caused it (§3.5).
const relatchDac = () => [
  op(`ld a,${hex(YM.R_DAC)}`, 7, { clobbers: ["a"] }),
  op(`ld (${YM_ADDR}),a`, 13, { writes: [{ port: 0, kind: "addr", reg: YM.R_DAC }], what: "$2A re-latch" }),
];

// Read the status byte. The engine does nothing with it — the point is that
// the read is IN the schedule, costed, and that the harness can see when it
// happened relative to Timer B's real overflow.
const readStatus = () => [
  op(`ld a,(${YM_ADDR})`, 13, { clobbers: ["a"], reads: true, what: "status read" }),
  op("ld (G_STATUS),a", 13, { what: "status stash" }),
];

// ── The jobs a slot can carry ──────────────────────────────────────────────
// Reserved time, EXECUTED. §10.3 step 2 (R1) asks for the complete 2ch
// engine's placement, with nothing left at zero because it is not written yet.
// A table of intentions cannot fail; this runs the cycles, so the schedule has
// to survive them and the timing gate measures it doing so. The instructions
// are the pad solver's own — they do nothing, which is the point: what is
// being tested is the BUDGET, not a guess at the code.
const reserveOps = (cycles, why, fill) => {
  if (!cycles) return [];
  // Tagged, so the byte ledger can tell PROVISIONAL padding — which the real
  // feature will replace — from the pad, which it will not (R8 §23.3).
  const ops = padTo(cycles, fill).map((o) => ({ ...o, reserved: true }));
  ops[0] = { ...ops[0], what: `RESERVED ${cycles} — ${why}` };
  return ops;
};

// What a slot is allowed to destroy. The default is the pad solver's own, and
// it uses `ld b,k`/`djnz` — four bytes for any length — which is why the whole
// schedule fits in the code region. A slot that has to carry a value in BC
// from one piece of the distributed phase decode to the next cannot use it: it
// gets `["a"]` and pays in bytes (R8 §23.3). Threaded per slot rather than set
// globally because the live ranges are what decides it, and the byte cost is
// the thing being measured.
export const DEAD_DEFAULT = ["a", "b", "bc"];

function slotWork(cfg, slotIndex, fill = { dead: DEAD_DEFAULT }, commandPlan = null,
  ymPlan = null, xpPlan = null) {
  const work = [];
  const g = slotIndex % cfg.groupSlots;
  // Which sample of a BUILT block this slot builds. The edge belongs to the
  // built stream, not to the slot index, so it moves with the lead.
  const b = (slotIndex + cfg.lead) % cfg.blockSamples;
  // Timer B: observed, and its flag reset, on a fixed cadence. There is no
  // branch on the result — a conditional would make the slot's length depend
  // on the chip, which is exactly the coupling §3.2 says not to build.
  //
  // IT IS A LOAD CASE, NOT A CLOCK. §3.2 (R1) withdraws the phase-reference
  // reading of it: the flag answers "any overflow since the reset", the
  // reset -> read window is longer than the timer period at every cadence
  // tried, and so the answer is 1 every time. What the traffic still tests is
  // real: a status READ and a $27 write inside the schedule, with the $2A
  // re-latch behind them. Off unless a case asks for it.
  if (cfg.observeTimerB && !cfg.voices && g === 0) {
    work.push(...readStatus());
    work.push(...ymWrite(YM.R_TIMER_CTL, "R27_RESET", "timer flag reset"));
  }
  if (cfg.observeTimerB && cfg.voices) {
    if (b === 4) work.push(...ymWrite(YM.R_TIMER_CTL, "R27_RESET", "timer flag reset"));
    if (b === 12) work.push(...readStatus());
  }
  // CSM: CH3 keys itself off Timer A; what a driver actually spends cycles on
  // is the register traffic around it, so that is what is placed here.
  //
  // ONE WRITE PER SLOT once there is a mixer, on two separate slots. Two writes in one slot is 112 cycles on top of a 207-cycle mix and
  // the slot overruns — which the generator refuses to emit rather than
  // quietly deliver late. §3.5 asks for exactly this: an FM transaction split
  // across intervals, each piece re-latching `$2A` behind it. The chip sees
  // the pair 358 cycles apart, and since the frequency latches on the LSB
  // write ($A8, second), that is a coherent write either way.
  if (cfg.csm && !cfg.voices && g === 2) {
    work.push(...ymWrite(0xac, "(G_CSMHI)", "CSM ch3 op frequency hi"));
    work.push(...ymWrite(0xa8, "(G_CSMLO)", "CSM ch3 op frequency lo"));
  }
  if (cfg.csm && cfg.voices) {
    if (b === 6) work.push(...ymWrite(0xac, "(G_CSMHI)", "CSM ch3 op frequency hi"));
    if (b === 8) work.push(...ymWrite(0xa8, "(G_CSMLO)", "CSM ch3 op frequency lo"));
  }
  // A burst of FM register writes in ONE slot — §6.3's "FM音色変更が集中する
  // 時刻". This is the case that decides whether a voice change has to be
  // split across slots or can ride one.
  if (cfg.fmBurst && g === 4) {
    for (let i = 0; i < cfg.fmBurst; i++)
      work.push(...ymWrite(0x30 + i, `${hex(0x71 + i)}`, `FM burst ${i}`));
  }
  if (work.some((o) => o.writes?.some((w) => w.kind === "addr"))) work.push(...relatchDac());
  // Whatever chip traffic this slot already carries DRAWS ON its reservation
  // rather than adding to it — a CSM write is one of the four YM writes a
  // block is budgeted for, not a fifth one for free.
  const chargeable = cost(work);
  if (cfg.multi) {
    // THE N-VOICE PROFILE: each voice's four edge pieces at ITS block phase
    // (cfg.voiceOffsets), START before the mix and the other three after it,
    // exactly as the one-voice edge — so no two voices share an edge slot.
    const B = cfg.blockSamples;
    const at = cfg.voiceOffsets.map((o) => (b - o + B) % B);
    if (cfg.loops) {
      // THE LOOP-CAPABLE EDGE (D10): six pieces a voice a block, each constant
      // time and none heavier than the expander's A piece.
      // The three light pieces sit where the voices' edges collide least
      // (LP_LIGHT_AT, searched over the piece costs); COMPARE, WRAP and START
      // are fixed at b14, b15 and b0 by the END contract.
      const [pSG, pEG, pAP] = LP_LIGHT_AT[cfg.voices];
      at.forEach((bv, v) => { if (bv === 0) work.push(...lpEdgeStart(cfg, v)); });
      work.push(...callMix(cfg));
      at.forEach((bv, v) => {
        if (bv === pSG) work.push(...lpEdgeStartGen(cfg, v));
        if (bv === pEG) work.push(...lpEdgeEndGen(cfg, v));
        if (bv === pAP) work.push(...lpEdgeApply(cfg, v));
        if (bv === B - 2) work.push(...lpEdgeCompare(cfg, v));
        if (bv === B - 1) work.push(...lpEdgeWrap(cfg, v));
      });
      if (xpPlan) work.push(...(xpPlan.get(slotIndex) ?? []));
      return work;
    }
    at.forEach((bv, v) => { if (bv === 0) work.push(...nvEdgeStart(cfg, v)); });
    work.push(...callMix(cfg));
    at.forEach((bv, v) => {
      if (bv === B - 3) work.push(...nvEdgeStop(cfg, v));
      if (bv === B - 2) work.push(...nvEdgeCompare(cfg, v));
      if (bv === B - 1) work.push(...nvEdgePark(cfg, v));
    });
    if (xpPlan) work.push(...(xpPlan.get(slotIndex) ?? []));
    return work;
  }
  if (cfg.voices) {
    // THE START IS APPLIED BEFORE THE FIRST MIX OF A BLOCK (R28 §63.3 D2, §4:
    // "前区間最後のミックスの後と、次区間最初のミックスの前の2スロットへ分ける").
    // The source pointer and the step have to be in place before sample 0 of
    // the new block is read, and the park of the previous edge has to have
    // finished before that — so this is the one piece of work that goes in
    // front of the mix.
    if (cfg.oneVoice && b === 0) work.push(...pcmEdgeStart(cfg));
    // The mix runs in EVERY slot — one sample built for every sample played.
    work.push(...callMix(cfg));
    // The block edge rides the LAST slot of a block, so what it writes takes
    // effect on the next one and no block is ever built at two volumes.
    if (b === cfg.blockSamples - 1) work.push(...blockEdge(cfg));
    if (cfg.oneVoice && b === cfg.blockSamples - 3) work.push(...pcmEdgeStop(cfg));
    if (cfg.oneVoice && b === cfg.blockSamples - 2) work.push(...pcmEdgeCompare(cfg));
    // THE COMMAND CONSUMER, at the block positions it was packed into (R15
    // §39.4). It goes in BEFORE the reservation, because it is what replaced
    // part of that reservation and the rest of the block's budget still has to
    // fit around it — exactly as a CSM write draws on the block's YM budget.
    if (cfg.command && commandPlan) work.push(...(commandPlan.get(slotIndex) ?? []));
    // THE Z80 YM WRITER, at the b11..b14 positions its reservation owns (R26
    // §59.3) — after the mix, which is where the reserved pad it replaces was.
    // That placement is not cosmetic: the slot's own DAC write raises the
    // chip's BUSY for 1,386 master, and the writer's data write has to fall
    // after that and far enough before the next slot's DAC write for its own
    // BUSY to have cleared (§59.4).
    if (cfg.ymWriter && ymPlan) work.push(...(ymPlan.get(slotIndex) ?? []));
    // THE EXPANDER'S SITES (R28 §63.3 D4): a `call` into piece A or piece B,
    // costed with the routine inside it, at the slots the site plan fixes.
    if (cfg.oneVoice && xpPlan) work.push(...(xpPlan.get(slotIndex) ?? []));
    if (cfg.reserve) {
      const [, cycles, why] = cfg.reserve[b];
      // The RESERVED padding is padding too, and it sits between one piece of a
      // distributed computation and the next just as the slot's own pad does.
      work.push(...reserveOps(Math.max(0, cycles - chargeable), why, fill));
    }
  }
  return work;
}

// ── P2: the block mixer ────────────────────────────────────────────────────
//
// EVERY SLOT'S WORK IS CONSTANT TIME, and that is a hard constraint, not a
// style. A cycle-placed schedule has no clock to wait on: if a slot's work can
// finish early it finishes early, and the next DAC write moves. So the mixer
// carries no data-dependent branch — the volume is a table lookup, not a loop;
// the ring's cursors are `inc c`/`inc l` inside one page, so no wrap is ever
// tested; and where a branch becomes unavoidable (the saturating add of a
// second voice) both arms have to be padded to the same length before it can
// go in. That is the price of the structure and it is worth stating up front.
//
// PRODUCTION IS LOCKED TO CONSUMPTION. Slot i plays sample i and builds sample
// i+16, one of each, for ever. So the ring cannot drain and cannot overrun,
// there is no fill counter, no low-water mark and no regulator — the property
// the shipped engine spent four rounds trying to obtain by measurement is here
// a consequence of the schedule. What the 16-sample lead buys is the block:
// a volume change lands on a block boundary and is whole (§3.4), and a note
// onset can be quantised to one (§3.7).
// ── THE ONE-VOICE MIX (R28 §63.3 D1) ──────────────────────────────────────
//
// One source, a 16-bit pointer in the 68k window, advanced by a 2^k STEP held
// in a self-modified operand: the sample bank bakes one blob per note and
// reaches the octaves above it by stepping 2, 4 or 8 bytes a sample (mmb.md
// §10.1). Voice level then master, in that order — the same two lookups and the
// same rounding as the two-voice mix, minus the clamp, because a single
// voice's "sum" is itself and cannot leave the range.
const mixRoutine1v = (cfg) => [
  op("        exx", 4, { what: "to the mixer's register set" }),
  op("        ld   a,(de)", 7 + cfg.windowWait, { what: `the source byte through the 68k window (7 + ${cfg.windowWait} measured wait)` }),
  op("        ld   l,a", 4),
  op("mix_v0: ld   h,0", 7, { what: "the voice's level page — SELF-MODIFIED at the block edge" }),
  op("        ld   a,(hl)", 7, { what: "x vel" }),
  op("        ld   l,a", 4),
  op("mix_mp: ld   h,0", 7, { what: "the master's page — likewise" }),
  op("        ld   a,(hl)", 7, { what: "x master, in that order, so the rounding is the reference's" }),
  // A signed family gives a signed byte: biased once here, for the ring and
  // the DAC (lut.mjs). The test images' biased family needs nothing.
  ...(cfg.signedSource ? [op("        xor  $80", 7, { what: "signed -> biased, once" })] : []),
  op("        ld   (bc),a", 7, { what: "into the ring, LEAD samples ahead of the play cursor" }),
  op("        inc  c", 4),
  op("        ld   a,e", 4),
  op("mix_st: add  a,1", 7, { what: "the 2^k step — SELF-MODIFIED at the block edge" }),
  op("        ld   e,a", 4),
  op("        ld   a,d", 4),
  op("        adc  a,0", 7, { what: "…and its carry into the high byte" }),
  op("        ld   d,a", 4),
  op("        exx", 4),
  op("        ret", 10),
];

// ── THE N-VOICE MIX (plan-pcm-spec.md D1/D4) ──────────────────────────────
//
// One table read a voice: the rung page already carries the master (the 68000
// folds it in), so there is no master stage. Voice 0 reads through DE' as in
// the one-voice mix. Voices 1 and 2 keep their pointer in the operand of a
// self-modified `ld hl,nn` — ADVANCED FIRST, so HL still holds the old pointer
// for the fetch, and no register the expander (IX, IYH) or the decode (main BC)
// owns is taken. Each extra voice is summed through the 512 B clamp: two biased
// terms make a 9-bit sum whose carry picks the page, so the add saturates in
// constant time, and a third voice cascades through the same table.
const nvS = (cfg, key, v) => {
  const off = typeof PCMN[key] === "function" ? PCMN[key](v) : PCMN[key];
  return `$${(pcm1Base(cfg) + off).toString(16)}`;
};
const mixRoutineN = (cfg) => {
  const N = cfg.voices, ww = cfg.windowWait;
  // flatLevel: the STUDY's "what does a level cost" variant — no per-voice rung
  // page and no master, so the source byte IS the term (the bank would hold it
  // biased, which costs nothing at run time). Never a shipping shape on its own.
  const flat = !!cfg.flatLevel;
  const ops = [
    op("        exx", 4, { what: "to the mixer's register set" }),
    op("        ld   a,(de)", 7 + ww, { what: `voice 0's byte through the 68k window (7 + ${ww})` }),
    ...(flat ? [] : [
      op("        ld   l,a", 4),
      op("mix_v0: ld   h,0", 7, { what: "voice 0's rung page (master folded in) — SELF-MODIFIED at its edge" }),
      op("        ld   a,(hl)", 7, { what: "signed in, biased out" }),
    ]),
  ];
  const advance0 = [
    op("        ld   a,e", 4),
    op("mix_st0: add  a,1", 7, { what: "voice 0's 2^k step — SELF-MODIFIED at its edge" }),
    op("        ld   e,a", 4),
    op("        ld   a,d", 4),
    op("        adc  a,0", 7),
    op("        ld   d,a", 4),
  ];
  // Without a step voice 0 walks whole addresses, as the stepping form does:
  // `inc e` alone would wrap the source at a page and the gate catches it.
  const adv0 = cfg.stepVoices > 0 ? advance0
    : [op("        inc  de", 6, { what: "step 1: the source pointer moves on by one" })];
  if (N === 1) {
    ops.push(op("        ld   (bc),a", 7, { what: "into the ring, LEAD ahead of the play cursor" }),
      op("        inc  c", 4), ...adv0);
  } else {
    ops.push(op("        ld   iyl,a", 8, { what: "voice 0's term, parked in IYL" }), ...adv0);
    for (let v = 1; v < N; v++) {
      ops.push(
        op(`mv${v}:    ld   hl,${hexW(0xff00)}`, 10, { what: `voice ${v}'s pointer — the operand IS the pointer` }),
        ...(cfg.stepVoices > v ? [
          op("        ld   a,l", 4),
          op(`mix_st${v}: add  a,1`, 7, { what: `voice ${v}'s step — SELF-MODIFIED at its edge` }),
          op(`        ld   (mv${v}+1),a`, 13),
          op("        ld   a,h", 4),
          op("        adc  a,0", 7),
          op(`        ld   (mv${v}+2),a`, 13, { what: "advanced first: HL still holds the old pointer" }),
          op("        ld   a,(hl)", 7 + ww, { what: `voice ${v}'s byte (7 + ${ww})` }),
        ] : [
          // No octave step on this voice: one byte a sample, so the pointer is
          // fetched through, incremented and put back whole.
          op("        ld   a,(hl)", 7 + ww, { what: `voice ${v}'s byte (7 + ${ww})` }),
          op("        inc  hl", 6),
          op(`        ld   (mv${v}+1),hl`, 16, { what: "step 1: the pointer moves on by one" }),
        ]),
        ...(flat ? [] : [
          op("        ld   l,a", 4),
          op(`mix_v${v}: ld   h,0`, 7, { what: `voice ${v}'s rung page` }),
          op("        ld   a,(hl)", 7),
        ]),
        op("        add  a,iyl", 8, { what: "9-bit sum of two biased terms in (carry, A)" }),
        op("        ld   l,a", 4),
        op("        ld   a,0", 7, { what: "`ld` keeps the carry" }),
        op("        adc  a,CLAMP>>8", 7, { what: "the carry picks the clamp page" }),
        op("        ld   h,a", 4),
        op("        ld   a,(hl)", 7, { what: "saturated, biased" }),
        ...(v < N - 1 ? [op("        ld   iyl,a", 8, { what: "…and parked for the next voice" })] : []),
      );
    }
    ops.push(op("        ld   (bc),a", 7, { what: "the finished sample" }), op("        inc  c", 4));
  }
  ops.push(op("        exx", 4), op("        ret", 10));
  return ops;
};
const hexW = (n) => `$${n.toString(16).padStart(4, "0")}`;

/** STOP for voice v: `END_v := 0` when its stop generation moved. */
const nvEdgeStop = (cfg, v) => [
  op("exx", 4, { what: `voice ${v} edge: stop` }),
  op(`ld   a,(${nvS(cfg, "stopGen", v)})`, 13),
  op("ld   l,a", 4),
  op(`ld   a,(${nvS(cfg, "lastStop", v)})`, 13),
  op("cp   l", 4),
  ...balanced("z", [
    op("ld   a,l", 4),
    op(`ld   (${nvS(cfg, "lastStop", v)}),a`, 13),
    op("ld   hl,0", 10),
    op(`ld   (${nvS(cfg, "liveEnd", v)}),hl`, 16),
  ], `voice ${v}: no stop pending`),
  op("exx", 4),
];

/** COMPARE for voice v: `park_v := pointer >= END_v`. */
const nvEdgeCompare = (cfg, v) => (v === 0 ? [
  op("exx", 4, { what: "voice 0 edge: compare" }),
  op(`ld   hl,${nvS(cfg, "liveEnd", 0)}`, 10),
  op("ld   a,e", 4),
  op("sub  (hl)", 7),
  op("inc  l", 4),
  op("ld   a,d", 4),
  op("sbc  a,(hl)", 7),
  op("sbc  a,a", 4),
  op("cpl", 4),
  op(`ld   (${nvS(cfg, "parkMask", 0)}),a`, 13),
  op("exx", 4),
] : [
  op("exx", 4, { what: `voice ${v} edge: compare` }),
  op(`ld   hl,(${nvS(cfg, "liveEnd", v)})`, 16),
  op(`ld   a,(mv${v}+1)`, 13),
  op("sub  l", 4),
  op(`ld   a,(mv${v}+2)`, 13),
  op("sbc  a,h", 4),
  op("sbc  a,a", 4),
  op("cpl", 4),
  op(`ld   (${nvS(cfg, "parkMask", v)}),a`, 13),
  op("exx", 4),
]);

/** PARK for voice v: its rung page for the next block, then the park. */
const nvEdgePark = (cfg, v) => [
  ...(cfg.flatLevel ? [] : [
    op(`ld   a,(${nvS(cfg, "level", v)})`, 13, { what: `voice ${v} edge: the rung its next block runs at` }),
    op(`ld   (mix_v${v}+1),a`, 13),
  ]),
  op("exx", 4),
  op(`ld   a,(${nvS(cfg, "parkMask", v)})`, 13),
  op("or   a", 4),
  ...balanced("z", v === 0
    ? [op("ld   de,PCM_SILENCE", 10)]
    : [op("ld   hl,PCM_SILENCE", 10), op(`ld   (mv${v}+1),hl`, 16)], `voice ${v}: not parking`),
  op("exx", 4),
];

/** START for voice v, before the mix: the staged pointer, end and step. */
const nvEdgeStart = (cfg, v) => [
  op("exx", 4, { what: `voice ${v} edge: start` }),
  op(`ld   a,(${nvS(cfg, "startGen", v)})`, 13),
  op("ld   l,a", 4),
  op(`ld   a,(${nvS(cfg, "lastStart", v)})`, 13),
  op("cp   l", 4),
  ...balanced("z", [
    op("ld   a,l", 4),
    op(`ld   (${nvS(cfg, "lastStart", v)}),a`, 13, { what: "latched before HL is reused" }),
    ...(v === 0
      ? [op(`ld   de,(${nvS(cfg, "stSrc", 0)})`, 20)]
      : [op(`ld   hl,(${nvS(cfg, "stSrc", v)})`, 16), op(`ld   (mv${v}+1),hl`, 16)]),
    ...(cfg.stepVoices > v ? [
      op(`ld   a,(${nvS(cfg, "stStep", v)})`, 13),
      op(`ld   (mix_st${v}+1),a`, 13),
    ] : []),
    op(`ld   hl,(${nvS(cfg, "stEnd", v)})`, 16),
    op(`ld   (${nvS(cfg, "liveEnd", v)}),hl`, 16),
  ], `voice ${v}: no start pending`),
  op("exx", 4),
];

/** The N-voice pieces' costs, for the study's report. */
export const nvEdgeCost = (cfg) => Array.from({ length: cfg.voices }, (_, v) => (cfg.loops ? {
  startGen: cost(lpEdgeStartGen(cfg, v)), endGen: cost(lpEdgeEndGen(cfg, v)),
  apply: cost(lpEdgeApply(cfg, v)), compare: cost(lpEdgeCompare(cfg, v)),
  wrap: cost(lpEdgeWrap(cfg, v)), start: cost(lpEdgeStart(cfg, v)),
} : {
  stop: cost(nvEdgeStop(cfg, v)), compare: cost(nvEdgeCompare(cfg, v)),
  park: cost(nvEdgePark(cfg, v)), start: cost(nvEdgeStart(cfg, v)),
}));

// ── THE LOOP-CAPABLE EDGE (plan-pcm-spec.md D10) ──────────────────────────
//
// A voice is a pointer, an END and a WRAP. At every block edge: if the
// pointer has reached END it is sent to WRAP. A shot's WRAP is the silence
// page (it parks and re-parks for ever, as today); a loop's WRAP is its loop
// start and its END the loop end; a note-off RETARGETS END to the sample's
// end and WRAP to silence, so the release tail plays out and parks. A loop
// point moved by a curve is the same RETARGET. Six pieces a voice a block,
// at the voice's own phase:
//
//   b11 START-GEN  startGen moved: latch it, startMask and applyMask := $ff
//   b12 END-GEN    endGen moved:   latch it, applyMask := $ff
//   b13 APPLY      applyMask:      live END, WRAP := the staged ones; clear
//   b14 COMPARE    parkMask := pointer >= live END
//   b15 WRAP       the rung page; parkMask: pointer := live WRAP
//   b0  START      startMask:      pointer := staged source; clear (before the mix)
//
// Why END/WRAP may be applied before the pointer: COMPARE then judges the OLD
// pointer against the NEW END, and a spurious park sends it to the new WRAP —
// which b0 overwrites with the staged source before the first mix of the
// block. Nothing is read that the host might still be writing: the staged
// bytes are read at b13 and b0, and the host's three-IDLE rule after a
// generation bump keeps the next staged store behind the edge.
export const LP_LIGHT_AT = { 1: [11, 12, 13], 2: [11, 12, 13], 3: [1, 12, 13] };
const lpS = (cfg, key, v) => `$${(pcm1Base(cfg) + PCMN_L[key](v)).toString(16)}`;

// THE TWO GENERATION PIECES ARE BRANCH-FREE, AND READ THE GENERATION ONCE.
// Latching is correct whether or not it moved (an unchanged value latched
// again is the same value), so the piece needs no arm: the difference becomes
// a mask by `add a,$ff / sbc a,a`, and the value latched is the one compared
// — main B carries it, which is dead at every piece boundary of this profile
// (the pad's `ld b,k / djnz` owns it otherwise). No `exx`: nothing here touches
// the mixer's register set.
const lpGenPiece = (cfg, v, gen, last, mask, what) => [
  op(`ld   a,(${lpS(cfg, gen, v)})`, 13, { what }),
  op("ld   b,a", 4, { clobbers: ["b"] }),
  op(`ld   a,(${lpS(cfg, last, v)})`, 13),
  op("sub  b", 4, { what: "zero exactly when the generation did not move" }),
  op("add  a,$ff", 7, { what: "carry = moved" }),
  op("sbc  a,a", 4, { what: "$ff = moved, $00 = not" }),
  op(`ld   (${lpS(cfg, mask, v)}),a`, 13),
  op("ld   a,b", 4),
  op(`ld   (${lpS(cfg, last, v)}),a`, 13, { what: "latched: the value just compared" }),
];
const lpEdgeStartGen = (cfg, v) => lpGenPiece(cfg, v, "startGen", "lastStart", "startMask",
  `voice ${v} edge: start generation`);
const lpEdgeEndGen = (cfg, v) => lpGenPiece(cfg, v, "endGen", "lastEnd", "applyMask",
  `voice ${v} edge: end generation (retarget)`);

const lpEdgeApply = (cfg, v) => [
  op("exx", 4, { what: `voice ${v} edge: apply END and WRAP` }),
  op(`ld   a,(${lpS(cfg, "applyMask", v)})`, 13),
  op(`ld   hl,${lpS(cfg, "startMask", v)}`, 10),
  op("or   (hl)", 7, { what: "a start applies END and WRAP too" }),
  ...balanced("z", [
    op(`ld   hl,(${lpS(cfg, "stEnd", v)})`, 16),
    op(`ld   (${lpS(cfg, "liveEnd", v)}),hl`, 16, { what: "END := the staged end" }),
    op(`ld   hl,(${lpS(cfg, "stWrap", v)})`, 16),
    op(`ld   (${lpS(cfg, "liveWrap", v)}),hl`, 16, { what: "WRAP := the staged wrap" }),
    op("xor  a", 4),
    op(`ld   (${lpS(cfg, "applyMask", v)}),a`, 13, { what: "consumed" }),
  ], `voice ${v}: nothing to apply`),
  op("exx", 4),
];

const lpEdgeCompare = (cfg, v) => (v === 0 ? [
  op("exx", 4, { what: "voice 0 edge: compare" }),
  op(`ld   hl,${lpS(cfg, "liveEnd", 0)}`, 10),
  op("ld   a,e", 4),
  op("sub  (hl)", 7),
  op("inc  l", 4),
  op("ld   a,d", 4),
  op("sbc  a,(hl)", 7),
  op("sbc  a,a", 4),
  op("cpl", 4),
  op(`ld   (${lpS(cfg, "parkMask", 0)}),a`, 13),
  op("exx", 4),
] : [
  op("exx", 4, { what: `voice ${v} edge: compare` }),
  op(`ld   hl,(${lpS(cfg, "liveEnd", v)})`, 16),
  op(`ld   a,(mv${v}+1)`, 13),
  op("sub  l", 4),
  op(`ld   a,(mv${v}+2)`, 13),
  op("sbc  a,h", 4),
  op("sbc  a,a", 4),
  op("cpl", 4),
  op(`ld   (${lpS(cfg, "parkMask", v)}),a`, 13),
  op("exx", 4),
]);

const lpEdgeWrap = (cfg, v) => [
  op(`ld   a,(${lpS(cfg, "level", v)})`, 13, { what: `voice ${v} edge: the rung its next block runs at` }),
  op(`ld   (mix_v${v}+1),a`, 13),
  op("exx", 4),
  op(`ld   a,(${lpS(cfg, "parkMask", v)})`, 13),
  op("or   a", 4),
  ...balanced("z", v === 0
    ? [op(`ld   de,(${lpS(cfg, "liveWrap", 0)})`, 20, { what: "the pointer goes to WRAP" })]
    : [op(`ld   hl,(${lpS(cfg, "liveWrap", v)})`, 16), op(`ld   (mv${v}+1),hl`, 16)],
  `voice ${v}: not wrapping`),
  op("exx", 4),
];

const lpEdgeStart = (cfg, v) => [
  op("exx", 4, { what: `voice ${v} edge: start (the pointer)` }),
  op(`ld   a,(${lpS(cfg, "startMask", v)})`, 13),
  op("or   a", 4),
  ...balanced("z", [
    ...(v === 0
      ? [op(`ld   de,(${lpS(cfg, "stSrc", 0)})`, 20, { what: "DE' := the staged source" })]
      : [op(`ld   hl,(${lpS(cfg, "stSrc", v)})`, 16), op(`ld   (mv${v}+1),hl`, 16)]),
    op("xor  a", 4),
    op(`ld   (${lpS(cfg, "startMask", v)}),a`, 13, { what: "consumed" }),
  ], `voice ${v}: no start pending`),
  op("exx", 4),
];

const mixRoutine = (cfg) => (cfg.multi ? mixRoutineN(cfg) : cfg.oneVoice ? mixRoutine1v(cfg) : cfg.voices >= 2 ? [
  // Two voices. Voice 0's contribution is parked in the ring slot the sample
  // is being built in — the play cursor is LEAD samples behind, so nothing can
  // ever read it half-built, which is §3.3's ownership rule made structural
  // rather than counted.
  op("        exx", 4, { what: "to the mixer's register set" }),
  op("        ld   a,(de)", 7 + cfg.windowWait, { what: `voice 0's byte through the 68k window (7 + ${cfg.windowWait} measured wait)` }),
  op("        inc  e", 4, { what: "…E alone: the source page wraps free" }),
  op("        ld   l,a", 4),
  op("mix_v0: ld   h,0", 7, { what: "voice 0's level page — SELF-MODIFIED at the block edge" }),
  op("        ld   a,(hl)", 7, { what: "x vel0" }),
  // Voice 0's contribution waits in IY, not in the ring slot. Parking it in
  // memory cost `ld h,b`/`ld l,c` to point HL back at it before the add — 15
  // cycles against `add a,iyl`'s 8 — and it is what the measured window wait
  // was found by needing to pay for. It also makes the ownership argument
  // trivial: a partial sum is never in the ring at all, so nothing can read
  // one. IY survives `exx`, and nothing else in the engine uses it.
  op("        ld   iyl,a", 8, { what: "voice 0's contribution parked in a register" }),
  op("        ld   a,(ix+0)", 19 + cfg.windowWait, { what: `voice 1's byte — IX is the price of a second pointer (19 + ${cfg.windowWait})` }),
  op("        inc  ixl", 8),
  op("        ld   l,a", 4),
  op("mix_v1: ld   h,0", 7, { what: "voice 1's level page — likewise" }),
  op("        ld   a,(hl)", 7, { what: "x vel1" }),
  op("        add  a,iyl", 8, { what: "9-bit sum in (carry, A) — both operands biased" }),
  op("        ld   l,a", 4),
  op("        ld   a,0", 7, { what: "…`ld` leaves the carry alone, which is the whole trick" }),
  op("        adc  a,CLAMP>>8", 7, { what: "the carry picks the table's second page" }),
  op("        ld   h,a", 4),
  op("        ld   a,(hl)", 7, { what: "saturated, branch-free, constant time" }),
  op("        ld   l,a", 4),
  op("mix_mp: ld   h,0", 7, { what: "the master's page" }),
  op("        ld   a,(hl)", 7, { what: "x master, in that order, so the rounding is the reference's" }),
  op("        ld   (bc),a", 7, { what: "the finished sample" }),
  op("        inc  c", 4),
  op("        exx", 4),
  op("        ret", 10),
] : [
  op("        exx", 4, { what: "to the mixer's register set" }),
  op("        ld   a,(de)", 7 + cfg.windowWait, { what: `source byte through the 68k window (7 + ${cfg.windowWait} measured wait)` }),
  op("        inc  e", 4, { what: "…one byte a sample; E alone, so the page wraps free" }),
  op("        ld   l,a", 4),
  op("mix_v0: ld   h,0", 7, { what: "the voice's level page — SELF-MODIFIED at the block edge" }),
  op("        ld   a,(hl)", 7, { what: "x vel" }),
  op("        ld   l,a", 4),
  op("mix_mp: ld   h,0", 7, { what: "the master's page — likewise" }),
  op("        ld   a,(hl)", 7, { what: "x master, in that order, so the rounding is the reference's" }),
  op("        ld   (bc),a", 7, { what: "into the ring, LEAD samples ahead of the play cursor" }),
  op("        inc  c", 4),
  op("        exx", 4),
  op("        ret", 10),
]);

// THE CALL IS COSTED WITH THE ROUTINE INSIDE IT. A slot's pad is what the slot
// has left, and what it has left includes everything the call runs — 17 for the
// call plus the routine's own cycles, `ret` included. Costing the three bytes
// and not the body is how a schedule ends up ~180 cycles a sample optimistic
// and still looks like arithmetic.
const callMix = (cfg) => [
  op("call mix_one", 17 + cost(mixRoutine(cfg)), { what: "the mix, one sample (call + routine)" }),
];

const blockEdge = (cfg) => [
  op(cfg.oneVoice ? `ld a,(${st(cfg, "level")})` : "ld a,(G_V0PAGE)", 13, { what: "the levels the next block runs at" }),
  op("ld (mix_v0+1),a", 13),
  ...(cfg.voices >= 2 ? [
    op("ld a,(G_V1PAGE)", 13),
    op("ld (mix_v1+1),a", 13),
  ] : []),
  op(cfg.oneVoice ? `ld a,(${st(cfg, "master")})` : "ld a,(G_MPAGE)", 13),
  op("ld (mix_mp+1),a", 13, { what: "…so a change is whole-block, never half of one" }),
  ...(cfg.oneVoice ? pcmEdgePark(cfg) : []),
];

// ── THE ONE-VOICE PCM EDGE (R28 §63.3 D2) ─────────────────────────────────
//
// Four constant-time pieces around one block boundary, in this order:
//
//   b13 after the mix   STOP     END := 0 where a stop is pending
//   b14 after the mix   COMPARE  park := (DE' >= END), kept for the next slot
//   b15 after the mix   PARK     the level pages, then DE' := SILENCE if park
//   b0  before the mix  START    DE', END and the step := the staged ones,
//                                where a start is pending
//
// BRANCHES WITH ARMS OF ONE LENGTH, not byte masks. §3.1 forbids a slot whose
// length depends on the data, not a branch: `jr` is 12 taken and 7 not, so the
// arm that does the work is followed by a `jr` over a pad that costs exactly
// (arm + 7), and both paths leave the piece at the same cycle. The masked form
// of the same pieces measured 92 / 129 / 170 / 179 cycles and put three edge
// slots past the ceiling.
//
// THE PAD DESTROYS NOTHING. These run inside `exx`, where B is the mixer's
// build cursor, so the pad may not use the `ld b,k`/`djnz` filler — `dead: []`
// gives it nops, `jp $+3` and `jr $+2` only, and a length those cannot reach
// is a generation-time error rather than a rounded slot.
//
// A START OR A STOP IS A GENERATION (config.mjs PCM1): the 68000 bumps a byte,
// the Z80 acts when it differs from the one it last acted on and latches the
// value it READ — so a bump that lands between the read and the latch is still
// different at the next edge, and nothing is ever cleared unseen.
//
// THE END THE HOST SENDS IS `sampleEnd - 16 * step`. The compare sees DE' after
// the mix of the block's fifteenth sample; if it does not park, the next block
// reads DE' + step .. DE' + 16 * step, which is below the sample's end exactly
// when DE' < sampleEnd - 16 * step. So the voice parks at the last edge before
// it would read past the end, never reads beyond it, and loses at most sixteen
// output samples of the tail.
const st = (cfg, k) => `$${(pcm1Base(cfg) + PCM1[k]).toString(16)}`;
let edgeSeq = 0;

/**
 * `jr cc,skip` around `arm`, then a pad on the skip path of exactly arm + 7.
 *
 *   not taken:  7 + arm + 12
 *   taken:     12 + pad          with pad = arm + 7
 *
 * The ops are costed as the NOT-TAKEN path (the `jr` at 7, the arm, the `jr`
 * over the pad at 12, the pad at 0), and the taken path costs the same by the
 * arithmetic above. Both are checked by running them, not by trusting this.
 */
function balanced(cc, arm0, what) {
  const n = edgeSeq++;
  const skip = `pcmsk${n}`, done = `pcmdn${n}`;
  // The no-clobber fillers cost 4, 10 and 12, so the pad can only reach an
  // even length: an arm whose cost is even gets a 7-cycle `ld a,0` appended
  // (A is dead at the end of every arm here) so that arm + 7 is reachable.
  let arm = arm0, pad = null;
  for (const extra of [[], [op("ld   a,0", 7, { clobbers: ["a"] })],
    [op("nop", 4)], [op("ld   a,0", 7, { clobbers: ["a"] }), op("nop", 4)]]) {
    arm = [...arm0, ...extra];
    try { pad = padTo(cost(arm) + 7, { dead: [] }); break; } catch { pad = null; }
  }
  if (!pad) throw new Error(`balanced: no mirror pad for an arm of ${cost(arm0)} cycles`);
  const armCycles = cost(arm);
  return [
    op(`jr   ${cc},${skip}`, 7, { what: `${what}: 12 taken / 7 not`, balanced: { arm: armCycles, pad: cost(pad) } }),
    ...arm,
    op(`jr   ${done}`, 12),
    op([`${skip}:`, ...pad.flatMap((o) => o.asm)], 0,
      { what: "the other arm, padded to the same length" }),
    op([`${done}:`], 0),
  ];
}

/** STOP (b13): `END := 0` when `stopGen != lastStop`; latch what was read. */
const pcmEdgeStop = (cfg) => [
  op("exx", 4, { what: "PCM edge: stop" }),
  op(`ld   a,(${st(cfg, "stopGen")})`, 13),
  op("ld   l,a", 4),
  op(`ld   a,(${st(cfg, "lastStop")})`, 13),
  op("cp   l", 4),
  ...balanced("z", [
    // The generation is latched BEFORE `ld hl,0` takes L away: latching after
    // it stored 0, so the stop fired at every edge from then on and re-zeroed
    // END one edge after every restart (found by the gate's stop case).
    op("ld   a,l", 4),
    op(`ld   (${st(cfg, "lastStop")}),a`, 13, { what: "this stop is consumed" }),
    op("ld   hl,0", 10),
    op(`ld   (${st(cfg, "liveEnd")}),hl`, 16, { what: "END := 0 — the next compare parks" }),
  ], "no stop pending"),
  op("exx", 4),
];

/** COMPARE (b14): `park := DE' >= END`, kept in RAM for the next slot. */
const pcmEdgeCompare = (cfg) => [
  op("exx", 4, { what: "PCM edge: compare the play pointer with END" }),
  op(`ld   hl,${st(cfg, "liveEnd")}`, 10),
  op("ld   a,e", 4),
  op("sub  (hl)", 7),
  op("inc  l", 4),
  op("ld   a,d", 4),
  op("sbc  a,(hl)", 7, { what: "carry = DE' < END" }),
  op("sbc  a,a", 4),
  op("cpl", 4, { what: "$ff when the pointer has reached END" }),
  op(`ld   (${st(cfg, "parkMask")}),a`, 13, { what: "PARK" }),
  op("exx", 4),
];

/** PARK (b15, after the level pages): `DE' := SILENCE` where park says so. */
const pcmEdgePark = (cfg) => [
  op("exx", 4, { what: "PCM edge: park" }),
  op(`ld   a,(${st(cfg, "parkMask")})`, 13),
  op("or   a", 4),
  ...balanced("z", [
    op("ld   de,PCM_SILENCE", 10, { what: "the voice parks in the silence page" }),
  ], "not parking"),
  op("exx", 4),
];

/** START (b0, before the mix): the staged pointer, end and step, if pending. */
const pcmEdgeStart = (cfg) => [
  op("exx", 4, { what: "PCM edge: start" }),
  op(`ld   a,(${st(cfg, "startGen")})`, 13),
  op("ld   l,a", 4),
  op(`ld   a,(${st(cfg, "lastStart")})`, 13),
  op("cp   l", 4),
  ...balanced("z", [
    op(`ld   de,(${st(cfg, "stSrc")})`, 20, { what: "DE' := the staged start" }),
    op(`ld   a,(${st(cfg, "stStep")})`, 13),
    op("ld   (mix_st+1),a", 13, { what: "the step, into the mix's own operand" }),
    op("ld   a,l", 4),
    op(`ld   (${st(cfg, "lastStart")}),a`, 13, { what: "this start is consumed" }),
    op(`ld   hl,(${st(cfg, "stEnd")})`, 16),
    op(`ld   (${st(cfg, "liveEnd")}),hl`, 16, { what: "END := the staged end" }),
  ], "no start pending"),
  op("exx", 4),
];

/** The pieces' costs, for the ledger and the report. */
export const pcmEdgeCost = (cfg) => ({
  stop: cost(pcmEdgeStop(cfg)), compare: cost(pcmEdgeCompare(cfg)),
  park: cost(pcmEdgePark(cfg)), start: cost(pcmEdgeStart(cfg)),
});

// ── THE EXPANDER (R28 §63.3 D3/D4, step 2) ─────────────────────────────────
//
// The 68000 writes 2-byte {op, val} pairs into a 128-pair page; sixteen steps
// a lap consume them, one pair a step, at fixed slots. A step is two pieces:
//
//   xp_a   fetch the op and run ONE of three arms, all of one length:
//            RAW    op >= $22: the op is a YM register; write it and the value
//                   to the current port, then put the DAC's latch back
//            PORT   op == $20: the value picks the port for the RAW arms
//            STORE  op <  $20: `(PCM_STATE + op) := val` — the levels, the
//                   staged start, the two generation bumps, and op $00 (IDLE)
//                   into a bucket byte, so an empty pair is the same path
//   xp_b   idle the consumed pair, advance the pointer, publish the index
//
// IX is the FIFO pointer for the life of the run — its high byte is the page
// and the low byte wraps by an 8-bit add, so the ring needs no test. IY's high
// byte is the globals page for the same reason: the STORE arm's target is one
// `ld iyl,a` away. Neither register is used anywhere else in this profile. A
// and F are dead at every site; DE, HL and BC are not touched.
//
// The three arms are balanced the same way the edge pieces are: two `jr`s pick
// the arm, and each arm's tail is padded so every path through xp_a costs the
// same — checked by the selftest running all three, not by adding them up.
const XP = { RAW_MIN: 0x22, PORT: 0x20 };

/**
 * Pad several arms to ONE length. Each arm is `{ops, fixed}` — its own ops
 * plus the branch cycles on its path — and the answer is one pad per arm and
 * the common total. Where a difference is unreachable by the no-clobber
 * fillers the arm itself is lengthened by `ld a,0` (A is dead at the end of
 * every arm this is used on) and the search starts again; the smallest common
 * total that works is the one returned. The arms' op lists are extended IN
 * PLACE so the caller emits what was priced.
 */
function balanceArms(arms) {
  const reach = (n) => { try { return padTo(n, { dead: [] }); } catch { return null; } };
  const EXTRA = [[], [op("ld   a,0", 7, { clobbers: ["a"] })], [op("nop", 4)],
    [op("ld   a,0", 7, { clobbers: ["a"] }), op("nop", 4)]];
  const idx = (n, k) => Math.floor(n / EXTRA.length ** k) % EXTRA.length;
  let best = null;
  for (let combo = 0; combo < EXTRA.length ** arms.length; combo++) {
    const costs = arms.map((a, k) => cost(a.ops) + a.fixed + cost(EXTRA[idx(combo, k)]));
    const target = Math.max(...costs);
    const pads = costs.map((c) => reach(target - c));
    if (pads.every((p) => p) && (!best || target < best.target)) best = { target, pads, combo };
  }
  if (!best) throw new Error("balanceArms: no common length is reachable");
  arms.forEach((a, k) => a.ops.push(...EXTRA[idx(best.combo, k)]));
  return [...best.pads, best.target];
}

function expanderRoutines(cfg) {
  const base = pcm1Base(cfg);
  const fifoLo = `$${(base + (cfg.loops ? PCMN_L.fifoLo : cfg.multi ? PCMN.fifoLo : PCM1.fifoLo)).toString(16)}`;
  // The three arms, priced.
  const store = [
    op(`add  a,${base & 0xff}`, 7, { what: "STORE: the op is an offset into the state block" }),
    op("ld   iyl,a", 8),
    op("ld   a,(ix+1)", 19, { what: "the value" }),
    op("ld   (iy+0),a", 19, { what: "(PCM_STATE + op) := val" }),
  ];
  const port = [
    op("ld   a,(ix+1)", 19, { what: "PORT: 0 or 1" }),
    op("add  a,a", 4),
    op("ld   (xp_p0+1),a", 13, { what: "the address port's low byte: $00 / $02" }),
    op("inc  a", 4),
    op("ld   (xp_p1+1),a", 13, { what: "…and the data port's: $01 / $03" }),
  ];
  const raw = [
    op(["xp_p0:", `ld   (${hex(YM.addr0)}),a`], 13, { what: "RAW: the register, to the current port" }),
    op("ld   a,(ix+1)", 19, { what: "the value" }),
    op(["xp_p1:", `ld   (${hex(YM.data0)}),a`], 13),
    op(`ld   a,${hex(YM.R_DAC)}`, 7),
    op(`ld   (${hex(YM.addr0)}),a`, 13, { what: "the DAC's latch, put back in the same step" }),
  ];
  // Path costs from the fetch to the common exit:
  //   store:  cp 7 + jr 7 + cp 7 + jr 7 + store + jr 12
  //   port:   cp 7 + jr 7 + cp 7 + jr 12 + port + jr 12
  //   raw:    cp 7 + jr 12 + raw            (it is placed last: no jr needed)
  // A is dead at the end of every arm, so an arm may take a 7-cycle `ld a,0`
  // to make its mirror pad reachable — the no-clobber fillers reach only 0, 4
  // and the even numbers from 8 up.
  const [padS, padP, padR, target] = balanceArms([
    { ops: store, fixed: 7 + 7 + 7 + 7 + 12 },
    { ops: port, fixed: 7 + 7 + 7 + 12 + 12 },
    { ops: raw, fixed: 7 + 12 }]);
  const cS = cost(store) + 7 + 7 + 7 + 7 + 12, cP = cost(port) + 7 + 7 + 7 + 12 + 12, cR = cost(raw) + 7 + 12;
  const L = [];
  const emit = (ops) => { for (const o of ops) for (const l of o.asm) L.push(l.endsWith(":") ? l : `        ${l}`); };
  L.push("; ── The expander, piece A: fetch a pair and run one padded arm ──────────");
  L.push(`; every path from xp_a to its ret costs ${17 + 19 + target + 10} cycles (call included)`);
  L.push("xp_a:");
  L.push("        ld   a,(ix+0)           ; the op");
  L.push(`        cp   ${hex(XP.RAW_MIN)}`);
  L.push("        jr   nc,xp_raw");
  L.push(`        cp   ${hex(XP.PORT)}`);
  L.push("        jr   z,xp_port");
  emit(store); emit(padS);
  L.push("        jr   xp_done");
  L.push("xp_port:");
  emit(port); emit(padP);
  L.push("        jr   xp_done");
  L.push("xp_raw:");
  emit(raw); emit(padR);
  L.push("xp_done:");
  L.push("        ret");
  L.push("");
  L.push("; ── piece B: the pair is consumed, the pointer moves, the index is public ─");
  L.push("xp_b:");
  L.push("        ld   (ix+0),0           ; IDLE — a pair is executed once");
  L.push("        ld   a,ixl");
  L.push("        add  a,2                ; the page wraps by itself");
  L.push("        ld   ixl,a");
  L.push(`        ld   (${fifoLo}),a        ; what the 68000 reads: the next pair to be consumed`);
  L.push("        ret");
  L.push("");
  return { text: L.join("\n"), aCycles: 17 + 19 + target + 10, bCycles: 17 + 19 + 8 + 7 + 8 + 13 + 10,
    arms: { store: cS, port: cP, raw: cR, target } };
}

/** The ops a site slot carries: a `call`, costed with the routine inside it. */
function expanderPlan(cfg) {
  const r = expanderRoutines(cfg);
  const plan = new Map();
  for (const s of expanderSites(cfg)) {
    plan.set(s.a, [op("call xp_a", r.aCycles, { what: `expander A (step ${plan.size >> 1})` })]);
    plan.set(s.b, [op("call xp_b", r.bCycles, { what: "expander B: idle, advance, publish" })]);
  }
  return { plan, routines: r };
}
export const expanderCost = (cfg) => expanderRoutines(cfg);

/**
 * THE N-VOICE SITE PLAN: `cfg.xpSteps` steps spread evenly over the lap, each
 * A piece in the first slot at or after its even position that still has room
 * under the ceiling for it, and its B piece in the next such slot. Placed
 * against the slot's own work (the mix and the edges), before the decode is,
 * because the expander's positions are fixed for the host and the decode's are
 * not. Steps stay in order: step j+1's A comes after step j's B.
 */
function nvExpanderPlan(cfg) {
  const r = expanderRoutines(cfg);
  const n = cfg.cycleSlots, S = cfg.xpSteps;
  const room = [];
  for (let i = 0; i < n; i++) {
    const used = 7 + 11 + (i === n - 1 ? 10 : 0) + cost(slotWork(cfg, i, { dead: DEAD_DEFAULT }));
    room.push(Math.floor(cfg.workTarget * cfg.slotCycles[i % cfg.groupSlots]) - used);
  }
  // Even spacing first; where the heavy slots push the last steps off the end
  // of the lap, the spacing is compressed until every step lands.
  const tryPlace = (squeeze) => {
    const left = [...room], sites = [];
    let at = 0;
    for (let j = 0; j < S; j++) {
      let a = Math.max(at, Math.floor((j * n * squeeze) / S));
      while (a < n && left[a] < r.aCycles) a++;
      // THE ROOMIEST SLOT IN REACH, not the first that fits (D10): a site that
      // lands on an edge slot makes that slot the lap's worst and sets the
      // rate. Within the step's own spacing, take the slot with the most room.
      if (cfg.loops) {
        const lim = Math.min(n, Math.floor(((j + 1) * n * squeeze) / S));
        for (let k = a + 1; k < lim; k++) if (left[k] > left[a] && left[k] >= r.aCycles) a = k;
      }
      let b = a + 1;
      while (b < n && left[b] < r.bCycles) b++;
      if (cfg.loops) {
        const lim = Math.min(n, b + 3);
        for (let k = b + 1; k < lim; k++) if (left[k] > left[b] && left[k] >= r.bCycles) b = k;
      }
      if (b >= n) return { failedAt: j };
      left[a] -= r.aCycles; left[b] -= r.bCycles;
      sites.push({ a, b });
      at = b + 1;
    }
    return { sites };
  };
  let got = null;
  for (let q = 100; q >= 0 && !got?.sites; q -= 5) got = tryPlace(q / 100);
  if (!got.sites)
    throw new Error(`the expander's step ${got.failedAt} of ${S} finds no room in a ${n}-slot lap`
      + ` (A ${r.aCycles}, B ${r.bCycles} cycles; the most room any slot has is ${Math.max(...room)})`);
  const plan = new Map();
  got.sites.forEach(({ a, b }, j) => {
    plan.set(a, [op("call xp_a", r.aCycles, { what: `expander A (step ${j})` })]);
    plan.set(b, [op("call xp_b", r.bCycles, { what: "expander B: idle, advance, publish" })]);
  });
  return { plan, routines: r, sites: got.sites };
}

// ── §4's 経路別サイクル表 ───────────────────────────────────────────────────
// Costed from the encodings, not measured and not fitted. Every path P1 can
// take is here; the paths it cannot take yet are listed with what they wait on,
// because a table that silently omits them reads as if they were free.
export function cyclePaths(cfg) {
  const c = (ops) => cost(ops);
  const rows = [
    ["DAC sample write", 7, "`ld (de),a` — DE holds $4001 for the life of the run"],
    ["next-sample fetch", 11, "`ld a,(hl)` + `inc l`; the ring page wraps for free"],
    ["one YM register write", c(ymWrite(0x30, 0x00)), "address + data, both through A"],
    ["one YM write, value from RAM", c(ymWrite(0x30, "(G_CSMHI)")), "`ld a,(nn)` is 13, not 7"],
    ["$2A re-latch", c(relatchDac()), "charged to the slot that disturbed the address port"],
    ["Timer B observation", c(readStatus()), "status read + stash; no branch on the result"],
    ["Timer B flag reset", c(ymWrite(YM.R_TIMER_CTL, "R27_RESET")), "through the $27 shadow"],
  ];
  if (cfg.voices) {
    rows.push(["mix, one sample", c(callMix(cfg)),
      `call + routine, ${cfg.voices} voice${cfg.voices > 1 ? "s" : ""} incl. master`]);
    rows.push(["…of which the 2nd voice", cfg.voices >= 2 ? 19 + 8 + 4 + 7 + 7 : 0,
      "`ld a,(ix+0)` + `inc ixl` is 27 where DE's is 11 — the price of a 2nd pointer"]);
    rows.push(["…of which the clamp", cfg.voices >= 2 ? 7 + 4 + 7 + 7 + 4 + 7 : 0,
      "add, then a 512 B table indexed by the carry — branch-free, constant time"]);
    rows.push(["block edge (level change)", c(blockEdge(cfg)),
      `${cfg.voices >= 2 ? 3 : 2} pages into the mix routine's own immediates, once per ${cfg.blockSamples}`]);
  }
  rows.push(["slot with nothing else", 7 + 11, `the floor: ${(100 * 18 / cfg.periodCycles).toFixed(1)}% of an interval`]);
  rows.push(["group", cfg.groupCycles, `${cfg.groupSlots} slots, EXACT — no residue survives a group`]);
  const pending = [
    ...(cfg.voices >= 2 ? [] : [["a second voice", "P2 — measured at 2 voices, see the two-voice cases"]]),
    ["a third voice", "P5 — not attempted; §5 says one dimension at a time"],
    ["loop wrap, ROM bank step", "NOT BUILT. The source is one 256 B page and `inc e` wraps it"],
    ["voice start / stop / end", "NOT BUILT — needs the command protocol"],
    ["command dispatch", "P3 — sample-timed commands"],
    ["interrupt entry", "NOT TAKEN. This engine runs with interrupts disabled"],
    ["bus-grab recovery", "P3 — measured, not modelled: see the grab case"],
  ];
  return { rows, pending };
}

// ── The generator ──────────────────────────────────────────────────────────
/**
 * @param cfg
 * @param extraWork  optional (slotIndex) => ops, appended to that slot's work.
 *   It exists so an experiment can be placed in the REAL schedule — with the
 *   real mixer, the real CSM traffic and the real pad arithmetic — instead of
 *   re-emitting a copy of the slot loop beside it. An experiment that does not
 *   fit is then a slot overrun at generation time, which is the point.
 * @param bootExtra  optional array of asm lines emitted at the END of boot,
 *   before the loop is entered. State an experiment keeps in RAM is
 *   initialised HERE and not left to whatever the core's RAM happens to hold
 *   (R7 §20.2 B) — a run whose first observation depended on a zeroed core was
 *   not testing initialisation at all.
 * @param slotDead  optional (slotIndex) => the registers this slot may destroy.
 *   Defaults to DEAD_DEFAULT everywhere. It reaches BOTH the reserved padding
 *   and the slot's own pad, because both use `ld b,k`/`djnz` and both sit
 *   between one piece of a distributed computation and the next (R8 §23.3).
 */
export function generate(cfg, extraWork = null, bootExtra = null, slotDead = null,
  commandPlan = null, ymPlan = null) {
  const L = [];
  const slots = [];
  const P = (s = "") => L.push(s);
  const xp = cfg.oneVoice ? expanderPlan(cfg) : cfg.multi ? nvExpanderPlan(cfg) : null;

  P(`; ${stampLine(cfg)}`);
  P(";");
  P("; GENERATED by drv/engine/gen-stream.mjs — do not edit.");
  P("; The output-only DAC stream prototype (P1). No mixer, no commands, no host");
  P("; transfer: one known waveform out of Z80 RAM on a cycle-placed schedule.");
  P(";");
  P(`; Sample period ${cfg.periodNum}/${cfg.periodDen} = ${cfg.periodCycles} Z80 cycles`);
  P(`; Group        ${cfg.groupSlots} slots = ${cfg.groupCycles} cycles EXACTLY (no residue to accumulate)`);
  P(`; Slot lengths ${cfg.slotCycles.join(", ")}`);
  P("");
  P(`YM_ADDR0    equ ${hex(YM.addr0)}`);
  P(`YM_DATA0    equ ${hex(YM.data0)}`);
  if (cfg.voices) {
    P(`LUT         equ ${hex(cfg.ram.lut[0])}       ; ${cfg.levels} pages, one per level (lut.mjs)`);
    if (cfg.ram.clamp)
      P(`CLAMP       equ ${hex(cfg.ram.clamp[0])}       ; ${CLAMP_SIZE} B — the saturating add, as a table`);
    P(`RING        equ ${hex(cfg.ram.ring[0])}       ; 256 B — the finished samples`);
    if (cfg.oneVoice || cfg.multi) {
      P(`PCM_STATE   equ ${hex(pcm1Base(cfg))}       ; the one voice's state, in the globals (config.mjs PCM1)`);
      P(`PCM_SILENCE equ ${hex(PCM1_SILENCE)}       ; where a parked voice reads (R28 §63.3 D2)`);
      P(`FIFO        equ ${hex(cfg.ram.fifo[0])}       ; 128 {op,val} pairs the 68000 writes (R28 §63.3 D3)`);
    }
    P(`WINDOW      equ $8000              ; the 68k bank window the source lives in`);
    P(`LEAD        equ ${cfg.lead}                  ; the build cursor runs this far ahead`);
  } else {
    P(`WAVE        equ ${hex(cfg.ram.wave[0])}       ; 256 B, page aligned`);
  }
  // Every global's offset comes from config's GLOB table, which is the only
  // place a live byte of this region is named (R7 §20.2 B).
  const gh = (n) => `$${n.toString(16).padStart(2, "0")}`;
  P(`G_BASE      equ ${hex(cfg.ram.glob[0])}`);
  P(`G_STATUS    equ G_BASE+${gh(GLOB.status)}      ; u8  last YM status byte read`);
  P(`G_CSMHI     equ G_BASE+${gh(GLOB.csmHi)}      ; u8  CSM ch3 frequency, block/hi`);
  P(`G_CSMLO     equ G_BASE+${gh(GLOB.csmLo)}      ; u8  CSM ch3 frequency, lo`);
  if (cfg.voices) {
    P(`G_V0PAGE    equ G_BASE+${gh(GLOB.v0page)}      ; u8  LUT page for voice 0's level (the host writes it)`);
    P(`G_V1PAGE    equ G_BASE+${gh(GLOB.v1page)}      ; u8  …voice 1's`);
    P(`G_MPAGE     equ G_BASE+${gh(GLOB.mpage)}      ; u8  …and the master's`);
  }
  P(`STACK_TOP   equ ${hex(cfg.ram.stack[1])}`);
  P("");
  // The $27 shadow (§3.5): one byte that carries CH3 mode, both timers' load
  // and enable bits, and the flag reset. Timer B's flag is reset THROUGH it, so
  // a reset can never clear CSM or stop Timer A.
  const r27 = (cfg.csm ? YM.CTL_CH3_CSM : 0)
    | YM.CTL_LOAD_A | YM.CTL_ENA_A | YM.CTL_LOAD_B | YM.CTL_ENA_B;
  P(`R27_BASE    equ ${hex(r27)}       ; CH3 mode | Load A | Enable A | Load B | Enable B`);
  P(`R27_RESET   equ R27_BASE|${hex(YM.CTL_RESET_B)}  ; …and Timer B's flag reset, composed not replaced`);
  P("");
  P("        org 0");
  P("");
  P("; ── Boot ──────────────────────────────────────────────────────────────");
  P("; Not timed: everything here runs before the first sample leaves. The one");
  P("; rule that still applies is the chip's settling table — the analyzer");
  P("; checks these writes exactly as it checks the loop's.");
  P("        di                      ; …and never enabled again (see the header)");
  P("        im   1");
  P("        ld   sp,STACK_TOP");
  const boot = [];
  const bootWrite = (reg, val, what) => boot.push(...ymWrite(reg, val, what));
  // The light image leaves $2B to the sequencer (plan-pcm-d10-design.md §3.6):
  // a score without PCM keeps fm6 as FM.
  if (!cfg.loops) bootWrite(YM.R_DACEN, 0x80, "DAC enable");
  // The shipped image sets no timer: it keeps none, and $24..$27 are the
  // sequencer's to write through the pair stream (R28 step 4).
  if (!cfg.production) {
    bootWrite(YM.R_TIMER_B, cfg.timerB, "Timer B period");
    bootWrite(YM.R_TIMER_A_HI, cfg.timerAna >> 2, "Timer A period, hi");
    bootWrite(YM.R_TIMER_A_LO, cfg.timerAna & 3, "Timer A period, lo");
  }
  // A minimal but real CH3 voice, so CSM has something to key. Operator offsets
  // for channel 3 on port 0 are +2. Emitted as a TABLE and a loop, not 34
  // unrolled writes: this is boot code for a test voice, it is not timed, and
  // unrolled it was 438 BYTES — a fifth of the code region, spent on the test
  // harness rather than on the engine, and enough to push the 15-level image
  // with the distributed decode past the region it otherwise fits in.
  // …and when the 68000 is going to write it instead (R19 §46.3), the Z80 emits
  // none of it: the test harness's 161 bytes are not charged to the engine's
  // code region, which is what lets the 15-level image with the distributed
  // decode, the corrector, the protocol and the consumer assemble inside 2,560 B
  // WITH CSM on.
  const csmVoice = cfg.csm && !cfg.csmHost ? CSM_TEST_VOICE : [];
  if (!cfg.production) bootWrite(YM.R_TIMER_CTL, "R27_BASE", "timers + CH3 mode");
  for (const o of boot) for (const l of o.asm) P(`        ${l}`);
  if (csmVoice.length) {
    P("");
    P("; The CH3 test voice, table-driven. Not timed — it all runs before the");
    P("; first sample leaves — and the analyzer sees exactly the same writes in");
    P("; exactly the same order as the unrolled form it replaces.");
    P("        ld   hl,csmvoice");
    P(`        ld   b,${csmVoice.length}`);
    P("csmload:");
    P("        ld   a,(hl)");
    P("        inc  hl");
    P(`        ld   (${YM_ADDR}),a`);
    P("        ld   a,(hl)");
    P("        inc  hl");
    P(`        ld   (${YM_DATA}),a`);
    P("        djnz csmload");
    P("        jr   csmdone");
    P("csmvoice:");
    for (let i = 0; i < csmVoice.length; i += 4)
      P(`        db   ${csmVoice.slice(i, i + 4).map(([r, v]) => `${hex(r)},${hex(v)}`).join(",")}`);
    P("csmdone:");
    P("");
  }
  // The CH3 frequency the per-slot CSM writes send. It is the TEST VOICE's
  // frequency, so when the 68000 loads the voice it writes these two bytes too
  // and the Z80's image does not carry them (R19 §46.3).
  if (!cfg.csmHost) {
    P("");
    P("        ld   a,$22");
    P("        ld   (G_CSMHI),a");
    P("        ld   a,$69");
    P("        ld   (G_CSMLO),a");
  }
  P("");
  if (cfg.multi) {
    // THE N-VOICE BOOT: every voice parked on the silence page at rung 0
    // (silence), END 0, and — as in the one-voice boot — only the Z80's own
    // bytes of the state block touched: the staged fields are the 68000's.
    const ST = cfg.loops ? PCMN_L : PCMN;
    P("; Every voice silent and parked; only the Z80's own state bytes written.");
    P("        ld   a,LUT>>8               ; page 0 — silence");
    for (let v = 0; v < cfg.voices; v++) {
      P(`        ld   (PCM_STATE+${ST.level(v)}),a`);
      if (!cfg.flatLevel) P(`        ld   (mix_v${v}+1),a`);
    }
    P("        ld   hl,RING");
    P("        ld   b,0");
    P("bootsil:");
    P(`        ld   (hl),${hex(SILENCE)}`);
    P("        inc  l");
    P("        djnz bootsil");
    P("        exx");
    P("        ld   de,PCM_SILENCE");
    P("        ld   bc,RING+LEAD");
    P("        ld   hl,0");
    P("        exx");
    P("        xor  a");
    for (let v = 0; v < cfg.voices; v++)
      for (const k of cfg.loops ? ["lastStart", "lastEnd", "parkMask", "startMask", "applyMask"]
        : ["lastStart", "lastStop", "parkMask"]) P(`        ld   (PCM_STATE+${ST[k](v)}),a`);
    P("        ld   hl,0");
    for (let v = 0; v < cfg.voices; v++) P(`        ld   (PCM_STATE+${ST.liveEnd(v)}),hl`);
    if (cfg.loops) {
      P("        ld   hl,PCM_SILENCE");
      for (let v = 0; v < cfg.voices; v++) P(`        ld   (PCM_STATE+${ST.liveWrap(v)}),hl`);
    }
    P("        ld   hl,FIFO");
    P("        ld   b,0");
    P("fifoinit:");
    P("        ld   (hl),0");
    P("        inc  l");
    P("        djnz fifoinit");
    P("        ld   ix,FIFO");
    P(`        ld   iy,${hex(pcm1Base(cfg) & 0xff00)}`);
    P("        xor  a");
    P(`        ld   (PCM_STATE+${ST.fifoLo}),a`);
    P("");
  } else if (cfg.voices) {
    P("; Levels start at unity. The host writes G_VPAGE / G_MPAGE whenever it");
    P("; likes; the block edge is what makes the change take effect, and it");
    P("; takes effect whole (§3.4).");
    P(`        ld   a,(LUT>>8)+${cfg.levels - 1}    ; unity — the TOP page of the family`);
    if (cfg.oneVoice) {
      // THE SHIPPED IMAGE BOOTS SILENT (R28 step 4): until the host sets the
      // sample bank the window shows whatever ROM bank 0 holds, and the parked
      // voice would play it. Level 0 keeps the DAC at silence whatever the
      // window shows; every PCM start carries its own level page.
      if (cfg.production) P(`        ld   a,LUT>>8               ; level 0 — silence until a start`);
      P(`        ld   (PCM_STATE+${PCM1.level}),a`);
      if (cfg.production) P(`        ld   a,(LUT>>8)+${cfg.levels - 1}`);
      P(`        ld   (PCM_STATE+${PCM1.master}),a`);
    } else {
      P("        ld   (G_V0PAGE),a");
      if (cfg.voices >= 2) P("        ld   (G_V1PAGE),a");
      P("        ld   (G_MPAGE),a");
    }
    if (cfg.production) P("        ld   a,LUT>>8");
    P("        ld   (mix_v0+1),a");
    if (cfg.production) P(`        ld   a,(LUT>>8)+${cfg.levels - 1}`);
    if (cfg.voices >= 2) P("        ld   (mix_v1+1),a");
    P("        ld   (mix_mp+1),a");
    P("");
    P("; The ring starts at silence, and the first LEAD samples out of the DAC");
    P("; are that silence — the declared start-up exclusion (§6.2).");
    P("        ld   hl,RING");
    P("        ld   b,0                ; 256");
    P("bootsil:");
    P(`        ld   (hl),${hex(SILENCE)}`);
    P("        inc  l");
    P("        djnz bootsil");
    P("");
    P("; The mixer's register set: DE' = voice 0's source in the 68k window,");
    P("; BC' = the build cursor exactly LEAD ahead of the play cursor, HL' = the");
    P("; table scratch. Nothing in the loop reloads any of them.");
    P("        exx");
    P(`        ld   de,${cfg.oneVoice ? "PCM_SILENCE" : "WINDOW"}`);
    P("        ld   bc,RING+LEAD");
    P("        ld   hl,0");
    P("        exx");
    if (cfg.voices >= 2) P("        ld   ix,WINDOW+$100     ; voice 1's own page");
    if (cfg.oneVoice) {
      // The voice starts PARKED: END is zero, so the first compare parks it,
      // and the pointer already sits in the silence zone. Every staged byte is
      // zero, so nothing starts until the host stages a start. The step operand
      // in `mix_st` assembles as 1 and stays 1 until a start changes it.
      P("; The one voice's state: parked, and ONLY THE Z80'S OWN BYTES touched.");
      P("; The staged fields and both generation counters are the 68000's, and it");
      P("; may have written a start before releasing the bus — a boot that zeroed");
      P("; the whole block erased it (found on BlastEm, R28 §63.6 step 1).");
      P("        xor  a");
      for (const k of ["lastStart", "lastStop", "parkMask"])
        P(`        ld   (PCM_STATE+${PCM1[k]}),a       ; ${k}`);
      P("        ld   hl,0");
      P(`        ld   (PCM_STATE+${PCM1.liveEnd}),hl      ; END = 0: the first compare parks`);
      P("; The expander: the pair page all IDLE, the pointer at its start, the");
      P("; published index 0, IY's high byte the globals page for the STORE arm.");
      P("        ld   hl,FIFO");
      P("        ld   b,0                ; 256 bytes");
      P("fifoinit:");
      P("        ld   (hl),0");
      P("        inc  l");
      P("        djnz fifoinit");
      P("        ld   ix,FIFO");
      P(`        ld   iy,${hex(pcm1Base(cfg) & 0xff00)}`);
      P("        xor  a");
      P(`        ld   (PCM_STATE+${PCM1.fifoLo}),a`);
    }
    P("");
  }
  if (bootExtra && bootExtra.length) {
    P("; State this build keeps in RAM, initialised explicitly.");
    for (const l of bootExtra) P(l.endsWith(":") ? l : `        ${l}`);
    P("");
  }
  if (cfg.voices) {
    // The mixer's page number is a self-modified operand: a page outside the
    // family does not fault, it reads whatever is there as a volume table. In
    // the 15-level profile the very next page is the phase table (R8 §23.2).
    const unity = (cfg.ram.lut[0] >> 8) + cfg.levels - 1;
    if (!pageIsALevel(cfg, unity))
      throw new Error(`the unity page $${unity.toString(16)} is not inside the level family`);
    const { levels: pages } = lutPages(cfg);
    if (pages !== cfg.levels)
      throw new Error(`the level family holds ${pages} pages and the profile says ${cfg.levels}`);
  }
  if (cfg.oneVoice || cfg.multi) {
    P("; Boot is done: the host may take the bus from here on (it reads this byte).");
    P(`        ld   a,${hex(PCM1_READY_MARK)}`);
    P(`        ld   (PCM_STATE+${cfg.loops ? PCMN_L.ready : cfg.multi ? PCMN.ready : PCM1.ready}),a`);
    P("");
  }
  P("; The DAC's address latch is written ONCE. Every slot writes data only,");
  P("; and any slot that disturbs the address port puts it back itself.");
  P(`        ld   a,${hex(YM.R_DAC)}`);
  P("        ld   (YM_ADDR0),a");
  P(`        ld   hl,${cfg.voices ? "RING" : "WAVE"}`);
  P("        ld   de,YM_DATA0");
  P("        ld   a,(hl)             ; prime the first sample");

  P("        inc  l");
  P("");
  P("; ── The output loop ───────────────────────────────────────────────────");
  P("; Each slot BEGINS with the DAC write, so the interval between two writes");
  P("; is the slot's length whatever else the slot carries.");
  P("stream:");

  for (let i = 0; i < cfg.cycleSlots; i++) {
    const cycles = cfg.slotCycles[i % cfg.groupSlots];
    // DE holds the data port for the life of the run: `ld (de),a` is 7 cycles
    // where the absolute store is 13, and the DAC write is the one instruction
    // that happens on every single sample.
    const dacWrite = op("ld   (de),a", 7,
      { writes: [{ port: 0, kind: "data", reg: YM.R_DAC }], what: "DAC sample" });
    // `slotDead` may return a register list, a {dead, stack} filler spec, or
    // {work, pad} — two of them. The last shape exists because a slot's
    // RESERVED padding runs BEFORE whatever the slot carries and its own pad
    // runs after, so the two answer different questions: what has to survive
    // INTO this slot, and what has to survive OUT of it (R8 §23.3).
    const d0 = slotDead ? slotDead(i) : DEAD_DEFAULT;
    const spec = Array.isArray(d0) ? { dead: d0 } : d0;
    const workFill = spec.work ?? spec, padFill = spec.pad ?? spec;
    const work = [...slotWork(cfg, i, workFill, commandPlan, ymPlan, xp?.plan ?? null),
      ...(extraWork ? extraWork(i) : [])];
    // THE FETCH GOES AFTER THE PAD. `a` carries the next sample across the slot
    // boundary, so anything that runs after the fetch may not touch it — and
    // the pad's only odd-cost filler is `ld a,0`. Fetching last makes `a` dead
    // for the whole pad, which is what lets the pad hit an odd residual at all.
    // (Found by the 3.3 kHz case: its tail padded with `ld a,0` and every other
    // sample went out as zero. At 10 kHz the pad happened to be a bare djnz and
    // nothing showed.)
    const isLast = i === cfg.cycleSlots - 1;
    const tail = [
      op("ld   a,(hl)", 7, { clobbers: ["a"], what: "next sample" }),
      op("inc  l", 4, { what: "cursor (256 B page, wraps free)" }),
      ...(isLast ? [op("jp   stream", 10, { what: "loop" })] : []),
    ];
    const laid = laySlot({ index: i, cycles, dacWrite, work, tail, fill: padFill });
    slots.push(laid);
    P(`slot${i}:                         ; ${cycles} cyc — work ${laid.row.work}, pad ${laid.row.pad}`);
    // A label has to sit flush left; everything else is indented.
    for (const o of laid.ops) for (const l of o.asm) P(l.endsWith(":") ? l : `        ${l}`);
  }
  P("");
  if (cfg.voices) {
    P("; ── The mix, one sample ───────────────────────────────────────────────");
    P("; Constant time, no branch, no test. Called from every slot.");
    P("mix_one:");
    for (const o of mixRoutine(cfg)) for (const l of o.asm) P(l);
    P("");
  }
  if (xp) P(xp.routines.text);
  P("code_end:");
  P(`; total ${cfg.cycleSlots} slots = ${slots.reduce((t, s) => t + s.cycles, 0)} cycles`);
  P(`        assert code_end <= ${hex(cfg.ram.code[1])}, "the loop overran its code region"`);
  P("");
  if (cfg.voices) {
    if (cfg.ram.clamp) {
      P(`        ds   ${hex(cfg.ram.clamp[0])}-$, 0     ; up to the clamp table`);
      P(`; ${CLAMP_SIZE} B: the 9-bit sum of two biased contributions, saturated and re-biased.`);
      const clamp = buildClamp();
      for (let i = 0; i < clamp.length; i += 16)
        P(`        db   ${[...clamp.slice(i, i + 16)].join(",")}`);
    }
    P(`        ds   ${hex(cfg.ram.lut[0])}-$, 0     ; up to the level tables`);
    P(`; ${cfg.levels} pages of 256 bytes: level k maps a signed sample to`);
    P(`; round(s*k/${cfg.levels - 1}), clamped. Level ${cfg.levels - 1} is bit-exact unity`);
    P(`; and level 0 is silence (lut.mjs). Source bytes are ${cfg.signedSource ? "SIGNED" : "biased"}.`);
    const lut = cfg.multi ? buildRungs() : buildLut(cfg.levels, { signed: !!cfg.signedSource });
    for (let i = 0; i < lut.length; i += 16)
      P(`        db   ${[...lut.slice(i, i + 16)].join(",")}`);
    // The light image ends at the last level page: the ring and everything
    // above it are the Z80's to initialise (plan-pcm-d10-design.md §1.3).
    if (!cfg.loops) P(`        ds   ${hex(cfg.ram.ring[0])}-$, 0     ; the ring, zeroed at boot anyway`);
  } else {
    P(`        ds   ${hex(cfg.ram.wave[0])}-$, 0     ; the waveform page the harness fills`);
  }
  P("");

  return { text: L.join("\n"), slots, placement: placementTable(slots, cfg.periodCycles),
    expander: xp ? { sites: cfg.multi ? xp.sites : expanderSites(cfg), ...xp.routines, text: undefined } : null };
}

// ── THE CODE LEDGER (R11 §31.1, restoring the rule R8 §24.3 already fixed) ──
//
// `code_end + what the unwritten features are estimated to cost` DOUBLE-COUNTS.
// A `complete` build EXECUTES those features' cycles as tagged padding, and that
// padding is bytes in the image — bytes the real feature will REPLACE, not add
// to. §24.3 said so and wrote `image - reserved padding + estimate`; both
// split-report.mjs and gate.mjs had drifted back to the plain sum, which is how
// a 2,392 B image came to be reported as 269 B over a 2,560 B region.
//
// The padding is MEASURED from the same generated object, never tabulated: only
// ops the generator tagged `reserved`, so a slot's own pad and a correction
// ladder's nops — which no feature replaces — stay in.
export function reservedPadBytes(gen) {
  let total = 0;
  for (const slot of gen.slots) total += fillBytes(slot.ops.filter((o) => o.reserved));
  return total;
}

/**
 * @param engineBytes  code_end WITHOUT the test scaffolding (the CSM patch dump)
 */
export function codeLedger(cfg, gen, engineBytes) {
  const reserved = reservedPadBytes(gen);
  const owed = (cfg.codeEstimate ?? []).reduce((t, [, b]) => t + b, 0);
  const region = cfg.ram.code[1] - cfg.ram.code[0];
  const finished = engineBytes - reserved + owed;
  return { engine: engineBytes, reserved, owed, finished, region, spare: region - finished };
}
