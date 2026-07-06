// The M1 asm bring-up gate (driver.md §12.4): assemble the driver, replay an
// MMB through the Z80 emulator, and diff the register-write trace against the
// JS reference driver — RAW equality, zero tolerance: same writes, same
// values, same frames, same order.
//
//   node verify.mjs <song.mmlisp> [--frames N] [--verbose]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { refTrace } from "./ref-trace.mjs";
import { assemble } from "./z80asm.mjs";
import { runTrace } from "./run-trace.mjs";
import { generateTables } from "./gen-tables.mjs";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

function fmtWrite(w) {
  if (!w) return "(none)";
  const p = w.port === 2 ? "psg" : `ym${w.port}`;
  return `f${w.frame} ${p} $${w.addr.toString(16).padStart(2, "0")} = $${w.data
    .toString(16)
    .padStart(2, "0")}`;
}

export function verify(songPath, { frames, verbose = false } = {}) {
  // 1. song → MMB
  const { bytes: mmb } = buildMmb(songPath);

  // 2. JS reference trace (also decides the frame horizon)
  const ref = refTrace(mmb, frames ? { maxFrames: frames } : {});
  const horizon = frames ?? ref.frames;

  // 3. regenerate tables + assemble
  writeFileSync(join(srcDir, "tables.z80"), generateTables());
  const { bytes: bin } = assemble(join(srcDir, "mmlispdrv.z80"));

  // 4. emulate
  const asm = runTrace(bin, mmb, { frames: horizon });

  // 5. raw diff
  const a = ref.writes.filter((w) => w.frame < horizon);
  const b = asm.writes;
  const mismatches = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const wa = a[i];
    const wb = b[i];
    if (
      wa &&
      wb &&
      wa.frame === wb.frame &&
      wa.port === wb.port &&
      wa.addr === wb.addr &&
      wa.data === wb.data
    ) {
      continue;
    }
    mismatches.push({ index: i, ref: wa, asm: wb });
    if (mismatches.length >= 40) break;
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    stats: {
      binBytes: bin.length,
      mmbBytes: mmb.length,
      frames: horizon,
      refWrites: a.length,
      asmWrites: b.length,
      refEnded: ref.ended,
      skippedOpcodes: ref.skippedOpcodes,
    },
    ref: a,
    asm: b,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const fIdx = args.indexOf("--frames");
  const frames = fIdx >= 0 ? Number(args.splice(fIdx, 2)[1]) : undefined;
  const verbose = args.includes("--verbose");
  const songPath = args.filter((x) => !x.startsWith("--"))[0];
  if (!songPath) {
    console.error("usage: node verify.mjs <song.mmlisp> [--frames N] [--verbose]");
    process.exit(2);
  }
  const r = verify(songPath, { frames, verbose });
  console.log(
    `driver ${r.stats.binBytes} B · mmb ${r.stats.mmbBytes} B · ` +
      `frames ${r.stats.frames} · ref ${r.stats.refWrites} writes · ` +
      `asm ${r.stats.asmWrites} writes`,
  );
  if (r.ok) {
    console.log("TRACE MATCH — 0 mismatches");
    process.exit(0);
  }
  console.log(`TRACE MISMATCH — ${r.mismatches.length}${r.mismatches.length >= 40 ? "+" : ""} diffs`);
  for (const m of r.mismatches.slice(0, 20)) {
    console.log(`  #${m.index}  ref ${fmtWrite(m.ref)}   asm ${fmtWrite(m.asm)}`);
  }
  if (verbose) {
    // dump surrounding context of the first mismatch
    const i = r.mismatches[0].index;
    console.log("\ncontext (ref | asm):");
    for (let k = Math.max(0, i - 5); k < i + 5; k++) {
      console.log(
        `  #${k}${k === i ? " *" : "  "} ${fmtWrite(r.ref[k]).padEnd(28)} | ${fmtWrite(r.asm[k])}`,
      );
    }
  }
  process.exit(1);
}
