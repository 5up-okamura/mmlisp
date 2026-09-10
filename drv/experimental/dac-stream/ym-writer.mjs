// THE Z80's YM WRITER (docs/dac-engine-implementation.md R26 §59.3-§59.5).
//
// b11..b14 of every block were reserved for it — 280 cycles a block and 120
// bytes of code — since R16 §41.1. This is the code that replaces the pad, and
// the first thing it produced was a measurement that contradicts the
// reservation. Both halves of that are here, because the reservation cannot be
// judged without the instructions that were supposed to fit inside it.
//
// ── why the writer cannot be a subroutine ────────────────────────────────
//
// The engine's loop is eighty slots of straight-line code, so a write
// opportunity that carries code carries it TWENTY times a lap. A shared
// routine would fix that — three bytes a site instead of ten — and it is not
// available, for a reason that is worth stating once:
//
//   * `call` + `ret` is 27 cycles and `rst` + `ret` is 21, against a 70-cycle
//     reservation that has to hold a fetch and three chip writes as well.
//   * The queue cursor has nowhere to live but SP. BC is the decode's — it
//     carries a value across 47 of the 80 slots (decode-split.mjs) — HL is the
//     ring's play cursor and DE is the DAC's data port, and both are read in
//     EVERY slot. IX is voice 1's source pointer and IYL is where the mixer
//     parks voice 0's contribution.
//   * SP and a call frame are mutually exclusive: `rst` pushes the return
//     address at SP-2, so the first `pop` inside the routine reads the return
//     address instead of the queue. Recovering it costs `pop iy` + `jp (iy)`,
//     which is 22 cycles on top of the 11 the `rst` already cost.
//
// So the writer is INLINE, and its cost is measured in bytes a site. That is
// what decides how many opportunities the reservation can actually carry.
//
// ── the shape that came out of it ────────────────────────────────────────
//
// One opportunity, ELEVEN bytes, 89 cycles, and the same instructions whatever
// the entry says:
//
//     pop  de        DE = the port to address ($4000, $4002 — or the bucket)
//     pop  af        A = the register number          (F takes the odd byte)
//     ld   (de),a    …into the address latch
//     inc  e         → the matching data port
//     pop  af        A = the value
//     ld   (de),a    …into it
//     pop  de        DE = $4000, from the queue
//     pop  af        A = $2a
//     ld   (de),a    the DAC's address latch, put back inside the opportunity
//     inc  e         DE = $4001 again, which is where every slot's DAC write
//                    expects it
//     pop  af        …and past the word the mixer's `call` is about to use
//
// `pop` is one byte and carries its address in SP, which is why this is eleven
// bytes and an absolutely-addressed form is fourteen. The price is paid in
// QUEUE bytes: SIX words an entry (see the next paragraph for the sixth), of
// which the producer owns FOUR BYTES — the two of the target pointer, the
// register and the value. R26 §60.8 said three, counting the three FIELDS as
// three bytes; R27 §61.2 withdraws that. The pointer's two bytes differ in the
// high byte as well (`$1E60` idle against `$4000`/`$4002` live), so no amount
// of pre-initialisation shrinks it to one, and four bytes a write is the
// floor of this form.
//
// THE STACK AND THE QUEUE ARE THE SAME PAGE, and one word an entry is the
// engine's. `call mix_one` runs in every slot and pushes its return address at
// SP-2 — which, once the cursor has moved, is the last word the writer popped.
// For a queue that is consumed once that is free real estate; this window is
// STATIC and read again every lap, so the push was quietly rewriting the entry
// it had just read, and the second lap re-latched `$02` instead of `$2a` and
// sent every DAC sample after it into an FM register. So each entry ends in a
// word nobody reads: the site pops six and uses five, and the sixth is where
// the mixer's return address lives between one opportunity and the next.
//
// THE TARGET POINTER IS WHAT MAKES AN ENTRY LIVE OR IDLE — and that is a
// property of this static fixture, NOT an atomic commit (R27 §61.2). An entry
// whose pointer names the two-byte bucket in the chip region makes no FM write
// at all: the register and the value go to RAM, and the only chip access left
// is the `$2A` re-latch, which is idempotent. So an empty queue is not a path,
// it is the same path with a different pointer, and the four cases §59.4 asks
// to be the same length are the same INSTRUCTIONS.
//
// What it is NOT is a commit a producer could rely on. The 68000 reaches Z80
// RAM one byte at a time, so a 16-bit pointer's two halves never change
// together: a reader can see `$1E00` or `$4060` between them. A real transport
// publishes a window by releasing the bus, or by a separate one-byte
// generation written last — and `--fault port-first` shows only that a live
// entry read before its payload is wrong, not that any of that has been
// tested.
import { op } from "./schedule.mjs";
import { YM } from "./config.mjs";
import { checkWriteStream } from "./analyze.mjs";
import { generate } from "./gen-stream.mjs";
import { assemble } from "../../tools/z80asm.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bytes an instruction sequence assembles to — measured, not tabulated. */
export function asmBytes(lines) {
  const dir = mkdtempSync(join(tmpdir(), "ymw-"));
  const f = join(dir, "x.z80");
  try {
    writeFileSync(f, ["        org 0", ...lines.map((l) => `        ${l}`)].join("\n"));
    return assemble(f).bytes.length;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const ENTRY_WORDS = 6;
export const ENTRY_BYTES = ENTRY_WORDS * 2;

/**
 * WHO OWNS EACH BYTE OF AN ENTRY (R27 §61.2).
 *
 * `producer` is what changes per write and is therefore what a transport has to
 * carry: FOUR bytes, not three. `const` is laid down once by the fixture and
 * `engine` is the word `call mix_one` writes its return address into.
 */
export const ENTRY_LAYOUT = [
  { at: 0, owner: "producer", what: "target pointer, low — $60 idle / $00 port 0 / $02 port 1" },
  { at: 1, owner: "producer", what: "target pointer, high — $1e idle / $40 live" },
  { at: 2, owner: "const", what: "the byte `pop af` puts in F" },
  { at: 3, owner: "producer", what: "register number" },
  { at: 4, owner: "const", what: "the byte `pop af` puts in F" },
  { at: 5, owner: "producer", what: "value" },
  { at: 6, owner: "const", what: "$4000, low — the DAC's address port" },
  { at: 7, owner: "const", what: "$4000, high" },
  { at: 8, owner: "const", what: "the byte `pop af` puts in F" },
  { at: 9, owner: "const", what: "$2a" },
  { at: 10, owner: "engine", what: "`call mix_one`'s return address" },
  { at: 11, owner: "engine", what: "…its other half" },
];
export const PRODUCER_BYTES = ENTRY_LAYOUT.filter((b) => b.owner === "producer").map((b) => b.at);

/** One entry, as the fixture lays it down. `port` is null for an idle one. */
export function entryBytes({ port = null, reg = 0, val = 0 }, bucket) {
  const at = port === null ? bucket : (port ? YM.addr1 : YM.addr0);
  return [at & 0xff, at >> 8, 0, reg & 0xff, 0, val & 0xff,
    YM.addr0 & 0xff, YM.addr0 >> 8, 0, YM.R_DAC,
    // …and the word the mixer's return address lives in. Nothing reads it.
    0, 0];
}

export const IDLE = { port: null, reg: 0, val: 0 };

/** What one entry makes the chip see, in order. `null` = nothing. */
export function entryWrites({ port = null, reg = 0, val = 0 }) {
  const relatch = { port: 0, kind: "addr", reg: YM.R_DAC };
  if (port === null) return [relatch];
  return [{ port, kind: "addr", reg }, { port, kind: "data", reg }, relatch];
}

// ── The site, as instructions ─────────────────────────────────────────────
//
// `writes` is what the analyzer checks against the chip's settling table. An
// entry can be idle, so what a site DECLARES is the write it makes when it is
// not — the analyzer is given the trace, and the trace has only the writes
// that really happened.
export function siteOps({ fault = null } = {}) {
  const relatch = [
    op("pop  de", 10, { what: "…and $4000, to put the DAC's latch back" }),
    op("pop  af", 10),
    op("ld   (de),a", 7, { what: "$2A re-latch, inside the same opportunity" }),
    op("inc  e", 4, { what: "DE = $4001 again — the DAC's data port" }),
    op("pop  af", 10, { what: "…and past the word `call mix_one` writes in" }),
  ];
  const body = [
    op("pop  de", 10, { what: "the port this entry addresses (or the bucket)" }),
    op("pop  af", 10, { what: "the register number" }),
    op("ld   (de),a", 7),
    op("inc  e", 4),
    op("pop  af", 10, { what: "the value" }),
    op("ld   (de),a", 7),
  ];
  // §59.5's negatives, each one instruction wide.
  if (fault === "no-relatch")
    // The address latch is left wherever the entry put it, and the next slot's
    // DAC write goes into that register instead of $2A.
    return [...body, op("pop  de", 10), op("pop  af", 10),
      op("inc  e", 4, { what: "FAULT no-relatch: the latch is never put back" }),
      op("nop", 4), op("pop  af", 10)];
  if (fault === "slow-empty")
    // Same bytes, different cycles: `ld a,(de)` is 7 where `pop af` is 10, so
    // the slot finishes three cycles early and the DAC interval moves.
    return [...body.slice(0, 4),
      op("ld   a,(de)", 7, { what: "FAULT slow-empty: one byte, three cycles short" }),
      ...body.slice(5), ...relatch];
  return [...body, ...relatch];
}

/** The once-a-lap reload of the cursor. */
export const resetOps = (base) => [
  op(`ld   sp,$${base.toString(16)}`, 10,
    { what: "the writer's window, reloaded at the top of every lap" }),
];

// ── The candidates §59.3 asks to be priced ────────────────────────────────
//
// Every row is real instructions, assembled for its byte count and summed from
// the documented cycle counts for its cost. `queue` is what the entry costs in
// the fixture; `producerBytes` is how many of those BYTES a producer would have
// to write for each FM write, which is the number the transport question needs.
// It is bytes and not fields: R27 §61.2 corrects the single stream's figure
// from 3 to 4, because a 16-bit target pointer is two bytes on an 8-bit bus.
export const FORMS = [
  { name: "single stream, port in the entry", key: "stream",
    asm: ["pop de", "pop af", "ld (de),a", "inc e", "pop af", "ld (de),a",
      "pop de", "pop af", "ld (de),a", "inc e", "pop af"],
    cycles: 89, queue: 12, producerBytes: 4,
    note: "the built form: run switching is free, an idle entry is the same instructions" },
  { name: "port runs, the port in a RAM byte", key: "run",
    asm: ["ld a,($1e62)", "ld e,a", "pop af", "ld (de),a", "inc e", "pop af",
      "ld (de),a", "pop af", "ld e,0", "ld (de),a", "inc e", "pop af"],
    cycles: 13 + 4 + 10 + 7 + 4 + 10 + 7 + 10 + 7 + 7 + 4 + 10, queue: 8, producerBytes: 2,
    note: "\"the current port\" has no register to live in, so every site re-reads it"
      + " — and the run-length countdown is not in this row at all" },
  { name: "port fixed by placement, port 0", key: "fixed0",
    asm: ["dec e", "pop af", "ld (de),a", "inc e", "pop af", "ld (de),a",
      "dec e", "pop af", "ld (de),a", "inc e", "pop af"],
    cycles: 4 + 10 + 7 + 4 + 10 + 7 + 4 + 10 + 7 + 4 + 10, queue: 8, producerBytes: 2,
    note: "cheaper, but the producer may only put a port-0 write in a port-0 site" },
  { name: "port fixed by placement, port 1", key: "fixed1",
    asm: ["inc e", "pop af", "ld (de),a", "inc e", "pop af", "ld (de),a",
      "dec e", "dec e", "pop af"],
    cycles: 4 + 10 + 7 + 4 + 10 + 7 + 4 + 4 + 10, queue: 6, producerBytes: 2,
    note: "port 1 never touches port 0's address latch, so it needs no re-latch" },
  { name: "absolute stores, port self-modified", key: "absolute",
    asm: ["pop af", "ld ($4000),a", "pop af", "ld ($4001),a", "ld a,$2a",
      "ld ($4000),a", "pop af"],
    cycles: 10 + 13 + 10 + 13 + 7 + 13 + 10, queue: 6, producerBytes: 2,
    note: "the cheapest in CYCLES and the dearest in bytes — and twenty sites"
      + " cannot share one self-modified operand" },
];

/** The joint constraint: bytes a site, the block ceiling and the 120 B reserve. */
export function fits(form, { codeBudget, blockBudget, slotBudget, reset, positions }) {
  const bytes = asmBytes(form.asm);
  const byBytes = Math.floor((codeBudget - reset) / bytes);
  const byBlock = Math.floor(blockBudget / form.cycles);
  const bySlot = form.cycles <= slotBudget ? Infinity : 0;
  const sites = Math.min(byBytes, byBlock * (positions / 4), bySlot);
  return { bytes, byBytes, byBlock, perSlotOk: form.cycles <= slotBudget, sites };
}

export const YM_FAULTS = {
  "no-relatch": "one opportunity leaves the address latch where the entry put it",
  "port-bit": "one entry's port word says port 1 where the reference says port 0",
  "pitch-split": "another $A4 upper write is put between a pair's upper and lower halves",
  "slow-empty": "the idle path is one byte the same and three cycles short",
  "port-first": "the fixture commits an entry's port word before its register and value",
};

// ── Where the sites go ────────────────────────────────────────────────────
//
// The reservation owns b11..b14 of every block — twenty positions a lap — and
// the 120 bytes it also owns buy eleven of them. Which eleven is arithmetic:
// the sites are spread as evenly over the twenty as eleven will go, so no
// block carries more than three and the writes come out of the chip at a
// steady rate rather than in a burst at the top of the lap.
export const YM_POSITIONS = [11, 12, 13, 14];

export function writerSlots(cfg) {
  const out = [];
  for (let i = 0; i < cfg.cycleSlots; i++)
    if (YM_POSITIONS.includes((i + cfg.lead) % cfg.blockSamples)) out.push(i);
  return out;
}

/**
 * @param sites how many of the twenty positions carry code
 * @param base  the window's first byte — the cursor is reloaded to it once a lap
 */
export function writerPlan(cfg, { sites, base, fault = null }) {
  const all = writerSlots(cfg);
  if (sites > all.length) throw new Error(`${sites} sites into ${all.length} positions`);
  const at = [];
  for (let k = 0; k < sites; k++) at.push(all[Math.floor((k * all.length) / sites)]);
  const plan = new Map();
  const ops = siteOps({ fault });
  // WHERE THE CURSOR IS RELOADED. Not in front of the first site: that slot is
  // already the fullest of the four and ten more cycles took it to 85.5% of its
  // period, past the ceiling. It goes in the first opportunity the sites left
  // EMPTY after the last one, which is after the lap's last pop and before the
  // next lap's first — and which costs the schedule nothing, because that slot
  // was carrying pad.
  const resetAt = all.find((i) => i > at[at.length - 1] && !at.includes(i)) ?? at[0];
  for (const slot of at) plan.set(slot, [...ops]);
  plan.set(resetAt, [...resetOps(base), ...(plan.get(resetAt) ?? [])]);
  // Cycles a BLOCK, which is the number §59.6 grades — the reservation is
  // 280 there, not 79 per position.
  const perBlock = new Map();
  for (const [slot, o] of plan) {
    const b = Math.floor((slot + cfg.lead) / cfg.blockSamples);
    perBlock.set(b, (perBlock.get(b) ?? 0) + o.reduce((t, x) => t + x.cycles, 0));
  }
  const siteBytes = asmBytes(ops.flatMap((o) => o.asm));
  const resetBytes = asmBytes(resetOps(base).flatMap((o) => o.asm));
  // …AND THE BOOT SET-UP, which is the writer's code too (R27 §61.3 step 4).
  // The first lap runs before the once-a-lap reload has happened, so boot has
  // to put the cursor somewhere; leaving it out is what made §60 report 113 B
  // where the image carries 116, and a three-byte difference nobody can
  // account for is exactly what the ledger exists to prevent.
  const bootBytes = resetBytes;
  return { plan, at, resetAt, perBlock, sites, base,
    bytes: sites * siteBytes + resetBytes + bootBytes,
    siteBytes, resetBytes, bootBytes,
    worstBlock: Math.max(...perBlock.values()),
    writesPerLap: sites,
    writesPerSecond: sites * cfg.rateHz / cfg.cycleSlots };
}

// ── The fixture ───────────────────────────────────────────────────────────
//
// A test fixture and NOT a transport (§59.3). One lap's worth of entries at a
// fixed window, laid down once before the Z80 is let go and never refilled, so
// the same lap of writes repeats for the length of a run. What that buys is a
// count nobody has to trust: at eleven writes a lap the chip must see exactly
// `11 x laps` of them, in this order, for ever.
export function fixtureBytes(entries, { base, sites, bucket, fault = null }) {
  if (entries.length !== sites)
    throw new Error(`the window holds ${sites} entries, not ${entries.length}`);
  const out = [];
  entries.forEach((e, i) => {
    // `port-first` is the producer-order negative: the entry is committed (its
    // port word points at the chip) while its register and value are still the
    // bytes the fixture laid down for an idle one.
    const live = fault === "port-first" && i === 1
      ? { ...IDLE, port: 0 } : e;
    out.push(...entryBytes(live, bucket));
  });
  return { base, bytes: out, writes: entries.flatMap((e, i) =>
    entryWrites(fault === "port-first" && i === 1 ? { ...IDLE, port: 0 } : e)) };
}

/** The chip writes one lap of the window makes, as the analyzer wants them. */
export const lapWrites = (entries) => entries.flatMap(entryWrites);

// ── The sequences §59.5 asks to be run ────────────────────────────────────
//
// One lap's window, so every sequence is exactly `sites` entries long and an
// unused one is idle. A PITCH PAIR MAY NOT STRADDLE A BLOCK: the engine's own
// CSM traffic writes $AC at b6 and commits it with $A8 at b8, so an upper write
// left uncommitted across a block boundary would take that latch away from CSM
// — which is exactly what the analyzer's frequency-latch check refuses, and
// exactly what the `pitch-split` negative does on purpose.
const pad = (list, sites) => {
  if (list.length > sites) throw new Error(`${list.length} entries into ${sites}`);
  return [...list, ...Array.from({ length: sites - list.length }, () => IDLE)];
};

export const SEQUENCES = {
  // Both ports, a key edge, a pitch pair, a TL, a voice register and a global.
  control: (n) => pad([
    { port: 0, reg: 0x28, val: 0xf0 },      // key on, channel 1, all operators
    { port: 0, reg: 0x40, val: 0x18 },      // TL
    { port: 0, reg: 0xa4, val: 0x22 },      // pitch, upper…
    { port: 0, reg: 0xa0, val: 0x69 },      // …and the lower that commits it
    { port: 0, reg: 0x30, val: 0x71 },      // DT/MUL — a voice register
    { port: 1, reg: 0x44, val: 0x20 },      // port 1: channel 4's TL
    { port: 1, reg: 0xa4, val: 0x21 },      // port 1 has its own frequency latch
    { port: 1, reg: 0xa0, val: 0x55 },
    { port: 1, reg: 0xb0, val: 0x3a },      // …and channel 4's algorithm
    { port: 0, reg: 0x22, val: 0x00 },      // a global
  ], n),
  // Nothing at all: every entry points at the bucket, and the only chip access
  // left is the idempotent $2A re-latch.
  empty: (n) => pad([], n),
  one: (n) => pad([{ port: 0, reg: 0x40, val: 0x2a }], n),
  // Maximum density: every opportunity carries a real write, for as long as the
  // run lasts. This is the sequence the count is checked against.
  dense: (n) => Array.from({ length: n },
    (_, i) => ({ port: i & 1, reg: 0x40 + (i & 3), val: 0x10 + i })),
  // A port change at EVERY opportunity, so the "run boundary" lands on each of
  // b11..b14 in turn.
  ports: (n) => Array.from({ length: n },
    (_, i) => ({ port: i & 1, reg: 0x30 + i, val: 0x40 + i })),
  // The corpus's steady mix (R25 §57.4): TL and pitch dominate, key edges are
  // rare. 2:1 port 0 to port 1, which is what the 41 scores measured.
  steady: (n) => Array.from({ length: n }, (_, i) => {
    // Period FOUR, so a pitch pair always starts on an even entry and both
    // halves land in the same block — see `pairsWithinBlocks`. Three port-0
    // writes to one on port 1 is what the 41 scores measured (R25 §57.4).
    const k = i % 4;
    if (k === 0) return { port: 0, reg: 0xa4, val: 0x22 };
    if (k === 1) return { port: 0, reg: 0xa0, val: 0x60 + i };
    if (k === 2) return { port: 0, reg: 0x4c, val: 0x20 + i };
    return { port: 1, reg: 0x4c, val: 0x20 + i };
  }),
  // As much of a voice patch as one window holds — which is the point of the
  // measurement, not a claim that a patch fits.
  burst: (n) => Array.from({ length: n },
    (_, i) => ({ port: 0, reg: 0x30 + i * 4, val: 0x71 + i })),
};

/**
 * A PORT-0 PITCH PAIR MAY NOT STRADDLE A BLOCK (R26 §59.5).
 *
 * Found by running it: the engine's own CSM traffic writes $AC at b6 of every
 * block and commits it with $A8 at b8, so an upper write left uncommitted
 * across a block boundary loses its frequency to CSM's — the chip has ONE
 * holding register per part and the two features are sharing it. The first
 * `control` fixture put $A4 at the last opportunity of one block and $A0 at the
 * first of the next, and the analyzer said so.
 *
 * It is a constraint on the PRODUCER, not on the writer, and it is checked here
 * so that a fixture cannot break it by accident again.
 */
const UPPER = new Set([0xa4, 0xa5, 0xa6]);
const LOWER = { 0xa0: 0xa4, 0xa1: 0xa5, 0xa2: 0xa6 };
export function pairsWithinBlocks(entries, at, cfg) {
  const problems = [];
  const blockOf = (k) => Math.floor((at[k] + cfg.lead) / cfg.blockSamples);
  entries.forEach((e, k) => {
    if (e.port !== 0 || !UPPER.has(e.reg)) return;
    const next = entries[k + 1];
    if (!next || next.port !== 0 || LOWER[next.reg] !== e.reg)
      problems.push(`entry ${k} writes $${e.reg.toString(16)} and the entry after it`
        + " does not commit that frequency latch");
    else if (blockOf(k) !== blockOf(k + 1))
      problems.push(`entry ${k}'s $${e.reg.toString(16)} and its lower half are in`
        + ` different blocks (${blockOf(k)} and ${blockOf(k + 1)}), and the engine's own`
        + " CSM pair runs between them");
  });
  return problems;
}

/**
 * §59.5's fixture negatives, applied to the entries rather than to the code.
 * They are the producer's mistakes, and the writer has no way to catch them —
 * which is the point: what they establish is the input contract.
 */
export function breakEntries(entries, fault) {
  const out = entries.map((e) => ({ ...e }));
  const live = out.findIndex((e) => e.port !== null);
  if (fault === "port-bit") {
    if (live < 0) throw new Error("port-bit needs a live entry to move");
    out[live].port = out[live].port ? 0 : 1;
    return out;
  }
  if (fault === "pitch-split") {
    // Another upper write between a pair's upper and its lower half.
    const up = out.findIndex((e) => e.port === 0 && e.reg === 0xa4);
    if (up < 0 || up + 1 >= out.length) throw new Error("pitch-split needs an $a4/$a0 pair");
    out[up + 1] = { port: 0, reg: 0xa5, val: 0x23 };
    return out;
  }
  return out;
}

// ── What the machine has to show ──────────────────────────────────────────
//
// The trace carries every YM access the Z80 made, with its port half and its
// byte (probe-analysis.mjs), so the writer's stream is RECONSTRUCTED from the
// chip's side rather than read back out of the engine's RAM: the address latch
// is tracked per part, and a data write is attributed to the register that was
// latched when it arrived. That is also what makes the `no-relatch` negative
// visible as itself — a DAC sample that lands in $40 is a data write to $40,
// not a missing one.
const CSM_REGS = new Set([0xac, 0xa8]);
export const YM_BUSY_MASTER = 32 * 42 + 42;     // R24 §55.2, after a DATA write

export function checkWriterTrace(log, { entries, from = 0, to = Infinity }) {
  const live = entries.filter((e) => e.port !== null);
  // The address latch is tracked over the WHOLE log and the measurement window
  // only decides which writes are counted: a window that starts between an
  // address write and its data write would otherwise report a data write with
  // nothing latched, which is an artefact of the window and not of the engine.
  const latch = [null, null];
  const dac = [], writer = [], csm = [], problems = [];
  for (const e of log.ymZ80) {
    if (e.read) continue;
    if (e.kind === "addr") { latch[e.part] = e.byte; continue; }
    const reg = latch[e.part];
    const inWindow = e.time >= from && e.time <= to;
    if (e.part === 0 && reg === 0x2a) { if (inWindow) dac.push(e.time); continue; }
    if (e.part === 0 && CSM_REGS.has(reg)) { if (inWindow) csm.push(e.time); continue; }
    if (!inWindow) continue;
    if (reg === null) { problems.push(`a data write at ${e.time} with nothing latched`); continue; }
    writer.push({ time: e.time, port: e.part, reg, val: e.byte });
  }
  // WHERE IN THE WINDOW THE MEASUREMENT STARTED. The run does not begin at
  // entry 0 of a lap, so the phase is found once and every write after it has
  // to follow — which is a stronger statement than "some rotation matches",
  // because only one rotation can survive the whole run.
  const same = (w, e) => w.port === e.port && w.reg === e.reg && w.val === e.val;
  let phase = -1, matched = 0, bad = null;
  if (live.length && writer.length) {
    for (let o = 0; o < live.length; o++) {
      let n = 0, first = null;
      for (; n < writer.length; n++) {
        if (same(writer[n], live[(n + o) % live.length])) continue;
        first = { at: n, w: writer[n], want: live[(n + o) % live.length] };
        break;
      }
      if (n > matched) { matched = n; phase = o; bad = first; }
      if (n === writer.length) break;
    }
    if (bad) problems.push(`write ${bad.at} is ${bad.w.port}:$${bad.w.reg.toString(16)}`
      + `=$${bad.w.val.toString(16)} where the window says ${bad.want.port}`
      + `:$${bad.want.reg.toString(16)}=$${bad.want.val.toString(16)}`);
  } else if (writer.length) {
    problems.push(`${writer.length} register writes from a window that names none`);
  }
  // BUSY, from the machine's own times: the writer's data write has to fall
  // after the DAC's own busy and clear before the next one (§59.4).
  let beforeMin = Infinity, afterMin = Infinity, d = 0;
  for (const w of writer) {
    while (d + 1 < dac.length && dac[d + 1] <= w.time) d++;
    if (dac.length && dac[d] <= w.time) beforeMin = Math.min(beforeMin, w.time - dac[d]);
    if (d + 1 < dac.length) afterMin = Math.min(afterMin, dac[d + 1] - w.time);
  }
  if (writer.length && beforeMin < YM_BUSY_MASTER)
    problems.push(`a writer data write came ${beforeMin} master after the slot's DAC write,`
      + ` inside the ${YM_BUSY_MASTER} master that one is busy for`);
  if (writer.length && afterMin < YM_BUSY_MASTER)
    problems.push(`a writer data write left only ${afterMin} master before the next DAC write,`
      + ` less than the ${YM_BUSY_MASTER} its own busy lasts`);
  // …AND THE CHIP'S OWN TABLE, on the same stream. Register-range settling,
  // $28's 53 cycles, the address latch and BOTH frequency latches — §59.4 asks
  // for every one of them, and the arithmetic is analyze.mjs's, not a second
  // copy of it. Times are the instrument's master clocks; the table is in Z80
  // cycles.
  const stream = [], seen = [null, null];
  let seeded = false;
  for (const e of log.ymZ80) {
    if (e.read) continue;
    if (e.kind === "addr") seen[e.part] = e.byte;
    if (e.time < from || e.time > to) continue;
    // The window opens in the middle of a run, so the latch each part is
    // already holding is stated once — otherwise every DAC write before the
    // first re-latch reads as an address that was lost, which is a property of
    // where the measurement started and not of the engine.
    if (!seeded) {
      seeded = true;
      for (const part of [0, 1]) if (seen[part] !== null)
        stream.push({ cycle: e.time / 15 - 100, port: part, kind: "addr", reg: seen[part] });
    }
    // A data write is attributed to the register that was LATCHED, which is
    // what the chip did with it. The intent is checked separately, against the
    // window — those are two different questions and this is the chip's.
    stream.push({ cycle: e.time / 15, port: e.part, kind: e.kind,
      reg: e.kind === "addr" ? e.byte : seen[e.part] });
  }
  const settle = checkWriteStream(stream.filter((w) => w.reg !== null));
  for (const p of settle.problems.slice(0, 4)) problems.push(p);
  return { dac: dac.length, csm: csm.length, writer, writes: writer.length,
    matched, phase, problems, settle: settle.problems.length,
    busyBefore: Number.isFinite(beforeMin) ? beforeMin : null,
    busyAfter: Number.isFinite(afterMin) ? afterMin : null };
}

// ── The table §59.3 asks for, before anything is built ────────────────────
//
//   node drv/experimental/dac-stream/ym-writer.mjs
//
// Real instructions, assembled for their byte counts and summed from the
// documented cycle counts, against the two numbers the reservation is: 280
// cycles a block and 120 bytes of code.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { buildConfig, ymBudgetCycles, YM_CODE_BUDGET } = await import("./config.mjs");
  const cfg = buildConfig({ voices: 2, complete: true, csm: true, csmHost: true,
    levels: 15, workTarget: 0.839, correctorBudget: true, command: true, ymWriter: true });
  const positions = writerSlots(cfg).length;
  const blocks = cfg.cycleSlots / cfg.blockSamples;
  const perBlock = ymBudgetCycles();
  // How much a b11..b14 slot really has at the ceiling, measured from an image
  // with everything else in it and the writer left out: the slot's own work
  // less the pad the reservation was executing as.
  const probe = generate(buildConfig({ voices: 2, complete: true, csm: true,
    csmHost: true, levels: 15, workTarget: 0.839, correctorBudget: true, command: true }));
  const at = writerSlots(cfg)[0];
  const row = probe.placement.rows[at];
  const slotRoom = Math.floor(0.839 * row.cycles) - (row.work - perBlock / YM_POSITIONS.length);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`the Z80 YM writer, priced (R26 §59.3)`);
  console.log(`  ${positions} opportunities a lap (b11..b14 of ${blocks} blocks),`
    + ` ${perBlock} cyc a block reserved, ${YM_CODE_BUDGET} B of code,`
    + ` ~${slotRoom} cyc of room in one slot at the 83.9% ceiling.`
    + `\n  "prod" is the bytes a PRODUCER writes for each FM write (R27 §61.2).`);
  console.log("");
  console.log(`  ${pad("candidate", 38)}${pad("B", 4)}${pad("cyc", 5)}`
    + `${pad("entry", 7)}${pad("prod", 6)}${pad("4/block", 18)}${pad("sites", 7)}rate`);
  for (const f of FORMS) {
    const b = asmBytes(f.asm);
    const cyc = YM_POSITIONS.length * f.cycles, by = positions * b + 6;
    const four = `${cyc}${cyc > perBlock ? "!" : " "} cyc ${by}${by > YM_CODE_BUDGET ? "!" : " "} B`;
    const sites = Math.min(Math.floor((YM_CODE_BUDGET - 6) / b),
      Math.floor(perBlock / f.cycles) * blocks, f.cycles <= slotRoom ? Infinity : 0);
    console.log(`  ${pad(f.name, 38)}${pad(b, 4)}${pad(f.cycles, 5)}${pad(`${f.queue} B`, 7)}`
      + `${pad(`${f.producerBytes} B`, 6)}${pad(four, 18)}${pad(sites, 7)}`
      + `${(sites * cfg.rateHz / cfg.cycleSlots).toFixed(0)}/s`);
  }
  console.log("  (\"!\" is a number the reservation does not hold)");
  console.log("");
  for (const f of FORMS) console.log(`  ${pad(f.key, 10)}${f.note}`);
  console.log("");
  console.log(`  four writes a block is ${(positions * cfg.rateHz / cfg.cycleSlots).toFixed(1)}/s`
    + ` and needs ${positions * asmBytes(FORMS[0].asm) + 6} B — 1.9x the reservation.`);
  console.log("  A shared routine is not available: `rst` + `ret` is 21 cycles, and the queue"
    + "\n  cursor has nowhere to live but SP, which a call frame destroys.");
}
