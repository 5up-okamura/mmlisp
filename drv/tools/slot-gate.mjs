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
const cap = drv.captureSlotLog({ maxFrames: MAX_FRAMES, builder });

// ── Engine side ────────────────────────────────────────────────────────────
const built = assemble(join(here, "..", "src", "engine.z80"));
const sym = (n) => built.symbols.get(n);
const RING = sym("RING");
const RING_DEPTH = sym("RING_DEPTH");
const SLOT_SIZE = sym("SLOT_SIZE");
const H_HEAD = sym("H_HEAD");
const H_TAIL = sym("H_TAIL");
const H_READY = sym("H_READY");

const ram = new Uint8Array(RAM_SIZE);
ram.set(built.bytes, 0);
const got = [];              // transport writes, as the chips see them
const dac = [];              // $2A feed — produced by the mixer, never sent
const dacEn = [];            // $2B — the engine's own, driver.md §14
const addr = [0, 0];
let engFrame = 0;
let bankReg = 0;
const smp = sampleBank ?? new Uint8Array(0);

const cpu = new Z80Cpu({
  read: (a) => {
    a &= 0xffff;
    if (a < RAM_SIZE) return ram[a];
    if (a === 0x4000) return 0;
    if (a >= 0x8000) return smp[bankReg * 0x8000 + (a - 0x8000)] ?? 0;
    return 0xff;
  },
  write: (a, d) => {
    a &= 0xffff;
    if (a < RAM_SIZE) { ram[a] = d; return; }
    if (a === 0x6000) { bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
    if (a === 0x7f11) { got.push({ frame: engFrame, port: 2, addr: 0, data: d }); return; }
    if (a === 0x4000) { addr[0] = d; return; }
    if (a === 0x4002) { addr[1] = d; return; }
    if (a === 0x4001) {
      if (addr[0] === 0x2a) dac.push({ frame: engFrame, data: d });
      else if (addr[0] === 0x2b) dacEn.push({ frame: engFrame, data: d });
      else got.push({ frame: engFrame, port: 0, addr: addr[0], data: d });
      return;
    }
    if (a === 0x4003) { got.push({ frame: engFrame, port: 1, addr: addr[1], data: d }); return; }
  },
});
cpu.pc = 0;
for (let i = 0; i < 2_000_000 && !(ram[H_READY] === 0xd2 && cpu.halted); i++) cpu.step();
if (ram[H_READY] !== 0xd2) throw new Error("engine never reported ready");

// The host: fill the ring ahead of each vblank, exactly as MMLisp_render would.
let posted = 0;
let starved = 0;
for (engFrame = 0; engFrame < cap.slots.length || posted < cap.slots.length; engFrame++) {
  while (posted < cap.slots.length) {
    const head = ram[H_HEAD];
    const next = (head + 1) % RING_DEPTH;
    if (next === ram[H_TAIL]) break;                 // ring full: we are ahead
    const s = cap.slots[posted++];
    ram.fill(0, RING + head * SLOT_SIZE, RING + head * SLOT_SIZE + SLOT_SIZE);
    ram.set(s, RING + head * SLOT_SIZE);
    ram[H_HEAD] = next;
  }
  if (ram[H_HEAD] === ram[H_TAIL]) starved++;
  cpu.intRequest();
  let guard = 0;
  while (cpu.halted && guard++ < 1000) cpu.step();
  while (!cpu.halted && guard++ < 3_000_000) cpu.step();
  if (guard >= 3_000_000) throw new Error("frame did not complete");
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
const want = byPort(cap.writes.filter((w) => !isDac(w)));
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
}
for (let i = 0; i < Math.min(dac.length, wantDac.length); i++) {
  if (dac[i].data !== wantDac[i].data) {
    problems.push(
      `DAC[${i}] (frame ${dac[i].frame}): engine ${dac[i].data}, reference ${wantDac[i].data}`,
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
