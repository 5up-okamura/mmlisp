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
import { stampLine, YM } from "./config.mjs";
import { buildLut, buildClamp, CLAMP_SIZE, LEVELS, SILENCE } from "./lut.mjs";
import { op, cost, laySlot, placementTable, padTo } from "./schedule.mjs";

const hex = (n) => `$${n.toString(16)}`;

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
const reserveOps = (cycles, why) => {
  if (!cycles) return [];
  const ops = padTo(cycles, { dead: ["a", "b", "bc"] });
  ops[0] = { ...ops[0], what: `RESERVED ${cycles} — ${why}` };
  return ops;
};

function slotWork(cfg, slotIndex) {
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
  if (cfg.voices) {
    // The mix runs in EVERY slot — one sample built for every sample played.
    work.push(...callMix(cfg));
    // The block edge rides the LAST slot of a block, so what it writes takes
    // effect on the next one and no block is ever built at two volumes.
    if (b === cfg.blockSamples - 1) work.push(...blockEdge(cfg));
    if (cfg.reserve) {
      const [, cycles, why] = cfg.reserve[b];
      work.push(...reserveOps(Math.max(0, cycles - chargeable), why));
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
const mixRoutine = (cfg) => (cfg.voices >= 2 ? [
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
  op("ld a,(G_V0PAGE)", 13, { what: "the levels the next block runs at" }),
  op("ld (mix_v0+1),a", 13),
  ...(cfg.voices >= 2 ? [
    op("ld a,(G_V1PAGE)", 13),
    op("ld (mix_v1+1),a", 13),
  ] : []),
  op("ld a,(G_MPAGE)", 13),
  op("ld (mix_mp+1),a", 13, { what: "…so a change is whole-block, never half of one" }),
];

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
 */
export function generate(cfg, extraWork = null) {
  const L = [];
  const slots = [];
  const P = (s = "") => L.push(s);

  P(`; ${stampLine(cfg)}`);
  P(";");
  P("; GENERATED by drv/experimental/dac-stream/gen-stream.mjs — do not edit.");
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
    P(`LUT         equ ${hex(cfg.ram.lut[0])}       ; ${LEVELS} pages, one per level (lut.mjs)`);
    P(`CLAMP       equ ${hex(cfg.ram.clamp[0])}       ; ${CLAMP_SIZE} B — the saturating add, as a table`);
    P(`RING        equ ${hex(cfg.ram.ring[0])}       ; 256 B — the finished samples`);
    P(`WINDOW      equ $8000              ; the 68k bank window the source lives in`);
    P(`LEAD        equ ${cfg.lead}                  ; the build cursor runs this far ahead`);
  } else {
    P(`WAVE        equ ${hex(cfg.ram.wave[0])}       ; 256 B, page aligned`);
  }
  P(`G_BASE      equ ${hex(cfg.ram.glob[0])}`);
  P("G_STATUS    equ G_BASE+$00      ; u8  last YM status byte read");
  P("G_CSMHI     equ G_BASE+$01      ; u8  CSM ch3 frequency, block/hi");
  P("G_CSMLO     equ G_BASE+$02      ; u8  CSM ch3 frequency, lo");
  if (cfg.voices) {
    P("G_V0PAGE    equ G_BASE+$03      ; u8  LUT page for voice 0's level (the host writes it)");
    P("G_V1PAGE    equ G_BASE+$04      ; u8  …voice 1's");
    P("G_MPAGE     equ G_BASE+$05      ; u8  …and the master's");
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
  bootWrite(YM.R_DACEN, 0x80, "DAC enable");
  bootWrite(YM.R_TIMER_B, cfg.timerB, "Timer B period");
  bootWrite(YM.R_TIMER_A_HI, cfg.timerAna >> 2, "Timer A period, hi");
  bootWrite(YM.R_TIMER_A_LO, cfg.timerAna & 3, "Timer A period, lo");
  if (cfg.csm) {
    // A minimal but real CH3 voice, so CSM has something to key. Operator
    // offsets for channel 3 on port 0 are +2.
    for (const [reg, val] of [
      [0x32, 0x01], [0x36, 0x01], [0x3a, 0x02], [0x3e, 0x01],   // DT/MUL
      [0x42, 0x1b], [0x46, 0x28], [0x4a, 0x28], [0x4e, 0x00],   // TL
      [0x52, 0x1f], [0x56, 0x1f], [0x5a, 0x1f], [0x5e, 0x1f],   // KS/AR
      [0x62, 0x0a], [0x66, 0x0a], [0x6a, 0x0a], [0x6e, 0x0a],   // AM/D1R
      [0x72, 0x00], [0x76, 0x00], [0x7a, 0x00], [0x7e, 0x00],   // D2R
      [0x82, 0x1f], [0x86, 0x1f], [0x8a, 0x1f], [0x8e, 0x1f],   // D1L/RR
      [0xb2, 0x3a], [0xb6, 0xc0],                               // ALG/FB, pan
      [0xac, 0x22], [0xa8, 0x69], [0xad, 0x22], [0xa9, 0x69],   // CH3 op freqs
      [0xae, 0x22], [0xaa, 0x69], [0xa6, 0x22], [0xa2, 0x69],
    ]) bootWrite(reg, val, "CSM voice");
  }
  bootWrite(YM.R_TIMER_CTL, "R27_BASE", "timers + CH3 mode");
  for (const o of boot) for (const l of o.asm) P(`        ${l}`);
  P("");
  P("        ld   a,$22");
  P("        ld   (G_CSMHI),a");
  P("        ld   a,$69");
  P("        ld   (G_CSMLO),a");
  P("");
  if (cfg.voices) {
    P("; Levels start at unity. The host writes G_VPAGE / G_MPAGE whenever it");
    P("; likes; the block edge is what makes the change take effect, and it");
    P("; takes effect whole (§3.4).");
    P(`        ld   a,(LUT>>8)+${LEVELS - 1}`);
    P("        ld   (G_V0PAGE),a");
    if (cfg.voices >= 2) P("        ld   (G_V1PAGE),a");
    P("        ld   (G_MPAGE),a");
    P("        ld   (mix_v0+1),a");
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
    P("        ld   de,WINDOW");
    P("        ld   bc,RING+LEAD");
    P("        ld   hl,0");
    P("        exx");
    if (cfg.voices >= 2) P("        ld   ix,WINDOW+$100     ; voice 1's own page");
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
    const work = [...slotWork(cfg, i), ...(extraWork ? extraWork(i) : [])];
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
    const laid = laySlot({
      index: i, cycles, dacWrite, work, tail,
      dead: ["a", "b", "bc"],
    });
    slots.push(laid);
    P(`slot${i}:                         ; ${cycles} cyc — work ${laid.row.work}, pad ${laid.row.pad}`);
    for (const o of laid.ops) for (const l of o.asm) P(`        ${l}`);
  }
  P("");
  if (cfg.voices) {
    P("; ── The mix, one sample ───────────────────────────────────────────────");
    P("; Constant time, no branch, no test. Called from every slot.");
    P("mix_one:");
    for (const o of mixRoutine(cfg)) for (const l of o.asm) P(l);
    P("");
  }
  P("code_end:");
  P(`; total ${cfg.cycleSlots} slots = ${slots.reduce((t, s) => t + s.cycles, 0)} cycles`);
  P(`        assert code_end <= ${hex(cfg.ram.code[1])}, "the loop overran its code region"`);
  P("");
  if (cfg.voices) {
    P(`        ds   ${hex(cfg.ram.clamp[0])}-$, 0     ; up to the clamp table`);
    P(`; ${CLAMP_SIZE} B: the 9-bit sum of two biased contributions, saturated and re-biased.`);
    const clamp = buildClamp();
    for (let i = 0; i < clamp.length; i += 16)
      P(`        db   ${[...clamp.slice(i, i + 16)].join(",")}`);
    P(`        ds   ${hex(cfg.ram.lut[0])}-$, 0     ; up to the level tables`);
    P(`; ${LEVELS} pages of ${LEVELS === 16 ? "256" : "?"} bytes: level k maps a signed sample to round(s*k/15),`);
    P("; clamped. Level 15 is bit-exact unity and level 0 is silence (lut.mjs).");
    const lut = buildLut();
    for (let i = 0; i < lut.length; i += 16)
      P(`        db   ${[...lut.slice(i, i + 16)].join(",")}`);
    P(`        ds   ${hex(cfg.ram.ring[0])}-$, 0     ; the ring, zeroed at boot anyway`);
  } else {
    P(`        ds   ${hex(cfg.ram.wave[0])}-$, 0     ; the waveform page the harness fills`);
  }
  P("");

  return { text: L.join("\n"), slots, placement: placementTable(slots, cfg.periodCycles) };
}
