#!/usr/bin/env node
// Render and verify the actual score pipeline, including legato and slides.
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import makeCore from '../../live/nuked-opn2.js';
import {compileMMLisp} from '../../live/src/mmlisp2ir.js';
import {encodeMmb} from '../../live/src/export-mmb.js';
import {IRPlayer} from '../../live/src/ir-player.js';
import {DrvPlayer} from '../../live/src/drv-player.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const bank=fs.readFileSync(root+'presets/waveforms/set.mmlisp','utf8');
const core=await makeCore();const rate=core._nopn_get_native_sample_rate();
const output=nodePath.join(os.tmpdir(),'mmlisp-renders','acid')+nodePath.sep;fs.mkdirSync(output,{recursive:true});
{
 const name='acid';
 const source=fs.readFileSync(root+'presets/waveforms/demo-acid.mmlisp','utf8');
 const {ir,diagnostics}=compileMMLisp(source,'presets/waveforms/demo-acid.mmlisp',{imports:new Map([['presets/waveforms/set.mmlisp',bank]])});
 assert.deepEqual(diagnostics,[]);
 const events=ir.tracks[0].events;
 const notes=events.filter(e=>e.cmd==='NOTE_ON');
 // `(x 4 …)` is a counted loop, so the IR holds one pass per voice.
 assert.equal(notes.length,26);assert.equal(notes.filter(e=>e.args.legato).length,6);
 assert.equal(events.filter(e=>e.cmd==='LOOP_BEGIN').length,2);
 const sweeps=events.filter(e=>e.cmd==='PARAM_SWEEP'&&e.args.target==='NOTE_PITCH');
 assert.equal(sweeps.length,6);assert(sweeps.every(e=>e.args.bounded&&e.args.frames===12));
 const encoded=encodeMmb(ir);assert.deepEqual(encoded.diagnostics,[]);
 const drv=new DrvPlayer();drv.loadMMB(encoded.bytes);
 const driver=drv.captureRegisterLog({maxFrames:1200});assert(driver.ended);assert.deepEqual(driver.diagnostics,[]);
 assert.deepEqual(driver.skippedOpcodes,{});
 const log=new IRPlayer(()=>{}).loadJSON(ir).captureRegisterLog({maxSec:20});
 const keyons=writes=>writes.filter(w=>w.port===0&&w.addr===0x28&&w.data===0xf0);
 assert.equal(keyons(log.writes).length,80);assert.equal(keyons(driver.writes).length,80);
 // Each slide pair is one held attack. Compare the key state through the
 // destination note in the IR log, allowing its initial scheduler preroll.
 const ons=keyons(log.writes);const origin=ons[0].sec;const secondsPerTick=60/130/ir.ppqn;
 for(const ev of notes.filter(e=>e.args.legato)){
  const start=origin+(ev.tick-24)*secondsPerTick+.001;
  const end=origin+(ev.tick+12)*secondsPerTick-.001;
  const keys=log.writes.filter(w=>w.port===0&&w.addr===0x28&&(w.data&7)===0&&w.sec>start&&w.sec<end);
  assert.equal(keys.length,0,`No re-key or key-off inside slide at tick ${ev.tick}`);
 }
 // Every attack after the first is preceded by a key-off: on FM the key
 // transition IS the attack, so the note before it keys off however full its
 // gate was. The separation the chip needs to re-attack (one 18.77 us slot
 // round) comes from the write path, not from the score — in the driver both
 // writes sit in one frame, spaced by the pair transport.
 for(const [label,writes] of [["ir",log.writes],["driver",driver.writes]]){
  let previousOff=null,attacked=false;
  for(const w of writes.filter(w=>w.port===0&&w.addr===0x28&&(w.data&7)===0)){
   const at=w.sec ?? w.frame/60;
   if(w.data===0){previousOff=at;continue;}
   if(w.data===0xf0){
    if(attacked)assert(previousOff!==null&&at>=previousOff,`${label}: no key-off before the attack at ${at}`);
    attacked=true;previousOff=null;
   }
  }
 }
 core._nopn_reset();
 const duration=log.endSec+.3,total=Math.ceil(duration*rate),audio=new Float64Array(total);let pos=0;
 const renderTo=end=>{end=Math.min(total,Math.max(pos,end));while(pos<end){const n=Math.min(4096,end-pos);core._nopn_render(n);const p=core._nopn_get_buffer_ptr()>>1;for(let j=0;j<n;j++)audio[pos+j]=(core.HEAP16[p+j*2]+core.HEAP16[p+j*2+1])/2;pos+=n;}};
 for(const w of log.writes.filter(w=>w.port===0||w.port===1).sort((a,b)=>a.sec-b.sec)){
  renderTo(Math.round(Math.max(0,w.sec)*rate));core._nopn_write_reg(w.port,w.addr,w.data);
 }
 renderTo(total);
 const mean=audio.reduce((a,b)=>a+b,0)/total;const centered=audio.map(x=>x-mean);
 const peak=centered.reduce((a,b)=>Math.max(a,Math.abs(b)),0);assert(peak>5);
 const gain=.85/peak;const b=Buffer.alloc(44+total*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(Math.round(rate),24);b.writeUInt32LE(Math.round(rate)*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(total*2,40);
 for(let i=0;i<total;i++)b.writeInt16LE(Math.round(centered[i]*gain*32767),44+i*2);
 fs.writeFileSync(output+`acid-${name}.wav`,b);
}
console.log('PASS: the demo compiles/exports; two counted loops with 6 legato slides each; IR/driver key-on counts match; WAV rendered.'+` Output: ${output}`);
