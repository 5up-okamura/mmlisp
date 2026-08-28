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
import { GATE_CY } from "./gen-mixer.mjs";
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
const WATCH = process.env.WATCH ? parseInt(process.env.WATCH, 16) : -1;
const R = sym("PCM_MIX_R");
const RING_TARGET = sym("PCM_RING_TARGET");
const RING_BYTES = sym("RING_TOP") - sym("RING_BUF");
const RING = sym("RING");
const RING_DEPTH = sym("RING_DEPTH");
const SLOT_SIZE = sym("SLOT_SIZE");
const SLOT_SUBS = sym("SLOT_SUBS"); // taken from the engine, so it cannot drift
// Likewise the voice/pass count: the slot's plan block is one run-list per
// voice, so a hardcoded 3 here silently misaligns every byte after it the
// moment the mixer's pass count moves.
const PCM_VOICES = sym("PCM_VOICES");
// A scenario that needs a SECOND voice cannot run at PCM_VOICES = 1, and one
// that merely happens to have been written on voice 1 can — it is the shape
// being pinned, not the index. V2 is the second voice where there is one and
// the first where there is not; scenarios that need two DISTINCT voices carry
// `needs: 2` and are SKIPPED OUT LOUD rather than quietly re-indexed onto one.
const V2 = Math.min(1, PCM_VOICES - 1);
const H_HEAD = sym("H_HEAD");
const H_VBL = sym("H_VBL");
const H_TAIL = sym("H_TAIL");
const H_FRAMES = sym("H_FRAMES");
const H_STARVE = sym("H_STARVE");
// One frame of wall clock: 262 lines x 3420 master clocks / 15.
const FRAME_CYCLES = 59736;
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
// A slot is SLOT_SUBS blocks of three runs, then the frame's PCM commands. A
// spec may give `subs` explicitly to place writes in a particular sub-slot;
// otherwise everything rides sub-slot 0 and the rest go out empty.
function encodeSlot({ psg = [], fm0 = [], fm1 = [], pcm = [], subs = null }, plan = null,
                    chunk = R) {
  const blocks = subs ?? [{ psg, fm0, fm1 }];
  const nWrites = blocks.reduce(
    (t, b) => t + (b.psg ?? []).length + (b.fm0 ?? []).length + (b.fm1 ?? []).length, 0);
  const out = [nWrites, chunk, pcm.length];
  for (const c of pcm) out.push(...c);
  // The frame's segment plan (§6.3.1) — one count-prefixed run per voice, from
  // the same model the DAC stream is checked against, so the gate exercises the
  // plan path rather than the engine's fallback.
  out.push(...(plan ?? new Array(PCM_VOICES).fill(0)));
  for (let j = 0; j < SLOT_SUBS; j++) {
    const b = blocks[j] ?? {};
    const p = b.psg ?? [], f0 = b.fm0 ?? [], f1 = b.fm1 ?? [];
    out.push(p.length, ...p, f0.length);
    for (const [r, v] of f0) out.push(r, v);
    out.push(f1.length);
    for (const [r, v] of f1) out.push(r, v);
  }
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
    this.broke = false;   // set when a LOGICAL break falls on this tick
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
      this.broke = true;   // a loop wrap or the end — what the plan records
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

// One frame of MIXING. Every voice runs a full pass whether or not it is
// sounding — pass 0 stores (so an absent or finished voice writes silence),
// later passes add with a clamp. That uniformity is what the paced feed needs
// (driver.md §5.1) and it subsumes the old early-end fill.
function mixFrame(voices) {
  return mixFramePlan(voices).plane;
}

// The same pass, also reporting where each voice BROKE — which is the slot's
// segment plan (§6.3.1). One model produces both, so a plan the engine follows
// and the samples it is checked against cannot disagree.
function mixFramePlan(voices, ticks = R) {
  const plane = new Int8Array(ticks);
  const plan = [];
  voices.forEach((v, i) => {
    const segs = [];
    let last = 0;
    for (let t = 0; t < ticks; t++) {
      const s = v.active ? v.tick() : 0;
      if (v.broke) { segs.push(t + 1 - last); last = t + 1; }
      if (i === 0) plane[t] = s;
      else plane[t] = Math.max(-128, Math.min(127, plane[t] + s));
    }
    if (v.active) segs.push(ticks);   // no further break in this chunk
    plan.push(segs.length, ...segs);
  });
  return { plane, plan };
}

// The PCM command list, applied to a set of model voices. Shared by the plan
// pre-pass and the check, so both read a slot the same way.
function applyPcm(voices, spec) {
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
}

// What the engine FEEDS in a frame (driver.md §5.1.2). The ring is modelled the
// same way the engine holds it — a sample is final only after the last voice
// pass, so what a frame can be feeding is what an earlier frame finished:
//
//   PRIME   an empty ring: mix TARGET, feed nothing but one silence byte that
//           parks the DAC where claiming fm6 cannot step it;
//   STEADY  mix exactly what is fed, so the fill does not move;
//   TAIL    nothing sounding: feed what is left and mix nothing.
class ModelFeed {
  constructor() {
    this.ring = new Int8Array(RING_BYTES);
    this.rd = 0;
    this.fill = 0;
    this.dacOn = false;
  }
  frame(voices, chunk = R) {
    const active = voices.some((v) => v.active);
    // fm6 is claimed for the rest of the score: once the DAC is on the ring is
    // kept topped up with silence and never released, so a later hit is a
    // STEADY frame and not a PRIME one (§5.1.2). A prime frame feeds nothing
    // while it builds the lead — 135 to 355 sample periods of silence — which
    // on percussion is a click per hit. Only a score that has never sounded
    // PCM stays off.
    if (!active && !this.dacOn) return null;
    this.dacOn = true;
    if (this.fill === 0) {                       // prime
      this.mix(voices, RING_TARGET);
      return [0x80];
    }
    // Read only what the ring HAS: past the fill a burst is over and the answer
    // is silence, which is also what the engine reads there because a tail
    // frame mixes silence into the ring ahead of the tail (§5.1.2).
    const out = [];
    for (let i = 0; i < chunk; i++) {
      let s = 0;
      if (this.fill > 0) {
        s = this.ring[this.rd];
        this.rd = (this.rd + 1) % RING_BYTES;
        this.fill--;
      }
      out.push((s ^ 0x80) & 0xff);
    }
    // Mixed whether or not anything SOUNDS: a silent pass stores silence, which
    // is what holds `fill` constant instead of letting the ring drain.
    this.mix(voices, chunk);
    return out;
  }
  mix(voices, ticks) {
    const { plane } = mixFramePlan(voices, ticks);
    let w = (this.rd + this.fill) % RING_BYTES;
    for (const v of plane) { this.ring[w] = v; w = (w + 1) % RING_BYTES; }
    this.fill += ticks;
  }
}

// ── Run the engine ─────────────────────────────────────────────────────────
// `frames` is the host schedule: one entry per frame, either a slot spec or
// null to skip filling (which starves the ring — a legal, non-fatal state).
function run(frames, image = built) {
  const ram = new Uint8Array(RAM_SIZE);
  ram.set(image.bytes, 0);

  let bankReg = 0;
  let bankShift = 0;
  // The Timer B model: the gate the engine's feed waits on (§5.1.2). `cyc` is
  // advanced by the run loop below, so the flag rises on time and the engine's
  // pacing is exercised rather than short-circuited.
  // GATE_CY comes from the generator that also writes the engine's $26 byte, so
  // this harness cannot model a timer the engine does not run.
  let cyc = 0, gateAt = GATE_CY;
  // ENABLE B ($27 bit 3). Nuked-OPN2 is the authority and it is one line
  // (ym3438.c, OPN2_DoTimerB):
  //
  //     timer_b_overflow_flag |= timer_b_overflow & timer_b_enable;
  //
  // so the STATUS FLAG only ever appears while bit 3 is set — Load B (bit 1)
  // runs the counter, Enable B publishes its overflow. This model used to
  // ignore bit 3 and raise the flag on time regardless, which is why every gate
  // in this repo passed against an engine that hung on the first emit of the
  // first frame on real hardware: one note out, then `gate_wait` forever.
  // Modelled from the chip now, and a poll with it clear is a hard error rather
  // than a spin, because a spin only shows up as "no frames ran".
  let enableB = false;
  let polledDisabled = 0;
  const writes = [];   // {port, reg, val} for everything except the DAC feed
  const dac = [];      // $2A data bytes
  const addr = [0, 0];

  const cpu = new Z80Cpu({
    read: (a) => {
      a &= 0xffff;
      if (a < RAM_SIZE) return ram[a];
      // Status. BUSY is never set (an emulated write completes instantly), but
      // TIMER B's overflow flag is the engine's sample clock (§5.1.2) and has to
      // be modelled or `gate_wait` never returns: bit 1 goes up GATE_CY cycles
      // after the last reset and stays up until the engine writes $27 bit 5.
      if (a === 0x4000) {
        if (!enableB) { polledDisabled++; return 0; }
        return cyc >= gateAt ? 0x02 : 0;
      }
      if (a >= WINDOW) return romAt(bankReg, a);
      return 0xff;
    },
    write: (a, d) => {
      a &= 0xffff;
      if (a < RAM_SIZE) {
        // WATCH=<hex addr> names the code that wrote a RAM byte. The ring's
        // two cursors are the one thing here whose bugs are invisible in the
        // DAC stream until several frames later, and "who wrote this byte" is
        // the question that localises them in one run.
        if (WATCH >= 0 && a === WATCH && ram[a] !== d)
          console.log(`  W f${perFrame.length} ${a.toString(16)} <- ${d}`
            + ` at pc ${cpu.pc.toString(16)} idx ${ram[sym("G_IDX")]}`
            + ` mixp ${ram[sym("G_MIXP")].toString(16)} emits ${ram[sym("G_EMITS")]}`);
        ram[a] = d; return;
      }
      if (a === 0x6000) {                                // 9-bit shift register
        bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff;
        bankShift++;
        return;
      }
      if (a === 0x7f11) { writes.push({ port: "psg", val: d }); return; }
      if (a === 0x4000) { addr[0] = d; return; }
      if (a === 0x4002) { addr[1] = d; return; }
      if (a === 0x4001) {
        if (addr[0] === 0x2a) { dac.push(d); return; }
        if (addr[0] === 0x27) enableB = (d & 0x08) !== 0;
        if (addr[0] === 0x27 && (d & 0x20)) {
          // The gate's flag reset. The timer free-runs, so the next overflow is
          // the next multiple of the period — not one period from here. Bit 5
          // is the engine's alone, so this write is not the score's.
          while (gateAt <= cyc) gateAt += GATE_CY;
          return;
        }
        writes.push({ port: 0, reg: addr[0], val: d });
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
  while (boot++ < 2_000_000 && !(ram[H_READY] === 0xd2 && cpu.halted)) cyc += cpu.step();
  if (ram[H_READY] !== 0xd2) throw new Error("engine never reported ready");

  // The plan is the sequencer's, so the harness has to play sequencer: one
  // model run in lockstep with the schedule, one plan per slot POSTED (the
  // engine mixes once per slot it consumes), and one silent advance per frame
  // that posts nothing, so a starved frame leaves the model in step.
  const planVoices = Array.from({ length: PCM_VOICES }, () => new ModelVoice());
  // The sequencer models the ring too (§5.1.2): how many ticks a frame mixes is
  // TARGET while the ring is empty and the chunk after that, and the plan's
  // distances are measured against exactly that number — which is the whole
  // reason the slot carries it.
  let planFill = 0;
  const planTicks = (voices) => {
    const active = voices.some((v) => v.active);
    if (!active && planFill === 0) return 0;
    if (planFill === 0) { planFill = RING_TARGET; return RING_TARGET; }
    planFill = Math.max(0, planFill - R) + (active ? R : 0);
    return active ? R : 0;
  };

  const perFrame = [];
  for (const spec of frames) {
    if (spec) {
      // `extra` posts further slots in the same host frame — the catch-up
      // scenario needs a backlog in the ring. `vbl` stamps the 68k's vblank
      // counter the way MMLisp_frame does (§6.7); specs that omit it leave
      // the stamp at 0 and the engine resyncs silently, which is also the
      // behaviour of every harness in this repo that predates the stamp.
      for (const one of [spec, ...(spec.extra ?? [])]) {
        applyPcm(planVoices, one);
        const ticks = planTicks(planVoices);
        const { plan } = mixFramePlan(planVoices, ticks);
        const head = ram[H_HEAD];
        const next = (head + 1) % RING_DEPTH;
        if (next !== ram[H_TAIL]) {                      // room in the ring
          const bytes = encodeSlot(one, plan);
          ram.set(bytes, RING + head * SLOT_SIZE);
          ram[H_HEAD] = next;
        } else if (VERBOSE) console.log("  (ring full, slot dropped)");
      }
      if (spec.vbl !== undefined) ram[H_VBL] = spec.vbl;
    } else {
      mixFramePlan(planVoices, planTicks(planVoices)); // starved: no plan sent
    }
    const w0 = writes.length;
    const d0 = dac.length;
    cpu.intRequest();
    let guard = 0;
  // A frame is FRAME_CYCLES of wall clock, not "until the CPU halts": the
  // engine feeds the DAC from its idle loop and only halts in a score with
  // no PCM in it (engine.z80 `idle`). A halted Z80 burns 4-cycle NOPs here,
  // which is exactly how it waits out the rest of a frame on hardware.
    let fcyc = 0;
    while (guard++ < 3_000_000 && fcyc < FRAME_CYCLES) { const c = cpu.step(); cpu.decay(c); cyc += c; fcyc += c; }
    if (guard >= 3_000_000) {
      // Name the one cause that reads as a hang and is invisible otherwise: on
      // the chip an unenabled timer's flag never appears, so `gate_wait` is an
      // infinite loop and the driver stops after its first frame of writes.
      throw new Error("frame did not complete"
        + (polledDisabled
          ? ` — the engine polled Timer B's flag ${polledDisabled} times with`
            + " ENABLE B ($27 bit 3) CLEAR, so on the chip it would never rise"
          : ""));
    }
    perFrame.push({ writes: writes.slice(w0), dac: dac.slice(d0),
      ring: process.env.RINGDUMP ? ram.slice(sym("RING_BUF"), sym("RING_TOP")) : null,
      rd: ram[sym("G_RD")] | (ram[sym("G_RD") + 1] << 8),
      wr: ram[sym("G_WR")] | (ram[sym("G_WR") + 1] << 8),
      fill: ram[sym("G_FILL")] | (ram[sym("G_FILL") + 1] << 8),
      wri: ram[sym("G_WRI")], wrp: ram[sym("G_WRP")], idx: ram[sym("G_IDX")],
      mixp: ram[sym("G_MIXP")], emits: ram[sym("G_EMITS")], chunk: ram[sym("G_CHUNK")] });
  }
  return {
    perFrame,
    frames: ram[H_FRAMES] | (ram[H_FRAMES + 1] << 8),
    starved: ram[H_STARVE] | (ram[H_STARVE + 1] << 8),
    ram,
  };
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

// Writes placed in every sub-slot of the frame (driver.md §3.5). Two different
// engine paths have to deliver them: the mixer's voice-pass boundaries while
// PCM is sounding, and the paced idle loop when it is not — and a PCM-less
// score silently losing its sub-ticks is exactly the failure worth a gate.
const subSpread = (base) =>
  Array.from({ length: SLOT_SUBS }, (_, j) => ({
    psg: [0x80 | (j << 5) | 0x0f],
    fm0: [[0x30 + j, base + j]],
  }));

scenarios.push({
  name: "writes spread across the frame's sub-slots",
  why: "sub-slot 0 rides the frame head, the rest ride pass boundaries — or a paced idle loop when nothing is sounding",
  frames: [
    { subs: subSpread(0x10) },                       // nothing sounding: idle path
    {
      subs: subSpread(0x20),
      pcm: [pcmStart(0, { flags: 1, shift: 0, bank: 2, ptr: WINDOW + 0x100,
                          left: 2000, loopl: 0, tail: 0, incF: 0x8000, incI: 1 })],
    },
    { subs: subSpread(0x30) },                       // sounding: pass boundaries
    { subs: subSpread(0x40) },
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
  name: "two voices, different rates and volumes",
  why: "saturating-add order, per-voice shift, and the storing/accumulating split",
  needs: 2,
  frames: [
    {
      pcm: [
        pcmStart(0, { flags: 1, shift: 0, bank: 1, ptr: WINDOW + 0x40, left: 20000, loopl: 0, tail: 0, incF: 0x4000, incI: 1 }),
        pcmStart(1, { flags: 1, shift: 1, bank: 2, ptr: WINDOW + 0x800, left: 20000, loopl: 0, tail: 0, incF: 0xc000, incI: 2 }),
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

// The exact shape a real score produces (m3-pcm-softmix, voice 2): a loop
// region a little longer than one frame's span, so the boundary lands at a
// different point in every frame and the segment sizing has to converge.
scenarios.push({
  name: "loop region just over one frame's span",
  why: "the segment bound shrinks toward the boundary; every frame ends mid-region",
  frames: Array.from({ length: 20 }, (_, i) =>
    i === 0
      ? { pcm: [pcmStart(V2, { flags: 3, shift: 1, bank: 0, ptr: 0x811a, left: 400, loopl: 300, tail: 112, incF: 0x0cbc, incI: 1 })] }
      : {},
  ),
});

// A retrigger: STOP and START for the same voice in ONE slot, with other
// commands around them. This is what a real score does when a looped PCM note
// is re-attacked, and it is the case that catches a handler which fails to
// return the command cursor untouched — the earlier stop-only scenarios could
// not, because nothing followed the STOP in their slot.
scenarios.push({
  name: "STOP and START in the same slot",
  why: "every PCM handler must leave HL on the command cursor, or the rest of the slot is garbage",
  frames: [
    {
      // The neighbouring voice is scenery here — the retrigger below is the
      // test — so at one voice it is simply absent and the slot still carries
      // a STOP, a START and a VOL for the cursor to walk.
      pcm: [
        ...(V2 ? [pcmStart(0, { flags: 1, shift: 0, bank: 1, ptr: WINDOW + 0x60, left: 4000, loopl: 0, tail: 0, incF: 0x4000, incI: 1 })] : []),
        pcmStart(V2, { flags: 3, shift: 1, bank: 3, ptr: WINDOW + 0x300, left: 400, loopl: 300, tail: 112, incF: 0x2000, incI: 1 }),
      ],
    },
    {}, {},
    {
      pcm: [
        pcmStop(V2),
        pcmStart(V2, { flags: 3, shift: 1, bank: 4, ptr: WINDOW + 0x120, left: 500, loopl: 400, tail: 90, incF: 0x1000, incI: 1 }),
        pcmVol(0, 3),
      ],
    },
    {}, {}, {}, {},
  ],
});

// ── Check ──────────────────────────────────────────────────────────────────
let failures = 0;
for (const sc of scenarios) {
  // Skipping is reported, never silent: a build with fewer voices than a
  // scenario needs has LESS coverage, and a gate that prints "all ok" without
  // saying so is claiming something it did not check.
  if (sc.needs > PCM_VOICES) {
    console.log(`skip  ${sc.name}`);
    console.log(`      needs ${sc.needs} PCM voices, this build has ${PCM_VOICES}`);
    continue;
  }
  const voices = Array.from({ length: PCM_VOICES }, () => new ModelVoice());
  const feed = new ModelFeed();
  const { perFrame, starved } = run(sc.frames);
  const problems = [];
  // The ring is topped up before every frame, so nothing may starve — except in
  // the scenario that starves it on purpose (a `null` frame spec). A slot the
  // engine holds for the WHOLE frame (§3.5) is what made this bite on hardware,
  // and RING_DEPTH is what pays for it.
  const deliberate = sc.frames.filter((f) => !f).length;
  if (starved !== deliberate) {
    problems.push(`${starved} starved frame(s), expected ${deliberate}`);
  }

  sc.frames.forEach((spec, f) => {
    const got = perFrame[f];

    // (a) chip writes == the slot, exactly — sub-slot by sub-slot, in order.
    // Sub-slot 0 goes out at the frame head and the rest at the mixer's voice
    // pass boundaries (driver.md §3.5), so the frame's whole write sequence is
    // the blocks concatenated.
    const want = [];
    if (spec) {
      for (const b of spec.subs ?? [spec]) {
        for (const v of b.psg ?? []) want.push({ port: "psg", val: v });
        for (const [r, v] of b.fm0 ?? []) want.push({ port: 0, reg: r, val: v });
        for (const [r, v] of b.fm1 ?? []) want.push({ port: 1, reg: r, val: v });
      }
    }
    // $2B (DAC enable) is the engine's own — it is claimed on the first active
    // voice and released when the last one ends (driver.md §14).
    const chip = got.writes.filter((w) => !(w.port === 0 && w.reg === 0x2b));
    if (JSON.stringify(chip) !== JSON.stringify(want)) {
      problems.push(`f${f}: chip writes ${JSON.stringify(chip)} != slot ${JSON.stringify(want)}`);
    }

    if (process.env.RINGDUMP && f <= 1 && got.ring) {
      const hex = (a, o) => [...a.slice(o, o + 6)].map((x) => x & 0xff).join(",");
      console.log(`  f${f} engine [0..5] ${hex(got.ring, 0)} [255..260] ${hex(got.ring, 255)}`
        + ` rd ${got.rd - 0x1a00} wr ${got.wr - 0x1a00} fill ${got.fill}`
        + ` | wri ${got.wri} wrp ${got.wrp.toString(16)} idx ${got.idx} mixp ${got.mixp.toString(16)}`
        + ` emits ${got.emits} chunk ${got.chunk}`);
      console.log(`  f${f} model  [0..5] ${hex(feed.ring, 0)} [255..260] ${hex(feed.ring, 255)}`
        + ` rd ${feed.rd} fill ${feed.fill}`);
    }
    // (b) DAC stream == the model
    applyPcm(voices, spec);
    const wantDac = feed.frame(voices);
    if (wantDac === null) {
      if (got.dac.length) problems.push(`f${f}: ${got.dac.length} DAC writes with no voice active`);
    } else if (got.dac.length !== wantDac.length) {
      problems.push(`f${f}: ${got.dac.length} DAC writes, expected ${wantDac.length}`);
    } else {
      for (let i = 0; i < wantDac.length; i++) {
        if (got.dac[i] !== wantDac[i]) {
          problems.push(`f${f}: DAC[${i}] = ${got.dac[i]}, model says ${wantDac[i]}`
            + ` | got ${got.dac.slice(Math.max(0, i - 1), i + 5).join(",")}`
            + ` want ${wantDac.slice(Math.max(0, i - 1), i + 5).join(",")}`);
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

// ── Missed-vblank catch-up (§6.7) — bespoke, because the assertion is about
// slot COUNT per interrupt, which the declarative loop assumes is one. A
// frame that runs over budget loses its next /INT outright; the 68k's stamp
// is what lets the engine consume the owed slot late instead of never. No
// emulated frame ever runs out of cycles, so without this scenario the whole
// path would ship untested (the overrun-counter lesson, all over again).
{
  const mk = (r, v) => ({ fm0: [[r, v]] });
  const { perFrame, frames: consumed, starved } = run([
    { ...mk(0x30, 0x11), vbl: 1 },                        // in step: no catch-up
    { ...mk(0x32, 0x22), vbl: 3, extra: [mk(0x34, 0x33)] }, // stamp says one vblank was missed
    { ...mk(0x36, 0x44), vbl: 4 },                        // back in step
  ]);
  const problems = [];
  const w = (f) => JSON.stringify(perFrame[f].writes);
  const want = (...ws) => JSON.stringify(ws.map(([r, v]) => ({ port: 0, reg: r, val: v })));
  if (w(0) !== want([0x30, 0x11])) problems.push(`f0 ${w(0)} — a spurious catch-up?`);
  if (w(1) !== want([0x32, 0x22], [0x34, 0x33]))
    problems.push(`f1 ${w(1)} — expected the owed slot consumed in the same interrupt`);
  if (w(2) !== want([0x36, 0x44])) problems.push(`f2 ${w(2)} — catch-up did not stop at the stamp`);
  if (consumed !== 4) problems.push(`H_FRAMES = ${consumed}, expected 4 (the audible clock counts the caught-up frame)`);
  if (starved) problems.push(`${starved} starved frame(s)`);
  const ok = problems.length === 0;
  if (!ok) failures++;
  scenarios.push({});   // it counts
  console.log(`${ok ? "ok  " : "FAIL"}  missed vblank is caught up, not lost`);
  console.log(`      the 68k's H_VBL stamp is ahead of the answered count, so the engine consumes the owed slot late`);
  for (const p of problems.slice(0, 4)) console.log(`      ! ${p}`);
}

// ── The hot code must stop below the published header ──────────────────────
// Code runs from $0000 and HDR is a FIXED address the 68k compiles in (§6.4),
// so what the frame runs has $1300 bytes and not one more. Nothing checked
// this: an engine that grew past it assembled cleanly, overwrote the header and
// the ring with its own code, and presented as the mixer executing data — which
// is how it was found. COLD code (once a frame, once a boot) lives above the
// sample ring instead, so the blob spans the gap and its length is not the
// number that matters — CODE_END is.
{
  const HDR = sym("HDR");
  const codeEnd = sym("CODE_END");
  const room = HDR - codeEnd;
  const stackRoom = sym("STACK_TOP") - 64 - built.bytes.length;
  const ok = room >= 0 && stackRoom >= 0;
  if (!ok) failures++;
  scenarios.push({});   // it counts
  console.log(`${ok ? "ok  " : "FAIL"}  the image stops below the published header`);
  console.log(`      hot ${codeEnd} B (${room} B to $${HDR.toString(16)}), `
    + `blob ${built.bytes.length} B (${stackRoom} B to the stack)`);
  if (room < 0) console.log(`      ! the hot code runs INTO the header and the ring — the`
    + ` 68k's one compiled-in address (§6.4) cannot move`);
  if (stackRoom < 0) console.log(`      ! the cold code runs into the stack`);
}

console.log(`\nengine image ${built.bytes.length} B · R = ${R} · ring depth ${RING_DEPTH}`);
if (failures) {
  console.error(`FAIL: ${failures} of ${scenarios.length} scenarios`);
  process.exit(1);
}
console.log(`${scenarios.length} scenarios pass`);
