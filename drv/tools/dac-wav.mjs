// LISTEN to the DAC's clock (driver.md §5.1.2).
//
//   node tools/dac-wav.mjs [tone | score.mmlisp | song.mmb …] [--frames N]
//                          [--out DIR] [--baseline REF|none]
//
// `dac-clock` proves the clock is wrong with numbers; this renders the same
// thing as sound, because a sideband above the carrier is easier to believe
// through headphones. Every file it writes is a ZERO-ORDER HOLD reconstruction
// — the DAC holds the last byte written until the next one, so the output is
// fully determined by (value, instant) pairs and nothing models it better.
//
// Four renders of the same music:
//
//   a-today    the CURRENT engine, measured: the real $2A stream out of the Z80
//              emulator with its real cycle stamps, built from a git worktree of
//              --baseline (default HEAD) so a half-converted working tree cannot
//              contaminate the comparison.
//   a2-flat    THE SAME BYTES, uniformly clocked. a vs a2 is the decisive A/B in
//              this whole line of work: identical values, and the only
//              difference between the two files is WHEN each one was written. If
//              those two sound the same, the clock is not what is wrong and none
//              of the rest of this is worth building.
//   b-stage1   Timer B + the sample ring. Values from drv-player (the port
//              spec); instants from the pacing model below — gate-locked, with
//              the frame's chip-write burst and the three voice-pass
//              transitions still emitting nothing.
//   c-stage3   the same, with emit points sprinkled through those stretches so
//              no run of work between two samples exceeds one sample period.
//   d-flat     the same values on a perfect clock. The ceiling: anything b or c
//              does that this does not is the clock, not the mixer.
//
// b/c/d are a MODEL — the engine is not on the timer yet. Its costs are all
// measured in this repo (see the constants) and it does not flatter: the mix
// work is priced from gen-mixer's own instruction-level model, so a frame that
// cannot keep up starves here too.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";
import { PCM_RING_TARGET, pcmSampleIndex } from "../../live/src/mmb.js";
import { buildMmb } from "./mmb-build.mjs";
import { tickCost, PACE_WINDOW, PCM_GROUP, GATE_CY } from "./gen-mixer.mjs";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const repo = join(drv, "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const FRAMES = Number(opt("frames", 300));
const OUT = opt("out", join(drv, "out", "dac"));
const BASELINE = opt("baseline", "HEAD");
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const Z80HZ = 3579545, SR = 44100;
const FRAME_CYCLES = 59736;            // one 59.92 Hz frame of Z80 (gen-mixer)
// The sample clock (driver.md §5.1.2), from the generator that also writes the
// engine's own $26 byte — so this harness cannot model a timer the engine does
// not run. That drift is exactly how an unenabled Timer B once shipped.
const GROUP = PCM_GROUP;
const SAMPLE_CY = GATE_CY / GROUP;      // 358.4

// ── What a frame spends, in Z80 cycles ─────────────────────────────────────
// Measured in this repo, or derived from something measured. Nothing here is
// fitted to make the output sound better.
const YM_WRITE = 113;    // one latched YM write, BUSY polls inlined (drv/README)
const HEAD_FIXED = 1500; // slot claim + PCM commands + the first pass's set-up
const TRANS = 2500;      // one voice-pass transition — measured ~3.2k with the
                         // pcm_debt call the timer removes (plan-68k-split)
const SEG = 1000;        // a segment's boundary math (seg-bench's marginal cost)
const EMIT = 88;         // $2A write (49) + the 3-phase counter and gate poll (39)
// Per mix tick, from the generator's own instruction-level cost model.
const TICK_SOUND = tickCost("i8sat", "add", 0);
const TICK_IDLE = tickCost("i8sat", "add", 9);

// ── WAV ────────────────────────────────────────────────────────────────────
// Zero-order hold: each byte is held until the next event's instant. `events`
// is [cycle, value|null]; null means the DAC was released (fm6 is FM again,
// which with no FM playing is silence).
function renderWav(events, path) {
  if (events.length < 2) return { secs: 0, pcm: new Float64Array(0) };
  const t0 = events[0][0], span = events[events.length - 1][0] - t0;
  const n = Math.max(1, Math.floor((span / Z80HZ) * SR));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i / SR) * Z80HZ;
    while (k + 1 < events.length && events[k + 1][0] <= t) k++;
    const v = events[k][1];
    // 8-bit unsigned DAC → signed 16, at half scale so the four files A/B at
    // one volume setting and a hard-clipped mix has somewhere to go.
    buf.writeInt16LE(v === null ? 0 : Math.max(-32768, Math.min(32767, (v - 128) * 128)), 44 + i * 2);
  }
  writeFileSync(path, buf);
  const pcm = new Float64Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return { secs: n / SR, pcm };
}

// ── What the clock does to a steady tone ───────────────────────────────────
// The same measurement dac-clock makes, run on the rendered audio so the number
// and the file describe the same thing. A clock that wanders puts sidebands at
// multiples of the frame rate on every partial; a flat one does not.
const goertzel = (buf, f) => {
  const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) { const s = buf[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (buf.length / 2);
};
const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
function sidebands(pcm, f0) {
  if (pcm.length < SR / 4) return null;
  const ref = dB(goertzel(pcm, f0));
  return [1, 2, 3].map((k) => {
    const up = dB(goertzel(pcm, f0 + k * 59.92)) - ref;
    const dn = dB(goertzel(pcm, Math.max(20, f0 - k * 59.92))) - ref;
    return Math.max(up, dn);
  });
}
function findTone(pcm) {
  let best = 0, f0 = 0;
  for (let f = 200; f < 4000; f += 1) { const m = goertzel(pcm, f); if (m > best) { best = m; f0 = f; } }
  return f0;
}

// The interval summary, so the file and its number ship together.
function summary(events) {
  const g = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i][1] === null || events[i - 1][1] === null) continue;
    g.push(events[i][0] - events[i - 1][0]);
  }
  if (!g.length) return "no samples";
  const s = [...g].sort((a, b) => a - b);
  const q = (x) => Math.round(s[Math.floor((s.length - 1) * x)]);
  const held = g.filter((x) => x > SAMPLE_CY * 1.5).length;
  return `p10/p50/p90 ${q(0.1)}/${q(0.5)}/${q(0.9)} cyc (nominal ${Math.round(SAMPLE_CY)}), ` +
    `worst hold ${(q(1) / SAMPLE_CY).toFixed(1)} periods, ` +
    `${((100 * held) / g.length).toFixed(1)}% held past 150%`;
}

// ── The synthesised tone (same one dac-clock.mjs uses, same reasoning) ─────
// 16 whole cycles in 256 samples, so the loop is seamless and any sideband in
// the output came from the driver and not from the material.
function toneScore(dir) {
  const N = 256, RATE = 16000, b = Buffer.alloc(44 + N * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + N * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 16 * i) / N) * 30000), 44 + i * 2);
  writeFileSync(join(dir, "sine.wav"), b);
  const src = join(dir, "tone.mmlisp");
  writeFileSync(src,
    `(def tone :sample :file "sine.wav" :loop-start 0 :loop-end ${N})\n`
    + `(pcm1 tone :tempo 120 :mode loop :oct 4 :len 1 :vel 15 c ~ ~ ~ ~ ~ ~ ~)\n`);
  return src;
}

function loadScore(score) {
  if (score.endsWith(".mmb")) {
    const smp = score.replace(/\.mmb$/, ".smp");
    if (!existsSync(smp)) return null;
    return { bytes: readFileSync(score), sampleBank: readFileSync(smp) };
  }
  const b = buildMmb(score);
  return b.sampleBank?.length ? b : null;
}

// ── a-today: the committed engine, measured ────────────────────────────────
// Built and run out of a detached git worktree, with that tree's own compiler
// (its increments are computed against its own sample rate, so this really is
// its output). Same harness as dac-clock.mjs.
async function captureBaseline(ref, score, tmp) {
  const wt = join(tmp, "baseline");
  execFileSync("git", ["worktree", "add", "--detach", "-f", wt, ref], { cwd: repo, stdio: "pipe" });
  try {
    const wdrv = join(wt, "drv");
    execFileSync("node", [join(wdrv, "tools", "gen-c-tables.mjs")], { stdio: "pipe" });
    const exe = join(tmp, "seq-base");
    execFileSync(process.env.CC ?? "cc",
      ["-std=c99", "-O1", "-o", exe, join(wdrv, "68k", "gate_main.c"),
        join(wdrv, "68k", "mmlispseq.c"), join(wdrv, "68k", "tables.c")], { stdio: "pipe" });
    const gen = await import(join(wdrv, "tools", "gen-mixer.mjs"));
    const mmbMod = await import(join(wdrv, "tools", "mmb-build.mjs"));
    // In memory, like every other tool: the mixer is generated, not authored,
    // and assembling it is a read (see z80asm.mjs's `sources`).
    const built = assemble(join(wdrv, "src", "engine.z80"),
      { sources: gen.generatedSources() });
    const sym = (n) => built.symbols.get(n);
    let mmb, sampleBank;
    if (score.endsWith(".mmb")) {
      mmb = readFileSync(score);
      sampleBank = readFileSync(score.replace(/\.mmb$/, ".smp"));
    } else ({ bytes: mmb, sampleBank } = mmbMod.buildMmb(score));
    writeFileSync(join(tmp, "b.mmb"), mmb);
    writeFileSync(join(tmp, "b.smp"), sampleBank);
    const out = execFileSync(exe,
      [join(tmp, "b.mmb"), String(FRAMES), "--samples", join(tmp, "b.smp")], { maxBuffer: 1 << 28 });
    const slots = [];
    for (let i = 0; i + 2 <= out.length; ) {
      const n = out[i] | (out[i + 1] << 8); i += 2; slots.push(out.subarray(i, i + n)); i += n;
    }
    const RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
    const ram = new Uint8Array(0x2000); ram.set(built.bytes, 0);
    let bank = 0, cyc = 0, win = 0, dacOn = false;
    // TIMER B, as dac-gate.mjs models it. Without it gate_wait spins for ever
    // on a status port answering a flat zero and a-today yields no samples.
    let gateAt = GATE_CY, enableB = false;
    const addr = [0, 0], ev = [];
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < 0x2000) return ram[a];
        if (a === 0x4000) return enableB && cyc >= gateAt ? 0x02 : 0;
        if (a >= 0x8000) { win++; return sampleBank[bank * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < 0x2000) { ram[a] = d; return; }
        if (a === 0x6000) { bank = ((bank >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
        if (a === 0x4000) { addr[0] = d; return; }
        if (a === 0x4002) { addr[1] = d; return; }
        if (a !== 0x4001) return;
        if (addr[0] === 0x27) {
          enableB = (d & 0x08) !== 0;
          if (d & 0x20) while (gateAt <= cyc) gateAt += GATE_CY;
        } else if (addr[0] === 0x2b) { dacOn = (d & 0x80) !== 0; if (!dacOn) ev.push([cyc, null]); }
        else if (addr[0] === 0x2a && dacOn) ev.push([cyc, d]);
      },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) cpu.step();
    let posted = 0, base = 0;
    for (let f = 0; f < slots.length; f++) {
      while (posted < slots.length) {
        const h = ram[sym("H_HEAD")], n = (h + 1) % DEPTH;
        if (n === ram[sym("H_TAIL")]) break;
        ram.fill(0, RING + h * SLOT, RING + h * SLOT + SLOT);
        ram.set(slots[posted++], RING + h * SLOT);
        ram[sym("H_HEAD")] = n;
      }
      // A frame is FRAME_CYCLES of wall clock whatever the engine does inside
      // it; an early finish is dead time the DAC spends holding, so it belongs
      // in the timeline. A frame that overran starts the next one late.
      cyc = Math.max(cyc, base);
      // What the host does every real frame (sgdk/mmlispdrv.c MMLisp_frame):
      // stamp the vblank the engine's catch-up compares against. Without it the
      // engine believes it is behind on every frame and runs the catch-up for
      // ever — which is a harness artefact, and it looked exactly like a ring
      // accounting bug.
      ram[sym("H_VBL")] = (f + 1) & 0xff;
      cpu.intRequest();
      // One loop with run-trace.mjs's exit condition. Stepping "while halted"
      // then "while not halted" never got past the first frame: the interrupt
      // is pending while the CPU is still halted.
      // A frame is FRAME_CYCLES of wall clock, not "until the CPU halts": the
      // engine feeds the DAC from its idle loop and only halts in a score with
      // no PCM in it. A halted Z80 burns 4-cycle NOPs here, exactly as it waits
      // out the rest of a frame on hardware — and running the frame out is what
      // puts the idle loop's own samples in this trace.
      let g = 0, fcyc = 0;
      while (g++ < 3_000_000 && fcyc < FRAME_CYCLES) {
        win = 0;
        const c = cpu.step() + win * PACE_WINDOW;
        cpu.decay(c);
        cyc += c; fcyc += c;
      }
      base += FRAME_CYCLES;
    }
    return { ev, period: FRAME_CYCLES / sym("PCM_MIX_R") };
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, stdio: "pipe" });
  }
}

// ── b/c/d: the Timer-B design, modelled ────────────────────────────────────
// The reference supplies the VALUES and the per-frame shape; this places them
// on a cycle timeline.
//
// THE RULE THE MODEL ENFORCES, and the thing building it taught: a frame's
// emission span IS the frame. 166.674 samples x 358.4 cycles = 59,736 = one
// frame exactly, by construction — so a cycle spent NOT emitting is not a hole
// to be caught up from later, it is a sample that never goes out. Timer B
// cannot give it back either: the overflow flag is one bit, so however many
// gates were missed, the engine gets one group and then the gate rate again.
//
// Two consequences, both audible below:
//
//   * every contiguous stretch of work — the slot's chip writes, a voice-pass
//     transition, a segment set-up — must carry emit points, at most one sample
//     period apart. This is XGM2's "<=168 cycles between sample outputs
//     EVERYWHERE" rule, arrived at from the other end.
//   * Timer B gates only every third sample, and the Z80 cannot read a clock,
//     so samples 2 and 3 of each group are paced by CODE PLACEMENT alone. A
//     loop copy whose iteration is cheaper than a sample period (a mute or idle
//     pass: 100 cycles against 358) bunches its three samples against the gate
//     unless it is padded to the period. The pad survives the timer — but as a
//     baked constant per loop copy, with none of the debt machinery.
//
// `paced` is the design with both obeyed; `nopad` is the same design with the
// second one forgotten, which is what it sounds like.
function modelTimerB(mmb, sampleBank, variant) {
  const player = new DrvPlayer(() => {});
  const trace = [];
  class TracingBuilder extends SlotBuilder {
    endFrame() {
      const s = super.endFrame();
      trace.push({ ring: player.getPcmRing(), nWrites: s[0] ?? 0 });
      return s;
    }
  }
  player.loadMMB(mmb, sampleBank);
  const cap = player.captureSlotLog({ maxFrames: FRAMES, builder: new TracingBuilder() });
  const byFrame = new Map(), dacOff = new Set();
  for (const w of cap.pcmLog) {
    if (w.reg === 0x2a) {
      if (!byFrame.has(w.frame)) byFrame.set(w.frame, []);
      byFrame.get(w.frame).push(w.data);
    } else if (w.data === 0) dacOff.add(w.frame);
  }

  const ev = [];
  // The group phase is CONTINUOUS across frames — a frame carries 166 or 167
  // samples and neither divides GROUP, so a phase that restarted every frame
  // would insert a gate wait at every frame boundary. (The engine's counter
  // does not reset either; getting this wrong in the model showed up as a hole
  // 60 times a second, which is precisely the artifact being designed out.)
  let t = 0, gate = GATE_CY, over = 0, phase = 0;
  for (let f = 0; f < trace.length; f++) {
    const bytes = byFrame.get(f) ?? [];
    const sounding = trace[f].ring.sounding;
    const prime = bytes.length === 1 && (f === 0 || trace[f - 1].ring.fill === 0);
    const chunk = bytes.length ? (prime ? PCM_RING_TARGET : bytes.length) : 0;
    t = Math.max(t, f * FRAME_CYCLES);      // a frame that overran starts late
    // d-flat puts every sample at its own instant on the sample clock, which is
    // what the frame's samples are INDEXED by anyway — so the bursts keep their
    // places and the only thing missing from it is what the clock did.
    let e = variant === "flat" ? pcmSampleIndex(f) * SAMPLE_CY : t;
    // What the frame COSTS. If this exceeds a frame the vblank is lost, the
    // next frame starts late, and the samples it owed go out late with it —
    // which is the one hole the design cannot design away.
    const mix = 3 * (TRANS + SEG) + chunk * (
      sounding >= 3 ? 3 * TICK_SOUND
        : sounding * TICK_SOUND + (3 - sounding) * TICK_IDLE);
    const work = trace[f].nWrites * YM_WRITE + HEAD_FIXED + mix + bytes.length * EMIT;
    // Where the samples land. Phase 0 of each group waits for Timer B; 2 and 3
    // are wherever the code puts them.
    const loopStep = sounding ? 3 * TICK_SOUND + EMIT : 3 * TICK_IDLE + EMIT;
    for (let i = 0; i < bytes.length; i++) {
      if (phase === 0 && variant !== "flat") {
        if (e < gate) e = gate;
        while (gate <= e) gate += GATE_CY;
      }
      phase = (phase + 1) % GROUP;
      ev.push([e, bytes[i]]);
      e += variant === "nopad" ? Math.min(loopStep, SAMPLE_CY) : SAMPLE_CY;
    }
    if (dacOff.has(f)) ev.push([Math.max(e, t + work), null]);
    if (work > FRAME_CYCLES) over++;
    t += Math.max(work, prime || !chunk ? 0 : bytes.length * SAMPLE_CY);
  }
  if (over) console.log(`        (${over} frames cost more than a frame — lost vblanks)`);
  return ev;
}

// ── run ────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "dacwav-"));
mkdirSync(OUT, { recursive: true });
try {
  if (!scores.length) scores = ["tone", join(drv, "tests", "m2-pcmloop.mmlisp")];
  scores = scores.map((s) => (s === "tone" ? toneScore(tmp) : s));
  console.log(`sample clock ${(Z80HZ / SAMPLE_CY).toFixed(0)} Hz — ${SAMPLE_CY.toFixed(1)} Z80 cycles a `
    + `sample, gate every ${GROUP} (${GATE_CY.toFixed(0)} cyc). Mix priced at `
    + `${TICK_SOUND}/${TICK_IDLE} cyc a tick (sounding/idle).`);
  for (const score of scores) {
    const stem = basename(score).replace(/\.(mmlisp|mmb)$/, "");
    const isTone = stem === "tone";
    const loaded = loadScore(score);
    if (!loaded) { console.log(`skip  ${basename(score)} — no sample bank`); continue; }
    console.log(`\n${stem} — ${FRAMES} frames`);
    const rendered = [];
    if (BASELINE !== "none") {
      const { ev, period } = await captureBaseline(BASELINE, score, tmp);
      rendered.push(["a-today", renderWav(ev, join(OUT, `${stem}-a-today.wav`)), ev]);
      // Same bytes, uniform clock — the baseline's OWN nominal period, so the
      // pitch is its own and the only thing taken out is the jitter. Burst
      // starts keep their real times (a burst is re-spaced inside itself, not
      // slid), or the silences between them would move the music.
      let last = null;
      const flat = ev.map(([c, v]) => {
        if (v === null) { const at = last ?? c; last = null; return [at, null]; }
        last = last === null ? c : last + period;
        return [last, v];
      });
      rendered.push(["a2-flat", renderWav(flat, join(OUT, `${stem}-a2-flat.wav`)), flat]);
    }
    for (const [tag, variant] of [["b-timerb", "paced"], ["c-nopad", "nopad"], ["d-flat", "flat"]]) {
      const ev = modelTimerB(loaded.bytes, loaded.sampleBank, variant);
      rendered.push([tag, renderWav(ev, join(OUT, `${stem}-${tag}.wav`)), ev]);
    }
    // The tone f0 is found on the flat render, where it is unambiguous, and the
    // same frequency is then measured in all of them.
    for (const [tag, { secs, pcm }, ev] of rendered) {
      console.log(`  ${tag}${" ".repeat(10 - tag.length)}${secs.toFixed(1)}s  ${summary(ev)}`);
      // f0 per render: the streams do not share a sample rate, so one f0 for
      // all of them would measure the carrier in some and its skirt in others.
      const f0 = isTone ? findTone(pcm) : 0;
      const sb = f0 ? sidebands(pcm, f0) : null;
      if (sb) {
        console.log(`${" ".repeat(12)}${f0} Hz tone: sidebands at 1x/2x/3x the frame rate `
          + `${sb.map((x) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`).join(" / ")} dB`);
      }
    }
  }
  console.log(`\nwrote ${OUT}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
