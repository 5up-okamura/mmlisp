// PAL gate — a score baked for 50 Hz is the SAME MUSIC as the one baked for
// 60 Hz (driver.md §3.3).
//
// The driver never reads a frame rate: it counts frames and takes every number
// from the stream, so "PAL support" is entirely a property of what the
// exporter bakes. That makes it invisible to every other gate — c-gate compares
// one stream against itself, and ab-gate compares against ir-player, which only
// previews NTSC. This gate is the one that can see it.
//
// The claim is checked at one of two strengths, because a score can carry
// machinery that is counted in FRAMES by design:
//
//   **strict** — a score with no macro and no sweep. The ordered sequence of
//   (port, addr, data) must be IDENTICAL between the two bakes, and write i
//   must land at the same wall-clock time (frame_ntsc/60 vs frame_pal/50).
//   Same notes, same values, same moment. This is what "the tempo is
//   corrected" means, as against the SMPS behaviour of running 17% slow on a
//   PAL console.
//
//   **frames** — a score whose durations are all written as `Nf`. Then BOTH
//   compiles produce the same music on the same FRAME numbers, 20% longer in
//   wall-clock time on PAL — which is what a frame count is for. The gate
//   recognises it by the tick timeline coming out scaled by exactly 6/5, and
//   then requires the playback to agree frame for frame, not second for
//   second. m4-pal-frames and m4-pal-sweep are the two halves of §3.3.
//
//   **gesture** — a score whose only frame-counted machinery is sweeps, and
//   every one of them written in MUSICAL time. Their intermediate values are
//   re-sampled (a 120-frame glide becomes 100), so the sequences diverge; but
//   each sweep is a continuous run of writes to one register, and that run
//   must START and END at the same wall-clock moment. This is what catches a
//   sweep length left on the 60 Hz conversion — the run then ends 20% late,
//   which the span check cannot see because the song still lasts as long.
//
//   **span** — a score with a macro, or with a sweep written in frames. `Nf`
//   means frames on both standards (language.md §6), and a curve is
//   PRE-SAMPLED into frames at export, so a `:step 1/16` envelope is 8 NTSC
//   frames and 6 PAL ones: the two bakes genuinely emit different values at
//   different moments, and that is the decision, not a defect. What must still
//   hold is that the music occupies the same wall-clock time.
//
// The strength is inferred from the score, which is convenient for the corpus
// but useless for the two scores that exist to PIN a rule: a regression there
// would quietly re-classify itself and pass. Those carry a `<score>.pal.json`
// naming the strength they must be checked at, and a mismatch is a failure.
//
//   node tools/pal-gate.mjs [score.mmlisp …] [--frames N]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb, MACRO_ARG_KEYS } from "../../live/src/export-mmb.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { FRAME_HZ_NTSC, FRAME_HZ_PAL } from "../../live/src/ir-utils.js";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "tests");

// One frame of the slower clock. Both bakes round their frame counts
// independently (the increment once, each macro/sweep length once), so a write
// can land a frame either side of its ideal time; it may not drift further.
const TOL_SECS = 1 / FRAME_HZ_PAL;

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
let scores = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fIdx = process.argv.indexOf("--frames");
const NTSC_FRAMES = fIdx >= 0 ? Number(process.argv[fIdx + 1]) : 400;
if (fIdx >= 0) scores = scores.filter((s) => s !== process.argv[fIdx + 1]);
if (!scores.length) {
  scores = readdirSync(testDir)
    .filter((f) => f.endsWith(".mmlisp"))
    .sort()
    .map((f) => join(testDir, f));
}

function render(src, name, frameHz, frames) {
  const { ir, diagnostics } = compileMMLisp(src, name, { frameHz });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`${errors[0].code}: ${errors[0].message}`);
  const { bytes } = encodeMmb(ir);
  const drv = new DrvPlayer();
  drv.loadMMB(bytes);
  return { ir, writes: drv.captureRegisterLog({ maxFrames: frames }).writes, bytes };
}

// Does this score drive anything on the FRAME clock? Three things do, and all
// three are frames by the same decision (language.md §6, `Nf` is frames on both
// standards) rather than by accident:
//   - a sweep, whose length the exporter converts to a whole number of frames;
//   - a macro, whose curve is PRE-SAMPLED into frames at export (it rides on a
//     NOTE_ON under one of a dozen arg names, so the gate asks the exporter's
//     own MACRO_ARG_KEYS rather than keeping a second list that could drift);
//   - `$time`, which IS the frame counter (driver.md §6.4).
// For these the two bakes land their intermediate values on different frames,
// so the strict comparison does not apply.
// Did compiling for the two standards scale the WHOLE tick timeline by 6/5?
// That happens only when every duration came from an `Nf`: a tick-written one
// is the same number on both. Per-note rounding accumulates, so the comparison
// is approximate; a score mixing the two matches neither and stays on `span`.
function timelineScaledBySixFifths(irA, irB) {
  const ticks = (ir) => (ir.tracks ?? []).flatMap((t) => (t.events ?? []).map((e) => e.tick));
  const a = ticks(irA);
  const b = ticks(irB);
  if (a.length !== b.length) return false;
  let moved = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0 && b[i] === 0) continue;
    const want = (a[i] * FRAME_HZ_NTSC) / FRAME_HZ_PAL;
    if (Math.abs(b[i] - want) > 2 + want * 0.01) return false;
    if (b[i] !== a[i]) moved = true;
  }
  return moved;
}

// Which of the strengths a score is checked at.
function tierOf(ir) {
  let sweeps = 0;
  let frameAuthored = false;
  for (const track of ir.tracks ?? []) {
    for (const ev of track.events ?? []) {
      for (const [k, v] of Object.entries(ev.args ?? {})) {
        if (v === "$time") return "span";
        // A macro's `:len` is already frames by the time it reaches the IR
        // (the compiler resolves it at the note's tempo), so the IR cannot say
        // which were written as ticks — a macro always means the span check.
        if (v != null && MACRO_ARG_KEYS.has(k)) return "span";
      }
      if (ev.cmd === "CSM_RATE" && ev.args?.to != null) return "span";
      if (String(ev.cmd).includes("SWEEP")) {
        sweeps++;
        // A sweep keeps its `lenFrames` flag, so here the distinction survives.
        if (ev.args?.lenFrames) frameAuthored = true;
      }
    }
  }
  if (!sweeps) return "strict";
  return frameAuthored ? "span" : "gesture";
}

// Split one register's writes into the continuous gestures they make: a sweep
// samples every frame, so anything separated by more than a few frames of
// quiet is a different gesture. Times are wall-clock, which is the whole point.
function runsOf(writes, frameHz) {
  const GAP_SECS = 0.1;
  const runs = [];
  let cur = null;
  for (const w of writes) {
    const t = w.frame / frameHz;
    if (cur && t - cur.end <= GAP_SECS) cur.end = t;
    else runs.push((cur = { start: t, end: t }));
  }
  return runs;
}

// Every gesture on every register starts and ends at the same moment.
function gestureDiff(a, b, frameHzA, frameHzB, tol) {
  const key = (w) => `${w.port}:${w.addr}`;
  const group = (writes) => {
    const m = new Map();
    for (const w of writes) {
      if (!m.has(key(w))) m.set(key(w), []);
      m.get(key(w)).push(w);
    }
    return m;
  };
  const A = group(a);
  const B = group(b);
  for (const [k, wa] of A) {
    const wb = B.get(k) ?? [];
    const ra = runsOf(wa, frameHzA);
    const rb = runsOf(wb, frameHzB);
    if (ra.length !== rb.length) {
      return `register ${k} makes ${ra.length} continuous gestures on NTSC and ${rb.length} on PAL`;
    }
    for (let i = 0; i < ra.length; i++) {
      for (const edge of ["start", "end"]) {
        const d = Math.abs(ra[i][edge] - rb[i][edge]);
        if (d > tol) {
          return `register ${k} gesture ${i} ${edge}s at ${ra[i][edge].toFixed(3)} s on `
            + `NTSC but ${rb[i][edge].toFixed(3)} s on PAL`;
        }
      }
    }
  }
  return null;
}

let failed = 0;
for (const score of scores) {
  const name = basename(score);
  const src = readFileSync(score, "utf8");
  let ntsc, pal;
  try {
    ntsc = render(src, name, FRAME_HZ_NTSC, NTSC_FRAMES);
    // The same music occupies 5/6 as many frames at 50 Hz.
    pal = render(src, name, FRAME_HZ_PAL, Math.ceil((NTSC_FRAMES * FRAME_HZ_PAL) / FRAME_HZ_NTSC));
  } catch (e) {
    console.log(`FAIL  ${name} — ${e.message}`);
    failed++;
    continue;
  }

  if ((pal.bytes[6] & 0x02) === 0 || (ntsc.bytes[6] & 0x02) !== 0) {
    console.log(`FAIL  ${name} — PAL_TIMEBASE header flag is not set as baked`);
    failed++;
    continue;
  }

  let tier = tierOf(ntsc.ir);
  // An all-`Nf` score keeps its frame numbers instead of its wall-clock times,
  // so it is compared on the other axis. Only a score with no other
  // frame-counted machinery can make that claim cleanly.
  if (tier === "strict" && timelineScaledBySixFifths(ntsc.ir, pal.ir)) tier = "frames";

  // A score that exists to pin a rule says which strength it must be met at.
  const pinPath = score.replace(/\.mmlisp$/, ".pal.json");
  const pinned = existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, "utf8")).tier : null;
  if (pinned && pinned !== tier) {
    console.log(
      `FAIL  ${name} — pinned as "${pinned}" but the score now reads as "${tier}": ` +
        `the rule it exists to check no longer applies to it`,
    );
    failed++;
    continue;
  }
  const sampled = tier !== "strict";
  const n = Math.min(ntsc.writes.length, pal.writes.length);
  let worst = 0;
  let bad = null;
  let agreed = n;
  for (let i = 0; i < n; i++) {
    const a = ntsc.writes[i];
    const b = pal.writes[i];
    if (a.port !== b.port || a.addr !== b.addr || a.data !== b.data) {
      agreed = i;
      if (!sampled) {
        bad = `write ${i}: NTSC p${a.port} $${a.addr.toString(16)}=${a.data} vs `
          + `PAL p${b.port} $${b.addr.toString(16)}=${b.data}`;
      }
      break;
    }
    if (tier === "frames") {
      if (a.frame !== b.frame) {
        bad = `write ${i} (p${a.port} $${a.addr.toString(16)}=${a.data}) is on `
          + `frame ${a.frame} at 60 Hz but frame ${b.frame} at 50 Hz — an `
          + `Nf duration must be the same COUNT of frames on both`;
        break;
      }
      continue;
    }
    const drift = Math.abs(a.frame / FRAME_HZ_NTSC - b.frame / FRAME_HZ_PAL);
    if (drift > worst) worst = drift;
    if (drift > TOL_SECS && !sampled) {
      bad = `write ${i} (p${a.port} $${a.addr.toString(16)}=${a.data}) drifts `
        + `${(drift * 1000).toFixed(1)} ms: NTSC f${a.frame} vs PAL f${b.frame}`;
      break;
    }
  }

  if (!bad && !sampled && ntsc.writes.length !== pal.writes.length) {
    // Only a tail difference is allowed, and only because the two horizons cut
    // at slightly different musical points.
    const tail = Math.abs(ntsc.writes.length - pal.writes.length);
    const lastSec = n ? ntsc.writes[n - 1].frame / FRAME_HZ_NTSC : 0;
    if (lastSec < NTSC_FRAMES / FRAME_HZ_NTSC - 1) {
      bad = `${ntsc.writes.length} NTSC writes vs ${pal.writes.length} PAL, `
        + `diverging well before the horizon (${tail} extra)`;
    }
  }

  if (!bad && tier === "gesture") {
    bad = gestureDiff(ntsc.writes, pal.writes, FRAME_HZ_NTSC, FRAME_HZ_PAL, 2 * TOL_SECS);
  }

  // The span is the check that survives re-sampling, and it is what would catch
  // an unscaled tempo: that is a 20% error, an order of magnitude past anything
  // rounding can produce. A sampled score gets a proportional allowance as well
  // as the absolute one, because a tick-authored macro step rounds to a whole
  // frame on EACH standard independently (`:step 1/16` at 120 BPM is 7.5 NTSC
  // frames → 8 and 6.25 PAL frames → 6), and a long envelope multiplies that.
  if (!bad) {
    const spanA = ntsc.writes.length
      ? ntsc.writes[ntsc.writes.length - 1].frame / FRAME_HZ_NTSC
      : 0;
    const spanB = pal.writes.length
      ? pal.writes[pal.writes.length - 1].frame / FRAME_HZ_PAL
      : 0;
    const allow = sampled ? Math.max(2 * TOL_SECS, spanA * 0.05) : 2 * TOL_SECS;
    if (tier === "frames") {
      // Same frames, so the PAL span IS 6/5 of the NTSC one. Nothing to check
      // here that the frame-for-frame comparison above has not already said.
    } else if (Math.abs(spanA - spanB) > allow) {
      bad = `the music spans ${spanA.toFixed(3)} s on NTSC but ${spanB.toFixed(3)} s on PAL`;
    }
  }

  if (bad) {
    console.log(`FAIL  ${name} — ${bad}`);
    failed++;
  } else if (tier === "frames") {
    console.log(`ok    ${name} — frames: ${n} writes identical, on the same frame numbers`);
  } else if (tier === "strict") {
    console.log(
      `ok    ${name} — strict: ${n} writes identical, worst drift ${(worst * 1000).toFixed(1)} ms`,
    );
  } else {
    console.log(
      `ok    ${name} — ${tier}: ${agreed}/${n} writes identical, ` +
        `re-sampled past that by design`,
    );
  }
}

console.log(
  `\n${scores.length - failed} passed · ${failed} failed ` +
    `(strict tolerance ${(TOL_SECS * 1000).toFixed(1)} ms = one PAL frame)`,
);
process.exit(failed ? 1 : 0);
