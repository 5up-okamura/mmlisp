// P1-only experiment: a BUSREQ transfer the Z80's schedule EXPECTS. The Z80
// raises a notification (a write to 68k work RAM through the bank window, bank
// held at $FF0000), keeps a window of nops, lowers it, then looks at a local
// commit byte the 68000 wrote last before releasing the bus. If the commit is
// there, the slot's pad is generated `compensation` cycles short — the planned
// stop is repaid inside the slot it happened in. If not, the full pad runs.
//
// THE WINDOW IS NOPS, and what that buys is narrower than the earlier note
// here claimed. BUSREQ is sampled at the end of the MACHINE CYCLE in flight,
// not at the end of the instruction (Zilog Z80 CPU User Manual, "Bus Request/
// Acknowledge Cycle"), and a branch-taken `djnz` is 13 T split into machine
// cycles of 5/4/4 — so the worst wait for a boundary is one machine cycle
// either way, not the 13 T of the whole instruction. What a nop run actually
// gives is a UNIFORM boundary lattice: every 4 T, with no operand fetch or
// internal-work cycle of a different length to land in. The measurement is
// what stands on its own: under a `djnz` window the modelled stop was 53..65
// Z80 cycles depending on the host's phase and one phase of 32 missed the
// fixed compensation by 4.3 (+0.2387% mean rate); under a nop window it is
// 62.8..68.3 in every phase and a single compensation holds (-0.0004%..
// +0.0001% over 31 host phases). That is BlastEm's arbitration, which is a
// model of the M-cycle rule and not a substitute for measuring silicon: the
// hardware stop width and its mean residual are UNMEASURED.
//
// The bank stays at $FF0000 for one-way notifications.
// 68k must enter the low→high polling section with interrupts masked, payload
// prepared, and no DMA. Late entry waits for a new low→high edge. Z80 never
// waits for the host: a missing commit selects the full-length padding path.
import { generate } from "../engine/gen-stream.mjs";
import { padTo } from "../engine/schedule.mjs";

export const COOP = { notify: 0xff0000, queue: 0x1d00, commit: 0x1eff,
  windowCycles: 64, defaultCompensation: 32 };

// The instructions that bracket the window, by exact cost. `ld ($8000),a` is
// 13 T plus whatever the bank window charges; the probe logs the write itself,
// so the span between the two notifications is
//   (13 - lambda) + bankWait + windowCycles + 4 + lambda = 81 + bankWait
// where lambda is where inside `ld (nn),a` the emulator timestamps the write.
// The span does not depend on lambda, so a measured span YIELDS the bank cost;
// lambda stays unknown and bounded by 13, and that is the whole uncertainty in
// where the window sits relative to the notification. Nothing here pretends to
// resolve it — the analyzer carries it as a band.
export const NOTIFY_WRITE = 13, CLOSE_PROLOGUE = 4;

/** Where the window sits, given the span the log actually shows. */
export function windowBand(spanZ80, windowCycles = COOP.windowCycles) {
  const bankWait = spanZ80 - (windowCycles + NOTIFY_WRITE + CLOSE_PROLOGUE);
  return { bankWait, windowCycles,
    openMin: bankWait, openMax: bankWait + NOTIFY_WRITE,
    closeMin: bankWait + windowCycles, closeMax: bankWait + NOTIFY_WRITE + windowCycles };
}

