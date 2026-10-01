// WHAT THE PCM VOICES ARE TOLD, from both sequencers — for a score that
// sounds wrong on the machine.
//
//   node tools/pcm-trace.mjs <score.mmlisp> [--frames N] [--list N]
//
// Runs the score the way the SGDK host does (primed at load, then the song's
// start: captureSlotLog({ prime: 0 }) and gate_main --prime 0) through the JS
// reference and the C sequencer, and prints:
//
//   - whether the two agree on every PCM command (frame, bytes), and the first
//     frame they do not;
//   - the first N commands, decoded: the voice, the sample entry the source
//     address falls in, shot or loop, and the loop's length in bytes and ms at
//     the image's rate;
//   - what looks wrong on its own: a loop shorter than four blocks (heard as a
//     buzz near rate/len Hz), a source outside every entry, an END outside its
//     entry, the same voice restarted within two frames.
//
// It reads the score, not the ROM: if this is clean and the ROM still sounds
// wrong, the fault is past the sequencer (the host, the bank, the image).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { generatedTables } from "./c-tables.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder, decodeSlot, PCM_START, PCM_RETARGET, PCM_VOL, PCM_MASTER } from "../../live/src/slot-builder.js";
import { parsePcmBank, PCM_WINDOW, PCM_SILENCE_ADDR } from "../../live/src/pcm-model.js";
import { engineImage } from "../../live/src/engine-images.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".mmlisp"));
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
if (!file) { console.error("usage: node tools/pcm-trace.mjs <score.mmlisp> [--frames N] [--list N]"); process.exit(2); }
const FRAMES = opt("--frames", 1800), LIST = opt("--list", 40);

const { bytes, sampleBank, pcmEntryIds } = buildMmb(file);
if (!sampleBank) { console.log("no sample bank: the score plays no PCM"); process.exit(0); }
const drv = new DrvPlayer();
drv.loadMMB(bytes, sampleBank);
const voices = drv._song.pcmVoices || 1;
const rate = engineImage(voices).rateHz;
const { entries } = parsePcmBank(sampleBank);
const names = new Map(Object.entries(pcmEntryIds ?? {}).map(([k, i]) => [i, k]));
console.log(`${file}: pcm-voices ${voices}, image rate ${rate.toFixed(2)} Hz, ${entries.length} bank entries`);

// ── the two sequencers, as the host runs them ──────────────────────────────
const js = drv.captureSlotLog({ maxFrames: FRAMES, prime: 0, builder: new SlotBuilder() }).slots
  .map((s) => decodeSlot(s).pcm);
const ctab = generatedTables();
const tmp = mkdtempSync(join(tmpdir(), "pcmtrace-"));
let c = null;
try {
  const exe = join(tmp, "gate_main");
  execFileSync(process.env.CC ?? "cc", ["-std=c99", "-O1", "-o", exe, ...ctab.flags,
    join(here, "..", "68k", "gate_main.c"), join(here, "..", "68k", "mmlispseq.c"), ctab.tables], { stdio: "pipe" });
  writeFileSync(join(tmp, "s.mmb"), bytes);
  writeFileSync(join(tmp, "s.smp"), sampleBank);
  const buf = execFileSync(exe, [join(tmp, "s.mmb"), String(FRAMES), "--samples", join(tmp, "s.smp"), "--prime", "0"],
    { maxBuffer: 1 << 28 });
  c = [];
  for (let i = 0; i + 2 <= buf.length;) { const n = buf[i] | (buf[i + 1] << 8); i += 2; c.push(decodeSlot(buf.subarray(i, i + n)).pcm); i += n; }
} catch (e) {
  console.log(`(the C did not run: ${(e.stderr ?? e.message).toString().split("\n")[0]})`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
if (c) {
  let bad = -1;
  for (let f = 0; f < Math.max(js.length, c.length) && bad < 0; f++)
    if (JSON.stringify((js[f] ?? []).map((x) => [...x])) !== JSON.stringify((c[f] ?? []).map((x) => [...x]))) bad = f;
  console.log(bad < 0 ? `C ≡ JS: every PCM command identical over ${js.length} frames`
    : `C and JS DIFFER from frame ${bad}: JS ${JSON.stringify((js[bad] ?? []).map((x) => [...x]))} C ${JSON.stringify((c[bad] ?? []).map((x) => [...x]))}`);
}

// ── decode and check ───────────────────────────────────────────────────────
const w16 = (x, k) => x[k] | (x[k + 1] << 8);
const hex = (v) => "$" + v.toString(16).padStart(4, "0");
const entryAt = (addr) => entries.findIndex((e) => {
  const src = PCM_WINDOW + (e.base & 0x7fff);
  return addr >= src && addr < src + e.len;
});
const lastStart = new Map();
const flags = { shortLoop: 0, srcOutside: 0, endOutside: 0, fastRestart: 0 };
let listed = 0, starts = 0;
js.forEach((cmds, f) => cmds.forEach((x) => {
  const op = x[0];
  let line = null, warn = [];
  if (op === PCM_START) {
    starts++;
    const v = x[1], shift = x[2], src = w16(x, 3), end = w16(x, 5), wrap = w16(x, 7);
    const ei = entryAt(src);
    const e = entries[ei];
    if (ei < 0) { warn.push("SOURCE OUTSIDE EVERY ENTRY"); flags.srcOutside++; }
    else {
      const top = PCM_WINDOW + (e.base & 0x7fff) + e.len;
      if (end + 16 > top) { warn.push("END PAST ITS ENTRY"); flags.endOutside++; }
    }
    const loop = wrap !== PCM_SILENCE_ADDR;
    const llen = loop ? end + 16 - wrap : 0;
    if (loop && llen < 64) { warn.push(`LOOP OF ${llen} B ≈ ${(rate / Math.max(llen, 1)).toFixed(0)} Hz BUZZ`); flags.shortLoop++; }
    const prev = lastStart.get(v);
    if (prev !== undefined && f - prev <= 2) { warn.push(`voice ${v} restarted ${f - prev} frame(s) after its last start`); flags.fastRestart++; }
    lastStart.set(v, f);
    line = `START  v${v} shift ${shift} src ${hex(src)} end ${hex(end)} wrap ${hex(wrap)}  `
      + `${ei >= 0 ? `entry ${ei}${names.has(ei) ? ` (${names.get(ei)})` : ""}` : "?"}  `
      + (loop ? `LOOP ${llen} B = ${(1000 * llen / rate).toFixed(1)} ms` : "shot");
  } else if (op === PCM_RETARGET) line = `RETGT  v${x[1]} end ${hex(w16(x, 2))} wrap ${hex(w16(x, 4))}`;
  else if (op === PCM_VOL) line = `VOL    v${x[1]} shift ${x[2]}`;
  else if (op === PCM_MASTER) line = `MASTER shift ${x[1]}`;
  if (line && (listed < LIST || warn.length)) {
    if (listed < LIST || warn.length) console.log(`f${String(f).padStart(5)}  ${line}${warn.length ? "   <<< " + warn.join("; ") : ""}`);
    listed++;
  }
}));
console.log(`\n${starts} STARTs over ${js.length} frames · short loops ${flags.shortLoop} · sources outside ${flags.srcOutside}`
  + ` · ENDs past their entry ${flags.endOutside} · restarts within 2 frames ${flags.fastRestart}`);
