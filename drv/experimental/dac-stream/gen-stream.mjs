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
//   * The phase reference is Timer B, read (and its flag reset) once per group.
//     The engine does not gate on it; the harness records the cycle of every
//     status read and the value it returned, which is what makes a phase error
//     measurable instead of assumed.
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
import { op, cost, laySlot, placementTable } from "./schedule.mjs";

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
function slotWork(cfg, slotIndex) {
  const work = [];
  const g = slotIndex % cfg.groupSlots;
  // Timer B: observed once a group, and its flag reset unconditionally. There
  // is no branch on it — a conditional would make the slot's length depend on
  // the chip, which is exactly the coupling §3.2 says not to build.
  if (cfg.observeTimerB && g === 0) {
    work.push(...readStatus());
    work.push(...ymWrite(YM.R_TIMER_CTL, "R27_RESET", "timer flag reset"));
  }
  // CSM: one note's two frequency writes a group. CSM keys CH3 off Timer A by
  // itself; what a driver actually spends cycles on is the register traffic
  // around it, so that is what is placed here.
  if (cfg.csm && g === 2) {
    work.push(...ymWrite(0xac, "(G_CSMHI)", "CSM ch3 op frequency hi"));
    work.push(...ymWrite(0xa8, "(G_CSMLO)", "CSM ch3 op frequency lo"));
  }
  // A burst of FM register writes in ONE slot — §6.3's "FM音色変更が集中する
  // 時刻". This is the case that decides whether a voice change has to be
  // split across slots or can ride one.
  if (cfg.fmBurst && g === 4) {
    for (let i = 0; i < cfg.fmBurst; i++)
      work.push(...ymWrite(0x30 + i, `${hex(0x71 + i)}`, `FM burst ${i}`));
  }
  if (work.some((o) => o.writes?.some((w) => w.kind === "addr"))) work.push(...relatchDac());
  return work;
}

// ── §4's 経路別サイクル表 ───────────────────────────────────────────────────
// Costed from the encodings, not measured and not fitted. Every path P1 can
// take is here; the paths it cannot take yet are listed with what they wait on,
// because a table that silently omits them reads as if they were free.
export function cyclePaths(cfg) {
  const c = (ops) => cost(ops);
  const rows = [
    ["DAC sample write", 7, "`ld (de),a` — DE holds $4001 for the life of the run"],
    ["next-sample fetch", 11, "`ld a,(hl)` + `inc l`; the page wraps for free"],
    ["one YM register write", c(ymWrite(0x30, 0x00)), "address + data, both through A"],
    ["one YM write, value from RAM", c(ymWrite(0x30, "(G_CSMHI)")), "`ld a,(nn)` is 13, not 7"],
    ["$2A re-latch", c(relatchDac()), "charged to the slot that disturbed the address port"],
    ["Timer B observation", c(readStatus()), "status read + stash; no branch on the result"],
    ["Timer B flag reset", c(ymWrite(YM.R_TIMER_CTL, "R27_RESET")), "through the $27 shadow"],
    ["slot with nothing else", 7 + 11, "the floor: 5.0% of a 358-cycle interval"],
    ["group (5 slots)", cfg.groupCycles, "EXACT — no residue survives a group"],
  ];
  const pending = [
    ["per-voice mix tick", "P2 — the block mixer"],
    ["volume / master", "P2 — LUT vs shift, measured then chosen"],
    ["loop wrap, ROM bank step", "P2 — boundary work, split into bounded pieces"],
    ["command dispatch", "P3 — sample-timed commands"],
    ["interrupt entry", "NOT TAKEN. This engine runs with interrupts disabled"],
    ["bus-grab recovery", "P3 — measured, not modelled: see the grab case"],
  ];
  return { rows, pending };
}

// ── The generator ──────────────────────────────────────────────────────────
export function generate(cfg) {
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
  P(`WAVE        equ ${hex(cfg.ram.wave[0])}       ; 256 B, page aligned`);
  P(`G_BASE      equ ${hex(cfg.ram.glob[0])}`);
  P("G_STATUS    equ G_BASE+$00      ; u8  last YM status byte read");
  P("G_CSMHI     equ G_BASE+$01      ; u8  CSM ch3 frequency, block/hi");
  P("G_CSMLO     equ G_BASE+$02      ; u8  CSM ch3 frequency, lo");
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
  P("; The DAC's address latch is written ONCE. Every slot writes data only,");
  P("; and any slot that disturbs the address port puts it back itself.");
  P(`        ld   a,${hex(YM.R_DAC)}`);
  P("        ld   (YM_ADDR0),a");
  P("        ld   hl,WAVE");
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
    const work = slotWork(cfg, i);
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
  P("code_end:");
  P(`; total ${cfg.cycleSlots} slots = ${slots.reduce((t, s) => t + s.cycles, 0)} cycles`);
  P(`        assert code_end <= ${hex(cfg.ram.code[1])}, "the loop overran its code region"`);
  P("");
  P(`        ds   ${hex(cfg.ram.wave[0])}-$, 0     ; the waveform page the harness fills`);
  P("");

  return { text: L.join("\n"), slots, placement: placementTable(slots, cfg.periodCycles) };
}
