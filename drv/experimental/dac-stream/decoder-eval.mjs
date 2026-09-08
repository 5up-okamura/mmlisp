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
import { buildCase, FAULTS } from "./case-config.mjs";
import { readProbe, recordsBetweenReads } from "./probe-analysis.mjs";
import { buildPhaseTable, buildLineTable, findLineOrigin, decode, decodeVH,
  scoreDecode, contractProblems, quantise, LINE_MASTER, FRAME_MASTER } from "./decoder.mjs";

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

if (!argv.includes("--reuse")) {
  console.log(`running the observer cases for ${SECONDS}s each…`);
  for (const name of FAULT ? [] : ["hv observer, Z80 reads h", "hv observer, Z80 reads v+h",
    "load timed in place", "unrepaid", "V+H, unrepaid", "boot phase",
    "in-contract", "back-to-back", "boundary", "2ch pattern with"])
    execFileSync(process.execPath, [join(here, "machine-probe.mjs"), "--case", name,
      "--seconds", String(SECONDS)], { stdio: ["ignore", "ignore", "inherit"] });
  for (const sel of FAULT ? ["z80 decoder"] : ["z80 decoder", "2ch 15-level decoder"])
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
  ...BOUNDARY, ...Z80_DECODER, ...SPLIT_2CH, "hv observer, Z80 reads v+h"])
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
/** How many of these intervals the 68000 stalled inside. */
const countStalled = (times, stops) => {
  let n = 0, si = 0;
  for (let k = 1; k < times.length; k++) {
    const a = times[k - 1], b = times[k];
    while (si < stops.length && stops[si][1] < a) si++;
    if (si < stops.length && stops[si][0] < b) n++;
  }
  return n;
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
for (const name of FAULT ? [] : SPLIT_2CH) {
  const f = need(name, Z80_SECONDS); if (!f) continue;
  const built = expectedRom.get(name);
  const fields = built.gen.observer.record;
  const log = readProbe(readFileSync(f));
  const reads = log.z80vdp.filter((e) => (e.value >>> 8) === 9)
    .map((e) => ({ h: e.value & 255, time: e.time }));
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
  if (boot.length !== names.length || boot.some((w) => w.value !== 0))
    failures.push(`"${name}": boot wrote ${boot.length} of ${names.length} record fields`
      + ` before the first reading${boot.some((w) => w.value !== 0) ? ", and not all of them zero" : ""}`);
  stopsOf.set(name, log.stops);
  const { rows, problems, incompleteTail, kinds } = recordsBetweenReads(reads, recs, names);

  const U = art.quantised.unit, units = art.quantised.units;
  const opts = { units, unknown: art.quantised.unknown, table: [...qbytes] };
  const sp = spacingOf(name);
  let state = { ...INITIAL_STATE }, mismatch = 0, compared = 0, firstBad = null;
  for (let n = 0; n < rows.length; n++) {
    const step = ((sp[(n + 1) % sp.length] % LINE_MASTER) / U) % units;
    state = refDecode(state, reads[n].h, step, opts);
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
  console.log(`  boot wrote ${boot.length} record fields before the first reading, all zero`);
  const owed = reads.length - incompleteTail;
  if (compared !== owed)
    failures.push(`"${name}": ${owed} readings owe a record and ${compared} arrived complete`);
  for (const k of kinds) failures.push(`"${name}": ${problems[k]} records ${k}`);
  if (mismatch) failures.push(`"${name}": the 2ch engine and the reference disagreed on ${mismatch} of ${compared}`);
  // The schedule's own read spacing, checked against the machine — but only
  // where there is something undisturbed to check. One read a LOOP is 430,080
  // master and a stall every 3,000 lands inside every one of them, so the
  // disturbed case has no clean interval by construction; that is the case
  // working, not the check failing.
  const stalled = countStalled(reads.map((x) => x.time), log.stops);
  if (stalled < reads.length - 1) {
    const worst = checkSpacing(name, reads.map((x) => x.time));
    console.log(`  read spacing ${sp[0]} master, agrees to ${worst} master on the`
      + ` ${reads.length - 1 - stalled} undisturbed intervals`);
  } else {
    console.log(`  read spacing not checked: the 68000 stalled inside all`
      + ` ${reads.length - 1} intervals — one read a loop is ${sp[0]} master`);
  }
  console.log(`  worst slot ${built.gen.placement.worst.workPct}%,`
    + ` mean ${built.gen.placement.meanWorkPct}%, ${built.gen.split.slotsPreserving} slots carry BC`);
  // WHEN THE RESULT IS FINISHED: the reading, then the last field of its
  // record. The layout predicts it; the machine is asked to agree.
  const settle = [];
  { let ri = 0;
    for (const rec of recs) {
      while (ri + 1 < reads.length && reads[ri + 1].time <= rec.time) ri++;
      if (rec.field === names.length - 1 && rec.time > reads[ri].time)
        settle.push(rec.time - reads[ri].time);
    } }
  if (settle.length) {
    settle.sort((a, b) => a - b);
    const want = built.gen.observer.settleMaster;
    const mid = settle[settle.length >> 1];
    console.log(`  reading -> finished record: ${settle[0]}..${settle.at(-1)} master`
      + ` (p50 ${mid} = ${(mid / MCLK * 1000).toFixed(3)} ms), the layout says ${want}`);
    if (settle[0] !== want && !stalled)
      failures.push(`"${name}": the record settles in ${settle[0]}..${settle.at(-1)} master`
        + ` where the layout says ${want}`);
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
