// A channel's modulators do not outlive its owner (docs/driver.md §2.2, §2.5).
//
//   node tools/claim-gate.mjs [--pal]
//
// WHY THIS IS NOT THE c-gate. That gate compares the C sequencer against
// drv-player.js, so a rule both of them get wrong passes it — and this rule was
// wrong in both for as long as it existed (driver-decisions.md §6). What a
// leak looks like is not a disagreement between the players; it is register
// traffic that the music never asked for. So each case here is a score and a
// TWIN: the same score with the modulators removed. Over the window where the
// modulators must not be heard, the two slot streams have to be identical, and
// any leak is bytes in one that are not in the other.
//
// The windows are half-open [from, to) in rendered frames, and they stop where
// the two scores are *supposed* to part company — a restored part's macro
// really does come back, and a channel a sweep has moved really does stay
// where it left it.
//
// ONE WINDOW SERVES BOTH VIDEO STANDARDS. The claims are host commands, so they
// land on the frame the schedule names whatever the clock; the effect that ends
// them is a musical length, so it is 30 frames at 60 Hz and 25 at 50 Hz. The
// windows are therefore cut to whichever bound is tighter — a steal window that
// ends before the PAL restore, a restore window that opens after the NTSC one.
// Writing the scores in `Nf` instead would align the two exactly, but it would
// also make them PAL tests, which they are not (tools/pal-gate.mjs).
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb, remapTrackChannels } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const tests = join(here, "..", "tests");
const pal = process.argv.includes("--pal");
const frameHz = pal ? 50 : 60;
// The schedules put the claim at frame 40 on the NTSC clock; on PAL the same
// frame numbers are the same frames (a host schedule is frames, not beats), so
// the windows hold for both.
const CASES = [
  {
    score: "p3-claim-evict",
    from: 41, to: 120,
    what: "an evicted track's macro and sweep stop at the eviction",
  },
  {
    score: "p3-claim-se-in",
    from: 41, to: 64,   // the effect ends at f65 on PAL, f71 on NTSC
    what: "a displaced part's macro and sweep do not play the effect",
  },
  {
    score: "p3-claim-se-out",
    from: 74, to: 130,  // opens after the NTSC restore, the later of the two
    what: "an effect's macro and sweep do not play the restored part",
  },
];
const MAX_FRAMES = 140;

function slots(stem) {
  const path = join(tests, `${stem}.mmlisp`);
  const { bytes: mmb, sampleBank, diagnostics } = buildMmb(path, { frameHz });
  for (const d of diagnostics ?? []) {
    if (d.severity === "error") throw new Error(`${stem}: ${d.code}: ${d.message}`);
  }
  // Both halves of a pair run the same schedule: it belongs to the case, not
  // to the file, so the twin carries no sidecar of its own.
  const sidecar = JSON.parse(readFileSync(join(tests, `${stem.replace(/-twin$/, "")}.cmds.json`), "utf8"));
  if (sidecar.remapChannels) remapTrackChannels(mmb, sidecar.remapChannels);
  const drv = new DrvPlayer();
  drv.loadMMB(mmb, sampleBank);
  return drv.captureSlotLog({
    maxFrames: MAX_FRAMES, commands: sidecar.commands ?? [],
    autoStart: sidecar.autoStart !== false, builder: new SlotBuilder(),
  }).slots;
}

const hex = (s) => Array.from(s).map((x) => x.toString(16).padStart(2, "0")).join(" ");
let failures = 0;
for (const c of CASES) {
  const a = slots(c.score);
  const b = slots(`${c.score}-twin`);
  const leaked = [];
  for (let f = c.from; f < c.to; f++) {
    const x = a[f] ?? new Uint8Array(0), y = b[f] ?? new Uint8Array(0);
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) leaked.push(f);
  }
  if (!leaked.length) {
    console.log(`ok    ${c.score} — ${c.what} (f${c.from}..${c.to})`);
    continue;
  }
  failures++;
  const f = leaked[0];
  console.log(`FAIL  ${c.score} — ${c.what}`);
  console.log(`      ${leaked.length} frames of traffic the music never asked for, from f${f}:`);
  console.log(`        score: ${hex(a[f] ?? [])}`);
  console.log(`        twin : ${hex(b[f] ?? [])}`);
}
console.log(`\n${CASES.length - failures} passed · ${failures} failed${pal ? " (PAL)" : ""}`);
if (failures) process.exit(1);
