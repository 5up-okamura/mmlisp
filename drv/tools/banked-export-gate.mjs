// Format, compiler, JS/C sequencer and shared-bank compatibility regression.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {buildMmb} from './mmb-build.mjs';
import {buildBundle} from './bundle.mjs';
import {parsePcmBank,PcmLiveEngine} from '../../live/src/pcm-model.js';
import {bankedEngineImage} from '../../live/src/engine-banked-images.js';
import {DrvPlayer} from '../../live/src/drv-player.js';
import {SlotBuilder} from '../../live/src/slot-builder.js';
import {packBankedSamples} from '../../live/src/export-mmb.js';
const out=resolve('out/banked-export-gate');mkdirSync(out,{recursive:true});
const pairsExe=join(out,'pairs');
execFileSync('cc',['-std=c99','-O2','-I68k','tests/banked-pairs.c','68k/mmlpairs.c','68k/mmlispseq.c','68k/tables.c','-o',pairsExe]);
execFileSync(pairsExe);
console.log('ok full physical grab reservation, consumer advance, generation fences');
const exe=join(out,'seq');execFileSync('cc',['-std=c99','-O2','-I68k','68k/gate_main.c','68k/mmlispseq.c','68k/tables.c','-o',exe]);
function gate(file,voices,{commands=[],autoStart=true,frameHz=60}={}){
 const b=buildMmb(file,{multibank:true,frameHz}),bank=parsePcmBank(b.sampleBank);
 assert.equal(bank.multibank,true);assert.equal(bank.stamp,Math.round(bankedEngineImage(voices,frameHz).rateHz));
 const cmdPath=join(out,'commands.txt');
 writeFileSync(cmdPath,commands.map(c=>`${c.frame} ${c.cmd} ${c.a0??0} ${c.a1??0} ${c.a2??0}`).join('\n')+'\n');
 const mmb=join(out,'song.mmb'),smp=join(out,'song.smp');writeFileSync(mmb,b.bytes);writeFileSync(smp,b.sampleBank);
 for(const prime of [undefined,0]){
  const p=new DrvPlayer();p.loadMMB(b.bytes,b.sampleBank);
  const ref=p.captureSlotLog({maxFrames:400,builder:new SlotBuilder(),commands,autoStart,...(prime===undefined?{}:{prime})}).slots;
  const raw=execFileSync(exe,[mmb,'400','--samples',smp,...(commands.length?['--cmds',cmdPath]:[]),...(autoStart?[]:['--idle']),...(prime===undefined?[]:['--prime','0'])]);
  let at=0,index=0;while(at<raw.length&&index<ref.length){const n=raw[at]|raw[at+1]<<8;at+=2;assert.deepEqual([...raw.subarray(at,at+n)],[...ref[index]],`${file} prime=${prime} frame=${index}`);at+=n;index++;}assert.equal(index,ref.length);
 }
 const e=new PcmLiveEngine(bankedEngineImage(voices,frameHz),b.sampleBank),s=bank.entries[0];
 e.apply([6,0,0,(0x8000+(s.base&0x7fff))&255,(0x8000+(s.base&0x7fff))>>8,...[(0x8000+(s.base&0x7fff)+s.len-16)&255,(0x8000+(s.base&0x7fff)+s.len-16)>>8],0,255,s.base>>15,0]);
 assert.ok(Array.from({length:4096},()=>e.next()).some(x=>x!==128));
 console.log('ok banked C/JS, priming, live PCM:',file,frameHz);
 return b;
}
const big=gate('tests/multibank.mmlisp',2);gate('tests/m3-pcm-baked.mmlisp',1);gate('tests/m4-pcm-2v-master.mmlisp',2);gate('tests/p3-se-pcm-macro.mmlisp',2,JSON.parse(readFileSync('tests/p3-se-pcm-macro.cmds.json')));
const packed=gate('tests/multibank-packed.mmlisp',2);
assert.equal(packed.sampleBank.length,3*32768);
// Independent payloads and an alias retain their IDs and point metadata after relocation.
const lengths=[20000,20000,12000,12000],tableEnd=4+5*24;
const flat=new Uint8Array(tableEnd+64000),view=new DataView(flat.buffer);
view.setUint16(0,5,true);view.setUint16(2,10112,true);
let offset=0;
for(let i=0;i<5;i++) {
 const at=4+i*24,len=i===4?lengths[0]:lengths[i],off=i===4?0:offset;
 flat[at]=i;flat[at+1]=7;
 view.setUint32(at+4,off,true);view.setUint32(at+8,len,true);
 view.setUint32(at+12,1234+i,true);
 for(let j=16;j<24;j+=2)view.setUint16(at+j,16*(j+i),true);
 if(i<4){for(let j=0;j<len;j++)flat[tableEnd+offset+j]=(i*41+j*13)&255;offset+=len;}
}
const relocated=packBankedSamples(flat),rv=new DataView(relocated.buffer);
assert.equal(relocated.length,3*32768);
for(let i=0;i<5;i++) {
 const at=4+i*24,off=rv.getUint32(at+4,true),len=view.getUint32(at+8,true);
 assert.deepEqual(relocated.subarray(at,at+4),flat.subarray(at,at+4));
 assert.deepEqual(relocated.subarray(at+8,at+24),flat.subarray(at+8,at+24));
 assert.deepEqual(relocated.subarray(32768+off,32768+off+len),
   flat.subarray(tableEnd+view.getUint32(at+4,true),tableEnd+view.getUint32(at+4,true)+len));
 assert.ok((off&32767)+len<=32512);
}
assert.equal(rv.getUint32(8,true),rv.getUint32(4+4*24+4,true));
for(let bank=0;bank<3;bank++)assert.ok(relocated.subarray((bank+1)*32768-256,(bank+1)*32768).every(b=>b===0));
const tied=flat.slice();
[2,0,1,3,4].forEach((row,i)=>{tied.set(flat.subarray(4+row*24,4+(row+1)*24),4+i*24);tied[4+i*24]=i;});
const tiedBank=packBankedSamples(tied),tv=new DataView(tiedBank.buffer);
assert.equal(tiedBank.length,3*32768);
assert.deepEqual(Array.from({length:5},(_,i)=>tv.getUint32(8+i*24,true)),[0,12000,32768,52768,12000]);
const monoPath=join(out,'large-one.mmlisp');
writeFileSync(monoPath,readFileSync('tests/multibank.mmlisp','utf8')
 .replace('(def-score :pcm-voices 2)','(def-score :pcm-voices 1)')
 .replace('"pcmbank.wav"',JSON.stringify(resolve('tests/pcmbank.wav'))).replace(/\(pcm2[\s\S]*$/,''));
const mono=buildMmb(monoPath);assert.equal((mono.bytes[6]>>2)&3,1);assert.ok(mono.bytes[6]&0x10);assert.equal(parsePcmBank(mono.sampleBank).stamp,10112);
assert.equal(buildMmb('tests/multibank.mmlisp').bytes[6]&0x10,0x10);
assert.throws(()=>buildMmb('tests/multibank.mmlisp',{multibank:false}),/exceeds/);
assert.equal(buildMmb('tests/m3-pcm-baked.mmlisp').bytes[6]&0x10,0);
gate('tests/multibank.mmlisp',2,{frameHz:50});gate('tests/m3-pcm-baked.mmlisp',1,{frameHz:50});gate('tests/p3-se-pcm-macro.mmlisp',2,{...JSON.parse(readFileSync('tests/p3-se-pcm-macro.cmds.json')),frameHz:50});
assert.ok(buildMmb('tests/multibank.mmlisp',{frameHz:50}).bytes[6]&0x10);
gate('tests/m4-pcm-3v.mmlisp',3);gate('tests/multibank-3v.mmlisp',3);
gate('tests/multibank-3v.mmlisp',3,{frameHz:50});gate('tests/m4-pcm-3v.mmlisp',3,{frameHz:50});
assert.ok(buildMmb('tests/multibank-3v.mmlisp',{frameHz:50}).bytes[6]&0x10);
const wrongRate=big.sampleBank.slice();new DataView(wrongRate.buffer).setUint16(2,0x8000|14376,true);
assert.throws(()=>new DrvPlayer().loadMMB(big.bytes,wrongRate),/stamp/);
const bad=big.sampleBank.slice();new DataView(bad.buffer).setUint32(8,0x7ef0,true);assert.throws(()=>parsePcmBank(bad),/crosses/);
writeFileSync(join(out,'bad.smp'),bad);writeFileSync(join(out,'song.mmb'),big.bytes);
assert.throws(()=>execFileSync(exe,[join(out,'song.mmb'),'1','--samples',join(out,'bad.smp')],{stdio:'pipe'}));
const bundle=buildBundle({multibank:true,pcmVoices:2,songs:[{name:'a',src:'tests/multibank.mmlisp'},{name:'b',src:'tests/multibank.mmlisp'}]},{baseDir:resolve('.')});
assert.ok(bundle.bank.length>32768);assert.ok(!bundle.diagnostics.some(d=>d.severity==='error'));
assert.ok(buildBundle({pcmVoices:2,songs:[{name:'auto',src:'tests/multibank.mmlisp'}]},{baseDir:resolve('.')}).bank.length>32768);
for(const hz of [60,50]) for(const voices of [1,2,3]) {
 const {buildMultibankImage}=await import('./build-multibank.mjs');
 const image=buildMultibankImage({voices,frameHz:hz}),sites=new Set(image.gen.sites.map(x=>x.a));
 const window=Math.ceil(image.cfg.machine.frameMaster/(15*image.cfg.periodCycles))+1;
 const peak=Math.max(...Array.from({length:image.cfg.cycleSlots},(_,start)=>Array.from({length:window},(_,i)=>sites.has((start+i)%image.cfg.cycleSlots)?1:0).reduce((a,b)=>a+b,0)));
 assert.ok(peak<128,`FIFO publication can hide a wrap at ${hz} Hz / ${voices} voices: ${peak}`);
}
console.log('ok auto extension, legacy output, unsupported profiles, corrupt banks, bundle');
