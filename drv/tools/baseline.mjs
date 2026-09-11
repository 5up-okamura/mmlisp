// P0 — freeze the comparison baseline (docs/dac-engine-implementation.md §5, P0).
//
//   node tools/baseline.mjs [--out out/baseline] [--quick] [--frames N]
//
// One command, one directory of evidence: WHAT was built (commit, config,
// hashes), WHAT the existing gates say about it right now, and WHAT the
// existing DAC instruments measure on a fixed case list. Nothing here changes
// the driver; it records the state a redesign is going to be compared against.
//
// Three rules this tool exists to enforce:
//
//   1. The gates are run INDEPENDENTLY, not chained with `&&`. `verify:all`
//      stops at the first failure, so a red gate early in the chain hides
//      every gate behind it — and one of them has been red for ~40 commits.
//   2. A gate's verdict is recorded VERBATIM. A baseline that reports what a
//      memory file said the gate used to do is not a baseline.
//   3. Every artifact that carries the sample clock is hashed and stamped, at
//      the configuration ACTUALLY in effect. The tools default to
//      TIMER_B_K = 16 while the committed mirrors are at 1, so "what was
//      measured" is not answerable from the commit alone.
//
// Value / time / bus are reported as three separate columns because they are
// three different faults with three different fixes (§1 of the instruction).
// Where an instrument cannot see one of them it says so rather than reporting
// a zero — the JS harnesses model no 68000 bus grab at all, so BUS is
// "not modelled here" and not "none".
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const root = join(drv, "..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const QUICK = argv.includes("--quick");
const FRAMES = Number(flag("frames", 240));
const OUT = join(drv, flag("out", "out/baseline"));

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const shaFile = (rel) => {
  const p = join(drv, rel);
  return existsSync(p) ? sha(readFileSync(p)) : null;
};
const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// ── 1. Identity ────────────────────────────────────────────────────────────
const identity = {
  when: new Date().toISOString(),
  commit: git(["rev-parse", "HEAD"]),
  subject: git(["log", "-1", "--format=%s"]),
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  dirty: git(["status", "--porcelain"]).split("\n").filter(Boolean),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};

// ── 2. Configuration actually in effect ────────────────────────────────────
// Imported, not re-derived: gen-mixer is the one place the clock is computed,
// and a second copy of that arithmetic here would be a second thing to keep
// right. The env knobs are recorded as SEEN, including their absence.
const gm = await import("./gen-mixer.mjs");
const mmb = await import("../../live/src/mmb.js");
const ENV_KNOBS = ["TIMER_B_K", "PCM_SPG", "PCM_TIMER", "PCM_VOICES", "PCM_RESERVE",
  "MMLISP_PACE", "MMLISP_EMIT_CY", "PAD_FRACTION", "MMLISP_RATE"];
const config = {
  env: Object.fromEntries(ENV_KNOBS.map((k) => [k, process.env[k] ?? null])),
  derived: {
    pcmTimer: gm.PCM_TIMER,
    timerBK: gm.TIMER_B_K,
    pcmGroup: gm.PCM_GROUP,
    sampleCycles: gm.SAMPLE_CYCLES,
    gateCycles: Number(gm.GATE_CY.toFixed(3)),
    rateHz: Number((3579545 / gm.GATE_CY * gm.PCM_GROUP).toFixed(2)),
    frameCycles: gm.FRAME_CYCLES,
    ringLead: mmb.PCM_RING_LEAD ?? null,
  },
};

// The five committed mirrors and what clock each one claims. rate-mirrors.mjs
// gates that they AGREE; this records what they say, whether or not they do.
const MIRRORS = ["src/mixer.z80", "src/rate.z80", "src/ask-dense.z80",
  "68k/mml_rate.h", "sgdk/mmlispdrv_bin.h"];
config.mirrors = MIRRORS.map((rel) => {
  const text = existsSync(join(drv, rel)) ? readFileSync(join(drv, rel), "utf8") : "";
  const m = /RATE-STAMP\s+(\d+)\s+(\d+)/.exec(text);
  return { file: rel, hz: m ? Number(m[1]) : null, lead: m ? Number(m[2]) : null, sha: shaFile(rel) };
});

// ── 3. Input hashes ────────────────────────────────────────────────────────
const HASHED = [
  "src/engine.z80", "src/mixer.z80", "src/rate.z80", "src/ask-dense.z80",
  "src/tables.z80", "tools/gen-mixer.mjs", "tools/z80asm.mjs", "tools/z80cpu.mjs",
  "68k/mmlispseq.c", "68k/mml_rate.h", "sgdk/mmlispdrv.c", "sgdk/mmlispdrv_bin.h",
  "../live/src/drv-player.js", "../live/src/mmb.js", "../live/src/export-mmb.js",
];
const hashes = Object.fromEntries(HASHED.map((rel) => [rel, shaFile(rel)]));

// The engine image itself, assembled here at the configuration above — the one
// artifact that is neither a source file nor committed in the form it runs in.
let engineImage = null;
try {
  const { buildEngine } = await import("./build-engine-ring.mjs");
  const built = buildEngine();
  engineImage = { bytes: built.bytes.length, sha: sha(built.bytes) };
} catch (e) {
  engineImage = { error: String(e.message ?? e).split("\n")[0] };
}

// ── 4. The gates, each on its own ──────────────────────────────────────────
const GATES = [
  ["mirrors", ["tools/rate-mirrors.mjs"]],
  ["selftest", ["tools/selftest.mjs"]],
  ["engine", ["tools/engine-gate.mjs"]],
  ["mixer", ["tools/mixer-bench.mjs"]],
  ["dac", ["tools/dac-gate.mjs"]],
  ["ring", ["tools/ring-gate.mjs"]],
  ["sgdk:lint", ["tools/sgdk-lint.mjs"]],
  ["ab", ["tools/ab-gate.mjs"]],
  ["slots:ab-core", ["tools/slot-gate.mjs", "../examples/source/ab-core.mmlisp", "--frames", "400"]],
  ["slots:pcm-softmix", ["tools/slot-gate.mjs", "tests/m3-pcm-softmix.mmlisp", "--frames", "300"]],
  ...(QUICK ? [] : [["c-gate", ["tools/c-gate.mjs", "../examples/source/ab-core.mmlisp",
    "tests/m3-pcm-softmix.mmlisp", "tests/m2-pcmloop.mmlisp", "--frames", "300"]]]),
];

const runGate = (args) => {
  const t0 = Date.now();
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, args, { cwd: drv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const lines = out.split("\n").filter((l) => l.trim());
  return {
    exit: code, seconds: +((Date.now() - t0) / 1000).toFixed(1),
    fails: lines.filter((l) => /^\s*(FAIL|not ok|\*\*\*)/.test(l)).length,
    summary: lines.slice(-3),
  };
};

const gates = [];
for (const [name, args] of GATES) {
  process.stderr.write(`  gate ${name} … `);
  const first = runGate(args);
  // A FAILING gate is run a second time on the same inputs. A baseline whose
  // numbers are not reproducible is not a baseline, and a gate that passes on
  // the retry is a DIFFERENT finding from one that fails twice — the mirrors
  // gate reads five files that half a dozen other tools write, so a concurrent
  // tool run can turn it red on its own. Recording both verdicts is what makes
  // the difference visible instead of arguing about it later.
  const retry = first.exit === 0 ? null : runGate(args);
  gates.push({
    name, cmd: `node ${args.join(" ")}`, ...first,
    retryExit: retry ? retry.exit : null,
    flaky: retry ? retry.exit !== first.exit : false,
  });
  process.stderr.write(`${first.exit === 0 ? "ok"
    : retry.exit === 0 ? `exit ${first.exit}, PASSED on retry — FLAKY` : `exit ${first.exit}`}\n`);
}

// ── 5. What the existing DAC instruments measure ───────────────────────────
// The four cases §5/P0 names: one note, two voices continuous, a volume
// change, and PCM together with FM. frame-budget is the only instrument here
// that reports the $2A INTERVAL, which is the clock; its own header says it
// cannot see the ring's regulator (no host calls mml_pcm_ring_fill), so its
// hole counts are recorded as what they are — a model with no restoring force.
const CASES = [
  ["one shot", "tests/m2-pcm.mmlisp"],
  ["two voices, continuous", "tests/m3-pcm-softmix.mmlisp"],
  ["volume change", "tests/m3-pcm-vol.mmlisp"],
  ["PCM with FM", "tests/m3-fm6-pcm.mmlisp"],
];
const parse = (text) => {
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  return {
    isrP50: num(/per ISR p50 (\d+)/),
    isrMax: num(/max (\d+) \(\d+%\)/),
    overVblankPct: num(/ISR past its own vblank: \d+\/\d+ \(([\d.]+)%\)/),
    dacSentPerFrame: num(/DAC SENT ([\d.]+) samples a frame/),
    dacSentPct: num(/samples a frame against [\d.]+ the clock owes — ([\d.]+)%/),
    intervalP50: num(/\$2A INTERVAL[^\n]*p50 (\d+)/),
    intervalP99: num(/\$2A INTERVAL[^\n]*p99 (\d+)/),
    intervalMax: num(/\$2A INTERVAL[^\n]*max (\d+)/),
    earlyPct: num(/([\d.]+)% arrive EARLY/),
    heldPct: num(/, ([\d.]+)% are HELD/),
    holesPerFrame: num(/holes past 3 periods: \d+ \(([\d.]+) a frame\)/),
    emptyAsksPerFrame: num(/found the ring EMPTY \(([\d.]+) a frame\)/),
    strayWrites: num(/— (\d+) emit writes? landed outside/),
  };
};
const dac = [];
for (const [what, score] of CASES) {
  process.stderr.write(`  measure ${what} … `);
  let text = "";
  try {
    text = execFileSync(process.execPath,
      ["tools/frame-budget.mjs", score, "--frames", String(FRAMES), "--asks"],
      { cwd: drv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const p = parse(text);
  dac.push({
    what, score,
    value: { strayWrites: p.strayWrites, note: "byte-level value equality is the engine/slot gates' job, not this instrument's" },
    time: {
      dacSentPerFrame: p.dacSentPerFrame, dacSentPct: p.dacSentPct,
      intervalP50: p.intervalP50, intervalP99: p.intervalP99, intervalMax: p.intervalMax,
      earlyPct: p.earlyPct, heldPct: p.heldPct,
      holesPerFrame: p.holesPerFrame, emptyAsksPerFrame: p.emptyAsksPerFrame,
      isrP50: p.isrP50, isrMax: p.isrMax, overVblankPct: p.overVblankPct,
    },
    bus: { note: "NOT MODELLED — this harness writes the slot into Z80 RAM as an array assignment; the 68000 never holds the bus" },
    raw: text.split("\n").filter((l) => l.trim()),
  });
  process.stderr.write("done\n");
}

// ── Write it out ───────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const report = { tool: "baseline", version: 1, identity, config, hashes, engineImage, gates, dac };
const stamp = `${identity.commit.slice(0, 8)}${identity.dirty.length ? "-dirty" : ""}`;
writeFileSync(join(OUT, `${stamp}.json`), JSON.stringify(report, null, 2));

const md = [];
md.push(`# DAC baseline — ${identity.commit.slice(0, 8)}${identity.dirty.length ? " (dirty)" : ""}`);
md.push("");
md.push(`\`${identity.subject}\` on \`${identity.branch}\`, ${identity.when}, node ${identity.node} on ${identity.platform}.`);
if (identity.dirty.length) md.push(`\nUncommitted: ${identity.dirty.map((l) => `\`${l.slice(3)}\``).join(", ")}`);
md.push("");
md.push(`Reproduce: \`${ENV_KNOBS.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join(" ")} node tools/baseline.mjs${QUICK ? " --quick" : ""}\``);
md.push("");
md.push("## Configuration in effect");
md.push("");
md.push(`Timer ${config.derived.pcmTimer}, K = ${config.derived.timerBK}, group ${config.derived.pcmGroup}, `
  + `sample ${config.derived.sampleCycles} cyc, gate ${config.derived.gateCycles} cyc, `
  + `**${config.derived.rateHz} Hz**, ring lead ${config.derived.ringLead}.`);
md.push("");
md.push("| mirror | Hz | lead | sha256/16 |");
md.push("| --- | --- | --- | --- |");
for (const m of config.mirrors) md.push(`| \`${m.file}\` | ${m.hz ?? "—"} | ${m.lead ?? "—"} | \`${m.sha ?? "—"}\` |`);
md.push("");
md.push(`Engine image: ${engineImage.bytes ?? "—"} B, \`${engineImage.sha ?? engineImage.error}\`.`);
md.push("");
md.push("## Gates, run independently");
md.push("");
md.push("| gate | exit | retry | FAIL lines | s | last line |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const g of gates)
  md.push(`| \`${g.name}\` | ${g.exit === 0 ? "ok" : `**${g.exit}**`}`
    + ` | ${g.retryExit === null ? "—" : g.retryExit === 0 ? "**passed — FLAKY**" : "same"}`
    + ` | ${g.fails} | ${g.seconds} | ${(g.summary.at(-1) ?? "").replace(/\|/g, "\\|")} |`);
md.push("");
md.push("## What the existing instruments measure");
md.push("");
md.push("`frame-budget.mjs --asks`. Value, time and bus are separate columns because they are separate faults.");
md.push("");
md.push("| case | sent/frame | % of clock | $2A p50 | p99 | max | early % | held % | holes/frame | empty asks/frame |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const d of dac) {
  const t = d.time;
  const c = (x) => (x === null || x === undefined ? "—" : x);
  md.push(`| ${d.what} | ${c(t.dacSentPerFrame)} | ${c(t.dacSentPct)} | ${c(t.intervalP50)} | ${c(t.intervalP99)} | ${c(t.intervalMax)} | ${c(t.earlyPct)} | ${c(t.heldPct)} | ${c(t.holesPerFrame)} | ${c(t.emptyAsksPerFrame)} |`);
}
md.push("");
md.push("- **VALUE** — stray writes outside the YM ports: "
  + dac.map((d) => `${d.what} ${d.value.strayWrites ?? "—"}`).join(", ")
  + ". Byte equality against the reference mixer is `engine`/`slots`, above.");
md.push("- **BUS** — not modelled by any harness in this repository. The 68000's grab is a real hole in the DAC's output and every number above excludes it.");
md.push("- The ring's regulator is dead in this instrument (no host calls `mml_pcm_ring_fill`), so its hole counts have no restoring force behind them. Use the BlastEm probe for anything the regulator touches.");
md.push("");
writeFileSync(join(OUT, `${stamp}.md`), md.join("\n"));

console.log(`\nbaseline → ${relative(root, join(OUT, `${stamp}.md`))}`);
console.log(`  ${gates.filter((g) => g.exit === 0).length}/${gates.length} gates green`
  + ` · ${config.derived.rateHz} Hz · engine ${engineImage.bytes ?? "?"} B`);
for (const g of gates.filter((g) => g.exit !== 0))
  console.log(`  ${g.flaky ? "FLAKY" : "FAIL "} ${g.name}: ${g.summary.at(-1) ?? ""}`);
