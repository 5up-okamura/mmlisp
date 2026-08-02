// P1 gate — the Z80 engine against its contract (docs/driver.md §12.3).
//
// The engine's job is narrow enough to gate directly: feed it a recorded slot
// stream and assert that
//
//   (a) the chip writes it emits are exactly the slot's bytes, in order, on the
//       right ports — nothing added, nothing dropped, nothing reordered; and
//   (b) the $2A DAC stream matches a JS model of the mixer and the PCM voice
//       state machine, sample for sample.
//
// (b) is the interesting half: the asm splits each voice's frame into segments
// bounded away from loop and sample boundaries, while the model just walks
// ticks. They must agree exactly, which is what pins the segment arithmetic —
// the conservative `avail >> KSH` bound, the LEFT countdown, the loop wrap and
// the ROM bank step.
//
//   node tools/engine-gate.mjs [--verbose]
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine.z80");
const RAM_SIZE = 0x2000;
const WINDOW = 0x8000;
const BANK_SIZE = 0x8000;
const VERBOSE = process.argv.includes("--verbose");

const built = assemble(SRC);
const sym = (n) => {
  const v = built.symbols.get(n);
  if (v === undefined) throw new Error(`missing symbol ${n}`);
  return v;
};
const R = sym("PCM_MIX_R");
const RING = sym("RING");
const RING_DEPTH = sym("RING_DEPTH");
const SLOT_SIZE = sym("SLOT_SIZE");
const H_HEAD = sym("H_HEAD");
const H_TAIL = sym("H_TAIL");
const H_FRAMES = sym("H_FRAMES");
const H_READY = sym("H_READY");

// ── Sample ROM ─────────────────────────────────────────────────────────────
// Distinct content per bank, so reading the wrong bank cannot pass by accident.
const BANKS = 6;
const rom = new Uint8Array(BANKS * BANK_SIZE);
{
  let x = 0x13579bd;
  for (let i = 0; i < rom.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    rom[i] = (x >>> 16) & 0xff;
  }
}
const romAt = (bank, addr) => rom[bank * BANK_SIZE + (addr - WINDOW)] ?? 0;
const toI8 = (b) => (b < 128 ? b : b - 256);

// ── Slot encoding (driver.md §6.2 / §6.3) ──────────────────────────────────
function encodeSlot({ psg = [], fm0 = [], fm1 = [], pcm = [] }) {
  const out = [psg.length, ...psg, fm0.length];
  for (const [r, v] of fm0) out.push(r, v);
  out.push(fm1.length);
  for (const [r, v] of fm1) out.push(r, v);
  out.push(pcm.length);
  for (const c of pcm) out.push(...c);
  if (out.length > SLOT_SIZE) throw new Error(`slot ${out.length} B > ${SLOT_SIZE}`);
  return out;
}
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

// 2^ksh >= the largest advance one tick can make (incI + 1), so the engine can
// bound a segment with a shift instead of a divide.
const kshFor = (incI) => Math.ceil(Math.log2(incI + 1));

function pcmStart(v, { flags, shift, bank, ptr, left, loopl, tail, incF, incI }) {
  return [1, v, flags, shift, kshFor(incI), ...u16(bank), ...u16(ptr),
    ...u16(left), ...u16(loopl), ...u16(tail), ...u16(incF), incI];
}
const pcmStop = (v) => [2, v];
const pcmVol = (v, shift) => [3, v, shift];
const pcmLoop = (v, loopl, left) => [4, v, ...u16(loopl), ...u16(left)];

// ── Model of the engine's PCM state machine + mixer ────────────────────────
class ModelVoice {
  constructor() { this.active = false; }
  start(p) {
    Object.assign(this, {
      active: (p.flags & 1) !== 0, hasLoop: (p.flags & 2) !== 0,
      shift: p.shift, bank: p.bank, ptr: p.ptr, frac: 0,
      left: p.left, loopl: p.loopl, tail: p.tail, incF: p.incF, incI: p.incI,
    });
  }
  stop() {
    if (!this.active || !this.hasLoop) return;
    this.hasLoop = false;
    this.left = (this.left + this.tail) & 0xffff;
  }
  // One tick: fetch at the current position, then advance and settle the
  // boundary. The fetch precedes the advance, which is why one more tick is
  // always legal while a single byte remains.
  tick() {
    const s = toI8(romAt(this.bank, this.ptr)) >> this.shift;
    const before = this.ptr;
    this.frac += this.incF;
    const carry = this.frac > 0xffff ? 1 : 0;
    this.frac &= 0xffff;
    this.ptr = (this.ptr + this.incI + carry) & 0xffff;
    let consumed = (this.ptr - before) & 0xffff;
    this.left = this.left - consumed;
    if (this.ptr < WINDOW) { this.ptr += WINDOW; this.bank++; }   // window top
    if (this.left <= 0) {
      if (this.hasLoop) {
        this.ptr -= this.loopl;
        if (this.ptr < WINDOW) { this.ptr += WINDOW; this.bank--; }
        this.left = this.loopl;
      } else {
        this.active = false;
      }
    }
    return s;
  }
}

function modelFrame(voices) {
  if (!voices.some((v) => v.active)) return null; // DAC released, no writes
  const plane = new Int8Array(R);
  let storing = true;
  for (const v of voices) {
    if (!v.active) continue;
    let t = 0;
    for (; t < R && v.active; t++) {
      const s = v.tick();
      if (storing) plane[t] = s;
      else plane[t] = Math.max(-128, Math.min(127, plane[t] + s));
    }
    if (storing) {
      for (; t < R; t++) plane[t] = 0;   // the storing voice ended early
      storing = false;
    }
  }
  if (storing) plane.fill(0);            // every active voice ended at tick 0
  return Array.from(plane, (s) => (s ^ 0x80) & 0xff);
}

// ── Run the engine ─────────────────────────────────────────────────────────
// `frames` is the host schedule: one entry per frame, either a slot spec or
// null to skip filling (which starves the ring — a legal, non-fatal state).
function run(frames) {
  const ram = new Uint8Array(RAM_SIZE);
  ram.set(built.bytes, 0);

  let bankReg = 0;
  let bankShift = 0;
  const writes = [];   // {port, reg, val} for everything except the DAC feed
  const dac = [];      // $2A data bytes
  const addr = [0, 0];

  const cpu = new Z80Cpu({
    read: (a) => {
      a &= 0xffff;
      if (a < RAM_SIZE) return ram[a];
      if (a === 0x4000) return 0;                       // status: never BUSY
      if (a >= WINDOW) return romAt(bankReg, a);
      return 0xff;
    },
    write: (a, d) => {
      a &= 0xffff;
      if (a < RAM_SIZE) { ram[a] = d; return; }
      if (a === 0x6000) {                                // 9-bit shift register
        bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff;
        bankShift++;
        return;
      }
      if (a === 0x7f11) { writes.push({ port: "psg", val: d }); return; }
      if (a === 0x4000) { addr[0] = d; return; }
      if (a === 0x4002) { addr[1] = d; return; }
      if (a === 0x4001) {
        if (addr[0] === 0x2a) dac.push(d);
        else writes.push({ port: 0, reg: addr[0], val: d });
        return;
      }
      if (a === 0x4003) { writes.push({ port: 1, reg: addr[1], val: d }); return; }
    },
  });

  // Boot, and settle into the idle `halt`. Stopping at "ready" alone would
  // leave the CPU one instruction short of the halt, and the first interrupt
  // would then be serviced inside the *next* frame's window.
  cpu.pc = 0;
  let boot = 0;
  while (boot++ < 2_000_000 && !(ram[H_READY] === 0xd2 && cpu.halted)) cpu.step();
  if (ram[H_READY] !== 0xd2) throw new Error("engine never reported ready");

  const perFrame = [];
  for (const spec of frames) {
    if (spec) {
      const head = ram[H_HEAD];
      const next = (head + 1) % RING_DEPTH;
      if (next !== ram[H_TAIL]) {                        // room in the ring
        const bytes = encodeSlot(spec);
        ram.set(bytes, RING + head * SLOT_SIZE);
        ram[H_HEAD] = next;
      } else if (VERBOSE) console.log("  (ring full, slot dropped)");
    }
    const w0 = writes.length;
    const d0 = dac.length;
    cpu.intRequest();
    let guard = 0;
    while (cpu.halted && guard++ < 1000) cpu.step();        // accept the interrupt
    while (!cpu.halted && guard++ < 3_000_000) cpu.step();  // run the ISR out
    if (guard >= 3_000_000) throw new Error("frame did not complete");
    perFrame.push({ writes: writes.slice(w0), dac: dac.slice(d0) });
  }
  return { perFrame, frames: ram[H_FRAMES] | (ram[H_FRAMES + 1] << 8), ram };
}

// ── Scenarios ──────────────────────────────────────────────────────────────
const scenarios = [];

scenarios.push({
  name: "register writes only",
  why: "the consume loop reproduces the slot byte for byte, on both YM ports and the PSG",
  frames: [
    { psg: [0x9f, 0xbf], fm0: [[0x30, 0x71], [0xa4, 0x22], [0xa0, 0x69], [0x28, 0xf0]], fm1: [[0x30, 0x12]] },
    { fm0: [[0x28, 0x00]] },
    { psg: [0x80, 0x0a, 0x90], fm1: [[0xb4, 0xc0], [0xa6, 0x1a], [0xa2, 0x11]] },
    {},
  ],
});

scenarios.push({
  name: "ring starvation",
  why: "an empty ring holds the chips and keeps mixing — it is a game overrun, not an error",
  frames: [
    { fm0: [[0x30, 0x01]] },
    null,
    null,
    { fm0: [[0x30, 0x02]] },
  ],
});

// A shot that runs past the end mid-frame: exercises the LEFT countdown, the
// early-end silence fill, and the DAC release.
scenarios.push({
  name: "PCM shot ending mid-frame",
  why: "the storing voice ends part-way through, so the rest of the plane must be silenced",
  frames: [
    { pcm: [pcmStart(0, { flags: 1, shift: 0, bank: 2, ptr: WINDOW + 0x100, left: 400, loopl: 0, tail: 0, incF: 0x8000, incI: 1 })] },
    {}, {}, {}, {},
  ],
});

// A loop shorter than one frame's span, so it wraps several times per frame.
scenarios.push({
  name: "PCM loop wrapping several times per frame",
  why: "pins the wrap arithmetic against a per-tick model when a segment ends on the boundary",
  frames: [
    { pcm: [pcmStart(0, { flags: 3, shift: 0, bank: 3, ptr: WINDOW + 0x200, left: 100, loopl: 100, tail: 250, incF: 0, incI: 2 })] },
    {}, {},
    { pcm: [pcmStop(0)] },     // release: boundary moves to the sample end
    {}, {}, {},
  ],
});

scenarios.push({
  name: "three voices, different rates and volumes",
  why: "saturating-add order, per-voice shift, and the storing/accumulating split",
  frames: [
    {
      pcm: [
        pcmStart(0, { flags: 1, shift: 0, bank: 1, ptr: WINDOW + 0x40, left: 20000, loopl: 0, tail: 0, incF: 0x4000, incI: 1 }),
        pcmStart(1, { flags: 1, shift: 1, bank: 2, ptr: WINDOW + 0x800, left: 20000, loopl: 0, tail: 0, incF: 0xc000, incI: 2 }),
        pcmStart(2, { flags: 1, shift: 2, bank: 4, ptr: WINDOW + 0x1200, left: 20000, loopl: 0, tail: 0, incF: 0x1000, incI: 0 }),
      ],
    },
    {}, {},
    { pcm: [pcmVol(1, 3)] },
    {}, {},
  ],
});

scenarios.push({
  name: "sample crossing the ROM bank boundary",
  why: "a voice-outer pass latches its own bank; the window top must step it, not wrap the pointer",
  frames: [
    { pcm: [pcmStart(0, { flags: 1, shift: 0, bank: 2, ptr: 0xff00, left: 3000, loopl: 0, tail: 0, incF: 0x8000, incI: 1 })] },
    {}, {}, {}, {},
  ],
});

scenarios.push({
  name: "PCM_LOOP retargets a running voice",
  why: "loop bounds are read once per segment, so changing them between frames is free",
  frames: [
    { pcm: [pcmStart(0, { flags: 3, shift: 0, bank: 5, ptr: WINDOW + 0x80, left: 600, loopl: 600, tail: 100, incF: 0, incI: 1 })] },
    {},
    { pcm: [pcmLoop(0, 150, 150)] },
    {}, {},
  ],
});

// ── Check ──────────────────────────────────────────────────────────────────
let failures = 0;
for (const sc of scenarios) {
  const voices = [new ModelVoice(), new ModelVoice(), new ModelVoice()];
  const { perFrame } = run(sc.frames);
  const problems = [];

  sc.frames.forEach((spec, f) => {
    const got = perFrame[f];

    // (a) chip writes == the slot, exactly
    const want = [];
    if (spec) {
      for (const v of spec.psg ?? []) want.push({ port: "psg", val: v });
      for (const [r, v] of spec.fm0 ?? []) want.push({ port: 0, reg: r, val: v });
      for (const [r, v] of spec.fm1 ?? []) want.push({ port: 1, reg: r, val: v });
    }
    // $2B (DAC enable) is the engine's own — it is claimed on the first active
    // voice and released when the last one ends (driver.md §14).
    const chip = got.writes.filter((w) => !(w.port === 0 && w.reg === 0x2b));
    if (JSON.stringify(chip) !== JSON.stringify(want)) {
      problems.push(`f${f}: chip writes ${JSON.stringify(chip)} != slot ${JSON.stringify(want)}`);
    }

    // (b) DAC stream == the model
    for (const c of spec?.pcm ?? []) {
      const [op, v] = c;
      if (op === 1) {
        voices[v].start({
          flags: c[2], shift: c[3], bank: c[5] | (c[6] << 8), ptr: c[7] | (c[8] << 8),
          left: c[9] | (c[10] << 8), loopl: c[11] | (c[12] << 8), tail: c[13] | (c[14] << 8),
          incF: c[15] | (c[16] << 8), incI: c[17],
        });
      } else if (op === 2) voices[v].stop();
      else if (op === 3) voices[v].shift = c[2];
      else if (op === 4) {
        voices[v].loopl = c[2] | (c[3] << 8);
        voices[v].left = c[4] | (c[5] << 8);
      }
    }
    const wantDac = modelFrame(voices);
    if (wantDac === null) {
      if (got.dac.length) problems.push(`f${f}: ${got.dac.length} DAC writes with no voice active`);
    } else if (got.dac.length !== R) {
      problems.push(`f${f}: ${got.dac.length} DAC writes, expected ${R}`);
    } else {
      for (let i = 0; i < R; i++) {
        if (got.dac[i] !== wantDac[i]) {
          problems.push(`f${f}: DAC[${i}] = ${got.dac[i]}, model says ${wantDac[i]}`);
          break;
        }
      }
    }
  });

  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${sc.name}`);
  console.log(`      ${sc.why}`);
  for (const p of problems.slice(0, 4)) console.log(`      ! ${p}`);
  if (problems.length > 4) console.log(`      ! …and ${problems.length - 4} more`);
}

console.log(`\nengine image ${built.bytes.length} B · R = ${R} · ring depth ${RING_DEPTH}`);
if (failures) {
  console.error(`FAIL: ${failures} of ${scenarios.length} scenarios`);
  process.exit(1);
}
console.log(`${scenarios.length} scenarios pass`);
