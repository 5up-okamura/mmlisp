// The pair transport's host gate: 68k/mmlpairs.c against tools/pairs-model.mjs
// (R28 §63.6 step 4).
//
//   node tools/pairs-gate.mjs [score.mmlisp …] [--frames N]
//
// Both sides take the SAME slot stream — the sequencer's, rendered by gate_main
// exactly as the c-gate does — and turn it into what the 68000 would put on
// the wire: for every grab the destination and the pair bytes, and the PSG
// bytes released. A modelled engine advances its published index by 17 pairs a
// grab in both. The two streams have to be identical byte for byte; a
// disagreement names the score, the grab and the first byte.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { generatedTables } from "./c-tables.mjs";
import { buildEngine } from "./build-engine.mjs";
import { PairsModel, inTime, pairsCfgFromHeader } from "./pairs-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const c68k = join(here, "..", "68k");
const argv = process.argv.slice(2);
const fIdx = argv.indexOf("--frames");
const FRAMES = fIdx >= 0 ? Number(argv[fIdx + 1]) : 400;
let scores = argv.filter((a, i) => !a.startsWith("--") && !(fIdx >= 0 && i === fIdx + 1));
if (!scores.length) {
  // The c-gate's own list, from the one place it is defined.
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  scores = pkg.scripts["c-gate"].split(/\s+/).filter((a) => a.endsWith(".mmlisp")).map((s) => join(here, "..", s));
}

const { header: H } = buildEngine();
const cfg = pairsCfgFromHeader(H);
const ctab = generatedTables();
const tmp = mkdtempSync(join(tmpdir(), "pairsgate-"));
const gateExe = join(tmp, "gate_main"), pairsExe = join(tmp, "pairs_main");
try {
  execFileSync(process.env.CC ?? "cc", ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", gateExe,
    ...ctab.flags, join(c68k, "gate_main.c"), join(c68k, "mmlispseq.c"), ctab.tables], { stdio: "pipe" });
  execFileSync(process.env.CC ?? "cc", ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", pairsExe,
    ...ctab.flags, join(c68k, "pairs_main.c"), join(c68k, "mmlpairs.c")], { stdio: "pipe" });
} catch (e) {
  console.error(e.stderr?.toString() ?? e.message);
  console.error("FAIL: the C did not compile");
  process.exit(1);
}

const O = H.OPS;
const cArgs = [cfg.fifo, cfg.fifoPairs, cfg.pairsPerGrab, cfg.lutPage, cfg.levels, cfg.opLimit,
  O.IDLE, O.LEVEL, O.MASTER, O.SRC_LO, O.SRC_HI, O.END_LO, O.END_HI, O.STEP, O.START, O.STOP, O.PORT]
  .map(String);

/** The JS side: the same slots, the same modelled engine, the same records. */
function jsStream(slots) {
  const m = new PairsModel(cfg);
  const out = [];
  let consumer = 0, fifoLo = null, ngrab = 0;
  const grab = () => {
    const prev = fifoLo;
    const g = m.plan(prev);
    consumer = (consumer + (ngrab++ % 7 === 6 ? 41 : 17)) % cfg.fifoPairs;
    fifoLo = 2 * consumer;
    let bytes = g.bytes;
    if (bytes.length && !inTime(prev, g.dst, fifoLo)) { m.abort(); bytes = []; out.push(0x4c); }
    out.push(0x47, g.dst & 0xff, g.dst >> 8, bytes.length, ...bytes);
    const psg = m.psgTake(256);
    out.push(0x50, psg.length, ...psg);
  };
  for (const s of slots) { m.slot(s); grab(); grab(); }
  for (let g = 0; g < 4096 && m.pending; g++) grab();
  return { bytes: Uint8Array.from(out), model: m };
}

function parseSlots(buf) {
  const slots = [];
  for (let i = 0; i + 2 <= buf.length;) {
    const n = buf[i] | (buf[i + 1] << 8);
    i += 2;
    slots.push(buf.subarray(i, i + n));
    i += n;
  }
  return slots;
}

let failed = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const score of scores) {
  const name = basename(score, ".mmlisp");
  const { bytes, sampleBank } = buildMmb(score);
  const mmb = join(tmp, `${name}.mmb`);
  writeFileSync(mmb, bytes);
  const gateArgs = [mmb, String(FRAMES)];
  if (sampleBank) { const smp = join(tmp, `${name}.smp`); writeFileSync(smp, sampleBank); gateArgs.push("--samples", smp); }
  let slotsBuf;
  try { slotsBuf = execFileSync(gateExe, gateArgs, { maxBuffer: 1 << 26 }); }
  catch (e) { console.log(`FAIL  ${pad(name, 24)} gate_main: ${e.stderr?.toString().trim()}`); failed++; continue; }
  const slotsFile = join(tmp, `${name}.slots`);
  writeFileSync(slotsFile, slotsBuf);
  let cOut, cErr = "";
  try { cOut = execFileSync(pairsExe, [slotsFile, ...cArgs], { maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { console.log(`FAIL  ${pad(name, 24)} pairs_main: ${e.stderr?.toString().trim()}`); failed++; continue; }
  const js = jsStream(parseSlots(slotsBuf));
  let bad = -1;
  for (let i = 0; i < Math.max(cOut.length, js.bytes.length); i++)
    if (cOut[i] !== js.bytes[i]) { bad = i; break; }
  const m = js.model;
  const note = `${m.grabs} grabs (${m.late} late), ${m.pairsWritten} pairs, ${m.psg.length} psg left`
    + (m.droppedVoice ? `, ${m.droppedVoice} voice>0 dropped` : "")
    + (m.droppedLoop ? `, ${m.droppedLoop} loops ignored` : "")
    + (m.stepRounded ? `, ${m.stepRounded} steps rounded` : "")
    + (m.overflow ? `, ${m.overflow} OVERFLOW` : "");
  if (bad >= 0) {
    failed++;
    console.log(`FAIL  ${pad(name, 24)} C and JS differ at byte ${bad}: C ${cOut[bad]} JS ${js.bytes[bad]}`
      + ` (C ${cOut.length} B, JS ${js.bytes.length} B) — ${note}`);
  } else console.log(`ok    ${pad(name, 24)} ${cOut.length} B identical — ${note}`);
  void cErr;
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `FAIL: ${failed} of ${scores.length} scores` : `${scores.length} scores: C ≡ JS`);
process.exit(failed ? 1 : 0);
