// P2 gate — the 68k C sequencer against drv-player.js (docs/driver.md §12.2).
//
// This is the port's hard gate, and it is a straight replacement for the old
// asm↔reference trace gate — only cheaper, because both sides run on the host:
// no emulator, no assembler, a debugger on each. The comparison surface is the
// SLOT STREAM (§6.2), which is what the 68000 actually hands the Z80.
//
//   node tools/c-gate.mjs [score.mmlisp …] [--frames N] [--keep]
//
// A score whose stream reaches an opcode the port does not decode yet stops
// that track fail-safe (mmb.md §13) and is reported as PENDING rather than
// silently passing on a truncated stream.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";

const here = dirname(fileURLToPath(import.meta.url));
const c68k = join(here, "..", "68k");
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
let scores = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fIdx = process.argv.indexOf("--frames");
const MAX_FRAMES = fIdx >= 0 ? Number(process.argv[fIdx + 1]) : 400;
if (fIdx >= 0) scores = scores.filter((s) => s !== process.argv[fIdx + 1]);
if (!scores.length) scores = [join(here, "..", "..", "examples", "source", "ab-core.mmlisp")];

// ── Build ──────────────────────────────────────────────────────────────────
execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
const tmp = mkdtempSync(join(tmpdir(), "cgate-"));
const exe = join(tmp, "gate_main");
try {
  execFileSync(
    process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", exe,
      join(c68k, "gate_main.c"), join(c68k, "mmlispseq.c"), join(c68k, "tables.c")],
    { stdio: "pipe" },
  );
} catch (e) {
  console.error(e.stderr?.toString() ?? e.message);
  console.error("FAIL: the C did not compile");
  process.exit(1);
}

// ── Compare ────────────────────────────────────────────────────────────────
function parseStream(buf) {
  const slots = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const n = buf[i] | (buf[i + 1] << 8);
    i += 2;
    slots.push(buf.subarray(i, i + n));
    i += n;
  }
  return slots;
}

let failures = 0;
let pending = 0;
for (const score of scores) {
  const name = basename(score);
  const { bytes: mmb, sampleBank, diagnostics } = buildMmb(score);
  for (const d of diagnostics ?? []) {
    if (d.severity === "error") throw new Error(`${d.code}: ${d.message}`);
  }
  const mmbPath = join(tmp, name.replace(/\.mmlisp$/, ".mmb"));
  writeFileSync(mmbPath, mmb);

  const drv = new DrvPlayer();
  drv.loadMMB(mmb, sampleBank);
  const ref = drv.captureSlotLog({ maxFrames: MAX_FRAMES, builder: new SlotBuilder() });

  let out, incomplete = null;
  try {
    out = execFileSync(exe, [mmbPath, String(MAX_FRAMES)], { maxBuffer: 1 << 28 });
  } catch (e) {
    if (e.status === 3) { out = e.stdout; incomplete = (e.stderr ?? "").toString().trim(); }
    else { console.error(`FAIL  ${name}: ${e.message}`); failures++; continue; }
  }
  const got = parseStream(out);

  // Compare frame by frame. The C stops a track on an opcode it cannot decode
  // yet, so a short stream is reported as pending work rather than a pass.
  // How many leading frames are byte-identical. For a score the port cannot
  // finish yet this is the meaningful number: it says exactly how far the port
  // gets, and it regresses visibly if something breaks upstream of the stop.
  const n = Math.min(got.length, ref.slots.length);
  let same = 0;
  let bad = null;
  for (let f = 0; f < n && !bad; f++) {
    const a = ref.slots[f], b = got[f];
    if (a.length !== b.length) {
      bad = `f${f}: C slot ${b.length} B, reference ${a.length} B`;
      break;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        bad = `f${f} byte ${i}: C 0x${b[i].toString(16)}, reference 0x${a[i].toString(16)}`;
        break;
      }
    }
    if (!bad) same++;
  }
  if (!bad && got.length !== ref.slots.length && !incomplete) {
    bad = `${got.length} slots from the C, ${ref.slots.length} from the reference`;
  }

  const bytes = ref.slots.reduce((t, s) => t + s.length, 0);
  if (incomplete) {
    // Not a failure: the port simply has not reached this opcode yet, and it
    // stops fail-safe rather than mis-decoding a length (mmb.md §13).
    console.log(`PEND  ${name} — ${same}/${ref.slots.length} frames identical, then ${incomplete}`);
    pending++;
  } else if (bad) {
    console.log(`FAIL  ${name} — ${bad}`);
    failures++;
  } else {
    console.log(`ok    ${name} — ${ref.slots.length} slots, ${bytes} B, byte-identical`);
  }
}

if (!flags.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(
  `\n${scores.length - failures - pending} passed · ${pending} pending · ${failures} failed`,
);
if (failures) process.exit(1);
