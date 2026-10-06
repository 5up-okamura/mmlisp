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
  { src: "mmlispdrv_banked_bin.h", dest: "inc/mmlispdrv_banked_bin.h", own: "driver" },
  { src: "mmlispdrv_bin.h", dest: "inc/mmlispdrv_bin.h", own: "driver" },
  { src: "../68k/mmlispseq.c", dest: "src/mmlispseq.c", own: "driver" },
  { src: "../68k/mmlispseq.h", dest: "inc/mmlispseq.h", own: "driver" },
  // mmlispseq.h includes this one, so it has to land beside it in inc/.
  // Leaving it out is not a link error, it is `#include "mml_rate.h"` failing
  // at mmlispseq.h:89 in a project that was building a moment earlier.
  { src: "../68k/mml_banked_rate.h", dest: "inc/mml_banked_rate.h", own: "driver" },
  { src: "../68k/mml_rate.h", dest: "inc/mml_rate.h", own: "driver" },
  { src: "../68k/tables.c", dest: "src/mmlispseq_tables.c", own: "driver" },
  // The slot -> pair converter (R28 §63.3 D7): portable C, gated on the host
  // against its JS twin (tools/pairs-gate.mjs), compiled into the game.
  { src: "../68k/mmlpairs.c", dest: "src/mmlpairs.c", own: "driver" },
  { src: "../68k/mmlpairs.h", dest: "inc/mmlpairs.h", own: "driver" },
  { src: "example/song.res", dest: "res/song.res", own: "seed" },
];

const USAGE = `usage: node tools/install-sgdk.mjs [<project-dir>] [options]

  <project-dir>          SGDK project root (default: $MMLISP_SGDK_PROJECT)

  --pal                 compile the score or bundle for PAL (50 Hz)
  --multibank           use banked PCM even when samples fit in 32 KiB (1–2 voices)
  --song <file.mmlisp>   compile the score into <project>/res/song.mmb
                         (plus song.smp when the score uses PCM samples)
  --se <file.mmlisp>     with --song: the game's effects (def-se) — the score
                         compiles as if it imported the file
  --bundle <manifest>    several scores against ONE sample bank (tools/bundle.mjs):
                         res/<name>.mmb per song and res/song.smp. Instead of
                         --song; the manifest's "se" gives every song the effects
  Both write inc/mmlisp_se.h: the score's def-se numbers, SE_<NAME>.
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
const opts = { build: true, dryRun: false, example: false, song: null, se: null, bundle: null };
let projectArg = process.env.MMLISP_SGDK_PROJECT ?? null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--song") {
    opts.song = argv[++i] ?? fail("--song needs a path");
  } else if (a === "--pal") {
    opts.frameHz = 50;
  } else if (a === "--multibank") {
    opts.multibank = true;
  } else if (a === "--se") {
    opts.se = argv[++i] ?? fail("--se needs a path");
  } else if (a === "--bundle") {
    opts.bundle = argv[++i] ?? fail("--bundle needs a manifest path");
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
if (opts.bundle && opts.song) fail("--bundle replaces --song: the manifest names the scores");
if (opts.se && !opts.song) fail("--se goes with --song; a bundle's manifest names its own \"se\"");
if (opts.se && !existsSync(opts.se)) fail(`no such effects file: ${opts.se}`);
if (opts.bundle && !existsSync(opts.bundle)) fail(`no such manifest: ${opts.bundle}`);

const dry = opts.dryRun ? "[dry-run] " : "";
console.log(`${dry}project: ${project}`);

// ---- regenerate the generated artifacts ----------------------------------
// mmlispdrv_bin.h is a build output of tools/emit-bin.mjs and 68k/tables.c one of
// live/src/ir-utils.js; copying either stale is the classic way to ship a
// driver that does not match the repo.
if (opts.build) {
  const { headerSource } = await import("./emit-bin.mjs");
  const text = headerSource();
  const headerPath = join(sgdkDir, "mmlispdrv_bin.h");
  const stale = readFileSync(headerPath, "utf8") !== text;
  if (stale) {
    if (opts.dryRun) {
      console.log(`${dry}sgdk/mmlispdrv_bin.h is stale — would regenerate the engine images`);
    } else {
      writeFileSync(headerPath, text);
      console.log("  engine images regenerated (sgdk/mmlispdrv_bin.h)");
    }
  } else {
    console.log("  engine images up to date");
  }
  const { bankedSources } = await import("./emit-banked.mjs");
  for (const [name, source] of bankedSources()) {
    const path = resolve(here, "../..", name);
    if (readFileSync(path, "utf8") !== source) {
      if (opts.dryRun) console.log(`${dry}${name} is stale — would regenerate`);
      else { writeFileSync(path, source); console.log(`  regenerated ${name}`); }
    }
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

let resState = null;  // how res/song.res fared — a seed we wrote is ours to amend
let mainState = null; // …and the same for src/main.c under --example
for (const f of plan) {
  const srcPath = join(sgdkDir, f.src);
  if (!existsSync(srcPath)) fail(`missing master file: ${relative(drvRoot, srcPath)}`);
  const state = install(srcPath, join(project, f.dest), f.own);
  if (f.dest === "res/song.res") resState = state;
  if (f.dest === "src/main.c") mainState = state;
  counts[state]++;
  const note = state === "kept" ? "  (yours — left alone)" : "";
  console.log(`${dry}  ${MARK[state]} ${f.dest}${note}`);
}

// ---- optional: compile the score ----------------------------------------
let smpPath = null;
let seList = []; // the score's effects (def-se), for inc/mmlisp_se.h
if (opts.song) {
  const { buildMmb, seListOf } = await import("./mmb-build.mjs");
  const { bytes, sampleBank, ir, diagnostics } = buildMmb(opts.song, { seFile: opts.se, multibank: opts.multibank, frameHz: opts.frameHz });
  // An export error is a score the driver cannot play as written (a note with
  // no baked sample plays whatever entry it falls back to). Refuse it, as a
  // bundle's errors are refused below, rather than install a ROM that sounds
  // wrong with the reason scrolled past.
  for (const d of diagnostics) console.warn(`    ${d.severity}: ${d.message}`);
  if (diagnostics.some((d) => d.severity === "error")) fail("the score has errors (above)");
  seList = seListOf(ir);
  const mmbPath = join(project, "res", "song.mmb");
  ensureDir(dirname(mmbPath));
  if (!opts.dryRun) writeFileSync(mmbPath, bytes);
  console.log(`${dry}  > res/song.mmb  ${bytes.length} B  (${opts.song})`);
  // Track ids are the declaration order — what MMLisp_startTrack takes.
  const chans = (ir.tracks ?? []).map((t, i) => `${i}:${t.channel}`).join(" ");
  const trackCount = ir.tracks?.length ?? 0;
  console.log(`    ${trackCount} tracks — ${chans}`);
  if (sampleBank?.length) {
    smpPath = join(project, "res", "song.smp");
    if (!opts.dryRun) writeFileSync(smpPath, sampleBank);
    console.log(`${dry}  > res/song.smp  ${sampleBank.length} B  (sample bank)`);
  }
}

// ---- optional: a bundle of scores over one bank -------------------------
let bundleRes = null; // the BIN lines the bundle needs
if (opts.bundle) {
  const { loadManifest, buildBundle, resLines, channelName } = await import("./bundle.mjs");
  const { manifest, baseDir } = loadManifest(opts.bundle);
  const bundle = buildBundle(opts.multibank ? { ...manifest, multibank: true } : manifest, { baseDir, frameHz: opts.frameHz });
  seList = bundle.se;
  // The seeded song.res declares "song.smp", and the uncommenting below keys
  // on that name; a manifest that renames the bank would leave the res
  // pointing at a file the build never writes. Rather than thread the name
  // through two rewrites, say so.
  const bankName = manifest.bank ?? "song.smp";
  if (bankName !== "song.smp") {
    fail(`--bundle: "bank": "${bankName}" — install-sgdk writes the bank as song.smp.` +
      ` Drop "bank" from the manifest, or run tools/bundle.mjs directly and copy the files.`);
  }
  ensureDir(join(project, "res"));
  for (const s of bundle.songs) {
    const out = join(project, "res", `${s.name}.mmb`);
    if (!opts.dryRun) writeFileSync(out, s.bytes);
    console.log(`${dry}  > res/${s.name}.mmb  ${s.bytes.length} B  (${relative(process.cwd(), s.src)})`);
    const chans = s.tracks.map((t) => `${t.id}:${channelName(t.channel)}`).join(" ");
    console.log(`    ${s.tracks.length} tracks — ${chans}`);
    for (const d of s.diagnostics) console.warn(`    ${d.severity}: ${d.message}`);
  }
  if (bundle.bank) {
    smpPath = join(project, "res", bankName);
    if (!opts.dryRun) writeFileSync(smpPath, bundle.bank);
    console.log(`${dry}  > res/${bankName}  ${bundle.entryCount} entries, ${bundle.blobBytes} B of blobs, ` +
      `${bundle.headroom} B of headroom — ONE bank for ${bundle.songs.length} songs, ` +
      `all on the ${bundle.pcmVoices}-voice image (a song change never reboots the Z80)`);
  }
  for (const d of bundle.diagnostics) console.warn(`    ${d.severity}: ${d.message}`);
  if ([...bundle.diagnostics, ...bundle.songs.flatMap((s) => s.diagnostics)].some((d) => d.severity === "error")) {
    fail("the bundle has errors (above)");
  }
  bundleRes = resLines(bundle, bankName);
  // A song.res this run seeded declares the single song; make it declare the
  // bundle's instead. A project-owned one is told what to add, below.
  const resPath = join(project, "res", "song.res");
  if (resState === "created" && existsSync(resPath)) {
    const res = readFileSync(resPath, "utf8").replace(
      /^\s*BIN\s+song_mmb\s+"song\.mmb".*$/m,
      bundleRes.filter((l) => !/song_smp/.test(l)).join("\n"),
    );
    if (!opts.dryRun) writeFileSync(resPath, res);
    console.log(`${dry}  ~ res/song.res  (declares the bundle's songs)`);
  }
}

// ---- the effects' numbers -------------------------------------------------
// Written on every install, empty for a score without effects, so a program
// can always `#include "mmlisp_se.h"` and test MMLISP_SE_COUNT.
{
  const { seHeader } = await import("./mmb-build.mjs");
  const out = join(project, "inc", "mmlisp_se.h");
  ensureDir(dirname(out));
  if (!opts.dryRun) writeFileSync(out, seHeader(seList));
  console.log(`${dry}  > inc/mmlisp_se.h  ${seList.length} effect${seList.length === 1 ? "" : "s"}` +
    (seList.length ? ` — ${seList.map((e, i) => `${i}:${e.name}`).join(" ")}` : ""));
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
  if (bundleRes) {
    const missing = bundleRes.filter((l) => !res.includes(l.split(" ")[1]));
    if (missing.length) {
      console.warn(`\nres/song.res is yours — add the bundle's resources to it:\n  ${missing.join("\n  ")}`);
    }
    // A bundle writes one .mmb per song and no res/song.mmb, so a line left
    // over from a single-score install now names a file that is not there —
    // and rescomp fails on a BIN whose file is missing.
    if (/^\s*BIN\s+\S+\s+"?song\.mmb/m.test(res) && !existsSync(join(project, "res", "song.mmb"))) {
      console.warn(`\nwarning: res/song.res still declares song.mmb, which this bundle does not` +
        ` write — remove that BIN line.`);
    }
  } else if (!/^\s*BIN\s+\S+\s+"?song\.mmb/m.test(res)) {
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
  // The same trap as the BIN line, one file over: example/main.c ships with
  // MMLISP_PCM_SAMPLES at 0, so MMLisp_setSampleBank() is never called and the
  // song plays FM and PSG with every drum missing — silently, and identically
  // to a driver bug. We already know the score has a bank; if we also WROTE the
  // main.c this run, it is ours to set, exactly as song.res is.
  let mainSet = false;
  const mainPath = join(project, "src", "main.c");
  if (mainState === "created" && existsSync(mainPath)) {
    const before = readFileSync(mainPath, "utf8");
    const after = before.replace(/^#define MMLISP_PCM_SAMPLES 0$/m,
      "#define MMLISP_PCM_SAMPLES 1   // set by install-sgdk: this score has a bank");
    if (after !== before) {
      if (!opts.dryRun) writeFileSync(mainPath, after);
      console.log(`${dry}  ~ src/main.c  (set MMLISP_PCM_SAMPLES 1)`);
      mainSet = true;
    }
  }
  console.warn(
    `\nnote: this score carries a PCM sample bank (res/song.smp).` +
      (hasSmpBin ? "" : `\n  - res/song.res: add   BIN song_smp "song.smp" 32768`) +
      (mainSet ? "" :
        `\n  - main.c: call MMLisp_setSampleBank(song_smp) after MMLisp_init()` +
        `\n    (REQUIRED — the BIN line alone leaves every PCM note dropped)`) +
      `\n  (drv/sgdk/README.md §PCM sample banks)`,
  );
}
if (bundleRes) {
  const names = bundleRes.filter((l) => /_mmb /.test(l)).map((l) => l.split(" ")[1]);
  console.log(
    `\nNext: include "song.h" (rescomp generates it from res/song.res). The bundle's songs are ` +
      `${names.join(", ")} — one MMLisp_loadScore each, the bank published once with ` +
      `MMLisp_setSampleBank(song_smp). example/main.c cycles them with\n` +
      `  make -f $GDK/makefile.gen EXTRA_FLAGS="-DMMLISP_PCM_SAMPLES=1 ` +
      `-DMMLISP_SONG_LIST=${names.join(",")}"`,
  );
} else console.log(
  `\nNext: include "song.h" (rescomp generates it from res/song.res), then` +
    ` MMLisp_init() → MMLisp_loadScore(song_mmb) → MMLisp_startSong(), effects with` +
    ` MMLisp_playSe(SE_<NAME>) from "mmlisp_se.h", and MMLisp_frame() once per vblank, last in your frame` +
    ` (driver.md §6.6). Then \`make\`.`,
);
