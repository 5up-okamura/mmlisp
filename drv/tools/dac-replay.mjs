// Does the DAC stream REPLAY?
//
//   node tools/dac-replay.mjs <probe.log>
//
// Every other gate here measures the CLOCK — when a sample went out, how evenly,
// how many were lost. NONE of them looks at WHICH sample went out, and that is
// a whole class of fault they cannot see: a feed reading a stretch of ring the
// mixer never refreshed puts the same bytes on the chip twice, on a perfect
// clock, and every number in this repo stays green.
//
// Written for "the snare goes ta-tan instead of tan" (2026-09-02). It answered
// NO at 3,329 / 4,439 / 6,658 Hz — zero verbatim replays — which is what turned
// the search towards the ring's LEAD, where the fault actually was: at 6,658 Hz
// the fill runs 2-4 frames deep against a sequencer that cancels exactly one,
// so the DAC lags the FM by 17-50 ms and a layered drum doubles.
//
// Keep it. The next content fault will be as invisible as this one was.
import { readFileSync } from "node:fs";
const path = process.argv[2];
const b = readFileSync(path);
const n = (b.length / 8) | 0;
const v = [], t = [];
for (let i = 0; i < n; i++) if (b[i * 8] === 1) { v.push(b[i * 8 + 2]); t.push(b.readUInt32LE(i * 8 + 4)); }
// Skip bring-up.
const t0 = t[0] + 53693175;
let s = 0; while (s < t.length && t[s] < t0) s++;
const W = 24;            // a block this long repeating verbatim is not chance
let hits = 0, first = -1, total = 0;
for (let i = s; i + 2 * W < v.length; i++) {
  let same = true;
  for (let k = 0; k < W; k++) if (v[i + k] !== v[i + W + k]) { same = false; break; }
  if (!same) continue;
  // …and it must not be silence or a flat hold, which repeats legitimately.
  let flat = true;
  for (let k = 1; k < W; k++) if (v[i + k] !== v[i]) { flat = false; break; }
  if (flat) continue;
  hits++; total++;
  if (first < 0) first = i;
  i += W;                // count each replay once
}
const secs = (t[t.length - 1] - t[s]) / 53693175;
console.log(`  ${path}: ${v.length - s} samples over ${secs.toFixed(1)}s`);
console.log(`  verbatim ${W}-sample replays: ${hits}  (${(hits / secs).toFixed(2)} a second)`
  + (first >= 0 ? `  first at sample ${first - s}` : ""));
