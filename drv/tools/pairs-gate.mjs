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
import { MMLP_AHEAD_ONE, PairsModel, inTime, pairsCfgForImage } from "./pairs-model.mjs";
import { engineImage } from "../../live/src/engine-images.js";
import { headerPcmVoices } from "../../live/src/mmb.js";

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

const ctab = generatedTables();
const tmp = mkdtempSync(join(tmpdir(), "pairsgate-"));
const gateExe = join(tmp, "gate_main"), pairsExe = join(tmp, "pairs_main"), viewExe = join(tmp, "view_main");
try {
  execFileSync(process.env.CC ?? "cc", ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", gateExe,
    ...ctab.flags, join(c68k, "gate_main.c"), join(c68k, "mmlispseq.c"), ctab.tables], { stdio: "pipe" });
  execFileSync(process.env.CC ?? "cc", ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", pairsExe,
    ...ctab.flags, join(c68k, "pairs_main.c"), join(c68k, "mmlpairs.c"), join(c68k, "mmlispseq.c"), ctab.tables], { stdio: "pipe" });
  execFileSync(process.env.CC ?? "cc", ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", viewExe,
    ...ctab.flags, join(c68k, "view_main.c"), join(c68k, "mmlpairs.c"), join(c68k, "mmlispseq.c"), ctab.tables], { stdio: "pipe" });
} catch (e) {
  console.error(e.stderr?.toString() ?? e.message);
  console.error("FAIL: the C did not compile");
  process.exit(1);
}

/** The converter's configuration for a score: its engine image's (MMB header flags). */
const cfgOf = (mmb) => pairsCfgForImage(engineImage(headerPcmVoices(mmb[6] | (mmb[7] << 8))));
const cArgsOf = (cfg) => [cfg.fifo, cfg.fifoPairs, cfg.pairsPerGrab, cfg.lutPage, cfg.opStride, cfg.opPort,
  cfg.voices, cfg.idleAfterGen].map(String);

/** The JS side: the same slots, the same modelled engine, the same records. */
function jsStream(cfg, slots, lead = -1, pumps = 2) {
  const m = new PairsModel(pumps === 1 ? { ...cfg, ahead: MMLP_AHEAD_ONE } : cfg);
  const advance = pumps === 1 ? 34 : 17;
  const out = [];
  let consumer = 0, fifoLo = null, ngrab = 0;
  const grab = (release = m.framesIn) => {
    const prev = fifoLo;
    const g = m.plan(prev, release);
    consumer = (consumer + (ngrab++ % 7 === 6 ? advance + 24 : advance)) % cfg.fifoPairs;
    fifoLo = 2 * consumer;
    let bytes = g.bytes;
    if (bytes.length && !inTime(prev, g.dst, fifoLo)) { m.abort(); bytes = []; out.push(0x4c); }
    out.push(0x47, g.dst & 0xff, g.dst >> 8, bytes.length, ...bytes);
    const psg = m.psgTake(256, release);
    out.push(0x50, psg.length, ...psg);
  };
  if (lead < 0) for (const s of slots) { m.slot(s); for (let g = 0; g < pumps; g++) grab(); }
  else {
    // The SGDK host's schedule (pairs_main.c has the note): queue `lead`
    // frames ahead, then two grabs passing the frame count.
    let i = 0, release = 0;
    for (;;) {
      while (i < slots.length && m.framesIn < release + lead) m.slot(slots[i++]);
      release++;
      for (let g = 0; g < pumps; g++) grab(release);
      if (i >= slots.length && release >= m.framesIn) break;
    }
  }
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
  const cfg = cfgOf(bytes), cArgs = cArgsOf(cfg);
  const mmb = join(tmp, `${name}.mmb`);
  writeFileSync(mmb, bytes);
  const gateArgs = [mmb, String(FRAMES)];
  if (sampleBank) { const smp = join(tmp, `${name}.smp`); writeFileSync(smp, sampleBank); gateArgs.push("--samples", smp); }
  let slotsBuf;
  try { slotsBuf = execFileSync(gateExe, gateArgs, { maxBuffer: 1 << 26 }); }
  catch (e) { console.log(`FAIL  ${pad(name, 24)} gate_main: ${e.stderr?.toString().trim()}`); failed++; continue; }
  const slotsFile = join(tmp, `${name}.slots`);
  writeFileSync(slotsFile, slotsBuf);
  // Three schedules: every slot sent as soon as it is queued, and the SGDK
  // host's render-ahead of one and two frames with release by frame count.
  const parsed = parseSlots(slotsBuf);
  const rows = [];
  let scoreBad = false;
  let asap = null;
  for (const [lead, pumps] of [[-1, 2], [1, 2], [2, 2], [1, 1]]) {
    let cOut;
    try { cOut = execFileSync(pairsExe, [slotsFile, ...cArgs, String(lead), String(pumps)], { maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { rows.push(`pairs_main (lead ${lead}): ${e.stderr?.toString().trim()}`); scoreBad = true; continue; }
    const js = jsStream(cfg, parsed, lead, pumps);
    let bad = -1;
    for (let i = 0; i < Math.max(cOut.length, js.bytes.length); i++)
      if (cOut[i] !== js.bytes[i]) { bad = i; break; }
    const m = js.model;
    const tag = lead < 0 ? "asap" : pumps === 1 ? `one grab/frame` : `lead ${lead}`;
    // Rendering ahead must change nothing on the wire: with the same grabs, a
    // frame queued early still leaves on its own frame's grabs.
    if (lead < 0) asap = js.bytes;
    else if (pumps === 2 && Buffer.compare(Buffer.from(asap), Buffer.from(js.bytes)) !== 0) {
      scoreBad = true;
      rows.push(`${tag}: the wire differs from sending as soon as queued — a frame left before its time`);
    }
    if (bad >= 0) {
      scoreBad = true;
      rows.push(`${tag}: C and JS differ at byte ${bad}: C ${cOut[bad]} JS ${js.bytes[bad]} (C ${cOut.length} B, JS ${js.bytes.length} B)`);
    } else rows.push(`${tag} ${cOut.length} B` + (lead < 0 ? ` — ${m.grabs} grabs (${m.late} late), ${m.pairsWritten} pairs, ${m.psg.length} psg left`
      + (m.fault ? `, ${m.fault} FAULTS` : "")
      + (m.overflow ? `, ${m.overflow} OVERFLOW` : "") : ""));
  }
  // THE SGDK HOST'S PATH (mmlp_render, no slot bytes) against the slot path,
  // state for state, plain and primed at load.
  for (const prime of [-1, 12]) {
    const smpArgs = sampleBank ? ["--samples", join(tmp, `${name}.smp`)] : [];
    try {
      execFileSync(viewExe, [mmb, String(FRAMES), ...smpArgs, ...(prime >= 0 ? ["--prime", String(prime)] : []), ...cArgs], { stdio: "pipe" });
      rows.push(prime < 0 ? "view ≡ slot" : "primed");
    } catch (e) { scoreBad = true; rows.push(`view path: ${(e.stdout ?? "").toString().trim() || e.message}`); }
  }
  if (scoreBad) failed++;
  console.log(`${scoreBad ? "FAIL" : "ok  "}  ${pad(name, 24)} ${rows.join(" · ")}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `FAIL: ${failed} of ${scores.length} scores` : `${scores.length} scores: C ≡ JS`);
process.exit(failed ? 1 : 0);
