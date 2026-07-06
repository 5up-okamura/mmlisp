// Human-readable register trace — decode the JS-reference (and optionally the
// asm-emulated) register-write log into musically meaningful lines, grouped by
// frame. This is the "eyeball" companion to verify.mjs: verify proves the two
// logs are byte-identical; this shows you WHAT the driver actually emits so you
// can sanity-check it against your intent (patch load, key-on, pitch, level).
//
//   node dump-trace.mjs <song.mmlisp|song.mmb> [--frames N] [--asm] [--max L]
//
// --asm also runs the assembled Z80 driver and prints both columns side by
// side (they must match; any divergence is flagged).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { refTrace } from "./ref-trace.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const hex = (v, w = 2) => v.toString(16).padStart(w, "0");

// YM op slot from the register's low 2 bits of the high nibble: OPN2 lays ops
// out at address offsets 0,8,4,12 → op1,op2,op3,op4.
const OP_FROM_OFF = { 0: 1, 4: 3, 8: 2, 12: 4 };

function decodeYm(port, addr, data) {
  const chBase = port === 1 ? 4 : 1;
  const off = addr & 0x0f;
  const ch = chBase + (off & 3);
  const op = OP_FROM_OFF[off & 0x0c];
  const hi = addr & 0xf0;
  if (addr === 0x22)
    return data & 0x08 ? `LFO on rate ${data & 7}` : `LFO off`;
  if (addr === 0x27) return `CH3/timer mode $${hex(data)}`;
  if (addr === 0x28) {
    const chSel = data & 0x07;
    const chName = chSel < 3 ? chSel + 1 : chSel; // 4,5,6 already
    const mask = data >> 4;
    return mask ? `KEY-ON fm${chName} ops$${hex(mask, 1)}` : `KEY-OFF fm${chName}`;
  }
  if (hi === 0x30) return `fm${ch} op${op} DT/MUL $${hex(data)}`;
  if (hi === 0x40) return `fm${ch} op${op} TL ${data}`;
  if (hi === 0x50) return `fm${ch} op${op} KS/AR $${hex(data)}`;
  if (hi === 0x60) return `fm${ch} op${op} AM/DR $${hex(data)}`;
  if (hi === 0x70) return `fm${ch} op${op} SR ${data & 0x1f}`;
  if (hi === 0x80) return `fm${ch} op${op} SL/RR $${hex(data)}`;
  if (hi === 0x90) return `fm${ch} op${op} SSG-EG $${hex(data)}`;
  if (addr >= 0xa0 && addr <= 0xa2) return `fm${chBase + (addr & 3)} F-num.lo ${data}`;
  if (addr >= 0xa4 && addr <= 0xa6)
    return `fm${chBase + (addr & 3)} block ${(data >> 3) & 7} F-num.hi ${data & 7}`;
  if (addr >= 0xb0 && addr <= 0xb2)
    return `fm${chBase + (addr & 3)} ALG ${data & 7} FB ${(data >> 3) & 7}`;
  if (addr >= 0xb4 && addr <= 0xb6) {
    const pan = data >> 6;
    const p = pan === 2 ? "L" : pan === 1 ? "R" : pan === 3 ? "LR" : "off";
    return `fm${chBase + (addr & 3)} pan ${p} AMS ${(data >> 4) & 3} FMS ${data & 7}`;
  }
  return `$${hex(addr)} = $${hex(data)}`;
}

// PSG is a latch/data stream; decode with a tiny state machine.
function makePsgDecoder() {
  let reg = 0;
  let isAtt = false;
  let ch = 0;
  const period = [0, 0, 0];
  return (data) => {
    if (data & 0x80) {
      ch = (data >> 5) & 3;
      isAtt = (data & 0x10) !== 0;
      if (isAtt) {
        if (ch === 3) return `noise att ${data & 0x0f}`;
        return `sqr${ch + 1} att ${data & 0x0f}`;
      }
      if (ch === 3) return `noise cfg $${hex(data & 0x0f, 1)}`;
      period[ch] = (period[ch] & 0x3f0) | (data & 0x0f);
      return `sqr${ch + 1} period.lo → ${period[ch]}`;
    }
    if (!isAtt && ch < 3) {
      period[ch] = ((data & 0x3f) << 4) | (period[ch] & 0x0f);
      return `sqr${ch + 1} period ${period[ch]}`;
    }
    return `data $${hex(data)}`;
  };
}

function decodeLog(writes) {
  const psg = makePsgDecoder();
  return writes.map((w) => ({
    frame: w.frame,
    text:
      w.port === 2
        ? `psg  ${psg(w.data)}`
        : `ym${w.port}  ${decodeYm(w.port, w.addr, w.data)}`,
  }));
}

function printGrouped(lines, maxLines) {
  let lastFrame = -1;
  let printed = 0;
  for (const l of lines) {
    if (printed++ >= maxLines) {
      console.log(`  … (${lines.length - maxLines} more)`);
      break;
    }
    if (l.frame !== lastFrame) {
      console.log(`\nframe ${l.frame}:`);
      lastFrame = l.frame;
    }
    console.log(`  ${l.text}`);
  }
}

const args = process.argv.slice(2);
const fIdx = args.indexOf("--frames");
const frames = fIdx >= 0 ? Number(args.splice(fIdx, 2)[1]) : undefined;
const mIdx = args.indexOf("--max");
const maxLines = mIdx >= 0 ? Number(args.splice(mIdx, 2)[1]) : 60;
const withAsm = args.includes("--asm");
const input = args.filter((x) => !x.startsWith("--"))[0];
if (!input) {
  console.error("usage: node dump-trace.mjs <song.mmlisp|.mmb> [--frames N] [--asm] [--max L]");
  process.exit(2);
}

const mmb = input.endsWith(".mmb")
  ? new Uint8Array(readFileSync(input))
  : buildMmb(input).bytes;

const ref = refTrace(mmb, frames ? { maxFrames: frames } : {});
const horizon = frames ?? ref.frames;
const refWrites = ref.writes.filter((w) => w.frame < horizon);

if (!withAsm) {
  console.log(`# reference trace — ${refWrites.length} writes over ${horizon} frames`);
  printGrouped(decodeLog(refWrites), maxLines);
  process.exit(0);
}

// Side-by-side with the assembled driver (proves + shows).
const { assemble } = await import("./z80asm.mjs");
const { runTrace } = await import("./run-trace.mjs");
const { generateTables } = await import("./gen-tables.mjs");
const { writeFileSync } = await import("node:fs");
writeFileSync(join(here, "..", "src", "tables.z80"), generateTables());
const { bytes: bin } = assemble(join(here, "..", "src", "mmlispdrv.z80"));
const asm = runTrace(bin, mmb, { frames: horizon });
const rL = decodeLog(refWrites);
const aL = decodeLog(asm.writes);
console.log(
  `# ref ${refWrites.length} writes  vs  asm ${asm.writes.length} writes  (${horizon} frames)`,
);
const n = Math.max(rL.length, aL.length);
let mism = 0;
for (let i = 0; i < n && i < maxLines; i++) {
  const r = rL[i];
  const a = aL[i];
  const ok = r && a && r.frame === a.frame && r.text === a.text;
  if (!ok) mism++;
  const rt = r ? `f${r.frame} ${r.text}` : "—";
  const at = a ? `f${a.frame} ${a.text}` : "—";
  console.log(`${ok ? "  " : "✗ "}${rt.padEnd(34)} | ${at}`);
}
console.log(mism ? `\n${mism} divergence(s) in first ${maxLines}` : `\nmatch (first ${maxLines})`);
