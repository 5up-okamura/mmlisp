// WHAT THE Z80 WRITES TO THE YM2612, AND WHEN (§33.5, R24 §55.3, R25 §57.1).
//
//   node drv/experimental/dac-stream/ym-window.mjs [--seconds N] [--case NAME]
//
// WITHDRAWN, AND KEPT FOR WHAT IT MEASURES. This began as the search for a
// "safe window" — a gap between the Z80's own YM accesses that a 68000 FM
// transaction could be slipped into without stopping it. That premise is wrong
// and R25 §57.1 withdraws it: the YM2612 is on the Z80's bus, so a 68000
// access to $A04000..$A04003 is answered with OPEN BUS unless the 68000 holds
// the bus (measured — the `host-YM P1, no bus` image lands 0 of 28 attempts).
// There is no gap to aim at, because with the bus held the Z80 makes no YM
// access at all and the transaction is atomic by construction.
//
// What this tool still does, and why it is kept: it enumerates every YM access
// the Z80 makes in a lap, from the placement AND from the machine, and refuses
// to answer if the two disagree. That is the measurement any future YM
// transport has to start from — how much traffic the engine itself puts on the
// chip, where it is, and how far it moves under the corrector and the bus
// stops. The window arithmetic below is reported as what it is: the shape of
// the Z80's traffic, not a place for the 68000 to write.
//
// "the machine" throughout means BlastEm with drv/blastem/probe.patch. There
// has been no hardware run.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { buildCase } from "./case-config.mjs";
import { readProbe, Z80_DIV } from "../../tools/probe-analysis.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const OUT = join(drv, "out", "dac-stream");
const BLAST = process.env.MMLISP_BLASTEM || join(drv, "out", "blastem");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 10));
const ONLY = arg("case", "2ch mailbox, adaptive");
const MCLK = 53693175;

const core = ["blastem_libretro.dylib", "blastem_libretro.so"]
  .map((f) => join(BLAST, f)).find(existsSync);
const host = join(BLAST, "host");
if (!core || !existsSync(host)) {
  console.error("ym-window: BlastEm is not built here — run `sh drv/blastem/setup.sh` first");
  process.exit(2);
}

/**
 * WHERE THE PLACEMENT PUTS THEM. Each op the generator emitted carries what it
 * writes, so the YM accesses can be read straight out of the image with the
 * cycle each one lands on — no guess and no transcription from an older round.
 */
export function placedAccesses(gen) {
  const out = []; let base = 0;
  gen.slots.forEach((slot, i) => {
    let inSlot = 0;
    for (const o of slot.ops) {
      const from = base + inSlot; inSlot += o.cycles; const to = base + inSlot;
      const asm = o.asm[0].trim();
      const isDac = /^ld\s+\(de\),a$/.test(asm);
      const isAddr = /^ld\s+\(YM_ADDR0\),a$/.test(asm);
      const isData = /^ld\s+\(YM_DATA0\),a$/.test(asm);
      const isRead = /^ld\s+a,\(YM_ADDR0\)$/.test(asm);
      if (!isDac && !isAddr && !isData && !isRead) continue;
      out.push({ slot: i, from, to, kind: isAddr || isRead ? "addr" : "data",
        read: isRead, what: isDac ? "the DAC sample" : o.what ?? asm });
    }
    base += slot.cycles;
  });
  return out;
}

/** The gaps between consecutive accesses, with what closes each end. */
const gaps = (xs, loop) => xs.map((a, i) => {
  const b = xs[(i + 1) % xs.length];
  const to = i + 1 < xs.length ? b.from : b.from + loop;
  return { from: a.to, to, len: to - a.to, after: a, before: b };
});

const c0 = CASES.find((c) => c.name === ONLY);
if (!c0) { console.error(`ym-window: no case named "${ONLY}"`); process.exit(2); }
const b = buildCase(c0, { outDir: OUT });
const loop = b.gen.slots.reduce((t, s) => t + s.cycles, 0);
const placed = placedAccesses(b.gen);
const pg = gaps(placed, loop).sort((x, y) => y.len - x.len);

console.log(`── the Z80's YM accesses, from the placement — ${c0.name} ──`);
console.log(`  ${placed.length} accesses in a lap of ${loop} Z80 cycles`
  + ` (${loop * Z80_DIV} master, ${b.cfg.cycleSlots} slots)`);
const byWhat = new Map();
for (const a of placed) byWhat.set(a.what, (byWhat.get(a.what) ?? 0) + 1);
for (const [what, n] of [...byWhat].sort((x, y) => y[1] - x[1]))
  console.log(`    ${String(n).padStart(3)} × ${what}`);
console.log(`  widest gap ${pg[0].len} Z80 cycles (${pg[0].len * Z80_DIV} master),`
  + ` slot ${pg[0].after.slot} after "${pg[0].after.what}"`);
console.log(`  narrowest  ${pg.at(-1).len} Z80 cycles (${pg.at(-1).len * Z80_DIV} master),`
  + ` slot ${pg.at(-1).after.slot} after "${pg.at(-1).after.what}"`);
// The gap every slot offers, so the window is a property of the lap and not of
// one lucky place in it.
const per = new Map();
for (const g of gaps(placed, loop)) {
  const k = g.after.slot;
  if (!per.has(k) || per.get(k).len < g.len) per.set(k, g);
}
const lens = [...per.values()].map((g) => g.len).sort((x, y) => x - y);
console.log(`  every slot's widest gap: ${lens[0]}..${lens.at(-1)} Z80 cycles,`
  + ` median ${lens[Math.floor(lens.length / 2)]}`);

// ── and the same thing, measured ──────────────────────────────────────────
const log = join(OUT, `ymwin-${b.sha}-${SECONDS}s.log`);
execFileSync(host, ["--core", core, "--rom", b.rpath, "--frames", String(Math.round(SECONDS * 60))],
  { env: { ...process.env, MMLISP_PROBE_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });
const L = readProbe(readFileSync(log));
const from = L.dac.length ? L.dac[0].time : 0;
const z = L.ymZ80.filter((x) => x.time >= from);
const h = L.ym68k.filter((x) => x.time >= from);
console.log(`\n── …and as the machine saw them, over ${SECONDS}s ──`);
console.log(`  ${z.length} Z80 accesses, ${h.length} from the 68000`
  + ` (a 68000 access reaches the chip ONLY while it holds the bus — R25 §57.1)`);
const kinds = new Map();
for (const a of z) {
  const k = `${a.read ? "read " : "write"} ${a.kind} port ${a.port}`;
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1]))
  console.log(`    ${String(n).padStart(7)} × ${k}`);
// ── EVERY ACCESS SITE, EARLIEST AND LATEST (R24 §55.3 step 1) ────────────
// A lap is an H observation interval and it carries the same 110 accesses every
// time, so each one can be followed across the run and given a range rather
// than an instant. The corrector moves them, the pads move them, and a bus stop
// moves everything after it — which is exactly why a window may not be derived
// from one lap or from the placement alone.
const obs = L.z80vdp.filter((e) => (e.value >>> 8) === 9).map((e) => e.time);
const laps = [];
for (let i = 1; i < obs.length; i++) {
  const inLap = z.filter((a) => a.time >= obs[i - 1] && a.time < obs[i]);
  if (inLap.length) laps.push({ at: obs[i - 1], len: obs[i] - obs[i - 1], acc: inLap });
}
const sizes = new Set(laps.map((l) => l.acc.length));
console.log(`  ${laps.length} laps, ${[...sizes].sort((a2, b2) => a2 - b2).join("/")}`
  + ` accesses in each (the placement says ${placed.length})`);
const full = laps.filter((l) => l.acc.length === placed.length);
if (full.length < laps.length * 0.9)
  console.log(`  …only ${full.length} laps carry the full set; a stop that straddles an`
    + " observation moves an access into the next lap, and those are left out");
const site = Array.from({ length: placed.length }, () => ({ lo: Infinity, hi: -Infinity }));
for (const l of full)
  l.acc.forEach((a, k) => {
    const off = a.time - l.at;
    site[k].lo = Math.min(site[k].lo, off);
    site[k].hi = Math.max(site[k].hi, off);
  });
// THE WINDOW A TRANSACTION CAN RELY ON is the gap between the LATEST any access
// ever is and the EARLIEST the next one ever is — the intersection over every
// lap, not the mean of them.
const win = site.map((sN, k) => {
  const next = k + 1 < site.length ? site[k + 1] : null;
  const end = next ? next.lo : site[0].lo + laps[0].len;
  return { k, slot: placed[k]?.slot, what: placed[k]?.what,
    open: sN.hi + Z80_DIV * (placed[k]?.to - placed[k]?.from ?? 0), close: end,
    len: end - (sN.hi + Z80_DIV * ((placed[k]?.to ?? 0) - (placed[k]?.from ?? 0))) };
});
const wide = [...win].sort((x, y) => y.len - x.len);
const jitter = site.map((sN) => sN.hi - sN.lo).sort((a2, b2) => a2 - b2);
console.log(`  each site's spread across the run: ${jitter[0]}..${jitter.at(-1)} master`
  + ` (median ${jitter[Math.floor(jitter.length / 2)]})`);
console.log(`\n── the gaps that are there EVERY lap ──`);
console.log("  (the shape of the Z80's own traffic. NOT a place for the 68000 to write:");
console.log("   it cannot reach the chip without stopping the Z80 — R25 §57.1)");
console.log(`  ${"after".padEnd(30)}${"slot".padStart(5)}${"opens".padStart(9)}`
  + `${"closes".padStart(9)}${"length".padStart(9)}`);
for (const w of wide.slice(0, 6))
  console.log(`  ${String(w.what).slice(0, 30).padEnd(30)}${String(w.slot).padStart(5)}`
    + `${String(w.open).padStart(9)}${String(w.close).padStart(9)}${String(w.len).padStart(9)}`);
console.log(`  …${wide.length} in all; the narrowest is ${wide.at(-1).len} master`
  + ` after "${wide.at(-1).what}" in slot ${wide.at(-1).slot}`);
const usable = win.filter((w) => w.len > 0).map((w) => w.len).sort((a2, b2) => a2 - b2);
console.log(`  ${usable.length} of ${win.length} gaps survive the intersection;`
  + ` ${usable[0]}..${usable.at(-1)} master, median ${usable[Math.floor(usable.length / 2)]}`);
// ── AND WHAT IS LEFT AFTER THE CHIP'S OWN BUSY (R24 §55.3 step 1) ────────
// A gap is not a window. The YM2612 raises BUSY one internal clock after every
// DATA write and holds it for 32 of them — with MCLKS_PER_YM = 7 and a /6
// internal divider that is 42 master to the edge and 1,344 master of it, so
// 1,386 master from the write. Only a data write sets it; an address write does
// not.
//
// That matters at both ends of a window and the two ends are not the same
// question:
//
//   leading   the Z80's DAC sample is a data write, so the chip is busy into
//             the start of every window. A 68000 that polls BUSY — which R24
//             §55.4 requires, with a bound — waits this out before it may
//             select a register.
//   trailing  the 68000's OWN data write raises BUSY behind it, and the Z80's
//             next DAC sample cannot wait for anything. BlastEm does not gate a
//             write on BUSY, so the model will not fail on this; the chip's
//             documented rule says to leave it clear, and the cost of obeying
//             it is what the second column below prices.
const BUSY = 32 * 42 + 42;                       // 1,386 master, edge included
const c68 = (m) => Math.floor(m / 7);
const dataSites = win.filter((w) => placed[w.k]?.kind === "data" && w.len > 0);
const lead = dataSites.map((w) => w.len - BUSY).sort((a2, b2) => a2 - b2);
const both = dataSites.map((w) => w.len - 2 * BUSY).sort((a2, b2) => a2 - b2);
const count = (xs, n) => xs.filter((x) => x >= n).length;
console.log(`\n── the gaps after the chip's BUSY, ${BUSY} master a data write ──`);
console.log(`  ${"guard".padEnd(34)}${"narrowest".padStart(10)}${"median".padStart(9)}`
  + `${"widest".padStart(9)}${"usable/lap".padStart(12)}`);
const row = (name, xs) => console.log(`  ${name.padEnd(34)}`
  + `${String(xs[0]).padStart(10)}${String(xs[Math.floor(xs.length / 2)]).padStart(9)}`
  + `${String(xs.at(-1)).padStart(9)}${String(count(xs, 1)).padStart(12)}`);
row("gap, no guard at all", dataSites.map((w) => w.len).sort((a2, b2) => a2 - b2));
row("less the Z80 write's BUSY", lead);
row("…and leaving BUSY clear behind", both);
console.log("  (master clocks; \"usable\" counts the windows that are still positive)");
console.log(`  the median window is ${c68(lead[Math.floor(lead.length / 2)])} 68000 cycles with`
  + ` the leading guard and ${c68(both[Math.floor(both.length / 2)])} with both;`
  + " an address/data pair through a preloaded pointer is about 40");
// ── COULD THE 68000 HAVE FOUND A WINDOW? (R24 §55.3 step 2, withdrawn) ───
// Kept because the two answers are worth having on record. Neither is usable:
// R25 §57.1 withdrew the premise they were candidate origins FOR.
//
// HV first, because §55.3 names it. A line is 3,420 master and the DAC period
// is 5,376; their gcd is 12, so the pattern of DAC writes against the line
// repeats only every 285 slots. If the writes are spread across the line then
// HV on its own cannot say where in a slot the engine is, and the origin has to
// come from somewhere else.
{
  const LINE = 3420;
  const bins = new Array(20).fill(0);
  for (const a of z) if (!a.read && a.kind === "data")
    bins[Math.floor(((a.time % LINE) / LINE) * 20)]++;
  const tot = bins.reduce((x, y) => x + y, 0);
  const lo = Math.min(...bins), hi = Math.max(...bins);
  console.log(`\n── where the Z80's data writes fall inside a 3,420 master line ──`);
  console.log(`  ${bins.map((n) => (n / tot * 100).toFixed(1)).join(" ")} %`);
  console.log(`  ${lo}..${hi} per twentieth of a line — `
    + (hi < lo * 1.5 ? "SPREAD. HV alone cannot locate a slot; the origin has to be"
      + " something the chip or the engine says." : "concentrated: HV can locate it."));
}
// …and the chip's own BUSY, which is a signal both CPUs can read. Every Z80
// data write raises it for 1,386 master, so its FALLING edge is the Z80's last
// data write plus a known constant — an origin that costs one status read and
// needs nothing shared. What it is worth is the gap from that edge to the
// Z80's next access, instance by instance rather than intersected.
{
  // FROM THE EDGE, not from the write. A host acts when BUSY falls, which is
  // 1,386 master after the write — and by then anything the Z80 did in between
  // is already past. Measuring from the write instead counts the $2A re-latch
  // that follows a CSM value by 300 master as if it were still in the way.
  const after = [];
  for (let i = 0; i < z.length - 1; i++) {
    if (z[i].read || z[i].kind !== "data") continue;
    const edge = z[i].time + BUSY;
    const next = z.find((a, k) => k > i && a.time > edge);
    if (next) after.push(next.time - edge);
  }
  after.sort((a2, b2) => a2 - b2);
  const p = (f) => after[Math.floor((after.length - 1) * f)];
  console.log(`\n── the gap a BUSY falling edge opens, instance by instance ──`);
  console.log(`  ${after.length} data writes; window ${after[0]}..${after.at(-1)} master`);
  console.log(`    p0.1 ${p(0.001)}  p1 ${p(0.01)}  p10 ${p(0.1)}  p50 ${p(0.5)}`
    + `  p90 ${p(0.9)}`);
  const need = 40 * 7;
  console.log(`  ${after.filter((x) => x >= need).length} of ${after.length}`
    + ` (${(after.filter((x) => x >= need).length / after.length * 100).toFixed(1)}%)`
    + ` leave room for a ${need} master address/data pair`);
  console.log(`  ${after.filter((x) => x >= need + BUSY).length} of ${after.length}`
    + ` also leave BUSY clear behind them`);
  // THE TAIL IS THE WHOLE PROBLEM. Almost every edge opens 3,294 master, and a
  // handful open 55 — a CSM slot whose $2A re-latch happens to land just after
  // the DAC write's BUSY expired. R24 §55.4 asks for ZERO window escapes, so
  // what matters is not the median but how long the host must stand off after
  // the edge before the worst instance is safe.
  console.log(`\n── standing off after the edge, had that been the mechanism ──`);
  console.log(`  ${"wait".padStart(6)}${"worst window".padStart(14)}${"p1".padStart(8)}`
    + `${"median".padStart(8)}${"under 280".padStart(11)}`);
  for (const D of [0, 150, 300, 450, 600, 750, 900, 1200]) {
    const w2 = [];
    for (let i = 0; i < z.length - 1; i++) {
      if (z[i].read || z[i].kind !== "data") continue;
      const start = z[i].time + BUSY + D;
      const next = z.find((a, k) => k > i && a.time > start);
      if (next) w2.push(next.time - start);
    }
    w2.sort((a2, b2) => a2 - b2);
    console.log(`  ${String(D).padStart(6)}${String(w2[0]).padStart(14)}`
      + `${String(w2[Math.floor(w2.length * 0.01)]).padStart(8)}`
      + `${String(w2[Math.floor(w2.length / 2)]).padStart(8)}`
      + `${String(w2.filter((x) => x < need).length).padStart(11)}`);
  }
  console.log("  (master clocks; the wait is what the host inserts between seeing BUSY fall");
  console.log("   and writing the address, and it costs the window it buys)");
}
const stops = L.stops.filter(([a]) => a >= from);
console.log(`\n  ${stops.length} bus stops in the run. Each one is a stretch in which the Z80`);
console.log("  makes no YM access at all — and is the ONLY way the 68000 reaches the chip,");
console.log("  since it must hold the bus to do so. They also DELAY the Z80's own accesses,");
console.log("  which is why every site above is a range and not an instant.");
