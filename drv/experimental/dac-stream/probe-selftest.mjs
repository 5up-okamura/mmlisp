import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assemble } from "../../tools/z80asm.mjs";
import { Z80Cpu } from "../../tools/z80cpu.mjs";
import { buildConfig } from "./config.mjs";
import { generateCooperative, COOP } from "./cooperative.mjs";
import { analyzeProbe, analyzeTransfers, readProbe, summarizeResults } from "./probe-analysis.mjs";

const cfg = buildConfig();
const expected = (i) => (i*73+19)&255;
const fixture = () => {
  const dac = Array.from({length:5000}, (_,i)=>({time:i*5376,value:expected(i)}));
  return { dac, ym: structuredClone(dac), grabs: [], stops: [], copies: [], notifications: [], commits: [], polls: [] };
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
  l=>l.stops[0][1]=2100,
]) {
  const l=structuredClone(transfer); mutate(l);
  assert.ok(analyzeTransfers(l,[[300,900]],{bytes:2,cooperative:true},[19,92]).errors.length);
}

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
  for (const name of ["output only", "two voices"]) {
    const r=spawnSync(process.execPath,[new URL("./machine-probe.mjs",import.meta.url).pathname,
      "--case",name,"--seconds","0.5","--inject-value-error"],{encoding:"utf8"});
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.match(r.stdout,/value at sample/);
  }
  const r=spawnSync(process.execPath,[new URL("./machine-probe.mjs",import.meta.url).pathname,
    "--case","NO-SUCH-CASE"],{encoding:"utf8"});
  assert.equal(r.status,1); assert.match(r.stdout,/no matching cases/);
}
console.log("probe selftest: values, interval attribution, transfer protocol, alternating padding paths and requested CLI negatives pass");
