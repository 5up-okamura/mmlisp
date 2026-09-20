#!/usr/bin/env node
// Offline single-channel YM2612 render + ideal waveform references, not an NES emulator.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import makeCore from '../../player/wasm/dist/nuked-opn2.js';
import {compileMMLisp} from '../../live/src/mmlisp2ir.js';
import {planVoices} from '../../live/src/mmb-voices.js';
import {encodeMmb} from '../../live/src/export-mmb.js';
import {midiToFnumBlock,OP_ADDR_OFFSET} from '../../live/src/ir-utils.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=fs.readFileSync(root+'presets/waveforms/waveforms.mmlisp','utf8');
const core=await makeCore();const rate=core._nopn_get_native_sample_rate();
const frames=Math.round(rate*.65),rest=Math.round(rate*.2);
const out=root+'presets/_renders/nes-vrc6/';fs.mkdirSync(out,{recursive:true});
const kinds=[['wave-square',.5],['wave-pulse-25',.25],['wave-pulse-12-approx',.125],['wave-triangle','triangle'],['wave-saw','saw']];
function render(n){const result=new Float64Array(n);for(let i=0;i<n;i+=4096){const k=Math.min(n-i,4096);core._nopn_render(k);const p=core._nopn_get_buffer_ptr()>>1;for(let j=0;j<k;j++)result[i+j]=(core.HEAP16[p+j*2]+core.HEAP16[p+j*2+1])/2;}return result;}
function wav(name,x){
 const mean=x.reduce((a,b)=>a+b,0)/x.length;const centered=x.map(v=>v-mean);
 const rms=Math.sqrt(centered.reduce((a,b)=>a+b*b,0)/x.length);assert(rms>0);
 const peak=centered.reduce((a,b)=>Math.max(a,Math.abs(b)),0);const gain=Math.min(.15/rms,.95/peak);
 const b=Buffer.alloc(44+x.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(Math.round(rate),24);b.writeUInt32LE(Math.round(rate)*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(x.length*2,40);
 for(let i=0;i<x.length;i++)b.writeInt16LE(Math.round(centered[i]*gain*32767),44+i*2);
 fs.writeFileSync(out+name+'.wav',b);
 return {rawRms:rms,previewGain:gain};
}
const report=[];
for(const [name,kind] of kinds){
 const {ir,diagnostics}=compileMMLisp(source+`\n(fm1 ${name} c)`);assert.deepEqual(diagnostics,[]);assert.deepEqual(encodeMmb(ir).diagnostics,[]);
 const entries=planVoices(ir).table;assert.equal(entries.length,1);const patch=entries[0];
 const fm=[],ref=[];
 for(const note of [48,60,72]){
  core._nopn_reset();const wr=(a,d)=>core._nopn_write_reg(0,a,d);
  wr(0x22,0);wr(0x27,0);wr(0x2b,0);wr(0xb0,patch[28]);wr(0xb4,0xc0);
  for(let field=0;field<7;field++)for(let op=0;op<4;op++)wr(0x30+field*16+OP_ADDR_OFFSET[op],patch[field*4+op]);
  const {fnum,block}=midiToFnumBlock(note);wr(0xa4,(block<<3)|(fnum>>8));wr(0xa0,fnum&255);wr(0x28,0xf0);
  fm.push(...render(frames));wr(0x28,0);fm.push(...render(rest));
  const freq=fnum*rate/2**(21-block);
  for(let i=0;i<frames;i++){
   const phase=(i*freq/rate)%1;
   // NES triangle has 32 sequencer steps, VRC6 saw reference has 7 levels.
   let value=typeof kind==='number'?(phase<kind?1:-1):kind==='triangle'?(phase<.5?15-Math.floor(phase*32):Math.floor(phase*32)-16)/7.5-1:Math.floor(phase*7)/3-1;
   // 2ms edge fade only for reference playback clicks.
   const edge=Math.min(1,i/(rate*.002),(frames-1-i)/(rate*.002));ref.push(value*edge);
  }
  ref.push(...new Float64Array(rest));
 }
 report.push({name,reference:kind,fm:wav(name+'-fm',Float64Array.from(fm)),ideal:wav(name+'-reference',Float64Array.from(ref))});
}
const audition=fs.readFileSync(root+'examples/source/nes-vrc6-audition.mmlisp','utf8');
const compiled=compileMMLisp(audition,'nes-vrc6-audition.mmlisp',{imports:new Map([['../../presets/waveforms/waveforms.mmlisp',source]])});
assert.deepEqual(compiled.diagnostics,[]);assert.deepEqual(encodeMmb(compiled.ir).diagnostics,[]);
fs.writeFileSync(root+'presets/waveforms/nes-vrc6-render.json',JSON.stringify({nativeRate:rate,wavRate:Math.round(rate),notes:[48,60,72],noteSeconds:.65,restSeconds:.2,preview:'DC removed and RMS matched to 0.15; peak capped at 0.95. Direct register render at base TL, equivalent to full velocity/volume; no runtime macros.',voices:report},null,2)+'\n');
console.log('PASS: 5 FM voices compile/export; rendered 10 FM/reference WAVs at C3/C4/C5 using Nuked-OPN2.');
