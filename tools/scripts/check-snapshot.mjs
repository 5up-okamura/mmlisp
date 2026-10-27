#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Snapshot gate: the toolchain's output against its own earlier output.
//
// The driver's gates prove C ≡ drv-player and ir-player ≈ drv-player (within
// ab-compare's bands). Neither sees a change that moves both players the same
// way, or one inside the A/B bands (TL ±2, F-number ±1, ±1 frame). This gate
// does: for every score in the corpus it hashes what the toolchain produces —
//
//   ir    the compiled IR (compileMMLisp)
//   regs  the IR player's register log (IRPlayer.captureRegisterLog)
//   mmb   the MMB and its sample bank (encodeMmb)
//   vgm   File > Export > VGM's bytes (renderVgm, with the PCM)
//
// — each where the score's target has it (live/src/targets/): the MMB on a
// target with MMLispDRV, the register log and the VGM once its chips have
// encoders; a target still being built holds its IR and diagnostics, and
// gains the rest as they arrive (each a --update, after review). Fails when
// any hash moves. A refactor that must not change behavior
// keeps it green; a change that should, regenerates the baseline after review.
//
//   node scripts/check-snapshot.mjs              # check against the baseline
//   node scripts/check-snapshot.mjs --update     # regenerate (after review)
//   node scripts/check-snapshot.mjs --dump DIR   # write every output to DIR
//
// `--dump` before and after a change, then `diff -r`, shows what moved.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb, compileScoreFile } from "../../drv/tools/mmb-build.mjs";
import { targetProfile } from "../../live/src/targets.js";
import { bakedChipSamples } from "../../drv/tools/wav.mjs";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderVgm } from "../../live/src/export-vgm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE = join(ROOT, "tools", "snapshot-baseline.json");
const CALLER = process.cwd(); // --dump's directory is the caller's, not the root's
process.chdir(ROOT); // corpus paths are repo-relative, so the hashes are too

const hash = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16);

// The corpus: the driver's test scores on both video standards, the SGDK
// example with its effects, the examples, and the scores of the targets
// without a driver (tools/tests/<target>/). A score added to any of these
// directories joins the gate (and needs a --update).
function corpus() {
  const list = [];
  const dir = (d) => readdirSync(d).filter((f) => f.endsWith(".mmlisp")).sort().map((f) => join(d, f));
  for (const file of dir("drv/tests")) {
    list.push({ key: file, file });
    list.push({ key: `${file} @pal`, file, frameHz: 50 });
  }
  list.push({ key: "drv/sgdk/example/demo.mmlisp +se", file: "drv/sgdk/example/demo.mmlisp", seFile: "drv/sgdk/example/demo-se.mmlisp" });
  for (const file of dir("examples")) list.push({ key: file, file });
  for (const t of readdirSync("tools/tests", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort())
    for (const file of dir(join("tools/tests", t))) list.push({ key: file, file });
  return list;
}

// Every output of one score, as bytes/strings ready to hash or dump.
function outputs({ file, frameHz, seFile }) {
  const compiled = compileScoreFile(file, { frameHz, seFile });
  const target = targetProfile(compiled.ir?.metadata?.target);
  if (target.driver !== "mmlispdrv") {
    // No MMB; the IR and its diagnostics, and the rest once the chips encode.
    const { ir, diagnostics } = compiled;
    const out = { diagnostics: diagnostics.map((d) => d.code ?? d.message).join(","), ir: JSON.stringify(ir, null, 1) };
    if (!target.encodes || diagnostics.some((d) => d.severity === "error")) return out;
    // The chip's own sample RAM (the YM2608's ADPCM-B) or the samples as
    // frames (PCM8's, the PC Engine's DDA), baked as Live does.
    const { adpcm, frames } = bakedChipSamples(ir, target);
    const player = new IRPlayer(() => {});
    player.loadJSON(ir);
    player.setAdpcmBank(adpcm);
    player.setFrameBank(frames);
    const vgmPlayer = new IRPlayer(() => {});
    vgmPlayer.loadJSON(ir);
    const meta = { title: ir.metadata?.title, composer: ir.metadata?.composer, author: ir.metadata?.author };
    const pcm = adpcm ? { adpcm } : frames ? (target.hasPart("pcm8") ? { pcm8: frames } : { frames }) : null;
    return { ...out, regs: JSON.stringify(player.captureRegisterLog()), vgm: renderVgm(vgmPlayer, meta, pcm).bytes };
  }
  let built;
  try {
    built = buildMmb(file, { frameHz, seFile });
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
  const { ir, bytes, sampleBank, pcmEntryIds, diagnostics } = built;
  const player = new IRPlayer(() => {});
  player.loadJSON(ir);
  const regs = JSON.stringify(player.captureRegisterLog());

  const pcmVoices = ir.metadata?.pcmVoices ?? 0;
  const pcm = sampleBank?.length && pcmVoices
    ? { bank: sampleBank, entryIds: pcmEntryIds ?? {}, pcmVoices, frameHz: ir.metadata?.frameHz ?? 60 }
    : null;
  const vgmPlayer = new IRPlayer(() => {});
  vgmPlayer.loadJSON(ir);
  const meta = { title: ir.metadata?.title, composer: ir.metadata?.composer, author: ir.metadata?.author };
  const vgm = renderVgm(vgmPlayer, meta, pcm).bytes;

  return {
    diagnostics: diagnostics.map((d) => d.code ?? d.message).join(","),
    ir: JSON.stringify(ir, null, 1),
    regs,
    mmb: bytes,
    bank: sampleBank ?? new Uint8Array(0),
    vgm,
  };
}

function signature(out) {
  if (out.error) return { error: hash(out.error) };
  const sig = { diagnostics: hash(out.diagnostics), ir: hash(out.ir) };
  if (out.regs) sig.regs = hash(out.regs);
  if (out.mmb) sig.mmb = hash(Buffer.concat([Buffer.from(out.mmb), Buffer.from(out.bank)]));
  if (out.vgm) sig.vgm = hash(out.vgm);
  return sig;
}

const args = process.argv.slice(2);
const items = corpus();

const dumpAt = args.indexOf("--dump");
if (dumpAt >= 0) {
  const dir = args[dumpAt + 1] && resolve(CALLER, args[dumpAt + 1]);
  if (!dir) {
    console.error("check-snapshot: --dump needs a directory");
    process.exit(2);
  }
  for (const item of items) {
    const out = outputs(item);
    const base = join(dir, item.key.replace(/[ /@+]+/g, "_"));
    mkdirSync(dirname(base), { recursive: true });
    if (out.error) {
      writeFileSync(`${base}.error.txt`, out.error + "\n");
      continue;
    }
    writeFileSync(`${base}.diagnostics.txt`, out.diagnostics + "\n");
    writeFileSync(`${base}.ir.json`, out.ir + "\n");
    if (!out.regs) continue; // a target whose chips do not encode yet
    // One write per line, so `diff` points at the write that moved.
    const cap = JSON.parse(out.regs);
    const lines = [
      `loopStartSec ${cap.loopStartSec} endSec ${cap.endSec}`,
      ...cap.writes.map((w) => JSON.stringify(w)),
      ...(cap.pcmEvents ?? []).map((e) => "pcm " + JSON.stringify(e)),
    ];
    writeFileSync(`${base}.regs.txt`, lines.join("\n") + "\n");
    if (out.mmb) writeFileSync(`${base}.mmb`, out.mmb);
    if (out.bank?.length) writeFileSync(`${base}.bank`, out.bank);
    writeFileSync(`${base}.vgm`, out.vgm);
  }
  console.log(`check-snapshot: dumped ${items.length} scores to ${dir}`);
  process.exit(0);
}

if (args.includes("--update")) {
  const baseline = {};
  for (const item of items) baseline[item.key] = signature(outputs(item));
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + "\n");
  console.log(`check-snapshot: wrote the baseline for ${items.length} scores`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("check-snapshot: no baseline; run `npm run check:snapshot -- --update` first");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const unseen = new Set(Object.keys(baseline));
const failures = [];
for (const item of items) {
  unseen.delete(item.key);
  const want = baseline[item.key];
  if (!want) {
    failures.push(`${item.key}: not in the baseline`);
    continue;
  }
  const got = signature(outputs(item));
  const moved = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((k) => want[k] !== got[k]);
  if (moved.length) failures.push(`${item.key}: ${moved.join(", ")} changed`);
}
for (const key of unseen) failures.push(`${key}: in the baseline but no longer in the corpus`);

if (failures.length) {
  console.error(`check-snapshot: ${failures.length} of ${items.length} scores differ from the baseline\n`);
  for (const f of failures) console.error("  " + f);
  console.error("\nIf the change is intended, review it (--dump before and after, then diff -r) and run --update.");
  process.exit(1);
}
console.log(`check-snapshot: OK, ${items.length} scores match the baseline`);
