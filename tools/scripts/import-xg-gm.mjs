#!/usr/bin/env node
// Extract only melodic MSB=0 / LSB=0 from libOPNMIDI WOPN v2.
// Usage: node tools/scripts/import-xg-gm.mjs /path/to/xg.wopn COMMIT
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const bankPath=path.join(root,'presets/gm/gm.mmlisp');
const [input,commit]=process.argv.slice(2);
if (!input || !/^[0-9a-f]{40}$/.test(commit??'')) throw Error('Usage: import-xg-gm.mjs xg.wopn COMMIT');
const b=fs.readFileSync(input);
if(b.subarray(0,11).toString()!=='WOPN2-B2NK\0'||b.readUInt16LE(11)!==2)throw Error('Expected WOPN v2');
const melodic=b.readUInt16BE(13),percussion=b.readUInt16BE(15),flags=b[17];
if(flags&16)throw Error('Expected OPN2 bank');
const start=18+(melodic+percussion)*34;
if(b.length!==start+(melodic+percussion)*128*69)throw Error('Invalid bank length');
const matches=[];
for(let i=0;i<melodic;i++)if(b[18+i*34+32]===0&&b[18+i*34+33]===0)matches.push(i);
if(matches.length!==1)throw Error('Expected one melodic 0:0 bank');
const names=[...fs.readFileSync(bankPath,'utf8').matchAll(/\(def (gm-\d{3}-\S+)/g)].map(m=>m[1]);
if(names.length!==128||new Set(names).size!==128)throw Error('Expected 128 existing public names');
const lfoRate=(flags&8)?(flags&7)+1:0;
const result=['; libOPNMIDI XG: melodic MSB 0 / LSB 0 only (128 GM programs).',
'; MIT: Copyright (c) 2018-2026 Vitaliy Novichkov.',
'; See licenses/libopnmidi-xg.txt and source.json.',
'; Voice registers only; pitch and shared LFO settings belong to the score.', ''];
const instruments=[];
for(let i=0;i<128;i++){
 const r=b.subarray(start+(matches[0]*128+i)*69,start+(matches[0]*128+i+1)*69);
 if(r.readUInt16BE(65)===0&&r.readUInt16BE(67)===0)throw Error(`Blank program ${i}`);
 const offset=r.readInt16BE(32);
 const sourceName=r.subarray(0,32).toString('utf8').split('\0')[0];
 const patch=names[i];
 result.push(`; GM ${i+1} / MIDI ${i}: ${sourceName}`,`(def ${patch} :alg ${r[35]&7} :fb ${(r[35]>>3)&7} :ams ${(r[36]>>4)&3} :fms ${r[36]&7}`);
 // WOPN is register slot order 1,3,2,4; MMLisp is algorithm order 1,2,3,4.
 for(const [op,slot] of [0,2,1,3].entries()){
  const [dt,tl,ar,dr,sr,rr,ssg]=r.subarray(37+slot*7,44+slot*7);
  // WOPN keeps DT as the 3-bit sign-magnitude register field; :dt is signed.
  const dtReg=(dt>>4)&7;
  const vals={ar:ar&31,dr:dr&31,sr:sr&31,rr:rr&15,sl:rr>>4,tl:tl&127,ks:ar>>6,ml:dt&15,dt:dtReg&4?-(dtReg&3):dtReg,ssg:ssg&15,am:dr>>7};
  result.push('  '+Object.entries(vals).map(([k,v])=>`:${k}${op+1} ${v}`).join(' '));
 }
 result.push(')','');
 instruments.push({program:i,gm:i+1,name:names[i],sourceName,noteOffset:offset,recordHex:r.toString('hex')});
}
fs.writeFileSync(bankPath,result.join('\n'));
fs.writeFileSync(path.join(root,'presets/gm/source.json'),JSON.stringify({repository:'https://github.com/Wohlstand/libOPNMIDI',commit,path:'fm_banks/xg.wopn',sha256:createHash('sha256').update(b).digest('hex'),license:'MIT',bankMSB:0,bankLSB:0,lfoRate,instruments},null,2)+'\n');
console.log(`Imported ${instruments.length} GM voice definitions; source LFO rate ${lfoRate} retained as metadata only.`);
