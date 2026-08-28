// P1 end-to-end gate — a real score all the way through the split interface.
//
//   .mmlisp → MMB → drv-player.js (the sequencer's port spec)
//           → slot stream (docs/driver.md §6.2, through the real cap/spill queue)
//           → the Z80 engine, one slot per vblank
//           → chip writes
//
// and asserts the chip writes are the sequencer's register writes: same values,
// same ports, same order, nothing added or dropped. That is the whole contract
// of the transport — the slot format, the write cap, and the spill queue are
// only allowed to DELAY a write, never to reorder or lose one.
//
// It also checks the delay is bounded and that the engine never runs ahead: a
// write may appear in its own frame or a later one, never earlier.
//
//   node tools/slot-gate.mjs [score.mmlisp] [--frames N] [--cap N]
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";
import { GATE_CY } from "./gen-mixer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const opt = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return Number(a.slice(name.length + 3));
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const SCORE = args[0] ?? join(here, "..", "..", "examples", "source", "ab-core.mmlisp");
const MAX_FRAMES = opt("frames", 400);
const CAP = opt("cap", undefined);

const RAM_SIZE = 0x2000;

// ── Sequencer side ─────────────────────────────────────────────────────────
const { bytes: mmb, sampleBank, diagnostics } = buildMmb(SCORE);
for (const d of diagnostics ?? []) {
  if (d.severity === "error") throw new Error(`${d.code}: ${d.message}`);
}
const drv = new DrvPlayer();
drv.loadMMB(mmb, sampleBank);
const builder = CAP ? new SlotBuilder({ maxWrites: CAP }) : new SlotBuilder();
// COUNT also records the REFERENCE's voice position per frame, so "the engine
// is one sample ahead" can be pinned to the frame it started in.
const refPos = [];
if (process.env.COUNT) {
  const base = builder.endFrame.bind(builder);
  builder.endFrame = () => {
    const v = drv._pcmVoices[0];
    refPos.push({ pos: v.pos, left: v.left, active: v.active });
    return base();
  };
}
const cap = drv.captureSlotLog({ maxFrames: MAX_FRAMES, builder });

// ── Engine side ────────────────────────────────────────────────────────────
const built = assemble(join(here, "..", "src", "engine.z80"));
const sym = (n) => built.symbols.get(n);
const RING = sym("RING");
const RING_DEPTH = sym("RING_DEPTH");
const SLOT_SIZE = sym("SLOT_SIZE");
const H_HEAD = sym("H_HEAD");
const H_TAIL = sym("H_TAIL");
// One frame of wall clock: 262 lines x 3420 master clocks / 15.
const FRAME_CYCLES = 59736;
const H_READY = sym("H_READY");

const ram = new Uint8Array(RAM_SIZE);
ram.set(built.bytes, 0);
const got = [];              // transport writes, as the chips see them
const dac = [];              // $2A feed — produced by the mixer, never sent
const dacEn = [];            // $2B — the engine's own, driver.md §14
const addr = [0, 0];
let booting = true;
let ringWrites = 0, bankBits = 0, lastDelta = null;
const WATCH = process.env.WATCH ? parseInt(process.env.WATCH, 16) : -1;
// The Timer B gate, in Z80 cycles: 2304 YM clocks, and the two run off one
// crystal at master/7 and master/15.

let cyc = 0, gateAt = GATE_CY;
let engFrame = 0;
let bankReg = 0;
const smp = sampleBank ?? new Uint8Array(0);
    // ENABLE B ($27 bit 3). Nuked-OPN2 (ym3438.c, OPN2_DoTimerB) is the
    // authority: `timer_b_overflow_flag |= timer_b_overflow & timer_b_enable`,
    // so the STATUS FLAG only appears while bit 3 is set. Load B (bit 1) runs
    // the counter; Enable B publishes its overflow. Modelling the flag without
    // bit 3 is what let an engine that hangs on the chip pass every gate here —
    // one frame of writes out, then gate_wait for ever.
let enableB = false;

const cpu = new Z80Cpu({
  read: (a) => {
    a &= 0xffff;
    if (a < RAM_SIZE) return ram[a];
    // Timer B's overflow flag is the engine's sample clock (§5.1.2): without it
    // gate_wait never returns. BUSY (bit 7) stays clear — an emulated write
    // completes instantly.
    if (a === 0x4000) return enableB && cyc >= gateAt ? 0x02 : 0;
    if (a >= 0x8000) {
      const i = bankReg * 0x8000 + (a - 0x8000);
      // PROBE=1 makes a read past the bank loud instead of silent: 0 is a
      // perfectly ordinary sample value, and "the engine read one byte past the
      // loop end" is invisible without this.
      if (i >= smp.length) return process.env.PROBE ? 0x55 : 0;
      return smp[i];
    }
    return 0xff;
  },
  write: (a, d) => {
    a &= 0xffff;
    if (a < RAM_SIZE) {
      if (WATCH >= 0 && a >= WATCH && a <= WATCH + 15)
        console.log(`  W f${engFrame} ${a.toString(16)} <- ${d} pc ${cpu.pc.toString(16)}`);
      ram[a] = d; return;
    }
    if (a === 0x6000) {
      bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff;
      if (process.env.COUNT) bankBits++;
      return;
    }
    if (a === 0x7f11) { got.push({ frame: engFrame, port: 2, addr: 0, data: d }); return; }
    if (a === 0x4000) { addr[0] = d; return; }
    if (a === 0x4002) { addr[1] = d; return; }
    if (a === 0x4001) {
      if (addr[0] === 0x2a) dac.push({ frame: engFrame, data: d });
      else if (addr[0] === 0x2b) dacEn.push({ frame: engFrame, data: d });
      // The sample clock is the ENGINE's, not the sequencer's (§5.1.2): $26 is
      // Timer B's period and $27 carries both sides — bits 6-7 the score's CH3
      // mode, 0-5 the timer's Load and flag reset. So $26 never belongs in this
      // comparison, and $27 only by its mode bits.
      else if (addr[0] === 0x26) return;
      // Bit 3 is tracked BEFORE the boot skip below — the write that enables the
      // timer IS a boot write, and dropping it here would model a chip that can
      // never gate.
      else if (addr[0] === 0x27 && ((enableB = (d & 0x08) !== 0), booting)) return;
      else if (booting) return;   // the engine's own boot: Timer B's Load
      else if (addr[0] === 0x27 && (d & 0x20)) {
        while (gateAt <= cyc) gateAt += GATE_CY;   // the timer free-runs
      } else if (addr[0] === 0x27) {
        // Bit 5 is the gate clearing Timer B's flag — the engine's own, and it
        // comes round thousands of times a frame. Everything else through this
        // register is the score's, kept by its mode bits.
        if (!(d & 0x20)) got.push({ frame: engFrame, port: 0, addr: 0x27, data: d & 0xc0 });
      } else got.push({ frame: engFrame, port: 0, addr: addr[0], data: d });
      return;
    }
    if (a === 0x4003) { got.push({ frame: engFrame, port: 1, addr: addr[1], data: d }); return; }
  },
});
cpu.pc = 0;
for (let i = 0; i < 2_000_000 && !(ram[H_READY] === 0xd2 && cpu.halted); i++) cyc += cpu.step();
if (ram[H_READY] !== 0xd2) throw new Error("engine never reported ready");
booting = false;

// The host: render into the ring the way a 68000 actually does — from a frame
// loop that woke on the SAME vblank the engine did, so its render lands INSIDE
// the engine's frame, not before it. That distinction is not academic: the
// engine holds the slot it is consuming for the whole frame now (§3.5), so a
// host that renders before the slot is released sees a full ring and produces
// nothing. Posting before the interrupt (which this gate used to do) hides that
// completely, and it reached hardware as half-speed music.
let posted = 0;
let starved = 0;
// When the host's render lands, measured in Z80 CYCLES from the interrupt. It
// used to be a fraction of frame 0's INSTRUCTION COUNT, which is only a proxy
// for wall-clock and stops being one the moment the engine's frame gets short:
// at SLOT_SUBS = 1 a frame with no PCM is 81 instructions, the threshold from
// frame 0 was 317, and the host simply never posted again — 120 starved frames
// that the hardware would not have had. The 68000 renders from its own vblank
// loop and does not care whether the Z80 is still running.
const POST_AT = Math.floor(59736 / 5);   // ~20% into the frame
const post = () => {
  while (posted < cap.slots.length) {
    const head = ram[H_HEAD];
    const next = (head + 1) % RING_DEPTH;
    if (next === ram[H_TAIL]) break;                 // ring full: we are ahead
    const s = cap.slots[posted++];
    ram.fill(0, RING + head * SLOT_SIZE, RING + head * SLOT_SIZE + SLOT_SIZE);
    ram.set(s, RING + head * SLOT_SIZE);
    ram[H_HEAD] = next;
  }
};
post();                                              // MMLisp_init primes it
for (engFrame = 0; engFrame < cap.slots.length || posted < cap.slots.length; engFrame++) {
  if (ram[H_HEAD] === ram[H_TAIL]) starved++;
  cpu.intRequest();
  let guard = 0;
  let fcyc = 0, postedInFrame = false;
  // A frame is FRAME_CYCLES of wall clock, not "until the CPU halts": the
  // engine feeds the DAC from its idle loop and only halts in a score with
  // no PCM in it (engine.z80 `idle`). A halted Z80 burns 4-cycle NOPs here,
  // which is exactly how it waits out the rest of a frame on hardware.
  while (guard++ < 3_000_000 && fcyc < FRAME_CYCLES) {
    const c = cpu.step();
    cpu.decay(c);
    cyc += c; fcyc += c;
    // ~20% in: a real host is a few hundred microseconds behind the vblank it
    // woke on. Posting BEFORE the interrupt would hide the fact that the engine
    // holds its slot for the whole frame (§3.5) — that is what this timing is
    // for, and it reached hardware once as half-speed music.
    if (!postedInFrame && fcyc >= POST_AT) { post(); postedInFrame = true; }
  }
  if (guard >= 3_000_000) throw new Error("frame did not complete");
  // The engine can HALT before the host's render lands. That is not the host
  // being early — the vblank has not come yet — so the post still belongs to
  // this frame.
  if (!postedInFrame) post();
  if (process.env.COUNT) {
    // Align by SLOTS CONSUMED, not by frame: the engine eats a slot up to
    // RING_DEPTH frames after the sequencer emitted it, so H_FRAMES is the only
    // honest index into the reference's state (§6.4 calls it the audible clock).
    const V = sym("G_PCMV"), PV = (o) => ram[V + o] | (ram[V + o + 1] << 8);
    const n = (ram[sym("H_FRAMES")] | (ram[sym("H_FRAMES") + 1] << 8)) - 1;
    const r = refPos[n];
    if (r) {
      const engFrac = PV(2), refFrac = r.pos & 0xffff;
      const engLeft = PV(12), same = engFrac === refFrac && engLeft === r.left;
      // The pointers live in different spaces — the engine's is a window
      // address, the reference's a 16.16 offset from the sample's base — so
      // what is comparable is the DIFFERENCE, which is constant while the two
      // agree. A step in it is a whole sample gained or lost.
      const delta = (PV(0) - 0x8000) - (r.pos >>> 16);
      if (!same || delta !== lastDelta) {
        console.log(`  slot ${n}: engine ptr-ref ${delta} frac ${engFrac.toString(16)}`
          + ` left ${engLeft} | ref frac ${refFrac.toString(16)} left ${r.left}`
          + (delta !== lastDelta && lastDelta !== null ? "   <- A SAMPLE MOVED" : ""));
        lastDelta = delta;
      }
    }
  }
  ringWrites = 0; bankBits = 0;
  if (engFrame > cap.slots.length + RING_DEPTH + 4) break;
}

// ── Compare ────────────────────────────────────────────────────────────────
// Per port, because bucketing a slot into runs is allowed to lose cross-port
// order within a frame and nothing depends on it (driver.md §4).
const key = (w) => (w.port === 2 ? "psg" : `fm${w.port}`);
const byPort = (list) => {
  const m = { psg: [], fm0: [], fm1: [] };
  for (const w of list) m[key(w)].push(w);
  return m;
};
const isDac = (w) => w.port === 0 && (w.addr === 0x2a || w.addr === 0x2b);
const want = byPort(cap.writes.filter((w) => !isDac(w)).map((w) =>
  w.port === 0 && w.addr === 0x27 ? { ...w, data: w.data & 0xc0 } : w));
const have = byPort(got);

const problems = [];
let maxDelay = 0;
for (const p of ["psg", "fm0", "fm1"]) {
  const a = want[p];
  const b = have[p];
  if (a.length !== b.length) {
    problems.push(`${p}: ${b.length} writes reached the chips, sequencer emitted ${a.length}`);
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].data !== b[i].data || (p !== "psg" && a[i].addr !== b[i].addr)) {
      problems.push(
        `${p}[${i}]: chips got ${b[i].addr.toString(16)}=${b[i].data}, ` +
          `sequencer emitted ${a[i].addr.toString(16)}=${a[i].data} (frame ${a[i].frame})`,
      );
      break;
    }
    const delay = b[i].frame - a[i].frame;
    if (delay < 0) {
      problems.push(`${p}[${i}]: reached the chips ${-delay} frames EARLY — the transport may only delay`);
      break;
    }
    maxDelay = Math.max(maxDelay, delay);
  }
}

// The mixer's own output. The sequencer never sends these — it produces the
// same stream independently — so agreeing here is the real check that
// drv-player's mixer and the Z80 engine implement the same thing.
// cap.pcmLog is what the REFERENCE MIXER produced, as distinct from the
// power-on patch's $2A/$2B — which are the sequencer's and never cross the bus.
const wantDac = cap.pcmLog.filter((w) => w.reg === 0x2a);

const wantEn = cap.pcmLog.filter((w) => w.reg === 0x2b);
if (wantDac.length !== dac.length) {
  problems.push(`DAC: engine fed ${dac.length} samples, reference ${wantDac.length}`);
  // …and WHERE. Per-frame counts diverging names the frame whose case the two
  // read differently (prime, tail, or the release), which is the only thing
  // that can move the count.
  const per = (l, k) => l.reduce((m, w) => m.set(w[k], (m.get(w[k]) ?? 0) + 1), new Map());
  const a = per(dac, "frame"), b = per(wantDac, "frame");
  for (const f of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) {
    if ((a.get(f) ?? 0) !== (b.get(f) ?? 0)) {
      problems.push(`  first at frame ${f}: engine ${a.get(f) ?? 0}, reference ${b.get(f) ?? 0}`);
      break;
    }
  }
}
for (let i = 0; i < Math.min(dac.length, wantDac.length); i++) {
  if (dac[i].data !== wantDac[i].data) {
    problems.push(
      `DAC[${i}] (frame ${dac[i].frame}): engine ${dac[i].data}, reference ${wantDac[i].data}`
        + `\n      engine ${dac.slice(i - 2, i + 8).map((w) => w.data).join(",")}`
        + `\n      refer. ${wantDac.slice(i - 2, i + 8).map((w) => w.data).join(",")}`,
    );
    break;
  }
}
if (wantEn.length !== dacEn.length) {
  problems.push(`$2B: engine wrote ${dacEn.length} DAC-enable edges, reference ${wantEn.length}`);
} else {
  for (let i = 0; i < dacEn.length; i++) {
    if (dacEn[i].data !== wantEn[i].data || dacEn[i].frame !== wantEn[i].frame) {
      problems.push(
        `$2B[${i}]: engine ${dacEn[i].data}@f${dacEn[i].frame}, ` +
          `reference ${wantEn[i].data}@f${wantEn[i].frame}`,
      );
      break;
    }
  }
}

const total = cap.writes.length;
console.log(`${basename(SCORE)} — ${cap.frames} frames, ${total} register writes`);
console.log(`  slots ${cap.slots.length} · cap ${builder._maxWrites} writes/slot · ring depth ${RING_DEPTH}`);
console.log(`  spill: ${cap.spillFrames} frames held work back, deepest queue ${cap.spillPeak} writes`);
console.log(`  delivery: max ${maxDelay} frame(s) late · engine idled ${starved} frame(s)`);
if (starved > 1) {
  // One at the very end (the host runs out of slots) is expected; a pattern is
  // the ring geometry being wrong, which is inaudible in any value comparison.
  problems.push(`engine starved on ${starved} frames — the ring never had a slot ready`);
}
if (wantDac.length) {
  console.log(`  PCM: ${dac.length} DAC samples, ${dacEn.length} $2B edges — engine vs reference`);
}
if (problems.length) {
  for (const p of problems.slice(0, 6)) console.error(`  ! ${p}`);
  console.error(`\nFAIL: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`  OK — every write reached the chips, in order, on the right port` +
  (wantDac.length ? ", and the mixers agree sample for sample" : ""));
