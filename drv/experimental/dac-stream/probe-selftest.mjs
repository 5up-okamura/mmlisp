import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assemble } from "../../tools/z80asm.mjs";
import { Z80Cpu } from "../../tools/z80cpu.mjs";
import { buildConfig } from "./config.mjs";
import { tablesAgree, buildLut, scale, unbias, levelFromCommand, lutPages,
  pageIsALevel } from "./lut.mjs";
import { generateCooperative, COOP, windowBand, windowPeriodMaster } from "./cooperative.mjs";
import { resolveCase, FAULTS } from "./case-config.mjs";
import { buildRom } from "./rom.mjs";
import { analyzeProbe, analyzeTransfers, analyzeHost, windowGenerations, commitReaders,
  analyzeAdoption, analyzeZ80Hv, readProbe, recordsBetweenReads, stoppedWithin,
  summarizeResults,
  KIND } from "./probe-analysis.mjs";
import { generateObserver, decodeOps, decodeInitOps, decodeMap, refDecode, INITIAL_STATE,
  STATE, PHASE_TABLE, VDP } from "./observer.mjs";
import { splitBlocks, placeSplit, SPLIT_STATE, SPLIT_STATE_SIZE } from "./decode-split.mjs";
import { generate, codeLedger, reservedPadBytes } from "./gen-stream.mjs";
import { protocolLayout, protocolAsm, protocolHeader, publishSteps, readSnapshot,
  controlSteps, readControl, faultySteps, faultyControlSteps, tornSnapshotPossible,
  tornControlPossible, enqueueSteps, dequeue, extendTime, lateTarget, genAdvance,
  phaseInvalidated, outputAdvance, SNAPSHOT, CONTROL, PROTOCOL_BYTES, PROTOCOL_SPARE,
  PUB_REGION_BYTES } from "./protocol.mjs";
import { generateSplit } from "./decode-split.mjs";
import { CORR, MAX_QUANTA, MAX_DEBT_UNITS, debtLimitFor, CORR_FAULTS, correctorBlocks,
  correctorLive, ladderOps, refCorrect, splitQuanta, INITIAL_CORR } from "./corrector.mjs";
import { Machine } from "./machine.mjs";
import { buildPhaseTable, buildLineTable, findLineOrigin, decode, decodeVH,
  learnSpacing, scoreDecode, contractProblems } from "./decoder.mjs";

const cfg = buildConfig();
const expected = (i) => (i*73+19)&255;
const fixture = () => {
  const dac = Array.from({length:5000}, (_,i)=>({time:i*5376,value:expected(i)}));
  return { dac, ym: structuredClone(dac), grabs: [], stops: [], copies: [], notifications: [],
    commits: [], polls: [], hints: [], marks: [] };
};
assert.deepEqual(analyzeProbe(fixture(),cfg,expected).errors, []);
for (const index of [0,2500,4999]) {
  const l=fixture(); l.dac[index].value^=1;
  const a=analyzeProbe(l,cfg,expected);
  assert.equal(a.firstBad,index);
  assert.equal(summarizeResults([{informational:true,errors:a.errors}]).exitCode,1);
}
assert.equal(summarizeResults([]).exitCode,1);
assert.match(summarizeResults([{informational:true,errors:["mean rate"]}]).text,/1 fail criteria/);
// A landing failure is a timing verdict an exploratory case may report; a
// protocol failure is fatal wherever it appears.
assert.equal(summarizeResults([{informational:true,errors:["window landing"]}]).exitCode,0);
assert.equal(summarizeResults([{informational:true,errors:["transferred payload"]}]).exitCode,1);
assert.equal(summarizeResults([{informational:true,errors:["window geometry"]}]).exitCode,1);
assert.throws(()=>readProbe(Buffer.alloc(9)),/truncated/);
const holeFixture = fixture();
for (const i of [2600,2800]) for(let j=i;j<holeFixture.dac.length;j++) holeFixture.dac[j].time+=5376;
holeFixture.ym=structuredClone(holeFixture.dac);
holeFixture.grabs=[[holeFixture.dac[2799].time+1,holeFixture.dac[2800].time-1]];
const h=analyzeProbe(holeFixture,cfg,expected);
assert.equal(h.holes.length,2); assert.equal(h.overlapping.length,1);
assert.equal(h.overlapping[0].index,2800); // equal-sized holes remain distinct

const transfer = { ...fixture(), copies:[{time:340,value:19},{time:360,value:256+92}],
  notifications:[{time:0,value:1},{time:2000,value:0}], stops:[[320,910]],
  commits:[{time:800,value:1}], polls:[{time:10}] };
assert.deepEqual(analyzeTransfers(transfer,[[300,900]],{bytes:2,cooperative:true},[19,92]).errors,[]);
for (const mutate of [
  l=>l.copies.reverse(), l=>l.commits[0].time=330,
  l=>l.notifications[0].value=0, l=>l.notifications[0].time=-1000,
  l=>l.stops[0][1]=2100, l=>l.stops.length=0,
  l=>l.copies[1].value=256+93,      // right place, wrong byte
  l=>l.copies.length=1,             // one byte short
]) {
  const l=structuredClone(transfer); mutate(l);
  assert.ok(analyzeTransfers(l,[[300,900]],{bytes:2,cooperative:true},[19,92]).errors.length);
}
// A payload whose content cannot be predicted is still checked for order and count.
const opaque = structuredClone(transfer); opaque.copies[1].value = 256+7;
assert.deepEqual(analyzeTransfers(opaque,[[300,900]],{bytes:2,cooperative:true},null).errors,[]);
opaque.copies.reverse();
assert.ok(analyzeTransfers(opaque,[[300,900]],{bytes:2,cooperative:true},null).errors.length);

// ── window geometry, and the carry-over it exists to catch ────────────────
// The notification bracket is 81 + the bank write; a window with a stall in it
// is longer by exactly the stall, and taking the median of ALL of them would
// price that into the geometry.
assert.deepEqual(windowBand(84), { bankWait:3, windowCycles:64, openMin:3, openMax:16,
  closeMin:67, closeMax:80 });
const Z = 15, W = 26880;
const genLog = { ...fixture(), notifications: [], commits: [], stops: [], copies: [] };
for (let i = 0; i < 6; i++) {
  const t = 100000 + i*W;
  genLog.notifications.push({time:t,value:1},{time:t+84*Z,value:0});
}
genLog.stops.push([100000+20*Z, 100000+80*Z]);        // inside generation 0
let g = windowGenerations(genLog);
assert.equal(g.gens.length, 6);
assert.equal(g.span, 84);
assert.equal(g.quiet, 5);                              // the stalled one is excluded
// ── which window reads a commit: an INTERVAL judgment (§13.2.1) ──────────
// The read is known only to a band, so a commit inside that band cannot be
// attributed from the timestamps at all. The earlier code selected the first
// window whose readLo was past the commit and THEN asked whether the commit
// was at or after that readLo — a test that can never be true — so every
// undecidable commit was reported as a carry-over.
const G = g.gens;
const at = (t) => commitReaders(G, [{ time: t, value: 1 }]).rows[0];
assert.equal(at(G[0].notify1 + 40*Z).verdict, "own");            // inside its window
assert.equal(at(G[0].notify0 - 1).verdict, "own");                // still inside the window
// Written after the window closed but before the read: decidably read by this
// window, and decidably not written in it — which is the fault, not a pass.
assert.equal(at(G[0].readLo - 1).verdict, "carried");
assert.equal(at(G[0].readLo).verdict, "undecided");              // exactly at the near edge
assert.equal(at((G[0].readLo + G[0].readHi)/2).verdict, "undecided");
assert.equal(at(G[0].readHi).verdict, "undecided");              // exactly at the far edge
assert.equal(at(G[0].readHi + 1).verdict, "carried");            // past the read, not its own
assert.equal(at(G[1].notify1 + 40*Z).verdict, "own");            // written inside the next one
assert.equal(at(G.at(-1).readHi + 1).verdict, "unread");         // no window left to read it
// The exact counterexample R4 gives: read bands [110,136] and [1110,1136],
// a commit at 120. It is undecidable, not carried.
const tiny = [{ index:0, notify1:0, notify0:100, readLo:110, readHi:136 },
              { index:1, notify1:1000, notify0:1100, readLo:1110, readHi:1136 }];
const r120 = commitReaders(tiny, [{time:120,value:1}]);
assert.equal(r120.undecided, 1); assert.equal(r120.carried, 0);
// Several commits are attributed in one linear pass, in order.
const many = commitReaders(G, [G[0].notify1+40*Z, G[0].readHi+1, G[1].notify1+40*Z]
  .map((t)=>({time:t,value:1})));
assert.deepEqual(many.rows.map((x)=>x.verdict), ["own","carried","own"]);
assert.equal(many.own, 2); assert.equal(many.carried, 1);
genLog.commits = [{time:100000+40*Z,value:1}];
assert.equal(analyzeTransfers(genLog,[[100000+20*Z,100000+80*Z]],{bytes:0,hint:true},null,
  {windows:g}).carried, 0);
genLog.commits = [{time:100000+W+2000*Z,value:1}];
assert.equal(analyzeTransfers(genLog,[[100000+20*Z,100000+80*Z]],{bytes:0,hint:true},null,
  {windows:g}).carried, 1);

// ── which branch the Z80 took, MEASURED from the slot's own length ────────
// The served path shortens the pad, so the slot bounded by two DAC writes is
// exactly `compensation` shorter. Nothing here is inferred from commit times.
const adoptCfg = { slotCycles: [358], machine: { z80Div: 15 } };
const mkAdopt = (shorten, stallCyc) => {
  const l = { dac: [], stops: [] };
  let t = 0;
  const notifies = [];
  for (let i = 0; i < 4; i++) {
    l.dac.push({ time: t, value: 0 });
    notifies.push(t + 20*Z);
    if (stallCyc) l.stops.push([t + 30*Z, t + (30 + stallCyc)*Z]);
    t += (358 + (stallCyc ?? 0) - (shorten ?? 0)) * Z;
  }
  l.dac.push({ time: t, value: 0 });
  return { log: l, gens: notifies.map((n, index) => ({ index, notify1: n, notify0: n + 84*Z })) };
};
const served = mkAdopt(65, 65), quiet = mkAdopt(0, 0), stolen = mkAdopt(65, 0), owed = mkAdopt(0, 65);
assert.equal(analyzeAdoption(served.log,{gens:served.gens},adoptCfg,65).served, 4);
assert.equal(analyzeAdoption(quiet.log,{gens:quiet.gens},adoptCfg,65).absent, 4);
// A slot that repaid a stall it never had took some other window's commit —
// the fault, observed rather than argued.
assert.equal(analyzeAdoption(stolen.log,{gens:stolen.gens},adoptCfg,65).repaidUnstalled, 4);
// …and a slot stalled without repaying is the other half.
assert.equal(analyzeAdoption(owed.log,{gens:owed.gens},adoptCfg,65).stalledUnrepaid, 4);
// A span that cannot be produced by the emitted code yields no geometry at all
// rather than a plausible-looking band.
const bad = structuredClone(genLog);
bad.notifications = bad.notifications.map((e,i)=> i%2 ? {...e, time: e.time + 900*Z} : e);
assert.equal(windowGenerations(bad).band, null);
assert.equal(windowGenerations(bad).impossible, true);

// ── the host timeline ─────────────────────────────────────────────────────
const hostLog = { ...fixture(),
  hints: [{time:0,value:0},{time:3420,value:1},{time:6840,value:2}],
  marks: [{time:70*7,value:1},{time:3420+140*7,value:1}] };
const host = analyzeHost(hostLog, { marks: true });
assert.equal(host.entryDelay.min, 70);
assert.equal(host.entryDelay.max, 140);
assert.equal(host.missedHints, 0);
// A tick with no entry before the next serviced one is lost, not averaged away.
const lost = { ...hostLog, marks: [{time:6840+100*7,value:1}] };
assert.equal(analyzeHost(lost,{marks:true}).missedHints, 2);
// Calibration: the mark pair gives the mark's own cost, and everything else is
// that subtracted.
const cal = { ...fixture(), marks: [
  {time:0,value:0x1a},{time:20*7,value:0x1b},
  {time:1000,value:0x10},{time:1000+(20+256*4)*7,value:0x11},
  {time:5000,value:0x12},{time:5000+(20+32*140)*7,value:0x13}] };
const c = analyzeHost(cal,{calibrate:true}).cal;
assert.equal(c.markCycles, 20); assert.equal(c.nop, 4); assert.equal(c.divu, 140);

// ── what the Z80 read from the VDP ────────────────────────────────────────
// The statistic is the spread of times within one observed value, and it has
// to be able to report a value that carries NO information as such.
const LINE = 3420;
const hvLog = { z80vdp: [], machine: { z80Div: 15 } };
for (let i = 0; i < 800; i++) {
  const t = i * 26880 + 1000;
  hvLog.z80vdp.push({ value: (9 << 8) | Math.floor((t % LINE) / 16), time: t });
}
const hvOut = analyzeZ80Hv(hvLog, { machine: { z80Div: 15 } });
assert.ok(hvOut.ports[9].widestObservedSpreadMaster <= 16);   // the value determines the phase
// A reading that carries no phase information spreads over nearly a whole
// line — the statistic has to be able to say so, or it says nothing.
const noisy = { z80vdp: hvLog.z80vdp.map((e, i) => ({ ...e, value: (9 << 8) | (i % 7) })) };
assert.ok(analyzeZ80Hv(noisy, { machine: { z80Div: 15 } }).ports[9].widestObservedSpreadMaster > LINE / 2);
// The observer is generated INSIDE the real schedule, so a read that does not
// fit is a slot overrun rather than a second loop that happens to have room.
const obs = generateObserver(buildConfig({ voices: 2, complete: true, csm: true }),
  { reads: ["v", "h"], store: true });
assert.equal(obs.observer.workPerSlot, 2 * VDP.readCycles + 13);
assert.ok(obs.observer.worstSlotPct > generate2chWorst());
function generate2chWorst() { return 79.5; }
assert.ok(obs.observer.worstSlotPct < 100);
assert.throws(() => generateObserver(buildConfig({ voices: 2, complete: true }),
  { reads: Array(20).fill("h"), store: true }), /slot|overrun|fill/);

// ── the phase decoder (§13.3 step 3) ──────────────────────────────────────
// Its inputs are the byte read and the read's index. The instrument's clock is
// used to BUILD the chip tables and to score, and nowhere else.
const LN = 3420, UNIT = 16;
const hOf = (t) => Math.floor((t % LN) / UNIT);
const clean = Array.from({ length: 600 }, (_, n) => ({ time: n * 26880 + 500 }));
for (const r of clean) r.h = hOf(r.time);
const { table, covered } = buildPhaseTable(clean);
assert.ok(covered > 0 && covered <= 256);
const stepsH = learnSpacing(clean.map((r) => r.time), 1).map((v) => v % LN);
const rowsClean = decode(clean.map((r) => r.h), { table, steps: stepsH });
assert.equal(rowsClean.filter((r) => r.event === "moved").length, 0);   // no false alarm
assert.equal(rowsClean.filter((r) => r.event === "unknown").length, 0);
assert.equal(rowsClean.filter((r) => r.sync === "valid").length, rowsClean.length - 1);
// A shift the schedule did not plan is seen, and measured — as a DISPLACEMENT
// between two reads, which is a different claim from being back in sync.
const shifted = clean.map((r, n) => ({ time: r.time + (n >= 300 ? 900 : 0) }));
for (const r of shifted) r.h = hOf(r.time);
const rowsShift = decode(shifted.map((r) => r.h), { table, steps: stepsH });
assert.equal(rowsShift[300].event, "moved");
assert.ok(Math.abs(rowsShift[300].delta - 900) <= UNIT);
assert.equal(rowsShift[301].event, "steady");        // one event, not a run…
assert.ok(Math.abs(rowsShift[301].offset - 900) <= UNIT);   // …and the offset stays
// A reading the table has never seen is refused, not interpolated.
const unseen = table.findIndex((v, i) => v < 0 && i < 256);
if (unseen >= 0) {
  const hs2 = clean.map((r) => r.h); hs2[10] = unseen;
  const row = decode(hs2, { table, steps: stepsH })[10];
  assert.equal(row.event, "unknown");
  assert.equal(row.sync, "lost");
}
// findLineOrigin picks the origin that stops a V value from straddling lines.
const vpairs = Array.from({ length: 400 }, (_, n) => {
  const time = n * 26880 + 500 + 900;
  return { v: Math.floor((((time - 900) % 896040) + 896040) % 896040 / LN) & 255, time };
});
// Any origin that leaves no V straddling two lines is as good as any other
// within the sampling's own quantum; what is pinned is that one is found.
// The fixture's own V wraps at 256 while a frame is 262 lines, so six values
// answer to two lines however the origin is chosen — the same duplication the
// real counter has. What is pinned is that the search finds an origin with far
// fewer straddling values than a wrong one.
const foundOrigin = findLineOrigin(vpairs);
const wrongOrigin = findLineOrigin(vpairs, { step: LN }).multi;   // origin 0 only
assert.ok(foundOrigin.multi <= 6, `multi ${foundOrigin.multi}`);
assert.ok(foundOrigin.multi < wrongOrigin, `${foundOrigin.multi} vs ${wrongOrigin}`);
// A V value that answers to two lines is reported as two candidates and the
// decode says "ambiguous" instead of choosing one.
const dup = [{ v: 7, time: 0 }, { v: 7, time: 6 * LN }, { v: 8, time: LN }];
const lt = buildLineTable(dup);
assert.equal(lt.ambiguous, 1);
assert.deepEqual(lt.candidates.get(7), [0, 6]);
// A table covering every H, so this exercises the ambiguity and not a gap.
const fullTable = Int16Array.from({ length: 256 }, (_, i) => (i * UNIT) % LN);
const vhRows = decodeVH([{ v: 8, h: hOf(LN + 500) }, { v: 7, h: hOf(2 * LN + 500) }],
  { hTable: fullTable, vTable: lt.table, candidates: lt.candidates, steps: [0, LN] });
assert.equal(vhRows[1].state, "ambiguous");
assert.ok(vhRows[1].phaseMax - vhRows[1].phaseMin === 6 * LN);
assert.equal(vhRows[1].phase, null);          // no guess is recorded as a value

// The decoder's three claims are scored apart (R5 §15.2 B). A displacement of
// exactly one line leaves H unchanged: it must be counted as INVISIBLE, not as
// a quiet true negative.
const spacing1 = [26880];
const aliasTimes = clean.map((r, n) => ({ time: r.time + (n >= 300 ? LN : 0) }));
for (const r of aliasTimes) r.h = hOf(r.time);
const aliasRows = decode(aliasTimes.map((r) => r.h), { table, steps: [26880 % LN] });
const aliasScore = scoreDecode(aliasRows, aliasTimes.map((r) => r.time), spacing1);
assert.equal(aliasRows[300].event, "steady");          // H saw nothing…
assert.equal(aliasScore.visible.realShifts, 1);        // …and the score says so
assert.equal(aliasScore.visible.invisible, 1);
assert.equal(aliasScore.visible.seen, 0);
// A wrong nominal spacing must show up as error, not be normalised away.
const wrongSpacing = scoreDecode(rowsClean, clean.map((r) => r.time), [26880 + 500]);
assert.ok(wrongSpacing.inLine.worstMaster > 400, `worst ${wrongSpacing.inLine.worstMaster}`);
// A table with nothing in it makes every reading unknown rather than a guess.
const blind = decode(clean.map((r) => r.h), { table: new Int16Array(256).fill(-1), steps: stepsH });
assert.equal(blind.filter((r) => r.sync === "lost").length, blind.length);
assert.equal(scoreDecode(blind, clean.map((r) => r.time), spacing1).scored, 0);
// A missing reading breaks the chain instead of being absorbed into the next
// displacement.
const gapped = clean.filter((_, n) => n !== 100);
const gapRows = decode(gapped.map((r) => r.h),
  { table, steps: stepsH, indices: clean.map((_, n) => n).filter((n) => n !== 100) });
assert.equal(gapRows[100].event, "gap");
assert.equal(gapRows[100].sync, "lost");
// A first V+H reading with two candidates fixes no origin.
const firstAmb = decodeVH([{ v: 7, h: hOf(500) }, { v: 8, h: hOf(LN + 500) }],
  { hTable: fullTable, vTable: lt.table, candidates: lt.candidates, steps: [0, LN] });
assert.equal(firstAmb[0].state, "ambiguous");
assert.equal(firstAmb[0].phase, null);

// A NON-UNIFORM spacing pattern, indexed by the observation number. The whole
// cycle, a start part-way through it, a gap, and indices that go backwards.
// (R6 §17.2 A: the departure-indexed version read correctly only because P1's
// intervals are all equal.)
const PAT = [26880, 27000, 26760, 26940];
const patTimes = [], patH = [];
{ let t = 500;
  for (let n = 0; n < 400; n++) { patTimes.push(t); patH.push(hOf(t)); t += PAT[(n + 1) % PAT.length]; } }
const patSteps = PAT.map((v) => v % LN);
const patRows = decode(patH, { table: fullTable, steps: patSteps, indices: patH.map((_, i) => i) });
assert.equal(patRows.filter((r) => r.event === "moved").length, 0);
assert.equal(scoreDecode(patRows, patTimes, PAT).inLine.worstMaster <= UNIT, true);
// Starting part-way through the pattern: the observation numbers say where.
const from = 7;
const midRows = decode(patH.slice(from), { table: fullTable, steps: patSteps,
  indices: patH.map((_, i) => i).slice(from) });
assert.equal(midRows.filter((r) => r.event === "moved").length, 0);
// A dropped reading must not shift the pattern for everything after it.
const keep = patH.map((_, i) => i).filter((i) => i !== 100);
const gapRows2 = decode(keep.map((i) => patH[i]), { table: fullTable, steps: patSteps, indices: keep });
assert.equal(gapRows2[100].event, "gap");
assert.equal(gapRows2.slice(101).filter((r) => r.event === "moved").length, 0);
// …which is exactly what the array position gets wrong.
const wrongIdx = decode(keep.map((i) => patH[i]), { table: fullTable, steps: patSteps });
assert.ok(wrongIdx.filter((r) => r.event === "moved").length > 100,
  `array-position indexing should misread the pattern, got ${wrongIdx.filter((r) => r.event === "moved").length}`);
// Repeated or reversed observation numbers are refused, not absorbed.
const backwards = decode([patH[0], patH[1], patH[1]], { table: fullTable, steps: patSteps,
  indices: [0, 1, 1] });
assert.equal(backwards[2].event, "bad-index");
assert.equal(backwards[2].sync, "lost");

// A GATE THAT CANNOT FAIL IS NOT A GATE (R6 §17.2 B). A decoder that always
// says the same thing has to be rejected by the criteria the harness applies.
{
  const N = 800, SP = 26880;
  const t = [], hh = [];
  let now = 500;
  for (let n = 0; n < N; n++) { t.push(now); hh.push(hOf(now)); now += SP + (n % 4 === 0 ? 600 : 0); }
  const steps = [SP % LN];
  const honest = decode(hh, { table: fullTable, steps, indices: hh.map((_, i) => i) });
  const truth = scoreDecode(honest, t, [SP]);
  assert.deepEqual(contractProblems(truth, { kind: "contract" }), [],
    `an honest decode should pass: ${contractProblems(truth, { kind: "contract" })}`);
  assert.ok(truth.visible.realShifts > 100);
  // …and each degenerate decoder fails, for the reason it should.
  const always = (patch) => honest.map((r) => ({ ...r, ...patch(r) }));
  const steady = scoreDecode(always(() => ({ delta: 0, deltaMin: -24, deltaMax: 24, event: "steady" })), t, [SP]);
  assert.ok(contractProblems(steady, { kind: "contract" }).some((p) => /invisible/.test(p)), JSON.stringify(contractProblems(steady)));
  const moved = scoreDecode(always((r) => ({ event: "moved" })), t, [SP]);
  assert.ok(contractProblems(moved, { kind: "contract" }).some((p) => /did not happen/.test(p)));
  const unknown = scoreDecode(always(() => ({ delta: null, offset: null, sync: "lost", event: "unknown" })), t, [SP]);
  const problems = contractProblems(unknown, { kind: "contract" });
  assert.ok(problems.some((p) => /reads scored/.test(p)) && problems.some((p) => /no calibration/.test(p)),
    JSON.stringify(problems));
  // A quiet run that reports movement is rejected too.
  const quiet = [], qt = [];
  { let u = 500; for (let n = 0; n < N; n++) { qt.push(u); quiet.push(hOf(u)); u += SP; } }
  const qrows = decode(quiet, { table: fullTable, steps, indices: quiet.map((_, i) => i) });
  assert.deepEqual(contractProblems(scoreDecode(qrows, qt, [SP]), { kind: "quiet" }), []);
  const noisy = scoreDecode(qrows.map((r) => ({ ...r, event: "moved" })), qt, [SP]);
  assert.ok(contractProblems(noisy, { kind: "quiet" }).some((p) => /did not happen/.test(p)));
}

// ── the decode as the Z80 runs it (R6 §17.4 step 2, R7 §20.2 A) ──────────
// Assembled once, then run AS A SEQUENCE on one RAM — which is the only way
// the acquisition contract can be checked at all. The first version of this
// test rebuilt the CPU and the RAM for every reading, so the state machine it
// was checking never had a previous observation to be wrong about, and an
// unknown reading polluting the next real difference went straight past it.
//
// Four things are pinned: the initialisation does not depend on what the RAM
// held, the state machine matches the reference, the arithmetic matches the
// reference, and every path costs the same.
{
  const cfg = buildConfig({});
  const map = decodeMap(cfg);
  const UNITS = PHASE_TABLE.quantised.units, UNKNOWN = PHASE_TABLE.quantised.unknown;
  const tb = PHASE_TABLE.quantised.bytes;
  const STEP = 147;
  const ops = decodeOps(STEP, map);
  const src = ["        org $0000", "init:"];
  for (const l of decodeInitOps(map)) src.push(l.endsWith(":") ? l : `        ${l}`);
  src.push("        halt", "        ds $100-$,0", "body:");
  for (const o of ops) for (const l of o.asm) src.push(l.endsWith(":") ? l : `        ${l}`);
  src.push("        halt", `        ds $${map.table.toString(16)}-$,0`);
  for (let i = 0; i < 256; i += 16) src.push(`        db ${tb.slice(i, i + 16).join(",")}`);
  const d2 = mkdtempSync(join(tmpdir(), "dac-decode-"));
  let bytes;
  try { const f = join(d2, "d.z80"); writeFileSync(f, src.join("\n") + "\n"); bytes = assemble(f).bytes; }
  finally { rmSync(d2, { recursive: true, force: true }); }
  const BODY = 0x100;

  // One machine, reused: the state lives in its RAM exactly as it does on the
  // hardware. `run` is the read-and-decode the schedule performs.
  const ram = new Uint8Array(0x2000).fill(0xa5);     // NOT zero: see below
  ram.set(bytes.subarray(0, Math.min(bytes.length, ram.length)));
  const cpu = new Z80Cpu({ read: (a) => ram[a] ?? 0xff,
    write: (a, v) => { if (a < ram.length) ram[a] = v; } });
  const at = (entry) => { cpu.pc = entry; cpu.halted = false;
    let c = 0; while (!cpu.halted && c < 4000) c += cpu.step(); return c; };
  const read = () => ({
    known: ram[map.state + STATE.known], valid: ram[map.state + STATE.valid],
    delta: ram[map.state + STATE.delta], expect: ram[map.state + STATE.expect],
    count: ram[map.state + STATE.countLo] | (ram[map.state + STATE.countHi] << 8) });
  const decodeCost = new Set();
  const run = (h) => { cpu.a = h; decodeCost.add(at(BODY)); return read(); };

  // 1. INITIALISATION, from a RAM that is not zero anywhere.
  at(0x0000);
  assert.deepEqual(read(), { known: 0, valid: 0, delta: 0, expect: 0, count: 0 },
    "the boot init must not depend on what the RAM held");

  // 2. THE STATE MACHINE, as a sequence on that one machine. Both a known and
  // an unknown reading are needed, and the table has to actually contain them.
  const known = [...tb].findIndex((b) => b !== UNKNOWN);
  const known2 = [...tb].findIndex((b, i) => b !== UNKNOWN && i > known && b !== tb[known]);
  const unknown = [...tb].findIndex((b) => b === UNKNOWN);
  assert.ok(known >= 0 && known2 >= 0 && unknown >= 0, "the table must have both kinds of reading");
  const model = (prev, h) => refDecode(prev, h, STEP, { units: UNITS, unknown: UNKNOWN, table: tb });
  const story = [
    [known, "the first known reading is a base, not a difference"],
    [known2, "two consecutive known readings make a real difference"],
    [unknown, "an unknown reading breaks the chain"],
    [known, "the reading after an unknown one is a re-acquisition"],
    [known2, "and the one after THAT is a difference again"],
  ];
  let want = { ...INITIAL_STATE };
  for (const [h, why] of story) {
    want = model(want, h);
    assert.deepEqual(run(h), want, why);
  }
  assert.equal(want.valid, 0xff);
  // The bug this replaces: the reading after an unknown one used to publish a
  // difference from a number made out of $ff.
  assert.equal(model(model({ ...INITIAL_STATE, known: 0xff, expect: 0 }, unknown), known).valid, 0);

  // 3. RESTART, mid-sequence: the state goes back to the boot state and the
  // next known reading is a base again, not a difference across the restart.
  at(0x0000);
  assert.deepEqual(read(), { known: 0, valid: 0, delta: 0, expect: 0, count: 0 });
  assert.equal(run(known).valid, 0, "the reading after a restart cannot be a difference");

  // 4. THE COUNTER, over its carry and its wrap.
  for (const start of [0x00fe, 0x12fe, 0xfffe]) {
    ram[map.state + STATE.countLo] = start & 0xff;
    ram[map.state + STATE.countHi] = start >> 8;
    let n = start;
    for (let k = 0; k < 3; k++) { n = (n + 1) & 0xffff; assert.equal(run(known).count, n); }
  }

  // 5. THE ARITHMETIC, over every reading and every state it can be in.
  let compared = 0;
  for (let h = 0; h < 256; h++) for (const prevKnown of [0, 0xff]) for (const expect of [0, 1, 85, 86, 170]) {
    const prev = { known: prevKnown, valid: 0, delta: 0, expect, count: 0x1234 };
    ram[map.state + STATE.known] = prev.known;
    ram[map.state + STATE.valid] = prev.valid;
    ram[map.state + STATE.delta] = prev.delta;
    ram[map.state + STATE.expect] = prev.expect;
    ram[map.state + STATE.countLo] = prev.count & 0xff;
    ram[map.state + STATE.countHi] = prev.count >> 8;
    assert.deepEqual(run(h), model(prev, h), `h=${h} known=${prevKnown} expect=${expect}`);
    compared++;
  }
  assert.equal(compared, 256 * 2 * 5);
  // ONE cost, for every input, every state and both outcomes of all three
  // balanced branches.
  assert.equal(decodeCost.size, 1, `paths cost ${[...decodeCost].join("/")} cycles`);
  assert.equal([...decodeCost][0] - 4, ops.reduce((t, o) => t + o.cycles, 0));   // less the halt
}

// ── the same decode, cut into pieces a 2ch slot could hold (R7 §20.3) ─────
// The pieces are run SEPARATELY, with A and the flags clobbered between every
// pair, because that is what a slot boundary does in the complete engine:
// mix_one runs in every slot and it is the sample path. Only B, C and memory
// cross. If a piece secretly depended on a flag or on A, this fails.
{
  const cfg = buildConfig({});
  const map = decodeMap(cfg);
  const STEP = 147, TABLE = map.table, ST = map.state;
  const blocks = splitBlocks({ table: TABLE, state: ST, step: STEP });
  const src = ["        org $0000"];
  blocks.forEach((b, i) => {
    src.push(`blk${i}:`);
    for (const o of b.ops) for (const l of o.asm) src.push(l.endsWith(":") ? l : `        ${l}`);
    src.push("        halt");
  });
  src.push(`        ds $${TABLE.toString(16)}-$,0`);
  const tb = PHASE_TABLE.quantised.bytes;
  for (let i = 0; i < 256; i += 16) src.push(`        db ${tb.slice(i, i + 16).join(",")}`);
  const d3 = mkdtempSync(join(tmpdir(), "dac-split-"));
  let asm;
  try { const f = join(d3, "s.z80"); writeFileSync(f, src.join("\n") + "\n"); asm = assemble(f); }
  finally { rmSync(d3, { recursive: true, force: true }); }

  const ram = new Uint8Array(0x2000);
  ram.set(asm.bytes.subarray(0, Math.min(asm.bytes.length, ram.length)));
  let hv = 0;
  const cpu = new Z80Cpu({ read: (a) => a === 0x7f09 ? hv : (ram[a] ?? 0xff),
    write: (a, v) => { if (a < ram.length) ram[a] = v; } });
  const costs = blocks.map(() => new Set());
  const step1 = (h) => {
    hv = h;
    blocks.forEach((b, i) => {
      cpu.a = (i * 37 + h) & 0xff; cpu.f = (i * 91 + h) & 0xff;   // nothing survives
      cpu.pc = asm.symbols.get(`blk${i}`); cpu.halted = false;
      let c = 0; while (!cpu.halted && c < 4000) c += cpu.step();
      costs[i].add(c - 4);
    });
    return { known: ram[ST + SPLIT_STATE.known], valid: ram[ST + SPLIT_STATE.valid],
      delta: ram[ST + SPLIT_STATE.delta], expect: ram[ST + SPLIT_STATE.expect],
      count: ram[ST + SPLIT_STATE.countLo] | (ram[ST + SPLIT_STATE.countHi] << 8) };
  };
  for (let k = 0; k < SPLIT_STATE_SIZE; k++) ram[ST + k] = 0;
  let want = { ...INITIAL_STATE }, n = 0;
  const key = (o) => ["known", "valid", "delta", "expect", "count"].map((k) => o[k]).join(",");
  for (let pass = 0; pass < 2; pass++) for (let h = 0; h < 256; h++) {
    want = refDecode(want, h, STEP);
    assert.equal(key(step1(h)), key(want), `split decode disagreed at h=${h}`);
    n++;
  }
  assert.equal(n, 512);
  // One cost a piece. The VDP read is 13 on this CPU and 16 in the schedule —
  // the 3-cycle difference is the emulated machine's bank penalty, not the
  // instruction's, and the schedule is the one that has to be right.
  blocks.forEach((b, i) => {
    assert.equal(costs[i].size, 1, `piece "${b.name}" costs ${[...costs[i]].join("/")}`);
    assert.equal([...costs[i]][0], b.cycles - (i === 0 ? 3 : 0), `piece "${b.name}" cost`);
  });
  // …and the placement it is for: at the 79.6% target it does not close, and
  // the reason is granularity, not the total (R7 §20.3).
  const full = buildConfig({ voices: 2, complete: true, csm: true });
  const gen2 = generate(full);
  const head = gen2.slots.map((s) => 0.796 * s.cycles - s.row.work);
  assert.ok(head.reduce((a, b) => a + b, 0) > blocks.reduce((t, b) => t + b.cycles, 0),
    "the loop's TOTAL headroom is larger than the decode — the total is not the binding test");
  assert.ok(placeSplit(blocks, gen2.slots, { target: 0.796 }).failed,
    "the split must still fail to place at the 79.6% target");
  assert.ok(!placeSplit(blocks, gen2.slots, { target: 0.839 }).failed,
    "…and close at the 83.9% one, which is the number the ceiling question is about");

  // THE WALKER'S OWN CONTRACT (R10 §29.2). It used to keep walking `at % 80`
  // into a second and third lap and fold those pieces back onto the same
  // physical slots, which reorders the chain and still reports a placement. So
  // the deadline is checked against a synthetic loop where the arithmetic is
  // trivially known: 80 slots that hold exactly one piece each.
  const flat = (n, work) => [...Array(n).keys()].map((i) =>
    ({ cycles: 100, row: { slot: i, work } }));
  const one = (n) => [...Array(n).keys()].map((i) => ({ name: `p${i}`, cycles: 40, ops: [] }));
  {
    const slots = flat(80, 50);                       // headroom 50 at target 1.0
    const ok80 = placeSplit(one(80), slots, { target: 1 });
    assert.ok(!ok80.failed && ok80.laps === 1, "80 pieces must fit 80 one-piece slots");
    assert.equal(new Set(ok80.placed.map((p) => p.slot)).size, 80);
    const over = placeSplit(one(81), slots, { target: 1 });
    assert.ok(over.failed, "the 81st piece has no slot before the next read — it must NOT fold");
    assert.equal(over.placed.length, 80);
    // Two pieces DO share a slot when both fit, and the order is preserved.
    const roomy = flat(80, 10);                       // headroom 90 = two pieces
    const pair = placeSplit(one(4), roomy, { target: 1 });
    assert.deepEqual(pair.placed.map((p) => p.slot), [0, 0, 1, 1],
      "two dependent pieces belong in one slot when the slot holds them");
    assert.equal(pair.laps, 1);
    // …and a chain that needs more than the loop still fails rather than wraps.
    assert.ok(placeSplit(one(200), roomy, { target: 1 }).failed);
    // The deadline is ABSOLUTE, not modular: starting at slot 40 the chain has
    // 80 slots from there, not 40.
    const from40 = placeSplit(one(80), slots, { target: 1, from: 40 });
    assert.ok(!from40.failed && from40.laps === 1);
    assert.equal(from40.placed.at(-1).absolute, 119);
    assert.ok(placeSplit(one(81), slots, { target: 1, from: 40 }).failed);
  }
}

// ── the 15-level profile (R8 §23.2) ───────────────────────────────────────
// The level family is a PROFILE's choice, and the two profiles have to be
// different builds rather than one build reinterpreted. What is checked here is
// the definition, the mapping a command goes through, and the page number —
// which is a self-modified operand, so a page one past the family is not a
// fault, it is the phase table read as a volume table.
{
  const c16 = buildConfig({ voices: 2, complete: true });
  const c15 = buildConfig({ voices: 2, complete: true, levels: 15, workTarget: 0.839 });
  assert.equal(c16.ram.lut[1] - c16.ram.lut[0], 16 * 256);
  assert.equal(c15.ram.lut[1] - c15.ram.lut[0], 15 * 256);
  assert.equal(c15.ram.phase[0], c15.ram.lut[1], "the phase table is the page the family gave up");
  assert.equal(c15.ram.phase[1], c15.ram.ring[0], "…and the ring does not move");
  assert.deepEqual([c16.ram.ring, c16.ram.queue, c16.ram.glob, c16.ram.stack],
    [c15.ram.ring, c15.ram.queue, c15.ram.glob, c15.ram.stack]);

  // Level k of n scales by k/(n-1): silence at 0, unity at the top, both exact.
  for (const n of [16, 15]) {
    assert.deepEqual(tablesAgree(n), []);
    assert.equal(buildLut(n).length, n * 256);
    for (let b = 0; b < 256; b++) {
      assert.equal(scale(unbias(b), 0, n) + 0, 0, `level 0 of ${n} is not silence`);
      assert.equal(scale(unbias(b), n - 1, n), unbias(b), `level ${n - 1} of ${n} is not unity`);
    }
  }
  // 15 levels are NOT the 16-level table with a page removed: every level's
  // meaning is redefined, so the two families disagree in the middle and agree
  // only at silence and unity.
  const l16 = buildLut(16), l15 = buildLut(15);
  assert.notEqual(l16[7 * 256 + 200], l15[7 * 256 + 200]);
  assert.equal(l16[15 * 256 + 200], l15[14 * 256 + 200]);

  // The command mapping, written down rather than discovered: monotone, keeps
  // silence and unity, and — the cost — is not injective at 15.
  const map15 = [...Array(16).keys()].map((v) => levelFromCommand(v, 15));
  assert.deepEqual(map15, [0, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual([...Array(16).keys()].map((v) => levelFromCommand(v, 16)), [...Array(16).keys()]);
  for (let v = 1; v < 16; v++) assert.ok(map15[v] >= map15[v - 1], "the mapping must be monotone");

  // The page number is an operand, not an index: one past the family is the
  // phase table, and nothing about reading it would fault.
  for (const cfg of [c16, c15]) {
    const { first, last } = lutPages(cfg);
    assert.equal(last - first + 1, cfg.levels);
    assert.ok(pageIsALevel(cfg, first) && pageIsALevel(cfg, last));
    assert.ok(!pageIsALevel(cfg, last + 1), "a page past the family must not pass as a level");
    assert.ok(!pageIsALevel(cfg, first - 1));
  }
  assert.equal(lutPages(c15).last + 1, c15.ram.phase[0] >> 8,
    "the page one past the 15-level family IS the phase table");
  // The knob is checked, not trusted: a level count with no RAM map behind it
  // and the P1 form of a profile that has none are both refused.
  assert.throws(() => buildConfig({ voices: 2, complete: true, levels: 14 }), /levels must be/);
  assert.throws(() => buildConfig({ levels: 15 }), /no P1 form/);
}

// ── the bounded corrector's arithmetic (R9 §26.4, §26.5) ──────────────────
// The placement does not close (see the report), but the arithmetic is a
// separate question and it is settled here: the pieces are assembled and run
// SEPARATELY, with A and the flags clobbered between them, against the same
// reference the design is written in. Four deliberate faults have to be
// refused, including the one R9 §26.4 names — forgetting to take the applied
// correction off the phase the next expectation is built from, which makes the
// engine see its own correction as a displacement of the opposite sign.
{
  const ST = 0x1f10;
  const S = (n) => `$${(ST + SPLIT_STATE[n]).toString(16)}`;
  const TAGS = [["a0", "a1", "a2", "a3"], ["b0", "b1"], ["c0"]];

  const build = (fault) => {
    const blocks = correctorBlocks(S, TAGS, { fault });
    const src = ["        org $0000"];
    blocks.forEach((blk, i) => {
      src.push(`blk${i}:`);
      for (const o of blk.ops) for (const l of o.asm) src.push(l.endsWith(":") ? l : `        ${l}`);
      src.push("        halt");
    });
    for (const t of TAGS.flat())
      for (const o of ladderOps(t)) for (const l of o.asm) src.push(l.endsWith(":") ? l : `        ${l}`);
    const d = mkdtempSync(join(tmpdir(), "dac-corr-"));
    try { const f = join(d, "c.z80"); writeFileSync(f, src.join("\n") + "\n"); return { blocks, asm: assemble(f) }; }
    finally { rmSync(d, { recursive: true, force: true }); }
  };

  const score = (fault, extra = []) => {
    const { blocks, asm } = build(fault);
    const ram = new Uint8Array(0x2000);
    ram.set(asm.bytes.subarray(0, Math.min(asm.bytes.length, ram.length)));
    const cpu = new Z80Cpu({ read: (a) => ram[a] ?? 0xff,
      write: (a, v) => { if (a < ram.length) ram[a] = v; } });
    const costs = blocks.map(() => new Set());
    const opAddr = Object.fromEntries(TAGS.flat().map((t) => [t, asm.symbols.get(`corr_${t}`) + 1]));
    const run = () => blocks.forEach((blk, i) => {
      cpu.a = (i * 53 + 7) & 0xff; cpu.f = (i * 31) & 0xff;      // nothing survives
      cpu.pc = asm.symbols.get(`blk${i}`); cpu.halted = false;
      let c = 0; while (!cpu.halted && c < 4000) c += cpu.step();
      costs[i].add(c - 4);
    });
    const groupValue = (g) => ram[opAddr[TAGS[g][0]]] - CORR.neutral;
    const sameGroup = (g) => TAGS[g].every((t) => ram[opAddr[t]] === ram[opAddr[TAGS[g][0]]]);

    for (let k = 0; k <= SPLIT_STATE.kraw; k++) ram[ST + k] = 0;
    for (const t of TAGS.flat()) ram[opAddr[t]] = CORR.neutral;
    const cases = [];
    for (let d = -40; d <= 40; d++) cases.push({ valid: 0xff, delta: d });
    cases.push({ valid: 0, delta: 0 });                         // unknown: the debt is dropped
    for (const d of [75, 0, 0, 0, 0, -75, 0, 0, 0, 0]) cases.push({ valid: 0xff, delta: d });
    for (const d of [113, 0, 114, 0, 120, 0, -120, 0, 60, 0, 0]) cases.push({ valid: 0xff, delta: d });
    cases.push(...extra);

    let ref = { ...INITIAL_CORR }, bad = 0, n = 0, expired = 0;
    for (const c of cases) {
      // A case may PIN the debt: the ±112 boundary and the eight-bit wrap are
      // states the running sequence cannot be driven into by deltas alone, and
      // they are exactly the two the old code got wrong (R10 §29.4).
      if (c.debt !== undefined) { ram[ST + SPLIT_STATE.debt] = c.debt & 0xff; ref = { debt: c.debt }; }
      ram[ST + SPLIT_STATE.valid] = c.valid;
      ram[ST + SPLIT_STATE.delta] = c.delta & 0xff;
      ram[ST + SPLIT_STATE.phase] = 100;
      // The raw mask goes to the scratch byte and the corrector's gate makes
      // the single write into the record's own KNOWN (R10 §29.3).
      ram[ST + SPLIT_STATE.kraw] = 0xff;
      ram[ST + SPLIT_STATE.known] = 0;
      ref = refCorrect(c.valid ? { debt: ref.debt } : { debt: 0 }, c.valid ? c.delta : 0);
      run();
      if (ref.expired) expired++;
      n++;
      const got = { debt: (ram[ST + SPLIT_STATE.debt] << 24) >> 24,
        a: groupValue(0), b: groupValue(1), c: groupValue(2),
        known: ram[ST + SPLIT_STATE.known], phase: ram[ST + SPLIT_STATE.phase] };
      const want = { debt: ref.debt, a: ref.a, b: ref.b, c: ref.c,
        known: ref.expired ? 0 : 0xff,
        phase: ((100 - 3 * ref.applied) % 171 + 171) % 171 };
      if (JSON.stringify(got) !== JSON.stringify(want) || !sameGroup(0) || !sameGroup(1)) bad++;
    }
    const oneCost = blocks.every((blk, i) => costs[i].size === 1 && [...costs[i]][0] === blk.cycles);
    return { n, bad, expired, oneCost, blocks };
  };

  // The reference first: it has to converge, and it has to expire rather than
  // saturate past its capability.
  {
    let worst = 0, slowest = 0;
    for (let d0 = -112; d0 <= 112; d0++) {
      let st = refCorrect({ debt: 0 }, d0), k = 0;
      if (st.expired) continue;
      while (st.applied !== 0 && k < 40) { st = refCorrect(st, 0); k++; if (st.expired) break; }
      if (!st.expired) { worst = Math.max(worst, Math.abs(st.debt)); slowest = Math.max(slowest, k + 1); }
    }
    assert.ok(worst * 20 < 60, `the corrector settles at ${worst} units = ${worst * 20} master`);
    assert.ok(slowest <= 6, `it takes ${slowest} observations`);
    assert.ok(refCorrect({ debt: 0 }, 120).expired, "past the capability it must expire");
    assert.ok(!refCorrect({ debt: 0 }, 75).expired, "…and inside the contract it must not");
    // Every quantum in range is reachable — one shared value could not do that.
    for (let q = -MAX_QUANTA; q <= MAX_QUANTA; q++)
      assert.equal(splitQuanta(q).applied, q, `${q} quanta is not reachable`);
  }

  // THE DEBT BOUNDARY, in the reference and then on the Z80 (R10 §29.4). §27
  // and §28 claimed ±112 and the code did not do it: it narrowed the sum to a
  // byte and asked |q| > 28 afterwards, which takes +113, +114 and -113 and
  // first refuses at +115. Each of these is one observation, so they are pinned
  // rather than walked into.
  {
    assert.equal(MAX_DEBT_UNITS, debtLimitFor(MAX_QUANTA));
    for (const d of [112, -112]) {
      assert.ok(!refCorrect({ debt: 0 }, d).expired, `${d} units is inside the limit`);
      assert.ok(refCorrect({ debt: 0 }, d + Math.sign(d)).expired,
        `${d + Math.sign(d)} units is past it`);
    }
    // The one that the eight-bit sum accepted as a valid debt of the opposite
    // sign: 100 + 75 is 175, not -81.
    assert.ok(refCorrect({ debt: 100 }, 75).expired, "175 units must expire");
    assert.ok(refCorrect({ debt: -100 }, -75).expired, "-175 units must expire");
    assert.ok(refCorrect({ debt: 56 }, 56).expired === false, "112 units is still inside");
  }

  const BOUNDARY = [
    { valid: 0xff, debt: 0, delta: 112 }, { valid: 0xff, debt: 0, delta: 113 },
    { valid: 0xff, debt: 0, delta: -112 }, { valid: 0xff, debt: 0, delta: -113 },
    { valid: 0xff, debt: 100, delta: 75 }, { valid: 0xff, debt: -100, delta: -75 },
    { valid: 0xff, debt: 56, delta: 56 }, { valid: 0xff, debt: 57, delta: 56 },
    { valid: 0xff, debt: 112, delta: 0 }, { valid: 0xff, debt: 112, delta: 1 },
    { valid: 0xff, debt: -90, delta: -60 }, { valid: 0xff, debt: 90, delta: 60 },
  ];
  {
    const r = score(null, BOUNDARY);
    assert.equal(r.bad, 0, `the corrector disagreed on ${r.bad} of ${r.n}`);
    assert.ok(r.oneCost, "a corrector piece has more than one cost");
    assert.ok(r.expired > 0, "the expiry path was never taken");
  }
  // …and it refuses each way of getting it wrong, including the eight-bit sum.
  for (const fault of Object.keys(CORR_FAULTS)) {
    const r = score(fault, BOUNDARY);
    assert.ok(r.bad > 0, `the fault "${fault}" was accepted`);
  }
  // There is ONE shape. The 16-quantum variant §28 measured is gone rather than
  // kept behind a flag: the declared contract reaches 1,500 master = 75 units,
  // which asks for 19 quanta, so a 16-quantum corrector expires INSIDE the
  // contract it exists to hold. Asking for it is an error, not a fallback.
  assert.throws(() => correctorBlocks(S, TAGS, { maxQuanta: 16 }), /one corrector shape/);
  assert.throws(() => correctorLive(TAGS, { maxQuanta: 16 }), /one corrector shape/);
}

// ── the split decode in the REAL loop (R8 §23.3) ──────────────────────────
// Clobbering A and the flags between the pieces was not enough. What runs
// between them on the machine is the mixer, the RESERVED padding standing in
// for the unwritten 2ch features, and the slot's own pad — and the pad's
// cheapest filler is `ld b,k` / `djnz $`, which leaves B at zero. So this
// generates the whole engine with the pieces in it, assembles it, and runs it.
//
// It is not a formality. The first version that got this far placed `keep
// known` in slot 16 behind that slot's `ld b,5 / djnz $`, so it stored a B the
// reserve had already zeroed: every published record came out as the boot
// state, while the DAC stayed perfect and every slot stayed inside its budget.
{
  const cfg = buildConfig({ voices: 2, complete: true, levels: 15, workTarget: 0.839 });
  const r = generateSplit(cfg, { stackFill: true });
  assert.ok(r.ok, `the split image did not generate: ${r.stage} ${r.error ?? ""}`);
  const d4 = mkdtempSync(join(tmpdir(), "dac-split2ch-"));
  let built;
  try { const f = join(d4, "e.z80"); writeFileSync(f, r.gen.text); built = assemble(f); }
  finally { rmSync(d4, { recursive: true, force: true }); }
  // It has to FIT, and the assembler's own assert is what says so.
  assert.ok(built.symbols.get("code_end") <= cfg.ram.code[1], "the split image overran the code region");

  const tb = PHASE_TABLE.quantised.bytes, UNK = PHASE_TABLE.quantised.unknown;
  const known = [...tb.keys()].filter((h) => tb[h] !== UNK);
  const unknown = [...tb.keys()].filter((h) => tb[h] === UNK);
  assert.ok(known.length && unknown.length);
  const seq = [];
  for (let i = 0; i < 18; i++) {
    seq.push(known[(i * 37) % known.length]);
    if (i % 5 === 2) seq.push(unknown[(i * 13) % unknown.length]);   // break the chain
  }
  let reads = 0;
  const machine = new Machine(cfg, built, {
    rom: Uint8Array.from({ length: 512 }, (_, i) => (i * 73 + 19) & 255),
    vdp: () => seq[Math.min(reads++, seq.length - 1)],
  });
  const ST = r.map.state;
  const state = () => ({
    known: machine.ram[ST + SPLIT_STATE.known], valid: machine.ram[ST + SPLIT_STATE.valid],
    delta: machine.ram[ST + SPLIT_STATE.delta], expect: machine.ram[ST + SPLIT_STATE.expect],
    count: machine.ram[ST + SPLIT_STATE.countLo] | (machine.ram[ST + SPLIT_STATE.countHi] << 8) });
  const key = (o) => ["known", "valid", "delta", "expect", "count"].map((k) => o[k]).join(",");

  const LOOP = cfg.slotCycles.reduce((a, b) => a + b, 0) * (cfg.cycleSlots / cfg.groupSlots);
  let want = { ...INITIAL_STATE }, at = 0, checked = 0;
  for (let lap = 0; lap < seq.length; lap++) {
    const until = cfg.cycleSlots * (lap + 1) + 1;    // one write into the next lap
    // IN SMALL STEPS near the boundary. `run()` stops where it is asked to,
    // not where the DAC count reaches the target, so a coarse step overshoots
    // — and once the record's pieces moved earlier in the loop, an overshoot of
    // a few slots was enough to read the NEXT observation's VALID.
    let guard = 0;
    while (machine.trace.dacCycle.length < until && guard++ < 4000) { at += 200; machine.run(at); }
    assert.ok(machine.trace.dacCycle.length >= until, `the engine stalled on lap ${lap}`);
    want = refDecode(want, seq[lap], r.advance);
    assert.equal(key(state()), key(want), `lap ${lap}, reading $${seq[lap].toString(16)}`);
    checked++;
  }
  assert.equal(checked, seq.length);
  // One reading a lap. The run may overshoot into the next lap's read before it
  // stops, which is why this is a range and not an equality — the readings are
  // still consumed in order, and each lap is compared against its own.
  assert.ok(reads === seq.length || reads === seq.length + 1,
    `${reads} readings over ${seq.length} laps`);
  // The DAC did not move while all that happened, and the model charges the
  // VDP read the same window wait the schedule does.
  const gaps = [];
  for (let i = 1; i < machine.trace.dacCycle.length; i++)
    gaps.push(machine.trace.dacCycle[i] - machine.trace.dacCycle[i - 1]);
  assert.deepEqual([...new Set(gaps)].sort((a, b) => a - b), [358, 359],
    `the DAC interval moved: ${[...new Set(gaps)].sort((a, b) => a - b)}`);
  assert.equal(machine.trace.stray.length, 0);
  // Per slot at the profile's ceiling, and the average at the shipped one.
  const worst = r.gen.placement.worst, mean = r.gen.placement.meanWorkPct;
  assert.ok(worst.workPct <= cfg.workTarget * 100 + 0.05,
    `slot ${worst.slot} is at ${worst.workPct}%, over the ${cfg.workTarget * 100}% ceiling`);
  assert.ok(mean <= cfg.meanTarget * 100 + 0.05, `the mean is ${mean}%`);
  // And BC really is what carries: the liveness is not a comment.
  assert.ok(r.preserve.liveIn.size > 0 && r.preserve.liveOut.size > 0);
}

// ── the 68k/Z80 runtime protocol, as a reference (R12 §33.2-§33.4) ───────
// ONE LAYOUT, checked to be one: the JS object, the Z80 equates and the 68000
// header are all read back here and required to name the same addresses. The
// orders are checked by walking EVERY interleaving rather than by arguing about
// them — a reader may run between any two of the publisher's byte writes — and
// each way of getting the order wrong has to produce a torn reading.
{
  const cfg = buildConfig({ voices: 2, complete: true, levels: 15, workTarget: 0.839 });
  const BASE = cfg.ram.pub[0];
  const L = protocolLayout(BASE);

  // It fits the region the map already reserves, with the spare R12 §33.2 asks
  // to leave undefined, and it does not run into the next one.
  assert.equal(PROTOCOL_BYTES, 24);
  assert.equal(PROTOCOL_SPARE, 8);
  assert.equal(cfg.ram.pub[1] - cfg.ram.pub[0], PUB_REGION_BYTES);
  assert.equal(L.size, PROTOCOL_BYTES);
  assert.ok(BASE + L.size <= cfg.ram.pub[1], "the protocol overruns the publication region");

  // The three emitters, read back. A hand-kept second copy of an offset is the
  // failure §33.2 names, so the asm and the header are PARSED and compared with
  // the object rather than eyeballed.
  const asm = new Map([...protocolAsm(BASE).matchAll(/^(\S+)\s+equ \$([0-9a-f]+)$/gm)]
    .map((m) => [m[1], parseInt(m[2], 16)]));
  const hdr = new Map([...protocolHeader(BASE).matchAll(/^#define (MML_PROTO_\S+) 0x([0-9A-F]+)/gm)]
    .map((m) => [m[1], parseInt(m[2], 16)]));
  const up = (n) => n.replace(/([A-Z])/g, "_$1").toUpperCase();
  for (let f = 0; f < 2; f++)
    for (const [name] of SNAPSHOT) {
      assert.equal(asm.get(`PROTO_F${f}_${up(name)}`), L.faces[f][name].offset, `asm F${f} ${name}`);
      assert.equal(hdr.get(`MML_PROTO_F${f}_${up(name)}`), L.faces[f][name].offset, `header F${f} ${name}`);
    }
  for (const [name] of CONTROL) {
    assert.equal(asm.get(`PROTO_H_${up(name)}`), L.control[name].offset, `asm host ${name}`);
    assert.equal(hdr.get(`MML_PROTO_H_${up(name)}`), L.control[name].offset, `header host ${name}`);
  }
  assert.equal(asm.get("PROTO_SELECT"), L.publishSelect.offset);
  assert.equal(hdr.get("MML_PROTO_SELECT"), L.publishSelect.offset);
  assert.equal(hdr.get("MML_PROTO_BYTES") ?? PROTOCOL_BYTES, PROTOCOL_BYTES);

  // ── publication, every interleaving ────────────────────────────────────
  const mem = new Uint8Array(0x2000);
  const snaps = [
    { bootGeneration: 0x1234, phaseGeneration: 0x00, boundarySampleIndex: 0x00000050, observationNumber: 1 },
    { bootGeneration: 0x1234, phaseGeneration: 0x01, boundarySampleIndex: 0xfffffff0, observationNumber: 0xfffe },
    { bootGeneration: 0x1234, phaseGeneration: 0xff, boundarySampleIndex: 0x00000010, observationNumber: 0x0001 },
  ];
  let select = 0;
  for (const snap of snaps) {
    const steps = publishSteps(L, select, snap);
    assert.equal(tornSnapshotPossible(L, mem, snap, steps), null,
      "a reader must see either the whole old snapshot or the whole new one");
    for (const [, v] of steps.map((x) => [x[0], x[1]])) void v;
    for (const [a, v] of steps) mem[a] = v;
    select ^= 1;
    const got = readSnapshot(mem, L);
    assert.equal(got.select, select);
    for (const k of ["bootGeneration", "phaseGeneration", "boundarySampleIndex", "observationNumber"])
      assert.equal(got[k], snap[k], `published ${k}`);
  }
  // …and each way of getting the order wrong is caught.
  for (const fault of ["select-first", "half-face"]) {
    const snap = { bootGeneration: 0x1234, phaseGeneration: 2, boundarySampleIndex: 0x0a0b0c0d,
      observationNumber: 0x0203 };
    const bad = faultySteps(L, select, snap, fault);
    assert.ok(tornSnapshotPossible(L, mem, snap, bad),
      `the fault "${fault}" produced no torn reading — the check is not checking`);
  }

  // ── the host's control block, gated on its commit byte ─────────────────
  {
    const base = new Uint8Array(mem);
    const ctl = { bootGeneration: 0x1234, phaseGeneration: 3, queueHead: 12,
      hostCommit: (readControl(base, L).hostCommit + 1) & 0xff };
    assert.equal(tornControlPossible(L, base, ctl, controlSteps(L, ctl)), null,
      "a new commit must mean every field behind it is already there");
    assert.ok(tornControlPossible(L, base, ctl, faultyControlSteps(L, ctl, "commit-first")),
      "committing first must be caught");
    for (const [a, v] of controlSteps(L, ctl)) base[a] = v;
    assert.deepEqual(readControl(base, L), ctl);
  }

  // ── a snapshot from another run is not this run's ──────────────────────
  {
    const m = new Uint8Array(mem);
    const old = { bootGeneration: 0x1233, phaseGeneration: 0, boundarySampleIndex: 99,
      observationNumber: 7 };
    for (const [a, v] of publishSteps(L, readSnapshot(m, L).select, old)) m[a] = v;
    const got = readSnapshot(m, L);
    assert.notEqual(got.bootGeneration, 0x1234,
      "the host must be able to tell a previous run's snapshot from this run's");
  }

  // ── the queue: the payload first, the head last ────────────────────────
  {
    const QBASE = 0x1d00, QSIZE = 64;
    const rec = { size: 8, type: 3, applyAtLow: 0x1234, payload: [9, 8, 7, 6] };
    for (const fault of [null, "head-first"]) {
      const m = new Uint8Array(mem);
      m[L.control.queueHead.offset] = 0;
      const steps = enqueueSteps(L, QBASE, QSIZE, 0, rec, fault);
      let sawPartial = false, sawWhole = false;
      const scratch = new Uint8Array(m);
      for (let k = 0; k <= steps.length; k++) {
        const got = dequeue(scratch, L, QBASE, QSIZE, 0);
        if (got && !got.incomplete) {
          // Whatever a consumer is allowed to take has to BE the record.
          if (got.type === rec.type && got.applyAtLow === rec.applyAtLow
            && got.payload.join() === rec.payload.join()) sawWhole = true;
          else sawPartial = true;
        }
        if (k < steps.length) scratch[steps[k][0]] = steps[k][1];
      }
      assert.ok(sawWhole, `the ${fault ?? "correct"} order never delivered the record`);
      if (fault === null) assert.ok(!sawPartial, "a correctly ordered append was read half-written");
      else assert.ok(sawPartial, "advancing the head first must be visible as a half-written record");
    }
  }

  // ── the wraps, one question each ───────────────────────────────────────
  // 16-bit command time against a 32-bit output index.
  for (const at of [0xfff0, 0xfffe, 0xffff, 0x00000000, 0x0001, 0x7fff0000, 0xfffffff0, 0xffffffff]) {
    for (const ahead of [1, 2, 16, 32766, 32767]) {
      const low = (at + ahead) & 0xffff;
      const t = extendTime(low, at);
      assert.ok(!t.late, `${ahead} ahead of ${at} read as late`);
      assert.equal(t.at, (at + ahead) >>> 0, `${ahead} ahead of ${at}`);
      assert.equal(outputAdvance(at, t.at), ahead, "the extension must move forward");
    }
    assert.ok(extendTime(at & 0xffff, at).late, "the current sample is not the future");
    for (const behind of [1, 100, 32768]) {
      const t = extendTime((at - behind) & 0xffff, at);
      assert.ok(t.late, `${behind} behind ${at} read as future`);
    }
  }
  // A late command lands on the first block boundary NOT already built, and
  // never inside the 17 samples the build cursor has finished.
  for (const at of [0, 1, 15, 16, 100, 0xfffffff0]) {
    const t = lateTarget(at, cfg.lead, cfg.blockSamples);
    assert.equal(t % cfg.blockSamples, 0, "a late command must land on a block boundary");
    assert.ok(outputAdvance(at, t) >= cfg.lead, "…at or past the build cursor, never behind it");
    assert.ok(outputAdvance(at, t) < cfg.lead + cfg.blockSamples, "…and the FIRST such boundary");
  }
  // The phase generation's own wrap: $ff -> $00 is one step, not none.
  assert.equal(genAdvance(0xff, 0x00), 1);
  assert.equal(genAdvance(0x00, 0xff), 255);
  assert.equal(genAdvance(7, 7), 0);
  assert.ok(phaseInvalidated(0xff, 0x00), "$ff -> $00 is an invalidation, not a no-op");
  assert.ok(!phaseInvalidated(9, 9));
  // The 32-bit output index wraps too, and it must not read as a rewind.
  assert.equal(outputAdvance(0xffffffff, 0), 1);
  assert.equal(outputAdvance(0xfffffff0, 0x0f), 31);
}

// ── the code ledger (R11 §31.1) ───────────────────────────────────────────
// `code_end + estimate` double-counts, and it has now drifted back to the plain
// sum twice. A `complete` build EXECUTES the unwritten features' cycles as
// tagged padding, so those bytes are already in the image and the real feature
// REPLACES them. The padding is measured from the same generated object rather
// than tabulated — only ops the generator tagged `reserved`, so a slot's own pad
// and a correction ladder's nops, which no feature replaces, stay in.
{
  const build = (opt) => {
    const cfg = buildConfig({ voices: 2, complete: true, csm: false, levels: 15,
      workTarget: 0.839, ...opt.cfg });
    const r = generateSplit(cfg, { stackFill: true, ...opt.opt });
    assert.ok(r.ok, `the ledger's image did not generate: ${r.stage}`);
    const d = mkdtempSync(join(tmpdir(), "dac-ledger-"));
    let end;
    try { const f = join(d, "e.z80"); writeFileSync(f, r.gen.text); end = assemble(f).symbols.get("code_end"); }
    finally { rmSync(d, { recursive: true, force: true }); }
    return codeLedger(cfg, r.gen, end);
  };
  const plain = build({ cfg: {}, opt: {} });
  const corr = build({ cfg: { correctorBudget: true }, opt: { correct: true } });
  assert.deepEqual(
    { plain: [plain.engine, plain.reserved, plain.owed, plain.finished],
      corr: [corr.engine, corr.reserved, corr.owed, corr.finished] },
    { plain: [2089, 570, 608, 2127], corr: [2291, 437, 538, 2392] },
    "the code ledger moved — say so rather than letting it drift");
  assert.ok(plain.spare > 0 && corr.spare > 0, "the finished estimate must fit the region");
  assert.equal(plain.region, 2560, "the code region is not to be widened (R11 §31.1)");
  // The padding it subtracts is the RESERVED padding and nothing else: a build
  // with no reservations has none to subtract, and the ladder's own nops — which
  // no feature replaces — must not be counted.
  const p1 = buildConfig({ voices: 2 });
  assert.equal(reservedPadBytes(generate(p1)), 0, "a build with no reservations reserves no bytes");
}

// ── the corrector IN THE LOOP, and the correction read back off the DAC ───
// (R10 §29.3.)
//
// The piece-level test above runs the arithmetic and nothing else: it does not
// include the ladders and it does not include the next read, so it cannot see
// the one-observation skew that put the ladders before their own writes. This
// does. The image is generated with the corrector in it, assembled, run, and
// the correction is recovered TWICE — from the seven ladder operands, and
// independently from the DAC intervals those seven slots actually produced.
{
  const cfg = buildConfig({ voices: 2, complete: true, csm: true, levels: 15,
    workTarget: 0.839, correctorBudget: true });
  // THE COUNTER STARTS FOUR SHORT OF THE WRAP (R11 §31.2): 65,536 observations
  // is 8.7 minutes and the wrap has to be reached, not waited for.
  const COUNT_FROM = 0xfffc;
  const r = generateSplit(cfg, { stackFill: true, correct: true, countFrom: COUNT_FROM });
  assert.ok(r.ok, `the corrector image did not generate: ${r.stage} ${r.error ?? ""}`);
  // THE CAUSAL ORDER, from the placement rather than from the intention: every
  // ladder is after the last write that decides it and before the next read.
  const writes = r.walk.placed.filter((p) => p.block.name.startsWith("corr write"));
  const lastWrite = Math.max(...writes.map((p) => p.absolute));
  for (const l of r.ladders) {
    assert.ok(l.absolute >= lastWrite, `ladder ${l.tag} runs before its own operand is written`);
    assert.ok(l.absolute < r.walk.deadline, `ladder ${l.tag} runs after the next read`);
  }
  const expectAt = r.walk.placed.find((p) => p.block.name === "publish expect store").absolute;
  assert.ok(expectAt >= lastWrite, "EXPECT is stored before the decision is complete");
  assert.equal(r.walk.laps, 1);

  const d5 = mkdtempSync(join(tmpdir(), "dac-corr2ch-"));
  let built;
  try { const f = join(d5, "e.z80"); writeFileSync(f, r.gen.text); built = assemble(f); }
  finally { rmSync(d5, { recursive: true, force: true }); }
  assert.ok(built.symbols.get("code_end") <= cfg.ram.code[1], "the corrector image overran the code region");

  const tb = PHASE_TABLE.quantised.bytes, UNK = PHASE_TABLE.quantised.unknown;
  const units = PHASE_TABLE.quantised.units;
  const known = [...tb.keys()].filter((h) => tb[h] !== UNK);
  const unknown = [...tb.keys()].filter((h) => tb[h] === UNK);
  // A sequence that MOVES: a quiet run corrects nothing and would pass with the
  // ladders switched off entirely. These readings put a different displacement
  // in front of the corrector at nearly every observation, with two unknown
  // readings to break the chain and re-acquire.
  const seq = [];
  for (let i = 0; i < 24; i++) {
    seq.push(known[(i * 37 + i * i) % known.length]);
    // A reading the table does not cover BREAKS THE CHAIN: the difference is not
    // valid, the debt is dropped rather than repaid, and the next known reading
    // is a base. Two singles and one run of three, so a re-acquisition after a
    // longer gap is covered too (R11 §31.2).
    if (i === 7 || i === 16) seq.push(unknown[(i * 13) % unknown.length]);
    if (i === 11) for (let k = 0; k < 3; k++) seq.push(unknown[(i * 7 + k) % unknown.length]);
  }
  let reads = 0;
  const machine = new Machine(cfg, built, {
    rom: Uint8Array.from({ length: 512 }, (_, i) => (i * 73 + 19) & 255),
    vdp: () => seq[Math.min(reads++, seq.length - 1)],
  });
  const ST = r.map.state;
  const opAddr = Object.fromEntries(r.ladders.map((l) => [l.tag, built.symbols.get(`corr_${l.tag}`) + 1]));

  // The decode and the corrector as ONE reference: the fold changes the phase
  // the next expectation is built from, so they cannot be checked apart.
  const refBoth = (st, corr, reading, step) => {
    const phase = tb[reading];
    const k = phase === UNK ? 0 : 0xff;
    const valid = k & st.known;
    let d = (phase - st.expect) % units;
    if (d < 0) d += units;
    if (d >= (units + 1) >> 1) d -= units;
    const delta = valid ? d : 0;
    const c = refCorrect({ debt: valid ? corr.debt : 0 }, delta);
    const k2 = c.expired ? 0 : k;
    const ph = ((phase - CORR.unitsPerQuantum * c.applied) % units + units) % units;
    return { st: { known: k2, valid, delta: delta & 0xff, count: (st.count + 1) & 0xffff,
      expect: k2 ? (ph + step) % units : 0 }, corr: c };
  };

  let st = { ...INITIAL_STATE, count: COUNT_FROM }, corr = { ...INITIAL_CORR };
  let at = 0, moved = 0, expired = 0, unknowns = 0, reacquired = 0, wrapped = 0;
  let prevKnown = 0;
  for (let lap = 0; lap < seq.length; lap++) {
    const until = cfg.cycleSlots * (lap + 1) + 1;
    let guard = 0;
    while (machine.trace.dacCycle.length < until && guard++ < 6000) { at += 200; machine.run(at); }
    assert.ok(machine.trace.dacCycle.length >= until, `the engine stalled on lap ${lap}`);
    const want = refBoth(st, corr, seq[lap], r.advance);
    const before = st;
    st = want.st; corr = want.corr;
    if (corr.expired) expired++;
    if (corr.applied !== 0) moved++;
    if (!st.known) unknowns++;
    if (st.known && !st.valid && lap) reacquired++;
    if (st.count < before.count) wrapped++;
    const got = { known: machine.ram[ST + SPLIT_STATE.known],
      valid: machine.ram[ST + SPLIT_STATE.valid],
      delta: machine.ram[ST + SPLIT_STATE.delta],
      expect: machine.ram[ST + SPLIT_STATE.expect],
      count: machine.ram[ST + SPLIT_STATE.countLo] | (machine.ram[ST + SPLIT_STATE.countHi] << 8),
      debt: (machine.ram[ST + SPLIT_STATE.debt] << 24) >> 24 };
    assert.deepEqual(got, { ...st, debt: corr.debt },
      `lap ${lap}, reading $${seq[lap].toString(16)}`);
    // What the seven ladders were told to do. One slot is one quantum, so the
    // sum of the seven entries IS 4a + 2b + c — the grouping is in which slots
    // share a value, not in an arithmetic done here.
    const byOperand = r.ladders.reduce((t, l) =>
      t + machine.ram[opAddr[l.tag]] - CORR.neutral, 0);
    assert.equal(byOperand, corr.applied, `lap ${lap}: the operands say ${byOperand} quanta`);
    // …and what they ACTUALLY did to the DAC, measured off the intervals rather
    // than read back out of RAM. A ladder slot is `base - 4a` cycles long.
    let byInterval = 0;
    for (const l of r.ladders) {
      const i = lap * cfg.cycleSlots + l.slot;
      const gap = machine.trace.dacCycle[i + 1] - machine.trace.dacCycle[i];
      const base = cfg.slotCycles[l.slot % cfg.groupSlots];
      byInterval += (base - gap) / CORR.quantumCycles;
      assert.ok(gap >= 342 && gap <= 375, `lap ${lap}: a DAC interval of ${gap} cycles`);
    }
    assert.equal(byInterval, corr.applied,
      `lap ${lap}: the DAC moved by ${byInterval} quanta where ${corr.applied} was decided`);
  }
  assert.ok(moved >= 8, `only ${moved} of ${seq.length} observations corrected anything`);
  assert.ok(expired === 0, "this sequence should stay inside the debt limit");
  assert.equal(machine.trace.stray.length, 0);
  // …and the paths R11 §31.2 asks to see taken, counted rather than assumed. An
  // unknown reading, a re-acquisition after one and after three, and the 16-bit
  // observation number carrying past $FFFF — all of them THROUGH the corrector,
  // which is the part that had never been exercised.
  assert.ok(unknowns >= 5, `only ${unknowns} unknown readings`);
  assert.ok(reacquired >= 3, `only ${reacquired} re-acquisitions`);
  assert.equal(wrapped, 1, `the observation counter wrapped ${wrapped} times`);
  // The debt is DROPPED across a break, not carried: an invalid difference has
  // nothing to repay and the engine is openly at a new relative phase.
  {
    let sim = { ...INITIAL_STATE, count: COUNT_FROM }, c = { ...INITIAL_CORR }, drops = 0;
    for (const h of seq) {
      const w = refBoth(sim, c, h, r.advance);
      if (!w.st.valid && c.debt !== 0) drops++;
      sim = w.st; c = w.corr;
      if (!w.st.valid) assert.equal(c.debt, 0, "an invalid difference must leave no debt");
    }
    assert.ok(drops >= 1, "no break in the chain actually dropped a debt");
  }

  // `corr-one-late`: the ladders placed before their own writes, which is what
  // the code did until R10 §29.3. The generator has to refuse it, and if it ever
  // places again the causal check above is what catches it.
  const late = generateSplit(cfg, { stackFill: true, correct: true, ladderLate: true });
  assert.ok(!late.ok || late.ladders.every((l) => l.absolute < lastWrite),
    "the one-observation-late placement must not pass as the corrected one");
  if (late.ok) {
    const w = late.walk.placed.filter((p) => p.block.name.startsWith("corr write"));
    assert.ok(late.ladders.some((l) => l.absolute < Math.max(...w.map((p) => p.absolute))),
      "corr-one-late did not actually run a ladder before its operand was written");
  }
}

// ── the stop a window contains (R9 §26.3) ─────────────────────────────────
// The engine is a static schedule, so a bus stop MOVES it rather than slowing
// it: an interval that contains one is the laid-out interval plus the stop, and
// subtracting the overlap is what lets a disturbed run be scored at all. The
// rule it replaces skipped any interval containing a stop, which with one read
// a loop and a stall every 3,000 master skipped every interval there was.
{
  const S = [[10, 20], [30, 40], [50, 60]];
  const at = (a, b) => stoppedWithin(a, b, S).stopped;
  assert.equal(at(0, 100), 30, "three stops, all inside");
  assert.equal(at(12, 18), 6, "a window inside one stop");
  assert.equal(at(15, 35), 10, "two partial overlaps");
  assert.equal(at(0, 45), 20, "TWO stops in one window are both counted");
  // The boundaries, defined rather than discovered: a stop is [start, end) and
  // a window is [a, b), so touching at either end contributes nothing.
  assert.equal(at(20, 30), 0, "a stop ending exactly where the window starts");
  assert.equal(at(0, 10), 0, "a stop starting exactly where the window ends");
  assert.equal(at(20, 21), 0);
  assert.equal(at(59, 60), 1, "…and one master of overlap is one master");
  assert.equal(at(0, 0), 0);
  assert.equal(at(100, 200), 0, "past every stop");
  // `next` lets a caller walk intervals in order without rescanning.
  assert.equal(stoppedWithin(45, 55, S).next, 2);
  // A subtracted interval reproduces the schedule exactly: this is the shape
  // the 4 B stall case is scored in.
  const NOM = 1000;
  for (const stop of [[100, 140], [990, 1010]]) {
    const b = NOM + (stop[1] - stop[0]);
    assert.equal((b - 0) - stoppedWithin(0, b, [stop]).stopped, NOM);
  }
}

// ── the record check, driven by records that are wrong ───────────────────
// (R7 §20.2 B, and the terminal rule rebuilt for R8 §23.4.)
//
// The end-to-end faults break every record at once, so they cannot show that
// each kind of breakage is NAMED. These do. The terminal rule gets its own set:
// a measurement stops somewhere, and the only thing that may be excused is the
// last read's record ARRIVING AS A CORRECT PREFIX of itself — no fields at all
// included. The rule it replaces decided by subtraction, so a final record that
// was complete but out of order came back as short = -1 with outOfOrder = 1 and
// a caller adding the counts up saw nothing wrong.
{
  const NAMES = ["a", "b", "c"];
  const READS = [0, 100, 200, 300].map((time) => ({ time }));
  const fld = (time, field, value) => ({ time, field, value });
  const good = (n, base) => NAMES.map((_, k) => fld(base + k + 1, k, n * 10 + k));
  const whole = READS.flatMap((r, n) => good(n, r.time));
  const check = (recs, reads = READS) => recordsBetweenReads(reads, recs, NAMES);
  const clean = check(whole);
  assert.deepEqual(clean.problems, { late: 0, short: 0, extra: 0, outOfOrder: 0 });
  assert.deepEqual(clean.rows.map((r) => r && r.a), [0, 10, 20, 30]);
  assert.equal(clean.incompleteTail, 0);
  assert.equal(clean.broken, 0);
  assert.deepEqual(clean.kinds, []);

  // ── faults in the MIDDLE, which are never excused ──
  const drop = whole.filter((x) => !(x.field === 1 && x.value === 11));
  assert.equal(check(drop).problems.short, 1);
  assert.equal(check(drop).rows[1], null);
  assert.equal(check(drop).incompleteTail, 0, "a gap in the middle is not a truncation");

  const twice = [...whole.slice(0, 4), whole[3], ...whole.slice(4)]
    .sort((x, y) => x.time - y.time || x.field - y.field);
  assert.equal(check(twice).problems.extra, 1);

  const swapped = whole.map((x, i) => i === 3 ? { ...whole[4], time: x.time }
    : i === 4 ? { ...whole[3], time: x.time } : x);
  assert.equal(check(swapped).problems.outOfOrder, 1);

  const early = [{ time: -5, field: 0, value: 99 }, ...whole];
  assert.equal(check(early).problems.late, 1);

  const carried = whole.map((x) => x.field === 2 && x.time < 200 ? { ...x, time: x.time + 100 } : x)
    .sort((x, y) => x.time - y.time);
  const c = check(carried);
  assert.ok(c.problems.short >= 1 && c.problems.extra >= 1, JSON.stringify(c.problems));

  // ── the TERMINAL rule, one shape at a time (R8 §23.4) ──
  // 0..n-1 fields, in order: the measurement stopped inside the record. Excused,
  // exactly once, and not counted as a fault. Zero fields is the normal shape —
  // a run that stops before the first publication of the last record — and the
  // rule it replaces called that one short, because it asked for a publication
  // AFTER the last read and there was none (the 60 s run, R8 §23.5).
  for (const keep of [0, 1, 2]) {
    const cutRun = whole.slice(0, whole.length - NAMES.length + keep);
    const t = check(cutRun);
    assert.equal(t.incompleteTail, 1, `a ${keep}-field tail is a truncation`);
    assert.deepEqual(t.problems, { late: 0, short: 0, extra: 0, outOfOrder: 0 },
      `a ${keep}-field tail must not be counted as a fault`);
    assert.equal(t.rows.length, READS.length - 1);
    assert.equal(t.broken, 0);
  }
  // A COMPLETE final record is not a truncation and is compared like any other.
  assert.equal(clean.incompleteTail, 0);
  assert.equal(clean.rows.length, READS.length);

  // The same count, in the wrong order, at the end: NOT excused. This is R8's
  // own reproduction, at its size.
  {
    const R2 = [{ time: 0 }, { time: 100 }], N2 = ["a", "b"];
    const recs = [fld(1, 0, 1), fld(2, 1, 2), fld(101, 1, 3), fld(102, 0, 4)];
    const r = recordsBetweenReads(R2, recs, N2);
    assert.deepEqual(r.problems, { late: 0, short: 0, extra: 0, outOfOrder: 1 });
    assert.equal(r.incompleteTail, 0);
    assert.equal(r.broken, 1);
    assert.deepEqual(r.kinds, ["outOfOrder"]);
    assert.ok(Object.values(r.problems).every((v) => v >= 0), "no count may go negative");
  }
  // A field too many at the end: not a prefix, so not excused.
  {
    const over = [...whole, fld(305, 0, 99)];
    const r = check(over);
    assert.equal(r.incompleteTail, 0);
    assert.equal(r.problems.extra, 1);
  }
  // A tail whose fields are the right number but start at the wrong one is not
  // a prefix either — the first field of the record is what a prefix begins at.
  {
    const badPrefix = [...whole.slice(0, whole.length - NAMES.length), fld(301, 1, 7)];
    const r = check(badPrefix);
    assert.equal(r.incompleteTail, 0, "a tail that does not begin at field 0 is not a prefix");
    assert.equal(r.problems.short, 1);
  }
}

// ── one resolved configuration (§12.3) ────────────────────────────────────
// The compensation the CLI asks for has to reach BOTH the generated code and
// the recorded case. A JSON that names a configuration the run did not use is
// worse than no JSON: the rom hash changes and nothing says why.
const base = { name: "regression", cfg: {}, cooperative: { slots: 5, compensation: 65 },
  grab: { hint: true, computed: true, line: 1, bytes: 8, path: 0 } };
const a41 = resolveCase(base, { compensation: 41 }), a65 = resolveCase(base, {});
assert.equal(a41.case.cooperative.compensation, 41);
assert.equal(a65.case.cooperative.compensation, 65);
assert.notEqual(a41.gen.text, a65.gen.text);
assert.equal(a41.gen.cooperative.compensation, 41);
// Both CPUs read the window period from the same place.
assert.equal(a41.grab.windowPeriod, windowPeriodMaster(a41.cfg, 5));
assert.equal(a41.grab.windowPeriod, W);
assert.equal(resolveCase({...base, cooperative:{slots:80,compensation:41}},{}).grab.windowPeriod,
  windowPeriodMaster(cfg, 80));
// A 24-cycle change in the repayment is a 24-cycle change in the pad, and the
// generated text is what proves it rather than a comment.
const padCycles = (text) => {
  const body = text.slice(text.indexOf("coop_slot0:"), text.indexOf("coop_join:"));
  const n = (re, w) => (body.match(re) ?? []).length * w;
  const djnz = [...body.matchAll(/ld b,(\d+)/g)].reduce((t,m)=>t+13*Number(m[1])-5+7, 0);
  return djnz + n(/^\s+nop$/gm,4) + n(/^\s+inc bc$/gm,6) + n(/^\s+ld a,0$/gm,7)
    + n(/^\s+jp \$\+3$/gm,10) + n(/^\s+jr \$\+2$/gm,12);
};
assert.equal(padCycles(a65.gen.text) + 24, padCycles(a41.gen.text));
// Every fault changes the ROM, and a fault the emitted path never reaches is
// refused rather than silently passing.
const loadCaseNoPublish = { name: "obs", cfg: {}, wave: new Uint8Array(256),
  observer: { reads: ["h"], store: true, load: "divu", loadProbe: true } };
const TRANSFER_FAULTS = ["drop-copy", "no-commit", "early-commit", "late-request", "zero-divisor"];
const LOAD_FAULTS = ["short-load", "no-load-marks"];
const RECORD_FAULTS = ["drop-field", "double-field", "carry-publish"];
assert.deepEqual([...TRANSFER_FAULTS, ...LOAD_FAULTS, ...RECORD_FAULTS].sort(),
  Object.keys(FAULTS).sort(), "a new fault needs a home in one of these lists");
// The record faults are the Z80's, so what has to change is the generated
// source — and they are refused on a case that publishes nothing.
{
  const pub = { name: "dec", cfg: {}, wave: new Uint8Array(256),
    observer: { reads: ["h"], decode: true, publish: true, load: "divu" } };
  const texts = new Map();
  for (const fault of [null, ...RECORD_FAULTS]) {
    const t = resolveCase(pub, { fault }).gen.text;
    assert.ok(!texts.has(t), `fault ${fault} did not change the generated source`);
    texts.set(t, fault);
    // …and it must not have leaked into the 68000's side of the rom.
    assert.equal(resolveCase(pub, { fault }).grab.fault, undefined);
  }
  for (const fault of RECORD_FAULTS)
    assert.throws(() => resolveCase(loadCaseNoPublish, { fault }), /only applies/);
}
const roms = new Map();
for (const fault of [null, ...TRANSFER_FAULTS]) {
  const r = resolveCase(base, { fault });
  const rom = buildRom(new Uint8Array(0x100), new Uint8Array(512), r.grab);
  assert.ok(!roms.has(rom.sha), `fault ${fault} did not change the rom`);
  roms.set(rom.sha, fault);
}
// The load faults belong to a case that times its own load, and are refused
// anywhere else rather than quietly doing nothing.
const loadCase = loadCaseNoPublish;
const loadRoms = new Map();
for (const fault of [null, ...LOAD_FAULTS]) {
  const r = resolveCase(loadCase, { fault });
  const rom = buildRom(new Uint8Array(0x100), null, r.grab);
  assert.ok(!loadRoms.has(rom.sha), `fault ${fault} did not change the rom`);
  loadRoms.set(rom.sha, fault);
  assert.throws(() => resolveCase(base, { fault: fault ?? "short-load" }), /only applies/);
}
assert.throws(() => buildRom(new Uint8Array(0x100), new Uint8Array(512),
  resolveCase({ ...base, grab: { every: 100, bytes: 4, optimized: true } }, { fault: "late-request" }).grab),
  /does not apply/);
// A load whose divisor was never set is refused at build time. The observer's
// entry did exactly that and produced a rom that trapped every iteration.
assert.throws(() => buildRom(new Uint8Array(0x100), null,
  { vdp: true, disabled: true, load: "divu", skipInitForTest: true }), /initLoad|divisor/);

// Execute both branch paths, alternating serviced and skipped notifications.
// This tests padding arithmetic only: injected holds are explicitly synthetic,
// not evidence that a physical BUSREQ lasts this long.
const dir=mkdtempSync(join(tmpdir(),"dac-coop-test-"));
try {
  for (const compensation of [32,60]) {
    const path=join(dir,"engine.z80");
    writeFileSync(path,generateCooperative(cfg,{slots:5,compensation}).text);
    const ram=new Uint8Array(0x2000); ram.set(assemble(path).bytes);
    for(let i=0;i<256;i++) ram[0x1c00+i]=expected(i);
    let cycles=0, extra=0, addr=-1, windows=0;
    const dac=[];
    const cpu=new Z80Cpu({read:a=>ram[a]??255,write:(a,v)=>{
      if(a<ram.length) ram[a]=v;
      else if(a===0x4000) addr=v;
      else if(a===0x4001 && addr===0x2a) dac.push({time:cycles,value:v});
      else if(a===0x8000) {
        extra+=3;
        if(v===1 && windows++%2===0) { extra+=compensation; ram[COOP.commit]=1; }
      }
    }});
    while(dac.length<1000 && cycles<500000) { extra=0; cycles+=cpu.step()+extra; }
    assert.equal(dac.length,1000);
    for(let i=0;i<dac.length;i++) {
      assert.equal(dac[i].value,expected(i));
      if(i) assert.equal(dac[i].time-dac[i-1].time,cfg.slotCycles[(i-1)%5]);
    }
    assert.ok(windows>100);
  }
} finally { rmSync(dir,{recursive:true,force:true}); }

// Run against the built core to prove that corrupt output really fails the CLI.
if (process.argv.includes("--machine")) {
  const probe = new URL("./machine-probe.mjs", import.meta.url).pathname;
  const run = (args) => spawnSync(process.execPath, [probe, ...args], { encoding: "utf8" });
  for (const name of ["output only", "two voices"]) {
    const r = run(["--case", name, "--seconds", "0.5", "--inject-value-error"]);
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.match(r.stdout,/value at sample/);
  }
  const r = run(["--case","NO-SUCH-CASE"]);
  assert.equal(r.status,1); assert.match(r.stdout,/no matching cases/);
  // THE FAULT INJECTIONS, on a case that passes without them. A gate proven
  // only against a case that was already failing proves nothing (§12.2 B).
  const clean = run(["--case","cooperative 4B host delay 12000","--seconds","1"]);
  assert.equal(clean.status,0,clean.stdout+clean.stderr);
  for (const [fault, expect] of [
    ["drop-copy", /transferred byte count/],
    ["no-commit", /missing or premature transfer commit/],
    ["early-commit", /missing or premature transfer commit/],
    ["late-request", /commit adopted by a window it was not written in/],
  ]) {
    const f = run(["--case","cooperative 4B host delay 12000","--seconds","1","--fault",fault]);
    assert.equal(f.status,1,`fault ${fault} was not fatal:\n${f.stdout}`);
    assert.match(f.stdout, expect);
  }
  // …and through the HBlank path, which had no transfer checks at all.
  for (const fault of ["drop-copy","no-commit","early-commit","late-request"]) {
    const f = run(["--case","computed timing 8B, unloaded 68k","--seconds","1","--fault",fault]);
    assert.equal(f.status,1,`hblank fault ${fault} was not fatal:\n${f.stdout}`);
  }
  // A 68000 exception is a failed run even when the PCM is perfect. The
  // divisor init is removed on purpose; before the fix this rom passed a
  // 2-second run and died at 10.
  const zero = run(["--case","hv observer, load timed in place","--seconds","2",
    "--fault","zero-divisor"]);
  assert.equal(zero.status, 1, zero.stdout + zero.stderr);
  assert.match(zero.stdout, /took an exception/);
  // …and the same rom without the fault runs the load it was meant to.
  const loaded = run(["--case","hv observer, load timed in place","--seconds","2"]);
  assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
  assert.match(loaded.stdout, /foreground load: \d+ ticks, 5\d\d\.\d 68000 cycles/);
  // The evaluation harness refuses to work from logs it cannot verify.
  const evalTool = new URL("./decoder-eval.mjs", import.meta.url).pathname;
  const emptyDir = mkdtempSync(join(tmpdir(), "dac-eval-empty-"));
  try {
    const r2 = spawnSync(process.execPath, [evalTool, "--reuse", "--out", emptyDir],
      { encoding: "utf8" });
    assert.equal(r2.status, 1, r2.stdout + r2.stderr);
    assert.match(r2.stdout + r2.stderr, /no 2s log/);
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
  // The load's TIME is a criterion. Both ways of breaking the check must fail:
  // shortening the instruction, and switching the stamping off.
  for (const [fault, pattern] of [["short-load", /cycles an iteration, outside/],
    ["no-load-marks", /reported no timing marks/]]) {
    const f2 = run(["--case","hv observer, load timed in place","--seconds","2","--fault",fault]);
    assert.equal(f2.status, 1, `${fault} was not fatal:\n${f2.stdout}`);
    assert.match(f2.stdout, pattern);
  }
  // The load has to be the long path: an overflowing divide is caught by the
  // calibration case itself.
  const cal2 = run(["--case","load calibration","--seconds","1"]);
  assert.equal(cal2.status,0,cal2.stdout);
  assert.match(cal2.stdout,/divu\/7 1[0-9][0-9]\./);
}
console.log("probe selftest: values, interval attribution, transfer protocol, window geometry,"
  + " commit carry-over, host timeline, the phase decoder's detection and its refusals,"
  + " the Z80 decode's initialisation, acquisition contract, arithmetic and single cost,"
  + " the published record's completeness check and what it refuses,"
  + " the stop a window contains and how its boundaries are defined,"
  + " the corrector's arithmetic, its nine-bit debt and \u00b1112 boundary, convergence and five refusals, the corrector in the loop with the correction read back off the DAC, the code ledger and what it does not subtract, the 68k/Z80 protocol's one layout, its two commit orders and every wrap,"
  + " the split decode's agreement with it, the walker's one-observation deadline, and the"
  + " whole 15-level engine running it through real slots, pads and reserves,"
  + " resolved configuration and padding paths pass");
