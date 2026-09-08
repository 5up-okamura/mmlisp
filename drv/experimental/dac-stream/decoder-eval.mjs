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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { PUBLISH, INITIAL_STATE, refDecode } from "./observer.mjs";
import { CORR, MAX_DEBT_UNITS, refCorrect } from "./corrector.mjs";
import { buildCase, FAULTS } from "./case-config.mjs";
import { readProbe, recordsBetweenReads, stoppedWithin, Z80_DIV } from "./probe-analysis.mjs";
import { buildPhaseTable, buildLineTable, findLineOrigin, decode, decodeVH,
  scoreDecode, contractProblems, quantise, LINE_MASTER, FRAME_MASTER } from "./decoder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// `--out DIR` exists so the harness's own refusals — no log, stale log, empty
// log — can be exercised against a directory that does not have what it needs.
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : join(here, "..", "..", "out", "dac-stream");
const BLAST = process.env.MMLISP_BLASTEM || join(here, "..", "..", "out", "blastem");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", "2"));
const MCLK = 53693175;
// `--fault NAME` breaks the published record on purpose and INVERTS the verdict
// for the decoder cases: the run passes only if the record check refuses it
// (R7 §20.2 B). Everything else in the harness is skipped, because a broken
// record says nothing about the calibration or the contract runs.
const FAULT = arg("fault", null);
// The decoder's own runs can be scored at a different length from the rest.
// A record contract is about what happens over TIME — the observation number
// carries, the run ends inside a record — and two seconds of it says little
// (R8 §23.5 wants a 10 s and a 60 s pass). Default: the same as everything else.
const Z80_SECONDS = Number(arg("z80-seconds", String(arg("seconds", "2"))));

// ── the roles, declared and enforced ──────────────────────────────────────
const CALIBRATE = ["hv observer, unrepaid 1B stall", "hv observer, unrepaid 16B stall",
  "hv observer, unrepaid 64B stall"];
const CALIBRATE_VH = ["hv observer, V+H, unrepaid 16B stall",
  "hv observer, V+H, unrepaid 64B stall", "hv observer, V+H, unrepaid 256B stall"];
// Verified against the contract: displacements here stay well inside half a
// line, which is the condition H can actually promise anything under.
const VERIFY = ["hv observer, Z80 reads h", "hv observer, load timed in place",
  ...[1, 2, 3, 4, 5, 6, 7].map((k) => `hv observer, boot phase ${k}`)];
// Disturbed, but INSIDE the contract: displacements smaller than half a line,
// at boot phases and transfer intervals the calibration never saw. Without
// these the verification set only showed that a quiet run stays quiet
// (R6 §17.2 B).
const CONTRACT = [
  "hv observer, in-contract 1B stall every 1500",
  "hv observer, in-contract 2B stall every 900",
  "hv observer, in-contract 4B stall every 3000",
  "hv observer, in-contract 8B stall every 1200",
  "hv observer, back-to-back 2B stalls",
  "hv observer, 2ch pattern with a 4B stall",
];
// The decoder as the Z80 actually runs it.
const Z80_DECODER = ["z80 decoder, quiet", "z80 decoder, 4B stall"];
// The same decoder, distributed through the complete 2ch engine. Nothing is
// published over the bus: the record is read from the Z80's own writes to the
// globals page, which the emulator watches at no cost to the engine — so the
// image compared is the image under test (R8 §23.5 step 3).
const SPLIT_2CH = ["2ch 15-level decoder, quiet", "2ch 15-level decoder, 4B stall"];
// …and the same image with the BOUNDED CORRECTOR in it (R10 §29.7 step 6). The
// ladders make the loop's length a function of what the last observation
// decided, so nothing here may take the engine's own RAM as the truth: the
// correction is reconstructed from the DAC write times, the read times and the
// STOP/RESUME pairs, against the ladder slots the generator placed.
const SPLIT_CORR = ["2ch corrector, quiet", "2ch corrector, 4B stall",
  "2ch corrector, occasional 4B stall", "2ch corrector, counter wrap",
  ...[[1, 20], [2, 60], [8, 140]].map(([b, n]) => `2ch corrector, single ${b}B stall, phase ${n}`)];
// Either side of half a line, reported rather than graded.
const BOUNDARY = ["hv observer, boundary 16B stall", "hv observer, boundary 24B stall"];
// Kept to demonstrate the limit, not to pass it: these carry displacements
// past half a line, which H cannot see.
const LIMIT = ["hv observer, unrepaid 64B stall"];
const overlap = [...VERIFY, ...CONTRACT, ...BOUNDARY].filter((n) => CALIBRATE.includes(n));
if (overlap.length) { console.error(`decoder-eval: ${overlap} is both calibration and verification`); process.exit(2); }

const core = ["blastem_libretro.dylib", "blastem_libretro.so"]
  .map((f) => join(BLAST, f)).find(existsSync);
if (!core) { console.error("decoder-eval: BlastEm is not built — run `sh drv/blastem/setup.sh`"); process.exit(2); }
const coreHash = createHash("sha256").update(readFileSync(core)).digest("hex");
let build = null;
try { build = JSON.parse(readFileSync(join(BLAST, "build.json"), "utf8")); } catch { /* older tree */ }
console.log(`core ${coreHash.slice(0, 16)}`
  + (build ? ` — blastem ${build.revision.slice(0, 12)}, probe.patch ${build.patch}` : " — built before setup.sh recorded what it built"));

if (!argv.includes("--reuse")) {
  console.log(`running the observer cases for ${SECONDS}s each…`);
  for (const name of FAULT ? [] : ["hv observer, Z80 reads h", "hv observer, Z80 reads v+h",
    "load timed in place", "unrepaid", "V+H, unrepaid", "boot phase",
    "in-contract", "back-to-back", "boundary", "2ch pattern with"])
    execFileSync(process.execPath, [join(here, "machine-probe.mjs"), "--case", name,
      "--seconds", String(SECONDS)], { stdio: ["ignore", "ignore", "inherit"] });
  for (const sel of FAULT ? ["z80 decoder"] : ["z80 decoder", "2ch 15-level decoder", "2ch corrector"])
    execFileSync(process.execPath, [join(here, "machine-probe.mjs"), "--case", sel,
      "--seconds", String(Z80_SECONDS), ...(FAULT ? ["--fault", FAULT] : [])],
      { stdio: ["ignore", "ignore", "inherit"] });
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
for (const name of FAULT ? Z80_DECODER : [...CALIBRATE, ...CALIBRATE_VH, ...VERIFY, ...CONTRACT,
  ...BOUNDARY, ...Z80_DECODER, ...SPLIT_2CH, ...SPLIT_CORR, "hv observer, Z80 reads v+h"])
  expectedRom.set(name, buildCase(caseOf(name), { outDir: OUT, fault: FAULT }));

// A name is not an identity. The output directory accumulates logs from every
// run ever made, so a case is looked up by (name, rom, core, seconds) and the
// newest match wins; anything else is a stale file that happens to share a
// name, which is exactly how a previous configuration got read as a result.
const logs = new Map();
for (const n of readdirSync(OUT).filter((n) => n.endsWith(".log"))) {
  let j; try { j = JSON.parse(readFileSync(join(OUT, n.replace(/\.log$/, ".json")), "utf8")); } catch { continue; }
  if (j.coreHash !== coreHash) continue;
  const file = join(OUT, n);
  const key = `${j.name}\u0000${j.rom}\u0000${j.seconds}`;
  const at = statSync(file).mtimeMs;
  const prev = logs.get(key);
  if (!prev || at > prev.at) logs.set(key, { file, rom: j.rom, at });
}
const need = (name, secs = SECONDS) => {
  const want = expectedRom.get(name)?.sha;
  const got = want ? logs.get(`${name}\u0000${want}\u0000${secs}`) : null;
  if (!got) {
    const others = [...logs.keys()].filter((k) => k.startsWith(`${name}\u0000`))
      .map((k) => k.split("\u0000").slice(1).join(" @ ") + "s");
    failures.push(`no ${secs}s log for "${name}" at rom ${want} from this core`
      + (others.length ? ` (found ${others.join(", ")} — stale)` : ""));
    return null;
  }
  if (!readFileSync(got.file).length) { failures.push(`the log for "${name}" is empty`); return null; }
  return got.file;
};

const stopsOf = new Map();
const hs = (name) => { const f = need(name); if (!f) return null;
  const log = readProbe(readFileSync(f));
  stopsOf.set(name, log.stops);
  return log.z80vdp.filter((e) => (e.value >>> 8) === 9)
    .map((e) => ({ h: e.value & 255, time: e.time })); };
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
  // EVERY undisturbed interval against the pattern position it belongs to, not
  // the distribution against the distribution: the two agreed while the index
  // was off by one on 13,714 of 19,947 intervals (R6 §17.2 A). An interval the
  // 68000 stalled inside is EXCLUDED — that difference is the disturbance
  // being measured, not a wrong schedule.
  const stops = stopsOf.get(name) ?? [];
  let worst = 0, off = 0, checked = 0, si = 0;
  for (let n = 1; n < times.length; n++) {
    const a = times[n - 1], b = times[n];
    while (si < stops.length && stops[si][1] < a) si++;
    if (si < stops.length && stops[si][0] < b) continue;      // stalled: not ours to judge
    checked++;
    const d = Math.abs((b - a) - sp[n % sp.length]);
    if (d > 16) off++;
    worst = Math.max(worst, d);
  }
  if (checked < 100) failures.push(`"${name}": only ${checked} undisturbed intervals to check the schedule against`);
  if (off) failures.push(`"${name}": ${off} of ${checked} undisturbed intervals do not match`
    + ` the generated pattern at their own position (worst ${worst} master)`);
  return worst;
};

// ── calibration, as a fixed artifact ──────────────────────────────────────
// R6 §17.2 C: making the tables is a separate STEP whose result is saved with
// what it was made from, and a verification run READS it. Nothing
// re-calibrates mid-run, and a table made from a rom the cases no longer build
// is refused.
const TABLE_FILE = join(here, "phase-table.json");
const canon = (o) => JSON.stringify(Object.fromEntries(Object.entries(o)
  .filter(([k]) => k !== "hash").sort(([a], [b]) => a < b ? -1 : 1)));
const hashOf = (o) => createHash("sha256").update(canon(o)).digest("hex").slice(0, 32);

if (argv.includes("--calibrate")) {
  const denseSets = CALIBRATE.map(hs), vhSets = CALIBRATE_VH.map(vh);
  if (denseSets.includes(null) || vhSets.includes(null)) {
    for (const f of failures) console.error(`decoder-eval: ${f}`);
    process.exit(1);
  }
  const origin = findLineOrigin(vhSets.flat().map((x) => ({ v: x.v, time: x.vtime })));
  const h = buildPhaseTable(denseSets.flat(), { origin: origin.origin });
  const v = buildLineTable(vhSets.flat().map((x) => ({ v: x.v, time: x.vtime })), { origin: origin.origin });
  const q = quantise(h.table, [LINE_MASTER]);       // bytes only; steps are per schedule
  const artifact = {
    mode: { region: "ntsc", vdp: "mode 5, H40, display on, no vertical interrupt",
      lineMaster: LINE_MASTER, frameMaster: FRAME_MASTER },
    lineOrigin: origin.origin,
    straddlingV: origin.multi,
    widestGroupSpanMaster: h.widestGroupSpanMaster,
    hPhase: [...h.table], vLine: [...v.table],
    vCandidates: Object.fromEntries([...v.candidates]),
    quantised: { unit: q.unit, units: q.units, unknown: q.unknown, bytes: [...q.bytes] },
    calibratedFrom: [...CALIBRATE, ...CALIBRATE_VH].map((name) => ({
      name, rom: expectedRom.get(name).sha, coreHash: coreHash.slice(0, 16), seconds: SECONDS })),
  };
  artifact.hash = hashOf(artifact);
  writeFileSync(TABLE_FILE, JSON.stringify(artifact, null, 1) + "\n");
  console.log(`calibrated → ${TABLE_FILE}`);
  console.log(`  hash ${artifact.hash}, line origin ${artifact.lineOrigin} master`);
  console.log(`  H → phase ${h.covered} of 256, widest group span ${h.widestGroupSpanMaster} master`);
  console.log(`  quantised: ${q.unit} master a unit, ${q.units} a line, unknown $${q.unknown.toString(16)}`);
  process.exit(0);
}

if (!existsSync(TABLE_FILE)) {
  console.error(`decoder-eval: no calibration at ${TABLE_FILE} — run with --calibrate`);
  process.exit(2);
}
const art = JSON.parse(readFileSync(TABLE_FILE, "utf8"));
if (hashOf(art) !== art.hash) {
  console.error("decoder-eval: the calibration file's hash does not match its contents");
  process.exit(2);
}
for (const src of art.calibratedFrom) {
  const want = expectedRom.get(src.name)?.sha;
  if (want && src.rom !== want)
    failures.push(`the calibration was made from "${src.name}" at rom ${src.rom},`
      + ` which this case no longer builds (${want})`);
}
const cal = { table: Int16Array.from(art.hPhase),
  covered: art.hPhase.filter((x) => x >= 0).length };
const vcal = { table: Int16Array.from(art.vLine),
  candidates: new Map(Object.entries(art.vCandidates).map(([k, xs]) => [Number(k), xs])),
  covered: art.vLine.filter((x) => x >= 0).length,
  ambiguous: Object.values(art.vCandidates).filter((xs) => xs.length > 1).length };
const qbytes = Uint8Array.from(art.quantised.bytes);
console.log(`\ncalibration — READ from phase-table.json, hash ${art.hash}`);
console.log(`  made from ${art.calibratedFrom.length} runs used for NOTHING else`);
console.log(`  line origin ${art.lineOrigin} master · H → phase ${cal.covered} of 256`
  + ` (widest group span ${art.widestGroupSpanMaster} master) · V → line ${vcal.covered} of 256,`
  + ` ${vcal.ambiguous} answering to more than one`);
console.log(`  quantised: ${art.quantised.unit} master a unit, ${art.quantised.units} a line,`
  + ` unknown $${art.quantised.unknown.toString(16)}`);

// ── verification ──────────────────────────────────────────────────────────
const report = (name, s, spacingErr) => {
  console.log(`${name}`);
  console.log(`  in-line displacement: worst error ${s.inLine.worstMaster} master`
    + ` (${(s.inLine.worstMaster / 15).toFixed(1)} Z80 cyc), ${s.inLine.withinTolerance}`
    + ` of ${s.inLine.of} within tolerance · schedule spacing agrees to ${spacingErr} master`);
  console.log(`  interval: the truth fell inside the reported [min,max] on`
    + ` ${s.inLine.covered} of ${s.inLine.of}`);
  console.log(`  visible at all: ${s.visible.realShifts} real displacements,`
    + ` ${s.visible.seen} reported, ${s.visible.invisible} INVISIBLE to H (a whole`
    + ` number of lines) · ${s.visible.beyondHalfLine} past half a line, where H`
    + ` reports the short way round · ${s.visible.nearHalfLine} inside the guard band`
    + ` · ${s.visible.falseMoved} reported moved with nothing there,`
    + ` ${s.visible.signWrong} with the wrong sign`);
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

console.log(FAULT ? "" : `\n── H alone, verification set (never used for calibration) ──`);
for (const name of FAULT ? [] : VERIFY) {
  const r = hs(name); if (!r) continue;
  const times = r.map((x) => x.time);
  const spacing = spacingOf(name);
  const spacingErr = checkSpacing(name, times);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacing.map((v) => v % LINE_MASTER), indices: r.map((_, i) => i) });
  const s = scoreDecode(rows, times, spacing);
  report(name, s, spacingErr);
  for (const p of contractProblems(s, { kind: "quiet", minOffsetChecks: 500 }))
    failures.push(`"${name}": ${p}`);
}

console.log(FAULT ? "" : `\n── H alone, disturbed but inside the contract ──`);
for (const name of FAULT ? [] : CONTRACT) {
  const r = hs(name); if (!r) continue;
  const times = r.map((x) => x.time);
  const spacing = spacingOf(name);
  const spacingErr = checkSpacing(name, times);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacing.map((v) => v % LINE_MASTER), indices: r.map((_, i) => i) });
  const s = scoreDecode(rows, times, spacing);
  report(name, s, spacingErr);
  // These have to MEASURE, not merely stay quiet.
  for (const p of contractProblems(s, { kind: "contract" })) failures.push(`"${name}": ${p}`);
}

// ── the byte table the Z80 would carry ────────────────────────────────────
// R6 §17.3: the quantised table is a CANDIDATE, and "precision unchanged" was
// wrong — the rounding lands at both ends of every difference. This decodes
// the same independent runs through the byte table and its distributed steps,
// and grades it on its own tolerance.
console.log(FAULT ? "" : `\n── the same runs through the ${art.quantised.unit}-master byte table ──`);
if (!FAULT) {
  const U = art.quantised.unit;
  const byteTable = Int16Array.from(qbytes, (b) => b === art.quantised.unknown ? -1 : b * U);
  let worstAll = 0;
  for (const name of [...VERIFY, ...CONTRACT]) {
    const r = hs(name); if (!r) continue;
    const times = r.map((x) => x.time);
    const spacing = spacingOf(name);
    const q = quantise(cal.table, spacing, { unit: U, unknown: art.quantised.unknown });
    const rows = decode(r.map((x) => x.h), { table: byteTable,
      // The event threshold cannot be tighter than the estimator's own
      // uncertainty, or the quantisation itself reads as movement.
      steps: q.steps.map((v) => v * U), indices: r.map((_, i) => i),
      uncertainty: 44, threshold: 44 });
    const sc = scoreDecode(rows, times, spacing, { tolerance: 44 });
    worstAll = Math.max(worstAll, sc.inLine.worstMaster);
    const kind = CONTRACT.includes(name) ? "contract" : "quiet";
    const probs = contractProblems(sc, { kind, tolerance: 44,
      minOffsetChecks: kind === "quiet" ? 500 : 100 })
      .filter((p) => !/in-line error/.test(p));      // graded by the tolerance below
    if (sc.inLine.worstMaster > 60) probs.push(`in-line error ${sc.inLine.worstMaster} master`);
    for (const p of probs) failures.push(`"${name}" (byte table): ${p}`);
  }
  console.log(`  worst in-line error across ${VERIFY.length + CONTRACT.length} runs:`
    + ` ${worstAll} master (${(worstAll / 15).toFixed(1)} Z80 cyc) — against`
    + ` ${U} master of quantisation at each end of a difference`);
  // The unknown marker must stay distinguishable from a real phase.
  const clash = [...qbytes].filter((b, h) => b === art.quantised.unknown && cal.table[h] >= 0).length;
  if (clash) failures.push(`${clash} calibrated H values quantise onto the unknown marker`);
  const outOfRange = [...qbytes].filter((b) => b !== art.quantised.unknown && b >= art.quantised.units).length;
  if (outOfRange) failures.push(`${outOfRange} table entries are outside 0..${art.quantised.units - 1}`);
}

// ── the decoder as the Z80 runs it ────────────────────────────────────────
// R6 §17.4 step 2, rebuilt for R7 §20.2 B. The earlier version compared ONE
// byte — the displacement — took the first publication after each read without
// asking whether it had finished before the next one, and let any number of
// missing publications past as long as 500 remained. So it could not have seen
// a state contract at all.
//
// What is compared now is a WHOLE RECORD: the acquisition state, the validity
// of the difference, the displacement and the 16-bit observation number, each
// published to its own address in the window so a field that never arrived is
// visible as itself. A record must open after its read and close before the
// next one. The reference is the same refDecode() the emulator check scores
// against, driven by the same readings and by the advance the GENERATOR laid
// out — not by a second copy of a constant.
console.log(`\n── the decoder running on the Z80 ──`);
for (const name of Z80_DECODER) {
  const f = need(name, Z80_SECONDS); if (!f) continue;
  const log = readProbe(readFileSync(f));
  const reads = log.z80vdp.filter((e) => (e.value >>> 8) === 9)
    .map((e) => ({ h: e.value & 255, time: e.time }));
  const recs = log.records;
  const sp = spacingOf(name);
  const U = art.quantised.unit, units = art.quantised.units;
  const opts = { units, unknown: art.quantised.unknown, table: [...qbytes] };

  // Records, cut at the reads they belong between. The same function the
  // selftest drives with dropped, doubled and carried-over fields.
  const { rows, problems, incompleteTail, broken, kinds } = recordsBetweenReads(reads, recs, PUBLISH);

  let state = { ...INITIAL_STATE }, mismatch = 0, compared = 0, first = null;
  for (let n = 0; n < rows.length; n++) {
    const step = ((sp[(n + 1) % sp.length] % LINE_MASTER) / U) % units;
    state = refDecode(state, reads[n].h, step, opts);
    const said = rows[n];
    if (!said) continue;             // already counted as a broken record
    compared++;
    const want = { known: state.known, valid: state.valid, delta: state.delta,
      countLo: state.count & 0xff, countHi: state.count >> 8 };
    if (PUBLISH.some((k) => said[k] !== want[k])) {
      mismatch++;
      first ??= { n, h: reads[n].h, want, said };
    }
  }
  console.log(`${name} — ${Z80_SECONDS}s`);
  console.log(`  ${reads.length} readings, ${recs.length} published fields,`
    + ` ${compared} complete records compared field by field, ${mismatch} disagreed`);
  console.log(`  broken records: ${problems.short} short, ${problems.extra} with a field too many,`
    + ` ${problems.outOfOrder} out of order, ${problems.late} published before their own read`
    + `${incompleteTail ? `; 1 unfinished record at the end of the run, excluded` : ""}`);
  if (first) console.log(`  first disagreement:`, JSON.stringify(first));
  // EVERY reading owes a complete record, except the one the measurement may
  // have been cut inside. The kinds are reported by name and never summed into
  // a verdict — two faults cancelling is exactly how the old tail rule hid one
  // (R8 §23.4).
  const owed = reads.length - incompleteTail;
  if (compared !== owed)
    failures.push(`"${name}": ${owed} readings owe a record and ${compared} arrived complete`);
  for (const k of kinds)
    failures.push(`"${name}": ${problems[k]} records ${k === "late" ? "published before their own read"
      : k === "short" ? "never finished" : k === "extra" ? "carried a field too many"
      : "arrived out of order"}`);
  if (broken !== kinds.reduce((t, k) => t + problems[k], 0))
    failures.push(`"${name}": the record check's own counts do not add up`);
  if (mismatch) failures.push(`"${name}": the Z80 and the reference disagreed on ${mismatch} of ${compared} records`);
  // The validity gate has to have been exercised, or the run says nothing about
  // it: a run in which every reading was in the table never re-acquires.
  const bases = rows.filter((r) => r && r.known === 0xff && r.valid === 0).length;
  const unknowns = rows.filter((r) => r && r.known === 0).length;
  console.log(`  ${unknowns} readings the table does not cover, ${bases} records that are a base`
    + ` rather than a difference`);
  if (!bases) failures.push(`"${name}": not one record was a base — the acquisition gate was never exercised`);
}

// ── the decoder inside the complete 2ch engine (R8 §23.5 step 3) ──────────
// Same comparison, no publish: the record is the Z80's own writes to its
// globals page, in the order the placement stores them. The engine is not told
// anything and pays nothing for being watched.
console.log(FAULT ? "" : `\n── the decoder inside the complete 2ch engine ──`);
for (const name of FAULT ? [] : [...SPLIT_2CH, ...SPLIT_CORR]) {
  const f = need(name, Z80_SECONDS); if (!f) continue;
  const built = expectedRom.get(name);
  const fields = built.gen.observer.record;
  const log = readProbe(readFileSync(f));
  const reads = log.z80vdp.filter((e) => (e.value >>> 8) === 9)
    .map((e) => ({ h: e.value & 255, time: e.time }));
  // NO RAM WRITES AT ALL means the core does not carry the watch, and the
  // comparison below would then report "every record missing" — true, but not
  // the truth. Say which it is (R9 §26.2).
  if (!log.ramWrites.length) {
    failures.push(`"${name}": this core logged no Z80 RAM writes at all — it was`
      + ` built without the watch in probe.patch, so the record cannot be read`);
    continue;
  }
  // The probe reports the offset within the globals page, so a record field is
  // a write to one of five known addresses in it.
  const stateLo = (built.cfg.ram.glob[0] & 0xff) + 0x10;
  const index = new Map(fields.map((x, k) => [stateLo + x.offset, k]));
  const all = log.ramWrites.filter((w) => index.has(w.addr))
    .map((w) => ({ time: w.time, field: index.get(w.addr), value: w.value }));
  // BOOT WRITES EACH FIELD ONCE, before the first reading, and that is not a
  // record arriving early — it is the initialisation R7 §20.2 B asked for, seen
  // from the outside. It is checked rather than skipped: one write per field,
  // all of them zero, or the state is not being initialised at all.
  const first = reads.length ? reads[0].time : Infinity;
  const boot = all.filter((w) => w.time <= first);
  const recs = all.filter((w) => w.time > first);
  const names = fields.map((x) => x.name);
  // Each field is INITIALISED, and it ends boot holding the value the reference
  // starts from. Not "written exactly once, all zero": the counter-wrap image
  // boots the observation number to $FFFC, so those two fields are written twice
  // — zeroed by the init loop and then set — and both writes are the
  // initialisation R7 §20.2 B asked for, seen from the outside.
  {
    const cf = built.gen.observer.countFrom ?? 0;
    const want0 = { countLo: cf & 0xff, countHi: (cf >> 8) & 0xff };
    const last = new Map();
    for (const w of boot) last.set(names[w.field], w.value);
    for (const k of names) {
      if (!last.has(k)) failures.push(`"${name}": boot never wrote the record's ${k}`);
      else if (last.get(k) !== (want0[k] ?? 0))
        failures.push(`"${name}": boot left ${k} at ${last.get(k)}, not ${want0[k] ?? 0}`);
    }
  }
  stopsOf.set(name, log.stops);
  const { rows, problems, incompleteTail, kinds } = recordsBetweenReads(reads, recs, names);

  const U = art.quantised.unit, units = art.quantised.units;
  const opts = { units, unknown: art.quantised.unknown, table: [...qbytes] };
  const sp = spacingOf(name);
  // WITH THE CORRECTOR, the decode and the correction are ONE reference: the
  // fold takes the applied quanta off the phase the next expectation is built
  // from, so a decode-only reference disagrees with a correct engine from the
  // second observation onward. `applied` is kept per observation because the
  // interval AFTER a read is the one that carries that read's correction.
  const corrected = !!built.gen.split.correct;
  const applied = new Array(rows.length).fill(0);
  const split = new Array(rows.length).fill(null);
  let debt = 0, expired = 0, worstDebt = 0, over = 0, worstOver = 0;
  // The observation number does not always start at zero: the wrap case boots it
  // four short of $FFFF so the carry is reached rather than waited for.
  let state = { ...INITIAL_STATE, count: built.gen.observer.countFrom ?? 0 };
  let mismatch = 0, compared = 0, firstBad = null;
  for (let n = 0; n < rows.length; n++) {
    const step = ((sp[(n + 1) % sp.length] % LINE_MASTER) / U) % units;
    if (!corrected) state = refDecode(state, reads[n].h, step, opts);
    else {
      const phase = opts.table[reads[n].h];
      const known = phase === opts.unknown ? 0 : 0xff;
      const valid = known & state.known;
      let d = (phase - state.expect) % units;
      if (d < 0) d += units;
      if (d >= (units + 1) >> 1) d -= units;
      const delta = valid ? d : 0;
      const c = refCorrect({ debt: valid ? debt : 0 }, delta);
      debt = c.debt; applied[n] = c.applied; split[n] = { a: c.a, b: c.b, c: c.c };
      if (c.expired) expired++;
      worstDebt = Math.max(worstDebt, Math.abs(debt));
      // HOW LONG IT TAKES TO COME BACK. The gain leaves at most two units, so
      // "settled" is |debt| <= 2 and the longest stretch above it is the return
      // time a disturbance actually cost (R9 §26.5).
      over = Math.abs(debt) > 2 ? over + 1 : 0;
      worstOver = Math.max(worstOver, over);
      const k2 = c.expired ? 0 : known;
      const ph = ((phase - CORR.unitsPerQuantum * c.applied) % units + units) % units;
      state = { known: k2, valid, delta: delta & 0xff, count: (state.count + 1) & 0xffff,
        expect: k2 ? (ph + step) % units : 0 };
    }
    const said = rows[n];
    if (!said) continue;
    compared++;
    const want = { known: state.known, valid: state.valid, delta: state.delta,
      countLo: state.count & 0xff, countHi: state.count >> 8 };
    if (names.some((k) => said[k] !== want[k])) { mismatch++; firstBad ??= { n, h: reads[n].h, want, said }; }
  }
  console.log(`${name} — ${Z80_SECONDS}s`);
  console.log(`  ${reads.length} readings, ${recs.length} state writes watched,`
    + ` ${compared} complete records compared field by field, ${mismatch} disagreed`);
  console.log(`  broken records: ${problems.short} short, ${problems.extra} with a field too many,`
    + ` ${problems.outOfOrder} out of order, ${problems.late} written before their own read`
    + `${incompleteTail ? "; 1 unfinished record at the end of the run, excluded" : ""}`);
  if (firstBad) console.log(`  first disagreement:`, JSON.stringify(firstBad));
  console.log(`  boot wrote ${boot.length} record-field bytes before the first reading,`
    + ` leaving each field at its initial value`);
  const owed = reads.length - incompleteTail;
  if (compared !== owed)
    failures.push(`"${name}": ${owed} readings owe a record and ${compared} arrived complete`);
  for (const k of kinds) failures.push(`"${name}": ${problems[k]} records ${k}`);
  if (mismatch) failures.push(`"${name}": the 2ch engine and the reference disagreed on ${mismatch} of ${compared}`);
  // THE READ SPACING, WITH THE STOP SUBTRACTED PER INTERVAL (R9 §26.3). The
  // engine is a static schedule, so a stop moves it rather than slowing it:
  // interval - stopped inside that interval = the interval the generator laid
  // out. Skipping disturbed intervals instead checked NOTHING here, because one
  // read a loop is 430,080 master and a stall every 3,000 lands in every one.
  {
    let worst = 0, off = 0, checked = 0, stalledN = 0;
    for (let n = 1; n < reads.length; n++) {
      const a = reads[n - 1].time, b = reads[n].time;
      const { stopped } = stoppedWithin(a, b, log.stops);
      if (stopped) stalledN++;
      // The ladders shorten the loop by exactly what the previous observation
      // decided, so the interval the generator lays out for read n is `sp` minus
      // that correction. Without this term a working corrector reads as a broken
      // schedule.
      const laid = sp[n % sp.length] - applied[n - 1] * CORR.quantumCycles * Z80_DIV;
      const d = Math.abs((b - a) - stopped - laid);
      checked++;
      if (d > 16) off++;
      worst = Math.max(worst, d);
    }
    console.log(`  read spacing ${sp[0]} master: ${checked} intervals checked`
      + ` (${stalledN} with a stop subtracted), worst residual ${worst} master`);
    if (off) failures.push(`"${name}": ${off} of ${checked} intervals do not match the`
      + ` generated spacing once their own stop is subtracted (worst ${worst} master)`);
    if (checked < 100) failures.push(`"${name}": only ${checked} intervals to check`);
  }
  console.log(`  worst slot ${built.gen.placement.worst.workPct}%,`
    + ` mean ${built.gen.placement.meanWorkPct}%, ${built.gen.split.slotsPreserving} slots carry BC`);
  // WHAT THE RECORD ACTUALLY MEASURED, against the instrument's own clock.
  // This is the input a corrector needs and it is a measurement, not a design:
  // the true displacement of a reading is how far its interval departed from
  // the one the schedule lays out, and the record reports it in units of 20
  // master. Only records whose difference is VALID say anything.
  {
    const U = art.quantised.unit;
    const errs = [], seen = [];
    for (let n = 1; n < rows.length; n++) {
      const said = rows[n];
      if (!said || said.valid !== 0xff) continue;
      const truth = (reads[n].time - reads[n - 1].time)
        - (sp[n % sp.length] - applied[n - 1] * CORR.quantumCycles * Z80_DIV);
      const signed = said.delta > 127 ? said.delta - 256 : said.delta;
      seen.push(truth);
      errs.push(signed * U - truth);
    }
    if (errs.length) {
      const a = (x) => Math.abs(x);
      errs.sort((x, y) => a(x) - a(y));
      seen.sort((x, y) => x - y);
      console.log(`  displacement: ${seen[0]}..${seen.at(-1)} master really happened;`
        + ` the record's own error is at most ${a(errs.at(-1))} master`
        + ` (${(a(errs.at(-1)) / Z80_DIV).toFixed(1)} Z80 cyc) over ${errs.length} valid differences`);
    }
  }
  // WHEN THE RESULT IS FINISHED: the reading, then the last field of its
  // record. The layout predicts it; the machine is asked to agree.
  // …and the same subtraction per RECORD (R9 §26.3): the reading, the last
  // field of its record, minus whatever the 68000 held the bus for in between.
  // Every complete record owes a settle, and in a static schedule every one of
  // them must equal the layout's prediction — not just the smallest.
  {
    const want = built.gen.observer.settleMaster;
    const raw = [], adj = [];
    let ri = 0;
    for (const rec of recs) {
      while (ri + 1 < reads.length && reads[ri + 1].time <= rec.time) ri++;
      if (rec.field !== names.length - 1 || rec.time <= reads[ri].time) continue;
      const span = rec.time - reads[ri].time;
      raw.push(span);
      adj.push(span - stoppedWithin(reads[ri].time, rec.time, log.stops).stopped);
    }
    const bad = adj.filter((x) => x !== want).length;
    raw.sort((a, b) => a - b); const sorted = [...adj].sort((a, b) => a - b);
    console.log(`  reading -> finished record: ${raw[0]}..${raw.at(-1)} master raw,`
      + ` ${sorted[0]}..${sorted.at(-1)} with each record's own stop subtracted`
      + ` (the layout says ${want} = ${(want / MCLK * 1000).toFixed(3)} ms)`);
    // ONE SETTLE PER COMPLETE RECORD, so a single well-behaved one cannot stand
    // in for the rest.
    if (adj.length !== compared)
      failures.push(`"${name}": ${compared} complete records but ${adj.length} settle times`);
    if (bad) failures.push(`"${name}": ${bad} of ${adj.length} records settle somewhere`
      + ` other than the ${want} master the layout predicts`);
  }
  // THE CORRECTION, MEASURED OFF THE DAC (R10 §29.7 step 6, R11 §31.4 step 2).
  //
  // Nothing here reads the engine's q, its debt or its ladder bytes. EVERY DAC
  // interval of the observation is scored, not just the seven that carry a
  // ladder: a ladder slot has to be `base - 4a` for ITS OWN group's value — so
  // the 4+2+1 grouping is checked rather than only the total — and every other
  // slot has to be exactly the length the generator laid out. The read times say
  // which lap an interval belongs to and the STOP/RESUME pairs are subtracted,
  // so a held bus is not read as a correction.
  if (corrected) {
    const readSlot = built.gen.split.walk.placed[0].absolute;
    const nSlots = built.cfg.cycleSlots;
    const group = new Map(built.gen.split.ladders.map((l) => [l.slot, l.tag[0]]));
    const dacT = log.dac.map((e) => e.time);
    let checked = 0, wrong = 0, worstQ = 0, moved = 0, badSlots = 0, gaps = 0;
    let intervals = 0, worstErr = 0;
    const landed = new Set();
    let j = 0;
    for (let n = 0; n < reads.length - 1; n++) {
      while (j + 1 < dacT.length && dacT[j + 1] <= reads[n].time) j++;
      if (!dacT.length || dacT[j] > reads[n].time || j + nSlots >= dacT.length) continue;
      // One DAC write a slot, so the next read is exactly `nSlots` writes on.
      // Anything else is a hole and this observation cannot be scored.
      let k2 = j;
      while (k2 + 1 < dacT.length && dacT[k2 + 1] <= reads[n + 1].time) k2++;
      if (k2 - j !== nSlots) { gaps++; continue; }
      const sp3 = split[n] ?? { a: 0, b: 0, c: 0 };
      let sum = 0, ok = true;
      for (let k = 0; k < nSlots; k++) {
        const i = j + k, slot = (readSlot + k) % nSlots;
        const stop = stoppedWithin(dacT[i], dacT[i + 1], log.stops);
        if (stop.stopped) landed.add(slot);
        const span = dacT[i + 1] - dacT[i] - stop.stopped;
        const base = built.cfg.slotCycles[slot % built.cfg.groupSlots] * Z80_DIV;
        const q = group.has(slot) ? sp3[group.get(slot)] : 0;
        const want = base - q * CORR.quantumCycles * Z80_DIV;
        intervals++;
        if (span !== want) {
          badSlots++; ok = false;
          worstErr = Math.max(worstErr, Math.abs(span - want));
        }
        if (group.has(slot)) sum += (base - span) / (CORR.quantumCycles * Z80_DIV);
      }
      checked++;
      if (applied[n] !== 0) moved++;
      worstQ = Math.max(worstQ, Math.abs(sum));
      if (!ok || sum !== applied[n]) wrong++;
    }
    console.log(`  correction off the DAC: ${checked} observations, ${intervals} DAC intervals`
      + ` scored against the layout, ${badSlots} wrong (worst ${worstErr} master),`
      + ` ${wrong} observations disagreed with the reference`
      + ` — ${moved} corrected something, the largest ${worstQ} quanta`
      + ` = ${worstQ * CORR.quantumCycles * Z80_DIV} master`
      + `${gaps ? `; ${gaps} observations skipped for a hole in the DAC trace` : ""}`);
    if (!checked) failures.push(`"${name}": not one observation's correction could be rebuilt`);
    if (badSlots) failures.push(`"${name}": ${badSlots} of ${intervals} DAC intervals are not the`
      + ` length the layout lays out for them (worst ${worstErr} master)`);
    if (wrong) failures.push(`"${name}": ${wrong} of ${checked} observations moved the DAC by`
      + ` something other than what the corrector decided`);
    if (name.includes("stall") && !moved)
      failures.push(`"${name}": a disturbed run corrected nothing — the ladders never left neutral`);
    if (log.stops.length)
      console.log(`  the stop landed in ${landed.size} of the loop's ${nSlots} slots`
        + ` over ${log.stops.length} stops`);
    // WHERE THE PHASE ENDED UP. A quiet run has to SETTLE — R9 §26.5 asks for
    // under 60 master — and a run disturbed at every observation cannot, because
    // a new displacement arrives before the last one is repaid. So the quiet
    // case is graded on the residual and the disturbed one on staying inside the
    // limit without expiring, which is what "bounded" means.
    const held = Math.abs(debt) * U;
    console.log(`  debt held: ${debt} units = ${held} master at the last observation,`
      + ` worst ${worstDebt} units over the run, ${expired} expiries`
      + ` (the limit is ${MAX_DEBT_UNITS} units)`);
    console.log(`  return: longest stretch above 2 units (40 master) is ${worstOver} observations`
      + ` = ${(worstOver * sp[0] / MCLK * 1000).toFixed(2)} ms`);
    if (!name.includes("stall") && held > 60)
      failures.push(`"${name}": a quiet run settled at ${held} master, over the 60 asked for`);
    if (expired)
      failures.push(`"${name}": ${expired} observations expired — this disturbance is inside the contract`);
  }
  const bases = rows.filter((r) => r && r.known === 0xff && r.valid === 0).length;
  if (!bases) failures.push(`"${name}": not one record was a base`);
}

console.log(FAULT ? "" : `\n── H alone, either side of half a line ──`);
for (const name of FAULT ? [] : BOUNDARY) {
  const r = hs(name); if (!r) continue;
  const times = r.map((x) => x.time);
  const spacing = spacingOf(name);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacing.map((v) => v % LINE_MASTER), indices: r.map((_, i) => i) });
  const s = scoreDecode(rows, times, spacing);
  report(name, s, checkSpacing(name, times));
  // Reported, not graded — except that a displacement inside the contract must
  // still come back with the right sign.
  if (s.visible.signWrong > s.visible.beyondHalfLine)
    failures.push(`"${name}": ${s.visible.signWrong} wrong signs but only ${s.visible.beyondHalfLine} past half a line`);
}

console.log(FAULT ? "" : `\n── H alone, the limit it cannot pass ──`);
for (const name of FAULT ? [] : LIMIT) {
  const r = hs(name); if (!r) continue;
  const times = r.map((x) => x.time);
  const spacing = spacingOf(name);
  const rows = decode(r.map((x) => x.h), { table: cal.table,
    steps: spacing.map((v) => v % LINE_MASTER), indices: r.map((_, i) => i) });
  const s = scoreDecode(rows, times, spacing);
  report(name, s, checkSpacing(name, times));
  // This case exists to SHOW the blind spot. If it stops showing it, the
  // demonstration is broken and the limit is no longer being measured.
  if (!s.visible.beyondHalfLine) failures.push(`"${name}" no longer demonstrates H's limit`);
}

console.log(FAULT ? "" : `\n── V and H, for comparison only ──`);
if (!FAULT) {
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
if (FAULT) {
  // INVERTED: the run is a pass only if the record check refused it.
  console.log(`\n${bad.length ? "ok" : "FAIL"} — fault "${FAULT}": ${FAULTS[FAULT]}`);
  for (const f of bad) console.log(`  refused: ${f}`);
  if (!bad.length) console.log(`  the record check accepted a deliberately broken record`);
  process.exit(bad.length ? 0 : 1);
}
console.log(`\n${bad.length ? "FAIL" : "ok"} — ${VERIFY.length} quiet + ${CONTRACT.length}`
  + ` in-contract verification runs, ${BOUNDARY.length} boundary, ${LIMIT.length} limit,`
  + ` ${CALIBRATE.length} calibration runs, ${bad.length} problems`);
for (const f of bad) console.log(`  ${f}`);
process.exit(bad.length ? 1 : 0);
