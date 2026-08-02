// Install the MMLispDRV host files into an SGDK project.
//
//   node tools/install-sgdk.mjs <project-dir> [--song foo.mmlisp] [options]
//
// The repo is only the master copy — nothing propagates to a project on its
// own (drv/sgdk/README.md §Files). This copies the four driver-owned files into
// the SGDK layout, seeds `res/song.res` when the project has none, and can
// compile a score straight into `res/song.mmb`.
//
// Driver-owned files are always overwritten; user-owned files (song.res,
// main.c) are only ever created, never clobbered — `main.c` is the project's
// own program, not `example/main.c`.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const drvRoot = join(here, "..");
const sgdkDir = join(drvRoot, "sgdk");

// src (under drv/sgdk/) → dest (under the project) → who owns the file.
// "driver": regenerated/maintained here, overwritten on every install.
// "seed":   the project's to edit; written only when absent.
// Post-split the SEQUENCER is 68k code, so it is installed as source rather
// than uploaded as a blob: mmlispseq.c + its generated tables compile into the
// game. What crosses to the Z80 is only the engine image, which rides inside
// mmlispdrv_bin.h. There is no overlay blob any more.
const FILES = [
  { src: "mmlispdrv.c", dest: "src/mmlispdrv.c", own: "driver" },
  { src: "mmlispdrv.h", dest: "inc/mmlispdrv.h", own: "driver" },
  { src: "mmlispdrv_bin.h", dest: "inc/mmlispdrv_bin.h", own: "driver" },
  { src: "../68k/mmlispseq.c", dest: "src/mmlispseq.c", own: "driver" },
  { src: "../68k/mmlispseq.h", dest: "inc/mmlispseq.h", own: "driver" },
  { src: "../68k/tables.c", dest: "src/mmlispseq_tables.c", own: "driver" },
  { src: "example/song.res", dest: "res/song.res", own: "seed" },
];

const USAGE = `usage: node tools/install-sgdk.mjs [<project-dir>] [options]

  <project-dir>          SGDK project root (default: $MMLISP_SGDK_PROJECT)

  --song <file.mmlisp>   compile the score into <project>/res/song.mmb
                         (plus song.smp when the score uses PCM samples)
  --example              also seed src/main.c from example/main.c, if absent
  --no-build             skip the emit-bin.mjs regeneration step
  --dry-run              report what would change; write nothing
  -h, --help             this text
`;

function fail(msg) {
  console.error(`install-sgdk: ${msg}`);
  process.exit(2);
}

// ---- args -----------------------------------------------------------------
const opts = { build: true, dryRun: false, example: false, song: null };
let projectArg = process.env.MMLISP_SGDK_PROJECT ?? null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--song") {
    opts.song = argv[++i] ?? fail("--song needs a path");
  } else if (a === "--example") {
    opts.example = true;
  } else if (a === "--no-build") {
    opts.build = false;
  } else if (a === "--dry-run") {
    opts.dryRun = true;
  } else if (a.startsWith("-")) {
    fail(`unknown option ${a}\n\n${USAGE}`);
  } else if (projectArg === null || projectArg === process.env.MMLISP_SGDK_PROJECT) {
    projectArg = a; // a positional path wins over the env default
  } else {
    fail(`unexpected argument ${a}`);
  }
}
if (!projectArg) fail(`no project directory given\n\n${USAGE}`);

const project = resolve(projectArg.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
if (!existsSync(project) || !statSync(project).isDirectory()) {
  fail(`not a directory: ${project}`);
}
// An SGDK project builds through SGDK's makefile; without one this is almost
// certainly the wrong directory, and we are about to write into src/inc/res.
if (!["Makefile", "makefile", "GNUmakefile"].some((m) => existsSync(join(project, m)))) {
  fail(
    `${project} has no Makefile — SGDK projects build through one.\n` +
      `  Pass the project root (the directory holding src/, inc/, res/).`,
  );
}
if (opts.song && !existsSync(opts.song)) fail(`no such score: ${opts.song}`);

const dry = opts.dryRun ? "[dry-run] " : "";
console.log(`${dry}project: ${project}`);

// ---- regenerate the generated artifacts ----------------------------------
// mmlispdrv_bin.h is a build output of src/engine.z80 and 68k/tables.c one of
// live/src/ir-utils.js; copying either stale is the classic way to ship a
// driver that does not match the repo.
if (opts.build) {
  const { buildEngine } = await import("./build-engine.mjs");
  const { bytes } = buildEngine();
  const current = readFileSync(join(sgdkDir, "mmlispdrv.bin"));
  const stale = current.length !== bytes.length || !current.equals(Buffer.from(bytes));
  if (stale) {
    if (opts.dryRun) {
      console.log(
        `${dry}sgdk/ engine image is stale (${current.length} → ${bytes.length} B)` +
          ` — would run tools/emit-bin.mjs`,
      );
    } else {
      await import("./emit-bin.mjs");
    }
  } else {
    console.log(`  engine image up to date (${bytes.length} B, no overlay)`);
  }
  if (!opts.dryRun) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("node", [join(here, "gen-c-tables.mjs")], { stdio: "pipe" });
  }
}

// ---- copy ----------------------------------------------------------------
function ensureDir(dir) {
  if (existsSync(dir)) return;
  if (!opts.dryRun) mkdirSync(dir, { recursive: true });
  console.log(`${dry}  mkdir  ${relative(project, dir) || "."}/`);
}

// Returns "created" | "updated" | "unchanged" | "kept".
function install(srcPath, destPath, own) {
  const src = readFileSync(srcPath);
  const exists = existsSync(destPath);
  if (exists && own === "seed") return "kept";
  if (exists && src.equals(readFileSync(destPath))) return "unchanged";
  ensureDir(dirname(destPath));
  if (!opts.dryRun) copyFileSync(srcPath, destPath);
  return exists ? "updated" : "created";
}

const MARK = { created: "+", updated: "~", unchanged: "=", kept: "·" };
const counts = { created: 0, updated: 0, unchanged: 0, kept: 0 };
const plan = [...FILES];
if (opts.example) plan.push({ src: "example/main.c", dest: "src/main.c", own: "seed" });

let resState = null; // how res/song.res fared — a seed we wrote is ours to amend
for (const f of plan) {
  const srcPath = join(sgdkDir, f.src);
  if (!existsSync(srcPath)) fail(`missing master file: ${relative(drvRoot, srcPath)}`);
  const state = install(srcPath, join(project, f.dest), f.own);
  if (f.dest === "res/song.res") resState = state;
  counts[state]++;
  const note = state === "kept" ? "  (yours — left alone)" : "";
  console.log(`${dry}  ${MARK[state]} ${f.dest}${note}`);
}

// ---- optional: compile the score ----------------------------------------
let smpPath = null;
if (opts.song) {
  const { buildMmb } = await import("./mmb-build.mjs");
  const { bytes, sampleBank, ir, diagnostics } = buildMmb(opts.song);
  const mmbPath = join(project, "res", "song.mmb");
  ensureDir(dirname(mmbPath));
  if (!opts.dryRun) writeFileSync(mmbPath, bytes);
  console.log(`${dry}  > res/song.mmb  ${bytes.length} B  (${opts.song})`);
  // Track ids are the declaration order — what MMLisp_startTrack takes.
  const chans = (ir.tracks ?? []).map((t, i) => `${i}:${t.channel}`).join(" ");
  const trackCount = ir.tracks?.length ?? 0;
  console.log(`    ${trackCount} tracks — ${chans}`);
  // The one host-side way left to lose a track without any error: a TRACK_COUNT
  // that stops short of this list. The pre-split ceiling — a start burst deeper
  // than the mailbox ring — is gone with the mailbox: starts are plain calls
  // now, so a whole score can start in one frame however many tracks it has.
  if (sampleBank?.length) {
    smpPath = join(project, "res", "song.smp");
    if (!opts.dryRun) writeFileSync(smpPath, sampleBank);
    console.log(`${dry}  > res/song.smp  ${sampleBank.length} B  (sample bank)`);
  }
  for (const d of diagnostics) console.warn(`    ${d.severity}: ${d.message}`);
}

// ---- report --------------------------------------------------------------
const summary = Object.entries(counts)
  .filter(([, n]) => n)
  .map(([k, n]) => `${n} ${k}`)
  .join(", ");
console.log(`${dry}${summary}`);

// A project-owned song.res predating the split still declares the overlay blob
// that no longer exists — rescomp fails on a BIN whose file is missing, so say
// so rather than let `make` do it cryptically.
const resPath = join(project, "res", "song.res");
if (counts.kept && existsSync(resPath)) {
  const res = readFileSync(resPath, "utf8");
  if (!/^\s*BIN\s+\S+\s+"?song\.mmb/m.test(res)) {
    console.warn(`\nwarning: res/song.res declares no BIN for song.mmb.`);
  }
  if (/^\s*BIN\s+\S+\s+"?mmlispdrv_ovl\.bin/m.test(res)) {
    console.warn(
      `\nwarning: res/song.res still declares mmlispdrv_ovl.bin, which the` +
        ` post-split driver does not have — remove that BIN line, and drop the` +
        ` 32768 alignment on song.mmb while you are there (the 68000 reads the` +
        ` score directly now; only song.smp still goes through the Z80 window).`,
    );
  }
}
// A PCM score needs the sample bank declared as a BIN *and* published to the
// driver. The BIN line alone is the trap: rescomp puts song.smp in the ROM and
// declares the symbol, but G_SMP_BANK stays 0, so every PCM note is dropped and
// the song plays FM/PSG only. The seed ships the BIN line commented out (rescomp refuses a BIN
// whose file is missing), so uncomment it here now that song.smp exists — but
// only in a song.res this run created. A project-owned one is never rewritten;
// it just gets told. The bank publish is always the caller's own main.c.
if (smpPath) {
  let res = existsSync(resPath) ? readFileSync(resPath, "utf8") : "";
  let hasSmpBin = /^\s*BIN\s+\S+\s+"?song\.smp/m.test(res);
  const commented = /^#\s*(BIN\s+\S+\s+"?song\.smp.*)$/m;
  if (!hasSmpBin && resState === "created" && commented.test(res)) {
    res = res.replace(commented, "$1");
    if (!opts.dryRun) writeFileSync(resPath, res);
    console.log(`${dry}  ~ res/song.res  (enabled the song.smp BIN)`);
    hasSmpBin = true;
  }
  console.warn(
    `\nnote: this score carries a PCM sample bank (res/song.smp).` +
      (hasSmpBin ? "" : `\n  - res/song.res: add   BIN song_smp "song.smp" 32768`) +
      `\n  - main.c: call MMLisp_setSampleBank(song_smp) after MMLisp_init()` +
      `\n    (REQUIRED — the BIN line alone leaves every PCM note dropped)` +
      `\n  (drv/sgdk/README.md §PCM sample banks)`,
  );
}
console.log(
  `\nNext: include "song.h" (rescomp generates it from res/song.res), then` +
    ` MMLisp_init() → MMLisp_loadScore(song_mmb) → MMLisp_startTrack(id) per` +
    ` track, and MMLisp_frame() once per vblank, last in your frame` +
    ` (driver.md §6.6). Then \`make\`.`,
);
