import assert from "node:assert/strict";
import { buildMultibankImage } from "./build-multibank.mjs";
import { MultibankPairs } from "./multibank-model.mjs";
import { runMultibank } from "./multibank-run.mjs";
import { pcmLoopPoints, pcmShotPoints } from "../../live/src/pcm-model.js";
import { buildMultibankScore, packMultibank, fenceMultibankItems, prioritizeFmNotes } from "./multibank-score.mjs";
import { buildMmb } from "./mmb-build.mjs";
import { fileURLToPath } from "node:url";
import { analyzeMultibankTiming } from "./multibank-timing.mjs";

const word = (n) => [n & 255, n >> 8];
const built = buildMultibankImage();
// The two-voice layout must actually expose the denser pair schedule while
// retaining one FIFO read per DAC interval (publication cannot hide a wrap).
assert.equal(built.cfg.xpSteps, 15);
assert.equal(built.gen.sites.length, 15);
assert.equal(new Set(built.gen.sites.map((site) => site.a)).size, 15);
// Repeating a note still publishes a new generation; redundant staged data
// may be omitted without turning a retrigger into a sustained note.
const repeat = new MultibankPairs(built.gen.idleAfterGen);
const repeatedNote = [1, 0, 0, ...word(0x8100), ...word(0x8110), ...word(0xff00), ...word(1)];
const first = repeat.pcm(repeatedNote), second = repeat.pcm(repeatedNote);
assert.equal(first.find(([op]) => op === 8)[1], 1);
assert.equal(second.find(([op]) => op === 8)[1], 2);
assert.equal(second.filter(([op]) => op !== 0).length, 1);
const guarded = fenceMultibankItems([{ pairs: [[8,1],[0,0],[0,0],[0x40,1],[2,1],[8,2]] }], 2)[0].pairs;
assert.deepEqual(guarded, [[8,1],[0x40,1],[0,0],[2,1],[8,2]]);
const generationGuard = fenceMultibankItems([{ pairs: [[8,1],[8,2]] }], 2)[0].pairs;
assert.deepEqual(generationGuard, [[8,1],[0,0],[0,0],[8,2]]);
const patch = Array.from({length:12}, (_,i) => [1,0x30,i]);
const bass = [[0,0xa5,0x22],[0,0xa1,0x70],[0,0x28,0xf1]];
const original = [...patch,[0,0x22,12],...bass];
assert.deepEqual(prioritizeFmNotes(original,[0,0,0,3,3,0]), [...bass,...patch,[0,0x22,12]]);
assert.deepEqual(prioritizeFmNotes(original,[0,3,0,3,3,0]), original);
assert.deepEqual(prioritizeFmNotes([[0,0x21,1],...original],[0,0,0,3,3,0]), [[0,0x21,1],...original]);
const splitPitch = [...patch,...bass.slice(1)];
assert.deepEqual(prioritizeFmNotes(splitPitch,[0,0,0,3,3,0]), splitPitch);
// Equal PSG bytes are insufficient: postponing a frame and then catching up
// must be visible in the timing grade even though no byte was lost.
const timedItems = [61, 62, 63].map((frame) => ({ frame, pairs: [], psg: [0x90] }));
const psgTrace = { ymZ80: [], psg68k: timedItems.map((it) => ({ value: 0x90,
  time: (it.frame + 2) * built.cfg.machine.frameMaster })) };
const steady = analyzeMultibankTiming({ items: timedItems }, psgTrace, 0, [], [], built);
assert.ok(steady.psg.intervalError.maxMs < 1e-9);
psgTrace.psg68k[1].time += built.cfg.machine.frameMaster;
const delayed = analyzeMultibankTiming({ items: timedItems }, psgTrace, 0, [], [], built);
assert.ok(delayed.psg.intervalError.maxMs > delayed.frameMs / 4);
// More than 32 KiB of distinct PCM, at identical window offsets in different
// banks. Bank $101 exercises the ninth latch bit, not just the low byte.
const rom = new Uint8Array(0x102 * 0x8000);
const samples = [
  { bank: 1, src: 0x8100, len: 20000, wave: (i) => Math.round(100 * Math.sin(i * .047)) },
  { bank: 0x101, src: 0x8100, len: 24000, wave: (i) => ((i * 7) & 255) - 128 },
  { bank: 2, src: 0xfef0, len: 16, wave: (i) => 127 - i * 13 },
];
for (const s of samples) for (let i = 0; i < s.len; i++) rom[s.bank * 0x8000 + s.src - 0x8000 + i] = s.wave(i) & 255;

function script(kind, idle = built.gen.idleAfterGen, voices = 2) {
  const pairs = new MultibankPairs(idle), out = [];
  const add = (frame, c, intent) => out.push({ frame, pairs: pairs.pcm(c), intent });
  const points = (s, loop) => loop ? pcmLoopPoints(s.src, s.len, ...loop) : pcmShotPoints(s.src, s.len);
  const start = (frame, v, si, loop = null, shift = 0) => {
    const s = samples[si], p = points(s, loop);
    add(frame, [1, v, shift, ...word(s.src), ...word(p.end), ...word(p.wrap), ...word(s.bank)],
      { kind: "start", v, src: s.src, bank: s.bank, end: p.end, wrap: p.wrap });
  };
  const retarget = (frame, v, si, loop) => {
    const p = points(samples[si], loop);
    add(frame, [4, v, ...word(p.end), ...word(p.wrap)], { kind: "retarget", v, end: p.end, wrap: p.wrap });
  };
  if (kind !== "idle") {
    start(1, 0, 0, kind === "shots" ? null : [32, 1600]);
    start(1, 1, 1, kind === "shots" ? null : [64, 2048]);
    if(voices===3) start(1,2,0,kind === "shots" ? null : [0,16]);
  }
  if (["loops", "adjacent"].includes(kind)) {
    retarget(10, 0, 0, [160, 176]); retarget(10, 1, 1, [32, 48]);
    if(voices===3) retarget(10,2,0,[32,64]);
    retarget(20, 0, 0, [0, 512]); retarget(20, 1, 1, [0, 1024]);
    // Release to the tail; a new source/bank then steals voice zero.
    retarget(30, 0, 0, null); start(35, 0, 2, null);
    retarget(35, 1, 1, null);
  }
  if (kind === "levels") for (let f = 5; f < 50; f += 5) {
    if(voices===3) add(f,[3,2,(f+3)%7]);
    add(f, [3, 0, f % 7]); add(f, [3, 1, (f + 2) % 7]); add(f, [5, f % 4]);
  }
  if (kind === "adjacent") for (let f = 40; f < 60; f += 2) {
    start(f, 0, 2, [0, 16]);
    start(f, 0, 0, [0, 16]);
    retarget(f, 0, 0, [16, 32]);
    start(f, 1, 1, [48, 64]);
  }
  if (kind === "wire") {
    for (let f = 1; f <= 120; f++) out.push({ frame: f,
      pairs: Array.from({ length: 14 }, (_, i) => [0x40, (f + i) & 127]) });
    for (let f = 5; f < 60; f += 4) start(f, 0, f % 3 ? 0 : 2, [0, 16]);
  }
  // Port switches, pitch latch pairs, key-on and timer/CSM writes alongside PCM.
  for (let f = 3; f < 60; f += 3) out.push({ frame: f, pairs:
    [[0x20, 1], [0xa4, 0x22], [0xa0, f], [0x20, 0], [0x28, 0xf4], [0x27, f & 1 ? 0x80 : 0]] });
  return out.sort((a, b) => a.frame - b.frame);
}

let failed = 0;
console.log(`multibank pcm2: ${built.cfg.rateHz.toFixed(3)} Hz, ${built.symbols.get("code_end")}/4352 code bytes, `
  + `${built.gen.placement.meanWorkPct}% mean work, ${built.gen.idleAfterGen} IDLE fence, 44016 B PCM`);
for (const kind of ["idle", "shots", "loops", "levels", "adjacent", "wire"]) {
  const r = runMultibank(built, rom, script(kind), { seconds: 4 });
  if (kind !== "idle" && !r.machine.trace.dacValue.some((x) => x !== 128)) r.fail.push("no sounding samples");
  if (r.fail.length) failed++;
  console.log(`${r.fail.length ? "FAIL" : "ok"} ${kind}: ${r.reference.length} samples, gap ${r.time.gapMin}..${r.time.gapMax}, ${r.bankWrites} bank writes, ${r.pairs} pairs`);
  for (const f of r.fail.slice(0, 5)) console.log(`  ${f}`);
}
const mono = buildMultibankImage({ voices: 1, xpSteps: 55 });
for (const kind of ["shots", "loops", "adjacent", "wire"]) {
  const items = script(kind, mono.gen.idleAfterGen).filter((it) => it.intent?.v !== 1);
  const run = runMultibank(mono, rom, items, { seconds: 4 });
  assert.equal(run.fail.length, 0, `pcm1 ${kind}: ${run.fail.join("; ")}`);
  console.log(`ok pcm1 ${kind}: 55 pairs / 80 samples, gap ${run.time.gapMin}..${run.time.gapMax}`);
}
// Three voices use a shorter lap and an independent single-byte bank store.
const trio = buildMultibankImage({voices:3});
for (const kind of ["shots", "loops", "levels", "adjacent", "wire"]) {
  const items = script(kind,trio.gen.idleAfterGen,3);
  const run=runMultibank(trio,rom,items,{seconds:6});
  assert.equal(run.fail.length,0,`pcm3 ${kind}: ${run.fail.join("; ")}`);
  console.log(`ok pcm3 ${kind}: ${trio.cfg.xpSteps} pairs / ${trio.cfg.cycleSlots} samples`);
}

const scorePath = fileURLToPath(new URL("../tests/multibank.mmlisp", import.meta.url));
assert.throws(() => buildMmb(scorePath, { multibank: false }), /exceeds.*32512/);
const score = buildMultibankScore(scorePath, { frames: 360, idleAfterGen: built.gen.idleAfterGen });
assert.ok(score.usedBytes > 32768);
assert.equal(score.banks, 2);
for (let bank = 0; bank < score.banks; bank++)
  assert.ok(score.rom.subarray(bank * 0x8000 + 0x7f00, (bank + 1) * 0x8000).every((b) => b === 0));
const scoreRun = runMultibank(built, score.rom, score.items, { seconds: 7 });
assert.deepEqual(scoreRun.fail, []);
assert.ok(new Set(scoreRun.log.filter((e) => e.kind === "start").map((e) => e.bank)).size > 1);
console.log(`ok real score: legacy rejects it, ${score.usedBytes} B / ${score.banks} banks, every DAC byte matches`);
const separated = buildMultibankScore(scorePath, { frames: 360, idleAfterGen: built.gen.idleAfterGen, separateBanks: true });
assert.ok(separated.banks > score.banks);
const separatedRun = runMultibank(built, separated.rom, separated.items, { seconds: 7 });
assert.deepEqual(separatedRun.fail, []);
assert.equal(separated.usedBytes, score.usedBytes);
for (let i = 0; i < score.entries.length; i++) {
  const a = score.entries[i], b = separated.entries[i];
  assert.deepEqual(separated.rom.subarray(b.base, b.base+b.len), score.rom.subarray(a.base, a.base+a.len));
}
console.log("ok separated banks: source bytes preserved; optimized commands match each engine model");
// An oversized individual blob must be rejected rather than crossing into a
// different voice's bank. Packing aliases the baked builder's shared blobs.
const raw = new Uint8Array(4 + 48 + 32), view = new DataView(raw.buffer);
view.setUint16(0, 2, true);
for (let i = 0; i < 2; i++) {
  const at = 4 + i * 24; raw[at] = i;
  view.setUint32(at + 8, 32, true);
}
raw.fill(0x55, 52);
const shared = packMultibank(raw);
assert.equal(shared.usedBytes, 32);
assert.equal(shared.entries[0].base, shared.entries[1].base);
view.setUint32(12, 0x8000, true);
assert.throws(() => packMultibank(raw), /one baked sample/);
for (const [fault, expected] of [["bank", "VALUE"], ["high-bank", "VALUE"], ["timing", "TIME"], ["fence", "INTENT"]]) {
  const image = fault === "timing" ? buildMultibankImage({ fault }) : built;
  const r = runMultibank(image, rom, script("adjacent", fault === "fence" ? 0 : built.gen.idleAfterGen), { seconds: 4, fault });
  const caught = r.fail.some((f) => f.startsWith(expected));
  if (!caught) failed++;
  console.log(`${caught ? "ok" : "FAIL"} negative ${fault}: ${expected} ${caught ? "caught it" : "missed"}`);
}
assert.equal(failed, 0, `${failed} multibank gate failures`);
