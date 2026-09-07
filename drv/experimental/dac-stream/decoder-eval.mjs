// Does observation ALONE settle the phase? (§13.3 step 3, R4.)
//
//   node drv/experimental/dac-stream/decoder-eval.mjs [--seconds N]
//
// Runs the observer cases on BlastEm, calibrates the decoder's tables, decodes
// every run using nothing but the bytes the Z80 read and the read's index in
// the schedule, and scores the result against the instrument's own clock —
// which is used HERE and nowhere else.
//
// It reports what the decoder cannot distinguish instead of filling it in.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readProbe } from "./probe-analysis.mjs";
import { buildPhaseTable, buildLineTable, findLineOrigin, decode, decodeVH,
  learnSpacing, scoreDecode, LINE_MASTER, FRAME_MASTER } from "./decoder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "out", "dac-stream");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = arg("seconds", "2");

const H_ONLY = ["hv observer, Z80 reads h", "hv observer, unrepaid 1B stall",
  "hv observer, unrepaid 16B stall", "hv observer, unrepaid 64B stall",
  // The same decoder, the same tables, from seven other starting phases.
  ...[1, 2, 3, 4, 5, 6, 7].map((k) => `hv observer, boot phase ${k}`)];
const V_AND_H = ["hv observer, Z80 reads v+h", "hv observer, V+H, unrepaid 16B stall",
  "hv observer, V+H, unrepaid 64B stall", "hv observer, V+H, unrepaid 256B stall"];

if (!argv.includes("--reuse")) {
  console.log(`running the observer cases for ${SECONDS}s each…`);
  for (const name of ["hv observer, Z80 reads h", "hv observer, Z80 reads v+h",
    "unrepaid", "V+H, unrepaid", "boot phase"])
    execFileSync(process.execPath, [join(here, "machine-probe.mjs"), "--case", name,
      "--seconds", SECONDS], { stdio: ["ignore", "ignore", "inherit"] });
}

const byName = new Map();
for (const n of readdirSync(OUT).filter((n) => n.endsWith(".log"))) {
  try {
    const j = JSON.parse(readFileSync(join(OUT, n.replace(/\.log$/, ".json")), "utf8"));
    if (j.seconds === Number(SECONDS)) byName.set(j.name, join(OUT, n));
  } catch {}
}
const need = (name) => {
  const f = byName.get(name);
  if (!f) { console.error(`decoder-eval: no ${SECONDS}s log for "${name}" — run without --reuse`); process.exit(2); }
  return f;
};
const hs = (name) => readProbe(readFileSync(need(name))).z80vdp
  .filter((e) => (e.value >>> 8) === 9).map((e) => ({ h: e.value & 255, time: e.time }));
const vh = (name) => {
  const es = readProbe(readFileSync(need(name))).z80vdp, out = [];
  for (let i = 1; i < es.length; i++)
    if ((es[i - 1].value >>> 8) === 8 && (es[i].value >>> 8) === 9)
      out.push({ v: es[i - 1].value & 255, h: es[i].value & 255,
        time: es[i].time, vtime: es[i - 1].time });
  return out;
};

// ── calibration ───────────────────────────────────────────────────────────
// These are properties of the VDP's counters, not of a run: a shipped decoder
// carries them as constants. They are derived from measurement here because
// that is the description of the counter available, and deriving them again is
// a step that has to happen on hardware before any of this is a hardware claim.
// The dense phase coverage they need only exists in a DISTURBED run — a clean
// schedule samples the same 57 phases forever.
// CALIBRATION DATA IS NOT EVALUATION DATA (§13.2.2). The tables are built from
// the three disturbed runs, which are the only ones with dense phase coverage;
// every boot phase, every load and every frame scored below is data the tables
// have never seen.
const CALIBRATE_ON = ["hv observer, unrepaid 1B stall", "hv observer, unrepaid 16B stall",
  "hv observer, unrepaid 64B stall"];
const dense = CALIBRATE_ON.flatMap(hs);
const origin = findLineOrigin(V_AND_H.slice(1).flatMap(vh).map((x) => ({ v: x.v, time: x.vtime })));
const cal = buildPhaseTable(dense, { origin: origin.origin });
const vcal = buildLineTable(V_AND_H.slice(1).flatMap(vh).map((x) => ({ v: x.v, time: x.vtime })),
  { origin: origin.origin });
console.log(`\ncalibration (chip constants, derived from measurement)`);
console.log(`  line origin ${origin.origin} master — chosen because it leaves`
  + ` ${origin.multi} of ${origin.values} V values straddling two lines`);
console.log(`  H → phase: ${cal.covered} of 256 values covered, widest group span`
  + ` ${cal.widestGroupSpanMaster} master`);
console.log(`  V → line: ${vcal.covered} of 256 values, ${vcal.ambiguous} answering to more than one`);

const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(2)}%`;

console.log(`\n── H ALONE ──────────────────────────────────────────────────`);
const spacingH = learnSpacing(hs(H_ONLY[0]).map((x) => x.time), 1);
for (const name of H_ONLY) {
  const r = hs(name), times = r.map((x) => x.time);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacingH.map((v) => v % LINE_MASTER) });
  const s = scoreDecode(rows, times, spacingH);
  console.log(`${name}`);
  console.log(`  ${s.scored} decoded · worst error vs the instrument ${s.worstErrorMaster} master`
    + ` (${(s.worstErrorMaster / 15).toFixed(1)} Z80 cyc) · within tolerance ${pct(s.withinToleranceFraction*s.scored, s.scored)}`);
  console.log(`  detection TP ${s.truePositive} FP ${s.falsePositive} FN ${s.falseNegative}`
    + ` · unknown reading ${s.unknown}`);
  console.log(`  beyond H's reach: ${s.wrapped} shifts (${pct(s.wrapped, s.scored)}) exceeded half a`
    + ` line; worst real shift ${s.worstTrueShiftMaster} master`
    + ` (${(s.worstTrueShiftMaster / 15).toFixed(0)} Z80 cyc)`);
}

console.log(`\n── V AND H ──────────────────────────────────────────────────`);
const spacingVH = learnSpacing(vh(V_AND_H[0]).map((x) => x.time), 1);
for (const name of V_AND_H) {
  const r = vh(name), times = r.map((x) => x.time);
  const rows = decodeVH(r, { hTable: cal.table, vTable: vcal.table,
    candidates: vcal.candidates, steps: spacingVH.map((v) => v % FRAME_MASTER) });
  const s = scoreDecode(rows, times, spacingVH, { modulus: FRAME_MASTER, tolerance: 40 });
  console.log(`${name}`);
  console.log(`  ${s.scored} decoded · worst error ${s.worstErrorMaster} master`
    + ` · within tolerance ${pct(s.withinToleranceFraction*s.scored, s.scored)}`);
  console.log(`  undecidable from the reading: ${s.ambiguous} (${pct(s.ambiguous, rows.length)})`
    + ` — a V value that occurs twice a frame`);
  // The residual misses left in a disturbed run are a whole line each: V is
  // read 16 cycles before H, and a stall landing between the two reads breaks
  // the rule that decides whether the line advanced in between.
  if (s.misses.length) console.log(`  first misses (residual vs truth, master):`,
    s.misses.slice(0, 3).map((m) => `${m.residual}/${m.truth}`).join(" "));
}
console.log(`\nThe instrument's absolute clock appears only in scoreDecode(); the`
  + `\ndecoders above ran on the read bytes and the schedule index alone.`);
