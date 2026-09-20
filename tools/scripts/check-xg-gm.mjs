#!/usr/bin/env node
// Verify all GM patches against the original WOPN register records.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {compileMMLisp} from '../../live/src/mmlisp2ir.js';
import {planVoices} from '../../live/src/mmb-voices.js';
import {encodeMmb} from '../../live/src/export-mmb.js';
const read=p=>fs.readFileSync(fileURLToPath(new URL('../../'+p,import.meta.url)),'utf8');
const bank=read('presets/gm/gm.mmlisp');
const source=JSON.parse(read('presets/gm/source.json'));
assert.equal(source.instruments.length,128);
assert.equal([...bank.matchAll(/\(def gm-\S+ :alg /g)].length,128);
assert(!bank.includes('xg-patch-'));
assert.equal(new Set(source.instruments.map(i=>i.name)).size,128);
for(const [program,ins] of source.instruments.entries()){
 assert.equal(ins.program,program);
 const {ir,diagnostics}=compileMMLisp(bank+`\n(fm1 ${ins.name} c)`);
 assert.deepEqual(diagnostics,[],ins.name);
 const r=Buffer.from(ins.recordHex,'hex');assert.equal(r.length,69);
 const table=planVoices(ir).table;assert.equal(table.length,1);
 // WOPN register slots -> MMLisp algorithm order, field-major MMB entry.
 const expected=[];
 for(let field=0;field<7;field++)for(const slot of [0,2,1,3])expected.push(r[37+slot*7+field]);
 expected.push(r[35]);
 // $30 (the first four field-major bytes) holds DT/MUL. DT is sign-magnitude,
 // so register 4 is "-0": the sign bit is set but the magnitude is 0, and
 // ym3438.c adds/subtracts a detune of 0 either way (pg_detune path, dt_l==0).
 // `:dt` is signed and has no -0, so 4 imports as 0. Compare them as equal.
 const dtNorm=(b,i)=>i<4&&((b>>4)&7)===4?b&0x0f:b;
 assert.deepEqual(table[0].map(dtNorm),expected.map(dtNorm),`Register roundtrip: ${ins.name}`);
 const params=new Map(ir.tracks[0].events.filter(e=>e.cmd==='PARAM_SET').map(e=>[e.args.target,e.args.value]));
 assert(!params.has('NOTE_PITCH')); 
 assert.equal(params.get('FM_AMS'),(r[36]>>4)&3);
 assert.equal(params.get('FM_FMS'),r[36]&7);
 assert(!params.has('LFO_RATE'));
 assert.deepEqual(encodeMmb(ir).diagnostics,[]);
}
const {ir,diagnostics}=compileMMLisp(read('examples/source/gm-audition.mmlisp'),'gm-audition.mmlisp',{imports:new Map([['../../presets/gm/gm.mmlisp',bank]])});
assert.deepEqual(diagnostics,[]);
assert.equal(ir.tracks[0].events.filter(e=>e.cmd==='NOTE_ON').length,512);
const pitches=ir.tracks[0].events.filter(e=>e.args?.target==='NOTE_PITCH');
assert.equal(pitches.length,0);
assert(!ir.tracks[0].events.some(e=>e.args?.target==='LFO_RATE'));
const encoded=encodeMmb(ir);assert.deepEqual(encoded.diagnostics,[]);
console.log(`PASS: 128 GM programs, all 29 patch bytes + AMS/FMS; no pitch/LFO writes; 512-note audition; MMB ${encoded.bytes.length} bytes.`);
