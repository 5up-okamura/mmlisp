// Where a frame's cycles actually go — a symbol-bucketed profile of the REAL
// engine running a REAL score.
//
//   node tools/seg-bench.mjs [score.mmlisp | song.mmb …] [--frames N] [--top N]
//                            [--stall N] [--stall-read N]
//
// A .mmb is taken as-is with its sample bank read from `<name>.smp` beside it —
// which is what an SGDK project's res/ actually holds, so a song can be profiled
// without its source.
//
// `mixer-bench.mjs` prices one mix TICK and says so: the segment split "is not
// modelled". But a segment measured ~2,400 cycles and a frame runs five to ten
// of them, so a fifth of the frame is spent somewhere that nothing in this repo
// has ever decomposed — and `PACE_SEG` charges the pad a flat constant for it.
// That constant is the reason the DAC feed still wanders ~3.4 ms
// (driver.md §5.1), and it cannot be improved by guessing at its parts.
//
// So this tool attributes every executed cycle to the nearest preceding label
// and reports the per-frame total. Labels are the engine's own, which is what
// makes the output honest: nothing here is a model of the code, it IS the code.
// It answers exactly one question — of the cycles a frame does not spend inside
// a paced loop body, which label holds them.
//
// Not a gate: nothing here can fail. `npm run dac` is the gate that watches the
// number this tool exists to move.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";
import { buildMmb } from "./mmb-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
// 240 frames is FOUR SECONDS. That is a fine sample of a gate score, which is
// short and deterministic by construction, and it is no sample at all of a real
// song: the frames that matter are the loop point, the section change, the
// dense bar — and a song has none of those in its first four seconds. A `.mmb`
// is a real song, so it gets a minute of it unless told otherwise.
const DEFAULT_FRAMES = (list) => (list.some((f) => f.endsWith(".mmb")) ? 4000 : 240);
const TOP = opt("top", 18);
// Z80 cycles the 68000 steals each frame by holding the Z80 bus. MMLisp_frame
// takes it three times — to read `tail`, to copy the slot, to write `head` —
// and the Z80 executes NOTHING while it is held. Every harness in this repo
// writes the slot into Z80 RAM as a free array assignment, so this cost is
// absent from all of them; it is real on hardware and it comes straight off the
// frame's margin. Sweep it to see how much headroom a song actually has.
const STALL = opt("stall", 0);
// Z80 cycles EACH READ through the $8000 ROM window costs beyond the CPU's own
// 7, waiting for the 68000's bus arbiter. This is the mixer-path hypothesis for
// the steady hardware frame loss, made runnable: `--stall-read 14` charges what
// the hardware numbers imply (~2,450 cyc per sounding voice per frame), lands
// it on the exact instructions that pay it, and lets the engine's pace_win_tab
// charge be tested against it — over-budget frames must return to the
// stall-free counts when the two agree.
const STALL_READ = opt("stall-read", 0);
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!scores.length) {
  scores = ["tests/m3-pcm-softmix.mmlisp", "tests/m2-pcmloop.mmlisp", "tests/m3-pcm-slice.mmlisp"]
    .map((p) => join(drv, p));
}
const FRAMES = opt("frames", DEFAULT_FRAMES(scores));

const FRAME_CYCLES = 59659;

// Cycles inside a paced loop body are the work the frame is FOR, and the pad is
// deliberate idle — neither is overhead however large it reads. Only the third
// group is what `PACE_SEG` charges the pad for, and it is the one this tool
// exists to size. Names come from the generator's `lbl()` counter, so the rules
// are on PREFIX, and `pd<digits>` (a pad loop) is not `pd_<word>` (pcm_debt).
const GROUPS = [
  ["pad (idle by design)", /^pd\d+$/],
  ["mix tick bodies", /^(mix_(first|add)_s\d+|np\d+|ov\d+(_hi)?|nc\d+|dn\d+)/],
  ["segment set-up", /^(mix_seg|ms_|mvf_|mve_|voice_ptr)/],
  ["pad accounting", /^(pd_|pcm_debt)/],
  ["slot consume", /^(cs|csc)/],
  ["PCM commands", /^pc_/],
  // The frame has no PCM at all, so the mixer is never entered and the two
  // remaining sub-slots have no voice-pass boundaries to ride (driver.md §3.5).
  // pace_sub burns the frame by hand to place them. Deliberate idle, like the
  // pad — and it is NOT a PCM command, which is what it read as while these
  // labels were called ps_*.
  ["paced idle (no PCM)", /^(pace_sub|pq_)/],
];
const groupOf = (n) => GROUPS.findIndex(([, re]) => re.test(n));

const tmp = mkdtempSync(join(tmpdir(), "segbench-"));
try {
  execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  const exe = join(tmp, "seq");
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-o", exe,
      join(drv, "68k", "gate_main.c"), join(drv, "68k", "mmlispseq.c"), join(drv, "68k", "tables.c")],
    { stdio: "pipe" });
  const { writeMixer } = await import("./gen-mixer.mjs");
  writeMixer();
  const built = assemble(join(drv, "src", "engine.z80"));
  const sym = (n) => built.symbols.get(n);

  // ── address → label bucket ────────────────────────────────────────────────
  // Every symbol that lands inside the image is a bucket boundary; an address
  // belongs to the nearest label at or below it. Built once as a flat table so
  // attribution costs one array read per instruction.
  const IMG = built.bytes.length;
  const marks = [...built.symbols.entries()]
    .filter(([, a]) => a >= 0 && a < IMG)
    .sort((x, y) => x[1] - y[1]);
  const bucketName = marks.map(([n]) => n);
  const owner = new Uint16Array(0x10000).fill(0xffff);
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1][1] : IMG;
    owner.fill(i, marks[i][1], end);
  }

  for (const score of scores) {
    const name = basename(score);
    // A .mmb is already compiled; its blobs live in the sibling .smp (mmb.md
    // §10 — the sample bank is a separate ROM bank, not an MMB section).
    let mmb, sampleBank;
    if (score.endsWith(".mmb")) {
      mmb = readFileSync(score);
      const smp = score.replace(/\.mmb$/, ".smp");
      if (!existsSync(smp)) {
        console.log(`skip  ${name} — no ${basename(smp)} beside it; a PCM song needs its sample bank`);
        continue;
      }
      sampleBank = readFileSync(smp);
    } else {
      ({ bytes: mmb, sampleBank } = buildMmb(score));
    }
    if (!sampleBank?.length) { console.log(`skip  ${name} — no sample bank`); continue; }
    const mmbPath = join(tmp, "s.mmb"), smpPath = join(tmp, "s.smp");
    writeFileSync(mmbPath, mmb); writeFileSync(smpPath, sampleBank);
    const out = execFileSync(exe, [mmbPath, String(FRAMES), "--samples", smpPath], { maxBuffer: 1 << 28 });
    const slots = [];
    for (let i = 0; i + 2 <= out.length; ) {
      const n = out[i] | (out[i + 1] << 8); i += 2; slots.push(out.subarray(i, i + n)); i += n;
    }

    const RAM = 0x2000, RING = sym("RING"), DEPTH = sym("RING_DEPTH"), SLOT = sym("SLOT_SIZE");
    const ram = new Uint8Array(RAM); ram.set(built.bytes, 0);
    let bankReg = 0, winReads = 0;
    const addr = [0, 0];
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < RAM) return ram[a];
        if (a === 0x4000) return 0;
        if (a >= 0x8000) { winReads++; return sampleBank[bankReg * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < RAM) { ram[a] = d; return; }
        if (a === 0x6000) { bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
        if (a === 0x4000) { addr[0] = d; return; }
        if (a === 0x4002) { addr[1] = d; return; } },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) cpu.step();

    const cost = new Float64Array(marks.length);
    const hits = new Float64Array(marks.length);
    const SEGB = bucketName.indexOf("mix_seg");
    // Segments come from the ENGINE'S OWN counter, not from bucket entries.
    // `mix_seg`'s bucket runs to the next label, so control re-enters it on the
    // return from `ms_call_unrolled` and a bucket-entry count reads ~2x high —
    // which silently doubles the x-axis of the regression below and made
    // PACE_SEG look 2x too steep when it was not. G_NSEG is what `pcm_debt`
    // itself reads, so it is the only count that can be compared to PACE_SEG.
    const G_NSEG = sym("G_NSEG");
    const G_ACTM = sym("G_ACTM");   // which PCM voices were sounding at frame start
    const obs = [];   // per frame: [segments, total cycles] — the regression below
    let frames = 0, total = 0, worst = 0;
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
      let cyc = 0, g = 0, prev = -1;
      while (cpu.halted && g++ < 1000) cyc += cpu.step();
      const tgt = process.env.SEG_FRAME !== undefined && f === Number(process.env.SEG_FRAME);
      const fcost = tgt ? new Float64Array(marks.length) : null;
      while (!cpu.halted && g++ < 3_000_000) {
        const b = owner[cpu.pc];
        winReads = 0;
        let c = cpu.step();
        c += winReads * STALL_READ;   // the stall lands on the instruction that fetched
        if (b !== 0xffff) {
          cost[b] += c;
          if (fcost) fcost[b] += c;
          if (b !== prev) { hits[b]++; prev = b; }
        }
        cyc += c;
      }
      if (fcost) {
        const rows = [...fcost.keys()].filter((i) => fcost[i] > 0)
          .sort((a2, b2) => fcost[b2] - fcost[a2]).slice(0, 24);
        console.log(`  [frame ${f}: ${cyc} cyc]`);
        for (const i of rows) console.log(`    ${bucketName[i].padEnd(18)} ${fcost[i].toFixed(0)}`);
      }
      const m = ram[G_ACTM];
      const nv = (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
      cyc += STALL;   // the bus the 68000 holds; see STALL above
      frames++; total += cyc; obs.push([ram[G_NSEG], cyc, nv, f]);
      if (cyc > worst) worst = cyc;
    }
    if (!frames) { console.log(`skip  ${name} — no frames ran`); continue; }

    const per = (v) => (v / frames).toFixed(0).padStart(7);
    const pct = (v) => `${(100 * v / frames / FRAME_CYCLES).toFixed(1)}%`.padStart(7);
    const gcost = new Float64Array(GROUPS.length + 1);
    for (let i = 0; i < marks.length; i++) {
      const g = groupOf(bucketName[i]);
      gcost[g < 0 ? GROUPS.length : g] += cost[i];
    }
    // A frame that overruns does not degrade — the vblank /INT is asserted for
    // about one scanline, so the interrupt is missed outright and the score
    // loses a whole frame (driver.md §1.1). This count is the tempo wobble.
    const over = obs.filter((o) => o[1] > FRAME_CYCLES).length;
    const slotBytes = slots.reduce((t, x) => t + x.length, 0) / slots.length;
    const slotMax = Math.max(...slots.map((x) => x.length));
    console.log(`\n${name} — ${frames} frames, mean ${(total / frames).toFixed(0)} cyc ` +
      `(${(100 * total / frames / FRAME_CYCLES).toFixed(0)}% of budget), worst ${worst} ` +
      `(${(100 * worst / FRAME_CYCLES).toFixed(0)}%)`);
    console.log(`  OVER BUDGET: ${over}/${frames} frames (${(100 * over / frames).toFixed(0)}%) ` +
      `— each one is a missed interrupt and a lost frame of music` +
      (STALL ? `  [with a ${STALL}-cycle bus stall charged per frame]` : "") +
      (STALL_READ ? `  [with ${STALL_READ} cycles charged per $8000-window read]` : ""));
    console.log(`  slot: ${slotBytes.toFixed(0)} B mean, ${slotMax} B worst ` +
      `— what the 68000 copies across the bus each frame, with the Z80 stopped`);
    // WHICH frames, and with how many PCM voices sounding. Both times this tool
    // was pointed at a tempo complaint, the answer was in this correlation and
    // not in the averages below: a frame's cost is dominated by how many voices
    // it mixes, and the over-budget ones cluster on note-ons and score heads.
    if (over) {
      const byV = {};
      for (const [, c, nv] of obs) {
        (byV[nv] ??= [0, 0])[0]++;
        if (c > FRAME_CYCLES) byV[nv][1]++;
      }
      console.log(`    by PCM voices sounding: ` +
        Object.entries(byV).map(([v, [n, o]]) => `${v}v ${o}/${n}`).join("   "));
      const list = obs.filter((o) => o[1] > FRAME_CYCLES).slice(0, 10)
        .map(([sg, c, nv, f]) => `f${f} ${(100 * c / FRAME_CYCLES).toFixed(0)}% ${nv}v ${sg}seg`);
      console.log(`    ${list.join("  ")}${over > 10 ? "  …" : ""}`);
    }
    for (let g = 0; g <= GROUPS.length; g++) {
      if (!gcost[g]) continue;
      const label = g < GROUPS.length ? GROUPS[g][0] : "other";
      console.log(`  ${label.padEnd(22)}${per(gcost[g])}${pct(gcost[g])}`);
    }
    const segs = obs.reduce((s, o) => s + o[0], 0) / frames;
    console.log(`  → ${segs.toFixed(1)} segments/frame (engine's G_NSEG), ` +
      `${(gcost[2] / frames / segs).toFixed(0)} cyc each by attribution`);
    // What PACE_SEG is actually FOR: the pad is cut by `segs x PACE_SEG`, so
    // what has to be right is the MARGINAL cost of one more segment, not its
    // average. Least squares over the frames gives it directly — and if the
    // slope is not PACE_SEG, every frame whose segment count differs from the
    // last one is mis-padded by the difference. That is the wander.
    const n = obs.length;
    const mx = obs.reduce((s, o) => s + o[0], 0) / n;
    const my = obs.reduce((s, o) => s + o[1], 0) / n;
    const sxy = obs.reduce((s, o) => s + (o[0] - mx) * (o[1] - my), 0);
    const sxx = obs.reduce((s, o) => s + (o[0] - mx) ** 2, 0);
    if (sxx > 0) {
      const slope = sxy / sxx;
      const lo = Math.min(...obs.map((o) => o[0])), hi = Math.max(...obs.map((o) => o[0]));
      const { PACE_SEG, PACE_RESERVE } = await import("./gen-mixer.mjs");
      console.log(`  → marginal cost of one segment: ${slope.toFixed(0)} cyc ` +
        `(PACE_SEG charges ${PACE_SEG} — ${(PACE_SEG / slope).toFixed(2)}x), ` +
        `segment count ranges ${lo}..${hi}`);
      console.log(`     mis-pad per extra segment: ${(PACE_SEG - slope).toFixed(0)} cyc = ` +
        `${(100 * (PACE_SEG - slope) / FRAME_CYCLES).toFixed(1)}% of a frame`);
      // The intercept is what PACE_RESERVE is for: the frame's fixed cost with
      // no segments at all, minus the pad it is allowed to keep.
      console.log(`     implied fixed cost (intercept): ${(my - slope * mx).toFixed(0)} cyc ` +
        `(PACE_RESERVE charges ${PACE_RESERVE})`);
    }
    console.log(`  ${"label".padEnd(22)}${"cyc/frame".padStart(10)}${"share".padStart(8)}${"entries".padStart(9)}`);
    const rank = [...cost.keys()]
      .filter((i) => { const g = groupOf(bucketName[i]); return (g < 0 || g >= 2) && cost[i] > 0; })
      .sort((a, b) => cost[b] - cost[a]).slice(0, TOP);
    for (const i of rank)
      console.log(`  ${bucketName[i].padEnd(22)}${per(cost[i])}${pct(cost[i])}` +
        `${(hits[i] / frames).toFixed(1).padStart(9)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
