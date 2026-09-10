// WHAT A REAL SCORE ACTUALLY WRITES TO THE CHIPS (R25 §57.3 step 4, §57.4).
//
//   node drv/experimental/dac-stream/corpus.mjs [--frames N] [score …]
//
// Everything about who writes the YM and who writes the PSG turns on how much
// traffic there is, and until R25 that number came from nowhere. This reads it
// off the reference driver itself — the same `DrvPlayer` and `SlotBuilder` the
// c-gate compares the C port against — so the figures are the port's own
// behaviour and not an estimate.
//
// It also dumps the PSG stream in frame/sub-tick order, which is what the PSG
// P1 image replays.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "../../tools/mmb-build.mjs";
import { DrvPlayer } from "../../../live/src/drv-player.js";
// The recorder lives with the semantic corpus (R27 §61.5): one subclass, read
// by both tools, so "what the reference driver wrote" is one definition.
import { Recording } from "./semantic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const FRAMES = Number(arg("frames", 400));
const scores = argv.filter((a) => !a.startsWith("--") && a.endsWith(".mmlisp"));
const list = scores.length ? scores : [join(drv, "tests", "m3-macro-multi.mmlisp")];

import { buildMmb } from "../../tools/mmb-build.mjs";
import { DrvPlayer } from "../../../live/src/drv-player.js";
// The recorder lives with the semantic corpus (R27 §61.5): one subclass, read
// by both tools, so "what the reference driver wrote" is one definition.
import { Recording } from "./semantic.mjs";const rows = [];
for (const score of list) {
  const { bytes, sampleBank } = buildMmb(score);
  const player = new DrvPlayer();
  player.loadMMB(bytes, sampleBank);
  const builder = new Recording();
  const ref = player.captureSlotLog({ maxFrames: FRAMES, commands: [], builder });
  const frames = ref.slots.length;
  const w = builder.log.filter((x) => x.frame < frames);
  const fm = w.filter((x) => x.port === 0 || x.port === 1);
  const psg = w.filter((x) => x.port === 2);
  // Per frame, so a median and a p95 mean something: an average over a song
  // hides the voice change that decides the transport.
  const per = (xs) => {
    const c = new Array(frames).fill(0);
    for (const x of xs) c[x.frame]++;
    const s = [...c].sort((a, b) => a - b);
    return { total: xs.length, max: s.at(-1) ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0,
      med: s[Math.floor(s.length / 2)] ?? 0, perSec: xs.length / (frames / 60), c };
  };
  // The deepest burst inside ONE sub-tick, which is what a transport has to
  // carry in one go rather than spread over a frame.
  const burst = (xs) => {
    const k = new Map();
    for (const x of xs) { const key = `${x.frame}/${x.sub}`; k.set(key, (k.get(key) ?? 0) + 1); }
    return Math.max(0, ...k.values());
  };
  const F = per(fm), P = per(psg);
  rows.push({ name: basename(score, ".mmlisp"), frames, F, P,
    fmBurst: burst(fm), psgBurst: burst(psg), log: builder.log, fm, psg });
}

console.log(`── what the reference driver writes, ${FRAMES} frames asked for ──`);
console.log(`  ${"score".padEnd(22)}${"frames".padStart(7)}${"FM".padStart(7)}${"FM/s".padStart(8)}`
  + `${"med".padStart(5)}${"p95".padStart(5)}${"max".padStart(5)}${"burst".padStart(7)}`
  + `${"PSG".padStart(7)}${"PSG/s".padStart(8)}${"med".padStart(5)}${"p95".padStart(5)}`
  + `${"max".padStart(5)}${"burst".padStart(7)}`);
for (const r of rows)
  console.log(`  ${r.name.padEnd(22)}${String(r.frames).padStart(7)}`
    + `${String(r.F.total).padStart(7)}${r.F.perSec.toFixed(1).padStart(8)}`
    + `${String(r.F.med).padStart(5)}${String(r.F.p95).padStart(5)}${String(r.F.max).padStart(5)}`
    + `${String(r.fmBurst).padStart(7)}`
    + `${String(r.P.total).padStart(7)}${r.P.perSec.toFixed(1).padStart(8)}`
    + `${String(r.P.med).padStart(5)}${String(r.P.p95).padStart(5)}${String(r.P.max).padStart(5)}`
    + `${String(r.psgBurst).padStart(7)}`);

// ── the FM breakdown R25 §57.4 asks for ──────────────────────────────────
// A voice setting is 29 writes and everything else is a handful, so the two
// have to be told apart before any transport is chosen: one is a burst the
// transport must survive, the other is the traffic it must sustain.
// $30..$9F is the operator block — DT/MUL, TL, RS/AR, AM/D1R, D2R, D1L/RR,
// SSG-EG, four operators each — and $B0/$B4 are the algorithm, feedback and
// pan. Together they are the patch: 28 + 2 writes, which is the "29 write voice
// setting" R25 §57.2 prices, give or take whether SSG-EG is sent.
const OPBLOCK = (r) => r >= 0x30 && r < 0xa0;
const ALGPAN = (r) => (r >= 0xb0 && r < 0xb8);
const KEY = (r) => r === 0x28;
const TL = (r) => r >= 0x40 && r < 0x50;
// $A0..$A3 is the frequency's low byte and $A4..$A7 its block and high bits;
// $A8..$AE are channel 3's per-operator pair. The high byte latches the low
// one, so the two are a pair and the order inside it carries meaning.
const PITCHLO = (r) => (r >= 0xa0 && r < 0xa4) || (r >= 0xa8 && r < 0xac);
const PITCHHI = (r) => (r >= 0xa4 && r < 0xa8) || (r >= 0xac && r < 0xb0);
const PITCH = (r) => PITCHLO(r) || PITCHHI(r);
const VOICE = (r) => (OPBLOCK(r) && !TL(r)) || ALGPAN(r);
console.log(`\n── the FM traffic, by what it is ──`);
console.log(`  ${"score".padEnd(22)}${"port0".padStart(7)}${"port1".padStart(7)}`
  + `${"key".padStart(6)}${"pitchLo".padStart(9)}${"pitchHi".padStart(9)}${"TL".padStart(6)}`
  + `${"voice".padStart(7)}${"other".padStart(7)}`);
const tot = { p0: 0, p1: 0, key: 0, plo: 0, phi: 0, tl: 0, voice: 0, other: 0 };
for (const r of rows) {
  const n = (f) => r.fm.filter((x) => f(x.addr)).length;
  const voice = n(VOICE), other = r.fm.length - n(KEY) - n(PITCH) - n(TL) - voice;
  tot.p0 += r.fm.filter((x) => x.port === 0).length;
  tot.p1 += r.fm.filter((x) => x.port === 1).length;
  tot.key += n(KEY); tot.plo += n(PITCHLO); tot.phi += n(PITCHHI);
  tot.tl += n(TL); tot.voice += voice; tot.other += other;
  console.log(`  ${r.name.padEnd(22)}${String(r.fm.filter((x) => x.port === 0).length).padStart(7)}`
    + `${String(r.fm.filter((x) => x.port === 1).length).padStart(7)}`
    + `${String(n(KEY)).padStart(6)}${String(n(PITCHLO)).padStart(9)}`
    + `${String(n(PITCHHI)).padStart(9)}${String(n(TL)).padStart(6)}`
    + `${String(voice).padStart(7)}${String(other).padStart(7)}`);
}
if (rows.length > 1)
  console.log(`  ${"ALL".padEnd(22)}${String(tot.p0).padStart(7)}${String(tot.p1).padStart(7)}`
    + `${String(tot.key).padStart(6)}${String(tot.plo).padStart(9)}${String(tot.phi).padStart(9)}`
    + `${String(tot.tl).padStart(6)}${String(tot.voice).padStart(7)}${String(tot.other).padStart(7)}`);
// STEADY AND BURST, apart. A frame that carries a patch is not the frame a
// transport is sized for, and a transport sized for the median cannot carry one.
console.log(`\n── steady traffic and the frames that carry a patch ──`);
console.log(`  ${"score".padEnd(22)}${"patch frames".padStart(14)}${"steady FM/s".padStart(13)}`
  + `${"with patches".padStart(14)}`);
for (const r of rows) {
  const heavy = new Set();
  const c = new Array(r.frames).fill(0);
  for (const x of r.fm) if (VOICE(x.addr)) c[x.frame]++;
  c.forEach((n, i) => { if (n >= 16) heavy.add(i); });
  const steady = r.fm.filter((x) => !heavy.has(x.frame)).length;
  console.log(`  ${r.name.padEnd(22)}${String(heavy.size).padStart(14)}`
    + `${(steady / ((r.frames - heavy.size) / 60)).toFixed(1).padStart(13)}`
    + `${r.F.perSec.toFixed(1).padStart(14)}`);
}

// …and the PSG stream itself, for the P1 image to replay. It is written NEXT TO
// THE SOURCE, not into out/, because the P1 rom is built from it: a build input
// that lives in a gitignored directory is a rom nobody else can reproduce.
// Only when asked for by name, so a corpus-wide run cannot silently replace it.
const want = arg("psg-from", null);
if (want) {
  const r = rows.find((x) => x.name === want);
  if (!r) throw new Error(`--psg-from ${want}: not among the scores measured`);
  const out = join(here, "psg-corpus.json");
  writeFileSync(out, JSON.stringify({ score: r.name, frames: r.frames,
    generated: "node drv/experimental/dac-stream/corpus.mjs --frames "
      + `${FRAMES} --psg-from ${want} <score>`,
    writes: r.psg.map((x) => ({ f: x.frame, s: x.sub, b: x.data })) }, null, 1));
  console.log(`\n  ${r.psg.length} PSG bytes from "${r.name}" written to ${out}`);
}
