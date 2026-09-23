// WHERE THE 68000 SPENDS ITS FRAME, measured in the real SGDK build.
//
//   node tools/sgdk-profile.mjs [score.mmlisp] [--seconds N] [--fn a,b,c] [--keep]
//   node tools/sgdk-profile.mjs [score.mmlisp] [--seconds N] --pc [period] [--peak N]
//
// --pc: no wrappers — the shipped code as built — and the probe core samples
// the 68000's PC every `period` master clocks (default 1,000). Each sample is
// attributed through the ELF to the innermost source function and line
// (addr2line -i, so code LTO inlined into main is still named), including the
// time SGDK spends waiting for the next frame: the 68000's idle share.
// --peak N: only mmlp_render (the host's frame) is marked, and only the samples inside the N
// most expensive renders are counted — where a frame that does not fit goes.
//
// Builds the example project for the score (as tools/sgdk-gate.mjs does), but
// before `make` wraps each named function in the installed sources — the
// sequencer, the converter, the host glue — so its entry and exit write a mark
// to $A130F1, which the probe BlastEm logs with the master-clock time. Then it
// runs the ROM and reports, per function: calls, cost per call (p50/p99/max,
// master clocks) and share of the 68000's time; and per frame: how often the
// render did not fit one.
//
// Interrupt-side functions (the pumps) are subtracted from the main-side spans
// they interrupt, so a render's cost is its own. The marks are real bus writes
// (~20 cycles each): a function called thousands of times a frame reads a
// little slow. Nothing here touches drv/ — the wrappers live in the scratch copy.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sgdkEnv, makeProject, runRom, dropProject } from "./sgdk-project.mjs";
import { readProbe } from "./probe-analysis.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 20));
const KEEP = argv.includes("--keep");
const score = argv.find((a) => a.endsWith(".mmlisp")) ?? join(drv, "sgdk", "example", "demo.mmlisp");
const FRAME = 896040;   // master clocks in an NTSC frame
const IRQ = new Set(["pump"]);
// The host's own path only: encode_slot and mmlp_slot serve the byte-slot path
// the gates' harnesses use, and an SGDK build never reaches them.
const DEFAULT_FNS = [
  "mmlp_render", "run_frame", "dispatch", "note_on", "voice_set", "param_set_ex", "recompose_carriers",
  "fnum_block_for", "psg_period_for", "process_macros", "pcm_note_on", "mmlp_plan", "pump",
];
const pcAt = argv.indexOf("--pc");
const PC_PERIOD = pcAt >= 0 ? (Number(argv[pcAt + 1]) || 1000) : 0;
const fns = (arg("fn", "") || DEFAULT_FNS.join(",")).split(",").filter(Boolean);
if (fns.length > 31) { console.error("sgdk-profile: at most 31 functions"); process.exit(2); }
const ID = new Map(fns.map((f, i) => [f, 0x40 + 2 * i]));   // entry id; exit = id + 1

// ── the wrappers ──────────────────────────────────────────────────────────
const MARK = (v) => `*(volatile unsigned char*)0xA130F1 = 0x${v.toString(16)};`;
function argNames(params) {
  const p = params.trim();
  if (!p || p === "void") return "";
  return p.split(",").map((x) => x.trim().replace(/\[.*\]$/, "").match(/([A-Za-z_]\w*)\s*$/)[1]).join(", ");
}
function wrapIn(text, name) {
  // A definition at column 0: [static] [inline] <type> name(<params>) {
  const re = new RegExp(`^((?:static\\s+)?(?:inline\\s+)?)([A-Za-z_][\\w\\s\\*]*?)\\b${name}\\(([^)]*)\\)\\s*\\{`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const end = text.indexOf("\n}\n", m.index) + 3;
  const [, quals, ret, params] = m;
  const rt = ret.trim();
  const raw = `static ${rt} ${name}__raw(${params})`;
  const def = text.slice(m.index, end).replace(m[0], `${raw} {`);
  const id = ID.get(name);
  const call = `${name}__raw(${argNames(params)})`;
  const wrapper = rt === "void"
    ? `${quals}${rt} ${name}(${params}) { ${MARK(id)} ${call}; ${MARK(id + 1)} }\n`
    : `${quals}${rt} ${name}(${params}) { ${MARK(id)} ${rt} r__ = ${call}; ${MARK(id + 1)} return r__; }\n`;
  return text.slice(0, m.index) + def + wrapper + text.slice(end);
}
function patch(proj) {
  const src = join(proj, "src");
  const files = readdirSync(src).filter((f) => /^(mmlispseq|mmlpairs|mmlispdrv)\.c$/.test(f));
  const found = new Set();
  for (const f of files) {
    let t = readFileSync(join(src, f), "utf8");
    for (const name of fns) {
      if (found.has(name)) continue;
      const w = wrapIn(t, name);
      if (w) { t = w; found.add(name); }
    }
    writeFileSync(join(src, f), t);
  }
  const missing = fns.filter((f) => !found.has(f));
  if (missing.length) { console.error(`sgdk-profile: no definition found for ${missing.join(", ")}`); process.exit(2); }
}

// ── build, run ────────────────────────────────────────────────────────────
const E = sgdkEnv("sgdk-profile");
if (PC_PERIOD) { pcProfile(); process.exit(0); }
let built;
try { built = makeProject(E, score, { patch }); }
catch (e) { console.error(e.output ?? e.message); if (e.proj && !KEEP) dropProject(e.proj); process.exit(1); }
const outDir = join(drv, "out", "sgdk-profile");
mkdirSync(outDir, { recursive: true });
const tag = basename(score, ".mmlisp");
const log = join(outDir, `${tag}-${SECONDS}s.log`);
runRom(E, built.rom, { seconds: SECONDS, log });
if (!KEEP) dropProject(built.proj);

// ── the spans ─────────────────────────────────────────────────────────────
const L = readProbe(readFileSync(log));
const byId = new Map(fns.map((f) => [ID.get(f), f]));
const open = new Map();          // name -> stack of entry times
const spans = [];                // { name, t0, t1 }
for (const e of L.marks) {
  const v = e.value & 0xff;
  if (v < 0x40 || v > 0x7e) continue;
  const name = byId.get(v & ~1);
  if (!name) continue;
  if (!(v & 1)) { if (!open.has(name)) open.set(name, []); open.get(name).push(e.time); continue; }
  const st = open.get(name);
  if (st?.length) spans.push({ name, t0: st.pop(), t1: e.time });
}
// Interrupt time inside each main-side span, subtracted.
const irq = spans.filter((s) => IRQ.has(s.name)).sort((a, b) => a.t0 - b.t0);
function irqInside(t0, t1) {
  let lo = 0, hi = irq.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (irq[mid].t1 <= t0) lo = mid + 1; else hi = mid; }
  let sum = 0;
  for (let i = lo; i < irq.length && irq[i].t0 < t1; i++) sum += Math.max(0, Math.min(t1, irq[i].t1) - Math.max(t0, irq[i].t0));
  return sum;
}
// A span wholly inside an interrupt (the planner under the pump) is interrupt
// time itself and keeps its whole length.
for (const s of spans) {
  const len = s.t1 - s.t0, inIrq = irqInside(s.t0, s.t1);
  s.cost = IRQ.has(s.name) || inIrq >= len ? len : len - inIrq;
}

// SELF time: a span's cost less the cost of the wrapped spans directly inside
// it (same side of the interrupt line).
{
  const main = spans.filter((s) => !(IRQ.has(s.name) || s.cost === s.t1 - s.t0 && irqInside(s.t0, s.t1) > 0))
    .sort((a, b) => a.t0 - b.t0 || b.t1 - a.t1);
  const stack = [];
  for (const s of main) {
    while (stack.length && stack.at(-1).t1 <= s.t0) stack.pop();
    s.self = s.cost;
    if (stack.length) stack.at(-1).self -= s.cost;
    stack.push(s);
  }
  for (const s of spans) if (s.self === undefined) s.self = s.cost;
}
// A frame is one mmlp_render (the SGDK host's path) or, profiling an older
// host, one mml_render_frame.
const FRAME_FN = spans.some((s) => s.name === "mmlp_render") ? "mmlp_render" : "mml_render_frame";
const renders = spans.filter((s) => s.name === FRAME_FN).sort((a, b) => a.t0 - b.t0);
const t0 = renders[0]?.t0 ?? 0, t1 = renders.at(-1)?.t1 ?? 1;
const frames = Math.max(1, renders.length);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const rows = [];
for (const name of fns) {
  const c = spans.filter((s) => s.name === name && s.t0 >= t0 && s.t1 <= t1).map((s) => s.cost).sort((a, b) => a - b);
  if (!c.length) { rows.push({ name, calls: 0 }); continue; }
  const sum = c.reduce((a, b) => a + b, 0);
  const self = spans.filter((s) => s.name === name && s.t0 >= t0 && s.t1 <= t1).reduce((a, s) => a + s.self, 0);
  rows.push({ name, calls: c.length, perFrame: c.length / frames, p50: q(c, 0.5), p99: q(c, 0.99), max: c.at(-1),
    mean: Math.round(sum / c.length), share: sum / (t1 - t0), selfShare: self / (t1 - t0) });
}
const pad = (x, n) => String(x).padStart(n);
console.log(`sgdk-profile  ${tag}: ${SECONDS}s, ${frames} renders · master clocks per call · share = of all 68000 time`);
console.log(`  ${"function".padEnd(20)} ${pad("calls", 7)} ${pad("/frame", 7)} ${pad("p50", 8)} ${pad("p99", 8)} ${pad("max", 8)} ${pad("share", 7)} ${pad("self", 7)}`);
for (const r of rows) {
  if (!r.calls) { console.log(`  ${r.name.padEnd(20)} ${pad(0, 7)}`); continue; }
  console.log(`  ${r.name.padEnd(20)} ${pad(r.calls, 7)} ${pad(r.perFrame.toFixed(2), 7)} ${pad(r.p50, 8)} ${pad(r.p99, 8)} ${pad(r.max, 8)} ${pad((100 * r.share).toFixed(1) + "%", 7)} ${pad((100 * r.selfShare).toFixed(1) + "%", 7)}`);
}
const rc = renders.map((s) => s.cost);
const over = rc.filter((c) => c > FRAME).length;
const sorted = [...rc].sort((a, b) => a - b);
console.log(`  render: p50 ${(100 * q(sorted, 0.5) / FRAME).toFixed(1)}% · p99 ${(100 * q(sorted, 0.99) / FRAME).toFixed(1)}% · max ${(100 * sorted.at(-1) / FRAME).toFixed(1)}% of a frame · ${over} renders over one frame`);
// The worst renders, taken apart.
const worst = renders.map((s, i) => ({ s, i })).sort((a, b) => b.s.cost - a.s.cost).slice(0, 5);
for (const { s, i } of worst) {
  const parts = {};
  for (const x of spans) if (x !== s && !IRQ.has(x.name) && x.t0 >= s.t0 && x.t1 <= s.t1 && x.name !== FRAME_FN)
    parts[x.name] = (parts[x.name] ?? 0) + x.cost;
  console.log(`  frame ${i}: ${(100 * s.cost / FRAME).toFixed(0)}% — ` + Object.entries(parts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(", "));
}
writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ score: tag, seconds: SECONDS, frames, rows, render: { p50: q(sorted, 0.5), p99: q(sorted, 0.99), max: sorted.at(-1), over } }, null, 2));

// ── --pc: the statistical profile ─────────────────────────────────────────
function pcProfile() {
  let built;
  // -g for the line table (it does not change the code gcc generates).
  const PEAK = Number(arg("peak", 0));
  const markRender = (proj) => {
    const f = join(proj, "src", "mmlpairs.c");
    const w = wrapIn(readFileSync(f, "utf8"), "mmlp_render");
    if (!w) { console.error("sgdk-profile: mmlp_render not found"); process.exit(2); }
    writeFileSync(f, w);
  };
  if (PEAK) ID.set("mmlp_render", 0x40);
  try { built = makeProject(E, score, { flags: "-g", patch: PEAK ? markRender : undefined }); }
  catch (e) { console.error(e.output ?? e.message); if (e.proj && !KEEP) dropProject(e.proj); process.exit(1); }
  const outDir = join(drv, "out", "sgdk-profile");
  mkdirSync(outDir, { recursive: true });
  const tag = basename(score, ".mmlisp");
  const log = join(outDir, `${tag}-${SECONDS}s-pc.log`);
  runRom(E, built.rom, { seconds: SECONDS, log, env: { MMLISP_PROBE_PC: String(PC_PERIOD) } });
  const elf = [join(built.proj, "out", "release", "rom.out"), join(built.proj, "out", "rom.out")].find(existsSync);
  // The samples: a PCHI record then its PCLO. The first second (boot, upload,
  // the ready poll) is not the steady state and is left out.
  const buf = readFileSync(log);
  const counts = new Map();
  let hi = -1, n = 0, first = -1;
  // --peak: the render spans in the same log (its marks), the N most expensive.
  let windows = null;
  if (PEAK) {
    const spans = [];
    let open = -1;
    for (let i = 0; i + 8 <= buf.length; i += 8) {
      if (buf[i] !== 15) continue;
      const v = buf.readUInt16LE(i + 2) & 0xff, t = buf.readUInt32LE(i + 4);
      if (v === 0x40) open = t; else if (v === 0x41 && open >= 0) { spans.push([open, t]); open = -1; }
    }
    windows = spans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, PEAK).sort((a, b) => a[0] - b[0]);
    console.log(`  --peak: ${windows.length} renders of ${spans.length}, ${windows.map((w) => ((w[1] - w[0]) / FRAME * 100).toFixed(0) + "%").join(" ")}`);
  }
  const inWindow = (t) => {
    let lo = 0, hi2 = windows.length;
    while (lo < hi2) { const mid = (lo + hi2) >> 1; if (windows[mid][1] < t) lo = mid + 1; else hi2 = mid; }
    return lo < windows.length && windows[lo][0] <= t;
  };
  for (let i = 0; i + 8 <= buf.length; i += 8) {
    const kind = buf[i];
    if (kind === 24) { hi = buf.readUInt16LE(i + 2); continue; }
    if (kind !== 25 || hi < 0) continue;
    const t = buf.readUInt32LE(i + 4);
    if (first < 0) first = t;
    const pc = (hi << 16) | buf.readUInt16LE(i + 2);
    hi = -1;
    if (n++ < Math.round(53693175 / PC_PERIOD) && !PEAK) continue;   // skip ~1 s
    if (windows && !inWindow(t)) continue;
    counts.set(pc, (counts.get(pc) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  // Symbolize every distinct PC once: innermost inlined function and line.
  const pcs = [...counts.keys()];
  const bin = join(E.TOOLCHAIN, "m68k-elf-addr2line");
  const out = execFileSync(bin, ["-a", "-f", "-i", "-e", elf], { input: pcs.map((p) => "0x" + p.toString(16)).join("\n") + "\n", maxBuffer: 1 << 28 }).toString().split("\n");
  const where = new Map();
  let cur = null;
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    if (/^0x[0-9a-f]+$/.test(l)) { cur = { pc: parseInt(l, 16), frames: [] }; where.set(cur.pc, cur); continue; }
    if (!cur || !l) continue;
    cur.frames.push({ fn: l, line: (out[++i] ?? "").replace(/.*\//, "").replace(/ \(discriminator.*\)/, "") });
  }
  const byFn = new Map(), byLine = new Map(), byOuter = new Map();
  for (const [pc, c] of counts) {
    const w = where.get(pc)?.frames ?? [];
    const inner = w[0] ?? { fn: "??", line: "??" };
    const outer = w.at(-1) ?? inner;
    byFn.set(inner.fn, (byFn.get(inner.fn) ?? 0) + c);
    byLine.set(`${inner.fn}  ${inner.line}`, (byLine.get(`${inner.fn}  ${inner.line}`) ?? 0) + c);
    byOuter.set(outer.fn, (byOuter.get(outer.fn) ?? 0) + c);
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const pct = (c) => `${(100 * c / total).toFixed(1).padStart(5)}%`;
  console.log(`sgdk-profile --pc  ${tag}: ${SECONDS}s, ${total} samples every ${PC_PERIOD} master (first second left out)`);
  console.log("  by function (innermost, after inlining):");
  for (const [k, c] of top(byFn, 30)) console.log(`    ${pct(c)}  ${k}`);
  console.log("  by source line:");
  for (const [k, c] of top(byLine, 40)) console.log(`    ${pct(c)}  ${k}`);
  console.log("  by outermost function (what the call tree hangs off):");
  for (const [k, c] of top(byOuter, 12)) console.log(`    ${pct(c)}  ${k}`);
  writeFileSync(join(outDir, `${tag}-pc.json`), JSON.stringify({ score: tag, total, period: PC_PERIOD,
    byFn: top(byFn, 200), byLine: top(byLine, 400), byOuter: top(byOuter, 50) }, null, 2));
  if (!KEEP) dropProject(built.proj); else console.log(`  project kept at ${built.proj}`);
}
