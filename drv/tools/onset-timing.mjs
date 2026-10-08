// KEY-ON TIMING THROUGH THE LIGHT ENGINE: how late each FM key-on reaches the
// chip, and what the frames ahead of it were made of. The same path as
// engine-score-gate.mjs — the reference driver's frames, the host model
// (pairs-model.mjs, one grab a frame), the score's engine image in the JS
// instruction model — but graded for timing, not values.
//
//   node tools/onset-timing.mjs <score.mmlisp> [--from S] [--to S] [--top N] [--json F]
//
// A key-on's LAG is the time from its frame's start to the chip seeing the
// write. A constant lag is inaudible; what is heard is how much it changes from
// one key-on to the next on the same channel (the interval error), so that is
// what the summary reports, with the worst frames and their pairs by class.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { buildLightImage } from "./build-engine.mjs";
import { FrameRecorder, MMLP_AHEAD_ONE, PairsModel, inTime, pairsCfgForImage, recordPcm, recordWrites } from "./pairs-model.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { headerPcmVoices } from "../../live/src/mmb.js";
import { Machine } from "./machine.mjs";


/** A register write's class, for the burst breakdown. */
export function writeClass(port, reg, val) {
  if (port === 2) return "psg";
  if (reg === 0x28) return val & 0xf0 ? "keyon" : "keyoff";
  if (reg === 0x2b || reg === 0x2a) return "dac";
  if (reg < 0x30) return "global";
  if (reg >= 0x40 && reg <= 0x4e) return "tl";
  if ((reg >= 0xa0 && reg <= 0xa6) || (reg >= 0xa8 && reg <= 0xae)) return "pitch";
  if (reg >= 0xb4 && reg <= 0xb6) return "pan";
  return "patch"; // $30-$9E other than TL, $B0-$B2
}

export function onsetTiming(path, { seconds = 30, voiceHoist } = {}) {
  const { bytes, sampleBank } = buildMmb(path, { voiceHoist });
  const pcmVoices = headerPcmVoices(bytes[6] | (bytes[7] << 8));
  if (bytes[6] & 0x10) throw new Error("multi-bank scores need the banked host (banked-sgdk-gate.mjs)");
  const built = buildLightImage(Math.max(1, pcmVoices));
  const { cfg, descriptor: desc } = built;
  const player = new DrvPlayer();
  player.loadMMB(bytes, sampleBank);
  const maxFrames = Math.ceil(seconds * 60);
  const frames = player.captureSlotLog({ maxFrames, commands: [], builder: new FrameRecorder() }).slots;
  const bank = new Uint8Array(0x8000);
  if (sampleBank) bank.set(sampleBank.subarray(0, 0x8000), 0);
  const model = new PairsModel({ ...pairsCfgForImage(desc), ahead: MMLP_AHEAD_ONE });
  const m = new Machine(cfg, { bytes: built.bytes, symbols: built.symbols }, { rom: bank });
  while (!m.trace.dacCycle.length) m.run(m.cycles + 200);
  const dac0 = m.trace.dacCycle[0];
  const frameCycles = Math.round(cfg.frameCycles);
  let frame = 0, fifoLo = null;
  m.host = { every: frameCycles, fn: (ram) => {
    if (frame < frames.length) model.frame(frames[frame++]);
    const prev = fifoLo;
    const g = model.plan(prev);
    fifoLo = ram[desc.fifoLo];
    if (g.bytes.length && !inTime(prev, g.dst, fifoLo)) { model.abort(); return []; }
    const writes = [];
    if (g.bytes.length) for (let i = 0; i < g.fill.length; i++) writes.push([g.dst + i, g.fill[i]]);
    model.psgTake();
    return writes;
  } };
  m.hostNext = dac0 + frameCycles;
  m.run(dac0 + (frames.length + 30) * cfg.frameCycles);

  // The frames' port-0/1 writes in order, each tagged with its frame. The DAC
  // enable rides the PCM lane, so it is matched apart (as the score gate does).
  const want = [[], [], []];
  const perFrame = frames.map((rec, f) => {
    const d = recordWrites(rec), classes = {};
    const count = (c) => (classes[c] = (classes[c] ?? 0) + 1);
    for (const [r, v] of d.fm0) { want[r === 0x2b ? 2 : 0].push({ f, r, v }); count(writeClass(0, r, v)); }
    for (const [r, v] of d.fm1) { want[1].push({ f, r, v }); count(writeClass(1, r, v)); }
    const pcm = recordPcm(rec).length;
    if (pcm) classes.pcm = pcm;
    return { frame: f, sec: f / 60, writes: d.fm0.length + d.fm1.length, classes };
  });
  const seenAt = [0, 0, 0], keyOns = [];
  for (const [cycle, port, reg, val] of m.trace.ym) {
    if (cycle < dac0) continue;
    const lane = port === 0 && reg === 0x2b ? 2 : port;
    // The first write not yet seen, or — when the converter reorders within a
    // frame — the next one with this register and value in that frame.
    while (want[lane][seenAt[lane]]?.seen) seenAt[lane]++;
    let j = seenAt[lane];
    const f0 = want[lane][j]?.f;
    while (want[lane][j] && want[lane][j].f === f0 && (want[lane][j].seen || want[lane][j].r !== reg || want[lane][j].v !== val)) j++;
    const w = want[lane][j];
    if (!w || w.f !== f0) throw new Error(`port ${port}: the chip's write stream left the score's at write ${seenAt[lane]}`);
    w.seen = true;
    if (port === 0 && reg === 0x28 && (val & 0xf0)) {
      const ch = (val & 3) + (val & 4 ? 3 : 0) + 1;
      // The video frame is the machine's (59.92 Hz on NTSC), not 1/60 s.
      keyOns.push({ frame: w.f, ch, lagMs: ((cycle - dac0) - w.f * cfg.frameCycles) / cfg.z80Hz * 1000 });
    }
  }
  const last = new Map();
  for (const k of keyOns) {
    const prev = last.get(k.ch);
    k.errMs = prev && k.frame - prev.frame < 60 ? k.lagMs - prev.lagMs : null;
    last.set(k.ch, k);
  }
  return { file: path, frames: frames.length, perFrame, keyOns };
}

/** Lateness over the score's usual lag, in ms: what a listener hears. */
export function summarize(r, from = 0, to = Infinity) {
  const span = r.keyOns.filter((k) => k.frame >= from * 60 && k.frame < to * 60);
  const lags = span.map((k) => k.lagMs).sort((a, b) => a - b);
  const base = lags[lags.length >> 1] ?? 0;
  for (const k of span) k.lateMs = k.lagMs - base;
  const late = span.map((k) => k.lateMs).sort((a, b) => a - b);
  const q = (p) => late[Math.floor((late.length - 1) * p)] ?? 0;
  return { count: span.length, baseMs: base, p95Ms: q(0.95), maxMs: q(1), span };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const file = argv.find((a) => a.endsWith(".mmlisp"));
  if (!file) throw new Error("usage: node tools/onset-timing.mjs <score.mmlisp> [--from S] [--to S] [--top N] [--no-hoist] [--json F]");
  const from = Number(opt("--from", 2)), to = Number(opt("--to", 30)), top = Number(opt("--top", 8));
  const r = onsetTiming(file, { seconds: to + 1, voiceHoist: argv.includes("--no-hoist") ? false : undefined });
  const s = summarize(r, from, to);
  console.log(`${file}: ${s.count} key-ons ${from}–${to} s, usual lag ${s.baseMs.toFixed(1)} ms`);
  console.log(`  late over usual  p95 ${s.p95Ms.toFixed(1)}  max ${s.maxMs.toFixed(1)} ms`);
  console.log("  latest key-ons (and the 3 frames up to them):");
  for (const k of [...s.span].sort((a, b) => b.lateMs - a.lateMs).slice(0, top)) {
    console.log(`    ${(k.frame / 60).toFixed(2)} s f${k.frame} fm${k.ch}: ${k.lateMs.toFixed(1)} ms late`);
    for (const p of r.perFrame.slice(Math.max(0, k.frame - 2), k.frame + 1))
      console.log(`        f${p.frame} ${String(p.writes).padStart(3)} writes ${JSON.stringify(p.classes)}`);
  }
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(r, null, 1));
}
