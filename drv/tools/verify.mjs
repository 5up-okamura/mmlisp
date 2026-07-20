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

// Patch TRACK_TABLE channel ids in place (SE gate channel remap). `remap` is
// {trackId: channelId}. Layout (mmb.md §6): section id 0x0001, payload = u16
// count then count × 5 B {trackId, channelId, flags, eventOffset u16}.
function remapMmbChannels(mmb, remap) {
  const u16 = (o) => mmb[o] | (mmb[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  const sectionCount = u16(8);
  const headerSize = u16(10);
  for (let i = 0; i < sectionCount; i++) {
    const at = headerSize + i * 12;
    if (u16(at) !== 0x0001) continue;
    const off = u32(at + 4);
    const count = u16(off);
    for (let t = 0; t < count; t++) {
      const e = off + 2 + t * 5;
      const want = remap[mmb[e]]; // keyed by trackId
      if (want != null) mmb[e + 1] = want & 0xff;
    }
    return;
  }
  throw new Error("remapChannels: MMB has no TRACK_TABLE");
}

export function verify(songPath, { frames, verbose = false } = {}) {
  // 1. song → MMB (+ the separate sample bank, plan-se.md — PCM blobs live in
  //    their own ROM bank the mixer latches, not inside the 32KB control MMB).
  const { bytes: mmb, sampleBank } = buildMmb(songPath);

  // Optional host mailbox schedule: a sidecar "<song>.cmds.json" injected into
  // both players (M2 KEY_OFF / SET_PARAM / FADE_TRACK, and the SE gate's
  // START_TRACK / START_SE — all host-driven, not in the MMB stream). Two
  // shapes: a bare [{frame, cmd, a0, a1, a2}] array (auto-start every track, the
  // default), or {autoStart, commands} where autoStart:false holds every track
  // idle so the schedule drives starts explicitly (plan-se.md SE gate).
  const cmdPath = songPath.replace(/\.mmlisp$/, ".cmds.json");
  const sidecar = existsSync(cmdPath)
    ? JSON.parse(readFileSync(cmdPath, "utf8"))
    : [];
  const commands = Array.isArray(sidecar) ? sidecar : (sidecar.commands ?? []);
  const autoStart = Array.isArray(sidecar) ? true : (sidecar.autoStart ?? true);
  // Channel remap (SE gate): reassign a track's channel id in the built MMB so
  // two tracks can share one physical channel — the layout the Step 3 bundler
  // will emit. {"<trackId>": <channelId>}. A stand-in until the bundler lands.
  const remapChannels = Array.isArray(sidecar) ? null : sidecar.remapChannels;
  if (remapChannels) remapMmbChannels(mmb, remapChannels);

  // 2. JS reference trace. `frames` caps how long it runs; the horizon is
  // where the reference actually ended (which may be earlier — e.g. a PCM
  // tail finishing — so the asm is run for exactly that many frames).
  const ref = refTrace(mmb, {
    maxFrames: frames ?? 36000,
    commands,
    sampleBank,
    autoStart,
  });
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
    autoStart,
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
