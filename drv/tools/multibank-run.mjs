import { Machine } from "./machine.mjs";
import { MultibankModel } from "./multibank-model.mjs";
import { analyzeTime, analyzeWrites } from "../engine/analyze.mjs";
import { PCMN_L, pcm1Base } from "../engine/config.mjs";

// Same sixteen-pair, once-per-video-frame supply limit as the production host.
// No BUSREQ time is invented here: real bus stops are measured on BlastEm.
export function runMultibank(built, rom, items, { seconds = 2, fault = null } = {}) {
  const { cfg, gen } = built;
  const fifo = cfg.ram.fifo[0], fifoLo = pcm1Base(cfg) + PCMN_L.fifoLo;
  const m = new Machine(cfg, built, { rom, bankedRom: fault !== "bank",
    watch: Array.from({ length: 256 }, (_, i) => fifo + i) });
  if (fault === "high-bank") {
    const read = m.read.bind(m);
    m.read = (a) => {
      if (a >= 0x8000) { m.windowReads++; return rom[(m.bank & 255) * 0x8000 + a - 0x8000] ?? 255; }
      return read(a);
    };
  }
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  const queue = items.slice().sort((a, b) => a.frame - b.frame)
    .flatMap((it) => it.pairs.map((pair) => ({ frame: it.frame, pair })));
  let q = 0, head = null, frame = 0;
  const written = [];
  m.host = { every: cfg.frameCycles, fn: (ram) => {
    frame++;
    const tail = ram[fifoLo] >> 1;
    if (head === null || ((head - tail) & 127) > 64 || head === tail) head = (tail + 48) & 127;
    const room = Math.max(0, 128 - ((head - tail) & 127) - 1);
    const writes = [];
    for (let i = 0; i < Math.min(16, room) && q < queue.length && queue[q].frame <= frame; i++) {
      const [op, value] = queue[q++].pair;
      writes.push([fifo + 2 * head, op], [fifo + 2 * head + 1, value]);
      written.push([op, value]); head = (head + 1) & 127;
    }
    return writes;
  } };
  m.hostNext = dac0 + cfg.frameCycles;
  m.run(dac0 + seconds * cfg.z80Hz);
  const fail = [], time = analyzeTime(m.trace, cfg);
  if (time.gapMin !== cfg.periodCycles || time.gapMax !== cfg.periodCycles)
    fail.push(`TIME intervals ${time.gapMin}..${time.gapMax}, expected ${cfg.periodCycles}`);
  if (time.holes.length) fail.push(`TIME ${time.holes.length} holes`);
  const consumed = new Map();
  // Slot attribution uses measured DAC times even in a deliberately mistimed image.
  let s = 0;
  for (const [cycle, addr, value] of m.trace.globRead) {
    if (cycle < dac0) continue;
    while (s + 1 < m.trace.dacCycle.length && m.trace.dacCycle[s + 1] <= cycle) s++;
    if (s >= m.trace.dacCycle.length - 1) continue;
    if (!consumed.has(s)) consumed.set(s, [null, null]);
    consumed.get(s)[(addr - fifo) & 1] = value;
  }
  const allowed = new Set(gen.sites.map((x) => x.a));
  for (const [slot, pair] of consumed)
    if (!allowed.has(slot % cfg.cycleSlots) || pair.includes(null)) { fail.push(`PAIRS malformed read at slot ${slot}`); break; }
  const sent = written.filter((p) => p[0]), read = [...consumed.values()].filter((p) => p[0]);
  if (q !== queue.length || JSON.stringify(sent) !== JSON.stringify(read)) fail.push("PAIRS lost, reordered or undrained commands");
  const ref = new MultibankModel(gen, rom);
  const reference = new Uint8Array(m.trace.dacValue.length);
  let diffs = 0;
  for (let slot = 0; slot < reference.length; slot++) {
    reference[slot] = ref.slot(consumed.get(slot));
    if (reference[slot] !== m.trace.dacValue[slot] && diffs++ < 3)
      fail.push(`VALUE slot ${slot}: got ${m.trace.dacValue[slot]}, expected ${reference[slot]}`);
  }
  if (diffs > 3) fail.push(`VALUE ${diffs} bytes differ`);
  for (let v = 0; v < cfg.voices; v++) {
    const intents = items.filter((i) => i.intent?.v === v).map((i) => i.intent);
    const got = ref.log.filter((i) => i.v === v).map(({ slot, ...i }) => i);
    if (JSON.stringify(intents) !== JSON.stringify(got)) fail.push(`INTENT voice ${v}: ${JSON.stringify(got).slice(0,240)}`);
  }
  const writes = analyzeWrites(m.trace, cfg);
  fail.push(...writes.problems.slice(0, 3).map((p) => `WRITES ${p}`));
  if (m.trace.stray.length) fail.push(`STRAY ${m.trace.stray.length} writes`);
  return { fail, time, machine: m, reference, log: ref.log, consumed,
    pairs: read.length, diffs, bankWrites: m.trace.bank.length };
}
