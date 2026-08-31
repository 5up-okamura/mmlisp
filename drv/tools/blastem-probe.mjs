// Run a score on an emulated Mega Drive and report what happened. One command,
// no display, no listening.
//
//   node tools/blastem-probe.mjs <score.mmlisp|score.mmb> [--seconds N] [--wav out.wav]
//
// It builds the probe ROM (tools/build-verify-rom.mjs), runs it in BlastEm's
// libretro core through drv/blastem/host.c, and prints the same four numbers the
// example program puts on screen — plus the YM2612's actual output as a .wav.
//
// WHY. Every gate in this repo has been green through bugs that a real machine
// found in minutes: a `di` longer than the VDP's interrupt pulse, a ring cursor
// that read the engine's own code as samples, a catch-up that compounded
// (plan-68k-split.md, 2026-08-29). They were invisible here because nothing here
// ran the actual program on the actual machine — the answer always came back
// through somebody building a ROM, flashing or launching it, and listening. This
// closes that loop: the machine's own verdict, in a file, in seconds.
//
// It does NOT replace the hardware round. BlastEm is a very good model and it is
// still a model; what this removes is the *iteration* on somebody's attention,
// not the final confirmation.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..");
const out = join(drv, "out");
const bl = join(out, "blastem");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const score = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!score) {
  console.error("usage: node tools/blastem-probe.mjs <score.mmlisp|score.mmb> [--seconds N] [--wav out.wav]");
  process.exit(2);
}
const seconds = Number(arg("--seconds", 10));
const frames = Math.round(seconds * 59.9227);
const wav = arg("--wav", join(out, "probe.wav"));

if (!existsSync(join(bl, "host")) || !existsSync(join(bl, "blastem_libretro.so"))) {
  console.error(`blastem-probe: no emulator built. Run:\n\n    sh ${join(drv, "blastem", "setup.sh")}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const rom = join(out, "verify-rom", "probe.md");
execFileSync("node", [join(here, "build-verify-rom.mjs"), score, "-o", rom],
  { stdio: "inherit", cwd: drv });
const meta = JSON.parse(readFileSync(rom.replace(/\.[^.]+$/, "") + ".json", "utf8"));

const res = execFileSync(join(bl, "host"), [
  "--core", join(bl, "blastem_libretro.so"),
  "--rom", rom,
  "--frames", String(frames),
  "--wav", wav,
  "--mailbox", String(meta.probeOffset),
  "--mailbox-words", String(meta.probeWords),
], { encoding: "utf8", maxBuffer: 1 << 26 });

// The core writes its own chatter to stderr; the mailbox is the last line of
// stdout and the only thing this reads.
const w = JSON.parse(res.trim().split("\n").pop());
const F = [
  "magic", "status", "fault", "fault_addr_hi", "fault_addr_lo",
  "fault_pc_hi", "fault_pc_lo", "stage", "seconds", "track_count",
  "vblanks", "audible", "music256", "host256", "worst_1s", "lost_1s",
  "starved", "starv_1s",
];
const m = Object.fromEntries(F.map((k, i) => [k, w[i] ?? 0]));
const hex = (v, n = 4) => "0x" + v.toString(16).padStart(n, "0");

console.log(`\nblastem-probe: ${basename(score)} — ${seconds}s`
  + ` · Timer ${meta.timer ?? "B"}, ${(53693175 / 7 / 144 / (meta.fmPerSample ?? 16 / meta.pcmSpg)).toFixed(0)} Hz`);

// Everything below is worthless if the program did not actually run, so say so
// first and say it unambiguously. A green `music` from a ROM that crashed
// before it started a track is the exact shape of wrong answer this whole
// exercise exists to stop producing.
if (m.magic !== 0x4d4c) {
  console.log("  DID NOT RUN — main() never reached (bad ROM, or the core refused it)");
  process.exit(1);
}
if (m.fault) {
  const addr = (m.fault_addr_hi << 16) | m.fault_addr_lo;
  const pc = (m.fault_pc_hi << 16) | m.fault_pc_lo;
  console.log(`  CRASHED — ${m.fault === 0xbadd ? "address/bus error" : "exception"}`
    + ` at PC ${hex(pc, 6)}, address ${hex(addr, 6)}, after stage ${m.stage}`);
  console.log("  (m68k-linux-gnu-objdump -d drv/out/verify-rom/probe.elf, and look up that PC)");
  process.exit(1);
}
if (!(m.status & 0x0002)) {
  console.log(`  DID NOT PLAY — status ${hex(m.status)}: `
    + (m.status & 0x8000 ? "the Z80 engine never became ready"
     : m.status & 0x4000 ? "the MMB was rejected"
     : `stopped at stage ${m.stage}`));
  process.exit(1);
}
if (!m.seconds) {
  console.log(`  NO WINDOW COMPLETED — ran ${frames} frames but never finished a second;`
    + " the 68000 side is stuck (stage " + m.stage + ")");
  process.exit(1);
}

const pc = (v) => `${hex(v)} (${(100 * v / 256).toFixed(1)}%)`;
console.log(`  tracks ${m.track_count}`
  + (m.status & 0x0004 ? "  · PCM MUTE: the score wants samples and none loaded" : ""));
console.log(`  music  ${pc(m.music256)}   worst 1s ${pc(m.worst_1s)}`);
console.log(`  host   ${pc(m.host256)}   ${m.audible} frames consumed in ${m.vblanks} vblanks`);
console.log(`  lost/s ${m.lost_1s}   starv ${m.starved} (${m.starv_1s}/s)`);
// The decision table from the example program, because this is read in a
// terminal by somebody who has not got driver.md open.
if (m.music256 < 0xf8) {
  console.log(m.starv_1s > 0
    ? "  music is low and the ring ran DRY — the 68000 side is late (check `host` first)"
    : "  music is low with the ring full — the Z80 is not taking every interrupt");
}
console.log(`  audio  ${wav}`);
