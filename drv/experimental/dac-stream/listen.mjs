// THE DIAGNOSTIC LISTENING ROMS (docs/dac-engine-implementation.md §46.4).
//
//   node drv/experimental/dac-stream/listen.mjs [--seconds N]
//
// Builds the two tour ROMs, runs each on BlastEm, writes a DAC-ONLY reference
// WAV from what the instrument saw the DAC actually do, and writes the manifest
// that says what every section is for. Nothing here is a gate: the gates are
// `dac-stream`, `probe-test`, `machine:required`, `split` and `decoder`, and
// this is what you listen to once they are green.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { buildCase } from "./case-config.mjs";
import { readProbe, Z80_DIV } from "./probe-analysis.mjs";
import { GLOB } from "./config.mjs";
import { TOUR, MODE, triangle } from "./tour.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");
const OUT = join(drv, "out", "dac-stream", "listen");
const BLAST = process.env.MMLISP_BLASTEM || join(drv, "out", "blastem");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 44));
const MCLK = 53693175;
const RATE = 44100;

const core = ["blastem_libretro.dylib", "blastem_libretro.so"]
  .map((f) => join(BLAST, f)).find(existsSync);
const host = join(BLAST, "host");
if (!core || !existsSync(host)) {
  console.error("listen: BlastEm is not built here — run `sh drv/blastem/setup.sh` first");
  process.exit(2);
}

/**
 * WHAT THE DAC DID, and nothing else.
 *
 * The emulator's own WAV carries the whole mixer — FM, PSG and DAC together —
 * and the CSM build has a test tone in it on purpose. This one is built from
 * the instrument's record of every write to $2A: the value that was written and
 * the master clock it was written at, held until the next one, which is what
 * the chip's DAC does. So it is a reference for the PCM path alone, and it is
 * the same in both builds by construction.
 */
function dacWav(dac, seconds) {
  const n = Math.floor(seconds * RATE);
  const pcm = Buffer.alloc(n * 2);
  const t0 = dac.length ? dac[0].time : 0;
  let k = 0, value = 128;
  for (let i = 0; i < n; i++) {
    const at = t0 + Math.round((i * MCLK) / RATE);
    while (k < dac.length && dac[k].time <= at) value = dac[k++].value;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, (value - 128) * 256)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** The timeline the table describes, in seconds, with what each section is for. */
function plan(secondsPerSection) {
  const rows = []; let at = 0, index = 0;
  for (const s of TOUR) {
    const levels = [];
    for (let i = 0; i < s.n * 128; i++) {
      const t = triangle(s.mode & MODE.fast ? index * 128 + i : (index * 128 + i) >> 5);
      levels.push([s.mode & MODE.v0 ? t : s.v0, s.mode & MODE.v1 ? t : s.v1,
        s.mode & MODE.m ? t : s.m]);
    }
    const distinct = [...new Set(levels.map((l) => l.join("/")))];
    rows.push({ from: at, to: at + s.n * secondsPerSection, what: s.what, mode: s.mode,
      expect: distinct.length <= 4 ? distinct.join(" ")
        : `${distinct.length} triples, ${distinct[0]} … ${distinct.at(-1)}` });
    at += s.n * secondsPerSection;
    index += s.n;
  }
  return rows;
}

mkdirSync(OUT, { recursive: true });
const built = [];
for (const c of CASES.filter((x) => x.listenOnly)) {
  const b = buildCase(c, { outDir: OUT });
  const log = join(OUT, `tour-${b.sha}-${SECONDS}s.log`);
  execFileSync(host, ["--core", core, "--rom", b.rpath, "--frames", String(Math.round(SECONDS * 60))],
    { env: { ...process.env, MMLISP_PROBE_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });
  const L = readProbe(readFileSync(log));
  const from = L.dac[0].time, span = (L.dac.at(-1).time - from) / MCLK;
  const wav = join(OUT, `tour-${b.sha}-dac-only.wav`);
  writeFileSync(wav, dacWav(L.dac, Math.min(SECONDS, span)));
  // The section length, MEASURED: one iteration is one read and one publish, so
  // a section of 128 of them is 128 transfers of each.
  const glob = b.cfg.ram.glob[0];
  const st = (a) => L.ramWrites.filter((x) => x.region === "glob" && x.addr === a - glob
    && x.time >= from);
  const v0 = st(glob + GLOB.v0page).filter((x, i, xs) => i === 0 || x.value !== xs[i - 1].value);
  // A section is 128 iterations and an iteration is two transfers, so its
  // length comes from the period the host GENERATED — not from a count of
  // anything. The idle sections are a shade shorter because they take no bus,
  // which is 0.3% of an iteration and is why the run is 44.0 s and not 43.9.
  const secPer = 128 * 2 * b.grab.period.generated.target / MCLK;
  const base = b.cfg.ram.pub[0];
  const commits = L.hostWrites.filter((x) => x.addr === b.grab.proto.commandCommit - base
    && x.time >= from).length;
  // What the DAC was actually doing, section by section: the RMS of the
  // reference WAV's own samples over each window, so the table can be checked
  // against the levels before anyone plays it.
  const rms = (a, z) => {
    let sum = 0, n2 = 0, k2 = 0, v = 128;
    for (let t = a; t < z; t += MCLK / RATE) {
      while (k2 < L.dac.length && L.dac[k2].time <= from + t) v = L.dac[k2++].value;
      sum += (v - 128) ** 2; n2++;
    }
    return n2 ? Math.sqrt(sum / n2) : 0;
  };
  const triples = (a, z) => {
    const w2 = (addr) => L.ramWrites.filter((x) => x.region === "glob" && x.addr === addr
      && x.time >= from + a * MCLK && x.time < from + z * MCLK);
    const seen = new Set();
    const v0s = w2(GLOB.v0page), v1s = w2(GLOB.v1page), ms = w2(GLOB.mpage);
    for (let i = 0; i < Math.min(v0s.length, v1s.length, ms.length); i++)
      seen.add(`${v0s[i].value}/${v1s[i].value}/${ms[i].value}`);
    return [...seen];
  };
  built.push({ c, b, log, wav, span, dac: L.dac.length, v0, commits, secPer,
    rate: L.dac.length / span, rms, triples });
}

const secPer = built[0].secPer;
const rows = plan(secPer);
const lines = [];
lines.push("# The diagnostic listening ROMs — checkpoint A");
lines.push("");
lines.push("Built by `node drv/experimental/dac-stream/listen.mjs`"
  + (SECONDS === 44 ? "" : ` --seconds ${SECONDS}`) + ".");
lines.push("");
lines.push("Both ROMs are the SAME engine the gates measure: two voices, fifteen levels,");
lines.push("the bounded corrector, the runtime protocol and the one-slot PCM state mailbox,");
lines.push("with a real 68000 host reading the published snapshot and the decoder's own live");
lines.push("counter and publishing a bundle whose boundary is that counter's next one.");
lines.push("");
lines.push("| file | what |");
lines.push("| --- | --- |");
for (const x of built) {
  lines.push(`| \`${resolve(x.b.rpath)}\` | ${x.c.name} |`);
  lines.push(`| \`${resolve(x.wav)}\` | the DAC alone, 44.1 kHz mono, from the same run |`);
}
lines.push("");
lines.push("## How to run one");
lines.push("");
lines.push("```");
lines.push(`${resolve(host)} --core ${resolve(core)} \\`);
lines.push(`  --rom ${resolve(built[0].b.rpath)} --frames ${Math.round(SECONDS * 60)} --wav out.wav`);
lines.push("```");
lines.push("");
lines.push("…or open the `.bin` in any Mega Drive emulator, or write it to a flash cart.");
lines.push("It needs no controller and takes no input.");
lines.push("");
lines.push("## PCM material");
lines.push("");
lines.push("Two fixed sources, 256 bytes each, played from Z80 RAM and never changed:");
lines.push("voice 0 is one cycle of a sine at amplitude 120, voice 1 is three cycles at 90.");
lines.push("Everything you hear move is the LEVEL, published through the mailbox — the PCM");
lines.push("itself is the same 512 bytes from the first section to the last, so anything that");
lines.push("changes is the mailbox, the mixer or the corrector and nothing else.");
lines.push("");
lines.push(`## Sections — ${secPer.toFixed(3)} s each, 128 host iterations`);
lines.push("");
lines.push("");
lines.push("The expected column is LEVELS, 0 silent to 14 unity; the observed one is what the");
lines.push("engine actually staged, which is a Z80 PAGE — the level family starts at page 12,");
lines.push("so page = 12 + level. The rms is of the reference WAV itself over that window.");
lines.push("");
lines.push("| from | to | v0/v1/master expected | staged, observed | DAC rms | what it is for |");
lines.push("| --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const got = built[0].triples(r.from, r.to);
  const level = built[0].rms(r.from * MCLK, r.to * MCLK);
  lines.push(`| ${r.from.toFixed(2)} s | ${r.to.toFixed(2)} s | ${r.expect} |`
    + ` ${got.length === 0 ? "nothing new" : got.length <= 3 ? got.join(" ")
      : `${got.length} triples, ${got[0]} … ${got.at(-1)}`} |`
    + ` ${level.toFixed(1)} | ${r.what} |`);
}
lines.push("");
lines.push("## Measured, in the same runs");
lines.push("");
lines.push("| | " + built.map((x) => x.c.name).join(" | ") + " |");
lines.push("| --- | " + built.map(() => "---").join(" | ") + " |");
lines.push("| DAC writes | " + built.map((x) => x.dac.toLocaleString()).join(" | ") + " |");
lines.push("| DAC rate | " + built.map((x) => `${x.rate.toFixed(2)} Hz`).join(" | ") + " |");
lines.push("| bundles published | " + built.map((x) => x.commits).join(" | ") + " |");
lines.push("| distinct voice-0 pages staged | "
  + built.map((x) => new Set(x.v0.map((y) => y.value)).size).join(" | ") + " |");
lines.push("| run length | " + built.map((x) => `${x.span.toFixed(2)} s`).join(" | ") + " |");
lines.push("");
lines.push("The DAC period is 5,376 master, so the rate with the bus never taken is");
lines.push("53,693,175 / 5,376 = **9,987.57 Hz**. A run that takes the bus is a little under");
lines.push("it, because a sample is not written while the Z80 is stopped: the corrector holds");
lines.push("the PHASE against the H observation, it does not insert the samples the hold cost.");
lines.push("Over this tour that is a 0.04% deficit, and the dense section — two transfers");
lines.push("inside one observation, over the 1,500 master live contract on purpose — is where");
lines.push("most of it comes from and where the corrector is doing visible work.");
const manifest = join(OUT, "MANIFEST.md");
writeFileSync(manifest, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\nmanifest: ${resolve(manifest)}`);
