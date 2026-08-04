// Level diff — where does the DRIVER play louder than the reference player?
//
// The A/B gate (ab-gate.mjs) answers "did the divergence set change"; this one
// answers the question you actually have when something blasts: *which channel,
// at which frame, is the driver louder than ir-player, and by how much*. It
// reconstructs each player's per-frame level state (FM carrier TL for the
// algorithm in force at that moment, PSG attenuation, PCM shift) and reports
// only the frames where the driver is the louder of the two.
//
//   node tools/level-diff.mjs <song.mmlisp> [--frames N] [--tl N] [--all]
//
//   --frames N  frames to run (default 1800 = 30 s)
//   --hold N    ignore spans shorter than N frames (default 3). A one-frame
//               span is almost always the ±1 frame note-timing skew the two
//               players are allowed (driver.md §12), not a level bug.
//   --tl N      report a carrier that is N or more TL steps louder in the
//               driver (default 4 ≈ 3 dB; one step is 0.75 dB)
//   --all       also list the reverse direction (driver quieter)
//
// Loop points are printed alongside, so "it blasts when it loops" becomes a
// frame number you can line up against the report.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { fmCarrierOpsForAlg, OP_ADDR_OFFSET } from "../../live/src/ir-utils.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const numArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
if (!file) {
  console.error("usage: node tools/level-diff.mjs <song.mmlisp> [--frames N] [--tl N] [--all]");
  process.exit(2);
}
const FRAMES = numArg("--frames", 1800);
const TL_STEPS = numArg("--tl", 4);
const HOLD = numArg("--hold", 3);
const BOTH = args.includes("--all");
const FPS = 60;

// ── Run both players ───────────────────────────────────────────────────────
const src = readFileSync(file, "utf8");
const compiled = compileMMLisp(src, { filename: basename(file) });
const ir = compiled.ir ?? compiled;
const errs = compiled.errors ?? [];
if (errs.length) {
  for (const e of errs) console.error(`compile: ${e.message ?? e}`);
  process.exit(1);
}
const { bytes, diagnostics } = encodeMmb(ir, {});
for (const d of diagnostics ?? []) {
  if (d.severity === "error") console.error(`mmb: ${d.code} ${d.message}`);
}

const drv = new DrvPlayer();
drv.loadMMB(bytes, null);
const dcap = drv.captureRegisterLog({ maxFrames: FRAMES });

const irp = new IRPlayer();
irp.loadJSON(structuredClone(ir));
const icap = irp.captureRegisterLog({ maxSec: FRAMES / FPS });

// ir-player captures ONE pass — intro + loop body — and reports where the loop
// is; the driver actually loops. Comparing them raw makes every iteration after
// the first read as "the driver is louder", which is exactly the frames a loop
// blast lives in. So tile the body the way export-wav.js does: register writes
// are absolute state-sets, so re-emitting the body at +P reproduces the loop
// with no chip reset. Now the loop point itself is inside the comparison.
const irWrites = icap.writes.slice();
let period = null;
if (icap.loopStartSec != null && icap.endSec > icap.loopStartSec) {
  period = icap.endSec - icap.loopStartSec;
  const body = icap.writes.filter((w) => w.sec >= icap.loopStartSec);
  for (let n = 1; n * period * FPS < FRAMES + period * FPS; n++) {
    for (const w of body) irWrites.push({ ...w, sec: w.sec + n * period });
    if (n > 200) break;
  }
}

// ── Per-frame register state, from each log ────────────────────────────────
// Both logs are write streams; levels are STATE, so replay them into a register
// file and sample it once per frame. Same shape for both players, so the only
// thing the comparison can see is a difference in what the chip holds.
function statePerFrame(writes, frameOf) {
  const ym = new Map(); // "port:addr" → value
  const psgAtt = [15, 15, 15, 15];
  let latch = 0;
  const frames = [];
  const sorted = writes
    .map((w) => ({ ...w, f: Math.max(0, Math.round(frameOf(w))) }))
    .sort((a, b) => a.f - b.f);
  let wi = 0;
  for (let f = 0; f < FRAMES; f++) {
    while (wi < sorted.length && sorted[wi].f <= f) {
      const w = sorted[wi++];
      if (w.port === 2) {
        const d = w.data;
        if (d & 0x80) {
          latch = (d >> 5) & 3;
          if (d & 0x10) psgAtt[latch] = d & 0x0f;
        }
        continue;
      }
      if (w.addr === 0x28) continue;
      ym.set(`${w.port}:${w.addr}`, w.data);
    }
    frames.push({ ym: new Map(ym), psg: psgAtt.slice() });
  }
  return frames;
}

const D = statePerFrame(dcap.writes, (w) => w.frame);
const I = statePerFrame(irWrites, (w) => w.sec * FPS);

// Carrier TL of an FM channel under the algorithm the chip holds at that frame.
function carriers(st, ch) {
  const port = ch >= 3 ? 1 : 0;
  const off = ch % 3;
  const b0 = st.ym.get(`${port}:${0xb0 + off}`) ?? 0;
  const out = [];
  for (const op of fmCarrierOpsForAlg(b0 & 7)) {
    out.push({ op, tl: st.ym.get(`${port}:${0x40 + OP_ADDR_OFFSET[op] + off}`) ?? 0 });
  }
  return out;
}

// ── Loop points, for correlation ───────────────────────────────────────────
const loopFrames = new Set();
if (period != null) {
  for (let f = Math.round(icap.endSec * FPS); f < FRAMES; f += Math.round(period * FPS)) {
    loopFrames.add(f);
  }
}
{
  // Also any track whose marker id steps backwards — a `(go …)` inside a part.
  const seen = dcap.markerLog ?? [];
  for (let f = 1; f < seen.length; f++) {
    for (let t = 0; t < seen[f].length; t++) {
      if (seen[f][t] !== seen[f - 1][t] && seen[f][t] < seen[f - 1][t]) loopFrames.add(f);
    }
  }
}

// ── Compare ────────────────────────────────────────────────────────────────
const hits = [];
for (let f = 0; f < FRAMES; f++) {
  for (let ch = 0; ch < 6; ch++) {
    const dc = carriers(D[f], ch);
    const ic = carriers(I[f], ch);
    for (const { op, tl } of dc) {
      const m = ic.find((c) => c.op === op);
      if (!m) continue;
      const delta = m.tl - tl; // positive = driver LOUDER (lower TL)
      if (delta >= TL_STEPS || (BOTH && -delta >= TL_STEPS)) {
        hits.push({
          f,
          who: `fm${ch + 1} op${op + 1}`,
          reg: "TL",
          ir: m.tl,
          drv: tl,
          db: delta * 0.75,
        });
      }
    }
  }
  for (let p = 0; p < 4; p++) {
    const delta = I[f].psg[p] - D[f].psg[p]; // positive = driver louder
    const step = Math.max(1, Math.round(TL_STEPS / 2.67)); // PSG step is 2 dB
    if (delta >= step || (BOTH && -delta >= step)) {
      hits.push({
        f,
        who: p === 3 ? "noise" : `sqr${p + 1}`,
        reg: "att",
        ir: I[f].psg[p],
        drv: D[f].psg[p],
        db: delta * 2,
      });
    }
  }
}

// Collapse runs: one line per (channel, reg, ir, drv) span instead of per frame.
// Group by channel FIRST — hits arrive frame-major, so consecutive frames of one
// channel are not adjacent in the list and a naive scan never merges anything.
const byKey = new Map();
for (const h of hits) {
  const k = `${h.who}|${h.reg}|${h.ir}|${h.drv}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(h);
}
const runs = [];
for (const group of byKey.values()) {
  group.sort((a, b) => a.f - b.f);
  let cur = null;
  for (const h of group) {
    if (cur && h.f === cur.to + 1) cur.to = h.f;
    else {
      cur = { ...h, from: h.f, to: h.f };
      runs.push(cur);
    }
  }
}
runs.sort((a, b) => a.from - b.from);
// A span that lasts one or two frames is the allowed note-timing skew showing up
// as a level difference (one player has keyed off, the other has not yet). What
// a blast looks like is a level that is wrong for the whole note.
const long = runs.filter((r) => r.to - r.from + 1 >= HOLD);
const skipped = runs.length - long.length;
runs.length = 0;
runs.push(...long);

console.log(`${basename(file)} — ${FRAMES} frames, ${dcap.frames} played`);
if (loopFrames.size) {
  const l = [...loopFrames].slice(0, 12).join(" ");
  console.log(`loop points (frames): ${l}${loopFrames.size > 12 ? " …" : ""}`);
}
if (skipped) console.log(`(${skipped} span(s) shorter than ${HOLD} frames ignored — timing skew, not level)`);
if (!runs.length) {
  console.log(`\nNo channel is ${TL_STEPS} TL steps (${(TL_STEPS * 0.75).toFixed(1)} dB) louder in the driver for ${HOLD}+ frames.`);
  console.log("The level divergence is not here — say so and we look at pitch/timing next.");
  process.exit(0);
}
console.log(`\n${runs.length} span(s) where the DRIVER is louder (ir → drv, dB louder):\n`);
console.log("  frames            channel      reg   ir   drv   louder by");
for (const r of runs.slice(0, 40)) {
  const span = r.from === r.to ? `f${r.from}` : `f${r.from}-${r.to}`;
  const near = [...loopFrames].some((l) => r.from >= l && r.from <= l + 3) ? "  ← at a loop point" : "";
  console.log(
    `  ${span.padEnd(17)} ${r.who.padEnd(12)} ${r.reg.padEnd(5)} ${String(r.ir).padStart(3)} ${String(r.drv).padStart(5)}   ${r.db > 0 ? "+" : ""}${r.db.toFixed(1)} dB${near}`,
  );
}
if (runs.length > 40) console.log(`  … ${runs.length - 40} more`);
