// Batched-flush differential (v0.6 §4.7). Proves the drv-player batched write
// path (_batchYm) is audibly transparent: for every corpus score, the per-frame
// FINAL register state is byte-identical to the inline change-only path — only
// the write count differs (fewer chip writes / BUSY-waits). This is the gate
// the eventual Z80 batched flush must also satisfy.
//
//   node batch-diff.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb } from "../../live/src/export-mmb.js";
import { DrvPlayer } from "../../live/src/drv-player.js";

const here = dirname(fileURLToPath(import.meta.url));
const tests = join(here, "..", "tests");
const examples = join(here, "..", "..", "examples", "source");

// A write log → per-(port:addr) value at the end of each frame.
function frameFinal(writes, N) {
  const state = new Map(), tl = new Map();
  let f = 0;
  const snap = () => {
    for (const [k, v] of state) {
      if (!tl.has(k)) tl.set(k, []);
      const a = tl.get(k);
      while (a.length <= f) a.push(a.length ? a[a.length - 1] : null);
      a[f] = v;
    }
  };
  for (const w of writes) {
    while (f < w.frame) { snap(); f++; }
    state.set(w.port + ":" + w.addr, w.data);
  }
  snap();
  return tl;
}

function capture(bytes, batch) {
  const p = new DrvPlayer();
  p._batchYm = batch;
  p.loadMMB(bytes);
  return p.captureRegisterLog({ maxFrames: 2000 });
}

const scores = [
  join(examples, "ab-core.mmlisp"),
  ...readdirSync(tests).filter((f) => f.endsWith(".mmlisp")).map((f) => join(tests, f)),
];

let totalDiffs = 0, savedTotal = 0, inlineTotal = 0;
for (const path of scores) {
  const name = path.split("/").pop();
  const { ir, diagnostics } = compileMMLisp(readFileSync(path, "utf8"));
  if ((diagnostics || []).some((d) => d.severity === "error")) { console.log("skip  " + name); continue; }
  const { bytes } = encodeMmb(ir);
  const inl = capture(bytes, false);
  const bat = capture(bytes, true);
  const N = Math.max(...inl.writes.map((w) => w.frame), ...bat.writes.map((w) => w.frame)) + 1;
  const ta = frameFinal(inl.writes, N), tb = frameFinal(bat.writes, N);

  let diffs = 0, ex = "";
  for (const k of new Set([...ta.keys(), ...tb.keys()])) {
    const [port, addr] = k.split(":").map(Number);
    if (port === 0 && addr === 0x28) continue; // $28 key register is edges, not state
    const a = ta.get(k) || [], b = tb.get(k) || [];
    for (let f = 1; f < N; f++) {
      if ((a[f] ?? null) !== (b[f] ?? null)) {
        diffs++;
        if (diffs <= 3) ex += ` [${port}:$${addr.toString(16)} f${f} inline=${a[f]} batched=${b[f]}]`;
      }
    }
  }
  const isYm = (w) => w.port < 2 && w.addr !== 0x28 && w.addr !== 0x2a;
  const nInl = inl.writes.filter(isYm).length, nBat = bat.writes.filter(isYm).length;
  inlineTotal += nInl; savedTotal += nInl - nBat;
  const pct = nInl ? Math.round((1 - nBat / nInl) * 100) : 0;
  if (diffs) { console.log(`FAIL  ${name.padEnd(22)} ${diffs} frame-final diffs${ex}`); totalDiffs += diffs; }
  else console.log(`ok    ${name.padEnd(22)} ${nInl}→${nBat} YM writes (${pct}% fewer)`);
}

console.log("");
if (totalDiffs === 0) {
  console.log(`BATCH DIFF OK — frame-final state identical on all scores; ` +
    `${savedTotal}/${inlineTotal} YM writes saved (${Math.round((savedTotal / inlineTotal) * 100)}%).`);
} else {
  console.log(`BATCH DIFF FAILED — ${totalDiffs} frame-final divergences.`);
  process.exit(1);
}
