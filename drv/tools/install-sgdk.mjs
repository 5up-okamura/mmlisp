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
const FILES = [
  { src: "mmlispdrv.c", dest: "src/mmlispdrv.c", own: "driver" },
  { src: "mmlispdrv.h", dest: "inc/mmlispdrv.h", own: "driver" },
  { src: "mmlispdrv_bin.h", dest: "inc/mmlispdrv_bin.h", own: "driver" },
  { src: "mmlispdrv_ovl.bin", dest: "res/mmlispdrv_ovl.bin", own: "driver" },
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

// ---- regenerate the Z80 artifacts ----------------------------------------
// mmlispdrv_bin.h / mmlispdrv_ovl.bin are build outputs of src/*.z80; copying
// them stale is the classic way to ship a driver that does not match the repo.
if (opts.build) {
  const { buildDriver } = await import("./build-driver.mjs");
  const { resident, overlay } = buildDriver();
  const current = readFileSync(join(sgdkDir, "mmlispdrv.bin"));
  const stale =
    current.length !== resident.length || !current.equals(Buffer.from(resident));
  if (stale) {
    if (opts.dryRun) {
      console.log(
        `${dry}sgdk/ artifacts are stale (${current.length} → ${resident.length} B)` +
          ` — would run tools/emit-bin.mjs`,
      );
    } else {
      await import("./emit-bin.mjs"); // writes the four generated files
    }
  } else {
    console.log(`  driver image up to date (${resident.length} B + ${overlay.length} B overlay)`);
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

for (const f of plan) {
  const srcPath = join(sgdkDir, f.src);
  if (!existsSync(srcPath)) fail(`missing master file: ${relative(drvRoot, srcPath)}`);
  const state = install(srcPath, join(project, f.dest), f.own);
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
  console.log(`    ${ir.tracks?.length ?? 0} tracks — ${chans}`);
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

// The seeded song.res is the only place the two ROM blobs get their 32 KB
// alignment; a project-owned copy that predates a blob will not build.
const resPath = join(project, "res", "song.res");
if (counts.kept && existsSync(resPath)) {
  const res = readFileSync(resPath, "utf8");
  const missing = [
    ["song.mmb", /^\s*BIN\s+\S+\s+"?song\.mmb/m],
    ["mmlispdrv_ovl.bin", /^\s*BIN\s+\S+\s+"?mmlispdrv_ovl\.bin/m],
  ]
    .filter(([, re]) => !re.test(res))
    .map(([name]) => name);
  if (missing.length) {
    console.warn(
      `\nwarning: res/song.res declares no BIN for ${missing.join(", ")} —` +
        ` the Z80 reads both through its bank window and each needs align 32768` +
        ` (see drv/sgdk/README.md §banking).`,
    );
  }
}
if (smpPath) {
  console.warn(
    `\nnote: the score carries a PCM sample bank (res/song.smp), but the host` +
      ` glue does not publish G_SMP_BANK yet — add the BIN line and the bank` +
      ` publish before expecting sample playback (drv/sgdk/README.md).`,
  );
}
console.log(
  `\nNext: include "song.h" (rescomp generates it from res/song.res), call` +
    ` MMLisp_init(mmlisp_ovl) then MMLisp_startTrack(song_mmb, id, ...) — one` +
    ` per frame. Then \`make\`.`,
);
