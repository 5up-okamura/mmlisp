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
// modelled". But a frame runs five to ten segments, so a fifth of the frame is
// spent somewhere that nothing in this repo has ever decomposed.
//
// So this tool attributes every executed cycle to the nearest preceding label
// and reports the per-frame total. Labels are the engine's own, which is what
// makes the output honest: nothing here is a model of the code, it IS the code.
// It answers exactly one question — of the cycles a frame does not spend inside
// a paced loop body, which label holds them.
//
// Under Timer B that question has a sharp form, and the summary below states it:
//
//   the frame emits `chunk` samples and the timer spaces them, so the frame
//   cannot be shorter than chunk x SAMPLE_CYCLES however fast the code is. The
//   mix loops PAD themselves up to exactly that period, so their cycles are
//   free — they are the pacing. Everything else a frame does (the slot's chip
//   writes, the PCM commands, the segment set-ups, the frame's head) is NOT
//   paced, and every one of those cycles is added to the period rather than
//   hidden inside it. `npm run budget:frame` reports the sum; this reports the
//   NAMES.
//
// So read the "outside the paced loops" line first, and the ranking under it is
// the work list, largest first.
//
// The gate is modelled the way frame-budget.mjs models it: the Timer B overflow
// flag is satisfied on demand, so a gate wait costs what the CODE costs and the
// profile shows work rather than spin. Window reads are charged PACE_WINDOW by
// default (dac-gate's charge) — `--stall-read 0` prices an emulator-shaped
// frame that hardware never runs.
//
// Not a gate: nothing here can fail. `npm run budget:frame` and `npm run dac`
// are the gates that watch the numbers this tool exists to move.
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
// 7, waiting for the 68000's bus arbiter. It defaults to PACE_WINDOW — the same
// charge dac-gate, frame-budget and the mixer generator's pads all use — so the
// three tools price the same frame. `--stall-read 0` removes it, which times an
// emulator-shaped frame that hardware never runs.
const STALL_READ_OPT = opt("stall-read", -1);
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!scores.length) {
  scores = ["tests/m3-pcm-softmix.mmlisp", "tests/m2-pcmloop.mmlisp", "tests/m3-pcm-slice.mmlisp"]
    .map((p) => join(drv, p));
}
const FRAMES = opt("frames", DEFAULT_FRAMES(scores));

// A NTSC Mega Drive frame is 262 lines x 3420 master clocks = 896,040, and the
// Z80 runs at master/15 — so 59,736 Z80 cycles, not 59,659. 59,659 is
// 3,579,545 / 60, i.e. a 60 Hz frame, while every comment beside it said
// 59.92 Hz. The 77-cycle error is 0.13% and would not matter, except that it
// put the DAC's own clock (166.67 samples x 358.4 = 59,733) just ABOVE the
// frame instead of three cycles below it — which reads as "the sample rate
// cannot fit a frame even with zero work", and that is not true.
const FRAME_CYCLES = 59736;

// Cycles inside a paced loop body are the work the frame is FOR, and the pad is
// deliberate idle — neither is overhead however large it reads, because the
// loop holds itself to the sample period either way. Everything below the rule
// is what ADDS to the period, and it is what this tool exists to size. Names
// come from the generator's `lbl()` counter, so the rules are on PREFIX, and
// `pd<digits>` (a pad loop) is not `pd_<word>`.
//
// `PACED` marks the groups that are inside a padded loop body — their cycles
// are covered by the pacing and cost the frame nothing extra.
const PACED = 3;
const GROUPS = [
  ["pad (idle by design)", /^pd\d+$/],
  // `gt<digits>` is the inline gate's skip label — it sits INSIDE a loop copy,
  // so the emit and pad after it belong to that copy and not to a bucket of
  // their own. Without this rule a third of the frame reads as "other".
  ["mix tick bodies", /^(mix_(first|add)_s\d+|np\d+|ov\d+(_hi)?|nc\d+|dn\d+|gt\d+)/],
  // The gate's own spin. Modelled as satisfied-on-demand (see the header), so
  // what lands here is the cost of ASKING, not of waiting.
  ["gate + emit", /^(gate_|feed_one|fo_|fr_|flush_rest)/],
  // ── everything below this line is added to the sample period ──────────────
  ["segment set-up", /^(mix_seg|ms_|mvf_|mve_|voice_ptr|mix_voice|mp_|pv_)/],
  ["slot consume", /^(cs|csc)/],
  ["PCM commands", /^(pc_|pp_|process_pcm|pcm_)/],
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
  const { writeMixer, PACE_WINDOW, SAMPLE_CYCLES } = await import("./gen-mixer.mjs");
  writeMixer();
  const STALL_READ = STALL_READ_OPT < 0 ? PACE_WINDOW : STALL_READ_OPT;
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
    // A score with no PCM still HAS a frame: the slot's chip writes, the
    // sub-slot pacing, the sequencer's own head. Skipping it meant every cycle
    // number in this repo came from a PCM score, and the PCM gate scores are
    // musically trivial — 19 B slots — so the write stream was never measured
    // at any density. An empty bank runs it fine; only PCM commands read one.
    if (!sampleBank?.length) sampleBank = new Uint8Array(0);
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
    // Timer B's overflow flag, modelled as frame-budget.mjs models it: it is
    // already up once the frame has run GATE_CY cycles, so `gate_wait` reads it
    // once and falls through. That is deliberate — a profile of the engine
    // SPINNING says only that the gate works, and what has to be sized here is
    // the work that does not fit between two overflows.
    // ── the DEAD ZONE ────────────────────────────────────────────────────────
    // Stage D's rule is that no stretch of work between two samples may exceed
    // one sample period (§5.1.2). Total work can be well UNDER the clock's own
    // floor and the frame still overrun, because a stretch longer than a period
    // pushes every later sample back and the delays accumulate — which is
    // exactly what `dac-gate`'s "in-frame hold 6.5/23.6 periods" is reporting.
    //
    // So: charge every cycle spent more than one period after the last DAC
    // write to the label running at the time. That ranks the code that needs an
    // emit point, which is a different list from the one ranked by total cost —
    // a label can be cheap and still hold the DAC through a hole, and a label
    // can be expensive and cost the feed nothing because it emits as it goes.
    // Only BETWEEN two emits, and only on a frame that emits at all: a frame
    // with no PCM feeds nothing by design (pace_sub burns it on purpose to
    // place the sub-slots), so there is no feed there to starve and charging it
    // ranked `pq_in` first — 5,115 cyc/frame of "dead time" on frames where the
    // DAC is not running. -1 means "no emit yet this frame".
    const dead = new Float64Array(marks.length);
    let sinceEmit = -1, deadTotal = 0;
    // The INTERVAL between consecutive DAC writes, measured. This is the ground
    // truth for "does one iteration fit a sample period" — gen-mixer computes
    // 318 cyc/sample for a shift-0 pass from its own instruction model, and a
    // model is a claim about the code, not the code. Two of every PCM_GROUP
    // intervals are set by the loop alone; the third is the gate's and is
    // whatever the timer says, so they are reported apart.
    const gaps = [];
    // Split by WHICH emit: one in PCM_GROUP waits on the timer and then resets
    // its flag through $27, the other two are the loop's alone. If the gating
    // emit is the slow one, the fix is in gate_wait; if they are all slow, it
    // is the loop. Tagged from the $27 bit-5 write itself, not inferred.
    const gapsGate = [], gapsLoop = [];
    let gateArmed = false;
    // Cycles per TIMER B GROUP. A group is PCM_GROUP samples and the timer
    // gives it PCM_GROUP x SAMPLE_CYCLES cycles for the mixing AND for whatever
    // out-of-loop work falls inside it. Two of its samples can be emitted
    // early; the third waits for the overflow regardless — so a group that runs
    // long is never made up and a group with slack cannot give it away. The sum
    // of the EXCESSES is therefore the frame's overrun, and this is the only
    // view that shows it: per-frame averages say the work fits.
    const groups = [];
    let groupCyc = 0, groupN = 0;
    // What is IN the groups that blow the budget. Only ~11% of groups do, and
    // they carry the whole overrun, so a frame-wide or even a hole-wide ranking
    // averages them away — this is the only view that names them.
    const heavy = new Float64Array(marks.length);
    let groupLbl = [];
    const GATE_CY = Math.round((2304 / (53693175 / 7)) * 3579545);
    let fcyc = 0, fed = 0, enableB = false;
    // YM2612 BUSY: 32 internal cycles after a DATA write (Nuked-OPN2's
    // `write_busy_cnt >> 5`), an internal cycle is 6 YM clocks, a YM clock is
    // 7/15 of a Z80 one — 90 Z80 cycles. The consume loop polls it before every
    // data write and no harness here used to make it spin.
    // Judged on a MONOTONIC counter — `fcyc` restarts every frame, and against
    // that the chip read BUSY at every frame boundary.
    const BUSY_CY = Math.round(32 * 6 * 7 / 15);
    let tcyc = 0, lastData = -1e9;
    const addr = [0, 0];
    const cpu = new Z80Cpu({
      read: (a) => { a &= 0xffff;
        if (a < RAM) return ram[a];
        // ENABLE B ($27 bit 3) gates the flag on the chip — Nuked-OPN2 only ever
        // sets it as `timer_b_overflow & timer_b_enable` (ym3438.c). Modelled
        // here too so this tool cannot report a frame the hardware never runs.
        if (a === 0x4000) return (tcyc - lastData < BUSY_CY ? 0x80 : 0)
          | (enableB && fcyc >= GATE_CY ? 0x02 : 0);
        if (a >= 0x8000) { winReads++; return sampleBank[bankReg * 0x8000 + (a - 0x8000)] ?? 0; }
        return 0xff; },
      write: (a, d) => { a &= 0xffff;
        if (a < RAM) { ram[a] = d; return; }
        if (a === 0x6000) { bankReg = ((bankReg >> 1) | ((d & 1) << 8)) & 0x1ff; return; }
        if (a === 0x4000) { addr[0] = d; return; }
        if (a === 0x4001 || a === 0x4003) lastData = tcyc;
        if (a === 0x4001 && addr[0] === 0x27 && (d & 0x20)) gateArmed = true;
        if (a === 0x4001 && addr[0] === 0x2a) {
          if (sinceEmit >= 0) {
            gaps.push(sinceEmit);
            (gateArmed ? gapsGate : gapsLoop).push(sinceEmit);
          }
          if (++groupN === 3) {
            groups.push(groupCyc);
            if (groupCyc > SAMPLE_CYCLES * 3)
              for (const [bb, cc] of groupLbl) heavy[bb] += cc;
            groupCyc = 0; groupN = 0; groupLbl.length = 0;
          }
          gateArmed = false;
          sinceEmit = 0;   // between emits now
          frameTail.length = 0;   // everything so far is not the tail
        }
        if (a === 0x4001 && addr[0] === 0x27) { enableB = (d & 0x08) !== 0; return; }
        // $2A on port 0 is the DAC. Counting the writes is how many samples the
        // frame actually fed, which is what the timer paces — and it is the
        // engine's own answer, not a re-derivation of the schedule.
        if (a === 0x4001 && addr[0] === 0x2a) { fed++; return; }
        if (a === 0x4002) { addr[1] = d; return; } },
    });
    cpu.pc = 0;
    for (let i = 0; i < 2_000_000 && !(ram[sym("H_READY")] === 0xd2 && cpu.halted); i++) tcyc += cpu.step();

    const cost = new Float64Array(marks.length);
    const hits = new Float64Array(marks.length);
    // The biggest single holes, with WHERE in the frame they fell. A flat
    // per-label ranking cannot tell "one 8,000-cycle hole at the head" from
    // "forty 200-cycle holes spread through the passes", and those need
    // completely different fixes.
    let gapRun = 0, gapAt = 0, gapLbl = -1;
    const worstGaps = [];
    // Which LABEL opens the holes in the band that dominates. The biggest-hole
    // list shows only the extremes, and the per-label ranking sums every size
    // into one number; this names the recurring middle, which is where the
    // cycles actually are.
    const bandLbl = new Map();
    // Cycles executed after the frame's LAST $2A write, by label.
    const tail = new Float64Array(marks.length);
    let tailTotal = 0, frameTail = [];
    const G_ACTM = sym("G_ACTM");   // which PCM voices were sounding at frame start
    const obs = [];   // per frame: [samples fed, total cycles, voices, index]
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
      fcyc = 0; fed = 0; sinceEmit = -1;
      while (cpu.halted && g++ < 1000) { const c = cpu.step(); cyc += c; tcyc += c; }
      const tgt = process.env.SEG_FRAME !== undefined && f === Number(process.env.SEG_FRAME);
      const fcost = tgt ? new Float64Array(marks.length) : null;
      while (!cpu.halted && g++ < 3_000_000) {
        const b = owner[cpu.pc];
        winReads = 0;
        let c = cpu.step();
        c += winReads * STALL_READ;   // the stall lands on the instruction that fetched
        // Everything past the first period is dead time the ear hears as a hold.
        if (sinceEmit >= 0) sinceEmit += c;
        if (sinceEmit > SAMPLE_CYCLES && b !== 0xffff) {
          const over = Math.min(c, sinceEmit - SAMPLE_CYCLES);
          dead[b] += over; deadTotal += over;
          if (gapRun === 0) { gapAt = fcyc; gapLbl = b; }
          gapRun += over;
        } else if (gapRun > 0) {
          worstGaps.push([gapRun, gapLbl, gapAt, f]);
          const tot = gapRun + SAMPLE_CYCLES;
          if (tot >= 800 && tot < 1500) {
            const k = bucketName[gapLbl];
            const e = bandLbl.get(k) ?? [0, 0];
            e[0] += gapRun; e[1]++; bandLbl.set(k, e);
          }
          gapRun = 0;
        }
        if (b !== 0xffff) {
          cost[b] += c;
          if (fcost) fcost[b] += c;
          if (b !== prev) { hits[b]++; prev = b; }
        }
        cyc += c; fcyc += c; tcyc += c; groupCyc += c;
        if (b !== 0xffff) groupLbl.push([b, c]);
        if (b !== 0xffff) frameTail.push([b, c]);   // trimmed at each emit
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
      for (const [b, c] of frameTail) { tail[b] += c; tailTotal += c; }
      frameTail.length = 0;
      frames++; total += cyc; obs.push([fed, cyc, nv, f]);
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
      // Cost BY VOICE COUNT, which is the number that sets expectations: a
      // sounding pass is ~26k cycles against an idle one's ~11k, so what fits
      // is decided by how many voices sound and not by any of the overhead
      // below. Printed as mean % of a frame, with the over-budget share.
      const byV = {};
      for (const [, c, nv] of obs) {
        const e = (byV[nv] ??= [0, 0, 0]);
        e[0]++; e[2] += c;
        if (c > FRAME_CYCLES) e[1]++;
      }
      console.log(`    by PCM voices sounding: ` + Object.entries(byV)
        .map(([v, [n, o, t]]) =>
          `${v}v ${(100 * t / n / FRAME_CYCLES).toFixed(0)}% (${o}/${n} over)`).join("   "));
      const list = obs.filter((o) => o[1] > FRAME_CYCLES).slice(0, 10)
        .map(([sm, c, nv, f]) => `f${f} ${(100 * c / FRAME_CYCLES).toFixed(0)}% ${nv}v ${sm}smp`);
      console.log(`    ${list.join("  ")}${over > 10 ? "  …" : ""}`);
    }
    for (let g = 0; g <= GROUPS.length; g++) {
      if (!gcost[g]) continue;
      const label = g < GROUPS.length ? GROUPS[g][0] : "other";
      console.log(`  ${(g === PACED ? "· " : "  ") + label}`.padEnd(24)
        + `${per(gcost[g])}${pct(gcost[g])}`);
    }
    // ── the one number this tool exists for ──────────────────────────────────
    // The frame feeds `smp` samples and Timer B spaces them, so it cannot end
    // before smp x SAMPLE_CYCLES however fast the code is: that is the FLOOR.
    // The gate is satisfied on demand here, so what is measured is WORK, and
    // the frame really lasts whichever of the two is larger. Work above the
    // floor is the engine outrunning its own clock, and it is what the ranking
    // below is a work list for.
    //
    // The inside/outside split says where the slack is rather than what it
    // costs: the padded loops can always be made to fill more of the floor
    // (pcm_pad does exactly that), so only the OUTSIDE figure competes with it.
    const smp = obs.reduce((s, o) => s + o[0], 0) / frames;
    const paced = gcost.slice(0, PACED).reduce((s, v) => s + v, 0) / frames;
    const work = total / frames;
    const floor = smp * SAMPLE_CYCLES;
    const pc = (v) => `${(100 * v / FRAME_CYCLES).toFixed(1)}%`;
    console.log(`  → ${smp.toFixed(1)} samples fed/frame x ${SAMPLE_CYCLES} cyc = `
      + `${floor.toFixed(0)} the timer's floor (${pc(floor)} of a frame)`);
    console.log(`     work ${work.toFixed(0)} (${pc(work)}) — `
      + (work > floor
        ? `${(work - floor).toFixed(0)} OVER its own clock, so the frame is the work`
        : `${(floor - work).toFixed(0)} under its own clock, so the frame is the floor`));
    console.log(`     of that, ${paced.toFixed(0)} inside the padded loops and `
      + `${(work - paced).toFixed(0)} outside them — only the second competes with the floor`);
    const gap = Math.max(work, floor) - FRAME_CYCLES;
    console.log(`     ⇒ ${gap > 0 ? `OVER the vblank by ${gap.toFixed(0)} cyc (${pc(gap)})`
      : `fits the vblank, ${(-gap).toFixed(0)} cyc spare`}`);
    // The work list Stage D actually needs, ranked by dead time rather than by
    // cost. `npm run dac`'s in-frame hold is the number this moves.
    if (groups.length) {
      const GROUP_CY = SAMPLE_CYCLES * 3;
      const g = [...groups].sort((a, b) => a - b);
      const q = (f) => g[Math.floor((g.length - 1) * f)];
      const over = groups.reduce((t, v) => t + Math.max(0, v - GROUP_CY), 0);
      const nOver = groups.filter((v) => v > GROUP_CY).length;
      console.log(`  PER TIMER B GROUP (budget ${GROUP_CY} cyc, ${(groups.length / frames).toFixed(1)} a frame):`);
      console.log(`    p10 ${q(0.1)} · p50 ${q(0.5)} · p90 ${q(0.9)} · max ${q(1)} cyc`
        + ` · mean ${(groups.reduce((t, v) => t + v, 0) / groups.length).toFixed(0)}`);
      console.log(`    OVER budget: ${(100 * nOver / groups.length).toFixed(0)}% of groups,`
        + ` and their excess totals ${(over / frames).toFixed(0)} cyc/frame`
        + ` — this is the overrun, and nothing else can be`);
      // By KIND, not by label. "which label" says mvf_rc_feed and ms_load; only
      // "which kind" says whether the fix is in the segment machinery, in the
      // slot's chip writes, or in the frame's fixed head — and those are three
      // different pieces of work.
      const kind = new Float64Array(GROUPS.length + 2);
      for (let i = 0; i < marks.length; i++) {
        if (!heavy[i]) continue;
        const n = bucketName[i];
        const g = groupOf(n);
        // the frame's own head, which no GROUPS rule covers
        const head = /^(frame_step|consume_slot|cs_|cr_|ih_|slot_)/.test(n);
        kind[g < 0 ? (head ? GROUPS.length + 1 : GROUPS.length) : g] += heavy[i];
      }
      for (let g = 0; g < kind.length; g++) {
        if (!kind[g]) continue;
        const label = g < GROUPS.length ? GROUPS[g][0]
          : g === GROUPS.length ? "other" : "the frame's head (slot + chip writes)";
        console.log(`      ${label.padEnd(34)}${(kind[g] / frames).toFixed(0).padStart(6)} cyc/frame`);
      }
      const hr = [...heavy.keys()].filter((i) => heavy[i] > 0)
        .sort((a, b) => heavy[b] - heavy[a]).slice(0, 10);
      console.log(`    what is IN the over-budget groups, by kind:`);
      for (const i of hr)
        console.log(`      ${bucketName[i].padEnd(20)}${(heavy[i] / frames).toFixed(0).padStart(6)} cyc/frame`);
    }
    if (gaps.length) {
      const g = [...gaps].sort((a, b) => a - b);
      const q = (f) => g[Math.floor((g.length - 1) * f)];
      // The loop's own interval is the LOWER band — the gate's emit waits for
      // the timer and lands high, so the median of the bottom two thirds is
      // what the generator's number should be compared against.
      const loopBand = g.slice(0, Math.floor(g.length * 2 / 3));
      console.log(`  MEASURED sample interval (${gaps.length} emits): `
        + `p10 ${q(0.1)} · p50 ${q(0.5)} · p90 ${q(0.9)} · max ${q(1)} cyc`
        + ` — the period is ${SAMPLE_CYCLES}`);
      const band = (arr, label) => {
        if (!arr.length) return;
        const a = [...arr].sort((x, y) => x - y);
        const p = (f) => a[Math.floor((a.length - 1) * f)];
        const mean = a.reduce((t, v) => t + v, 0) / a.length;
        console.log(`    ${label.padEnd(18)} n=${String(a.length).padStart(7)} `
          + `p50 ${String(p(0.5)).padStart(4)} · p90 ${String(p(0.9)).padStart(5)} · `
          + `mean ${mean.toFixed(0).padStart(4)} cyc`
          + (mean > SAMPLE_CYCLES ? `  OVER the period by ${(mean - SAMPLE_CYCLES).toFixed(0)}` : ""));
      };
      band(gapsLoop, "loop's own emits");
      band(gapsGate, "the GATING emit");
      // WHERE the dead time lives, by hole size. Many medium holes and a few
      // huge ones need opposite fixes — an emit point inside a hot path is
      // wrong for the first and right for the second — and the per-label
      // ranking cannot tell them apart because it sums both into one number.
      const bins = [[358, 500], [500, 800], [800, 1500], [1500, 4000], [4000, 1e9]];
      console.log(`    dead time by HOLE SIZE (cyc/frame, and how many a frame):`);
      for (const [lo, hi] of bins) {
        let cyc = 0, n = 0;
        for (const v of gaps) if (v >= lo && v < hi) { cyc += v - SAMPLE_CYCLES; n++; }
        if (!n) continue;
        console.log(`      ${String(lo).padStart(5)}..${hi > 1e8 ? "  up" : String(hi).padStart(4)} `
          + `${(cyc / frames).toFixed(0).padStart(6)} cyc  ${(n / frames).toFixed(1).padStart(6)} holes`
          + `  ${(100 * cyc / deadTotal).toFixed(0).padStart(3)}% of the dead time`);
      }
    }
    // What runs AFTER the frame's last sample. The frame ends when the ISR
    // halts, and the last emit is gated — so the frame is (the last emit's
    // instant) + (whatever work follows it), and only the second half is
    // reducible. Emit PLACEMENT cannot touch it: the frame's emit total is
    // fixed at `chunk` by G_EMITS, so moving an emit earlier only stops a loop
    // emitting later — measured, adding or removing emit points leaves the
    // frame at the same cycle.
    if (tailTotal) {
      console.log(`  AFTER THE LAST SAMPLE: ${(tailTotal / frames).toFixed(0)} cyc/frame`
        + ` (${(100 * tailTotal / frames / FRAME_CYCLES).toFixed(1)}% of a frame)`
        + ` — the part of the overrun that emit points cannot reach`);
      const tr = [...tail.keys()].filter((i) => tail[i] > 0)
        .sort((a, b) => tail[b] - tail[a]).slice(0, 8);
      for (const i of tr)
        console.log(`    ${bucketName[i].padEnd(20)}${(tail[i] / frames).toFixed(0).padStart(6)} cyc`);
    }
    if (bandLbl.size) {
      console.log(`    the 800..1500 band, by the label that OPENS the hole:`);
      for (const [k, [c, n]] of [...bandLbl].sort((a, b) => b[1][0] - a[1][0]).slice(0, 6))
        console.log(`      ${k.padEnd(20)}${(c / frames).toFixed(0).padStart(6)} cyc`
          + `${(n / frames).toFixed(1).padStart(6)} a frame`);
    }
    console.log(`  DEAD TIME (DAC holding, past one ${SAMPLE_CYCLES}-cycle period): `
      + `${(deadTotal / frames).toFixed(0)} cyc/frame `
      + `(${(100 * deadTotal / frames / FRAME_CYCLES).toFixed(1)}% of a frame) — `
      + `each of these wants an emit point`);
    worstGaps.sort((a, b) => b[0] - a[0]);
    console.log(`    biggest single holes: ` + worstGaps.slice(0, 6)
      .map(([g, l, at, f]) => `${(g / SAMPLE_CYCLES).toFixed(1)}p in ${bucketName[l]}`
        + ` @${(100 * at / FRAME_CYCLES).toFixed(0)}% f${f}`).join("  "));
    const deadRank = [...dead.keys()].filter((i) => dead[i] > 0)
      .sort((a, b) => dead[b] - dead[a]).slice(0, 8);
    for (const i of deadRank)
      console.log(`    ${bucketName[i].padEnd(20)}${(dead[i] / frames).toFixed(0).padStart(7)}`
        + `${(dead[i] / Math.max(1, hits[i])).toFixed(0).padStart(8)} cyc/visit`);
    console.log(`  ${"label".padEnd(22)}${"cyc/frame".padStart(10)}${"share".padStart(8)}${"entries".padStart(9)}`);
    const rank = [...cost.keys()]
      .filter((i) => { const g = groupOf(bucketName[i]); return (g < 0 || g >= PACED) && cost[i] > 0; })
      .sort((a, b) => cost[b] - cost[a]).slice(0, TOP);
    for (const i of rank)
      console.log(`  ${bucketName[i].padEnd(22)}${per(cost[i])}${pct(cost[i])}` +
        `${(hits[i] / frames).toFixed(1).padStart(9)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
