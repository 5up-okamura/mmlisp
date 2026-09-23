// Generate the MMLispDRV light engine (docs/driver.md §5): a cycle-placed Z80
// output loop that mixes one to three PCM voices read through the 68k window,
// and consumes the {op,val} pairs the 68000 writes into its FIFO page.
//
// It generates rather than hand-places, because a hand-placed pad is a constant
// somebody has to re-derive every time the work changes, and that is the
// failure this design exists to avoid. The schedule is arithmetic: slot length from
// the profile's Bresenham, work from the job list, pad from what is left.
//
// THE ONE STRUCTURAL DECISION WORTH READING. There is no interrupt. The Z80
// runs with interrupts disabled for the whole session and never takes a
// vblank. §3.1 allows this and asks for the time-sync mechanism to be named,
// so:
//
//   * The DAC's clock is the Z80's own instruction stream — a group of slots is
//     a whole number of cycles EXACTLY, so the average carries no drift and no
//     correction is needed for it to stay put.
//   * THERE IS NO PHASE REFERENCE (§3.2, R1). The engine has no wall-clock
//     phase information at all — only the instrument does.
//   * The logical clock for a command is the OUTPUT SAMPLE INDEX (§3.2): a pair
//     takes effect at the block edge that follows the step which consumed it.
//
// Taking the vblank instead would cost ~90 cycles landing at an arbitrary
// point inside a 358-cycle slot: a quarter of the period, four times the §6.2
// tolerance. Reserving it in EVERY slot to make it safe is 25% of the budget
// for an event that happens once every 167 samples.
import { stampLine, GLOB, YM, PCM1_SILENCE, PCM1_READY_MARK, pcm1Base,
  PCMN, PCMN_L } from "./config.mjs";
import { buildClamp, CLAMP_SIZE, lutPages, pageIsALevel, SILENCE, buildRungs } from "./lut.mjs";
import { op, cost, laySlot, placementTable, padTo } from "./schedule.mjs";

const hex = (n) => `$${n.toString(16)}`;

// ── Op builders ────────────────────────────────────────────────────────────
// Costs are documented Z80 T-states. `writes` is what the analyzer checks
// against the chip's settling table — the engine polls nothing.
const YM_ADDR = "YM_ADDR0";
const YM_DATA = "YM_DATA0";

const ymWrite = (reg, val, what) => {
  // A value read from RAM is `ld a,(nn)` at 13, not `ld a,n` at 7. Costing it
  // as the immediate put six cycles a write into every slot that made one and
  // the clock came out 0.67% slow — small enough to look like noise and large
  // enough to fail §6.2 outright, which is the argument for costing from the
  // encoding rather than from the shape of the source line.
  const mem = typeof val === "string" && val.startsWith("(");
  return [
    op(`ld a,${hex(reg)}`, 7, { clobbers: ["a"] }),
    op(`ld (${YM_ADDR}),a`, 13, { writes: [{ port: 0, kind: "addr", reg }] }),
    op(typeof val === "string" ? `ld a,${val}` : `ld a,${hex(val)}`, mem ? 13 : 7, { clobbers: ["a"] }),
    op(`ld (${YM_DATA}),a`, 13, { writes: [{ port: 0, kind: "data", reg }], what }),
  ];
};

// What a slot is allowed to destroy. The default is the pad solver's own, and
// it uses `ld b,k`/`djnz` — four bytes for any length — which is why the whole
// schedule fits in the code region. A slot that has to carry a value in BC
// across its pad cannot use it: it gets `["a"]` and pays in bytes (R8 §23.3).
// Threaded per slot rather than set globally because the live ranges are what
// decides it, and the byte cost is the thing being measured.
export const DEAD_DEFAULT = ["a", "b", "bc"];

function slotWork(cfg, slotIndex, xpPlan = null) {
  const work = [];
  // Which sample of a BUILT block this slot builds. The edge belongs to the
  // built stream, not to the slot index, so it moves with the lead.
  const b = (slotIndex + cfg.lead) % cfg.blockSamples;
  // Each voice's edge pieces sit at ITS block phase (cfg.voiceOffsets), START
  // before the mix and the others after it, so no two voices share an edge slot.
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

// ── The block mixer ────────────────────────────────────────────────────────
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
// there is no fill counter, no low-water mark and no regulator — the ring's
// occupancy is a consequence of the schedule rather than something measured
// and regulated. What the 16-sample lead buys is the block: a volume change
// lands on a block boundary and is whole (§3.4), and a note onset can be
// quantised to one (§3.7).
//
// ── THE MIX (plan-pcm-spec.md D1/D4) ──────────────────────────────────────
//
// One table read a voice: the rung page already carries the master (the 68000
// folds it in), so there is no master stage. Voice 0 reads through DE'.
// Voices 1 and 2 keep their pointer in the operand of a
// self-modified `ld hl,nn` — ADVANCED FIRST, so HL still holds the old pointer
// for the fetch, and no register the expander (IX, IYH) or the decode (main BC)
// owns is taken. Each extra voice is summed through the 512 B clamp: two biased
// terms make a 9-bit sum whose carry picks the page, so the add saturates in
// constant time, and a third voice cascades through the same table.
const nvS = (cfg, key, v) => {
  const off = typeof PCMN[key] === "function" ? PCMN[key](v) : PCMN[key];
  return `$${(pcm1Base(cfg) + off).toString(16)}`;
};
const mixRoutine = (cfg) => {
  const N = cfg.voices, ww = cfg.windowWait;
  const ops = [
    op("        exx", 4, { what: "to the mixer's register set" }),
    op("        ld   a,(de)", 7 + ww, { what: `voice 0's byte through the 68k window (7 + ${ww})` }),
    op("        ld   l,a", 4),
    op("mix_v0: ld   h,0", 7, { what: "voice 0's rung page (master folded in) — SELF-MODIFIED at its edge" }),
    op("        ld   a,(hl)", 7, { what: "signed in, biased out" }),
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
        op("        ld   l,a", 4),
        op(`mix_v${v}: ld   h,0`, 7, { what: `voice ${v}'s rung page` }),
        op("        ld   a,(hl)", 7),
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
  op(`ld   a,(${nvS(cfg, "level", v)})`, 13, { what: `voice ${v} edge: the rung its next block runs at` }),
  op(`ld   (mix_v${v}+1),a`, 13),
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

// THE CALL IS COSTED WITH THE ROUTINE INSIDE IT. A slot's pad is what the slot
// has left, and what it has left includes everything the call runs — 17 for the
// call plus the routine's own cycles, `ret` included. Costing the three bytes
// and not the body is how a schedule ends up ~180 cycles a sample optimistic
// and still looks like arithmetic.
const callMix = (cfg) => [
  op("call mix_one", 17 + cost(mixRoutine(cfg)), { what: "the mix, one sample (call + routine)" }),
];

// ── Balanced branches ─────────────────────────────────────────────────────
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
  const fifoLo = `$${(base + (cfg.loops ? PCMN_L.fifoLo : PCMN.fifoLo)).toString(16)}`;
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
    const used = 7 + 11 + (i === n - 1 ? 10 : 0) + cost(slotWork(cfg, i));
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

// ── The generator ──────────────────────────────────────────────────────────
/**
 * @param cfg
 * @param extraWork  optional (slotIndex) => ops, appended to that slot's work.
 *   It exists so an experiment can be placed in the REAL schedule — with the
 *   real mixer, the real edge pieces and the real pad arithmetic — instead of
 *   re-emitting a copy of the slot loop beside it. An experiment that does not
 *   fit is then a slot overrun at generation time, which is the point.
 * @param bootExtra  optional array of asm lines emitted at the END of boot,
 *   before the loop is entered. State an experiment keeps in RAM is
 *   initialised HERE and not left to whatever the core's RAM happens to hold
 *   (R7 §20.2 B) — a run whose first observation depended on a zeroed core was
 *   not testing initialisation at all.
 * @param slotDead  optional (slotIndex) => the registers this slot may destroy.
 *   Defaults to DEAD_DEFAULT everywhere. It is what the slot's pad is solved
 *   with, and a slot that carries a value across its pad says so here
 *   (R8 §23.3).
 */
export function generate(cfg, extraWork = null, bootExtra = null, slotDead = null) {
  const L = [];
  const slots = [];
  const P = (s = "") => L.push(s);
  const xp = nvExpanderPlan(cfg);

  P(`; ${stampLine(cfg)}`);
  P(";");
  P("; GENERATED by drv/engine/gen-stream.mjs — do not edit.");
  P(`; The light engine: ${cfg.voices} PCM voice${cfg.voices > 1 ? "s" : ""} software-mixed through the 68k`);
  P("; window into a 256 B ring the DAC is fed from, one sample an output slot,");
  P("; with the 68000's {op,val} pairs consumed at fixed slots of the lap.");
  P(";");
  P(`; Sample period ${cfg.periodNum}/${cfg.periodDen} = ${cfg.periodCycles} Z80 cycles`);
  P(`; Group        ${cfg.groupSlots} slots = ${cfg.groupCycles} cycles EXACTLY (no residue to accumulate)`);
  P(`; Slot lengths ${cfg.slotCycles.join(", ")}`);
  P("");
  P(`YM_ADDR0    equ ${hex(YM.addr0)}`);
  P(`YM_DATA0    equ ${hex(YM.data0)}`);
  P(`LUT         equ ${hex(cfg.ram.lut[0])}       ; ${cfg.levels} rung pages (lut.mjs)`);
  if (cfg.ram.clamp)
    P(`CLAMP       equ ${hex(cfg.ram.clamp[0])}       ; ${CLAMP_SIZE} B — the saturating add, as a table`);
  P(`RING        equ ${hex(cfg.ram.ring[0])}       ; 256 B — the finished samples`);
  P(`PCM_STATE   equ ${hex(pcm1Base(cfg))}       ; the voices' state, in the globals (config.mjs PCMN_L)`);
  P(`PCM_SILENCE equ ${hex(PCM1_SILENCE)}       ; where a parked voice reads`);
  P(`FIFO        equ ${hex(cfg.ram.fifo[0])}       ; 128 {op,val} pairs the 68000 writes`);
  P(`WINDOW      equ $8000              ; the 68k bank window the source lives in`);
  P(`LEAD        equ ${cfg.lead}                  ; the build cursor runs this far ahead`);
  // Every global's offset comes from config's GLOB table, which is the only
  // place a live byte of this region is named (R7 §20.2 B).
  const gh = (n) => `$${n.toString(16).padStart(2, "0")}`;
  P(`G_BASE      equ ${hex(cfg.ram.glob[0])}`);
  P(`G_CSMHI     equ G_BASE+${gh(GLOB.csmHi)}      ; u8  CSM ch3 frequency, block/hi`);
  P(`G_CSMLO     equ G_BASE+${gh(GLOB.csmLo)}      ; u8  CSM ch3 frequency, lo`);
  P(`STACK_TOP   equ ${hex(cfg.ram.stack[1])}`);
  P("");
  // The $27 shadow (§3.5): one byte that carries both timers' load and enable
  // bits. A test image's boot writes it; the shipped one leaves $24..$27 to the
  // sequencer.
  const r27 = YM.CTL_LOAD_A | YM.CTL_ENA_A | YM.CTL_LOAD_B | YM.CTL_ENA_B;
  P(`R27_BASE    equ ${hex(r27)}       ; Load A | Enable A | Load B | Enable B`);
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
  // The light image leaves $2B to the sequencer (docs/driver.md §5.3):
  // a score without PCM keeps fm6 as FM.
  if (!cfg.loops) bootWrite(YM.R_DACEN, 0x80, "DAC enable");
  // The shipped image sets no timer: it keeps none, and $24..$27 are the
  // sequencer's to write through the pair stream (R28 step 4).
  if (!cfg.production) {
    bootWrite(YM.R_TIMER_B, cfg.timerB, "Timer B period");
    bootWrite(YM.R_TIMER_A_HI, cfg.timerAna >> 2, "Timer A period, hi");
    bootWrite(YM.R_TIMER_A_LO, cfg.timerAna & 3, "Timer A period, lo");
    bootWrite(YM.R_TIMER_CTL, "R27_BASE", "the timers");
  }
  for (const o of boot) for (const l of o.asm) P(`        ${l}`);
  // The CH3 frequency for a CSM voice, parked in the globals. The output loop
  // issues no CSM writes of its own, so nothing in the image reads it back.
  P("");
  P("        ld   a,$22");
  P("        ld   (G_CSMHI),a");
  P("        ld   a,$69");
  P("        ld   (G_CSMLO),a");
  P("");
  {
    // THE BOOT: every voice parked on the silence page at rung 0 (silence),
    // END 0, and only the Z80's own bytes of the state block touched — the
    // staged fields are the 68000's, which may have written a start before it
    // released the bus (found on BlastEm, R28 §63.6 step 1).
    const ST = cfg.loops ? PCMN_L : PCMN;
    P("; Every voice silent and parked; only the Z80's own state bytes written.");
    P("        ld   a,LUT>>8               ; page 0 — silence");
    for (let v = 0; v < cfg.voices; v++) {
      P(`        ld   (PCM_STATE+${ST.level(v)}),a`);
      P(`        ld   (mix_v${v}+1),a`);
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
  }
  if (bootExtra && bootExtra.length) {
    P("; State this build keeps in RAM, initialised explicitly.");
    for (const l of bootExtra) P(l.endsWith(":") ? l : `        ${l}`);
    P("");
  }
  // The mixer's page number is a self-modified operand: a page outside the
  // family does not fault, it reads whatever is there as a rung table. The
  // page after the family is the phase table.
  const unity = (cfg.ram.lut[0] >> 8) + cfg.levels - 1;
  if (!pageIsALevel(cfg, unity))
    throw new Error(`the unity page $${unity.toString(16)} is not inside the rung family`);
  const { levels: pages } = lutPages(cfg);
  if (pages !== cfg.levels)
    throw new Error(`the rung family holds ${pages} pages and the profile says ${cfg.levels}`);
  P("; Boot is done: the host may take the bus from here on (it reads this byte).");
  P(`        ld   a,${hex(PCM1_READY_MARK)}`);
  P(`        ld   (PCM_STATE+${cfg.loops ? PCMN_L.ready : PCMN.ready}),a`);
  P("");
  P("; The DAC's address latch is written ONCE. Every slot writes data only,");
  P("; and any slot that disturbs the address port puts it back itself.");
  P(`        ld   a,${hex(YM.R_DAC)}`);
  P("        ld   (YM_ADDR0),a");
  P("        ld   hl,RING");
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
    // `slotDead` may return a register list or a {dead, stack} filler spec.
    const d0 = slotDead ? slotDead(i) : DEAD_DEFAULT;
    const padFill = Array.isArray(d0) ? { dead: d0 } : d0;
    const work = [...slotWork(cfg, i, xp.plan), ...(extraWork ? extraWork(i) : [])];
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
  P("; ── The mix, one sample ───────────────────────────────────────────────");
  P("; Constant time, no branch, no test. Called from every slot.");
  P("mix_one:");
  for (const o of mixRoutine(cfg)) for (const l of o.asm) P(l);
  P("");
  P(xp.routines.text);
  P("code_end:");
  P(`; total ${cfg.cycleSlots} slots = ${slots.reduce((t, s) => t + s.cycles, 0)} cycles`);
  P(`        assert code_end <= ${hex(cfg.ram.code[1])}, "the loop overran its code region"`);
  P("");
  if (cfg.ram.clamp) {
    P(`        ds   ${hex(cfg.ram.clamp[0])}-$, 0     ; up to the clamp table`);
    P(`; ${CLAMP_SIZE} B: the 9-bit sum of two biased contributions, saturated and re-biased.`);
    const clamp = buildClamp();
    for (let i = 0; i < clamp.length; i += 16)
      P(`        db   ${[...clamp.slice(i, i + 16)].join(",")}`);
  }
  P(`        ds   ${hex(cfg.ram.lut[0])}-$, 0     ; up to the rung tables`);
  P(`; ${cfg.levels} pages of 256 bytes: page 0 is silence and page ${cfg.levels - 1} is`);
  P(`; bit-exact unity; page ${cfg.levels - 1} - r is the 6 dB rung s >> r (lut.mjs).`);
  P("; A page takes a SIGNED source byte and gives a BIASED one.");
  const lut = buildRungs();
  for (let i = 0; i < lut.length; i += 16)
    P(`        db   ${[...lut.slice(i, i + 16)].join(",")}`);
  // The light image ends at the last rung page: the ring and everything
  // above it are the Z80's to initialise (docs/driver.md §5.2).
  if (!cfg.loops) P(`        ds   ${hex(cfg.ram.ring[0])}-$, 0     ; the ring, zeroed at boot anyway`);
  P("");

  return { text: L.join("\n"), slots, placement: placementTable(slots, cfg.periodCycles),
    expander: { sites: xp.sites, ...xp.routines, text: undefined } };
}

