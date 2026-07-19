// The M1 asm bring-up gate (driver.md §12.4): assemble the driver, replay an
// MMB through the Z80 emulator, and diff the register-write trace against the
// JS reference driver — RAW equality, zero tolerance: same writes, same
// values, same frames, same order.
//
//   node verify.mjs <song.mmlisp> [--frames N] [--verbose]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { refTrace } from "./ref-trace.mjs";
import { runTrace } from "./run-trace.mjs";
import { buildDriver } from "./build-driver.mjs";

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
  // 1. song → MMB (+ the separate sample bank, plan-se.md — PCM blobs live in
  //    their own ROM bank the mixer latches, not inside the 32KB control MMB).
  const { bytes: mmb, sampleBank } = buildMmb(songPath);

  // Optional host mailbox schedule: a sidecar "<song>.cmds.json" holding
  // [{frame, cmd, a0, a1, a2}] injected into both players (M2 KEY_OFF /
  // SET_PARAM / FADE_TRACK, which are host-driven, not in the MMB stream).
  const cmdPath = songPath.replace(/\.mmlisp$/, ".cmds.json");
  const commands = existsSync(cmdPath)
    ? JSON.parse(readFileSync(cmdPath, "utf8"))
    : [];

  // 2. JS reference trace. `frames` caps how long it runs; the horizon is
  // where the reference actually ended (which may be earlier — e.g. a PCM
  // tail finishing — so the asm is run for exactly that many frames).
  const ref = refTrace(mmb, { maxFrames: frames ?? 36000, commands, sampleBank });
  const horizon = ref.frames;

  // 3. regenerate tables + assemble (resident + overlay ROM blob)
  const { resident, overlay, overlayBank, symbols } = buildDriver();

  // 4. emulate — the overlay blob rides ROM bank `overlayBank`; the PCM sample
  //    bank (if any) rides `sampleBankNumber`, latched by the mixer.
  const asm = runTrace(resident, mmb, {
    frames: horizon,
    commands,
    overlay: overlay.length ? overlay : null,
    overlayBank,
    sampleBank,
  });

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

  // Marker gate: MARKER / `(trig N)` has no register effect — it lands in the
  // track's 68k-readable status byte (MB_TSTAT). Diff the per-frame id bits of
  // both players at zero tolerance so trig sync points are actually verified.
  const markerMismatches = [];
  const ra = ref.markerLog ?? [];
  const ba = asm.markerLog ?? [];
  for (let f = 0; f < horizon; f++) {
    const rf = ra[f] ?? [];
    const bf = ba[f] ?? [];
    const t = Math.max(rf.length, bf.length);
    for (let k = 0; k < t; k++) {
      if ((rf[k] ?? 0) !== (bf[k] ?? 0)) {
        markerMismatches.push({ frame: f, track: k, ref: rf[k] ?? 0, asm: bf[k] ?? 0 });
        break;
      }
    }
    if (markerMismatches.length >= 40) break;
  }

  // Stack watermark: how deep this song drove the Z80 stack. STACK_TOP/
  // STACK_FLOOR bound the 82 B window; used = STACK_TOP − lowest-SP,
  // reserve = headroom left above the data region.
  const stackTop = symbols.get("STACK_TOP");
  const stackFloor = symbols.get("STACK_FLOOR");
  const stack = {
    used: stackTop - asm.stackMin,
    reserve: asm.stackMin - stackFloor,
    window: stackTop - stackFloor,
  };

  return {
    ok: mismatches.length === 0 && markerMismatches.length === 0,
    mismatches,
    markerMismatches,
    stats: {
      binBytes: resident.length + overlay.length,
      mmbBytes: mmb.length,
      frames: horizon,
      refWrites: a.length,
      asmWrites: b.length,
      refEnded: ref.ended,
      skippedOpcodes: ref.skippedOpcodes,
      stack,
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
  const s = r.stats.stack;
  console.log(
    `stack ${s.used} B used / ${s.window} B window · ${s.reserve} B reserve`,
  );
  if (r.ok) {
    console.log("TRACE MATCH — 0 mismatches");
    process.exit(0);
  }
  if (r.mismatches.length) {
    console.log(`TRACE MISMATCH — ${r.mismatches.length}${r.mismatches.length >= 40 ? "+" : ""} diffs`);
    for (const m of r.mismatches.slice(0, 20)) {
      console.log(`  #${m.index}  ref ${fmtWrite(m.ref)}   asm ${fmtWrite(m.asm)}`);
    }
  }
  if (r.markerMismatches.length) {
    console.log(`MARKER MISMATCH — ${r.markerMismatches.length}${r.markerMismatches.length >= 40 ? "+" : ""} diffs`);
    for (const m of r.markerMismatches.slice(0, 20)) {
      console.log(`  f${m.frame} track${m.track}: ref id ${m.ref}  asm id ${m.asm}`);
    }
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
