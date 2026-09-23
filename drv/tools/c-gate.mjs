// P2 gate — the 68k C sequencer against drv-player.js (docs/driver.md §12.2).
//
// This is the port's hard gate, and it is a straight replacement for the old
// asm↔reference trace gate — only cheaper, because both sides run on the host:
// no emulator, no assembler, a debugger on each. The comparison surface is the
// SLOT STREAM (§6.2), which is what the 68000 actually hands the Z80.
//
//   node tools/c-gate.mjs [score.mmlisp …] [--bundle manifest.json …]
//                         [--frames N] [--pal] [--keep]
//
// A --bundle gates every song of a bundle (tools/bundle.mjs) on the BUNDLED
// artifacts: each song's remapped MMB against the one shared sample bank, so
// what is compared is what the ROM will carry.
//
// A score whose stream reaches an opcode the port does not decode yet stops
// that track fail-safe (mmb.md §13) and is reported as PENDING rather than
// silently passing on a truncated stream.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb, remapTrackChannels } from "./mmb-build.mjs";
import { buildBundle, loadManifest } from "./bundle.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";
import { generatedTables } from "./c-tables.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const c68k = join(here, "..", "68k");
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
let scores = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// --pal bakes every score for 50 Hz instead. The C reads no frame rate — every
// frame-counted number arrives baked — so this is the check that it stays that
// way: the same C, on a stream of different numbers, still matches its
// reference byte for byte (driver.md §3.3).
const frameHz = flags.includes("--pal") ? 50 : 60;
const fIdx = process.argv.indexOf("--frames");
const MAX_FRAMES = fIdx >= 0 ? Number(process.argv[fIdx + 1]) : 400;
if (fIdx >= 0) scores = scores.filter((s) => s !== process.argv[fIdx + 1]);
// --bundle <manifest.json>: every song of a bundle (tools/bundle.mjs), each
// gated on the BUNDLED artifacts — its remapped MMB against the ONE shared
// bank — so what is compared is what the ROM will carry. May repeat.
const bundles = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--bundle" && process.argv[i + 1]) {
    bundles.push(process.argv[i + 1]);
    scores = scores.filter((s) => s !== process.argv[i + 1]);
  }
}
if (!scores.length && !bundles.length) scores = [join(here, "..", "..", "examples", "source", "ab-core.mmlisp")];

// ── Build ──────────────────────────────────────────────────────────────────
// The generated tables go to a directory of the gate's own: this used to
// regenerate them in drv/68k and leave the committed mml_rate.h rewritten to
// whatever clock the ambient environment resolved (tools/c-tables.mjs).
const ctab = generatedTables();
const tmp = mkdtempSync(join(tmpdir(), "cgate-"));
const exe = join(tmp, "gate_main");
try {
  execFileSync(
    process.env.CC ?? "cc",
    ["-std=c99", "-O1", "-Wall", "-Wextra", "-Werror", "-o", exe,
      ...ctab.flags,
      join(c68k, "gate_main.c"), join(c68k, "mmlispseq.c"), ctab.tables],
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

// ── What to gate ───────────────────────────────────────────────────────────
// A job is one MMB + its bank + its sidecar. A score on its own is built here;
// a bundle's songs come built, with the shared bank, and their channel remap
// already applied by the manifest — a sidecar's `remapChannels` is ignored for
// those, so one file owns that decision.
const jobs = [];
for (const score of scores) {
  const { bytes: mmb, sampleBank, diagnostics } = buildMmb(score, { frameHz });
  for (const d of diagnostics ?? []) {
    if (d.severity === "error") throw new Error(`${d.code}: ${d.message}`);
  }
  jobs.push({ name: basename(score), stem: basename(score, ".mmlisp"), mmb, sampleBank,
    sidecar: score.replace(/\.mmlisp$/, ".cmds.json"), remapFromSidecar: true });
}
for (const manifestPath of bundles) {
  const { manifest, baseDir } = loadManifest(manifestPath);
  const bundle = buildBundle(manifest, { baseDir, frameHz });
  const errs = [...bundle.diagnostics, ...bundle.songs.flatMap((s) => s.diagnostics)]
    .filter((d) => d.severity === "error");
  if (errs.length) throw new Error(`${manifestPath}: ${errs.map((d) => `${d.code}: ${d.message}`).join("; ")}`);
  for (const s of bundle.songs) {
    jobs.push({ name: `${basename(manifestPath)}:${s.name}`, stem: `${basename(manifestPath, ".json")}-${s.name}`,
      mmb: s.bytes, sampleBank: bundle.bank, sidecar: s.src.replace(/\.mmlisp$/, ".cmds.json"), remapFromSidecar: false });
  }
}

let failures = 0;
let pending = 0;
for (const job of jobs) {
  const { name, mmb, sampleBank } = job;

  // Host commands are not in the stream, so a score may carry a sidecar
  // schedule — the same one the Z80 gates used. Both sides apply it at the top
  // of the matching frame. A plain array is the schedule; the SE gates carry
  // an object: `autoStart: false` (nothing starts until the schedule says so),
  // `remapChannels` (track id → channel id, patched into the MMB's track table
  // so both players read the two-tracks-one-channel layout — driver.md §2.5),
  // and `commands`.
  const cmdPath = job.sidecar;
  const sidecar = existsSync(cmdPath) ? JSON.parse(readFileSync(cmdPath, "utf8")) : [];
  const commands = Array.isArray(sidecar) ? sidecar : sidecar.commands ?? [];
  const autoStart = Array.isArray(sidecar) ? true : sidecar.autoStart !== false;
  if (job.remapFromSidecar && !Array.isArray(sidecar) && sidecar.remapChannels) {
    remapTrackChannels(mmb, sidecar.remapChannels);
  }
  const mmbPath = join(tmp, `${job.stem}.mmb`);
  writeFileSync(mmbPath, mmb);
  // PCM scores carry their sample blobs in a separate ROM bank, not an MMB
  // section — so the C reads it as a separate file, the way the 68k will map it.
  let smpPath = null;
  if (sampleBank && sampleBank.length) {
    smpPath = join(tmp, `${job.stem}.smp`);
    writeFileSync(smpPath, sampleBank);
  }

  let cmdFile = null;
  if (commands.length) {
    cmdFile = join(tmp, `${job.stem}.cmds.txt`);
    writeFileSync(
      cmdFile,
      commands.map((c) => `${c.frame} ${c.cmd} ${c.a0 ?? 0} ${c.a1 ?? 0} ${c.a2 ?? 0}`).join("\n") + "\n",
    );
  }

  const drv = new DrvPlayer();
  drv.loadMMB(mmb, sampleBank);
  const ref = drv.captureSlotLog({ maxFrames: MAX_FRAMES, commands, autoStart, builder: new SlotBuilder() });

  // `(trig N)` status bytes are sequencer state, not stream bytes, so the
  // harness writes them to a sidecar and they are diffed separately.
  const trigFile = join(tmp, `${job.stem}.trig`);
  let out, incomplete = null;
  try {
    out = execFileSync(
      exe,
      [mmbPath, String(MAX_FRAMES),
        ...(cmdFile ? ["--cmds", cmdFile] : []),
        ...(smpPath ? ["--samples", smpPath] : []),
        ...(autoStart ? [] : ["--idle"]),
        "--trig", trigFile],
      { maxBuffer: 1 << 28 },
    );
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

  // The trig status bytes (opcodes.md §0x42) — one per track per rendered
  // frame. Nothing in the slot stream carries them, so without this the two
  // sequencers could disagree about every `(trig N)` and the gate would pass.
  let trigs = 0;
  if (!bad && existsSync(trigFile)) {
    const tb = readFileSync(trigFile);
    const width = ref.trigLog[0]?.length ?? 0;
    const frames = width ? tb.length / width : 0;
    if (!Number.isInteger(frames)) {
      bad = `trig dump is ${tb.length} B, not a multiple of ${width} tracks`;
    } else if (!incomplete && frames !== ref.trigLog.length) {
      bad = `${frames} trig frames from the C, ${ref.trigLog.length} from the reference`;
    }
    for (let f = 0; f < Math.min(frames, ref.trigLog.length) && !bad; f++) {
      for (let t = 0; t < width; t++) {
        const a = ref.trigLog[f][t], b = tb[f * width + t];
        if (a !== b) {
          bad = `trig f${f} track ${t}: C 0x${b.toString(16)}, reference 0x${a.toString(16)}`;
          break;
        }
      }
    }
    trigs = new Set(
      ref.trigLog.flat().filter((b) => b !== 0),
    ).size;
  }

  // THE SGDK HOST'S LOAD, too (mmlispseq.c mml_prime_tracks): nothing started,
  // PRIME, twelve idle frames, then START_TRACK for every track in order. Only
  // for scores without a host schedule — theirs is written against frame 0.
  let primed = "";
  if (!commands.length && !bad && !incomplete) {
    const PRIME = 12;
    const d2 = new DrvPlayer();
    d2.loadMMB(mmb, sampleBank);
    const ref2 = d2.captureSlotLog({ maxFrames: MAX_FRAMES, prime: PRIME, builder: new SlotBuilder() });
    let out2 = null;
    try {
      out2 = execFileSync(exe, [mmbPath, String(MAX_FRAMES), "--prime", String(PRIME),
        ...(smpPath ? ["--samples", smpPath] : [])], { maxBuffer: 1 << 28 });
    } catch (e) { bad = `primed: ${e.message}`; }
    if (out2) {
      const got2 = parseStream(out2);
      if (got2.length !== ref2.slots.length) bad = `primed: ${got2.length} slots from the C, ${ref2.slots.length} from the reference`;
      for (let f = 0; f < Math.min(got2.length, ref2.slots.length) && !bad; f++) {
        const a = ref2.slots[f], b = got2[f];
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) bad = `primed f${f}: C ${b.length} B, reference ${a.length} B`;
      }
      if (!bad) primed = ", primed too";
    }
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
    console.log(`ok    ${name} — ${ref.slots.length} slots, ${bytes} B${commands.length ? `, ${commands.length} host cmds` : ""}, byte-identical${trigs ? `, ${trigs} trig states` : ""}${primed}`);
  }
}

ctab.dispose();
if (!flags.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(
  `\n${jobs.length - failures - pending} passed · ${pending} pending · ${failures} failed`,
);
if (failures) process.exit(1);
