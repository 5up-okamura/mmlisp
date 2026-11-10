#!/usr/bin/env node
// A track's loop, several passes of it: the IR preview against the
// MMLispDRV reference. The A/B gate (drv ab-gate) compares one pass; what a
// sweep does when its track comes round — one written in the loop starts
// over, one from before it runs on through (driver.md §4 step 3) — shows only
// from the second.
//
//   cd tools && npm run check:loops
//
// Each case plays six seconds on both (the preview on a clock stepped by
// hand, as Live runs it) and compares a register's value frame by frame,
// a frame's slack either way.
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { encodeMmb } from "../../live/src/export-mmb.js";

const SECS = 6;
function parts(src, port, addr) {
  const { ir, diagnostics } = compileMMLisp(src, "loops.mmlisp", {});
  const errs = diagnostics.filter((d) => d.severity === "error");
  if (errs.length) throw new Error(errs.map((d) => d.message).join("; "));
  const w = [];
  const ctx = { currentTime: 10, state: "running", resume() {} };
  const p = new IRPlayer((pt, a, d, when) => { if (typeof pt !== "object" && pt === port && a === addr) w.push([when ?? ctx.currentTime, d]); });
  p.loadJSON(ir);
  p.play(ctx);
  for (let t = 10; t < 10 + SECS + 0.5; t += 0.01) {
    ctx.currentTime = t;
    clearTimeout(p._schedulerTimer);
    p._scheduleLoop();
    clearTimeout(p._schedulerTimer);
  }
  p.stop();
  w.sort((a, b) => a[0] - b[0]);
  const irAt = (f) => { let v = null; for (const [t, d] of w) { if (Math.round((t - 10.05) * 60) > f) break; v = d; } return v; };
  const d = new DrvPlayer();
  d.loadMMB(encodeMmb(ir).bytes);
  const dw = d.captureRegisterLog({ maxFrames: SECS * 60 + 5 }).writes.filter((x) => x.port === port && x.addr === addr);
  const drvAt = (f) => { let v = null; for (const x of dw) { if (x.frame > f) break; v = x.data; } return v; };
  let n = 0;
  for (let f = 2; f <= SECS * 60; f++) if (irAt(f - 1) !== drvAt(f) && irAt(f) !== drvAt(f) && irAt(f + 1) !== drvAt(f)) n++;
  return n;
}

const TL4 = [0, 0x4c], FB = [0, 0xb0], FNUM = [0, 0xa0];
const CASES = [
  ["a one-shot :vol sweep longer than its loop starts over each pass", `(fm1 :tempo 120 :len 4 #top :vol (linear 31..0 :len 2/1) c c (go top))`, TL4],
  ["a loop curve in the loop starts over each pass", `(fm1 :tempo 120 :len 4 #top :vol (sin 31..11 :len 90f) c c c (go top))`, TL4],
  ["a sweep from before the loop runs on through it", `(fm1 :tempo 120 :len 4 :vol (linear 31..0 :len 2/1) #top c c (go top))`, TL4],
  ["a loop curve from before the loop runs on", `(fm1 :tempo 120 :len 4 :vol (sin 31..11 :len 50f) #top c c c (go top))`, TL4],
  ["a :master sweep on another track's loop", `(fm1 :tempo 120 :len 4 #top c c (go top))\n(fm2 :len 4 #top :master (linear 31..8 :len 2/1) c c c (go top))`, TL4],
  ["a register word's sweep in the loop", `(fm1 :tempo 120 :len 4 #top :fb (linear 0..7 :len 2/1) c c (go top))`, FB],
  ["a pitch sweep from before the loop", `(fm1 :tempo 120 :len 4 :pitch (linear 0..300 :len 2/1) #top c c (go top))`, FNUM],
  ["a glide in the loop", `(fm1 :tempo 120 :len 4 #top c (glide 8) e g (go top))`, FNUM],
];
let failed = 0;
for (const [name, src, [port, addr]] of CASES) {
  let n;
  try { n = parts(src, port, addr); } catch (e) { n = e.message; }
  if (n !== 0) { failed++; console.error(`FAIL ${name}: ${typeof n === "number" ? `${n} frames part from the driver` : n}`); }
}
if (failed) process.exit(1);
console.log(`check:loops ok — ${CASES.length} cases, ${SECS} s each, the preview's passes are the driver's`);
