// P3 ring gate — the slot transport is a pipeline, not a filter.
//
// `mml_pump` (driver.md §6.6) is the half of MMLisp_frame that decides how many
// slots to render: eight lines of modular arithmetic that fail SILENTLY when
// they are wrong — a stalled ring reads as "the music stopped", a wrapped index
// as "the music got strange". So it gets its own gate.
//
// The check: run a score through gate_main twice — once calling
// mml_render_frame directly, once through the real ring with a model of the Z80
// consuming one slot per its own vblank — and require the two byte streams to
// be IDENTICAL. Every seventh host frame skips the call entirely, standing in
// for a game frame that overran; at depth N the ring absorbs N-1 of those
// (§3.4), so the stream must survive that too.
//
// gate_main also asserts §6.6's self-limiting property inside the loop: the
// call tops the ring up, so a second call in the same frame renders nothing.
//
//   node tools/ring-gate.mjs [score.mmlisp …] [--frames N] [--depths 2,3,4]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const c68k = join(here, "..", "68k");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const FRAMES = Number(opt("frames", 600));
const DEPTHS = String(opt("depths", "2,3,4,8")).split(",").map(Number);
let scores = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!scores.length) {
  // Scores that run well past FRAMES, so both modes emit the full count — and
  // between them cover a PCM voice retiring, a macro stepping and a long loop.
  scores = ["tests/m3-loop-gate.mmlisp", "tests/m3-pcm-slice.mmlisp",
            "../examples/source/demo1.mmlisp"].map((p) => join(here, "..", p));
}

const tmp = mkdtempSync(join(tmpdir(), "ringgate-"));
const exe = join(tmp, "gate_main");
try {
  execFileSync(process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", exe,
      join(c68k, "gate_main.c"), join(c68k, "mmlispseq.c"), join(c68k, "tables.c")],
    { stdio: "pipe" });
} catch (e) {
  console.error(e.stderr?.toString() ?? e.message);
  console.error("FAIL: the C did not compile");
  process.exit(1);
}

let failures = 0;
for (const score of scores) {
  const name = basename(score);
  const { bytes: mmb, sampleBank } = buildMmb(score);
  const mmbPath = join(tmp, name.replace(/\.mmlisp$/, ".mmb"));
  writeFileSync(mmbPath, mmb);
  let smpArgs = [];
  if (sampleBank?.length) {
    const p = join(tmp, name.replace(/\.mmlisp$/, ".smp"));
    writeFileSync(p, sampleBank);
    smpArgs = ["--samples", p];
  }
  const run = (extra) =>
    execFileSync(exe, [mmbPath, String(FRAMES), ...smpArgs, ...extra], { maxBuffer: 1 << 28 });

  const plain = run([]);
  for (const depth of DEPTHS) {
    let pumped;
    try {
      pumped = run(["--pump", String(depth)]);
    } catch (e) {
      console.log(`FAIL  ${name} depth ${depth} — ${(e.stderr ?? "").toString().trim() || e.message}`);
      failures++;
      continue;
    }
    // The plain run stops at the song's end; the pumped one emits exactly
    // FRAMES. Compare what both produced.
    const n = Math.min(plain.length, pumped.length);
    let bad = -1;
    for (let i = 0; i < n; i++) if (plain[i] !== pumped[i]) { bad = i; break; }
    if (bad >= 0) {
      console.log(`FAIL  ${name} depth ${depth} — byte ${bad}: plain 0x${plain[bad].toString(16)}, pumped 0x${pumped[bad].toString(16)}`);
      failures++;
    } else if (n < 64) {
      console.log(`FAIL  ${name} depth ${depth} — only ${n} B compared; raise --frames`);
      failures++;
    } else {
      console.log(`ok    ${name} depth ${depth} — ${n} B identical through the ring`);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} failed` : "ring transport clean"}`);
if (failures) process.exit(1);
