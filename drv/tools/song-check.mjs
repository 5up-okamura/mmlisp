// "Will this song actually make sound?" — the whole chain, without hardware.
//
//   node tools/song-check.mjs <score.mmlisp | song.mmb> [--samples song.smp]
//                             [--frames N]
//
// Runs the REAL 68k sequencer (68k/mmlispseq.c) over the score, feeds its slot
// stream to the REAL Z80 engine (src/engine.z80) under emulation, and reports
// what reached the chips. It is not a gate — nothing here can fail — it is the
// answer to a bring-up question that otherwise costs a hardware round trip:
// silence on target is either the driver or the integration, and this says
// which. If the DAC line below shows signal, the driver is not why your PCM is
// missing.
//
// The sample bank is modelled at ROM address 0, matching the gate. Where it
// really lands is bank arithmetic done at MMLisp_setSampleBank time from the
// linked address, so a wrong bank is a link-map question, not this one.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const FRAMES = Number(opt("frames", 600));
const input = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!input) {
  console.error("usage: node tools/song-check.mjs <score.mmlisp | song.mmb> [--samples f] [--frames N]");
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "songcheck-"));
try {
  // ── Inputs: compile a score, or take the blobs as they will ship ──────────
  let mmbPath = input, smpPath = opt("samples", null);
  if (input.endsWith(".mmlisp")) {
    const { buildMmb } = await import("./mmb-build.mjs");
    const { bytes, sampleBank } = buildMmb(input);
    mmbPath = join(tmp, "song.mmb");
    writeFileSync(mmbPath, bytes);
    if (sampleBank?.length) {
      smpPath = join(tmp, "song.smp");
      writeFileSync(smpPath, sampleBank);
    }
  }
  const smp = smpPath && existsSync(smpPath) ? new Uint8Array(readFileSync(smpPath)) : new Uint8Array(0);

  // ── The 68k sequencer ────────────────────────────────────────────────────
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const out = execFileSync(exe,
    [mmbPath, String(FRAMES), ...(smpPath ? ["--samples", smpPath] : [])],
    { maxBuffer: 1 << 28 });
  const slots = [];
  for (let i = 0; i + 2 <= out.length; ) {
    const n = out[i] | (out[i + 1] << 8); i += 2;
    slots.push(out.subarray(i, i + n)); i += n;
  }

  // ── The Z80 engine ───────────────────────────────────────────────────────
  const { writeMixer } = await import("./gen-mixer.mjs");
  writeMixer();
  const built = assemble(join(drv, "src", "engine.z80"));
  const sym = (n) => built.symbols.get(n);
  const RAM = 0x2000, RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
  const IDLE = sym("idle"), IDLE_END = sym("idle_halt");
  const ram = new Uint8Array(RAM);
  ram.set(built.bytes, 0);
  let bankReg = 0, dacEn = 0, fm = 0, psg = 0;
  const addr = [0, 0];
  const dac = [];
  const cpu = new Z80Cpu({
    read: (a) => {
      a &= 0xffff;
      if (a < RAM) return ram[a];
      if (a === 0x4000) return 0;          // YM status: never BUSY
      if (a >= 0x8000) return smp[bankReg * 0x8000 + (a - 0x8000)] ?? 0;
      return 0xff;
    },
    write: (a, d) => {
      a &= 0xffff;
      if (a < RAM) { ram[a] = d; return; }
      if (a === 0x6000) { bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
      if (a === 0x7f11) { psg++; return; }
      if (a === 0x4000) { addr[0] = d; return; }
      if (a === 0x4002) { addr[1] = d; return; }
      if (a === 0x4001) {
        if (addr[0] === 0x2a) dac.push(d);
        else if (addr[0] === 0x2b) dacEn = d;
        else fm++;
        return;
      }
      if (a === 0x4003) { fm++; return; }
    },
  });
  cpu.pc = 0;
  for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) cpu.step();
  if (ram[sym("H_READY")] !== 0xd2) throw new Error("engine never reported ready");

  // Cycles the ENGINE spends per frame. The Z80 keeps the clock by taking one
  // vblank interrupt per frame, so work that overruns the frame is work that
  // makes it miss the next interrupt — which is what an uneven tempo is.
  const FRAME_CYCLES = 59736;   // Z80 at master/15, a 59.92 Hz frame
  const perFrame = [];
  let posted = 0;
  for (let f = 0; f < slots.length; f++) {
    while (posted < slots.length) {
      const head = ram[sym("H_HEAD")], next = (head + 1) % DEPTH;
      if (next === ram[sym("H_TAIL")]) break;
      ram.fill(0, RING + head * SLOT, RING + head * SLOT + SLOT);
      ram.set(slots[posted++], RING + head * SLOT);
      ram[sym("H_HEAD")] = next;
    }
    cpu.intRequest();
    // A frame is FRAME_CYCLES of wall clock, not "until the CPU halts": the
    // engine feeds the DAC from its idle loop and only halts in a score with no
    // PCM in it. A halted Z80 burns 4-cycle NOPs here, exactly as it waits out
    // the rest of a frame on hardware.
    // …and the FRAME COST is the part of it the INTERRUPT owns: cycles until
    // the engine first reaches its idle loop. Everything after that is the DAC
    // feed, which is meant to fill the rest of the frame and says nothing about
    // whether the engine is keeping up.
    let g = 0, cyc = 0, isr = 0, inIsr = true, left = false;
    while (g++ < 3_000_000 && cyc < FRAME_CYCLES) {
      const idling = cpu.pc >= IDLE && cpu.pc < IDLE_END;
      // The CPU is ALREADY idling when the frame opens — it has to leave the
      // loop (take the interrupt) before coming back to it means anything.
      if (!left) { if (!idling) left = true; }
      else if (inIsr && idling) { isr = cyc; inIsr = false; }
      cyc += cpu.step();
    }
    if (inIsr) isr = cyc;
    cyc = isr;
    if (g >= 3_000_000) throw new Error(`frame ${f} never completed`);
    perFrame.push(cyc);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const signal = dac.filter((d) => d !== 0x80).length;
  const has = (n, unit) => (n ? `${n} ${unit}` : `NONE`);
  console.log(`${basename(input)} — ${slots.length} frames through the real driver\n`);
  console.log(`  FM writes    ${has(fm, "")}`);
  console.log(`  PSG writes   ${has(psg, "")}`);
  if (smp.length) {
    console.log(`  DAC enable   $2B = 0x${dacEn.toString(16)}${dacEn ? "" : "   <- never enabled: no PCM voice ever started"}`);
    console.log(`  DAC feed     ${dac.length} writes, ${signal} carrying signal ` +
                `(${(100 * signal / (dac.length || 1)).toFixed(1)}%)`);
    if (!dac.length) {
      console.log(`\n  No PCM reached the chip. Either the score starts no PCM note in` +
                  ` these ${FRAMES} frames, or its sample bank did not load.`);
    }
  } else {
    console.log(`  DAC feed     no sample bank given (pass --samples, or a .mmlisp that has one)`);
  }
  const sorted = [...perFrame].sort((a, b) => a - b);
  const pc = (n) => `${n} cyc (${(100 * n / FRAME_CYCLES).toFixed(0)}% of the frame)`;
  const over = perFrame.filter((c) => c > FRAME_CYCLES).length;
  console.log(`\n  Z80 frame     median ${pc(sorted[sorted.length >> 1])}`);
  console.log(`                peak   ${pc(sorted[sorted.length - 1])}`);
  if (over) {
    console.log(`                ${over}/${perFrame.length} frames OVERRUN the frame — the engine` +
                ` cannot take its\n                next vblank on time, so the music does not` +
                ` advance evenly.`);
  }
  console.log(`\n  On target, silence with these numbers non-zero is an integration` +
              ` problem, not the driver:\n` +
              `  the sample bank publish (MMLisp_setSampleBank), the track list` +
              ` (MMLisp_trackCount), or\n  the ring (MMLisp_starvedFrames).`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
