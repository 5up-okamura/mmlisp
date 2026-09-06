// P1-only experiment: a BUSREQ transfer the Z80's schedule EXPECTS. The Z80
// raises a notification (a write to 68k work RAM through the bank window, bank
// held at $FF0000), keeps a window of nops, lowers it, then looks at a local
// commit byte the 68000 wrote last before releasing the bus. If the commit is
// there, the slot's pad is generated `compensation` cycles short — the planned
// stop is repaid inside the slot it happened in. If not, the full pad runs.
//
// THE WINDOW MUST BE NOPS. BUSACK is granted at an M-cycle boundary, so where
// the request lands relative to the instruction in flight decides when the
// stop begins: on a run of nops that is within 4 cycles, on a `djnz` iteration
// up to 13. With a `djnz` window the measured stop was 53..65 cycles DEPENDING
// ON THE HOST'S PHASE — it averaged the compensation in seven phases and missed
// it by 4.3 in the eighth, which was the +0.2387% that stopped this work. With
// nops it is 62.8..68.3 in every phase and a single compensation holds
// (-0.0004%..+0.0001% over 31 host phases).
//
// The bank stays at $FF0000 for one-way notifications.
// 68k must enter the low→high polling section with interrupts masked, payload
// prepared, and no DMA. Late entry waits for a new low→high edge. Z80 never
// waits for the host: a missing commit selects the full-length padding path.
import { generate } from "./gen-stream.mjs";
import { padTo } from "./schedule.mjs";

export const COOP = { notify: 0xff0000, queue: 0x1d00, commit: 0x1eff,
  windowCycles: 64, defaultCompensation: 32 };

export function generateCooperative(cfg, { slots = 80, compensation = COOP.defaultCompensation,
  windowNops = true, windowSync = false } = {}) {
  if (cfg.voices || cfg.csm || cfg.observeTimerB) throw new Error("cooperative prototype is output-only P1");
  if (!Number.isInteger(slots) || slots < 5 || slots % cfg.groupSlots)
    throw new Error("cooperative schedule must close the fractional period");
  if (!Number.isInteger(compensation) || compensation < 0) throw new Error("invalid compensation");
  const base = generate(cfg);
  const lines = base.text.slice(0, base.text.indexOf("stream:")).split("\n");
  const emit = (s) => lines.push(`        ${s}`);
  const pad = (n, opts) => { for (const op of padTo(n, opts)) for (const asm of op.asm) emit(asm); };
  lines.push("stream:");
  for (let i=0; i<slots; i++) {
    lines.push(`coop_slot${i}:`);
    emit("ld (de),a"); // 7
    const tail = 11 + (i === slots-1 ? 10 : 0);
    const period = cfg.slotCycles[i % cfg.groupSlots];
    if (!i) {
      emit("ld a,1"); emit("ld ($8000),a"); // 7 + 13 + 3 bank wait
      // The window itself is nops when asked (the default): a grant on a
      // `djnz` iteration can land 13 cycles late, and that is the whole of
      // the phase-dependent stop length the fixed compensation cannot follow.
      // `windowSync`: four YM status reads inside the window (13 cycles each,
      // harmless, A is dead here). ONLY for the emulator: BlastEm grants a
      // pending BUSREQ at the Z80's next I/O access, so without these a
      // request that arrives mid-window is granted at the next DAC write, a
      // slot later. Hardware grants at the next M-cycle boundary regardless.
      if (windowSync) {
        if (COOP.windowCycles !== 64) throw new Error("windowSync assumes a 64-cycle window");
        for (let k = 0; k < 4; k++) emit("ld a,($4000)");                // 4 x 13 = 52
        for (let k = 0; k < 3; k++) emit("nop");                          // + 12 = 64
      } else pad(COOP.windowCycles, { nopsOnly: windowNops });
      emit("xor a"); emit("ld ($8000),a"); // 4 + 13 + 3 bank wait
      emit(`ld a,($${COOP.commit.toString(16)})`); emit("or a"); // 13 + 4
      emit("jr z,coop_absent"); // 7 served, 12 absent
      // The local commit is written last by the 68k, before releasing BUSREQ.
      // Both paths clear it; only the served path repays the planned stop.
      emit("xor a"); emit(`ld ($${COOP.commit.toString(16)}),a`); // 17
      const common = 7 + 23 + COOP.windowCycles + 20 + 17 + tail;
      pad(period - common - 7 - 17 - 10 - compensation);
      emit("jp coop_join");
      lines.push("coop_absent:");
      emit("xor a"); emit(`ld ($${COOP.commit.toString(16)}),a`);
      pad(period - common - 12 - 17);
      lines.push("coop_join:");
    } else pad(period - 7 - tail);
    emit("ld a,(hl)"); emit("inc l");
    if (i === slots-1) emit("jp stream");
  }
  lines.push("code_end:", `assert code_end <= $${cfg.ram.code[1].toString(16)}, "cooperative code overflow"`,
    `ds $${cfg.ram.wave[0].toString(16)}-$,0`);
  return { text: lines.join("\n"), cooperative: { slots, compensation, windowNops, windowSync, ...COOP } };
}
