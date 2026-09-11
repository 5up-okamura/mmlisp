// THE ONE-VOICE PROFILE'S TEST BANK, HOST SCRIPTS AND REFERENCE (R28 §63.6).
//
// Shared by the JS gate (gate-1v.mjs) and the machine run (machine-probe.mjs),
// so the bank the emulator's cartridge carries is the bank the model's window
// answers from, and the reference that grades one grades the other.
//
// The reference is a block-level state machine written from §63.3 D2: the
// pointer at a block's first sample, its step, the END it parks at, and the
// host's starts and stops as events in time. It reads nothing of the engine's
// state — only the host's own events and the DAC's timestamps.
import { PCM1, PCM1_SILENCE, pcm1Base } from "./config.mjs";
import { mixOne, SILENCE } from "./lut.mjs";
import { PHASE_TABLE } from "./observer.mjs";

// ── The bank, as the Z80 sees it through the window ────────────────────────
// 32 KB. Window address = $8000 + offset. The top page is silence (the parked
// voice reads it); the samples sit below it. The END the host sends is
// `end - 16 * step`, so the engine never reads a byte past a sample's last.
export const BANK = new Uint8Array(0x8000).fill(0x80);
export const SAMPLES = {};
let cursor = 0x0100;
function place(name, bytes) {
  SAMPLES[name] = { at: 0x8000 + cursor, bytes: bytes.length };
  BANK.set(bytes, cursor);
  cursor += bytes.length + 64;
}
place("sine", Uint8Array.from({ length: 1200 }, (_, i) => Math.round(128 + 120 * Math.sin(2 * Math.PI * i / 100)) & 0xff));
place("ramp", Uint8Array.from({ length: 700 }, (_, i) => (i * 3) & 0xff));
place("saw", Uint8Array.from({ length: 2000 }, (_, i) => (i * 7 + 40) & 0xff));
place("short", Uint8Array.from({ length: 40 }, (_, i) => 0x40 + i * 4));
place("long", Uint8Array.from({ length: 12000 }, (_, i) => Math.round(128 + 100 * Math.sin(2 * Math.PI * i / 64) * Math.exp(-i / 6000)) & 0xff));
if (cursor > PCM1_SILENCE - 0x8000) throw new Error("the samples reach the silence page");

/** The END a host sends for a sample played at `step` (§63.3 D2). */
export const endFor = (s, step) => (s.at + s.bytes - 16 * step) & 0xffff;

/** The bytes a host writes to stage a start, in the order it writes them. */
export function startBytes(cfg, s, step, gen) {
  const S = (k) => pcm1Base(cfg) + PCM1[k];
  const end = endFor(s, step);
  return [[S("stSrc"), s.at & 0xff], [S("stSrc") + 1, s.at >> 8],
    [S("stEnd"), end & 0xff], [S("stEnd") + 1, end >> 8],
    [S("stStep"), step], [S("startGen"), gen & 0xff]];
}

// ── The host's pokes: what a 68000 would write between two edges ───────────
// `at` is in Z80 cycles. Every poke lands at slot 16b + 6 of the lap — block
// position b8 with a lead of 18, four slots clear of the edge pieces either
// side — so which edge sees it is never in doubt.
export function hostScript(kind, cfg, cycles) {
  const blockCy = cfg.blockSamples * cfg.periodCycles;
  const S = (k) => pcm1Base(cfg) + PCM1[k];
  const ev = [];
  let sgen = 0, pgen = 0;
  const mid = (b) => Math.round((b + 0.4) * blockCy);
  const start = (b, name, step) => {
    const s = SAMPLES[name];
    const at = mid(b);
    sgen = (sgen + 1) & 0xff;
    ev.push({ at, kind: "start", src: s.at, end: endFor(s, step), step, gen: sgen, seq: ev.length, name });
    return startBytes(cfg, s, step, sgen).map(([addr, value]) => ({ at, addr, value }));
  };
  const stop = (b) => {
    const at = mid(b);
    pgen = (pgen + 1) & 0xff;
    ev.push({ at, kind: "stop", gen: pgen, seq: ev.length });
    return [{ at, addr: S("stopGen"), value: pgen }];
  };
  const pokes = [];
  const blocks = Math.floor(cycles / blockCy) - 4;
  if (kind === "shot") pokes.push(...start(4, "sine", 1));
  if (kind === "steps") for (const [b, st] of [[3, 1], [90, 2], [150, 4], [190, 8]]) pokes.push(...start(b, "sine", st));
  if (kind === "stop") { pokes.push(...start(3, "saw", 1)); pokes.push(...stop(40)); pokes.push(...start(60, "saw", 2)); pokes.push(...stop(100)); }
  if (kind === "restart") { pokes.push(...start(3, "saw", 1)); pokes.push(...start(20, "ramp", 1)); pokes.push(...start(24, "sine", 2)); }
  if (kind === "short") for (let b = 3; b < blocks; b += 7) pokes.push(...start(b, "short", (b % 3) ? 1 : 2));
  if (kind === "roll") for (let b = 3; b < blocks; b += 3) pokes.push(...start(b, b % 2 ? "ramp" : "sine", 1 << (b % 4)));
  if (kind === "levels") {
    pokes.push(...start(2, "saw", 1));
    for (let b = 3, n = 0; b < blocks; b += 5, n++) {
      if (b % 30 === 3) pokes.push(...start(b, "saw", 1));
      const at = mid(b) + 300;
      const L = cfg.levels, page = cfg.ram.lut[0] >> 8;
      pokes.push({ at, addr: S("level"), value: page + (n % L) });
      pokes.push({ at, addr: S("master"), value: page + (L - 1 - (n % L)) });
    }
  }
  return { pokes: pokes.sort((a, b) => a.at - b.at), events: ev };
}

// ── The reference (§6.1: independent of the assembly) ─────────────────────
/**
 * @param events  the host's starts and stops, each with an `at` in Z80 cycles
 *                (or master clocks — the same unit as `dac`) and a `seq`
 * @param dac     the DAC write times, one per output sample, same unit
 * @param edges   the level pages the engine was seen to read at each edge, or
 *                null for a run whose levels never move
 */
export function reference(cfg, src, events, dac, edges = null, { signed = !!cfg.signedSource } = {}) {
  const B = cfg.blockSamples, L = cfg.levels, lead = cfg.lead;
  const blockCount = Math.ceil(dac.length / B) + 2;
  const state = [];
  let ptr = PCM1_SILENCE, step = 1, end = 0;
  // Events are consumed in ORDER, not by generation value: the generation is a
  // byte and wraps at 256, which is what the Z80's `cp` handles and a JS `>` on
  // the raw value does not (found at event 256 of the roll case).
  let seenStart = -1, seenStop = -1;
  for (let K = 0; K < blockCount; K++) {
    if (K < 2) { state.push({ ptr, step, end }); continue; }
    // Block K's edge pieces: STOP in slot 16K-lead-3, COMPARE -2, PARK -1,
    // START in slot 16K-lead (before that slot's mix).
    const stopAt = dac[B * K - lead - 3], startAt = dac[B * K - lead];
    if (stopAt === undefined || startAt === undefined) { state.push({ ptr, step, end }); continue; }
    let start = null;
    for (const e of events) {
      if (e.kind === "stop" && e.at < stopAt && e.seq > seenStop) { seenStop = e.seq; end = 0; }
      if (e.kind === "start" && e.at < startAt && e.seq > seenStart) { seenStart = e.seq; start = e; }
    }
    const cmp = (ptr + 15 * step) & 0xffff;
    const park = cmp >= end;
    let next = park ? PCM1_SILENCE : (ptr + 16 * step) & 0xffff;
    if (start) { next = start.src; step = start.step; end = start.end; }
    ptr = next;
    state.push({ ptr, step, end });
  }
  // The shipped image boots at level 0 (silence until a start); test images at unity.
  const boot = { v0: cfg.production ? 0 : L - 1, master: L - 1 };
  return (i) => {
    if (i < lead) return SILENCE;
    const K = Math.floor(i / B);
    const s = state[K];
    const a = (s.ptr + (i % B) * s.step) & 0xffff;
    if (a < 0x8000) throw new Error(`reference: sample ${i} reads RAM at $${a.toString(16)}`);
    const e = !edges || K < 2 ? boot : edges[K - 2] ?? edges[edges.length - 1] ?? boot;
    return mixOne(src[a - 0x8000], e.v0, e.master, L, signed);
  };
}

// ── A synthetic VDP H counter for the JS machine ───────────────────────────
// The decoder's table maps a raw H byte to a phase unit inside the 3,420-master
// line; inverted, it gives an H byte for any master time. A machine handed this
// sees H advance exactly as the real line clock would, so the corrector finds
// nothing to correct and stays quiet — which is the state the JS gate wants
// the PCM pieces graded in. A constant H, by contrast, is a phantom the
// corrector chases for the whole run.
export function syntheticH() {
  const q = PHASE_TABLE.quantised;
  const inverse = new Array(q.units).fill(-1);
  q.bytes.forEach((u, h) => { if (u !== q.unknown && inverse[u] < 0) inverse[u] = h; });
  for (let u = 0; u < q.units; u++) if (inverse[u] < 0) inverse[u] = inverse[(u + 1) % q.units];
  const line = PHASE_TABLE.mode.lineMaster;
  return (addr, cycle) => {
    if ((addr & 0xff) !== 0x09) return 0x00;     // V: not modelled here
    const master = cycle * 15;
    const u = Math.floor((master % line) / q.unit) % q.units;
    return inverse[u];
  };
}
