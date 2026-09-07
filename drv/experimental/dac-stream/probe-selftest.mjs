import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assemble } from "../../tools/z80asm.mjs";
import { Z80Cpu } from "../../tools/z80cpu.mjs";
import { buildConfig } from "./config.mjs";
import { generateCooperative, COOP, windowBand, windowPeriodMaster } from "./cooperative.mjs";
import { resolveCase, FAULTS } from "./case-config.mjs";
import { buildRom } from "./rom.mjs";
import { analyzeProbe, analyzeTransfers, analyzeHost, windowGenerations, commitReaders,
  analyzeAdoption, analyzeZ80Hv, readProbe, summarizeResults, KIND } from "./probe-analysis.mjs";
import { generateObserver, VDP } from "./observer.mjs";
import { buildPhaseTable, buildLineTable, findLineOrigin, decode, decodeVH,
  learnSpacing } from "./decoder.mjs";

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
assert.equal(rowsClean.filter((r) => r.state === "moved").length, 0);   // no false alarm
assert.equal(rowsClean.filter((r) => r.state === "unknown").length, 0);
// A shift the schedule did not plan is seen, and measured.
const shifted = clean.map((r, n) => ({ time: r.time + (n >= 300 ? 900 : 0) }));
for (const r of shifted) r.h = hOf(r.time);
const rowsShift = decode(shifted.map((r) => r.h), { table, steps: stepsH });
assert.equal(rowsShift[300].state, "moved");
assert.ok(Math.abs(rowsShift[300].residual - 900) <= UNIT);
assert.equal(rowsShift[301].state, "locked");                          // one event, not a run
// A reading the table has never seen is refused, not interpolated.
const unseen = table.findIndex((v, i) => v < 0 && i < 256);
if (unseen >= 0) {
  const hs2 = clean.map((r) => r.h); hs2[10] = unseen;
  assert.equal(decode(hs2, { table, steps: stepsH })[10].state, "unknown");
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
const roms = new Map();
for (const fault of [null, ...Object.keys(FAULTS)]) {
  const r = resolveCase(base, { fault });
  const rom = buildRom(new Uint8Array(0x100), new Uint8Array(512), r.grab);
  assert.ok(!roms.has(rom.sha), `fault ${fault} did not change the rom`);
  roms.set(rom.sha, fault);
}
assert.throws(() => buildRom(new Uint8Array(0x100), new Uint8Array(512),
  resolveCase({ ...base, grab: { every: 100, bytes: 4, optimized: true } }, { fault: "late-request" }).grab),
  /does not apply/);

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
  // The load has to be the long path: an overflowing divide is caught by the
  // calibration case itself.
  const cal2 = run(["--case","load calibration","--seconds","1"]);
  assert.equal(cal2.status,0,cal2.stdout);
  assert.match(cal2.stdout,/divu\/7 1[0-9][0-9]\./);
}
console.log("probe selftest: values, interval attribution, transfer protocol, window geometry,"
  + " commit carry-over, host timeline, the phase decoder's detection and its refusals,"
  + " resolved configuration and padding paths pass");
