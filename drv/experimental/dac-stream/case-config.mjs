// ONE resolved case (docs/dac-engine-implementation.md §12.3).
//
// The CLI can override the compensation, the boot calibration and inject a
// protocol fault. Every one of those changes what is generated, so the case
// object the run RECORDS has to be the one the run USED — otherwise a stored
// JSON names a configuration that never existed and the rom hash is the only
// honest field in it. resolveCase() applies the overrides once, derives what
// both CPUs have to agree on (the window period, the window length) from the
// same place, and returns the object everything downstream reads.
import { buildConfig } from "./config.mjs";
import { COOP, windowPeriodMaster, generateCooperative } from "./cooperative.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../../tools/z80asm.mjs";
import { buildRom } from "./rom.mjs";
import { sine } from "./cases.mjs";
import { generate } from "./gen-stream.mjs";
import { generateObserver, PUBLISH_FAULTS } from "./observer.mjs";
import { generateSplit } from "./decode-split.mjs";
import { protocolLayout, SNAPSHOT_BYTES, PROTO_GLOB } from "./protocol.mjs";

export const QUEUE_FAULTS = {
  "q-head-first": "queueHead is advanced before the record's bytes are written",
  "q-short-record": "the head claims a whole record and one byte of it never arrived",
};

export const FAULTS = {
  "drop-copy": "the 68000 transfers one byte fewer than it announced",
  "no-commit": "the 68000 never writes the local commit byte",
  "early-commit": "the commit is written BEFORE the payload, not after it",
  "late-request": "the request is delayed past the window it was computed for",
  "zero-divisor": "the 68000's foreground load divides by zero, which traps",
  "short-load": "the foreground load becomes nops, so it is no longer a long instruction",
  "no-load-marks": "the load loop stops stamping, so its time cannot be checked",
  // Z80-side, and they break the diagnostic RECORD rather than the decode:
  // the instrument's own check has to fail on each of them.
  ...PUBLISH_FAULTS,
  // 68000-side, and they break the QUEUE's publication order rather than the
  // transfer: the head moved before the bytes, or the record stopped short of
  // what the head then claimed (R13 §35.3 step 2).
  ...QUEUE_FAULTS,
};

/**
 * @param c0    a case from the table
 * @param opts  {compensation, captureOffset, fault} — the CLI's overrides
 * @returns {case, cfg, gen, coop} with the case fully resolved
 */
// ONE COMMAND RECORD, in the wire format §33.4 fixes: size, type, the low 16
// bits of the sample it applies at, then payload. Eight bytes, so a 256-byte
// page holds exactly 32 of them and the head's own byte wraps with the page.
export const QREC_BYTES = 8;
export const QREC_RECORD = [QREC_BYTES, 0x01, 0x40, 0x00, 0xde, 0xad, 0xbe, 0xef];

/**
 * The addresses the 68000's ROM needs, taken from the ONE layout (R12 §33.2).
 * They are OFFSETS from the Z80's base, because that is how the host addresses
 * Z80 RAM, and nothing here re-derives one.
 */
function protoRomFields(cfg, p) {
  const L = protocolLayout(cfg.ram.pub[0]);
  return { bootGeneration: p.bootGeneration ?? 0x1234,
    between: p.between ?? 8,
    skipLive: !!p.skipLive, skipBulk: !!p.skipBulk,
    snapshotBytes: SNAPSHOT_BYTES,
    select: L.publishSelect.offset,
    readRun: L.readRun.offset,
    readLongs: L.readRun.bytes >> 2,
    readWords: (L.readRun.bytes & 3) >> 1,
    face0: L.faces[0].observationNumber.offset,
    face1: L.faces[1].observationNumber.offset,
    stride: 10,
    bootGen: L.control.bootGeneration.offset,
    phaseGen: L.control.phaseGeneration.offset,
    queueHead: L.control.queueHead.offset,
    phaseCommit: L.control.phaseCommit.offset,
    // The queue: where it lives, one well-formed record, and how many of them
    // fill the page — which is what makes the wrap a thing that happens rather
    // than a thing that is described.
    queue: !!p.queue, qfault: p.qfault ?? null, piece: p.piece ?? null,
    queueTail: cfg.ram.glob[0] + PROTO_GLOB.queueTail,
    queueBase: cfg.ram.queue ? cfg.ram.queue[0] : 0x1d00,
    recordBytes: QREC_BYTES,
    perPage: 256 / QREC_BYTES,
    record: QREC_RECORD };
}

export function resolveCase(c0, { compensation = null, captureOffset = null, fault = null } = {}) {
  if (fault && !FAULTS[fault]) throw new Error(`unknown fault ${fault}; one of ${Object.keys(FAULTS)}`);
  const cfg = buildConfig(c0.cfg);
  const coop = c0.cooperative
    ? { ...c0.cooperative, ...(compensation === null ? {} : { compensation }) } : null;
  let grab = c0.grab ? { ...c0.grab }
    : c0.bankOnly ? { cooperative: true, disabled: true }
    : c0.calibrate ? { calibrate: true, disabled: true }
    // An observer case has a display and a busy 68000. It has no transfer
    // protocol of its own; `stall` injects a plain, UNREPAID bus grab, which is
    // the disturbance the observer is supposed to notice.
    // A SPLIT case is an observer case whose observer is distributed through
    // the complete 2ch engine. Same disturbances, same idle-or-loaded 68000;
    // what differs is that there is nothing to publish (R8 §23.5 step 3).
    : c0.split ? (c0.split.stall
        ? { vdp: true, optimized: true, load: c0.split.load,
            bootNops: c0.split.bootNops, ...c0.split.stall }
        : { vdp: true, disabled: true, load: c0.split.load,
            bootNops: c0.split.bootNops })
    // A PROTOCOL case has a display, a busy 68000 AND a 68000 that takes the
    // bus on purpose: half its grabs read the published snapshot and change
    // nothing, the other half declare the phase over. It is the only observer
    // shape whose host writes into Z80 RAM at all (R12 §33.3).
    : c0.observer?.proto ? { vdp: true, load: c0.observer.load,
        bootNops: c0.observer.bootNops, every: c0.observer.proto.every,
        proto: protoRomFields(cfg, { ...c0.observer.proto,
          ...(fault in QUEUE_FAULTS ? { qfault: fault.slice(2) } : {}) }) }
    : c0.observer ? (c0.observer.stall
        ? { vdp: true, optimized: true, load: c0.observer.load,
            bootNops: c0.observer.bootNops, publish: c0.observer.publish,
            ...c0.observer.stall }
        : { vdp: true, disabled: true, load: c0.observer.load,
            loadProbe: c0.observer.loadProbe, bootNops: c0.observer.bootNops,
            publish: c0.observer.publish })
    : null;
  if (grab) {
    if (captureOffset !== null && grab.computed) grab.captureOffset = captureOffset;
    // A publish fault is the Z80's; it must not also reach the 68000's rom.
    if (fault && !(fault in PUBLISH_FAULTS) && !(fault in QUEUE_FAULTS)) grab.fault = fault;
    // Two ways to break the load CHECK rather than the load: make it short, or
    // stop it reporting. The gate has to fail on both (R6 §17.2 C).
    if (fault === "short-load" || fault === "no-load-marks") {
      if (!c0.observer?.loadProbe)
        throw new Error(`fault ${fault} only applies to a case that times its own load`);
      if (fault === "short-load") grab.load = "short";
      else grab.loadProbe = false;
    }
    // BOTH CPUs read the window period from the schedule that produces it.
    // The 68000's arithmetic used to carry its own copy of 26,880 while the
    // Z80's came from the slot table; they agreed only because slots was 5.
    if (grab.cooperative || grab.hint) {
      if (!coop) throw new Error("a cooperative or hint transfer needs a cooperative schedule");
      grab.windowPeriod = windowPeriodMaster(cfg, coop.slots);
      grab.windowCycles = COOP.windowCycles;
    }
  }
  if (c0.observer && coop) throw new Error("an observer case has no cooperative window");
  if (c0.split && (coop || c0.observer)) throw new Error("a split case is its own observer");
  const c = { ...c0, cooperative: coop, grab: grab ?? undefined };
  if (fault && fault in PUBLISH_FAULTS && !c0.observer?.publish)
    throw new Error(`fault ${fault} only applies to a case that publishes its records`);
  const observer = c0.observer && fault && fault in PUBLISH_FAULTS
    ? { ...c0.observer, publishFault: fault } : c0.observer;
  let gen;
  if (c0.split) {
    const r = generateSplit(cfg, { stackFill: true, ...c0.split.place });
    if (!r.ok) throw new Error(`case "${c0.name}": the split did not generate (${r.stage}: ${r.error ?? r.walk.failed?.name})`);
    gen = r.gen;
    gen.split = r;
  } else {
    gen = observer ? generateObserver(cfg, { ...observer, proto: !!observer.proto })
      : coop ? generateCooperative(cfg, coop) : generate(cfg);
  }
  return { case: c, cfg, gen, coop, grab };
}

/**
 * Everything a case turns into, deterministically: the generated Z80 source,
 * the assembled image, the cartridge and its hash.
 *
 * It lives here rather than in the runner so that a second tool can ask "what
 * rom would this case produce?" without running the suite, and so that the
 * answer cannot drift from what the runner actually built (R5 §15.2 C).
 *
 * @param outDir  where the .z80 and .bin are written
 */
export function buildCase(c0, { outDir, compensation = null, captureOffset = null,
  fault = null, marks = false } = {}) {
  const resolved = resolveCase(c0, { compensation, captureOffset, fault });
  const cfg = resolved.cfg;
  let c = resolved.case;
  if (marks && c.grab) c = { ...c, grab: { ...c.grab, marks: true } };
  const gen = resolved.gen;
  const caseId = createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 12);
  mkdirSync(outDir, { recursive: true });
  const zpath = join(outDir, `probe-${cfg.stamp}-${caseId}.z80`);
  writeFileSync(zpath, gen.text);
  const built = assemble(zpath);

  // P1 plays a waveform out of Z80 RAM, so it travels inside the image; P2
  // reads its voices through the 68k window, so they travel in the cartridge.
  let samples = null;
  let image = Uint8Array.from(built.bytes);
  if (cfg.voices) {
    samples = new Uint8Array(512);
    samples.set(sine(256, 120, 1), 0);
    samples.set(sine(256, 90, 3), 256);
  } else {
    // The image may reach past the waveform page — the decoder's table sits
    // above it — so the upload is as long as whichever is further.
    const end = Math.max(cfg.ram.wave[1], image.length);
    const grown = new Uint8Array(end);
    grown.set(image, 0);
    grown.set(c.wave, cfg.ram.wave[0]);
    image = grown;
  }
  if (!samples && c.grab) samples = Uint8Array.from({ length: 512 }, (_, i) => (i * 73 + 19) & 255);
  const { rom, sha } = buildRom(image, samples, c.grab ?? null);
  const rpath = join(outDir, `probe-${cfg.stamp}-${caseId}-${sha}.bin`);
  writeFileSync(rpath, rom);
  return { cfg, gen, grab: resolved.grab, resolved: c, caseId, image, samples, sha, rpath, zpath };
}
