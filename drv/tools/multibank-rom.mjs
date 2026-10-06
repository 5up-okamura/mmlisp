// Standalone SGDK/BlastEm feasibility ROM. Replays precompiled score commands
// through the production grab routine, using the experimental Z80 image.
// This is not an installation of the new ABI into the production C sequencer.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sgdkEnv, runRom } from "./sgdk-project.mjs";
import { buildMultibankImage } from "./build-multibank.mjs";
import { buildMultibankScore } from "./multibank-score.mjs";
import { MultibankModel } from "./multibank-model.mjs";
import { readProbe } from "./probe-analysis.mjs";
import { checkWriteStream } from "../engine/analyze.mjs";
import { analyzeMultibankTiming } from "./multibank-timing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, value) => args.includes(name) ? args[args.indexOf(name) + 1] : value;
const file = resolve(args.find((s) => s.endsWith(".mmlisp")) ?? join(here, "../tests/multibank.mmlisp"));
const out = resolve(opt("--out", join(here, "../out/multibank-rom")));
const seconds = Number(opt("--seconds", 8));
if (!Number.isFinite(seconds) || seconds < 2 || seconds > 60) throw new Error("ROM gate needs 2..60 seconds");
const E = sgdkEnv("multibank-rom");
const probeScore = buildMultibankScore(file, { frames: 1 });
const image = buildMultibankImage({ voices: probeScore.sourceVoices, xpSteps: probeScore.sourceVoices === 1 ? 55 : 15 });
const psgDelayFrames = 0;
const grabsPerFrame = 5;
const fifoAhead = 32;
const score = buildMultibankScore(file, { frames: Math.floor((seconds - 1) * 60), idleAfterGen: image.gen.idleAfterGen,
  separateBanks: args.includes("--separate-banks") });
for (const d of ["src", "inc", "res"]) mkdirSync(join(out, d), { recursive: true });
writeFileSync(join(out, "res/engine.bin"), image.bytes);
writeFileSync(join(out, "res/samples.rom"), score.rom);
writeFileSync(join(out, "res/resources.res"), 'BIN bank_engine "engine.bin" 2\nBIN bank_samples "samples.rom" 32768\n');
copyFileSync(join(here, "sgdk-shim/rom_header.c"), join(out, "src/rom_header.c"));

const queue = score.items.flatMap((it) => it.pairs.map(([op, value], i) => {
  if (op === 0x1c || op === 0x1e) value |= it.pairs[i + 1][1] << 8;
  else if (op === 0x1d || op === 0x1f) value = it.pairs[i - 1][1] | value << 8;
  return `{${it.frame},${op},${value}}`;
}));
// PSG keeps a fixed video-frame delay. Following each frame's variable FIFO
// completion compressed envelopes into bursts when FM changed instruments.
const initialPairs = score.items.filter((it) => it.frame === 1).reduce((n, it) => n + it.pairs.length, 0);
let pairPrefix = 0;
const psg = score.items.flatMap((it) => {
  pairPrefix += it.pairs.length;
  return (it.psg ?? []).map((value) => ({ frame: it.frame + psgDelayFrames, until: pairPrefix, value }));
});
const driver = readFileSync(join(here, "../sgdk/mmlispdrv.c"), "utf8");
const grab = driver.slice(driver.indexOf("typedef struct { u8 ops[16];"), driver.indexOf("// One grab, sending the frames"));
if (!grab.includes("static u16 grab(")) throw new Error("could not find production grab routine");
writeFileSync(join(out, "src/main.c"), `#include <genesis.h>
#include "resources.h"
#define Z80_RAM_AT(a) ((vu8*)(0xA00000 + (a)))
#define STR_(x) #x
#define STR(x) STR_(x)
#define MMLISPDRV_FIFO_LO 0x1f6d
#define MMLISPDRV_PAIRS_PER_GRAB 16
#define GRAB_LATE 0x100
static vu16 releaseSink;
${grab}
typedef struct { u16 frame, op, value; } Pair;
static const Pair data[] = {${queue.join(",\n")}};
typedef struct { u32 until; u16 frame, value; } Psg;
static const Psg psgData[] = {${psg.length ? psg.map((p) => `{${p.until},${p.frame},${p.value}}`).join(",\n") : "{0,0,0}"}};
static u32 nextPsg, consumedPairs, observedAt[128];
static u32 nextPair;
static u16 frame;
static u8 previous, head;
static bool valid;
static void observe(u16 got) {
    for (u8 at = previous; at != (u8)got; at += 2)
        if (observedAt[at >> 1] > consumedPairs) consumedPairs = observedAt[at >> 1];
    if (valid && (u8)((u8)got-previous) >= (u8)(2*head-previous)) valid = FALSE;
    previous = got;
}
static void poll(void) {
    static GrabBlock block;
    observe(grab(&block, 0x1d00));
}
static void pump(void) {
    GrabBlock block;
    const u8 tail = previous >> 1;
    const u8 ahead = (head-tail)&127;
    if (!valid || ahead < ${fifoAhead}) head = (tail+${fifoAhead})&127;
    // MOVEP accepts any pair offset; only a page crossing needs a wrap.
    // Rounding every destination to sixteen pairs added up to 15 ms jitter.
    if (head+16 > 128) head = 0;
    valid = TRUE;
    u16 n = 0;
    u32 q = nextPair;
    // The bus-held grant checks the destination again. After the fresh poll,
    // the one-voice profile can use all free cells, including the final eight.
    const bool room = ((head-tail)&127)+16 <= ${image.cfg.voices === 1 ? 128 : 120};
    const u16 bankBase = (u32)bank_samples >> 15;
    for (u16 i=0; i<16; i++) {
        block.ops[i] = 0; block.vals[i] = 0;
        if (room && q < sizeof(data)/sizeof(data[0]) && data[q].frame <= frame) {
            const Pair* p = &data[q++];
            block.ops[i] = p->op;
            block.vals[i] = p->op >= 0x1c && p->op <= 0x1f
                ? (u8)((p->value + bankBase) >> ((p->op & 1) ? 8 : 0)) : p->value;
            n++;
        }
    }
    block.prev = previous; block.dist = n ? (u8)(2*head - previous) : 0;
    const u16 got = grab(&block, 0x1d00 + 2*head);
    observe(got);
    if (n && (got & GRAB_LATE)) valid = FALSE;
    else if (n) {
        for (u16 i=0; i<16; i++) observedAt[(head+i)&127] = nextPair + ((i<n) ? i+1 : n);
        nextPair += n; head = (head + n) & 127;
    }
    while (nextPsg < ${psg.length} && psgData[nextPsg].frame <= frame) {
        const u16 level = SYS_getAndSetInterruptMaskLevel(7);
        do { *(vu8*)0xC00011 = psgData[nextPsg++].value; }
        while (nextPsg < ${psg.length} && psgData[nextPsg].frame <= frame);
        SYS_setInterruptMaskLevel(level);
    }
}
int main(bool hard) {
    (void)hard;
    JOY_setSupport(PORT_1, JOY_SUPPORT_OFF);
    JOY_setSupport(PORT_2, JOY_SUPPORT_OFF);
    SYS_disableInts();
    Z80_requestBus(TRUE); Z80_clear(); Z80_upload(0, bank_engine, ${image.bytes.length});
    Z80_startReset(); Z80_releaseBus(); waitSubTick(50); Z80_endReset();
    SYS_enableInts();
    for (u16 n=0; n<60; n++) {
        SYS_doVBlankProcess();
        Z80_requestBus(TRUE); const u8 ready = *Z80_RAM_AT(0x1f6e); Z80_releaseBus();
        if (ready == 0xd2) break;
    }
    // Set up voices before advancing the score, rather than letting the
    // initial register burst delay the first notes by a variable amount.
    frame = 1;
    for (u16 n=0; n<120 && consumedPairs < ${initialPairs}; n++) {
        SYS_doVBlankProcess(); poll();
        for (u16 i=0; i<${grabsPerFrame} && nextPair < ${initialPairs}; i++) pump();
    }
    Z80_requestBus(TRUE); *Z80_RAM_AT(0x1e40) = 0x53; Z80_releaseBus();
    while (TRUE) {
        SYS_doVBlankProcess(); frame++; poll(); pump();
        for (u16 i=1; i<${grabsPerFrame} && nextPair < sizeof(data)/sizeof(data[0]) && data[nextPair].frame <= frame; i++) pump();
    }
    return 0;
}
`);
try {
  execFileSync("make", ["-f", join(E.GDK, "makefile.gen")], { cwd: out, env: E.env, stdio: "pipe" });
} catch (e) { throw new Error(`SGDK build failed:\n${e.stdout?.toString().slice(-2500)}\n${e.stderr?.toString().slice(-2500)}`); }
const romFile = join(out, "out/rom.bin"), log = join(out, "probe.bin");
if (!runRom(E, romFile, { seconds, log, wav: join(out, "audio.wav") })) throw new Error("BlastEm run failed");
const rom = readFileSync(romFile), L = readProbe(readFileSync(log));
if (rom.length > 0x400000) throw new Error("ROM exceeds the prototype cartridge aperture");
const ready = L.ramWrites.find((w) => w.region === "glob" && w.addr === 0x6e && w.value === 0xd2);
if (!ready) throw new Error("experimental engine did not boot");
const dac = L.dac.filter((d) => d.time > ready.time), fail = [];
if (dac.length < image.cfg.rateHz) throw new Error("too few DAC writes");
const stores = new Map();
let si = 0;
for (const w of L.ramWrites) {
  if (w.region !== "glob" || w.addr < 0x30 || w.addr >= 0x50 || w.time < dac[0].time) continue;
  while (si + 1 < dac.length && dac[si + 1].time <= w.time) si++;
  if (stores.has(si)) throw new Error(`multiple STOREs in slot ${si}`);
  stores.set(si, [w.addr - 0x30, w.value]);
}
const model = new MultibankModel(image.gen, rom);
let mismatches = 0;
for (let i = 0; i < dac.length; i++) if (model.slot(stores.get(i)) !== dac[i].value) mismatches++;
if (mismatches) fail.push(`${mismatches} DAC values disagree with independent model`);
if (!dac.some((d) => d.value !== 128)) fail.push("the ROM was silent");
// Relocation changes bank fields; all commands must still arrive exactly once.
const wantCommands = score.items.filter((i) => i.intent).map((i) => i.intent);
const gotCommands = model.log;
for (let v = 0; v < 2; v++) {
  const want = wantCommands.filter((i) => i.v === v), got = gotCommands.filter((i) => i.v === v);
  if (want.length !== got.length) fail.push(`voice ${v}: ${got.length}/${want.length} commands applied`);
  const bankDeltas = new Set();
  for (let i = 0; i < Math.min(want.length, got.length); i++) {
    for (const key of ["kind", "src", "end", "wrap"]) if (want[i][key] !== got[i][key]) fail.push(`voice ${v} command ${i}: ${key} differs`);
    if (want[i].kind === "start") bankDeltas.add(got[i].bank - want[i].bank);
  }
  if (want.some((i) => i.kind === "start") && (bankDeltas.size !== 1 || [...bankDeltas][0] < 1))
    fail.push(`voice ${v}: inconsistent ROM relocation`);
}
const span = dac.at(-1).time - dac[0].time;
const stops = L.stops.filter(([a, b]) => b > dac[0].time && a < dac.at(-1).time);
const held = stops.reduce((n, [a, b]) => n + Math.min(b, dac.at(-1).time) - Math.max(a, dac[0].time), 0);
const rate = (dac.length - 1) * image.cfg.machine.masterHz / span;
const runningRate = (dac.length - 1) * image.cfg.machine.masterHz / (span - held);
if (Math.abs(runningRate / image.cfg.rateHz - 1) > .002) fail.push(`running rate ${runningRate} differs from nominal`);
if (rate < image.cfg.rateHz * .985) fail.push(`BUSREQ costs more than 1.5% of DAC rate`);
const writes = L.ymZ80.filter((e) => !e.read && e.time >= ready.time);
const latch = [0, 0], stream = [], seenFm = [], wantFm = [];
let wantedPort = 0;
for (const it of score.items) for (const [op, value] of it.pairs) {
  if (op === 0x20) wantedPort = value;
  else if (op >= 0x22) wantFm.push([wantedPort, op, value]);
}
for (const e of writes) {
  if (e.kind === "addr") latch[e.part] = e.byte;
  else if (e.part !== 0 || latch[0] !== 0x2a) seenFm.push([e.part, latch[e.part], e.byte]);
  stream.push({ cycle: e.time / 15, port: e.part, reg: latch[e.part], kind: e.kind });
}
if (JSON.stringify(wantFm) !== JSON.stringify(seenFm)) fail.push("FM command stream differs from the score");
const seenPsg = L.psg68k.filter((e) => e.time >= ready.time).map((e) => e.value & 255);
if (JSON.stringify(psg.map((p) => p.value)) !== JSON.stringify(seenPsg)) fail.push("PSG command stream differs from the score");
fail.push(...checkWriteStream(stream).problems.slice(0, 5));
const marker = L.hostWrites.find((w) => w.addr === 0 && w.value === 0x53);
if (!marker) fail.push("score clock marker was not published");
const clockOrigin = marker ? marker.time - image.cfg.machine.frameMaster : ready.time;
const timing = fail.length ? null : analyzeMultibankTiming(score, L, ready.time, model.log, dac, image, clockOrigin);
if (timing?.psg.intervalError.count && timing.psg.intervalError.maxMs > timing.frameMs / 4)
  fail.push(`PSG interval jitter ${timing.psg.intervalError.maxMs.toFixed(3)} ms exceeds a quarter frame`);
const report = { experimental: true, score: file, usedBytes: score.usedBytes, dataBanks: score.banks,
  sourceVoices: score.sourceVoices, engineVoices: image.cfg.voices, separateBanks: score.separateBanks,
  fmWrites: seenFm.length, psgWrites: seenPsg.length,
  commandStepsPerLap: image.cfg.xpSteps, psgDelayFrames, grabsPerFrame,
  samples: dac.length, mismatches, commands: model.log.length, nominalHz: image.cfg.rateHz,
  runningHz: runningRate, effectiveHz: rate, busLossPct: 100 * (1 - rate / image.cfg.rateHz),
  codeBytes: image.symbols.get("code_end"), timing, fail };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (fail.length) throw new Error("multibank ROM gate failed");
