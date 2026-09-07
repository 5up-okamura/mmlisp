// Does observation ALONE settle the phase, and how far? (§13.3 step 3, R4;
// rebuilt for R5 §15.2 B/C.)
//
//   npm --prefix drv run dac-stream:decoder [-- --seconds N] [--reuse]
//
// Three rules this harness exists to keep:
//
//   1. CALIBRATION LOGS ARE NOT VERIFICATION LOGS. The two sets are declared
//      below and their disjointness is asserted, not assumed.
//   2. THE READ SPACING COMES FROM THE GENERATED SCHEDULE, not from the
//      instrument's timestamps. A spacing learned from the run it is scoring
//      can normalise away a wrong nominal value.
//   3. A LOG IS ONLY USED IF IT IS THIS ROM, THIS CORE AND THESE SECONDS. The
//      rom hash is recomputed from the case, so a stale file in the output
//      directory cannot be read as a fresh result.
//
// It ends in a verdict and a non-zero exit, not in a printout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { buildCase } from "./case-config.mjs";
import { readProbe } from "./probe-analysis.mjs";
import { buildPhaseTable, buildLineTable, findLineOrigin, decode, decodeVH,
  scoreDecode, LINE_MASTER, FRAME_MASTER } from "./decoder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// `--out DIR` exists so the harness's own refusals — no log, stale log, empty
// log — can be exercised against a directory that does not have what it needs.
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : join(here, "..", "..", "out", "dac-stream");
const BLAST = join(here, "..", "..", "out", "blastem");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", "2"));

// ── the roles, declared and enforced ──────────────────────────────────────
const CALIBRATE = ["hv observer, unrepaid 1B stall", "hv observer, unrepaid 16B stall",
  "hv observer, unrepaid 64B stall"];
const CALIBRATE_VH = ["hv observer, V+H, unrepaid 16B stall",
  "hv observer, V+H, unrepaid 64B stall", "hv observer, V+H, unrepaid 256B stall"];
// Verified against the contract: displacements here stay well inside half a
// line, which is the condition H can actually promise anything under.
const VERIFY = ["hv observer, Z80 reads h", "hv observer, load timed in place",
  ...[1, 2, 3, 4, 5, 6, 7].map((k) => `hv observer, boot phase ${k}`)];
// Kept to demonstrate the limit, not to pass it: these carry displacements
// past half a line, which H cannot see.
const LIMIT = ["hv observer, unrepaid 64B stall"];
const overlap = VERIFY.filter((n) => CALIBRATE.includes(n));
if (overlap.length) { console.error(`decoder-eval: ${overlap} is both calibration and verification`); process.exit(2); }

const core = ["blastem_libretro.dylib", "blastem_libretro.so"]
  .map((f) => join(BLAST, f)).find(existsSync);
if (!core) { console.error("decoder-eval: BlastEm is not built — run `sh drv/blastem/setup.sh`"); process.exit(2); }
const coreHash = createHash("sha256").update(readFileSync(core)).digest("hex");

if (!argv.includes("--reuse")) {
  console.log(`running the observer cases for ${SECONDS}s each…`);
  for (const name of ["hv observer, Z80 reads h", "hv observer, Z80 reads v+h",
    "load timed in place", "unrepaid", "V+H, unrepaid", "boot phase"])
    execFileSync(process.execPath, [join(here, "machine-probe.mjs"), "--case", name,
      "--seconds", String(SECONDS)], { stdio: ["ignore", "ignore", "inherit"] });
}

// ── log selection, verified against the rom the case produces ─────────────
const failures = [];
const caseOf = (name) => {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no case named "${name}"`);
  return c;
};
// The rom each case produces, recomputed here from the case itself, so that a
// log can be checked against what it claims to be.
const expectedRom = new Map();
for (const name of [...CALIBRATE, ...CALIBRATE_VH, ...VERIFY, "hv observer, Z80 reads v+h"])
  expectedRom.set(name, buildCase(caseOf(name), { outDir: OUT }));

// A name is not an identity. The output directory accumulates logs from every
// run ever made, so a case is looked up by (name, rom, core, seconds) and the
// newest match wins; anything else is a stale file that happens to share a
// name, which is exactly how a previous configuration got read as a result.
const logs = new Map();
for (const n of readdirSync(OUT).filter((n) => n.endsWith(".log"))) {
  let j; try { j = JSON.parse(readFileSync(join(OUT, n.replace(/\.log$/, ".json")), "utf8")); } catch { continue; }
  if (j.seconds !== SECONDS || j.coreHash !== coreHash) continue;
  const file = join(OUT, n);
  const key = `${j.name}\u0000${j.rom}`;
  const at = statSync(file).mtimeMs;
  const prev = logs.get(key);
  if (!prev || at > prev.at) logs.set(key, { file, rom: j.rom, at });
}
const need = (name) => {
  const want = expectedRom.get(name)?.sha;
  const got = want ? logs.get(`${name}\u0000${want}`) : null;
  if (!got) {
    const others = [...logs.keys()].filter((k) => k.startsWith(`${name}\u0000`))
      .map((k) => k.split("\u0000")[1]);
    failures.push(`no ${SECONDS}s log for "${name}" at rom ${want} from this core`
      + (others.length ? ` (found ${others.join(", ")} — stale)` : ""));
    return null;
  }
  if (!readFileSync(got.file).length) { failures.push(`the log for "${name}" is empty`); return null; }
  return got.file;
};

const hs = (name) => { const f = need(name); if (!f) return null;
  return readProbe(readFileSync(f)).z80vdp
    .filter((e) => (e.value >>> 8) === 9).map((e) => ({ h: e.value & 255, time: e.time })); };
const vh = (name) => { const f = need(name); if (!f) return null;
  const es = readProbe(readFileSync(f)).z80vdp, out = [];
  for (let i = 1; i < es.length; i++)
    if ((es[i - 1].value >>> 8) === 8 && (es[i].value >>> 8) === 9)
      out.push({ v: es[i - 1].value & 255, h: es[i].value & 255,
        time: es[i].time, vtime: es[i - 1].time });
  return out; };

// The spacing pattern comes from the GENERATED SCHEDULE, and the measurement
// is then required to agree with it rather than to define it.
const spacingOf = (name) => {
  const sp = expectedRom.get(name)?.gen.observer?.spacingMaster;
  if (!sp) throw new Error(`case "${name}" is not an observer case`);
  return sp;
};
const checkSpacing = (name, times) => {
  const sp = spacingOf(name);
  const seen = new Map();
  for (let n = 1; n < times.length; n++) {
    const k = n % sp.length;
    (seen.get(k) ?? seen.set(k, []).get(k)).push(times[n] - times[n - 1]);
  }
  let worst = 0;
  for (const [k, xs] of seen) {
    xs.sort((a, b) => a - b);
    worst = Math.max(worst, Math.abs(xs[Math.floor(xs.length / 2)] - sp[k]));
  }
  if (worst > 16) failures.push(`"${name}": the schedule says the reads are`
    + ` ${sp.join("/")} master apart and the run's medians differ by ${worst}`);
  return worst;
};

// ── calibration ───────────────────────────────────────────────────────────
const denseSets = CALIBRATE.map(hs);
const vhSets = CALIBRATE_VH.map(vh);
if (denseSets.includes(null) || vhSets.includes(null)) {
  for (const f of failures) console.error(`decoder-eval: ${f}`);
  process.exit(1);
}
const dense = denseSets.flat(), vhAll = vhSets.flat();
const origin = findLineOrigin(vhAll.map((x) => ({ v: x.v, time: x.vtime })));
const cal = buildPhaseTable(dense, { origin: origin.origin });
const vcal = buildLineTable(vhAll.map((x) => ({ v: x.v, time: x.vtime })), { origin: origin.origin });
console.log(`\ncalibration — from ${CALIBRATE.length} runs used for NOTHING else`);
console.log(`  line origin ${origin.origin} master (${origin.multi} of ${origin.values} V values still straddle)`);
console.log(`  H → phase: ${cal.covered} of 256 values, widest group span ${cal.widestGroupSpanMaster} master`);
console.log(`  V → line: ${vcal.covered} of 256, ${vcal.ambiguous} answering to more than one`);

// ── verification ──────────────────────────────────────────────────────────
const report = (name, s, spacingErr) => {
  console.log(`${name}`);
  console.log(`  in-line displacement: worst error ${s.inLine.worstMaster} master`
    + ` (${(s.inLine.worstMaster / 15).toFixed(1)} Z80 cyc), ${s.inLine.withinTolerance}`
    + ` of ${s.inLine.of} within tolerance · schedule spacing agrees to ${spacingErr} master`);
  console.log(`  visible at all: ${s.visible.realShifts} real displacements,`
    + ` ${s.visible.seen} reported, ${s.visible.invisible} INVISIBLE to H (a whole`
    + ` number of lines) · ${s.visible.beyondHalfLine} past half a line, where H`
    + ` reports the short way round · ${s.visible.nearHalfLine} inside the guard band`);
  console.log(`  offset claim (MODULO ONE LINE): checked on ${s.offset.checked} reads where`
    + ` sync was called valid, ${s.offset.agreed} agreed, worst ${s.offset.worstMaster} master`
    + ` · the real un-wrapped offset reached ${s.offset.trueUnwrappedMaxMaster} master`);
  if (s.visible.beyondHalfLine && s.sync.valid)
    console.log(`  NOTE: ${s.sync.valid} reads still claimed valid sync while`
      + ` ${s.visible.beyondHalfLine} displacements passed half a line. H CANNOT INVALIDATE`
      + ` ITS OWN CLAIM — the claim is only as good as an external guarantee that`
      + ` displacements stay small.`);
  console.log(`  sync states: ${Object.entries(s.sync).map(([k, v]) => `${k} ${v}`).join(", ")}`
    + ` · events: ${Object.entries(s.events).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const [k, xs] of Object.entries(s.examples))
    if (xs.length) console.log(`  first ${k}:`, JSON.stringify(xs));
};

console.log(`\n── H alone, verification set (never used for calibration) ──`);
for (const name of VERIFY) {
  const r = hs(name); if (!r) continue;
  const times = r.map((x) => x.time);
  const spacing = spacingOf(name);
  const spacingErr = checkSpacing(name, times);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacing.map((v) => v % LINE_MASTER) });
  const s = scoreDecode(rows, times, spacing);
  report(name, s, spacingErr);
  // The contract these have to meet.
  if (s.scored < 500) failures.push(`"${name}": only ${s.scored} reads scored`);
  if (s.inLine.worstMaster > 40) failures.push(`"${name}": in-line error ${s.inLine.worstMaster} master`);
  if (s.inLine.withinTolerance !== s.inLine.of) failures.push(`"${name}": ${s.inLine.of - s.inLine.withinTolerance} in-line estimates outside tolerance`);
  if (s.visible.invisible) failures.push(`"${name}": ${s.visible.invisible} displacements were invisible`);
  if (s.visible.beyondHalfLine) failures.push(`"${name}": ${s.visible.beyondHalfLine} displacements passed half a line, so the contract H needs does not hold here`);
  if (s.offset.agreed !== s.offset.checked) failures.push(`"${name}": the offset claim was wrong on ${s.offset.checked - s.offset.agreed} reads`);
  if (s.events.unknown) failures.push(`"${name}": ${s.events.unknown} readings had no calibration`);
}

console.log(`\n── H alone, the limit it cannot pass ──`);
for (const name of LIMIT) {
  const r = hs(name); if (!r) continue;
  const times = r.map((x) => x.time);
  const spacing = spacingOf(name);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacing.map((v) => v % LINE_MASTER) });
  const s = scoreDecode(rows, times, spacing);
  report(name, s, checkSpacing(name, times));
  // This case exists to SHOW the blind spot. If it stops showing it, the
  // demonstration is broken and the limit is no longer being measured.
  if (!s.visible.beyondHalfLine) failures.push(`"${name}" no longer demonstrates H's limit`);
}

console.log(`\n── V and H, for comparison only ──`);
{
  const name = "hv observer, Z80 reads v+h";
  const r = vh(name);
  if (r) {
    const times = r.map((x) => x.time);
    const spacing = spacingOf(name);
    const rows = decodeVH(r, { hTable: cal.table, vTable: vcal.table,
      candidates: vcal.candidates, steps: spacing.map((v) => v % FRAME_MASTER) });
    const amb = rows.filter((x) => x.state === "ambiguous").length;
    console.log(`${name}`);
    console.log(`  ${rows.length} reads, ${amb} undecidable because the V value answers to two`
      + ` lines — reported as a candidate pair, never chosen`);
    console.log(`  NOT scored against the instrument here: while a reading is ambiguous the`);
    console.log(`  decode carries the PREDICTION forward, so its residual and the instrument's`);
    console.log(`  difference are measured from different points. That comparison is R5 §15.2 C`);
    console.log(`  work and is not claimed.`);
  }
}

const bad = [...new Set(failures)];
console.log(`\n${bad.length ? "FAIL" : "ok"} — ${VERIFY.length} verification runs,`
  + ` ${CALIBRATE.length} calibration runs, ${bad.length} problems`);
for (const f of bad) console.log(`  ${f}`);
process.exit(bad.length ? 1 : 0);
