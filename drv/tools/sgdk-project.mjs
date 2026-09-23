// A scratch SGDK project with MMLispDRV installed, built, and run in the probe
// BlastEm — what tools/sgdk-gate.mjs grades and tools/sgdk-profile.mjs times.
//
// The environment is the one SGDK's own makefile expects: $GDK (default
// ~/Developer/gendev/SGDK), the m68k toolchain on PATH ($M68K_BIN, default
// ~/Developer/gendev/m68k-gcc-toolchain/bin), and the patched headless BlastEm
// from drv/blastem/setup.sh ($MMLISP_BLASTEM, default drv/out/blastem).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");

export function sgdkEnv(tool) {
  const GDK = process.env.GDK ?? join(homedir(), "Developer", "gendev", "SGDK");
  const TOOLCHAIN = process.env.M68K_BIN ?? join(homedir(), "Developer", "gendev", "m68k-gcc-toolchain", "bin");
  const BLAST = process.env.MMLISP_BLASTEM || join(drv, "out", "blastem");
  const core = ["blastem_libretro.dylib", "blastem_libretro.so"].map((f) => join(BLAST, f)).find(existsSync);
  const host = join(BLAST, "host");
  const fail = (m) => { console.error(`${tool}: ${m}`); process.exit(2); };
  if (!existsSync(join(GDK, "makefile.gen"))) fail(`no SGDK at ${GDK} (set GDK)`);
  if (!existsSync(join(TOOLCHAIN, "m68k-elf-gcc"))) fail(`no m68k-elf-gcc at ${TOOLCHAIN} (set M68K_BIN)`);
  if (!core || !existsSync(host)) fail("BlastEm is not built — sh drv/blastem/setup.sh");
  return { GDK, TOOLCHAIN, core, host, env: { ...process.env, GDK, PATH: `${TOOLCHAIN}:${join(GDK, "bin")}:${process.env.PATH}` } };
}

/** Make and build the example project for `score`. `patch(proj)` runs after
 *  the install and before make (the profiler injects its marks there).
 *  `remap` is install-sgdk's `track:channel,…`, which points a sound-effect
 *  track at the channel it steals — the caller's reference has to be given the
 *  same one or the two are of different music.
 *  Returns { proj, rom, sampleBank } or throws with the build's output. */
export function makeProject(E, score, { flags = "", patch, remap } = {}) {
  const proj = mkdtempSync(join(tmpdir(), "mmlisp-sgdk-"));
  for (const d of ["src", "inc", "res"]) mkdirSync(join(proj, d));
  writeFileSync(join(proj, "Makefile"), `GDK ?= ${E.GDK}\nrelease:\n\t$(MAKE) -f $(GDK)/makefile.gen\n`);
  // A rom header SGDK is happy with: the user's project has one, and so does the
  // scratch build if a template is beside this tool.
  const romHead = join(here, "sgdk-shim", "rom_header.c");
  if (existsSync(romHead)) copyFileSync(romHead, join(proj, "src", "rom_header.c"));
  execFileSync("node", [join(here, "install-sgdk.mjs"), proj, "--song", score, "--example",
    ...(remap ? ["--remap", remap] : [])], { stdio: "pipe" });
  if (patch) patch(proj);
  const { sampleBank } = buildMmb(score);
  const all = `-DMMLISP_AUTOPLAY=1 -DMMLISP_PCM_SAMPLES=${sampleBank ? 1 : 0} ${flags}`.trim();
  try {
    execFileSync("make", ["-f", join(E.GDK, "makefile.gen"), `EXTRA_FLAGS=${all}`], { cwd: proj, env: E.env, stdio: "pipe" });
  } catch (e) {
    const err = new Error("the SGDK build failed");
    err.output = `${e.stdout?.toString().slice(-3000) ?? ""}\n${e.stderr?.toString().slice(-3000) ?? ""}`;
    err.proj = proj;
    throw err;
  }
  return { proj, rom: join(proj, "out", "rom.bin"), sampleBank };
}

/** Run a ROM for `seconds` with the probe log (and optionally a WAV). */
export function runRom(E, rom, { seconds, log, wav, env = {} }) {
  rmSync(log, { force: true });
  const args = ["--core", E.core, "--rom", rom, "--frames", String(Math.round(seconds * 60))];
  if (wav) args.push("--wav", wav);
  try {
    execFileSync(E.host, args, { env: { ...process.env, ...env, MMLISP_PROBE_LOG: log }, stdio: ["ignore", "pipe", "pipe"],
      // A few seconds of emulation take a few seconds; minutes mean the core is
      // wedged, and the log up to there is still worth reading.
      timeout: 60000 + seconds * 15000, killSignal: "SIGKILL" });
    return true;
  } catch (e) {
    console.error(`BlastEm did not finish (${e.signal ?? e.status}) — reading the log it left`);
    return false;
  }
}

export function dropProject(proj) { rmSync(proj, { recursive: true, force: true }); }
