// The sample ring, measured on the reference (driver.md §5.1.2).
//
//   node tools/dac-model.mjs [score.mmlisp | song.mmb …] [--frames N]
//
// `npm run dac` measures the ENGINE's feed: whether the Z80 puts its samples out
// across the frame instead of in a burst. It cannot ask the question this gate
// asks, because under Timer-B pacing the engine no longer decides when a sample
// goes out — the timer does. What is left to get wrong is the RING: the DAC
// takes 166 or 167 samples a frame depending on where the timer's phase falls,
// the mixer produces in frame-sized chunks, and if the two ever disagree the
// feed runs dry and the hole is audible.
//
// So this gate drives `drv-player.js` (the port spec, and now the definition of
// the ring) and checks three things a value-comparison gate cannot see:
//
//   * every feeding frame takes exactly pcmFrameSamples(frame) — the sequencer
//     and the feed derive that count independently and must agree forever
//   * the ring never runs dry under the mixer (UNDERRUN — the failure the whole
//     geometry exists to prevent)
//   * how much SLACK the ring is holding, in samples and in milliseconds. That
//     is the budget every late frame spends, so it is the number that says
//     whether the geometry survives contact with a real Z80.
//
// It is a model, and the model has no cycles in it: a hole from a frame that
// overran is not something this can see (that is `npm run dac:clock`, once the
// engine is on the timer). What it can prove is that the bookkeeping is right
// and how much room the bookkeeping leaves.
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";
import { pcmFrameSamples, PCM_RING_TARGET, PCM_SAMPLES_PER_FRAME } from "../../live/src/mmb.js";
import { buildMmb } from "./mmb-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const fIdx = argv.indexOf("--frames");
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!scores.length) {
  scores = [
    "tests/m3-pcm-softmix.mmlisp", // three voices, the dense case
    "tests/m2-pcmloop.mmlisp",     // one looping voice, continuous
    "tests/m3-pcm-slice.mmlisp",   // repeated short bursts — the ramp case
    "tests/m2-pcm.mmlisp",         // shots with silence between them
    "tests/m3-pcm-vol.mmlisp",
    "tests/m3-fm6-pcm.mmlisp",
  ].map((p) => join(drv, p));
}
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1]) : 400;

// The sample clock in Hz, for the millisecond figures — the real one (a frame
// is 59.92 Hz on NTSC, not the 60 the increment tables are written against).
const SAMPLE_HZ = PCM_SAMPLES_PER_FRAME * (53693175 / 896040);
const ms = (samples) => ((1000 * samples) / SAMPLE_HZ).toFixed(2);

// A burst's PRIME frame builds the whole lead and feeds nothing, so the slack
// is at its full value from the first fed frame onwards — there is no ramp. The
// constant survives as 1 (the prime frame itself is excluded below) so the shape
// of the check stays obvious if the policy ever grows one again.
const RAMP = 1;
// Below this much slack, a frame that runs late starves the DAC. The geometry
// (lead PCM_RING_TARGET, mixing exactly what was fed) gives TARGET - want = 89.
const MIN_SLACK = 64;

let failures = 0;
for (const score of scores) {
  const name = basename(score);
  let mmb, sampleBank;
  if (score.endsWith(".mmb")) {
    mmb = readFileSync(score);
    const smp = score.replace(/\.mmb$/, ".smp");
    if (!existsSync(smp)) {
      console.log(`skip  ${name} — no .smp beside it`);
      continue;
    }
    sampleBank = readFileSync(smp);
  } else {
    ({ bytes: mmb, sampleBank } = buildMmb(score));
  }
  if (!sampleBank?.length) {
    console.log(`skip  ${name} — no sample bank`);
    continue;
  }

  // Sample the ring at every frame boundary. captureSlotLog closes each frame
  // through the builder, so a builder subclass is the hook — no private state.
  const player = new DrvPlayer(() => {});
  const trace = [];
  class TracingBuilder extends SlotBuilder {
    endFrame() {
      trace.push(player.getPcmRing());
      return super.endFrame();
    }
  }
  player.loadMMB(mmb, sampleBank);
  const cap = player.captureSlotLog({ maxFrames: FRAMES, builder: new TracingBuilder() });

  const fedPerFrame = new Map();
  for (const w of cap.pcmLog) {
    if (w.reg === 0x2a) fedPerFrame.set(w.frame, (fedPerFrame.get(w.frame) ?? 0) + 1);
  }
  const problems = [];
  // A PRIME frame — one that starts with an empty ring — feeds no music at all:
  // it builds the lead and parks the DAC at silence with a single byte (§5.1.2).
  // Every other feeding frame owes the schedule exactly.
  const primeAt = (f) => (f === 0 ? true : trace[f - 1]?.fill === 0);
  let offSchedule = 0, badPrime = 0;
  for (const [f, n] of fedPerFrame) {
    if (primeAt(f)) { if (n !== 1) badPrime++; }
    else if (n !== pcmFrameSamples(f)) offSchedule++;
  }
  if (offSchedule) problems.push(`${offSchedule} frames fed off the sample clock's schedule`);
  if (badPrime) problems.push(`${badPrime} prime frames fed music instead of parking the DAC`);
  if (cap.pcmUnderruns) problems.push(`${cap.pcmUnderruns} samples the ring could not supply`);

  // Slack: what is left in the ring the instant before the mixer tops it up.
  // The chunk of frame f-1 is what frame f feeds from, so that is
  // fill-after-mix(f-1) - want(f), and its minimum is the budget a late frame
  // has to spend.
  //
  // Only frames the MIXER RAN IN count. A ring that empties under an idle mixer
  // is a burst ending — the tail runs out and the DAC is released — and that is
  // the design working, not a starved feed. `run` counts how long the mixer has
  // been going, so the opening ramp reads apart from the steady state.
  const produced = trace.map((t, f) =>
    f === 0 ? t.fill : t.fill - Math.max(0, trace[f - 1].fill - pcmFrameSamples(f)),
  );
  let maxFill = 0, minSlack = Infinity, minSlackAt = -1, steady = Infinity, steadyAt = -1;
  let run = 0;
  for (let f = 1; f < trace.length; f++) {
    maxFill = Math.max(maxFill, trace[f].fill);
    if (produced[f] <= 0) { run = 0; continue; }
    // A PRIME frame feeds nothing (it builds the lead), so it has no slack to
    // measure. Slack starts meaning something on the frame after it.
    if (++run === 1) continue;
    const slack = trace[f - 1].fill - pcmFrameSamples(f);
    if (slack < minSlack) { minSlack = slack; minSlackAt = f; }
    if (run > RAMP && slack < steady) { steady = slack; steadyAt = f; }
  }
  if (maxFill > PCM_RING_TARGET) problems.push(`ring overran: fill reached ${maxFill}/${PCM_RING_TARGET}`);
  if (Number.isFinite(steady) && steady < MIN_SLACK) {
    problems.push(`steady-state slack ${steady} samples, below the ${MIN_SLACK} bar (f${steadyAt})`);
  }

  const fed = [...fedPerFrame.values()].reduce((a, b) => a + b, 0);
  const primes = [...fedPerFrame.keys()].filter(primeAt).length;
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name} — ${cap.frames} frames, ${fed} samples fed, ` +
      `${offSchedule} off-schedule, ${cap.pcmUnderruns} underruns, ${primes} primes`,
  );
  if (Number.isFinite(minSlack)) {
    const want = Math.round(PCM_SAMPLES_PER_FRAME);
    const steadyTxt = Number.isFinite(steady)
      ? `${steady} samples steady (${ms(steady)} ms), a lost frame costs ${want} — ` +
        `covered ${steady >= want ? "yes" : "no"}`
      : `no steady state (every burst is shorter than ${RAMP} frames)`;
    console.log(
      `        ring: fill peak ${maxFill}/${PCM_RING_TARGET}, slack ${steadyTxt}; ` +
        `${minSlack} at its thinnest (${ms(minSlack)} ms, f${minSlackAt})`,
    );
  }
  for (const p of problems) console.log(`        ! ${p}`);
}

// Not a measurement — a property of the pacing, printed so the two numbers stay
// side by side. Timer B pulls the phase back at every gate, so the longest the
// DAC can hold between samples is one gate: GROUP = 3 sample periods, against
// the 14-20 measured under frame pacing (npm run dac:clock, 2026-08-06).
console.log(
  `\nhole bound by design: 3 sample periods (${ms(3)} ms) — the gate interval. ` +
    `Measuring it needs the engine on the timer (npm run dac:clock).`,
);
console.log(failures ? `${failures} failed — the ring does not hold` : "sample ring holds");
if (failures) process.exit(1);
