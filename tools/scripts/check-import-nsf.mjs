#!/usr/bin/env node
// The NSF importer on songs built here (no one's music in the repo): a small
// 6502 driver plays a table of register writes, a step every 15 frames,
// through the 2A03 and all six expansions. Checks the run (init / play, the
// banks, a DMC sample as the banks map it), the loop (the state coming
// round; the writes repeating when a counter keeps the state from it; a song
// that stops), the rows each chip's channels land on, and that every score
// compiles clean for fc.
import assert from "node:assert/strict";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { parseNsf, runNsf } from "../../live/src/import-nsf.js";
import { analyzeVgm, defaultVgmOptions, vgmToMmlisp } from "../../live/src/import-vgm.js";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";

const CLOCK = 1789773;
const FRAMES = 15; // a step
const PERIOD = 16639e-6 * 44100; // samples a frame

// ── A 6502 assembler for the driver: opcodes by name, labels in two passes ──
function assemble(org, body) {
  const OP = {
    "inc zp": 0xe6, "lda zp": 0xa5, "lda #": 0xa9, "cmp #": 0xc9, "sta zp": 0x85, "ldx zp": 0xa6, "lda abs,x": 0xbd,
    "ldy #": 0xa0, "lda (zp),y": 0xb1, "iny": 0xc8, "ldx #": 0xa2, "sta (zp,x)": 0x81, "rts": 0x60, "jsr": 0x20, "jmp": 0x4c,
    "bne": 0xd0, "beq": 0xf0,
  };
  const size = (op) => (op === "iny" || op === "rts" ? 1 : op === "jsr" || op === "jmp" || op === "lda abs,x" ? 3 : 2);
  const labels = {};
  let pc = org;
  for (const ins of body) {
    if (typeof ins === "string") labels[ins] = pc;
    else if (ins.bytes) pc += ins.bytes.length;
    else pc += size(ins[0]);
  }
  const out = [];
  pc = org;
  const val = (v) => (typeof v === "string" ? labels[v] : v);
  for (const ins of body) {
    if (typeof ins === "string") continue;
    if (ins.bytes) { out.push(...ins.bytes.map(val).map((v) => v & 0xff)); pc += ins.bytes.length; continue; }
    const [op, arg] = ins;
    out.push(OP[op]);
    if (op === "bne" || op === "beq") out.push((val(arg) - (pc + 2)) & 0xff);
    else if (size(op) === 3) out.push(val(arg) & 0xff, val(arg) >> 8);
    else if (size(op) === 2) out.push(val(arg) & 0xff);
    pc += size(op);
  }
  return { bytes: out, labels };
}

// The driver. RAM: $00 the frame count, $01 the step, $10-$11 a counter
// (song 2 only), $20-$21 the list pointer, $22-$23 a write's address, $30
// the song. A list is [lo, hi, value]…, ended by a 0 high byte — 85 writes
// at most (Y indexes it); `init` is one or more. Song 3 stops after its
// last step (step = $FF).
function driver({ init, steps, loopStep, stops = false, banked = false }) {
  const inits = Array.isArray(init[0][0]) ? init : [init];
  const lists = [...inits.map((w, i) => ({ name: `list-init${i}`, w })), ...steps.map((w, i) => ({ name: `list-${i}`, w }))];
  const body = [
    "init",
    ["sta zp", 0x30], ["lda #", FRAMES - 1], ["sta zp", 0x00], ["lda #", 0], ["sta zp", 0x01], ["sta zp", 0x10], ["sta zp", 0x11],
    ...inits.flatMap((_, i) => [["lda #", `lo:list-init${i}`], ["sta zp", 0x20], ["lda #", `hi:list-init${i}`], ["sta zp", 0x21], ["jsr", "run"]]),
    ["rts"],
    "play",
    ["lda zp", 0x30], ["cmp #", 1], ["bne", "nocount"], ["inc zp", 0x10], ["bne", "nocount"], ["inc zp", 0x11],
    "nocount",
    ["lda zp", 0x01], ["cmp #", 0xff], ["beq", "done"],
    ["inc zp", 0x00], ["lda zp", 0x00], ["cmp #", FRAMES], ["bne", "done"], ["lda #", 0], ["sta zp", 0x00],
    ["ldx zp", 0x01], ["lda abs,x", "ptrlo"], ["sta zp", 0x20], ["lda abs,x", "ptrhi"], ["sta zp", 0x21], ["jsr", "run"],
    ["inc zp", 0x01], ["lda zp", 0x01], ["cmp #", steps.length], ["bne", "done"], ["lda #", stops ? 0xff : loopStep], ["sta zp", 0x01],
    "done", ["rts"],
    "run", ["ldy #", 0],
    "next", ["lda (zp),y", 0x20], ["sta zp", 0x22], ["iny"], ["lda (zp),y", 0x20], ["beq", "end"], ["sta zp", 0x23], ["iny"],
    ["lda (zp),y", 0x20], ["iny"], ["ldx #", 0], ["sta (zp,x)", 0x22], ["jmp", "next"],
    "end", ["rts"],
    "ptrlo", { bytes: steps.map((_, i) => `list-${i}`) }, "ptrhi", { bytes: steps.map((_, i) => `list-${i}`) },
    ...lists.flatMap(({ name, w }) => [name, { bytes: [...w.flatMap(([a, v]) => [a & 0xff, a >> 8, v]), 0, 0] }]),
  ];
  // The pointer tables' bytes and #lo/#hi immediates name labels: resolve them in a second assembly.
  const first = assemble(0x8000, body.map((x) => (Array.isArray(x) && typeof x[1] === "string" && /^(lo|hi):/.test(x[1]) ? [x[0], 0] : x)));
  const L = first.labels;
  const fix = body.map((x) => {
    if (Array.isArray(x) && typeof x[1] === "string" && /^(lo|hi):/.test(x[1])) {
      const v = L[x[1].slice(3)];
      return [x[0], x[1].startsWith("lo") ? v & 0xff : v >> 8];
    }
    if (x?.bytes && x === body[body.indexOf("ptrlo") + 1]) return { bytes: steps.map((_, i) => L[`list-${i}`] & 0xff) };
    if (x?.bytes && x === body[body.indexOf("ptrhi") + 1]) return { bytes: steps.map((_, i) => L[`list-${i}`] >> 8) };
    return x;
  });
  const prog = assemble(0x8000, fix);
  return { code: prog.bytes, init: prog.labels.init, play: prog.labels.play, banked };
}

// An NSF file: the header, then the program (and, banked, more 4 KB banks).
function nsfFile({ code, init, play }, { songs = 1, exp = 0, banks = null, extra = [] } = {}) {
  const h = new Uint8Array(0x80);
  h.set([0x4e, 0x45, 0x53, 0x4d, 0x1a, 1, songs, 1]);
  h[8] = 0x00; h[9] = 0x80;
  h[0x0a] = init & 0xff; h[0x0b] = init >> 8; h[0x0c] = play & 0xff; h[0x0d] = play >> 8;
  h.set(new TextEncoder().encode("Test Song"), 0x0e);
  h.set(new TextEncoder().encode("Nobody"), 0x2e);
  h[0x6e] = 16639 & 0xff; h[0x6f] = 16639 >> 8;
  if (banks) h.set(banks, 0x70);
  h[0x7b] = exp;
  const prog = new Uint8Array(4096 * (1 + extra.length));
  prog.set(code);
  extra.forEach((b, i) => prog.set(b, 4096 * (i + 1)));
  const out = new Uint8Array(0x80 + prog.length);
  out.set(h); out.set(prog, 0x80);
  return out;
}

// ── Pitches as each chip's registers ────────────────────────────────────────
const hzOf = (midi) => 440 * 2 ** ((midi - 69) / 12);
const MELODY = [60, 62, 64, 65, 67, 69, 71, 72];
const apu = (midi) => Math.round(CLOCK / (16 * hzOf(midi))) - 1;
const n163 = (midi) => Math.round((hzOf(midi) * 15 * 65536 * 32) / CLOCK);
const ssg = (midi) => Math.round(CLOCK / 2 / (16 * hzOf(midi)));
const opllF = (midi) => Math.round((hzOf(midi) * 72 * 2 ** 15) / 3579545); // block 4
const fdsF = (midi) => Math.round((hzOf(midi) * 2 ** 22) / CLOCK);

const EXP_ALL = 0x3f;
const initAll = [[
  [0x4015, 0x0f],
  // N163: a 32-sample saw at $00, channel 8 alone.
  ...Array.from({ length: 16 }, (_, i) => [[0xf800, 0x80 | i], [0x4800, ((2 * i) >> 1) | (((2 * i + 1) >> 1) << 4)]]).flat(),
  [0xf800, 0x7c], [0x4800, 0xe0], [0xf800, 0x7e], [0x4800, 0x00],
  // MMC5 on; 5B tone A; the FDS's wave (a ramp) and its gain.
  [0x5015, 0x03], [0xc000, 7], [0xe000, 0x3e],
], [
  [0x4089, 0x80], ...Array.from({ length: 64 }, (_, i) => [0x4040 + i, i]), [0x4089, 0x00],
]];
const stepAll = (midi) => {
  const p = apu(midi), f = n163(midi), s = ssg(midi), o = opllF(midi), d = fdsF(midi);
  return [
    [0x4000, 0xbf], [0x4002, p & 0xff], [0x4003, (p >> 8) | 0x08],
    [0x9000, 0x7f], [0x9001, p & 0xff], [0x9002, 0x80 | (p >> 8)],
    [0xf800, 0x78], [0x4800, f & 0xff], [0xf800, 0x7a], [0x4800, (f >> 8) & 0xff], [0xf800, 0x7c], [0x4800, 0xe0 | (f >> 16)],
    [0xf800, 0x7f], [0x4800, 0x0f],
    [0x5000, 0xbf], [0x5002, p & 0xff], [0x5003, (p >> 8) | 0x08],
    [0xc000, 0], [0xe000, s & 0xff], [0xc000, 1], [0xe000, s >> 8], [0xc000, 8], [0xe000, 0x0f],
    [0x9010, 0x30], [0x9030, 0x10], [0x9010, 0x10], [0x9030, o & 0xff], [0x9010, 0x20], [0x9030, 0x08 | (o >> 8)],
    [0x9010, 0x20], [0x9030, 0x18 | (o >> 8)],
    [0x4080, 0xa0], [0x4082, d & 0xff], [0x4083, d >> 8],
  ];
};

function imported(parsed) {
  const a = analyzeVgm(parsed);
  const opt = defaultVgmOptions(a, "fc");
  const { source, warnings } = vgmToMmlisp(parsed, { ...opt, structure: true, fileName: "t.nsf" }, a);
  const bad = compileMMLisp(source, "t.mmlisp", { imports: readImportSources("t.mmlisp", source) }).diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(bad.map((d) => `${d.code} ${d.message}`), [], "the imported score compiles clean");
  return { a, opt, source, warnings };
}
const near = (x, y, tol, what) => assert.ok(Math.abs(x - y) <= tol, `${what}: ${x} (expected ${y} ± ${tol})`);

// Every chip, an intro of four steps and a loop of eight back to step 4.
{
  const steps = [...[48, 50, 52, 53], ...MELODY].map(stepAll);
  const nsf = parseNsf(nsfFile(driver({ init: initAll, steps, loopStep: 4 }), { songs: 2, exp: EXP_ALL }));
  assert.equal(nsf.songs, 2);
  assert.equal(nsf.name, "Test Song");
  const parsed = runNsf(nsf, 0);
  assert.deepEqual([...parsed.chips].sort(), ["2A03", "5B", "FDS", "MMC5", "N163", "VRC6", "VRC7"]);
  // Song 1: the state comes round at step 4's frame, a loop of eight steps.
  near(parsed.loopSample / PERIOD, 4 * FRAMES, 0.01, "song 1's loop point (frames)");
  near(parsed.totalSamples / PERIOD, 12 * FRAMES, 0.01, "song 1's end (frames)");
  const { a, opt, source } = imported(parsed);
  assert.equal(a.target, "fc");
  for (const [k, d] of Object.entries({ "2A03 SQ1": "sqr1", "VRC6 SQ1": "vrc6-sqr1", "MMC5 SQ1": "mmc5-sqr1", "N163 CH8": "n163-wave1",
    "5B SSGA": "5b-sqr1", "VRC7 FM1": "vrc7-fm1", FDS: "fds-wave" }))
    assert.equal(opt.dest[k], d, `${k} on ${d}`);
  for (const k of ["2A03 SQ1", "VRC6 SQ1", "MMC5 SQ1", "N163 CH8", "5B SSGA", "VRC7 FM1", "FDS"])
    assert.equal(a.channels.find((c) => c.key === k)?.notes, 12, `${k}: a note a step`);
  for (const ch of ["vrc6-sqr1", "mmc5-sqr1", "n163-wave1", "5b-sqr1", "vrc7-fm1", "fds-wave"])
    assert.match(source, new RegExp(`\\(${ch}\\b`), `${ch} is written`);
  assert.match(source, /\(def-wave wave-\d+/, "the N163's and the FDS's waves are def-waves");
  const ramp = Array.from({ length: 64 }, (_, i) => Math.round((i * 255) / 63) - 128).join(" ");
  assert.ok(source.includes(`:wave [${ramp}]`), "the FDS's ramp, its 64 steps whole");
  assert.match(source, /:duty 8/, "the VRC6 pulse's duty, 8/16");
  assert.match(source, /\(go top\)|:loop|\(loop/, "the loop is written");

  // Song 2: a counter keeps the state from coming round; the writes repeat.
  const p2 = runNsf(nsf, 1);
  assert.ok(p2.loopSample != null, "song 2 loops");
  near((p2.totalSamples - p2.loopSample) / PERIOD, 8 * FRAMES, 0.01, "song 2's loop length (frames)");
  near(p2.loopSample / PERIOD, 4 * FRAMES, 0.01, "song 2's loop point, settled on step 4's writes (frames)");
  imported(p2);
}

// A song that stops after four steps ends there, without a loop.
{
  const steps = [60, 64, 67, 72].map((m) => [[0x4000, 0xbf], [0x4002, apu(m) & 0xff], [0x4003, (apu(m) >> 8) | 0x08]]);
  const parsed = runNsf(parseNsf(nsfFile(driver({ init: [[0x4015, 0x0f]], steps, stops: true }))));
  assert.equal(parsed.loopSample, null, "a song that stops does not loop");
  near(parsed.totalSamples / PERIOD, 3 * FRAMES + 1, 1, "it ends after its last step");
  const { a } = imported(parsed);
  assert.equal(a.loop ?? a.fileLoop, false);
}

// Banks: the program in bank 0, the DMC's samples in banks 1 and 2 switched
// into $C000 between hits — each hit plays the bytes mapped when it started.
{
  const sample = (v) => new Uint8Array(4096).fill(v);
  const hit = (bank) => [[0x5ffc, bank], [0x4010, 0x0f], [0x4012, 0x00], [0x4013, 0x01], [0x4015, 0x0f], [0x4015, 0x1f]];
  const parsed = runNsf(parseNsf(nsfFile(driver({ init: [[0x4015, 0x0f]], steps: [hit(1), hit(2)], loopStep: 0 }),
    { banks: [0, 0, 0, 0, 1, 0, 0, 0], extra: [sample(0x55), sample(0xaa)] })));
  const hits = parsed.pcmHits.filter((h) => h.src === "DPCM");
  assert.ok(hits.length >= 2, "two DMC hits");
  assert.deepEqual([hits[0].bytes[0], hits[1].bytes[0]], [0x55, 0xaa], "each hit's sample as its bank had it");
  assert.equal(hits[0].bytes.length, 17, "$4013's length: 16 × 1 + 1 bytes");
  imported(parsed);
}

console.log("check-import-nsf: ok");
