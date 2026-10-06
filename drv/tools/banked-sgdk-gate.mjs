// Integrated SGDK sequencer, planner and banked engine gate.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {makeProject,sgdkEnv,runRom} from './sgdk-project.mjs';
import {buildMmb} from './mmb-build.mjs';
import {prioritizeFmNotes} from './multibank-score.mjs';
import {buildMultibankImage} from './build-multibank.mjs';
import {MultibankModel} from './multibank-model.mjs';
import {readProbe} from './probe-analysis.mjs';
import {DrvPlayer} from '../../live/src/drv-player.js';
import {FrameRecorder,recordWrites,recordPcm} from './pairs-model.mjs';
const args=process.argv.slice(2),opt=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const file=resolve(args.find(s=>s.endsWith('.mmlisp'))??'tests/multibank.mmlisp');
const seconds=Number(opt('--seconds',8)),out=resolve(opt('--out','out/banked-sgdk'));
if(!Number.isFinite(seconds)||seconds<3||seconds>60)throw new RangeError('seconds must be 3..60');
mkdirSync(out,{recursive:true});
const E=sgdkEnv('banked-sgdk'),b=buildMmb(file,{multibank:true});
const voices=(b.bytes[6]>>2)&3,image=buildMultibankImage({voices,xpSteps:voices===1?55:15});
const p=makeProject(E,file,{multibank:true,patch:args.includes('--minimal') ? proj => {
 writeFileSync(join(proj,'src/main.c'), `#include <genesis.h>
#include "mmlispdrv.h"
#include "song.h"
int main(bool hard) {
 (void)hard;
 JOY_setSupport(PORT_1, JOY_SUPPORT_OFF); JOY_setSupport(PORT_2, JOY_SUPPORT_OFF);
 MMLisp_init(); MMLisp_setSampleBank(song_smp);
 if (!MMLisp_loadScore(song_mmb)) return 1;
 MMLisp_attachInterrupts();
 for(u16 n=0;n<120 && !MMLisp_isSettled();n++) { MMLisp_frame(); SYS_doVBlankProcess(); }
 MMLisp_startSong();
 while(TRUE) { MMLisp_frame(); SYS_doVBlankProcess(); }
 return 0;
}
`);
} : undefined});copyFileSync(p.rom,join(out,'rom.bin'));
if(!runRom(E,p.rom,{seconds,log:join(out,'probe.bin'),wav:join(out,'audio.wav')}))throw new Error('BlastEm failed');
const L=readProbe(readFileSync(join(out,'probe.bin'))),rom=readFileSync(p.rom),fail=[];
const ready=L.ramWrites.filter(w=>w.region==='glob'&&w.addr===0x6e&&w.value===0xd2).at(-1);
if(!ready)throw new Error('banked engine did not boot');
const dac=L.dac.filter(d=>d.time>ready.time),stores=new Map();let si=0;
for(const w of L.ramWrites){if(w.region!=='glob'||w.addr<0x30||w.addr>=0x50||w.time<dac[0].time)continue;while(si+1<dac.length&&dac[si+1].time<=w.time)si++;if(stores.has(si))fail.push('multiple stores in a DAC slot');stores.set(si,[w.addr-0x30,w.value]);}
const model=new MultibankModel(image.gen,rom);let mismatch=0;
for(let i=0;i<dac.length;i++)if(model.slot(stores.get(i))!==dac[i].value)mismatch++;
if(mismatch)fail.push(`${mismatch} DAC mismatches`);if(!dac.some(d=>d.value!==128))fail.push('silent PCM');
const player=new DrvPlayer();player.loadMMB(b.bytes,b.sampleBank);
const frames=player.captureSlotLog({maxFrames:Math.ceil(seconds*60)+60,prime:0,builder:new FrameRecorder()}).slots;
const sampleAt=rom.indexOf(Buffer.from(b.sampleBank));
if(sampleAt < 0 || (sampleAt & 0x7fff)) fail.push('sample resource missing or unaligned');
const wantedStarts = frames.flatMap(recordPcm).filter(c => c[0] === 6);
for(let v=0;v<voices;v++) {
 const expected=wantedStarts.filter(c=>c[1]===v), actual=model.log.filter(e=>e.kind==='start'&&e.v===v);
 if(!actual.length) fail.push(`voice ${v} never started`);
 for(let i=0;i<actual.length;i++) {
  const c=expected[i], a=actual[i];
  if(!c || a.src !== (c[3]|c[4]<<8) || a.bank !== (c[9]|c[10]<<8) + (sampleAt>>15)
    || a.end !== (c[5]|c[6]<<8) || a.wrap !== (c[7]|c[8]<<8)) {fail.push(`voice ${v} start ${i} intent mismatch`);break;}
 }
}
const want=[[],[]],psg=[];
const modulation=new Array(6).fill(null);
for(let frame=0;frame<frames.length;frame++) {
 const rec=frames[frame], pcm=recordPcm(rec), writes=[];
 for(let at=1+pcm.reduce((n,c)=>n+c.length,0);at+3<=rec.length;at+=3) writes.push([...rec.slice(at,at+3)]);
 for(const [port,reg,value] of prioritizeFmNotes(writes,modulation)) {
  if(port===2) psg.push(value);else want[port].push([reg,value,frame]);
 }
}
const latch=[0,0],seen=[[],[]];
for(const e of L.ymZ80){if(e.read)continue;if(e.kind==='addr')latch[e.part]=e.byte;else if(e.time>ready.time&&!(e.part===0&&latch[0]===0x2a))seen[e.part].push([latch[e.part],e.byte,e.time]);}
for(let port=0;port<2;port++)for(let i=0;i<seen[port].length;i++){let w=want[port][i],g=seen[port][i];if(!w||g[0]!==w[0]||g[1]!==w[1]){fail.push(`FM port ${port} write ${i}: ${JSON.stringify(g)} vs ${JSON.stringify(w)}`);break;}}
const gotPsg=L.psg68k.filter(e=>e.time>ready.time);for(let i=0;i<gotPsg.length;i++)if(gotPsg[i].value!==psg[i]){fail.push(`PSG write ${i}`);break;}
const span=dac.at(-1).time-dac[0].time,held=L.stops.filter(([a])=>a>=dac[0].time&&a<=dac.at(-1).time).reduce((sum,[a,z])=>sum+z-a,0);
const rate=(dac.length-1)*image.cfg.machine.masterHz/(span-held),loss=100*held/span;
if(Math.abs(rate/image.cfg.rateHz-1)>.002)fail.push('DAC running rate drift');if(loss>1.5)fail.push('excessive bus loss');
const previousKeys=new Map(),intervals=[];
for(let i=0;i<seen[0].length;i++) {
 const [reg,value,time]=seen[0][i],frame=want[0][i]?.[2];
 if(reg!==0x28 || !(value&0xf0) || frame===undefined) continue;
 const channel=(value&3)+((value&4)?3:0),old=previousKeys.get(channel);
 if(old && old.frame>60 && frame>old.frame) intervals.push({channel:channel+1,frame,
  errorMs:(time-old.time-(frame-old.frame)*image.cfg.machine.frameMaster)*1000/image.cfg.machine.masterHz});
 previousKeys.set(channel,{frame,time});
}
const sorted=intervals.map(r=>Math.abs(r.errorMs)).sort((a,b)=>a-b);
const fmTiming={count:sorted.length,p95Ms:sorted[Math.floor((sorted.length-1)*.95)]??null,maxMs:sorted.at(-1)??null,
 worstIntervals:intervals.sort((a,b)=>Math.abs(b.errorMs)-Math.abs(a.errorMs)).slice(0,10)};
const report={file,seconds,integrated:true,testApp:args.includes('--minimal')?'minimal':'sgdk-example',project:p.proj,voices,sampleBankBytes:b.sampleBank.length,samples:dac.length,mismatch,starts:model.log.filter(e=>e.kind==='start').length,fmWrites:seen.map(x=>x.length),psgWrites:gotPsg.length,rate,busLossPct:loss,fmTiming,fail};
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(fail.length)process.exitCode=1;
